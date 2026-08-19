import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  parseTaskDiffReviewExternalClosureRequestInput,
  parseTaskDiffReviewExternalClosureInput,
  parseTaskDiffReviewExternalSubmissionInput,
} from '../src/modules/assurance/task-diff-review-input.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';

const SUBJECT = 'a'.repeat(64);
const REVIEW = 'b'.repeat(64);
const RESPONSE = 'c'.repeat(64);
const CHALLENGE = 'd'.repeat(64);

test('external TaskDiff submission input binds semantic bytes without authority fields', () => {
  const input = {
    schemaVersion: 1,
    kind: 'task-diff-review-submission-input.v1',
    subjectDigest: SUBJECT,
    submission: validSubmission(),
  };
  assert.deepEqual(parseTaskDiffReviewExternalSubmissionInput(input), input);
  assert.throws(
    () =>
      parseTaskDiffReviewExternalSubmissionInput({
        ...input,
        reviewerAuthority: { principalId: 'independent-reviewer' },
      }),
    hasCode('TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskDiffReviewExternalSubmissionInput({
        ...input,
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    hasCode('TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID'),
  );
});

test('external TaskDiff closure input is advisory and cannot name its closer or Final Assurance', () => {
  const input = {
    schemaVersion: 1,
    kind: 'task-diff-review-closure-input.v1',
    subjectDigest: SUBJECT,
    reviewRecordDigest: REVIEW,
    responseDigest: RESPONSE,
    proposedDispositions: [
      {
        challengeId: CHALLENGE,
        decision: 'rebutted',
        rationale: 'Exact subject-bound evidence rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  assert.deepEqual(parseTaskDiffReviewExternalClosureInput(input), input);
  assert.throws(
    () =>
      parseTaskDiffReviewExternalClosureInput({
        ...input,
        finalAssurance: { verdict: 'satisfied' },
      }),
    hasCode('TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskDiffReviewExternalClosureInput({
        ...input,
        proposedDispositions: [
          {
            ...input.proposedDispositions[0],
            closedBy: 'independent-reviewer',
          },
        ],
      }),
    hasCode('TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID'),
  );
});

test('public external closure request carries response evidence but no caller-authored response digest or authority', () => {
  const input = {
    schemaVersion: 1,
    kind: 'task-diff-review-external-closure-request.v1',
    subjectDigest: SUBJECT,
    reviewRecordDigest: REVIEW,
    responses: [
      {
        challengeId: CHALLENGE,
        rationale: 'The exact candidate evidence answers the challenge.',
        evidence: [
          {
            kind: 'repository-location',
            path: 'src/feature.ts',
            line: 1,
            blobObjectId: 'f'.repeat(40),
            observation: 'The challenged invariant remains present.',
          },
        ],
      },
    ],
    proposedDispositions: [
      {
        challengeId: CHALLENGE,
        decision: 'rebutted',
        rationale: 'Exact subject-bound evidence rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  assert.deepEqual(
    parseTaskDiffReviewExternalClosureRequestInput(input),
    input,
  );
  for (const forbidden of [
    { responseDigest: RESPONSE },
    { grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    { attestation: { payload: {}, signature: 'claimed' } },
    { closer: 'caller-selected-reviewer' },
    { finalAssurance: { verdict: 'satisfied' } },
  ]) {
    assert.throws(
      () =>
        parseTaskDiffReviewExternalClosureRequestInput({
          ...input,
          ...forbidden,
        }),
      hasCode('TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID'),
    );
  }
});

test('external TaskDiff semantic inputs reject grant, participant, attestation, and authority fields', () => {
  const base = {
    schemaVersion: 1,
    kind: 'task-diff-review-submission-input.v1',
    subjectDigest: SUBJECT,
    submission: validSubmission(),
  };
  for (const authority of [
    { grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    { participant: { kind: 'caller-supplied', principalId: 'reviewer' } },
    { attestation: { payload: {}, signature: 'claimed' } },
    { reviewerAuthority: { principalId: 'reviewer' } },
  ]) {
    assert.throws(
      () =>
        parseTaskDiffReviewExternalSubmissionInput({ ...base, ...authority }),
      hasCode('TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID'),
    );
  }
});

function validSubmission() {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/feature.ts',
          line: 1,
          blobObjectId: 'f'.repeat(40),
          observation: 'The exact candidate preserves the reviewed invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact candidate.',
  };
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}
