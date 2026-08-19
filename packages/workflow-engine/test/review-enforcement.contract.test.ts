import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReviewSetHonoured,
  buildCoverageManifest,
  requiredReviewSet,
  type ReviewTarget,
} from '../src/modules/assurance/review-coverage.ts';
import {
  assertChallengesClosed,
  deltaReviewRequired,
  type Challenge,
} from '../src/modules/assurance/review-challenge.ts';
import { isWorkflowError } from './fixture.ts';

const SEED = 'a'.repeat(64);
const POLICY = 'b'.repeat(64);

function targets(): ReviewTarget[] {
  return [
    {
      targetId: 'mutation-1',
      stratum: 'planned-mutation',
      reusedFromLedger: false,
    },
    { targetId: 'risk-1', stratum: 'hard-risk', reusedFromLedger: false },
    {
      targetId: 'blast-1',
      stratum: 'largest-blast-radius',
      reusedFromLedger: false,
    },
    {
      targetId: 'degraded-1',
      stratum: 'degraded-extraction',
      reusedFromLedger: false,
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      targetId: `consumer-${index}`,
      stratum: 'production-consumer' as const,
      reusedFromLedger: true,
    })),
  ];
}

test('a reused subject still appears in what the reviewer is shown', () => {
  // Reuse says how much the author owed, never what a reviewer may look at.
  const manifest = buildCoverageManifest('standard', targets());
  assert.equal(manifest.targets.length, 14);
  assert.equal(
    manifest.targets.filter(({ reusedFromLedger }) => reusedFromLedger).length,
    10,
  );
});

test('critical reviews every target', () => {
  const manifest = buildCoverageManifest('critical', targets());
  assert.equal(requiredReviewSet(manifest, SEED, POLICY).length, 14);
});

test('lower tiers still review every mandatory stratum in full', () => {
  for (const tier of ['standard', 'elevated'] as const) {
    const required = requiredReviewSet(
      buildCoverageManifest(tier, targets()),
      SEED,
      POLICY,
    );
    for (const mandatory of ['mutation-1', 'risk-1', 'blast-1', 'degraded-1']) {
      assert.ok(required.includes(mandatory), `${tier} dropped ${mandatory}`);
    }
    assert.ok(required.length < 14, `${tier} sampled nothing`);
  }
});

test('elevated samples the remainder more heavily than standard', () => {
  const standard = requiredReviewSet(
    buildCoverageManifest('standard', targets()),
    SEED,
    POLICY,
  );
  const elevated = requiredReviewSet(
    buildCoverageManifest('elevated', targets()),
    SEED,
    POLICY,
  );
  assert.ok(elevated.length > standard.length);
});

test('the sample is reproducible and unaffected by target ordering', () => {
  const forward = requiredReviewSet(
    buildCoverageManifest('standard', targets()),
    SEED,
    POLICY,
  );
  const reversed = requiredReviewSet(
    buildCoverageManifest('standard', [...targets()].reverse()),
    SEED,
    POLICY,
  );
  assert.deepEqual(reversed, forward);
});

test('an unsealed seed is refused', () => {
  assert.throws(
    () =>
      requiredReviewSet(
        buildCoverageManifest('standard', targets()),
        'x',
        POLICY,
      ),
    (error) => isWorkflowError(error, 'REVIEW_COVERAGE_INVALID'),
  );
});

test('a required target with no disposition blocks the plan', () => {
  const manifest = buildCoverageManifest('standard', targets());
  const required = requiredReviewSet(manifest, SEED, POLICY);
  assert.throws(
    () => assertReviewSetHonoured(required, required.slice(1)),
    (error) => isWorkflowError(error, 'REVIEW_COVERAGE_INCOMPLETE'),
  );
  assertReviewSetHonoured(required, [...required, 'extra-target']);
});

const CONTEXT = {
  authorId: 'author',
  reviewerIds: ['reviewer', 'author'],
  domainOwnerIds: ['owner'],
};

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    challengeId: 'c1',
    raisedBy: 'reviewer',
    severity: 'ordinary',
    targetId: 'mutation-1',
    ...overrides,
  };
}

test('an open challenge blocks the plan at any tier', () => {
  assert.throws(
    () => assertChallengesClosed([challenge()], [], CONTEXT),
    (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_OPEN'),
  );
});

test('an author cannot close a challenge raised against their own plan', () => {
  assert.throws(
    () =>
      assertChallengesClosed(
        [challenge()],
        [{ challengeId: 'c1', disposition: 'rebutted', closedBy: 'author' }],
        CONTEXT,
      ),
    (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_INVALID'),
  );
  assertChallengesClosed(
    [challenge()],
    [{ challengeId: 'c1', disposition: 'rebutted', closedBy: 'reviewer' }],
    CONTEXT,
  );
});

test('only the author of a challenge may withdraw it', () => {
  assert.throws(
    () =>
      assertChallengesClosed(
        [challenge()],
        [{ challengeId: 'c1', disposition: 'withdrawn', closedBy: 'author' }],
        CONTEXT,
      ),
    (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_INVALID'),
  );
  assertChallengesClosed(
    [challenge()],
    [{ challengeId: 'c1', disposition: 'withdrawn', closedBy: 'reviewer' }],
    CONTEXT,
  );
});

test('a forbidden-floor challenge cannot be waived by anyone', () => {
  assert.throws(
    () =>
      assertChallengesClosed(
        [challenge({ severity: 'forbidden-floor' })],
        [{ challengeId: 'c1', disposition: 'waived', closedBy: 'owner' }],
        CONTEXT,
      ),
    (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_INVALID'),
  );
});

test('an ordinary challenge may be waived only by a named domain owner', () => {
  assert.throws(
    () =>
      assertChallengesClosed(
        [challenge()],
        [{ challengeId: 'c1', disposition: 'waived', closedBy: 'reviewer' }],
        CONTEXT,
      ),
    (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_INVALID'),
  );
  assertChallengesClosed(
    [challenge()],
    [{ challengeId: 'c1', disposition: 'waived', closedBy: 'owner' }],
    CONTEXT,
  );
});

test('supersession must name a real, different challenge', () => {
  for (const supersededBy of [undefined, 'c1', 'nonexistent']) {
    assert.throws(
      () =>
        assertChallengesClosed(
          [challenge(), challenge({ challengeId: 'c2' })],
          [
            {
              challengeId: 'c1',
              disposition: 'superseded',
              closedBy: 'reviewer',
              ...(supersededBy === undefined ? {} : { supersededBy }),
            },
            {
              challengeId: 'c2',
              disposition: 'rebutted',
              closedBy: 'reviewer',
            },
          ],
          CONTEXT,
        ),
      (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_INVALID'),
      String(supersededBy),
    );
  }
});

test('a resolution that moves a reviewed target owes a delta review', () => {
  assert.deepEqual(
    deltaReviewRequired({ a: 'd1', b: 'd2' }, { a: 'd1', b: 'CHANGED' }),
    ['b'],
  );
  assert.deepEqual(deltaReviewRequired({ a: 'd1' }, { a: 'd1' }), []);
  // A target that appeared after the review was sealed was never reviewed.
  assert.deepEqual(deltaReviewRequired({}, { fresh: 'd9' }), ['fresh']);
});
