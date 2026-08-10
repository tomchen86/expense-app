import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AiAdapterRetryAccounting } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  acceptAttemptResult,
  assertAttemptRecord,
  assertAttemptResult,
  assertJobRecord,
  assertWorkflowRecord,
  createReplacementAttempt,
  createAttemptResult,
  decideRetry,
  executionPolicyChangedFields,
  projectExecutionFailureState,
  projectProviderInvocationExecution,
  requireExecutionJobMandateBinding,
  type AttemptRecord,
  type AttemptResult,
  type JobRecord,
  type ProviderInvocationProjection,
  type RetryDecision,
  type RetryPolicy,
  type WorkflowRecord,
} from './execution-core.ts';
import { createExecutionBudgetGrantRequest } from './execution-governance.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import type { InvestigationRuntimePaths } from './paths.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import type {
  ProviderInvocationRecord,
  ProviderRetryAccountingSnapshot,
} from './provider-invocation-store.ts';
import {
  readProviderRepairLineage,
  type ProviderRepairLineage,
} from './provider-execution-governance.ts';

const EXECUTION_JOB_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LEGACY_DIGEST = /^[0-9a-f]{64}$/;
const MAX_LEGACY_ATTEMPTS = 1_000;
const EXECUTION_STATE_FILE = /^[0-9a-f]{64}\.json$/;

export type LegacyProviderExecutionEntry = Readonly<{
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  retryAccounting?: ProviderRetryAccountingSnapshot | null;
}>;

export function providerRetryPolicyFromAccounting(
  accounting: AiAdapterRetryAccounting,
  createdAt: string,
): RetryPolicy {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw executionProjectionConflict(
      'Provider retry accounting has an invalid Job creation timestamp.',
    );
  }
  return deepFreeze({
    maxAttempts: accounting.maxAttempts,
    maxCumulativeRuntimeMs: accounting.maxCumulativeRuntimeMs,
    maxProviderCostMicros: accounting.maxProviderCostMicros,
    maxProviderTokens: accounting.maxProviderTokens,
    maxSameFailureFingerprint: accounting.maxSameFailureFingerprint,
    maxRepairAttempts: accounting.maxRepairAttempts,
    deadline: new Date(createdAtMs + accounting.deadlineMs).toISOString(),
    providerLimits: Object.fromEntries(
      Object.entries(accounting.providerLimits).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

export function decideLegacyExecutionFailure(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  attempts: readonly AttemptRecord[];
}): RetryDecision {
  const failure = input.attempt.failure;
  if (failure === null) {
    throw executionProjectionConflict(
      'A durable retry decision requires a failed Attempt.',
    );
  }
  const sameFingerprintCount = input.attempts.filter(
    ({ failureFingerprint }) =>
      failureFingerprint !== null && failureFingerprint === failure.fingerprint,
  ).length;
  const decision = decideRetry({
    workflow: input.workflow,
    job: input.job,
    attempt: input.attempt,
    failure,
    sameFingerprintCount,
    currentExecutionPolicy: input.attempt.policySnapshot,
    now: input.attempt.updatedAt,
  });
  if (
    ![
      'REPEATED_FAILURE',
      // A changed strategy has no automatic executor, so the boundary is
      // offered the same bounded-grant exit as an exhausted ladder.
      'REPEATED_FAILURE_STRATEGY_CHANGE',
      'RETRY_BUDGET_EXHAUSTED',
    ].includes(decision.reasonCode) ||
    input.job.mandateBinding === undefined
  ) {
    return decision;
  }
  const requestedChanges = [
    {
      path: '/retryPolicy/maxAttempts',
      from: input.job.retryPolicy.maxAttempts,
      to: input.job.retryPolicy.maxAttempts + 1,
    },
    ...(sameFingerprintCount > input.job.retryPolicy.maxSameFailureFingerprint
      ? [
          {
            path: '/retryPolicy/maxSameFailureFingerprint',
            from: input.job.retryPolicy.maxSameFailureFingerprint,
            to: input.job.retryPolicy.maxSameFailureFingerprint + 1,
          },
        ]
      : []),
  ];
  const requiredGrant = createExecutionBudgetGrantRequest({
    requestId: deterministicUuid({
      kind: 'legacy-execution-budget-request',
      jobId: input.job.jobId,
      attemptId: input.attempt.attemptId,
      failureFingerprint: failure.fingerprint,
    }),
    workflowId: input.job.workflowId,
    epoch: input.job.epoch,
    jobId: input.job.jobId,
    mandateBinding: requireExecutionJobMandateBinding(input.job),
    requestedChanges,
    rationale:
      'Automatic retry budget is exhausted; authorize one bounded replacement Attempt with the same semantic context.',
    expiresAfterAttempts: 1,
    createdAt: new Date(input.attempt.updatedAt),
  });
  return decideRetry({
    workflow: input.workflow,
    job: input.job,
    attempt: input.attempt,
    failure,
    sameFingerprintCount,
    boundedGrantRequest: requiredGrant,
    currentExecutionPolicy: input.attempt.policySnapshot,
    now: input.attempt.updatedAt,
  });
}

export type DurableExecutionJobState = Readonly<{
  schemaVersion: 1;
  revision: number;
  workflow: WorkflowRecord;
  job: JobRecord;
  attempts: AttemptRecord[];
  results: AttemptResult[];
  reconciliationReceipts: ExecutionReconciliationReceipt[];
  legacyProjection: {
    kind: 'provider-invocation-v1';
    completeHistory: boolean;
    invocations: Array<{
      invocationId: string;
      legacyRevision: number;
      attemptId: string;
    }>;
  };
}>;

export type ExecutionReconciliationReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'legacy-provider-execution-reconciliation';
  receiptId: string;
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedLegacyRevision: number;
  resultingExecutionRevision: number;
  beforeStateDigest: string;
  afterProjectionDigest: string;
  acceptedAttemptId: string | null;
  reconciledInvocationIds: string[];
  recordedAt: string;
}>;

export type DurableAttemptResultAcceptance = Readonly<{
  state: DurableExecutionJobState;
  accepted: boolean;
  result: AttemptResult;
}>;

export type DurableExecutionReconciliation = Readonly<{
  state: DurableExecutionJobState;
  receipt: ExecutionReconciliationReceipt;
  replayed: boolean;
}>;

export function executionStorePaths(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'execution');
  return {
    root,
    jobs: path.join(root, 'jobs'),
  };
}

export function executionJobStatePath(
  paths: InvestigationRuntimePaths,
  requestedJobId: string,
): string {
  const jobId = assertExecutionJobId(requestedJobId);
  return path.join(
    executionStorePaths(paths).jobs,
    `${sha256Text(jobId)}.json`,
  );
}

export function readExecutionJobState(
  paths: InvestigationRuntimePaths,
  requestedJobId: string,
): DurableExecutionJobState | null {
  const jobId = assertExecutionJobId(requestedJobId);
  return readExecutionJobStateUnlocked(paths, jobId);
}

export function listExecutionJobStates(
  paths: InvestigationRuntimePaths,
): DurableExecutionJobState[] {
  const stores = executionStorePaths(paths);
  const root = fs.lstatSync(stores.root, { throwIfNoEntry: false });
  if (root === undefined) return [];
  try {
    assertPrivateInvestigationDirectory(
      paths,
      stores.root,
      executionStoreUnsafe,
    );
    const jobs = fs.lstatSync(stores.jobs, { throwIfNoEntry: false });
    if (jobs === undefined) return [];
    assertPrivateInvestigationDirectory(
      paths,
      stores.jobs,
      executionStoreUnsafe,
    );
    const states = fs
      .readdirSync(stores.jobs, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !EXECUTION_STATE_FILE.test(entry.name)
        ) {
          throw executionStoreUnsafe();
        }
        const value = assertDurableExecutionJobState(
          readPrivateCanonicalJson(
            paths,
            path.join(stores.jobs, entry.name),
            executionStoreUnsafe,
          ),
        );
        if (`${sha256Text(value.job.jobId)}.json` !== entry.name) {
          throw executionStoreUnsafe();
        }
        return value;
      });
    const jobIds = states.map(({ job }) => job.jobId);
    if (new Set(jobIds).size !== jobIds.length) throw executionStoreUnsafe();
    return deepFreeze(
      states.sort((left, right) =>
        left.job.jobId.localeCompare(right.job.jobId),
      ),
    );
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw executionStoreUnsafe(error);
  }
}

/**
 * Materialize all legacy invocation attempts for exactly one semantic Job.
 * The aggregate is one private canonical file so revision checks, attempt
 * lineage, and accepted-result state change under a single atomic rename.
 */
export function materializeLegacyProviderExecutionJob(
  paths: InvestigationRuntimePaths,
  entries: readonly LegacyProviderExecutionEntry[],
  options: { expectedRevision?: number | null } = {},
): DurableExecutionJobState {
  const prepared = prepareLegacyEntries(paths, entries);
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    assertExpectedRevision(current, options.expectedRevision);
    const candidate = buildLegacyExecutionState(prepared, current);
    return persistExecutionJobState(paths, current, candidate);
  });
}

/**
 * Submit a fenced legacy Attempt result against the durable Job aggregate.
 * The current acceptedAttemptId is read and changed beneath the same lock. A
 * later valid result therefore persists as late-duplicate instead of replacing
 * the winner or being silently discarded.
 */
export function acceptLegacyProviderAttemptResult(
  paths: InvestigationRuntimePaths,
  input: {
    entries: readonly LegacyProviderExecutionEntry[];
    attemptId: string;
    leaseGeneration: number;
    leaseToken: string;
    outputDigest: string;
    completedAt: string;
    expectedRevision?: number;
  },
): DurableAttemptResultAcceptance {
  const prepared = prepareLegacyEntries(paths, input.entries);
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    assertExpectedRevision(current, input.expectedRevision);
    const materialized = buildLegacyExecutionState(prepared, current);
    const attemptIndex = materialized.attempts.findIndex(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (attemptIndex < 0) {
      throw executionProjectionConflict(
        'The submitted legacy Attempt is not part of the projected Job.',
      );
    }
    const outputDigest = normalizeDigest(input.outputDigest);
    const existingResult = materialized.results.find(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (existingResult !== undefined) {
      if (existingResult.outputDigest !== outputDigest) {
        throw workflowError(
          'EXECUTION_STORE_RESULT_CONFLICT',
          'The durable Attempt already has a different result digest.',
          ExitCode.conflict,
        );
      }
      const state = persistExecutionJobState(paths, current, materialized);
      return deepFreeze({
        state,
        accepted: existingResult.acceptance === 'accepted',
        result: existingResult,
      });
    }
    const outcome = acceptAttemptResult({
      workflow: materialized.workflow,
      job: materialized.job,
      attempt: materialized.attempts[attemptIndex]!,
      expectedAcceptedAttemptId: materialized.job.acceptedAttemptId,
      leaseGeneration: input.leaseGeneration,
      leaseToken: input.leaseToken,
      outputDigest,
      completedAt: input.completedAt,
    });
    const attempts = [...materialized.attempts];
    attempts[attemptIndex] = outcome.attempt;
    const results = [...materialized.results, outcome.result].sort(
      (left, right) =>
        attemptNumber(attempts, left.attemptId) -
        attemptNumber(attempts, right.attemptId),
    );
    const candidate = assertDurableExecutionJobState({
      ...materialized,
      job: {
        ...outcome.job,
        // Provider Attempts are charged conservatively when their durable
        // reservation is materialized. Result acceptance must not charge the
        // same reservation a second time.
        cumulativeRuntimeMs: materialized.job.cumulativeRuntimeMs,
        providerCostMicros: materialized.job.providerCostMicros,
        providerTokens: materialized.job.providerTokens,
      },
      attempts,
      results,
    });
    const state = persistExecutionJobState(paths, current, candidate);
    return deepFreeze({
      state,
      accepted: outcome.accepted,
      result: outcome.result,
    });
  });
}

export function reconcileLegacyProviderExecutionJob(
  paths: InvestigationRuntimePaths,
  input: {
    entries: readonly LegacyProviderExecutionEntry[];
    triggerInvocationId: string;
    expectedExecutionRevision: number;
    expectedLegacyRevision: number;
  },
): DurableExecutionReconciliation {
  const prepared = prepareLegacyEntries(paths, input.entries);
  const trigger = prepared.entries.find(
    ({ record }) => record.invocationId === input.triggerInvocationId,
  );
  if (
    trigger === undefined ||
    !Number.isSafeInteger(input.expectedLegacyRevision) ||
    input.expectedLegacyRevision < 0 ||
    trigger.record.revision !== input.expectedLegacyRevision
  ) {
    throw workflowError(
      'EXECUTION_RECONCILIATION_LEGACY_REVISION_MISMATCH',
      'The trigger invocation does not have the expected legacy revision.',
      ExitCode.staleState,
      {
        details: {
          expectedLegacyRevision: input.expectedLegacyRevision,
          observedLegacyRevision: trigger?.record.revision ?? null,
        },
      },
    );
  }
  const receiptId = reconciliationReceiptId({
    jobId: prepared.jobId,
    triggerInvocationId: input.triggerInvocationId,
    expectedExecutionRevision: input.expectedExecutionRevision,
    expectedLegacyRevision: input.expectedLegacyRevision,
  });
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    if (current === null) {
      throw workflowError(
        'EXECUTION_RECONCILIATION_STATE_MISSING',
        'Reconciliation requires an existing durable execution aggregate.',
        ExitCode.staleState,
      );
    }
    const replay = current.reconciliationReceipts.find(
      (receipt) => receipt.receiptId === receiptId,
    );
    if (replay !== undefined) {
      assertReconciliationReplay(current, prepared, replay);
      return deepFreeze({ state: current, receipt: replay, replayed: true });
    }
    assertExpectedRevision(current, input.expectedExecutionRevision);
    const materialized = buildLegacyExecutionState(prepared, current);
    if (materialized.job.acceptedAttemptId !== current.job.acceptedAttemptId) {
      throw workflowError(
        'EXECUTION_RECONCILIATION_WINNER_CHANGE_REJECTED',
        'Reconciliation cannot select or replace the accepted Attempt.',
        ExitCode.guard,
      );
    }
    const currentSources = new Map(
      current.legacyProjection.invocations.map((source) => [
        source.invocationId,
        source.legacyRevision,
      ]),
    );
    const reconciledInvocationIds = materialized.legacyProjection.invocations
      .filter(
        (source) =>
          currentSources.get(source.invocationId) !== source.legacyRevision,
      )
      .map(({ invocationId }) => invocationId)
      .sort();
    const resultingExecutionRevision = current.revision + 1;
    const receipt = assertExecutionReconciliationReceipt(
      {
        schemaVersion: 1,
        kind: 'legacy-provider-execution-reconciliation',
        receiptId,
        jobId: prepared.jobId,
        triggerInvocationId: input.triggerInvocationId,
        expectedExecutionRevision: input.expectedExecutionRevision,
        expectedLegacyRevision: input.expectedLegacyRevision,
        resultingExecutionRevision,
        beforeStateDigest: durableExecutionStateDigest(current),
        afterProjectionDigest: durableExecutionProjectionDigest(materialized),
        acceptedAttemptId: current.job.acceptedAttemptId,
        reconciledInvocationIds,
        recordedAt: prepared.entries
          .map(({ record }) => record.updatedAt)
          .reduce(latestTimestamp),
      },
      prepared.jobId,
    );
    const candidate = assertDurableExecutionJobState({
      ...materialized,
      revision: resultingExecutionRevision,
      reconciliationReceipts: [
        ...materialized.reconciliationReceipts,
        receipt,
      ].sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    });
    const state = persistExecutionJobState(paths, current, candidate);
    if (state.revision !== resultingExecutionRevision) {
      throw executionStoreUnsafe();
    }
    return deepFreeze({ state, receipt, replayed: false });
  });
}

type PreparedLegacyEntries = Readonly<{
  jobId: string;
  entries: Array<
    LegacyProviderExecutionEntry & {
      projection: ProviderInvocationProjection;
      repairLineage: ProviderRepairLineage | null;
      retryAccounting: ProviderRetryAccountingSnapshot | null;
    }
  >;
}>;

function prepareLegacyEntries(
  paths: InvestigationRuntimePaths,
  input: readonly LegacyProviderExecutionEntry[],
): PreparedLegacyEntries {
  if (input.length < 1 || input.length > MAX_LEGACY_ATTEMPTS) {
    throw executionProjectionConflict(
      'Legacy execution materialization requires a bounded non-empty history.',
    );
  }
  let entries: PreparedLegacyEntries['entries'];
  try {
    entries = input
      .map(({ record, request, retryAccounting = null }) => ({
        record,
        request,
        projection: projectProviderInvocationExecution({ record, request }),
        repairLineage: readProviderRepairLineage(paths, record, request),
        retryAccounting,
      }))
      .sort(
        (left, right) =>
          left.record.attempt - right.record.attempt ||
          left.record.invocationId.localeCompare(right.record.invocationId),
      );
  } catch (error) {
    throw executionProjectionConflict(
      'Legacy invocation history cannot be projected into execution records.',
      error,
    );
  }
  const first = entries[0]!;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (
      (index > 0 &&
        entry.record.attempt <= entries[index - 1]!.record.attempt) ||
      entry.projection.job.jobId !== first.projection.job.jobId ||
      entry.projection.workflow.workflowId !==
        first.projection.workflow.workflowId ||
      entry.projection.workflow.currentEpoch !==
        first.projection.workflow.currentEpoch ||
      entry.projection.workflow.contextDigest !==
        first.projection.workflow.contextDigest ||
      canonicalJson(entry.projection.job.semanticSpec) !==
        canonicalJson(first.projection.job.semanticSpec) ||
      canonicalJson(entry.projection.job.mandateBinding ?? null) !==
        canonicalJson(first.projection.job.mandateBinding ?? null) ||
      entry.projection.job.requestDigest !== first.projection.job.requestDigest
    ) {
      throw executionProjectionConflict(
        'Legacy invocation history has duplicate Attempts or conflicting semantic identity.',
      );
    }
  }
  return deepFreeze({
    jobId: first.projection.job.jobId,
    entries,
  });
}

function buildLegacyExecutionState(
  prepared: PreparedLegacyEntries,
  current: DurableExecutionJobState | null,
): DurableExecutionJobState {
  const firstEntry = prepared.entries[0]!;
  const first = firstEntry.projection;
  if (
    current !== null &&
    (current.job.jobId !== prepared.jobId ||
      current.workflow.workflowId !== first.workflow.workflowId ||
      current.workflow.currentEpoch !== first.workflow.currentEpoch ||
      current.workflow.contextDigest !== first.workflow.contextDigest ||
      canonicalJson(current.job.semanticSpec) !==
        canonicalJson(first.job.semanticSpec) ||
      canonicalJson(current.job.mandateBinding ?? null) !==
        canonicalJson(first.job.mandateBinding ?? null) ||
      current.job.requestDigest !== first.job.requestDigest)
  ) {
    throw executionProjectionConflict(
      'Durable execution state conflicts with the legacy semantic identity.',
    );
  }
  assertLegacyProjectionMonotonic(prepared, current);
  const frozenRetryPolicy =
    firstEntry.retryAccounting === null
      ? (current?.job.retryPolicy ?? first.job.retryPolicy)
      : providerRetryPolicyFromAccounting(
          firstEntry.retryAccounting.retryPolicy,
          firstEntry.record.createdAt,
        );

  const currentResults = new Map(
    (current?.results ?? []).map((result) => [result.attemptId, result]),
  );
  let acceptedAttemptId = current?.job.acceptedAttemptId ?? null;
  if (acceptedAttemptId === null) {
    const firstSuccess = [...prepared.entries]
      .filter(({ record }) => record.state === 'succeeded')
      .sort(
        (left, right) =>
          Date.parse(left.record.updatedAt) -
            Date.parse(right.record.updatedAt) ||
          left.record.invocationId.localeCompare(right.record.invocationId),
      )[0];
    acceptedAttemptId = firstSuccess?.projection.attempt.attemptId ?? null;
  }

  const attempts: AttemptRecord[] = [];
  for (let index = 0; index < prepared.entries.length; index += 1) {
    const entry = prepared.entries[index]!;
    const projected = entry.projection.attempt;
    const chargedProjection =
      entry.retryAccounting === null
        ? projected
        : assertAttemptRecord({
            ...projected,
            runtimeMs: entry.retryAccounting.attemptReservation.runtimeMs,
            providerCostMicros:
              entry.retryAccounting.attemptReservation.providerCostMicros,
            providerTokens:
              entry.retryAccounting.attemptReservation.providerTokens,
          });
    const previous = attempts.at(-1);
    const previousEntry = prepared.entries[index - 1];
    const hasAdjacentPrevious =
      previous !== undefined &&
      previousEntry !== undefined &&
      entry.record.attempt === previousEntry.record.attempt + 1;
    const result = currentResults.get(projected.attemptId);
    // A missing ordinal prevents a direct retryOf edge, but it does not erase
    // an observable policy difference from the last retained Attempt.
    const changedFields =
      previous === undefined
        ? []
        : executionPolicyChangedFields(
            previous.policySnapshot,
            projected.policySnapshot,
          );
    const acceptance = result?.acceptance;
    const projectedAcceptance =
      entry.record.state !== 'succeeded'
        ? null
        : projected.attemptId === acceptedAttemptId
          ? 'accepted'
          : 'late-duplicate';
    const effectiveAcceptance = acceptance ?? projectedAcceptance;
    if (
      hasAdjacentPrevious &&
      previous!.failure?.retryClass === 'repairable' &&
      entry.repairLineage === null
    ) {
      throw workflowError(
        'PROVIDER_REPAIR_LINEAGE_REQUIRED',
        'A repairable predecessor requires durable repair lineage before materialization.',
        ExitCode.guard,
      );
    }
    let baseAttempt = chargedProjection;
    if (entry.repairLineage !== null) {
      const lineage = entry.repairLineage;
      if (
        !hasAdjacentPrevious ||
        previous!.failure?.retryClass !== 'repairable' ||
        lineage.failedAttemptId !== previous!.attemptId ||
        lineage.failureFingerprint !== previous!.failure.fingerprint ||
        lineage.replacementAttemptId !== projected.attemptId ||
        lineage.jobId !== first.job.jobId ||
        lineage.workflowId !== first.workflow.workflowId ||
        lineage.epoch !== first.job.epoch ||
        lineage.contextDigest !== first.job.contextDigest
      ) {
        throw executionProjectionConflict(
          'Durable repair lineage does not bind adjacent legacy Attempts.',
        );
      }
      const priorRepairCount = attempts.filter(
        ({ retryMode }) => retryMode === 'repair',
      ).length;
      const replacement = createReplacementAttempt({
        workflow: current?.workflow ?? first.workflow,
        job: assertJobRecord({
          ...(current?.job ?? first.job),
          status: 'waiting-retry',
          acceptedAttemptId: null,
          attemptCount: previous!.attemptNumber,
          repairAttemptCount: priorRepairCount,
          retryPolicy: frozenRetryPolicy,
          updatedAt: previous!.updatedAt,
        }),
        previousAttempt: previous!,
        attemptId: projected.attemptId,
        retryMode: 'repair',
        currentExecutionPolicy: projected.policySnapshot,
        repairContext: lineage.repairContext,
        environmentDigest: projected.environmentDigest,
        createdAt: projected.createdAt,
      });
      if (
        replacement.attempt.attemptNumber !== projected.attemptNumber ||
        replacement.job.repairAttemptCount !== priorRepairCount + 1
      ) {
        throw executionProjectionConflict(
          'Repair Attempt does not preserve the projected attempt number.',
        );
      }
      baseAttempt = assertAttemptRecord({
        ...replacement.attempt,
        status: projected.status,
        leaseGeneration: projected.leaseGeneration,
        lease: projected.lease,
        failure: projected.failure,
        failureFingerprint: projected.failureFingerprint,
        runtimeMs: chargedProjection.runtimeMs,
        providerCostMicros: chargedProjection.providerCostMicros,
        providerTokens: chargedProjection.providerTokens,
        retention: projected.retention,
        legacyInvocation: projected.legacyInvocation,
        createdAt: projected.createdAt,
        updatedAt: projected.updatedAt,
      });
    }
    attempts.push(
      assertAttemptRecord({
        ...baseAttempt,
        retryOf: hasAdjacentPrevious ? previous!.attemptId : null,
        retryMode:
          entry.repairLineage !== null
            ? 'repair'
            : index === 0
              ? projected.retryMode
              : changedFields.length === 0
                ? 'same-input'
                : 'execution-policy-change',
        changedFields:
          entry.repairLineage === null
            ? changedFields
            : baseAttempt.changedFields,
        status:
          effectiveAcceptance === 'accepted'
            ? 'succeeded'
            : effectiveAcceptance === 'late-duplicate'
              ? 'late-duplicate'
              : effectiveAcceptance === 'stale'
                ? 'stale'
                : projected.status,
        retention:
          effectiveAcceptance === 'late-duplicate' ||
          effectiveAcceptance === 'stale'
            ? 'debug'
            : projected.retention,
        updatedAt:
          result === undefined
            ? projected.updatedAt
            : latestTimestamp(projected.updatedAt, result.completedAt),
      }),
    );
  }

  const results = new Map(currentResults);
  for (const [index, entry] of prepared.entries.entries()) {
    if (entry.record.state !== 'succeeded' || entry.record.result === null) {
      continue;
    }
    const attempt = attempts[index]!;
    const legacyOutputDigest = normalizeDigest(
      entry.record.result.outputDigest,
    );
    const existingResult = results.get(attempt.attemptId);
    if (existingResult !== undefined) {
      if (existingResult.outputDigest !== legacyOutputDigest) {
        throw executionProjectionConflict(
          'Legacy and durable Attempt result digests diverge.',
        );
      }
      continue;
    }
    results.set(
      attempt.attemptId,
      createAttemptResult(
        attempt,
        legacyOutputDigest,
        attempt.attemptId === acceptedAttemptId ? 'accepted' : 'late-duplicate',
        entry.record.updatedAt,
      ),
    );
  }
  const orderedResults = [...results.values()].sort(
    (left, right) =>
      attemptNumber(attempts, left.attemptId) -
      attemptNumber(attempts, right.attemptId),
  );
  const latestProjection = prepared.entries.at(-1)!.projection;
  const updatedAt = [
    ...attempts.map(({ updatedAt }) => updatedAt),
    ...orderedResults.map(({ completedAt }) => completedAt),
  ].reduce(latestTimestamp);
  const cumulativeRuntimeMs = sumAttemptAccounting(attempts, 'runtimeMs');
  const providerCostMicros = sumAttemptAccounting(
    attempts,
    'providerCostMicros',
  );
  const providerTokens = sumAttemptAccounting(attempts, 'providerTokens');
  let workflow = current?.workflow ?? first.workflow;
  let job = assertJobRecord({
    ...(current?.job ?? first.job),
    status:
      acceptedAttemptId === null ? latestProjection.job.status : 'succeeded',
    acceptedAttemptId,
    attemptCount: attempts.at(-1)!.attemptNumber,
    cumulativeRuntimeMs,
    providerCostMicros,
    providerTokens,
    repairAttemptCount: attempts.filter(
      ({ retryMode }) => retryMode === 'repair',
    ).length,
    retryPolicy: frozenRetryPolicy,
    createdAt: attempts[0]!.createdAt,
    updatedAt,
  });
  const latestAttempt = attempts.at(-1)!;
  if (acceptedAttemptId === null && latestAttempt.failure !== null) {
    const projected = projectExecutionFailureState({
      workflow,
      job,
      attempt: latestAttempt,
      failure: latestAttempt.failure,
      decision: decideLegacyExecutionFailure({
        workflow,
        job,
        attempt: latestAttempt,
        attempts,
      }),
    });
    workflow = projected.workflow;
    job = projected.job;
  } else if (workflow.blocker?.jobId === job.jobId) {
    workflow = assertWorkflowRecord({ ...workflow, blocker: null });
  }
  return assertDurableExecutionJobState({
    schemaVersion: 1,
    revision: current?.revision ?? 0,
    workflow,
    job,
    attempts,
    results: orderedResults,
    reconciliationReceipts: current?.reconciliationReceipts ?? [],
    legacyProjection: {
      kind: 'provider-invocation-v1',
      completeHistory: attempts.every(
        ({ attemptNumber }, index) => attemptNumber === index + 1,
      ),
      invocations: prepared.entries.map(({ record, projection }) => ({
        invocationId: record.invocationId,
        legacyRevision: record.revision,
        attemptId: projection.attempt.attemptId,
      })),
    },
  });
}

function assertLegacyProjectionMonotonic(
  prepared: PreparedLegacyEntries,
  current: DurableExecutionJobState | null,
): void {
  if (current === null) return;
  const incoming = new Map(
    prepared.entries.map(({ record }) => [
      record.invocationId,
      record.revision,
    ]),
  );
  for (const prior of current.legacyProjection.invocations) {
    const nextRevision = incoming.get(prior.invocationId);
    if (nextRevision === undefined || nextRevision < prior.legacyRevision) {
      throw executionProjectionConflict(
        'Legacy execution projection is missing history or moved backwards.',
      );
    }
  }
}

function persistExecutionJobState(
  paths: InvestigationRuntimePaths,
  current: DurableExecutionJobState | null,
  input: DurableExecutionJobState,
): DurableExecutionJobState {
  const candidate = assertDurableExecutionJobState(input);
  if (
    current !== null &&
    canonicalStateIgnoringRevision(current) ===
      canonicalStateIgnoringRevision(candidate)
  ) {
    return current;
  }
  const next = assertDurableExecutionJobState({
    ...candidate,
    revision: current === null ? 0 : current.revision + 1,
  });
  const statePath = executionJobStatePath(paths, next.job.jobId);
  if (current === null) {
    createPrivateCanonicalJson(
      paths,
      statePath,
      next,
      executionStoreUnsafe,
      'EXECUTION_STORE_COLLISION',
    );
  } else {
    writePrivateCanonicalJsonAtomic(
      paths,
      statePath,
      next,
      executionStoreUnsafe,
    );
  }
  const stored = readExecutionJobStateUnlocked(paths, next.job.jobId);
  if (stored === null) throw executionStoreUnsafe();
  return stored;
}

function readExecutionJobStateUnlocked(
  paths: InvestigationRuntimePaths,
  jobId: string,
): DurableExecutionJobState | null {
  const statePath = executionJobStatePath(paths, jobId);
  try {
    if (!privatePathExists(paths, statePath, executionStoreUnsafe)) return null;
    const state = assertDurableExecutionJobState(
      readPrivateCanonicalJson(paths, statePath, executionStoreUnsafe),
    );
    if (state.job.jobId !== jobId) throw executionStoreUnsafe();
    return state;
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw executionStoreUnsafe(error);
  }
}

function assertDurableExecutionJobState(
  value: unknown,
): DurableExecutionJobState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempts',
      'job',
      'legacyProjection',
      'reconciliationReceipts',
      'results',
      'revision',
      'schemaVersion',
      'workflow',
    ]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > MAX_LEGACY_ATTEMPTS ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.reconciliationReceipts) ||
    !isRecord(value.legacyProjection) ||
    !hasExactKeys(value.legacyProjection, [
      'completeHistory',
      'invocations',
      'kind',
    ]) ||
    value.legacyProjection.kind !== 'provider-invocation-v1' ||
    typeof value.legacyProjection.completeHistory !== 'boolean' ||
    !Array.isArray(value.legacyProjection.invocations)
  ) {
    throw executionStoreUnsafe();
  }
  let workflow: WorkflowRecord;
  let job: JobRecord;
  let attempts: AttemptRecord[];
  let results: AttemptResult[];
  let reconciliationReceipts: ExecutionReconciliationReceipt[];
  try {
    workflow = assertWorkflowRecord(value.workflow);
    job = assertJobRecord(value.job);
    attempts = value.attempts.map(assertAttemptRecord);
    results = value.results.map(assertAttemptResult);
    reconciliationReceipts = value.reconciliationReceipts.map((receipt) =>
      assertExecutionReconciliationReceipt(receipt, job.jobId),
    );
  } catch (error) {
    throw executionStoreUnsafe(error);
  }
  if (
    job.workflowId !== workflow.workflowId ||
    job.epoch !== workflow.currentEpoch ||
    job.contextDigest !== workflow.contextDigest ||
    job.attemptCount !== attempts.at(-1)!.attemptNumber ||
    value.legacyProjection.invocations.length !== attempts.length
  ) {
    throw executionStoreUnsafe();
  }
  const attemptIds = new Set<string>();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const source = value.legacyProjection.invocations[index];
    if (
      attemptIds.has(attempt.attemptId) ||
      (index > 0 &&
        attempt.attemptNumber <= attempts[index - 1]!.attemptNumber) ||
      attempt.jobId !== job.jobId ||
      attempt.workflowId !== workflow.workflowId ||
      attempt.epoch !== job.epoch ||
      attempt.contextDigest !== job.contextDigest ||
      attempt.retryOf !==
        (index > 0 &&
        attempt.attemptNumber === attempts[index - 1]!.attemptNumber + 1
          ? attempts[index - 1]!.attemptId
          : null) ||
      !isRecord(source) ||
      !hasExactKeys(source, ['attemptId', 'invocationId', 'legacyRevision']) ||
      source.attemptId !== attempt.attemptId ||
      source.invocationId !== attempt.legacyInvocation?.invocationId ||
      source.legacyRevision !== attempt.legacyInvocation?.legacyRevision ||
      !Number.isSafeInteger(source.legacyRevision) ||
      (source.legacyRevision as number) < 0
    ) {
      throw executionStoreUnsafe();
    }
    attemptIds.add(attempt.attemptId);
  }
  const resultAttempts = new Set<string>();
  let acceptedResult: AttemptResult | null = null;
  let priorAttemptNumber = 0;
  for (const result of results) {
    const attempt = attempts.find(
      ({ attemptId }) => attemptId === result.attemptId,
    );
    if (
      attempt === undefined ||
      resultAttempts.has(result.attemptId) ||
      result.workflowId !== workflow.workflowId ||
      result.epoch !== workflow.currentEpoch ||
      result.contextDigest !== workflow.contextDigest ||
      result.jobId !== job.jobId ||
      attempt.attemptNumber <= priorAttemptNumber ||
      (result.acceptance === 'accepted' && attempt.status !== 'succeeded') ||
      (result.acceptance === 'late-duplicate' &&
        attempt.status !== 'late-duplicate') ||
      (result.acceptance === 'stale' && attempt.status !== 'stale')
    ) {
      throw executionStoreUnsafe();
    }
    if (result.acceptance === 'accepted') {
      if (acceptedResult !== null) throw executionStoreUnsafe();
      acceptedResult = result;
    }
    resultAttempts.add(result.attemptId);
    priorAttemptNumber = attempt.attemptNumber;
  }
  for (const attempt of attempts) {
    if (
      ['succeeded', 'late-duplicate'].includes(attempt.status) !==
      resultAttempts.has(attempt.attemptId)
    ) {
      throw executionStoreUnsafe();
    }
  }
  if (
    reconciliationReceipts.some(
      (receipt, index) =>
        receipt.resultingExecutionRevision > (value.revision as number) ||
        (index > 0 &&
          receipt.receiptId <= reconciliationReceipts[index - 1]!.receiptId),
    ) ||
    value.legacyProjection.completeHistory !==
      attempts.every(
        ({ attemptNumber }, index) => attemptNumber === index + 1,
      ) ||
    (job.acceptedAttemptId === null) !== (acceptedResult === null) ||
    (acceptedResult !== null &&
      acceptedResult.attemptId !== job.acceptedAttemptId)
  ) {
    throw executionStoreUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    revision: value.revision as number,
    workflow,
    job,
    attempts,
    results,
    reconciliationReceipts,
    legacyProjection: {
      kind: 'provider-invocation-v1',
      completeHistory: value.legacyProjection.completeHistory,
      invocations: value.legacyProjection.invocations.map((source) => ({
        invocationId: String((source as Record<string, unknown>).invocationId),
        legacyRevision: Number(
          (source as Record<string, unknown>).legacyRevision,
        ),
        attemptId: String((source as Record<string, unknown>).attemptId),
      })),
    },
  });
}

function withExecutionJobLock<T>(
  paths: InvestigationRuntimePaths,
  jobId: string,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `execution-job-${sha256Text(jobId)}.lock`),
    operation,
    'EXECUTION_STORE_OPERATION_CONFLICT',
    executionStoreUnsafe,
  );
}

function assertExpectedRevision(
  current: DurableExecutionJobState | null,
  expectedRevision: number | null | undefined,
): void {
  if (expectedRevision === undefined) return;
  if (
    (expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
    (expectedRevision === null
      ? current !== null
      : current?.revision !== expectedRevision)
  ) {
    throw workflowError(
      'EXECUTION_STORE_CAS_MISMATCH',
      'The durable execution aggregate revision changed.',
      ExitCode.staleState,
      {
        details: {
          expectedRevision,
          observedRevision: current?.revision ?? null,
        },
      },
    );
  }
}

function assertExecutionReconciliationReceipt(
  value: unknown,
  expectedJobId: string,
): ExecutionReconciliationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'acceptedAttemptId',
      'afterProjectionDigest',
      'beforeStateDigest',
      'expectedExecutionRevision',
      'expectedLegacyRevision',
      'jobId',
      'kind',
      'receiptId',
      'reconciledInvocationIds',
      'recordedAt',
      'resultingExecutionRevision',
      'schemaVersion',
      'triggerInvocationId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'legacy-provider-execution-reconciliation' ||
    value.jobId !== expectedJobId ||
    typeof value.receiptId !== 'string' ||
    !DIGEST.test(value.receiptId) ||
    typeof value.triggerInvocationId !== 'string' ||
    !EXECUTION_JOB_ID.test(value.triggerInvocationId) ||
    !Number.isSafeInteger(value.expectedExecutionRevision) ||
    (value.expectedExecutionRevision as number) < 0 ||
    !Number.isSafeInteger(value.expectedLegacyRevision) ||
    (value.expectedLegacyRevision as number) < 0 ||
    !Number.isSafeInteger(value.resultingExecutionRevision) ||
    value.resultingExecutionRevision !==
      (value.expectedExecutionRevision as number) + 1 ||
    typeof value.beforeStateDigest !== 'string' ||
    !DIGEST.test(value.beforeStateDigest) ||
    typeof value.afterProjectionDigest !== 'string' ||
    !DIGEST.test(value.afterProjectionDigest) ||
    (value.acceptedAttemptId !== null &&
      (typeof value.acceptedAttemptId !== 'string' ||
        !EXECUTION_JOB_ID.test(value.acceptedAttemptId))) ||
    !Array.isArray(value.reconciledInvocationIds) ||
    value.reconciledInvocationIds.some(
      (invocationId) =>
        typeof invocationId !== 'string' ||
        !EXECUTION_JOB_ID.test(invocationId),
    ) ||
    canonicalJson(value.reconciledInvocationIds) !==
      canonicalJson(
        [...new Set(value.reconciledInvocationIds as string[])].sort(),
      ) ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw executionStoreUnsafe();
  }
  const expectedReceiptId = reconciliationReceiptId({
    jobId: expectedJobId,
    triggerInvocationId: value.triggerInvocationId,
    expectedExecutionRevision: value.expectedExecutionRevision as number,
    expectedLegacyRevision: value.expectedLegacyRevision as number,
  });
  if (value.receiptId !== expectedReceiptId) throw executionStoreUnsafe();
  return deepFreeze(structuredClone(value) as ExecutionReconciliationReceipt);
}

function reconciliationReceiptId(input: {
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedLegacyRevision: number;
}): string {
  return digestCanonical({
    schemaVersion: 1,
    kind: 'legacy-provider-execution-reconciliation-request',
    ...input,
  });
}

function assertReconciliationReplay(
  current: DurableExecutionJobState,
  prepared: PreparedLegacyEntries,
  receipt: ExecutionReconciliationReceipt,
): void {
  const materialized = buildLegacyExecutionState(prepared, current);
  if (
    current.revision < receipt.resultingExecutionRevision ||
    current.job.acceptedAttemptId !== receipt.acceptedAttemptId ||
    durableExecutionProjectionDigest(materialized) !==
      receipt.afterProjectionDigest
  ) {
    throw workflowError(
      'EXECUTION_RECONCILIATION_RECEIPT_STALE',
      'The existing reconciliation receipt no longer matches durable state.',
      ExitCode.staleState,
    );
  }
}

function durableExecutionStateDigest(state: DurableExecutionJobState): string {
  return digestCanonical(state);
}

function durableExecutionProjectionDigest(
  state: DurableExecutionJobState,
): string {
  return digestCanonical({
    workflow: state.workflow,
    job: state.job,
    attempts: state.attempts,
    results: state.results,
    legacyProjection: state.legacyProjection,
  });
}

function canonicalStateIgnoringRevision(
  state: DurableExecutionJobState,
): string {
  return canonicalJson({ ...state, revision: 0 });
}

function digestCanonical(value: unknown): string {
  return `sha256:${sha256Text(canonicalJson(value))}`;
}

function deterministicUuid(value: unknown): string {
  const hex = sha256Text(canonicalJson(value));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function attemptNumber(attempts: AttemptRecord[], attemptId: string): number {
  const attempt = attempts.find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (attempt === undefined) throw executionStoreUnsafe();
  return attempt.attemptNumber;
}

function sumAttemptAccounting(
  attempts: readonly AttemptRecord[],
  field: 'runtimeMs' | 'providerCostMicros' | 'providerTokens',
): number {
  let total = 0;
  for (const attempt of attempts) {
    total += attempt[field];
    if (!Number.isSafeInteger(total)) {
      throw executionProjectionConflict(
        'Provider retry accounting exceeds the durable integer range.',
      );
    }
  }
  return total;
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function assertExecutionJobId(value: string): string {
  if (typeof value !== 'string' || !EXECUTION_JOB_ID.test(value)) {
    throw workflowError(
      'EXECUTION_STORE_JOB_ID_INVALID',
      'The durable execution Job identifier is invalid.',
      ExitCode.usage,
    );
  }
  return value;
}

function normalizeDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  if (LEGACY_DIGEST.test(value)) return `sha256:${value}`;
  throw executionProjectionConflict('Legacy result digest is invalid.');
}

function executionProjectionConflict(
  message: string,
  cause?: unknown,
): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_PROJECTION_CONFLICT',
    message,
    ExitCode.guard,
    cause === undefined ? {} : { details: { cause: errorMessage(cause) } },
  );
}

function executionStoreUnsafe(cause?: unknown): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_UNSAFE',
    'The private durable execution store is malformed or unsafe.',
    ExitCode.unsafeEnvironment,
    cause === undefined ? {} : { details: { cause: errorMessage(cause) } },
  );
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
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
