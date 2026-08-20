import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ATTEMPT_STATUSES_V2,
  JOB_ATTEMPT_RUNTIME_CONTRACT_VERSION,
  JOB_STATUSES_V2,
  AttemptResultCodecError,
  assertAttemptAcceptanceBindingV1,
  attemptResultDigestV1,
  createAttemptAcceptanceBindingV1,
  type AttemptResultIdentityV1,
} from '../src/job-attempt-runtime.ts';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const RESULT_IDENTITY: AttemptResultIdentityV1 = {
  workflowId: 'workflow-a',
  epoch: 4,
  contextDigest: digest('a'),
  jobId: 'job-a',
  attemptId: 'attempt-a',
  outputDigest: digest('b'),
  acceptance: 'accepted',
  completedAt: '2026-08-20T02:00:00.000Z',
};

test('core publishes only the exact landed Job and Attempt vocabularies', () => {
  assert.equal(
    JOB_ATTEMPT_RUNTIME_CONTRACT_VERSION,
    'jigwright.job-attempt-runtime.v1',
  );
  assert.deepEqual(JOB_STATUSES_V2, [
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
  assert.deepEqual(ATTEMPT_STATUSES_V2, [
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
});

test('AttemptResult factory and parser preserve the landed identity digest exactly', () => {
  const result = createAttemptAcceptanceBindingV1(RESULT_IDENTITY);
  assert.equal(
    result.resultId,
    'sha256:4d67878084f62d4fc8d184439808d5cc44c0afe9e3c4286d1dbfea951fd31dd2',
  );
  assert.equal(result.resultId, attemptResultDigestV1(RESULT_IDENTITY));
  assert.deepEqual(assertAttemptAcceptanceBindingV1(result), result);
  assert.ok(Object.isFrozen(result));
});

test('AttemptResult codec fails closed on unknown fields, identity drift, and noncanonical timestamps', () => {
  const valid = createAttemptAcceptanceBindingV1(RESULT_IDENTITY);
  for (const candidate of [
    { ...valid, unknown: true },
    { ...valid, resultId: digest('f') },
    { ...valid, attemptId: 'Attempt-A' },
    { ...valid, completedAt: '2026-08-20 02:00:00Z' },
  ]) {
    assert.throws(
      () => assertAttemptAcceptanceBindingV1(candidate),
      (error) =>
        error instanceof AttemptResultCodecError &&
        error.code === 'ATTEMPT_RESULT_INVALID',
    );
  }
});

test('partial extraction declares execution-store as sole aggregate authority and contains no reducer', () => {
  const source = fs.readFileSync(
    new URL('../src/job-attempt-runtime.ts', import.meta.url),
    'utf8',
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./job-attempt-runtime'],
    './src/job-attempt-runtime.ts',
  );
  assert.match(source, /execution-store remains the unique/);
  assert.match(source, /Aggregate transition adoption[\s*]+is NOT implemented/);
  assert.doesNotMatch(
    source,
    /JOB_TRANSITIONS|ATTEMPT_TRANSITIONS|JobAttemptAggregate|assertJobAttemptMutation|sourceProjection/,
  );
  assert.doesNotMatch(
    source,
    /expense-app|openspec|provider|mandate|workflowError/i,
  );
});
