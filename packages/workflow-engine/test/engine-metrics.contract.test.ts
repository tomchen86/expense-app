import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type {
  AttemptRecord,
  FailureDescriptor,
  JobRecord,
  WorkflowRecord,
} from '../src/modules/provider-orchestration/execution-core.ts';
import type { ExecutionJobInspection } from '../src/runtime/provider-execution/execution-runtime.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  collectEngineMetrics,
  computeEngineMetrics,
  inspectEngineSupersedeReason,
  type EngineMetricsSnapshot,
} from '../src/application/control-plane/engine-metrics.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  createExecutionBudgetGrantEnvelope,
  createExecutionBudgetGrantRequest,
  storeExecutionBudgetGrant,
} from '../src/modules/authority/execution-governance.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  compareAndSwapHumanResolutionHead,
  createHumanResolutionNode,
  writeHumanResolutionNode,
} from '../src/runtime/storage-journal/investigation-session-store.ts';
import type { ProviderRetentionMetrics } from '../src/runtime/provider-execution/provider-retention.ts';
import type { TaskMandateBinding } from '../src/modules/authority/task-mandate.ts';
import { createFixtureRepository, sourceRepositoryRoot } from './fixture.ts';

const NOW = '2026-08-03T10:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

test('engine metrics derive resilience, speed, governance, and storage measures', () => {
  const first = inspection(
    'job-a',
    'stage-a',
    [
      attempt('a-1', 1, 'timed-out', '2026-08-03T09:00:00.000Z', {
        failure: failure('timeout-repeat', 'provider', 'retryable'),
      }),
      attempt('a-2', 2, 'timed-out', '2026-08-03T09:05:00.000Z', {
        retryMode: 'same-input',
        retryOf: 'a-1',
        failure: failure('timeout-repeat', 'provider', 'retryable'),
      }),
      attempt('a-3', 3, 'succeeded', '2026-08-03T09:10:00.000Z', {
        retryMode: 'execution-policy-change',
        retryOf: 'a-2',
        grantId: 'grant-timeout',
      }),
      attempt('a-4', 4, 'late-duplicate', '2026-08-03T09:11:00.000Z', {
        retryMode: 'same-input',
        retryOf: 'a-3',
      }),
    ],
    'a-3',
  );
  first.workflow.blocker = {
    kind: 'human-grant',
    since: '2026-08-03T08:00:00.000Z',
  };
  const second = inspection(
    'job-b',
    'stage-b',
    [
      attempt('b-1', 1, 'failed-retryable', '2026-08-03T09:20:00.000Z', {
        failure: failure('network-once', 'network', 'retryable'),
      }),
      attempt('b-2', 2, 'succeeded', '2026-08-03T09:25:00.000Z', {
        retryMode: 'same-input',
        retryOf: 'b-1',
      }),
    ],
    'b-2',
  );
  const third = inspection(
    'job-c',
    'stage-c',
    [
      attempt('c-1', 1, 'failed-retryable', '2026-08-03T09:30:00.000Z', {
        failure: failure('schema-once', 'validator', 'repairable'),
      }),
      attempt('c-2', 2, 'succeeded', '2026-08-03T09:35:00.000Z', {
        retryMode: 'repair',
        retryOf: 'c-1',
      }),
    ],
    'c-2',
  );

  const metrics = computeEngineMetrics(
    [first, second, third],
    storageMetrics(),
    NOW,
  );

  assert.deepEqual(metrics.metrics.attempt_failure_recovered_rate, {
    numerator: 4,
    denominator: 4,
    value: 1,
  });
  assert.deepEqual(metrics.metrics.automatic_retry_success_rate, {
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.deepEqual(metrics.metrics.repair_retry_success_rate, {
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  assert.equal(metrics.metrics.late_output_rejected_count, 1);
  assert.equal(metrics.metrics.same_fingerprint_replay_count, 1);
  assert.equal(metrics.metrics.median_failure_to_next_attempt_ms, 300_000);
  assert.equal(metrics.metrics.median_failure_to_recovery_ms, 300_000);
  assert.equal(metrics.metrics.human_actions_per_recoverable_failure, 0.25);
  assert.equal(metrics.metrics.stages_recomputed_per_retry, 1);
  assert.equal(metrics.metrics.workflow_blocked_hours, 13 / 6);
  assert.equal(metrics.metrics.suspended_created_count, 0);
  assert.deepEqual(metrics.metrics.supersede_by_reason, {});
  assert.equal(metrics.metrics.direct_refusal_count, 0);
  assert.equal(metrics.metrics.grant_request_count, 1);
  assert.deepEqual(metrics.metrics.grant_to_success_rate, {
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  assert.deepEqual(metrics.metrics.raw_evidence_bytes_by_retention_class, {
    active: 120,
    debug: 30,
    pinned: 10,
  });
  assert.deepEqual(metrics.metrics.expired_pending_deletion, {
    count: 2,
    bytes: 30,
  });
  assert.equal(metrics.metrics.pinned_count, 1);
  assert.equal(metrics.metrics.receipt_count, 3);
});

test('engine metrics retain historical wait time and count one stage per replacement Attempt', () => {
  const observed = inspection(
    'job-history',
    'plan-review',
    [
      attempt('history-1', 1, 'failed-retryable', '2026-08-03T08:00:00.000Z', {
        failure: failure('network-history-1', 'network', 'retryable'),
      }),
      attempt('history-2', 2, 'failed-retryable', '2026-08-03T09:00:00.000Z', {
        retryMode: 'same-input',
        retryOf: 'history-1',
        failure: failure('network-history-2', 'network', 'retryable'),
      }),
      attempt('history-3', 3, 'succeeded', '2026-08-03T09:30:00.000Z', {
        retryMode: 'strategy-change',
        retryOf: 'history-1',
      }),
    ],
    'history-3',
  );

  const metrics = computeEngineMetrics([observed], storageMetrics(), NOW);

  assert.equal(metrics.metrics.stages_recomputed_per_retry, 1);
  assert.equal(metrics.metrics.workflow_blocked_hours, 1.5);
});

test('engine governance metrics count issued-but-unused grants in the success denominator', () => {
  const observed = inspection(
    'job-grants',
    'provider-call',
    [
      attempt('grant-1', 1, 'failed-retryable', '2026-08-03T09:00:00.000Z', {
        failure: failure('budget-grant', 'provider', 'retryable'),
      }),
      attempt('grant-2', 2, 'succeeded', '2026-08-03T09:05:00.000Z', {
        retryMode: 'execution-policy-change',
        retryOf: 'grant-1',
        grantId: 'issued-and-successful',
      }),
    ],
    'grant-2',
  );
  const otherRequestDigest = `sha256:${'b'.repeat(64)}`;

  const metrics = computeEngineMetrics([observed], storageMetrics(), NOW, {
    grantRequestDigests: [DIGEST, otherRequestDigest],
    issuedGrants: [
      {
        grantId: 'issued-and-successful',
        requestDigest: DIGEST,
        consumedAttemptIds: ['grant-2'],
      },
      {
        grantId: 'issued-but-unused',
        requestDigest: otherRequestDigest,
        consumedAttemptIds: [],
      },
    ],
    supersedeReasons: [],
  });

  assert.equal(metrics.metrics.grant_request_count, 2);
  assert.deepEqual(metrics.metrics.grant_to_success_rate, {
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.equal(metrics.metrics.human_actions_per_recoverable_failure, 2);
});

test('engine governance metrics use canonical supersede reasons and isolate legacy unknowns', () => {
  const canonical = inspection(
    'job-canonical-supersede',
    'plan-review',
    [attempt('canonical-1', 1, 'succeeded', NOW)],
    'canonical-1',
  );
  canonical.workflow.status = 'superseded';
  const legacy = inspection(
    'job-legacy-supersede',
    'survey',
    [attempt('legacy-1', 1, 'succeeded', NOW)],
    'legacy-1',
  );
  legacy.workflow.status = 'superseded';

  const metrics = computeEngineMetrics(
    [canonical, legacy],
    storageMetrics(),
    NOW,
    {
      grantRequestDigests: [],
      issuedGrants: [],
      supersedeReasons: [
        {
          workflowId: canonical.workflow.workflowId,
          reason: 'workflow-replaced',
        },
        {
          workflowId: legacy.workflow.workflowId,
          reason: 'legacy-unknown',
        },
      ],
    },
  );

  assert.deepEqual(metrics.metrics.supersede_by_reason, {
    'legacy-unknown': 1,
    'workflow-replaced': 1,
  });
});

test('production metrics enumerate issued unused grants and durable replacement requests', () => {
  const repository = createFixtureRepository();
  const auditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join('/tmp', 'engine-metrics-audit-')),
  );
  try {
    const runtime = loadInvestigationRuntimeContext(repository);
    fs.mkdirSync(runtime.lifecycleRuntime.root, { mode: 0o700 });
    const binding: TaskMandateBinding = {
      schemaVersion: 1,
      mandateTaskId: 'metrics-task',
      mandateId: '11111111-1111-4111-8111-111111111111',
      mandateDigest: 'c'.repeat(64),
      changeId: 'demo-change',
      externalAuditRoot: auditRoot,
    };
    const issuedRequest = metricsGrantRequest(
      binding,
      '22222222-2222-4222-8222-222222222222',
      600_000,
    );
    const envelope = createExecutionBudgetGrantEnvelope(issuedRequest, {
      grantId: '33333333-3333-4333-8333-333333333333',
      issuedAt: new Date(NOW),
      issuer: 'metrics-maintainer',
      maxUses: 1,
      signature: 'fixture-signature',
    });
    storeExecutionBudgetGrant(runtime.lifecycleRuntime.root, envelope, {
      request: issuedRequest,
      mandateBinding: binding,
      audit: {
        repositoryRoot: fs.realpathSync(repository),
        repositoryIdentity: 'github:R_engine_metrics_fixture',
      },
      verify() {},
    });

    const pendingRequest = metricsGrantRequest(
      binding,
      '44444444-4444-4444-8444-444444444444',
      900_000,
    );
    const pendingBytes = canonicalExecutionBudgetGrantRequest(pendingRequest);
    const pendingDigest = `sha256:${sha256Hex(pendingBytes)}`;
    const requestsDirectory = path.join(
      runtime.lifecycleRuntime.root,
      'execution-replacements',
      'requests',
    );
    fs.mkdirSync(requestsDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(requestsDirectory, `${pendingDigest.slice(7)}.json`),
      pendingBytes,
      { mode: 0o600 },
    );

    const metrics = collectEngineMetrics(repository, { now: NOW });
    assert.equal(metrics.metrics.grant_request_count, 2);
    assert.deepEqual(metrics.metrics.grant_to_success_rate, {
      numerator: 0,
      denominator: 1,
      value: 0,
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test('metrics read canonical supersede reasons and only classify verified legacy nodes as unknown', () => {
  const repository = createFixtureRepository();
  try {
    const { runtime } = loadInvestigationRuntimeContext(repository);
    const resolutionRoot = path.join(runtime.root, 'human-resolutions');
    for (const directory of ['nodes', 'refs', 'locks']) {
      fs.mkdirSync(path.join(resolutionRoot, directory), {
        recursive: true,
        mode: 0o700,
      });
    }
    const canonicalWorkflowId = 'investigation-metrics-canonical';
    const canonicalNode = metricsSupersedeNode(
      canonicalWorkflowId,
      '55555555-5555-4555-8555-555555555555',
    );
    writeHumanResolutionNode(runtime, canonicalNode);
    compareAndSwapHumanResolutionHead(
      runtime,
      canonicalWorkflowId,
      null,
      canonicalNode.nodeId,
    );
    assert.equal(
      inspectEngineSupersedeReason(runtime, canonicalWorkflowId),
      'workflow-replaced',
    );

    const legacyWorkflowId = 'investigation-metrics-legacy';
    const legacyNode = structuredClone(
      metricsSupersedeNode(
        legacyWorkflowId,
        '66666666-6666-4666-8666-666666666666',
      ),
    ) as unknown as Record<string, unknown>;
    const legacyDecision = legacyNode.decision as {
      parameters: Record<string, unknown>;
    };
    delete legacyDecision.parameters.reason;
    const { nodeId: _nodeId, ...legacySemantic } = legacyNode;
    legacyNode.nodeId = crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          schema: 'human-resolution-node.v1',
          node: legacySemantic,
        }),
      )
      .digest('hex');
    fs.writeFileSync(
      path.join(resolutionRoot, 'nodes', `${legacyNode.nodeId}.json`),
      `${canonicalJson(legacyNode)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(resolutionRoot, 'refs', `${legacyWorkflowId}.json`),
      `${canonicalJson({
        schemaVersion: 1,
        investigationId: legacyWorkflowId,
        nodeId: legacyNode.nodeId,
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal(
      inspectEngineSupersedeReason(runtime, legacyWorkflowId),
      'legacy-unknown',
    );

    const malformed = structuredClone(legacyNode);
    malformed.nodeId = 'f'.repeat(64);
    fs.writeFileSync(
      path.join(resolutionRoot, 'nodes', `${malformed.nodeId}.json`),
      `${canonicalJson(malformed)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(resolutionRoot, 'refs', `${legacyWorkflowId}.json`),
      `${canonicalJson({
        schemaVersion: 1,
        investigationId: legacyWorkflowId,
        nodeId: malformed.nodeId,
      })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => inspectEngineSupersedeReason(runtime, legacyWorkflowId),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENGINE_METRICS_STORE_UNSAFE',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('metrics show exposes a zero-sample production snapshot', () => {
  const repository = createFixtureRepository();
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.join(
            sourceRepositoryRoot,
            'packages/workflow-engine/src/cli.ts',
          ),
          'metrics',
          'show',
          '--json',
        ],
        { cwd: repository, encoding: 'utf8' },
      ),
    ) as {
      ok: boolean;
      result: EngineMetricsSnapshot;
    };
    assert.equal(output.ok, true);
    assert.deepEqual(output.result.sample, {
      workflows: 0,
      jobs: 0,
      attempts: 0,
    });
    assert.equal(output.result.metrics.suspended_created_count, 0);
    assert.equal(output.result.metrics.receipt_count, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function inspection(
  jobId: string,
  stage: string,
  attempts: AttemptRecord[],
  acceptedAttemptId: string,
): ExecutionJobInspection {
  const workflow: WorkflowRecord = {
    schemaVersion: 2,
    workflowId: `workflow-${jobId}`,
    currentEpoch: 1,
    contractVersion: 1,
    contextDigest: DIGEST,
    checkpoint: stage,
    status: 'active',
    blocker: null,
    engineBinding: DIGEST,
  };
  const job: JobRecord = {
    schemaVersion: 2,
    jobId,
    workflowId: workflow.workflowId,
    epoch: 1,
    stage,
    contextDigest: DIGEST,
    requestDigest: DIGEST,
    semanticSpec: {
      schemaVersion: 1,
      contractVersion: 1,
      stage,
      contextDigest: DIGEST,
      inputDigest: DIGEST,
      outputContractDigest: DIGEST,
      acceptancePolicyDigest: DIGEST,
    },
    status: 'succeeded',
    acceptedAttemptId,
    attemptCount: attempts.length,
    cumulativeRuntimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    repairAttemptCount: attempts.filter(
      ({ retryMode }) => retryMode === 'repair',
    ).length,
    retryPolicy: {
      maxAttempts: 8,
      maxCumulativeRuntimeMs: 3_600_000,
      maxProviderCostMicros: 0,
      maxProviderTokens: 0,
      maxSameFailureFingerprint: 2,
      maxRepairAttempts: 2,
      deadline: '2026-08-04T00:00:00.000Z',
      providerLimits: { codex: 8 },
    },
    createdAt: attempts[0]!.createdAt,
    updatedAt: attempts.at(-1)!.updatedAt,
  };
  for (const value of attempts) {
    value.jobId = jobId;
    value.workflowId = workflow.workflowId;
  }
  return {
    schemaVersion: 1,
    workflow,
    job,
    attempts,
    acceptedAttemptId,
    attemptNumbering: 'recorded' as const,
    results: [
      {
        attemptId: acceptedAttemptId,
        invocationId: `${acceptedAttemptId}-invocation`,
        acceptance: 'accepted',
        outputDigest: DIGEST,
        outputSchema: 'code-owned' as const,
        residuals: null,
      },
      ...attempts
        .filter(({ status }) => status === 'late-duplicate')
        .map((value) => ({
          attemptId: value.attemptId,
          invocationId: `${value.attemptId}-invocation`,
          acceptance: 'late-duplicate' as const,
          outputDigest: DIGEST,
          outputSchema: 'code-owned' as const,
          residuals: null,
        })),
    ],
    latestFailure: null,
  };
}

function metricsGrantRequest(
  binding: TaskMandateBinding,
  requestId: string,
  timeoutMs: number,
) {
  return createExecutionBudgetGrantRequest({
    requestId,
    workflowId: 'investigation-metrics',
    epoch: 1,
    jobId: 'job-metrics',
    mandateBinding: binding,
    requestedChanges: [{ path: '/timeoutMs', from: 300_000, to: timeoutMs }],
    rationale: 'Measure an exact durable execution replacement request.',
    expiresAfterAttempts: 1,
    createdAt: new Date(NOW),
  });
}

function metricsSupersedeNode(workflowId: string, grantId: string) {
  return createHumanResolutionNode({
    target: {
      workflowKind: 'investigation',
      changeId: 'demo-change',
      workflowId,
    },
    expected: {
      reasonCode: 'workflow-replaced',
      blockedTransition: 'workflow.abort-or-supersede',
      stateDigest: 'd'.repeat(64),
      currentRefDigest: null,
    },
    decision: {
      kind: 'supersede',
      parameters: {
        successorInvestigationId: null,
        reason: 'workflow-replaced',
      },
    },
    consequences: {
      continuity: 'broken',
      assurance: 'unchanged',
      claimsWaived: [],
    },
    grantId,
    grantDigest: 'e'.repeat(64),
    previousResolutionNodeId: null,
    createdAt: NOW,
  });
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function attempt(
  attemptId: string,
  attemptNumber: number,
  status: AttemptRecord['status'],
  updatedAt: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  const observedFailure = overrides.failure ?? null;
  return {
    schemaVersion: 2,
    attemptId,
    jobId: 'pending',
    workflowId: 'pending',
    epoch: 1,
    attemptNumber,
    retryOf: null,
    provider: 'codex',
    status,
    inputDigest: DIGEST,
    requestDigest: DIGEST,
    contextDigest: DIGEST,
    environmentDigest: DIGEST,
    retryMode: 'none',
    policySnapshot: {
      schemaVersion: 1,
      provider: 'codex',
      timeoutMs: 300_000,
      maxOutputBytes: 1_024,
      workerClass: 'fixture',
      backoffMs: 0,
      processEnvironment: {},
      concurrency: 1,
      transientToolConfig: {},
    },
    changedFields: [],
    repairContext: null,
    strategyChanges: [],
    grantId: null,
    failure: observedFailure,
    failureFingerprint: observedFailure?.fingerprint ?? null,
    leaseGeneration: 0,
    lease: null,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: status === 'late-duplicate' ? 'debug' : 'active',
    legacyInvocation: null,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function failure(
  fingerprint: string,
  source: FailureDescriptor['source'],
  retryClass: FailureDescriptor['retryClass'],
): FailureDescriptor {
  return {
    schemaVersion: 1,
    stage: 'fixture',
    code: 'FIXTURE_FAILURE',
    source,
    retryClass,
    sideEffectState: 'none',
    paths: [],
    validatorPath: null,
    inputDigest: DIGEST,
    environmentDigest: DIGEST,
    observedAt: NOW,
    retryAfterMs: null,
    fingerprint,
  };
}

function storageMetrics(): ProviderRetentionMetrics {
  return {
    schemaVersion: 1,
    kind: 'provider-retention-metrics',
    measuredAt: NOW,
    ttlDays: 7,
    rawEvidenceBytesByRetentionClass: {
      active: 120,
      debug: 30,
      pinned: 10,
    },
    expiredPendingDeletion: { count: 2, bytes: 30 },
    pinnedCount: 1,
    receiptCount: 3,
  };
}
