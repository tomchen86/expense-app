import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import {
  listExecutionJobStates,
  readExecutionJobState,
} from '../src/execution-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type ProviderInvocationFailure,
} from '../src/provider-invocation-store.ts';
import { createFixtureRepository, git } from './fixture.ts';

const OBSERVED_AT = '2026-08-10T09:05:00.000Z';

for (const scenario of [
  {
    name: 'rate-limit',
    failure: {
      kind: 'retryable',
      code: 'PROVIDER_RATE_LIMIT',
      message: 'The provider asked the worker to retry later.',
      executionKind: 'rate-limit',
      retryAfterMs: 23_000,
    } satisfies ProviderInvocationFailure,
    expectedBlocker: {
      kind: 'retry-delay',
      retryAt: '2026-08-10T09:05:23.000Z',
    },
  },
  {
    name: 'provider-capacity',
    failure: {
      kind: 'retryable',
      code: 'PROVIDER_CAPACITY',
      message: 'The provider has no execution capacity.',
      executionKind: 'provider-capacity',
    } satisfies ProviderInvocationFailure,
    expectedBlocker: {
      kind: 'provider-capacity',
    },
  },
] as const) {
  test(`${scenario.name} projects an exact durable Workflow blocker until replacement materialization`, () => {
    const repository = createFixtureRepository();
    try {
      const investigationId = `investigation-${scenario.name}-blocker`;
      const runtime = loadInvestigationRuntimeContext(repository).runtime;
      const manifest = createManifest(repository, scenario.name);
      const first = createRequest(
        repository,
        manifest,
        investigationId,
        `invocation-${scenario.name}-attempt-1`,
      );
      createDirectProviderInvocation(repository, runtime, {
        investigationId,
        changeId: manifest.changeId,
        attempt: 1,
        manifest,
        request: first,
        createdAt: '2026-08-10T09:00:00.000Z',
      });
      failInvocation(runtime, first, scenario.failure);

      const failedState = requiredExecutionState(runtime);
      const failedAttempt = failedState.attempts[0]!;
      assert.ok(failedAttempt.failure);
      assert.deepEqual(failedState.workflow.blocker, {
        ...scenario.expectedBlocker,
        since: OBSERVED_AT,
        jobId: failedState.job.jobId,
        detailsDigest: failedAttempt.failure.fingerprint,
      });
      assert.equal(failedState.job.status, 'waiting-retry');

      const replacement = createRequest(
        repository,
        manifest,
        investigationId,
        `invocation-${scenario.name}-attempt-2`,
      );
      createDirectProviderInvocation(repository, runtime, {
        investigationId,
        changeId: manifest.changeId,
        attempt: 2,
        manifest,
        request: replacement,
        createdAt: '2026-08-10T09:06:00.000Z',
      });

      const replacementState = readExecutionJobState(
        runtime,
        failedState.job.jobId,
      );
      assert.ok(replacementState);
      assert.equal(replacementState.attempts.length, 2);
      assert.equal(
        replacementState.attempts[1]?.retryOf,
        failedAttempt.attemptId,
      );
      assert.equal(replacementState.workflow.blocker, null);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function createManifest(
  repository: string,
  scenario: string,
): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: `blocker-${scenario}`,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: `Project the ${scenario} execution blocker.`,
      explicitPaths: [
        'packages/workflow-engine/src/modules/provider-orchestration/execution-core.ts',
      ],
      explicitSymbols: ['projectExecutionFailureState'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'How does a retryable provider failure remain visible without suspending its Workflow?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  investigationId: string,
  invocationId: string,
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
    limits: { timeoutMs: 300_000, aggregateOutputBytes: 1_048_576 },
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
  failure: ProviderInvocationFailure,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: '2026-08-10T09:04:00.000Z',
  });
  failProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure,
    now: OBSERVED_AT,
  });
}

function requiredExecutionState(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
) {
  const states = listExecutionJobStates(runtime);
  assert.equal(states.length, 1);
  const durable = readExecutionJobState(runtime, states[0]!.job.jobId);
  assert.ok(durable);
  return durable;
}
