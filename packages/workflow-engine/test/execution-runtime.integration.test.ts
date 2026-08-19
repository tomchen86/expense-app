import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import {
  authorizeLegacyReplacement,
  inspectExecutionJob,
  listExecutionJobs,
  prepareLegacyReplacement,
} from '../src/runtime/provider-execution/execution-runtime.ts';
import { requestExecutionReplacement } from '../src/application/control-plane/execution-replacement.ts';
import { canonicalExecutionBudgetGrantRequest } from '../src/modules/authority/execution-governance.ts';
import { readExecutionJobState } from '../src/runtime/storage-journal/execution-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type ProviderInvocationFailure,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const INVESTIGATION_ID = 'investigation-execution-runtime';
const CHANGE_ID = 'demo-change';
const RUNTIME_MANDATE_BINDING = {
  schemaVersion: 1 as const,
  mandateTaskId: 'runtime-grant-task',
  mandateId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: 'a'.repeat(64),
  changeId: CHANGE_ID,
  externalAuditRoot: '/private/tmp/execution-runtime-authority-audit',
};

test('300 to 600 is one legacy Job with replacement Attempt lineage and one accepted winner', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const first = createRequest(
      repository,
      manifest,
      'invocation-runtime-attempt-1',
      300_000,
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: INVESTIGATION_ID,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request: first,
      createdAt: '2026-08-03T09:00:00.000Z',
    });
    failInvocation(runtime, first, '2026-08-03T09:05:00.000Z');

    const failedView = listExecutionJobs(repository);
    assert.equal(failedView.length, 1);
    assert.equal(failedView[0]!.attempts.length, 1);
    assert.equal(failedView[0]!.latestFailure?.decision.automatic, true);
    assert.equal(failedView[0]!.job.status, 'waiting-retry');
    assert.equal(failedView[0]!.workflow.blocker, null);
    const jobId = failedView[0]!.job.jobId;
    const cliStatus = runWorkflowCli(repository, [
      'job',
      'status',
      jobId,
      '--json',
    ]);
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    assert.equal(
      (JSON.parse(cliStatus.stdout) as { result: ExecutionJobResult }).result
        .job.jobId,
      jobId,
    );
    const cliPreview = runWorkflowCli(repository, [
      'job',
      'retry-preview',
      jobId,
      '--timeout',
      '600000',
      '--json',
    ]);
    assert.equal(cliPreview.status, 0, cliPreview.stderr);
    assert.deepEqual(
      (JSON.parse(cliPreview.stdout) as { result: ReplacementResult }).result
        .changedFields,
      [{ path: '/timeoutMs', from: 300_000, to: 600_000 }],
    );
    const beforePreview = fs.readFileSync(
      path.join(runtime.invocations, first.invocationId, 'state.json'),
      'utf8',
    );
    const preview = prepareLegacyReplacement(repository, jobId, {
      timeoutMs: 600_000,
      now: '2026-08-03T09:06:00.000Z',
    });
    assert.equal(preview.retryMode, 'execution-policy-change');
    assert.deepEqual(preview.changedFields, [
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);
    assert.equal(preview.attemptNumber, 2);
    assert.equal(
      fs.readFileSync(
        path.join(runtime.invocations, first.invocationId, 'state.json'),
        'utf8',
      ),
      beforePreview,
    );

    const second = createRequest(
      repository,
      manifest,
      'invocation-runtime-attempt-2',
      600_000,
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: INVESTIGATION_ID,
      changeId: CHANGE_ID,
      attempt: 2,
      manifest,
      request: second,
      createdAt: '2026-08-03T09:06:00.000Z',
    });
    completeInvocation(runtime, second, '2026-08-03T09:08:00.000Z');

    const inspected = inspectExecutionJob(repository, jobId);
    assert.equal(inspected.workflow.workflowId, INVESTIGATION_ID);
    assert.equal(inspected.workflow.currentEpoch, 1);
    assert.equal(inspected.job.jobId, jobId);
    assert.equal(inspected.job.attemptCount, 2);
    assert.equal(inspected.attempts.length, 2);
    assert.equal(inspected.attempts[1]!.jobId, jobId);
    assert.equal(
      inspected.attempts[1]!.retryOf,
      inspected.attempts[0]!.attemptId,
    );
    assert.equal(inspected.attempts[1]!.retryMode, 'execution-policy-change');
    assert.deepEqual(inspected.attempts[1]!.changedFields, [
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);
    assert.equal(inspected.acceptedAttemptId, inspected.attempts[1]!.attemptId);
    assert.deepEqual(
      inspected.results.map(({ attemptId, acceptance }) => ({
        attemptId,
        acceptance,
      })),
      [
        {
          attemptId: inspected.attempts[1]!.attemptId,
          acceptance: 'accepted',
        },
      ],
    );
    assert.equal(
      inspected.latestFailure?.decision.reasonCode,
      'JOB_RESULT_ALREADY_ACCEPTED',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('multiple legacy successes expose one winner and later output as late-duplicate', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    for (const attempt of [1, 2]) {
      const request = createRequest(
        repository,
        manifest,
        `invocation-runtime-winner-${attempt}`,
        600_000,
      );
      createDirectProviderInvocation(repository, runtime, {
        investigationId: 'investigation-runtime-winner',
        changeId: CHANGE_ID,
        attempt,
        manifest,
        request,
        createdAt: `2026-08-03T10:0${attempt}:00.000Z`,
      });
      completeInvocation(runtime, request, `2026-08-03T10:1${attempt}:00.000Z`);
    }
    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    assert.equal(inspection.results[0]!.acceptance, 'accepted');
    assert.equal(inspection.results[1]!.acceptance, 'late-duplicate');
    assert.equal(inspection.attempts[0]!.status, 'succeeded');
    assert.equal(inspection.attempts[1]!.status, 'late-duplicate');
    assert.equal(
      inspection.acceptedAttemptId,
      inspection.results[0]!.attemptId,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('exhausted retryable legacy Job returns a concrete scoped GrantRequest', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const request = createRequest(
        repository,
        manifest,
        `invocation-runtime-exhausted-${attempt}`,
        300_000,
        'investigation-runtime-exhausted',
      );
      createDirectProviderInvocation(repository, runtime, {
        investigationId: 'investigation-runtime-exhausted',
        changeId: CHANGE_ID,
        mandateBinding: RUNTIME_MANDATE_BINDING,
        attempt,
        manifest,
        request,
        createdAt: `2026-08-03T11:0${attempt}:00.000Z`,
      });
      failInvocation(runtime, request, `2026-08-03T11:1${attempt}:00.000Z`);
    }
    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    const decision = inspection.latestFailure?.decision;
    assert.equal(decision?.automatic, false);
    assert.equal(decision?.retryable, true);
    assert.equal(decision?.reasonCode, 'REPEATED_FAILURE_GRANT_REQUIRED');
    assert.equal(
      decision?.requiredGrant?.workflowId,
      inspection.workflow.workflowId,
    );
    assert.equal(decision?.requiredGrant?.epoch, inspection.job.epoch);
    assert.equal(decision?.requiredGrant?.jobId, inspection.job.jobId);
    assert.deepEqual(
      decision?.requiredGrant?.mandateBinding,
      RUNTIME_MANDATE_BINDING,
    );
    assert.equal(decision?.requiredGrant?.expiresAfterAttempts, 1);
    assert.equal(inspection.job.status, 'waiting-grant');
    assert.equal(inspection.workflow.status, 'active');
    assert.equal(inspection.workflow.blocker?.kind, 'human-grant');
    assert.equal(inspection.workflow.blocker?.jobId, inspection.job.jobId);
    assert.match(
      inspection.workflow.blocker?.detailsDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(
      readExecutionJobState(runtime, inspection.job.jobId)?.job.status,
      'waiting-grant',
    );
    const retryRequest = requestExecutionReplacement(
      repository,
      inspection.job.jobId,
      { timeoutMs: 600_000 },
    );
    assert.deepEqual(retryRequest.request.requestedChanges, [
      { path: '/retryPolicy/maxAttempts', from: 4, to: 5 },
      {
        path: '/retryPolicy/maxSameFailureFingerprint',
        from: 2,
        to: 3,
      },
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);
    assert.equal(
      fs.readFileSync(retryRequest.requestPath, 'utf8'),
      canonicalExecutionBudgetGrantRequest(retryRequest.request),
    );
    assert.deepEqual(
      requestExecutionReplacement(repository, inspection.job.jobId, {
        timeoutMs: 600_000,
      }),
      retryRequest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('retry budget boundary stays automatic below the limit and projects a scoped grant exactly at exhaustion', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const request = createRequest(
        repository,
        manifest,
        `invocation-runtime-budget-boundary-${attempt}`,
        300_000,
        'investigation-runtime-budget-boundary',
      );
      createDirectProviderInvocation(repository, runtime, {
        investigationId: 'investigation-runtime-budget-boundary',
        changeId: CHANGE_ID,
        mandateBinding: RUNTIME_MANDATE_BINDING,
        attempt,
        manifest,
        request,
        createdAt: `2026-08-03T13:0${attempt}:00.000Z`,
      });
      failInvocation(
        runtime,
        request,
        `2026-08-03T13:1${attempt}:00.000Z`,
        `PROVIDER_TIMEOUT_DISTINCT_${attempt}`,
      );
    }
    let [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    assert.equal(inspection.job.attemptCount, 3);
    assert.equal(inspection.job.status, 'waiting-retry');
    assert.equal(inspection.workflow.blocker, null);
    assert.equal(inspection.latestFailure?.decision.automatic, true);
    assert.equal(inspection.latestFailure?.decision.requiredGrant, undefined);

    const fourth = createRequest(
      repository,
      manifest,
      'invocation-runtime-budget-boundary-4',
      300_000,
      'investigation-runtime-budget-boundary',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-runtime-budget-boundary',
      changeId: CHANGE_ID,
      mandateBinding: RUNTIME_MANDATE_BINDING,
      attempt: 4,
      manifest,
      request: fourth,
      createdAt: '2026-08-03T13:04:00.000Z',
    });
    failInvocation(
      runtime,
      fourth,
      '2026-08-03T13:14:00.000Z',
      'PROVIDER_TIMEOUT_DISTINCT_4',
    );
    [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    assert.equal(inspection.job.attemptCount, 4);
    assert.equal(inspection.job.status, 'waiting-grant');
    assert.equal(inspection.workflow.blocker?.kind, 'human-grant');
    assert.equal(
      inspection.latestFailure?.decision.reasonCode,
      'EXECUTION_GRANT_REQUIRED',
    );
    assert.ok(inspection.latestFailure?.decision.requiredGrant);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('needs-user-decision projects durable waiting-human-input without suspending the Workflow', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-runtime-needs-user-decision',
      300_000,
      'investigation-runtime-needs-user-decision',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-runtime-needs-user-decision',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T14:00:00.000Z',
    });
    failInvocation(runtime, request, '2026-08-03T14:01:00.000Z', {
      kind: 'retryable',
      code: 'NEEDS_USER_DECISION',
      message: 'A product-scope choice requires human semantic input.',
      executionKind: 'needs-user-decision',
    });

    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    assert.equal(inspection.job.status, 'waiting-human-input');
    assert.equal(inspection.workflow.status, 'active');
    assert.equal(inspection.workflow.blocker?.kind, 'human-input');
    assert.equal(inspection.workflow.blocker?.jobId, inspection.job.jobId);
    assert.equal(
      inspection.latestFailure?.decision.reasonCode,
      'NEEDS_USER_DECISION',
    );
    assert.equal(
      readExecutionJobState(runtime, inspection.job.jobId)?.workflow.blocker
        ?.kind,
      'human-input',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('unknown side effect projects a durable manual-reconciliation blocker', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-runtime-unknown-side-effect',
      300_000,
      'investigation-runtime-unknown-side-effect',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-runtime-unknown-side-effect',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T15:00:00.000Z',
    });
    failInvocation(runtime, request, '2026-08-03T15:01:00.000Z', {
      kind: 'repository-reconciliation-required',
      code: 'UNKNOWN_SIDE_EFFECT_STATE',
      message: 'The external effect outcome cannot be proven.',
      executionKind: 'unknown-side-effect',
    });

    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    assert.equal(inspection.job.status, 'failed-terminal');
    assert.equal(inspection.workflow.status, 'active');
    assert.equal(inspection.workflow.blocker?.kind, 'manual-reconciliation');
    assert.equal(inspection.workflow.blocker?.jobId, inspection.job.jobId);
    assert.equal(
      inspection.latestFailure?.decision.reasonCode,
      'MANUAL_RECONCILIATION_REQUIRED',
    );
    assert.equal(
      readExecutionJobState(runtime, inspection.job.jobId)?.workflow.blocker
        ?.kind,
      'manual-reconciliation',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('runtime inspection uses stable errors for invalid and absent Job IDs', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => inspectExecutionJob(repository, '../job'),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_JOB_ID_INVALID'),
    );
    assert.throws(
      () =>
        inspectExecutionJob(repository, `job-legacy-survey-${'0'.repeat(32)}`),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_JOB_NOT_FOUND'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy unmandated Job cannot mint new execution-budget authority', () => {
  const repository = createFixtureRepository();
  try {
    const context = loadInvestigationRuntimeContext(repository);
    const manifest = createManifest(repository);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const request = createRequest(
        repository,
        manifest,
        `invocation-runtime-granted-${attempt}`,
        300_000,
        'investigation-runtime-granted',
      );
      createDirectProviderInvocation(repository, context.runtime, {
        investigationId: 'investigation-runtime-granted',
        changeId: CHANGE_ID,
        attempt,
        manifest,
        request,
        createdAt: `2026-08-03T12:0${attempt}:00.000Z`,
      });
      failInvocation(
        context.runtime,
        request,
        `2026-08-03T12:1${attempt}:00.000Z`,
        `PROVIDER_TIMEOUT_${attempt}`,
      );
    }
    const [inspection] = listExecutionJobs(repository);
    const grantRequest = inspection?.latestFailure?.decision.requiredGrant;
    assert.ok(inspection);
    assert.equal(grantRequest, undefined);

    assert.throws(
      () =>
        authorizeLegacyReplacement(repository, inspection.job.jobId, {
          grantId: '33333333-3333-4333-8333-333333333333',
          timeoutMs: 600_000,
          now: '2026-08-03T12:16:00.000Z',
        }),
      (error) =>
        isWorkflowError(
          error,
          'EXECUTION_RUNTIME_PREVIEW_AUTHORIZATION_DISABLED',
        ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

type ExecutionJobResult = ReturnType<typeof inspectExecutionJob>;
type ReplacementResult = ReturnType<typeof prepareLegacyReplacement>;

function runWorkflowCli(repository: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      ...args,
    ],
    { cwd: repository, encoding: 'utf8' },
  );
}

function createManifest(repository: string): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: CHANGE_ID,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Inspect legacy provider retries through one stable Job.',
      explicitPaths: [
        'packages/workflow-engine/src/runtime/provider-execution/execution-runtime.ts',
      ],
      explicitSymbols: ['inspectExecutionJob'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'How should legacy provider retries retain stable execution identity?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
  timeoutMs: number,
  investigationId = INVESTIGATION_ID,
): ProviderInvocationRequest {
  const targetDigest = blindSurveyIntentDigest(manifest);
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: `provider-session-${investigationId}`,
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: loadAiAdapterPolicy(repository).digest,
    limits: { timeoutMs, aggregateOutputBytes: 1_048_576 },
  });
}

function createDirectProviderInvocation(
  repository: string,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  input: Parameters<typeof createProviderInvocation>[1],
) {
  storeProviderExecutionPolicySnapshot(
    runtime,
    input.request,
    loadAiAdapterPolicy(repository),
  );
  return createProviderInvocation(runtime, input);
}

function failInvocation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
  now: string,
  failureInput: string | ProviderInvocationFailure = 'PROVIDER_TIMEOUT',
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(now) - 60_000).toISOString(),
  });
  failProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure:
      typeof failureInput === 'string'
        ? {
            kind: 'retryable',
            code: failureInput,
            message: `Provider timed out after ${request.limits.timeoutMs}ms.`,
          }
        : failureInput,
    now,
  });
}

function completeInvocation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
  now: string,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(now) - 60_000).toISOString(),
  });
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
    now,
  });
}

function providerOutcome(
  request: ProviderInvocationRequest,
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify({
      schemaVersion: 1,
      requestDigest: request.requestDigest,
      invocationId: request.invocationId,
      nonce: request.nonce,
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignmentDigest: request.roleAssignmentDigest,
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: request.policyDigest,
      limits: request.limits,
      observedTouchedPaths: [],
      output: {
        reference: request.invocationId,
        terms: [{ kind: 'symbol', value: 'ExecutionRuntime' }],
      },
    }),
    stderr: '',
  };
}
