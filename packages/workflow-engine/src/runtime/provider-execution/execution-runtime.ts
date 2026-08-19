import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertAttemptRecord,
  assertJobRecord,
  assertWorkflowRecord,
  createReplacementAttempt,
  projectLegacyProviderInvocation,
  type AttemptRecord,
  type ChangedField,
  type ExecutionPolicySnapshot,
  type FailureDescriptor,
  type JobRecord,
  type ProviderInvocationProjection,
  type RetryDecision,
  type RetryPolicy,
  type WorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  decideLegacyExecutionFailure,
  readExecutionJobState,
  type DurableExecutionJobState,
} from '../storage-journal/execution-store.ts';
import {
  type ExecutionBudgetConsumeReceipt,
  type GrantRequest,
} from '../../modules/authority/execution-governance.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { listProviderInvocationLifecycleProjections } from '../storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../../lifecycle-context.ts';
import {
  providerOutputSchemaGeneration,
  providerResidualsGeneration,
  readProviderInvocation,
  readProviderInvocationRequest,
  type ProviderInvocationRecord,
  type ProviderOutputSchemaGeneration,
  type ProviderResidualsGeneration,
} from '../storage-journal/provider-invocation-store.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_PROVIDER_TIMEOUT_MS = 3_600_000;
const LEGACY_EPOCH = 1;
const LEGACY_CONTRACT_VERSION = 1;
const LEGACY_MAX_ATTEMPTS = 4;
const RETRY_DEADLINE = '9999-12-31T23:59:59.999Z';

export type ExecutionResultView = {
  attemptId: string;
  invocationId: string;
  acceptance: 'accepted' | 'late-duplicate';
  outputDigest: string;
  /**
   * `legacy-superseded` marks a result whose output schema body changed after
   * the result was written, so its output kept its original binding instead of
   * being re-judged by the current grammar. It is never inferred from a schema
   * this engine does not own, only from an earlier generation of one it does.
   */
  outputSchema: ProviderOutputSchemaGeneration;
  /**
   * `legacy-subset` marks a result whose observation carries the residuals list
   * of the day it was written, from before a caveat this runner now names.
   * `missing` names every code it therefore does not carry, so a record
   * claiming fewer soft-containment caveats than today's runner says so rather
   * than passing as current. Null when the result holds no observation.
   */
  residuals: ProviderResidualsGeneration | null;
};

export type ExecutionFailureView = {
  attemptId: string;
  failure: FailureDescriptor;
  decision: RetryDecision;
};

export type ExecutionJobInspection = {
  schemaVersion: 1;
  workflow: WorkflowRecord;
  job: JobRecord;
  /**
   * `legacy-renumbered` marks a Job whose records do not carry the 1..N
   * ordinals the current writer assigns -- a legacy retry opened a fresh
   * invocation and left it numbered 1 -- so the ordinals below are the reader's,
   * derived from the order the records were observed in. The observed order is
   * still required to be monotonic, so this renames the attempts without
   * reordering the history.
   */
  attemptNumbering: 'recorded' | 'legacy-renumbered';
  attempts: AttemptRecord[];
  acceptedAttemptId: string | null;
  results: ExecutionResultView[];
  latestFailure: ExecutionFailureView | null;
};

export type LegacyReplacementPreview = {
  schemaVersion: 1;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  previousAttemptId: string;
  previewAttemptId: string;
  attemptNumber: number;
  retryMode: 'execution-policy-change';
  changedFields: ChangedField[];
  policySnapshot: ExecutionPolicySnapshot;
  requestDigest: string;
  grantId: string | null;
};

export type AuthorizedLegacyReplacement = {
  schemaVersion: 1;
  grantRequest: GrantRequest;
  preview: LegacyReplacementPreview;
  receipt: ExecutionBudgetConsumeReceipt;
};

type LegacyProjectionEntry = {
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  outputSchema: ProviderOutputSchemaGeneration;
  residuals: ProviderResidualsGeneration | null;
  projection: ProviderInvocationProjection;
};

export function listExecutionJobs(cwd: string): ExecutionJobInspection[] {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const entries = readLegacyProjectionEntries(cwd);
  const grouped = new Map<string, LegacyProjectionEntry[]>();
  for (const entry of entries) {
    const jobId = entry.projection.job.jobId;
    const group = grouped.get(jobId) ?? [];
    group.push(entry);
    grouped.set(jobId, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const jobId = group[0]!.projection.job.jobId;
      const durable = readExecutionJobState(runtime, jobId);
      return durable === null
        ? aggregateLegacyJob(group)
        : aggregateDurableJob(durable, group);
    });
}

export function inspectExecutionJob(
  cwd: string,
  requestedJobId: string,
): ExecutionJobInspection {
  const jobId = assertRuntimeJobId(requestedJobId);
  const inspection = listExecutionJobs(cwd).find(
    ({ job }) => job.jobId === jobId,
  );
  if (!inspection) {
    throw workflowError(
      'EXECUTION_RUNTIME_JOB_NOT_FOUND',
      `Execution Job ${jobId} was not found.`,
      ExitCode.staleState,
    );
  }
  return inspection;
}

export function prepareLegacyReplacement(
  cwd: string,
  requestedJobId: string,
  input: { timeoutMs: number; now?: string },
): LegacyReplacementPreview {
  const inspection = inspectExecutionJob(cwd, requestedJobId);
  if (inspection.latestFailure?.decision.requiredGrant !== undefined) {
    throw workflowError(
      'EXECUTION_RUNTIME_GRANT_REQUIRED',
      'The replacement requires the concrete execution-budget grant returned by inspection.',
      ExitCode.guard,
      {
        details: {
          grantRequest: inspection.latestFailure.decision.requiredGrant,
        },
      },
    );
  }
  return buildLegacyReplacementPreview(inspection, input, null);
}

/**
 * Build the exact replacement projection used by a future grant request. This
 * is read-only: unlike the deprecated authorization helper it never consumes a
 * grant or manufactures a receipt for a preview identity.
 */
export function previewLegacyReplacementGrantDelta(
  cwd: string,
  requestedJobId: string,
  input: { timeoutMs: number; now?: string },
): LegacyReplacementPreview {
  return buildLegacyReplacementPreview(
    inspectExecutionJob(cwd, requestedJobId),
    input,
    null,
    true,
  );
}

export function inspectLegacyExecutionJobSource(
  cwd: string,
  requestedJobId: string,
): LegacyProjectionEntry {
  const jobId = assertRuntimeJobId(requestedJobId);
  const entries = readLegacyProjectionEntries(cwd)
    .filter(({ projection }) => projection.job.jobId === jobId)
    .sort((left, right) => left.record.attempt - right.record.attempt);
  const latest = entries.at(-1);
  if (latest === undefined) {
    throw workflowError(
      'EXECUTION_RUNTIME_JOB_NOT_FOUND',
      `Execution Job ${jobId} was not found.`,
      ExitCode.staleState,
    );
  }
  return deepFreeze(structuredClone(latest));
}

export function authorizeLegacyReplacement(
  _cwd: string,
  _requestedJobId: string,
  _input: { grantId: string; timeoutMs: number; now?: string },
): AuthorizedLegacyReplacement {
  throw workflowError(
    'EXECUTION_RUNTIME_PREVIEW_AUTHORIZATION_DISABLED',
    'Preview authorization is disabled; persist a retry request and dispatch the real replacement with job retry.',
    ExitCode.guard,
  );
}

function buildLegacyReplacementPreview(
  inspection: ExecutionJobInspection,
  input: { timeoutMs: number; now?: string },
  grantId: string | null,
  pendingGrant = false,
): LegacyReplacementPreview {
  const previous = inspection.attempts.at(-1);
  if (
    previous === undefined ||
    inspection.acceptedAttemptId !== null ||
    !['failed-retryable', 'timed-out'].includes(previous.status) ||
    previous.failure === null
  ) {
    throw workflowError(
      'EXECUTION_RUNTIME_REPLACEMENT_NOT_ALLOWED',
      'The latest legacy Attempt is not eligible for replacement.',
      ExitCode.guard,
    );
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > MAX_PROVIDER_TIMEOUT_MS ||
    input.timeoutMs === previous.policySnapshot.timeoutMs
  ) {
    throw workflowError(
      'EXECUTION_RUNTIME_POLICY_CHANGE_INVALID',
      'Replacement timeout must be a different bounded positive value.',
      ExitCode.usage,
    );
  }
  const createdAt = assertExactTimestamp(input.now ?? previous.updatedAt);
  const previewAttemptId = `attempt-preview-${digestCanonical({
    jobId: inspection.job.jobId,
    previousAttemptId: previous.attemptId,
    timeoutMs: input.timeoutMs,
    grantId,
  }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
  const replacement = createReplacementAttempt({
    workflow: inspection.workflow,
    job: inspection.job,
    previousAttempt: previous,
    attemptId: previewAttemptId,
    retryMode: 'execution-policy-change',
    currentExecutionPolicy: previous.policySnapshot,
    policyOverrides: { timeoutMs: input.timeoutMs },
    ...(grantId === null && !pendingGrant
      ? {}
      : { grantId: grantId ?? 'pending-execution-budget-grant' }),
    environmentDigest: previous.environmentDigest,
    createdAt,
  });
  return deepFreeze({
    schemaVersion: 1,
    workflowId: inspection.workflow.workflowId,
    epoch: inspection.job.epoch,
    contextDigest: inspection.job.contextDigest,
    jobId: inspection.job.jobId,
    previousAttemptId: previous.attemptId,
    previewAttemptId: replacement.attempt.attemptId,
    attemptNumber: replacement.attempt.attemptNumber,
    retryMode: 'execution-policy-change',
    changedFields: replacement.attempt.changedFields.map((field) => ({
      ...field,
    })),
    policySnapshot: replacement.attempt.policySnapshot,
    requestDigest: replacement.attempt.requestDigest,
    grantId,
  });
}

function readLegacyProjectionEntries(cwd: string): LegacyProjectionEntry[] {
  const context = loadInvestigationRuntimeContext(cwd);
  let records: Array<{
    record: ProviderInvocationRecord;
    request: ProviderInvocationRequest;
    outputSchema: ProviderOutputSchemaGeneration;
    residuals: ProviderResidualsGeneration | null;
  }>;
  try {
    const projections = listProviderInvocationLifecycleProjections(
      context.runtime,
    );
    records = projections.map(({ invocationId }) => {
      const request = readProviderInvocationRequest(
        context.runtime,
        invocationId,
      );
      const record = readProviderInvocation(context.runtime, invocationId);
      return {
        record,
        request,
        // Classified here, with the rest of the store read, so a shape no
        // writer of this engine produced still fails the scan closed rather
        // than reaching the projection as if it were merely old.
        outputSchema: providerOutputSchemaGeneration(request),
        residuals: providerResidualsGeneration(record),
      };
    });
  } catch (error) {
    throw workflowError(
      'EXECUTION_RUNTIME_STORE_UNSAFE',
      'Legacy provider invocation state cannot be inspected safely.',
      ExitCode.staleState,
      { details: { cause: errorMessage(error) } },
    );
  }
  return records.map(({ record, request, outputSchema, residuals }) => {
    try {
      const executionPolicy = legacyExecutionPolicy(request);
      const projection = projectLegacyProviderInvocation({
        record,
        epoch: LEGACY_EPOCH,
        contractVersion: LEGACY_CONTRACT_VERSION,
        contextDigest: normalizeDigest(record.manifestDigest),
        engineBinding: digestCanonical({
          kind: 'legacy-execution-engine-binding',
          schemaVersion: 1,
        }),
        executionPolicy,
        environmentDigest: legacyEnvironmentDigest(request),
        semanticJobIdentityDigest: normalizeDigest(record.manifestDigest),
        retryPolicy: legacyRetryPolicy(request.providerId),
      });
      return { record, request, outputSchema, residuals, projection };
    } catch (error) {
      throw workflowError(
        'EXECUTION_RUNTIME_PROJECTION_INVALID',
        `Legacy invocation ${record.invocationId} cannot be projected.`,
        ExitCode.guard,
        { details: { cause: errorMessage(error) } },
      );
    }
  });
}

function aggregateDurableJob(
  state: DurableExecutionJobState,
  input: LegacyProjectionEntry[],
): ExecutionJobInspection {
  const entries = [...input].sort(
    (left, right) =>
      left.record.attempt - right.record.attempt ||
      left.record.invocationId.localeCompare(right.record.invocationId),
  );
  if (
    entries.length !== state.legacyProjection.invocations.length ||
    state.job.jobId !== entries[0]?.projection.job.jobId
  ) {
    throw runtimeConflict(
      'Durable execution state does not cover the current legacy Job history.',
    );
  }
  const entriesByInvocation = new Map(
    entries.map((entry) => [entry.record.invocationId, entry]),
  );
  for (const source of state.legacyProjection.invocations) {
    const entry = entriesByInvocation.get(source.invocationId);
    if (
      entry === undefined ||
      entry.record.revision !== source.legacyRevision ||
      entry.projection.attempt.attemptId !== source.attemptId ||
      entry.projection.job.jobId !== state.job.jobId ||
      entry.projection.workflow.workflowId !== state.workflow.workflowId ||
      canonicalJson(entry.projection.job.mandateBinding ?? null) !==
        canonicalJson(state.job.mandateBinding ?? null) ||
      canonicalJson(entry.projection.job.semanticSpec) !==
        canonicalJson(state.job.semanticSpec)
    ) {
      throw runtimeConflict(
        'Durable execution state is stale or conflicts with its legacy projection.',
      );
    }
  }
  const attemptsById = new Map(
    state.attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const results = state.results.map((result): ExecutionResultView => {
    const attempt = attemptsById.get(result.attemptId);
    if (
      attempt?.legacyInvocation === null ||
      attempt?.legacyInvocation === undefined ||
      result.acceptance === 'stale'
    ) {
      throw runtimeConflict(
        'Durable provider result is not a compatible legacy result.',
      );
    }
    const entry = entriesByInvocation.get(
      attempt.legacyInvocation.invocationId,
    );
    if (entry === undefined) {
      throw runtimeConflict(
        'Durable provider result has no legacy invocation to classify.',
      );
    }
    return {
      attemptId: result.attemptId,
      invocationId: attempt.legacyInvocation.invocationId,
      acceptance: result.acceptance,
      outputDigest: result.outputDigest,
      outputSchema: entry.outputSchema,
      residuals: entry.residuals,
    };
  });
  const latestFailedAttempt = [...state.attempts]
    .reverse()
    .find((attempt) => attempt.failure !== null);
  const latestFailure =
    latestFailedAttempt?.failure === null || latestFailedAttempt === undefined
      ? null
      : {
          attemptId: latestFailedAttempt.attemptId,
          failure: latestFailedAttempt.failure,
          decision: retryDecisionForLegacyFailure({
            workflow: state.workflow,
            job: state.job,
            attempt: latestFailedAttempt,
            attempts: state.attempts,
          }),
        };
  return deepFreeze({
    schemaVersion: 1,
    workflow: state.workflow,
    job: state.job,
    // Durable state carries the ordinals the writer assigned, so there is
    // nothing for the reader to renumber.
    attemptNumbering: 'recorded' as const,
    attempts: state.attempts,
    acceptedAttemptId: state.job.acceptedAttemptId,
    results,
    latestFailure,
  });
}

function aggregateLegacyJob(
  input: LegacyProjectionEntry[],
): ExecutionJobInspection {
  const entries = [...input].sort(
    (left, right) =>
      left.record.attempt - right.record.attempt ||
      left.record.invocationId.localeCompare(right.record.invocationId),
  );
  if (entries.length < 1) throw runtimeConflict('Legacy Job group is empty.');
  const attemptNumbering = classifyLegacyEntries(entries);
  const successful = entries.filter(
    ({ record }) => record.state === 'succeeded',
  );
  const acceptedInvocationId = successful[0]?.record.invocationId ?? null;
  const attempts = entries.map((entry, index) => {
    const projected = entry.projection.attempt;
    const previous =
      index === 0 ? undefined : entries[index - 1]!.projection.attempt;
    const changedFields =
      previous === undefined
        ? []
        : diffExecutionPolicy(
            previous.policySnapshot,
            projected.policySnapshot,
          );
    const lateDuplicate =
      entry.record.state === 'succeeded' &&
      entry.record.invocationId !== acceptedInvocationId;
    return assertAttemptRecord({
      ...projected,
      retryOf: previous?.attemptId ?? null,
      retryMode:
        index === 0
          ? 'none'
          : changedFields.length === 0
            ? 'same-input'
            : 'execution-policy-change',
      changedFields,
      status: lateDuplicate ? 'late-duplicate' : projected.status,
      retention: lateDuplicate ? 'debug' : projected.retention,
    });
  });
  const acceptedAttemptId =
    acceptedInvocationId === null
      ? null
      : (attempts.find(
          ({ legacyInvocation }) =>
            legacyInvocation?.invocationId === acceptedInvocationId,
        )?.attemptId ?? null);
  if (acceptedInvocationId !== null && acceptedAttemptId === null) {
    throw runtimeConflict(
      'Accepted legacy invocation has no projected Attempt.',
    );
  }
  const first = entries[0]!.projection;
  const latest = entries.at(-1)!.projection;
  const workflow = assertWorkflowRecord(first.workflow);
  const job = assertJobRecord({
    ...first.job,
    status: acceptedAttemptId === null ? latest.job.status : 'succeeded',
    acceptedAttemptId,
    attemptCount: attempts.length,
    createdAt: attempts[0]!.createdAt,
    updatedAt: attempts.at(-1)!.updatedAt,
  });
  const results = entries.flatMap((entry, index): ExecutionResultView[] => {
    if (entry.record.state !== 'succeeded' || entry.record.result === null) {
      return [];
    }
    return [
      {
        attemptId: attempts[index]!.attemptId,
        invocationId: entry.record.invocationId,
        acceptance:
          entry.record.invocationId === acceptedInvocationId
            ? 'accepted'
            : 'late-duplicate',
        outputDigest: normalizeDigest(entry.record.result.outputDigest),
        outputSchema: entry.outputSchema,
        residuals: entry.residuals,
      },
    ];
  });
  const latestFailedAttempt = [...attempts]
    .reverse()
    .find((attempt) => attempt.failure !== null);
  const latestFailure =
    latestFailedAttempt?.failure === null || latestFailedAttempt === undefined
      ? null
      : {
          attemptId: latestFailedAttempt.attemptId,
          failure: latestFailedAttempt.failure,
          decision: retryDecisionForLegacyFailure({
            workflow,
            job,
            attempt: latestFailedAttempt,
            attempts,
          }),
        };
  return deepFreeze({
    schemaVersion: 1,
    workflow,
    job,
    attemptNumbering,
    attempts,
    acceptedAttemptId,
    results,
    latestFailure,
  });
}

/**
 * Check that a legacy group is one Job, and report how its attempts are
 * numbered.
 *
 * The current writer refuses to open a second attempt 1 in a group, so a group
 * that carries one cannot have been written by it: the ordinals predate that
 * rule, from when a retry opened a fresh invocation and numbered it 1 again.
 * That is the record's own age, so it is reported rather than refused.
 *
 * Nothing else relaxes. Every identity field must still agree, and the observed
 * order must still be monotonic -- which is what makes renumbering sound at
 * all, since the projected ordinals are that order and no other.
 */
function classifyLegacyEntries(
  entries: LegacyProjectionEntry[],
): 'recorded' | 'legacy-renumbered' {
  const first = entries[0]!.projection;
  let previousUpdatedAt = 0;
  let numbering: 'recorded' | 'legacy-renumbered' = 'recorded';
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.record.attempt !== index + 1) {
      numbering = 'legacy-renumbered';
    }
    if (
      entry.projection.job.jobId !== first.job.jobId ||
      entry.projection.workflow.workflowId !== first.workflow.workflowId ||
      entry.projection.workflow.currentEpoch !== first.workflow.currentEpoch ||
      entry.projection.workflow.contextDigest !==
        first.workflow.contextDigest ||
      canonicalJson(entry.projection.job.semanticSpec) !==
        canonicalJson(first.job.semanticSpec) ||
      canonicalJson(entry.projection.job.mandateBinding ?? null) !==
        canonicalJson(first.job.mandateBinding ?? null) ||
      canonicalJson(entry.projection.job.retryPolicy) !==
        canonicalJson(first.job.retryPolicy)
    ) {
      throw runtimeConflict(
        'Legacy invocations grouped as one Job have conflicting semantic identity or attempt order.',
      );
    }
    const updatedAt = Date.parse(entry.record.updatedAt);
    if (updatedAt < previousUpdatedAt) {
      throw runtimeConflict('Legacy invocation timestamps are not monotonic.');
    }
    previousUpdatedAt = updatedAt;
  }
  return numbering;
}

function retryDecisionForLegacyFailure(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  attempts: AttemptRecord[];
}): RetryDecision {
  return decideLegacyExecutionFailure(input);
}

function legacyExecutionPolicy(
  request: ProviderInvocationRequest,
): ExecutionPolicySnapshot {
  return {
    schemaVersion: 1,
    provider: request.providerId,
    timeoutMs: request.limits.timeoutMs,
    maxOutputBytes: request.limits.aggregateOutputBytes,
    workerClass: 'legacy-provider',
    backoffMs: 0,
    processEnvironment: {},
    concurrency: 1,
    transientToolConfig: {},
  };
}

function legacyRetryPolicy(providerId: string): RetryPolicy {
  return {
    maxAttempts: LEGACY_MAX_ATTEMPTS,
    maxCumulativeRuntimeMs: LEGACY_MAX_ATTEMPTS * MAX_PROVIDER_TIMEOUT_MS,
    maxProviderCostMicros: 0,
    maxProviderTokens: 0,
    maxSameFailureFingerprint: 2,
    maxRepairAttempts: 2,
    deadline: RETRY_DEADLINE,
    providerLimits: { [providerId]: LEGACY_MAX_ATTEMPTS },
  };
}

function legacyEnvironmentDigest(request: ProviderInvocationRequest): string {
  return digestCanonical({
    kind: 'legacy-provider-environment',
    schemaVersion: 1,
    provider: request.providerId,
    workerClass: 'legacy-provider',
  });
}

function diffExecutionPolicy(
  previous: ExecutionPolicySnapshot,
  current: ExecutionPolicySnapshot,
): ChangedField[] {
  const changed: ChangedField[] = [];
  for (const key of [
    'backoffMs',
    'concurrency',
    'maxOutputBytes',
    'processEnvironment',
    'provider',
    'timeoutMs',
    'transientToolConfig',
    'workerClass',
  ] as const) {
    if (canonicalJson(previous[key]) !== canonicalJson(current[key])) {
      changed.push({
        path: `/${key}`,
        from: structuredClone(previous[key]),
        to: structuredClone(current[key]),
      });
    }
  }
  return changed;
}

function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertRuntimeJobId(value: string): string {
  if (typeof value !== 'string' || !JOB_ID.test(value)) {
    throw workflowError(
      'EXECUTION_RUNTIME_JOB_ID_INVALID',
      'Execution Job ID is invalid.',
      ExitCode.usage,
    );
  }
  return value;
}

function assertExactTimestamp(value: string): string {
  const date = new Date(value);
  if (
    typeof value !== 'string' ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value
  ) {
    throw workflowError(
      'EXECUTION_RUNTIME_TIMESTAMP_INVALID',
      'Execution runtime timestamp must be exact ISO time.',
      ExitCode.usage,
    );
  }
  return value;
}

function runtimeConflict(message: string) {
  return workflowError(
    'EXECUTION_RUNTIME_JOB_CONFLICT',
    message,
    ExitCode.staleState,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
