import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationGroupFacts,
  deriveInvestigationGroups,
} from '../src/investigation-groups.ts';
import {
  buildInvestigationManifestDraft,
  type OrdinaryInvestigationAuthoringState,
} from '../src/investigation-manifest.ts';
import {
  materializeInvestigationEvidenceView,
  type InvestigationReplayAuthoringInput,
} from '../src/investigation-materializer.ts';
import {
  adaptInvestigationScanFactsResult,
  scanInvestigationTreeFacts,
} from '../src/investigation-scanner.ts';
import {
  compareInvestigationV2V3Shadow,
  type InvestigationV2ShadowOracle,
} from '../src/investigation-shadow-parity.ts';
import { buildInvestigationV3Shadow } from '../src/investigation-shadow-builder.ts';
import {
  buildInvestigationV3WhyAuthoring,
  deriveInvestigationV3WhyRequirements,
} from '../src/investigation-why-domain.ts';
import {
  createInvestigationWhyNodes,
  deriveInvestigationFullBlobManifest,
} from '../src/investigation-why.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/mutation-class-policy.ts';
import { readPinnedTrackedTree } from '../src/tracked-tree-reader.ts';
import { git, isWorkflowError } from './fixture.ts';

test('independent v2/v3 shadow views match every governed semantic facet', () => {
  const repository = createRepository();
  try {
    const author = { id: 'owner', provenance: 'checkpoint:shadow' };
    const contribution: InvestigationTermContribution<'main'> = {
      source: 'main',
      reference: 'main:shadow-parity',
      terms: [
        {
          kind: 'literal-content',
          value: 'shadow-parity',
          rationale: 'Locate the implementation behavior.',
          expectedRelationship: 'The match is load-bearing.',
        },
      ],
    };
    const contributions: InvestigationTermContribution[] = [
      {
        source: 'engine',
        reference: 'engine-floor:shadow-parity',
        terms: [{ kind: 'literal-path', value: 'src/owner.ts' }],
      },
      contribution,
    ];
    const preview = previewInvestigationTermUnion(contributions);
    assert.equal(preview.outcome, 'ready');
    if (preview.outcome !== 'ready') assert.fail('term union not ready');
    const baseline = {
      commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
      treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    };
    const mutationPolicy = createMutationClassPolicy({ rules: [] });
    const scanner = scanInvestigationTreeFacts({
      repositoryRoot: repository,
      treeOid: baseline.treeOid,
      terms: preview.terms,
    });
    assert.equal(scanner.outcome, 'ready');
    if (scanner.outcome !== 'ready') assert.fail('scan not ready');
    const legacyScan = adaptInvestigationScanFactsResult(scanner);
    assert.equal(legacyScan.outcome, 'ready');
    if (legacyScan.outcome !== 'ready') assert.fail('legacy scan not ready');
    const grouping = deriveInvestigationGroupFacts({
      scanFacts: scanner.facts,
      mutationPolicy,
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
    });
    const dispositionDecisions = grouping.groups.map((group) => ({
      groupKey: group.key,
      classification: 'load-bearing',
      rationale: 'This source is required by the planned behavior.',
      semanticAuthor: author,
    }));
    const replayAuthoring: InvestigationReplayAuthoringInput = {
      baseline,
      termContributions: contributions,
      canonicalTerms: preview.terms,
      scanner: { allowSaturatedTerms: false, saturationDecision: null },
      grouping: {
        mutationPolicy,
        declaredRoots: [{ rootId: 'repository', path: '' }],
        reviewedRelationships: [],
      },
      semanticGroupDecisions: [],
      dispositionDecisions,
    };
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: replayAuthoring,
    });
    const legacyGroups = deriveInvestigationGroups({
      scanNodes: legacyScan.nodes,
      mutationPolicy,
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
      exceptions: [],
    });
    const legacyDispositions = createInvestigationDispositionNodes({
      groupNodes: legacyGroups.groupNodes,
      dispositions: dispositionDecisions.map((decision) => ({
        groupId: decision.groupKey,
        classification: decision.classification,
        rationale: decision.rationale,
        author: decision.semanticAuthor.id,
      })),
    });
    const legacyCoverage = createInvestigationCoverageNode({
      effectiveTermIds: preview.terms.map(({ termId }) => termId),
      scanNodes: legacyScan.nodes,
      inventoryNode: legacyScan.inventory.evidenceNode,
      hitNodes: legacyGroups.hitNodes,
      groupNodes: legacyGroups.groupNodes,
      dispositionNodes: legacyDispositions,
    });
    const completeManifest = deriveInvestigationFullBlobManifest({
      snapshot: readPinnedTrackedTree({
        repositoryRoot: repository,
        treeOid: baseline.treeOid,
      }),
      hitNodes: legacyGroups.hitNodes,
      groupNodes: legacyGroups.groupNodes,
      dispositionNodes: legacyDispositions,
    });
    assert.equal(completeManifest.length, 1);
    const answer = {
      why: 'This file owns the shadow parity behavior.',
      protectedInvariant: 'Both representations preserve exact coverage.',
      reviewerQuestion: 'Do the v2 and v3 semantic views disagree?',
      answer: 'No; every governed facet has the same canonical root.',
      semanticAuthor: 'owner',
      readComplete: true,
    } as const;
    const legacyWhy = createInvestigationWhyNodes({
      manifest: completeManifest,
      hitNodes: legacyGroups.hitNodes,
      groupNodes: legacyGroups.groupNodes,
      dispositionNodes: legacyDispositions,
      answers: [
        { manifestEntryId: completeManifest[0]!.manifestEntryId, ...answer },
      ],
    });
    const requirements = deriveInvestigationV3WhyRequirements(view);
    const why = buildInvestigationV3WhyAuthoring({
      view,
      answers: [
        {
          sourceKey: requirements[0]!.sourceKey,
          why: answer.why,
          protectedInvariant: answer.protectedInvariant,
          reviewerQuestion: answer.reviewerQuestion,
          answer: answer.answer,
          semanticAuthor: author,
          readComplete: true,
        },
      ],
      knowledgeReuse: [],
    });
    const intent = {
      schemaVersion: 1 as const,
      summary: 'Implement independent Investigation v3 shadow parity.',
      explicitPaths: ['src/owner.ts'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const assurance = {
      assessmentDigest: digest('assessment'),
      coverageTier: 'standard' as const,
      escalated: false,
      reasons: ['ordinary-shadow-fixture'],
      provenanceDigest: digest('assessment-provenance'),
    };
    const state: OrdinaryInvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'ordinary',
      repositoryId: 'expense-app-shadow-test',
      changeId: 'manifest-first-shadow',
      investigationId: 'investigation-shadow-test',
      normalizedIntent: intent,
      authoring: {
        sessionRevision: 4,
        sessionSnapshotDigest: digest('session-snapshot'),
      },
      ordinary: {
        ...replayAuthoring,
        ...why,
        investigationRoleResults: [
          {
            role: 'blind-surveyor',
            targetDigest: digest('role-target'),
            providerId: 'codex',
            sessionId: 'session-shadow',
            principalId: 'principal-shadow',
            requiredIndependence: 'provider-independent',
            achievedIndependence: 'provider-independent',
            requestDigest: digest('role-request'),
            outputDigest: digest('role-output'),
            contentDigest: digest('role-content'),
            policyDigest: digest('role-policy'),
            provenanceDigest: digest('role-provenance'),
          },
        ],
        floorOverflowDecision: null,
        exceptions: [],
        investigationRequirements: [],
        assuranceFacts: assurance,
      },
    };
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') {
      assert.fail(
        `${built.blocker.failureCode}:${built.blocker.detailsDigest}`,
      );
    }
    const oracle: InvestigationV2ShadowOracle = {
      canonicalTerms: preview.terms,
      inventory: scanner.facts.inventory,
      groupNodes: legacyGroups.groupNodes,
      dispositionNodes: legacyDispositions,
      coverageNode: legacyCoverage,
      whyNodes: legacyWhy,
      knowledgeReuse: [],
      baseline: { head: baseline.commitOid, tree: baseline.treeOid },
      intentDigest: digest(intent),
      assurance: {
        coverageTier: assurance.coverageTier,
        escalated: assurance.escalated,
        reasons: assurance.reasons,
      },
    };
    const parity = compareInvestigationV2V3Shadow({
      v2: oracle,
      v3: { draft: built.draft, view },
    });
    assert.equal(parity.matched, true);
    assert.equal(
      Object.values(parity.facets).every((facet) => facet.matched),
      true,
    );

    const shadow = buildInvestigationV3Shadow({
      repositoryRoot: repository,
      repositoryId: state.repositoryId,
      changeId: state.changeId,
      investigationId: state.investigationId,
      normalizedIntent: intent,
      authoring: state.authoring,
      baseline,
      termContributions: contributions,
      canonicalTerms: preview.terms,
      scanFacts: scanner.facts,
      groupFacts: grouping,
      scanner: { allowSaturatedTerms: false, saturationDecision: null },
      grouping: replayAuthoring.grouping,
      dispositionDecisions,
      whyAuthoring: { kind: 'direct-v3', ...why },
      investigationRoleResults: state.ordinary.investigationRoleResults,
      floorOverflowDecision: null,
      assuranceFacts: assurance,
      approval: {
        semanticAuthor: author,
        approvalProvenanceDigest: digest('shadow-approval'),
      },
      v2Oracle: oracle,
    });
    assert.equal(shadow.outcome, 'matched');

    assert.throws(
      () =>
        compareInvestigationV2V3Shadow({
          v2: {
            ...oracle,
            assurance: { ...oracle.assurance, escalated: true },
          },
          v3: { draft: built.draft, view },
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_V3_SHADOW_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-shadow-parity-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'shadow-v3@example.test']);
  git(repository, ['config', 'user.name', 'Shadow V3 Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'src/owner.ts'),
    'export const behavior = "shadow-parity";\n',
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create shadow parity fixture']);
  return repository;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
