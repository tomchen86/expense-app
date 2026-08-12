import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import type {
  CrossAgentTddExecution,
  ExecutionTask,
  TddSingleAgentExecution,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  providerInvocationExists,
  readProviderInvocation,
} from './provider-invocation-store.ts';
import { getSession, type WorkflowSession } from './session.ts';
import {
  beginTaskStrategyImplementation,
  type BeginTaskStrategyImplementationOptions,
  type TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
import {
  createTaskStrategyImplementationSubject,
  type TaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
} from './task-strategy-provider-store.ts';
import { sealTaskStrategyRed } from './task-strategy-execution.ts';
import { adoptCurrentTaskStrategyImplementation } from './task-strategy-patch.ts';
import { readTaskStrategyPatchCurrentBinding } from './task-strategy-patch-store.ts';
import {
  readTaskStrategyTransaction,
  type TaskStrategyTransaction,
} from './task-strategy-store.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';

type TddStrategy = 'cross-agent-tdd' | 'tdd-single-agent';

export type TaskStrategyLifecycleState =
  | 'not-required'
  | 'session-terminal'
  | 'red-authoring'
  | 'implementation-required'
  | 'ready'
  | 'reservation-persisted'
  | 'collaboration-grant-required'
  | 'waiting-for-provider'
  | 'provider-succeeded-awaiting-import'
  | 'provider-failed'
  | 'caller-supplied-awaiting-import'
  | 'patch-imported';

export type TaskStrategyLifecycleStatus = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-lifecycle-status.v1';
  sessionId: string;
  strategy: string | null;
  state: TaskStrategyLifecycleState;
  transactionDigest: string | null;
  invocationId: string | null;
  sessionState: string;
  inputSchema?: unknown;
}>;

export type ResumeTaskStrategyOptions = Readonly<{
  explicitActor?: string;
  collaborationGrant?: BeginTaskStrategyImplementationOptions['collaborationGrant'];
}>;

/** Strictly read durable strategy state; never seal, reserve, dispatch, or import. */
export function inspectTaskStrategyLifecycle(
  cwd: string,
  requestedSessionId: string,
): TaskStrategyLifecycleStatus {
  const session = getSession(cwd, requestedSessionId);
  const context = loadInvestigationRuntimeContext(cwd);
  const transaction = readTaskStrategyTransaction(
    context.runtime,
    session.sessionId,
  );
  if (session.state !== 'active') {
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: transaction?.strategy ?? null,
      state: 'session-terminal',
      transactionDigest: transaction?.recordDigest ?? null,
      sessionState: session.state,
    });
  }

  const contract = loadStableValidatedChangeContract(
    discoverRepository(cwd),
    session.changeId,
  ).contract;
  const task = contract.execution?.tasks[session.taskId];
  if (!isTddExecution(task)) {
    if (transaction !== null) throw lifecycleStale();
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: task?.strategy ?? null,
      state: 'not-required',
      transactionDigest: null,
      sessionState: session.state,
    });
  }
  if (transaction === null) {
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: task.strategy,
      state: 'red-authoring',
      transactionDigest: null,
      sessionState: session.state,
    });
  }
  assertTransactionContractCurrent(transaction, session, task);
  return projectDurableImplementationState(
    context.runtime,
    transaction,
    session.state,
  );
}

/**
 * Advance only the next durable strategy substate. Process dispatch remains a
 * CLI concern so the domain transition cannot launch an arbitrary executable.
 */
export function resumeTaskStrategy(
  cwd: string,
  requestedSessionId: string,
  options: ResumeTaskStrategyOptions = {},
): TaskStrategyLifecycleStatus {
  let current = inspectTaskStrategyLifecycle(cwd, requestedSessionId);
  if (current.state === 'not-required') return current;
  if (current.state === 'session-terminal') {
    throw workflowError(
      'TASK_STRATEGY_RESUME_NOT_APPLICABLE',
      'Only an active task strategy transaction can be resumed.',
      ExitCode.staleState,
    );
  }
  if (current.state === 'red-authoring') {
    const transaction = sealTaskStrategyRed(cwd, current.sessionId, {
      ...(options.explicitActor === undefined
        ? {}
        : { explicitActor: options.explicitActor }),
    });
    if (transaction.strategy === 'tdd-single-agent') {
      return inspectTaskStrategyLifecycle(cwd, current.sessionId);
    }
  }

  current = inspectTaskStrategyLifecycle(cwd, current.sessionId);
  if (
    current.strategy === 'tdd-single-agent' &&
    current.state === 'implementation-required'
  ) {
    const adopted = adoptCurrentTaskStrategyImplementation(
      cwd,
      current.sessionId,
    );
    return adopted === null
      ? current
      : inspectTaskStrategyLifecycle(cwd, current.sessionId);
  }
  if (
    current.state === 'patch-imported' ||
    current.state === 'provider-failed'
  ) {
    return current;
  }
  const advanced = beginTaskStrategyImplementation(cwd, current.sessionId, {
    ...(options.collaborationGrant === undefined
      ? {}
      : { collaborationGrant: options.collaborationGrant }),
  });
  const transaction = requireTransaction(cwd, current.sessionId);
  return projectAdvancedStatus(advanced, transaction, 'active');
}

function projectDurableImplementationState(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: TaskStrategyTransaction,
  sessionState: string,
): TaskStrategyLifecycleStatus {
  const base = {
    sessionId: transaction.sessionId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    sessionState,
  };
  const patchBinding = readTaskStrategyPatchCurrentBinding(
    runtime,
    transaction.sessionId,
  );
  if (transaction.strategy === 'tdd-single-agent') {
    return lifecycleStatus({
      ...base,
      state:
        patchBinding === null ? 'implementation-required' : 'patch-imported',
    });
  }

  const reservation = readTaskStrategyImplementationReservation(
    runtime,
    transaction.sessionId,
  );
  const callerReservation = readTaskStrategyCallerImplementationReservation(
    runtime,
    transaction.sessionId,
  );
  const callerBinding = readTaskStrategyCallerImplementationBinding(
    runtime,
    transaction.sessionId,
  );
  if (reservation === null) {
    if (callerReservation !== null || callerBinding !== null) {
      if (
        callerReservation === null ||
        callerReservation.subjectDigest !== subject(transaction).subjectDigest
      ) {
        throw lifecycleStale();
      }
      return lifecycleStatus({
        ...base,
        state:
          callerBinding !== null &&
          callerBinding.subjectDigest === callerReservation.subjectDigest &&
          patchBinding !== null &&
          patchBinding.patchDigest === callerBinding.output.patchDigest
            ? 'patch-imported'
            : 'caller-supplied-awaiting-import',
      });
    }
    return lifecycleStatus({ ...base, state: 'ready' });
  }
  const expectedSubject = subject(transaction);
  if (
    reservation.subject.subjectDigest !== expectedSubject.subjectDigest ||
    reservation.subject.transactionDigest !== transaction.recordDigest
  ) {
    throw lifecycleStale();
  }
  if (!providerInvocationExists(runtime, reservation.request.invocationId)) {
    return lifecycleStatus({
      ...base,
      state: 'reservation-persisted',
      invocationId: reservation.request.invocationId,
    });
  }
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'failed') {
    return lifecycleStatus({
      ...base,
      state: 'provider-failed',
      invocationId: invocation.invocationId,
    });
  }
  if (invocation.state !== 'succeeded') {
    return lifecycleStatus({
      ...base,
      state: 'waiting-for-provider',
      invocationId: invocation.invocationId,
    });
  }
  const result = readTaskStrategyImplementationResultBinding(
    runtime,
    transaction.sessionId,
  );
  return lifecycleStatus({
    ...base,
    state:
      result !== null &&
      result.subjectDigest === expectedSubject.subjectDigest &&
      patchBinding !== null &&
      result.output.patchDigest === patchBinding.patchDigest
        ? 'patch-imported'
        : 'provider-succeeded-awaiting-import',
    invocationId: invocation.invocationId,
  });
}

function projectAdvancedStatus(
  advanced: TaskStrategyImplementationStatus,
  transaction: TaskStrategyTransaction,
  sessionState: string,
): TaskStrategyLifecycleStatus {
  return lifecycleStatus({
    sessionId: advanced.sessionId,
    strategy: transaction.strategy,
    state:
      advanced.state === 'provider-not-required'
        ? 'implementation-required'
        : advanced.state,
    transactionDigest: transaction.recordDigest,
    invocationId: 'invocationId' in advanced ? advanced.invocationId : null,
    sessionState,
    ...('inputSchema' in advanced ? { inputSchema: advanced.inputSchema } : {}),
  });
}

function assertTransactionContractCurrent(
  transaction: TaskStrategyTransaction,
  session: WorkflowSession,
  task: CrossAgentTddExecution | TddSingleAgentExecution,
): void {
  if (
    transaction.sessionId !== session.sessionId ||
    transaction.changeId !== session.changeId ||
    transaction.taskId !== session.taskId ||
    transaction.strategy !== task.strategy ||
    transaction.baseline.head !== session.baseline.head ||
    transaction.baseline.tree !== session.baseline.tree ||
    transaction.taskContractDigest !== sha256(canonicalJson(task))
  ) {
    throw lifecycleStale();
  }
}

function subject(
  transaction: TaskStrategyTransaction,
): TaskStrategyImplementationSubject {
  return createTaskStrategyImplementationSubject({
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    taskContractDigest: transaction.taskContractDigest,
    sourceTree: transaction.red.candidateTree,
    failureFingerprint: transaction.red.failureFingerprint,
    redEvidenceNodeId: transaction.red.evidenceNodeId,
    redEvidenceResultDigest: transaction.red.evidenceResultDigest,
    testPaths: transaction.red.testPaths,
    fixturePaths: transaction.red.fixturePaths,
    frozenFiles: transaction.red.files,
  });
}

function requireTransaction(
  cwd: string,
  sessionId: string,
): TaskStrategyTransaction {
  const context = loadInvestigationRuntimeContext(cwd);
  const transaction = readTaskStrategyTransaction(context.runtime, sessionId);
  if (transaction === null) throw lifecycleStale();
  return transaction;
}

function lifecycleStatus(
  input: Omit<
    TaskStrategyLifecycleStatus,
    'schemaVersion' | 'kind' | 'invocationId'
  > & { invocationId?: string | null },
): TaskStrategyLifecycleStatus {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'task-strategy-lifecycle-status.v1',
    invocationId: null,
    ...input,
  });
}

function isTddExecution(
  task: ExecutionTask | undefined,
): task is CrossAgentTddExecution | TddSingleAgentExecution {
  return isTddStrategy(task?.strategy);
}

function isTddStrategy(value: unknown): value is TddStrategy {
  return value === 'cross-agent-tdd' || value === 'tdd-single-agent';
}

function lifecycleStale() {
  return workflowError(
    'TASK_STRATEGY_LIFECYCLE_STALE',
    'Durable task strategy state no longer matches the active reviewed task contract.',
    ExitCode.staleState,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
