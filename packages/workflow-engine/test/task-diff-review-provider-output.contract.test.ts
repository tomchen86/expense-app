import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  parseTaskDiffReviewContinuationSubmission,
  parseTaskDiffReviewSubmission,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
  type TaskDiffReviewSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';

test('TaskDiffReview provider output schema and validator bind the complete semantic grammar', () => {
  const submission = validSubmission();
  const reversed = {
    ...submission,
    coverage: [...submission.coverage].reverse(),
  };

  assert.equal(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(submission), true);
  assert.deepEqual(
    parseTaskDiffReviewSubmission(reversed),
    parseTaskDiffReviewSubmission(submission),
  );
  assert.deepEqual(TASK_DIFF_REVIEW_OUTPUT_SCHEMA, {
    id: 'expense-app.workflow.task-diff-review-output',
    version: 1,
    digest: crypto
      .createHash('sha256')
      .update(canonicalJson(TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA))
      .digest('hex'),
  });
  assert.deepEqual(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR, {
    ...TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    validate: TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate,
  });
});

test('TaskDiffReview provider output rejects incomplete, duplicate, and evidence-free conclusions', () => {
  const submission = validSubmission();
  const invalid: unknown[] = [
    (({ riskPathDispositions: _riskPathDispositions, ...rest }) => rest)(
      submission,
    ),
    { ...submission, coverage: submission.coverage.slice(1) },
    {
      ...submission,
      coverage: [...submission.coverage.slice(0, -1), submission.coverage[0]],
    },
    {
      ...submission,
      scopeAssessment: { kind: 'no-challenge', evidence: [] },
    },
    {
      ...submission,
      unexpectedSemanticAction: 'approve-and-commit',
    },
    {
      ...submission,
      suggestions: [submission.suggestions[0], submission.suggestions[0]],
    },
    {
      ...submission,
      riskPathDispositions: [
        { path: 'src/a.ts', role: 'ordinary', outcome: 'no-challenge' },
      ],
    },
    {
      ...submission,
      riskPathDispositions: [
        { path: 'src/a.ts', role: 'lifecycle', outcome: 'no-challenge' },
        { path: 'src/a.ts', role: 'lifecycle', outcome: 'challenge-raised' },
      ],
    },
    {
      ...submission,
      riskPathDispositions: [
        {
          path: 'src/a.ts',
          role: 'lifecycle',
          outcome: 'accepted',
        },
      ],
    },
    {
      ...submission,
      riskPathDispositions: [
        {
          path: 'src/a.ts',
          role: 'lifecycle',
          outcome: 'no-challenge',
          closedBy: 'provider-a:reviewer',
        },
      ],
    },
  ];

  for (const candidate of invalid) {
    assert.equal(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(candidate), false);
    assert.throws(() => parseTaskDiffReviewSubmission(candidate));
  }
});

test('TaskDiffReview provider output requires challenges and scope assessment to agree', () => {
  const submission = validSubmission();
  const challenge = {
    kind: 'challenge' as const,
    severity: 'high' as const,
    category: 'correctness-and-invariants' as const,
    currentChangeImpact: 'required' as const,
    summary: 'The changed branch may violate the task invariant.',
    evidence:
      submission.scopeAssessment.kind === 'no-challenge'
        ? submission.scopeAssessment.evidence
        : [],
  };

  assert.equal(
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate({
      ...submission,
      verdict: 'advisory-reject',
      scopeAssessment: { kind: 'challenges' },
      findings: [challenge],
    }),
    true,
  );
  assert.equal(
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate({
      ...submission,
      scopeAssessment: { kind: 'challenges' },
    }),
    false,
  );
  assert.equal(
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate({
      ...submission,
      findings: [challenge],
    }),
    false,
  );
});

test('TaskDiffReview continuation output is advisory structured evidence, not a closure credential', () => {
  const submission = {
    schemaVersion: 1 as const,
    reviewRecordDigest: 'a'.repeat(64),
    responseDigest: 'b'.repeat(64),
    proposedDispositions: [
      {
        challengeId: 'c'.repeat(64),
        decision: 'rebutted' as const,
        rationale: 'The exact response rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  assert.equal(
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR.validate(submission),
    true,
  );
  assert.deepEqual(
    parseTaskDiffReviewContinuationSubmission(submission),
    submission,
  );
  assert.deepEqual(TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA, {
    id: 'expense-app.workflow.task-diff-review-continuation-output',
    version: 1,
    digest: crypto
      .createHash('sha256')
      .update(
        canonicalJson(TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA),
      )
      .digest('hex'),
  });
  for (const invalid of [
    { ...submission, reviewRecordDigest: 'not-a-digest' },
    { ...submission, proposedDispositions: [] },
    {
      ...submission,
      proposedDispositions: [
        submission.proposedDispositions[0],
        submission.proposedDispositions[0],
      ],
    },
    {
      ...submission,
      proposedDispositions: [
        {
          ...submission.proposedDispositions[0],
          decision: 'closed',
        },
      ],
    },
  ]) {
    assert.equal(
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR.validate(invalid),
      false,
    );
    assert.throws(() => parseTaskDiffReviewContinuationSubmission(invalid));
  }
});

function validSubmission(): TaskDiffReviewSubmission {
  const repositoryEvidence = {
    kind: 'repository-location' as const,
    path: 'src/a.ts',
    line: 1,
    blobObjectId: 'a'.repeat(40),
    observation: 'The exact candidate branch preserves the task invariant.',
  };
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [repositoryEvidence],
    },
    findings: [],
    suggestions: [
      {
        kind: 'suggestion',
        severity: 'informational',
        category: 'test-adequacy',
        currentChangeImpact: 'independent-follow-up',
        summary: 'A follow-up property test could improve diagnostics.',
        evidence: [repositoryEvidence],
      },
    ],
    riskPathDispositions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}
