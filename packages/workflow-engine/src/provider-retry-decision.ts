import crypto from 'node:crypto';

import {
  parseAiAdapterPolicyDocument,
  type LoadedAiAdapterPolicy,
} from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  decideRetry,
  providerExecutionPolicySnapshot,
  projectProviderInvocationExecution,
  type AttemptRecord,
  type JobRecord,
  type RetryDecision,
  type WorkflowRecord,
} from './execution-core.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  type ExecutionBudgetConsumeReceipt,
  type GrantRequest,
} from './execution-governance.ts';
import {
  providerRetryPolicyFromAccounting,
  readExecutionJobState,
} from './execution-store.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { InvestigationRuntimePaths } from './paths.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import {
  readProviderExecutionPolicySnapshot,
  readProviderInvocationRequest,
  type ProviderAttemptBudgetReservation,
  type ProviderInvocationRecord,
} from './provider-invocation-store.ts';
import { createProviderExecutionBudgetAuthority } from './provider-execution-policy-authority.ts';

export type AuthorizedProviderRetry = Readonly<{
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  executionRevision: number;
  decision: RetryDecision;
  sameFingerprintCount: number;
  providerAttemptCount: number;
  nextReservation: ProviderAttemptBudgetReservation;
  evaluatedAt: string;
  evidenceDigest: string;
  sourceInvocationIds: readonly string[];
}>;

export type ProviderExecutionGrantAuthorization = Readonly<{
  grantId: string;
  grantRequest: GrantRequest;
  receipt: ExecutionBudgetConsumeReceipt;
}>;

export function assertProviderExecutionGrantAuthorization(
  authorization: AuthorizedProviderRetry,
  grant: ProviderExecutionGrantAuthorization,
  replacementAttemptId: string,
): void {
  const requestDigest = `sha256:${crypto
    .createHash('sha256')
    .update(canonicalExecutionBudgetGrantRequest(grant.grantRequest))
    .digest('hex')}`;
  if (
    authorization.decision.requiredGrant === undefined ||
    canonicalJson(authorization.decision.requiredGrant) !==
      canonicalJson(grant.grantRequest) ||
    grant.receipt.grantId !== grant.grantId ||
    grant.receipt.requestDigest !== requestDigest ||
    grant.receipt.workflowId !== authorization.workflow.workflowId ||
    grant.receipt.epoch !== authorization.job.epoch ||
    grant.receipt.jobId !== authorization.job.jobId ||
    grant.receipt.attemptId !== replacementAttemptId
  ) {
    throw workflowError(
      'PROVIDER_RETRY_GRANT_AUTHORIZATION_INVALID',
      'The durable execution-budget receipt does not authorize this exact provider replacement.',
      ExitCode.guard,
    );
  }
}

/**
 * Make both Survey and PlanReview retry paths consume the same durable Job
 * aggregate. Every source Attempt must have v2 accounting before the decision;
 * a readable historical v1 policy snapshot remains inspectable but cannot
 * authorize new automatic provider work.
 */
export function authorizeAutomaticProviderRetry(
  paths: InvestigationRuntimePaths,
  input: {
    failed: ProviderInvocationRecord;
    failedRequest: ProviderInvocationRequest;
    replacementRequest: ProviderInvocationRequest;
    replacementExecutionPolicy: LoadedAiAdapterPolicy;
    boundedGrantRequest?: GrantRequest;
    executionGrantAuthorization?: ProviderExecutionGrantAuthorization;
    now?: string;
  },
): AuthorizedProviderRetry {
  const projection = projectProviderInvocationExecution({
    record: input.failed,
    request: input.failedRequest,
  });
  const state = readExecutionJobState(paths, projection.job.jobId);
  if (
    state === null ||
    !state.legacyProjection.completeHistory ||
    state.attempts.length !== state.legacyProjection.invocations.length
  ) {
    throw retryAccountingRequired();
  }
  const failedSource = state.legacyProjection.invocations.find(
    ({ invocationId }) => invocationId === input.failed.invocationId,
  );
  const failedAttempt = state.attempts.find(
    ({ attemptId }) => attemptId === projection.attempt.attemptId,
  );
  if (
    failedSource === undefined ||
    failedSource.legacyRevision !== input.failed.revision ||
    failedSource.attemptId !== projection.attempt.attemptId ||
    failedAttempt === undefined ||
    failedAttempt.failure === null ||
    failedAttempt.legacyInvocation?.invocationId !==
      input.failed.invocationId ||
    failedAttempt.legacyInvocation.legacyRevision !== input.failed.revision ||
    state.job.jobId !== projection.job.jobId ||
    state.workflow.workflowId !== projection.workflow.workflowId
  ) {
    throw retryAccountingStale();
  }

  let cumulativeRuntimeMs = 0;
  let providerCostMicros = 0;
  let providerTokens = 0;
  let firstRetryPolicy: ReturnType<
    typeof providerRetryPolicyFromAccounting
  > | null = null;
  const accountingEvidence: Array<{
    attemptId: string;
    invocationId: string;
    accountingDigest: string;
  }> = [];
  for (const [index, source] of state.legacyProjection.invocations.entries()) {
    const request = readProviderInvocationRequest(paths, source.invocationId);
    const snapshot = readProviderExecutionPolicySnapshot(paths, request);
    if (snapshot.accounting === null) {
      throw retryAccountingRequired();
    }
    const attempt = state.attempts.find(
      ({ attemptId }) => attemptId === source.attemptId,
    );
    if (
      attempt === undefined ||
      attempt.legacyInvocation?.invocationId !== source.invocationId ||
      attempt.legacyInvocation.legacyRevision !== source.legacyRevision ||
      attempt.runtimeMs !== snapshot.accounting.attemptReservation.runtimeMs ||
      attempt.providerCostMicros !==
        snapshot.accounting.attemptReservation.providerCostMicros ||
      attempt.providerTokens !==
        snapshot.accounting.attemptReservation.providerTokens
    ) {
      throw retryAccountingStale();
    }
    if (index === 0) {
      firstRetryPolicy = providerRetryPolicyFromAccounting(
        snapshot.accounting.retryPolicy,
        attempt.createdAt,
      );
    }
    cumulativeRuntimeMs = safeAdd(
      cumulativeRuntimeMs,
      snapshot.accounting.attemptReservation.runtimeMs,
    );
    providerCostMicros = safeAdd(
      providerCostMicros,
      snapshot.accounting.attemptReservation.providerCostMicros,
    );
    providerTokens = safeAdd(
      providerTokens,
      snapshot.accounting.attemptReservation.providerTokens,
    );
    accountingEvidence.push({
      attemptId: attempt.attemptId,
      invocationId: source.invocationId,
      accountingDigest: snapshot.accounting.accountingDigest,
    });
  }
  if (
    firstRetryPolicy === null ||
    canonicalJson(state.job.retryPolicy) !== canonicalJson(firstRetryPolicy) ||
    state.job.cumulativeRuntimeMs !== cumulativeRuntimeMs ||
    state.job.providerCostMicros !== providerCostMicros ||
    state.job.providerTokens !== providerTokens
  ) {
    throw retryAccountingStale();
  }

  const replacementPolicy = validateReplacementPolicy(input);
  const nextReservation: ProviderAttemptBudgetReservation = deepFreeze({
    runtimeMs: input.replacementRequest.limits.timeoutMs,
    providerCostMicros:
      replacementPolicy.policy.retryAccounting.reservations[
        input.replacementRequest.providerId
      ].providerCostMicros,
    providerTokens:
      replacementPolicy.policy.retryAccounting.reservations[
        input.replacementRequest.providerId
      ].providerTokens,
  });
  const sameFingerprintCount = state.attempts.filter(
    ({ failureFingerprint }) =>
      failureFingerprint !== null &&
      failureFingerprint === failedAttempt.failureFingerprint,
  ).length;
  const providerAttemptCount = state.attempts.filter(
    ({ provider }) => provider === input.replacementRequest.providerId,
  ).length;
  const evaluatedAt = normalizeEvaluationTime(
    input.now,
    input.failed.updatedAt,
  );
  const decision = decideRetry({
    workflow: state.workflow,
    job: state.job,
    attempt: failedAttempt,
    failure: failedAttempt.failure,
    sameFingerprintCount,
    currentExecutionPolicy: providerExecutionPolicySnapshot(
      input.replacementRequest,
    ),
    providerAttemptCount,
    nextRuntimeMs: nextReservation.runtimeMs,
    nextProviderCostMicros: nextReservation.providerCostMicros,
    nextProviderTokens: nextReservation.providerTokens,
    boundedGrantRequest: input.boundedGrantRequest,
    now: evaluatedAt,
  });
  const evidenceDigest = digestCanonical({
    schemaVersion: 1,
    kind: 'provider-retry-decision-evidence',
    executionJobId: state.job.jobId,
    executionRevision: state.revision,
    failedAttemptId: failedAttempt.attemptId,
    failedLegacyRevision: input.failed.revision,
    replacementRequestDigest: input.replacementRequest.requestDigest,
    accountingEvidence,
    cumulativeRuntimeMs,
    providerCostMicros,
    providerTokens,
    sameFingerprintCount,
    providerAttemptCount,
    nextReservation,
    boundedGrantRequest: input.boundedGrantRequest ?? null,
    ...(input.executionGrantAuthorization === undefined
      ? {}
      : {
          executionGrantAuthorization: input.executionGrantAuthorization,
        }),
    evaluatedAt,
    decision,
  });
  return deepFreeze({
    workflow: state.workflow,
    job: state.job,
    attempt: failedAttempt,
    executionRevision: state.revision,
    decision,
    sameFingerprintCount,
    providerAttemptCount,
    nextReservation,
    evaluatedAt,
    evidenceDigest,
    sourceInvocationIds: state.legacyProjection.invocations.map(
      ({ invocationId }) => invocationId,
    ),
  });
}

function validateReplacementPolicy(input: {
  replacementRequest: ProviderInvocationRequest;
  replacementExecutionPolicy: LoadedAiAdapterPolicy;
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization;
}): LoadedAiAdapterPolicy {
  let loaded: LoadedAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(
      input.replacementExecutionPolicy.document,
    );
  } catch {
    throw retryAccountingStale();
  }
  const request = input.replacementRequest;
  if (
    loaded.digest !== input.replacementExecutionPolicy.digest ||
    canonicalJson(loaded.policy) !==
      canonicalJson(input.replacementExecutionPolicy.policy) ||
    request.policyDigest !== loaded.digest ||
    request.limits.aggregateOutputBytes >
      loaded.policy.limits.aggregateOutputBytes ||
    !loaded.policy.providers[request.providerId].enabled
  ) {
    throw retryAccountingStale();
  }
  if (request.limits.timeoutMs > loaded.policy.limits.timeoutMs) {
    if (input.executionGrantAuthorization === undefined) {
      throw retryAccountingStale();
    }
    createProviderExecutionBudgetAuthority(
      request,
      loaded,
      input.executionGrantAuthorization,
    );
  }
  return loaded;
}

function normalizeEvaluationTime(
  requested: string | undefined,
  failedAt: string,
): string {
  const now = requested ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const failedMs = Date.parse(failedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(failedMs)) {
    throw retryAccountingStale();
  }
  return new Date(Math.max(nowMs, failedMs)).toISOString();
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw retryAccountingStale();
  return sum;
}

function retryAccountingRequired() {
  return workflowError(
    'PROVIDER_RETRY_ACCOUNTING_REQUIRED',
    'Automatic provider retry requires complete v2 accounting for every durable Attempt.',
    ExitCode.guard,
  );
}

function retryAccountingStale() {
  return workflowError(
    'PROVIDER_RETRY_ACCOUNTING_STALE',
    'Durable provider retry accounting is incomplete, inconsistent, or stale.',
    ExitCode.staleState,
  );
}

function digestCanonical(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
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
