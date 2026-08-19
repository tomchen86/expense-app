import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDocumentationClosureRecord,
  encodeDocumentationClosure,
  parseDocumentationClosureFromCommitMessage,
  parseDocumentationClosureRecord,
} from '../src/documentation-closure.ts';

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
  type TaskDiffReviewAssignment,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  createTaskDiffDocumentationClosureRequirement,
  createTaskDiffReviewSubject,
  deriveTaskDiffReviewCandidatePlan,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/modules/assurance/task-diff-review.ts';

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
  assert.deepEqual(record.riskPathDispositions, []);
  assert.equal(record.assignment.achievedIndependence, 'provider-independent');
  assert.match(record.recordDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(parseTaskDiffReviewRecord(structuredClone(record)), record);
  assert.deepEqual(
    assertTaskDiffReviewContentSatisfied(input.subject, record, null),
    record,
  );
});

test('final-change TaskDiffReview requires an explicit documentation disposition', () => {
  const base = reviewInput();
  const subject = createTaskDiffReviewSubject({
    ...subjectInput(),
    documentationRequirement: createTaskDiffDocumentationClosureRequirement({
      required: true,
      changeBaseCommit: '1'.repeat(40),
      changeBaseTree: '2'.repeat(40),
      candidateTree: 'c'.repeat(40),
      changedPaths: ['docs/WORKFLOW.md', 'src/a.ts', 'src/b.ts'],
      patchDigest: '3'.repeat(64),
      hints: [
        {
          reason: 'workflow-lifecycle-changed',
          suggestedPaths: ['docs/WORKFLOW.md'],
        },
      ],
    }),
  } as Parameters<typeof createTaskDiffReviewSubject>[0]);

  assert.throws(
    () => createTaskDiffReviewRecord({ ...base, subject }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );

  const record = createTaskDiffReviewRecord({
    ...base,
    subject,
    submission: {
      ...base.submission,
      documentationAssessment: {
        decision: 'updated',
        paths: ['docs/WORKFLOW.md'],
        notes: 'The lifecycle documentation reflects the reviewed behavior.',
      },
    },
  } as CreateTaskDiffReviewRecordInput);

  assert.deepEqual(record.documentationAssessment, {
    decision: 'updated',
    paths: ['docs/WORKFLOW.md'],
    notes: 'The lifecycle documentation reflects the reviewed behavior.',
  });
  assert.deepEqual(parseTaskDiffReviewRecord(structuredClone(record)), record);

  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...base,
        subject,
        submission: {
          ...base.submission,
          documentationAssessment: {
            decision: 'no-impact',
            notes: 'This incorrectly ignores the changed documentation path.',
          },
        },
      } as CreateTaskDiffReviewRecordInput),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );

  const generated = createTaskDiffReviewRecord({
    ...base,
    subject,
    submission: {
      ...base.submission,
      documentationAssessment: {
        decision: 'generated-verified',
        sources: ['src/a.ts'],
        generated: ['docs/WORKFLOW.md'],
        evidence: ['check:documentation-projection'],
        notes: 'The generated documentation matches its reviewed source.',
      },
    },
  } as CreateTaskDiffReviewRecordInput);
  assert.equal(
    generated.documentationAssessment?.decision,
    'generated-verified',
  );

  const challenged = reviewInput({ challenge: true });
  const needsChanges = createTaskDiffReviewRecord({
    ...challenged,
    subject,
    submission: {
      ...challenged.submission,
      documentationAssessment: {
        decision: 'needs-changes',
        requiredPaths: ['docs/ROADMAP.md'],
        notes: 'The final change needs an exact roadmap update.',
      },
    },
  } as CreateTaskDiffReviewRecordInput);
  assert.equal(needsChanges.documentationAssessment?.decision, 'needs-changes');
  assert.throws(
    () =>
      createDocumentationClosureRecord({
        changeId: subject.changeId,
        taskId: subject.taskId,
        review: needsChanges,
        finalAssurance: null,
        remediation: {
          reviewRecordDigests: [needsChanges.recordDigest],
          paths: ['docs/ROADMAP.md'],
        },
        projectedCommitTree: '4'.repeat(40),
        projectionPaths: [`openspec/changes/${subject.changeId}/tasks.md`],
      }),
    hasCode('DOCUMENTATION_CLOSURE_INVALID'),
  );

  const closure = createDocumentationClosureRecord({
    changeId: subject.changeId,
    taskId: subject.taskId,
    review: record,
    finalAssurance: null,
    remediation: null,
    projectedCommitTree: '4'.repeat(40),
    projectionPaths: [
      `openspec/changes/${subject.changeId}/tasks.md`,
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ],
  });
  const message = [
    'Complete documentation closure',
    '',
    encodeDocumentationClosure(closure),
    '',
    `Change: ${subject.changeId}`,
    `Task: ${subject.taskId}`,
  ].join('\n');

  assert.deepEqual(
    parseDocumentationClosureRecord(structuredClone(closure)),
    closure,
  );
  assert.deepEqual(
    parseDocumentationClosureFromCommitMessage(message),
    closure,
  );
  assert.throws(
    () =>
      parseDocumentationClosureFromCommitMessage(
        message.replace('Task: 1.1', 'Task: 1.1\nDocumentation-Closure: bad'),
      ),
    hasCode('DOCUMENTATION_CLOSURE_INVALID'),
  );
});

test('TaskDiffReview binds one advisory disposition to every in-scope risk path and no ordinary path', () => {
  const input = riskReviewInput();
  const record = createTaskDiffReviewRecord(input);

  assert.deepEqual(record.riskPathDispositions, [
    {
      path: 'src/a.ts',
      role: 'lifecycle',
      outcome: 'challenge-raised',
    },
    { path: 'src/b.ts', role: 'policy', outcome: 'no-challenge' },
  ]);

  for (const riskPathDispositions of [
    input.submission.riskPathDispositions.slice(1),
    [
      ...input.submission.riskPathDispositions,
      { path: 'src/c.ts', role: 'ordinary', outcome: 'no-challenge' },
    ],
    [
      ...input.submission.riskPathDispositions,
      input.submission.riskPathDispositions[0],
    ],
    input.submission.riskPathDispositions.map((entry) =>
      entry.path === 'src/a.ts' ? { ...entry, role: 'policy' } : entry,
    ),
  ]) {
    assert.throws(
      () =>
        createTaskDiffReviewRecord({
          ...input,
          submission: { ...input.submission, riskPathDispositions },
        } as unknown as CreateTaskDiffReviewRecordInput),
      hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
    );
  }

  assert.throws(
    () => assertTaskDiffReviewContentSatisfied(input.subject, record, null),
    hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
  );
});

test('TaskDiffReview delta scope requires only risk paths intersecting reviewed paths', () => {
  const previous = createTaskDiffReviewSubject(riskSubjectInput());
  const current = createTaskDiffReviewSubject(
    riskSubjectInput({
      candidateTree: '8'.repeat(40),
      ordinaryAfterObjectId: '9'.repeat(40),
    }),
  );
  const plan = deriveTaskDiffReviewCandidatePlan({
    current,
    predecessor: {
      subject: previous,
      reviewRecordDigest: 'a'.repeat(64),
      finalAssuranceCommitmentDigest: null,
    },
  });
  assert.equal(plan.action, 'review');
  if (plan.action !== 'review') throw new Error('expected delta review');
  assert.equal(plan.scope.mode, 'delta');
  assert.deepEqual(plan.scope.reviewedPaths, ['src/c.ts']);

  const base = reviewInput({ challenge: false });
  const input = {
    ...base,
    subject: current,
    reviewScope: plan.scope,
    submission: {
      ...base.submission,
      riskPathDispositions: [],
    },
  };
  const record = createTaskDiffReviewRecord(input);
  assert.deepEqual(record.riskPathDispositions, []);
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        submission: {
          ...input.submission,
          riskPathDispositions: [
            { path: 'src/a.ts', role: 'lifecycle', outcome: 'no-challenge' },
          ],
        },
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );
});

test('a risk-path challenge outcome cannot exist without an advisory challenge finding', () => {
  const input = riskReviewInput();
  const noChallenge = reviewInput({ challenge: false }).submission
    .scopeAssessment;
  if (noChallenge.kind !== 'no-challenge') throw new Error('fixture invalid');
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        submission: {
          ...input.submission,
          verdict: 'advisory-approve',
          scopeAssessment: noChallenge,
          findings: [],
        },
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
  );
});

test('risk-path dispositions correlate challenges to the exact anchored path', () => {
  const input = riskReviewInput();
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...input,
        submission: {
          ...input.submission,
          riskPathDispositions: input.submission.riskPathDispositions.map(
            (entry) => ({
              ...entry,
              outcome:
                entry.path === 'src/a.ts'
                  ? ('no-challenge' as const)
                  : ('challenge-raised' as const),
            }),
          ),
        },
      }),
    hasCode('TASK_DIFF_REVIEW_RECORD_INVALID'),
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
        } as TaskDiffReviewAssignment,
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

test('TaskDiffReview represents an authenticated external reviewer without a fake provider or session', () => {
  const ordinary = reviewInput();
  const grantUseDigest = '8'.repeat(64);
  const assignment = {
    ...ordinary.assignment,
    implementerPrincipalId: 'caller:task-implementer',
    implementerProviderId: null,
    reviewerPrincipalId: 'maintainer:independent-reviewer',
    reviewerProviderId: null,
    reviewerSessionId: null,
    achievedIndependence: 'none',
    degradedForm: 'direct-human-review',
    grantUseDigest,
  } as const;
  const record = createTaskDiffReviewRecord({
    ...ordinary,
    assignment,
  });

  assert.deepEqual(record.assignment, assignment);
  assert.deepEqual(parseTaskDiffReviewRecord(structuredClone(record)), record);
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...ordinary,
        assignment: {
          ...assignment,
          reviewerPrincipalId: assignment.implementerPrincipalId,
        },
      }),
    hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'),
  );
  assert.throws(
    () =>
      createTaskDiffReviewRecord({
        ...ordinary,
        assignment: {
          ...ordinary.assignment,
          implementerProviderId: null,
        },
      }),
    hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'),
  );
  for (const invalid of [
    { ...assignment, reviewerProviderId: 'fake-provider' },
    { ...assignment, reviewerSessionId: 'fake-session' },
    { ...assignment, achievedIndependence: 'provider-independent' },
    { ...assignment, grantUseDigest: null },
  ]) {
    assert.throws(
      () =>
        createTaskDiffReviewRecord({
          ...ordinary,
          assignment: invalid as typeof assignment,
        }),
      hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'),
    );
  }
});

test('advisory dispositions cannot close challenges; Final Assurance uses the shared author-cannot-close verifier', () => {
  const input = reviewInput({ challenge: true });
  const implementerProviderId = input.assignment.implementerProviderId;
  if (implementerProviderId === null) throw new Error('fixture invalid');
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
          providerId: implementerProviderId,
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
  const implementerProviderId = ordinary.assignment.implementerProviderId;
  if (implementerProviderId === null) throw new Error('fixture invalid');
  const grantUseDigest = '9'.repeat(64);
  const input: ProviderTaskDiffReviewInput = {
    ...ordinary,
    assignment: {
      ...ordinary.assignment,
      reviewerPrincipalId: 'collaboration-grant:reviewer',
      reviewerProviderId: implementerProviderId,
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
        stage: 'review',
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

test('external review and challenge closure use independently staged grant authority in Final Assurance', () => {
  const ordinary = reviewInput({ challenge: true });
  const reviewGrantUseDigest = '8'.repeat(64);
  const closureGrantUseDigest = '9'.repeat(64);
  const input: CreateTaskDiffReviewRecordInput = {
    ...ordinary,
    assignment: {
      ...ordinary.assignment,
      reviewerPrincipalId: 'caller:independent-reviewer',
      reviewerProviderId: null,
      reviewerSessionId: null,
      achievedIndependence: 'none',
      degradedForm: 'caller-supplied',
      grantUseDigest: reviewGrantUseDigest,
    },
  };
  const review = createTaskDiffReviewRecord(input);
  const response = createTaskDiffReviewChallengeResponse({
    review,
    responses: review.challenges.map((challenge) => ({
      challengeId: challenge.challengeId,
      rationale: 'The exact external evidence answers the challenge.',
      evidence: [challenge.evidence[0]!],
    })),
  });
  const submission = {
    schemaVersion: 1 as const,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    proposedDispositions: review.challenges.map((challenge) => ({
      challengeId: challenge.challengeId,
      decision: 'rebutted' as const,
      rationale: 'The authenticated external closer rebuts the challenge.',
      supersededBy: null,
    })),
  };
  const reviewerAuthority = {
    kind: 'grant-attributed-external-reviewer' as const,
    principalId: 'maintainer:challenge-closer',
    degradedForm: 'direct-human-review' as const,
    grantUseDigest: closureGrantUseDigest,
    policyDigest: input.subject.reviewPolicyDigest,
  };
  const exceptions = [
    {
      kind: 'collaboration-grant-degradation' as const,
      stage: 'challenge-closure' as const,
      grantUseDigest: closureGrantUseDigest,
      degradedForm: 'direct-human-review' as const,
    },
    {
      kind: 'collaboration-grant-degradation' as const,
      stage: 'review' as const,
      grantUseDigest: reviewGrantUseDigest,
      degradedForm: 'caller-supplied' as const,
    },
  ];
  const authenticatedReviewAuthority = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'review' as const,
    subjectDigest: input.subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: null,
    authorityNodeId: 'a'.repeat(64),
    authorityResultDigest: 'b'.repeat(64),
    authority: {
      kind: 'grant-attributed-external-reviewer' as const,
      principalId: input.assignment.reviewerPrincipalId,
      degradedForm: 'caller-supplied' as const,
      grantUseDigest: reviewGrantUseDigest,
      policyDigest: input.subject.reviewPolicyDigest,
    },
  };
  const authenticatedChallengeClosureAuthority = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'challenge-closure' as const,
    subjectDigest: input.subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    authorityNodeId: 'c'.repeat(64),
    authorityResultDigest: 'd'.repeat(64),
    authority: reviewerAuthority,
  };
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.subject,
    review,
    response,
    submission,
    reviewerAuthority,
    exceptions,
    authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority,
  });

  assert.equal(
    assurance.reviewerAuthority.principalId,
    reviewerAuthority.principalId,
  );
  assert.deepEqual(assurance.exceptions, [...exceptions].reverse());
  assert.deepEqual(
    parseTaskDiffFinalAssuranceRecord(structuredClone(assurance)),
    assurance,
  );
  assert.deepEqual(
    assertTaskDiffFinalAssuranceCurrent({
      subject: input.subject,
      review,
      response,
      assurance,
      authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority,
    }),
    assurance,
  );

  for (const invalidExceptions of [
    exceptions.slice(0, 1),
    [exceptions[1], exceptions[1]],
    [exceptions[1], { ...exceptions[0], grantUseDigest: reviewGrantUseDigest }],
  ]) {
    assert.throws(
      () =>
        createTaskDiffFinalAssuranceRecord({
          subject: input.subject,
          review,
          response,
          submission,
          reviewerAuthority,
          exceptions: invalidExceptions,
          authenticatedReviewAuthority,
          authenticatedChallengeClosureAuthority,
        }),
      hasCode('TASK_DIFF_FINAL_ASSURANCE_INVALID'),
    );
  }
  assert.throws(
    () =>
      createTaskDiffFinalAssuranceRecord({
        subject: input.subject,
        review,
        response,
        submission,
        reviewerAuthority: {
          ...reviewerAuthority,
          principalId: input.assignment.implementerPrincipalId,
        },
        exceptions,
        authenticatedReviewAuthority,
        authenticatedChallengeClosureAuthority,
      }),
    (error: unknown) =>
      hasCode('REVIEW_CHALLENGE_INVALID')(error) ||
      hasCode('TASK_DIFF_FINAL_ASSURANCE_INVALID')(error),
  );
});

test('provider review can continue through separately authenticated external challenge closure', () => {
  const input = reviewInput({ challenge: true });
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
        rationale: 'The independent external closer rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  const reviewerAuthority = {
    kind: 'grant-attributed-external-reviewer' as const,
    principalId: 'maintainer:challenge-closer',
    degradedForm: 'direct-human-review' as const,
    grantUseDigest: '8'.repeat(64),
    policyDigest: input.subject.reviewPolicyDigest,
  };
  const authenticatedReviewAuthority = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'review' as const,
    subjectDigest: input.subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: null,
    authorityNodeId: '1'.repeat(64),
    authorityResultDigest: '2'.repeat(64),
    authority: {
      kind: 'engine-attributed-provider-reviewer' as const,
      principalId: input.assignment.reviewerPrincipalId,
      providerId: input.assignment.reviewerProviderId,
      policyDigest: input.subject.reviewPolicyDigest,
    },
  };
  const authenticatedChallengeClosureAuthority = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'challenge-closure' as const,
    subjectDigest: input.subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    authorityNodeId: '3'.repeat(64),
    authorityResultDigest: '4'.repeat(64),
    authority: reviewerAuthority,
  };
  const exceptions = [
    {
      kind: 'collaboration-grant-degradation' as const,
      stage: 'challenge-closure' as const,
      grantUseDigest: reviewerAuthority.grantUseDigest,
      degradedForm: reviewerAuthority.degradedForm,
    },
  ];

  assert.throws(
    () =>
      createTaskDiffFinalAssuranceRecord({
        subject: input.subject,
        review,
        response,
        submission,
        reviewerAuthority,
        exceptions,
        authenticatedChallengeClosureAuthority,
      }),
    hasCode('TASK_DIFF_FINAL_ASSURANCE_INVALID'),
  );

  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.subject,
    review,
    response,
    submission,
    reviewerAuthority,
    exceptions,
    authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority,
  });
  assert.deepEqual(
    assertTaskDiffFinalAssuranceCurrent({
      subject: input.subject,
      review,
      response,
      assurance,
      authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority,
    }),
    assurance,
  );
});

test('external initial review can continue through separately authenticated provider challenge closure', () => {
  const providerInput = reviewInput({ challenge: true });
  const reviewGrantUseDigest = '7'.repeat(64);
  const input: CreateTaskDiffReviewRecordInput = {
    ...providerInput,
    assignment: {
      ...providerInput.assignment,
      reviewerPrincipalId: 'maintainer:initial-reviewer',
      reviewerProviderId: null,
      reviewerSessionId: null,
      achievedIndependence: 'none',
      degradedForm: 'caller-supplied',
      grantUseDigest: reviewGrantUseDigest,
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
        rationale: 'The independent provider closer rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  const reviewerAuthority = {
    kind: 'engine-attributed-provider-reviewer' as const,
    principalId: 'provider-a:challenge-closer',
    providerId: 'provider-a',
    policyDigest: input.subject.reviewPolicyDigest,
  };
  const authenticatedReviewAuthority = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'review' as const,
    subjectDigest: input.subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: null,
    authorityNodeId: '5'.repeat(64),
    authorityResultDigest: '6'.repeat(64),
    authority: {
      kind: 'grant-attributed-external-reviewer' as const,
      principalId: input.assignment.reviewerPrincipalId,
      degradedForm: 'caller-supplied' as const,
      grantUseDigest: reviewGrantUseDigest,
      policyDigest: input.subject.reviewPolicyDigest,
    },
  };
  const authenticatedChallengeClosureAuthority = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'challenge-closure' as const,
    subjectDigest: input.subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    authorityNodeId: '7'.repeat(64),
    authorityResultDigest: '8'.repeat(64),
    authority: reviewerAuthority,
  };
  const exceptions = [
    {
      kind: 'collaboration-grant-degradation' as const,
      stage: 'review' as const,
      grantUseDigest: reviewGrantUseDigest,
      degradedForm: 'caller-supplied' as const,
    },
  ];

  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.subject,
    review,
    response,
    submission,
    reviewerAuthority,
    exceptions,
    authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority,
  });
  assert.deepEqual(
    assertTaskDiffFinalAssuranceCurrent({
      subject: input.subject,
      review,
      response,
      assurance,
      authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority,
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

test('TaskDiffReview reuse follows candidate identity while redigested record bytes still fail closed', () => {
  const input = reviewInput();
  const record = createTaskDiffReviewRecord(input);
  const sameCandidate = createTaskDiffReviewSubject({
    ...subjectInput(),
    checkEvidenceDigest: '8'.repeat(64),
  });
  const changedCandidate = createTaskDiffReviewSubject({
    ...subjectInput(),
    candidateTree: '8'.repeat(40),
  });

  assert.equal(
    assertTaskDiffReviewContentSatisfied(sameCandidate, record, null)
      .recordDigest,
    record.recordDigest,
  );
  assert.throws(
    () => assertTaskDiffReviewContentSatisfied(changedCandidate, record, null),
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

type ProviderTaskDiffReviewInput = Omit<
  CreateTaskDiffReviewRecordInput,
  'assignment'
> &
  Readonly<{
    assignment: Extract<
      TaskDiffReviewAssignment,
      { reviewerProviderId: string }
    >;
  }>;

function reviewInput(
  options: { challenge?: boolean } = {},
): ProviderTaskDiffReviewInput {
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
      riskPathDispositions: [],
      residualRisk: 'No residual release-blocking risk was identified.',
      uncertainty: 'Review is limited to the exact canonical subject.',
    },
  };
}

function riskReviewInput(): CreateTaskDiffReviewRecordInput {
  const base = reviewInput({ challenge: true });
  return {
    ...base,
    subject: createTaskDiffReviewSubject(riskSubjectInput()),
    submission: {
      ...base.submission,
      riskPathDispositions: [
        { path: 'src/b.ts', role: 'policy', outcome: 'no-challenge' },
        {
          path: 'src/a.ts',
          role: 'lifecycle',
          outcome: 'challenge-raised',
        },
      ],
    },
  };
}

function riskSubjectInput(
  options: {
    candidateTree?: string;
    ordinaryAfterObjectId?: string;
  } = {},
) {
  return {
    ...subjectInput(),
    candidateTree: options.candidateTree ?? 'c'.repeat(40),
    transitions: [
      {
        path: 'src/a.ts',
        before: { mode: '100644' as const, objectId: 'd'.repeat(40) },
        after: { mode: '100644' as const, objectId: 'e'.repeat(40) },
      },
      {
        path: 'src/b.ts',
        before: { mode: '100644' as const, objectId: '1'.repeat(40) },
        after: { mode: '100644' as const, objectId: '2'.repeat(40) },
      },
      {
        path: 'src/c.ts',
        before: { mode: '100644' as const, objectId: '3'.repeat(40) },
        after: {
          mode: '100644' as const,
          objectId: options.ordinaryAfterObjectId ?? '4'.repeat(40),
        },
      },
    ],
    reviewRequirement: {
      required: true,
      basis: 'risk-role' as const,
      riskPaths: [
        { path: 'src/a.ts', role: 'lifecycle' as const },
        { path: 'src/b.ts', role: 'policy' as const },
      ],
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
