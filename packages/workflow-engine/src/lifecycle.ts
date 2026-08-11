import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertCommitObject } from './commit-object-validation.ts';
import { readFileAtCommit } from './ci-git.ts';
import { loadWorkflowConfig } from './contracts.ts';
import {
  finalizeCommittedSession,
  resumePendingCommit,
  type CommitSessionResult,
} from './commit-recovery.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import { ExitCode, workflowError } from './errors.ts';
import { classifyProjectionPaths } from './engine-projection-registry.ts';
import {
  completeFinalizeCancellation,
  createFinalizeCancellation,
  MAX_FINALIZE_CANCELLATION_REASON_BYTES,
  markFinalizeProjectionRestored,
  publishFinalizeCancellation,
  readFinalizeCancellation,
  type FinalizeCancellation,
} from './finalize-cancellation.ts';
import {
  commitFacts,
  createManagedCommitObject,
  findExactTaskCommits,
  listStagedPaths,
  rollbackExactStaging,
  stageExactPaths,
  updateManagedRef,
  validateCommitSubject,
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
import {
  removeFinalizeTransaction,
  readFinalizeTransaction,
  type FinalizeTransaction,
} from './finalize-transaction.ts';
import {
  finalizeTaskUnlocked,
  PROJECTED_SINGLE_PASS_ASSURANCE,
  restoreFinalizeTransactionProjection,
  type FinalizeTaskOptions,
  type FinalizeTaskResult,
} from './projected-finalization.ts';
import { assertCurrentImplementationReconciliation } from './implementation-reconciliation.ts';
import { readImmutableReport, type WorkflowReport } from './report-store.ts';
import {
  assertCompletionTaskIds,
  assertInspectionReport,
  assertProjectionPathClassification,
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
  runtimePaths,
  writeJsonAtomic,
  type WorkflowSession,
} from './session-store.ts';
import { getSession } from './session.ts';
import {
  executeChecks,
  inspectSession,
  persistSession,
  reconcileSessionChecksAfterLocalEngineAdoption,
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
export type { FinalizeTaskResult } from './projected-finalization.ts';

export type FinalizeSessionResult = Omit<FinalizeTaskResult, 'session'> & {
  session: WorkflowSession;
  commitReportId: string;
  commitHash: string;
};

export type FinalizeSessionOptions = Readonly<{
  testCrashAfter?: FinalizeTaskOptions['testCrashAfter'] | 'finalized';
}>;

export type FinalizeRecoveryStatus = Readonly<{
  state: 'in-progress' | 'recovery-required' | 'completed';
  transactionId: string;
  phase: FinalizeTransaction['phase'];
  retrySafe: boolean;
  recoveryCommand: string;
}>;

export type FinalizeCancellationResult = Readonly<{
  state: 'cancelled';
  sessionId: string;
  transactionId: string;
  reason: string;
  cancelledAt: string;
}>;

export type FinalizeCancellationOptions = Readonly<{
  testCrashAfter?:
    'cancellation-requested' | 'projection-restored' | 'cancellation-completed';
}>;

export function cancelFinalizeRecovery(
  cwd: string,
  requestedSessionId: string,
  transactionId: string,
  reason: string,
  options: FinalizeCancellationOptions = {},
): FinalizeCancellationResult {
  assertFinalizeCancellationReason(reason);
  return runSessionOperation(cwd, requestedSessionId, () => {
    const session = getSession(cwd, requestedSessionId);
    const git = discoverRepository(cwd);
    const config = loadWorkflowConfig(git.repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const archived = readFinalizeCancellation(runtime.root, transactionId);
    if (archived?.phase === 'completed') {
      assertCancellationRequest(archived, session, git, transactionId, reason);
      removeCancelledActiveTransaction(runtime.root, archived);
      return cancellationResult(archived);
    }
    const transaction = readFinalizeTransaction(
      runtime.root,
      session.sessionId,
    );
    if (
      transaction === null ||
      transaction.transactionId !== transactionId ||
      transaction.phase !== 'checks-running'
    ) {
      throw invalidFinalizeCancellation(
        'The requested ambiguous finalize transaction is not active.',
      );
    }
    assertFinalizeTransactionMatchesSession(transaction, session, git);
    let cancellation = archived;
    if (cancellation === null) {
      cancellation = publishFinalizeCancellation(
        runtime.root,
        createFinalizeCancellation(
          transaction,
          reason,
          new Date().toISOString(),
        ),
      );
      maybeInterruptFinalizeCancellation(options, 'cancellation-requested');
    } else {
      assertCancellationRequest(
        cancellation,
        session,
        git,
        transactionId,
        reason,
      );
    }
    if (cancellation.phase === 'requested') {
      restoreFinalizeTransactionProjection(cwd, transaction, cancellation);
      cancellation = markFinalizeProjectionRestored(runtime.root, cancellation);
      maybeInterruptFinalizeCancellation(options, 'projection-restored');
    }
    if (cancellation.phase === 'projection-restored') {
      cancellation = completeFinalizeCancellation(
        runtime.root,
        cancellation,
        new Date().toISOString(),
      );
      maybeInterruptFinalizeCancellation(options, 'cancellation-completed');
    }
    removeCancelledActiveTransaction(runtime.root, cancellation);
    return cancellationResult(cancellation);
  });
}

export function inspectFinalizeRecoveryStatus(
  cwd: string,
  requestedSessionId: string,
): FinalizeRecoveryStatus | null {
  const session = getSession(cwd, requestedSessionId);
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const transaction = readFinalizeTransaction(runtime.root, session.sessionId);
  if (transaction === null) return null;
  assertFinalizeTransactionMatchesSession(transaction, session, git);
  if (transaction.phase === 'checks-running') {
    return {
      state: 'recovery-required',
      transactionId: transaction.transactionId,
      phase: transaction.phase,
      retrySafe: false,
      recoveryCommand:
        `pnpm workflow finalize-recover ${session.sessionId} ` +
        `--cancel ${transaction.transactionId} --reason <text> --json`,
    };
  }
  return {
    state: transaction.phase === 'completed' ? 'completed' : 'in-progress',
    transactionId: transaction.transactionId,
    phase: transaction.phase,
    retrySafe: true,
    recoveryCommand: `pnpm workflow finalize-recover ${session.sessionId} --json`,
  };
}

export function recoverFinalize(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): FinalizeTaskResult {
  return runSessionOperation(cwd, requestedSessionId, () => {
    const session = getSession(cwd, requestedSessionId);
    const git = discoverRepository(cwd);
    const config = loadWorkflowConfig(git.repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    if (readFinalizeTransaction(runtime.root, session.sessionId) === null) {
      throw workflowError(
        'FINALIZE_TRANSACTION_NOT_FOUND',
        'No durable finalize transaction exists for this session.',
        ExitCode.staleState,
      );
    }
    return session.state === 'committed'
      ? replayCompletedFinalize(cwd, session)
      : finalizeTaskUnlocked(cwd, requestedSessionId, environment);
  });
}

export function finalizeSession(
  cwd: string,
  requestedSessionId: string,
  subject: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: FinalizeSessionOptions = {},
): FinalizeSessionResult {
  validateCommitSubject(subject);
  return runSessionOperation(cwd, requestedSessionId, () => {
    const observed = getSession(cwd, requestedSessionId);
    let finalized: FinalizeTaskResult;
    if (observed.state === 'committed') {
      finalized = replayCompletedFinalize(cwd, observed);
    } else {
      finalized = finalizeTaskUnlocked(cwd, requestedSessionId, environment, {
        ...(options.testCrashAfter && options.testCrashAfter !== 'finalized'
          ? { testCrashAfter: options.testCrashAfter }
          : {}),
      });
      if (options.testCrashAfter === 'finalized') {
        throw new Error('Simulated finalize interruption after finalized.');
      }
    }
    const committed = commitSessionUnlocked(
      cwd,
      requestedSessionId,
      subject,
      environment,
    );
    const facts = commitFacts(
      finalized.session.repositoryRoot,
      committed.commitHash,
    );
    if (facts.tree !== finalized.tree) {
      throw workflowError(
        'FINALIZE_TRANSACTION_DIVERGED',
        'Managed finalize commit does not match its checked candidate tree.',
        ExitCode.staleState,
      );
    }
    const { session: _activeSession, ...result } = finalized;
    return {
      ...result,
      session: committed.session,
      commitReportId: committed.reportId,
      commitHash: committed.commitHash,
    };
  });
}

export function finalizeTask(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: FinalizeTaskOptions = {},
): FinalizeTaskResult {
  return runSessionOperation(cwd, requestedSessionId, () =>
    finalizeTaskUnlocked(cwd, requestedSessionId, environment, options),
  );
}

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
  assertProjectionPathClassification(
    completionReport,
    classifyProjectionPaths(
      reportStringArray(
        completionReport,
        'changedPaths',
        'COMPLETION_REPORT_STALE',
      ),
      [tasksPathRelative],
      transitionPaths,
    ),
    'COMPLETION_REPORT_STALE',
  );
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
  reconcileSessionChecksAfterLocalEngineAdoption(cwd, requestedSessionId, {
    environment,
  });
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
  assertCurrentImplementationReconciliation(initial);

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
    const pathClassification = classifyProjectionPaths(
      projected.changedPaths,
      [path.relative(projected.git.repositoryRoot, projected.tasksPath)],
      transitionPaths,
    );
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
      ...pathClassification,
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
  const pathClassification = classifyProjectionPaths(
    unprojected.changedPaths,
    [path.relative(unprojected.git.repositoryRoot, unprojected.tasksPath)],
    transitionPaths,
  );
  assertProjectionPathClassification(
    completionReport,
    pathClassification,
    'COMPLETION_REPORT_STALE',
  );
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
  assertCurrentImplementationReconciliation(unprojected);

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
      ...classifyProjectionPaths(
        finished.changedPaths,
        pathClassification.taskProjectionPaths,
        transitionPaths,
      ),
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
  const observed = getSession(cwd, requestedSessionId);
  if (observed.state === 'committed') {
    return replayCommittedCommit(cwd, observed, subject);
  }
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
  const pathClassification = classifyProjectionPaths(
    inspection.changedPaths,
    [path.relative(inspection.git.repositoryRoot, inspection.tasksPath)],
    transitionPaths,
  );
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
  assertProjectionPathClassification(
    completionReport,
    pathClassification,
    'COMPLETION_REPORT_STALE',
  );
  assertProjectionPathClassification(
    finishReport,
    pathClassification,
    'FINISH_REPORT_STALE',
  );
  if (finishReport.parentReportId !== initialSession.completionReportId) {
    throw staleReport('FINISH_REPORT_STALE');
  }
  assertProjectedFinalizeCandidateChain(
    inspection,
    initialSession,
    completionReport,
    finishReport,
  );
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
    ...pathClassification,
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

function replayCompletedFinalize(
  cwd: string,
  session: WorkflowSession,
): FinalizeTaskResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const transaction = readFinalizeTransaction(runtime.root, session.sessionId);
  if (
    transaction === null ||
    !isCompletedFinalizeTransaction(transaction) ||
    transaction.checkReportId !== session.latestCheckReportId ||
    transaction.completionReportId !== session.completionReportId ||
    transaction.finishReportId !== session.finishReportId
  ) {
    throw invalidCompletedFinalize();
  }
  assertFinalizeTransactionMatchesSession(transaction, session, git);
  return finalizeResultFromTransaction(transaction, session);
}

function assertFinalizeTransactionMatchesSession(
  transaction: FinalizeTransaction,
  session: WorkflowSession,
  git: ReturnType<typeof discoverRepository>,
): void {
  if (
    transaction.repositoryRoot !== git.repositoryRealPath ||
    transaction.gitCommonDirectory !== git.gitCommonDirectory ||
    transaction.sessionId !== session.sessionId ||
    transaction.changeId !== session.changeId ||
    transaction.taskId !== session.taskId ||
    transaction.branch !== session.branch ||
    JSON.stringify(transaction.baseline) !== JSON.stringify(session.baseline)
  ) {
    throw invalidCompletedFinalize();
  }
}

function assertFinalizeCancellationReason(reason: string): void {
  if (
    reason.length === 0 ||
    reason.trim() !== reason ||
    Buffer.byteLength(reason) > MAX_FINALIZE_CANCELLATION_REASON_BYTES ||
    /\p{Cc}/u.test(reason)
  ) {
    throw workflowError(
      'FINALIZE_CANCELLATION_REASON_INVALID',
      `Finalize cancellation requires one trimmed reason of at most ${MAX_FINALIZE_CANCELLATION_REASON_BYTES} bytes without control characters.`,
      ExitCode.usage,
    );
  }
}

function assertCancellationRequest(
  cancellation: FinalizeCancellation,
  session: WorkflowSession,
  git: ReturnType<typeof discoverRepository>,
  transactionId: string,
  reason: string,
): void {
  assertFinalizeTransactionMatchesSession(
    cancellation.transaction,
    session,
    git,
  );
  if (
    cancellation.sessionId !== session.sessionId ||
    cancellation.transactionId !== transactionId ||
    cancellation.reason !== reason
  ) {
    throw invalidFinalizeCancellation(
      'Finalize cancellation does not match the exact transaction and reason.',
    );
  }
}

function removeCancelledActiveTransaction(
  runtimeRoot: string,
  cancellation: FinalizeCancellation,
): void {
  const active = readFinalizeTransaction(
    runtimeRoot,
    cancellation.transaction.sessionId,
  );
  if (active === null) return;
  if (JSON.stringify(active) === JSON.stringify(cancellation.transaction)) {
    removeFinalizeTransaction(runtimeRoot, active);
  }
}

function cancellationResult(
  cancellation: FinalizeCancellation,
): FinalizeCancellationResult {
  if (cancellation.phase !== 'completed' || cancellation.cancelledAt === null) {
    throw invalidFinalizeCancellation(
      'Finalize cancellation is not durably completed.',
    );
  }
  return {
    state: 'cancelled',
    sessionId: cancellation.sessionId,
    transactionId: cancellation.transactionId,
    reason: cancellation.reason,
    cancelledAt: cancellation.cancelledAt,
  };
}

function maybeInterruptFinalizeCancellation(
  options: FinalizeCancellationOptions,
  phase: FinalizeCancellationOptions['testCrashAfter'],
): void {
  if (options.testCrashAfter === phase) {
    throw new Error(`Simulated finalize cancellation after ${String(phase)}.`);
  }
}

function invalidFinalizeCancellation(message: string) {
  return workflowError(
    'FINALIZE_CANCELLATION_INVALID',
    message,
    ExitCode.staleState,
  );
}

function isCompletedFinalizeTransaction(
  transaction: FinalizeTransaction,
): transaction is FinalizeTransaction & {
  candidateTree: string;
  checkReportId: string;
  completionReportId: string;
  finishReportId: string;
} {
  return (
    transaction.phase === 'completed' &&
    transaction.candidateTree !== null &&
    transaction.checkReportId !== null &&
    transaction.completionReportId !== null &&
    transaction.finishReportId !== null
  );
}

function finalizeResultFromTransaction(
  transaction: FinalizeTransaction & {
    candidateTree: string;
    checkReportId: string;
    completionReportId: string;
    finishReportId: string;
  },
  session: WorkflowSession,
): FinalizeTaskResult {
  return {
    session,
    assurance: PROJECTED_SINGLE_PASS_ASSURANCE,
    transactionId: transaction.transactionId,
    checkReportId: transaction.checkReportId,
    completionReportId: transaction.completionReportId,
    finishReportId: transaction.finishReportId,
    completedTaskIds: [...transaction.completedTaskIds],
    stagedPaths: [...transaction.changedPaths],
    tree: transaction.candidateTree,
  };
}

function replayCommittedCommit(
  cwd: string,
  session: WorkflowSession,
  subject: string,
): CommitSessionResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  if (
    session.repositoryRoot !== git.repositoryRealPath ||
    session.gitCommonDirectory !== git.gitCommonDirectory ||
    session.state !== 'committed' ||
    !session.finishReportId ||
    !session.commitReportId ||
    !session.commitHash
  ) {
    throw invalidCompletedFinalize();
  }
  const report = readImmutableReport(
    runtime.reports,
    session.sessionId,
    session.commitReportId,
  );
  const changedPaths = reportStringArray(
    report,
    'changedPaths',
    'PENDING_COMMIT_INVALID',
  );
  const facts = commitFacts(git.repositoryRoot, session.commitHash);
  assertCommitObject(
    git.repositoryRoot,
    session,
    subject,
    facts,
    reportString(report, 'tree', 'PENDING_COMMIT_INVALID'),
    changedPaths,
  );
  if (
    report.kind !== 'commit' ||
    report.parentReportId !== session.finishReportId ||
    report.commitHash !== session.commitHash
  ) {
    throw invalidCompletedFinalize();
  }
  return {
    session,
    reportId: session.commitReportId,
    commitHash: session.commitHash,
  };
}

function invalidCompletedFinalize() {
  return workflowError(
    'FINALIZE_TRANSACTION_INVALID',
    'Completed finalize state does not match its immutable transaction and commit evidence.',
    ExitCode.staleState,
  );
}

function assertProjectedFinalizeCandidateChain(
  inspection: ReturnType<typeof inspectSession>,
  session: WorkflowSession,
  completionReport: WorkflowReport,
  finishReport: WorkflowReport,
): void {
  const projectedFields = [
    completionReport.finalizeProfile,
    completionReport.candidateTree,
    finishReport.finalizeProfile,
    finishReport.candidateTree,
  ];
  if (projectedFields.every((value) => value === undefined)) return;
  if (!session.latestCheckReportId) {
    throw staleReport('FINISH_REPORT_STALE');
  }
  const checkReport = readSessionReport(
    inspection,
    session.latestCheckReportId,
  );
  const candidateTree = reportString(
    finishReport,
    'candidateTree',
    'FINISH_REPORT_STALE',
  );
  if (
    checkReport.kind !== 'check' ||
    completionReport.kind !== 'completion' ||
    checkReport.parentReportId !== undefined ||
    completionReport.parentReportId !== session.latestCheckReportId ||
    checkReport.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    completionReport.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    finishReport.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    reportString(checkReport, 'candidateTree', 'FINISH_REPORT_STALE') !==
      candidateTree ||
    reportString(completionReport, 'candidateTree', 'FINISH_REPORT_STALE') !==
      candidateTree ||
    reportString(finishReport, 'tree', 'FINISH_REPORT_STALE') !== candidateTree
  ) {
    throw staleReport('FINISH_REPORT_STALE');
  }
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
