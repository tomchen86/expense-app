import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { deriveInvestigationGroupFacts } from '../src/modules/investigation/domain/investigation-groups.ts';
import { materializeInvestigationEvidenceView } from '../src/modules/investigation/manifest/investigation-materializer.ts';
import { scanInvestigationTreeFacts } from '../src/modules/investigation/domain/investigation-scanner.ts';
import {
  buildInvestigationV3WhyAuthoring,
  deriveInvestigationV3WhyRequirements,
  mapLegacyWhyAuthoringToV3Sources,
} from '../src/modules/investigation/manifest/investigation-why-domain.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import { git } from './fixture.ts';

test('WHY authoring is derived from domain facts and raw source anchors without evidence envelopes', () => {
  const repository = createRepository();
  try {
    const contribution: InvestigationTermContribution<'main'> = {
      source: 'main',
      reference: 'main:why-domain',
      terms: [
        {
          kind: 'literal-content',
          value: 'why-domain',
          rationale: 'Locate the load-bearing implementation.',
          expectedRelationship: 'Both matches belong to one source blob.',
        },
      ],
    };
    const preview = previewInvestigationTermUnion([contribution]);
    assert.equal(preview.outcome, 'ready');
    if (preview.outcome !== 'ready') assert.fail('term union not ready');
    const baseline = {
      commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
      treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    };
    const mutationPolicy = createMutationClassPolicy({ rules: [] });
    const scan = scanInvestigationTreeFacts({
      repositoryRoot: repository,
      treeOid: baseline.treeOid,
      terms: preview.terms,
    });
    assert.equal(scan.outcome, 'ready');
    if (scan.outcome !== 'ready') assert.fail('scan not ready');
    const grouping = deriveInvestigationGroupFacts({
      scanFacts: scan.facts,
      mutationPolicy,
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
    });
    const groupKey = grouping.groups[0]!.key;
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: {
        baseline,
        termContributions: [contribution],
        canonicalTerms: preview.terms,
        scanner: {
          allowSaturatedTerms: false,
          saturationDecision: null,
        },
        grouping: {
          mutationPolicy,
          declaredRoots: [{ rootId: 'repository', path: '' }],
          reviewedRelationships: [],
        },
        semanticGroupDecisions: [],
        dispositionDecisions: [
          {
            groupKey,
            classification: 'load-bearing',
            rationale: 'The implementation is changed by this proposal.',
            semanticAuthor: {
              id: 'owner',
              provenance: 'checkpoint:dispositions',
            },
          },
        ],
      },
    });

    const requirements = deriveInvestigationV3WhyRequirements(view);
    assert.equal(requirements.length, 1);
    assert.equal(requirements[0]!.hits.length, 2);
    const mapped = mapLegacyWhyAuthoringToV3Sources({
      requirements,
      manifestRows: [
        {
          manifestEntryId: 'a'.repeat(64),
          path: requirements[0]!.pathIdentity,
          blob: {
            objectId: requirements[0]!.blobOid,
            contentSha256: requirements[0]!.contentSha256,
          },
        },
      ],
      answers: [
        {
          manifestEntryId: 'a'.repeat(64),
          why: 'This file owns the manifest-first behavior.',
          protectedInvariant: 'Every hit remains dispositioned exactly once.',
          reviewerQuestion: 'Can a hit escape the final group partition?',
          answer: 'No; the compact root binds the complete current hit set.',
          semanticAuthor: 'owner',
          readComplete: true,
        },
      ],
      carried: [],
      checkpointProvenanceDigest: 'b'.repeat(64),
    });
    const authored = buildInvestigationV3WhyAuthoring({
      view,
      answers: mapped.answers,
      knowledgeReuse: mapped.knowledgeReuse,
    });
    assert.equal(authored.whyOverlays.length, 1);
    assert.equal(authored.whyOverlays[0]!.anchors.length, 2);
    assert.equal(authored.whyOverlays[0]!.groupRefs.length, 1);
    assert.deepEqual(authored.knowledgeReuseDecisions, []);
    const serialized = canonicalJson(authored);
    for (const forbidden of [
      'nodeId',
      'nodeSchema',
      'evaluator',
      'outputSchema',
    ]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-why-domain-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'why-v3@example.test']);
  git(repository, ['config', 'user.name', 'WHY V3 Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'src/owner.ts'),
    'export const first = "why-domain";\nexport const second = "why-domain";\n',
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create WHY domain fixture']);
  return repository;
}
