import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { validateClosedEvidenceDag } from '../src/adapters/compatibility/investigation-v2/evidence-currentness.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationGroups,
  readInvestigationCoverageNode,
  readInvestigationDispositionNode,
  readInvestigationGroupNode,
  readInvestigationHitNode,
  validateInvestigationEvidenceDag,
  type DeclaredInvestigationRoot,
  type InvestigationDispositionInput,
  type InvestigationGroupException,
  type ReviewedPathRelationship,
} from '../src/modules/investigation/domain/investigation-groups.ts';
import {
  MUTATION_CLASSES,
  classifyMutationPath,
  createMutationClassPolicy,
  type MutationClassPolicy,
} from '../src/modules/source/mutation-class-policy.ts';

const POLICY_DIGEST = '1'.repeat(64);
const TREE_DIGEST = '2'.repeat(64);
const TERM_A = 'a'.repeat(64);
const TERM_B = 'b'.repeat(64);
const TERM_ZERO = 'c'.repeat(64);

test('mutation classes are explicit, raw-path-safe grouping metadata and never a scan filter', () => {
  const policy = mutationPolicy();
  const reorderedPolicy = createMutationClassPolicy({
    rules: [...policy.rules].reverse(),
  });
  assert.equal(reorderedPolicy.policyDigest, policy.policyDigest);
  assert.deepEqual(reorderedPolicy.rules, policy.rules);

  const cases = [
    ['src/a.ts', 'live'],
    ['blocked/file.ts', 'prohibited'],
    ['generated/file.ts', 'generated'],
    ['mirror/file.ts', 'mirror'],
    ['CHANGELOG.md', 'append-only'],
    ['archive/file.md', 'immutable'],
    ['history/file.md', 'historical-reference'],
  ] as const;

  assert.deepEqual(MUTATION_CLASSES, [
    'live',
    'prohibited',
    'generated',
    'mirror',
    'append-only',
    'immutable',
    'historical-reference',
  ]);
  for (const [filePath, expected] of cases) {
    const classified = classifyMutationPath(policy, pathIdentity(filePath));
    assert.equal(classified.mutationClass, expected);
    assert.equal(classified.policyDigest, policy.policyDigest);
  }

  const invalidRaw = Buffer.concat([
    Buffer.from('blocked/'),
    Buffer.from([0xff]),
    Buffer.from('/secret.ts'),
  ]);
  const rawPolicy = createMutationClassPolicy({
    rules: [
      ...policy.rules,
      {
        ruleId: 'raw-prohibited',
        mutationClass: 'prohibited',
        selector: {
          kind: 'raw-prefix',
          rawBase64: Buffer.concat([
            Buffer.from('blocked/'),
            Buffer.from([0xff]),
          ]).toString('base64'),
        },
      },
    ],
  });
  assert.equal(
    classifyMutationPath(rawPolicy, {
      rawBase64: invalidRaw.toString('base64'),
      utf8: null,
    }).mutationClass,
    'prohibited',
  );

  const ambiguous = createMutationClassPolicy({
    rules: [
      ...policy.rules,
      {
        ruleId: 'overlapping-generated',
        mutationClass: 'generated',
        selector: { kind: 'path-prefix', path: 'blocked' },
      },
    ],
  });
  assert.throws(
    () => classifyMutationPath(ambiguous, pathIdentity('blocked/file.ts')),
    (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
  );

  assert.throws(
    () =>
      classifyMutationPath(
        {
          policyDigest: policy.policyDigest,
          rules: policy.rules.map((rule) =>
            rule.ruleId === 'generated'
              ? { ...rule, mutationClass: 'prohibited' }
              : rule,
          ),
        },
        pathIdentity('generated/file.ts'),
      ),
    (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
  );

  for (const invalidPath of [
    { rawBase64: '', utf8: '' },
    { rawBase64: 'not-canonical-base64', utf8: null },
    {
      rawBase64: Buffer.from('src/a.ts', 'utf8').toString('base64'),
      utf8: 'src/spoofed.ts',
    },
    {
      rawBase64: Buffer.from('src/a.ts', 'utf8').toString('base64'),
      utf8: null,
    },
  ]) {
    assert.throws(
      () => classifyMutationPath(policy, invalidPath),
      (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
    );
  }

  for (const selector of [
    { kind: 'raw-prefix', rawBase64: '' },
    { kind: 'raw-prefix', rawBase64: 'not-canonical-base64' },
  ]) {
    assert.throws(
      () =>
        createMutationClassPolicy({
          rules: [
            {
              ruleId: 'invalid-raw-selector',
              mutationClass: 'prohibited',
              selector,
            },
          ] as Parameters<typeof createMutationClassPolicy>[0]['rules'],
        }),
      (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
    );
  }

  assert.throws(
    () =>
      createMutationClassPolicy({
        rules: policy.rules,
        hidden: true,
      } as Parameters<typeof createMutationClassPolicy>[0]),
    (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
  );
  assert.throws(
    () =>
      classifyMutationPath(
        { ...policy, hidden: true } as MutationClassPolicy,
        pathIdentity('src/a.ts'),
      ),
    (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
  );
});

test('grouping creates stable per-term hit identities and conservative selector groups', () => {
  const context = groupingContext();
  const scanA = scanNode(TERM_A, [
    hit('src/a.ts', 0),
    hit('src/b.ts', 1),
    hit('src/c.ts', 2),
    hit('blocked/file.ts', 3),
    hit('generated/file.ts', 4),
    hit('mirror/file.ts', 5),
    hit('CHANGELOG.md', 6),
    hit('archive/file.md', 7),
    hit('history/file.md', 8),
  ]);
  const scanB = scanNode(TERM_B, [hit('src/a.ts', 0)]);

  const grouped = deriveInvestigationGroups({
    scanNodes: [scanA, scanB],
    ...context,
    exceptions: [],
  });
  assert.equal(grouped.hitNodes.length, 10);
  assert.equal(
    new Set(
      grouped.hitNodes.map((node) => readInvestigationHitNode(node).hitId),
    ).size,
    10,
  );
  const sameOccurrence = grouped.hitNodes
    .map(readInvestigationHitNode)
    .filter((candidate) => candidate.path.utf8 === 'src/a.ts');
  assert.equal(sameOccurrence.length, 2);
  assert.notEqual(sameOccurrence[0]?.hitId, sameOccurrence[1]?.hitId);

  assert.deepEqual(
    [
      ...new Set(
        grouped.groupNodes.map(
          (node) => readInvestigationGroupNode(node).selector.mutationClass,
        ),
      ),
    ].sort(),
    [...MUTATION_CLASSES].sort(),
  );
  const sharedLiveGroup = grouped.groupNodes
    .map(readInvestigationGroupNode)
    .find((group) => {
      const paths = group.hits.map((entry) => entry.path.utf8).sort();
      return canonicalJson(paths) === canonicalJson(['src/b.ts', 'src/c.ts']);
    });
  assert.ok(sharedLiveGroup);
  assert.equal(sharedLiveGroup.selector.rootId, 'source');
  assert.equal(sharedLiveGroup.selector.extension.utf8, '.ts');
  assert.equal(sharedLiveGroup.selector.relationshipId, null);

  const shuffled = deriveInvestigationGroups({
    scanNodes: [scanB, scanA],
    mutationPolicy: context.mutationPolicy,
    declaredRoots: [...context.declaredRoots].reverse(),
    reviewedRelationships: [...context.reviewedRelationships].reverse(),
    exceptions: [],
  });
  assert.deepEqual(
    shuffled.hitNodes.map(({ nodeId }) => nodeId),
    grouped.hitNodes.map(({ nodeId }) => nodeId),
  );
  assert.deepEqual(
    shuffled.groupNodes.map(({ nodeId }) => nodeId),
    grouped.groupNodes.map(({ nodeId }) => nodeId),
  );

  assert.throws(
    () =>
      deriveInvestigationGroups({
        scanNodes: [scanA],
        ...context,
        declaredRoots: [
          ...context.declaredRoots,
          { rootId: 'duplicate-source', path: 'src' },
        ],
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  assert.throws(
    () =>
      deriveInvestigationGroups({
        scanNodes: [scanA],
        ...context,
        reviewedRelationships: [
          ...context.reviewedRelationships,
          {
            relationshipId: 'ambiguous-mirror',
            kind: 'mirror',
            subjectPath: pathIdentity('src/b.ts'),
            counterpartPath: pathIdentity('mirror/file.ts'),
            reference: 'review:ambiguous',
          },
        ],
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  for (const reviewedRelationships of [
    [
      {
        ...context.reviewedRelationships[0]!,
        kind: 'inferred',
      },
    ],
    [
      {
        ...context.reviewedRelationships[0]!,
        reference: '   ',
      },
    ],
    [
      context.reviewedRelationships[0]!,
      {
        relationshipId: 'generated-chain',
        kind: 'generated',
        subjectPath: pathIdentity('generated/file.ts'),
        counterpartPath: pathIdentity('generated/second.ts'),
        reference: 'review:generated-chain',
      },
    ],
  ]) {
    assert.throws(
      () =>
        deriveInvestigationGroups({
          scanNodes: [scanA],
          mutationPolicy: context.mutationPolicy,
          declaredRoots: context.declaredRoots,
          reviewedRelationships,
          exceptions: [],
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
    );
  }

  assert.throws(
    () =>
      deriveInvestigationGroups({
        scanNodes: [scanA],
        mutationPolicy: context.mutationPolicy,
        declaredRoots: context.declaredRoots,
        reviewedRelationships: [
          {
            ...context.reviewedRelationships[0]!,
            subjectPath: {
              ...context.reviewedRelationships[0]!.subjectPath,
              utf8: 'src/spoofed.ts',
            },
          },
        ],
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const relationshipCollisionA = deriveInvestigationGroups({
    scanNodes: [scanNode(TERM_A, [hit('src/a.ts', 0)])],
    mutationPolicy: context.mutationPolicy,
    declaredRoots: context.declaredRoots,
    reviewedRelationships: [
      reviewedRelationship('a+b', 'src/a.ts', 'generated/one.ts'),
      reviewedRelationship('c', 'src/a.ts', 'generated/two.ts'),
    ],
    exceptions: [],
  });
  const relationshipCollisionB = deriveInvestigationGroups({
    scanNodes: [scanNode(TERM_A, [hit('src/a.ts', 0)])],
    mutationPolicy: context.mutationPolicy,
    declaredRoots: context.declaredRoots,
    reviewedRelationships: [
      reviewedRelationship('a', 'src/a.ts', 'generated/one.ts'),
      reviewedRelationship('b+c', 'src/a.ts', 'generated/two.ts'),
    ],
    exceptions: [],
  });
  assert.notEqual(
    readInvestigationGroupNode(relationshipCollisionA.groupNodes[0]!).selector
      .relationshipId,
    readInvestigationGroupNode(relationshipCollisionB.groupNodes[0]!).selector
      .relationshipId,
  );

  assert.throws(
    () =>
      deriveInvestigationGroups({
        scanNodes: [scanNode(TERM_ZERO, [])],
        mutationPolicy: {
          policyDigest: context.mutationPolicy.policyDigest,
          rules: context.mutationPolicy.rules.map((rule) =>
            rule.ruleId === 'generated'
              ? { ...rule, mutationClass: 'prohibited' }
              : rule,
          ),
        },
        declaredRoots: context.declaredRoots,
        reviewedRelationships: [],
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
});

test('explicit exceptions split one current hit without dropping or overlapping coverage', () => {
  const context = groupingContext();
  const scan = scanNode(TERM_A, [
    hit('src/b.ts', 1),
    hit('src/c.ts', 2),
    hit('src/d.ts', 3),
  ]);
  const base = deriveInvestigationGroups({
    scanNodes: [scan],
    ...context,
    exceptions: [],
  });
  assert.equal(base.groupNodes.length, 1);
  const baseGroup = readInvestigationGroupNode(base.groupNodes[0]!);
  const splitHit = baseGroup.hits.find(
    (candidate) => candidate.path.utf8 === 'src/c.ts',
  )!;
  const exception: InvestigationGroupException = {
    exceptionId: 'split-src-c',
    hitId: splitHit.hitId,
    baseSelectorId: baseGroup.selector.selectorId,
    splitId: 'separate-load-bearing-file',
    rationale: 'This consumer guards a distinct invariant.',
    author: 'codex',
  };

  const split = deriveInvestigationGroups({
    scanNodes: [scan],
    ...context,
    exceptions: [exception],
  });
  assert.equal(split.groupNodes.length, 2);
  assert.deepEqual(
    split.groupNodes
      .flatMap((node) => readInvestigationGroupNode(node).hitIds)
      .sort(),
    baseGroup.hitIds,
  );
  const exceptionGroup = split.groupNodes
    .map(readInvestigationGroupNode)
    .find((group) => group.selector.splitId === exception.splitId);
  assert.deepEqual(exceptionGroup?.exceptions, [exception]);
  assert.deepEqual(exceptionGroup?.hitIds, [splitHit.hitId]);

  const revisedExceptionSplit = deriveInvestigationGroups({
    scanNodes: [scan],
    ...context,
    exceptions: [
      {
        ...exception,
        rationale: 'This consumer guards a separately reviewed invariant.',
      },
    ],
  });
  const splitNode = split.groupNodes.find(
    (node) =>
      readInvestigationGroupNode(node).selector.splitId === exception.splitId,
  )!;
  const revisedSplitNode = revisedExceptionSplit.groupNodes.find(
    (node) =>
      readInvestigationGroupNode(node).selector.splitId === exception.splitId,
  )!;
  const unaffectedBaseNode = split.groupNodes.find(
    (node) => readInvestigationGroupNode(node).selector.splitId === null,
  )!;
  const revisedBaseNode = revisedExceptionSplit.groupNodes.find(
    (node) => readInvestigationGroupNode(node).selector.splitId === null,
  )!;
  assert.notEqual(revisedSplitNode.nodeId, splitNode.nodeId);
  assert.equal(revisedBaseNode.nodeId, unaffectedBaseNode.nodeId);

  const secondSplitHit = baseGroup.hits.find(
    (candidate) => candidate.path.utf8 === 'src/d.ts',
  )!;
  const secondException: InvestigationGroupException = {
    exceptionId: 'split-src-d',
    hitId: secondSplitHit.hitId,
    baseSelectorId: baseGroup.selector.selectorId,
    splitId: exception.splitId,
    rationale: 'This consumer belongs to the same reviewed split.',
    author: 'codex',
  };
  const splitPair = deriveInvestigationGroups({
    scanNodes: [scan],
    ...context,
    exceptions: [exception, secondException],
  });
  const reversedSplitPair = deriveInvestigationGroups({
    scanNodes: [scan],
    ...context,
    exceptions: [secondException, exception],
  });
  assert.deepEqual(
    reversedSplitPair.groupNodes.map(({ nodeId, resultDigest }) => ({
      nodeId,
      resultDigest,
    })),
    splitPair.groupNodes.map(({ nodeId, resultDigest }) => ({
      nodeId,
      resultDigest,
    })),
  );

  for (const exceptions of [
    [exception, { ...exception, exceptionId: 'duplicate-hit' }],
    [{ ...exception, hitId: 'f'.repeat(64) }],
    [{ ...exception, baseSelectorId: 'e'.repeat(64) }],
    [{ ...exception, splitId: '' }],
    [{ ...exception, rationale: '   ' }],
    [{ ...exception, author: '' }],
  ]) {
    assert.throws(
      () =>
        deriveInvestigationGroups({
          scanNodes: [scan],
          ...context,
          exceptions,
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
    );
  }
});

test('dispositions cover every current hit exactly once and bind selector, blobs, and exceptions', () => {
  const context = groupingContext();
  const scan = scanNode(TERM_A, [
    hit('src/a.ts', 0),
    hit('generated/file.ts', 1),
    hit('mirror/file.ts', 2),
  ]);
  const zero = scanNode(TERM_ZERO, []);
  const grouped = deriveInvestigationGroups({
    scanNodes: [scan, zero],
    ...context,
    exceptions: [],
  });
  const answers = dispositionAnswers(grouped.groupNodes);
  const dispositions = createInvestigationDispositionNodes({
    groupNodes: grouped.groupNodes,
    dispositions: answers,
  });
  assert.equal(dispositions.length, grouped.groupNodes.length);
  for (const node of dispositions) {
    const disposition = readInvestigationDispositionNode(node);
    const group = readInvestigationGroupNode(
      grouped.groupNodes.find(
        (candidate) =>
          readInvestigationGroupNode(candidate).groupId === disposition.groupId,
      )!,
    );
    assert.deepEqual(disposition.coveredHitIds, group.hitIds);
    assert.deepEqual(disposition.sourceObjects, group.sourceObjects);
    assert.deepEqual(disposition.selectorEvidence, group.selector);
    assert.deepEqual(disposition.exceptions, group.exceptions);
    assert.ok(disposition.rationale.length > 0);
  }

  const inventory = inventoryNode();
  const coverage = createInvestigationCoverageNode({
    effectiveTermIds: [TERM_A, TERM_ZERO],
    scanNodes: [scan, zero],
    inventoryNode: inventory,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes: dispositions,
  });
  const coverageOutput = readInvestigationCoverageNode(coverage);
  assert.deepEqual(coverageOutput.zeroHitTermIds, [TERM_ZERO]);
  assert.equal(coverageOutput.hitIds.length, grouped.hitNodes.length);
  assert.equal(coverageOutput.dispositionNodeIds.length, dispositions.length);

  const validation = validateInvestigationEvidenceDag({
    effectiveTermIds: [TERM_A, TERM_ZERO],
    scanNodes: [scan, zero],
    inventoryNode: inventory,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes: dispositions,
    coverageNode: coverage,
    ...context,
    exceptions: [],
  });
  assert.deepEqual(validation, {
    valid: true,
    scanCount: 2,
    zeroHitTermIds: [TERM_ZERO],
    hitCount: grouped.hitNodes.length,
    groupCount: grouped.groupNodes.length,
    dispositionCount: dispositions.length,
  });

  const reorderedCoverage = createInvestigationCoverageNode({
    effectiveTermIds: [TERM_ZERO, TERM_A],
    scanNodes: [zero, scan],
    inventoryNode: inventory,
    hitNodes: [...grouped.hitNodes].reverse(),
    groupNodes: [...grouped.groupNodes].reverse(),
    dispositionNodes: [...dispositions].reverse(),
  });
  assert.equal(reorderedCoverage.nodeId, coverage.nodeId);
  assert.equal(reorderedCoverage.resultDigest, coverage.resultDigest);

  const dispositionToForge = dispositions[0]!;
  const forgedDisposition = createEvidenceNode({
    ...nodeInput(dispositionToForge),
    output: {
      ...readInvestigationDispositionNode(dispositionToForge),
      coveredHitIds: [],
      sourceObjects: [],
    },
  });
  const forgedDispositions = dispositions.map((node) =>
    node.nodeId === dispositionToForge.nodeId ? forgedDisposition : node,
  );
  const forgedCoverage = createInvestigationCoverageNode({
    effectiveTermIds: [TERM_A, TERM_ZERO],
    scanNodes: [scan, zero],
    inventoryNode: inventory,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes: forgedDispositions,
  });
  assert.throws(
    () =>
      validateInvestigationEvidenceDag({
        effectiveTermIds: [TERM_A, TERM_ZERO],
        scanNodes: [scan, zero],
        inventoryNode: inventory,
        hitNodes: grouped.hitNodes,
        groupNodes: grouped.groupNodes,
        dispositionNodes: forgedDispositions,
        coverageNode: forgedCoverage,
        ...context,
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_EVIDENCE_DAG_INVALID'),
  );

  const forgedDispositionInput = createEvidenceNode({
    ...nodeInput(dispositionToForge),
    exactInputDigests: { forged: 'f'.repeat(64) },
    output: dispositionToForge.output,
  });
  const forgedInputDispositions = dispositions.map((node) =>
    node.nodeId === dispositionToForge.nodeId ? forgedDispositionInput : node,
  );
  assert.throws(
    () =>
      createInvestigationCoverageNode({
        effectiveTermIds: [TERM_A, TERM_ZERO],
        scanNodes: [scan, zero],
        inventoryNode: inventory,
        hitNodes: grouped.hitNodes,
        groupNodes: grouped.groupNodes,
        dispositionNodes: forgedInputDispositions,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_COVERAGE_INVALID'),
  );

  const forgedDispositionAnswerDigest = createEvidenceNode({
    ...nodeInput(dispositionToForge),
    exactInputDigests: { answer: 'f'.repeat(64) },
    output: dispositionToForge.output,
  });
  assert.throws(
    () => readInvestigationDispositionNode(forgedDispositionAnswerDigest),
    (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
  );

  assert.throws(
    () =>
      createInvestigationDispositionNodes({
        groupNodes: [grouped.groupNodes[0]!, grouped.groupNodes[0]!],
        dispositions: [answers[0]!],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
  );

  for (const badAnswers of [
    answers.slice(1),
    [...answers, answers[0]!],
    [{ ...answers[0]!, groupId: 'f'.repeat(64) }, ...answers.slice(1)],
    [
      { ...answers[0]!, classification: 'directory-inferred' },
      ...answers.slice(1),
    ],
    [{ ...answers[0]!, rationale: '   ' }, ...answers.slice(1)],
  ]) {
    assert.throws(
      () =>
        createInvestigationDispositionNodes({
          groupNodes: grouped.groupNodes,
          dispositions: badAnswers as InvestigationDispositionInput[],
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
    );
  }

  assert.throws(
    () =>
      createInvestigationCoverageNode({
        effectiveTermIds: [TERM_A, TERM_ZERO],
        scanNodes: [scan],
        inventoryNode: inventory,
        hitNodes: grouped.hitNodes,
        groupNodes: grouped.groupNodes,
        dispositionNodes: dispositions,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_COVERAGE_INVALID'),
  );

  assert.throws(
    () =>
      createInvestigationCoverageNode({
        effectiveTermIds: [TERM_A, TERM_ZERO],
        scanNodes: [scan, zero],
        inventoryNode: inventoryNode('3'.repeat(64)),
        hitNodes: grouped.hitNodes,
        groupNodes: grouped.groupNodes,
        dispositionNodes: dispositions,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_COVERAGE_INVALID'),
  );

  assert.throws(
    () => readInvestigationHitNode(grouped.groupNodes[0]!),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  assert.throws(
    () => readInvestigationGroupNode(scan),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  assert.throws(
    () => readInvestigationDispositionNode(grouped.groupNodes[0]!),
    (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
  );
  assert.throws(
    () => readInvestigationCoverageNode(grouped.groupNodes[0]!),
    (error) => isWorkflowError(error, 'INVESTIGATION_COVERAGE_INVALID'),
  );

  const malformedGroupOutput = createEvidenceNode({
    ...nodeInput(grouped.groupNodes[0]!),
    output: {
      ...readInvestigationGroupNode(grouped.groupNodes[0]!),
      hitIds: [123],
    },
  });
  assert.throws(
    () => readInvestigationGroupNode(malformedGroupOutput),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const groupWithUnexpectedInput = createEvidenceNode({
    ...nodeInput(grouped.groupNodes[0]!),
    exactInputDigests: {
      ...grouped.groupNodes[0]!.exactInputDigests,
      hidden: 'f'.repeat(64),
    },
    output: grouped.groupNodes[0]!.output,
  });
  assert.throws(
    () => readInvestigationGroupNode(groupWithUnexpectedInput),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const groupWithForgedExceptionDigest = createEvidenceNode({
    ...nodeInput(grouped.groupNodes[0]!),
    exactInputDigests: {
      ...grouped.groupNodes[0]!.exactInputDigests,
      exceptions: 'f'.repeat(64),
    },
    output: grouped.groupNodes[0]!.output,
  });
  assert.throws(
    () => readInvestigationGroupNode(groupWithForgedExceptionDigest),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const validGroupOutput = readInvestigationGroupNode(grouped.groupNodes[0]!);
  const groupWithMalformedSource = createEvidenceNode({
    ...nodeInput(grouped.groupNodes[0]!),
    output: {
      ...validGroupOutput,
      sourceObjects: validGroupOutput.sourceObjects.map((source, index) =>
        index === 0 ? { ...source, objectId: 'not-a-git-object-id' } : source,
      ),
    },
  });
  assert.throws(
    () => readInvestigationGroupNode(groupWithMalformedSource),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const hitWithNegativeOffset = createEvidenceNode({
    ...nodeInput(grouped.hitNodes[0]!),
    output: {
      ...(grouped.hitNodes[0]!.output as Record<string, unknown>),
      byteOffset: -1,
    },
  });
  assert.throws(
    () => readInvestigationHitNode(hitWithNegativeOffset),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const malformedCoverageOutput = createEvidenceNode({
    ...nodeInput(coverage),
    output: {
      ...readInvestigationCoverageNode(coverage),
      effectiveTermIds: [TERM_A, TERM_A],
    },
  });
  assert.throws(
    () => readInvestigationCoverageNode(malformedCoverageOutput),
    (error) => isWorkflowError(error, 'INVESTIGATION_COVERAGE_INVALID'),
  );
});

test('zero-hit terms are current leaves and unrelated terms preserve existing descendants', () => {
  const context = groupingContext();
  const scanA = scanNode(TERM_A, [hit('src/a.ts', 0)]);
  const scanB = scanNode(TERM_B, [hit('generated/file.ts', 0)]);
  const zero = scanNode(TERM_ZERO, []);
  const first = deriveInvestigationGroups({
    scanNodes: [scanA, zero],
    ...context,
    exceptions: [],
  });
  assert.equal(
    first.hitNodes.some(
      (node) => readInvestigationHitNode(node).termId === TERM_ZERO,
    ),
    false,
  );
  assert.equal(
    first.groupNodes.some(
      (node) => readInvestigationGroupNode(node).selector.termId === TERM_ZERO,
    ),
    false,
  );

  const expanded = deriveInvestigationGroups({
    scanNodes: [scanB, zero, scanA],
    ...context,
    exceptions: [],
  });
  const firstHitIds = first.hitNodes.map(({ nodeId }) => nodeId);
  const firstGroupIds = first.groupNodes.map(({ nodeId }) => nodeId);
  assert.deepEqual(
    expanded.hitNodes
      .filter((node) => readInvestigationHitNode(node).termId === TERM_A)
      .map(({ nodeId }) => nodeId),
    firstHitIds,
  );
  assert.deepEqual(
    expanded.groupNodes
      .filter(
        (node) => readInvestigationGroupNode(node).selector.termId === TERM_A,
      )
      .map(({ nodeId }) => nodeId),
    firstGroupIds,
  );

  const firstDispositions = createInvestigationDispositionNodes({
    groupNodes: first.groupNodes,
    dispositions: dispositionAnswers(first.groupNodes),
  });
  const expandedDispositions = createInvestigationDispositionNodes({
    groupNodes: expanded.groupNodes,
    dispositions: dispositionAnswers(expanded.groupNodes),
  });
  assert.deepEqual(
    expandedDispositions
      .filter((node) => {
        const groupId = readInvestigationDispositionNode(node).groupId;
        return first.groupNodes.some(
          (group) => readInvestigationGroupNode(group).groupId === groupId,
        );
      })
      .map(({ nodeId }) => nodeId),
    firstDispositions.map(({ nodeId }) => nodeId),
  );

  const changedRationale = createInvestigationDispositionNodes({
    groupNodes: first.groupNodes,
    dispositions: dispositionAnswers(first.groupNodes).map((answer) => ({
      ...answer,
      rationale: `${answer.rationale} Reviewed again.`,
    })),
  });
  assert.deepEqual(
    first.groupNodes.map(({ nodeId }) => nodeId),
    firstGroupIds,
  );
  assert.notDeepEqual(
    changedRationale.map(({ resultDigest }) => resultDigest),
    firstDispositions.map(({ resultDigest }) => resultDigest),
  );
  assert.notDeepEqual(
    changedRationale.map(({ nodeId }) => nodeId),
    firstDispositions.map(({ nodeId }) => nodeId),
  );
});

test('closed DAG validation is topological and rejects missing parents, collisions, and forged grouping output', () => {
  const context = groupingContext();
  const scan = scanNode(TERM_A, [hit('src/a.ts', 0)]);
  const zero = scanNode(TERM_ZERO, []);
  const inventory = inventoryNode();
  const grouped = deriveInvestigationGroups({
    scanNodes: [scan, zero],
    ...context,
    exceptions: [],
  });
  const dispositions = createInvestigationDispositionNodes({
    groupNodes: grouped.groupNodes,
    dispositions: dispositionAnswers(grouped.groupNodes),
  });
  const coverage = createInvestigationCoverageNode({
    effectiveTermIds: [TERM_A, TERM_ZERO],
    scanNodes: [scan, zero],
    inventoryNode: inventory,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes: dispositions,
  });
  const nodes = [
    scan,
    zero,
    inventory,
    ...grouped.hitNodes,
    ...grouped.groupNodes,
    ...dispositions,
    coverage,
  ];
  const forward = validateClosedEvidenceDag(nodes);
  const reverse = validateClosedEvidenceDag([...nodes].reverse());
  assert.deepEqual(reverse, forward);
  assert.equal(forward.topologicalNodeIds.at(-1), coverage.nodeId);

  assert.throws(
    () =>
      validateClosedEvidenceDag(
        nodes.filter(({ nodeId }) => nodeId !== grouped.hitNodes[0]!.nodeId),
      ),
    (error) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );

  const collisionA = createEvidenceNode({
    type: 'collision',
    nodeSchema: 'collision.v1',
    evaluator: 'collision.v1',
    policyDigest: POLICY_DIGEST,
    exactInputDigests: { source: TREE_DIGEST },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'collision-output.v1',
    output: { value: 'a' },
    runtimeMetadata: {},
  });
  const collisionB = createEvidenceNode({
    ...nodeInput(collisionA),
    output: { value: 'b' },
  });
  assert.equal(collisionA.nodeId, collisionB.nodeId);
  assert.notEqual(collisionA.resultDigest, collisionB.resultDigest);
  assert.throws(
    () => validateClosedEvidenceDag([collisionA, collisionB]),
    (error) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );

  const validGroup = grouped.groupNodes[0]!;
  const forgedGroup = createEvidenceNode({
    ...nodeInput(validGroup),
    output: {
      ...readInvestigationGroupNode(validGroup),
      hitIds: [],
      hits: [],
      sourceObjects: [],
    },
  });
  assert.equal(forgedGroup.nodeId, validGroup.nodeId);
  assert.notEqual(forgedGroup.resultDigest, validGroup.resultDigest);
  assert.throws(
    () =>
      validateInvestigationEvidenceDag({
        effectiveTermIds: [TERM_A, TERM_ZERO],
        scanNodes: [scan, zero],
        inventoryNode: inventory,
        hitNodes: grouped.hitNodes,
        groupNodes: [forgedGroup],
        dispositionNodes: dispositions,
        coverageNode: coverage,
        ...context,
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_EVIDENCE_DAG_INVALID'),
  );

  const futureWhyNode = createEvidenceNode({
    type: 'investigation-why',
    nodeSchema: 'investigation.why.v1',
    evaluator: 'investigation-why.v1',
    policyDigest: POLICY_DIGEST,
    exactInputDigests: { blob: TREE_DIGEST },
    semanticParentResultDigests: {
      disposition: dispositions[0]!.resultDigest,
    },
    provenanceParentNodeIds: {
      disposition: dispositions[0]!.nodeId,
    },
    outputSchema: 'investigation.why-output.v1',
    output: { why: 'Preserves a load-bearing invariant.' },
    runtimeMetadata: {},
  });
  const extendedOrder = validateClosedEvidenceDag([
    ...nodes,
    futureWhyNode,
  ]).topologicalNodeIds;
  assert.ok(extendedOrder.includes(futureWhyNode.nodeId));
  assert.ok(
    extendedOrder.indexOf(dispositions[0]!.nodeId) <
      extendedOrder.indexOf(futureWhyNode.nodeId),
  );

  const forgedWhyParentResult = createEvidenceNode({
    ...nodeInput(futureWhyNode),
    semanticParentResultDigests: {
      disposition: 'f'.repeat(64),
    },
    output: futureWhyNode.output,
  });
  assert.throws(
    () => validateClosedEvidenceDag([...nodes, forgedWhyParentResult]),
    (error) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );

  const missingWhySemanticParent = createEvidenceNode({
    ...nodeInput(futureWhyNode),
    semanticParentResultDigests: {},
    output: futureWhyNode.output,
  });
  assert.throws(
    () => validateClosedEvidenceDag([...nodes, missingWhySemanticParent]),
    (error) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );

  const wrongTypedScan = createEvidenceNode({
    ...nodeInput(scan),
    type: 'not-an-investigation-scan',
    output: scan.output,
  });
  assert.throws(
    () =>
      deriveInvestigationGroups({
        scanNodes: [wrongTypedScan],
        ...context,
        exceptions: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
});

function mutationPolicy(): MutationClassPolicy {
  return createMutationClassPolicy({
    rules: [
      {
        ruleId: 'prohibited',
        mutationClass: 'prohibited',
        selector: { kind: 'path-prefix', path: 'blocked' },
      },
      {
        ruleId: 'generated',
        mutationClass: 'generated',
        selector: { kind: 'path-prefix', path: 'generated' },
      },
      {
        ruleId: 'mirror',
        mutationClass: 'mirror',
        selector: { kind: 'path-prefix', path: 'mirror' },
      },
      {
        ruleId: 'append-only',
        mutationClass: 'append-only',
        selector: { kind: 'exact-path', path: 'CHANGELOG.md' },
      },
      {
        ruleId: 'immutable',
        mutationClass: 'immutable',
        selector: { kind: 'path-prefix', path: 'archive' },
      },
      {
        ruleId: 'historical',
        mutationClass: 'historical-reference',
        selector: { kind: 'path-prefix', path: 'history' },
      },
    ],
  });
}

function groupingContext(): {
  mutationPolicy: MutationClassPolicy;
  declaredRoots: DeclaredInvestigationRoot[];
  reviewedRelationships: ReviewedPathRelationship[];
} {
  return {
    mutationPolicy: mutationPolicy(),
    declaredRoots: [
      { rootId: 'repository', path: '' },
      { rootId: 'source', path: 'src' },
      { rootId: 'blocked', path: 'blocked' },
      { rootId: 'generated', path: 'generated' },
      { rootId: 'mirror', path: 'mirror' },
      { rootId: 'archive', path: 'archive' },
      { rootId: 'history', path: 'history' },
    ],
    reviewedRelationships: [
      {
        relationshipId: 'generated-source',
        kind: 'generated',
        subjectPath: pathIdentity('src/a.ts'),
        counterpartPath: pathIdentity('generated/file.ts'),
        reference: 'review:generated-source',
      },
      {
        relationshipId: 'mirror-source',
        kind: 'mirror',
        subjectPath: pathIdentity('src/a.ts'),
        counterpartPath: pathIdentity('mirror/file.ts'),
        reference: 'review:mirror-source',
      },
    ],
  };
}

function reviewedRelationship(
  relationshipId: string,
  subjectPath: string,
  counterpartPath: string,
): ReviewedPathRelationship {
  return {
    relationshipId,
    kind: 'generated',
    subjectPath: pathIdentity(subjectPath),
    counterpartPath: pathIdentity(counterpartPath),
    reference: `review:${relationshipId}`,
  };
}

function dispositionAnswers(
  groupNodes: EvidenceNode[],
): InvestigationDispositionInput[] {
  return groupNodes.map((node) => {
    const group = readInvestigationGroupNode(node);
    return {
      groupId: group.groupId,
      classification:
        group.selector.mutationClass === 'generated'
          ? ('generated' as const)
          : group.selector.mutationClass === 'mirror'
            ? ('test-or-mirror' as const)
            : ('load-bearing' as const),
      rationale: `Reviewed exact selector ${group.selector.selectorId}.`,
      author: 'codex',
    };
  });
}

function scanNode(
  termId: string,
  hits: Array<ReturnType<typeof hit>>,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-term-scan',
    nodeSchema: 'investigation.term-scan.v1',
    evaluator: 'investigation-scanner.v1',
    policyDigest: POLICY_DIGEST,
    exactInputDigests: {
      term: sha256(`term:${termId}`),
      tree: TREE_DIGEST,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.term-scan-output.v1',
    output: { termId, hits },
    runtimeMetadata: {},
  });
}

function inventoryNode(treeDigest = TREE_DIGEST): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-tree-inventory',
    nodeSchema: 'investigation.tree-inventory.v1',
    evaluator: 'investigation-scanner.v1',
    policyDigest: POLICY_DIGEST,
    exactInputDigests: { tree: treeDigest },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.tree-inventory-output.v1',
    output: { skippedObjects: [] },
    runtimeMetadata: {},
  });
}

function hit(filePath: string, byteOffset: number) {
  return {
    path: pathIdentity(filePath),
    sourceObject: {
      objectId: sha1(`object:${filePath}`),
      objectType: 'blob',
      mode: '100644',
      byteSize: 128,
      contentSha256: sha256(`content:${filePath}`),
      skipReason: null,
    },
    surface: 'content' as const,
    byteOffset,
    byteLength: 6,
  };
}

function pathIdentity(filePath: string): {
  rawBase64: string;
  utf8: string;
} {
  return {
    rawBase64: Buffer.from(filePath, 'utf8').toString('base64'),
    utf8: filePath,
  };
}

function nodeInput(node: EvidenceNode) {
  return {
    type: node.type,
    nodeSchema: node.nodeSchema,
    evaluator: node.evaluator,
    policyDigest: node.policyDigest,
    exactInputDigests: node.exactInputDigests,
    semanticParentResultDigests: node.semanticParentResultDigests,
    provenanceParentNodeIds: node.provenanceParentNodeIds,
    outputSchema: node.outputSchema,
    runtimeMetadata: node.runtimeMetadata,
  };
}

function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
