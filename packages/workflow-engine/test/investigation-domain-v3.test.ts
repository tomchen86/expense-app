import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  applyInvestigationDispositionDecisions,
  applyInvestigationSemanticGroupDecisions,
} from '../src/investigation-domain.ts';
import { deriveInvestigationGroupFacts } from '../src/investigation-groups.ts';
import {
  deriveInvestigationCommitments,
  investigationTermSetDigest,
} from '../src/investigation-roots.ts';
import { scanInvestigationTreeFacts } from '../src/investigation-scanner.ts';
import {
  normalizeInvestigationTerm,
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/mutation-class-policy.ts';
import { git, isWorkflowError } from './fixture.ts';

test('v3 domain decisions partition hits and derive compact commitments without evidence envelopes', () => {
  const repository = createRepository();
  try {
    const contribution: InvestigationTermContribution<'main'> = {
      source: 'main',
      reference: 'main:v3-domain',
      terms: [
        {
          kind: 'literal-content',
          value: 'v3-domain',
          rationale: 'Find both load-bearing v3 domain occurrences.',
          expectedRelationship: 'Both occurrences exercise semantic splitting.',
        },
      ],
    };
    const preview = previewInvestigationTermUnion([contribution]);
    assert.equal(preview.outcome, 'ready');
    if (preview.outcome !== 'ready') assert.fail('expected term union');
    const scan = scanInvestigationTreeFacts({
      repositoryRoot: repository,
      treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
      terms: preview.terms,
    });
    assert.equal(scan.outcome, 'ready');
    if (scan.outcome !== 'ready') assert.fail('expected scan facts');
    const grouping = deriveInvestigationGroupFacts({
      scanFacts: scan.facts,
      mutationPolicy: createMutationClassPolicy({ rules: [] }),
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
    });
    assert.equal(grouping.groups.length, 1);
    assert.equal(grouping.hits.length, 2);
    const mechanical = grouping.groups[0]!;
    const author = {
      id: 'owner',
      provenance: 'checkpoint:semantic-groups',
    };
    const finalGroups = applyInvestigationSemanticGroupDecisions({
      mechanical: grouping,
      decisions: [
        {
          decisionId: 'split-first',
          key: 'first-occurrence',
          title: 'First occurrence',
          sourceMechanicalGroupKeys: [mechanical.key],
          hitKeys: [mechanical.hitKeys[0]!],
          rationale: 'The two locations carry distinct change semantics.',
          semanticAuthor: author,
        },
        {
          decisionId: 'split-second',
          key: 'second-occurrence',
          title: 'Second occurrence',
          sourceMechanicalGroupKeys: [mechanical.key],
          hitKeys: [mechanical.hitKeys[1]!],
          rationale: 'The two locations carry distinct change semantics.',
          semanticAuthor: author,
        },
      ],
    });
    const dispositions = applyInvestigationDispositionDecisions({
      finalGroups,
      decisions: finalGroups.map((group) => ({
        groupKey: group.key,
        classification: 'load-bearing',
        rationale: `${group.title} is required for the planned behavior.`,
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:dispositions',
        },
      })),
    });
    const commitments = deriveInvestigationCommitments({
      scanFacts: scan.facts,
      grouping,
      finalGroups,
      dispositions,
      effectiveTermIds: preview.terms.map(({ termId }) => termId),
    });

    assert.equal(finalGroups.length, 2);
    assert.equal(dispositions.length, 2);
    assert.equal(commitments.hitCount, 2);
    assert.equal(commitments.finalGroupCount, 2);
    assert.deepEqual(commitments.zeroHitTermIds, []);
    for (const digest of [
      commitments.inventoryRoot,
      commitments.hitRoot,
      commitments.mechanicalGroupRoot,
      commitments.finalGroupRoot,
      commitments.coverageRoot,
      investigationTermSetDigest(preview.terms),
    ]) {
      assert.match(digest, /^[0-9a-f]{64}$/);
    }
    const serialized = canonicalJson({
      finalGroups,
      dispositions,
      commitments,
    });
    for (const forbidden of [
      'nodeId',
      'nodeSchema',
      'evaluator',
      'outputSchema',
      'provenanceParentNodeIds',
      'semanticParentResultDigests',
    ]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }

    assert.throws(
      () =>
        applyInvestigationDispositionDecisions({
          finalGroups,
          decisions: [],
        }),
      (error) => isWorkflowError(error, 'SEMANTIC_COMPLETENESS_FAILURE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('term-set digest binds normalized terms and all provenance', () => {
  const term = normalizeInvestigationTerm({
    kind: 'symbol',
    value: 'ManifestFirst',
  });
  const first = [
    {
      ...term,
      provenance: [
        {
          source: 'main' as const,
          reference: 'main:first',
          rationale: 'The symbol is directly named by the change.',
          expectedRelationship: 'It is an implementation entry point.',
        },
      ],
    },
  ];
  const second = structuredClone(first);
  second[0]!.provenance[0]!.reference = 'main:changed';
  assert.notEqual(
    investigationTermSetDigest(first),
    investigationTermSetDigest(second),
  );
});

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-domain-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'v3@example.test']);
  git(repository, ['config', 'user.name', 'V3 Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'src/domain.ts'),
    'const first = "v3-domain";\nconst second = "v3-domain";\n',
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create v3 domain fixture']);
  return repository;
}
