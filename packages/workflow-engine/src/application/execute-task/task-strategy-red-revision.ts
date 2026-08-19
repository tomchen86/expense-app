import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { pinCheckRunner } from '../../adapters/consumer/expense-app/work-registry/check-runner.ts';
import { writeEvidenceNode } from '../../runtime/storage-journal/evidence-object-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { readFinalizeTransaction } from '../../runtime/repository-transaction/finalize-transaction.ts';
import { assertCurrentImplementationReconciliation } from '../../modules/why-knowledge/implementation-reconciliation.ts';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from '../../composition-root/lifecycle-context.ts';
import { restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock } from './task-strategy-patch.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchRecord,
} from '../../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  createTaskStrategyCurrentRef,
  createTaskStrategyRedRevisionJournal,
  compareAndSwapTaskStrategyCurrentRef,
  persistTaskStrategyRedRevisionRequest,
  readActiveTaskStrategyRedRevision,
  readTaskStrategyCurrentRef,
  readTaskStrategyRedRevisionJournal,
  taskStrategyRedRevisionId,
  taskStrategyRedRevisionRequestDigest,
  taskStrategyRedRevisionSnapshotDigest,
  updateTaskStrategyRedRevisionJournal,
  type TaskStrategyRedRevisionJournal,
  type TaskStrategyRedRevisionJournalState,
  type TaskStrategyRedRevisionRequest,
} from '../../runtime/storage-journal/task-strategy-red-revision-store.ts';
import { prepareTaskStrategyRedSuccessorUnlocked } from './task-strategy-execution.ts';
import {
  persistTaskStrategyTransaction,
  prepareTaskStrategyTransaction,
  readTaskStrategyTransaction,
  readTaskStrategyTransactionByDigest,
  type TaskStrategyTransaction,
} from '../../runtime/storage-journal/task-strategy-store.ts';
import {
  readSessionFile,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  writeJsonAtomic,
  type WorkflowSession,
} from '../../runtime/session-workspace/session-store.ts';
import {
  inspectSession,
  type SessionInspection,
} from '../finalize/verification.ts';

export type TaskStrategyRedRevisionResult = Readonly<{
  sessionId: string;
  revisionId: string;
  phase: TaskStrategyRedRevisionJournal['phase'];
  transaction: TaskStrategyTransaction | null;
}>;

export type BeginTaskStrategyRedRevisionOptions = Readonly<{
  /** Test-only crash cut after the journal is durable but before any mutation. */
  testAfterJournalPersist?: () => void;
  /** Test-only crash cut after exact worktree restoration but before phase CAS. */
  testAfterWorktreeRestore?: () => void;
  /** Test-only crash cut after restoration is journaled but before ref CAS. */
  testAfterRestorationRecorded?: () => void;
}>;

export function beginTaskStrategyRedRevision(
  cwd: string,
  request: TaskStrategyRedRevisionRequest,
  options: BeginTaskStrategyRedRevisionOptions = {},
): TaskStrategyRedRevisionResult {
  const initial = loadActiveSessionContext(cwd, request.sessionId);
  return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
    withSessionOperation(initial.runtime, request.sessionId, () => {
      assertOwned();
      const context = loadInvestigationRuntimeContext(cwd);
      const requestedRevisionId = taskStrategyRedRevisionId(request);
      const exactJournal = readTaskStrategyRedRevisionJournal(
        context.runtime,
        request.sessionId,
        requestedRevisionId,
      );
      if (exactJournal !== null) {
        if (exactJournal.phase === 'completed') {
          return revisionResult(exactJournal);
        }
        return revisionResult(
          reconcileRevisionOpening(
            cwd,
            context,
            exactJournal,
            assertOwned,
            options,
          ),
        );
      }
      const active = readActiveTaskStrategyRedRevision(
        context.runtime,
        request.sessionId,
      );
      if (
        active !== null &&
        taskStrategyRedRevisionId(active.request) !== requestedRevisionId
      ) {
        throw workflowError(
          'TASK_STRATEGY_RED_REVISION_ACTIVE',
          'A different RED revision is already active for this task session.',
          ExitCode.conflict,
        );
      }
      const preparedJournal = prepareRevisionJournalStateUnlocked(
        cwd,
        context,
        request,
        requestedRevisionId,
        taskStrategyRedRevisionRequestDigest(request),
      );
      const persistedRequest = persistTaskStrategyRedRevisionRequest(
        context.runtime,
        request,
      );
      if (
        persistedRequest.revisionId !== requestedRevisionId ||
        persistedRequest.requestDigest !== preparedJournal.requestDigest
      ) {
        throw revisionStateCorrupt();
      }
      const journal = createTaskStrategyRedRevisionJournal(
        context.runtime,
        preparedJournal,
      );
      options.testAfterJournalPersist?.();
      const opened = reconcileRevisionOpening(
        cwd,
        context,
        journal,
        assertOwned,
        options,
      );
      return revisionResult(opened);
    }),
  );
}

/** Continue an existing revision, or return null when no revision exists. */
export function continueTaskStrategyRedRevision(
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): TaskStrategyRedRevisionResult | null {
  const initial = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
    withSessionOperation(initial.runtime, requestedSessionId, () => {
      assertOwned();
      const context = loadInvestigationRuntimeContext(cwd);
      const active = readActiveTaskStrategyRedRevision(
        context.runtime,
        requestedSessionId,
      );
      if (active === null) return null;
      const snapshot = persistTaskStrategyRedRevisionRequest(
        context.runtime,
        active.request,
      );
      let journal =
        active.journal ??
        createTaskStrategyRedRevisionJournal(
          context.runtime,
          prepareRevisionJournalStateUnlocked(
            cwd,
            context,
            snapshot.request,
            snapshot.revisionId,
            snapshot.requestDigest,
          ),
        );
      journal = reconcileRevisionOpening(cwd, context, journal, assertOwned);
      if (journal.phase === 'session-evidence-cleared') {
        const prepared = prepareTaskStrategyRedSuccessorUnlocked(
          cwd,
          requestedSessionId,
          {
            author: journal.binding.author,
            predecessorCandidateTree: journal.predecessor.candidateTree,
            environment,
          },
        );
        assertOwned();
        const successor = prepareTaskStrategyTransaction(
          prepared.transactionInput,
        );
        if (
          successor.red.checkId !== journal.binding.checkId ||
          successor.red.runner !== journal.binding.runner ||
          successor.red.runnerDigest !== journal.binding.runnerDigest
        ) {
          throw workflowError(
            'TASK_STRATEGY_RED_REVISION_PLAN_REQUIRED',
            'RED check identity changed; use a reviewed planning revision.',
            ExitCode.staleState,
          );
        }
        const successorRef = createTaskStrategyCurrentRef({
          sessionId: journal.sessionId,
          state: 'red-sealed',
          transactionDigest: successor.recordDigest,
          predecessorTransactionDigest: journal.predecessor.transactionDigest,
          revisionId: journal.revisionId,
          taskContractDigest: journal.binding.taskContractDigest,
          updatedAt: successor.createdAt,
        });
        journal = advanceJournal(context.runtime, journal, {
          phase: 'reseal-prepared',
          successorTransaction: successor,
          successorRef,
        });
      }
      if (journal.phase === 'reseal-prepared') {
        const successor = requireSuccessor(journal);
        writeEvidenceNode(context.runtime, successor.red.evidenceNode);
        persistTaskStrategyTransaction(context.runtime, successor);
        journal = advanceJournal(context.runtime, journal, {
          phase: 'successor-persisted',
        });
      }
      if (journal.phase === 'successor-persisted') {
        const successorRef = journal.successorRef;
        if (successorRef === null) throw revisionStateCorrupt();
        compareAndSwapTaskStrategyCurrentRef(context.runtime, {
          sessionId: journal.sessionId,
          expectedRefDigest: journal.authoringRef.refDigest,
          next: successorRef,
        });
        journal = advanceJournal(context.runtime, journal, {
          phase: 'current-sealed',
        });
      }
      if (journal.phase === 'current-sealed') {
        journal = advanceJournal(context.runtime, journal, {
          phase: 'completed',
        });
      }
      assertOwned();
      return revisionResult(journal);
    }),
  );
}

function prepareRevisionJournalStateUnlocked(
  cwd: string,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  request: TaskStrategyRedRevisionRequest,
  revisionId: string,
  requestDigest: string,
): TaskStrategyRedRevisionJournalState {
  const observedRef = readTaskStrategyCurrentRef(
    context.runtime,
    request.sessionId,
  );
  const predecessor = readTaskStrategyTransaction(
    context.runtime,
    request.sessionId,
  );
  if (
    predecessor === null ||
    predecessor.recordDigest !== request.expectedTransactionDigest
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_STALE',
      'RED revision must name the exact current sealed transaction.',
      ExitCode.staleState,
    );
  }
  const inspection = inspectSession(cwd, request.sessionId);
  assertPredecessorMatchesInspection(predecessor, inspection);
  assertRevisionMayProceed(cwd, predecessor, inspection.session);
  const patchBinding = readTaskStrategyPatchCurrentBinding(
    context.runtime,
    request.sessionId,
    predecessor.red.candidateTree,
  );
  const patchRecord =
    patchBinding === null
      ? null
      : readTaskStrategyPatchRecord(
          context.runtime,
          request.sessionId,
          patchBinding.patchDigest,
          predecessor.red.candidateTree,
        );
  if (patchBinding !== null && patchRecord === null) {
    throw revisionStateCorrupt();
  }
  const createdAt = new Date().toISOString();
  const authoringRef = createTaskStrategyCurrentRef({
    sessionId: request.sessionId,
    state: 'red-authoring',
    transactionDigest: null,
    predecessorTransactionDigest: predecessor.recordDigest,
    revisionId,
    taskContractDigest: predecessor.taskContractDigest,
    updatedAt: createdAt,
  });
  const before = structuredClone(inspection.session) as WorkflowSession;
  const after = revisedSessionSnapshot(inspection);
  return {
    revisionId,
    sessionId: request.sessionId,
    phase: 'prepared',
    request,
    requestDigest,
    predecessor: {
      transactionDigest: predecessor.recordDigest,
      candidateTree: predecessor.red.candidateTree,
      currentRefDigest: observedRef?.refDigest ?? null,
    },
    binding: {
      changeId: predecessor.changeId,
      taskId: predecessor.taskId,
      baseline: predecessor.baseline,
      strategy: predecessor.strategy,
      taskContractDigest: predecessor.taskContractDigest,
      checkId: predecessor.red.checkId,
      runner: predecessor.red.runner,
      runnerDigest: predecessor.red.runnerDigest,
      author: predecessor.author,
    },
    restoration: {
      sourceTree: predecessor.red.candidateTree,
      implementationCandidateTree: patchRecord?.candidateTree ?? null,
      patchRecordDigest: patchRecord?.recordDigest ?? null,
      patchDigest: patchRecord?.patchDigest ?? null,
    },
    sessionTransition: {
      before,
      beforeDigest: taskStrategyRedRevisionSnapshotDigest(before),
      after,
      afterDigest: taskStrategyRedRevisionSnapshotDigest(after),
    },
    authoringRef,
    successorTransaction: null,
    successorRef: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function reconcileRevisionOpening(
  cwd: string,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  initial: TaskStrategyRedRevisionJournal,
  assertOwned: () => void,
  options: BeginTaskStrategyRedRevisionOptions = {},
): TaskStrategyRedRevisionJournal {
  let journal = initial;
  const predecessor = readTaskStrategyTransactionByDigest(
    context.runtime,
    journal.sessionId,
    journal.predecessor.transactionDigest,
  );
  if (predecessor === null) throw revisionStateCorrupt();
  assertJournalBindingMatchesPredecessor(journal, predecessor);
  const inspection = inspectSession(cwd, journal.sessionId);
  assertPredecessorMatchesInspection(predecessor, inspection);
  assertRevisionMayProceed(cwd, predecessor, inspection.session);
  assertJournalDurableRelations(context, journal, inspection.session);
  if (journal.phase === 'prepared') {
    const restored =
      restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock(
        cwd,
        journal.sessionId,
        predecessor,
        assertOwned,
      );
    if (
      (restored?.recordDigest ?? null) !==
        journal.restoration.patchRecordDigest ||
      (restored?.patchDigest ?? null) !== journal.restoration.patchDigest ||
      (restored?.candidateTree ?? null) !==
        journal.restoration.implementationCandidateTree
    ) {
      throw revisionStateCorrupt();
    }
    options.testAfterWorktreeRestore?.();
    journal = advanceJournal(context.runtime, journal, {
      phase: 'implementation-restored',
    });
    options.testAfterRestorationRecorded?.();
  }
  if (journal.phase === 'implementation-restored') {
    compareAndSwapTaskStrategyCurrentRef(context.runtime, {
      sessionId: journal.sessionId,
      expectedRefDigest: journal.predecessor.currentRefDigest,
      next: journal.authoringRef,
    });
    journal = advanceJournal(context.runtime, journal, {
      phase: 'current-authoring',
    });
  }
  if (journal.phase === 'current-authoring') {
    clearSessionEvidence(context, journal);
    journal = advanceJournal(context.runtime, journal, {
      phase: 'session-evidence-cleared',
    });
  }
  return journal;
}

function clearSessionEvidence(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: TaskStrategyRedRevisionJournal,
): WorkflowSession {
  const filePath = path.join(
    context.lifecycleRuntime.sessions,
    `${journal.sessionId}.json`,
  );
  const current = readSessionFile(filePath);
  if (
    canonicalJson(current) === canonicalJson(journal.sessionTransition.after)
  ) {
    return current as WorkflowSession;
  }
  if (
    canonicalJson(current) !== canonicalJson(journal.sessionTransition.before)
  ) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The task session changed during RED revision.',
      ExitCode.staleState,
    );
  }
  const next = journal.sessionTransition.after as WorkflowSession;
  writeJsonAtomic(filePath, next);
  const persisted = readSessionFile(filePath);
  if (canonicalJson(persisted) !== canonicalJson(next)) {
    throw revisionStateCorrupt();
  }
  return persisted;
}

function revisedSessionSnapshot(
  inspection: SessionInspection,
): WorkflowSession {
  const current = inspection.session;
  const next = structuredClone(current);
  if (current.implementationReconciliationReportId !== undefined) {
    const reconciliation =
      assertCurrentImplementationReconciliation(inspection);
    if (reconciliation === null || reconciliation.ledgerProjection !== null) {
      throw workflowError(
        'TASK_STRATEGY_RED_REVISION_PLAN_REQUIRED',
        'Recorded implementation reconciliation projected semantic-ledger bytes; use a reviewed planning revision.',
        ExitCode.staleState,
      );
    }
    delete next.implementationReconciliationReportId;
    delete next.implementationReconciliationPaths;
  }
  delete next.latestCheckReportId;
  delete next.checkEvidenceEngineDigest;
  return next;
}

function assertPredecessorMatchesInspection(
  predecessor: TaskStrategyTransaction,
  inspection: SessionInspection,
): void {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (
    (task?.strategy !== 'cross-agent-tdd' &&
      task?.strategy !== 'tdd-single-agent') ||
    predecessor.sessionId !== inspection.session.sessionId ||
    predecessor.changeId !== inspection.session.changeId ||
    predecessor.taskId !== inspection.session.taskId ||
    canonicalJson(predecessor.baseline) !==
      canonicalJson(inspection.session.baseline) ||
    predecessor.strategy !== task.strategy ||
    predecessor.taskContractDigest !== sha256(canonicalJson(task))
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_PLAN_REQUIRED',
      'The reviewed task contract or execution baseline changed; use a reviewed planning revision.',
      ExitCode.staleState,
    );
  }
  const definition = inspection.contract.checks.checks[task.redCheck];
  if (definition === undefined || definition.destructiveDatabase) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_PLAN_REQUIRED',
      'The pinned RED check is missing or no longer safe; use a reviewed planning revision.',
      ExitCode.staleState,
    );
  }
  const runner = pinCheckRunner(
    inspection.git.repositoryRoot,
    task.redCheck,
    definition,
  );
  if (
    predecessor.red.checkId !== task.redCheck ||
    predecessor.red.runner !== runner.runner ||
    predecessor.red.runnerDigest !== runner.digest
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_PLAN_REQUIRED',
      'The pinned RED runner changed; use a reviewed planning revision.',
      ExitCode.staleState,
    );
  }
}

function assertJournalBindingMatchesPredecessor(
  journal: TaskStrategyRedRevisionJournal,
  predecessor: TaskStrategyTransaction,
): void {
  if (
    predecessor.recordDigest !== journal.predecessor.transactionDigest ||
    predecessor.red.candidateTree !== journal.predecessor.candidateTree ||
    predecessor.changeId !== journal.binding.changeId ||
    predecessor.taskId !== journal.binding.taskId ||
    canonicalJson(predecessor.baseline) !==
      canonicalJson(journal.binding.baseline) ||
    predecessor.strategy !== journal.binding.strategy ||
    predecessor.taskContractDigest !== journal.binding.taskContractDigest ||
    predecessor.red.checkId !== journal.binding.checkId ||
    predecessor.red.runner !== journal.binding.runner ||
    predecessor.red.runnerDigest !== journal.binding.runnerDigest ||
    canonicalJson(predecessor.author) !== canonicalJson(journal.binding.author)
  ) {
    throw revisionStateCorrupt();
  }
}

function assertJournalDurableRelations(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: TaskStrategyRedRevisionJournal,
  session: WorkflowSession,
): void {
  if (journal.phase === 'completed') return;
  const before =
    canonicalJson(session) === canonicalJson(journal.sessionTransition.before);
  const after =
    canonicalJson(session) === canonicalJson(journal.sessionTransition.after);
  const sessionValid =
    journal.phase === 'prepared' || journal.phase === 'implementation-restored'
      ? before
      : journal.phase === 'current-authoring'
        ? before || after
        : after;
  if (!sessionValid) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The task session changed during RED revision.',
      ExitCode.staleState,
    );
  }

  const current = readTaskStrategyCurrentRef(
    context.runtime,
    journal.sessionId,
  );
  const predecessorCurrent =
    journal.predecessor.currentRefDigest === null
      ? current === null
      : current?.refDigest === journal.predecessor.currentRefDigest &&
        current.state === 'red-sealed' &&
        current.transactionDigest === journal.predecessor.transactionDigest;
  const authoringCurrent =
    current?.refDigest === journal.authoringRef.refDigest &&
    current.state === 'red-authoring';
  const successorCurrent =
    journal.successorRef !== null &&
    current?.refDigest === journal.successorRef.refDigest &&
    current.state === 'red-sealed';
  const refValid =
    journal.phase === 'prepared'
      ? predecessorCurrent
      : journal.phase === 'implementation-restored'
        ? predecessorCurrent || authoringCurrent
        : journal.phase === 'successor-persisted'
          ? authoringCurrent || successorCurrent
          : journal.phase === 'current-sealed'
            ? successorCurrent
            : authoringCurrent;
  if (!refValid) throw revisionStateCorrupt();
}

function assertRevisionMayProceed(
  cwd: string,
  predecessor: TaskStrategyTransaction,
  session: WorkflowSession,
): void {
  const context = loadInvestigationRuntimeContext(cwd);
  if (
    session.state !== 'active' ||
    session.revisionLeaseId !== undefined ||
    session.completionReportId !== undefined ||
    session.finishReportId !== undefined ||
    session.commitReportId !== undefined
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_NOT_APPLICABLE',
      'RED revision cannot begin during planning revision, completion, staging, commit, or a terminal session.',
      ExitCode.staleState,
    );
  }
  const finalize = readFinalizeTransaction(
    context.lifecycleRuntime.root,
    predecessor.sessionId,
  );
  if (finalize !== null) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_FINALIZE_RECOVERY_REQUIRED',
      'An active finalize transaction must be recovered or cancelled before RED revision.',
      ExitCode.staleState,
      {
        recovery: `pnpm workflow finalize-recover ${predecessor.sessionId} --json`,
      },
    );
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function advanceJournal(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  current: TaskStrategyRedRevisionJournal,
  patch: Partial<TaskStrategyRedRevisionJournalState> &
    Pick<TaskStrategyRedRevisionJournalState, 'phase'>,
): TaskStrategyRedRevisionJournal {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    journalDigest: _journalDigest,
    previousJournalDigest: _previousJournalDigest,
    ...state
  } = current;
  return updateTaskStrategyRedRevisionJournal(paths, {
    sessionId: current.sessionId,
    revisionId: current.revisionId,
    expectedJournalDigest: current.journalDigest,
    next: {
      ...state,
      ...patch,
      updatedAt: new Date().toISOString(),
    },
  });
}

function requireRevisionJournal(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  sessionId: string,
  revisionId: string,
): TaskStrategyRedRevisionJournal {
  const journal = readTaskStrategyRedRevisionJournal(
    paths,
    sessionId,
    revisionId,
  );
  if (journal === null) throw revisionStateCorrupt();
  return journal;
}

function requireSuccessor(
  journal: TaskStrategyRedRevisionJournal,
): TaskStrategyTransaction {
  if (journal.successorTransaction === null) throw revisionStateCorrupt();
  return journal.successorTransaction;
}

function revisionResult(
  journal: TaskStrategyRedRevisionJournal,
): TaskStrategyRedRevisionResult {
  return Object.freeze({
    sessionId: journal.sessionId,
    revisionId: journal.revisionId,
    phase: journal.phase,
    transaction: journal.successorTransaction,
  });
}

function revisionStateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT',
    'Task strategy RED revision state is malformed or disagrees with its durable lineage.',
    ExitCode.staleState,
  );
}
