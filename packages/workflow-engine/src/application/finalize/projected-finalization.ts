import fs from 'node:fs';
import path from 'node:path';

import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import { parseTasks } from '../../contracts.ts';
import { classifyProjectionPaths } from '../../modules/projection/engine-projection-registry.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  advanceFinalizeTransaction,
  createFinalizeTransaction,
  publishFinalizeTransaction,
  readFinalizeTransaction,
  removeFinalizeTransaction,
  type FinalizeTransaction,
  type FinalizeTransactionPhase,
} from '../../finalize-transaction.ts';
import {
  resolveExplicitFinalizeChecks,
  resolveFinalizeCheckPolicy,
  type FinalizeCheckEscalation,
} from '../../modules/assurance/finalize-check-policy.ts';
import {
  listStagedPaths,
  previewExactStaging,
  rollbackExactStaging,
  stageExactPaths,
} from '../../git-transitions.ts';
import {
  fingerprintRepositoryProjectionExcludingPaths,
  fingerprintUnstagedRepositoryProjection,
  runGit,
} from '../../git.ts';
import { loadActiveSessionContext } from '../../lifecycle-context.ts';
import {
  applyGeneratedDocumentMutations,
  planCompletionDocuments,
} from '../../managed-documents.ts';
import { assertCurrentImplementationReconciliation } from '../../modules/why-knowledge/implementation-reconciliation.ts';
import { reconcilePredecessor } from './predecessor-reconciliation.ts';
import type { WorkflowReport } from '../../report-store.ts';
import {
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
} from '../../report-validation.ts';
import type { WorkflowSession } from '../../session-store.ts';
import {
  applyTaskProjection,
  digestTaskContent,
  planTasksCompleted,
  restoreTaskProjection,
} from '../../task-projection.ts';
import {
  assertTaskDiffReviewCompletionGateSatisfied,
  loadTaskDiffDocumentationReviewCapture,
} from './task-diff-review-lifecycle.ts';
import type { DocumentationReviewCapture } from '../../documentation-closure.ts';
import { assertTaskStrategyExecutionGate } from '../../modules/assurance/task-strategy-gate.ts';
import { ensureTaskMechanicalTransformationEvidence } from '../execute-task/task-mechanical-transform.ts';
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
  transactionId: string;
  checkReportId: string;
  completionReportId: string;
  finishReportId: string;
  completedTaskIds: string[];
  requiredChecks: string[];
  checkEscalation: 'all-tasks-terminal' | 'explicit' | null;
  stagedPaths: string[];
  tree: string;
};

export type FinalizeTaskOptions = Readonly<{
  fullGate?: boolean;
  onCheckEscalation?: (
    escalation: Exclude<FinalizeCheckEscalation, null>,
    requiredChecks: readonly string[],
  ) => void;
  testCrashAfter?:
    | 'projection-prepared'
    | 'task-projected'
    | 'projection-applied'
    | 'candidate-prepared'
    | 'checks-running'
    | 'checks-executed'
    | 'checked'
    | 'staged'
    | 'reports-persisted'
    | 'session-finished';
}>;

export function finalizeTaskUnlocked(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv,
  options: FinalizeTaskOptions = {},
): FinalizeTaskResult {
  const active = loadActiveSessionContext(cwd, requestedSessionId);
  const existing = readFinalizeTransaction(
    active.runtime.root,
    active.session.sessionId,
  );
  if (existing !== null) {
    assertFinalizeTransactionIdentity(active, existing);
    assertExplicitCheckRequestMatches(active, existing, options);
    try {
      return continueFinalizeTransaction(cwd, existing, environment, options);
    } catch (error) {
      if (preservesFinalizeTransaction(error)) throw error;
      rollbackPersistedFinalizeTransaction(cwd, existing.sessionId, error);
      throw error;
    }
  }

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
  assertCurrentImplementationReconciliation(initial);
  ensureTaskMechanicalTransformationEvidence(initial);
  assertTaskStrategyExecutionGate(initial, environment);

  const reconciliation = reconcilePredecessor(cwd, initial, environment);
  const completedTaskIds = [
    ...reconciliation.map(({ taskId }) => taskId),
    session.taskId,
  ];
  const projection = planTasksCompleted(initial.tasksPath, completedTaskIds);
  const projectionSourceDigest = digestTaskContent(projection.before);
  const checkPolicy = resolveFinalizeCheckPolicy(
    parseTasks(projection.after),
    session.requiredChecks,
    initial.contract.config,
    options.fullGate === true,
  );
  if (options.fullGate === true && checkPolicy.checkEscalation === null) {
    throw workflowError(
      'FINALIZE_FULL_GATE_NOT_CONFIGURED',
      'Explicit full-gate escalation requires repository terminal checks.',
      ExitCode.guard,
    );
  }
  let transaction: FinalizeTransaction | null = null;

  try {
    const generatedDocuments = planCompletionDocuments(
      initial.git.repositoryRoot,
      { changeId: session.changeId, tasks: projection.after },
    );
    const transitionPaths = generatedDocuments.map(({ path }) => path).sort();
    const taskProjectionPath = path.relative(
      initial.git.repositoryRoot,
      initial.tasksPath,
    );
    const projectionMutations = [
      {
        path: taskProjectionPath,
        before: projection.before,
        after: projection.after,
      },
      ...generatedDocuments.map((mutation) => ({
        path: mutation.path,
        before: mutation.before ?? null,
        after: mutation.after,
      })),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const projectionPaths = projectionMutations.map(({ path }) => path);
    if (
      listStagedPaths(initial.git.repositoryRoot, session.baseline.head)
        .length > 0
    ) {
      throw workflowError(
        'STAGING_ALREADY_PRESENT',
        'Only workflow finalize may create the managed staging projection.',
        ExitCode.staleState,
      );
    }
    transaction = publishFinalizeTransaction(
      active.runtime.root,
      createFinalizeTransaction({
        schemaVersion: 2,
        kind: 'projected-finalize-transaction.v2',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        repositoryRoot: initial.git.repositoryRealPath,
        gitCommonDirectory: initial.git.gitCommonDirectory,
        branch: session.branch,
        baseline: session.baseline,
        completedTaskIds,
        requiredChecks: checkPolicy.requiredChecks,
        checkEscalation: checkPolicy.checkEscalation,
        reconciledTasks: reconciliation,
        taskProjectionPath,
        projectionMutations,
        projectionSourceDigest,
        projectionBaseFingerprint:
          fingerprintRepositoryProjectionExcludingPaths(
            initial.git.repositoryRoot,
            session.baseline.head,
            initial.git.statusEntries,
            projectionPaths,
          ),
        transitionPaths,
        previousIndexTree: runGit(initial.git.repositoryRoot, [
          'write-tree',
        ]).trim(),
        createdAt: new Date().toISOString(),
      }),
    );
    maybeInterrupt(options, 'projection-prepared');
    return continueFinalizeTransaction(cwd, transaction, environment, options);
  } catch (error) {
    if (preservesFinalizeTransaction(error)) throw error;
    if (transaction !== null) {
      rollbackPersistedFinalizeTransaction(cwd, session.sessionId, error);
      throw error;
    }
    throw error;
  }
}

function continueFinalizeTransaction(
  cwd: string,
  initial: FinalizeTransaction,
  environment: NodeJS.ProcessEnv,
  options: FinalizeTaskOptions,
): FinalizeTaskResult {
  let transaction = initial;
  while (true) {
    if (transaction.phase === 'projection-prepared') {
      transaction = applyPreparedFinalizeProjection(cwd, transaction, options);
      continue;
    }
    assertCandidateTransaction(transaction);
    const state = inspectFinalizeTransaction(cwd, transaction);
    const session = state.inspection.session;
    if (transaction.phase === 'candidate-prepared') {
      if (state.indexState !== 'previous') throw transactionDiverged();
      if (transaction.checkEscalation) {
        options.onCheckEscalation?.(
          transaction.checkEscalation,
          transactionRequiredChecks(transaction, session),
        );
      }
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        { ...transaction, phase: 'checks-running' },
      );
      maybeInterrupt(options, 'checks-running');
      const verified = executeChecks(
        cwd,
        state.inspection,
        transactionRequiredChecks(transaction, session),
        environment,
        [...transaction.completedTaskIds],
        transaction.projectionSourceDigest,
        [...transaction.transitionPaths],
      );
      maybeInterrupt(options, 'checks-executed');
      if (
        verified.inspection.fingerprint !== transaction.candidateFingerprint ||
        JSON.stringify(verified.inspection.git.statusEntries) !==
          JSON.stringify(transaction.candidateStatusEntries)
      ) {
        throw transactionDiverged();
      }
      const checkReportId = writeSessionReport(
        verified.inspection,
        createCheckReport(transaction, verified.inspection, verified.checks),
      );
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        { ...transaction, phase: 'checked', checkReportId },
      );
      maybeInterrupt(options, 'checked');
      continue;
    }
    if (transaction.phase === 'checks-running') {
      throw finalizeRecoveryRequired(transaction);
    }
    const checkReport = currentCheckReport(state.inspection, transaction);
    if (transaction.phase === 'checked') {
      assertTaskDiffReviewCompletionGateSatisfied(cwd, transaction.sessionId, {
        projectedTaskIds: transaction.completedTaskIds,
        projectionSourceDigest: transaction.projectionSourceDigest,
        authorizedTransitionPaths: transaction.transitionPaths,
        transactionId: transaction.transactionId,
        candidateTree: transaction.candidateTree,
      });
      const documentationReview = loadTaskDiffDocumentationReviewCapture(
        cwd,
        transaction.sessionId,
      );
      if (state.indexState === 'previous') {
        stageExactPaths(
          state.inspection.git.repositoryRoot,
          session.baseline.head,
          [...transaction.changedPaths],
          {
            expectedTree: transaction.candidateTree,
            expectedPreviousIndexTree: transaction.previousIndexTree,
          },
        );
      }
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        {
          ...transaction,
          phase: 'staged',
          ...(documentationReview === null ? {} : { documentationReview }),
        },
      );
      maybeInterrupt(options, 'staged');
      continue;
    }
    if (transaction.phase === 'staged') {
      if (state.indexState !== 'candidate') throw transactionDiverged();
      const completionReportId = writeSessionReport(
        state.inspection,
        createCompletionReport(
          transaction,
          state.inspection,
          transaction.documentationReview ?? null,
        ),
      );
      const finishReportId = writeSessionReport(
        state.inspection,
        createFinishReport(
          transaction,
          state.inspection,
          checkReport,
          completionReportId,
        ),
      );
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        {
          ...transaction,
          phase: 'reports-persisted',
          completionReportId,
          finishReportId,
        },
      );
      maybeInterrupt(options, 'reports-persisted');
      continue;
    }
    if (transaction.phase === 'reports-persisted') {
      if (state.indexState !== 'candidate') throw transactionDiverged();
      const updated = finalizedSession(session, transaction);
      if (!sessionHasFinalizeReports(session, transaction)) {
        if (
          session.latestCheckReportId ||
          session.completionReportId ||
          session.finishReportId
        ) {
          throw transactionDiverged();
        }
        persistSession(state.inspection, updated);
      }
      maybeInterrupt(options, 'session-finished');
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        { ...transaction, phase: 'completed' },
      );
      continue;
    }
    if (transaction.phase === 'completed') {
      if (
        state.indexState !== 'candidate' ||
        !sessionHasFinalizeReports(session, transaction)
      ) {
        throw transactionDiverged();
      }
      return resultFrom(transaction, session);
    }
  }
}

type CandidateFinalizeTransaction = FinalizeTransaction & {
  candidateTree: string;
  candidateFingerprint: string;
};

function applyPreparedFinalizeProjection(
  cwd: string,
  transaction: FinalizeTransaction,
  options: FinalizeTaskOptions,
): CandidateFinalizeTransaction {
  const context = loadActiveSessionContext(cwd, transaction.sessionId);
  assertFinalizeTransactionIdentity(context, transaction);
  if (
    context.session.latestCheckReportId ||
    context.session.completionReportId ||
    context.session.finishReportId ||
    runGit(context.git.repositoryRoot, ['write-tree']).trim() !==
      transaction.previousIndexTree
  ) {
    throw transactionDiverged();
  }
  const projectionPaths = transaction.projectionMutations.map(
    ({ path: mutationPath }) => mutationPath,
  );
  assertProjectionBaseCurrent(context.git, transaction, projectionPaths);
  const taskMutation = transaction.projectionMutations.find(
    ({ path: mutationPath }) => mutationPath === transaction.taskProjectionPath,
  );
  if (!taskMutation || taskMutation.before === null) {
    throw transactionDiverged();
  }
  applyTaskProjection(
    path.join(transaction.repositoryRoot, taskMutation.path),
    taskMutation.before,
    taskMutation.after,
  );
  maybeInterrupt(options, 'task-projected');
  applyGeneratedDocumentMutations(
    transaction.repositoryRoot,
    transaction.projectionMutations
      .filter(
        ({ path: mutationPath }) =>
          mutationPath !== transaction.taskProjectionPath,
      )
      .map((mutation) => ({
        path: mutation.path,
        before: mutation.before ?? undefined,
        after: mutation.after,
      })),
  );
  maybeInterrupt(options, 'projection-applied');

  const projected = inspectSession(cwd, transaction.sessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    authorizedTransitionPaths: [...transaction.transitionPaths],
  });
  assertProjectionBaseCurrent(projected.git, transaction, projectionPaths);
  const preview = previewExactStaging(
    projected.git.repositoryRoot,
    transaction.baseline.head,
    projected.changedPaths,
  );
  if (preview.previousIndexTree !== transaction.previousIndexTree) {
    throw transactionDiverged();
  }
  const candidate = advanceFinalizeTransaction(
    context.runtime.root,
    transaction,
    {
      ...transaction,
      phase: 'candidate-prepared',
      changedPaths: projected.changedPaths,
      candidateTree: preview.tree,
      candidateFingerprint: projected.fingerprint,
      candidateStatusEntries: projected.git.statusEntries,
    },
  );
  assertCandidateTransaction(candidate);
  maybeInterrupt(options, 'candidate-prepared');
  return candidate;
}

function assertProjectionBaseCurrent(
  git: ReturnType<typeof loadActiveSessionContext>['git'],
  transaction: FinalizeTransaction,
  projectionPaths: string[],
): void {
  if (
    fingerprintRepositoryProjectionExcludingPaths(
      git.repositoryRoot,
      transaction.baseline.head,
      git.statusEntries,
      projectionPaths,
    ) !== transaction.projectionBaseFingerprint
  ) {
    throw transactionDiverged();
  }
}

function assertCandidateTransaction(
  transaction: FinalizeTransaction,
): asserts transaction is CandidateFinalizeTransaction {
  if (
    transaction.phase === 'projection-prepared' ||
    transaction.candidateTree === null ||
    transaction.candidateFingerprint === null
  ) {
    throw transactionDiverged();
  }
}

function inspectFinalizeTransaction(
  cwd: string,
  transaction: CandidateFinalizeTransaction,
) {
  const context = loadActiveSessionContext(cwd, transaction.sessionId);
  assertFinalizeTransactionIdentity(context, transaction);
  for (const mutation of transaction.projectionMutations) {
    if (
      readProjectionText(transaction.repositoryRoot, mutation.path) !==
      mutation.after
    ) {
      throw transactionDiverged();
    }
  }
  const inspection = inspectSession(cwd, transaction.sessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    authorizedTransitionPaths: [...transaction.transitionPaths],
  });
  if (
    JSON.stringify(inspection.changedPaths) !==
    JSON.stringify(transaction.changedPaths)
  ) {
    throw transactionDiverged();
  }
  const indexTree = runGit(inspection.git.repositoryRoot, [
    'write-tree',
  ]).trim();
  const unstagedState = runGit(inspection.git.repositoryRoot, [
    'diff',
    '--name-only',
    '-z',
    '--',
  ]);
  const reconstructedCandidateFingerprint =
    fingerprintUnstagedRepositoryProjection(
      inspection.git.repositoryRoot,
      transaction.baseline.head,
      [...transaction.candidateStatusEntries],
    );
  let indexState: 'previous' | 'candidate';
  if (indexTree === transaction.previousIndexTree) {
    const preview = previewExactStaging(
      inspection.git.repositoryRoot,
      transaction.baseline.head,
      [...transaction.changedPaths],
    );
    if (
      preview.tree !== transaction.candidateTree ||
      preview.previousIndexTree !== transaction.previousIndexTree ||
      inspection.fingerprint !== transaction.candidateFingerprint ||
      JSON.stringify(inspection.git.statusEntries) !==
        JSON.stringify(transaction.candidateStatusEntries)
    ) {
      throw transactionDiverged();
    }
    indexState = 'previous';
  } else if (
    indexTree === transaction.candidateTree &&
    JSON.stringify(
      listStagedPaths(inspection.git.repositoryRoot, transaction.baseline.head),
    ) === JSON.stringify(transaction.changedPaths) &&
    unstagedState === '' &&
    reconstructedCandidateFingerprint === transaction.candidateFingerprint
  ) {
    indexState = 'candidate';
  } else {
    throw transactionDiverged();
  }
  return {
    context,
    inspection,
    indexState,
    pathClassification: classifyProjectionPaths(
      [...transaction.changedPaths],
      [transaction.taskProjectionPath],
      [...transaction.transitionPaths],
    ),
  };
}

function createCheckReport(
  transaction: FinalizeTransaction,
  inspection: ReturnType<typeof inspectSession>,
  checks: unknown[],
): WorkflowReport {
  const requiredChecks = transactionRequiredChecks(
    transaction,
    inspection.session,
  );
  return {
    schemaVersion: 1,
    kind: 'check',
    finalizeProfile: PROJECTED_SINGLE_PASS_ASSURANCE,
    candidateTree: transaction.candidateTree,
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    createdAt: transaction.createdAt,
    baseline: transaction.baseline,
    branch: transaction.branch,
    artifactDigests: inspection.artifactDigests,
    allowedPaths: inspection.session.allowedPaths,
    requiredChecks,
    requiredCheckDigests: digestRequiredCheckDefinitions(
      inspection.contract.checks,
      requiredChecks,
    ),
    ...(transaction.schemaVersion === 2
      ? { checkEscalation: transaction.checkEscalation ?? null }
      : {}),
    ...classifyProjectionPaths(
      inspection.changedPaths,
      [transaction.taskProjectionPath],
      [...transaction.transitionPaths],
    ),
    fingerprint: inspection.fingerprint,
    checks,
  };
}

function createCompletionReport(
  transaction: FinalizeTransaction,
  inspection: ReturnType<typeof inspectSession>,
  documentationReview: DocumentationReviewCapture | null,
): WorkflowReport {
  return {
    ...createCheckReport(transaction, inspection, []),
    kind: 'completion',
    parentReportId: transaction.checkReportId!,
    completedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    transitionPaths: [...transaction.transitionPaths],
    reconciledTasks: transaction.reconciledTasks,
    checks: undefined,
    ...(documentationReview === null ? {} : { documentationReview }),
  };
}

function createFinishReport(
  transaction: FinalizeTransaction,
  inspection: ReturnType<typeof inspectSession>,
  checkReport: WorkflowReport,
  completionReportId: string,
): WorkflowReport {
  return {
    ...createCheckReport(
      transaction,
      inspection,
      checkReport.checks as unknown[],
    ),
    kind: 'finish',
    parentReportId: completionReportId,
    completedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    transitionPaths: [...transaction.transitionPaths],
    stagedPaths: [...transaction.changedPaths],
    tree: transaction.candidateTree,
  };
}

function currentCheckReport(
  inspection: ReturnType<typeof inspectSession>,
  transaction: CandidateFinalizeTransaction,
): WorkflowReport {
  if (transaction.checkReportId === null) throw transactionDiverged();
  const report = readSessionReport(inspection, transaction.checkReportId);
  assertInspectionReport(
    report,
    { ...inspection, fingerprint: transaction.candidateFingerprint },
    'check',
    'CHECK_REPORT_STALE',
    transactionRequiredChecks(transaction, inspection.session),
  );
  assertReportChecks(
    report,
    inspection,
    transactionRequiredChecks(transaction, inspection.session),
    'CHECK_REPORT_STALE',
  );
  if (
    report.parentReportId !== undefined ||
    report.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    report.candidateTree !== transaction.candidateTree ||
    report.checkEscalation !== transactionReportCheckEscalation(transaction)
  ) {
    throw transactionDiverged();
  }
  return report;
}

function finalizedSession(
  session: WorkflowSession,
  transaction: FinalizeTransaction,
): WorkflowSession {
  if (
    transaction.checkReportId === null ||
    transaction.completionReportId === null ||
    transaction.finishReportId === null
  ) {
    throw transactionDiverged();
  }
  return {
    ...session,
    latestCheckReportId: transaction.checkReportId,
    completionReportId: transaction.completionReportId,
    finishReportId: transaction.finishReportId,
  };
}

function sessionHasFinalizeReports(
  session: WorkflowSession,
  transaction: FinalizeTransaction,
): boolean {
  return (
    session.latestCheckReportId === transaction.checkReportId &&
    session.completionReportId === transaction.completionReportId &&
    session.finishReportId === transaction.finishReportId
  );
}

function resultFrom(
  transaction: CandidateFinalizeTransaction,
  session: WorkflowSession,
): FinalizeTaskResult {
  if (
    transaction.checkReportId === null ||
    transaction.completionReportId === null ||
    transaction.finishReportId === null
  ) {
    throw transactionDiverged();
  }
  return {
    session,
    assurance: PROJECTED_SINGLE_PASS_ASSURANCE,
    transactionId: transaction.transactionId,
    checkReportId: transaction.checkReportId,
    completionReportId: transaction.completionReportId,
    finishReportId: transaction.finishReportId,
    completedTaskIds: [...transaction.completedTaskIds],
    requiredChecks: transactionRequiredChecks(transaction, session),
    checkEscalation: transaction.checkEscalation ?? null,
    stagedPaths: [...transaction.changedPaths],
    tree: transaction.candidateTree,
  };
}

export function transactionRequiredChecks(
  transaction: FinalizeTransaction,
  session: Pick<WorkflowSession, 'requiredChecks'>,
): string[] {
  return [
    ...(transaction.schemaVersion === 2 && transaction.requiredChecks
      ? transaction.requiredChecks
      : session.requiredChecks),
  ];
}

export function transactionReportCheckEscalation(
  transaction: FinalizeTransaction,
): FinalizeCheckEscalation | undefined {
  return transaction.schemaVersion === 2
    ? (transaction.checkEscalation ?? null)
    : undefined;
}

function assertExplicitCheckRequestMatches(
  context: ReturnType<typeof loadActiveSessionContext>,
  transaction: FinalizeTransaction,
  options: FinalizeTaskOptions,
): void {
  if (options.fullGate !== true) return;
  const terminalChecks = context.config.allTasksTerminalChecks ?? [];
  const expected = resolveExplicitFinalizeChecks(
    context.session.requiredChecks,
    context.config,
  );
  if (
    terminalChecks.length === 0 ||
    JSON.stringify(transactionRequiredChecks(transaction, context.session)) !==
      JSON.stringify(expected)
  ) {
    throw workflowError(
      'FINALIZE_REQUEST_CHANGED',
      'A durable finalize transaction cannot be escalated after it was created.',
      ExitCode.conflict,
      {
        recovery: `Resume without --full-gate: pnpm workflow finalize-recover ${transaction.sessionId} --json`,
      },
    );
  }
}

function assertFinalizeTransactionIdentity(
  context: ReturnType<typeof loadActiveSessionContext>,
  transaction: FinalizeTransaction,
): void {
  const session = context.session;
  if (
    transaction.sessionId !== session.sessionId ||
    transaction.changeId !== session.changeId ||
    transaction.taskId !== session.taskId ||
    transaction.repositoryRoot !== context.git.repositoryRealPath ||
    transaction.gitCommonDirectory !== context.git.gitCommonDirectory ||
    transaction.branch !== session.branch ||
    JSON.stringify(transaction.baseline) !== JSON.stringify(session.baseline)
  ) {
    throw transactionDiverged();
  }
}

function rollbackPersistedFinalizeTransaction(
  cwd: string,
  sessionId: string,
  cause: unknown,
): void {
  const context = loadActiveSessionContext(cwd, sessionId);
  const transaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  if (transaction === null) return;
  if (sessionHasFinalizeReports(context.session, transaction)) return;
  restoreFinalizeTransactionProjection(cwd, transaction, cause);
  removeFinalizeTransaction(context.runtime.root, transaction);
}

export function restoreFinalizeTransactionProjection(
  cwd: string,
  transaction: FinalizeTransaction,
  cause: unknown,
): void {
  const context = loadActiveSessionContext(cwd, transaction.sessionId);
  assertFinalizeTransactionIdentity(context, transaction);
  const observed = readFinalizeTransaction(
    context.runtime.root,
    transaction.sessionId,
  );
  if (
    observed === null ||
    JSON.stringify(observed) !== JSON.stringify(transaction) ||
    sessionHasFinalizeReports(context.session, transaction)
  ) {
    throw transactionDiverged();
  }
  const indexTree = runGit(context.git.repositoryRoot, ['write-tree']).trim();
  if (indexTree === transaction.candidateTree) {
    rollbackExactStaging(
      context.git.repositoryRoot,
      transaction.previousIndexTree,
      transaction.candidateTree,
      cause,
    );
  } else if (indexTree !== transaction.previousIndexTree) {
    throw transactionDiverged();
  }
  for (const mutation of [...transaction.projectionMutations].reverse()) {
    const current = readProjectionText(
      transaction.repositoryRoot,
      mutation.path,
    );
    if (current === mutation.before) continue;
    if (current !== mutation.after) throw transactionDiverged();
    const target = path.join(transaction.repositoryRoot, mutation.path);
    if (mutation.path === transaction.taskProjectionPath) {
      if (mutation.before === null) throw transactionDiverged();
      restoreTaskProjection(target, mutation.after, mutation.before);
    } else if (mutation.before === null) {
      fs.rmSync(target, { force: true });
    } else {
      fs.writeFileSync(target, mutation.before, 'utf8');
    }
  }
}

function readProjectionText(
  repositoryRoot: string,
  relativePath: string,
): string | null {
  const target = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw transactionDiverged();
  }
  return fs.readFileSync(target, 'utf8');
}

function maybeInterrupt(
  options: FinalizeTaskOptions,
  phase: FinalizeTaskOptions['testCrashAfter'],
): void {
  if (options.testCrashAfter === phase) {
    throw new SimulatedFinalizeInterruption(String(phase));
  }
}

function preservesFinalizeTransaction(error: unknown): boolean {
  return (
    error instanceof SimulatedFinalizeInterruption ||
    (error instanceof WorkflowError &&
      [
        'FINALIZE_RECOVERY_REQUIRED',
        'TASK_DIFF_REVIEW_REQUIRED',
        'TASK_DIFF_REVIEW_CHALLENGE_OPEN',
        'TASK_DIFF_REVIEW_CHANGES_REQUIRED',
      ].includes(error.code))
  );
}

function finalizeRecoveryRequired(transaction: FinalizeTransaction) {
  return workflowError(
    'FINALIZE_RECOVERY_REQUIRED',
    'Finalize check execution may have crossed an interruption boundary; automatic retry will not duplicate it.',
    ExitCode.staleState,
    {
      details: {
        transactionId: transaction.transactionId,
        phase: transaction.phase,
      },
      recovery:
        'Inspect the durable finalize transaction and explicitly cancel or reconcile it before retrying.',
    },
  );
}

class SimulatedFinalizeInterruption extends Error {
  constructor(phase: string) {
    super(`Simulated finalize interruption after ${phase}.`);
  }
}

function transactionDiverged() {
  return workflowError(
    'FINALIZE_TRANSACTION_DIVERGED',
    'Durable finalize state differs from its exact candidate transaction.',
    ExitCode.staleState,
  );
}
