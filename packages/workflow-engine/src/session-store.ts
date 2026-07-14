import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

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
  fs.mkdirSync(runtime.operations, { recursive: true });
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
