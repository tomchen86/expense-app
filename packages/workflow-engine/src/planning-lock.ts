import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import {
  listActiveWorkflowSessionIds,
  type runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';

type RuntimePaths = ReturnType<typeof runtimePaths>;

export function withPlanningAuthority<T>(
  runtime: RuntimePaths,
  changeId: string,
  operation: (assertOwned: () => void) => T,
): T {
  return withChangeTransitionAuthority(runtime, changeId, 'plan', operation);
}

/**
 * Investigation creation shares the repository and per-change transition
 * locks with task, plan, and archive transitions. The callback must contain
 * only synchronous persistence/CAS work: provider execution and caller/human
 * waits happen after both locks have been released.
 */
export function withInvestigationTransitionAuthority<T>(
  runtime: RuntimePaths,
  changeId: string,
  operation: (assertOwned: () => void) => T,
): T {
  reclaimDeadInvestigationTransitionLocks(runtime, changeId);
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withChangeTransitionLock(
      runtime,
      changeId,
      'investigation',
      (assertChangeLock) => {
        assertNoActiveSessions(runtime);
        return operation(() => {
          assertRepositoryLock();
          assertChangeLock();
        });
      },
    ),
  );
}

export function withChangeTransitionAuthority<T>(
  runtime: RuntimePaths,
  changeId: string,
  transition: 'plan' | 'archive',
  operation: (assertOwned: () => void) => T,
): T {
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withChangeTransitionLock(
      runtime,
      changeId,
      transition,
      (assertChangeLock) => {
        assertNoActiveSessions(runtime);
        return operation(() => {
          assertRepositoryLock();
          assertChangeLock();
        });
      },
    ),
  );
}

function withChangeTransitionLock<T>(
  runtime: RuntimePaths,
  changeId: string,
  transition: 'plan' | 'archive' | 'investigation',
  operation: (assertOwned: () => void) => T,
): T {
  ensurePlainDirectory(runtime.locks);
  const lockPath = path.join(runtime.locks, `${changeId}.lock`);
  const operationId = `${transition}-${crypto.randomUUID()}`;
  const content = `${JSON.stringify({
    operationId,
    changeId,
    transition,
    pid: process.pid,
  })}\n`;
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
      throw existingChangeLockError(lockPath, transition);
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

function reclaimDeadInvestigationTransitionLocks(
  runtime: RuntimePaths,
  changeId: string,
): void {
  ensurePlainDirectory(runtime.operations);
  ensurePlainDirectory(runtime.locks);
  reclaimDeadTransitionLock(
    path.join(runtime.operations, 'repository-lifecycle.lock'),
    (value) =>
      isRecord(value) &&
      hasExactKeys(value, ['kind', 'ownerToken', 'pid']) &&
      value.kind === 'repository-lifecycle' &&
      typeof value.ownerToken === 'string' &&
      value.ownerToken.length > 0 &&
      Number.isSafeInteger(value.pid)
        ? (value.pid as number)
        : null,
  );
  reclaimDeadTransitionLock(
    path.join(runtime.locks, `${changeId}.lock`),
    (value) =>
      isRecord(value) &&
      hasExactKeys(value, ['operationId', 'changeId', 'transition', 'pid']) &&
      typeof value.operationId === 'string' &&
      value.changeId === changeId &&
      value.transition === 'investigation' &&
      Number.isSafeInteger(value.pid)
        ? (value.pid as number)
        : null,
  );
}

function reclaimDeadTransitionLock(
  lockPath: string,
  readOwnerPid: (value: unknown) => number | null,
): void {
  const before = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!before) {
    return;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600
  ) {
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600
    ) {
      return;
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return;
    }
    const pid = readOwnerPid(value);
    if (pid === null || pid < 1 || isProcessAlive(pid)) {
      return;
    }
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      !observed ||
      observed.dev !== opened.dev ||
      observed.ino !== opened.ino
    ) {
      return;
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function assertNoActiveSessions(runtime: RuntimePaths): void {
  const active = listActiveWorkflowSessionIds(runtime);
  if (active.length > 0) {
    throw workflowError(
      'ACTIVE_SESSION_CONFLICT',
      'Planning transitions require no active workflow session.',
      ExitCode.conflict,
      { details: { activeSessionIds: active } },
    );
  }
}

function existingChangeLockError(
  lockPath: string,
  transition: 'plan' | 'archive' | 'investigation',
) {
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
    transition === 'archive'
      ? 'ARCHIVE_TRANSITION_CONFLICT'
      : transition === 'investigation'
        ? 'INVESTIGATION_TRANSITION_CONFLICT'
        : 'PLANNING_TRANSITION_CONFLICT',
    `Change already has a ${transition} transition in progress.`,
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
