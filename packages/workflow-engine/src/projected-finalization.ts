import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  previewExactStaging,
  rollbackExactStaging,
  stageExactPaths,
} from './git-transitions.ts';
import {
  refreshCompletionDocuments,
  rollbackGeneratedDocuments,
  type GeneratedDocumentMutation,
} from './managed-documents.ts';
import { reconcilePredecessor } from './predecessor-reconciliation.ts';
import type { WorkflowReport } from './report-store.ts';
import type { WorkflowSession } from './session-store.ts';
import {
  digestTaskContent,
  projectTasksCompleted,
  restoreTaskProjection,
} from './task-projection.ts';
import {
  executeChecks,
  inspectSession,
  persistSession,
  writeSessionReport,
} from './verification.ts';

/**
 * A projected single-pass finalize builds the final implementation, checkbox,
 * and generated-handoff projection, runs each current-task required check
 * exactly once on that final tree, and, on success, emits schema-compatible
 * check -> completion -> finish reports bound to the same projected inspection
 * and check evidence. Independently required predecessor reconciliation stays
 * distinct. On any caught ordinary failure it restores the controlled
 * projections and leaves no evidence pointers behind.
 */
export const PROJECTED_SINGLE_PASS_ASSURANCE =
  'projected-single-pass-ordinary-failure' as const;

export type FinalizeTaskResult = {
  session: WorkflowSession;
  assurance: typeof PROJECTED_SINGLE_PASS_ASSURANCE;
  checkReportId: string;
  completionReportId: string;
  finishReportId: string;
  completedTaskIds: string[];
  stagedPaths: string[];
  tree: string;
};

export function finalizeTaskUnlocked(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv,
): FinalizeTaskResult {
  const initial = inspectSession(cwd, requestedSessionId);
  const session = initial.session;
  if (
    session.latestCheckReportId ||
    session.completionReportId ||
    session.finishReportId
  ) {
    throw workflowError(
      'FINALIZE_REQUIRES_FRESH_SESSION',
      'Projected single-pass finalize requires an active session without prior check, completion, or finish evidence.',
      ExitCode.staleState,
    );
  }

  const reconciliation = reconcilePredecessor(cwd, initial, environment);
  const completedTaskIds = [
    ...reconciliation.map(({ taskId }) => taskId),
    session.taskId,
  ];
  const projection = projectTasksCompleted(initial.tasksPath, completedTaskIds);
  const projectionSourceDigest = digestTaskContent(projection.before);
  let generatedDocuments: GeneratedDocumentMutation[] = [];

  try {
    generatedDocuments = refreshCompletionDocuments(initial.git.repositoryRoot);
    const transitionPaths = generatedDocuments.map(({ path }) => path).sort();
    const projected = inspectSession(cwd, session.sessionId, {
      expectedSession: session,
      projectedTaskIds: completedTaskIds,
      projectionSourceDigest,
      authorizedTransitionPaths: transitionPaths,
    });

    // Pin the prospective checked tree before verification so that same-path
    // byte drift after the check cannot be silently staged.
    const preview = previewExactStaging(
      projected.git.repositoryRoot,
      session.baseline.head,
      projected.changedPaths,
    );

    // Each current-task required check runs exactly once on the final projected
    // tree. Predecessor reconciliation, when needed, is separate above.
    const verified = executeChecks(
      cwd,
      projected,
      session.requiredChecks,
      environment,
      completedTaskIds,
      projectionSourceDigest,
      transitionPaths,
    );
    const inspection = verified.inspection;
    const requiredCheckDigests = digestRequiredCheckDefinitions(
      inspection.contract.checks,
      session.requiredChecks,
    );

    const staged = stageExactPaths(
      inspection.git.repositoryRoot,
      session.baseline.head,
      inspection.changedPaths,
      {
        expectedTree: preview.tree,
        expectedPreviousIndexTree: preview.previousIndexTree,
      },
    );
    try {
      const finalized = inspectSession(cwd, session.sessionId, {
        expectedSession: session,
        projectedTaskIds: completedTaskIds,
        projectionSourceDigest,
        authorizedTransitionPaths: transitionPaths,
      });

      const createdAt = new Date().toISOString();
      const checkReport: WorkflowReport = {
        schemaVersion: 1,
        kind: 'check',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        createdAt,
        baseline: session.baseline,
        branch: session.branch,
        artifactDigests: inspection.artifactDigests,
        allowedPaths: session.allowedPaths,
        requiredChecks: session.requiredChecks,
        requiredCheckDigests,
        changedPaths: inspection.changedPaths,
        fingerprint: inspection.fingerprint,
        checks: verified.checks,
      };
      const checkReportId = writeSessionReport(inspection, checkReport);

      const completionReport: WorkflowReport = {
        schemaVersion: 1,
        kind: 'completion',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        createdAt,
        parentReportId: checkReportId,
        baseline: session.baseline,
        branch: session.branch,
        artifactDigests: inspection.artifactDigests,
        allowedPaths: session.allowedPaths,
        requiredChecks: session.requiredChecks,
        requiredCheckDigests,
        changedPaths: inspection.changedPaths,
        fingerprint: inspection.fingerprint,
        completedTaskIds,
        projectionSourceDigest,
        transitionPaths,
        reconciledTasks: reconciliation,
      };
      const completionReportId = writeSessionReport(
        inspection,
        completionReport,
      );

      const finishReport: WorkflowReport = {
        schemaVersion: 1,
        kind: 'finish',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        createdAt,
        parentReportId: completionReportId,
        baseline: session.baseline,
        branch: session.branch,
        artifactDigests: finalized.artifactDigests,
        allowedPaths: session.allowedPaths,
        requiredChecks: session.requiredChecks,
        requiredCheckDigests: digestRequiredCheckDefinitions(
          finalized.contract.checks,
          session.requiredChecks,
        ),
        changedPaths: finalized.changedPaths,
        fingerprint: finalized.fingerprint,
        completedTaskIds,
        projectionSourceDigest,
        transitionPaths,
        checks: verified.checks,
        stagedPaths: staged.stagedPaths,
        tree: staged.tree,
      };
      const finishReportId = writeSessionReport(finalized, finishReport);

      const updated: WorkflowSession = {
        ...session,
        latestCheckReportId: checkReportId,
        completionReportId,
        finishReportId,
      };
      persistSession(finalized, updated);

      return {
        session: updated,
        assurance: PROJECTED_SINGLE_PASS_ASSURANCE,
        checkReportId,
        completionReportId,
        finishReportId,
        completedTaskIds,
        stagedPaths: staged.stagedPaths,
        tree: staged.tree,
      };
    } catch (error) {
      rollbackExactStaging(
        inspection.git.repositoryRoot,
        staged.previousIndexTree,
        staged.tree,
        error,
      );
      throw error;
    }
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
