import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  pinCheckRunner,
  runCheck,
  type CheckEvidence,
  type PinnedCheckRunner,
} from './check-runner.ts';
import type { CheckDefinition } from './contracts.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from './database-policy.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
} from './git.ts';
import {
  assertGrantPathsEligible,
  canonicalGrantEnvelope,
  canonicalGrantPayload,
  validateGrantPayload,
  type MaintainerGrantEnvelope,
} from './maintainer-grant.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import { writeAuthorityCheckReport } from './maintainer-report.ts';
import {
  maintainerGrantStorePaths,
  readReservedMaintainerGrant,
  reserveMaintainerGrant,
  terminallyRevokeMaintainerReservation,
} from './maintainer-store.ts';
import { assertChangeId, assertSessionId } from './paths.ts';
import { createSessionId } from './session-store.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';

export type AuthorityPinnedCheck = {
  checkId: string;
  definition: CheckDefinition;
  runner: PinnedCheckRunner;
};

export type AuthoritySession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'failed' | 'aborted' | 'committed';
  grantId: string;
  changeId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseCommit: string;
  baselineTree: string;
  policyBlob: string;
  policyDigest: string;
  grantDigest: string;
  signer: string;
  contractDigest: string;
  contractArtifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  pinnedChecks: AuthorityPinnedCheck[];
  createdAt: string;
  latestCheckReportId?: string;
  failedAt?: string;
  failureReason?: string;
  abortedAt?: string;
  abortReason?: string;
  committedAt?: string;
  commitHash?: string;
};

export type AuthoritySessionOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
};

export function startAuthoritySession(
  cwd: string,
  requestedChangeId: string,
  requestedGrantId: string,
  options: AuthoritySessionOptions = {},
): AuthoritySession {
  const changeId = assertChangeId(requestedChangeId);
  const initial = discoverRepository(cwd);
  if (initial.statusEntries.length > 0 || !initial.branch) {
    throw authorityError(
      'AUTHORITY_START_DIRTY',
      'Authority start requires a clean named branch.',
    );
  }
  const sessionId = createSessionId();
  const reservation = reserveMaintainerGrant(
    initial.gitCommonDirectory,
    requestedGrantId,
    {
      sessionId,
      repositoryRoot: initial.repositoryRealPath,
      now: options.now,
    },
  );
  try {
    const envelope = reservation.envelope;
    if (
      reservation.repositoryRoot !== initial.repositoryRealPath ||
      envelope.payload.changeId !== changeId ||
      envelope.payload.baseCommit !== initial.head
    ) {
      throw authorityError(
        'AUTHORITY_GRANT_MISMATCH',
        'The reserved grant does not match this repository, change, or base.',
      );
    }
    const { policy, policyContent, policyBlob } = loadBasePolicy(
      initial.repositoryRoot,
      initial.head,
    );
    validateGrantPayload(envelope.payload, policy, {
      now: exactDate(options.now ?? new Date()),
      expectedBase: initial.head,
      expectedPolicyBlob: policyBlob,
    });
    verifyEnvelopeSignature(
      initial.repositoryRoot,
      envelope,
      policy,
      options.signer,
    );
    assertExactAuditTag(initial.repositoryRoot, envelope, policy);
    assertGrantPathsEligible(
      initial.repositoryRoot,
      envelope.payload.allowedPaths,
      policy,
    );
    const { git, contract } = loadStableValidatedChangeContract(
      initial,
      changeId,
    );
    const expectedBranch = contract.config.branchTemplate.replace(
      '{changeId}',
      changeId,
    );
    if (
      git.branch !== expectedBranch ||
      git.head !== envelope.payload.baseCommit
    ) {
      throw authorityError(
        'AUTHORITY_BRANCH_INVALID',
        `Authority start requires branch ${expectedBranch} at the exact grant base.`,
      );
    }
    const requiredChecks = requiredAuthorityChecks(
      policy,
      contract.guard.tasks,
    );
    const pinnedChecks = requiredChecks.map((checkId) => {
      const definition = contract.checks.checks[checkId];
      if (!definition) {
        throw authorityError(
          'AUTHORITY_CHECK_UNKNOWN',
          `Authority policy references unknown check ${checkId}.`,
        );
      }
      return {
        checkId,
        definition,
        runner: pinCheckRunner(git.repositoryRoot, checkId, definition),
      };
    });
    const createdAt = exactDate(options.now ?? new Date()).toISOString();
    const session: AuthoritySession = {
      schemaVersion: 1,
      sessionId,
      state: 'active',
      grantId: envelope.payload.grantId,
      changeId,
      repositoryRoot: git.repositoryRealPath,
      gitCommonDirectory: git.gitCommonDirectory,
      branch: git.branch,
      baseCommit: git.head,
      baselineTree: git.tree,
      policyBlob,
      policyDigest: digest(policyContent),
      grantDigest: digest(canonicalGrantEnvelope(envelope)),
      signer: envelope.payload.signer,
      contractDigest: contract.contractDigest,
      contractArtifacts: Object.fromEntries(
        Object.entries(contract.artifactDigests).filter(
          ([filePath]) => !envelope.payload.allowedPaths.includes(filePath),
        ),
      ),
      allowedPaths: [...envelope.payload.allowedPaths],
      requiredChecks,
      pinnedChecks,
      createdAt,
    };
    writeAuthoritySession(session, true);
    return session;
  } catch (error) {
    terminallyRevokeMaintainerReservation(
      initial.gitCommonDirectory,
      reservation.grantId,
      sessionId,
      failureReason(error),
      options.now,
    );
    throw error;
  }
}

export function checkAuthoritySession(
  cwd: string,
  requestedSessionId: string,
  options: AuthoritySessionOptions = {},
): {
  sessionId: string;
  grantId: string;
  changedPaths: string[];
  checks: CheckEvidence[];
  reportId: string;
  passed: true;
} {
  const initialSession = readAuthoritySession(cwd, requestedSessionId);
  if (initialSession.state !== 'active') {
    throw authorityError(
      'AUTHORITY_SESSION_NOT_ACTIVE',
      `Authority session ${initialSession.sessionId} is ${initialSession.state}.`,
    );
  }
  try {
    const { git, envelope, contractDigest } = inspectAuthoritySession(
      cwd,
      initialSession,
      options,
    );
    const changedPaths = listChangedPaths(git.repositoryRoot, git.head);
    const allowedPaths = envelope.payload.allowedPaths;
    const unexpectedPaths = changedPaths.filter(
      (filePath) => !allowedPaths.includes(filePath),
    );
    if (changedPaths.length === 0 || unexpectedPaths.length > 0) {
      throw authorityError(
        'AUTHORITY_SCOPE_INVALID',
        'Authority check requires at least one change and only exact grant paths.',
        { unexpectedPaths },
      );
    }
    const database = initialSession.pinnedChecks.some(
      ({ definition }) => definition.destructiveDatabase,
    )
      ? assertDisposableDatabase(options.environment ?? process.env)
      : undefined;
    const initialFingerprint = fingerprintWorkingState(
      git.repositoryRoot,
      git.head,
      git.statusEntries,
    );
    const checks: CheckEvidence[] = [];
    for (const pinned of initialSession.pinnedChecks) {
      checks.push(
        runCheck(
          git.repositoryRoot,
          pinned.checkId,
          pinned.definition,
          pinned.runner,
          createCheckEnvironment(
            options.environment ?? process.env,
            pinned.definition.destructiveDatabase,
          ),
          pinned.definition.destructiveDatabase
            ? database?.identity
            : undefined,
        ),
      );
      const current = discoverRepository(git.repositoryRoot);
      if (
        current.head !== git.head ||
        fingerprintWorkingState(
          current.repositoryRoot,
          current.head,
          current.statusEntries,
        ) !== initialFingerprint
      ) {
        throw authorityError(
          'AUTHORITY_CHECK_MUTATED_WORKTREE',
          `Required check ${pinned.checkId} changed the authority checkout.`,
        );
      }
    }
    const paths = maintainerGrantStorePaths(git.gitCommonDirectory);
    const reportId = writeAuthorityCheckReport(paths.runtime.reports, {
      sessionId: initialSession.sessionId,
      changeId: initialSession.changeId,
      grantId: initialSession.grantId,
      baseCommit: initialSession.baseCommit,
      policyBlob: initialSession.policyBlob,
      contractDigest,
      allowedPaths,
      changedPaths,
      requiredChecks: initialSession.requiredChecks,
      checks,
      fingerprint: initialFingerprint,
      createdAt: exactDate(options.now ?? new Date()).toISOString(),
    });
    writeAuthoritySession(
      { ...initialSession, latestCheckReportId: reportId },
      false,
    );
    return {
      sessionId: initialSession.sessionId,
      grantId: envelope.payload.grantId,
      changedPaths,
      checks,
      reportId,
      passed: true,
    };
  } catch (error) {
    failAuthoritySession(initialSession, error, options.now);
    throw error;
  }
}

export function abortAuthoritySession(
  cwd: string,
  requestedSessionId: string,
  reason: string,
  now = new Date(),
): AuthoritySession {
  const session = readAuthoritySession(cwd, requestedSessionId);
  if (session.state !== 'active' || !reason || reason.trim() !== reason) {
    throw authorityError(
      'AUTHORITY_ABORT_INVALID',
      'Only an active authority session may be aborted with an exact reason.',
    );
  }
  terminallyRevokeMaintainerReservation(
    session.gitCommonDirectory,
    session.grantId,
    session.sessionId,
    `Authority cancellation: ${reason}`,
    now,
  );
  const aborted: AuthoritySession = {
    ...session,
    state: 'aborted',
    abortedAt: exactDate(now).toISOString(),
    abortReason: reason,
  };
  writeAuthoritySession(aborted, false);
  return aborted;
}

export function readAuthoritySession(
  cwd: string,
  requestedSessionId: string,
): AuthoritySession {
  const git = discoverRepository(cwd);
  const sessionId = assertSessionId(requestedSessionId);
  const paths = maintainerGrantStorePaths(git.gitCommonDirectory);
  const sessionPath = path.join(paths.sessions, `${sessionId}.json`);
  const stats = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw authorityError(
      'AUTHORITY_SESSION_INVALID',
      'Authority session state is unavailable or unsafe.',
    );
  }
  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const value = JSON.parse(raw) as AuthoritySession;
    if (
      raw !== `${JSON.stringify(value)}\n` ||
      value.schemaVersion !== 1 ||
      value.sessionId !== sessionId ||
      !['active', 'failed', 'aborted', 'committed'].includes(value.state) ||
      value.gitCommonDirectory !== git.gitCommonDirectory ||
      !Array.isArray(value.allowedPaths) ||
      !Array.isArray(value.requiredChecks) ||
      !Array.isArray(value.pinnedChecks)
    ) {
      throw new Error('invalid authority session');
    }
    return value;
  } catch {
    throw authorityError(
      'AUTHORITY_SESSION_INVALID',
      'Authority session state is malformed.',
    );
  }
}

export function inspectActiveAuthoritySession(
  cwd: string,
  requestedSessionId: string,
  options: AuthoritySessionOptions = {},
) {
  const session = readAuthoritySession(cwd, requestedSessionId);
  if (session.state !== 'active') {
    throw authorityError(
      'AUTHORITY_SESSION_NOT_ACTIVE',
      `Authority session ${session.sessionId} is ${session.state}.`,
    );
  }
  return { session, ...inspectAuthoritySession(cwd, session, options) };
}

export function markAuthoritySessionCommitted(
  cwd: string,
  expected: AuthoritySession,
  commitHash: string,
  now = new Date(),
): AuthoritySession {
  const current = readAuthoritySession(cwd, expected.sessionId);
  if (current.state === 'committed' && current.commitHash === commitHash) {
    return current;
  }
  if (
    current.state !== 'active' ||
    JSON.stringify(current) !== JSON.stringify(expected) ||
    !/^[0-9a-f]{40,64}$/.test(commitHash)
  ) {
    throw authorityError(
      'AUTHORITY_SESSION_CHANGED',
      'Authority session changed before commit finalization.',
    );
  }
  const committed: AuthoritySession = {
    ...current,
    state: 'committed',
    committedAt: exactDate(now).toISOString(),
    commitHash,
  };
  writeAuthoritySession(committed, false);
  return committed;
}

function inspectAuthoritySession(
  cwd: string,
  session: AuthoritySession,
  options: AuthoritySessionOptions,
) {
  const git = discoverRepository(cwd);
  if (
    git.repositoryRealPath !== session.repositoryRoot ||
    git.gitCommonDirectory !== session.gitCommonDirectory ||
    git.branch !== session.branch ||
    git.head !== session.baseCommit
  ) {
    throw authorityError(
      'AUTHORITY_BASE_DRIFT',
      'Authority repository, branch, or base changed after start.',
    );
  }
  const reservation = readReservedMaintainerGrant(
    git.gitCommonDirectory,
    session.grantId,
  );
  if (
    reservation.sessionId !== session.sessionId ||
    reservation.repositoryRoot !== session.repositoryRoot ||
    digest(canonicalGrantEnvelope(reservation.envelope)) !== session.grantDigest
  ) {
    throw authorityError(
      'AUTHORITY_RESERVATION_MISMATCH',
      'Authority reservation no longer matches the pinned session.',
    );
  }
  const { policy, policyContent, policyBlob } = loadBasePolicy(
    git.repositoryRoot,
    session.baseCommit,
  );
  if (
    policyBlob !== session.policyBlob ||
    digest(policyContent) !== session.policyDigest
  ) {
    throw authorityError(
      'AUTHORITY_POLICY_DRIFT',
      'Pinned maintainer policy changed after authority start.',
    );
  }
  validateGrantPayload(reservation.envelope.payload, policy, {
    now: exactDate(options.now ?? new Date()),
    expectedBase: session.baseCommit,
    expectedPolicyBlob: session.policyBlob,
  });
  assertGrantPathsEligible(
    git.repositoryRoot,
    reservation.envelope.payload.allowedPaths,
    policy,
  );
  verifyEnvelopeSignature(
    git.repositoryRoot,
    reservation.envelope,
    policy,
    options.signer,
  );
  assertExactAuditTag(git.repositoryRoot, reservation.envelope, policy);
  const stable = loadStableValidatedChangeContract(git, session.changeId);
  const allowedPaths = reservation.envelope.payload.allowedPaths;
  const expectedContractArtifacts = Object.fromEntries(
    Object.entries(stable.contract.artifactDigests).filter(
      ([filePath]) => !allowedPaths.includes(filePath),
    ),
  );
  if (!sameRecord(session.contractArtifacts, expectedContractArtifacts)) {
    throw authorityError(
      'AUTHORITY_CONTRACT_DRIFT',
      'Pinned OpenSpec authority changed after start.',
    );
  }
  const expectedBranch = stable.contract.config.branchTemplate.replace(
    '{changeId}',
    session.changeId,
  );
  const expectedRequiredChecks = requiredAuthorityChecks(
    policy,
    stable.contract.guard.tasks,
  );
  const baseChecks = loadBaseCheckDefinitions(
    git.repositoryRoot,
    session.baseCommit,
    expectedRequiredChecks,
  );
  const pinnedChecksAreExact =
    session.pinnedChecks.length === expectedRequiredChecks.length &&
    session.pinnedChecks.every((pinned, index) => {
      const checkId = expectedRequiredChecks[index];
      const definition = baseChecks[checkId];
      if (
        pinned.checkId !== checkId ||
        JSON.stringify(pinned.definition) !== JSON.stringify(definition)
      ) {
        return false;
      }
      try {
        return (
          JSON.stringify(pinned.runner) ===
          JSON.stringify(
            pinCheckRunner(git.repositoryRoot, checkId, definition),
          )
        );
      } catch {
        return false;
      }
    });
  if (
    reservation.envelope.payload.changeId !== session.changeId ||
    reservation.envelope.payload.signer !== session.signer ||
    git.branch !== expectedBranch ||
    git.tree !== session.baselineTree ||
    !sameStringArray(session.allowedPaths, allowedPaths) ||
    !sameStringArray(session.requiredChecks, expectedRequiredChecks) ||
    !pinnedChecksAreExact
  ) {
    throw authorityError(
      'AUTHORITY_SESSION_MISMATCH',
      'Authority session state differs from its signed and base-pinned inputs.',
    );
  }
  return {
    git: stable.git,
    envelope: reservation.envelope,
    policy,
    contractDigest: session.contractDigest,
  };
}

export function failAuthoritySession(
  session: AuthoritySession,
  error: unknown,
  now = new Date(),
): void {
  terminallyRevokeMaintainerReservation(
    session.gitCommonDirectory,
    session.grantId,
    session.sessionId,
    failureReason(error),
    now,
  );
  writeAuthoritySession(
    {
      ...session,
      state: 'failed',
      failedAt: exactDate(now).toISOString(),
      failureReason: failureReason(error),
    },
    false,
  );
}

function loadBasePolicy(repositoryRoot: string, baseCommit: string) {
  try {
    const policyContent = runGit(repositoryRoot, [
      'show',
      `${baseCommit}:workflow/maintainer-policy.json`,
    ]);
    const policy = parseMaintainerPolicy(JSON.parse(policyContent));
    const policyBlob = runGit(repositoryRoot, [
      'rev-parse',
      `${baseCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    return { policy, policyContent, policyBlob };
  } catch {
    throw authorityError(
      'AUTHORITY_POLICY_INVALID',
      'The exact base maintainer policy is unavailable or invalid.',
    );
  }
}

function verifyEnvelopeSignature(
  repositoryRoot: string,
  envelope: MaintainerGrantEnvelope,
  policy: MaintainerPolicy,
  signer = createInteractiveSshSigner(repositoryRoot, policy),
): void {
  try {
    signer.verify(
      canonicalGrantPayload(envelope.payload),
      envelope.signature,
      envelope.payload.signer,
    );
  } catch {
    throw authorityError(
      'AUTHORITY_SIGNATURE_INVALID',
      'The maintainer grant signature is invalid.',
    );
  }
}

function assertExactAuditTag(
  repositoryRoot: string,
  envelope: MaintainerGrantEnvelope,
  policy: MaintainerPolicy,
): void {
  const tagRef = `${policy.auditTagPrefix}${envelope.payload.grantId}`;
  try {
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagRef]);
    const separator = raw.indexOf('\n\n');
    const headers = raw.slice(0, separator).split('\n');
    const object = headers.find((line) => line.startsWith('object '))?.slice(7);
    const type = headers.find((line) => line.startsWith('type '))?.slice(5);
    const tag = headers.find((line) => line.startsWith('tag '))?.slice(4);
    if (
      separator === -1 ||
      object !== envelope.payload.baseCommit ||
      type !== 'commit' ||
      tag !== tagRef.slice('refs/tags/'.length) ||
      raw.slice(separator + 2) !== canonicalGrantEnvelope(envelope)
    ) {
      throw new Error('audit mismatch');
    }
  } catch {
    throw authorityError(
      'AUTHORITY_AUDIT_TAG_INVALID',
      'The exact maintainer audit tag is missing or different.',
    );
  }
}

function writeAuthoritySession(
  session: AuthoritySession,
  create: boolean,
): void {
  const paths = maintainerGrantStorePaths(session.gitCommonDirectory);
  const target = path.join(paths.sessions, `${session.sessionId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  const content = `${JSON.stringify(session)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (create) {
      try {
        fs.linkSync(temporary, target);
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw authorityError(
            'AUTHORITY_SESSION_EXISTS',
            'Authority session state already exists.',
          );
        }
        throw error;
      }
    } else {
      fs.renameSync(temporary, target);
    }
    const directory = fs.openSync(paths.sessions, fs.constants.O_RDONLY);
    fs.fsyncSync(directory);
    fs.closeSync(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function requiredAuthorityChecks(
  policy: MaintainerPolicy,
  tasks: Record<string, { requiredChecks: string[] }>,
): string[] {
  return [
    ...new Set([
      ...policy.requiredChecks,
      ...Object.values(tasks).flatMap(({ requiredChecks }) => requiredChecks),
    ]),
  ].sort();
}

function loadBaseCheckDefinitions(
  repositoryRoot: string,
  baseCommit: string,
  requiredChecks: string[],
): Record<string, CheckDefinition> {
  try {
    const raw = JSON.parse(
      runGit(repositoryRoot, ['show', `${baseCommit}:workflow/checks.json`]),
    ) as { schemaVersion?: unknown; checks?: unknown };
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.checks !== 'object' ||
      raw.checks === null ||
      Array.isArray(raw.checks)
    ) {
      throw new Error('invalid base checks');
    }
    const checks = raw.checks as Record<string, unknown>;
    return Object.fromEntries(
      requiredChecks.map((checkId) => {
        const definition = checks[checkId] as
          Partial<CheckDefinition> | undefined;
        if (
          !definition ||
          !Array.isArray(definition.command) ||
          !definition.command.every((part) => typeof part === 'string') ||
          typeof definition.destructiveDatabase !== 'boolean'
        ) {
          throw new Error(`invalid base check ${checkId}`);
        }
        return [
          checkId,
          {
            command: [...definition.command],
            destructiveDatabase: definition.destructiveDatabase,
          },
        ];
      }),
    );
  } catch {
    throw authorityError(
      'AUTHORITY_CHECK_INVALID',
      'Required check definitions are unavailable from the exact grant base.',
    );
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw authorityError(
      'AUTHORITY_TIME_INVALID',
      'Authority transition requires an exact timestamp.',
    );
  }
  return date;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function failureReason(error: unknown): string {
  return error instanceof WorkflowError
    ? `${error.code}: ${error.message}`
    : 'AUTHORITY_OPERATION_FAILED';
}

function authorityError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.staleState, { details });
}
