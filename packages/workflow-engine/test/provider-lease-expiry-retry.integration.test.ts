import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { projectProviderInvocationExecution } from '../src/execution-core.ts';
import { readExecutionJobState } from '../src/execution-store.ts';
import { discoverRepository } from '../src/git.ts';
import {
  expireInvestigationProviderLease,
  getInvestigationStatus,
} from '../src/investigation-session.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { startPropose } from '../src/propose-orchestrator.ts';
import {
  claimProviderInvocation,
  failProviderInvocation,
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../src/provider-invocation-store.ts';
import {
  processProviderFailureRetry,
  readProviderAutomaticRetrySchedule,
} from '../src/provider-retry-scheduler.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test('an expired provider lease schedules one freshly fenced replacement Attempt', () => {
  const changeId = 'lease-expiry-automatic-replacement';
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const investigation = started.investigation!;
    const invocationId = investigation.providerInvocationId;
    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const original = readProviderInvocation(runtime, invocationId);
    const originalRequest = readProviderInvocationRequest(
      runtime,
      invocationId,
    );
    const originalProjection = projectProviderInvocationExecution({
      record: original,
      request: originalRequest,
    });
    const originalClaim = claimProviderInvocation(runtime, invocationId, {
      workerId: 'expired-worker',
      leaseDurationMs: 1_000,
      expectedRevision: original.revision,
      now: original.createdAt,
    });
    const expiresAt = originalClaim.record.lease!.expiresAt;
    const beforeExpiry = getInvestigationStatus(
      repository,
      investigation.investigationId,
    );

    const expired = expireInvestigationProviderLease(
      repository,
      investigation.investigationId,
      {
        expectedSessionRevision: beforeExpiry.revision,
        expectedInvocationRevision: originalClaim.record.revision,
        now: expiresAt,
      },
    );
    assert.equal(expired.provider.state, 'failed');
    assert.equal(
      expired.provider.failure?.code,
      'PROVIDER_INVOCATION_LEASE_EXPIRED',
    );

    const dispatched: string[] = [];
    const retry = processProviderFailureRetry(repository, invocationId, {
      now: expiresAt,
      dispatcher(_cwd, replacementInvocationId) {
        dispatched.push(replacementInvocationId);
      },
    });
    assert.equal(retry.kind, 'replacement-dispatched');

    const schedule = readProviderAutomaticRetrySchedule(
      repository,
      invocationId,
    );
    assert.ok(schedule);
    assert.equal(schedule.failureCode, 'PROVIDER_INVOCATION_LEASE_EXPIRED');
    assert.equal(schedule.route, 'provider-replacement');
    assert.equal(schedule.retryMode, 'same-input');
    assert.ok(schedule.replacementInvocationId);
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);

    const replacement = readProviderInvocation(
      runtime,
      schedule.replacementInvocationId,
    );
    const replacementRequest = readProviderInvocationRequest(
      runtime,
      replacement.invocationId,
    );
    const replacementProjection = projectProviderInvocationExecution({
      record: replacement,
      request: replacementRequest,
    });
    assert.equal(replacement.attempt, original.attempt + 1);
    assert.equal(replacement.state, 'prepared');
    assert.equal(replacementProjection.job.jobId, originalProjection.job.jobId);
    assert.equal(
      replacementProjection.job.contextDigest,
      originalProjection.job.contextDigest,
    );
    assert.equal(replacementProjection.job.epoch, originalProjection.job.epoch);

    const claimNow = new Date(
      Math.max(Date.parse(expiresAt), Date.parse(replacement.createdAt)) + 1,
    ).toISOString();
    const replacementClaim = claimProviderInvocation(
      runtime,
      replacement.invocationId,
      {
        workerId: 'replacement-worker',
        leaseDurationMs: 1_000,
        expectedRevision: replacement.revision,
        now: claimNow,
      },
    );
    assert.notEqual(replacementClaim.leaseToken, originalClaim.leaseToken);
    assert.throws(
      () =>
        failProviderInvocation(runtime, replacement.invocationId, {
          expectedRevision: replacementClaim.record.revision,
          leaseGeneration: replacementClaim.record.leaseGeneration,
          leaseToken: originalClaim.leaseToken,
          failure: {
            kind: 'retryable',
            code: 'NETWORK_TRANSIENT',
            message: 'The expired worker must not control the replacement.',
          },
          now: new Date(Date.parse(claimNow) + 1).toISOString(),
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_STALE'),
    );

    const state = readExecutionJobState(runtime, schedule.executionJobId);
    assert.ok(state);
    assert.equal(state.attempts.length, 2);
    assert.equal(state.attempts[0]?.status, 'failed-retryable');
    assert.equal(state.attempts[1]?.status, 'leased');
    assert.equal(state.attempts[1]?.retryOf, state.attempts[0]?.attemptId);
    assert.equal(
      state.attempts[1]?.legacyInvocation?.invocationId,
      replacement.invocationId,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Exercise automatic replacement after a provider lease expires.',
    explicitPaths: ['packages/workflow-engine/src/provider-retry-scheduler.ts'],
    explicitSymbols: ['processProviderFailureRetry'],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}
