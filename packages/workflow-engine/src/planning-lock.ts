import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import {
  readSessionFile,
  type runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';

type RuntimePaths = ReturnType<typeof runtimePaths>;

export function withPlanningAuthority<T>(
  runtime: RuntimePaths,
  changeId: string,
  operation: (assertOwned: () => void) => T,
): T {
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withPlanningChangeLock(runtime, changeId, (assertChangeLock) => {
      assertNoActiveSessions(runtime);
      return operation(() => {
        assertRepositoryLock();
        assertChangeLock();
      });
    }),
  );
}

function withPlanningChangeLock<T>(
  runtime: RuntimePaths,
  changeId: string,
  operation: (assertOwned: () => void) => T,
): T {
  ensurePlainDirectory(runtime.locks);
  const lockPath = path.join(runtime.locks, `${changeId}.lock`);
  const operationId = `plan-${crypto.randomUUID()}`;
  const content = `${JSON.stringify({ operationId, changeId, transition: 'plan' })}\n`;
  let descriptor: number | undefined;
  const assertOwned = () => {
    if (descriptor === undefined) {
      throw staleLock();
    }
    const owned = fs.fstatSync(descriptor);
    const stats = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    let observed: string | undefined;
    try {
      observed = fs.readFileSync(lockPath, 'utf8');
    } catch {
      observed = undefined;
    }
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.dev !== owned.dev ||
      stats.ino !== owned.ino ||
      observed !== content
    ) {
      throw staleLock();
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
      throw existingChangeLockError(lockPath);
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
      throw staleLock();
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(lockPath);
  };

  let result: T;
  try {
    result = operation(assertOwned);
  } catch (error) {
    release();
    throw error;
  }
  release();
  return result;
}

function assertNoActiveSessions(runtime: RuntimePaths): void {
  const stats = fs.lstatSync(runtime.sessions, { throwIfNoEntry: false });
  if (!stats) {
    return;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw workflowError(
      'SESSION_DIRECTORY_UNSAFE',
      'Workflow session directory is unsafe.',
      ExitCode.staleState,
    );
  }
  const active = fs
    .readdirSync(runtime.sessions)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readSessionFile(path.join(runtime.sessions, entry)))
    .filter((session) => session.state === 'active')
    .map((session) => session.sessionId)
    .sort();
  if (active.length > 0) {
    throw workflowError(
      'ACTIVE_SESSION_CONFLICT',
      'Planning transitions require no active workflow session.',
      ExitCode.conflict,
      { details: { activeSessionIds: active } },
    );
  }
}

function existingChangeLockError(lockPath: string) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      'sessionId' in value &&
      typeof value.sessionId === 'string'
    ) {
      return workflowError(
        'ACTIVE_SESSION_CONFLICT',
        'Change already has an active task session.',
        ExitCode.conflict,
      );
    }
  } catch {
    // A malformed occupied lock remains an exclusive conflict.
  }
  return workflowError(
    'PLANNING_TRANSITION_CONFLICT',
    'Change already has a lifecycle transition in progress.',
    ExitCode.conflict,
  );
}

function staleLock() {
  return workflowError(
    'PLANNING_LOCK_INVALID',
    'Planning change lock ownership changed during the transition.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
