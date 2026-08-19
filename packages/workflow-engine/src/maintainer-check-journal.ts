import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import type { CheckEvidence } from './check-runner.ts';
import { isRecord } from './foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import type {
  MaintainerChecksAttestation,
  MaintainerChecksAttestationV2,
  MaintainerPreapprovalCheck,
} from './modules/authority/maintainer-grant-v2.ts';
import type { CheckDependency } from './modules/authority/maintainer-manifest.ts';
import { writeJsonAtomic } from './session-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAINTAINER_CHECK_RESUME_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

export type MaintainerCheckJournalIdentity = {
  schemaVersion: 1 | 2;
  repositoryId: string;
  repositoryRealPath: string;
  trustBaseCommit: string;
  policyDigest: string;
  profileId: string;
  profileVersion: number;
  patchDigest: string;
  candidateStateDigest: string;
  environmentDigest: string;
  harnessEngineDigest?: string;
  requiredChecks: Array<{
    checkId: string;
    definitionDigest: string;
    runner: string;
    runnerDigest: string;
    destructiveDatabase: boolean;
    databaseIdentity: string | null;
    dependsOn?: CheckDependency[];
    externalSnapshotDigest?: string | null;
    externalMaxAgeMs?: number | null;
  }>;
};

export type MaintainerCheckJournal = {
  schemaVersion: 1;
  kind: 'maintainer-check-journal.v1';
  identity: MaintainerCheckJournalIdentity;
  identityDigest: string;
  state: 'running' | 'completed';
  createdAt: string;
  updatedAt: string;
  checks: MaintainerPreapprovalCheck[];
  finalAttestation: MaintainerChecksAttestation | null;
};

export function maintainerCheckIdentityDigest(
  identity: MaintainerCheckJournalIdentity,
): string {
  return digest(canonicalJson(identity));
}

export function openMaintainerCheckJournal(
  gitCommonDirectory: string,
  identity: MaintainerCheckJournalIdentity,
  now: Date,
): { path: string; journal: MaintainerCheckJournal } {
  assertIdentity(identity);
  const identityDigest = maintainerCheckIdentityDigest(identity);
  const filePath = path.join(
    gitCommonDirectory,
    'workflow-engine',
    'maintainer-checks',
    `${identityDigest}.json`,
  );
  ensurePlainDirectory(path.dirname(filePath));
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!existing) {
    const timestamp = exactTime(now);
    const journal: MaintainerCheckJournal = {
      schemaVersion: 1,
      kind: 'maintainer-check-journal.v1',
      identity,
      identityDigest,
      state: 'running',
      createdAt: timestamp,
      updatedAt: timestamp,
      checks: [],
      finalAttestation: null,
    };
    writeJsonAtomic(filePath, journal);
    return { path: filePath, journal };
  }
  const journal = readJournal(filePath);
  if (
    journal.identityDigest !== identityDigest ||
    canonicalJson(journal.identity) !== canonicalJson(identity)
  ) {
    throw journalInvalid('The durable check journal identity is inconsistent.');
  }
  if (journal.state === 'running') {
    const updatedAt = Date.parse(journal.updatedAt);
    const current = now.getTime();
    if (
      updatedAt > current ||
      current - updatedAt > MAINTAINER_CHECK_RESUME_MAX_AGE_MS ||
      journal.checks.some(({ completedAt }) => {
        const completed = Date.parse(completedAt);
        return (
          completed > current ||
          current - completed > MAINTAINER_CHECK_RESUME_MAX_AGE_MS
        );
      })
    ) {
      throw workflowError(
        'MAINTAINER_CHECK_JOURNAL_STALE',
        'Incomplete preapproval check evidence is no longer fresh enough to resume.',
        ExitCode.staleState,
        { details: { identityDigest } },
      );
    }
  }
  return { path: filePath, journal };
}

export function appendMaintainerCheckEvidence(
  filePath: string,
  journal: MaintainerCheckJournal,
  check: MaintainerPreapprovalCheck,
  now: Date,
): MaintainerCheckJournal {
  if (journal.state !== 'running' || journal.finalAttestation !== null) {
    throw journalInvalid('A terminal check journal cannot be extended.');
  }
  const expected = journal.identity.requiredChecks[journal.checks.length];
  assertCheck(check, expected);
  const next: MaintainerCheckJournal = {
    ...journal,
    updatedAt: exactTime(now),
    checks: [...journal.checks, check],
  };
  ensurePlainDirectory(path.dirname(filePath));
  writeJsonAtomic(filePath, next);
  return next;
}

export function completeMaintainerCheckJournal(
  filePath: string,
  journal: MaintainerCheckJournal,
  attestation: MaintainerChecksAttestation,
  now: Date,
): MaintainerCheckJournal {
  if (
    journal.state !== 'running' ||
    journal.checks.length !== journal.identity.requiredChecks.length ||
    canonicalJson(attestation.checks) !== canonicalJson(journal.checks)
  ) {
    throw journalInvalid('The check journal cannot publish this attestation.');
  }
  const next: MaintainerCheckJournal = {
    ...journal,
    state: 'completed',
    updatedAt: exactTime(now),
    finalAttestation: attestation,
  };
  ensurePlainDirectory(path.dirname(filePath));
  writeJsonAtomic(filePath, next);
  return next;
}

function readJournal(filePath: string): MaintainerCheckJournal {
  let raw: unknown;
  try {
    const observed = fs.lstatSync(filePath);
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1 ||
      (observed.mode & 0o777) !== 0o600 ||
      observed.size > 1_048_576
    ) {
      throw new Error('unsafe journal file');
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.dev !== observed.dev ||
        opened.ino !== observed.ino ||
        opened.size !== observed.size
      ) {
        throw new Error('journal file changed while opening');
      }
      const content = fs.readFileSync(descriptor, 'utf8');
      raw = JSON.parse(content);
      if (`${JSON.stringify(raw, null, 2)}\n` !== content) {
        throw new Error('noncanonical journal bytes');
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw journalInvalid('The durable check journal is unreadable.');
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== 'maintainer-check-journal.v1' ||
    !isRecord(raw.identity) ||
    typeof raw.identityDigest !== 'string' ||
    !DIGEST.test(raw.identityDigest) ||
    (raw.state !== 'running' && raw.state !== 'completed') ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    !Array.isArray(raw.checks) ||
    (raw.finalAttestation !== null && !isRecord(raw.finalAttestation))
  ) {
    throw journalInvalid('The durable check journal has an invalid shape.');
  }
  const journal = raw as unknown as MaintainerCheckJournal;
  assertIdentity(journal.identity);
  if (
    journal.identityDigest !==
      maintainerCheckIdentityDigest(journal.identity) ||
    !Number.isFinite(Date.parse(journal.createdAt)) ||
    !Number.isFinite(Date.parse(journal.updatedAt)) ||
    journal.checks.length > journal.identity.requiredChecks.length ||
    journal.checks.some((check, index) => {
      try {
        assertCheck(check, journal.identity.requiredChecks[index]);
        return false;
      } catch {
        return true;
      }
    }) ||
    (journal.state === 'running' && journal.finalAttestation !== null) ||
    (journal.state === 'completed' &&
      (!journal.finalAttestation ||
        !attestationMatchesIdentity(
          journal.finalAttestation,
          journal.identity,
        ) ||
        canonicalJson(journal.finalAttestation.checks) !==
          canonicalJson(journal.checks)))
  ) {
    throw journalInvalid(
      'The durable check journal is internally inconsistent.',
    );
  }
  return journal;
}

function assertIdentity(identity: MaintainerCheckJournalIdentity): void {
  const identityKeys = [
    'candidateStateDigest',
    'environmentDigest',
    ...(identity.schemaVersion === 2 ? ['harnessEngineDigest'] : []),
    'patchDigest',
    'policyDigest',
    'profileId',
    'profileVersion',
    'repositoryId',
    'repositoryRealPath',
    'requiredChecks',
    'schemaVersion',
    'trustBaseCommit',
  ].sort();
  if (
    Object.keys(identity).sort().join(',') !== identityKeys.join(',') ||
    (identity.schemaVersion !== 1 && identity.schemaVersion !== 2) ||
    !/^github:[A-Za-z0-9_.:-]+$/.test(identity.repositoryId) ||
    !path.isAbsolute(identity.repositoryRealPath) ||
    !isExactRealPath(identity.repositoryRealPath) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(identity.trustBaseCommit) ||
    !DIGEST.test(identity.policyDigest) ||
    !identity.profileId ||
    !Number.isSafeInteger(identity.profileVersion) ||
    identity.profileVersion < 1 ||
    !DIGEST.test(identity.patchDigest) ||
    !DIGEST.test(identity.candidateStateDigest) ||
    !DIGEST.test(identity.environmentDigest) ||
    (identity.schemaVersion === 2 &&
      (typeof identity.harnessEngineDigest !== 'string' ||
        !DIGEST.test(identity.harnessEngineDigest))) ||
    identity.requiredChecks.length === 0 ||
    identity.requiredChecks.some(
      (check, index) =>
        Object.keys(check).sort().join(',') !==
          (identity.schemaVersion === 1
            ? 'checkId,databaseIdentity,definitionDigest,destructiveDatabase,runner,runnerDigest'
            : 'checkId,databaseIdentity,definitionDigest,dependsOn,destructiveDatabase,externalMaxAgeMs,externalSnapshotDigest,runner,runnerDigest') ||
        !CHECK_ID.test(check.checkId) ||
        !DIGEST.test(check.definitionDigest) ||
        typeof check.runner !== 'string' ||
        check.runner.length === 0 ||
        !DIGEST.test(check.runnerDigest) ||
        typeof check.destructiveDatabase !== 'boolean' ||
        (check.destructiveDatabase
          ? typeof check.databaseIdentity !== 'string' ||
            check.databaseIdentity.length === 0
          : check.databaseIdentity !== null) ||
        (identity.schemaVersion === 2 &&
          (!Array.isArray(check.dependsOn) ||
            check.dependsOn.length === 0 ||
            check.dependsOn.some(
              (dependency, dependencyIndex) =>
                !/^(?:source-tree|base-commit|harness-engine|policy|runner|external-state)$/.test(
                  dependency,
                ) || check.dependsOn!.indexOf(dependency) !== dependencyIndex,
            ) ||
            (check.dependsOn.includes('external-state')
              ? typeof check.externalSnapshotDigest !== 'string' ||
                !DIGEST.test(check.externalSnapshotDigest) ||
                !Number.isSafeInteger(check.externalMaxAgeMs) ||
                Number(check.externalMaxAgeMs) < 1
              : check.externalSnapshotDigest !== null ||
                check.externalMaxAgeMs !== null))) ||
        identity.requiredChecks.findIndex(
          (candidate) => candidate.checkId === check.checkId,
        ) !== index,
    )
  ) {
    throw journalInvalid('The preapproval check journal identity is invalid.');
  }
}

function isExactRealPath(value: string): boolean {
  try {
    return fs.realpathSync(value) === value;
  } catch {
    return false;
  }
}

function assertCheck(
  check: MaintainerPreapprovalCheck,
  expected:
    MaintainerCheckJournalIdentity['requiredChecks'][number] | undefined,
): void {
  const evidence = check?.evidence as CheckEvidence | undefined;
  const expectsExternalSnapshot =
    typeof expected?.externalSnapshotDigest === 'string';
  if (
    !expected ||
    !evidence ||
    evidence.checkId !== expected.checkId ||
    evidence.outcome !== 'passed' ||
    evidence.exitCode !== 0 ||
    evidence.runner !== expected.runner ||
    evidence.runnerDigest !== expected.runnerDigest ||
    (expectsExternalSnapshot
      ? evidence.externalSnapshotDigest !== expected.externalSnapshotDigest
      : evidence.externalSnapshotDigest !== undefined) ||
    (expectsExternalSnapshot
      ? evidence.maxAgeMs !== expected.externalMaxAgeMs ||
        evidence.completedAt !== check.completedAt
      : evidence.maxAgeMs !== undefined ||
        evidence.completedAt !== undefined) ||
    evidence.destructiveDatabase !== expected.destructiveDatabase ||
    (expected.destructiveDatabase
      ? evidence.databaseIdentity !== expected.databaseIdentity
      : evidence.databaseIdentity !== undefined) ||
    Object.keys(evidence).sort().join(',') !==
      (evidence.destructiveDatabase
        ? expectsExternalSnapshot
          ? 'checkId,completedAt,databaseIdentity,destructiveDatabase,exitCode,externalSnapshotDigest,maxAgeMs,outcome,runner,runnerDigest'
          : 'checkId,databaseIdentity,destructiveDatabase,exitCode,outcome,runner,runnerDigest'
        : expectsExternalSnapshot
          ? 'checkId,completedAt,destructiveDatabase,exitCode,externalSnapshotDigest,maxAgeMs,outcome,runner,runnerDigest'
          : 'checkId,destructiveDatabase,exitCode,outcome,runner,runnerDigest') ||
    check.commandDigest !== expected.definitionDigest ||
    Object.keys(check).sort().join(',') !==
      'commandDigest,completedAt,evidence,startedAt' ||
    !Number.isFinite(Date.parse(check.startedAt)) ||
    !Number.isFinite(Date.parse(check.completedAt)) ||
    Date.parse(check.startedAt) > Date.parse(check.completedAt)
  ) {
    throw journalInvalid('Durable preapproval check evidence is invalid.');
  }
}

function attestationMatchesIdentity(
  attestation: MaintainerChecksAttestation,
  identity: MaintainerCheckJournalIdentity,
): boolean {
  return (
    Object.keys(attestation).sort().join(',') ===
      (identity.schemaVersion === 1
        ? 'candidateStateDigest,checks,environmentDigest,patchDigest,policyDigest,schemaVersion,trustBaseCommit'
        : 'candidateStateDigest,checks,environmentDigest,harnessEngineDigest,patchDigest,policyDigest,schemaVersion,trustBaseCommit') &&
    attestation.schemaVersion === identity.schemaVersion &&
    attestation.trustBaseCommit === identity.trustBaseCommit &&
    attestation.policyDigest === identity.policyDigest &&
    attestation.patchDigest === identity.patchDigest &&
    attestation.candidateStateDigest === identity.candidateStateDigest &&
    attestation.environmentDigest === identity.environmentDigest &&
    attestation.checks.length === identity.requiredChecks.length &&
    (identity.schemaVersion === 1 ||
      (attestation as MaintainerChecksAttestationV2).harnessEngineDigest ===
        identity.harnessEngineDigest)
  );
}

function exactTime(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw journalInvalid('The preapproval check journal time is invalid.');
  }
  return now.toISOString();
}

function journalInvalid(message: string) {
  return workflowError(
    'MAINTAINER_CHECK_JOURNAL_INVALID',
    message,
    ExitCode.staleState,
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
