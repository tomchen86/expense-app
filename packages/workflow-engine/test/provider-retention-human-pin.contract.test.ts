import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProviderRetentionEligibility,
  providerRuntimeEvidenceId,
} from '../src/runtime/provider-execution/provider-retention.ts';

// An old-epoch accepted Attempt whose TTL has expired: the ordinary schedule
// would delete its private runtime.
const EXPIRED = {
  invocationState: 'succeeded' as const,
  historyComplete: true,
  attemptEpoch: 1,
  currentEpoch: 2,
  retention: 'active' as const,
  acceptedAttempt: true,
  latestUnacceptedAttempt: false,
  terminalAt: '2026-07-01T00:00:00.000Z',
  cutoffAt: '2026-08-01T00:00:00.000Z',
};

test('a human pin recorded in the catalog withholds expired provider runtime', () => {
  assert.equal(classifyProviderRetentionEligibility(EXPIRED), null);
  assert.equal(
    classifyProviderRetentionEligibility({ ...EXPIRED, humanPinned: true }),
    'pinned',
  );
});

test('a pin outranks every other reason to delete', () => {
  // Whatever else is true of the Attempt, an explicit human decision is the
  // one thing the schedule may not override.
  assert.equal(
    classifyProviderRetentionEligibility({
      ...EXPIRED,
      retention: 'debug',
      acceptedAttempt: false,
      humanPinned: true,
    }),
    'pinned',
  );
});

test('an absent pin leaves the ordinary schedule in charge', () => {
  assert.equal(
    classifyProviderRetentionEligibility({ ...EXPIRED, humanPinned: false }),
    null,
  );
});

test('runtime evidence identity is stable and attempt-specific', () => {
  const first = providerRuntimeEvidenceId('attempt-001');
  assert.equal(first, providerRuntimeEvidenceId('attempt-001'));
  assert.notEqual(first, providerRuntimeEvidenceId('attempt-002'));
  assert.match(first, /^provider-runtime-[0-9a-f]{32}$/);
});
