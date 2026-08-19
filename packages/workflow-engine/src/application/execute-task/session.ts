import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadWorkflowConfig } from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  ensurePlainDirectory,
  publishPreparedExclusiveLock,
} from '../../runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import type { ValidatedChangeContract } from '../../adapters/planning/openspec/documents/managed-change-contract.ts';
import {
  assertChangeId,
  assertSessionId,
  assertTaskId,
} from '../../runtime/session-workspace/paths.ts';
import { createTaskPlanningAssuranceBinding } from '../../modules/assurance/planning-assurance-validator.ts';
import { reclaimDeadChangeTransitionLock } from '../../runtime/session-workspace/planning-lock.ts';
import {
  createSessionId,
  readSessionFile,
  releaseOwnedLock,
  runtimePaths,
  type WorkflowSession,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  writeJsonAtomic,
} from '../../runtime/session-workspace/session-store.ts';
import { loadStableValidatedChangeContract } from '../../validated-contract-context.ts';
import {
  authorizeTaskMandateOperation,
  type TaskMandateBinding,
  type TaskMandateOptions,
} from '../../modules/authority/task-mandate.ts';
import { assertTaskMandateOptional } from '../../adapters/consumer/expense-app/work-registry/task-authorization-policy.ts';
import {
  completeTaskRevisionAbort,
  prepareTaskRevisionAbort,
} from '../revise/task-revision.ts';

export type { WorkflowSession } from '../../runtime/session-workspace/session-store.ts';

export { checkSession } from '../finalize/verification.ts';
export type {
  SessionCheck,
  SessionCheckOptions,
} from '../finalize/verification.ts';

export function startSession(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): WorkflowSession {
  const initial = inspectSessionStart(cwd, requestedChangeId, requestedTaskId);
  const runtime = runtimePaths(
    initial.git.gitCommonDirectory,
    initial.contract.config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
    reclaimDeadChangeTransitionLock(
      runtime,
      initial.changeId,
      assertRepositoryLock,
    );
    return persistSessionStart(
      inspectSessionStart(cwd, requestedChangeId, requestedTaskId),
    );
  });
}

export function startMandatedSession(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  requestedMandateTaskId: string,
  options: TaskMandateOptions = {},
): WorkflowSession {
  const initial = inspectSessionStart(cwd, requestedChangeId, requestedTaskId);
  const authorization = authorizeTaskMandateOperation(
    cwd,
    requestedMandateTaskId,
    { kind: 'isolated-repository-write' },
    { ...options, changeId: initial.changeId },
  );
  const runtime = runtimePaths(
    initial.git.gitCommonDirectory,
    initial.contract.config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
    reclaimDeadChangeTransitionLock(
      runtime,
      initial.changeId,
      assertRepositoryLock,
    );
    return persistSessionStart(
      inspectSessionStart(cwd, requestedChangeId, requestedTaskId),
      authorization.binding,
    );
  });
}

function inspectSessionStart(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): {
  changeId: string;
  taskId: string;
  git: ReturnType<typeof discoverRepository>;
  contract: ValidatedChangeContract;
  branch: string;
} {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  const discovered = discoverRepository(cwd);
  const { git, contract } = loadStableValidatedChangeContract(
    discovered,
    changeId,
  );
  const task = contract.tasks.find((candidate) => candidate.id === taskId);

  if (!task) {
    throw workflowError(
      'UNKNOWN_TASK',
      `Task ${taskId} does not exist in change ${changeId}.`,
      ExitCode.guard,
    );
  }
  if (task.completed) {
    throw workflowError(
      'TASK_ALREADY_COMPLETED',
      `Task ${taskId} is already checked in tasks.md.`,
      ExitCode.guard,
      { recovery: 'Select the next incomplete task.' },
    );
  }
  if (!git.branch) {
    throw workflowError(
      'DETACHED_HEAD',
      'Cannot start a workflow session from detached HEAD.',
      ExitCode.guard,
    );
  }
  if (contract.config.protectedBranches.includes(git.branch)) {
    throw workflowError(
      'PROTECTED_BRANCH',
      `Cannot start a workflow session on protected branch ${git.branch}.`,
      ExitCode.guard,
      {
        recovery: `Create branch ${expectedBranch(contract.config.branchTemplate, changeId)}.`,
      },
    );
  }

  const requiredBranch = expectedBranch(
    contract.config.branchTemplate,
    changeId,
  );
  if (git.branch !== requiredBranch) {
    throw workflowError(
      'WRONG_BRANCH',
      `Change ${changeId} requires branch ${requiredBranch}, not ${git.branch}.`,
      ExitCode.guard,
      { details: { actual: git.branch, expected: requiredBranch } },
    );
  }
  if (git.statusEntries.length > 0) {
    throw workflowError(
      'DIRTY_WORKTREE',
      'Cannot start a workflow session with staged, unstaged, or untracked files.',
      ExitCode.guard,
      {
        details: { entryCount: git.statusEntries.length },
        recovery:
          'Review and commit or otherwise resolve existing work explicitly. The workflow will not stash, reset, or delete it.',
      },
    );
  }

  return { changeId, taskId, git, contract, branch: git.branch };
}

function persistSessionStart(
  inspection: ReturnType<typeof inspectSessionStart>,
  mandateBinding?: TaskMandateBinding,
  fixedIdentity?: Readonly<{ sessionId: string; createdAt: string }>,
): WorkflowSession {
  const { changeId, taskId, git, contract, branch } = inspection;
  const policy = contract.guard.tasks[taskId];
  if (!mandateBinding) {
    assertTaskMandateOptional(
      git.repositoryRoot,
      contract.config,
      policy.allowedPaths,
    );
  }
  const sessionId = fixedIdentity
    ? assertSessionId(fixedIdentity.sessionId)
    : createSessionId();
  const runtime = runtimePaths(
    git.gitCommonDirectory,
    contract.config.runtimeDirectory,
  );
  ensurePlainDirectory(runtime.sessions);
  ensurePlainDirectory(runtime.locks);

  const lockPath = path.join(runtime.locks, `${changeId}.lock`);
  const ownerToken = crypto.randomUUID();
  let lockDescriptor: number | undefined;
  try {
    lockDescriptor = publishPreparedExclusiveLock(
      lockPath,
      `${JSON.stringify({
        sessionId,
        ownerToken,
        changeId,
        taskId,
        pid: process.pid,
      })}\n`,
      ownerToken,
      sessionLockInvalid,
    );
    fs.closeSync(lockDescriptor);
    lockDescriptor = undefined;
  } catch (error) {
    if (lockDescriptor !== undefined) {
      fs.closeSync(lockDescriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw workflowError(
        'ACTIVE_SESSION_CONFLICT',
        `Change ${changeId} already has an active session lock.`,
        ExitCode.conflict,
        { details: { lockPath } },
      );
    }
    throw error;
  }

  const session: WorkflowSession = {
    schemaVersion: 1,
    sessionId,
    state: 'active',
    changeId,
    taskId,
    ...(mandateBinding ? { mandateBinding } : {}),
    repositoryRoot: git.repositoryRealPath,
    gitCommonDirectory: git.gitCommonDirectory,
    branch,
    baseline: { head: git.head, tree: git.tree },
    artifacts: contract.artifactDigests,
    allowedPaths: [...policy.allowedPaths],
    requiredChecks: [...policy.requiredChecks],
    requiredCheckDigests: digestRequiredCheckDefinitions(
      contract.checks,
      policy.requiredChecks,
    ),
    planningAssurance: createTaskPlanningAssuranceBinding(
      contract,
      contract.planningAssurance,
    ),
    createdAt: fixedIdentity
      ? assertExactSessionTimestamp(fixedIdentity.createdAt)
      : new Date().toISOString(),
  };
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);

  try {
    writeJsonAtomic(sessionPath, session);
    const persisted = readSessionFile(sessionPath);
    if (persisted.sessionId !== sessionId || persisted.state !== 'active') {
      throw workflowError(
        'SESSION_WRITE_VERIFICATION_FAILED',
        'Persisted session did not match the requested active session.',
        ExitCode.staleState,
      );
    }
  } catch (error) {
    fs.rmSync(sessionPath, { force: true });
    releaseOwnedLock(lockPath, sessionId);
    throw error;
  }

  return session;
}

/**
 * Publish one exact session while the caller owns the repository lifecycle
 * lock. Open-task uses this only after releasing its per-change planning lock,
 * so the change-lock pathname can become the durable active-session lock
 * without ever dropping repository-wide exclusion.
 */
export function startMandatedSessionUnderLifecycleLock(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  mandateBinding: TaskMandateBinding,
  identity: Readonly<{ sessionId: string; createdAt: string }>,
  assertRepositoryLock: () => void,
): WorkflowSession {
  assertRepositoryLock();
  const inspection = inspectSessionStart(
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  assertRepositoryLock();
  const session = persistSessionStart(inspection, mandateBinding, identity);
  assertRepositoryLock();
  return session;
}

export function startSessionUnderLifecycleLock(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  identity: Readonly<{ sessionId: string; createdAt: string }>,
  assertRepositoryLock: () => void,
): WorkflowSession {
  assertRepositoryLock();
  const inspection = inspectSessionStart(
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  assertRepositoryLock();
  const session = persistSessionStart(inspection, undefined, identity);
  assertRepositoryLock();
  return session;
}

function assertExactSessionTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw workflowError(
      'SESSION_TIMESTAMP_INVALID',
      'The durable session timestamp is not canonical.',
      ExitCode.staleState,
    );
  }
  return value;
}

function sessionLockInvalid() {
  return workflowError(
    'SESSION_LOCK_INVALID',
    'The active session lock publication is unsafe.',
    ExitCode.staleState,
  );
}

export function abortSession(
  cwd: string,
  requestedSessionId: string,
  reason: string,
): WorkflowSession {
  if (!reason.trim()) {
    throw workflowError(
      'ABORT_REASON_REQUIRED',
      'Aborting a session requires a non-empty reason.',
      ExitCode.usage,
    );
  }

  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const sessionId = assertSessionId(requestedSessionId);
  const initial = readSessionFile(
    path.join(runtime.sessions, `${sessionId}.json`),
  );
  const operation = () =>
    withSessionOperation(runtime, sessionId, () =>
      abortSessionUnlocked(runtime, sessionId, reason),
    );
  return initial.state === 'revising' || initial.revisionLeaseId !== undefined
    ? withRepositoryLifecycleOperation(runtime, operation)
    : operation();
}

function abortSessionUnlocked(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
  reason: string,
): WorkflowSession {
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);

  if (session.state === 'aborted' && session.revisionLeaseId !== undefined) {
    releaseOwnedLock(
      path.join(runtime.locks, `${session.changeId}.lock`),
      sessionId,
    );
    completeTaskRevisionAbort(runtime, session);
    return session;
  }
  if (session.state !== 'active' && session.state !== 'revising') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is already ${session.state}.`,
      ExitCode.staleState,
    );
  }
  if (
    session.completionReportId ||
    session.finishReportId ||
    session.commitReportId
  ) {
    throw workflowError(
      'ABORT_REQUIRES_ROLLBACK',
      'A projected, staged, or pending session requires an explicit engine rollback transition.',
      ExitCode.staleState,
    );
  }

  if (session.state === 'revising') {
    prepareTaskRevisionAbort(runtime, session, reason.trim());
  }

  const aborted: WorkflowSession = {
    ...session,
    state: 'aborted',
    abortedAt: new Date().toISOString(),
    abortReason: reason.trim(),
  };
  writeJsonAtomic(sessionPath, aborted);
  releaseOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    sessionId,
  );
  if (session.state === 'revising') {
    completeTaskRevisionAbort(runtime, aborted);
  }
  return aborted;
}

export function getSession(
  cwd: string,
  requestedSessionId: string,
): WorkflowSession {
  const git = discoverRepository(cwd);
  return loadSession(
    git.gitCommonDirectory,
    git.repositoryRoot,
    requestedSessionId,
  );
}

export function listSessions(cwd: string): WorkflowSession[] {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  if (
    !fs.statSync(runtime.sessions, { throwIfNoEntry: false })?.isDirectory()
  ) {
    return [];
  }
  return fs
    .readdirSync(runtime.sessions)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readSessionFile(path.join(runtime.sessions, entry)));
}

function loadSession(
  gitCommonDirectory: string,
  repositoryRoot: string,
  requestedSessionId: string,
): WorkflowSession {
  const config = loadWorkflowConfig(repositoryRoot);
  const runtime = runtimePaths(gitCommonDirectory, config.runtimeDirectory);
  const sessionId = assertSessionId(requestedSessionId);
  return readSessionFile(path.join(runtime.sessions, `${sessionId}.json`));
}

function expectedBranch(template: string, changeId: string): string {
  return template.replaceAll('{changeId}', changeId);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
