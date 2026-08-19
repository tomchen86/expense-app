import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlanningGenerationCurrentnessProof,
  createPreMergeCoverageEntry,
  createRequiredPreMergeCoverage,
  completePreMergeAssurance,
  parsePreMergeAssuranceNode,
  preparePreMergeAssurance,
  resolvePreMergeAssurance,
  type IntegrationDeltaReviewSubmission,
} from '../src/modules/assurance/pre-merge-assurance.ts';

const digest = (character: string): string => character.repeat(64);
const objectId = (character: string): string => character.repeat(40);

function coverageFixture() {
  const planning = createPreMergeCoverageEntry({
    category: 'planning',
    changeId: 'complete-t2-assurance-gaps',
    subjectDigest: digest('1'),
    paths: [
      'openspec/changes/complete-t2-assurance-gaps/design.md',
      'openspec/changes/complete-t2-assurance-gaps/tasks.md',
    ],
    contextDigests: [digest('2')],
  });
  const implementation = createPreMergeCoverageEntry({
    category: 'implementation',
    changeId: 'complete-t2-assurance-gaps',
    subjectDigest: digest('3'),
    paths: [
      'packages/workflow-engine/src/modules/assurance/pre-merge-assurance.ts',
    ],
    contextDigests: [digest('4'), digest('5')],
  });
  const baseContext = createPreMergeCoverageEntry({
    category: 'base-context',
    changeId: null,
    subjectDigest: digest('6'),
    paths: ['packages/workflow-engine/src/ci.ts'],
    contextDigests: [digest('7')],
  });
  return { planning, implementation, baseContext };
}

function currentnessProof() {
  return createPlanningGenerationCurrentnessProof({
    changeId: 'complete-t2-assurance-gaps',
    planningGenerationId: digest('8'),
    planCommit: objectId('a'),
    taskBindings: [
      {
        taskId: '1.1',
        taskCommit: objectId('b'),
        planningGenerationId: digest('8'),
      },
      {
        taskId: '1.2',
        taskCommit: objectId('c'),
        planningGenerationId: digest('8'),
      },
    ],
    supersedingPlanCommits: [],
    ancestorPairs: [
      { ancestor: objectId('a'), descendant: objectId('b') },
      { ancestor: objectId('a'), descendant: objectId('c') },
    ],
  });
}

test('pre-merge composes current plan and exact-diff coverage with zero provider calls', async () => {
  const { planning, implementation } = coverageFixture();
  const requiredCoverage = createRequiredPreMergeCoverage({
    baseCommit: objectId('d'),
    headCommit: objectId('e'),
    entries: [planning, implementation],
    integrationSubjectDigest: null,
  });
  let providerCalls = 0;
  const resolved = await resolvePreMergeAssurance({
    requiredCoverage,
    planningCurrentness: [currentnessProof()],
    existingCoverage: [
      {
        source: 'plan-review',
        nodeId: digest('9'),
        resultDigest: digest('a'),
        coveredEntryDigests: [planning.entryDigest],
      },
      {
        source: 'task-diff-review',
        nodeId: digest('b'),
        resultDigest: digest('c'),
        coveredEntryDigests: [implementation.entryDigest],
      },
    ],
    invokeIntegrationReview: async () => {
      providerCalls += 1;
      throw new Error('covered pre-merge assurance must not invoke a provider');
    },
  });

  assert.equal(providerCalls, 0);
  assert.deepEqual(resolved.uncoveredEntryDigests, []);
  assert.equal(resolved.integrationReview, null);
  assert.equal(parsePreMergeAssuranceNode(resolved).nodeId, resolved.nodeId);
});

test('pre-merge invokes one provider with only uncovered coverage and integration context', async () => {
  const { planning, implementation, baseContext } = coverageFixture();
  const integrationSubjectDigest = digest('d');
  const requiredCoverage = createRequiredPreMergeCoverage({
    baseCommit: objectId('d'),
    headCommit: objectId('e'),
    entries: [planning, implementation, baseContext],
    integrationSubjectDigest,
  });
  let providerCalls = 0;
  const resolved = await resolvePreMergeAssurance({
    requiredCoverage,
    planningCurrentness: [currentnessProof()],
    existingCoverage: [
      {
        source: 'plan-review',
        nodeId: digest('9'),
        resultDigest: digest('a'),
        coveredEntryDigests: [planning.entryDigest],
      },
      {
        source: 'task-diff-review',
        nodeId: digest('b'),
        resultDigest: digest('c'),
        coveredEntryDigests: [implementation.entryDigest],
      },
    ],
    invokeIntegrationReview: async (request) => {
      providerCalls += 1;
      assert.equal(
        request.requiredCoverageDigest,
        requiredCoverage.manifestDigest,
      );
      assert.deepEqual(request.uncoveredEntries, [baseContext]);
      assert.equal(request.integrationSubjectDigest, integrationSubjectDigest);
      return {
        schemaVersion: 1,
        kind: 'integration-delta-review-submission.v1',
        requiredCoverageDigest: request.requiredCoverageDigest,
        uncoveredEntryDigests: request.uncoveredEntries.map(
          ({ entryDigest }) => entryDigest,
        ),
        integrationSubjectDigest: request.integrationSubjectDigest,
        reviewer: {
          principalId: 'provider:claude',
          providerId: 'claude',
          achievedIndependence: 'provider-independent',
          degradedForm: null,
          grantUseDigest: null,
        },
        verdict: 'advisory-approve',
        challenges: [],
        residualRisk: 'Cross-task integration remains advisory.',
      } satisfies IntegrationDeltaReviewSubmission;
    },
  });

  assert.equal(providerCalls, 1);
  assert.deepEqual(resolved.uncoveredEntryDigests, [baseContext.entryDigest]);
  assert.equal(
    resolved.integrationReview?.integrationSubjectDigest,
    integrationSubjectDigest,
  );
});

test('pre-merge rejects stale planning generations and incomplete provider coverage', async () => {
  const { planning, implementation, baseContext } = coverageFixture();
  assert.throws(
    () =>
      createPlanningGenerationCurrentnessProof({
        changeId: 'complete-t2-assurance-gaps',
        planningGenerationId: digest('8'),
        planCommit: objectId('a'),
        taskBindings: [
          {
            taskId: '1.1',
            taskCommit: objectId('b'),
            planningGenerationId: digest('f'),
          },
        ],
        supersedingPlanCommits: [],
        ancestorPairs: [{ ancestor: objectId('a'), descendant: objectId('b') }],
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PRE_MERGE_PLANNING_GENERATION_STALE',
  );

  const requiredCoverage = createRequiredPreMergeCoverage({
    baseCommit: objectId('d'),
    headCommit: objectId('e'),
    entries: [planning, implementation, baseContext],
    integrationSubjectDigest: digest('d'),
  });
  await assert.rejects(
    resolvePreMergeAssurance({
      requiredCoverage,
      planningCurrentness: [currentnessProof()],
      existingCoverage: [
        {
          source: 'plan-review',
          nodeId: digest('9'),
          resultDigest: digest('a'),
          coveredEntryDigests: [planning.entryDigest],
        },
        {
          source: 'task-diff-review',
          nodeId: digest('b'),
          resultDigest: digest('c'),
          coveredEntryDigests: [implementation.entryDigest],
        },
      ],
      invokeIntegrationReview: async (request) => ({
        schemaVersion: 1,
        kind: 'integration-delta-review-submission.v1',
        requiredCoverageDigest: request.requiredCoverageDigest,
        uncoveredEntryDigests: [],
        integrationSubjectDigest: request.integrationSubjectDigest,
        reviewer: {
          principalId: 'provider:claude',
          providerId: 'claude',
          achievedIndependence: 'provider-independent',
          degradedForm: null,
          grantUseDigest: null,
        },
        verdict: 'advisory-approve',
        challenges: [],
        residualRisk: 'Incorrectly omitted uncovered bytes.',
      }),
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PRE_MERGE_REVIEW_COVERAGE_MISMATCH',
  );
});

test('pre-merge assurance is content-addressed and rejects tampered replay', async () => {
  const { planning, implementation } = coverageFixture();
  const resolved = await resolvePreMergeAssurance({
    requiredCoverage: createRequiredPreMergeCoverage({
      baseCommit: objectId('d'),
      headCommit: objectId('e'),
      entries: [planning, implementation],
      integrationSubjectDigest: null,
    }),
    planningCurrentness: [currentnessProof()],
    existingCoverage: [
      {
        source: 'plan-review',
        nodeId: digest('9'),
        resultDigest: digest('a'),
        coveredEntryDigests: [planning.entryDigest],
      },
      {
        source: 'task-diff-review',
        nodeId: digest('b'),
        resultDigest: digest('c'),
        coveredEntryDigests: [implementation.entryDigest],
      },
    ],
    invokeIntegrationReview: async () => {
      throw new Error('unexpected provider call');
    },
  });

  assert.throws(
    () =>
      parsePreMergeAssuranceNode({
        ...resolved,
        uncoveredEntryDigests: [planning.entryDigest],
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PRE_MERGE_ASSURANCE_INVALID',
  );
});

test('pre-merge coverage rejects cross-source claims and coerced paths', async () => {
  const { planning, implementation } = coverageFixture();
  const requiredCoverage = createRequiredPreMergeCoverage({
    baseCommit: objectId('d'),
    headCommit: objectId('e'),
    entries: [planning, implementation],
    integrationSubjectDigest: null,
  });

  await assert.rejects(
    resolvePreMergeAssurance({
      requiredCoverage,
      planningCurrentness: [currentnessProof()],
      existingCoverage: [
        {
          source: 'plan-review',
          nodeId: digest('9'),
          resultDigest: digest('a'),
          coveredEntryDigests: [
            planning.entryDigest,
            implementation.entryDigest,
          ],
        },
      ],
      invokeIntegrationReview: async () => {
        throw new Error('invalid reused coverage must fail before invocation');
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PRE_MERGE_ASSURANCE_INVALID',
  );

  assert.throws(
    () =>
      createPreMergeCoverageEntry({
        category: 'planning',
        changeId: 'complete-t2-assurance-gaps',
        subjectDigest: digest('1'),
        paths: [42 as unknown as string],
        contextDigests: [digest('2')],
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PRE_MERGE_ASSURANCE_INVALID',
  );
});

test('pre-merge preparation exposes one exact resumable review request', () => {
  const { planning, implementation, baseContext } = coverageFixture();
  const requiredCoverage = createRequiredPreMergeCoverage({
    baseCommit: objectId('d'),
    headCommit: objectId('e'),
    entries: [planning, implementation, baseContext],
    integrationSubjectDigest: digest('d'),
  });
  const prepared = preparePreMergeAssurance({
    requiredCoverage,
    planningCurrentness: [currentnessProof()],
    existingCoverage: [
      {
        source: 'plan-review',
        nodeId: digest('9'),
        resultDigest: digest('a'),
        coveredEntryDigests: [planning.entryDigest],
      },
      {
        source: 'task-diff-review',
        nodeId: digest('b'),
        resultDigest: digest('c'),
        coveredEntryDigests: [implementation.entryDigest],
      },
    ],
  });

  assert.deepEqual(prepared.reviewRequest, {
    baseCommit: objectId('d'),
    headCommit: objectId('e'),
    requiredCoverageDigest: requiredCoverage.manifestDigest,
    uncoveredEntries: [baseContext],
    integrationSubjectDigest: digest('d'),
    reusedCoverageReferences: prepared.existingCoverage,
  });
  assert.throws(
    () => completePreMergeAssurance(prepared, null),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PRE_MERGE_INTEGRATION_REVIEW_REQUIRED',
  );
});
