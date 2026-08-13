import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveTaskDiffReviewLineage,
  type TaskDiffReviewLineageEntry,
} from '../src/task-diff-review-lineage.ts';
import {
  createTaskDiffReviewSubject,
  deriveTaskDiffReviewCandidatePlan,
  type TaskDiffReviewScope,
  type TaskDiffReviewSubject,
} from '../src/task-diff-review.ts';

const DIGEST = {
  baseCommit: 'a'.repeat(40),
  baseTree: 'b'.repeat(40),
  taskContract: 'c'.repeat(64),
  checkPolicy: 'd'.repeat(64),
  planningGeneration: 'e'.repeat(64),
  planTarget: 'f'.repeat(64),
  planReview: '1'.repeat(64),
  planningAssurance: '2'.repeat(64),
};

test('common TaskDiffReview lineage selects the fully reviewed leaf for delta and exact-candidate reuse', () => {
  const first = subject('3', '4');
  const firstEntry = entry('provider', first, '5', fullScope(first));
  const second = subject('6', '7');
  const secondScope = successorScope(second, firstEntry);
  const secondEntry = entry('external', second, '8', secondScope);
  const third = subject('9', '0');

  const changed = resolveTaskDiffReviewLineage({
    current: third,
    entries: [secondEntry, firstEntry],
  });
  assert.equal(changed.predecessor?.source, 'external');
  assert.equal(changed.predecessor?.reviewRecordDigest, '8'.repeat(64));
  assert.equal(changed.candidatePlan.action, 'review');
  if (changed.candidatePlan.action !== 'review') {
    assert.fail('expected a delta review');
  }
  assert.equal(changed.candidatePlan.scope.mode, 'delta');
  assert.equal(
    changed.candidatePlan.scope.predecessor?.reviewRecordDigest,
    secondEntry.reviewRecordDigest,
  );

  const refreshed = subject('6', '7', 'a');
  const reused = resolveTaskDiffReviewLineage({
    current: refreshed,
    entries: [firstEntry, secondEntry],
  });
  assert.equal(reused.candidatePlan.action, 'reuse');
  assert.equal(reused.predecessor?.source, 'external');
});

test('common TaskDiffReview lineage fails closed on a provider/external duplicate subject', () => {
  const current = subject('3', '4');
  const scope = fullScope(current);
  assert.throws(
    () =>
      resolveTaskDiffReviewLineage({
        current,
        entries: [
          entry('provider', current, '5', scope),
          entry('external', current, '6', scope),
        ],
      }),
    hasLineageConflict,
  );
});

test('common TaskDiffReview lineage fails closed on a missing predecessor', () => {
  const first = subject('3', '4');
  const second = subject('6', '7');
  const missing = entry('provider', first, '5', fullScope(first));
  const successor = entry(
    'external',
    second,
    '8',
    successorScope(second, missing),
  );
  assert.throws(
    () =>
      resolveTaskDiffReviewLineage({ current: second, entries: [successor] }),
    hasLineageConflict,
  );
});

test('common TaskDiffReview lineage fails closed on a fork', () => {
  const rootSubject = subject('3', '4');
  const root = entry('provider', rootSubject, '5', fullScope(rootSubject));
  const leftSubject = subject('6', '7');
  const rightSubject = subject('8', '9');
  assert.throws(
    () =>
      resolveTaskDiffReviewLineage({
        current: rightSubject,
        entries: [
          root,
          entry(
            'provider',
            leftSubject,
            'a',
            successorScope(leftSubject, root),
          ),
          entry(
            'external',
            rightSubject,
            'b',
            successorScope(rightSubject, root),
          ),
        ],
      }),
    hasLineageConflict,
  );
});

test('common TaskDiffReview lineage fails closed on a cycle', () => {
  const leftSubject = subject('3', '4');
  const rightSubject = subject('6', '7');
  const leftRecordDigest = '5'.repeat(64);
  const rightRecordDigest = '8'.repeat(64);
  const left = entry(
    'provider',
    leftSubject,
    '5',
    scopeWithPredecessor(leftSubject, rightSubject, rightRecordDigest),
  );
  const right = entry(
    'external',
    rightSubject,
    '8',
    scopeWithPredecessor(rightSubject, leftSubject, leftRecordDigest),
  );
  assert.throws(
    () =>
      resolveTaskDiffReviewLineage({
        current: rightSubject,
        entries: [left, right],
      }),
    hasLineageConflict,
  );
});

test('common TaskDiffReview lineage fails closed on multiple roots and leaves', () => {
  const leftSubject = subject('3', '4');
  const rightSubject = subject('6', '7');
  assert.throws(
    () =>
      resolveTaskDiffReviewLineage({
        current: rightSubject,
        entries: [
          entry('provider', leftSubject, '5', fullScope(leftSubject)),
          entry('external', rightSubject, '8', fullScope(rightSubject)),
        ],
      }),
    hasLineageConflict,
  );
});

function entry(
  source: TaskDiffReviewLineageEntry['source'],
  reviewedSubject: TaskDiffReviewSubject,
  reviewDigit: string,
  reviewScope: TaskDiffReviewScope,
): TaskDiffReviewLineageEntry {
  return Object.freeze({
    source,
    subject: reviewedSubject,
    reviewRecordDigest: reviewDigit.repeat(64),
    reviewScope,
    finalAssuranceCommitmentDigest: null,
  });
}

function fullScope(
  reviewedSubject: TaskDiffReviewSubject,
): TaskDiffReviewScope {
  const plan = deriveTaskDiffReviewCandidatePlan({ current: reviewedSubject });
  if (plan.action !== 'review') throw new Error('review expected');
  return plan.scope;
}

function successorScope(
  current: TaskDiffReviewSubject,
  predecessor: TaskDiffReviewLineageEntry,
): TaskDiffReviewScope {
  const plan = deriveTaskDiffReviewCandidatePlan({
    current,
    predecessor: {
      subject: predecessor.subject,
      reviewRecordDigest: predecessor.reviewRecordDigest,
      finalAssuranceCommitmentDigest:
        predecessor.finalAssuranceCommitmentDigest,
    },
  });
  if (plan.action !== 'review') throw new Error('review expected');
  return plan.scope;
}

function scopeWithPredecessor(
  current: TaskDiffReviewSubject,
  predecessorSubject: TaskDiffReviewSubject,
  predecessorReviewRecordDigest: string,
): TaskDiffReviewScope {
  const plan = deriveTaskDiffReviewCandidatePlan({
    current,
    predecessor: {
      subject: predecessorSubject,
      reviewRecordDigest: predecessorReviewRecordDigest,
      finalAssuranceCommitmentDigest: null,
    },
  });
  if (plan.action !== 'review') throw new Error('review expected');
  return plan.scope;
}

function subject(
  candidateDigit: string,
  afterDigit: string,
  checkDigit = 'b',
): TaskDiffReviewSubject {
  return createTaskDiffReviewSubject({
    repositoryId: 'github:example/repository',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit: DIGEST.baseCommit,
    baseTree: DIGEST.baseTree,
    candidateTree: candidateDigit.repeat(40),
    transitions: [
      {
        path: 'src/feature.ts',
        before: null,
        after: { mode: '100644', objectId: afterDigit.repeat(40) },
      },
    ],
    taskContractDigest: DIGEST.taskContract,
    requiredCheckPolicyDigest: DIGEST.checkPolicy,
    checkEvidenceDigest: checkDigit.repeat(64),
    planningGenerationId: DIGEST.planningGeneration,
    planTargetDigest: DIGEST.planTarget,
    planReviewNodeId: DIGEST.planReview,
    planningAssuranceDigest: DIGEST.planningAssurance,
    reviewRequirement: {
      required: true,
      basis: 'explicit',
      riskPaths: [],
    },
  });
}

function hasLineageConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'TASK_DIFF_REVIEW_LINEAGE_CONFLICT'
  );
}
