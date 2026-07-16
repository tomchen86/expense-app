import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';

const MAINTAINER_GRANT_STATE_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export type WorkflowSession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'aborted' | 'committed';
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: {
    head: string;
    tree: string;
  };
  artifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  requiredCheckDigests?: Record<string, string>;
  createdAt: string;
  latestCheckReportId?: string;
  completionReportId?: string;
  finishReportId?: string;
  commitReportId?: string;
  commitHash?: string;
  committedAt?: string;
  abortedAt?: string;
  abortReason?: string;
};

export function runtimePaths(
  gitCommonDirectory: string,
  runtimeDirectory: string,
) {
  const root = path.join(gitCommonDirectory, runtimeDirectory);
  return {
    root,
    locks: path.join(root, 'locks'),
    operations: path.join(root, 'operations'),
    sessions: path.join(root, 'sessions'),
    reports: path.join(root, 'reports'),
  };
}

export function withSessionOperation<T>(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
  operation: () => T,
): T {
  ensurePlainDirectory(runtime.operations);
  const lockPath = path.join(runtime.operations, `${sessionId}.lock`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ sessionId, pid: process.pid })}\n`,
      'utf8',
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw workflowError(
        'SESSION_OPERATION_CONFLICT',
        `Session ${sessionId} already has an operation in progress.`,
        ExitCode.conflict,
      );
    }
    throw error;
  }

  try {
    return operation();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export function withRepositoryLifecycleOperation<T>(
  runtime: ReturnType<typeof runtimePaths>,
  operation: (assertOwned: () => void) => T,
  options: { allowMaintainerGrantId?: string } = {},
): T {
  ensurePlainDirectory(runtime.operations);
  const lockPath = path.join(runtime.operations, 'repository-lifecycle.lock');
  const ownerToken = crypto.randomUUID();
  const content = `${JSON.stringify({
    kind: 'repository-lifecycle',
    ownerToken,
    pid: process.pid,
  })}\n`;
  let descriptor: number | undefined;
  const assertOwned = () => {
    if (descriptor === undefined) {
      throw invalidRepositoryLifecycleLock(
        'Repository lifecycle lock ownership was lost.',
      );
    }
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    let observedContent: string | undefined;
    try {
      observedContent = fs.readFileSync(lockPath, 'utf8');
    } catch {
      observedContent = undefined;
    }
    if (
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.dev !== owned.dev ||
      observed.ino !== owned.ino ||
      observedContent !== content
    ) {
      throw invalidRepositoryLifecycleLock(
        'Repository lifecycle lock ownership changed during the transition.',
      );
    }
  };
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw workflowError(
        'REPOSITORY_LIFECYCLE_CONFLICT',
        'Another repository lifecycle transition is in progress.',
        ExitCode.conflict,
      );
    }
    throw error;
  }

  const release = () => {
    try {
      assertOwned();
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      throw error;
    }
    if (descriptor === undefined) {
      throw invalidRepositoryLifecycleLock(
        'Repository lifecycle lock ownership was lost.',
      );
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(lockPath);
  };

  let result: T;
  try {
    assertMaintainerReservationCompatibility(
      runtime,
      options.allowMaintainerGrantId,
    );
    result = operation(assertOwned);
  } catch (error) {
    release();
    throw error;
  }
  release();
  return result;
}

export function listActiveWorkflowSessionIds(
  runtime: ReturnType<typeof runtimePaths>,
): string[] {
  const stats = fs.lstatSync(runtime.sessions, { throwIfNoEntry: false });
  if (!stats) {
    return [];
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw workflowError(
      'SESSION_DIRECTORY_UNSAFE',
      'Workflow session directory is unsafe.',
      ExitCode.staleState,
    );
  }
  return fs
    .readdirSync(runtime.sessions)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readSessionFile(path.join(runtime.sessions, entry)))
    .filter((session) => session.state === 'active')
    .map((session) => session.sessionId)
    .sort();
}

function assertMaintainerReservationCompatibility(
  runtime: ReturnType<typeof runtimePaths>,
  allowedGrantId: string | undefined,
): void {
  const reservedDirectory = path.join(
    runtime.root,
    'maintainer-grants',
    'reserved',
  );
  const stats = fs.lstatSync(reservedDirectory, { throwIfNoEntry: false });
  if (!stats) {
    return;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(reservedDirectory) !== path.resolve(reservedDirectory) ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_STORE_UNSAFE',
      'Maintainer grant reservation storage is unsafe.',
      ExitCode.staleState,
    );
  }
  const entries = fs.readdirSync(reservedDirectory);
  if (entries.some((entry) => !MAINTAINER_GRANT_STATE_FILE.test(entry))) {
    throw workflowError(
      'MAINTAINER_GRANT_STORE_UNSAFE',
      'Maintainer grant reservation storage contains an invalid entry.',
      ExitCode.staleState,
    );
  }
  const reservations = entries
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
  if (
    reservations.length === 0 ||
    (allowedGrantId !== undefined &&
      reservations.length === 1 &&
      reservations[0] === allowedGrantId)
  ) {
    return;
  }
  throw workflowError(
    'ACTIVE_AUTHORITY_CONFLICT',
    'A maintainer authority reservation already owns the repository lifecycle.',
    ExitCode.conflict,
    { details: { grantIds: reservations } },
  );
}

function invalidRepositoryLifecycleLock(message: string) {
  return workflowError(
    'REPOSITORY_LIFECYCLE_LOCK_INVALID',
    message,
    ExitCode.staleState,
  );
}

export function readSessionFile(sessionPath: string): WorkflowSession {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'SESSION_UNREADABLE',
      `Unable to read session: ${path.basename(sessionPath, '.json')}`,
      ExitCode.staleState,
      {
        details: {
          sessionPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }

  if (!isWorkflowSession(value)) {
    throw workflowError(
      'INVALID_SESSION',
      `Session file is malformed: ${sessionPath}`,
      ExitCode.staleState,
    );
  }

  const expectedSessionId = path.basename(sessionPath, '.json');
  if (value.sessionId !== expectedSessionId) {
    throw workflowError(
      'SESSION_ID_MISMATCH',
      `Session content does not match filename ${expectedSessionId}.`,
      ExitCode.staleState,
    );
  }

  return value;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function releaseOwnedLock(lockPath: string, sessionId: string): void {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    value.sessionId === sessionId
  ) {
    fs.rmSync(lockPath, { force: true });
  }
}

export function assertOwnedLock(
  lockPath: string,
  sessionId: string,
  changeId: string,
  taskId: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    throw invalidSessionLock();
  }

  if (
    !isRecord(value) ||
    value.sessionId !== sessionId ||
    value.changeId !== changeId ||
    value.taskId !== taskId
  ) {
    throw invalidSessionLock();
  }
}

export function createSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `session-${timestamp}-${crypto.randomUUID()}`;
}

function isWorkflowSession(value: unknown): value is WorkflowSession {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }
  const allowedFields = new Set([
    'schemaVersion',
    'sessionId',
    'state',
    'changeId',
    'taskId',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'artifacts',
    'allowedPaths',
    'requiredChecks',
    'requiredCheckDigests',
    'createdAt',
    'latestCheckReportId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
    'commitHash',
    'committedAt',
    'abortedAt',
    'abortReason',
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    return false;
  }
  if (
    typeof value.sessionId !== 'string' ||
    !['active', 'aborted', 'committed'].includes(String(value.state)) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isRecord(value.baseline) ||
    typeof value.baseline.head !== 'string' ||
    typeof value.baseline.tree !== 'string' ||
    !isStringRecord(value.artifacts) ||
    !isStringArray(value.allowedPaths) ||
    !isStringArray(value.requiredChecks)
  ) {
    return false;
  }
  for (const field of [
    'latestCheckReportId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
  ]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isDigest(fieldValue)) {
      return false;
    }
  }
  if (
    value.requiredCheckDigests !== undefined &&
    !isStringRecord(value.requiredCheckDigests)
  ) {
    return false;
  }
  if (
    (value.commitHash !== undefined && !isCommitHash(value.commitHash)) ||
    (value.commitReportId === undefined) !== (value.commitHash === undefined)
  ) {
    return false;
  }
  if (
    value.state === 'active' &&
    value.commitReportId !== undefined &&
    (value.finishReportId === undefined || value.committedAt !== undefined)
  ) {
    return false;
  }
  if (
    value.state === 'aborted' &&
    (typeof value.abortedAt !== 'string' ||
      Number.isNaN(Date.parse(value.abortedAt)) ||
      typeof value.abortReason !== 'string' ||
      !value.abortReason)
  ) {
    return false;
  }
  if (
    value.state === 'committed' &&
    (!isDigest(value.latestCheckReportId) ||
      !isDigest(value.completionReportId) ||
      !isDigest(value.finishReportId) ||
      !isDigest(value.commitReportId) ||
      !isCommitHash(value.commitHash) ||
      typeof value.committedAt !== 'string' ||
      Number.isNaN(Date.parse(value.committedAt)))
  ) {
    return false;
  }
  return true;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isCommitHash(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function invalidSessionLock() {
  return workflowError(
    'SESSION_LOCK_INVALID',
    'The active session lock is missing or does not match the session.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
