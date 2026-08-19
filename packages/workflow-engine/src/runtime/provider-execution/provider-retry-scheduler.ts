import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertReadOnlyProbe,
  projectProviderInvocationExecution,
  type ExecutionFailureKind,
  type ReadOnlyProbeRequest,
  type RetryMode,
} from '../../modules/provider-orchestration/execution-core.ts';
import type { GrantRequest } from '../../modules/authority/execution-governance.ts';
import { inspectExecutionJob } from './execution-runtime.ts';
import { readExecutionJobState } from '../storage-journal/execution-store.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  privatePathExists,
  readInvestigationSession,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from '../storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import { retryInvestigationProvider } from '../../adapters/compatibility/investigation-v2/investigation-session.ts';
import {
  createPlanReviewRetryEnvelope,
  getProposeStatus,
  resumePropose,
} from '../../application/propose/propose-orchestrator.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  type ProviderInvocationFailure,
  type ProviderInvocationRecord,
} from '../storage-journal/provider-invocation-store.ts';
import {
  executeProviderReadOnlyProbe,
  type ProviderReadOnlyProbeExecutionResult,
} from './provider-probe-executor.ts';

const RETRY_SCHEDULE_FILE = /^[0-9a-f]{64}\.json$/;
const RETRY_RECEIPT_FILE = /^[0-9a-f]{64}\.json$/;
const PROBE_MAX_ATTEMPTS = 3;
const PROBE_MIN_BACKOFF_MS = 1_000;
const PROBE_MAX_BACKOFF_MS = 86_400_000;

export type ProviderRetryScheduleState =
  'scheduled' | 'dispatch-issued' | 'probe-succeeded' | 'probe-failed-terminal';

export type ProviderRetryScheduleNextAction =
  | 'wait-until-due'
  | 'dispatch-replacement'
  | 'none'
  | 'inspect-environment-before-new-provider-attempt';

export type ProviderAutomaticRetrySchedule = Readonly<{
  schemaVersion: 2;
  kind: 'provider-automatic-retry-schedule';
  scheduleId: string;
  state: ProviderRetryScheduleState;
  route: 'provider-replacement' | 'environment-probe';
  workflowId: string;
  epoch: number;
  contextDigest: string;
  executionJobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureDigest: string;
  failureCode: string;
  replacementAttemptId: string | null;
  replacementInvocationId: string | null;
  retryMode: RetryMode | 'probe-only';
  probe: Readonly<ReadOnlyProbeRequest> | null;
  probeAttemptsCompleted: number;
  probeMaxAttempts: number;
  probeBackoffMs: number;
  retryAfterMs: number;
  notBefore: string;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  nextAction: ProviderRetryScheduleNextAction;
  updatedAt: string;
}>;

export type ProviderRetryScheduleReceiptState =
  | 'started'
  | 'dispatch-issued'
  | 'probe-succeeded'
  | 'probe-retry-scheduled'
  | 'probe-failed-terminal';

export type ProviderRetryScheduleReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-schedule-receipt';
  receiptId: string;
  scheduleId: string;
  route: ProviderAutomaticRetrySchedule['route'];
  attemptNumber: number;
  state: ProviderRetryScheduleReceiptState;
  requestDigest: string;
  probe: Readonly<ReadOnlyProbeRequest> | null;
  outcomeCode: string | null;
  observationDigest: string | null;
  startedAt: string;
  completedAt: string | null;
  nextNotBefore: string | null;
}>;

export type ProviderRetrySchedulePumpResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-schedule-pump';
  inspected: number;
  due: number;
  processed: number;
  scheduleIds: readonly string[];
}>;

export type ProviderRetrySchedulePumpOptions = Readonly<{
  limit: number;
  now?: string;
  dispatcher?: (cwd: string, invocationId: string) => unknown;
  probeExecutor?: (
    cwd: string,
    request: Readonly<ReadOnlyProbeRequest>,
    schedule: ProviderAutomaticRetrySchedule,
  ) => ProviderReadOnlyProbeExecutionResult;
  faultInjector?: (
    point: 'after-dispatch' | 'after-probe-execution',
    schedule: ProviderAutomaticRetrySchedule,
  ) => void;
}>;

export type ProviderFailureRetryResult =
  | Readonly<{
      kind: 'replacement-scheduled' | 'replacement-dispatched';
      schedule: ProviderAutomaticRetrySchedule;
    }>
  | Readonly<{
      kind: 'probe-scheduled';
      schedule: ProviderAutomaticRetrySchedule;
    }>
  | Readonly<{
      kind: 'grant-required';
      jobId: string;
      grantRequest: GrantRequest;
    }>
  | Readonly<{
      kind: 'decision-denied' | 'not-retryable';
      jobId: string;
      reasonCode: string;
    }>;

export type ProcessProviderFailureRetryOptions = Readonly<{
  now?: string;
  dispatcher?: (cwd: string, invocationId: string) => unknown;
}>;

/**
 * Reconcile one durable failed invocation into its bounded next action. The
 * existing Survey/PlanReview lifecycle remains the publication authority for
 * replacement work; this service only adds a durable due-time/dispatch journal
 * around that exact transition.
 */
export function processProviderFailureRetry(
  cwd: string,
  requestedInvocationId: string,
  options: ProcessProviderFailureRetryOptions = {},
): ProviderFailureRetryResult {
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const existing = readProviderAutomaticRetrySchedule(
    cwd,
    requestedInvocationId,
  );
  if (existing !== null) {
    return continueSchedule(cwd, existing, now, options.dispatcher);
  }

  const context = loadInvestigationRuntimeContext(cwd);
  const failed = readProviderInvocation(context.runtime, requestedInvocationId);
  const failedRequest = readProviderInvocationRequest(
    context.runtime,
    failed.invocationId,
  );
  const projection = projectProviderInvocationExecution({
    record: failed,
    request: failedRequest,
  });
  if (
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable'
  ) {
    return deepFreeze({
      kind: 'not-retryable' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure?.code ?? 'PROVIDER_INVOCATION_NOT_RETRYABLE',
    });
  }
  // TaskDiffReview and task implementation are not owned by the
  // investigation/PlanReview retry state machine. Until their exact
  // WorkflowSession owner publishes a replacement, fail closed instead of
  // routing the invocation through `resumePropose`.
  if (
    failed.purpose === 'task-diff-review' ||
    failed.purpose === 'task-implementation'
  ) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode:
        failed.purpose === 'task-diff-review'
          ? 'TASK_DIFF_REVIEW_RETRY_OWNER_REQUIRED'
          : 'TASK_IMPLEMENTATION_RETRY_OWNER_REQUIRED',
    });
  }
  const strategyDecision = inspectExecutionJob(cwd, projection.job.jobId)
    .latestFailure?.decision;
  if (
    strategyDecision?.retryable === true &&
    strategyDecision.automatic === false &&
    strategyDecision.retryMode === 'strategy-change' &&
    strategyDecision.changedStrategyRequired === true
  ) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: strategyDecision.reasonCode,
    });
  }
  const executionKind = providerExecutionFailureKind(failed.failure);
  if (executionKind === null || executionKind === 'unknown-side-effect') {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure.code,
    });
  }
  if (executionKind === 'probe-transient') {
    return scheduleProbeRetry(cwd, failed, projection.job.jobId, now);
  }
  if (!PROVIDER_REPLACEMENT_FAILURE_KINDS.has(executionKind)) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure.code,
    });
  }

  let replacementInvocationId: string;
  try {
    replacementInvocationId = publishReplacement(cwd, failed);
  } catch (error) {
    if (!isExpectedRetryDecisionError(error)) throw error;
    return decisionWithoutReplacement(cwd, projection.job.jobId, error.code);
  }
  const schedule = createReplacementSchedule(
    cwd,
    failed,
    projection.job.jobId,
    replacementInvocationId,
    now,
  );
  return continueSchedule(cwd, schedule, now, options.dispatcher);
}

const PROVIDER_REPLACEMENT_FAILURE_KINDS = new Set<ExecutionFailureKind>([
  'provider-timeout',
  'network',
  'rate-limit',
  'provider-process-crash',
  'worker-crash',
  'lease-expiry',
  'temporary-file-lock',
  'provider-capacity',
  'stdout-truncated',
  'process-nonzero',
  'json-parse',
  'schema-mismatch',
  'missing-required-field',
  'citation-out-of-range',
]);

export function readProviderAutomaticRetrySchedule(
  cwd: string,
  requestedInvocationId: string,
): ProviderAutomaticRetrySchedule | null {
  const context = loadInvestigationRuntimeContext(cwd);
  const schedulePath = providerRetrySchedulePath(
    context.runtime,
    requestedInvocationId,
  );
  if (
    !privatePathExists(
      context.runtime,
      schedulePath,
      providerRetryScheduleUnsafe,
    )
  ) {
    return null;
  }
  const schedule = assertProviderAutomaticRetrySchedule(
    readPrivateCanonicalJson(
      context.runtime,
      schedulePath,
      providerRetryScheduleUnsafe,
    ),
  );
  if (schedule.failedInvocationId !== requestedInvocationId) {
    throw providerRetryScheduleUnsafe();
  }
  return schedule;
}

export function listProviderAutomaticRetrySchedules(
  cwd: string,
): ProviderAutomaticRetrySchedule[] {
  const context = loadInvestigationRuntimeContext(cwd);
  const root = providerRetryScheduleRoot(context.runtime);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  assertPrivateInvestigationDirectory(
    context.runtime,
    root,
    providerRetryScheduleUnsafe,
  );
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !RETRY_SCHEDULE_FILE.test(entry.name)
      ) {
        throw providerRetryScheduleUnsafe();
      }
      const schedule = assertProviderAutomaticRetrySchedule(
        readPrivateCanonicalJson(
          context.runtime,
          path.join(root, entry.name),
          providerRetryScheduleUnsafe,
        ),
      );
      if (`${sha256Text(schedule.failedInvocationId)}.json` !== entry.name) {
        throw providerRetryScheduleUnsafe();
      }
      return schedule;
    });
}

export function listProviderRetryScheduleReceipts(
  cwd: string,
  scheduleId?: string,
): ProviderRetryScheduleReceipt[] {
  if (scheduleId !== undefined && !isDigest(scheduleId)) {
    throw providerRetryScheduleUnsafe();
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const root = providerRetryReceiptRoot(context.runtime);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  assertPrivateInvestigationDirectory(
    context.runtime,
    root,
    providerRetryScheduleUnsafe,
  );
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !RETRY_RECEIPT_FILE.test(entry.name)
      ) {
        throw providerRetryScheduleUnsafe();
      }
      const receipt = assertProviderRetryScheduleReceipt(
        readPrivateCanonicalJson(
          context.runtime,
          path.join(root, entry.name),
          providerRetryScheduleUnsafe,
        ),
      );
      if (`${receipt.receiptId.slice('sha256:'.length)}.json` !== entry.name) {
        throw providerRetryScheduleUnsafe();
      }
      return receipt;
    })
    .filter((receipt) =>
      scheduleId === undefined ? true : receipt.scheduleId === scheduleId,
    )
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.attemptNumber - right.attemptNumber ||
        left.receiptId.localeCompare(right.receiptId),
    );
}

/** Process at most `limit` due retry schedules in one finite sweep. */
export function pumpProviderRetrySchedules(
  cwd: string,
  options: ProviderRetrySchedulePumpOptions,
): ProviderRetrySchedulePumpResult {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw workflowError(
      'PROVIDER_RETRY_PUMP_LIMIT_INVALID',
      'Provider retry pump limit must be an integer from 1 through 100.',
      ExitCode.usage,
    );
  }
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const schedules = listProviderAutomaticRetrySchedules(cwd);
  const due = schedules
    .filter(
      (schedule) =>
        schedule.state === 'scheduled' &&
        Date.parse(schedule.notBefore) <= Date.parse(now) &&
        (schedule.route === 'environment-probe' ||
          options.dispatcher !== undefined),
    )
    .sort(
      (left, right) =>
        left.notBefore.localeCompare(right.notBefore) ||
        left.scheduleId.localeCompare(right.scheduleId),
    );
  const processed: string[] = [];
  for (const schedule of due.slice(0, options.limit)) {
    const updated = processDueSchedule(cwd, schedule, now, options);
    if (
      updated.state !== 'scheduled' ||
      updated.updatedAt !== schedule.updatedAt
    ) {
      processed.push(updated.scheduleId);
    }
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-retry-schedule-pump' as const,
    inspected: schedules.length,
    due: due.length,
    processed: processed.length,
    scheduleIds: processed,
  });
}

function processDueSchedule(
  cwd: string,
  expected: ProviderAutomaticRetrySchedule,
  now: string,
  options: Pick<
    ProviderRetrySchedulePumpOptions,
    'dispatcher' | 'probeExecutor' | 'faultInjector'
  >,
): ProviderAutomaticRetrySchedule {
  const context = loadInvestigationRuntimeContext(cwd);
  return withPrivateRuntimeLock(
    context.runtime,
    providerRetryScheduleLockPath(context.runtime, expected.failedInvocationId),
    () => {
      const current = readProviderAutomaticRetryScheduleFromPaths(
        context.runtime,
        expected.failedInvocationId,
      );
      if (current.scheduleId !== expected.scheduleId) {
        throw providerRetryScheduleUnsafe();
      }
      if (
        current.state !== 'scheduled' ||
        Date.parse(current.notBefore) > Date.parse(now)
      ) {
        return current;
      }
      const receipt = startScheduleReceipt(context.runtime, current, now);
      if (receipt.state !== 'started') {
        return reconcileScheduleFromReceipt(context.runtime, current, receipt);
      }
      if (current.route === 'provider-replacement') {
        if (options.dispatcher === undefined) return current;
        const replacement = readProviderInvocation(
          context.runtime,
          current.replacementInvocationId!,
        );
        if (replacement.state === 'prepared') {
          options.dispatcher(cwd, replacement.invocationId);
        }
        options.faultInjector?.('after-dispatch', current);
        const completed = finishScheduleReceipt(context.runtime, receipt, {
          state: 'dispatch-issued',
          outcomeCode: 'PROVIDER_REPLACEMENT_DISPATCH_ISSUED',
          observationDigest: digestCanonical({
            invocationId: replacement.invocationId,
            observedState: replacement.state,
          }),
          completedAt: now,
          nextNotBefore: null,
        });
        return reconcileScheduleFromReceipt(
          context.runtime,
          current,
          completed,
        );
      }

      const probe = assertReadOnlyProbe(current.probe);
      let result: ProviderReadOnlyProbeExecutionResult;
      try {
        result = assertProviderReadOnlyProbeExecutionResult(
          (options.probeExecutor ?? executeProviderReadOnlyProbe)(
            cwd,
            probe,
            current,
          ),
        );
      } catch (error) {
        result = {
          state: 'failed',
          code:
            error instanceof WorkflowError
              ? error.code
              : 'PROVIDER_PROBE_EXECUTION_FAILED',
          observationDigest: digestCanonical({
            code:
              error instanceof WorkflowError
                ? error.code
                : 'PROVIDER_PROBE_EXECUTION_FAILED',
          }),
          elapsedMs: 0,
        };
      }
      if (result.elapsedMs > probe.timeoutMs) {
        result = {
          state: 'failed',
          code: 'PROVIDER_PROBE_TIMEOUT',
          observationDigest: digestCanonical({
            reportedObservationDigest: result.observationDigest,
            elapsedMs: result.elapsedMs,
            timeoutMs: probe.timeoutMs,
          }),
          elapsedMs: result.elapsedMs,
        };
      }
      options.faultInjector?.('after-probe-execution', current);
      const attemptNumber = receipt.attemptNumber;
      const terminal =
        result.state === 'succeeded' ||
        attemptNumber >= current.probeMaxAttempts;
      const nextNotBefore = terminal
        ? null
        : new Date(
            Date.parse(now) + probeBackoffForAttempt(current, attemptNumber),
          ).toISOString();
      const completed = finishScheduleReceipt(context.runtime, receipt, {
        state:
          result.state === 'succeeded'
            ? 'probe-succeeded'
            : terminal
              ? 'probe-failed-terminal'
              : 'probe-retry-scheduled',
        outcomeCode: result.code,
        observationDigest: result.observationDigest,
        completedAt: now,
        nextNotBefore,
      });
      return reconcileScheduleFromReceipt(context.runtime, current, completed);
    },
    'PROVIDER_RETRY_SCHEDULE_OPERATION_CONFLICT',
    providerRetryScheduleUnsafe,
  );
}

function startScheduleReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  schedule: ProviderAutomaticRetrySchedule,
  now: string,
): ProviderRetryScheduleReceipt {
  const attemptNumber =
    schedule.route === 'provider-replacement'
      ? 1
      : schedule.probeAttemptsCompleted + 1;
  if (
    attemptNumber < 1 ||
    (schedule.route === 'environment-probe' &&
      attemptNumber > schedule.probeMaxAttempts)
  ) {
    throw providerRetryScheduleUnsafe();
  }
  const identity = {
    kind: 'provider-retry-schedule-receipt',
    scheduleId: schedule.scheduleId,
    route: schedule.route,
    attemptNumber,
  };
  const receiptId = digestCanonical(identity);
  const requestDigest = scheduleReceiptRequestDigest(schedule);
  const receiptPath = providerRetryReceiptPath(paths, receiptId);
  if (privatePathExists(paths, receiptPath, providerRetryScheduleUnsafe)) {
    const existing = assertProviderRetryScheduleReceipt(
      readPrivateCanonicalJson(paths, receiptPath, providerRetryScheduleUnsafe),
    );
    if (
      existing.receiptId !== receiptId ||
      existing.scheduleId !== schedule.scheduleId ||
      existing.route !== schedule.route ||
      existing.attemptNumber !== attemptNumber ||
      existing.requestDigest !== requestDigest ||
      canonicalJson(existing.probe) !== canonicalJson(schedule.probe)
    ) {
      throw providerRetryScheduleUnsafe();
    }
    return existing;
  }
  const receipt = assertProviderRetryScheduleReceipt({
    schemaVersion: 1,
    kind: 'provider-retry-schedule-receipt',
    receiptId,
    scheduleId: schedule.scheduleId,
    route: schedule.route,
    attemptNumber,
    state: 'started',
    requestDigest,
    probe: schedule.probe,
    outcomeCode: null,
    observationDigest: null,
    startedAt: now,
    completedAt: null,
    nextNotBefore: null,
  });
  const root = providerRetryReceiptRoot(paths);
  ensurePrivateInvestigationDirectory(paths, root, providerRetryScheduleUnsafe);
  createPrivateCanonicalJson(
    paths,
    receiptPath,
    receipt,
    providerRetryScheduleUnsafe,
    'PROVIDER_RETRY_SCHEDULE_RECEIPT_CONFLICT',
  );
  return assertProviderRetryScheduleReceipt(
    readPrivateCanonicalJson(paths, receiptPath, providerRetryScheduleUnsafe),
  );
}

function finishScheduleReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  started: ProviderRetryScheduleReceipt,
  completion: Pick<
    ProviderRetryScheduleReceipt,
    | 'state'
    | 'outcomeCode'
    | 'observationDigest'
    | 'completedAt'
    | 'nextNotBefore'
  >,
): ProviderRetryScheduleReceipt {
  if (started.state !== 'started') return started;
  const updated = assertProviderRetryScheduleReceipt({
    ...started,
    ...completion,
  });
  writePrivateCanonicalJsonAtomic(
    paths,
    providerRetryReceiptPath(paths, started.receiptId),
    updated,
    providerRetryScheduleUnsafe,
  );
  return assertProviderRetryScheduleReceipt(
    readPrivateCanonicalJson(
      paths,
      providerRetryReceiptPath(paths, started.receiptId),
      providerRetryScheduleUnsafe,
    ),
  );
}

function reconcileScheduleFromReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  schedule: ProviderAutomaticRetrySchedule,
  receipt: ProviderRetryScheduleReceipt,
): ProviderAutomaticRetrySchedule {
  if (
    receipt.state === 'started' ||
    receipt.scheduleId !== schedule.scheduleId ||
    receipt.route !== schedule.route ||
    receipt.completedAt === null
  ) {
    throw providerRetryScheduleUnsafe();
  }
  const expectedAttemptNumber =
    schedule.route === 'provider-replacement'
      ? 1
      : schedule.probeAttemptsCompleted + 1;
  if (
    receipt.attemptNumber !== expectedAttemptNumber ||
    receipt.requestDigest !== scheduleReceiptRequestDigest(schedule) ||
    canonicalJson(receipt.probe) !== canonicalJson(schedule.probe)
  ) {
    throw providerRetryScheduleUnsafe();
  }
  let updated: ProviderAutomaticRetrySchedule;
  if (receipt.state === 'dispatch-issued') {
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'dispatch-issued',
      dispatchedAt: receipt.completedAt,
      completedAt: receipt.completedAt,
      nextAction: 'none',
      updatedAt: receipt.completedAt,
    });
  } else if (receipt.state === 'probe-retry-scheduled') {
    if (receipt.nextNotBefore === null) throw providerRetryScheduleUnsafe();
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'scheduled',
      probeAttemptsCompleted: receipt.attemptNumber,
      notBefore: receipt.nextNotBefore,
      completedAt: null,
      nextAction: 'wait-until-due',
      updatedAt: receipt.completedAt,
    });
  } else if (receipt.state === 'probe-succeeded') {
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'probe-succeeded',
      probeAttemptsCompleted: receipt.attemptNumber,
      completedAt: receipt.completedAt,
      nextAction: 'none',
      updatedAt: receipt.completedAt,
    });
  } else {
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'probe-failed-terminal',
      probeAttemptsCompleted: receipt.attemptNumber,
      completedAt: receipt.completedAt,
      nextAction: 'inspect-environment-before-new-provider-attempt',
      updatedAt: receipt.completedAt,
    });
  }
  writePrivateCanonicalJsonAtomic(
    paths,
    providerRetrySchedulePath(paths, schedule.failedInvocationId),
    updated,
    providerRetryScheduleUnsafe,
  );
  return readProviderAutomaticRetryScheduleFromPaths(
    paths,
    schedule.failedInvocationId,
  );
}

function scheduleReceiptRequestDigest(
  schedule: ProviderAutomaticRetrySchedule,
): string {
  return schedule.route === 'environment-probe'
    ? digestCanonical(assertReadOnlyProbe(schedule.probe))
    : digestCanonical({
        replacementAttemptId: schedule.replacementAttemptId,
        replacementInvocationId: schedule.replacementInvocationId,
      });
}

function probeBackoffForAttempt(
  schedule: ProviderAutomaticRetrySchedule,
  attemptNumber: number,
): number {
  return Math.min(
    PROBE_MAX_BACKOFF_MS,
    schedule.probeBackoffMs * 2 ** Math.max(0, attemptNumber - 1),
  );
}

function assertProviderReadOnlyProbeExecutionResult(
  value: unknown,
): ProviderReadOnlyProbeExecutionResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['state', 'code', 'observationDigest', 'elapsedMs']) ||
    (value.state !== 'succeeded' && value.state !== 'failed') ||
    typeof value.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) ||
    !isDigest(value.observationDigest) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    (value.elapsedMs as number) < 0 ||
    (value.elapsedMs as number) > 86_400_000
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderReadOnlyProbeExecutionResult,
  );
}

function scheduleProbeRetry(
  cwd: string,
  failed: ProviderInvocationRecord,
  jobId: string,
  now: string,
): ProviderFailureRetryResult {
  const probe = failed.failure?.probe;
  if (probe === undefined) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId,
      reasonCode: 'ENVIRONMENT_PROBE_REQUEST_MISSING',
    });
  }
  const decision = inspectExecutionJob(cwd, jobId).latestFailure?.decision;
  if (decision?.requiredGrant !== undefined) {
    return deepFreeze({
      kind: 'grant-required' as const,
      jobId,
      grantRequest: decision.requiredGrant,
    });
  }
  if (decision?.automatic !== true || decision.retryable !== true) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId,
      reasonCode: decision?.reasonCode ?? failed.failure!.code,
    });
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const state = readExecutionJobState(context.runtime, jobId);
  const failedAttempt = state?.attempts.find(
    ({ legacyInvocation }) =>
      legacyInvocation?.invocationId === failed.invocationId,
  );
  if (state === null || state === undefined || failedAttempt === undefined) {
    throw providerRetryScheduleUnsafe();
  }
  const retryAfterMs =
    failed.failure!.retryAfterMs ?? decision.retryAfterMs ?? 0;
  const schedule = persistSchedule(context.runtime, {
    failed,
    state,
    failedAttemptId: failedAttempt.attemptId,
    replacementAttemptId: null,
    replacementInvocationId: null,
    route: 'environment-probe',
    retryMode: 'probe-only',
    probe,
    retryAfterMs,
    createdAt: now,
  });
  return deepFreeze({ kind: 'probe-scheduled' as const, schedule });
}

function publishReplacement(
  cwd: string,
  failed: ProviderInvocationRecord,
): string {
  if (failed.purpose === 'survey') {
    return publishSurveyReplacement(cwd, failed);
  }
  const output = getProposeStatus(cwd, failed.investigationId);
  const retried = resumePropose(
    cwd,
    failed.changeId,
    createPlanReviewRetryEnvelope(cwd, output, {
      acknowledgeProviderCost: true,
    }),
  );
  const invocationId = retried.planReview?.invocationId;
  if (invocationId === undefined || invocationId === failed.invocationId) {
    throw providerRetryScheduleUnsafe();
  }
  return invocationId;
}

function publishSurveyReplacement(
  cwd: string,
  failed: ProviderInvocationRecord,
): string {
  const context = loadInvestigationRuntimeContext(cwd);
  const existing = readProviderRetryReservation(
    context.runtime,
    failed.investigationId,
    failed.attempt + 1,
  );
  if (existing !== null) {
    if (existing.previousInvocationId !== failed.invocationId) {
      throw providerRetryScheduleUnsafe();
    }
    return existing.invocationId;
  }
  const failedRequest = readProviderInvocationRequest(
    context.runtime,
    failed.invocationId,
  );
  const session = readInvestigationSession(
    context.runtime,
    failed.investigationId,
  );
  const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
  const identity = crypto.randomUUID();
  const replacementRequest = replacementProviderRequest(
    failedRequest,
    policy.digest,
    policy.policy.limits,
    identity,
  );
  const retried = retryInvestigationProvider(cwd, failed.investigationId, {
    expectedRevision: session.revision,
    replacementRequest,
  });
  if (
    retried.providerInvocationId !== replacementRequest.invocationId ||
    retried.provider.attempt !== failed.attempt + 1
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return retried.providerInvocationId;
}

function replacementProviderRequest(
  failed: ProviderInvocationRequest,
  policyDigest: string,
  limits: { timeoutMs: number; aggregateOutputBytes: number },
  identity: string,
): ProviderInvocationRequest {
  return createProviderInvocationRequest({
    invocationId: `invocation-auto-retry-${identity}`,
    nonce: `provider-auto-retry-${identity}`,
    purpose: failed.purpose,
    providerId: failed.providerId,
    roleAssignment: failed.roleAssignment,
    capabilityProfile: failed.capabilityProfile,
    repositoryId: failed.repositoryId,
    baseCommit: failed.baseCommit,
    baseTree: failed.baseTree,
    targetDigest: failed.targetDigest,
    inputManifestDigest: failed.inputManifestDigest,
    authorizationNodeId: failed.authorizationNodeId,
    writeAllowedPaths: [...failed.writeAllowedPaths],
    outputSchema: failed.outputSchema,
    evaluatorVersion: failed.evaluatorVersion,
    policyDigest,
    limits: {
      timeoutMs: limits.timeoutMs,
      aggregateOutputBytes: limits.aggregateOutputBytes,
    },
  });
}

function createReplacementSchedule(
  cwd: string,
  failed: ProviderInvocationRecord,
  jobId: string,
  replacementInvocationId: string,
  now: string,
): ProviderAutomaticRetrySchedule {
  const context = loadInvestigationRuntimeContext(cwd);
  const replacement = readProviderInvocation(
    context.runtime,
    replacementInvocationId,
  );
  const state = readExecutionJobState(context.runtime, jobId);
  const failedAttempt = state?.attempts.find(
    ({ legacyInvocation }) =>
      legacyInvocation?.invocationId === failed.invocationId,
  );
  const replacementAttempt = state?.attempts.find(
    ({ legacyInvocation }) =>
      legacyInvocation?.invocationId === replacement.invocationId,
  );
  if (
    state === null ||
    state === undefined ||
    failedAttempt === undefined ||
    replacementAttempt === undefined ||
    replacement.investigationId !== failed.investigationId ||
    replacement.changeId !== failed.changeId ||
    replacement.purpose !== failed.purpose ||
    replacement.attempt !== failed.attempt + 1 ||
    replacementAttempt.retryOf !== failedAttempt.attemptId ||
    replacementAttempt.jobId !== failedAttempt.jobId ||
    replacementAttempt.workflowId !== failedAttempt.workflowId ||
    replacementAttempt.epoch !== failedAttempt.epoch ||
    replacementAttempt.contextDigest !== failedAttempt.contextDigest
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return persistSchedule(context.runtime, {
    failed,
    state,
    failedAttemptId: failedAttempt.attemptId,
    replacementAttemptId: replacementAttempt.attemptId,
    replacementInvocationId: replacement.invocationId,
    route: 'provider-replacement',
    retryMode: replacementAttempt.retryMode,
    probe: null,
    retryAfterMs: failed.failure!.retryAfterMs ?? 0,
    createdAt: now,
  });
}

function persistSchedule(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  input: {
    failed: ProviderInvocationRecord;
    state: NonNullable<ReturnType<typeof readExecutionJobState>>;
    failedAttemptId: string;
    replacementAttemptId: string | null;
    replacementInvocationId: string | null;
    route: ProviderAutomaticRetrySchedule['route'];
    retryMode: ProviderAutomaticRetrySchedule['retryMode'];
    probe: Readonly<ReadOnlyProbeRequest> | null;
    retryAfterMs: number;
    createdAt: string;
  },
): ProviderAutomaticRetrySchedule {
  const failureDigest = digestCanonical(input.failed.failure);
  const notBefore = new Date(
    Date.parse(input.failed.updatedAt) + input.retryAfterMs,
  ).toISOString();
  const identity = {
    kind: 'provider-automatic-retry-schedule',
    failedInvocationId: input.failed.invocationId,
    failedInvocationRevision: input.failed.revision,
    failureDigest,
    route: input.route,
    replacementInvocationId: input.replacementInvocationId,
    probe: input.probe,
    notBefore,
  };
  const probeBackoffMs =
    input.route === 'environment-probe'
      ? Math.min(
          PROBE_MAX_BACKOFF_MS,
          Math.max(PROBE_MIN_BACKOFF_MS, input.retryAfterMs),
        )
      : 0;
  const schedule = assertProviderAutomaticRetrySchedule({
    schemaVersion: 2,
    kind: 'provider-automatic-retry-schedule',
    scheduleId: digestCanonical(identity),
    state: 'scheduled',
    route: input.route,
    workflowId: input.state.workflow.workflowId,
    epoch: input.state.job.epoch,
    contextDigest: input.state.job.contextDigest,
    executionJobId: input.state.job.jobId,
    failedAttemptId: input.failedAttemptId,
    failedInvocationId: input.failed.invocationId,
    failedInvocationRevision: input.failed.revision,
    failureDigest,
    failureCode: input.failed.failure!.code,
    replacementAttemptId: input.replacementAttemptId,
    replacementInvocationId: input.replacementInvocationId,
    retryMode: input.retryMode,
    probe: input.probe,
    probeAttemptsCompleted: 0,
    probeMaxAttempts:
      input.route === 'environment-probe' ? PROBE_MAX_ATTEMPTS : 0,
    probeBackoffMs,
    retryAfterMs: input.retryAfterMs,
    notBefore,
    createdAt: input.createdAt,
    dispatchedAt: null,
    completedAt: null,
    nextAction:
      Date.parse(notBefore) > Date.parse(input.createdAt)
        ? 'wait-until-due'
        : input.route === 'provider-replacement'
          ? 'dispatch-replacement'
          : 'wait-until-due',
    updatedAt: input.createdAt,
  });
  const root = providerRetryScheduleRoot(paths);
  ensurePrivateInvestigationDirectory(paths, root, providerRetryScheduleUnsafe);
  createPrivateCanonicalJson(
    paths,
    providerRetrySchedulePath(paths, input.failed.invocationId),
    schedule,
    providerRetryScheduleUnsafe,
    'PROVIDER_RETRY_SCHEDULE_CONFLICT',
  );
  const durable = readProviderAutomaticRetryScheduleFromPaths(
    paths,
    input.failed.invocationId,
  );
  if (canonicalJson(durable) !== canonicalJson(schedule)) {
    throw providerRetryScheduleUnsafe();
  }
  return durable;
}

function continueSchedule(
  cwd: string,
  schedule: ProviderAutomaticRetrySchedule,
  now: string,
  dispatcher: ProcessProviderFailureRetryOptions['dispatcher'],
): ProviderFailureRetryResult {
  if (schedule.route === 'environment-probe') {
    return deepFreeze({ kind: 'probe-scheduled' as const, schedule });
  }
  if (schedule.state === 'dispatch-issued') {
    return deepFreeze({
      kind: 'replacement-dispatched' as const,
      schedule,
    });
  }
  if (Date.parse(now) < Date.parse(schedule.notBefore) || !dispatcher) {
    return deepFreeze({
      kind: 'replacement-scheduled' as const,
      schedule,
    });
  }
  const updated = processDueSchedule(cwd, schedule, now, { dispatcher });
  return deepFreeze({
    kind: 'replacement-dispatched' as const,
    schedule: updated,
  });
}

function decisionWithoutReplacement(
  cwd: string,
  jobId: string,
  fallbackReasonCode: string,
): ProviderFailureRetryResult {
  const decision = inspectExecutionJob(cwd, jobId).latestFailure?.decision;
  if (decision?.requiredGrant !== undefined) {
    return deepFreeze({
      kind: 'grant-required' as const,
      jobId,
      grantRequest: decision.requiredGrant,
    });
  }
  return deepFreeze({
    kind: 'decision-denied' as const,
    jobId,
    reasonCode: decision?.reasonCode ?? fallbackReasonCode,
  });
}

function providerExecutionFailureKind(
  failure: ProviderInvocationFailure,
): ExecutionFailureKind | null {
  if (failure.executionKind !== undefined) return failure.executionKind;
  const code = failure.code;
  if (code === 'PROVIDER_TIMEOUT') return 'provider-timeout';
  if (code === 'NETWORK_TRANSIENT') return 'network';
  if (code === 'PROVIDER_RATE_LIMIT') return 'rate-limit';
  if (code === 'PROVIDER_PROCESS_CRASH') return 'provider-process-crash';
  if (code === 'PROVIDER_INVOCATION_LEASE_EXPIRED') return 'lease-expiry';
  if (code === 'PROVIDER_NATIVE_OUTPUT_INVALID') return 'schema-mismatch';
  if (code === 'ENVIRONMENT_PROBE_TRANSIENT' && failure.probe !== undefined) {
    return 'probe-transient';
  }
  return null;
}

function isExpectedRetryDecisionError(error: unknown): error is WorkflowError {
  return (
    error instanceof WorkflowError &&
    new Set([
      'PROVIDER_RETRY_DECISION_DENIED',
      'PROVIDER_RETRY_GRANT_REQUIRED',
      'PROVIDER_RETRY_STRATEGY_CHANGE_REQUIRED',
      'PLAN_REVIEW_RETRY_DECISION_DENIED',
      'PLAN_REVIEW_RETRY_GRANT_REQUIRED',
      'PLAN_REVIEW_RETRY_STRATEGY_CHANGE_REQUIRED',
    ]).has(error.code)
  );
}

function providerRetryScheduleRoot(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
): string {
  return path.join(paths.root, 'provider-retry-schedules');
}

function providerRetryReceiptRoot(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
): string {
  return path.join(paths.root, 'provider-retry-schedule-receipts');
}

function providerRetryReceiptPath(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  receiptId: string,
): string {
  if (!isDigest(receiptId)) throw providerRetryScheduleUnsafe();
  return path.join(
    providerRetryReceiptRoot(paths),
    `${receiptId.slice('sha256:'.length)}.json`,
  );
}

function providerRetryScheduleLockPath(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  failedInvocationId: string,
): string {
  return path.join(paths.locks, `${sha256Text(failedInvocationId)}.retry.lock`);
}

function providerRetrySchedulePath(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  invocationId: string,
): string {
  return path.join(
    providerRetryScheduleRoot(paths),
    `${sha256Text(invocationId)}.json`,
  );
}

function readProviderAutomaticRetryScheduleFromPaths(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  invocationId: string,
): ProviderAutomaticRetrySchedule {
  const schedule = assertProviderAutomaticRetrySchedule(
    readPrivateCanonicalJson(
      paths,
      providerRetrySchedulePath(paths, invocationId),
      providerRetryScheduleUnsafe,
    ),
  );
  if (schedule.failedInvocationId !== invocationId) {
    throw providerRetryScheduleUnsafe();
  }
  return schedule;
}

function assertProviderRetryScheduleReceipt(
  value: unknown,
): ProviderRetryScheduleReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'receiptId',
      'scheduleId',
      'route',
      'attemptNumber',
      'state',
      'requestDigest',
      'probe',
      'outcomeCode',
      'observationDigest',
      'startedAt',
      'completedAt',
      'nextNotBefore',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-schedule-receipt' ||
    !isDigest(value.receiptId) ||
    !isDigest(value.scheduleId) ||
    (value.route !== 'provider-replacement' &&
      value.route !== 'environment-probe') ||
    !Number.isSafeInteger(value.attemptNumber) ||
    (value.attemptNumber as number) < 1 ||
    value.receiptId !==
      digestCanonical({
        kind: 'provider-retry-schedule-receipt',
        scheduleId: value.scheduleId,
        route: value.route,
        attemptNumber: value.attemptNumber,
      }) ||
    ![
      'started',
      'dispatch-issued',
      'probe-succeeded',
      'probe-retry-scheduled',
      'probe-failed-terminal',
    ].includes(String(value.state)) ||
    !isDigest(value.requestDigest) ||
    (value.probe !== null && !isReadOnlyProbe(value.probe)) ||
    !nullableErrorCode(value.outcomeCode) ||
    !nullableDigest(value.observationDigest) ||
    !isTimestamp(value.startedAt) ||
    !nullableTimestamp(value.completedAt) ||
    !nullableTimestamp(value.nextNotBefore) ||
    (value.route === 'provider-replacement' &&
      (value.probe !== null ||
        (value.state !== 'started' && value.state !== 'dispatch-issued'))) ||
    (value.route === 'environment-probe' &&
      (value.probe === null || value.state === 'dispatch-issued')) ||
    (value.state === 'started' &&
      (value.outcomeCode !== null ||
        value.observationDigest !== null ||
        value.completedAt !== null ||
        value.nextNotBefore !== null)) ||
    (value.state !== 'started' &&
      (value.outcomeCode === null ||
        value.observationDigest === null ||
        value.completedAt === null)) ||
    (value.state === 'probe-retry-scheduled' && value.nextNotBefore === null) ||
    (value.state !== 'probe-retry-scheduled' && value.nextNotBefore !== null) ||
    (value.completedAt !== null &&
      Date.parse(value.completedAt as string) <
        Date.parse(value.startedAt as string)) ||
    (value.nextNotBefore !== null &&
      value.completedAt !== null &&
      Date.parse(value.nextNotBefore as string) <=
        Date.parse(value.completedAt as string))
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderRetryScheduleReceipt,
  );
}

function assertProviderAutomaticRetrySchedule(
  value: unknown,
): ProviderAutomaticRetrySchedule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scheduleId',
      'state',
      'route',
      'workflowId',
      'epoch',
      'contextDigest',
      'executionJobId',
      'failedAttemptId',
      'failedInvocationId',
      'failedInvocationRevision',
      'failureDigest',
      'failureCode',
      'replacementAttemptId',
      'replacementInvocationId',
      'retryMode',
      'probe',
      'probeAttemptsCompleted',
      'probeMaxAttempts',
      'probeBackoffMs',
      'retryAfterMs',
      'notBefore',
      'createdAt',
      'dispatchedAt',
      'completedAt',
      'nextAction',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-automatic-retry-schedule' ||
    !isDigest(value.scheduleId) ||
    ![
      'scheduled',
      'dispatch-issued',
      'probe-succeeded',
      'probe-failed-terminal',
    ].includes(String(value.state)) ||
    (value.route !== 'provider-replacement' &&
      value.route !== 'environment-probe') ||
    typeof value.workflowId !== 'string' ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !isDigest(value.contextDigest) ||
    typeof value.executionJobId !== 'string' ||
    typeof value.failedAttemptId !== 'string' ||
    typeof value.failedInvocationId !== 'string' ||
    !Number.isSafeInteger(value.failedInvocationRevision) ||
    (value.failedInvocationRevision as number) < 1 ||
    !isDigest(value.failureDigest) ||
    typeof value.failureCode !== 'string' ||
    !nullableString(value.replacementAttemptId) ||
    !nullableString(value.replacementInvocationId) ||
    ![
      'same-input',
      'execution-policy-change',
      'repair',
      'strategy-change',
      'new-context',
      'none',
      'probe-only',
    ].includes(String(value.retryMode)) ||
    (value.probe !== null && !isReadOnlyProbe(value.probe)) ||
    !Number.isSafeInteger(value.probeAttemptsCompleted) ||
    (value.probeAttemptsCompleted as number) < 0 ||
    !Number.isSafeInteger(value.probeMaxAttempts) ||
    (value.probeMaxAttempts as number) < 0 ||
    (value.probeMaxAttempts as number) > 10 ||
    !Number.isSafeInteger(value.probeBackoffMs) ||
    (value.probeBackoffMs as number) < 0 ||
    (value.probeBackoffMs as number) > PROBE_MAX_BACKOFF_MS ||
    !Number.isSafeInteger(value.retryAfterMs) ||
    (value.retryAfterMs as number) < 0 ||
    (value.retryAfterMs as number) > 86_400_000 ||
    !isTimestamp(value.notBefore) ||
    !isTimestamp(value.createdAt) ||
    !nullableTimestamp(value.dispatchedAt) ||
    !nullableTimestamp(value.completedAt) ||
    ![
      'wait-until-due',
      'dispatch-replacement',
      'none',
      'inspect-environment-before-new-provider-attempt',
    ].includes(String(value.nextAction)) ||
    !isTimestamp(value.updatedAt) ||
    (value.route === 'provider-replacement' &&
      (value.replacementAttemptId === null ||
        value.replacementInvocationId === null ||
        value.retryMode === 'probe-only' ||
        value.probe !== null ||
        value.probeAttemptsCompleted !== 0 ||
        value.probeMaxAttempts !== 0 ||
        value.probeBackoffMs !== 0 ||
        (value.state !== 'scheduled' && value.state !== 'dispatch-issued'))) ||
    (value.route === 'environment-probe' &&
      (value.replacementAttemptId !== null ||
        value.replacementInvocationId !== null ||
        value.retryMode !== 'probe-only' ||
        value.probe === null ||
        value.probeMaxAttempts !== PROBE_MAX_ATTEMPTS ||
        (value.probeBackoffMs as number) < PROBE_MIN_BACKOFF_MS ||
        (value.probeAttemptsCompleted as number) >
          (value.probeMaxAttempts as number) ||
        value.state === 'dispatch-issued')) ||
    (value.state === 'scheduled' &&
      (value.dispatchedAt !== null ||
        value.completedAt !== null ||
        (value.nextAction !== 'wait-until-due' &&
          value.nextAction !== 'dispatch-replacement') ||
        (value.route === 'environment-probe' &&
          value.nextAction !== 'wait-until-due') ||
        (value.route === 'environment-probe' &&
          value.probeAttemptsCompleted === value.probeMaxAttempts))) ||
    (value.state === 'dispatch-issued' &&
      (value.dispatchedAt === null ||
        value.completedAt === null ||
        value.nextAction !== 'none')) ||
    (value.state === 'probe-succeeded' &&
      (value.route !== 'environment-probe' ||
        value.dispatchedAt !== null ||
        value.completedAt === null ||
        (value.probeAttemptsCompleted as number) < 1 ||
        value.nextAction !== 'none')) ||
    (value.state === 'probe-failed-terminal' &&
      (value.route !== 'environment-probe' ||
        value.dispatchedAt !== null ||
        value.completedAt === null ||
        value.probeAttemptsCompleted !== value.probeMaxAttempts ||
        value.nextAction !==
          'inspect-environment-before-new-provider-attempt')) ||
    Date.parse(value.updatedAt as string) <
      Date.parse(value.createdAt as string) ||
    (value.completedAt !== null &&
      Date.parse(value.completedAt as string) <
        Date.parse(value.createdAt as string))
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderAutomaticRetrySchedule,
  );
}

function exactTimestamp(value: string): string {
  if (!isTimestamp(value)) throw providerRetryScheduleUnsafe();
  return value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function nullableErrorCode(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isReadOnlyProbe(value: unknown): value is ReadOnlyProbeRequest {
  try {
    assertReadOnlyProbe(value);
    return true;
  } catch {
    return false;
  }
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort())
  );
}

function providerRetryScheduleUnsafe(cause?: unknown): WorkflowError {
  return workflowError(
    'PROVIDER_RETRY_SCHEDULE_UNSAFE',
    'The durable provider retry schedule is malformed, stale, or ambiguous.',
    ExitCode.staleState,
    cause === undefined ? {} : { details: { cause: String(cause) } },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
