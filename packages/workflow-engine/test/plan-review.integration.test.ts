import assert from 'node:assert/strict';
import test from 'node:test';

import { projectPlanReviewTerms } from '../src/investigation-term-projection.ts';
import {
  createPlanReviewDispositionNode,
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewSubject,
  PLAN_REVIEW_COVERAGE,
  readPlanReviewNode,
} from '../src/plan-review.ts';
import { validatePlanReview } from '../src/plan-review-validation.ts';
import { createPlanTarget, type PlanTargetInput } from '../src/plan-target.ts';
import { createPlanningGeneration } from '../src/planning-generation.ts';

test('exact PlanReview composes target, generation, challenge, terms, and advisory eligibility', () => {
  const targetInput = integrationTargetInput();
  const target = createPlanTarget(targetInput);
  const generation = createPlanningGeneration({
    schemaVersion: 1,
    target,
    investigationBaseline: {
      head: '1'.repeat(64),
      tree: '2'.repeat(64),
    },
    investigationDependencies: [
      {
        role: 'sealed-investigation',
        nodeId: '3'.repeat(64),
        resultDigest: '4'.repeat(64),
      },
      {
        role: 'why-ledger',
        nodeId: '5'.repeat(64),
        resultDigest: '6'.repeat(64),
      },
    ],
    policies: {
      planningPolicyDigest: '7'.repeat(64),
      canonicalizerPolicyDigest: '8'.repeat(64),
      rendererPolicyDigest: '9'.repeat(64),
      reviewPolicyDigest: 'a'.repeat(64),
    },
  });
  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest: 'a'.repeat(64),
    requiredIndependence: 'provider-independent',
  });
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: 'review-session',
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const submission = {
    schemaVersion: 2 as const,
    verdict: 'advisory-reject' as const,
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' as const },
    findings: [
      {
        kind: 'challenge' as const,
        severity: 'high' as const,
        category: 'missing-scope',
        currentChangeImpact: 'required' as const,
        summary: 'Explain the preserved authorization invariant.',
        evidence: [
          {
            kind: 'investigation-node' as const,
            nodeId: '5'.repeat(64),
            resultDigest: '6'.repeat(64),
          },
        ],
      },
    ],
    proposedTerms: [
      { kind: 'symbol' as const, value: 'AuthorizationInvariant' },
    ],
    suggestions: [
      {
        kind: 'suggestion' as const,
        severity: 'low' as const,
        category: 'follow-up',
        currentChangeImpact: 'independent-follow-up' as const,
        summary: 'Add a visualization in a later change.',
        evidence: [
          {
            kind: 'repository-location' as const,
            path: 'docs/ROADMAP.md',
            line: 10,
            observation: 'The roadmap already owns visualization work.',
          },
        ],
      },
    ],
    residualRisk: 'The authorization explanation remains the only known risk.',
    uncertainty: 'No additional uncertainty identified.',
  };
  const providerResultNode = createPlanReviewProviderResultNode({
    subject,
    assignment,
    submission,
    providerPolicyDigest: 'a'.repeat(64),
  });
  const reviewNode = createPlanReviewNode({
    subject,
    assignment,
    providerResultNode,
    submission,
  });
  const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: 'a'.repeat(64),
    dispositions: [
      {
        challengeId,
        decision: 'mitigated',
        rationale: 'The exact planning subject now explains the invariant.',
        author: 'main-agent',
      },
    ],
  });
  const validation = validatePlanReview({
    reviewNode,
    dispositionNode,
    subject,
    generation,
    target,
    expectedReviewPolicyDigest: 'a'.repeat(64),
    requiredIndependence: 'provider-independent',
    independenceAuthorization: {
      kind: 'ordinary-provider-independent',
      planAuthorProviderId: 'codex',
    },
    repositoryEvidence: {
      tree: subject.investigationBaseline.tree,
      locations: [
        {
          path: 'docs/ROADMAP.md',
          blobOid: 'b'.repeat(64),
          lineCount: 10,
        },
      ],
    },
  });

  assert.equal(validation.current, true);
  assert.equal(validation.eligible, true);
  assert.equal(validation.advisoryVerdict, 'advisory-reject');
  assert.deepEqual(
    validation.intakeCandidates.map(({ summary }) => summary),
    ['Add a visualization in a later change.'],
  );

  const projection = projectPlanReviewTerms({
    validationInput: {
      reviewNode,
      dispositionNode,
      subject,
      generation,
      target,
      expectedReviewPolicyDigest: 'a'.repeat(64),
      requiredIndependence: 'provider-independent',
      independenceAuthorization: {
        kind: 'ordinary-provider-independent',
        planAuthorProviderId: 'codex',
      },
      repositoryEvidence: {
        tree: subject.investigationBaseline.tree,
        locations: [
          {
            path: 'docs/ROADMAP.md',
            blobOid: 'b'.repeat(64),
            lineCount: 10,
          },
        ],
      },
    },
    existingContributions: [
      {
        source: 'engine',
        reference: 'engine-floor',
        terms: [{ kind: 'literal-path', value: 'src/authorization.ts' }],
      },
    ],
  });
  assert.equal(projection.preview.outcome, 'ready');
  assert.deepEqual(projection.preview.terms.map(({ value }) => value).sort(), [
    'AuthorizationInvariant',
    'src/authorization.ts',
  ]);

  const implementationDescendant = structuredClone(validation);
  assert.equal(
    implementationDescendant.planningGenerationId,
    generation.planningGenerationId,
  );
  assert.equal(implementationDescendant.eligible, true);
});

test('PlanReview stales on governing inputs but not checkbox projection or JSON key order', () => {
  const unchecked = integrationTargetInput();
  const checked = integrationTargetInput();
  const task = checked.components.find(
    (component) => component.kind === 'tasks-markdown',
  );
  if (!task || task.kind !== 'tasks-markdown') {
    throw new Error('tasks fixture missing');
  }
  task.content = task.content.replace('- [ ] 1.1', '- [x] 1.1');
  const guard = checked.components.find(
    (component) =>
      component.kind === 'structured-json' && component.role === 'guard',
  );
  if (!guard || guard.kind !== 'structured-json') {
    throw new Error('guard fixture missing');
  }
  guard.value = {
    tasks: { '1.1': { requiredChecks: ['fixture'], allowedPaths: ['src/**'] } },
    changeId: 'demo-change',
    schemaVersion: 1,
  };
  assert.equal(
    createPlanTarget(unchecked).targetDigest,
    createPlanTarget(checked).targetDigest,
  );

  const changed = integrationTargetInput();
  const proposal = changed.components.find(
    (component) =>
      component.kind === 'authored-markdown' && component.role === 'proposal',
  );
  if (!proposal || proposal.kind !== 'authored-markdown') {
    throw new Error('proposal fixture missing');
  }
  proposal.content = proposal.content.replace('Preserve', 'Remove');
  assert.notEqual(
    createPlanTarget(unchecked).targetDigest,
    createPlanTarget(changed).targetDigest,
  );
});

function integrationTargetInput(): PlanTargetInput {
  return {
    schemaVersion: 1,
    changeId: 'demo-change',
    schemaName: 'expense-app-v2',
    components: [
      {
        kind: 'structured-json',
        role: 'schema-metadata',
        path: 'openspec/changes/demo-change/.openspec.yaml',
        schemaDigest: '1'.repeat(64),
        value: { schema: 'expense-app-v2' },
      },
      {
        kind: 'authored-markdown',
        role: 'proposal',
        path: 'openspec/changes/demo-change/proposal.md',
        content: '# Proposal\n\nPreserve authorization.\n',
      },
      {
        kind: 'mixed-markdown',
        role: 'design',
        path: 'openspec/changes/demo-change/design.md',
        authoredRegions: ['# Design\n\n', '\n## Decision\n\nKeep the gate.\n'],
        managedProjection: {
          renderer: 'investigation-ledger.v1',
          rendererDigest: '2'.repeat(64),
          sourceNodes: [
            { nodeId: '5'.repeat(64), resultDigest: '6'.repeat(64) },
          ],
        },
      },
      {
        kind: 'authored-markdown',
        role: 'delta-spec',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        content:
          '### Requirement: Authorization\n\nThe system SHALL preserve authorization.\n\n#### Scenario: Authorized\n\n- **THEN** access is allowed\n',
      },
      {
        kind: 'tasks-markdown',
        role: 'tasks',
        path: 'openspec/changes/demo-change/tasks.md',
        content: '# Tasks\n\n## Work\n\n- [ ] 1.1 Preserve authorization\n',
      },
      {
        kind: 'structured-json',
        role: 'guard',
        path: 'openspec/changes/demo-change/guard.json',
        schemaDigest: '3'.repeat(64),
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
        schemaDigest: '3'.repeat(64),
        value: { schemaVersion: 1, kind: 'execution-artifact', tasks: {} },
      },
      {
        kind: 'structured-json',
        role: 'investigation',
        path: 'openspec/changes/demo-change/investigation.json',
        schemaDigest: '3'.repeat(64),
        value: {
          schemaVersion: 1,
          kind: 'investigation-artifact',
          currentRefs: { sealedInvestigation: '3'.repeat(64) },
        },
      },
      {
        kind: 'requirement-clause',
        role: 'requirement-clause',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        requirement: 'Authorization',
        scenario: 'Authorized',
        content:
          '### Requirement: Authorization\n\nThe system SHALL preserve authorization.\n\n#### Scenario: Authorized\n\n- **THEN** access is allowed\n',
      },
      {
        kind: 'policy',
        role: 'policy',
        path: 'workflow/review-policy',
        name: 'review-policy',
        version: 1,
        digest: 'a'.repeat(64),
      },
    ],
  };
}
