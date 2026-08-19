import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  evaluateProviderProcess,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  projectProviderInvocationExecution,
  type RetryDecision,
} from '../src/modules/provider-orchestration/execution-core.ts';
import { inspectExecutionJob } from '../src/runtime/provider-execution/execution-runtime.ts';
import { readExecutionJobState } from '../src/runtime/storage-journal/execution-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { readProviderAutomaticRetrySchedule } from '../src/runtime/provider-execution/provider-retry-scheduler.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import { createFixtureRepository, git } from './fixture.ts';

for (const scenario of [
  {
    name: 'tool-unavailable',
    failureCode: 'PROVIDER_TOOL_UNAVAILABLE',
    reasonCode: 'PROVIDER_TOOL_CONFIGURATION_REQUIRED',
    run(request: ProviderInvocationRequest): never {
      return rejectProcess(request, { spawnErrorCode: 'ENOENT' });
    },
  },
  {
    name: 'stdout-truncated',
    failureCode: 'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    reasonCode: 'PROVIDER_OUTPUT_CONTEXT_REDUCTION_REQUIRED',
    run(request: ProviderInvocationRequest): never {
      return rejectProcess(request, {
        stderr: 'x'.repeat(request.limits.aggregateOutputBytes),
      });
    },
  },
] as const) {
  test(`${scenario.name} requires a declared strategy change without publishing an identical replacement`, () => {
    const fixture = startWorkerFixture(`strategy-${scenario.name}`);
    try {
      const dispatched: string[] = [];
      const result = runProviderWorker(
        fixture.repository,
        fixture.invocationId,
        {
          runner({ request }) {
            return scenario.run(request);
          },
          automaticRetry: {
            enabled: true,
            dispatcher(_cwd, invocationId) {
              dispatched.push(invocationId);
            },
          },
        },
      );

      assert.equal(result.state, 'failed');
      const failed = readProviderInvocation(
        fixture.runtime,
        fixture.invocationId,
      );
      assert.equal(failed.failure?.code, scenario.failureCode);
      const request = readProviderInvocationRequest(
        fixture.runtime,
        failed.invocationId,
      );
      const projection = projectProviderInvocationExecution({
        record: failed,
        request,
      });
      const durable = readExecutionJobState(
        fixture.runtime,
        projection.job.jobId,
      );
      assert.ok(durable);
      const failedAttempt = durable.attempts[0]!;
      assert.ok(failedAttempt.failure);
      assert.deepEqual(durable.workflow.blocker, {
        kind: 'configuration',
        since: failedAttempt.failure.observedAt,
        jobId: durable.job.jobId,
        detailsDigest: failedAttempt.failure.fingerprint,
      });
      assert.equal(durable.job.status, 'waiting-retry');

      const decision = inspectExecutionJob(
        fixture.repository,
        durable.job.jobId,
      ).latestFailure?.decision;
      assert.deepEqual(decision, {
        retryable: true,
        automatic: false,
        retryMode: 'strategy-change',
        changedStrategyRequired: true,
        reasonCode: scenario.reasonCode,
      } satisfies RetryDecision);
      assert.deepEqual(dispatched, []);
      assert.equal(
        readProviderAutomaticRetrySchedule(
          fixture.repository,
          failed.invocationId,
        ),
        null,
      );
      assert.deepEqual(invocationIds(fixture.runtime.invocations), [
        fixture.invocationId,
      ]);
    } finally {
      fixture.dispose();
    }
  });
}

function startWorkerFixture(changeId: string) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const started = startPropose(repository, changeId, intent(), {
    explicitActor: 'codex',
    environment: {},
  });
  const invocationId = started.investigation!.providerInvocationId;
  const runtime = investigationRuntimePaths(
    discoverRepository(repository).gitCommonDirectory,
    'workflow-engine',
  );
  return {
    repository,
    invocationId,
    runtime,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function rejectProcess(
  request: ProviderInvocationRequest,
  override: Partial<ProviderProcessOutcome>,
): never {
  evaluateProviderProcess(
    request,
    {
      exitCode: 0,
      signal: null,
      timedOut: false,
      spawnErrorCode: null,
      elapsedMs: 10,
      stdout: JSON.stringify(providerResult(request)),
      stderr: '',
      ...override,
    },
    {
      id: request.outputSchema.id,
      version: request.outputSchema.version,
      digest: request.outputSchema.digest,
      validate: () => true,
    },
  );
  assert.fail('The process failure fixture unexpectedly produced a result.');
}

function providerResult(request: ProviderInvocationRequest) {
  return {
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
      terms: [],
    },
  };
}

function invocationIds(invocationsRoot: string): string[] {
  return fs
    .readdirSync(invocationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
}

function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Require a real strategy change before provider replacement.',
    explicitPaths: [
      'packages/workflow-engine/src/modules/provider-orchestration/execution-core.ts',
    ],
    explicitSymbols: ['decideRetry'],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}
