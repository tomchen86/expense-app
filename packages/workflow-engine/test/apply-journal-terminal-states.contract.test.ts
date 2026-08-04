import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceApplyJournal,
  createApplyJournal,
  recoverApplyJournal,
} from '../src/maintainer-candidate.ts';
import { isWorkflowError } from './fixture.ts';

const OLD_COMMIT = 'a'.repeat(40);
const CANDIDATE_COMMIT = 'b'.repeat(40);
const CREATED_AT = '2026-08-04T00:00:00.000Z';
const EXPIRES_AT = '2026-08-11T00:00:00.000Z';

function journal() {
  return createApplyJournal({
    txId: 'tx-12345678',
    grantId: '22222222-2222-4222-8222-222222222222',
    targetRef: 'refs/heads/work/demo-change',
    expectedOldCommit: OLD_COMMIT,
    expectedRefGeneration: 7,
    candidateCommit: CANDIDATE_COMMIT,
    candidateBundleDigest: 'c'.repeat(64),
    createdAt: CREATED_AT,
  });
}

function recover(state: ReturnType<typeof journal>, observedRef: string) {
  return recoverApplyJournal(state, {
    observedRef,
    now: new Date('2026-08-04T00:05:00.000Z'),
    grantExpiresAt: EXPIRES_AT,
  });
}

test('a rolled-back transaction is never completed by observing its candidate', () => {
  const rolledBack = advanceApplyJournal(
    advanceApplyJournal(journal(), 'REF_UPDATED', {
      at: '2026-08-04T00:01:00.000Z',
      observedRef: CANDIDATE_COMMIT,
    }),
    'ROLLED_BACK',
    { at: '2026-08-04T00:02:00.000Z', observedRef: OLD_COMMIT },
  );

  // The ref sitting at the candidate after a rollback means something moved it
  // back; finishing the transaction here would replay a change the maintainer
  // watched being undone.
  assert.equal(
    recover(rolledBack, CANDIDATE_COMMIT).action,
    'manual-reconciliation',
  );
  assert.equal(recover(rolledBack, OLD_COMMIT).action, 'manual-reconciliation');
});

test('a failed transaction is never completed by observing its candidate', () => {
  const failed = advanceApplyJournal(journal(), 'FAILED', {
    at: '2026-08-04T00:01:00.000Z',
    failureCode: 'APPLY_PRESTATE_REJECTED',
  });
  assert.equal(
    recover(failed, CANDIDATE_COMMIT).action,
    'manual-reconciliation',
  );
});

test('a consumed grant cannot be rolled back', () => {
  const consumed = advanceApplyJournal(
    advanceApplyJournal(journal(), 'REF_UPDATED', {
      at: '2026-08-04T00:01:00.000Z',
      observedRef: CANDIDATE_COMMIT,
    }),
    'CONSUMED',
    { at: '2026-08-04T00:02:00.000Z' },
  );
  assert.throws(
    () =>
      advanceApplyJournal(consumed, 'ROLLED_BACK', {
        at: '2026-08-04T00:03:00.000Z',
        observedRef: OLD_COMMIT,
      }),
    (error) => isWorkflowError(error, 'APPLY_JOURNAL_TRANSITION_INVALID'),
  );
  assert.equal(
    advanceApplyJournal(consumed, 'COMPLETE', {
      at: '2026-08-04T00:03:00.000Z',
    }).state,
    'COMPLETE',
  );
});

test('completing after a crash still works while the transaction is live', () => {
  const refUpdated = advanceApplyJournal(journal(), 'REF_UPDATED', {
    at: '2026-08-04T00:01:00.000Z',
    observedRef: CANDIDATE_COMMIT,
  });
  assert.equal(
    recover(refUpdated, CANDIDATE_COMMIT).action,
    'complete-after-cas',
  );
  assert.equal(recover(journal(), OLD_COMMIT).action, 'resume-before-cas');
});
