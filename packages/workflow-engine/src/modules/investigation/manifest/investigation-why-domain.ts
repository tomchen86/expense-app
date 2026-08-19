import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import type { InvestigationGroupRef } from '../domain/investigation-domain.ts';
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';
import type {
  InvestigationKnowledgeReuseDecision,
  InvestigationWhyOverlayV3,
} from './investigation-manifest.ts';
import type { MaterializedEvidenceView } from './investigation-materializer.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:([0-9a-f]{64})$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified' as const;

type PathIdentity = { rawBase64: string; utf8: string | null };

export type InvestigationV3WhyRequirement = {
  sourceKey: string;
  pathIdentity: PathIdentity;
  blobOid: string;
  contentSha256: string;
  groupRefs: InvestigationGroupRef[];
  hits: Array<{
    hitKey: string;
    termId: string;
    byteRange: { start: number; end: number };
  }>;
};

export type InvestigationV3WhyAnswerInput = {
  sourceKey: string;
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: InvestigationSemanticAuthor;
  readComplete: true;
};

export type InvestigationV3KnowledgeReuseInput = {
  sourceKey: string;
  knowledgeRef: { subjectId: string; versionDigest: string };
  freshness: {
    decision: 'fresh';
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    provenanceDigest: string;
  };
};

/**
 * Derive the exact load-bearing source obligations from the process-local v3
 * view. Full blob bytes and generic evidence envelopes are deliberately absent:
 * Git remains the source authority and byte ranges bind only current hits.
 */
export function deriveInvestigationV3WhyRequirements(
  view: MaterializedEvidenceView,
): InvestigationV3WhyRequirement[] {
  const hits = new Map(view.grouping.hits.map((hit) => [hit.hitKey, hit]));
  const requirements = new Map<
    string,
    {
      pathIdentity: PathIdentity;
      blobOid: string;
      contentSha256: string;
      groupRefs: Map<string, InvestigationGroupRef>;
      hits: Map<
        string,
        {
          hitKey: string;
          termId: string;
          byteRange: { start: number; end: number };
        }
      >;
    }
  >();
  for (const disposition of view.dispositions) {
    if (disposition.classification !== 'load-bearing') continue;
    for (const hitKey of disposition.coveredHitKeys) {
      const hit = hits.get(hitKey);
      if (
        hit === undefined ||
        hit.sourceObject.contentSha256 === null ||
        !GIT_OBJECT_ID.test(hit.sourceObject.objectId)
      ) {
        throw whyFailure(
          'SOURCE_ANCHOR_UNRESOLVED',
          'A load-bearing hit has no replayable Git blob source.',
        );
      }
      const sourceKey = investigationV3SourceKey(
        hit.path,
        hit.sourceObject.objectId,
      );
      let requirement = requirements.get(sourceKey);
      if (requirement === undefined) {
        requirement = {
          pathIdentity: structuredClone(hit.path),
          blobOid: hit.sourceObject.objectId,
          contentSha256: hit.sourceObject.contentSha256,
          groupRefs: new Map(),
          hits: new Map(),
        };
        requirements.set(sourceKey, requirement);
      }
      if (
        canonicalJson(requirement.pathIdentity) !== canonicalJson(hit.path) ||
        requirement.blobOid !== hit.sourceObject.objectId ||
        requirement.contentSha256 !== hit.sourceObject.contentSha256
      ) {
        throw whyFailure(
          'SOURCE_ANCHOR_UNRESOLVED',
          'One source key resolved to inconsistent Git object facts.',
        );
      }
      requirement.groupRefs.set(
        disposition.groupRef.key,
        structuredClone(disposition.groupRef),
      );
      requirement.hits.set(hitKey, {
        hitKey,
        termId: hit.termId,
        byteRange: {
          start: hit.byteOffset,
          end: hit.byteOffset + hit.byteLength,
        },
      });
    }
  }
  return [...requirements.entries()]
    .map(([sourceKey, requirement]) => ({
      sourceKey,
      pathIdentity: requirement.pathIdentity,
      blobOid: requirement.blobOid,
      contentSha256: requirement.contentSha256,
      groupRefs: [...requirement.groupRefs.values()].sort(
        (left, right) => left.index - right.index,
      ),
      hits: [...requirement.hits.values()].sort((left, right) =>
        left.hitKey.localeCompare(right.hitKey),
      ),
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

/** Bind exactly one fresh WHY or reusable-knowledge decision to every source. */
export function buildInvestigationV3WhyAuthoring(input: {
  view: MaterializedEvidenceView;
  answers: InvestigationV3WhyAnswerInput[];
  knowledgeReuse: InvestigationV3KnowledgeReuseInput[];
}): {
  whyOverlays: InvestigationWhyOverlayV3[];
  knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
} {
  const requirements = deriveInvestigationV3WhyRequirements(input.view);
  const bySource = new Map(
    requirements.map((entry) => [entry.sourceKey, entry]),
  );
  const answers = uniqueBySource(input.answers, 'WHY answers');
  const reuse = uniqueBySource(input.knowledgeReuse, 'knowledge reuse');
  const covered = new Set<string>();
  const whyOverlays: InvestigationWhyOverlayV3[] = [];
  const knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[] = [];

  for (const [sourceKey, answer] of answers) {
    const requirement = bySource.get(sourceKey);
    if (
      requirement === undefined ||
      reuse.has(sourceKey) ||
      answer.readComplete !== true
    ) {
      throw whyFailure(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'WHY answers must map one-to-one to current load-bearing sources.',
      );
    }
    covered.add(sourceKey);
    whyOverlays.push({
      overlayId: digest({ schema: 'investigation.why-overlay.v3', sourceKey }),
      pathIdentity: structuredClone(requirement.pathIdentity),
      blobOid: requirement.blobOid,
      contentSha256: requirement.contentSha256,
      groupRefs: structuredClone(requirement.groupRefs),
      anchors: requirement.hits.map((hit) => ({
        pathIdentity: structuredClone(requirement.pathIdentity),
        blobOid: requirement.blobOid,
        byteRange: structuredClone(hit.byteRange),
        termId: hit.termId,
      })),
      why: answer.why,
      protectedInvariant: answer.protectedInvariant,
      reviewerQuestion: answer.reviewerQuestion,
      answer: answer.answer,
      semanticAuthor: structuredClone(answer.semanticAuthor),
      readComplete: true,
      semanticAssurance: SEMANTIC_ASSURANCE,
    });
  }

  for (const [sourceKey, decision] of reuse) {
    const requirement = bySource.get(sourceKey);
    if (requirement === undefined || answers.has(sourceKey)) {
      throw whyFailure(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Knowledge reuse must map one-to-one to current load-bearing sources.',
      );
    }
    covered.add(sourceKey);
    knowledgeReuseDecisions.push({
      decisionId: digest({
        schema: 'investigation.knowledge-reuse-decision.v3',
        sourceKey,
        knowledgeRef: decision.knowledgeRef,
      }),
      pathIdentity: structuredClone(requirement.pathIdentity),
      blobOid: requirement.blobOid,
      knowledgeRef: {
        subjectId: decision.knowledgeRef.subjectId,
        versionDigest: bareDigest(decision.knowledgeRef.versionDigest),
      },
      freshness: {
        decision: 'fresh',
        rationale: decision.freshness.rationale,
        semanticAuthor: structuredClone(decision.freshness.semanticAuthor),
        provenanceDigest: bareDigest(decision.freshness.provenanceDigest),
      },
    });
  }
  if (covered.size !== requirements.length) {
    throw whyFailure(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Every load-bearing source requires exactly one WHY or fresh reuse decision.',
    );
  }
  return {
    whyOverlays: whyOverlays.sort((left, right) =>
      left.overlayId.localeCompare(right.overlayId),
    ),
    knowledgeReuseDecisions: knowledgeReuseDecisions.sort((left, right) =>
      left.decisionId.localeCompare(right.decisionId),
    ),
  };
}

export type LegacyWhyAuthoringRow = {
  manifestEntryId: string;
  path: PathIdentity;
  blob: { objectId: string; contentSha256: string };
};

export type LegacyWhyAuthoringAnswer = {
  manifestEntryId: string;
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: string;
  readComplete: boolean;
};

export type LegacyKnowledgeCarry = {
  manifestEntryId: string;
  subjectId: string;
  versionDigest: string;
  freshnessRationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

/**
 * Shadow-only bridge for checkpoints whose answer key is the v2 manifest row
 * digest. It resolves that key to a v3 source tuple, then drops every legacy
 * identifier before the direct Manifest writer is called.
 */
export function mapLegacyWhyAuthoringToV3Sources(input: {
  requirements: InvestigationV3WhyRequirement[];
  manifestRows: LegacyWhyAuthoringRow[];
  answers: LegacyWhyAuthoringAnswer[];
  carried: LegacyKnowledgeCarry[];
  checkpointProvenanceDigest: string;
}): {
  answers: InvestigationV3WhyAnswerInput[];
  knowledgeReuse: InvestigationV3KnowledgeReuseInput[];
} {
  const requirementByTuple = new Map(
    input.requirements.map((requirement) => [
      sourceTuple(requirement.pathIdentity, requirement.blobOid),
      requirement,
    ]),
  );
  if (requirementByTuple.size !== input.requirements.length) {
    throw whyFailure(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'v3 WHY requirements contain duplicate source tuples.',
    );
  }
  const sourceByLegacyId = new Map<string, string>();
  for (const row of input.manifestRows) {
    if (
      !DIGEST.test(row.manifestEntryId) ||
      sourceByLegacyId.has(row.manifestEntryId)
    ) {
      throw whyFailure(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Legacy WHY manifest rows are malformed or duplicated.',
      );
    }
    const requirement = requirementByTuple.get(
      sourceTuple(row.path, row.blob.objectId),
    );
    if (
      requirement === undefined ||
      requirement.contentSha256 !== row.blob.contentSha256 ||
      [...sourceByLegacyId.values()].includes(requirement.sourceKey)
    ) {
      throw whyFailure(
        'RECONSTRUCTION_MISMATCH',
        'Legacy WHY row does not map one-to-one to a current v3 source.',
      );
    }
    sourceByLegacyId.set(row.manifestEntryId, requirement.sourceKey);
  }
  if (sourceByLegacyId.size !== input.requirements.length) {
    throw whyFailure(
      'RECONSTRUCTION_MISMATCH',
      'Legacy WHY rows do not cover the complete current v3 source set.',
    );
  }
  const checkpointDigest = bareDigest(input.checkpointProvenanceDigest);
  return {
    answers: input.answers.map((answer) => {
      const sourceKey = sourceByLegacyId.get(answer.manifestEntryId);
      if (sourceKey === undefined || answer.readComplete !== true) {
        throw whyFailure(
          'SEMANTIC_COMPLETENESS_FAILURE',
          'Legacy WHY answer does not resolve to one current source.',
        );
      }
      return {
        sourceKey,
        why: answer.why,
        protectedInvariant: answer.protectedInvariant,
        reviewerQuestion: answer.reviewerQuestion,
        answer: answer.answer,
        semanticAuthor: {
          id: answer.semanticAuthor,
          provenance: `checkpoint:${checkpointDigest}`,
        },
        readComplete: true,
      };
    }),
    knowledgeReuse: input.carried.map((carry) => {
      const sourceKey = sourceByLegacyId.get(carry.manifestEntryId);
      if (sourceKey === undefined) {
        throw whyFailure(
          'SEMANTIC_COMPLETENESS_FAILURE',
          'Legacy knowledge carry does not resolve to one current source.',
        );
      }
      return {
        sourceKey,
        knowledgeRef: {
          subjectId: carry.subjectId,
          versionDigest: bareDigest(carry.versionDigest),
        },
        freshness: {
          decision: 'fresh',
          rationale: carry.freshnessRationale,
          semanticAuthor: structuredClone(carry.semanticAuthor),
          provenanceDigest: bareDigest(carry.provenanceDigest),
        },
      };
    }),
  };
}

export function investigationV3SourceKey(
  pathIdentity: PathIdentity,
  blobOid: string,
): string {
  return digest({
    schema: 'investigation.source-key.v3',
    pathIdentity,
    blobOid,
  });
}

function uniqueBySource<T extends { sourceKey: string }>(
  values: T[],
  label: string,
): Map<string, T> {
  if (!Array.isArray(values)) {
    throw whyFailure(
      'SEMANTIC_COMPLETENESS_FAILURE',
      `${label} are malformed.`,
    );
  }
  const result = new Map<string, T>();
  for (const value of values) {
    if (!DIGEST.test(value.sourceKey) || result.has(value.sourceKey)) {
      throw whyFailure(
        'SEMANTIC_COMPLETENESS_FAILURE',
        `${label} contain an invalid or duplicate source key.`,
      );
    }
    result.set(value.sourceKey, value);
  }
  return result;
}

function sourceTuple(pathIdentity: PathIdentity, blobOid: string): string {
  return canonicalJson({ pathIdentity, blobOid });
}

function bareDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  const prefixed = PREFIXED_DIGEST.exec(value);
  if (prefixed !== null) return prefixed[1]!;
  throw whyFailure(
    'SEMANTIC_COMPLETENESS_FAILURE',
    'WHY provenance or knowledge version digest is malformed.',
  );
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function whyFailure(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
