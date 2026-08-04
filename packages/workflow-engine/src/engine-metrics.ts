import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import type { AttemptRecord, WorkflowRecord } from './execution-core.ts';
import { listExecutionBudgetGrantMetrics } from './execution-governance.ts';
import { listExecutionReplacementGrantRequestDigests } from './execution-replacement.ts';
import {
  listExecutionJobs,
  type ExecutionJobInspection,
} from './execution-runtime.ts';
import {
  assertHumanResolutionConsequences,
  assertLegacySupersedeHumanResolutionDecisionReadOnly,
  privatePathExists,
  readHumanResolutionNode,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import {
  WORKFLOW_SUPERSEDE_REASONS,
  type WorkflowSupersedeReason,
} from './intervention-control.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  assertInvestigationId,
  type InvestigationRuntimePaths,
} from './paths.ts';
import {
  inspectProviderRetentionMetrics,
  type ProviderRetentionMetrics,
} from './provider-retention.ts';
import { ExitCode, workflowError } from './errors.ts';

type Rate = Readonly<{
  numerator: number;
  denominator: number;
  value: number | null;
}>;

export type EngineGovernanceMetricsSource = Readonly<{
  grantRequestDigests: readonly string[];
  issuedGrants: readonly Readonly<{
    grantId: string;
    requestDigest: string;
    consumedAttemptIds: readonly string[];
  }>[];
  supersedeReasons: readonly Readonly<{
    workflowId: string;
    reason: WorkflowSupersedeReason | 'legacy-unknown';
  }>[];
}>;

export type EngineMetricsSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'engine-metrics-snapshot.v1';
  generatedAt: string;
  sample: Readonly<{
    workflows: number;
    jobs: number;
    attempts: number;
  }>;
  metrics: Readonly<{
    attempt_failure_recovered_rate: Rate;
    automatic_retry_success_rate: Rate;
    repair_retry_success_rate: Rate;
    late_output_rejected_count: number;
    same_fingerprint_replay_count: number;
    median_failure_to_next_attempt_ms: number | null;
    median_failure_to_recovery_ms: number | null;
    human_actions_per_recoverable_failure: number | null;
    stages_recomputed_per_retry: number | null;
    workflow_blocked_hours: number;
    suspended_created_count: 0;
    supersede_by_reason: Readonly<Record<string, number>>;
    direct_refusal_count: number;
    grant_request_count: number;
    grant_to_success_rate: Rate;
    raw_evidence_bytes_by_retention_class: ProviderRetentionMetrics['rawEvidenceBytesByRetentionClass'];
    expired_pending_deletion: ProviderRetentionMetrics['expiredPendingDeletion'];
    pinned_count: number;
    receipt_count: number;
  }>;
}>;

const FAILURE_STATUSES = new Set<AttemptRecord['status']>([
  'failed-retryable',
  'failed-terminal',
  'timed-out',
]);
const RATE_TERMINAL_STATUSES = new Set<AttemptRecord['status']>([
  'succeeded',
  'failed-retryable',
  'failed-terminal',
  'timed-out',
]);
export function collectEngineMetrics(
  cwd: string,
  options: { now?: string; retentionTtlDays?: number } = {},
): EngineMetricsSnapshot {
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const jobs = listExecutionJobs(cwd);
  const storage = inspectProviderRetentionMetrics(cwd, {
    now,
    ...(options.retentionTtlDays === undefined
      ? {}
      : { ttlDays: options.retentionTtlDays }),
  });
  const context = loadInvestigationRuntimeContext(cwd);
  const issuedGrants = listExecutionBudgetGrantMetrics(
    context.lifecycleRuntime.root,
  );
  const replacementRequestDigests =
    listExecutionReplacementGrantRequestDigests(cwd);
  const governance: EngineGovernanceMetricsSource = {
    grantRequestDigests: [
      ...new Set([
        ...issuedGrants.map(({ requestDigest }) => requestDigest),
        ...replacementRequestDigests,
      ]),
    ].sort(),
    issuedGrants,
    supersedeReasons: collectSupersedeReasons(
      context.runtime,
      uniqueWorkflows(jobs),
    ),
  };
  return computeEngineMetrics(jobs, storage, now, governance);
}

export function computeEngineMetrics(
  inspections: readonly ExecutionJobInspection[],
  storage: ProviderRetentionMetrics,
  generatedAt: string,
  governanceSource?: EngineGovernanceMetricsSource,
): EngineMetricsSnapshot {
  const now = exactTimestamp(generatedAt);
  if (storage.measuredAt !== now) {
    throw metricsInvalid(
      'Execution and retention metrics must share one exact observation time.',
    );
  }
  const jobs = [...inspections].sort((left, right) =>
    left.job.jobId.localeCompare(right.job.jobId),
  );
  if (new Set(jobs.map(({ job }) => job.jobId)).size !== jobs.length) {
    throw metricsInvalid('Execution metrics contain duplicate Job identities.');
  }
  const workflows = uniqueWorkflows(jobs);
  const failures = jobs.flatMap(({ job, attempts }) =>
    attempts
      .filter((attempt) => FAILURE_STATUSES.has(attempt.status))
      .map((attempt) => ({ job, attempts, attempt })),
  );
  const recoveredFailures = failures.filter(({ job, attempts, attempt }) => {
    const accepted = attempts.find(
      ({ attemptId }) => attemptId === job.acceptedAttemptId,
    );
    return (
      accepted !== undefined && accepted.attemptNumber > attempt.attemptNumber
    );
  });
  const automaticRetries = jobs.flatMap(({ job, attempts }) =>
    attempts
      .filter(
        (attempt) =>
          attempt.grantId === null &&
          ['same-input', 'execution-policy-change', 'strategy-change'].includes(
            attempt.retryMode,
          ) &&
          RATE_TERMINAL_STATUSES.has(attempt.status),
      )
      .map((attempt) => ({ job, attempt })),
  );
  const repairRetries = jobs.flatMap(({ job, attempts }) =>
    attempts
      .filter(
        (attempt) =>
          attempt.retryMode === 'repair' &&
          RATE_TERMINAL_STATUSES.has(attempt.status),
      )
      .map((attempt) => ({ job, attempt })),
  );
  const failureToNext = failures.flatMap(({ attempts, attempt }) => {
    const next = attempts
      .filter(({ attemptNumber }) => attemptNumber > attempt.attemptNumber)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)[0];
    return next === undefined
      ? []
      : [duration(attempt.updatedAt, next.createdAt)];
  });
  const failureToRecovery = recoveredFailures.map(
    ({ job, attempts, attempt }) => {
      const accepted = attempts.find(
        ({ attemptId }) => attemptId === job.acceptedAttemptId,
      )!;
      return duration(attempt.updatedAt, accepted.updatedAt);
    },
  );
  const recoverableFailures = failures.filter(
    ({ attempt }) => attempt.failure?.retryClass !== 'terminal',
  );
  const governance = normalizeGovernanceSource(jobs, governanceSource);
  const requestIds = new Set<string>(governance.grantRequestDigests);
  let directRefusalCount = 0;
  for (const inspection of jobs) {
    const latest = inspection.latestFailure;
    if (governanceSource === undefined && latest?.decision.requiredGrant) {
      requestIds.add(latest.decision.requiredGrant.requestId);
    }
    if (
      latest !== null &&
      latest.failure.retryClass !== 'terminal' &&
      latest.decision.retryable === false &&
      latest.decision.requiredGrant === undefined
    ) {
      directRefusalCount += 1;
    }
  }
  const acceptedAttemptIds = new Set(
    jobs.flatMap(({ job }) =>
      job.acceptedAttemptId === null ? [] : [job.acceptedAttemptId],
    ),
  );
  const successfulGrantIds = new Set(
    governance.issuedGrants.flatMap((grant) =>
      grant.consumedAttemptIds.some((attemptId) =>
        acceptedAttemptIds.has(attemptId),
      )
        ? [grant.grantId]
        : [],
    ),
  );
  const recomputedRetries = jobs.flatMap(({ job, attempts }) =>
    attempts
      .filter((attempt) => attempt.retryOf !== null)
      .map((attempt) => {
        if (!attempts.some(({ attemptId }) => attemptId === attempt.retryOf)) {
          throw metricsInvalid(
            'A replacement Attempt does not name a predecessor in its bound Job.',
          );
        }
        return { stage: job.stage };
      }),
  );
  const recomputedStageCount = recomputedRetries.reduce(
    (total, { stage }) => total + (stage.length > 0 ? 1 : 0),
    0,
  );
  const supersedeByReason: Record<string, number> = {};
  for (const workflow of workflows.values()) {
    if (workflow.status === 'superseded') {
      const reason = governance.supersedeReasons.find(
        (entry) => entry.workflowId === workflow.workflowId,
      )?.reason;
      if (reason === undefined) {
        throw metricsInvalid(
          'A superseded Workflow has no exact governance reason observation.',
        );
      }
      supersedeByReason[reason] = (supersedeByReason[reason] ?? 0) + 1;
    }
  }
  const snapshot: EngineMetricsSnapshot = {
    schemaVersion: 1,
    kind: 'engine-metrics-snapshot.v1',
    generatedAt: now,
    sample: {
      workflows: workflows.size,
      jobs: jobs.length,
      attempts: jobs.reduce(
        (total, inspection) => total + inspection.attempts.length,
        0,
      ),
    },
    metrics: {
      attempt_failure_recovered_rate: rate(
        recoveredFailures.length,
        failures.length,
      ),
      automatic_retry_success_rate: rate(
        automaticRetries.filter(
          ({ job, attempt }) => job.acceptedAttemptId === attempt.attemptId,
        ).length,
        automaticRetries.length,
      ),
      repair_retry_success_rate: rate(
        repairRetries.filter(
          ({ job, attempt }) => job.acceptedAttemptId === attempt.attemptId,
        ).length,
        repairRetries.length,
      ),
      late_output_rejected_count: jobs.reduce(
        (total, { attempts }) =>
          total +
          attempts.filter(({ status }) =>
            ['stale', 'late-duplicate'].includes(status),
          ).length,
        0,
      ),
      same_fingerprint_replay_count: sameFingerprintReplayCount(jobs),
      median_failure_to_next_attempt_ms: median(failureToNext),
      median_failure_to_recovery_ms: median(failureToRecovery),
      human_actions_per_recoverable_failure:
        recoverableFailures.length === 0
          ? null
          : governance.issuedGrants.length / recoverableFailures.length,
      stages_recomputed_per_retry:
        recomputedRetries.length === 0
          ? null
          : recomputedStageCount / recomputedRetries.length,
      workflow_blocked_hours: workflowBlockedHours(jobs, workflows, now),
      // WorkflowStatus has no suspended state, so this is a schema-enforced
      // invariant rather than an inferred zero from missing telemetry.
      suspended_created_count: 0,
      supersede_by_reason: supersedeByReason,
      direct_refusal_count: directRefusalCount,
      grant_request_count: requestIds.size,
      grant_to_success_rate: rate(
        successfulGrantIds.size,
        governance.issuedGrants.length,
      ),
      raw_evidence_bytes_by_retention_class: {
        ...storage.rawEvidenceBytesByRetentionClass,
      },
      expired_pending_deletion: { ...storage.expiredPendingDeletion },
      pinned_count: storage.pinnedCount,
      receipt_count: storage.receiptCount,
    },
  };
  return deepFreeze(snapshot);
}

function normalizeGovernanceSource(
  jobs: readonly ExecutionJobInspection[],
  source: EngineGovernanceMetricsSource | undefined,
): EngineGovernanceMetricsSource {
  if (source === undefined) {
    const attemptsByGrant = new Map<string, string[]>();
    for (const { attempts } of jobs) {
      for (const attempt of attempts) {
        if (attempt.grantId === null) continue;
        const consumedAttemptIds = attemptsByGrant.get(attempt.grantId) ?? [];
        consumedAttemptIds.push(attempt.attemptId);
        attemptsByGrant.set(attempt.grantId, consumedAttemptIds);
      }
    }
    return {
      grantRequestDigests: [...attemptsByGrant.keys()].map(
        (grantId) => `inferred-from-grant:${grantId}`,
      ),
      issuedGrants: [...attemptsByGrant.entries()].map(
        ([grantId, consumedAttemptIds]) => ({
          grantId,
          requestDigest: `inferred-from-grant:${grantId}`,
          consumedAttemptIds,
        }),
      ),
      supersedeReasons: [...uniqueWorkflows(jobs).values()]
        .filter(({ status }) => status === 'superseded')
        .map(({ workflowId }) => ({
          workflowId,
          reason: 'legacy-unknown' as const,
        })),
    };
  }
  if (
    !Array.isArray(source.grantRequestDigests) ||
    !Array.isArray(source.issuedGrants) ||
    !Array.isArray(source.supersedeReasons) ||
    source.grantRequestDigests.some(
      (requestDigest: unknown) =>
        typeof requestDigest !== 'string' || requestDigest.length === 0,
    )
  ) {
    throw metricsInvalid('Engine governance metrics source is malformed.');
  }
  const grantIds = new Set<string>();
  for (const grant of source.issuedGrants) {
    if (
      typeof grant?.grantId !== 'string' ||
      grant.grantId.length === 0 ||
      typeof grant.requestDigest !== 'string' ||
      grant.requestDigest.length === 0 ||
      !Array.isArray(grant.consumedAttemptIds) ||
      grant.consumedAttemptIds.some(
        (attemptId: unknown) =>
          typeof attemptId !== 'string' || attemptId.length === 0,
      ) ||
      new Set(grant.consumedAttemptIds).size !==
        grant.consumedAttemptIds.length ||
      grantIds.has(grant.grantId)
    ) {
      throw metricsInvalid('Engine governance metrics source is malformed.');
    }
    grantIds.add(grant.grantId);
  }
  const supersededWorkflowIds = new Set(
    [...uniqueWorkflows(jobs).values()]
      .filter(({ status }) => status === 'superseded')
      .map(({ workflowId }) => workflowId),
  );
  const reasonWorkflowIds = new Set<string>();
  for (const entry of source.supersedeReasons) {
    if (
      typeof entry?.workflowId !== 'string' ||
      entry.workflowId.length === 0 ||
      !(
        entry.reason === 'legacy-unknown' ||
        WORKFLOW_SUPERSEDE_REASONS.includes(
          entry.reason as WorkflowSupersedeReason,
        )
      ) ||
      !supersededWorkflowIds.has(entry.workflowId) ||
      reasonWorkflowIds.has(entry.workflowId)
    ) {
      throw metricsInvalid('Engine governance metrics source is malformed.');
    }
    reasonWorkflowIds.add(entry.workflowId);
  }
  if (
    reasonWorkflowIds.size !== supersededWorkflowIds.size ||
    [...supersededWorkflowIds].some(
      (workflowId) => !reasonWorkflowIds.has(workflowId),
    )
  ) {
    throw metricsInvalid('Engine governance metrics source is malformed.');
  }
  const requestDigests = new Set(source.grantRequestDigests);
  if (
    source.issuedGrants.some(
      ({ requestDigest }) => !requestDigests.has(requestDigest),
    )
  ) {
    throw metricsInvalid('Engine governance metrics source is malformed.');
  }
  return deepFreeze({
    grantRequestDigests: [...new Set(source.grantRequestDigests)].sort(),
    issuedGrants: source.issuedGrants
      .map((grant) => ({
        grantId: grant.grantId,
        requestDigest: grant.requestDigest,
        consumedAttemptIds: [...grant.consumedAttemptIds].sort(),
      }))
      .sort((left, right) => left.grantId.localeCompare(right.grantId)),
    supersedeReasons: source.supersedeReasons
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.workflowId.localeCompare(right.workflowId)),
  });
}

function collectSupersedeReasons(
  paths: InvestigationRuntimePaths,
  workflows: ReadonlyMap<string, WorkflowRecord>,
): EngineGovernanceMetricsSource['supersedeReasons'] {
  const observations: Array<{
    workflowId: string;
    reason: WorkflowSupersedeReason | 'legacy-unknown';
  }> = [];
  for (const workflow of workflows.values()) {
    if (workflow.status !== 'superseded') continue;
    const workflowId = assertMetricsInvestigationId(workflow.workflowId);
    observations.push({
      workflowId,
      reason: inspectEngineSupersedeReason(paths, workflowId),
    });
  }
  return deepFreeze(
    observations.sort((left, right) =>
      left.workflowId.localeCompare(right.workflowId),
    ),
  );
}

export function inspectEngineSupersedeReason(
  paths: InvestigationRuntimePaths,
  requestedWorkflowId: string,
): WorkflowSupersedeReason | 'legacy-unknown' {
  const workflowId = assertMetricsInvestigationId(requestedWorkflowId);
  const resolutionRoot = path.join(paths.root, 'human-resolutions');
  const refPath = path.join(resolutionRoot, 'refs', `${workflowId}.json`);
  if (!privatePathExists(paths, refPath, metricsStoreUnsafe)) {
    return 'legacy-unknown';
  }
  const ref = readPrivateCanonicalJson(paths, refPath, metricsStoreUnsafe);
  if (
    !isRecord(ref) ||
    !hasExactKeys(ref, ['schemaVersion', 'investigationId', 'nodeId']) ||
    ref.schemaVersion !== 1 ||
    ref.investigationId !== workflowId ||
    !isRawDigest(ref.nodeId)
  ) {
    throw metricsStoreUnsafe();
  }
  const nodeId = ref.nodeId;
  try {
    const node = readHumanResolutionNode(paths, nodeId);
    if (
      node.target.workflowId !== workflowId ||
      node.decision.kind !== 'supersede'
    ) {
      throw metricsStoreUnsafe();
    }
    return node.decision.parameters.reason;
  } catch (error) {
    const nodePath = path.join(resolutionRoot, 'nodes', `${nodeId}.json`);
    let legacy: unknown;
    try {
      legacy = readPrivateCanonicalJson(paths, nodePath, metricsStoreUnsafe);
    } catch {
      throw metricsStoreUnsafe();
    }
    if (!isVerifiedLegacySupersedeNode(legacy, nodeId, workflowId)) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENGINE_METRICS_STORE_UNSAFE'
      ) {
        throw error;
      }
      throw metricsStoreUnsafe();
    }
    return 'legacy-unknown';
  }
}

function assertMetricsInvestigationId(value: string): string {
  try {
    return assertInvestigationId(value);
  } catch {
    throw metricsInvalid(
      'A superseded execution Workflow is not a bound Investigation.',
    );
  }
}

function isVerifiedLegacySupersedeNode(
  value: unknown,
  expectedNodeId: string,
  workflowId: string,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'nodeId',
      'target',
      'expected',
      'decision',
      'consequences',
      'grantId',
      'grantDigest',
      'previousResolutionNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-resolution-node' ||
    value.nodeId !== expectedNodeId ||
    !isRecord(value.target) ||
    !hasExactKeys(value.target, ['workflowKind', 'changeId', 'workflowId']) ||
    value.target.workflowKind !== 'investigation' ||
    value.target.workflowId !== workflowId ||
    typeof value.target.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.target.changeId) ||
    !isRecord(value.expected) ||
    !hasExactKeys(value.expected, [
      'reasonCode',
      'blockedTransition',
      'stateDigest',
      'currentRefDigest',
    ]) ||
    !isBoundedText(value.expected.reasonCode, 256) ||
    !isBoundedText(value.expected.blockedTransition, 256) ||
    !isRawDigest(value.expected.stateDigest) ||
    (value.expected.currentRefDigest !== null &&
      !isRawDigest(value.expected.currentRefDigest)) ||
    typeof value.grantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.grantId,
    ) ||
    !isRawDigest(value.grantDigest) ||
    (value.previousResolutionNodeId !== null &&
      !isRawDigest(value.previousResolutionNodeId)) ||
    typeof value.createdAt !== 'string' ||
    !isExactTimestamp(value.createdAt)
  ) {
    return false;
  }
  try {
    assertLegacySupersedeHumanResolutionDecisionReadOnly(value.decision);
    const consequences = assertHumanResolutionConsequences(value.consequences);
    if (consequences.continuity !== 'broken') return false;
  } catch {
    return false;
  }
  const { nodeId: _nodeId, ...semantic } = value;
  return (
    expectedNodeId ===
    crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          schema: 'human-resolution-node.v1',
          node: semantic,
        }),
      )
      .digest('hex')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isRawDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function isExactTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function metricsStoreUnsafe() {
  return workflowError(
    'ENGINE_METRICS_STORE_UNSAFE',
    'Engine governance metrics encountered unsafe durable state.',
    ExitCode.unsafeEnvironment,
  );
}

function uniqueWorkflows(
  jobs: readonly ExecutionJobInspection[],
): Map<string, WorkflowRecord> {
  const workflows = new Map<string, WorkflowRecord>();
  for (const { workflow } of jobs) {
    const existing = workflows.get(workflow.workflowId);
    if (existing && canonicalJson(existing) !== canonicalJson(workflow)) {
      throw metricsInvalid(
        'Execution Jobs disagree about their shared Workflow state.',
      );
    }
    workflows.set(workflow.workflowId, structuredClone(workflow));
  }
  return workflows;
}

function sameFingerprintReplayCount(
  jobs: readonly ExecutionJobInspection[],
): number {
  let total = 0;
  for (const { attempts } of jobs) {
    const counts = new Map<string, number>();
    for (const { failureFingerprint } of attempts) {
      if (failureFingerprint !== null) {
        counts.set(
          failureFingerprint,
          (counts.get(failureFingerprint) ?? 0) + 1,
        );
      }
    }
    total += [...counts.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );
  }
  return total;
}

function workflowBlockedHours(
  jobs: readonly ExecutionJobInspection[],
  workflows: ReadonlyMap<string, WorkflowRecord>,
  now: string,
): number {
  const intervals = new Map<string, Array<readonly [number, number]>>();
  const append = (workflowId: string, from: string, to: string): void => {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw metricsInvalid('Execution metric timestamps are not monotonic.');
    }
    const current = intervals.get(workflowId) ?? [];
    current.push([start, end]);
    intervals.set(workflowId, current);
  };
  for (const workflow of workflows.values()) {
    if (workflow.blocker !== null) {
      append(workflow.workflowId, workflow.blocker.since, now);
    }
  }
  for (const { workflow, job, attempts } of jobs) {
    const ordered = [...attempts].sort(
      (left, right) => left.attemptNumber - right.attemptNumber,
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const attempt = ordered[index]!;
      if (!FAILURE_STATUSES.has(attempt.status)) continue;
      const next = ordered[index + 1];
      if (next !== undefined) {
        append(workflow.workflowId, attempt.updatedAt, next.createdAt);
      } else if (
        ['waiting-retry', 'waiting-grant', 'waiting-human-input'].includes(
          job.status,
        )
      ) {
        append(workflow.workflowId, attempt.updatedAt, now);
      }
    }
  }
  const milliseconds = [...intervals.values()].reduce((total, observed) => {
    const ordered = [...observed].sort(
      ([leftStart, leftEnd], [rightStart, rightEnd]) =>
        leftStart - rightStart || leftEnd - rightEnd,
    );
    let union = 0;
    let start: number | null = null;
    let end: number | null = null;
    for (const [candidateStart, candidateEnd] of ordered) {
      if (start === null || end === null) {
        start = candidateStart;
        end = candidateEnd;
      } else if (candidateStart <= end) {
        end = Math.max(end, candidateEnd);
      } else {
        union += end - start;
        start = candidateStart;
        end = candidateEnd;
      }
    }
    return (
      total + (start === null || end === null ? union : union + end - start)
    );
  }, 0);
  return milliseconds / 3_600_000;
}

function duration(from: string, to: string): number {
  const value = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(value) || value < 0) {
    throw metricsInvalid('Execution metric timestamps are not monotonic.');
  }
  return value;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rate(numerator: number, denominator: number): Rate {
  return deepFreeze({
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  });
}

function exactTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw metricsInvalid('Engine metrics require an exact ISO-8601 timestamp.');
  }
  return value;
}

function metricsInvalid(message: string) {
  return workflowError(
    'ENGINE_METRICS_INVALID',
    message,
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
