import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAttemptResult,
  assertReadOnlyProbe,
  canonicalAttemptRecord,
  canonicalJobRecord,
  canonicalWorkflowRecord,
  classifyEnvironmentDrift,
  classifyExecutionFailure,
  createExecutionJob,
  createFailureDescriptor,
  createReplacementAttempt,
  decideRetry,
  environmentSnapshotDigest,
  leaseAttempt,
  parseAttemptRecord,
  parseJobRecord,
  parseWorkflowRecord,
  projectLegacyProviderInvocation,
  type EnvironmentSnapshot,
  type ExecutionPolicySnapshot,
  type JobRecord,
  type ProviderInvocationProjection,
  type WorkflowRecord,
} from '../src/modules/provider-orchestration/execution-core.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import type { ProviderInvocationRecord } from '../src/provider-invocation-store.ts';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const NOW = '2026-08-03T00:00:00.000Z';
const LATER = '2026-08-03T00:01:00.000Z';
const MANDATE_BINDING = {
  schemaVersion: 1 as const,
  mandateTaskId: 'plan-review-task',
  mandateId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: '1'.repeat(64),
  changeId: 'change-a',
  externalAuditRoot: '/private/tmp/execution-core-authority-audit',
};

const WORKFLOW: WorkflowRecord = {
  schemaVersion: 2,
  workflowId: 'change-a',
  currentEpoch: 4,
  contractVersion: 2,
  contextDigest: digest('a'),
  checkpoint: 'plan-review',
  status: 'active',
  blocker: null,
  engineBinding: digest('e'),
};

const POLICY_300: ExecutionPolicySnapshot = {
  schemaVersion: 1,
  provider: 'claude',
  timeoutMs: 300_000,
  maxOutputBytes: 262_144,
  workerClass: 'standard',
  backoffMs: 1_000,
  processEnvironment: { LANG: 'C.UTF-8' },
  concurrency: 1,
  transientToolConfig: {},
};

const POLICY_600: ExecutionPolicySnapshot = {
  ...POLICY_300,
  timeoutMs: 600_000,
};

function createJob() {
  return createExecutionJob({
    workflow: WORKFLOW,
    mandateBinding: MANDATE_BINDING,
    jobId: 'job-plan-review-004',
    attemptId: 'attempt-001',
    stage: 'plan-review',
    semanticSpec: {
      schemaVersion: 1,
      contractVersion: 2,
      stage: 'plan-review',
      contextDigest: WORKFLOW.contextDigest,
      inputDigest: digest('b'),
      outputContractDigest: digest('c'),
      acceptancePolicyDigest: digest('d'),
    },
    executionPolicy: POLICY_300,
    environmentDigest: digest('f'),
    retryPolicy: {
      maxAttempts: 4,
      maxCumulativeRuntimeMs: 2_400_000,
      maxProviderCostMicros: 1_000_000,
      maxProviderTokens: 200_000,
      maxSameFailureFingerprint: 2,
      maxRepairAttempts: 2,
      deadline: '2026-08-04T00:00:00.000Z',
      providerLimits: { claude: 4 },
    },
    createdAt: NOW,
  });
}

test('300 to 600 creates a replacement Attempt without changing semantic identity', () => {
  const initial = createJob();
  assert.deepEqual(initial.job.mandateBinding, MANDATE_BINDING);
  assert.throws(
    () =>
      createReplacementAttempt({
        workflow: WORKFLOW,
        job: initial.job,
        previousAttempt: {
          ...initial.attempt,
          status: 'timed-out',
          updatedAt: LATER,
        },
        attemptId: 'attempt-missing-failure',
        retryMode: 'execution-policy-change',
        currentExecutionPolicy: POLICY_600,
        environmentDigest: digest('f'),
        createdAt: LATER,
      }),
    (error) => isWorkflowError(error, 'EXECUTION_RECORD_INVALID'),
  );
  const timeoutFailure = createFailureDescriptor({
    stage: initial.job.stage,
    code: 'PROVIDER_TIMEOUT',
    source: 'provider',
    retryClass: 'retryable',
    sideEffectState: 'none',
    paths: [],
    inputDigest: initial.attempt.inputDigest,
    environmentDigest: initial.attempt.environmentDigest,
    validatorPath: null,
    observedAt: LATER,
  });
  const timedOut = {
    ...initial.attempt,
    status: 'timed-out' as const,
    failure: timeoutFailure,
    failureFingerprint: timeoutFailure.fingerprint,
    updatedAt: LATER,
  };

  const replacement = createReplacementAttempt({
    workflow: WORKFLOW,
    job: initial.job,
    previousAttempt: timedOut,
    attemptId: 'attempt-002',
    retryMode: 'execution-policy-change',
    currentExecutionPolicy: POLICY_600,
    environmentDigest: digest('f'),
    createdAt: LATER,
  });

  assert.equal(replacement.job.workflowId, initial.job.workflowId);
  assert.equal(replacement.job.epoch, initial.job.epoch);
  assert.equal(replacement.job.contextDigest, initial.job.contextDigest);
  assert.equal(replacement.attempt.jobId, initial.job.jobId);
  assert.equal(replacement.attempt.attemptNumber, 2);
  assert.equal(replacement.attempt.retryOf, 'attempt-001');
  assert.equal(replacement.attempt.policySnapshot.timeoutMs, 600_000);
  assert.deepEqual(replacement.attempt.changedFields, [
    { path: '/timeoutMs', from: 300_000, to: 600_000 },
  ]);
  assert.notEqual(
    replacement.attempt.requestDigest,
    initial.attempt.requestDigest,
    'the new request is composed from the immutable semantic spec plus current policy',
  );
  assert.equal(replacement.job.attemptCount, 2);
  assert.equal(replacement.job.status, 'queued');
});

test('legacy ProviderInvocationRecord preserves its attempt lineage', () => {
  const legacy: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: 'invocation-legacy-9',
    investigationId: 'investigation-legacy',
    changeId: 'legacy-change',
    attempt: 9,
    revision: 3,
    state: 'failed',
    providerId: 'codex',
    purpose: 'survey',
    requestDigest: '1'.repeat(64),
    manifestDigest: '2'.repeat(64),
    leaseGeneration: 2,
    lease: null,
    result: null,
    failure: {
      kind: 'retryable',
      code: 'PROVIDER_TIMEOUT',
      message: 'timed out',
    },
    createdAt: NOW,
    updatedAt: LATER,
  };
  const projection: ProviderInvocationProjection =
    projectLegacyProviderInvocation({
      record: legacy,
      epoch: 1,
      contractVersion: 1,
      contextDigest: digest('3'),
      engineBinding: digest('4'),
      executionPolicy: { ...POLICY_300, provider: 'codex' },
      environmentDigest: digest('5'),
      retryPolicy: createJob().job.retryPolicy,
    });

  assert.equal(projection.workflow.workflowId, legacy.investigationId);
  assert.equal(projection.job.attemptCount, 9);
  assert.equal(projection.attempt.attemptNumber, 9);
  assert.equal(
    projection.attempt.legacyInvocation?.invocationId,
    legacy.invocationId,
  );
  assert.equal(projection.attempt.legacyInvocation?.legacyAttempt, 9);
  assert.equal(projection.attempt.status, 'timed-out');
  assert.equal(projection.job.status, 'waiting-retry');
});

test('legacy retry invocations project into one stable Job', () => {
  const first: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: 'invocation-legacy-1',
    investigationId: 'investigation-legacy',
    changeId: 'legacy-change',
    attempt: 1,
    revision: 2,
    state: 'failed',
    providerId: 'codex',
    purpose: 'survey',
    requestDigest: '1'.repeat(64),
    manifestDigest: '2'.repeat(64),
    leaseGeneration: 1,
    lease: null,
    result: null,
    failure: {
      kind: 'retryable',
      code: 'NETWORK_TRANSIENT',
      message: 'connection reset',
    },
    createdAt: NOW,
    updatedAt: LATER,
  };
  const second: ProviderInvocationRecord = {
    ...first,
    invocationId: 'invocation-legacy-2',
    attempt: 2,
    revision: 0,
    requestDigest: '3'.repeat(64),
    leaseGeneration: 0,
    createdAt: LATER,
  };
  const project = (record: ProviderInvocationRecord) =>
    projectLegacyProviderInvocation({
      record,
      epoch: 1,
      contractVersion: 1,
      contextDigest: digest('3'),
      engineBinding: digest('4'),
      executionPolicy: { ...POLICY_300, provider: 'codex' },
      environmentDigest: digest('5'),
      retryPolicy: createJob().job.retryPolicy,
    });

  const firstProjection = project(first);
  const secondProjection = project(second);
  assert.equal(firstProjection.job.jobId, secondProjection.job.jobId);
  assert.notEqual(
    firstProjection.attempt.attemptId,
    secondProjection.attempt.attemptId,
  );
  assert.equal(firstProjection.attempt.attemptNumber, 1);
  assert.equal(secondProjection.attempt.attemptNumber, 2);
  assert.equal(secondProjection.job.attemptCount, 2);
  assert.equal(secondProjection.attempt.retryMode, 'same-input');
  assert.equal(
    firstProjection.job.requestDigest,
    secondProjection.job.requestDigest,
    'execution-level request changes do not alter the semantic Job request',
  );
});

test('lease fencing rejects stale workers and result CAS accepts one winner', () => {
  const initial = createJob();
  const firstLease = leaseAttempt(initial.attempt, {
    workerId: 'worker-1',
    leaseToken: 'token-one',
    leaseDurationMs: 120_000,
    now: NOW,
  });
  const winner = acceptAttemptResult({
    workflow: WORKFLOW,
    job: initial.job,
    attempt: firstLease,
    expectedAcceptedAttemptId: null,
    leaseGeneration: 1,
    leaseToken: 'token-one',
    outputDigest: digest('9'),
    completedAt: LATER,
  });

  assert.equal(winner.accepted, true);
  assert.equal(winner.job.acceptedAttemptId, 'attempt-001');
  assert.equal(winner.job.status, 'succeeded');
  assert.equal(winner.result.acceptance, 'accepted');

  const competing = createReplacementAttempt({
    workflow: WORKFLOW,
    job: initial.job,
    previousAttempt: {
      ...initial.attempt,
      status: 'timed-out',
      failure: classifyExecutionFailure({
        kind: 'provider-timeout',
        stage: initial.job.stage,
        inputDigest: initial.attempt.inputDigest,
        environmentDigest: initial.attempt.environmentDigest,
        observedAt: LATER,
      }),
      failureFingerprint: createFailureDescriptor({
        stage: initial.job.stage,
        code: 'PROVIDER_TIMEOUT',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
        paths: [],
        validatorPath: null,
        inputDigest: initial.attempt.inputDigest,
        environmentDigest: initial.attempt.environmentDigest,
        observedAt: LATER,
      }).fingerprint,
      updatedAt: LATER,
    },
    attemptId: 'attempt-002',
    retryMode: 'same-input',
    currentExecutionPolicy: POLICY_300,
    environmentDigest: digest('f'),
    createdAt: LATER,
  });
  const competingLease = leaseAttempt(competing.attempt, {
    workerId: 'worker-2',
    leaseToken: 'token-two',
    leaseDurationMs: 120_000,
    now: LATER,
  });
  const loser = acceptAttemptResult({
    workflow: WORKFLOW,
    job: winner.job,
    attempt: competingLease,
    expectedAcceptedAttemptId: 'attempt-001',
    leaseGeneration: 1,
    leaseToken: 'token-two',
    outputDigest: digest('8'),
    completedAt: LATER,
  });
  assert.equal(loser.accepted, false);
  assert.equal(loser.attempt.status, 'late-duplicate');
  assert.equal(loser.result.acceptance, 'late-duplicate');
  assert.equal(loser.job.acceptedAttemptId, 'attempt-001');

  assert.throws(
    () =>
      acceptAttemptResult({
        workflow: WORKFLOW,
        job: initial.job,
        attempt: firstLease,
        expectedAcceptedAttemptId: null,
        leaseGeneration: 0,
        leaseToken: 'token-one',
        outputDigest: digest('7'),
        completedAt: LATER,
      }),
    (error) => isWorkflowError(error, 'ATTEMPT_FENCE_REJECTED'),
  );
});

test('late output from an old epoch is stale and cannot update the Job checkpoint', () => {
  const initial = createJob();
  const leased = leaseAttempt(initial.attempt, {
    workerId: 'worker-1',
    leaseToken: 'token-one',
    leaseDurationMs: 120_000,
    now: NOW,
  });
  const rolledWorkflow = {
    ...WORKFLOW,
    currentEpoch: 5,
    contextDigest: digest('7'),
  };
  const stale = acceptAttemptResult({
    workflow: rolledWorkflow,
    job: initial.job,
    attempt: leased,
    expectedAcceptedAttemptId: null,
    leaseGeneration: 1,
    leaseToken: 'token-one',
    outputDigest: digest('9'),
    completedAt: LATER,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.attempt.status, 'stale');
  assert.equal(stale.result.acceptance, 'stale');
  assert.equal(stale.job.acceptedAttemptId, null);
  assert.equal(stale.job.status, 'stale');
});

test('failure descriptors are canonical and retry decisions follow fixed ordering', () => {
  const initial = createJob();
  const timeout = classifyExecutionFailure({
    kind: 'provider-timeout',
    stage: 'plan-review',
    inputDigest: initial.attempt.inputDigest,
    environmentDigest: initial.attempt.environmentDigest,
    observedAt: LATER,
  });
  const reordered = createFailureDescriptor({
    observedAt: LATER,
    environmentDigest: initial.attempt.environmentDigest,
    paths: [],
    inputDigest: initial.attempt.inputDigest,
    sideEffectState: 'none',
    retryClass: 'retryable',
    source: 'provider',
    code: 'PROVIDER_TIMEOUT',
    stage: 'plan-review',
    validatorPath: null,
  });
  assert.equal(timeout.fingerprint, reordered.fingerprint);

  for (const [kind, reasonCode, retryAfterMs] of [
    ['provider-timeout', 'PROVIDER_TIMEOUT', undefined],
    ['network', 'NETWORK_TRANSIENT', undefined],
    ['rate-limit', 'PROVIDER_RATE_LIMIT', 23_000],
    ['provider-process-crash', 'PROVIDER_PROCESS_CRASH', undefined],
  ] as const) {
    const failure = classifyExecutionFailure({
      kind,
      stage: 'plan-review',
      inputDigest: initial.attempt.inputDigest,
      environmentDigest: initial.attempt.environmentDigest,
      observedAt: LATER,
      retryAfterMs,
    });
    const decision = decideRetry({
      workflow: WORKFLOW,
      job: initial.job,
      attempt: initial.attempt,
      failure,
      sameFingerprintCount: 1,
      now: LATER,
    });
    assert.equal(decision.retryable, true);
    assert.equal(decision.automatic, true);
    assert.equal(decision.reasonCode, reasonCode);
    assert.equal(decision.retryAfterMs, retryAfterMs);
    assert.notEqual(decision.retryMode, 'new-context');
  }

  const cancelled = decideRetry({
    workflow: { ...WORKFLOW, status: 'cancelled' },
    job: initial.job,
    attempt: initial.attempt,
    failure: timeout,
    sameFingerprintCount: 1,
    now: LATER,
  });
  assert.deepEqual(cancelled, {
    retryable: false,
    automatic: false,
    retryMode: 'none',
    reasonCode: 'WORKFLOW_CANCELLED',
  });

  const stale = decideRetry({
    workflow: { ...WORKFLOW, currentEpoch: 5 },
    job: initial.job,
    attempt: initial.attempt,
    failure: timeout,
    sameFingerprintCount: 1,
    now: LATER,
  });
  assert.equal(stale.retryMode, 'new-context');
  assert.equal(stale.reasonCode, 'STALE_EPOCH');

  const unknownSideEffect = decideRetry({
    workflow: WORKFLOW,
    job: initial.job,
    attempt: initial.attempt,
    failure: { ...timeout, sideEffectState: 'unknown' },
    sameFingerprintCount: 1,
    now: LATER,
  });
  assert.equal(unknownSideEffect.retryable, false);
  assert.equal(unknownSideEffect.reasonCode, 'MANUAL_RECONCILIATION_REQUIRED');

  const repeated = decideRetry({
    workflow: WORKFLOW,
    job: initial.job,
    attempt: initial.attempt,
    failure: timeout,
    sameFingerprintCount: 2,
    now: LATER,
  });
  assert.equal(repeated.retryMode, 'strategy-change');
  assert.equal(repeated.changedStrategyRequired, true);

  const exhaustedJob: JobRecord = {
    ...initial.job,
    attemptCount: initial.job.retryPolicy.maxAttempts,
  };
  const grant = decideRetry({
    workflow: WORKFLOW,
    job: exhaustedJob,
    attempt: initial.attempt,
    failure: timeout,
    sameFingerprintCount: 1,
    boundedGrantRequest: {
      schemaVersion: 1,
      kind: 'execution-budget-grant-request',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      workflowId: WORKFLOW.workflowId,
      epoch: WORKFLOW.currentEpoch,
      jobId: exhaustedJob.jobId,
      mandateBinding: MANDATE_BINDING,
      requestedChanges: [
        {
          path: '/retryPolicy/maxAttempts',
          from: 4,
          to: 5,
        },
      ],
      rationale: 'one bounded replacement attempt',
      expiresAfterAttempts: 1,
      createdAt: LATER,
    },
    now: LATER,
  });
  assert.equal(grant.retryable, true);
  assert.equal(grant.automatic, false);
  assert.equal(grant.reasonCode, 'EXECUTION_GRANT_REQUIRED');
  assert.equal(
    grant.requiredGrant?.requestId,
    '123e4567-e89b-42d3-a456-426614174000',
  );

  const exhausted = decideRetry({
    workflow: WORKFLOW,
    job: exhaustedJob,
    attempt: initial.attempt,
    failure: timeout,
    sameFingerprintCount: 1,
    now: LATER,
  });
  assert.equal(exhausted.retryable, false);
  assert.equal(exhausted.reasonCode, 'RETRY_BUDGET_EXHAUSTED');
});

test('automatic retry rejects runtime, cost, token, deadline, and provider thresholds', () => {
  const initial = createJob();
  const failure = classifyExecutionFailure({
    kind: 'provider-timeout',
    stage: initial.job.stage,
    inputDigest: initial.attempt.inputDigest,
    environmentDigest: initial.attempt.environmentDigest,
    observedAt: LATER,
  });
  const cases: Array<{
    name: string;
    job: JobRecord;
    now?: string;
    providerAttemptCount?: number;
    nextRuntimeMs?: number;
    nextProviderCostMicros?: number;
    nextProviderTokens?: number;
  }> = [
    {
      name: 'runtime',
      job: {
        ...initial.job,
        cumulativeRuntimeMs:
          initial.job.retryPolicy.maxCumulativeRuntimeMs - 299_999,
      },
      nextRuntimeMs: 300_000,
    },
    {
      name: 'cost',
      job: {
        ...initial.job,
        providerCostMicros: initial.job.retryPolicy.maxProviderCostMicros - 99,
      },
      nextProviderCostMicros: 100,
    },
    {
      name: 'tokens',
      job: {
        ...initial.job,
        providerTokens: initial.job.retryPolicy.maxProviderTokens - 99,
      },
      nextProviderTokens: 100,
    },
    {
      name: 'deadline',
      job: initial.job,
      now: initial.job.retryPolicy.deadline,
    },
    {
      name: 'provider cap',
      job: initial.job,
      providerAttemptCount:
        initial.job.retryPolicy.providerLimits[initial.attempt.provider],
    },
  ];

  for (const { name, job, ...limits } of cases) {
    const decision = decideRetry({
      workflow: WORKFLOW,
      job,
      attempt: initial.attempt,
      failure,
      sameFingerprintCount: 1,
      now: limits.now ?? LATER,
      ...(limits.providerAttemptCount === undefined
        ? {}
        : { providerAttemptCount: limits.providerAttemptCount }),
      ...(limits.nextRuntimeMs === undefined
        ? {}
        : { nextRuntimeMs: limits.nextRuntimeMs }),
      ...(limits.nextProviderCostMicros === undefined
        ? {}
        : { nextProviderCostMicros: limits.nextProviderCostMicros }),
      ...(limits.nextProviderTokens === undefined
        ? {}
        : { nextProviderTokens: limits.nextProviderTokens }),
    });
    assert.equal(decision.automatic, false, name);
    assert.equal(decision.reasonCode, 'RETRY_BUDGET_EXHAUSTED', name);
  }
});

test('environment snapshots use an exact read-only probe allowlist and classify drift', () => {
  const base: EnvironmentSnapshot = {
    schemaVersion: 1,
    repository: {
      head: 'a'.repeat(40),
      treeDigest: digest('1'),
      worktreeDigest: digest('2'),
    },
    runtime: { node: 'v24.1.0', platform: 'darwin-arm64' },
    provider: {
      adapter: 'claude-cli',
      version: '1.2.3',
      timeoutMs: 300_000,
    },
    tools: [
      { name: 'git', available: true, version: '2.50.0' },
      { name: 'node', available: true, version: '24.1.0' },
      { name: 'pnpm', available: true, version: '10.0.0' },
      { name: 'rg', available: true, version: '14.1.0' },
    ],
    capabilities: {
      network: false,
      readRepository: true,
      writeWorkspace: false,
    },
  };
  assert.equal(
    environmentSnapshotDigest(base),
    environmentSnapshotDigest(base),
  );

  assert.deepEqual(
    assertReadOnlyProbe({
      kind: 'binary-exists',
      target: 'rg',
      timeoutMs: 1_000,
    }),
    { kind: 'binary-exists', target: 'rg', timeoutMs: 1_000 },
  );
  assert.throws(
    () =>
      assertReadOnlyProbe({
        kind: 'run-command' as never,
        target: 'rm -rf .',
        timeoutMs: 1_000,
      }),
    (error) => isWorkflowError(error, 'EXECUTION_PROBE_NOT_ALLOWED'),
  );
  assert.throws(
    () =>
      assertReadOnlyProbe({
        kind: 'file-read',
        target: '../secret',
        timeoutMs: 1_000,
      }),
    (error) => isWorkflowError(error, 'EXECUTION_PROBE_NOT_ALLOWED'),
  );
  assert.throws(
    () =>
      assertReadOnlyProbe({
        kind: 'validator-error',
        target: '../../arbitrary-file',
        timeoutMs: 1_000,
      }),
    (error) => isWorkflowError(error, 'EXECUTION_PROBE_NOT_ALLOWED'),
  );
  assert.throws(
    () =>
      assertReadOnlyProbe({
        kind: 'dependency-availability',
        target: 'file:///etc/passwd',
        timeoutMs: 1_000,
      }),
    (error) => isWorkflowError(error, 'EXECUTION_PROBE_NOT_ALLOWED'),
  );

  assert.equal(
    classifyEnvironmentDrift(base, {
      ...base,
      provider: { ...base.provider, timeoutMs: 600_000 },
    }).class,
    'non-semantic',
  );
  assert.equal(
    classifyEnvironmentDrift(base, {
      ...base,
      repository: { ...base.repository, worktreeDigest: digest('3') },
    }).class,
    'refreshable',
  );
  assert.equal(
    classifyEnvironmentDrift(base, {
      ...base,
      repository: {
        head: 'b'.repeat(40),
        treeDigest: digest('4'),
        worktreeDigest: digest('5'),
      },
    }).class,
    'semantic',
  );
});

test('execution records round-trip only through strict canonical bytes', () => {
  const initial = createJob();
  const workflowBytes = canonicalWorkflowRecord(WORKFLOW);
  const jobBytes = canonicalJobRecord(initial.job);
  const attemptBytes = canonicalAttemptRecord(initial.attempt);

  assert.deepEqual(parseWorkflowRecord(workflowBytes), WORKFLOW);
  assert.deepEqual(parseJobRecord(jobBytes), initial.job);
  assert.deepEqual(parseAttemptRecord(attemptBytes), initial.attempt);

  for (const raw of [
    workflowBytes.slice(0, -1),
    workflowBytes.replace('{"blocker"', '{ "blocker"'),
    `${workflowBytes}\n`,
  ]) {
    assert.throws(
      () => parseWorkflowRecord(raw),
      (error) => isWorkflowError(error, 'EXECUTION_RECORD_NONCANONICAL'),
    );
  }

  const overKeyed = JSON.parse(workflowBytes) as Record<string, unknown>;
  overKeyed.untrusted = true;
  assert.throws(
    () => parseWorkflowRecord(`${JSON.stringify(overKeyed)}\n`),
    (error) => isWorkflowError(error, 'EXECUTION_RECORD_INVALID'),
  );
});

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

test('a bounded grant reaches the fingerprint boundary, not only past it', () => {
  // At exactly maxSameFailureFingerprint the ladder demands a changed
  // strategy, and no automatic executor exists for one. The bounded grant is
  // the same manual lever the past-the-boundary branch already honors; a
  // decision that ignores it here is executable by nobody.
  const initial = createJob();
  const crash = classifyExecutionFailure({
    kind: 'provider-process-crash',
    stage: 'plan-review',
    inputDigest: initial.attempt.inputDigest,
    environmentDigest: initial.attempt.environmentDigest,
    observedAt: LATER,
  });
  const boundedGrantRequest: Parameters<
    typeof decideRetry
  >[0]['boundedGrantRequest'] = {
    schemaVersion: 1,
    kind: 'execution-budget-grant-request',
    requestId: '123e4567-e89b-42d3-a456-426614174001',
    workflowId: WORKFLOW.workflowId,
    epoch: WORKFLOW.currentEpoch,
    jobId: initial.job.jobId,
    mandateBinding: MANDATE_BINDING,
    requestedChanges: [{ path: '/retryPolicy/maxAttempts', from: 4, to: 5 }],
    rationale: 'one bounded replacement attempt',
    expiresAfterAttempts: 1,
    createdAt: LATER,
  };

  const granted = decideRetry({
    workflow: WORKFLOW,
    job: initial.job,
    attempt: initial.attempt,
    failure: crash,
    sameFingerprintCount: 2,
    boundedGrantRequest,
    now: LATER,
  });
  assert.equal(granted.retryable, true);
  assert.equal(granted.automatic, false);
  assert.equal(granted.reasonCode, 'REPEATED_FAILURE_GRANT_REQUIRED');
  assert.equal(
    granted.requiredGrant?.requestId,
    '123e4567-e89b-42d3-a456-426614174001',
  );

  // Without the grant candidate the boundary still reports the changed-
  // strategy requirement exactly as before.
  const ungranted = decideRetry({
    workflow: WORKFLOW,
    job: initial.job,
    attempt: initial.attempt,
    failure: crash,
    sameFingerprintCount: 2,
    now: LATER,
  });
  assert.equal(ungranted.retryMode, 'strategy-change');
  assert.equal(ungranted.changedStrategyRequired, true);
});
