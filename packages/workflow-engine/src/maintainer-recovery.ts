import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import {
  authorityCommitMessage,
  commitChangedPaths,
  commitFacts,
  rollbackExactStaging,
  updateManagedRef,
} from './git-transitions.ts';
import { discoverRepository, runGit } from './git.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  failAuthoritySession,
  markAuthoritySessionCommitted,
  readAuthoritySession,
  type AuthoritySession,
} from './maintainer-session.ts';
import {
  consumeMaintainerReservationUnderLifecycleLock,
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
} from './maintainer-store.ts';
import { parseManagedTrailers } from './managed-trailers.ts';
import { assertSessionId } from './paths.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';

export type AuthorityCommitJournalState =
  'preparing' | 'commit-created' | 'ref-updated' | 'consumed' | 'revoked';

export type AuthorityCommitJournal = {
  schemaVersion: 1;
  state: AuthorityCommitJournalState;
  sessionId: string;
  grantId: string;
  changeId: string;
  repositoryRoot: string;
  branch: string;
  baseCommit: string;
  expectedTree: string;
  previousIndexTree: string;
  allowedPaths: string[];
  subject: string;
  messageDigest: string;
  policyBlob: string;
  signer: string;
  commitHash: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthorityCommitResult = {
  session: AuthoritySession;
  grantId: string;
  commitHash: string;
  changedPaths: string[];
  journalState: 'consumed';
};

export function beginAuthorityCommitJournal(
  session: AuthoritySession,
  input: {
    expectedTree: string;
    previousIndexTree: string;
    changedPaths: string[];
    subject: string;
    now: Date;
  },
): AuthorityCommitJournal {
  const timestamp = exactDate(input.now).toISOString();
  const journal: AuthorityCommitJournal = {
    schemaVersion: 1,
    state: 'preparing',
    sessionId: session.sessionId,
    grantId: session.grantId,
    changeId: session.changeId,
    repositoryRoot: session.repositoryRoot,
    branch: session.branch,
    baseCommit: session.baseCommit,
    expectedTree: assertObjectId(input.expectedTree),
    previousIndexTree: assertObjectId(input.previousIndexTree),
    allowedPaths: [...input.changedPaths],
    subject: input.subject,
    messageDigest: digest(
      `${authorityCommitMessage(
        input.subject,
        session.changeId,
        session.grantId,
      )}\n`,
    ),
    policyBlob: assertObjectId(session.policyBlob),
    signer: session.signer,
    commitHash: null,
    reason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeJournal(session.gitCommonDirectory, journal, true);
  return journal;
}

export function recordAuthorityCommitCreated(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  commitHash: string,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'preparing', {
    state: 'commit-created',
    commitHash: assertObjectId(commitHash),
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recordAuthorityRefUpdated(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'commit-created', {
    state: 'ref-updated',
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recoverAuthorityCommit(
  cwd: string,
  requestedSessionId: string,
  now = new Date(),
): AuthorityCommitResult {
  const session = readAuthoritySession(cwd, requestedSessionId);
  const journal = readAuthorityCommitJournal(
    session.gitCommonDirectory,
    session.sessionId,
  );
  assertJournalMatchesSession(journal, session);

  if (journal.state === 'revoked') {
    throw recoveryError(
      'AUTHORITY_RECOVERY_REVOKED',
      'The authority transaction was terminally revoked.',
    );
  }
  if (journal.state === 'preparing') {
    revokePreparingTransaction(cwd, session, journal, now);
  }

  try {
    return withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const currentSession = readAuthoritySession(cwd, session.sessionId);
        assertJournalMatchesSession(journal, currentSession);
        const currentJournal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        if (currentJournal.state === 'consumed') {
          return finalizeConsumed(cwd, currentSession, currentJournal, now);
        }
        if (
          currentJournal.state !== 'commit-created' &&
          currentJournal.state !== 'ref-updated'
        ) {
          throw recoveryError(
            'AUTHORITY_JOURNAL_DIVERGED',
            'Authority journal state changed during recovery.',
          );
        }
        const commitHash = requireCommitHash(currentJournal);
        verifyJournaledCommit(cwd, currentSession, currentJournal, commitHash);
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (indexTree !== currentJournal.expectedTree) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_INDEX_DIVERGED',
            'The Git index differs from the journaled authority tree.',
          );
        }
        let advanced = currentJournal;
        if (git.head === currentJournal.baseCommit) {
          updateManagedRef(
            git.repositoryRoot,
            currentJournal.baseCommit,
            commitHash,
          );
        } else if (git.head !== commitHash) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_REF_DIVERGED',
            'The branch no longer points to the journaled base or commit.',
          );
        }
        if (advanced.state === 'commit-created') {
          advanced = recordAuthorityRefUpdated(
            session.gitCommonDirectory,
            advanced,
            now,
          );
        }
        assertOwned();
        consumeMaintainerReservationUnderLifecycleLock(
          session.gitCommonDirectory,
          session.grantId,
          session.sessionId,
          commitHash,
          now,
        );
        const consumed = transitionJournal(
          session.gitCommonDirectory,
          advanced,
          'ref-updated',
          {
            state: 'consumed',
            updatedAt: exactDate(now).toISOString(),
          },
        );
        const committed = markAuthoritySessionCommitted(
          cwd,
          currentSession,
          commitHash,
          now,
        );
        return result(committed, consumed, commitHash);
      },
      { allowMaintainerGrantId: session.grantId },
    );
  } catch (error) {
    const inspection = inspectMaintainerGrants(
      session.gitCommonDirectory,
      session.grantId,
    )[0];
    if (
      inspection?.state === 'consumed' &&
      inspection.commitHash === journal.commitHash
    ) {
      throw recoveryError(
        'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        'The grant is consumed but journal finalization must be retried.',
      );
    }
    revokeAmbiguousTransaction(session, journal, error, now);
    throw error;
  }
}

export function readAuthorityCommitJournal(
  gitCommonDirectory: string,
  requestedSessionId: string,
): AuthorityCommitJournal {
  const sessionId = assertSessionId(requestedSessionId);
  const journalPath = path.join(
    maintainerGrantStorePaths(gitCommonDirectory).journals,
    `${sessionId}.json`,
  );
  const stats = fs.lstatSync(journalPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_INVALID',
      'Authority recovery journal is missing or unsafe.',
    );
  }
  try {
    const raw = fs.readFileSync(journalPath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (
      !isJournal(value) ||
      raw !== `${JSON.stringify(value)}\n` ||
      value.sessionId !== sessionId
    ) {
      throw new Error('invalid journal');
    }
    return value;
  } catch {
    throw recoveryError(
      'AUTHORITY_JOURNAL_INVALID',
      'Authority recovery journal is malformed.',
    );
  }
}

export function verifyCreatedAuthorityCommit(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
): void {
  assertJournalMatchesSession(journal, session);
  if (journal.state !== 'commit-created') {
    throw recoveryError(
      'AUTHORITY_JOURNAL_COMMIT_MISSING',
      'Authority commit verification requires a created commit object.',
    );
  }
  verifyJournaledCommit(cwd, session, journal, requireCommitHash(journal));
}

function finalizeConsumed(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  now: Date,
): AuthorityCommitResult {
  const commitHash = requireCommitHash(journal);
  verifyJournaledCommit(cwd, session, journal, commitHash);
  const terminal = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    terminal?.state !== 'consumed' ||
    terminal.commitHash !== commitHash ||
    terminal.reservationSessionId !== session.sessionId
  ) {
    throw recoveryError(
      'AUTHORITY_TERMINAL_STATE_DIVERGED',
      'Consumed journal and terminal grant state do not match.',
    );
  }
  const committed =
    session.state === 'committed'
      ? session
      : markAuthoritySessionCommitted(cwd, session, commitHash, now);
  if (committed.commitHash !== commitHash) {
    throw recoveryError(
      'AUTHORITY_SESSION_DIVERGED',
      'Committed authority session references another commit.',
    );
  }
  return result(committed, journal, commitHash);
}

function verifyJournaledCommit(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  commitHash: string,
): void {
  const git = discoverRepository(cwd);
  if (
    git.repositoryRealPath !== journal.repositoryRoot ||
    git.gitCommonDirectory !== session.gitCommonDirectory ||
    git.branch !== journal.branch
  ) {
    throw recoveryError(
      'AUTHORITY_RECOVERY_REPOSITORY_DIVERGED',
      'Authority recovery repository or branch differs from the journal.',
    );
  }
  const facts = commitFacts(git.repositoryRoot, commitHash);
  const expectedMessage = authorityCommitMessage(
    journal.subject,
    journal.changeId,
    journal.grantId,
  );
  const trailers = parseManagedTrailers(facts.message);
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([journal.baseCommit]) ||
    facts.tree !== journal.expectedTree ||
    facts.message !== `${expectedMessage}\n` ||
    digest(facts.message) !== journal.messageDigest ||
    JSON.stringify(commitChangedPaths(git.repositoryRoot, commitHash)) !==
      JSON.stringify(journal.allowedPaths) ||
    trailers?.kind !== 'authority' ||
    trailers.changeId !== journal.changeId ||
    trailers.grantId !== journal.grantId
  ) {
    throw recoveryError(
      'AUTHORITY_COMMIT_INVALID',
      'The journaled commit does not match the exact authority transaction.',
    );
  }
  verifyCommitSignature(git.repositoryRoot, session, commitHash);
}

function verifyCommitSignature(
  repositoryRoot: string,
  session: AuthoritySession,
  commitHash: string,
): void {
  const policyContent = runGit(repositoryRoot, [
    'show',
    `${session.baseCommit}:workflow/maintainer-policy.json`,
  ]);
  const policy = parseMaintainerPolicy(JSON.parse(policyContent));
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${session.baseCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const signer = policy.trustedSigners.find(
    ({ identity }) => identity === session.signer,
  );
  if (!signer || policyBlob !== session.policyBlob) {
    throw recoveryError(
      'AUTHORITY_COMMIT_SIGNER_INVALID',
      'The journaled signer is not trusted by the exact parent policy.',
    );
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-authority-verify-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const allowedSigners = path.join(temporaryDirectory, 'allowed-signers');
  try {
    fs.writeFileSync(
      allowedSigners,
      `${signer.identity} ${signer.publicKey}\n`,
      { mode: 0o600 },
    );
    const verification = runGit(repositoryRoot, [
      '-c',
      'gpg.format=ssh',
      '-c',
      `gpg.ssh.allowedSignersFile=${allowedSigners}`,
      'show',
      '-s',
      '--format=%G?%x00%GS%x00%GF',
      commitHash,
    ]).trimEnd();
    const [status, identity, fingerprint] = verification.split('\0');
    if (
      status !== 'G' ||
      identity !== signer.identity ||
      fingerprint !== signer.fingerprint
    ) {
      throw new Error('signature mismatch');
    }
  } catch {
    throw recoveryError(
      'AUTHORITY_COMMIT_SIGNATURE_INVALID',
      'The authority commit signature is missing, invalid, or untrusted.',
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function revokePreparingTransaction(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  now: Date,
): never {
  try {
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (
          git.head !== journal.baseCommit ||
          indexTree !== journal.expectedTree
        ) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_PREPARING_DIVERGED',
            'Preparing transaction no longer matches its base and staged tree.',
          );
        }
        rollbackExactStaging(
          git.repositoryRoot,
          journal.previousIndexTree,
          journal.expectedTree,
          new Error('authority preparing recovery'),
        );
        transitionJournal(session.gitCommonDirectory, journal, 'preparing', {
          state: 'revoked',
          reason: 'Commit object was not durably journaled',
          updatedAt: exactDate(now).toISOString(),
        });
      },
      { allowMaintainerGrantId: session.grantId },
    );
  } catch (error) {
    revokeAmbiguousTransaction(session, journal, error, now);
    throw error;
  }
  const error = recoveryError(
    'AUTHORITY_RECOVERY_REVOKED',
    'Preparing authority transaction was rolled back and revoked.',
  );
  failAuthoritySession(session, error, now);
  throw error;
}

function revokeAmbiguousTransaction(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  cause: unknown,
  now: Date,
): void {
  try {
    const observed = readAuthorityCommitJournal(
      session.gitCommonDirectory,
      session.sessionId,
    );
    if (observed.state !== 'consumed' && observed.state !== 'revoked') {
      transitionJournal(session.gitCommonDirectory, observed, observed.state, {
        state: 'revoked',
        reason:
          cause instanceof Error ? cause.message : 'Ambiguous recovery state',
        updatedAt: exactDate(now).toISOString(),
      });
    }
  } catch {
    // The terminal grant record remains the fail-closed authority if the
    // private journal itself is too damaged to update safely.
  }
  if (session.state === 'active') {
    failAuthoritySession(session, cause, now);
  }
}

function transitionJournal(
  gitCommonDirectory: string,
  expected: AuthorityCommitJournal,
  expectedState: AuthorityCommitJournalState,
  update: Partial<AuthorityCommitJournal> & {
    state: AuthorityCommitJournalState;
    updatedAt: string;
  },
): AuthorityCommitJournal {
  const current = readAuthorityCommitJournal(
    gitCommonDirectory,
    expected.sessionId,
  );
  if (
    current.state !== expectedState ||
    JSON.stringify(current) !== JSON.stringify(expected)
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_DIVERGED',
      'Authority journal changed during its transaction.',
    );
  }
  const next = { ...current, ...update };
  writeJournal(gitCommonDirectory, next, false);
  return next;
}

function writeJournal(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  create: boolean,
): void {
  const directory = maintainerGrantStorePaths(gitCommonDirectory).journals;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStats = fs.lstatSync(directory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory)
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_DIRECTORY_UNSAFE',
      'Authority journal directory is unsafe.',
    );
  }
  fs.chmodSync(directory, 0o700);
  const target = path.join(directory, `${journal.sessionId}.json`);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (create) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(directoryDescriptor);
    fs.closeSync(directoryDescriptor);
  } catch (error) {
    if (create && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw recoveryError(
        'AUTHORITY_JOURNAL_EXISTS',
        'Authority session already has a commit transaction.',
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function assertJournalMatchesSession(
  journal: AuthorityCommitJournal,
  session: AuthoritySession,
): void {
  if (
    journal.sessionId !== session.sessionId ||
    journal.grantId !== session.grantId ||
    journal.changeId !== session.changeId ||
    journal.repositoryRoot !== session.repositoryRoot ||
    journal.branch !== session.branch ||
    journal.baseCommit !== session.baseCommit ||
    journal.policyBlob !== session.policyBlob ||
    journal.signer !== session.signer ||
    JSON.stringify(journal.allowedPaths) !==
      JSON.stringify([...journal.allowedPaths].sort()) ||
    journal.allowedPaths.some((entry) => !session.allowedPaths.includes(entry))
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_SESSION_MISMATCH',
      'Authority journal does not match the pinned authority session.',
    );
  }
}

function isJournal(value: unknown): value is AuthorityCommitJournal {
  if (!isRecord(value)) return false;
  const keys = [
    'schemaVersion',
    'state',
    'sessionId',
    'grantId',
    'changeId',
    'repositoryRoot',
    'branch',
    'baseCommit',
    'expectedTree',
    'previousIndexTree',
    'allowedPaths',
    'subject',
    'messageDigest',
    'policyBlob',
    'signer',
    'commitHash',
    'reason',
    'createdAt',
    'updatedAt',
  ].sort();
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((entry, index) => entry === keys[index]) &&
    value.schemaVersion === 1 &&
    [
      'preparing',
      'commit-created',
      'ref-updated',
      'consumed',
      'revoked',
    ].includes(String(value.state)) &&
    typeof value.sessionId === 'string' &&
    typeof value.grantId === 'string' &&
    typeof value.changeId === 'string' &&
    typeof value.repositoryRoot === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.subject === 'string' &&
    typeof value.signer === 'string' &&
    Array.isArray(value.allowedPaths) &&
    value.allowedPaths.every((entry) => typeof entry === 'string') &&
    isObjectId(value.baseCommit) &&
    isObjectId(value.expectedTree) &&
    isObjectId(value.previousIndexTree) &&
    isObjectId(value.policyBlob) &&
    typeof value.messageDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.messageDigest) &&
    (value.commitHash === null || isObjectId(value.commitHash)) &&
    (value.reason === null || typeof value.reason === 'string') &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function result(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  commitHash: string,
): AuthorityCommitResult {
  return {
    session,
    grantId: journal.grantId,
    commitHash,
    changedPaths: [...journal.allowedPaths],
    journalState: 'consumed',
  };
}

function requireCommitHash(journal: AuthorityCommitJournal): string {
  if (!journal.commitHash) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_COMMIT_MISSING',
      'Authority journal does not identify its commit object.',
    );
  }
  return journal.commitHash;
}

function assertObjectId(value: string): string {
  if (!isObjectId(value)) {
    throw recoveryError(
      'AUTHORITY_OBJECT_ID_INVALID',
      'Authority transaction requires full Git object IDs.',
    );
  }
  return value;
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw recoveryError(
      'AUTHORITY_RECOVERY_TIME_INVALID',
      'Authority recovery requires an exact timestamp.',
    );
  }
  return date;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recoveryError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
