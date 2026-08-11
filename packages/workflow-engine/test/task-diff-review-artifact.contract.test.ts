import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTaskDiffReviewChallengeResponseCurrent,
  assertTaskDiffReviewContentSatisfied,
  assertTaskDiffFinalAssuranceCurrent,
  createTaskDiffFinalAssuranceRecord,
  createTaskDiffReviewChallengeResponse,
  createTaskDiffReviewDispositionRecord,
  createTaskDiffReviewRecord,
  parseTaskDiffReviewChallengeResponseRecord,
  parseTaskDiffReviewDispositionRecord,
  parseTaskDiffFinalAssuranceRecord,
  parseTaskDiffReviewRecord,
  type CreateTaskDiffReviewRecordInput,
} from '../src/task-diff-review-artifact.ts';
import {
  createTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/task-diff-review.ts';

test('TaskDiffReview record canonically binds a fresh provider-independent assignment and complete coverage', () => {
  const input = reviewInput();
  const record = createTaskDiffReviewRecord(input);
  const reordered = createTaskDiffReviewRecord({
    ...input,
    submission: {
      ...input.submission,
      coverage: [...input.submission.coverage].reverse(),
      scopeAssessment: {
        kind: 'no-challenge',
        evidence: [
          ...(input.submission.scopeAssessment.kind === 'no-challenge'
            ? input.submission.scopeAssessment.evidence
            : []),
        ].reverse(),
      },
    },
  });

  assert.deepEqual(record, reordered);
  assert.deepEqual(record.coverage, TASK_DIFF_REVIEW_COVERAGE);
  assert.equal(record.assignment.achievedIndependence, 'provider-independent');
  assert.match(record.recordDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(parseTaskDiffReviewRecord(structuredClone(record)), record);
  assert.deepEqual(
    assertTaskDiffReviewContentSatisfied(input.subject, record, null),
    record,
  );
});

test('TaskDiffReview record rejects same-provider, reused-session, and incomplete review claims', () => {
  const input = reviewInput();
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        assignment: {
          ...input.assignment,
          reviewerProviderId: input.assignment.implementerProviderId,
        },
      }),
    hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        assignment: {
          ...input.assignment,
          reviewerSessionId: input.assignment.implementationSessionId,
        },
      }),
    hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        submission: {
          ...input.submission,
          coverage: input.submission.coverage.slice(1),
        },
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        submission: {
          ...input.submission,
          scopeAssessment: { kind: 'no-challenge', evidence: [] },
        },
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );
  const challenged = reviewInput({ challenge: true });
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...challenged,
        submission: {
          ...challenged.submission,
          findings: challenged.submission.findings.map((finding) => ({
            ...finding,
            evidence: [],
          })),
        },
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );
});

test('advisory dispositions cannot close challenges; Final Assurance uses the shared author-cannot-close verifier', () => {
  const input = reviewInput({ challenge: true });
  const record = createTaskDiffReviewRecord(input);
  const challenge = record.challenges[0]!;

  assert.equal(record.suggestions.length, 1);
  assert.throws(
    () => assertTaskDiffReviewContentSatisfied(input.subject, record, null),
    hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewDispositionRecord({
        review: record,
        entries: [
          {
            challengeId: challenge.challengeId,
            disposition: 'rebutted',
            rationale: 'The exact candidate blob preserves the invariant.',
            closedBy: input.assignment.implementerPrincipalId,
          },
        ],
      }),
    hasCode('TASK_DIFF_REVIEW_DISPOSITION_INVALID'),
  );

  const disposition = createTaskDiffReviewDispositionRecord({
    review: record,
    entries: [
      {
        challengeId: challenge.challengeId,
        disposition: 'rebutted',
        rationale: 'The exact candidate blob preserves the invariant.',
        closedBy: input.assignment.reviewerPrincipalId,
      },
    ],
  });
  assert.deepEqual(
    parseTaskDiffReviewDispositionRecord(structuredClone(disposition)),
    disposition,
  );
  assert.throws(
    () =>
      assertTaskDiffReviewContentSatisfied(input.subject, record, disposition),
    hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
  );

  const response = createTaskDiffReviewChallengeResponse({
    review: record,
    responses: [
      {
        challengeId: challenge.challengeId,
        rationale: 'The exact candidate evidence answers the challenge.',
        evidence: [challenge.evidence[0]!],
      },
    ],
  });
  const submission = {
    schemaVersion: 1 as const,
    reviewRecordDigest: record.recordDigest,
    responseDigest: response.responseDigest,
    proposedDispositions: [
      {
        challengeId: challenge.challengeId,
        decision: 'rebutted' as const,
        rationale: 'The exact candidate evidence rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  assert.throws(
    () =>
      createTaskDiffFinalAssuranceRecord({
        subject: input.subject,
        review: record,
        response,
        submission,
        reviewerAuthority: {
          kind: 'engine-attributed-provider-reviewer',
          principalId: input.assignment.implementerPrincipalId,
          providerId: input.assignment.implementerProviderId,
          policyDigest: input.subject.reviewPolicyDigest,
        },
      }),
    hasCode('TASK_DIFF_FINAL_ASSURANCE_INVALID'),
  );
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.subject,
    review: record,
    response,
    submission,
    reviewerAuthority: {
      kind: 'engine-attributed-provider-reviewer',
      principalId: input.assignment.reviewerPrincipalId,
      providerId: input.assignment.reviewerProviderId,
      policyDigest: input.subject.reviewPolicyDigest,
    },
  });
  assert.equal(assurance.verdict, 'satisfied');
  assert.deepEqual(
    parseTaskDiffFinalAssuranceRecord(structuredClone(assurance)),
    assurance,
  );
  assert.deepEqual(
    assertTaskDiffFinalAssuranceCurrent({
      subject: input.subject,
      review: record,
      response,
      assurance,
    }),
    assurance,
  );
});

test('Final Assurance records the exact collaboration-grant degradation without weakening challenge closure', () => {
  const ordinary = reviewInput({ challenge: true });
  const grantUseDigest = '9'.repeat(64);
  const input: CreateTaskDiffReviewRecordInput = {
    ...ordinary,
    assignment: {
      ...ordinary.assignment,
      reviewerPrincipalId: 'collaboration-grant:reviewer',
      reviewerProviderId: ordinary.assignment.implementerProviderId,
      reviewerSessionId: 'granted-review-session-2',
      achievedIndependence: 'session-independent',
      degradedForm: 'same-provider-fresh-session',
      grantUseDigest,
    },
  };
  const review = createTaskDiffReviewRecord(input);
  const challenge = review.challenges[0]!;
  const response = createTaskDiffReviewChallengeResponse({
    review,
    responses: [
      {
        challengeId: challenge.challengeId,
        rationale: 'The exact candidate evidence answers the challenge.',
        evidence: [challenge.evidence[0]!],
      },
    ],
  });
  const submission = {
    schemaVersion: 1 as const,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    proposedDispositions: [
      {
        challengeId: challenge.challengeId,
        decision: 'rebutted' as const,
        rationale: 'The exact candidate evidence rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  const reviewerAuthority = {
    kind: 'engine-attributed-provider-reviewer' as const,
    principalId: input.assignment.reviewerPrincipalId,
    providerId: input.assignment.reviewerProviderId,
    policyDigest: input.subject.reviewPolicyDigest,
  };
  assert.throws(
    () =>
      createTaskDiffFinalAssuranceRecord({
        subject: input.subject,
        review,
        response,
        submission,
        reviewerAuthority,
      }),
    hasCode('TASK_DIFF_FINAL_ASSURANCE_INVALID'),
  );
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.subject,
    review,
    response,
    submission,
    reviewerAuthority,
    exceptions: [
      {
        kind: 'collaboration-grant-degradation',
        grantUseDigest,
        degradedForm: 'same-provider-fresh-session',
      },
    ],
  });
  assert.deepEqual(
    assertTaskDiffFinalAssuranceCurrent({
      subject: input.subject,
      review,
      response,
      assurance,
    }),
    assurance,
  );
});

test('TaskDiffReview challenge responses are content-addressed and cover the exact current challenge set', () => {
  const record = createTaskDiffReviewRecord(reviewInput({ challenge: true }));
  const challenge = record.challenges[0]!;
  const response = createTaskDiffReviewChallengeResponse({
    review: record,
    responses: [
      {
        challengeId: challenge.challengeId,
        rationale: 'The exact candidate check evidence answers the challenge.',
        evidence: [challenge.evidence[0]!],
      },
    ],
  });
  assert.match(response.responseDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    parseTaskDiffReviewChallengeResponseRecord(structuredClone(response)),
    response,
  );
  assert.deepEqual(
    assertTaskDiffReviewChallengeResponseCurrent(record, response),
    response,
  );
  assert.throws(
    () =>
      createTaskDiffReviewChallengeResponse({
        review: record,
        responses: [],
      }),
    hasCode('TASK_DIFF_REVIEW_DISPOSITION_INVALID'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewChallengeResponse({
        review: record,
        responses: [
          {
            challengeId: 'f'.repeat(64),
            rationale: 'This challenge was not raised by the bound review.',
            evidence: [],
          },
        ],
      }),
    hasCode('TASK_DIFF_REVIEW_DISPOSITION_INVALID'),
  );
});

test('accepted TaskDiffReview challenges produce changes-required Final Assurance', () => {
  const input = reviewInput({ challenge: true });
  const record = createTaskDiffReviewRecord(input);
  const response = createTaskDiffReviewChallengeResponse({
    review: record,
    responses: [
      {
        challengeId: record.challenges[0]!.challengeId,
        rationale: 'The implementation must change before it can proceed.',
        evidence: [record.challenges[0]!.evidence[0]!],
      },
    ],
  });
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.subject,
    review: record,
    response,
    submission: {
      schemaVersion: 1,
      reviewRecordDigest: record.recordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: [
        {
          challengeId: record.challenges[0]!.challengeId,
          decision: 'accepted',
          rationale: 'The implementation must change before it can proceed.',
          supersededBy: null,
        },
      ],
    },
    reviewerAuthority: {
      kind: 'engine-attributed-provider-reviewer',
      principalId: input.assignment.reviewerPrincipalId,
      providerId: input.assignment.reviewerProviderId,
      policyDigest: input.subject.reviewPolicyDigest,
    },
  });
  assert.equal(assurance.verdict, 'changes-required');
});

test('TaskDiffReview reuse fails when any canonical subject input changes or stored bytes are redigested incompletely', () => {
  const input = reviewInput();
  const record = createTaskDiffReviewRecord(input);
  const changed = createTaskDiffReviewSubject({
    ...subjectInput(),
    checkEvidenceDigest: '8'.repeat(64),
  });

  assert.throws(
    () => assertTaskDiffReviewContentSatisfied(changed, record, null),
    hasCode('TASK_DIFF_REVIEW_STALE'),
  );
  assert.throws(
    () =>
      parseTaskDiffReviewRecord({
        ...record,
        verdict: 'advisory-reject',
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );
});

function reviewInput(
  options: { challenge?: boolean } = {},
): CreateTaskDiffReviewRecordInput {
  const subject = createTaskDiffReviewSubject(subjectInput());
  const repositoryEvidence = {
    kind: 'repository-location' as const,
    path: 'src/a.ts',
    line: 1,
    blobObjectId: 'e'.repeat(40),
    observation: 'The changed branch preserves the task invariant.',
  };
  return {
    subject,
    assignment: {
      implementerPrincipalId: 'provider-b:implementer',
      implementerProviderId: 'provider-b',
      implementationSessionId: 'implementation-session-1',
      reviewerPrincipalId: 'provider-a:reviewer',
      reviewerProviderId: 'provider-a',
      reviewerSessionId: 'review-session-2',
      achievedIndependence: 'provider-independent',
      degradedForm: null,
      grantUseDigest: null,
    },
    submission: {
      schemaVersion: 1,
      verdict: options.challenge ? 'advisory-reject' : 'advisory-approve',
      coverage: [...TASK_DIFF_REVIEW_COVERAGE],
      scopeAssessment: options.challenge
        ? { kind: 'challenges' }
        : { kind: 'no-challenge', evidence: [repositoryEvidence] },
      findings: options.challenge
        ? [
            {
              kind: 'challenge',
              severity: 'high',
              category: 'correctness-and-invariants',
              currentChangeImpact: 'required',
              summary: 'The changed branch may violate the task invariant.',
              evidence: [repositoryEvidence],
            },
          ]
        : [],
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
      residualRisk: 'No residual release-blocking risk was identified.',
      uncertainty: 'Review is limited to the exact canonical subject.',
    },
  };
}

function subjectInput() {
  return {
    repositoryId: 'github:tomchen86/expense-app',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    candidateTree: 'c'.repeat(40),
    transitions: [
      {
        path: 'src/a.ts',
        before: { mode: '100644' as const, objectId: 'd'.repeat(40) },
        after: { mode: '100644' as const, objectId: 'e'.repeat(40) },
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
      basis: 'behavioral-strategy' as const,
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
