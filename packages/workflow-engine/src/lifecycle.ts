import { assertCommitObject } from './commit-object-validation.ts';
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
import type { WorkflowSession } from './session-store.ts';
import {
  executeChecks,
  inspectSession,
  persistSession,
  writeSessionReport,
} from './verification.ts';
import {
  refreshCompletionDocuments,
  rollbackGeneratedDocuments,
  type GeneratedDocumentMutation,
} from './managed-documents.ts';
import {
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
