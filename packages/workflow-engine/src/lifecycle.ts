import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertCommitObject } from './commit-object-validation.ts';
import { readFileAtCommit } from './ci-git.ts';
import {
  finalizeCommittedSession,
  resumePendingCommit,
  type CommitSessionResult,
} from './commit-recovery.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  commitFacts,
  createManagedCommitObject,
  findExactTaskCommits,
  listStagedPaths,
  rollbackExactStaging,
  stageExactPaths,
  updateManagedRef,
  type TaskCommit,
} from './git-transitions.ts';
import { discoverRepository } from './git.ts';
import { assertChangeId, assertTaskId } from './paths.ts';
import {
  assertFinishProjection,
  loadActiveSessionContext,
  runSessionOperation,
} from './lifecycle-context.ts';
import { reconcilePredecessor } from './predecessor-reconciliation.ts';
import { readImmutableReport, type WorkflowReport } from './report-store.ts';
import {
  assertCompletionTaskIds,
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
  reportString,
  reportStringArray,
  reportTaskIds,
  staleReport,
} from './report-validation.ts';
import {
  assertOwnedLock,
  readSessionFile,
  writeJsonAtomic,
  type WorkflowSession,
} from './session-store.ts';
import {
  executeChecks,
  inspectSession,
  persistSession,
  writeSessionReport,
} from './verification.ts';
import {
  completionDocumentPaths,
  refreshCompletionDocuments,
  rollbackGeneratedDocuments,
  validateManagedDocuments,
  type GeneratedDocumentMutation,
} from './managed-documents.ts';
import {
  assertExactTaskProjection,
  projectTasksCompleted,
  digestTaskContent,
  restoreTaskProjection,
} from './task-projection.ts';

export type CompleteTaskResult = {
  session: WorkflowSession;
  reportId: string;
  completedTaskIds: string[];
};

export type FinishSessionResult = {
  session: WorkflowSession;
  reportId: string;
  stagedPaths: string[];
  tree: string;
};

export type RollbackCompletionResult = {
  session: WorkflowSession;
  completionReportId: string;
  rollbackRecordId: string;
  restoredPaths: string[];
  rolledBackAt: string;
  reason: string;
};

export type { CommitSessionResult } from './commit-recovery.ts';

export function completeTask(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): CompleteTaskResult {
  return runSessionOperation(cwd, requestedSessionId, () =>
    completeTaskUnlocked(cwd, requestedSessionId, environment),
  );
}

export function rollbackCompletion(
  cwd: string,
  requestedSessionId: string,
  reason: string,
): RollbackCompletionResult {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw workflowError(
      'ROLLBACK_REASON_REQUIRED',
      'Rolling back a completion projection requires a non-empty reason.',
      ExitCode.usage,
    );
  }
  if (/\p{Cc}/u.test(normalizedReason)) {
    throw workflowError(
      'ROLLBACK_REASON_INVALID',
      'Completion rollback reason contains control characters.',
      ExitCode.usage,
    );
  }

  return runSessionOperation(cwd, requestedSessionId, () =>
    rollbackCompletionUnlocked(cwd, requestedSessionId, normalizedReason),
  );
}

function rollbackCompletionUnlocked(
  cwd: string,
  requestedSessionId: string,
  reason: string,
): RollbackCompletionResult {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const { git, runtime, session } = context;
  if (
    !session.completionReportId ||
    session.finishReportId ||
    session.commitReportId
  ) {
    throw workflowError(
      'ROLLBACK_REQUIRES_PROJECTED_SESSION',
      'Completion rollback requires an active projected session that has not been finished or committed.',
      ExitCode.staleState,
    );
  }
  assertPinnedRollbackState(context);

  const completionReport = readImmutableReport(
    runtime.reports,
    session.sessionId,
    session.completionReportId,
  );
  if (
    completionReport.kind !== 'completion' ||
    completionReport.changeId !== session.changeId ||
    completionReport.taskId !== session.taskId ||
    completionReport.parentReportId !== session.latestCheckReportId
  ) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
  const completedTaskIds = reportTaskIds(
    completionReport,
    'COMPLETION_REPORT_STALE',
  );
  const transitionPaths = reportStringArray(
    completionReport,
    'transitionPaths',
    'COMPLETION_REPORT_STALE',
  );
  const configuredTransitionPaths = completionDocumentPaths(git.repositoryRoot);
  if (
    transitionPaths.some(
      (documentPath) => !configuredTransitionPaths.includes(documentPath),
    )
  ) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }

  const tasksPathRelative = `${context.config.changeRoot}/${session.changeId}/tasks.md`;
  const tasksPath = path.join(git.repositoryRoot, tasksPathRelative);
  const baselineTasks = readFileAtCommit(
    git.repositoryRoot,
    session.baseline.head,
    tasksPathRelative,
  );
  if (baselineTasks === undefined) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
  const projectedTasks = fs.readFileSync(tasksPath, 'utf8');
  assertExactTaskProjection(baselineTasks, projectedTasks, completedTaskIds);
  if (
    reportString(
      completionReport,
      'projectionSourceDigest',
      'COMPLETION_REPORT_STALE',
    ) !== digestTaskContent(baselineTasks)
  ) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
  validateManagedDocuments(git.repositoryRoot);

  const documentMutations = transitionPaths.map((documentPath) => {
    const absolutePath = path.join(git.repositoryRoot, documentPath);
    return {
      path: documentPath,
      before: readFileAtCommit(
        git.repositoryRoot,
        session.baseline.head,
        documentPath,
      ),
      after: fs.readFileSync(absolutePath, 'utf8'),
    } satisfies GeneratedDocumentMutation;
  });
  const restoredPaths = [...transitionPaths, tasksPathRelative].sort();
  const rolledBackAt = new Date().toISOString();
  const completionReportId = session.completionReportId;
  const {
    latestCheckReportId: _check,
    completionReportId: _completion,
    ...reset
  } = session;
  const resetSession: WorkflowSession = reset;
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  let rollbackRecordPath: string | undefined;

  try {
    restoreTaskProjection(tasksPath, projectedTasks, baselineTasks);
    rollbackGeneratedDocuments(git.repositoryRoot, documentMutations);
    assertPinnedRollbackState(context);
    if (
      JSON.stringify(readSessionFile(sessionPath)) !== JSON.stringify(session)
    ) {
      throw workflowError(
        'SESSION_CHANGED_DURING_TRANSITION',
        'The session changed before its completion rollback could be persisted.',
        ExitCode.staleState,
      );
    }

    const record = {
      schemaVersion: 1,
      kind: 'completion-rollback',
      sessionId: session.sessionId,
      changeId: session.changeId,
      taskId: session.taskId,
      completionReportId,
      rolledBackAt,
      reason,
      restoredPaths,
    } as const;
    const recordContent = `${JSON.stringify(record, null, 2)}\n`;
    const rollbackRecordId = crypto
      .createHash('sha256')
      .update(recordContent)
      .digest('hex');
    const rollbackDirectory = path.join(
      runtime.root,
      'completion-rollbacks',
      session.sessionId,
    );
    fs.mkdirSync(rollbackDirectory, { recursive: true });
    assertPlainDirectory(runtime.root);
    assertPlainDirectory(path.join(runtime.root, 'completion-rollbacks'));
    assertPlainDirectory(rollbackDirectory);
    rollbackRecordPath = path.join(
      rollbackDirectory,
      `${rollbackRecordId}.json`,
    );
    writeJsonAtomic(rollbackRecordPath, record);
    writeJsonAtomic(sessionPath, resetSession);

    return {
      session: resetSession,
      completionReportId,
      rollbackRecordId,
      restoredPaths,
      rolledBackAt,
      reason,
    };
  } catch (error) {
    if (rollbackRecordPath) {
      fs.rmSync(rollbackRecordPath, { force: true });
    }
    writePlainFile(tasksPath, projectedTasks);
    for (const mutation of documentMutations) {
      writePlainFile(
        path.join(git.repositoryRoot, mutation.path),
        mutation.after,
      );
    }
    throw error;
  }
}

function assertPinnedRollbackState(
  context: ReturnType<typeof loadActiveSessionContext>,
): void {
  const { git, runtime, session } = context;
  const current = discoverRepository(git.repositoryRoot);
  if (
    current.repositoryRealPath !== session.repositoryRoot ||
    current.gitCommonDirectory !== session.gitCommonDirectory ||
    current.branch !== session.branch ||
    current.head !== session.baseline.head
  ) {
    throw workflowError(
      'ROLLBACK_REPOSITORY_DRIFT',
      'Repository identity, branch, or HEAD changed before completion rollback.',
      ExitCode.staleState,
    );
  }
  assertOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    session.sessionId,
    session.changeId,
    session.taskId,
  );
  if (listStagedPaths(git.repositoryRoot, session.baseline.head).length > 0) {
    throw workflowError(
      'ROLLBACK_INDEX_NOT_EMPTY',
      'Completion rollback requires an empty index.',
      ExitCode.staleState,
    );
  }
}

function assertPlainDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw workflowError(
      'ROLLBACK_RECORD_DIRECTORY_UNSAFE',
      'Completion rollback record directory is missing or unsafe.',
      ExitCode.staleState,
    );
  }
}

function writePlainFile(filePath: string, content: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw workflowError(
      'ROLLBACK_PATH_UNSAFE',
      'Completion rollback encountered an unsafe projected file.',
      ExitCode.staleState,
    );
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function completeTaskUnlocked(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv,
): CompleteTaskResult {
  const initial = inspectSession(cwd, requestedSessionId);
  if (initial.session.completionReportId) {
    throw workflowError(
      'TASK_ALREADY_PROJECTED',
      'The active session already has a completion report.',
      ExitCode.staleState,
    );
  }
  const checkReportId = initial.session.latestCheckReportId;
  if (!checkReportId) {
    throw workflowError(
      'CURRENT_CHECK_REPORT_REQUIRED',
      'A current passing check report is required before completion.',
      ExitCode.verification,
    );
  }
  const checkReport = readSessionReport(initial, checkReportId);
  assertInspectionReport(checkReport, initial, 'check', 'CHECK_REPORT_STALE');
  assertReportChecks(
    checkReport,
    initial,
    initial.session.requiredChecks,
    'CHECK_REPORT_STALE',
  );
  if (checkReport.parentReportId !== undefined) {
    throw staleReport('CHECK_REPORT_STALE');
  }

  const reconciliation = reconcilePredecessor(cwd, initial, environment);
  const completedTaskIds = [
    ...reconciliation.map(({ taskId }) => taskId),
    initial.session.taskId,
  ];
  const projection = projectTasksCompleted(initial.tasksPath, completedTaskIds);
  const projectionSourceDigest = digestTaskContent(projection.before);
  let generatedDocuments: GeneratedDocumentMutation[] = [];

  try {
    generatedDocuments = refreshCompletionDocuments(initial.git.repositoryRoot);
    const transitionPaths = generatedDocuments.map(({ path }) => path).sort();
    const projected = inspectSession(cwd, initial.session.sessionId, {
      expectedSession: initial.session,
      projectedTaskIds: completedTaskIds,
      projectionSourceDigest,
      authorizedTransitionPaths: transitionPaths,
    });
    const report: WorkflowReport = {
      schemaVersion: 1,
      kind: 'completion',
      sessionId: initial.session.sessionId,
      changeId: initial.session.changeId,
      taskId: initial.session.taskId,
      createdAt: new Date().toISOString(),
      parentReportId: checkReportId,
      baseline: initial.session.baseline,
      branch: initial.session.branch,
      artifactDigests: projected.artifactDigests,
      allowedPaths: initial.session.allowedPaths,
      requiredChecks: initial.session.requiredChecks,
      requiredCheckDigests: digestRequiredCheckDefinitions(
        projected.contract.checks,
        initial.session.requiredChecks,
      ),
      changedPaths: projected.changedPaths,
      fingerprint: projected.fingerprint,
      completedTaskIds,
      projectionSourceDigest,
      transitionPaths,
      reconciledTasks: reconciliation,
    };
    const reportId = writeSessionReport(projected, report);
    const session: WorkflowSession = {
      ...initial.session,
      completionReportId: reportId,
    };
    persistSession(projected, session);
    return { session, reportId, completedTaskIds };
  } catch (error) {
    try {
      rollbackGeneratedDocuments(
        initial.git.repositoryRoot,
        generatedDocuments,
      );
    } finally {
      restoreTaskProjection(
        initial.tasksPath,
        projection.after,
        projection.before,
      );
    }
    throw error;
  }
}

export function finishSession(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): FinishSessionResult {
  return runSessionOperation(cwd, requestedSessionId, () =>
    finishSessionUnlocked(cwd, requestedSessionId, environment),
  );
}

function finishSessionUnlocked(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv,
): FinishSessionResult {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const session = context.session;
  if (session.finishReportId) {
    throw workflowError(
      'SESSION_ALREADY_FINISHED',
      'The active session already has a finish report.',
      ExitCode.staleState,
    );
  }
  if (!session.completionReportId) {
    throw workflowError(
      'COMPLETION_REPORT_REQUIRED',
      'An authorized completion report is required before finish.',
      ExitCode.verification,
    );
  }
  const completionReport = readImmutableReport(
    context.runtime.reports,
    session.sessionId,
    session.completionReportId,
  );
  const completedTaskIds = reportTaskIds(
    completionReport,
    'COMPLETION_REPORT_STALE',
  );
  const projectionSourceDigest = reportString(
    completionReport,
    'projectionSourceDigest',
    'COMPLETION_REPORT_STALE',
  );
  const transitionPaths = reportStringArray(
    completionReport,
    'transitionPaths',
    'COMPLETION_REPORT_STALE',
  );
  const unprojected = inspectSession(cwd, requestedSessionId, {
    projectedTaskIds: completedTaskIds,
    projectionSourceDigest,
    authorizedTransitionPaths: transitionPaths,
  });
  assertInspectionReport(
    completionReport,
    unprojected,
    'completion',
    'COMPLETION_REPORT_STALE',
  );
  assertCompletionTaskIds(
    completionReport,
    unprojected,
    'COMPLETION_REPORT_STALE',
  );
  if (completionReport.parentReportId !== session.latestCheckReportId) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }

  const verified = executeChecks(
    cwd,
    unprojected,
    session.requiredChecks,
    environment,
    completedTaskIds,
    projectionSourceDigest,
    transitionPaths,
  );
  const staged = stageExactPaths(
    verified.inspection.git.repositoryRoot,
    session.baseline.head,
    verified.inspection.changedPaths,
  );
  try {
    const finished = inspectSession(cwd, session.sessionId, {
      expectedSession: session,
      projectedTaskIds: completedTaskIds,
      projectionSourceDigest,
      authorizedTransitionPaths: transitionPaths,
    });
    const report: WorkflowReport = {
      schemaVersion: 1,
      kind: 'finish',
      sessionId: session.sessionId,
      changeId: session.changeId,
      taskId: session.taskId,
      createdAt: new Date().toISOString(),
      parentReportId: session.completionReportId,
      baseline: session.baseline,
      branch: session.branch,
      artifactDigests: finished.artifactDigests,
      allowedPaths: session.allowedPaths,
      requiredChecks: session.requiredChecks,
      requiredCheckDigests: digestRequiredCheckDefinitions(
        finished.contract.checks,
        session.requiredChecks,
      ),
      changedPaths: finished.changedPaths,
      fingerprint: finished.fingerprint,
      completedTaskIds,
      projectionSourceDigest,
      transitionPaths,
      checks: verified.checks,
      stagedPaths: staged.stagedPaths,
      tree: staged.tree,
    };
    const reportId = writeSessionReport(finished, report);
    const updated: WorkflowSession = { ...session, finishReportId: reportId };
    persistSession(finished, updated);
    return {
      session: updated,
      reportId,
      stagedPaths: staged.stagedPaths,
      tree: staged.tree,
    };
  } catch (error) {
    rollbackExactStaging(
      verified.inspection.git.repositoryRoot,
      staged.previousIndexTree,
      staged.tree,
      error,
    );
    throw error;
  }
}

export function commitSession(
  cwd: string,
  requestedSessionId: string,
  subject: string,
  environment: NodeJS.ProcessEnv = process.env,
): CommitSessionResult {
  return runSessionOperation(cwd, requestedSessionId, () =>
    commitSessionUnlocked(cwd, requestedSessionId, subject, environment),
  );
}

function commitSessionUnlocked(
  cwd: string,
  requestedSessionId: string,
  subject: string,
  environment: NodeJS.ProcessEnv,
): CommitSessionResult {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const initialSession = context.session;
  if (initialSession.commitReportId || initialSession.commitHash) {
    return resumePendingCommit(context, subject);
  }
  if (!initialSession.finishReportId) {
    throw workflowError(
      'FINISH_REPORT_REQUIRED',
      'A current finish report is required before commit.',
      ExitCode.verification,
    );
  }
  if (!initialSession.completionReportId) {
    throw workflowError(
      'COMPLETION_REPORT_REQUIRED',
      'An authorized completion report is required before commit.',
      ExitCode.verification,
    );
  }
  const completionReport = readImmutableReport(
    context.runtime.reports,
    initialSession.sessionId,
    initialSession.completionReportId,
  );
  const completedTaskIds = reportTaskIds(
    completionReport,
    'COMPLETION_REPORT_STALE',
  );
  const projectionSourceDigest = reportString(
    completionReport,
    'projectionSourceDigest',
    'COMPLETION_REPORT_STALE',
  );
  const transitionPaths = reportStringArray(
    completionReport,
    'transitionPaths',
    'COMPLETION_REPORT_STALE',
  );
  const inspection = inspectSession(cwd, requestedSessionId, {
    projectedTaskIds: completedTaskIds,
    projectionSourceDigest,
    authorizedTransitionPaths: transitionPaths,
  });
  const finishReport = readSessionReport(
    inspection,
    initialSession.finishReportId,
  );
  assertInspectionReport(
    finishReport,
    inspection,
    'finish',
    'FINISH_REPORT_STALE',
  );
  assertReportChecks(
    finishReport,
    inspection,
    initialSession.requiredChecks,
    'FINISH_REPORT_STALE',
  );
  assertCompletionTaskIds(
    completionReport,
    inspection,
    'COMPLETION_REPORT_STALE',
  );
  if (finishReport.parentReportId !== initialSession.completionReportId) {
    throw staleReport('FINISH_REPORT_STALE');
  }
  assertFinishProjection(finishReport, inspection);

  const expectedTree = reportString(
    finishReport,
    'tree',
    'FINISH_REPORT_STALE',
  );
  const commitHash = createManagedCommitObject(
    inspection.git.repositoryRoot,
    expectedTree,
    initialSession.baseline.head,
    subject,
    initialSession.changeId,
    initialSession.taskId,
    environment,
  );
  const facts = commitFacts(inspection.git.repositoryRoot, commitHash);
  assertCommitObject(
    inspection.git.repositoryRoot,
    initialSession,
    subject,
    facts,
    expectedTree,
    inspection.changedPaths,
  );

  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'commit',
    sessionId: initialSession.sessionId,
    changeId: initialSession.changeId,
    taskId: initialSession.taskId,
    createdAt: new Date().toISOString(),
    parentReportId: initialSession.finishReportId,
    baseline: initialSession.baseline,
    branch: initialSession.branch,
    commitHash,
    tree: facts.tree,
    changedPaths: inspection.changedPaths,
    completedTaskIds,
    projectionSourceDigest,
    transitionPaths,
    message: facts.message,
  };
  const reportId = writeSessionReport(inspection, report);
  const pending: WorkflowSession = {
    ...initialSession,
    commitReportId: reportId,
    commitHash,
  };
  persistSession(inspection, pending);
  updateManagedRef(
    inspection.git.repositoryRoot,
    initialSession.baseline.head,
    commitHash,
  );
  return finalizeCommittedSession(context.runtime, pending);
}

export function findTaskCommits(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): TaskCommit[] {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  return findExactTaskCommits(
    discoverRepository(cwd).repositoryRoot,
    changeId,
    taskId,
  );
}
