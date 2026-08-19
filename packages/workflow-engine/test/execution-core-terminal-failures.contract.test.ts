import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAttemptResult,
  createExecutionJob,
  createFailureDescriptor,
  decideRetry,
  leaseAttempt,
  type ExecutionPolicySnapshot,
  type WorkflowRecord,
} from '../src/modules/provider-orchestration/execution-core.ts';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const NOW = '2026-08-03T00:00:00.000Z';
const LATER = '2026-08-03T00:01:00.000Z';

const MANDATE_BINDING = {
  schemaVersion: 1 as const,
  mandateTaskId: 'plan-review-task',
  mandateId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: '1'.repeat(64),
  changeId: 'change-a',
  externalAuditRoot: '/private/tmp/execution-core-terminal-audit',
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

const POLICY: ExecutionPolicySnapshot = {
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
    executionPolicy: POLICY,
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

function terminalFailure(code: string) {
  return createFailureDescriptor({
    stage: 'plan-review',
    code,
    source: 'policy',
    retryClass: 'terminal',
    sideEffectState: 'none',
    paths: [],
    inputDigest: digest('b'),
    environmentDigest: digest('f'),
    validatorPath: null,
    observedAt: LATER,
  });
}

test('a terminal failure stays terminal however many times it repeats', () => {
  const initial = createJob();
  const attempt = { ...initial.attempt, status: 'running' as const };
  const failure = terminalFailure('NEEDS_USER_DECISION');

  // The fingerprint ladder converges repeated *retryable* failures onto a
  // changed strategy. A terminal failure must never reach it: the second
  // occurrence used to come back automatic, which would start an Attempt
  // while the Job is projected as waiting on human input.
  for (const sameFingerprintCount of [1, 2, 3]) {
    const decision = decideRetry({
      workflow: WORKFLOW,
      job: initial.job,
      attempt,
      failure,
      currentExecutionPolicy: POLICY,
      sameFingerprintCount,
      nextRuntimeMs: 1_000,
      nextProviderCostMicros: 1_000,
      nextProviderTokens: 100,
      now: LATER,
    });
    assert.equal(decision.retryable, false, `count ${sameFingerprintCount}`);
    assert.equal(decision.automatic, false, `count ${sameFingerprintCount}`);
    assert.equal(decision.retryMode, 'none', `count ${sameFingerprintCount}`);
  }
});

test('a late result for an accepted Job is classified, not thrown', () => {
  const initial = createJob();
  const leased = leaseAttempt(initial.attempt, {
    workerId: 'worker-1',
    leaseToken: 'token-one',
    leaseDurationMs: 120_000,
    now: NOW,
  });
  const accepted = acceptAttemptResult({
    workflow: WORKFLOW,
    job: initial.job,
    attempt: leased,
    expectedAcceptedAttemptId: null,
    leaseGeneration: 1,
    leaseToken: 'token-one',
    outputDigest: digest('7'),
    completedAt: LATER,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.job.acceptedAttemptId, leased.attemptId);

  // The epoch rolls forward while a second Attempt is still in flight.
  const rolled: WorkflowRecord = {
    ...WORKFLOW,
    currentEpoch: 5,
    contextDigest: digest('b'),
  };
  const late = acceptAttemptResult({
    workflow: rolled,
    job: accepted.job,
    attempt: { ...leased, attemptId: 'attempt-002' },
    expectedAcceptedAttemptId: accepted.job.acceptedAttemptId,
    leaseGeneration: 1,
    leaseToken: 'token-one',
    outputDigest: digest('8'),
    completedAt: '2026-08-03T00:02:00.000Z',
  });
  assert.equal(late.accepted, false);
  assert.equal(late.attempt.status, 'stale');
  assert.equal(late.result.acceptance, 'stale');
  // The Job keeps the result it already accepted.
  assert.equal(late.job.status, 'succeeded');
  assert.equal(late.job.acceptedAttemptId, leased.attemptId);
});
