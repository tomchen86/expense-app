import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

export type WorkflowSession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'aborted';
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
  createdAt: string;
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
    sessions: path.join(root, 'sessions'),
  };
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
  if (
    typeof value.sessionId !== 'string' ||
    (value.state !== 'active' && value.state !== 'aborted') ||
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
  if (
    value.state === 'aborted' &&
    (typeof value.abortedAt !== 'string' ||
      Number.isNaN(Date.parse(value.abortedAt)) ||
      typeof value.abortReason !== 'string' ||
      !value.abortReason)
  ) {
    return false;
  }
  return true;
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
