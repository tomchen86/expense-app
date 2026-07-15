import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  loadWorkflowConfig,
  parseTasks,
  type TaskPolicy,
} from './contracts.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import {
  pinCheckRunner,
  runCheck,
  type CheckEvidence,
} from './check-runner.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from './database-policy.ts';
import { ExitCode, workflowError } from './errors.ts';
import { completionDocumentPaths } from './managed-documents.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
  type GitState,
} from './git.ts';
import { type ValidatedChangeContract } from './managed-change-contract.ts';
import { assertSessionId, matchesAllowedPath } from './paths.ts';
import { writeImmutableReport, type WorkflowReport } from './report-store.ts';
import {
  assertOwnedLock,
  readSessionFile,
  runtimePaths,
  type WorkflowSession,
  withSessionOperation,
  writeJsonAtomic,
} from './session-store.ts';
import { assertTaskProjectionSourceDigest } from './task-projection.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';

export type SessionCheck = {
  sessionId: string;
  changeId: string;
  taskId: string;
  changedPaths: string[];
  unexpectedPaths: string[];
  checks: CheckEvidence[];
  passed: true;
  reportId: string;
};

export type SessionCheckOptions = {
  environment?: NodeJS.ProcessEnv;
};

export type SessionInspection = {
  git: GitState;
  session: WorkflowSession;
  contract: ValidatedChangeContract;
  policy: TaskPolicy;
  artifactDigests: Record<string, string>;
  changedPaths: string[];
  unexpectedPaths: string[];
  fingerprint: string;
  tasksPath: string;
  baselineTasks: string;
};

export function checkSession(
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions = {},
): SessionCheck {
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessionId = assertSessionId(requestedSessionId);
  return withSessionOperation(runtime, sessionId, () =>
    checkSessionUnlocked(cwd, sessionId, options),
  );
}

function checkSessionUnlocked(
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions,
): SessionCheck {
  const initial = inspectSession(cwd, requestedSessionId);
  const verified = executeChecks(
    cwd,
    initial,
    initial.session.requiredChecks,
    options.environment ?? process.env,
  );
  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'check',
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    createdAt: new Date().toISOString(),
    baseline: initial.session.baseline,
    branch: initial.session.branch,
    artifactDigests: verified.inspection.artifactDigests,
    allowedPaths: initial.session.allowedPaths,
    requiredChecks: initial.session.requiredChecks,
    requiredCheckDigests: digestRequiredCheckDefinitions(
      initial.contract.checks,
      initial.session.requiredChecks,
    ),
    changedPaths: verified.inspection.changedPaths,
    fingerprint: verified.inspection.fingerprint,
    checks: verified.checks,
  };
  const reportId = writeSessionReport(verified.inspection, report);
  persistSession(verified.inspection, {
    ...verified.inspection.session,
    latestCheckReportId: reportId,
  });

  return {
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    changedPaths: verified.inspection.changedPaths,
    unexpectedPaths: [],
    checks: verified.checks,
    passed: true,
    reportId,
  };
}

export function inspectSession(
  cwd: string,
  requestedSessionId: string,
  options: {
    expectedSession?: WorkflowSession;
    projectedTaskIds?: string[];
    projectionSourceDigest?: string;
    authorizedTransitionPaths?: string[];
  } = {},
): SessionInspection {
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessionId = assertSessionId(requestedSessionId);
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);
  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${session.sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  if (
    options.expectedSession &&
    JSON.stringify(session) !== JSON.stringify(options.expectedSession)
  ) {
    throw workflowError(
      'SESSION_CHANGED_DURING_CHECK',
      'The active session changed while required checks were running.',
      ExitCode.staleState,
    );
  }
  assertPinnedGit(discovered, session);

  const { git, contract } = loadStableValidatedChangeContract(
    discovered,
    session.changeId,
  );
  const policy = contract.guard.tasks[session.taskId];
  if (!policy) {
    throw workflowError(
      'SESSION_TASK_REMOVED',
      `Session task ${session.taskId} no longer exists in guard.json.`,
      ExitCode.staleState,
    );
  }
  assertOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    session.sessionId,
    session.changeId,
    session.taskId,
  );
  if (
    JSON.stringify(policy.allowedPaths) !==
      JSON.stringify(session.allowedPaths) ||
    JSON.stringify(policy.requiredChecks) !==
      JSON.stringify(session.requiredChecks)
  ) {
    throw workflowError(
      'SESSION_POLICY_TAMPERED',
      'Session task policy does not match the pinned change contract.',
      ExitCode.staleState,
    );
  }

  const artifactDigests = digestArtifacts(
    git.repositoryRoot,
    contract.artifactPaths,
  );
  const tasksPath = path.join(contract.changeDirectory, 'tasks.md');
  const relativeTasksPath = relative(git.repositoryRoot, tasksPath);
  const baselineTasks = runGit(git.repositoryRoot, [
    'show',
    `${session.baseline.head}:${relativeTasksPath}`,
  ]);
  const currentTasks = fs.readFileSync(tasksPath, 'utf8');
  assertTaskProjection(
    baselineTasks,
    currentTasks,
    options.projectedTaskIds ?? [],
    options.projectionSourceDigest,
  );
  const bootstrapArtifactUpgrade = assertArtifactDrift(
    session,
    contract,
    artifactDigests,
    relativeTasksPath,
    options.projectedTaskIds ?? [],
  );

  const changedPaths = listChangedPaths(
    git.repositoryRoot,
    session.baseline.head,
  );
  const projectedPaths =
    (options.projectedTaskIds?.length ?? 0) > 0 ? [relativeTasksPath] : [];
  const transitionPaths = options.authorizedTransitionPaths ?? [];
  const allowedTransitionPaths = completionDocumentPaths(git.repositoryRoot);
  if (
    transitionPaths.some(
      (transitionPath) => !allowedTransitionPaths.includes(transitionPath),
    )
  ) {
    throw workflowError(
      'UNAUTHORIZED_TRANSITION_PATH',
      'A transition path is not an active generated completion document.',
      ExitCode.staleState,
    );
  }
  const unexpectedPaths = changedPaths.filter(
    (changedPath) =>
      !projectedPaths.includes(changedPath) &&
      !transitionPaths.includes(changedPath) &&
      !policy.allowedPaths.some((allowedPath) =>
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

  const inspectedSession = bootstrapArtifactUpgrade
    ? persistBootstrapArtifactUpgrade(
        sessionPath,
        session,
        contract,
        artifactDigests,
      )
    : session;

  return {
    git,
    session: inspectedSession,
    contract,
    policy,
    artifactDigests,
    changedPaths,
    unexpectedPaths,
    fingerprint: fingerprintRepositoryProjection(
      git.repositoryRoot,
      session.baseline.head,
      git.statusEntries,
    ),
    tasksPath,
    baselineTasks,
  };
}

export function executeChecks(
  cwd: string,
  initial: SessionInspection,
  checkIds: string[],
  environment: NodeJS.ProcessEnv,
  projectedTaskIds: string[] = [],
  projectionSourceDigest?: string,
  authorizedTransitionPaths: string[] = [],
): { checks: CheckEvidence[]; inspection: SessionInspection } {
  const requiredChecks = checkIds.map((checkId) => ({
    checkId,
    definition: initial.contract.checks.checks[checkId],
  }));
  const databaseEvidence = requiredChecks.some(
    ({ definition }) => definition.destructiveDatabase,
  )
    ? assertDisposableDatabase(environment)
    : undefined;
  const pinnedChecks = requiredChecks.map(({ checkId, definition }) => ({
    checkId,
    definition,
    runner: pinCheckRunner(initial.git.repositoryRoot, checkId, definition),
  }));
  const fingerprint = fingerprintWorkingState(
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.git.statusEntries,
  );
  const checks: CheckEvidence[] = [];
  let inspection = initial;
  for (const { checkId, definition, runner } of pinnedChecks) {
    checks.push(
      runCheck(
        initial.git.repositoryRoot,
        checkId,
        definition,
        runner,
        createCheckEnvironment(environment, definition.destructiveDatabase),
        definition.destructiveDatabase ? databaseEvidence?.identity : undefined,
      ),
    );
    inspection = inspectSession(cwd, initial.session.sessionId, {
      expectedSession: initial.session,
      projectedTaskIds,
      projectionSourceDigest,
      authorizedTransitionPaths,
    });
    if (
      fingerprintWorkingState(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        inspection.git.statusEntries,
      ) !== fingerprint
    ) {
      throw workflowError(
        'CHECK_MUTATED_WORKTREE',
        `Required check ${checkId} changed the Git working state.`,
        ExitCode.staleState,
        { details: { checkId } },
      );
    }
  }
  return { checks, inspection };
}

export function persistSession(
  inspection: SessionInspection,
  session: WorkflowSession,
): void {
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  const current = readSessionFile(sessionPath);
  if (JSON.stringify(current) !== JSON.stringify(inspection.session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The session changed before its transition could be persisted.',
      ExitCode.staleState,
    );
  }
  writeJsonAtomic(sessionPath, session);
}

export function writeSessionReport(
  inspection: SessionInspection,
  report: WorkflowReport,
): string {
  return writeImmutableReport(
    runtimePaths(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    ).reports,
    report,
  );
}

function assertPinnedGit(git: GitState, session: WorkflowSession): void {
  if (git.repositoryRealPath !== session.repositoryRoot) {
    throw workflowError(
      'REPOSITORY_IDENTITY_CHANGED',
      'Session repository identity does not match the current repository.',
      ExitCode.staleState,
    );
  }
  if (git.gitCommonDirectory !== session.gitCommonDirectory) {
    throw workflowError(
      'GIT_COMMON_DIRECTORY_CHANGED',
      'Session Git common-directory identity has changed.',
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
}

function assertArtifactDrift(
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  currentDigests: Record<string, string>,
  tasksPath: string,
  projectedTaskIds: string[],
): boolean {
  const task32BootstrapArtifactSet = isTask32BootstrapArtifactSet(
    session,
    contract,
    tasksPath,
    projectedTaskIds,
  );
  const allPaths = new Set([
    ...Object.keys(session.artifacts),
    ...Object.keys(currentDigests),
  ]);
  for (const artifactPath of allPaths) {
    if (session.artifacts[artifactPath] === currentDigests[artifactPath]) {
      continue;
    }
    if (
      task32BootstrapArtifactSet &&
      !Object.hasOwn(session.artifacts, artifactPath)
    ) {
      continue;
    }
    if (artifactPath === 'workflow/config.json') {
      throw artifactsChanged();
    }
    if (artifactPath === 'workflow/checks.json') {
      if (
        !session.requiredCheckDigests ||
        JSON.stringify(
          digestRequiredCheckDefinitions(
            contract.checks,
            session.requiredChecks,
          ),
        ) !== JSON.stringify(session.requiredCheckDigests)
      ) {
        throw artifactsChanged();
      }
    }
    const projected = artifactPath === tasksPath && projectedTaskIds.length > 0;
    if (
      !projected &&
      !session.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(artifactPath, allowedPath),
      )
    ) {
      throw artifactsChanged();
    }
  }
  return task32BootstrapArtifactSet;
}

function persistBootstrapArtifactUpgrade(
  sessionPath: string,
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  artifactDigests: Record<string, string>,
): WorkflowSession {
  if (!sameStringRecord(contract.artifactDigests, artifactDigests)) {
    throw workflowError(
      'OPENSPEC_CHANGE_STATE_CHANGED',
      'Managed change inputs changed before the bootstrap session could be upgraded.',
      ExitCode.staleState,
    );
  }
  const current = readSessionFile(sessionPath);
  if (JSON.stringify(current) !== JSON.stringify(session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_CHECK',
      'The active session changed before its artifact contract could be upgraded.',
      ExitCode.staleState,
    );
  }
  const upgraded: WorkflowSession = {
    ...session,
    artifacts: { ...artifactDigests },
  };
  writeJsonAtomic(sessionPath, upgraded);
  if (
    JSON.stringify(readSessionFile(sessionPath)) !== JSON.stringify(upgraded)
  ) {
    throw workflowError(
      'SESSION_WRITE_VERIFICATION_FAILED',
      'The upgraded session artifact contract could not be verified.',
      ExitCode.staleState,
    );
  }
  return upgraded;
}

function isTask32BootstrapArtifactSet(
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  tasksPath: string,
  projectedTaskIds: string[],
): boolean {
  if (
    session.changeId !== 'integrate-openspec-with-workflow' ||
    session.taskId !== '3.2'
  ) {
    return false;
  }
  const bootstrapModule =
    'packages/workflow-engine/src/managed-change-contract.ts';
  const baselinePaths = runGit(session.repositoryRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    session.baseline.head,
    '--',
    `:(literal)${bootstrapModule}`,
  ]);
  if (baselinePaths !== '') {
    return false;
  }

  const legacyArtifacts = loadChangeContract(
    session.repositoryRoot,
    session.changeId,
  ).artifactDigests;
  const sessionPaths = Object.keys(session.artifacts).sort(compareText);
  const legacyPaths = Object.keys(legacyArtifacts).sort(compareText);
  if (JSON.stringify(sessionPaths) !== JSON.stringify(legacyPaths)) {
    return false;
  }
  return legacyPaths.every(
    (artifactPath) =>
      (artifactPath === tasksPath && projectedTaskIds.length > 0) ||
      session.artifacts[artifactPath] === legacyArtifacts[artifactPath],
  );
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sameStringRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return (
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function assertTaskProjection(
  baseline: string,
  current: string,
  projectedTaskIds: string[],
  projectionSourceDigest?: string,
): void {
  if (projectedTaskIds.length > 0) {
    if (!projectionSourceDigest) {
      throw workflowError(
        'TASK_PROJECTION_SOURCE_REQUIRED',
        'Projected tasks require the checked source digest.',
        ExitCode.staleState,
      );
    }
    assertTaskProjectionSourceDigest(
      current,
      projectedTaskIds,
      projectionSourceDigest,
    );
    return;
  }
  const baselineTasks = parseTasks(baseline).map(({ id, completed }) => ({
    id,
    completed,
  }));
  const currentTasks = parseTasks(current).map(({ id, completed }) => ({
    id,
    completed,
  }));
  if (JSON.stringify(baselineTasks) !== JSON.stringify(currentTasks)) {
    throw workflowError(
      'UNAUTHORIZED_TASK_PROJECTION',
      'Task checkboxes may only change through workflow complete-task.',
      ExitCode.staleState,
    );
  }
}

function artifactsChanged() {
  return workflowError(
    'ARTIFACTS_CHANGED',
    'Pinned workflow artifacts changed without preserving the active policy.',
    ExitCode.staleState,
  );
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
