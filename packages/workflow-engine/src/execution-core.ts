import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { GrantRequest } from './execution-governance.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import type { ProviderInvocationRecord } from './provider-invocation-store.ts';
import type { TaskMandateBinding } from './task-mandate.ts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LEGACY_DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_STRING_BYTES = 16_384;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkflowStatus =
  'active' | 'completed' | 'cancelled' | 'superseded';

export type WorkflowBlocker = {
  kind:
    | 'retry-delay'
    | 'provider-capacity'
    | 'human-grant'
    | 'human-input'
    | 'configuration'
    | 'dependency'
    | 'manual-reconciliation'
    | 'harness-intervention';
  since: string;
  jobId?: string;
  retryAt?: string;
  detailsDigest?: string;
  checkpointId?: string;
  blockedBy?: string;
};

export type WorkflowRecord = {
  schemaVersion: 2;
  workflowId: string;
  currentEpoch: number;
  contractVersion: number;
  contextDigest: string;
  checkpoint: string | null;
  status: WorkflowStatus;
  blocker: WorkflowBlocker | null;
  engineBinding: string;
};

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting-retry'
  | 'waiting-grant'
  | 'waiting-human-input'
  | 'succeeded'
  | 'failed-terminal'
  | 'stale'
  | 'cancelled';

export type RetryPolicy = {
  maxAttempts: number;
  maxCumulativeRuntimeMs: number;
  maxProviderCostMicros: number;
  maxProviderTokens: number;
  maxSameFailureFingerprint: number;
  maxRepairAttempts: number;
  deadline: string;
  providerLimits: Readonly<Record<string, number>>;
};

export type SemanticJobSpec = {
  schemaVersion: 1;
  contractVersion: number;
  stage: string;
  contextDigest: string;
  inputDigest: string;
  outputContractDigest: string;
  acceptancePolicyDigest: string;
};

export type ExecutionPolicySnapshot = {
  schemaVersion: 1;
  provider: string;
  timeoutMs: number;
  maxOutputBytes: number;
  workerClass: string;
  backoffMs: number;
  processEnvironment: Readonly<Record<string, string>>;
  concurrency: number;
  transientToolConfig: Readonly<Record<string, JsonPrimitive>>;
};

export type JobRecord = {
  schemaVersion: 2;
  jobId: string;
  workflowId: string;
  epoch: number;
  /** Absent only on read-only projections of legacy unmandated invocations. */
  mandateBinding?: TaskMandateBinding;
  stage: string;
  contextDigest: string;
  requestDigest: string;
  semanticSpec: SemanticJobSpec;
  status: JobStatus;
  acceptedAttemptId: string | null;
  attemptCount: number;
  cumulativeRuntimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
  repairAttemptCount: number;
  retryPolicy: RetryPolicy;
  createdAt: string;
  updatedAt: string;
};

export type RetryMode =
  | 'same-input'
  | 'execution-policy-change'
  | 'repair'
  | 'strategy-change'
  | 'new-context'
  | 'none';

export type AttemptStatus =
  | 'created'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed-retryable'
  | 'failed-terminal'
  | 'timed-out'
  | 'stale'
  | 'late-duplicate'
  | 'cancelled';

export type AttemptRetention = 'active' | 'debug' | 'pinned';

export type ChangedField = {
  path: string;
  from: JsonValue;
  to: JsonValue;
};

export type AttemptLease = {
  generation: number;
  workerId: string;
  tokenDigest: string;
  acquiredAt: string;
  expiresAt: string;
};

export type FailureSource =
  | 'provider'
  | 'network'
  | 'worker'
  | 'lease'
  | 'tool'
  | 'validator'
  | 'environment'
  | 'state'
  | 'effect'
  | 'policy';

export type FailureDescriptor = {
  schemaVersion: 1;
  stage: string;
  code: string;
  source: FailureSource;
  retryClass: 'retryable' | 'repairable' | 'terminal';
  sideEffectState: 'none' | 'idempotent-confirmed' | 'unknown';
  paths: string[];
  validatorPath: string | null;
  inputDigest: string;
  environmentDigest: string;
  observedAt: string;
  retryAfterMs: number | null;
  fingerprint: string;
};

export type RepairValidationError = {
  path: string;
  code: string;
  message: string;
};

export type RepairContext = {
  previousOutputDigest: string;
  validationErrors: RepairValidationError[];
  targetSchemaDigest: string;
  instruction: 'return-complete-replacement-object';
  epoch: number;
  contextDigest: string;
};

export type AttemptRecord = {
  schemaVersion: 2;
  attemptId: string;
  jobId: string;
  workflowId: string;
  epoch: number;
  attemptNumber: number;
  retryOf: string | null;
  provider: string;
  status: AttemptStatus;
  inputDigest: string;
  requestDigest: string;
  contextDigest: string;
  environmentDigest: string;
  retryMode: RetryMode;
  policySnapshot: ExecutionPolicySnapshot;
  changedFields: ChangedField[];
  repairContext: RepairContext | null;
  strategyChanges: string[];
  grantId: string | null;
  failure: FailureDescriptor | null;
  failureFingerprint: string | null;
  leaseGeneration: number;
  lease: AttemptLease | null;
  runtimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
  retention: AttemptRetention;
  legacyInvocation: {
    invocationId: string;
    legacyAttempt: number;
    legacyRevision: number;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type AttemptResult = {
  schemaVersion: 1;
  resultId: string;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  attemptId: string;
  outputDigest: string;
  acceptance: 'accepted' | 'stale' | 'late-duplicate';
  completedAt: string;
};

export type RetryDecision = {
  retryable: boolean;
  automatic: boolean;
  retryMode: RetryMode;
  retryAfterMs?: number;
  requiredGrant?: GrantRequest;
  changedStrategyRequired?: boolean;
  reasonCode: string;
};

export type EnvironmentSnapshot = {
  schemaVersion: 1;
  repository: {
    head: string;
    treeDigest: string;
    worktreeDigest: string;
  };
  runtime: {
    node: string;
    platform: string;
  };
  provider: {
    adapter: string;
    version: string;
    timeoutMs: number;
  };
  tools: Array<{
    name: string;
    available: boolean;
    version: string | null;
  }>;
  capabilities: {
    network: boolean;
    readRepository: boolean;
    writeWorkspace: boolean;
  };
};

export type ReadOnlyProbeKind =
  | 'repository-head'
  | 'repository-dirty-state'
  | 'runtime-version'
  | 'adapter-version'
  | 'binary-exists'
  | 'file-read'
  | 'validator-error'
  | 'execution-limits'
  | 'lease-state'
  | 'attempt-lineage'
  | 'dependency-availability';

export type ReadOnlyProbeRequest = {
  kind: ReadOnlyProbeKind;
  target?: string;
  timeoutMs: number;
};

export type EnvironmentDrift = {
  class: 'none' | 'non-semantic' | 'refreshable' | 'semantic';
  changedFields: ChangedField[];
};

export type ProviderInvocationProjection = {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
};

/**
 * Translate the provider request's process-only fields into the V2 execution
 * policy. Invocation identity, nonce, semantic target and output contract are
 * deliberately absent: changing those fields is not an execution-policy retry.
 */
export function providerExecutionPolicySnapshot(
  request: ProviderInvocationRequest,
): ExecutionPolicySnapshot {
  if (
    request.schemaVersion !== 1 ||
    request.invocationId.length === 0 ||
    request.policyDigest.length === 0
  ) {
    throw executionError(
      'PROVIDER_EXECUTION_REQUEST_INVALID',
      'Provider execution policy requires a validated provider request.',
      ExitCode.guard,
    );
  }
  return assertExecutionPolicy({
    schemaVersion: 1,
    provider: request.providerId,
    timeoutMs: request.limits.timeoutMs,
    maxOutputBytes: request.limits.aggregateOutputBytes,
    workerClass: 'provider-cli',
    backoffMs: 0,
    processEnvironment: {},
    concurrency: 1,
    transientToolConfig: {
      'policy-digest': normalizeDigest(request.policyDigest),
    },
  });
}

export function providerExecutionEnvironmentDigest(
  request: ProviderInvocationRequest,
): string {
  return digestCanonical({
    schemaVersion: 1,
    kind: 'provider-execution-environment',
    provider: request.providerId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    policyDigest: normalizeDigest(request.policyDigest),
  });
}

/**
 * Compatibility projection used by the live provider lifecycle while the
 * persisted invocation schema remains V1. All retry invocations for one
 * investigation/stage project to the same Job; each invocation is one Attempt.
 */
export function projectProviderInvocationExecution(input: {
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
}): ProviderInvocationProjection {
  const { record, request } = input;
  if (
    request.invocationId !== record.invocationId ||
    request.requestDigest !== record.requestDigest ||
    request.providerId !== record.providerId ||
    request.purpose !== record.purpose ||
    request.inputManifestDigest !== record.manifestDigest
  ) {
    throw executionError(
      'PROVIDER_EXECUTION_BINDING_INVALID',
      'Provider invocation and request do not project to the same Attempt.',
      ExitCode.guard,
    );
  }
  const deadline = new Date(
    Date.parse(record.createdAt) + 14 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  return projectLegacyProviderInvocation({
    record,
    epoch: 1,
    contractVersion: 1,
    contextDigest: normalizeDigest(record.manifestDigest),
    engineBinding: digestCanonical({
      schemaVersion: 1,
      kind: 'provider-execution-core-binding',
    }),
    executionPolicy: providerExecutionPolicySnapshot(request),
    environmentDigest: providerExecutionEnvironmentDigest(request),
    semanticJobIdentityDigest: normalizeDigest(record.manifestDigest),
    retryPolicy: {
      maxAttempts: 4,
      maxCumulativeRuntimeMs: request.limits.timeoutMs * 4,
      maxProviderCostMicros: Number.MAX_SAFE_INTEGER,
      maxProviderTokens: Number.MAX_SAFE_INTEGER,
      maxSameFailureFingerprint: 2,
      maxRepairAttempts: 2,
      deadline,
      providerLimits: { [request.providerId]: 4 },
    },
  });
}

export function createExecutionJob(input: {
  workflow: WorkflowRecord;
  mandateBinding: TaskMandateBinding;
  jobId: string;
  attemptId: string;
  stage: string;
  semanticSpec: SemanticJobSpec;
  executionPolicy: ExecutionPolicySnapshot;
  environmentDigest: string;
  retryPolicy: RetryPolicy;
  createdAt?: string;
}): { job: JobRecord; attempt: AttemptRecord } {
  const workflow = assertWorkflowRecord(input.workflow);
  const mandateBinding = assertExecutionJobMandateBinding(input.mandateBinding);
  if (workflow.status !== 'active') {
    throw executionError(
      'EXECUTION_WORKFLOW_NOT_ACTIVE',
      'A Job may only be created for an active Workflow.',
      ExitCode.guard,
    );
  }
  const jobId = assertIdentifier(input.jobId, 'jobId');
  const attemptId = assertIdentifier(input.attemptId, 'attemptId');
  const stage = assertIdentifier(input.stage, 'stage');
  const semanticSpec = assertSemanticJobSpec(input.semanticSpec);
  const executionPolicy = assertExecutionPolicy(input.executionPolicy);
  const environmentDigest = assertDigest(input.environmentDigest);
  const retryPolicy = assertRetryPolicy(input.retryPolicy);
  const createdAt = assertTimestamp(
    input.createdAt ?? new Date().toISOString(),
  );
  if (
    semanticSpec.contractVersion !== workflow.contractVersion ||
    semanticSpec.stage !== stage ||
    semanticSpec.contextDigest !== workflow.contextDigest
  ) {
    throw executionInvalid(
      'Semantic Job specification is not bound to its Workflow.',
    );
  }
  const semanticRequestDigest = digestCanonical({
    kind: 'semantic-job-spec',
    jobId,
    workflowId: workflow.workflowId,
    epoch: workflow.currentEpoch,
    mandateBinding,
    semanticSpec,
  });
  const attemptRequestDigest = composeAttemptRequestDigest({
    jobId,
    attemptNumber: 1,
    semanticSpec,
    executionPolicy,
    retryMode: 'none',
    repairContext: null,
    strategyChanges: [],
    grantId: null,
  });
  const job: JobRecord = {
    schemaVersion: 2,
    jobId,
    workflowId: workflow.workflowId,
    epoch: workflow.currentEpoch,
    mandateBinding,
    stage,
    contextDigest: workflow.contextDigest,
    requestDigest: semanticRequestDigest,
    semanticSpec,
    status: 'queued',
    acceptedAttemptId: null,
    attemptCount: 1,
    cumulativeRuntimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    repairAttemptCount: 0,
    retryPolicy,
    createdAt,
    updatedAt: createdAt,
  };
  const attempt: AttemptRecord = {
    schemaVersion: 2,
    attemptId,
    jobId,
    workflowId: workflow.workflowId,
    epoch: workflow.currentEpoch,
    attemptNumber: 1,
    retryOf: null,
    provider: executionPolicy.provider,
    status: 'created',
    inputDigest: semanticSpec.inputDigest,
    requestDigest: attemptRequestDigest,
    contextDigest: workflow.contextDigest,
    environmentDigest,
    retryMode: 'none',
    policySnapshot: executionPolicy,
    changedFields: [],
    repairContext: null,
    strategyChanges: [],
    grantId: null,
    failure: null,
    failureFingerprint: null,
    leaseGeneration: 0,
    lease: null,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: 'active',
    legacyInvocation: null,
    createdAt,
    updatedAt: createdAt,
  };
  return deepFreeze({
    job: assertJobRecord(job),
    attempt: assertAttemptRecord(attempt),
  });
}

export function createReplacementAttempt(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  previousAttempt: AttemptRecord;
  attemptId: string;
  retryMode: Exclude<RetryMode, 'none' | 'new-context'>;
  currentExecutionPolicy: ExecutionPolicySnapshot;
  policyOverrides?: Partial<Omit<ExecutionPolicySnapshot, 'schemaVersion'>>;
  repairContext?: RepairContext;
  strategyChanges?: string[];
  grantId?: string;
  environmentDigest: string;
  createdAt?: string;
}): { job: JobRecord; attempt: AttemptRecord } {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const previous = assertAttemptRecord(input.previousAttempt);
  const createdAt = assertTimestamp(
    input.createdAt ?? new Date().toISOString(),
  );
  if (workflow.status !== 'active') {
    throw executionError(
      'EXECUTION_WORKFLOW_NOT_ACTIVE',
      'A replacement Attempt requires an active Workflow.',
      ExitCode.guard,
    );
  }
  if (
    job.workflowId !== workflow.workflowId ||
    job.epoch !== workflow.currentEpoch ||
    job.contextDigest !== workflow.contextDigest ||
    previous.jobId !== job.jobId ||
    previous.workflowId !== job.workflowId ||
    previous.epoch !== job.epoch ||
    previous.contextDigest !== job.contextDigest
  ) {
    throw executionError(
      'EXECUTION_CONTEXT_STALE',
      'The Job or previous Attempt is not in the current Workflow context.',
      ExitCode.staleState,
    );
  }
  if (job.acceptedAttemptId !== null || job.status === 'succeeded') {
    throw executionError(
      'JOB_RESULT_ALREADY_ACCEPTED',
      'A Job with an accepted result cannot create a replacement Attempt.',
      ExitCode.conflict,
    );
  }
  if (!['failed-retryable', 'timed-out'].includes(previous.status)) {
    throw executionError(
      'ATTEMPT_NOT_REPLACEABLE',
      'The previous Attempt is not in a replaceable terminal state.',
      ExitCode.guard,
    );
  }
  if (previous.failure === null) {
    throw executionError(
      'ATTEMPT_FAILURE_REQUIRED',
      'A replacement Attempt requires the previous FailureDescriptor.',
      ExitCode.guard,
    );
  }
  if (
    (input.retryMode === 'repair') !==
    (previous.failure.retryClass === 'repairable')
  ) {
    throw executionError(
      'RETRY_MODE_MISMATCH',
      'The retry mode does not match the previous failure classification.',
      ExitCode.guard,
    );
  }
  if (
    job.attemptCount >= job.retryPolicy.maxAttempts &&
    input.grantId === undefined
  ) {
    throw executionError(
      'RETRY_BUDGET_EXHAUSTED',
      'The Job attempt budget is exhausted.',
      ExitCode.guard,
    );
  }
  const attemptId = assertIdentifier(input.attemptId, 'attemptId');
  if (attemptId === previous.attemptId) {
    throw executionInvalid('A replacement Attempt must have a new identity.');
  }
  const basePolicy = assertExecutionPolicy(input.currentExecutionPolicy);
  const policySnapshot = assertExecutionPolicy({
    ...basePolicy,
    ...(input.policyOverrides ?? {}),
    schemaVersion: 1,
    processEnvironment: {
      ...basePolicy.processEnvironment,
      ...(input.policyOverrides?.processEnvironment ?? {}),
    },
    transientToolConfig: {
      ...basePolicy.transientToolConfig,
      ...(input.policyOverrides?.transientToolConfig ?? {}),
    },
  });
  const changedFields = diffJson(
    previous.policySnapshot as unknown as JsonValue,
    policySnapshot as unknown as JsonValue,
    '',
    new Set(['/schemaVersion']),
  );
  if (
    input.retryMode === 'execution-policy-change' &&
    changedFields.length === 0
  ) {
    throw executionError(
      'RETRY_POLICY_CHANGE_EMPTY',
      'execution-policy-change requires at least one changed policy field.',
      ExitCode.usage,
    );
  }
  if (input.retryMode === 'same-input' && changedFields.length !== 0) {
    throw executionError(
      'RETRY_MODE_MISMATCH',
      'same-input cannot change the execution policy.',
      ExitCode.usage,
    );
  }
  const repairContext =
    input.repairContext === undefined
      ? null
      : assertRepairContext(input.repairContext, job);
  if ((input.retryMode === 'repair') !== (repairContext !== null)) {
    throw executionError(
      'RETRY_REPAIR_CONTEXT_INVALID',
      'A repair Attempt requires, and only a repair Attempt accepts, repair context.',
      ExitCode.usage,
    );
  }
  const strategyChanges = normalizeUniqueStrings(
    input.strategyChanges ?? [],
    'strategyChanges',
  );
  if (input.retryMode === 'strategy-change' && strategyChanges.length === 0) {
    throw executionError(
      'RETRY_STRATEGY_CHANGE_EMPTY',
      'strategy-change requires a declared strategy change.',
      ExitCode.usage,
    );
  }
  const grantId =
    input.grantId === undefined
      ? null
      : assertIdentifier(input.grantId, 'grantId');
  const attemptNumber = job.attemptCount + 1;
  const requestDigest = composeAttemptRequestDigest({
    jobId: job.jobId,
    attemptNumber,
    semanticSpec: job.semanticSpec,
    executionPolicy: policySnapshot,
    retryMode: input.retryMode,
    repairContext,
    strategyChanges,
    grantId,
  });
  const attempt: AttemptRecord = {
    schemaVersion: 2,
    attemptId,
    jobId: job.jobId,
    workflowId: job.workflowId,
    epoch: job.epoch,
    attemptNumber,
    retryOf: previous.attemptId,
    provider: policySnapshot.provider,
    status: 'created',
    inputDigest: job.semanticSpec.inputDigest,
    requestDigest,
    contextDigest: job.contextDigest,
    environmentDigest: assertDigest(input.environmentDigest),
    retryMode: input.retryMode,
    policySnapshot,
    changedFields,
    repairContext,
    strategyChanges,
    grantId,
    failure: null,
    failureFingerprint: null,
    leaseGeneration: 0,
    lease: null,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: 'active',
    legacyInvocation: null,
    createdAt,
    updatedAt: createdAt,
  };
  const nextJob: JobRecord = {
    ...job,
    status: 'queued',
    attemptCount: attemptNumber,
    repairAttemptCount:
      job.repairAttemptCount + (input.retryMode === 'repair' ? 1 : 0),
    updatedAt: createdAt,
  };
  return deepFreeze({
    job: assertJobRecord(nextJob),
    attempt: assertAttemptRecord(attempt),
  });
}

export function executionPolicyChangedFields(
  previous: ExecutionPolicySnapshot,
  current: ExecutionPolicySnapshot,
): ChangedField[] {
  const before = assertExecutionPolicy(previous);
  const after = assertExecutionPolicy(current);
  return deepFreeze(
    diffJson(
      before as unknown as JsonValue,
      after as unknown as JsonValue,
      '',
      new Set(['/schemaVersion']),
    ),
  );
}

export function leaseAttempt(
  inputAttempt: AttemptRecord,
  input: {
    workerId: string;
    leaseToken: string;
    leaseDurationMs: number;
    now?: string;
  },
): AttemptRecord {
  const attempt = assertAttemptRecord(inputAttempt);
  if (attempt.status !== 'created' || attempt.lease !== null) {
    throw executionError(
      'ATTEMPT_LEASE_CONFLICT',
      'Only an unleased created Attempt can be leased.',
      ExitCode.conflict,
    );
  }
  const workerId = assertIdentifier(input.workerId, 'workerId');
  if (
    typeof input.leaseToken !== 'string' ||
    input.leaseToken.length < 8 ||
    Buffer.byteLength(input.leaseToken, 'utf8') > 512
  ) {
    throw executionInvalid('leaseToken is invalid.');
  }
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > attempt.policySnapshot.timeoutMs
  ) {
    throw executionInvalid('leaseDurationMs is outside the Attempt policy.');
  }
  const now = assertTimestamp(input.now ?? new Date().toISOString());
  const generation = attempt.leaseGeneration + 1;
  return deepFreeze(
    assertAttemptRecord({
      ...attempt,
      status: 'leased',
      leaseGeneration: generation,
      lease: {
        generation,
        workerId,
        tokenDigest: digestText(input.leaseToken),
        acquiredAt: now,
        expiresAt: new Date(
          Date.parse(now) + input.leaseDurationMs,
        ).toISOString(),
      },
      updatedAt: now,
    }),
  );
}

export function acceptAttemptResult(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  expectedAcceptedAttemptId: string | null;
  leaseGeneration: number;
  leaseToken: string;
  outputDigest: string;
  completedAt?: string;
}): {
  accepted: boolean;
  job: JobRecord;
  attempt: AttemptRecord;
  result: AttemptResult;
} {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const attempt = assertAttemptRecord(input.attempt);
  const completedAt = assertTimestamp(
    input.completedAt ?? new Date().toISOString(),
  );
  if (input.expectedAcceptedAttemptId !== job.acceptedAttemptId) {
    throw executionError(
      'JOB_RESULT_CAS_CONFLICT',
      'The Job accepted-result compare-and-swap precondition changed.',
      ExitCode.staleState,
    );
  }
  assertAttemptFence(
    attempt,
    input.leaseGeneration,
    input.leaseToken,
    completedAt,
  );
  if (
    attempt.jobId !== job.jobId ||
    attempt.workflowId !== job.workflowId ||
    job.workflowId !== workflow.workflowId
  ) {
    throw executionInvalid(
      'Result identities do not bind to one Workflow and Job.',
    );
  }
  const outputDigest = assertDigest(input.outputDigest);
  if (
    workflow.status !== 'active' ||
    workflow.currentEpoch !== job.epoch ||
    workflow.currentEpoch !== attempt.epoch ||
    workflow.contextDigest !== job.contextDigest ||
    workflow.contextDigest !== attempt.contextDigest
  ) {
    const staleAttempt = assertAttemptRecord({
      ...attempt,
      status: 'stale',
      retention: 'debug',
      updatedAt: completedAt,
    });
    // Only the Attempt goes stale. A Job that already accepted a result stays
    // succeeded: marking it stale while it still names an accepted Attempt
    // contradicts the record invariant, and a late output must be classified
    // and dropped rather than crash the acceptance path.
    const staleJob =
      job.acceptedAttemptId === null
        ? assertJobRecord({
            ...job,
            status: 'stale',
            updatedAt: completedAt,
          })
        : job;
    return deepFreeze({
      accepted: false,
      job: staleJob,
      attempt: staleAttempt,
      result: createAttemptResult(
        staleAttempt,
        outputDigest,
        'stale',
        completedAt,
      ),
    });
  }
  if (job.acceptedAttemptId !== null) {
    const duplicate = assertAttemptRecord({
      ...attempt,
      status: 'late-duplicate',
      retention: 'debug',
      updatedAt: completedAt,
    });
    return deepFreeze({
      accepted: false,
      job,
      attempt: duplicate,
      result: createAttemptResult(
        duplicate,
        outputDigest,
        'late-duplicate',
        completedAt,
      ),
    });
  }
  if (!['leased', 'running'].includes(attempt.status)) {
    throw executionError(
      'ATTEMPT_RESULT_INELIGIBLE',
      'The Attempt state is not eligible to submit a result.',
      ExitCode.guard,
    );
  }
  const acceptedAttempt = assertAttemptRecord({
    ...attempt,
    status: 'succeeded',
    updatedAt: completedAt,
  });
  const acceptedJob = assertJobRecord({
    ...job,
    status: 'succeeded',
    acceptedAttemptId: attempt.attemptId,
    cumulativeRuntimeMs: job.cumulativeRuntimeMs + attempt.runtimeMs,
    providerCostMicros: job.providerCostMicros + attempt.providerCostMicros,
    providerTokens: job.providerTokens + attempt.providerTokens,
    updatedAt: completedAt,
  });
  return deepFreeze({
    accepted: true,
    job: acceptedJob,
    attempt: acceptedAttempt,
    result: createAttemptResult(
      acceptedAttempt,
      outputDigest,
      'accepted',
      completedAt,
    ),
  });
}

export function createFailureDescriptor(input: {
  stage: string;
  code: string;
  source: FailureSource;
  retryClass: FailureDescriptor['retryClass'];
  sideEffectState: FailureDescriptor['sideEffectState'];
  paths: string[];
  validatorPath: string | null;
  inputDigest: string;
  environmentDigest: string;
  observedAt: string;
  retryAfterMs?: number;
}): FailureDescriptor {
  const stage = assertIdentifier(input.stage, 'stage');
  const code = assertErrorCode(input.code);
  if (!FAILURE_SOURCES.has(input.source)) {
    throw executionInvalid('Failure source is unknown.');
  }
  if (!['retryable', 'repairable', 'terminal'].includes(input.retryClass)) {
    throw executionInvalid('Failure retryClass is unknown.');
  }
  if (
    !['none', 'idempotent-confirmed', 'unknown'].includes(input.sideEffectState)
  ) {
    throw executionInvalid('Failure sideEffectState is unknown.');
  }
  const paths = normalizeFailurePaths(input.paths);
  const validatorPath =
    input.validatorPath === null
      ? null
      : assertJsonPointer(input.validatorPath, 'validatorPath');
  const inputDigest = assertDigest(input.inputDigest);
  const environmentDigest = assertDigest(input.environmentDigest);
  const observedAt = assertTimestamp(input.observedAt);
  const retryAfterMs = input.retryAfterMs ?? null;
  if (
    retryAfterMs !== null &&
    (!Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > 86_400_000)
  ) {
    throw executionInvalid('retryAfterMs is invalid.');
  }
  const fingerprint = digestCanonical({
    stage,
    errorCode: code,
    validatorPath,
    inputDigest,
    environmentDigest,
  });
  return deepFreeze({
    schemaVersion: 1,
    stage,
    code,
    source: input.source,
    retryClass: input.retryClass,
    sideEffectState: input.sideEffectState,
    paths,
    validatorPath,
    inputDigest,
    environmentDigest,
    observedAt,
    retryAfterMs,
    fingerprint,
  });
}

export type ExecutionFailureKind =
  | 'provider-timeout'
  | 'network'
  | 'rate-limit'
  | 'provider-process-crash'
  | 'worker-crash'
  | 'lease-expiry'
  | 'temporary-file-lock'
  | 'provider-capacity'
  | 'stdout-truncated'
  | 'process-nonzero'
  | 'json-parse'
  | 'schema-mismatch'
  | 'missing-required-field'
  | 'citation-out-of-range'
  | 'probe-transient'
  | 'needs-user-decision'
  | 'state-corruption'
  | 'unknown-side-effect';

const FAILURE_CLASSIFICATIONS: Readonly<
  Record<
    ExecutionFailureKind,
    {
      code: string;
      source: FailureSource;
      retryClass: FailureDescriptor['retryClass'];
      sideEffectState: FailureDescriptor['sideEffectState'];
    }
  >
> = Object.freeze({
  'provider-timeout': {
    code: 'PROVIDER_TIMEOUT',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  network: {
    code: 'NETWORK_TRANSIENT',
    source: 'network',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'rate-limit': {
    code: 'PROVIDER_RATE_LIMIT',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'provider-process-crash': {
    code: 'PROVIDER_PROCESS_CRASH',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'worker-crash': {
    code: 'WORKER_CRASH',
    source: 'worker',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'lease-expiry': {
    code: 'LEASE_EXPIRED',
    source: 'lease',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'temporary-file-lock': {
    code: 'TEMPORARY_FILE_LOCK',
    source: 'tool',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'provider-capacity': {
    code: 'PROVIDER_CAPACITY',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'stdout-truncated': {
    code: 'PROVIDER_STDOUT_TRUNCATED',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'process-nonzero': {
    code: 'PROVIDER_PROCESS_NONZERO',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'json-parse': {
    code: 'OUTPUT_JSON_PARSE_FAILED',
    source: 'validator',
    retryClass: 'repairable',
    sideEffectState: 'none',
  },
  'schema-mismatch': {
    code: 'OUTPUT_SCHEMA_MISMATCH',
    source: 'validator',
    retryClass: 'repairable',
    sideEffectState: 'none',
  },
  'missing-required-field': {
    code: 'OUTPUT_REQUIRED_FIELD_MISSING',
    source: 'validator',
    retryClass: 'repairable',
    sideEffectState: 'none',
  },
  'citation-out-of-range': {
    code: 'OUTPUT_CITATION_OUT_OF_RANGE',
    source: 'validator',
    retryClass: 'repairable',
    sideEffectState: 'none',
  },
  'probe-transient': {
    code: 'ENVIRONMENT_PROBE_TRANSIENT',
    source: 'environment',
    retryClass: 'retryable',
    sideEffectState: 'none',
  },
  'needs-user-decision': {
    code: 'NEEDS_USER_DECISION',
    source: 'policy',
    retryClass: 'terminal',
    sideEffectState: 'none',
  },
  'state-corruption': {
    code: 'STATE_CORRUPTION',
    source: 'state',
    retryClass: 'terminal',
    sideEffectState: 'none',
  },
  'unknown-side-effect': {
    code: 'UNKNOWN_SIDE_EFFECT_STATE',
    source: 'effect',
    retryClass: 'terminal',
    sideEffectState: 'unknown',
  },
});

export function classifyExecutionFailure(input: {
  kind: ExecutionFailureKind;
  stage: string;
  inputDigest: string;
  environmentDigest: string;
  observedAt: string;
  paths?: string[];
  validatorPath?: string | null;
  retryAfterMs?: number;
}): FailureDescriptor {
  const classification = FAILURE_CLASSIFICATIONS[input.kind];
  if (classification === undefined) {
    throw executionError(
      'EXECUTION_FAILURE_KIND_UNKNOWN',
      'The execution failure kind is not registered.',
      ExitCode.usage,
    );
  }
  return createFailureDescriptor({
    ...classification,
    stage: input.stage,
    paths: input.paths ?? [],
    validatorPath: input.validatorPath ?? null,
    inputDigest: input.inputDigest,
    environmentDigest: input.environmentDigest,
    observedAt: input.observedAt,
    retryAfterMs: input.retryAfterMs,
  });
}

export function decideRetry(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  failure: FailureDescriptor;
  sameFingerprintCount: number;
  boundedGrantRequest?: GrantRequest;
  currentExecutionPolicy?: ExecutionPolicySnapshot;
  providerAttemptCount?: number;
  nextRuntimeMs?: number;
  nextProviderCostMicros?: number;
  nextProviderTokens?: number;
  now?: string;
}): RetryDecision {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const attempt = assertAttemptRecord(input.attempt);
  const failure = assertFailureDescriptor(input.failure);
  const now = assertTimestamp(input.now ?? new Date().toISOString());
  if (
    !Number.isSafeInteger(input.sameFingerprintCount) ||
    input.sameFingerprintCount < 1
  ) {
    throw executionInvalid('sameFingerprintCount must be a positive integer.');
  }

  // The order below is normative. Do not combine these guards: callers depend
  // on the first stable reason code that applies.
  if (workflow.status === 'cancelled' || job.status === 'cancelled') {
    return noRetry('WORKFLOW_CANCELLED');
  }
  if (workflow.status !== 'active') {
    return noRetry('WORKFLOW_NOT_ACTIVE');
  }
  if (
    workflow.currentEpoch !== job.epoch ||
    workflow.currentEpoch !== attempt.epoch ||
    workflow.contextDigest !== job.contextDigest ||
    workflow.contextDigest !== attempt.contextDigest
  ) {
    return {
      retryable: true,
      automatic: false,
      retryMode: 'new-context',
      reasonCode: 'STALE_EPOCH',
    };
  }
  if (failure.sideEffectState === 'unknown') {
    return noRetry('MANUAL_RECONCILIATION_REQUIRED');
  }
  if (failure.source === 'state' || failure.code === 'STATE_CORRUPTION') {
    return noRetry('STATE_CORRUPTION');
  }
  if (job.acceptedAttemptId !== null) {
    return noRetry('JOB_RESULT_ALREADY_ACCEPTED');
  }
  // Terminal failures resolve before the fingerprint ladder. The ladder exists
  // to converge repeated *retryable* failures onto a changed strategy; letting
  // a terminal failure reach it would turn its second occurrence into an
  // automatic retry and let an attempt proceed while the job is projected as
  // waiting on human input.
  if (failure.retryClass === 'terminal') {
    return noRetry(failure.code);
  }
  const grant =
    input.boundedGrantRequest === undefined
      ? undefined
      : assertExecutionBudgetGrantRequest(input.boundedGrantRequest, job);
  const withinBudget = isWithinAutomaticBudget({
    job,
    attempt,
    failure,
    providerAttemptCount: input.providerAttemptCount,
    nextRuntimeMs: input.nextRuntimeMs,
    nextProviderCostMicros: input.nextProviderCostMicros,
    nextProviderTokens: input.nextProviderTokens,
    now,
  });
  if (input.sameFingerprintCount > job.retryPolicy.maxSameFailureFingerprint) {
    return grant === undefined
      ? noRetry('REPEATED_FAILURE')
      : grantDecision(grant, 'REPEATED_FAILURE_GRANT_REQUIRED');
  }
  if (input.sameFingerprintCount >= job.retryPolicy.maxSameFailureFingerprint) {
    if (withinBudget) {
      return {
        retryable: true,
        automatic: true,
        retryMode: 'strategy-change',
        changedStrategyRequired: true,
        reasonCode: 'REPEATED_FAILURE_STRATEGY_CHANGE',
      };
    }
    return grant === undefined
      ? noRetry('REPEATED_FAILURE')
      : grantDecision(grant, 'REPEATED_FAILURE_GRANT_REQUIRED');
  }
  if (withinBudget) {
    const retryMode = inferRetryMode(
      failure,
      attempt,
      input.currentExecutionPolicy,
    );
    const decision: RetryDecision = {
      retryable: true,
      automatic: true,
      retryMode,
      reasonCode: failure.code,
    };
    if (failure.retryAfterMs !== null) {
      decision.retryAfterMs = failure.retryAfterMs;
    }
    return deepFreeze(decision);
  }
  if (grant !== undefined) {
    return grantDecision(grant, 'EXECUTION_GRANT_REQUIRED');
  }
  return noRetry('RETRY_BUDGET_EXHAUSTED');
}

export type ExecutionFailureStateProjection = Readonly<{
  workflow: WorkflowRecord;
  job: JobRecord;
}>;

/**
 * Project an already-decided durable failure into the exact Job wait state and
 * Workflow blocker. This is deliberately exhaustive for grant, semantic-input,
 * and unknown-side-effect outcomes; no generic suspended state exists.
 */
export function projectExecutionFailureState(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  failure: FailureDescriptor;
  decision: RetryDecision;
}): ExecutionFailureStateProjection {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const attempt = assertAttemptRecord(input.attempt);
  const failure = assertFailureDescriptor(input.failure);
  const decision = input.decision;
  if (
    attempt.jobId !== job.jobId ||
    attempt.workflowId !== workflow.workflowId ||
    attempt.epoch !== job.epoch ||
    attempt.contextDigest !== job.contextDigest ||
    attempt.failureFingerprint !== failure.fingerprint ||
    typeof decision.retryable !== 'boolean' ||
    typeof decision.automatic !== 'boolean' ||
    !RETRY_MODES.has(decision.retryMode) ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(decision.reasonCode)
  ) {
    throw executionInvalid('Failure state projection is inconsistent.');
  }

  let status: JobStatus;
  let blocker: WorkflowBlocker | null;
  if (decision.requiredGrant !== undefined) {
    if (
      decision.requiredGrant.workflowId !== workflow.workflowId ||
      decision.requiredGrant.epoch !== job.epoch ||
      decision.requiredGrant.jobId !== job.jobId
    ) {
      throw executionInvalid('Failure grant projection is stale.');
    }
    status = 'waiting-grant';
    blocker = {
      kind: 'human-grant',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: digestCanonical(decision.requiredGrant),
    };
  } else if (
    failure.code === 'NEEDS_USER_DECISION' ||
    decision.reasonCode === 'NEEDS_USER_DECISION'
  ) {
    status = 'waiting-human-input';
    blocker = {
      kind: 'human-input',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: failure.fingerprint,
    };
  } else if (
    failure.sideEffectState === 'unknown' ||
    decision.reasonCode === 'MANUAL_RECONCILIATION_REQUIRED'
  ) {
    status = 'failed-terminal';
    blocker = {
      kind: 'manual-reconciliation',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: failure.fingerprint,
    };
  } else if (decision.retryable && decision.automatic) {
    status = 'waiting-retry';
    blocker = null;
  } else {
    status = 'failed-terminal';
    blocker = null;
  }

  return deepFreeze({
    workflow: assertWorkflowRecord({ ...workflow, blocker }),
    job: assertJobRecord({
      ...job,
      status,
      updatedAt: new Date(
        Math.max(Date.parse(job.updatedAt), Date.parse(failure.observedAt)),
      ).toISOString(),
    }),
  });
}

export function environmentSnapshotDigest(
  snapshot: EnvironmentSnapshot,
): string {
  return digestCanonical(assertEnvironmentSnapshot(snapshot));
}

export function assertReadOnlyProbe(
  input: unknown,
): Readonly<ReadOnlyProbeRequest> {
  if (
    !isPlainObject(input) ||
    !hasOnlyKeys(input, ['kind', 'target', 'timeoutMs'])
  ) {
    throw probeNotAllowed();
  }
  if (
    typeof input.kind !== 'string' ||
    !READ_ONLY_PROBE_KINDS.has(input.kind as ReadOnlyProbeKind) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    (input.timeoutMs as number) < 1 ||
    (input.timeoutMs as number) > 30_000
  ) {
    throw probeNotAllowed();
  }
  const kind = input.kind as ReadOnlyProbeKind;
  const requiresTarget = new Set<ReadOnlyProbeKind>([
    'binary-exists',
    'file-read',
    'validator-error',
    'dependency-availability',
  ]).has(kind);
  if (
    requiresTarget !== Object.hasOwn(input, 'target') ||
    (requiresTarget &&
      (typeof input.target !== 'string' ||
        input.target.length === 0 ||
        Buffer.byteLength(input.target, 'utf8') > 1_024))
  ) {
    throw probeNotAllowed();
  }
  if (
    kind === 'file-read' &&
    !isSafeRepositoryRelativePath(input.target as string)
  ) {
    throw probeNotAllowed();
  }
  if (
    kind === 'binary-exists' &&
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(input.target as string)
  ) {
    throw probeNotAllowed();
  }
  if (
    kind === 'validator-error' &&
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(input.target as string)
  ) {
    throw probeNotAllowed();
  }
  if (
    kind === 'dependency-availability' &&
    !/^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/.test(
      input.target as string,
    )
  ) {
    throw probeNotAllowed();
  }
  const probe: ReadOnlyProbeRequest = {
    kind,
    timeoutMs: input.timeoutMs as number,
  };
  if (requiresTarget) {
    probe.target = input.target as string;
  }
  return deepFreeze(probe);
}

export function classifyEnvironmentDrift(
  previousInput: EnvironmentSnapshot,
  currentInput: EnvironmentSnapshot,
): EnvironmentDrift {
  const previous = assertEnvironmentSnapshot(previousInput);
  const current = assertEnvironmentSnapshot(currentInput);
  const changedFields = diffJson(
    previous as unknown as JsonValue,
    current as unknown as JsonValue,
  );
  if (changedFields.length === 0) {
    return deepFreeze({ class: 'none', changedFields });
  }
  if (
    previous.repository.head !== current.repository.head ||
    previous.repository.treeDigest !== current.repository.treeDigest
  ) {
    return deepFreeze({ class: 'semantic', changedFields });
  }
  if (
    previous.repository.worktreeDigest !== current.repository.worktreeDigest
  ) {
    return deepFreeze({ class: 'refreshable', changedFields });
  }
  return deepFreeze({ class: 'non-semantic', changedFields });
}

export function projectLegacyProviderInvocation(input: {
  record: ProviderInvocationRecord;
  epoch: number;
  contractVersion: number;
  contextDigest: string;
  engineBinding: string;
  executionPolicy: ExecutionPolicySnapshot;
  environmentDigest: string;
  semanticJobIdentityDigest?: string;
  retryPolicy: RetryPolicy;
}): ProviderInvocationProjection {
  const record = input.record;
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(record.state)
  ) {
    throw executionError(
      'LEGACY_INVOCATION_INVALID',
      'The legacy ProviderInvocationRecord cannot be projected safely.',
      ExitCode.guard,
    );
  }
  const workflowId = assertIdentifier(record.investigationId, 'workflowId');
  const epoch = assertPositiveInteger(input.epoch, 'epoch');
  const contractVersion = assertPositiveInteger(
    input.contractVersion,
    'contractVersion',
  );
  const contextDigest = assertDigest(input.contextDigest);
  const engineBinding = assertDigest(input.engineBinding);
  const executionPolicy = assertExecutionPolicy(input.executionPolicy);
  if (executionPolicy.provider !== record.providerId) {
    throw executionInvalid(
      'Legacy projection provider policy does not match the record.',
    );
  }
  const createdAt = assertTimestamp(record.createdAt);
  const updatedAt = assertTimestamp(record.updatedAt);
  const attemptId = assertIdentifier(
    `attempt-legacy-${record.invocationId}`,
    'attemptId',
  );
  // A legacy retry used a fresh invocationId for each process. Binding Job
  // identity to invocationId would therefore turn an attempt retry into a new
  // logical Job. The investigation/stage pair is the stable legacy semantic
  // identity; a digest keeps the projected identifier bounded and canonical.
  const jobIdentityDigest = digestCanonical({
    kind: 'legacy-provider-job',
    workflowId,
    stage: record.purpose,
    ...(input.semanticJobIdentityDigest === undefined
      ? {}
      : {
          semanticJobIdentityDigest: assertDigest(
            input.semanticJobIdentityDigest,
          ),
        }),
  }).slice('sha256:'.length, 'sha256:'.length + 32);
  const jobId = assertIdentifier(
    `job-legacy-${record.purpose}-${jobIdentityDigest}`,
    'jobId',
  );
  const semanticSpec: SemanticJobSpec = {
    schemaVersion: 1,
    contractVersion,
    stage: assertIdentifier(record.purpose, 'stage'),
    contextDigest,
    // The provider request includes execution details and invocation identity;
    // the manifest is the immutable semantic input shared by legacy retries.
    inputDigest: normalizeDigest(record.manifestDigest),
    outputContractDigest: digestCanonical({
      kind: 'legacy-provider-output-contract',
      purpose: record.purpose,
      schemaVersion: 1,
    }),
    acceptancePolicyDigest: digestCanonical({
      kind: 'legacy-provider-acceptance',
      purpose: record.purpose,
      schemaVersion: 1,
    }),
  };
  const requestDigest = digestCanonical({
    kind: 'semantic-job-spec',
    jobId,
    workflowId,
    epoch,
    ...(record.mandateBinding === undefined
      ? {}
      : {
          mandateBinding: assertExecutionJobMandateBinding(
            record.mandateBinding,
          ),
        }),
    semanticSpec,
  });
  const attemptRequestDigest = normalizeDigest(record.requestDigest);
  const status = legacyAttemptStatus(record);
  const acceptedAttemptId = status === 'succeeded' ? attemptId : null;
  const jobStatus = legacyJobStatus(record);
  const failure = legacyFailure(
    record,
    semanticSpec.inputDigest,
    input.environmentDigest,
  );
  const lease =
    record.lease === null
      ? null
      : {
          generation: record.lease.generation,
          workerId: assertIdentifier(record.lease.workerId, 'workerId'),
          tokenDigest: normalizeDigest(record.lease.tokenDigest),
          acquiredAt: assertTimestamp(record.lease.acquiredAt),
          expiresAt: assertTimestamp(record.lease.expiresAt),
        };
  const workflow: WorkflowRecord = {
    schemaVersion: 2,
    workflowId,
    currentEpoch: epoch,
    contractVersion,
    contextDigest,
    checkpoint: record.purpose,
    status: 'active',
    blocker: null,
    engineBinding,
  };
  const job: JobRecord = {
    schemaVersion: 2,
    jobId,
    workflowId,
    epoch,
    ...(record.mandateBinding === undefined
      ? {}
      : {
          mandateBinding: assertExecutionJobMandateBinding(
            record.mandateBinding,
          ),
        }),
    stage: semanticSpec.stage,
    contextDigest,
    requestDigest,
    semanticSpec,
    status: jobStatus,
    acceptedAttemptId,
    attemptCount: record.attempt,
    cumulativeRuntimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    repairAttemptCount: 0,
    retryPolicy: assertRetryPolicy(input.retryPolicy),
    createdAt,
    updatedAt,
  };
  const attempt: AttemptRecord = {
    schemaVersion: 2,
    attemptId,
    jobId,
    workflowId,
    epoch,
    attemptNumber: record.attempt,
    retryOf: null,
    provider: executionPolicy.provider,
    status,
    inputDigest: semanticSpec.inputDigest,
    requestDigest: attemptRequestDigest,
    contextDigest,
    environmentDigest: assertDigest(input.environmentDigest),
    retryMode: record.attempt === 1 ? 'none' : 'same-input',
    policySnapshot: executionPolicy,
    changedFields: [],
    repairContext: null,
    strategyChanges: [],
    grantId: null,
    failure,
    failureFingerprint: failure?.fingerprint ?? null,
    leaseGeneration: record.leaseGeneration,
    lease,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: status === 'succeeded' ? 'active' : 'debug',
    legacyInvocation: {
      invocationId: assertIdentifier(record.invocationId, 'invocationId'),
      legacyAttempt: record.attempt,
      legacyRevision: record.revision,
    },
    createdAt,
    updatedAt,
  };
  return deepFreeze({
    workflow: assertWorkflowRecord(workflow),
    job: assertJobRecord(job),
    attempt: assertAttemptRecord(attempt),
  });
}

export function canonicalWorkflowRecord(record: WorkflowRecord): string {
  return `${canonicalJson(assertWorkflowRecord(record))}\n`;
}

export function canonicalJobRecord(record: JobRecord): string {
  return `${canonicalJson(assertJobRecord(record))}\n`;
}

export function canonicalAttemptRecord(record: AttemptRecord): string {
  return `${canonicalJson(assertAttemptRecord(record))}\n`;
}

export function canonicalAttemptResult(result: AttemptResult): string {
  return `${canonicalJson(assertAttemptResult(result))}\n`;
}

export function parseWorkflowRecord(raw: string): WorkflowRecord {
  return parseCanonicalRecord(raw, assertWorkflowRecord);
}

export function parseJobRecord(raw: string): JobRecord {
  return parseCanonicalRecord(raw, assertJobRecord);
}

export function parseAttemptRecord(raw: string): AttemptRecord {
  return parseCanonicalRecord(raw, assertAttemptRecord);
}

export function parseAttemptResult(raw: string): AttemptResult {
  return parseCanonicalRecord(raw, assertAttemptResult);
}

export function assertWorkflowRecord(value: WorkflowRecord): WorkflowRecord;
export function assertWorkflowRecord(value: unknown): WorkflowRecord;
export function assertWorkflowRecord(value: unknown): WorkflowRecord {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'blocker',
      'checkpoint',
      'contextDigest',
      'contractVersion',
      'currentEpoch',
      'engineBinding',
      'schemaVersion',
      'status',
      'workflowId',
    ]) ||
    value.schemaVersion !== 2 ||
    !WORKFLOW_STATUSES.has(value.status as WorkflowStatus)
  ) {
    throw executionInvalid('Workflow record is invalid.');
  }
  assertIdentifier(value.workflowId, 'workflowId');
  assertPositiveInteger(value.currentEpoch, 'currentEpoch');
  assertPositiveInteger(value.contractVersion, 'contractVersion');
  assertDigest(value.contextDigest);
  assertDigest(value.engineBinding);
  if (value.checkpoint !== null) {
    assertIdentifier(value.checkpoint, 'checkpoint');
  }
  assertWorkflowBlocker(value.blocker);
  return deepFreeze(structuredClone(value) as WorkflowRecord);
}

export function assertJobRecord(value: JobRecord): JobRecord;
export function assertJobRecord(value: unknown): JobRecord;
export function assertJobRecord(value: unknown): JobRecord {
  const legacyKeys = [
    'acceptedAttemptId',
    'attemptCount',
    'contextDigest',
    'createdAt',
    'cumulativeRuntimeMs',
    'epoch',
    'jobId',
    'providerCostMicros',
    'providerTokens',
    'repairAttemptCount',
    'requestDigest',
    'retryPolicy',
    'schemaVersion',
    'semanticSpec',
    'stage',
    'status',
    'updatedAt',
    'workflowId',
  ];
  if (
    !isPlainObject(value) ||
    !hasKeysEither(value, [legacyKeys, [...legacyKeys, 'mandateBinding']]) ||
    value.schemaVersion !== 2 ||
    !JOB_STATUSES.has(value.status as JobStatus)
  ) {
    throw executionInvalid('Job record is invalid.');
  }
  assertIdentifier(value.jobId, 'jobId');
  assertIdentifier(value.workflowId, 'workflowId');
  assertPositiveInteger(value.epoch, 'epoch');
  if (Object.prototype.hasOwnProperty.call(value, 'mandateBinding')) {
    assertExecutionJobMandateBinding(value.mandateBinding);
  }
  assertIdentifier(value.stage, 'stage');
  assertDigest(value.contextDigest);
  assertDigest(value.requestDigest);
  const semanticSpec = assertSemanticJobSpec(value.semanticSpec);
  if (
    semanticSpec.stage !== value.stage ||
    semanticSpec.contextDigest !== value.contextDigest
  ) {
    throw executionInvalid('Job semantic specification binding is invalid.');
  }
  if (value.acceptedAttemptId !== null) {
    assertIdentifier(value.acceptedAttemptId, 'acceptedAttemptId');
  }
  const attemptCount = assertNonnegativeInteger(
    value.attemptCount,
    'attemptCount',
  );
  if (attemptCount < 1) {
    throw executionInvalid('attemptCount must be positive.');
  }
  assertNonnegativeInteger(value.cumulativeRuntimeMs, 'cumulativeRuntimeMs');
  assertNonnegativeInteger(value.providerCostMicros, 'providerCostMicros');
  assertNonnegativeInteger(value.providerTokens, 'providerTokens');
  assertNonnegativeInteger(value.repairAttemptCount, 'repairAttemptCount');
  assertRetryPolicy(value.retryPolicy);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.updatedAt);
  if (
    Date.parse(value.updatedAt as string) <
    Date.parse(value.createdAt as string)
  ) {
    throw executionInvalid('Job timestamps are not monotonic.');
  }
  if ((value.status === 'succeeded') !== (value.acceptedAttemptId !== null)) {
    throw executionInvalid('Job accepted result and succeeded state disagree.');
  }
  return deepFreeze(structuredClone(value) as JobRecord);
}

export function requireExecutionJobMandateBinding(
  input: JobRecord,
): TaskMandateBinding {
  const job = assertJobRecord(input);
  if (job.mandateBinding === undefined) {
    throw executionError(
      'EXECUTION_JOB_MANDATE_REQUIRED',
      'A legacy Execution Job without a durable Task Mandate binding is read-only.',
      ExitCode.guard,
    );
  }
  return assertExecutionJobMandateBinding(job.mandateBinding);
}

export function assertAttemptRecord(value: AttemptRecord): AttemptRecord;
export function assertAttemptRecord(value: unknown): AttemptRecord;
export function assertAttemptRecord(value: unknown): AttemptRecord {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'attemptId',
      'attemptNumber',
      'changedFields',
      'contextDigest',
      'createdAt',
      'environmentDigest',
      'epoch',
      'failure',
      'failureFingerprint',
      'grantId',
      'inputDigest',
      'jobId',
      'lease',
      'leaseGeneration',
      'legacyInvocation',
      'policySnapshot',
      'provider',
      'providerCostMicros',
      'providerTokens',
      'repairContext',
      'requestDigest',
      'retention',
      'retryMode',
      'retryOf',
      'runtimeMs',
      'schemaVersion',
      'status',
      'strategyChanges',
      'updatedAt',
      'workflowId',
    ]) ||
    value.schemaVersion !== 2 ||
    !ATTEMPT_STATUSES.has(value.status as AttemptStatus) ||
    !RETRY_MODES.has(value.retryMode as RetryMode) ||
    !ATTEMPT_RETENTION.has(value.retention as AttemptRetention)
  ) {
    throw executionInvalid('Attempt record is invalid.');
  }
  assertIdentifier(value.attemptId, 'attemptId');
  assertIdentifier(value.jobId, 'jobId');
  assertIdentifier(value.workflowId, 'workflowId');
  assertPositiveInteger(value.epoch, 'epoch');
  assertPositiveInteger(value.attemptNumber, 'attemptNumber');
  if (value.retryOf !== null) assertIdentifier(value.retryOf, 'retryOf');
  assertIdentifier(value.provider, 'provider');
  assertDigest(value.inputDigest);
  assertDigest(value.requestDigest);
  assertDigest(value.contextDigest);
  assertDigest(value.environmentDigest);
  assertExecutionPolicy(value.policySnapshot);
  assertChangedFields(value.changedFields);
  if (value.repairContext !== null) {
    assertRepairContextShape(value.repairContext);
  }
  normalizeUniqueStrings(
    value.strategyChanges as string[],
    'strategyChanges',
    true,
  );
  if (value.grantId !== null) assertIdentifier(value.grantId, 'grantId');
  if (value.failure !== null) {
    const failure = assertFailureDescriptor(value.failure);
    if (value.failureFingerprint !== failure.fingerprint) {
      throw executionInvalid('Attempt failure fingerprint is inconsistent.');
    }
  } else if (value.failureFingerprint !== null) {
    throw executionInvalid('Attempt failure fingerprint has no descriptor.');
  }
  if (
    (['failed-retryable', 'failed-terminal', 'timed-out'].includes(
      value.status as string,
    ) &&
      value.failure === null) ||
    (['created', 'leased', 'running', 'succeeded'].includes(
      value.status as string,
    ) &&
      value.failure !== null)
  ) {
    throw executionInvalid(
      'Attempt terminal failure state and FailureDescriptor disagree.',
    );
  }
  assertNonnegativeInteger(value.leaseGeneration, 'leaseGeneration');
  assertAttemptLease(value.lease, value.leaseGeneration as number);
  assertNonnegativeInteger(value.runtimeMs, 'runtimeMs');
  assertNonnegativeInteger(value.providerCostMicros, 'providerCostMicros');
  assertNonnegativeInteger(value.providerTokens, 'providerTokens');
  assertLegacyInvocation(value.legacyInvocation);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.updatedAt);
  if (
    Date.parse(value.updatedAt as string) <
    Date.parse(value.createdAt as string)
  ) {
    throw executionInvalid('Attempt timestamps are not monotonic.');
  }
  return deepFreeze(structuredClone(value) as AttemptRecord);
}

export function assertAttemptResult(value: AttemptResult): AttemptResult;
export function assertAttemptResult(value: unknown): AttemptResult;
export function assertAttemptResult(value: unknown): AttemptResult {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'acceptance',
      'attemptId',
      'completedAt',
      'contextDigest',
      'epoch',
      'jobId',
      'outputDigest',
      'resultId',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    !['accepted', 'stale', 'late-duplicate'].includes(String(value.acceptance))
  ) {
    throw executionInvalid('Attempt result is invalid.');
  }
  assertDigest(value.resultId);
  assertIdentifier(value.workflowId, 'result workflowId');
  assertPositiveInteger(value.epoch, 'result epoch');
  assertDigest(value.contextDigest);
  assertIdentifier(value.jobId, 'result jobId');
  assertIdentifier(value.attemptId, 'result attemptId');
  assertDigest(value.outputDigest);
  assertTimestamp(value.completedAt);
  const identity = {
    workflowId: value.workflowId,
    epoch: value.epoch,
    contextDigest: value.contextDigest,
    jobId: value.jobId,
    attemptId: value.attemptId,
    outputDigest: value.outputDigest,
    acceptance: value.acceptance,
    completedAt: value.completedAt,
  };
  if (digestCanonical(identity) !== value.resultId) {
    throw executionInvalid('Attempt result identity digest is invalid.');
  }
  return deepFreeze(structuredClone(value) as AttemptResult);
}

function assertSemanticJobSpec(value: unknown): SemanticJobSpec {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'acceptancePolicyDigest',
      'contextDigest',
      'contractVersion',
      'inputDigest',
      'outputContractDigest',
      'schemaVersion',
      'stage',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw executionInvalid('Semantic Job specification is invalid.');
  }
  assertPositiveInteger(value.contractVersion, 'contractVersion');
  assertIdentifier(value.stage, 'stage');
  assertDigest(value.contextDigest);
  assertDigest(value.inputDigest);
  assertDigest(value.outputContractDigest);
  assertDigest(value.acceptancePolicyDigest);
  return deepFreeze(structuredClone(value) as SemanticJobSpec);
}

function assertExecutionPolicy(value: unknown): ExecutionPolicySnapshot {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'backoffMs',
      'concurrency',
      'maxOutputBytes',
      'processEnvironment',
      'provider',
      'schemaVersion',
      'timeoutMs',
      'transientToolConfig',
      'workerClass',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw executionInvalid('Execution policy snapshot is invalid.');
  }
  assertIdentifier(value.provider, 'provider');
  assertIdentifier(value.workerClass, 'workerClass');
  assertBoundedPositiveInteger(value.timeoutMs, 'timeoutMs', 3_600_000);
  assertBoundedPositiveInteger(
    value.maxOutputBytes,
    'maxOutputBytes',
    268_435_456,
  );
  assertBoundedNonnegativeInteger(value.backoffMs, 'backoffMs', 86_400_000);
  assertBoundedPositiveInteger(value.concurrency, 'concurrency', 1_024);
  assertStringRecord(value.processEnvironment, 'processEnvironment');
  assertPrimitiveRecord(value.transientToolConfig, 'transientToolConfig');
  return deepFreeze(structuredClone(value) as ExecutionPolicySnapshot);
}

function assertRetryPolicy(value: unknown): RetryPolicy {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'deadline',
      'maxAttempts',
      'maxCumulativeRuntimeMs',
      'maxProviderCostMicros',
      'maxProviderTokens',
      'maxRepairAttempts',
      'maxSameFailureFingerprint',
      'providerLimits',
    ])
  ) {
    throw executionInvalid('Retry policy is invalid.');
  }
  assertBoundedPositiveInteger(value.maxAttempts, 'maxAttempts', 1_000);
  assertBoundedPositiveInteger(
    value.maxCumulativeRuntimeMs,
    'maxCumulativeRuntimeMs',
    31_536_000_000,
  );
  assertBoundedNonnegativeInteger(
    value.maxProviderCostMicros,
    'maxProviderCostMicros',
    Number.MAX_SAFE_INTEGER,
  );
  assertBoundedNonnegativeInteger(
    value.maxProviderTokens,
    'maxProviderTokens',
    Number.MAX_SAFE_INTEGER,
  );
  assertBoundedPositiveInteger(
    value.maxSameFailureFingerprint,
    'maxSameFailureFingerprint',
    100,
  );
  assertBoundedNonnegativeInteger(
    value.maxRepairAttempts,
    'maxRepairAttempts',
    100,
  );
  assertTimestamp(value.deadline);
  if (!isPlainObject(value.providerLimits)) {
    throw executionInvalid('providerLimits is invalid.');
  }
  for (const [provider, limit] of Object.entries(value.providerLimits)) {
    assertIdentifier(provider, 'providerLimits key');
    assertBoundedPositiveInteger(limit, 'provider limit', 1_000);
  }
  assertSortedObjectKeys(value.providerLimits, 'providerLimits');
  return deepFreeze(structuredClone(value) as RetryPolicy);
}

function assertFailureDescriptor(value: unknown): FailureDescriptor {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'code',
      'environmentDigest',
      'fingerprint',
      'inputDigest',
      'observedAt',
      'paths',
      'retryAfterMs',
      'retryClass',
      'schemaVersion',
      'sideEffectState',
      'source',
      'stage',
      'validatorPath',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw executionInvalid('Failure descriptor is invalid.');
  }
  const rebuilt = createFailureDescriptor({
    stage: value.stage as string,
    code: value.code as string,
    source: value.source as FailureSource,
    retryClass: value.retryClass as FailureDescriptor['retryClass'],
    sideEffectState:
      value.sideEffectState as FailureDescriptor['sideEffectState'],
    paths: value.paths as string[],
    validatorPath: value.validatorPath as string | null,
    inputDigest: value.inputDigest as string,
    environmentDigest: value.environmentDigest as string,
    observedAt: value.observedAt as string,
    retryAfterMs:
      value.retryAfterMs === null ? undefined : (value.retryAfterMs as number),
  });
  if (
    rebuilt.fingerprint !== value.fingerprint ||
    canonicalJson(rebuilt) !== canonicalJson(value)
  ) {
    throw executionInvalid('Failure descriptor is not canonical.');
  }
  return rebuilt;
}

function assertEnvironmentSnapshot(value: unknown): EnvironmentSnapshot {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'capabilities',
      'provider',
      'repository',
      'runtime',
      'schemaVersion',
      'tools',
    ]) ||
    value.schemaVersion !== 1 ||
    !isPlainObject(value.repository) ||
    !hasExactKeys(value.repository, ['head', 'treeDigest', 'worktreeDigest']) ||
    !isPlainObject(value.runtime) ||
    !hasExactKeys(value.runtime, ['node', 'platform']) ||
    !isPlainObject(value.provider) ||
    !hasExactKeys(value.provider, ['adapter', 'timeoutMs', 'version']) ||
    !Array.isArray(value.tools) ||
    !isPlainObject(value.capabilities) ||
    !hasExactKeys(value.capabilities, [
      'network',
      'readRepository',
      'writeWorkspace',
    ])
  ) {
    throw executionInvalid('Environment snapshot is invalid.');
  }
  if (
    typeof value.repository.head !== 'string' ||
    !GIT_OBJECT_ID.test(value.repository.head)
  ) {
    throw executionInvalid('Environment repository head is invalid.');
  }
  assertDigest(value.repository.treeDigest);
  assertDigest(value.repository.worktreeDigest);
  assertBoundedString(value.runtime.node, 'runtime.node');
  assertBoundedString(value.runtime.platform, 'runtime.platform');
  assertIdentifier(value.provider.adapter, 'provider.adapter');
  assertBoundedString(value.provider.version, 'provider.version');
  assertBoundedPositiveInteger(
    value.provider.timeoutMs,
    'provider.timeoutMs',
    3_600_000,
  );
  const toolNames: string[] = [];
  for (const tool of value.tools) {
    if (
      !isPlainObject(tool) ||
      !hasExactKeys(tool, ['available', 'name', 'version']) ||
      typeof tool.available !== 'boolean' ||
      (tool.version !== null && typeof tool.version !== 'string')
    ) {
      throw executionInvalid('Environment tool observation is invalid.');
    }
    assertIdentifier(tool.name, 'tool.name');
    if (tool.version !== null)
      assertBoundedString(tool.version, 'tool.version');
    toolNames.push(tool.name as string);
  }
  if (
    canonicalJson(toolNames) !==
      canonicalJson([...new Set(toolNames)].sort()) ||
    typeof value.capabilities.network !== 'boolean' ||
    typeof value.capabilities.readRepository !== 'boolean' ||
    typeof value.capabilities.writeWorkspace !== 'boolean'
  ) {
    throw executionInvalid('Environment snapshot is not canonical.');
  }
  return deepFreeze(structuredClone(value) as EnvironmentSnapshot);
}

function assertWorkflowBlocker(value: unknown): void {
  if (value === null) return;
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      'blockedBy',
      'checkpointId',
      'detailsDigest',
      'jobId',
      'kind',
      'retryAt',
      'since',
    ]) ||
    !WORKFLOW_BLOCKERS.has(value.kind as WorkflowBlocker['kind'])
  ) {
    throw executionInvalid('Workflow blocker is invalid.');
  }
  assertTimestamp(value.since);
  if (value.jobId !== undefined) assertIdentifier(value.jobId, 'blocker.jobId');
  if (value.retryAt !== undefined) assertTimestamp(value.retryAt);
  if (value.detailsDigest !== undefined) assertDigest(value.detailsDigest);
  if (value.checkpointId !== undefined)
    assertIdentifier(value.checkpointId, 'blocker.checkpointId');
  if (value.blockedBy !== undefined)
    assertIdentifier(value.blockedBy, 'blocker.blockedBy');
}

function assertRepairContext(
  value: RepairContext,
  job: JobRecord,
): RepairContext {
  const context = assertRepairContextShape(value);
  if (
    context.epoch !== job.epoch ||
    context.contextDigest !== job.contextDigest
  ) {
    throw executionError(
      'RETRY_REPAIR_CONTEXT_STALE',
      'Repair context is not bound to the current Job epoch.',
      ExitCode.staleState,
    );
  }
  return context;
}

function assertRepairContextShape(value: unknown): RepairContext {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'contextDigest',
      'epoch',
      'instruction',
      'previousOutputDigest',
      'targetSchemaDigest',
      'validationErrors',
    ]) ||
    value.instruction !== 'return-complete-replacement-object' ||
    !Array.isArray(value.validationErrors)
  ) {
    throw executionInvalid('Repair context is invalid.');
  }
  assertDigest(value.previousOutputDigest);
  assertDigest(value.targetSchemaDigest);
  assertPositiveInteger(value.epoch, 'repair epoch');
  assertDigest(value.contextDigest);
  let previousKey = '';
  for (const error of value.validationErrors) {
    if (
      !isPlainObject(error) ||
      !hasExactKeys(error, ['code', 'message', 'path'])
    ) {
      throw executionInvalid('Repair validation error is invalid.');
    }
    const pointer = assertJsonPointer(error.path, 'repair error path');
    const code = assertErrorCode(error.code);
    assertBoundedString(error.message, 'repair error message');
    const key = `${pointer}\u0000${code}`;
    if (key <= previousKey) {
      throw executionInvalid(
        'Repair validation errors are not sorted and unique.',
      );
    }
    previousKey = key;
  }
  return deepFreeze(structuredClone(value) as RepairContext);
}

function assertChangedFields(value: unknown): void {
  if (!Array.isArray(value))
    throw executionInvalid('changedFields is invalid.');
  let previous = '';
  for (const entry of value) {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['from', 'path', 'to'])) {
      throw executionInvalid('changedFields entry is invalid.');
    }
    const pointer = assertJsonPointer(entry.path, 'changedFields path');
    canonicalJson(entry.from);
    canonicalJson(entry.to);
    if (
      pointer <= previous ||
      canonicalJson(entry.from) === canonicalJson(entry.to)
    ) {
      throw executionInvalid('changedFields is not canonical.');
    }
    previous = pointer;
  }
}

function assertAttemptLease(value: unknown, generation: number): void {
  if (value === null) return;
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'acquiredAt',
      'expiresAt',
      'generation',
      'tokenDigest',
      'workerId',
    ]) ||
    value.generation !== generation
  ) {
    throw executionInvalid('Attempt lease is invalid.');
  }
  assertPositiveInteger(value.generation, 'lease generation');
  assertIdentifier(value.workerId, 'lease workerId');
  assertDigest(value.tokenDigest);
  assertTimestamp(value.acquiredAt);
  assertTimestamp(value.expiresAt);
  if (
    Date.parse(value.expiresAt as string) <=
    Date.parse(value.acquiredAt as string)
  ) {
    throw executionInvalid('Attempt lease expiry is invalid.');
  }
}

function assertLegacyInvocation(value: unknown): void {
  if (value === null) return;
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['invocationId', 'legacyAttempt', 'legacyRevision'])
  ) {
    throw executionInvalid('Legacy invocation projection is invalid.');
  }
  assertIdentifier(value.invocationId, 'legacy invocationId');
  assertPositiveInteger(value.legacyAttempt, 'legacy attempt');
  assertNonnegativeInteger(value.legacyRevision, 'legacy revision');
}

function assertExecutionBudgetGrantRequest(
  value: unknown,
  job: JobRecord,
): GrantRequest {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'createdAt',
      'epoch',
      'expiresAfterAttempts',
      'jobId',
      'kind',
      'mandateBinding',
      'rationale',
      'requestId',
      'requestedChanges',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-grant-request' ||
    !Array.isArray(value.requestedChanges) ||
    value.requestedChanges.length < 1 ||
    value.requestedChanges.length > 16
  ) {
    throw executionInvalid('Execution budget grant request is invalid.');
  }
  if (
    typeof value.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.requestId,
    )
  ) {
    throw executionInvalid('Execution budget grant requestId is invalid.');
  }
  assertIdentifier(value.workflowId, 'grant workflowId');
  assertPositiveInteger(value.epoch, 'grant epoch');
  assertIdentifier(value.jobId, 'grant jobId');
  const jobBinding = requireExecutionJobMandateBinding(job);
  const requestBinding = assertExecutionJobMandateBinding(value.mandateBinding);
  let previousChange = '';
  for (const change of value.requestedChanges) {
    if (
      !isPlainObject(change) ||
      !hasExactKeys(change, ['from', 'path', 'to'])
    ) {
      throw executionInvalid('Execution budget requested change is invalid.');
    }
    const pointer = assertJsonPointer(change.path, 'grant requested path');
    canonicalJson(change.from);
    canonicalJson(change.to);
    if (
      pointer <= previousChange ||
      canonicalJson(change.from) === canonicalJson(change.to)
    ) {
      throw executionInvalid(
        'Execution budget requested changes are not canonical.',
      );
    }
    previousChange = pointer;
  }
  assertBoundedString(value.rationale, 'grant rationale');
  assertBoundedPositiveInteger(
    value.expiresAfterAttempts,
    'grant expiresAfterAttempts',
    16,
  );
  assertTimestamp(value.createdAt);
  if (
    value.workflowId !== job.workflowId ||
    value.epoch !== job.epoch ||
    value.jobId !== job.jobId ||
    canonicalJson(requestBinding) !== canonicalJson(jobBinding)
  ) {
    throw executionError(
      'EXECUTION_GRANT_REQUEST_BINDING_INVALID',
      'The bounded GrantRequest is not bound to the Job.',
      ExitCode.guard,
    );
  }
  return deepFreeze(structuredClone(value) as GrantRequest);
}

function assertAttemptFence(
  attempt: AttemptRecord,
  generation: number,
  token: string,
  completedAt: string,
): void {
  if (
    attempt.lease === null ||
    !Number.isSafeInteger(generation) ||
    generation !== attempt.leaseGeneration ||
    generation !== attempt.lease.generation ||
    typeof token !== 'string' ||
    !constantTimeEqual(attempt.lease.tokenDigest, digestText(token)) ||
    Date.parse(completedAt) > Date.parse(attempt.lease.expiresAt)
  ) {
    throw executionError(
      'ATTEMPT_FENCE_REJECTED',
      'The Attempt result was produced by an expired or stale lease holder.',
      ExitCode.staleState,
    );
  }
}

export function createAttemptResult(
  inputAttempt: AttemptRecord,
  inputOutputDigest: string,
  acceptance: AttemptResult['acceptance'],
  inputCompletedAt: string,
): AttemptResult {
  const attempt = assertAttemptRecord(inputAttempt);
  const outputDigest = assertDigest(inputOutputDigest);
  const completedAt = assertTimestamp(inputCompletedAt);
  if (!['accepted', 'stale', 'late-duplicate'].includes(acceptance)) {
    throw executionInvalid('Attempt result acceptance is invalid.');
  }
  const identity = {
    workflowId: attempt.workflowId,
    epoch: attempt.epoch,
    contextDigest: attempt.contextDigest,
    jobId: attempt.jobId,
    attemptId: attempt.attemptId,
    outputDigest,
    acceptance,
    completedAt,
  };
  return assertAttemptResult({
    schemaVersion: 1,
    resultId: digestCanonical(identity),
    ...identity,
  });
}

function isWithinAutomaticBudget(input: {
  job: JobRecord;
  attempt: AttemptRecord;
  failure: FailureDescriptor;
  providerAttemptCount?: number;
  nextRuntimeMs?: number;
  nextProviderCostMicros?: number;
  nextProviderTokens?: number;
  now: string;
}): boolean {
  const { job, attempt, failure } = input;
  const providerLimit = job.retryPolicy.providerLimits[attempt.provider];
  const providerAttemptCount = input.providerAttemptCount ?? job.attemptCount;
  const nextRuntimeMs = input.nextRuntimeMs ?? attempt.policySnapshot.timeoutMs;
  const nextProviderCostMicros = input.nextProviderCostMicros ?? 0;
  const nextProviderTokens = input.nextProviderTokens ?? 0;
  for (const [value, label] of [
    [providerAttemptCount, 'providerAttemptCount'],
    [nextRuntimeMs, 'nextRuntimeMs'],
    [nextProviderCostMicros, 'nextProviderCostMicros'],
    [nextProviderTokens, 'nextProviderTokens'],
  ] as const) {
    assertNonnegativeInteger(value, label);
  }
  return (
    job.attemptCount < job.retryPolicy.maxAttempts &&
    job.cumulativeRuntimeMs + nextRuntimeMs <=
      job.retryPolicy.maxCumulativeRuntimeMs &&
    job.providerCostMicros + nextProviderCostMicros <=
      job.retryPolicy.maxProviderCostMicros &&
    job.providerTokens + nextProviderTokens <=
      job.retryPolicy.maxProviderTokens &&
    (providerLimit === undefined || providerAttemptCount < providerLimit) &&
    (failure.retryClass !== 'repairable' ||
      job.repairAttemptCount < job.retryPolicy.maxRepairAttempts) &&
    Date.parse(input.now) < Date.parse(job.retryPolicy.deadline)
  );
}

function inferRetryMode(
  failure: FailureDescriptor,
  attempt: AttemptRecord,
  currentPolicyInput?: ExecutionPolicySnapshot,
): Exclude<RetryMode, 'new-context' | 'none'> {
  if (failure.retryClass === 'repairable') return 'repair';
  if (currentPolicyInput !== undefined) {
    const currentPolicy = assertExecutionPolicy(currentPolicyInput);
    if (
      canonicalJson(currentPolicy) !== canonicalJson(attempt.policySnapshot)
    ) {
      return 'execution-policy-change';
    }
  }
  return 'same-input';
}

function noRetry(reasonCode: string): RetryDecision {
  return deepFreeze({
    retryable: false,
    automatic: false,
    retryMode: 'none',
    reasonCode,
  });
}

function grantDecision(
  requiredGrant: GrantRequest,
  reasonCode: string,
): RetryDecision {
  return deepFreeze({
    retryable: true,
    automatic: false,
    retryMode: 'none',
    requiredGrant,
    reasonCode,
  });
}

function composeAttemptRequestDigest(input: {
  jobId: string;
  attemptNumber: number;
  semanticSpec: SemanticJobSpec;
  executionPolicy: ExecutionPolicySnapshot;
  retryMode: RetryMode;
  repairContext: RepairContext | null;
  strategyChanges: string[];
  grantId: string | null;
}): string {
  return digestCanonical({
    kind: 'attempt-request',
    schemaVersion: 2,
    ...input,
  });
}

function legacyAttemptStatus(record: ProviderInvocationRecord): AttemptStatus {
  if (record.state === 'prepared') return 'created';
  if (record.state === 'leased') return 'leased';
  if (record.state === 'succeeded') return 'succeeded';
  if (record.failure?.code.toUpperCase().includes('TIMEOUT') === true) {
    return 'timed-out';
  }
  if (
    record.failure?.executionKind === 'needs-user-decision' ||
    record.failure?.code === 'NEEDS_USER_DECISION'
  ) {
    return 'failed-terminal';
  }
  return record.failure?.kind === 'retryable'
    ? 'failed-retryable'
    : 'failed-terminal';
}

function legacyJobStatus(record: ProviderInvocationRecord): JobStatus {
  if (record.state === 'prepared') return 'queued';
  if (record.state === 'leased') return 'running';
  if (record.state === 'succeeded') return 'succeeded';
  return record.failure?.kind === 'retryable'
    ? 'waiting-retry'
    : 'failed-terminal';
}

function legacyFailure(
  record: ProviderInvocationRecord,
  inputDigest: string,
  environmentDigest: string,
): FailureDescriptor | null {
  if (record.failure === null) return null;
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(record.failure.code)
    ? record.failure.code
    : 'LEGACY_PROVIDER_FAILURE';
  const classification =
    record.failure.executionKind === undefined
      ? classifyLegacyProviderFailure(code, record.failure.kind)
      : classifyExecutionFailure({
          kind: record.failure.executionKind,
          stage: record.purpose,
          inputDigest,
          environmentDigest,
          observedAt: record.updatedAt,
          ...(record.failure.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: record.failure.retryAfterMs }),
        });
  return createFailureDescriptor({
    stage: record.purpose,
    code,
    source: classification.source,
    retryClass: classification.retryClass,
    sideEffectState: classification.sideEffectState,
    paths: [],
    validatorPath: null,
    inputDigest,
    environmentDigest: assertDigest(environmentDigest),
    observedAt: record.updatedAt,
    retryAfterMs: record.failure.retryAfterMs,
  });
}

function classifyLegacyProviderFailure(
  code: string,
  kind: 'retryable' | 'repository-reconciliation-required',
): Pick<FailureDescriptor, 'source' | 'retryClass' | 'sideEffectState'> {
  if (kind === 'repository-reconciliation-required') {
    return {
      source: 'effect',
      retryClass: 'terminal',
      sideEffectState: 'unknown',
    };
  }
  if (code.includes('STATE_CORRUPTION')) {
    return {
      source: 'state',
      retryClass: 'terminal',
      sideEffectState: 'none',
    };
  }
  if (
    code.includes('SCHEMA') ||
    code.includes('JSON_PARSE') ||
    code.includes('REQUIRED_FIELD') ||
    code.includes('CITATION') ||
    code.includes('NATIVE_OUTPUT_INVALID')
  ) {
    return {
      source: 'validator',
      retryClass: 'repairable',
      sideEffectState: 'none',
    };
  }
  const source: FailureSource = code.includes('NETWORK')
    ? 'network'
    : code.includes('WORKER')
      ? 'worker'
      : code.includes('LEASE')
        ? 'lease'
        : code.includes('PROBE')
          ? 'environment'
          : code.includes('FILE_LOCK') || code.includes('TOOL')
            ? 'tool'
            : 'provider';
  return { source, retryClass: 'retryable', sideEffectState: 'none' };
}

function parseCanonicalRecord<T>(
  raw: string,
  assertRecord: (value: unknown) => T,
): T {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES ||
    !raw.endsWith('\n') ||
    raw.endsWith('\n\n')
  ) {
    throw executionError(
      'EXECUTION_RECORD_NONCANONICAL',
      'Execution record bytes are not canonical.',
      ExitCode.guard,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw executionError(
      'EXECUTION_RECORD_INVALID',
      'Execution record JSON is invalid.',
      ExitCode.guard,
    );
  }
  const record = assertRecord(parsed);
  if (`${canonicalJson(record)}\n` !== raw) {
    throw executionError(
      'EXECUTION_RECORD_NONCANONICAL',
      'Execution record bytes are not canonical.',
      ExitCode.guard,
    );
  }
  return record;
}

function diffJson(
  before: JsonValue,
  after: JsonValue,
  basePath = '',
  ignored = new Set<string>(),
): ChangedField[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].sort();
    const changes: ChangedField[] = [];
    for (const key of keys) {
      const path = `${basePath}/${escapeJsonPointer(key)}`;
      if (ignored.has(path)) continue;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
        changes.push({
          path,
          from: Object.hasOwn(before, key) ? before[key]! : null,
          to: Object.hasOwn(after, key) ? after[key]! : null,
        });
      } else {
        changes.push(...diffJson(before[key]!, after[key]!, path, ignored));
      }
    }
    return changes;
  }
  return [{ path: basePath || '/', from: before, to: after }];
}

function assertEnvironmentRecordValue(
  value: unknown,
): asserts value is JsonValue {
  canonicalJson(value);
}

function assertStringRecord(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw executionInvalid(`${label} is invalid.`);
  assertSortedObjectKeys(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof entry !== 'string') {
      throw executionInvalid(`${label} is invalid.`);
    }
    assertBoundedString(entry, `${label}.${key}`);
  }
}

function assertPrimitiveRecord(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw executionInvalid(`${label} is invalid.`);
  assertSortedObjectKeys(value, label);
  for (const [key, entry] of Object.entries(value)) {
    assertIdentifier(key, `${label} key`);
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw executionInvalid(`${label} is invalid.`);
    }
    assertEnvironmentRecordValue(entry);
  }
}

function assertSortedObjectKeys(
  value: Record<string, unknown>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
    throw executionInvalid(`${label} keys are not canonically sorted.`);
  }
}

function normalizeUniqueStrings(
  value: string[],
  label: string,
  requireCanonical = false,
): string[] {
  if (!Array.isArray(value)) throw executionInvalid(`${label} is invalid.`);
  for (const entry of value) assertBoundedString(entry, label);
  const normalized = [...new Set(value)].sort();
  if (requireCanonical && canonicalJson(normalized) !== canonicalJson(value)) {
    throw executionInvalid(`${label} is not sorted and unique.`);
  }
  return deepFreeze(normalized);
}

function normalizeFailurePaths(value: string[]): string[] {
  if (!Array.isArray(value))
    throw executionInvalid('Failure paths are invalid.');
  const normalized = value.map((entry) => {
    if (entry.startsWith('/')) return assertJsonPointer(entry, 'failure path');
    if (!isSafeRepositoryRelativePath(entry)) {
      throw executionInvalid('Failure path is unsafe.');
    }
    return entry;
  });
  return deepFreeze([...new Set(normalized)].sort());
}

function assertJsonPointer(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !value.startsWith('/') ||
    /~(?![01])/.test(value) ||
    Buffer.byteLength(value, 'utf8') > 2_048
  ) {
    throw executionInvalid(`${label} is not a canonical JSON pointer.`);
  }
  return value;
}

function isSafeRepositoryRelativePath(value: string): boolean {
  return (
    value === value.normalize('NFC') &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

function normalizeDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  if (LEGACY_DIGEST.test(value)) return `sha256:${value}`;
  throw executionInvalid('Digest is invalid.');
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw executionInvalid('Digest is invalid.');
  }
  return value;
}

function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER.test(value) ||
    value !== value.normalize('NFC')
  ) {
    throw executionInvalid(`${label} is invalid.`);
  }
  return value;
}

function assertExecutionJobMandateBinding(value: unknown): TaskMandateBinding {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
    typeof value.mandateId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) ||
    typeof value.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot
  ) {
    throw executionInvalid('Execution Job Task Mandate binding is invalid.');
  }
  return deepFreeze(structuredClone(value) as TaskMandateBinding);
}

function assertErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) {
    throw executionInvalid('Failure code is invalid.');
  }
  return value;
}

function assertTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw executionInvalid('Timestamp is invalid.');
  }
  return value;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw executionInvalid(`${label} must be a positive integer.`);
  }
  return value as number;
}

function assertNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw executionInvalid(`${label} must be a nonnegative integer.`);
  }
  return value as number;
}

function assertBoundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const result = assertPositiveInteger(value, label);
  if (result > maximum) throw executionInvalid(`${label} exceeds its bound.`);
  return result;
}

function assertBoundedNonnegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const result = assertNonnegativeInteger(value, label);
  if (result > maximum) throw executionInvalid(`${label} exceeds its bound.`);
  return result;
}

function assertBoundedString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ||
    value !== value.normalize('NFC')
  ) {
    throw executionInvalid(`${label} is invalid.`);
  }
  return value;
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return canonicalJson(actual) === canonicalJson(expected);
}

function hasKeysEither(
  value: Record<string, unknown>,
  variants: string[][],
): boolean {
  return variants.some((keys) => hasExactKeys(value, keys));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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

function executionInvalid(message: string) {
  return executionError('EXECUTION_RECORD_INVALID', message, ExitCode.guard);
}

function probeNotAllowed() {
  return executionError(
    'EXECUTION_PROBE_NOT_ALLOWED',
    'The requested environment probe is not on the read-only allowlist.',
    ExitCode.guard,
  );
}

function executionError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

const WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'active',
  'completed',
  'cancelled',
  'superseded',
]);
const WORKFLOW_BLOCKERS = new Set<WorkflowBlocker['kind']>([
  'retry-delay',
  'provider-capacity',
  'human-grant',
  'human-input',
  'configuration',
  'dependency',
  'manual-reconciliation',
  'harness-intervention',
]);
const JOB_STATUSES = new Set<JobStatus>([
  'queued',
  'running',
  'waiting-retry',
  'waiting-grant',
  'waiting-human-input',
  'succeeded',
  'failed-terminal',
  'stale',
  'cancelled',
]);
const ATTEMPT_STATUSES = new Set<AttemptStatus>([
  'created',
  'leased',
  'running',
  'succeeded',
  'failed-retryable',
  'failed-terminal',
  'timed-out',
  'stale',
  'late-duplicate',
  'cancelled',
]);
const RETRY_MODES = new Set<RetryMode>([
  'same-input',
  'execution-policy-change',
  'repair',
  'strategy-change',
  'new-context',
  'none',
]);
const ATTEMPT_RETENTION = new Set<AttemptRetention>([
  'active',
  'debug',
  'pinned',
]);
const FAILURE_SOURCES = new Set<FailureSource>([
  'provider',
  'network',
  'worker',
  'lease',
  'tool',
  'validator',
  'environment',
  'state',
  'effect',
  'policy',
]);
const READ_ONLY_PROBE_KINDS = new Set<ReadOnlyProbeKind>([
  'repository-head',
  'repository-dirty-state',
  'runtime-version',
  'adapter-version',
  'binary-exists',
  'file-read',
  'validator-error',
  'execution-limits',
  'lease-state',
  'attempt-lineage',
  'dependency-availability',
]);
