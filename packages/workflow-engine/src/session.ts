import fs from 'node:fs';
import path from 'node:path';

import { loadChangeContract, loadWorkflowConfig } from './contracts.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';
import { assertChangeId, assertSessionId, assertTaskId } from './paths.ts';
import {
  createSessionId,
  readSessionFile,
  releaseOwnedLock,
  runtimePaths,
  type WorkflowSession,
  withSessionOperation,
  writeJsonAtomic,
} from './session-store.ts';

export type { WorkflowSession } from './session-store.ts';

export { checkSession } from './verification.ts';
export type { SessionCheck, SessionCheckOptions } from './verification.ts';

export function startSession(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): WorkflowSession {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  const git = discoverRepository(cwd);
  const contract = loadChangeContract(git.repositoryRoot, changeId);
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

  const policy = contract.guard.tasks[taskId];
  const sessionId = createSessionId();
  const runtime = runtimePaths(
    git.gitCommonDirectory,
    contract.config.runtimeDirectory,
  );
  fs.mkdirSync(runtime.sessions, { recursive: true });
  fs.mkdirSync(runtime.locks, { recursive: true });

  const lockPath = path.join(runtime.locks, `${changeId}.lock`);
  let lockDescriptor: number | undefined;
  let createdLock = false;
  try {
    lockDescriptor = fs.openSync(lockPath, 'wx', 0o600);
    createdLock = true;
    fs.writeFileSync(
      lockDescriptor,
      `${JSON.stringify({ sessionId, changeId, taskId })}\n`,
      'utf8',
    );
    fs.fsyncSync(lockDescriptor);
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
    if (createdLock) {
      fs.rmSync(lockPath, { force: true });
    }
    throw error;
  }

  const session: WorkflowSession = {
    schemaVersion: 1,
    sessionId,
    state: 'active',
    changeId,
    taskId,
    repositoryRoot: git.repositoryRealPath,
    gitCommonDirectory: git.gitCommonDirectory,
    branch: git.branch,
    baseline: { head: git.head, tree: git.tree },
    artifacts: contract.artifactDigests,
    allowedPaths: [...policy.allowedPaths],
    requiredChecks: [...policy.requiredChecks],
    requiredCheckDigests: digestRequiredCheckDefinitions(
      contract.checks,
      policy.requiredChecks,
    ),
    createdAt: new Date().toISOString(),
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
  return withSessionOperation(runtime, sessionId, () =>
    abortSessionUnlocked(runtime, sessionId, reason),
  );
}

function abortSessionUnlocked(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
  reason: string,
): WorkflowSession {
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);

  if (session.state !== 'active') {
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
