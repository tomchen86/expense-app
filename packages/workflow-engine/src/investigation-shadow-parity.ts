import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import type { EvidenceNode } from './evidence-node.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  readInvestigationCoverageNode,
  readInvestigationDispositionNode,
  readInvestigationGroupNode,
} from './investigation-groups.ts';
import type {
  InvestigationManifestDraftV3,
  InvestigationWhyOverlayV3,
} from './investigation-manifest.ts';
import type { MaterializedEvidenceView } from './investigation-materializer.ts';
import type { ScanInventoryFacts } from './investigation-scanner.ts';
import type { PreviewInvestigationTerm } from './investigation-terms.ts';
import { readInvestigationWhyNode } from './investigation-why.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export type InvestigationV2ShadowOracle = {
  canonicalTerms: PreviewInvestigationTerm[];
  inventory: ScanInventoryFacts;
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
  coverageNode: EvidenceNode;
  whyNodes: EvidenceNode[];
  knowledgeReuse: Array<{
    pathIdentity: { rawBase64: string; utf8: string | null };
    blobOid: string;
    subjectId: string;
    versionDigest: string;
  }>;
  baseline: { head: string; tree: string };
  intentDigest: string;
  assurance: {
    coverageTier: 'standard' | 'elevated' | 'critical';
    escalated: boolean;
    reasons: readonly string[];
  };
};

export type InvestigationShadowFacet = {
  v2Root: string;
  v3Root: string;
  matched: boolean;
};

export type InvestigationShadowParityReport = {
  schemaVersion: 1;
  kind: 'investigation-v2-v3-shadow-parity';
  matched: true;
  facets: Record<string, InvestigationShadowFacet>;
  reportDigest: string;
};

/**
 * Transition-only parity oracle. v2 envelopes are accepted exclusively on the
 * oracle side; the v3 side is the direct Manifest plus its process-local replay
 * view. This module never writes authority and must be removed with v2 shadow.
 */
export function compareInvestigationV2V3Shadow(input: {
  v2: InvestigationV2ShadowOracle;
  v3: {
    draft: InvestigationManifestDraftV3;
    view: MaterializedEvidenceView;
  };
}): InvestigationShadowParityReport {
  if (input.v3.draft.applicability.kind !== 'ordinary') {
    throw parityFailure(
      'Ordinary v2 authority cannot be compared to an exemption.',
    );
  }
  assertPersistedCommitments(input.v3.draft, input.v3.view);
  const v2 = v2Facets(input.v2);
  const v3 = v3Facets(input.v3.draft, input.v3.view);
  const facetNames = Object.keys(v2).sort();
  if (canonicalJson(facetNames) !== canonicalJson(Object.keys(v3).sort())) {
    throw parityFailure('v2 and v3 expose different parity facets.');
  }
  const facets: Record<string, InvestigationShadowFacet> = {};
  for (const name of facetNames) {
    const v2Root = digest({
      schema: `investigation.shadow.${name}.v1`,
      value: v2[name],
    });
    const v3Root = digest({
      schema: `investigation.shadow.${name}.v1`,
      value: v3[name],
    });
    facets[name] = { v2Root, v3Root, matched: v2Root === v3Root };
  }
  const mismatched = Object.entries(facets)
    .filter(([, facet]) => !facet.matched)
    .map(([name]) => name);
  if (mismatched.length > 0) {
    throw workflowError(
      'INVESTIGATION_V3_SHADOW_MISMATCH',
      `Investigation v2/v3 shadow parity differs for: ${mismatched.join(', ')}.`,
      ExitCode.verification,
      { details: { facets, mismatched } },
    );
  }
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: 'investigation-v2-v3-shadow-parity' as const,
    matched: true as const,
    facets,
  };
  return {
    ...withoutDigest,
    reportDigest: digest({
      schema: 'investigation.v2-v3-shadow-parity-report.v1',
      report: withoutDigest,
    }),
  };
}

function v2Facets(input: InvestigationV2ShadowOracle): Record<string, unknown> {
  const groups = input.groupNodes.map(readInvestigationGroupNode);
  const dispositions = input.dispositionNodes.map(
    readInvestigationDispositionNode,
  );
  const coverage = readInvestigationCoverageNode(input.coverageNode);
  const groupKeyByNodeId = new Map(
    input.groupNodes.map((node, index) => [
      node.nodeId,
      groups[index]!.groupId,
    ]),
  );
  const dispositionGroupByNodeId = new Map(
    input.dispositionNodes.map((node, index) => [
      node.nodeId,
      dispositions[index]!.groupId,
    ]),
  );
  const hitsById = new Map(
    groups.flatMap((group) =>
      group.hits.map((hit) => [hit.hitId, hit] as const),
    ),
  );
  const semanticHits = sortCanonical(
    [...hitsById.values()].map(({ hitId: _hitId, ...hit }) => hit),
  );
  const groupView = sortCanonical(
    groups.map((group) => ({
      key: group.groupId,
      selector: selectorView(group.selector),
      hits: sortCanonical(group.hits.map(({ hitId: _hitId, ...hit }) => hit)),
      sourceObjects: sortCanonical(group.sourceObjects),
    })),
  );
  const dispositionView = sortCanonical(
    dispositions.map((disposition) => ({
      groupKey: disposition.groupId,
      classification: disposition.classification,
      rationale: disposition.rationale,
      author: disposition.author,
      coveredHits: sortCanonical(
        disposition.coveredHitIds.map((hitId) => {
          const hit = hitsById.get(hitId);
          if (hit === undefined) {
            throw parityFailure('v2 disposition cites an unknown hit.');
          }
          const { hitId: _hitId, ...semantic } = hit;
          return semantic;
        }),
      ),
    })),
  );
  return {
    terms: sortCanonical(input.canonicalTerms),
    inventory: {
      treeDigest: input.inventory.treeDigest,
      skippedObjects: sortCanonical([...input.inventory.skippedObjects]),
    },
    hits: semanticHits,
    mechanicalGroups: groupView,
    finalGroups: groupView.map(({ key, hits }) => ({ key, hits })),
    dispositions: dispositionView,
    coverage: {
      effectiveTermIds: [...coverage.effectiveTermIds].sort(),
      zeroHitTermIds: [...coverage.zeroHitTermIds].sort(),
      groupKeys: coverage.groupIds
        .map((nodeId) => {
          const groupKey = groupKeyByNodeId.get(nodeId);
          if (groupKey === undefined) {
            throw parityFailure('v2 coverage cites an unknown Group node.');
          }
          return groupKey;
        })
        .sort(),
      dispositionGroupKeys: coverage.dispositionNodeIds
        .map((nodeId) => {
          const groupKey = dispositionGroupByNodeId.get(nodeId);
          if (groupKey === undefined) {
            throw parityFailure(
              'v2 coverage cites an unknown disposition node.',
            );
          }
          return groupKey;
        })
        .sort(),
    },
    why: sortCanonical(
      input.whyNodes.map((node) => whyV2View(readInvestigationWhyNode(node))),
    ),
    knowledgeReuse: sortCanonical(
      input.knowledgeReuse.map((entry) => ({
        pathIdentity: entry.pathIdentity,
        blobOid: entry.blobOid,
        subjectId: entry.subjectId,
        versionDigest: bareDigest(entry.versionDigest),
      })),
    ),
    exceptions: sortCanonical(groups.flatMap(({ exceptions }) => exceptions)),
    applicability: {
      kind: 'ordinary',
      baseline: {
        commitOid: input.baseline.head,
        treeOid: input.baseline.tree,
      },
      intentDigest: input.intentDigest,
    },
    assurance: {
      coverageTier: input.assurance.coverageTier,
      escalated: input.assurance.escalated,
      reasons: [...input.assurance.reasons].sort(),
    },
  };
}

function v3Facets(
  draft: InvestigationManifestDraftV3,
  view: MaterializedEvidenceView,
): Record<string, unknown> {
  if (draft.applicability.kind !== 'ordinary') {
    throw parityFailure('v3 shadow draft is not ordinary.');
  }
  const semantic = draft.applicability.semanticDelta;
  const replay = draft.applicability.replayContract;
  const hitsByKey = new Map(view.grouping.hits.map((hit) => [hit.hitKey, hit]));
  const semanticHits = sortCanonical(
    view.grouping.hits.map(({ hitKey: _hitKey, ...hit }) => hit),
  );
  const groupView = sortCanonical(
    view.grouping.groups.map((group) => ({
      key: group.key,
      selector: group.selector,
      hits: sortCanonical(group.hits.map(({ hitKey: _hitKey, ...hit }) => hit)),
      sourceObjects: sortCanonical(group.sourceObjects),
    })),
  );
  const dispositionView = sortCanonical(
    view.dispositions.map((disposition) => ({
      groupKey: disposition.groupRef.key,
      classification: disposition.classification,
      rationale: disposition.rationale,
      author: disposition.semanticAuthor.id,
      coveredHits: sortCanonical(
        disposition.coveredHitKeys.map((hitKey) => {
          const hit = hitsByKey.get(hitKey);
          if (hit === undefined) {
            throw parityFailure('v3 disposition cites an unknown hit.');
          }
          const { hitKey: _hitKey, ...semanticHit } = hit;
          return semanticHit;
        }),
      ),
    })),
  );
  return {
    terms: sortCanonical(replay.canonicalTerms),
    inventory: {
      treeDigest: view.scanFacts.inventory.treeDigest,
      skippedObjects: sortCanonical([
        ...view.scanFacts.inventory.skippedObjects,
      ]),
    },
    hits: semanticHits,
    mechanicalGroups: groupView,
    finalGroups: sortCanonical(
      view.finalGroups.map((group) => ({
        key: group.key,
        hits: sortCanonical(
          group.hitKeys.map((hitKey) => {
            const hit = hitsByKey.get(hitKey);
            if (hit === undefined) {
              throw parityFailure('v3 final Group cites an unknown hit.');
            }
            const { hitKey: _hitKey, ...semanticHit } = hit;
            return semanticHit;
          }),
        ),
      })),
    ),
    dispositions: dispositionView,
    coverage: {
      effectiveTermIds: replay.canonicalTerms
        .map(({ termId }) => termId)
        .sort(),
      zeroHitTermIds: [...view.commitments.zeroHitTermIds].sort(),
      groupKeys: view.finalGroups.map(({ key }) => key).sort(),
      dispositionGroupKeys: view.dispositions
        .map(({ groupRef }) => groupRef.key)
        .sort(),
    },
    why: sortCanonical(semantic.whyOverlays.map(whyV3View)),
    knowledgeReuse: sortCanonical(
      semantic.knowledgeReuseDecisions.map((entry) => ({
        pathIdentity: entry.pathIdentity,
        blobOid: entry.blobOid,
        subjectId: entry.knowledgeRef.subjectId,
        versionDigest: bareDigest(entry.knowledgeRef.versionDigest),
      })),
    ),
    exceptions: sortCanonical(semantic.exceptions),
    applicability: {
      kind: 'ordinary',
      baseline: replay.baseline,
      intentDigest: draft.intentDigest,
    },
    assurance: {
      coverageTier: semantic.assuranceFacts.coverageTier,
      escalated: semantic.assuranceFacts.escalated,
      reasons: [...semantic.assuranceFacts.reasons].sort(),
    },
  };
}

function selectorView(
  selector: ReturnType<typeof readInvestigationGroupNode>['selector'],
) {
  const { selectorId: _selectorId, ...semantic } = selector;
  return semantic;
}

function whyV2View(why: ReturnType<typeof readInvestigationWhyNode>) {
  return {
    pathIdentity: why.path,
    blobOid: why.blob.objectId,
    contentSha256: why.blob.contentSha256,
    groupKeys: [...why.groupIds].sort(),
    anchors: sortCanonical(
      why.relevantLocations.map((location) => ({
        pathIdentity: location.path,
        blobOid: why.blob.objectId,
        byteRange: {
          start: location.byteOffset,
          end: location.byteOffset + location.byteLength,
        },
        termId: location.termId,
      })),
    ),
    why: why.why,
    protectedInvariant: why.protectedInvariant,
    reviewerQuestion: why.reviewerQuestion,
    answer: why.answer,
    semanticAuthor: why.semanticAuthor,
    readComplete: why.readComplete,
    semanticAssurance: why.semanticAssurance,
  };
}

function whyV3View(why: InvestigationWhyOverlayV3) {
  return {
    pathIdentity: why.pathIdentity,
    blobOid: why.blobOid,
    contentSha256: why.contentSha256,
    groupKeys: why.groupRefs.map(({ key }: { key: string }) => key).sort(),
    anchors: sortCanonical(why.anchors),
    why: why.why,
    protectedInvariant: why.protectedInvariant,
    reviewerQuestion: why.reviewerQuestion,
    answer: why.answer,
    semanticAuthor: why.semanticAuthor.id,
    readComplete: why.readComplete,
    semanticAssurance: why.semanticAssurance,
  };
}

function assertPersistedCommitments(
  draft: InvestigationManifestDraftV3,
  view: MaterializedEvidenceView,
): void {
  if (draft.applicability.kind !== 'ordinary') return;
  const replay = draft.applicability.replayContract;
  const semantic = draft.applicability.semanticDelta;
  const derived = draft.applicability.derivedCommitments;
  const pairs: Array<[unknown, unknown]> = [
    [replay.inventoryRoot, view.commitments.inventoryRoot],
    [replay.hitRoot, view.commitments.hitRoot],
    [replay.mechanicalGroupRoot, view.commitments.mechanicalGroupRoot],
    [semantic.finalGroupRoot, view.commitments.finalGroupRoot],
    [derived.coverageRoot, view.commitments.coverageRoot],
    [derived.zeroHitTermIds, view.commitments.zeroHitTermIds],
    [derived.finalGroupCount, view.commitments.finalGroupCount],
  ];
  if (
    pairs.some(([left, right]) => canonicalJson(left) !== canonicalJson(right))
  ) {
    throw parityFailure(
      'Persisted v3 commitments differ from its replay view.',
    );
  }
}

function sortCanonical<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function bareDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  if (/^sha256:[0-9a-f]{64}$/.test(value)) return value.slice(7);
  throw parityFailure('Shadow knowledge version digest is malformed.');
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parityFailure(message: string) {
  return workflowError(
    'INVESTIGATION_V3_SHADOW_MISMATCH',
    message,
    ExitCode.verification,
  );
}
