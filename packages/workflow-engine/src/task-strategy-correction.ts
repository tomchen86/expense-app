import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import type { CheckEvidence, ObservedCheckFailure } from './check-runner.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { pinCheckRunner } from './check-runner.ts';
import { investigationRuntimePaths } from './paths.ts';
import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  createTaskStrategyGreenFailureRecord,
  readTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
} from './task-strategy-correction-store.ts';
import {
  deriveTaskStrategyCorrectionState,
  listTaskStrategyCorrectionRounds,
  type TaskStrategyCorrectionRound,
  type TaskStrategyCorrectionState,
} from './task-strategy-correction-round-store.ts';
import { readProviderInvocation } from './provider-invocation-store.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchRecord,
} from './task-strategy-patch-store.ts';
import {
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationSubject,
  type TaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
  assertTaskStrategyCallerImplementationAuthorityCurrent,
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyImplementationProviderAttempt,
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
} from './task-strategy-provider-store.ts';
import { readTaskStrategyTransaction } from './task-strategy-store.ts';
import type { TaskStrategyTransaction } from './task-strategy-store.ts';
import type { SessionInspection } from './verification.ts';

export type CurrentTaskStrategyPatchHead = Readonly<{
  binding: NonNullable<ReturnType<typeof readTaskStrategyPatchCurrentBinding>>;
  record: NonNullable<ReturnType<typeof readTaskStrategyPatchRecord>>;
  receipt: NonNullable<ReturnType<typeof readTaskStrategyPatchImportReceipt>>;
}>;

export type TaskStrategyCorrectionProjection = Readonly<{
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>;
  head: CurrentTaskStrategyPatchHead | null;
  failure: TaskStrategyGreenFailureRecord | null;
  completedCorrectionRounds: number;
  exhausted: boolean;
  correctionState: TaskStrategyCorrectionState | null;
}>;

export type CurrentTaskStrategyImplementationAuthority = Readonly<{
  subject: TaskStrategyImplementationSubject;
  greenFailureRecord: TaskStrategyGreenFailureRecord | null;
}>;

/**
 * Persist only an engine-observed ordinary GREEN failure. Checks that throw,
 * mutate the worktree, lose runner identity, or belong to a non-TDD strategy
 * never enter this semantic correction ledger.
 */
export function recordTaskStrategyGreenFailure(
  inspection: SessionInspection,
  passedChecks: readonly CheckEvidence[],
  failingCheck: ObservedCheckFailure,
): TaskStrategyGreenFailureRecord | null {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (!isTddTask(task)) return null;
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const transaction = readTaskStrategyTransaction(
    runtime,
    inspection.session.sessionId,
  );
  if (
    transaction === null ||
    transaction.strategy !== task.strategy ||
    !task.greenChecks.includes(failingCheck.checkId)
  ) {
    throw correctionStateStale();
  }
  const projection = resolveCurrentTaskStrategyCorrection(inspection);
  const head = projection.head;
  if (head === null || projection.failure !== null) {
    throw correctionStateStale();
  }
  const { binding, record, receipt } = head;
  const definitions = task.greenChecks.map((checkId) => {
    const definition = inspection.contract.checks.checks[checkId];
    if (definition === undefined) throw correctionStateStale();
    const runner = pinCheckRunner(
      inspection.git.repositoryRoot,
      checkId,
      definition,
    );
    return Object.freeze({
      checkId,
      definition: Object.freeze({
        command: Object.freeze([...definition.command]),
        destructiveDatabase: definition.destructiveDatabase,
      }),
      runner: runner.runner,
      runnerDigest: runner.digest,
    });
  });
  if (
    definitions.find(({ checkId }) => checkId === failingCheck.checkId)
      ?.runnerDigest !== failingCheck.runnerDigest ||
    passedChecks.some(
      (check) =>
        !task.greenChecks.includes(check.checkId) ||
        definitions.find(({ checkId }) => checkId === check.checkId)
          ?.runnerDigest !== check.runnerDigest,
    )
  ) {
    throw correctionStateStale();
  }
  return createTaskStrategyGreenFailureRecord(runtime, {
    sessionId: inspection.session.sessionId,
    currentRedTransactionDigest: transaction.recordDigest,
    currentPatchHead: {
      bindingDigest: binding.bindingDigest,
      recordDigest: record.recordDigest,
      patchDigest: record.patchDigest,
      receiptDigest: receipt.receiptDigest,
    },
    candidateTree: record.candidateTree,
    checkDefinitions: definitions,
    passedChecks: Object.freeze([...passedChecks]),
    failingCheck,
    createdAt: new Date().toISOString(),
  });
}

export function readCurrentTaskStrategyGreenFailure(
  inspection: SessionInspection,
): TaskStrategyGreenFailureRecord | null {
  return resolveCurrentTaskStrategyCorrection(inspection).failure;
}

export function resolveCurrentTaskStrategyCorrection(
  inspection: SessionInspection,
): TaskStrategyCorrectionProjection {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (!isTddTask(task)) throw correctionStateStale();
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const transaction = readTaskStrategyTransaction(
    runtime,
    inspection.session.sessionId,
  );
  if (transaction === null) throw correctionStateStale();
  const initialHead = readAuthenticatedPatchHead(
    runtime,
    inspection.session.sessionId,
    transaction.red.candidateTree,
  );
  const rounds = listTaskStrategyCorrectionRounds(
    runtime,
    inspection.session.sessionId,
    transaction.recordDigest,
  );
  if (initialHead === null) {
    if (rounds.length > 0) throw correctionStateStale();
    return Object.freeze({
      transaction,
      head: null,
      failure: null,
      completedCorrectionRounds: 0,
      exhausted: false,
      correctionState: null,
    });
  }
  assertInitialImplementationAuthorityCurrent(
    runtime,
    transaction,
    initialHead,
  );
  let head = initialHead;
  let failure = readAuthenticatedFailure(
    runtime,
    inspection.session.sessionId,
    transaction,
    head,
  );
  if (failure === null) {
    if (rounds.length > 0) throw correctionStateStale();
    return Object.freeze({
      transaction,
      head,
      failure: null,
      completedCorrectionRounds: 0,
      exhausted: false,
      correctionState: null,
    });
  }

  let completedCorrectionRounds = 0;
  for (const [index, round] of rounds.entries()) {
    const expectedRound = index + 1;
    const expectedSubject = createCurrentTaskStrategyCorrectionSubject(
      transaction,
      failure,
      expectedRound,
    );
    if (
      round.reservation.round !== expectedRound ||
      round.reservation.redSourceTree !== transaction.red.candidateTree ||
      round.reservation.correctionSubjectDigest !==
        expectedSubject.subjectDigest ||
      round.reservation.predecessorFailure.recordDigest !==
        failure.recordDigest ||
      round.reservation.predecessorFailure.subjectDigest !==
        failure.subjectDigest ||
      round.reservation.predecessorFailure.candidateTree !==
        failure.candidateTree ||
      canonicalJson(round.reservation.predecessorFailure.currentPatchHead) !==
        canonicalJson(failure.currentPatchHead)
    ) {
      throw correctionStateStale();
    }
    if (round.importRecord === null) {
      if (index !== rounds.length - 1) throw correctionStateStale();
      const correctionState = deriveTaskStrategyCorrectionState(
        runtime,
        failure,
        DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
      );
      return Object.freeze({
        transaction,
        head,
        failure,
        completedCorrectionRounds,
        exhausted: correctionState.state === 'correction-exhausted',
        correctionState,
      });
    }
    const patchHead = readAuthenticatedPatchHead(
      runtime,
      inspection.session.sessionId,
      failure.candidateTree,
    );
    if (
      round.result === null ||
      patchHead === null ||
      round.result.patchResult.sourceTree !== failure.candidateTree ||
      round.result.patchResult.targetCandidateTree !==
        patchHead.record.candidateTree ||
      round.result.patchResult.patchRecordDigest !==
        patchHead.record.recordDigest ||
      round.result.patchResult.patchDigest !== patchHead.record.patchDigest ||
      canonicalJson(round.importRecord.currentPatchHead) !==
        canonicalJson({
          bindingDigest: patchHead.binding.bindingDigest,
          recordDigest: patchHead.record.recordDigest,
          patchDigest: patchHead.record.patchDigest,
          receiptDigest: patchHead.receipt.receiptDigest,
        }) ||
      (round.result.authority.kind === 'sealed-local' &&
        (transaction.strategy !== 'tdd-single-agent' ||
          canonicalJson(round.result.authority.author) !==
            canonicalJson(transaction.author) ||
          canonicalJson(patchHead.record.implementer) !==
            canonicalJson(transaction.author)))
    ) {
      throw correctionStateStale();
    }
    if (round.result.authority.kind === 'provider') {
      assertProviderCorrectionAuthorityCurrent(
        runtime,
        transaction,
        expectedSubject,
        round,
        patchHead,
      );
    } else if (round.result.authority.kind === 'caller-supplied') {
      assertCallerCorrectionAuthorityCurrent(
        runtime,
        transaction,
        expectedSubject,
        round,
        patchHead,
      );
    }
    head = patchHead;
    completedCorrectionRounds += 1;
    failure = readAuthenticatedFailure(
      runtime,
      inspection.session.sessionId,
      transaction,
      head,
    );
    if (failure === null) {
      if (index !== rounds.length - 1) throw correctionStateStale();
      return Object.freeze({
        transaction,
        head,
        failure: null,
        completedCorrectionRounds,
        exhausted: false,
        correctionState: null,
      });
    }
  }
  const correctionState = deriveTaskStrategyCorrectionState(
    runtime,
    failure,
    DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  );
  assertNoUnreservedCorrectionPatch(
    runtime,
    inspection.session.sessionId,
    failure,
    correctionState,
  );
  return Object.freeze({
    transaction,
    head,
    failure,
    completedCorrectionRounds,
    exhausted: correctionState.state === 'correction-exhausted',
    correctionState,
  });
}

/**
 * Resolve the exact implementation subject that owns the current correction
 * head. A completed correction remains bound to its originating GREEN failure;
 * it must not fall back to the initial RED subject merely because the latest
 * candidate has not failed again.
 */
export function resolveCurrentTaskStrategyImplementationAuthority(
  inspection: SessionInspection,
  projection: TaskStrategyCorrectionProjection = resolveCurrentTaskStrategyCorrection(
    inspection,
  ),
): CurrentTaskStrategyImplementationAuthority {
  const transaction = projection.transaction;
  if (projection.failure !== null) {
    return Object.freeze({
      subject: createCurrentTaskStrategyCorrectionSubject(
        transaction,
        projection.failure,
        projection.completedCorrectionRounds + 1,
      ),
      greenFailureRecord: projection.failure,
    });
  }
  if (projection.completedCorrectionRounds === 0) {
    return Object.freeze({
      subject: createInitialTaskStrategyImplementationSubject(transaction),
      greenFailureRecord: null,
    });
  }
  if (projection.head === null) throw correctionStateStale();
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const greenFailureRecord = readTaskStrategyGreenFailureRecord(
    runtime,
    inspection.session.sessionId,
    projection.head.record.sourceTree,
  );
  if (greenFailureRecord === null) throw correctionStateStale();
  return Object.freeze({
    subject: createCurrentTaskStrategyCorrectionSubject(
      transaction,
      greenFailureRecord,
      projection.completedCorrectionRounds,
    ),
    greenFailureRecord,
  });
}

function assertNoUnreservedCorrectionPatch(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  sessionId: string,
  failure: TaskStrategyGreenFailureRecord,
  correctionState: TaskStrategyCorrectionState,
): void {
  if (
    correctionState.state === 'correction-required' &&
    correctionState.nextAction !== 'reserve'
  ) {
    return;
  }
  if (
    readTaskStrategyPatchCurrentBinding(
      runtime,
      sessionId,
      failure.candidateTree,
    ) !== null
  ) {
    throw correctionStateStale();
  }
}

export function createCurrentTaskStrategyCorrectionSubject(
  transaction: TaskStrategyTransaction,
  failure: TaskStrategyGreenFailureRecord,
  round: number,
): TaskStrategyImplementationSubject {
  return createTaskStrategyCorrectionSubject({
    subject: createInitialTaskStrategyImplementationSubject(transaction),
    round,
    greenFailureRecord: failure,
  });
}

function createInitialTaskStrategyImplementationSubject(
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

function readAuthenticatedPatchHead(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  sessionId: string,
  sourceTree: string,
): CurrentTaskStrategyPatchHead | null {
  const binding = readTaskStrategyPatchCurrentBinding(
    runtime,
    sessionId,
    sourceTree,
  );
  if (binding === null) return null;
  const record = readTaskStrategyPatchRecord(
    runtime,
    sessionId,
    binding.patchDigest,
    sourceTree,
  );
  const receipt = readTaskStrategyPatchImportReceipt(
    runtime,
    sessionId,
    binding.patchDigest,
    sourceTree,
  );
  if (
    record === null ||
    receipt === null ||
    record.sourceTree !== sourceTree ||
    binding.recordDigest !== record.recordDigest ||
    binding.receiptDigest !== receipt.receiptDigest ||
    binding.candidateTree !== record.candidateTree ||
    receipt.recordDigest !== record.recordDigest ||
    receipt.candidateTree !== record.candidateTree
  ) {
    throw correctionStateStale();
  }
  return Object.freeze({ binding, record, receipt });
}

function readAuthenticatedFailure(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  sessionId: string,
  transaction: TaskStrategyTransaction,
  head: CurrentTaskStrategyPatchHead,
): TaskStrategyGreenFailureRecord | null {
  const failure = readTaskStrategyGreenFailureRecord(
    runtime,
    sessionId,
    head.record.candidateTree,
  );
  if (failure === null) return null;
  if (
    failure.currentRedTransactionDigest !== transaction.recordDigest ||
    canonicalJson(failure.currentPatchHead) !==
      canonicalJson({
        bindingDigest: head.binding.bindingDigest,
        recordDigest: head.record.recordDigest,
        patchDigest: head.record.patchDigest,
        receiptDigest: head.receipt.receiptDigest,
      })
  ) {
    throw correctionStateStale();
  }
  return failure;
}

function assertProviderCorrectionAuthorityCurrent(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  transaction: TaskStrategyTransaction,
  expectedSubject: TaskStrategyImplementationSubject,
  round: TaskStrategyCorrectionRound,
  patchHead: CurrentTaskStrategyPatchHead,
): void {
  const result = round.result;
  if (
    result === null ||
    result.authority.kind !== 'provider' ||
    round.reservation.authority.kind !== 'provider' ||
    transaction.strategy !== 'cross-agent-tdd'
  ) {
    throw correctionStateStale();
  }
  const authority = result.authority;
  try {
    const reservation = readTaskStrategyImplementationReservation(
      runtime,
      transaction.sessionId,
      expectedSubject.subjectDigest,
    );
    const binding = readTaskStrategyImplementationResultBinding(
      runtime,
      transaction.sessionId,
      expectedSubject.subjectDigest,
    );
    if (reservation === null || binding === null) {
      throw correctionStateStale();
    }
    const providerAttempt = readTaskStrategyImplementationProviderAttempt(
      runtime,
      reservation,
      binding.invocationId,
    );
    const exactReservation =
      taskStrategyImplementationReservationForAttempt(providerAttempt);
    const invocation = readProviderInvocation(runtime, binding.invocationId);
    if (
      canonicalJson(round.reservation.authority) !==
        canonicalJson({
          kind: 'provider',
          providerRequest: authority.providerRequest,
          providerReservation: authority.providerReservation,
        }) ||
      reservation.recordDigest !==
        authority.providerReservation.reservationDigest ||
      reservation.ownerInvestigationId !==
        authority.providerRequest.ownerInvestigationId ||
      reservation.authorizationNodeId !==
        authority.providerReservation.authorizationNodeId ||
      reservation.reservationNodeId !==
        authority.providerReservation.reservationNodeId ||
      reservation.request.invocationId !==
        authority.providerRequest.invocationId ||
      reservation.request.requestDigest !==
        authority.providerRequest.requestDigest ||
      providerAttempt.attempt !== authority.providerAttempt.attempt ||
      taskStrategyImplementationProviderAttemptReservationDigest(
        providerAttempt,
      ) !== authority.providerAttempt.attemptReservationDigest ||
      exactReservation.request.invocationId !==
        authority.providerAttempt.invocationId ||
      exactReservation.request.requestDigest !==
        authority.providerAttempt.requestDigest ||
      canonicalJson(reservation.subject) !== canonicalJson(expectedSubject) ||
      binding.bindingDigest !== authority.providerResult.bindingDigest ||
      binding.invocationId !== authority.providerResult.invocationId ||
      binding.requestDigest !== authority.providerResult.requestDigest ||
      binding.outputDigest !== authority.providerResult.outputDigest ||
      binding.providerResultNodeId !==
        authority.providerResult.providerResultNodeId ||
      binding.providerResultDigest !==
        authority.providerResult.providerResultDigest ||
      binding.output.sourceTree !== patchHead.record.sourceTree ||
      binding.output.patchDigest !== patchHead.record.patchDigest ||
      binding.roleResult.participant.providerId !==
        patchHead.record.implementer.providerId
    ) {
      throw correctionStateStale();
    }
    assertTaskStrategyImplementationProviderAuthorityCurrent(
      runtime,
      exactReservation,
      invocation,
      binding,
    );
  } catch {
    throw correctionStateStale();
  }
}

function assertInitialImplementationAuthorityCurrent(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  transaction: TaskStrategyTransaction,
  patchHead: CurrentTaskStrategyPatchHead,
): void {
  const subject = createInitialTaskStrategyImplementationSubject(transaction);
  try {
    const providerReservation = readTaskStrategyImplementationReservation(
      runtime,
      transaction.sessionId,
      subject.subjectDigest,
    );
    const providerBinding = readTaskStrategyImplementationResultBinding(
      runtime,
      transaction.sessionId,
      subject.subjectDigest,
    );
    const callerReservation = readTaskStrategyCallerImplementationReservation(
      runtime,
      transaction.sessionId,
      subject.subjectDigest,
    );
    const callerBinding = readTaskStrategyCallerImplementationBinding(
      runtime,
      transaction.sessionId,
      subject.subjectDigest,
    );
    const sealedLocal =
      transaction.strategy === 'tdd-single-agent' &&
      canonicalJson(patchHead.record.implementer) ===
        canonicalJson(transaction.author);
    const provider = providerReservation !== null && providerBinding !== null;
    const caller = callerReservation !== null && callerBinding !== null;
    if (Number(sealedLocal) + Number(provider) + Number(caller) !== 1) {
      throw correctionStateStale();
    }
    if (provider) {
      const providerAttempt = readTaskStrategyImplementationProviderAttempt(
        runtime,
        providerReservation,
        providerBinding.invocationId,
      );
      const exactReservation =
        taskStrategyImplementationReservationForAttempt(providerAttempt);
      const invocation = readProviderInvocation(
        runtime,
        providerBinding.invocationId,
      );
      if (
        canonicalJson(providerReservation.subject) !== canonicalJson(subject) ||
        providerBinding.output.sourceTree !== patchHead.record.sourceTree ||
        providerBinding.output.patchDigest !== patchHead.record.patchDigest ||
        providerBinding.roleResult.participant.providerId !==
          patchHead.record.implementer.providerId
      ) {
        throw correctionStateStale();
      }
      assertTaskStrategyImplementationProviderAuthorityCurrent(
        runtime,
        exactReservation,
        invocation,
        providerBinding,
      );
      return;
    }
    if (caller) {
      const participant = callerReservation.assignment.participant;
      if (
        callerBinding.output.sourceTree !== patchHead.record.sourceTree ||
        callerBinding.output.patchDigest !== patchHead.record.patchDigest ||
        participant.principalId === null ||
        participant.identityAssurance === 'maintainer-signed' ||
        canonicalJson(patchHead.record.implementer) !==
          canonicalJson({
            providerId: null,
            principalId: participant.principalId,
            assurance: participant.identityAssurance,
            degradedForm: 'caller-supplied',
            grantId: callerReservation.grantId,
          })
      ) {
        throw correctionStateStale();
      }
      assertTaskStrategyCallerImplementationAuthorityCurrent(
        runtime,
        transaction,
        subject,
        callerReservation,
        callerBinding,
      );
    }
  } catch {
    throw correctionStateStale();
  }
}

function assertCallerCorrectionAuthorityCurrent(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  transaction: TaskStrategyTransaction,
  expectedSubject: TaskStrategyImplementationSubject,
  round: TaskStrategyCorrectionRound,
  patchHead: CurrentTaskStrategyPatchHead,
): void {
  const result = round.result;
  if (
    result === null ||
    result.authority.kind !== 'caller-supplied' ||
    round.reservation.authority.kind !== 'caller-supplied' ||
    transaction.strategy !== 'cross-agent-tdd'
  ) {
    throw correctionStateStale();
  }
  const authority = result.authority;
  try {
    const reservation = readTaskStrategyCallerImplementationReservation(
      runtime,
      transaction.sessionId,
      expectedSubject.subjectDigest,
    );
    const binding = readTaskStrategyCallerImplementationBinding(
      runtime,
      transaction.sessionId,
      expectedSubject.subjectDigest,
    );
    if (reservation === null || binding === null) {
      throw correctionStateStale();
    }
    const participant = reservation.assignment.participant;
    if (
      canonicalJson(round.reservation.authority) !==
        canonicalJson({
          kind: 'caller-supplied',
          callerReservation: authority.callerReservation,
        }) ||
      reservation.reservationDigest !==
        authority.callerReservation.reservationDigest ||
      reservation.grantId !== authority.callerReservation.grantId ||
      reservation.transitionDigest !==
        authority.callerReservation.transitionDigest ||
      reservation.submissionNodeId !==
        authority.callerReservation.submissionNodeId ||
      reservation.submissionResultDigest !==
        authority.callerReservation.submissionResultDigest ||
      reservation.subjectDigest !== expectedSubject.subjectDigest ||
      binding.bindingDigest !== authority.callerResult.bindingDigest ||
      binding.resultNodeId !== authority.callerResult.resultNodeId ||
      binding.resultDigest !== authority.callerResult.resultDigest ||
      binding.roleResult.resultDigest !==
        authority.callerResult.roleResultDigest ||
      binding.roleResult.grantUse === null ||
      sha256(canonicalJson(binding.roleResult.grantUse)) !==
        authority.callerResult.grantUseDigest ||
      binding.output.sourceTree !== patchHead.record.sourceTree ||
      binding.output.patchDigest !== patchHead.record.patchDigest ||
      participant.principalId === null ||
      participant.identityAssurance === 'maintainer-signed' ||
      canonicalJson(patchHead.record.implementer) !==
        canonicalJson({
          providerId: null,
          principalId: participant.principalId,
          assurance: participant.identityAssurance,
          degradedForm: 'caller-supplied',
          grantId: reservation.grantId,
        })
    ) {
      throw correctionStateStale();
    }
    assertTaskStrategyCallerImplementationAuthorityCurrent(
      runtime,
      transaction,
      expectedSubject,
      reservation,
      binding,
    );
  } catch {
    throw correctionStateStale();
  }
}

function isTddTask(
  task: unknown,
): task is CrossAgentTddExecution | TddSingleAgentExecution {
  return (
    typeof task === 'object' &&
    task !== null &&
    'strategy' in task &&
    (task.strategy === 'cross-agent-tdd' ||
      task.strategy === 'tdd-single-agent')
  );
}

function correctionStateStale() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_STATE_STALE',
    'GREEN failure evidence does not match the exact current RED transaction, patch head, check set, or runner identity.',
    ExitCode.staleState,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
