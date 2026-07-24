import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceNode, type EvidenceNode } from '../src/evidence-node.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  projectPlanReviewTerms,
  type PlanReviewTermProjection,
} from '../src/investigation-term-projection.ts';
import {
  createPlanReviewDispositionNode,
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewSubject,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  readPlanReviewDispositionNode,
  readPlanReviewNode,
  type PlanReviewSubmission,
} from '../src/plan-review.ts';
import { validatePlanReview } from '../src/plan-review-validation.ts';
import {
  createPlanTarget,
  type PlanTarget,
  type PlanTargetInput,
} from '../src/plan-target.ts';
import {
  createPlanningGeneration,
  type PlanningGeneration,
} from '../src/planning-generation.ts';
import type { RoleAssignment } from '../src/role-scheduler.ts';

const DIGESTS = {
  schema: '1'.repeat(64),
  structured: '2'.repeat(64),
  ledgerRenderer: '3'.repeat(64),
  whyNode: '4'.repeat(64),
  whyResult: '5'.repeat(64),
  workflowPolicy: '6'.repeat(64),
  canonicalizerPolicy: '7'.repeat(64),
  rendererPolicy: '8'.repeat(64),
  reviewPolicy: '9'.repeat(64),
  investigationNode: 'a'.repeat(64),
  investigationResult: 'b'.repeat(64),
} as const;

test('plan review v2 requires finding severity, residual risk, and explicit uncertainty', () => {
  assert.equal(PLAN_REVIEW_OUTPUT_SCHEMA.version, 2);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.version, 2);

  const missingResidualRisk = structuredClone(
    challengeSubmission(),
  ) as unknown as Record<string, unknown>;
  delete missingResidualRisk.residualRisk;
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(missingResidualRisk),
    false,
  );

  const invalidSeverity = structuredClone(challengeSubmission()) as unknown as {
    findings: Array<Record<string, unknown>>;
  };
  invalidSeverity.findings[0]!.severity = 'urgent';
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.validate(invalidSeverity), false);
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(challengeSubmission()),
    true,
  );
});

test('plan target canonicalizes only enumerated component semantics', () => {
  const original = createPlanTarget(planTargetInput());

  const reorderedStructured = planTargetInput();
  structuredComponent(reorderedStructured, 'guard').value = {
    tasks: { '1.1': { requiredChecks: ['fixture'], allowedPaths: ['src/**'] } },
    changeId: 'demo-change',
    schemaVersion: 1,
  };
  assert.equal(
    createPlanTarget(reorderedStructured).targetDigest,
    original.targetDigest,
  );

  const crlf = planTargetInput();
  authoredComponent(crlf, 'proposal').content = authoredComponent(
    crlf,
    'proposal',
  ).content.replaceAll('\n', '\r\n');
  assert.equal(createPlanTarget(crlf).targetDigest, original.targetDigest);

  const checked = planTargetInput();
  tasksComponent(checked).content = tasksComponent(checked).content.replace(
    '- [ ] 1.1',
    '- [x] 1.1',
  );
  assert.equal(createPlanTarget(checked).targetDigest, original.targetDigest);

  for (const mutate of [
    (input: PlanTargetInput) => {
      authoredComponent(input, 'proposal').content =
        '# Proposal\n\nDo not preserve the behavior.\n';
    },
    (input: PlanTargetInput) => {
      tasksComponent(input).content =
        '# Tasks changed\n\n## Work\n\n- [ ] 1.1 Implement behavior\n';
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).authoredRegions[0] = '# Design changed\n\n';
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).managedProjection.sourceNodes[0]!.resultDigest =
        'c'.repeat(64);
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).managedProjection.rendererDigest = 'd'.repeat(64);
    },
    (input: PlanTargetInput) => {
      policyComponent(input, 'review-policy').digest = 'e'.repeat(64);
    },
  ]) {
    const changed = planTargetInput();
    mutate(changed);
    assert.notEqual(
      createPlanTarget(changed).targetDigest,
      original.targetDigest,
    );
  }
});

test('plan target normalizes only managed task checkboxes and supports complete multi-clause specs', () => {
  const unchecked = planTargetInput();
  tasksComponent(unchecked).content +=
    '\n## Notes\n\n- [ ] Ordinary authored checklist\n';
  const checkedAuthoredChecklist = structuredClone(unchecked);
  tasksComponent(checkedAuthoredChecklist).content = tasksComponent(
    checkedAuthoredChecklist,
  ).content.replace(
    '- [ ] Ordinary authored checklist',
    '- [x] Ordinary authored checklist',
  );
  assert.notEqual(
    createPlanTarget(unchecked).targetDigest,
    createPlanTarget(checkedAuthoredChecklist).targetDigest,
  );

  const multipleClauses = planTargetInput();
  multipleClauses.components.push({
    kind: 'requirement-clause',
    role: 'requirement-clause',
    path: 'openspec/changes/demo-change/specs/demo/spec.md',
    requirement: 'Demo',
    scenario: 'Also works',
    content:
      '#### Scenario: Also works\n\n- **WHEN** another path runs\n- **THEN** it works\n',
  });
  const target = createPlanTarget(multipleClauses);
  assert.equal(
    target.components.filter(
      ({ role, path }) =>
        role === 'requirement-clause' &&
        path === 'openspec/changes/demo-change/specs/demo/spec.md',
    ).length,
    2,
  );

  const traversal = planTargetInput();
  authoredComponent(traversal, 'proposal').path = '../outside.md';
  assert.throws(
    () => createPlanTarget(traversal),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );
});

test('mixed target dependencies are order-insensitive and reject duplicate identities', () => {
  const first = planTargetInput();
  mixedComponent(first).managedProjection.sourceNodes.push({
    nodeId: 'c'.repeat(64),
    resultDigest: 'd'.repeat(64),
  });
  const reversed = structuredClone(first);
  mixedComponent(reversed).managedProjection.sourceNodes.reverse();
  assert.equal(
    createPlanTarget(first).targetDigest,
    createPlanTarget(reversed).targetDigest,
  );

  const duplicate = structuredClone(first);
  mixedComponent(duplicate).managedProjection.sourceNodes.push(
    structuredClone(
      mixedComponent(duplicate).managedProjection.sourceNodes[0]!,
    ),
  );
  assert.throws(
    () => createPlanTarget(duplicate),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const unicodePaths = planTargetInput();
  unicodePaths.components.push(
    {
      kind: 'policy',
      role: 'policy',
      path: 'workflow/\u00e9-policy',
      name: 'composed-policy',
      version: 1,
      digest: 'c'.repeat(64),
    },
    {
      kind: 'policy',
      role: 'policy',
      path: 'workflow/e\u0301-policy',
      name: 'decomposed-policy',
      version: 1,
      digest: 'd'.repeat(64),
    },
  );
  const reversedUnicodePaths = structuredClone(unicodePaths);
  reversedUnicodePaths.components.reverse();
  assert.equal(
    createPlanTarget(unicodePaths).targetDigest,
    createPlanTarget(reversedUnicodePaths).targetDigest,
  );
});

test('structured target semantics exclude only code-owned runtime metadata', () => {
  const first = planTargetInput();
  structuredComponent(first, 'investigation').value = {
    schemaVersion: 1,
    kind: 'investigation-artifact',
    currentRefs: { sealedInvestigation: DIGESTS.investigationNode },
    nodes: [
      {
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
        runtimeMetadata: {
          elapsedMs: 10,
          pid: 123,
          displayOrder: 1,
        },
      },
    ],
  };
  const runtimeChanged = structuredClone(first);
  const runtimeNode = (
    structuredComponent(runtimeChanged, 'investigation').value as {
      nodes: Array<{ runtimeMetadata: Record<string, number> }>;
    }
  ).nodes[0]!;
  runtimeNode.runtimeMetadata = {
    elapsedMs: 999,
    pid: 456,
    displayOrder: 2,
  };
  assert.equal(
    createPlanTarget(first).targetDigest,
    createPlanTarget(runtimeChanged).targetDigest,
  );

  const semanticChanged = structuredClone(first);
  (
    structuredComponent(semanticChanged, 'investigation').value as {
      currentRefs: { sealedInvestigation: string };
    }
  ).currentRefs.sealedInvestigation = 'f'.repeat(64);
  assert.notEqual(
    createPlanTarget(first).targetDigest,
    createPlanTarget(semanticChanged).targetDigest,
  );
});

test('plan target enforces exact typed closure, ordering, and review exclusion', () => {
  const input = planTargetInput();
  input.components.reverse();
  const target = createPlanTarget(input);

  assert.deepEqual(
    target.components.map(({ role, path }) => [role, path]),
    [...target.components]
      .sort((left, right) =>
        `${left.role}\0${left.path}`.localeCompare(
          `${right.role}\0${right.path}`,
        ),
      )
      .map(({ role, path }) => [role, path]),
  );
  assert.equal(
    target.components.some(({ path }) => path.endsWith('plan-review.json')),
    false,
  );
  assert.equal(JSON.stringify(target).includes('runtimeMetadata'), false);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.components), true);

  const missing = planTargetInput();
  missing.components = missing.components.filter(
    (component) => component.role !== 'design',
  );
  assert.throws(
    () => createPlanTarget(missing),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const duplicate = planTargetInput();
  duplicate.components.push(
    structuredClone(authoredComponent(duplicate, 'proposal')),
  );
  assert.throws(
    () => createPlanTarget(duplicate),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const review = planTargetInput();
  review.components.push({
    kind: 'structured-json',
    role: 'plan-review',
    path: 'openspec/changes/demo-change/plan-review.json',
    schemaDigest: DIGESTS.structured,
    value: {},
  } as never);
  assert.throws(
    () => createPlanTarget(review),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );
});

test('planning generation is immutable and changes only with governing inputs', () => {
  const firstInput = generationInput(createPlanTarget(planTargetInput()));
  const generation = createPlanningGeneration(firstInput);
  const reordered = generationInput(
    createPlanTarget({
      ...planTargetInput(),
      components: [...planTargetInput().components].reverse(),
    }),
  );
  reordered.investigationDependencies.reverse();
  assert.equal(
    createPlanningGeneration(reordered).planningGenerationId,
    generation.planningGenerationId,
  );

  firstInput.investigationDependencies[0]!.resultDigest = 'f'.repeat(64);
  assert.notEqual(
    firstInput.investigationDependencies[0]!.resultDigest,
    generation.investigationDependencies[0]!.resultDigest,
  );
  assert.equal(Object.isFrozen(generation), true);
  assert.equal(Object.isFrozen(generation.investigationDependencies), true);

  for (const mutate of [
    (input: ReturnType<typeof generationInput>) => {
      input.investigationBaseline.tree = 'c'.repeat(40);
    },
    (input: ReturnType<typeof generationInput>) => {
      input.investigationDependencies[0]!.resultDigest = 'd'.repeat(64);
    },
    (input: ReturnType<typeof generationInput>) => {
      input.policies.reviewPolicyDigest = 'e'.repeat(64);
    },
  ]) {
    const changed = generationInput(createPlanTarget(planTargetInput()));
    mutate(changed);
    assert.notEqual(
      createPlanningGeneration(changed).planningGenerationId,
      generation.planningGenerationId,
    );
  }
});

test('planning generation and review subjects recompute rather than trust caller digests', () => {
  const target = createPlanTarget(planTargetInput());
  const forgedTarget = structuredClone(target);
  forgedTarget.components[0]!.componentDigest = 'f'.repeat(64);
  assert.throws(
    () => createPlanningGeneration(generationInput(forgedTarget)),
    (error) => isWorkflowError(error, 'PLANNING_GENERATION_INVALID'),
  );

  const generation = createPlanningGeneration(generationInput(target));
  const forgedGeneration = structuredClone(generation);
  forgedGeneration.targetDigest = 'e'.repeat(64);
  assert.throws(
    () =>
      createPlanReviewSubject({
        generation: forgedGeneration,
        reviewPolicyDigest: DIGESTS.reviewPolicy,
        requiredIndependence: 'provider-independent',
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const context = reviewContext();
  const forgedSubject = structuredClone(context.subject);
  forgedSubject.planTargetDigest = 'd'.repeat(64);
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: forgedSubject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: challengeSubmission(),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const wrongSchemaSubject = structuredClone(context.subject);
  wrongSchemaSubject.schemaVersion = 2 as 1;
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: wrongSchemaSubject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: challengeSubmission(),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const accessorInput = {
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'provider-independent' as const,
  } as {
    generation: PlanningGeneration;
    reviewPolicyDigest: string;
    requiredIndependence: 'provider-independent';
  };
  Object.defineProperty(accessorInput, 'generation', {
    enumerable: true,
    get() {
      throw new Error('caller accessor must not execute');
    },
  });
  assert.throws(
    () => createPlanReviewSubject(accessorInput),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

test('PlanReview requires complete coverage and evidence-bound challenge or no-challenge', () => {
  const context = reviewContext();
  const challengeNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const challenge = readPlanReviewNode(challengeNode);
  assert.equal(challenge.findings.length, 1);
  assert.match(challenge.findings[0]!.findingId, /^[0-9a-f]{64}$/);
  assert.deepEqual(challenge.coverage, PLAN_REVIEW_COVERAGE);
  assert.equal(Object.isFrozen(challenge), true);

  const noChallenge = challengeSubmission();
  noChallenge.verdict = 'advisory-approve';
  noChallenge.scopeAssessment = {
    kind: 'no-challenge',
    evidence: [
      {
        kind: 'investigation-node',
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
      },
    ],
  };
  noChallenge.findings = [];
  assert.equal(
    readPlanReviewNode(
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: providerResultFor(context, noChallenge),
        submission: noChallenge,
      }),
    ).scopeAssessment.kind,
    'no-challenge',
  );

  const scopeChallengeMissing = challengeSubmission();
  scopeChallengeMissing.findings[0] = {
    ...scopeChallengeMissing.findings[0]!,
    category: 'weak-why',
  };
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: scopeChallengeMissing,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  for (const mutate of [
    (submission: PlanReviewSubmission) => {
      submission.coverage = submission.coverage.slice(1);
    },
    (submission: PlanReviewSubmission) => {
      submission.scopeAssessment = { kind: 'no-challenge', evidence: [] };
      submission.findings = [];
    },
    (submission: PlanReviewSubmission) => {
      submission.findings[0]!.evidence = [];
    },
    (submission: PlanReviewSubmission) => {
      submission.findings[0]!.evidence = [
        {
          kind: 'repository-location',
          path: 'src/consumer.ts',
          line: 0,
          observation: 'invalid line',
        },
      ];
    },
    (submission: PlanReviewSubmission) => {
      submission.findings[0]!.evidence = [
        {
          kind: 'repository-location',
          path: '../outside.ts',
          line: 1,
          observation: 'Traversal is not repository evidence.',
        },
      ];
    },
  ]) {
    const invalid = challengeSubmission();
    mutate(invalid);
    assert.throws(
      () =>
        createPlanReviewNode({
          subject: context.subject,
          assignment: context.assignment,
          providerResultNode: context.providerResult,
          submission: invalid,
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
    );
  }
});

test('advisory verdict never replaces hard currentness and disposition gates', () => {
  const context = reviewContext();
  const submission = challengeSubmission({
    suggestions: [
      suggestion('Document a later migration'),
      suggestion('Document a later migration'),
      suggestion('Add a future dashboard'),
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  const review = readPlanReviewNode(reviewNode);
  const challengeId = review.findings.find(
    ({ kind }) => kind === 'challenge',
  )!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: DIGESTS.reviewPolicy,
    dispositions: [
      {
        challengeId,
        decision: 'rejected',
        rationale: 'The cited consumer is intentionally outside this change.',
        author: 'main-agent',
      },
    ],
  });

  const result = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    dispositionNode,
  });
  assert.equal(result.current, true);
  assert.equal(result.eligible, true);
  assert.equal(result.advisoryVerdict, 'advisory-reject');
  assert.equal(result.undispositionedChallengeIds.length, 0);
  assert.deepEqual(
    result.intakeCandidates.map(({ summary }) => summary),
    ['Add a future dashboard', 'Document a later migration'],
  );
  assert.equal(JSON.stringify(result).includes('issueId'), false);

  const missing = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    dispositionNode: null,
  });
  assert.equal(missing.current, true);
  assert.equal(missing.eligible, false);
  assert.deepEqual(missing.undispositionedChallengeIds, [challengeId]);

  const changedTargetInput = planTargetInput();
  authoredComponent(changedTargetInput, 'proposal').content +=
    '\nThe governing plan changed.\n';
  const changedTarget = createPlanTarget(changedTargetInput);
  const changedGeneration = createPlanningGeneration(
    generationInput(changedTarget),
  );
  const staleSubject = createPlanReviewSubject({
    generation: changedGeneration,
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'provider-independent',
  });
  const staleContext = {
    target: changedTarget,
    generation: changedGeneration,
    subject: staleSubject,
  };
  const stale = validatePlanReview({
    ...currentValidationInput(staleContext, reviewNode),
    dispositionNode,
  });
  assert.equal(stale.current, false);
  assert.equal(stale.eligible, false);
  assert.ok(stale.staleReasons.includes('PLAN_TARGET_MISMATCH'));
  assert.deepEqual(stale.intakeCandidates, []);
});

test('stored PlanReview and dispositions replay their exact evaluator bindings', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const forgedReviewNode = createEvidenceNode({
    type: reviewNode.type,
    nodeSchema: reviewNode.nodeSchema,
    evaluator: reviewNode.evaluator,
    policyDigest: reviewNode.policyDigest,
    exactInputDigests: { subject: context.subject.subjectDigest },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: reviewNode.outputSchema,
    output: reviewNode.output,
    runtimeMetadata: {},
  });
  assert.throws(
    () => readPlanReviewNode(forgedReviewNode),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: challengeSubmission({
          proposedTerms: [{ kind: 'symbol', value: 'UnobservedTerm' }],
        }),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: DIGESTS.reviewPolicy,
    dispositions: [
      {
        challengeId,
        decision: 'mitigated',
        rationale: 'The plan now covers the cited consumer.',
        author: 'main-agent',
      },
    ],
  });
  const forgedDispositionNode = createEvidenceNode({
    type: dispositionNode.type,
    nodeSchema: dispositionNode.nodeSchema,
    evaluator: dispositionNode.evaluator,
    policyDigest: dispositionNode.policyDigest,
    exactInputDigests: { dispositions: 'f'.repeat(64) },
    semanticParentResultDigests: dispositionNode.semanticParentResultDigests,
    provenanceParentNodeIds: dispositionNode.provenanceParentNodeIds,
    outputSchema: dispositionNode.outputSchema,
    output: dispositionNode.output,
    runtimeMetadata: {},
  });
  assert.throws(
    () => readPlanReviewDispositionNode(forgedDispositionNode),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

test('review validation rejects policy substitution, unknown dispositions, and uncited graph identities', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: DIGESTS.reviewPolicy,
    dispositions: [
      {
        challengeId,
        decision: 'mitigated',
        rationale: 'The exact subject now accounts for the challenge.',
        author: 'main-agent',
      },
    ],
  });
  const substitutedPolicyReview = createEvidenceNode({
    type: reviewNode.type,
    nodeSchema: reviewNode.nodeSchema,
    evaluator: reviewNode.evaluator,
    policyDigest: 'f'.repeat(64),
    exactInputDigests: reviewNode.exactInputDigests,
    semanticParentResultDigests: reviewNode.semanticParentResultDigests,
    provenanceParentNodeIds: reviewNode.provenanceParentNodeIds,
    outputSchema: reviewNode.outputSchema,
    output: reviewNode.output,
    runtimeMetadata: {},
  });
  const substituted = validatePlanReview({
    ...currentValidationInput(context, substitutedPolicyReview),
    dispositionNode: null,
  });
  assert.equal(substituted.current, false);
  assert.ok(substituted.staleReasons.includes('REVIEW_NODE_POLICY_MISMATCH'));

  const unknownDispositionNode = createEvidenceNode({
    type: 'plan-review-disposition',
    nodeSchema: 'plan-review-disposition.v1',
    evaluator: 'plan-review-disposition.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: { dispositions: '1'.repeat(64) },
    semanticParentResultDigests: { review: reviewNode.resultDigest },
    provenanceParentNodeIds: { review: reviewNode.nodeId },
    outputSchema: 'plan-review-disposition-output.v1',
    output: {
      schemaVersion: 1,
      dispositions: [
        {
          challengeId,
          decision: 'mitigated',
          rationale: 'Known challenge.',
          author: 'main-agent',
        },
        {
          challengeId: 'e'.repeat(64),
          decision: 'accepted',
          rationale: 'Unknown challenge must not be ignored.',
          author: 'main-agent',
        },
      ].sort((left, right) => (left.challengeId < right.challengeId ? -1 : 1)),
    },
    runtimeMetadata: {},
  });
  assert.throws(
    () =>
      validatePlanReview({
        ...currentValidationInput(context, reviewNode),
        dispositionNode: unknownDispositionNode,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const uncited = challengeSubmission();
  uncited.findings[0]!.evidence = [
    {
      kind: 'investigation-node',
      nodeId: 'e'.repeat(64),
      resultDigest: 'f'.repeat(64),
    },
  ];
  assert.throws(
    () => providerResultFor(context, uncited),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  assert.equal(dispositionNode.type, 'plan-review-disposition');
});

test('review eligibility recomputes provider separation and resolves repository citations', () => {
  const context = reviewContext();
  const submission = challengeSubmission();
  const sameProviderAssignment: RoleAssignment = {
    ...context.assignment,
    providerId: 'codex',
  };
  const sameProviderResult = createPlanReviewProviderResultNode({
    subject: context.subject,
    assignment: sameProviderAssignment,
    submission,
    providerPolicyDigest: DIGESTS.reviewPolicy,
  });
  const sameProviderReview = createPlanReviewNode({
    subject: context.subject,
    assignment: sameProviderAssignment,
    providerResultNode: sameProviderResult,
    submission,
  });
  const sameProvider = validatePlanReview(
    currentValidationInput(context, sameProviderReview),
  );
  assert.equal(sameProvider.current, false);
  assert.equal(sameProvider.eligible, false);
  assert.equal(sameProvider.achievedIndependence, 'none');
  assert.ok(
    sameProvider.staleReasons.includes(
      'REVIEWER_PROVIDER_INDEPENDENCE_MISMATCH',
    ),
  );

  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission,
  });
  const missingLocation = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    repositoryEvidence: {
      tree: context.subject.investigationBaseline.tree,
      locations: [],
    },
  });
  assert.equal(missingLocation.current, false);
  assert.equal(missingLocation.eligible, false);
  assert.ok(
    missingLocation.staleReasons.includes('REPOSITORY_EVIDENCE_MISMATCH'),
  );

  const outOfRange = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    repositoryEvidence: {
      tree: context.subject.investigationBaseline.tree,
      locations: [
        {
          path: 'src/consumer.ts',
          blobOid: 'c'.repeat(
            context.subject.investigationBaseline.tree.length,
          ),
          lineCount: 11,
        },
      ],
    },
  });
  assert.equal(outOfRange.current, false);
  assert.equal(outOfRange.eligible, false);
  assert.ok(outOfRange.staleReasons.includes('REPOSITORY_EVIDENCE_MISMATCH'));
});

test('reviewer terms enter only the fixed bounded projector with node provenance', () => {
  const context = reviewContext();
  const submission = challengeSubmission({
    proposedTerms: [
      { kind: 'symbol', value: 'SharedConsumer' },
      { kind: 'literal-path', value: 'src/shared.ts' },
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  const validationInput = currentValidationInput(context, reviewNode);
  const projected = projectPlanReviewTerms({
    validationInput,
    existingContributions: [
      {
        source: 'main',
        reference: 'main-input',
        terms: [
          {
            kind: 'symbol',
            value: 'SharedConsumer',
            rationale: 'The main investigation identified the shared symbol.',
            expectedRelationship: 'Existing consumers import this symbol.',
          },
        ],
      },
    ],
  });
  assert.equal(projected.preview.outcome, 'ready');
  const shared = projected.preview.terms.find(
    ({ value }) => value === 'SharedConsumer',
  );
  assert.deepEqual(shared?.provenance, [
    {
      source: 'main',
      reference: 'main-input',
      rationale: 'The main investigation identified the shared symbol.',
      expectedRelationship: 'Existing consumers import this symbol.',
    },
    {
      source: 'reviewer',
      reference: reviewNode.nodeId,
      rationale: null,
      expectedRelationship: null,
    },
  ]);

  const broadSubmission = challengeSubmission({
    proposedTerms: Array.from({ length: 129 }, (_, index) => ({
      kind: 'symbol' as const,
      value: `review-term-${index}`,
    })),
  });
  const broadNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, broadSubmission),
    submission: broadSubmission,
  });
  const broad = projectPlanReviewTerms({
    validationInput: currentValidationInput(context, broadNode),
    existingContributions: [],
  });
  assert.equal(broad.preview.outcome, 'requires-narrowing');
  if (broad.preview.outcome === 'requires-narrowing') {
    assert.ok(
      broad.preview.violations.some(
        ({ code }) => code === 'REVIEWER_TERM_LIMIT_EXCEEDED',
      ),
    );
  }

  assert.throws(
    () =>
      projectPlanReviewTerms({
        validationInput,
        existingContributions: [
          {
            source: 'reviewer',
            reference: 'caller-injected',
            terms: [{ kind: 'symbol', value: 'Bypass' }],
          },
        ],
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_TERM_PROJECTION_INVALID'),
  );
  assert.deepEqual(
    Object.keys(projected).sort(),
    [
      'planTargetDigest',
      'planningGenerationId',
      'preview',
      'reviewNodeId',
      'reviewPolicyDigest',
      'reviewResultDigest',
      'subjectDigest',
    ].sort(),
  );

  const forgedGeneration = structuredClone(context.generation);
  forgedGeneration.planningGenerationId = 'f'.repeat(64);
  assert.throws(
    () =>
      projectPlanReviewTerms({
        validationInput: {
          ...validationInput,
          generation: forgedGeneration,
        },
        existingContributions: [],
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_TERM_PROJECTION_INVALID'),
  );
});

test('PlanReview output schema is code-owned and rejects generic semantic actions', () => {
  const context = reviewContext();
  const valid = challengeSubmission();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: valid,
  });
  assert.match(PLAN_REVIEW_OUTPUT_SCHEMA.digest, /^[0-9a-f]{64}$/);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.id, PLAN_REVIEW_OUTPUT_SCHEMA.id);
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.version,
    PLAN_REVIEW_OUTPUT_SCHEMA.version,
  );
  assert.notEqual(reviewNode.outputSchema, PLAN_REVIEW_OUTPUT_SCHEMA.id);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.validate(valid), true);
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate({
      ...valid,
      proposals: [{ action: 'create-issue', title: 'Bypass' }],
    }),
    false,
  );
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate({
      ...valid,
      verdict: 'advisory-approve',
      scopeAssessment: {
        kind: 'no-challenge',
        evidence: [
          {
            kind: 'repository-location',
            path: ' ',
            line: 1,
            observation: ' ',
          },
        ],
      },
      findings: [],
    }),
    false,
  );
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate({
      ...valid,
      proposedTerms: [{ kind: 'symbol', value: 'invalid\nterm' }],
    }),
    false,
  );
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate({
      ...valid,
      proposedTerms: Array.from({ length: 257 }, (_, index) => ({
        kind: 'symbol',
        value: `review-term-${index}`,
      })),
    }),
    false,
  );

  const requiredSuggestion = challengeSubmission();
  requiredSuggestion.findings[0] = {
    ...requiredSuggestion.findings[0]!,
    kind: 'suggestion',
    currentChangeImpact: 'required',
  };
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: requiredSuggestion,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

function planTargetInput(): PlanTargetInput {
  return {
    schemaVersion: 1,
    changeId: 'demo-change',
    schemaName: 'expense-app-v2',
    components: [
      {
        kind: 'structured-json',
        role: 'schema-metadata',
        path: 'openspec/changes/demo-change/.openspec.yaml',
        schemaDigest: DIGESTS.schema,
        value: { schema: 'expense-app-v2', created: '2026-07-15' },
      },
      {
        kind: 'authored-markdown',
        role: 'proposal',
        path: 'openspec/changes/demo-change/proposal.md',
        content: '# Proposal\n\nPreserve the behavior.\n',
      },
      {
        kind: 'mixed-markdown',
        role: 'design',
        path: 'openspec/changes/demo-change/design.md',
        authoredRegions: [
          '# Design\n\n',
          '\n## Decisions\n\nKeep invariants.\n',
        ],
        managedProjection: {
          renderer: 'investigation-ledger.v1',
          rendererDigest: DIGESTS.ledgerRenderer,
          sourceNodes: [
            { nodeId: DIGESTS.whyNode, resultDigest: DIGESTS.whyResult },
          ],
        },
      },
      {
        kind: 'authored-markdown',
        role: 'delta-spec',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        content:
          '### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **THEN** it works\n',
      },
      {
        kind: 'tasks-markdown',
        role: 'tasks',
        path: 'openspec/changes/demo-change/tasks.md',
        content: '# Tasks\n\n## Work\n\n- [ ] 1.1 Implement behavior\n',
      },
      {
        kind: 'structured-json',
        role: 'guard',
        path: 'openspec/changes/demo-change/guard.json',
        schemaDigest: DIGESTS.structured,
        value: {
          schemaVersion: 1,
          changeId: 'demo-change',
          tasks: {
            '1.1': {
              allowedPaths: ['src/**'],
              requiredChecks: ['fixture'],
            },
          },
        },
      },
      {
        kind: 'structured-json',
        role: 'execution',
        path: 'openspec/changes/demo-change/execution.json',
        schemaDigest: DIGESTS.structured,
        value: { schemaVersion: 1, kind: 'execution-artifact', tasks: {} },
      },
      {
        kind: 'structured-json',
        role: 'investigation',
        path: 'openspec/changes/demo-change/investigation.json',
        schemaDigest: DIGESTS.structured,
        value: {
          schemaVersion: 1,
          kind: 'investigation-artifact',
          currentRefs: { sealedInvestigation: DIGESTS.investigationNode },
        },
      },
      {
        kind: 'requirement-clause',
        role: 'requirement-clause',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        requirement: 'Demo',
        scenario: 'Works',
        content:
          '### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **THEN** it works\n',
      },
      {
        kind: 'policy',
        role: 'policy',
        path: 'workflow/review-policy',
        name: 'review-policy',
        version: 1,
        digest: DIGESTS.reviewPolicy,
      },
    ],
  };
}

function generationInput(target: PlanTarget) {
  return {
    schemaVersion: 1 as const,
    target,
    investigationBaseline: {
      head: '1'.repeat(40),
      tree: '2'.repeat(40),
    },
    investigationDependencies: [
      {
        role: 'sealed-investigation',
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
      },
      {
        role: 'why-ledger',
        nodeId: DIGESTS.whyNode,
        resultDigest: DIGESTS.whyResult,
      },
    ],
    policies: {
      planningPolicyDigest: DIGESTS.workflowPolicy,
      canonicalizerPolicyDigest: DIGESTS.canonicalizerPolicy,
      rendererPolicyDigest: DIGESTS.rendererPolicy,
      reviewPolicyDigest: DIGESTS.reviewPolicy,
    },
  };
}

function reviewContext(): {
  target: PlanTarget;
  generation: PlanningGeneration;
  subject: ReturnType<typeof createPlanReviewSubject>;
  assignment: RoleAssignment;
  providerResult: EvidenceNode;
} {
  const target = createPlanTarget(planTargetInput());
  const generation = createPlanningGeneration(generationInput(target));
  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'provider-independent',
  });
  const assignment: RoleAssignment = {
    role: 'plan-reviewer',
    providerId: 'claude',
    sessionId: 'review-session',
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'provider-independent',
  };
  const providerResult = createPlanReviewProviderResultNode({
    subject,
    assignment,
    submission: challengeSubmission(),
    providerPolicyDigest: DIGESTS.reviewPolicy,
  });
  return { target, generation, subject, assignment, providerResult };
}

function providerResultFor(
  context: ReturnType<typeof reviewContext>,
  submission: PlanReviewSubmission,
): EvidenceNode {
  return createPlanReviewProviderResultNode({
    subject: context.subject,
    assignment: context.assignment,
    submission,
    providerPolicyDigest: DIGESTS.reviewPolicy,
  });
}

function challengeSubmission(
  overrides: Partial<PlanReviewSubmission> = {},
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-reject',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'A load-bearing consumer may be missing.',
        evidence: [
          {
            kind: 'repository-location',
            path: 'src/consumer.ts',
            line: 12,
            observation: 'The consumer imports the changed contract.',
          },
        ],
      },
    ],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'No residual risk beyond the documented challenge.',
    uncertainty: 'No additional uncertainty identified.',
    ...overrides,
  };
}

function suggestion(summary: string) {
  return {
    kind: 'suggestion' as const,
    severity: 'low' as const,
    category: 'follow-up' as const,
    currentChangeImpact: 'independent-follow-up' as const,
    summary,
    evidence: [
      {
        kind: 'repository-location' as const,
        path: 'docs/ROADMAP.md',
        line: 1,
        observation: 'The follow-up belongs to later roadmap work.',
      },
    ],
  };
}

function currentValidation(
  context: ReturnType<typeof reviewContext>,
  reviewNode: EvidenceNode,
) {
  return validatePlanReview(currentValidationInput(context, reviewNode));
}

function currentValidationInput(
  context: Pick<
    ReturnType<typeof reviewContext>,
    'target' | 'generation' | 'subject'
  >,
  reviewNode: EvidenceNode,
) {
  const review = readPlanReviewNode(reviewNode);
  const challengeIds = review.findings
    .filter(({ kind }) => kind === 'challenge')
    .map(({ findingId }) => findingId);
  const dispositionNode =
    challengeIds.length === 0
      ? null
      : createPlanReviewDispositionNode({
          reviewNode,
          policyDigest: DIGESTS.reviewPolicy,
          dispositions: challengeIds.map((challengeId) => ({
            challengeId,
            decision: 'mitigated' as const,
            rationale: 'The planning subject now accounts for this finding.',
            author: 'main-agent',
          })),
        });
  return {
    reviewNode,
    dispositionNode,
    subject: context.subject,
    generation: context.generation,
    target: context.target,
    expectedReviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'provider-independent' as const,
    independenceAuthorization: {
      kind: 'ordinary-provider-independent' as const,
      planAuthorProviderId: 'codex' as const,
    },
    repositoryEvidence: repositoryEvidenceFor(
      reviewNode,
      context.subject.investigationBaseline.tree,
    ),
  };
}

function repositoryEvidenceFor(reviewNode: EvidenceNode, tree: string) {
  const review = readPlanReviewNode(reviewNode);
  const locations = [
    ...review.findings.flatMap(({ evidence }) => evidence),
    ...review.suggestions.flatMap(({ evidence }) => evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ]
    .filter(
      (
        evidence,
      ): evidence is Extract<
        (typeof review.findings)[number]['evidence'][number],
        { kind: 'repository-location' }
      > => evidence.kind === 'repository-location',
    )
    .reduce((entries, evidence) => {
      const current = entries.get(evidence.path);
      entries.set(evidence.path, Math.max(current ?? 0, evidence.line));
      return entries;
    }, new Map<string, number>());

  return {
    tree,
    locations: [...locations]
      .map(([path, lineCount]) => ({
        path,
        blobOid: 'c'.repeat(tree.length),
        lineCount,
      }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.path, 'utf8'),
          Buffer.from(right.path, 'utf8'),
        ),
      ),
  };
}

function authoredComponent(
  input: PlanTargetInput,
  role: 'proposal' | 'delta-spec',
) {
  return input.components.find(
    (component) =>
      component.kind === 'authored-markdown' && component.role === role,
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'authored-markdown' }
  >;
}

function mixedComponent(input: PlanTargetInput) {
  return input.components.find(
    (component) => component.kind === 'mixed-markdown',
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'mixed-markdown' }
  >;
}

function tasksComponent(input: PlanTargetInput) {
  return input.components.find(
    (component) => component.kind === 'tasks-markdown',
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'tasks-markdown' }
  >;
}

function structuredComponent(
  input: PlanTargetInput,
  role: 'schema-metadata' | 'guard' | 'execution' | 'investigation',
) {
  return input.components.find(
    (component) =>
      component.kind === 'structured-json' && component.role === role,
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'structured-json' }
  >;
}

function policyComponent(input: PlanTargetInput, name: string) {
  return input.components.find(
    (component) => component.kind === 'policy' && component.name === name,
  ) as Extract<PlanTargetInput['components'][number], { kind: 'policy' }>;
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

void (undefined as unknown as PlanReviewTermProjection);
