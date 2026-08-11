import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTaskDiffReviewSubject,
  parseTaskDiffReviewSubject,
  taskDiffReviewRequirement,
  TASK_DIFF_REVIEW_POLICY_DIGEST,
  type CreateTaskDiffReviewSubjectInput,
} from '../src/task-diff-review.ts';

const OID = {
  baseCommit: 'a'.repeat(40),
  baseTree: 'b'.repeat(40),
  candidateTree: 'c'.repeat(40),
  beforeA: 'd'.repeat(40),
  afterA: 'e'.repeat(40),
  afterB: 'f'.repeat(40),
};

test('TaskDiffReview subject canonicalizes exact blob and mode transitions without runtime metadata', () => {
  const input = subjectInput();
  const subject = createTaskDiffReviewSubject(input);
  const reordered = createTaskDiffReviewSubject({
    ...input,
    transitions: [...input.transitions].reverse(),
  });

  assert.deepEqual(subject, reordered);
  assert.deepEqual(subject.changedPaths, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(
    subject.transitions.map(({ path }) => path),
    subject.changedPaths,
  );
  assert.equal(subject.reviewPolicyDigest, TASK_DIFF_REVIEW_POLICY_DIGEST);
  assert.match(subject.patchDigest, /^[0-9a-f]{64}$/);
  assert.match(subject.subjectDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(subject, 'createdAt'), false);
  assert.equal(Object.hasOwn(subject, 'sessionId'), false);
  assert.deepEqual(
    parseTaskDiffReviewSubject(structuredClone(subject)),
    subject,
  );
});

test('every assurance-relevant TaskDiffReview subject input invalidates reuse', () => {
  const initial = subjectInput();
  const baseline = createTaskDiffReviewSubject(initial).subjectDigest;
  const variants: CreateTaskDiffReviewSubjectInput[] = [
    { ...initial, repositoryId: 'github:tomchen86/other' },
    { ...initial, baseCommit: '0'.repeat(40) },
    { ...initial, baseTree: '1'.repeat(40) },
    { ...initial, candidateTree: '2'.repeat(40) },
    { ...initial, taskContractDigest: '8'.repeat(64) },
    { ...initial, requiredCheckPolicyDigest: '9'.repeat(64) },
    { ...initial, checkEvidenceDigest: 'a'.repeat(64) },
    { ...initial, planningGenerationId: 'b'.repeat(64) },
    { ...initial, planTargetDigest: 'c'.repeat(64) },
    { ...initial, planReviewNodeId: 'd'.repeat(64) },
    { ...initial, planningAssuranceDigest: 'e'.repeat(64) },
    {
      ...initial,
      transitions: initial.transitions.map((transition) =>
        transition.path === 'src/a.ts'
          ? {
              ...transition,
              after: { ...transition.after!, objectId: '0'.repeat(40) },
            }
          : transition,
      ),
    },
    {
      ...initial,
      transitions: initial.transitions.map((transition) =>
        transition.path === 'src/a.ts'
          ? { ...transition, after: { ...transition.after!, mode: '100755' } }
          : transition,
      ),
    },
    {
      ...initial,
      reviewRequirement: {
        required: true,
        basis: 'risk-role',
        riskPaths: [{ path: 'src/a.ts', role: 'lifecycle' }],
      },
    },
  ];

  for (const variant of variants) {
    assert.notEqual(
      createTaskDiffReviewSubject(variant).subjectDigest,
      baseline,
    );
  }
});

test('TaskDiffReview subject rejects duplicate, unchanged, and empty transitions', () => {
  const input = subjectInput();
  assert.throws(
    () =>
      createTaskDiffReviewSubject({
        ...input,
        transitions: [input.transitions[0]!, input.transitions[0]!],
      }),
    hasCode('TASK_DIFF_REVIEW_SUBJECT_INVALID'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewSubject({
        ...input,
        transitions: [
          {
            path: 'src/a.ts',
            before: { mode: '100644', objectId: OID.beforeA },
            after: { mode: '100644', objectId: OID.beforeA },
          },
        ],
      }),
    hasCode('TASK_DIFF_REVIEW_SUBJECT_INVALID'),
  );
  assert.throws(
    () => createTaskDiffReviewSubject({ ...input, transitions: [] }),
    hasCode('TASK_DIFF_REVIEW_SUBJECT_INVALID'),
  );

  const valid = createTaskDiffReviewSubject(input);
  assert.throws(
    () =>
      parseTaskDiffReviewSubject({
        ...valid,
        changedPaths: [...valid.changedPaths].reverse(),
      }),
    hasCode('TASK_DIFF_REVIEW_SUBJECT_INVALID'),
  );
});

test('TaskDiffReview policy requires explicit, behavioral, risky, and unregistered diffs without over-reviewing ordinary transforms', () => {
  assert.deepEqual(
    taskDiffReviewRequirement({
      diffReview: 'required',
      strategy: 'direct-reviewed',
      paths: [{ path: 'docs/guide.md', role: 'ordinary' }],
    }),
    { required: true, basis: 'explicit', riskPaths: [] },
  );
  assert.deepEqual(
    taskDiffReviewRequirement({
      diffReview: 'policy-required',
      strategy: 'cross-agent-tdd',
      paths: [{ path: 'apps/api/src/feature.ts', role: 'ordinary' }],
    }),
    { required: true, basis: 'behavioral-strategy', riskPaths: [] },
  );
  assert.deepEqual(
    taskDiffReviewRequirement({
      diffReview: 'policy-required',
      strategy: 'mechanical-transform',
      paths: [{ path: 'apps/api/src/feature.ts', role: 'ordinary' }],
    }),
    { required: false, basis: 'mechanical-evidence', riskPaths: [] },
  );
  assert.deepEqual(
    taskDiffReviewRequirement({
      diffReview: 'policy-required',
      strategy: 'mechanical-transform',
      paths: [
        {
          path: 'packages/workflow-engine/src/lifecycle.ts',
          role: 'lifecycle',
        },
      ],
    }),
    {
      required: true,
      basis: 'risk-role',
      riskPaths: [
        {
          path: 'packages/workflow-engine/src/lifecycle.ts',
          role: 'lifecycle',
        },
      ],
    },
  );
  assert.deepEqual(
    taskDiffReviewRequirement({
      diffReview: 'policy-required',
      strategy: 'direct-reviewed',
      paths: [{ path: 'unknown/new-surface.ts', role: 'unregistered' }],
    }),
    {
      required: true,
      basis: 'risk-role',
      riskPaths: [{ path: 'unknown/new-surface.ts', role: 'unregistered' }],
    },
  );
});

function subjectInput(): CreateTaskDiffReviewSubjectInput {
  return {
    repositoryId: 'github:tomchen86/expense-app',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit: OID.baseCommit,
    baseTree: OID.baseTree,
    candidateTree: OID.candidateTree,
    transitions: [
      {
        path: 'src/b.ts',
        before: null,
        after: { mode: '100644', objectId: OID.afterB },
      },
      {
        path: 'src/a.ts',
        before: { mode: '100644', objectId: OID.beforeA },
        after: { mode: '100644', objectId: OID.afterA },
      },
    ],
    taskContractDigest: '1'.repeat(64),
    requiredCheckPolicyDigest: '2'.repeat(64),
    checkEvidenceDigest: '3'.repeat(64),
    planningGenerationId: '4'.repeat(64),
    planTargetDigest: '5'.repeat(64),
    planReviewNodeId: '6'.repeat(64),
    planningAssuranceDigest: '7'.repeat(64),
    reviewRequirement: {
      required: true,
      basis: 'behavioral-strategy',
      riskPaths: [],
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
