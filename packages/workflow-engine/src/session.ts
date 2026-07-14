import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  loadWorkflowConfig,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, listChangedPaths } from './git.ts';
import {
  assertChangeId,
  assertSessionId,
  assertTaskId,
  matchesAllowedPath,
} from './paths.ts';
import {
  createSessionId,
  readSessionFile,
  releaseOwnedLock,
  runtimePaths,
  type WorkflowSession,
  writeJsonAtomic,
} from './session-store.ts';

export type { WorkflowSession } from './session-store.ts';

export type SessionCheck = {
  sessionId: string;
  changeId: string;
  taskId: string;
  changedPaths: string[];
  unexpectedPaths: string[];
  passed: boolean;
};

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

export function checkSession(
  cwd: string,
  requestedSessionId: string,
): SessionCheck {
  const git = discoverRepository(cwd);
  const session = loadSession(
    git.gitCommonDirectory,
    git.repositoryRoot,
    requestedSessionId,
  );

  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${session.sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  if (git.repositoryRealPath !== session.repositoryRoot) {
    throw workflowError(
      'REPOSITORY_IDENTITY_CHANGED',
      'Session repository identity does not match the current repository.',
      ExitCode.staleState,
    );
  }
  if (git.branch !== session.branch) {
    throw workflowError(
      'SESSION_BRANCH_CHANGED',
      `Session branch changed from ${session.branch} to ${git.branch ?? 'detached HEAD'}.`,
      ExitCode.staleState,
    );
  }
  if (git.head !== session.baseline.head) {
    throw workflowError(
      'SESSION_HEAD_CHANGED',
      'HEAD changed after session start.',
      ExitCode.staleState,
      { details: { baseline: session.baseline.head, actual: git.head } },
    );
  }

  const contract = loadChangeContract(git.repositoryRoot, session.changeId);
  const currentPolicy = contract.guard.tasks[session.taskId];
  if (!currentPolicy) {
    throw workflowError(
      'SESSION_TASK_REMOVED',
      `Session task ${session.taskId} no longer exists in guard.json.`,
      ExitCode.staleState,
    );
  }
  const currentDigests = digestArtifacts(
    git.repositoryRoot,
    contract.artifactPaths,
  );
  if (JSON.stringify(currentDigests) !== JSON.stringify(session.artifacts)) {
    throw workflowError(
      'ARTIFACTS_CHANGED',
      'Tracked workflow artifacts changed after session start.',
      ExitCode.staleState,
      {
        recovery:
          'Abort the session, review the contract change, and start again.',
      },
    );
  }
  if (
    JSON.stringify(currentPolicy.allowedPaths) !==
      JSON.stringify(session.allowedPaths) ||
    JSON.stringify(currentPolicy.requiredChecks) !==
      JSON.stringify(session.requiredChecks)
  ) {
    throw workflowError(
      'SESSION_POLICY_TAMPERED',
      'Session task policy does not match the pinned change contract.',
      ExitCode.staleState,
    );
  }

  const changedPaths = listChangedPaths(
    git.repositoryRoot,
    session.baseline.head,
  );
  const unexpectedPaths = changedPaths.filter(
    (changedPath) =>
      !currentPolicy.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );

  if (unexpectedPaths.length > 0) {
    throw workflowError(
      'OUT_OF_SCOPE_PATHS',
      `Session contains ${unexpectedPaths.length} out-of-scope path(s).`,
      ExitCode.verification,
      { details: { changedPaths, unexpectedPaths } },
    );
  }

  return {
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    changedPaths,
    unexpectedPaths,
    passed: true,
  };
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
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);

  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is already ${session.state}.`,
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
