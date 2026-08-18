import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import type {
  AppliedInvestigationDisposition,
  InvestigationDispositionDecision,
  InvestigationGroupRef,
  InvestigationSemanticGroupDecision,
} from './investigation-domain.ts';
import { WorkflowError } from './errors.ts';
import type { FloorOverflowDecision } from './floor-overflow-pruning.ts';
import {
  createInvestigationApplicability,
  type InvestigationChangeClass,
  type InvestigationExemptionCategory,
  type InvestigationSemanticAuthor,
} from './investigation-applicability.ts';
import type {
  DeclaredInvestigationRoot,
  ReviewedPathRelationship,
} from './investigation-groups.ts';
import {
  INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
  INVESTIGATION_TERM_NORMALIZATION_VERSION,
} from './investigation-roots.ts';
import {
  materializeInvestigationEvidenceView,
  type InvestigationReplayAuthoringInput,
  type InvestigationScanSaturationDecision,
  type InvestigationV3Baseline,
  type MaterializedEvidenceView,
} from './investigation-materializer.ts';
import {
  normalizeInvestigationTerm,
  type InvestigationLimits,
  type InvestigationTermContribution,
  type PreviewInvestigationTerm,
} from './investigation-terms.ts';
import type { MutationClassPolicy } from './mutation-class-policy.ts';
import type { NormalizedChangeIntent } from './provider-invocation-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_TEXT_BYTES = 16 * 1024;
const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified' as const;

export const INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION = 3 as const;
export const INVESTIGATION_MANIFEST_V3_KIND =
  'manifest-first-investigation' as const;

export type InvestigationV3RoleResult = {
  role: 'blind-surveyor' | 'investigation-reviewer';
  targetDigest: string;
  providerId: string | null;
  sessionId: string | null;
  principalId: string | null;
  requiredIndependence: string;
  achievedIndependence: string;
  requestDigest: string;
  outputDigest: string;
  contentDigest: string;
  policyDigest: string;
  provenanceDigest: string;
};

export type InvestigationAssuranceFacts = {
  assessmentDigest: string;
  coverageTier: 'standard' | 'elevated' | 'critical';
  escalated: boolean;
  reasons: string[];
  provenanceDigest: string;
};

export type InvestigationSourceAnchor = {
  pathIdentity: { rawBase64: string; utf8: string | null };
  blobOid: string;
  byteRange: { start: number; end: number };
  termId: string;
};

export type InvestigationWhyOverlayV3 = {
  overlayId: string;
  pathIdentity: { rawBase64: string; utf8: string | null };
  blobOid: string;
  contentSha256: string;
  groupRefs: InvestigationGroupRef[];
  anchors: InvestigationSourceAnchor[];
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: InvestigationSemanticAuthor;
  readComplete: true;
  semanticAssurance: typeof SEMANTIC_ASSURANCE;
};

export type InvestigationKnowledgeReuseDecision = {
  decisionId: string;
  pathIdentity: { rawBase64: string; utf8: string | null };
  blobOid: string;
  knowledgeRef: {
    subjectId: string;
    versionDigest: string;
  };
  freshness: {
    decision: 'fresh';
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    provenanceDigest: string;
  };
};

export type InvestigationSemanticException = {
  exceptionId: string;
  kind: 'semantic-group' | 'disposition' | 'why' | 'knowledge-reuse';
  subjectKey: string;
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

export type InvestigationRequirementV3 = {
  requirementId: string;
  text: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

type CommonAuthoringState = {
  schemaVersion: 1;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  normalizedIntent: NormalizedChangeIntent;
  authoring: {
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
};

export type OrdinaryInvestigationAuthoringState = CommonAuthoringState & {
  applicabilityKind: 'ordinary';
  ordinary: InvestigationReplayAuthoringInput & {
    whyOverlays: InvestigationWhyOverlayV3[];
    knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
    investigationRoleResults: InvestigationV3RoleResult[];
    floorOverflowDecision: FloorOverflowDecision | null;
    exceptions: InvestigationSemanticException[];
    investigationRequirements: InvestigationRequirementV3[];
    assuranceFacts: InvestigationAssuranceFacts;
  };
};

export type ExemptionInvestigationAuthoringState = CommonAuthoringState & {
  applicabilityKind: 'exemption';
  exemption: {
    category: InvestigationExemptionCategory;
    baseline: InvestigationV3Baseline;
    declaredPaths: string[];
    declaredChangeClasses: InvestigationChangeClass[];
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    nonTrivialBehaviorReliance: 'none-declared';
    researchBudgetMinutes: number | null;
  };
};

export type InvestigationAuthoringState =
  OrdinaryInvestigationAuthoringState | ExemptionInvestigationAuthoringState;

type PersistedDisposition = Omit<
  AppliedInvestigationDisposition,
  'coveredHitKeys' | 'dispositionDigest'
> & {
  dispositionDigest: string;
};

export type InvestigationReplayContractV3 = {
  baseline: InvestigationV3Baseline;
  termContributions: InvestigationTermContribution[];
  canonicalTerms: PreviewInvestigationTerm[];
  termNormalizationVersion: typeof INVESTIGATION_TERM_NORMALIZATION_VERSION;
  termSetDigest: string;
  scanner: {
    evaluatorId: 'investigation-scanner.v1';
    policyDigest: string;
    canonicalizationVersion: 'investigation-scan-canonicalization.v1';
    limits: InvestigationLimits;
    allowSaturatedTerms: boolean;
  };
  grouping: {
    evaluatorId: 'investigation-groups.v1';
    policyDigest: string;
    canonicalizationVersion: 'investigation-mechanical-groups.v3';
    mutationPolicy: MutationClassPolicy;
    declaredRoots: DeclaredInvestigationRoot[];
    reviewedRelationships: ReviewedPathRelationship[];
  };
  coverage: {
    evaluatorId: 'investigation-coverage.v3';
    canonicalizationVersion: typeof INVESTIGATION_ROOT_CANONICALIZATION_VERSION;
  };
  inventoryRoot: string;
  hitRoot: string;
  mechanicalGroupRoot: string;
  counts: {
    terms: number;
    hits: number;
    mechanicalGroups: number;
  };
};

export type InvestigationSemanticDeltaV3 = {
  investigationRoleResults: InvestigationV3RoleResult[];
  scanSaturationDecision: InvestigationScanSaturationDecision | null;
  floorOverflowDecision: FloorOverflowDecision | null;
  semanticGroupDecisions: InvestigationSemanticGroupDecision[];
  finalGroupRoot: string;
  dispositions: PersistedDisposition[];
  whyOverlays: InvestigationWhyOverlayV3[];
  knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
  exceptions: InvestigationSemanticException[];
  investigationRequirements: InvestigationRequirementV3[];
  assuranceFacts: InvestigationAssuranceFacts;
};

export type OrdinaryInvestigationApplicabilityV3 = {
  kind: 'ordinary';
  replayContract: InvestigationReplayContractV3;
  semanticDelta: InvestigationSemanticDeltaV3;
  derivedCommitments: {
    coverageRoot: string;
    zeroHitTermIds: string[];
    finalGroupCount: number;
  };
};

export type ExemptionInvestigationApplicabilityV3 = {
  kind: 'exemption';
  category: InvestigationExemptionCategory;
  baseline: InvestigationV3Baseline;
  declaredPaths: string[];
  declaredChangeClasses: InvestigationChangeClass[];
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  nonTrivialBehaviorReliance: 'none-declared';
  researchBudgetMinutes: number | null;
  policyDigest: string;
  applicabilityDigest: string;
};

export type InvestigationApprovalV3 = {
  schemaVersion: 1;
  kind: 'investigation-approval';
  investigationTargetDigest: string;
  semanticAuthor: InvestigationSemanticAuthor;
  approvalProvenanceDigest: string;
  semanticAssurance: typeof SEMANTIC_ASSURANCE;
  sealDigest: string;
};

type ManifestIdentity = {
  schemaVersion: typeof INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION;
  kind: typeof INVESTIGATION_MANIFEST_V3_KIND;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  normalizedIntent: NormalizedChangeIntent;
  intentDigest: string;
  authoring: {
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
};

export type InvestigationManifestDraftV3 = ManifestIdentity & {
  applicability:
    | OrdinaryInvestigationApplicabilityV3
    | ExemptionInvestigationApplicabilityV3;
  investigationApproval: null;
  manifestDigest: null;
};

export type InvestigationManifestV3 = ManifestIdentity & {
  applicability:
    | OrdinaryInvestigationApplicabilityV3
    | ExemptionInvestigationApplicabilityV3;
  investigationApproval: InvestigationApprovalV3;
  manifestDigest: string;
};

export type InvestigationV3FailureCode =
  | 'SCHEMA_V1_FORBIDDEN'
  | 'TERM_INTEGRITY_MISMATCH'
  | 'REPLAY_INPUT_MISSING'
  | 'REPLAY_CLOSURE_UNSUPPORTED'
  | 'MANIFEST_UNREPRESENTABLE'
  | 'RECONSTRUCTION_MISMATCH'
  | 'SEMANTIC_COMPLETENESS_FAILURE'
  | 'SOURCE_ANCHOR_UNRESOLVED'
  | 'REVIEW_TARGET_STALE'
  | 'PROJECTION_PIPELINE_FORBIDDEN'
  | string;

export type InvestigationV3Blocker = {
  schemaVersion: 1;
  kind: 'investigation-v3-failure';
  failureIdentity: string;
  attemptedTransition:
    | 'build-draft'
    | 'draft-seal'
    | 'authority-validation'
    | 'historical-inspection'
    | 'publication';
  candidateDigest: string;
  failureCode: InvestigationV3FailureCode;
  detailsDigest: string;
  missingAssuranceFacts: string[];
};

/**
 * Structured v3 failure emitter. This is deliberately only a failure contract:
 * it issues, stores, consumes, or binds no continuation grant.
 */
export function createInvestigationV3Blocker(input: {
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'];
  candidate: unknown;
  failureCode: InvestigationV3FailureCode;
  message: string;
  details?: Record<string, unknown>;
}): InvestigationV3Blocker {
  return blockedWithCode(
    input.attemptedTransition,
    input.candidate,
    input.failureCode,
    input.message,
    input.details,
  ).blocker;
}

type BuiltResult =
  | { outcome: 'built'; draft: InvestigationManifestDraftV3 }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };
type VerifiedDraftResult =
  | {
      outcome: 'verified';
      draft: InvestigationManifestDraftV3;
      applicabilityContentDigest: string;
      investigationTargetDigest: string;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };
type SealedResult =
  | { outcome: 'sealed'; manifest: InvestigationManifestV3 }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };
type AuthorityValidationResult =
  | {
      outcome: 'verified';
      manifest: InvestigationManifestV3;
      manifestDigest: string;
      investigationTargetDigest: string;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

export function buildInvestigationManifestDraft(input: {
  repositoryRoot: string;
  state: InvestigationAuthoringState;
}): BuiltResult {
  try {
    const identity = normalizeAuthoringIdentity(input.state);
    const intentDigest = digest(identity.normalizedIntent);
    const applicability =
      input.state.applicabilityKind === 'ordinary'
        ? buildOrdinaryApplicability(input.repositoryRoot, input.state)
        : buildExemptionApplicability(input.state, intentDigest);
    return {
      outcome: 'built',
      draft: deepFreeze({
        schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
        kind: INVESTIGATION_MANIFEST_V3_KIND,
        repositoryId: identity.repositoryId,
        changeId: identity.changeId,
        investigationId: identity.investigationId,
        normalizedIntent: identity.normalizedIntent,
        intentDigest,
        authoring: identity.authoring,
        applicability,
        investigationApproval: null,
        manifestDigest: null,
      }),
    };
  } catch (error) {
    return blocked('build-draft', input.state, error);
  }
}

export function validateDraftForSeal(input: {
  repositoryRoot: string;
  draft: unknown;
}): VerifiedDraftResult {
  try {
    const draft = parseDraft(input.repositoryRoot, input.draft);
    const applicabilityContentDigest = digestWithDomain(
      'investigation-applicability-content/v3',
      draft.applicability,
    );
    return {
      outcome: 'verified',
      draft,
      applicabilityContentDigest,
      investigationTargetDigest: investigationTargetDigest(
        draft,
        applicabilityContentDigest,
      ),
    };
  } catch (error) {
    return blocked('draft-seal', input.draft, error);
  }
}

export function sealInvestigationManifestDraft(input: {
  draft: InvestigationManifestDraftV3;
  approval: {
    semanticAuthor: InvestigationSemanticAuthor;
    approvalProvenanceDigest: string;
  };
}): SealedResult {
  try {
    assertDraftShape(input.draft);
    const semanticAuthor = normalizeSemanticAuthor(
      input.approval.semanticAuthor,
    );
    assertDigest(input.approval.approvalProvenanceDigest);
    const applicabilityContentDigest = digestWithDomain(
      'investigation-applicability-content/v3',
      input.draft.applicability,
    );
    const targetDigest = investigationTargetDigest(
      input.draft,
      applicabilityContentDigest,
    );
    const approvalWithoutSeal = {
      schemaVersion: 1 as const,
      kind: 'investigation-approval' as const,
      investigationTargetDigest: targetDigest,
      semanticAuthor,
      approvalProvenanceDigest: input.approval.approvalProvenanceDigest,
      semanticAssurance: SEMANTIC_ASSURANCE,
    };
    const investigationApproval = {
      ...approvalWithoutSeal,
      sealDigest: digestWithDomain(
        'investigation-approval-seal/v3',
        approvalWithoutSeal,
      ),
    };
    const withoutManifestDigest = {
      ...input.draft,
      investigationApproval,
      manifestDigest: undefined,
    };
    delete (withoutManifestDigest as { manifestDigest?: unknown })
      .manifestDigest;
    const manifestDigest = digestWithDomain(
      'investigation-manifest/v3',
      withoutManifestDigest,
    );
    return {
      outcome: 'sealed',
      manifest: deepFreeze({
        ...input.draft,
        investigationApproval,
        manifestDigest,
      }),
    };
  } catch (error) {
    return blocked('draft-seal', input.draft, error);
  }
}

export function validateForAuthority(input: {
  repositoryRoot: string;
  manifest: unknown;
  expected: {
    repositoryId: string;
    changeId: string;
    investigationId: string;
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
}): AuthorityValidationResult {
  if (isRecord(input.manifest) && input.manifest.schemaVersion === 1) {
    return blockedWithCode(
      'authority-validation',
      input.manifest,
      'SCHEMA_V1_FORBIDDEN',
      'Schema v1 cannot satisfy the v3 authority boundary.',
    );
  }
  try {
    const manifest = parseFinalManifest(input.repositoryRoot, input.manifest);
    if (
      manifest.repositoryId !== input.expected.repositoryId ||
      manifest.changeId !== input.expected.changeId ||
      manifest.investigationId !== input.expected.investigationId ||
      manifest.authoring.sessionRevision !== input.expected.sessionRevision ||
      manifest.authoring.sessionSnapshotDigest !==
        input.expected.sessionSnapshotDigest
    ) {
      throw new ManifestValidationError(
        'REVIEW_TARGET_STALE',
        'Manifest identity no longer matches the lifecycle authority snapshot.',
      );
    }
    return {
      outcome: 'verified',
      manifest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
    };
  } catch (error) {
    return blocked('authority-validation', input.manifest, error);
  }
}

export function inspectHistorical(input: {
  repositoryRoot: string;
  manifest: unknown;
}):
  | {
      outcome: 'inspected';
      authorityEligible: false;
      manifestDigest: string;
    }
  | {
      outcome: 'historicalReplayUnavailable';
      authorityEligible: false;
      manifestDigest: string | null;
      reasonCode: string;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  try {
    const manifest = parseFinalManifest(input.repositoryRoot, input.manifest);
    return {
      outcome: 'inspected',
      authorityEligible: false,
      manifestDigest: manifest.manifestDigest,
    };
  } catch (error) {
    const code = failureCode(error);
    if (
      code === 'REPLAY_INPUT_MISSING' ||
      code === 'REPLAY_CLOSURE_UNSUPPORTED'
    ) {
      return {
        outcome: 'historicalReplayUnavailable',
        authorityEligible: false,
        manifestDigest:
          isRecord(input.manifest) &&
          typeof input.manifest.manifestDigest === 'string'
            ? input.manifest.manifestDigest
            : null,
        reasonCode: code,
      };
    }
    return blocked('historical-inspection', input.manifest, error);
  }
}

function buildOrdinaryApplicability(
  repositoryRoot: string,
  state: OrdinaryInvestigationAuthoringState,
): OrdinaryInvestigationApplicabilityV3 {
  const termContributions = [...state.ordinary.termContributions]
    .map((value) => structuredClone(value))
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  const semanticGroupDecisions = normalizeSemanticGroupDecisions(
    state.ordinary.semanticGroupDecisions,
  );
  const dispositionDecisions = normalizeDispositionDecisions(
    state.ordinary.dispositionDecisions,
  );
  const replayAuthoring: InvestigationReplayAuthoringInput = {
    baseline: normalizeBaseline(state.ordinary.baseline),
    termContributions,
    canonicalTerms: structuredClone(state.ordinary.canonicalTerms),
    scanner: {
      ...(state.ordinary.scanner.limits === undefined
        ? {}
        : { limits: structuredClone(state.ordinary.scanner.limits) }),
      allowSaturatedTerms: state.ordinary.scanner.allowSaturatedTerms === true,
      saturationDecision: normalizeSaturationDecision(
        state.ordinary.scanner.saturationDecision,
      ),
    },
    grouping: {
      mutationPolicy: structuredClone(state.ordinary.grouping.mutationPolicy),
      declaredRoots: [...state.ordinary.grouping.declaredRoots]
        .map((value) => structuredClone(value))
        .sort((left, right) => left.rootId.localeCompare(right.rootId)),
      reviewedRelationships: [...state.ordinary.grouping.reviewedRelationships]
        .map((value) => structuredClone(value))
        .sort((left, right) =>
          left.relationshipId.localeCompare(right.relationshipId),
        ),
    },
    semanticGroupDecisions,
    dispositionDecisions,
  };
  assertIntentFloor(state.normalizedIntent, replayAuthoring.canonicalTerms);
  const view = materializeInvestigationEvidenceView({
    repositoryRoot,
    authoring: replayAuthoring,
  });
  const investigationRoleResults = normalizeRoleResults(
    state.ordinary.investigationRoleResults,
  );
  if (!investigationRoleResults.some(({ role }) => role === 'blind-surveyor')) {
    throw new ManifestValidationError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Ordinary investigation requires an admitted blind-surveyor result.',
    );
  }
  const whyOverlays = normalizeWhyOverlays(state.ordinary.whyOverlays);
  const knowledgeReuseDecisions = normalizeKnowledgeReuseDecisions(
    state.ordinary.knowledgeReuseDecisions,
  );
  validateWhyCoverage(view, whyOverlays, knowledgeReuseDecisions);
  const exceptions = normalizeExceptions(state.ordinary.exceptions);
  const investigationRequirements = normalizeRequirements(
    state.ordinary.investigationRequirements,
  );
  const assuranceFacts = normalizeAssuranceFacts(state.ordinary.assuranceFacts);
  const floorOverflowDecision = normalizeFloorOverflowDecision(
    state.ordinary.floorOverflowDecision,
  );
  const persistedDispositions = persistedDispositionsFrom(view.dispositions);

  return deepFreeze({
    kind: 'ordinary',
    replayContract: {
      baseline: replayAuthoring.baseline,
      termContributions,
      canonicalTerms: view.canonicalTerms,
      termNormalizationVersion: INVESTIGATION_TERM_NORMALIZATION_VERSION,
      termSetDigest: view.termSetDigest,
      scanner: {
        evaluatorId: 'investigation-scanner.v1',
        policyDigest: view.scanFacts.policyDigest,
        canonicalizationVersion: 'investigation-scan-canonicalization.v1',
        limits: view.limits,
        allowSaturatedTerms: replayAuthoring.scanner.allowSaturatedTerms,
      },
      grouping: {
        evaluatorId: 'investigation-groups.v1',
        policyDigest: view.grouping.groupingPolicyDigest,
        canonicalizationVersion: 'investigation-mechanical-groups.v3',
        mutationPolicy: replayAuthoring.grouping.mutationPolicy,
        declaredRoots: replayAuthoring.grouping.declaredRoots,
        reviewedRelationships: replayAuthoring.grouping.reviewedRelationships,
      },
      coverage: {
        evaluatorId: 'investigation-coverage.v3',
        canonicalizationVersion: INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
      },
      inventoryRoot: view.commitments.inventoryRoot,
      hitRoot: view.commitments.hitRoot,
      mechanicalGroupRoot: view.commitments.mechanicalGroupRoot,
      counts: {
        terms: view.canonicalTerms.length,
        hits: view.commitments.hitCount,
        mechanicalGroups: view.commitments.mechanicalGroupCount,
      },
    },
    semanticDelta: {
      investigationRoleResults,
      scanSaturationDecision: replayAuthoring.scanner.saturationDecision,
      floorOverflowDecision,
      semanticGroupDecisions,
      finalGroupRoot: view.commitments.finalGroupRoot,
      dispositions: persistedDispositions,
      whyOverlays,
      knowledgeReuseDecisions,
      exceptions,
      investigationRequirements,
      assuranceFacts,
    },
    derivedCommitments: {
      coverageRoot: view.commitments.coverageRoot,
      zeroHitTermIds: view.commitments.zeroHitTermIds,
      finalGroupCount: view.commitments.finalGroupCount,
    },
  });
}

function buildExemptionApplicability(
  state: ExemptionInvestigationAuthoringState,
  intentDigest: string,
): ExemptionInvestigationApplicabilityV3 {
  const baseline = normalizeBaseline(state.exemption.baseline);
  const applicability = createInvestigationApplicability({
    kind: 'investigation-exemption',
    category: state.exemption.category,
    baseline: { head: baseline.commitOid, tree: baseline.treeOid },
    intentDigest,
    declaredPaths: structuredClone(state.exemption.declaredPaths),
    declaredChangeClasses: structuredClone(
      state.exemption.declaredChangeClasses,
    ),
    rationale: state.exemption.rationale,
    semanticAuthor: structuredClone(state.exemption.semanticAuthor),
    nonTrivialBehaviorReliance: state.exemption.nonTrivialBehaviorReliance,
    researchBudgetMinutes: state.exemption.researchBudgetMinutes,
  });
  if (applicability.kind !== 'investigation-exemption') {
    throw new ManifestValidationError(
      'MANIFEST_UNREPRESENTABLE',
      'Exemption applicability normalization selected the wrong branch.',
    );
  }
  return deepFreeze({
    kind: 'exemption',
    category: applicability.category,
    baseline,
    declaredPaths: [...applicability.declaredPaths],
    declaredChangeClasses: [...applicability.declaredChangeClasses],
    rationale: applicability.rationale,
    semanticAuthor: applicability.semanticAuthor,
    nonTrivialBehaviorReliance: applicability.nonTrivialBehaviorReliance,
    researchBudgetMinutes: applicability.researchBudgetMinutes,
    policyDigest: applicability.policyDigest,
    applicabilityDigest: applicability.applicabilityDigest,
  });
}

function parseDraft(
  repositoryRoot: string,
  value: unknown,
): InvestigationManifestDraftV3 {
  const record = assertManifestTop(value);
  if (record.investigationApproval !== null || record.manifestDigest !== null) {
    throw unrepresentable('Draft contains final approval state.');
  }
  const identity = parseManifestIdentity(record);
  const applicability = parseApplicability(
    repositoryRoot,
    identity,
    record.applicability,
  );
  return deepFreeze({
    ...identity,
    applicability,
    investigationApproval: null,
    manifestDigest: null,
  });
}

function parseFinalManifest(
  repositoryRoot: string,
  value: unknown,
): InvestigationManifestV3 {
  const record = assertManifestTop(value);
  const identity = parseManifestIdentity(record);
  const applicability = parseApplicability(
    repositoryRoot,
    identity,
    record.applicability,
  );
  const draft: InvestigationManifestDraftV3 = {
    ...identity,
    applicability,
    investigationApproval: null,
    manifestDigest: null,
  };
  const approval = parseApproval(record.investigationApproval);
  const applicabilityContentDigest = digestWithDomain(
    'investigation-applicability-content/v3',
    applicability,
  );
  const targetDigest = investigationTargetDigest(
    draft,
    applicabilityContentDigest,
  );
  if (approval.investigationTargetDigest !== targetDigest) {
    throw new ManifestValidationError(
      'REVIEW_TARGET_STALE',
      'Investigation approval targets different Manifest content.',
    );
  }
  const approvalWithoutSeal = { ...approval };
  delete (approvalWithoutSeal as { sealDigest?: unknown }).sealDigest;
  if (
    approval.sealDigest !==
    digestWithDomain('investigation-approval-seal/v3', approvalWithoutSeal)
  ) {
    throw new ManifestValidationError(
      'RECONSTRUCTION_MISMATCH',
      'Investigation approval seal does not match recomputation.',
    );
  }
  if (typeof record.manifestDigest !== 'string') {
    throw unrepresentable('Final Manifest digest is absent.');
  }
  assertDigest(record.manifestDigest);
  const withoutManifestDigest = {
    ...identity,
    applicability,
    investigationApproval: approval,
  };
  const expectedManifestDigest = digestWithDomain(
    'investigation-manifest/v3',
    withoutManifestDigest,
  );
  if (record.manifestDigest !== expectedManifestDigest) {
    throw new ManifestValidationError(
      'RECONSTRUCTION_MISMATCH',
      'Manifest digest does not match the exact final Manifest.',
    );
  }
  return deepFreeze({
    ...withoutManifestDigest,
    manifestDigest: expectedManifestDigest,
  });
}

function parseApplicability(
  repositoryRoot: string,
  identity: ManifestIdentity,
  value: unknown,
):
  OrdinaryInvestigationApplicabilityV3 | ExemptionInvestigationApplicabilityV3 {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw unrepresentable('Manifest applicability branch is malformed.');
  }
  if (value.kind === 'exemption') {
    assertExactKeys(value, [
      'kind',
      'category',
      'baseline',
      'declaredPaths',
      'declaredChangeClasses',
      'rationale',
      'semanticAuthor',
      'nonTrivialBehaviorReliance',
      'researchBudgetMinutes',
      'policyDigest',
      'applicabilityDigest',
    ]);
    const state: ExemptionInvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: identity.repositoryId,
      changeId: identity.changeId,
      investigationId: identity.investigationId,
      normalizedIntent: identity.normalizedIntent,
      authoring: identity.authoring,
      exemption: {
        category: value.category as InvestigationExemptionCategory,
        baseline: value.baseline as InvestigationV3Baseline,
        declaredPaths: value.declaredPaths as string[],
        declaredChangeClasses:
          value.declaredChangeClasses as InvestigationChangeClass[],
        rationale: value.rationale as string,
        semanticAuthor: value.semanticAuthor as InvestigationSemanticAuthor,
        nonTrivialBehaviorReliance:
          value.nonTrivialBehaviorReliance as 'none-declared',
        researchBudgetMinutes: value.researchBudgetMinutes as number | null,
      },
    };
    const rebuilt = buildExemptionApplicability(state, identity.intentDigest);
    if (canonicalJson(rebuilt) !== canonicalJson(value)) {
      throw new ManifestValidationError(
        'RECONSTRUCTION_MISMATCH',
        'Exemption applicability does not match recomputation.',
      );
    }
    return rebuilt;
  }
  if (value.kind !== 'ordinary') {
    throw unrepresentable('Unknown Manifest applicability branch.');
  }
  assertExactKeys(value, [
    'kind',
    'replayContract',
    'semanticDelta',
    'derivedCommitments',
  ]);
  const replay = assertOrdinaryReplayShape(value.replayContract);
  const semantic = assertSemanticDeltaShape(value.semanticDelta);
  assertDerivedCommitmentsShape(value.derivedCommitments);
  const state: OrdinaryInvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'ordinary',
    repositoryId: identity.repositoryId,
    changeId: identity.changeId,
    investigationId: identity.investigationId,
    normalizedIntent: identity.normalizedIntent,
    authoring: identity.authoring,
    ordinary: {
      baseline: replay.baseline as InvestigationV3Baseline,
      termContributions:
        replay.termContributions as InvestigationTermContribution[],
      canonicalTerms: replay.canonicalTerms as PreviewInvestigationTerm[],
      scanner: {
        limits: replay.scanner.limits as InvestigationLimits,
        allowSaturatedTerms: replay.scanner.allowSaturatedTerms as boolean,
        saturationDecision:
          semantic.scanSaturationDecision as InvestigationScanSaturationDecision | null,
      },
      grouping: {
        mutationPolicy: replay.grouping.mutationPolicy as MutationClassPolicy,
        declaredRoots: replay.grouping
          .declaredRoots as DeclaredInvestigationRoot[],
        reviewedRelationships: replay.grouping
          .reviewedRelationships as ReviewedPathRelationship[],
      },
      semanticGroupDecisions:
        semantic.semanticGroupDecisions as InvestigationSemanticGroupDecision[],
      dispositionDecisions: persistedToDispositionDecisions(
        semantic.dispositions,
      ),
      whyOverlays: semantic.whyOverlays as InvestigationWhyOverlayV3[],
      knowledgeReuseDecisions:
        semantic.knowledgeReuseDecisions as InvestigationKnowledgeReuseDecision[],
      investigationRoleResults:
        semantic.investigationRoleResults as InvestigationV3RoleResult[],
      floorOverflowDecision:
        semantic.floorOverflowDecision as FloorOverflowDecision | null,
      exceptions: semantic.exceptions as InvestigationSemanticException[],
      investigationRequirements:
        semantic.investigationRequirements as InvestigationRequirementV3[],
      assuranceFacts: semantic.assuranceFacts as InvestigationAssuranceFacts,
    },
  };
  const rebuilt = buildOrdinaryApplicability(repositoryRoot, state);
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw new ManifestValidationError(
      'RECONSTRUCTION_MISMATCH',
      'Ordinary Manifest does not match exact Git-backed replay.',
    );
  }
  return rebuilt;
}

type ParsedReplayShape = Record<string, unknown> & {
  baseline: unknown;
  termContributions: unknown;
  canonicalTerms: unknown;
  scanner: Record<string, unknown>;
  grouping: Record<string, unknown>;
};

type ParsedSemanticShape = Record<string, unknown> & {
  investigationRoleResults: unknown;
  scanSaturationDecision: unknown;
  floorOverflowDecision: unknown;
  semanticGroupDecisions: unknown;
  dispositions: unknown;
  whyOverlays: unknown;
  knowledgeReuseDecisions: unknown;
  exceptions: unknown;
  investigationRequirements: unknown;
  assuranceFacts: unknown;
};

function assertOrdinaryReplayShape(value: unknown): ParsedReplayShape {
  const replay = assertRecord(value);
  assertExactKeys(replay, [
    'baseline',
    'termContributions',
    'canonicalTerms',
    'termNormalizationVersion',
    'termSetDigest',
    'scanner',
    'grouping',
    'coverage',
    'inventoryRoot',
    'hitRoot',
    'mechanicalGroupRoot',
    'counts',
  ]);
  const scanner = assertRecord(replay.scanner);
  assertExactKeys(scanner, [
    'evaluatorId',
    'policyDigest',
    'canonicalizationVersion',
    'limits',
    'allowSaturatedTerms',
  ]);
  const grouping = assertRecord(replay.grouping);
  assertExactKeys(grouping, [
    'evaluatorId',
    'policyDigest',
    'canonicalizationVersion',
    'mutationPolicy',
    'declaredRoots',
    'reviewedRelationships',
  ]);
  const coverage = assertRecord(replay.coverage);
  assertExactKeys(coverage, ['evaluatorId', 'canonicalizationVersion']);
  const counts = assertRecord(replay.counts);
  assertExactKeys(counts, ['terms', 'hits', 'mechanicalGroups']);
  return { ...replay, scanner, grouping } as ParsedReplayShape;
}

function assertSemanticDeltaShape(value: unknown): ParsedSemanticShape {
  const semantic = assertRecord(value);
  assertExactKeys(semantic, [
    'investigationRoleResults',
    'scanSaturationDecision',
    'floorOverflowDecision',
    'semanticGroupDecisions',
    'finalGroupRoot',
    'dispositions',
    'whyOverlays',
    'knowledgeReuseDecisions',
    'exceptions',
    'investigationRequirements',
    'assuranceFacts',
  ]);
  return semantic as ParsedSemanticShape;
}

function assertDerivedCommitmentsShape(value: unknown): void {
  const derived = assertRecord(value);
  assertExactKeys(derived, [
    'coverageRoot',
    'zeroHitTermIds',
    'finalGroupCount',
  ]);
}

function persistedDispositionsFrom(
  dispositions: AppliedInvestigationDisposition[],
): PersistedDisposition[] {
  return dispositions.map(
    ({ coveredHitKeys: _coveredHitKeys, ...disposition }) => disposition,
  );
}

function persistedToDispositionDecisions(
  value: unknown,
): InvestigationDispositionDecision[] {
  if (!Array.isArray(value)) {
    throw unrepresentable('Persisted dispositions are malformed.');
  }
  return value.map((entry) => {
    const record = assertRecord(entry);
    assertExactKeys(record, [
      'groupRef',
      'classification',
      'rationale',
      'semanticAuthor',
      'dispositionDigest',
    ]);
    const groupRef = normalizeGroupRef(record.groupRef);
    assertDigest(record.dispositionDigest);
    return {
      groupKey: groupRef.key,
      classification: record.classification as string,
      rationale: record.rationale as string,
      semanticAuthor: record.semanticAuthor as InvestigationSemanticAuthor,
    };
  });
}

function normalizeSemanticGroupDecisions(
  values: InvestigationSemanticGroupDecision[],
): InvestigationSemanticGroupDecision[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Semantic Group decisions are malformed.');
  }
  return values
    .map((value) => {
      const record = assertRecord(value);
      assertExactKeys(record, [
        'decisionId',
        'key',
        'title',
        'sourceMechanicalGroupKeys',
        'hitKeys',
        'rationale',
        'semanticAuthor',
      ]);
      return {
        decisionId: boundedText(record.decisionId, 'semantic decision ID'),
        key: boundedText(record.key, 'semantic Group key'),
        title: boundedText(record.title, 'semantic Group title'),
        sourceMechanicalGroupKeys: normalizeDigestArray(
          record.sourceMechanicalGroupKeys,
          false,
        ),
        hitKeys: normalizeDigestArray(record.hitKeys, false),
        rationale: boundedText(record.rationale, 'semantic Group rationale'),
        semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      };
    })
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

function normalizeDispositionDecisions(
  values: InvestigationDispositionDecision[],
): InvestigationDispositionDecision[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Disposition decisions are malformed.');
  }
  return values
    .map((value) => {
      const record = assertRecord(value);
      assertExactKeys(record, [
        'groupKey',
        'classification',
        'rationale',
        'semanticAuthor',
      ]);
      return {
        groupKey: boundedText(record.groupKey, 'Disposition Group key'),
        classification: boundedText(
          record.classification,
          'Disposition classification',
        ),
        rationale: boundedText(record.rationale, 'Disposition rationale'),
        semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      };
    })
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

function normalizeSaturationDecision(
  value: InvestigationScanSaturationDecision | null,
): InvestigationScanSaturationDecision | null {
  if (value === null) return null;
  const record = assertRecord(value);
  assertExactKeys(record, [
    'saturatedTermIds',
    'acknowledgeIncompleteScan',
    'rationale',
    'semanticAuthor',
    'provenanceDigest',
  ]);
  if (record.acknowledgeIncompleteScan !== true) {
    throw unrepresentable('Scan saturation acknowledgement is malformed.');
  }
  assertDigest(record.provenanceDigest);
  return {
    saturatedTermIds: normalizeDigestArray(record.saturatedTermIds, false),
    acknowledgeIncompleteScan: true,
    rationale: boundedText(record.rationale, 'saturation rationale'),
    semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
    provenanceDigest: record.provenanceDigest,
  };
}

function normalizeRoleResults(
  values: InvestigationV3RoleResult[],
): InvestigationV3RoleResult[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Investigation role results are malformed.');
  }
  const results = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'role',
      'targetDigest',
      'providerId',
      'sessionId',
      'principalId',
      'requiredIndependence',
      'achievedIndependence',
      'requestDigest',
      'outputDigest',
      'contentDigest',
      'policyDigest',
      'provenanceDigest',
    ]);
    if (
      record.role !== 'blind-surveyor' &&
      record.role !== 'investigation-reviewer'
    ) {
      throw unrepresentable('Investigation role is not investigation-owned.');
    }
    for (const key of [
      'targetDigest',
      'requestDigest',
      'outputDigest',
      'contentDigest',
      'policyDigest',
      'provenanceDigest',
    ]) {
      assertDigest(record[key]);
    }
    return {
      role: record.role,
      targetDigest: record.targetDigest as string,
      providerId: nullableText(record.providerId, 'provider ID'),
      sessionId: nullableText(record.sessionId, 'provider session ID'),
      principalId: nullableText(record.principalId, 'provider principal ID'),
      requiredIndependence: boundedText(
        record.requiredIndependence,
        'required independence',
      ),
      achievedIndependence: boundedText(
        record.achievedIndependence,
        'achieved independence',
      ),
      requestDigest: record.requestDigest as string,
      outputDigest: record.outputDigest as string,
      contentDigest: record.contentDigest as string,
      policyDigest: record.policyDigest as string,
      provenanceDigest: record.provenanceDigest as string,
    } satisfies InvestigationV3RoleResult;
  });
  const sorted = results.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  if (
    new Set(sorted.map((result) => canonicalJson(result))).size !==
    sorted.length
  ) {
    throw unrepresentable('Investigation role results contain duplicates.');
  }
  return sorted;
}

function normalizeAssuranceFacts(
  value: InvestigationAssuranceFacts,
): InvestigationAssuranceFacts {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'assessmentDigest',
    'coverageTier',
    'escalated',
    'reasons',
    'provenanceDigest',
  ]);
  assertDigest(record.assessmentDigest);
  assertDigest(record.provenanceDigest);
  if (
    record.coverageTier !== 'standard' &&
    record.coverageTier !== 'elevated' &&
    record.coverageTier !== 'critical'
  ) {
    throw unrepresentable('Assurance coverage tier is malformed.');
  }
  if (typeof record.escalated !== 'boolean') {
    throw unrepresentable('Assurance escalation is malformed.');
  }
  return {
    assessmentDigest: record.assessmentDigest as string,
    coverageTier: record.coverageTier,
    escalated: record.escalated,
    reasons: normalizeTextArray(record.reasons),
    provenanceDigest: record.provenanceDigest as string,
  };
}

function normalizeFloorOverflowDecision(
  value: FloorOverflowDecision | null,
): FloorOverflowDecision | null {
  if (value === null) return null;
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'limit',
    'retainedLimit',
    'reservedNonFloorTerms',
    'observed',
    'escalated',
    'reasons',
    'dropped',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'floor-overflow-decision' ||
    !Number.isSafeInteger(record.limit) ||
    !Number.isSafeInteger(record.retainedLimit) ||
    !Number.isSafeInteger(record.reservedNonFloorTerms) ||
    !Number.isSafeInteger(record.observed) ||
    record.escalated !== true ||
    !Array.isArray(record.dropped)
  ) {
    throw unrepresentable('Floor-overflow decision is malformed.');
  }
  for (const dropped of record.dropped) {
    const entry = assertRecord(dropped);
    assertExactKeys(entry, ['termId', 'kind', 'value', 'reason']);
    assertDigest(entry.termId);
    boundedText(entry.kind, 'floor term kind');
    boundedText(entry.value, 'floor term value');
    boundedText(entry.reason, 'floor drop reason');
  }
  normalizeTextArray(record.reasons);
  return structuredClone(value);
}

function normalizeWhyOverlays(
  values: InvestigationWhyOverlayV3[],
): InvestigationWhyOverlayV3[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('WHY overlays are malformed.');
  }
  const overlays = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'overlayId',
      'pathIdentity',
      'blobOid',
      'contentSha256',
      'groupRefs',
      'anchors',
      'why',
      'protectedInvariant',
      'reviewerQuestion',
      'answer',
      'semanticAuthor',
      'readComplete',
      'semanticAssurance',
    ]);
    if (
      record.readComplete !== true ||
      record.semanticAssurance !== SEMANTIC_ASSURANCE ||
      !Array.isArray(record.groupRefs) ||
      !Array.isArray(record.anchors) ||
      record.anchors.length === 0
    ) {
      throw unrepresentable('WHY overlay attestation is malformed.');
    }
    assertGitObjectId(record.blobOid);
    assertDigest(record.contentSha256);
    return {
      overlayId: boundedText(record.overlayId, 'WHY overlay ID'),
      pathIdentity: normalizePathIdentity(record.pathIdentity),
      blobOid: record.blobOid as string,
      contentSha256: record.contentSha256 as string,
      groupRefs: record.groupRefs
        .map(normalizeGroupRef)
        .sort((left, right) => left.index - right.index),
      anchors: record.anchors
        .map(normalizeSourceAnchor)
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      why: boundedText(record.why, 'WHY explanation'),
      protectedInvariant: boundedText(
        record.protectedInvariant,
        'protected invariant',
      ),
      reviewerQuestion: boundedText(
        record.reviewerQuestion,
        'reviewer question',
      ),
      answer: boundedText(record.answer, 'reviewer answer'),
      semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      readComplete: true as const,
      semanticAssurance: SEMANTIC_ASSURANCE,
    };
  });
  const sorted = overlays.sort((left, right) =>
    left.overlayId.localeCompare(right.overlayId),
  );
  assertUnique(
    sorted.map(({ overlayId }) => overlayId),
    'WHY overlay IDs',
  );
  return sorted;
}

function normalizeKnowledgeReuseDecisions(
  values: InvestigationKnowledgeReuseDecision[],
): InvestigationKnowledgeReuseDecision[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Knowledge-reuse decisions are malformed.');
  }
  const decisions = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'decisionId',
      'pathIdentity',
      'blobOid',
      'knowledgeRef',
      'freshness',
    ]);
    const knowledgeRef = assertRecord(record.knowledgeRef);
    assertExactKeys(knowledgeRef, ['subjectId', 'versionDigest']);
    assertDigest(knowledgeRef.versionDigest);
    const freshness = assertRecord(record.freshness);
    assertExactKeys(freshness, [
      'decision',
      'rationale',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    if (freshness.decision !== 'fresh') {
      throw unrepresentable('Knowledge reuse is not explicitly fresh.');
    }
    assertGitObjectId(record.blobOid);
    assertDigest(freshness.provenanceDigest);
    return {
      decisionId: boundedText(record.decisionId, 'knowledge decision ID'),
      pathIdentity: normalizePathIdentity(record.pathIdentity),
      blobOid: record.blobOid as string,
      knowledgeRef: {
        subjectId: boundedText(knowledgeRef.subjectId, 'knowledge subject ID'),
        versionDigest: knowledgeRef.versionDigest as string,
      },
      freshness: {
        decision: 'fresh' as const,
        rationale: boundedText(
          freshness.rationale,
          'knowledge freshness rationale',
        ),
        semanticAuthor: normalizeSemanticAuthor(freshness.semanticAuthor),
        provenanceDigest: freshness.provenanceDigest as string,
      },
    };
  });
  const sorted = decisions.sort((left, right) =>
    left.decisionId.localeCompare(right.decisionId),
  );
  assertUnique(
    sorted.map(({ decisionId }) => decisionId),
    'knowledge decision IDs',
  );
  return sorted;
}

function normalizeExceptions(
  values: InvestigationSemanticException[],
): InvestigationSemanticException[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Investigation exceptions are malformed.');
  }
  const exceptions = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'exceptionId',
      'kind',
      'subjectKey',
      'rationale',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    if (
      record.kind !== 'semantic-group' &&
      record.kind !== 'disposition' &&
      record.kind !== 'why' &&
      record.kind !== 'knowledge-reuse'
    ) {
      throw unrepresentable('Investigation exception kind is malformed.');
    }
    const kind = record.kind as InvestigationSemanticException['kind'];
    assertDigest(record.provenanceDigest);
    return {
      exceptionId: boundedText(record.exceptionId, 'exception ID'),
      kind,
      subjectKey: boundedText(record.subjectKey, 'exception subject'),
      rationale: boundedText(record.rationale, 'exception rationale'),
      semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      provenanceDigest: record.provenanceDigest as string,
    };
  });
  const sorted = exceptions.sort((left, right) =>
    left.exceptionId.localeCompare(right.exceptionId),
  );
  assertUnique(
    sorted.map(({ exceptionId }) => exceptionId),
    'exception IDs',
  );
  return sorted;
}

function normalizeRequirements(
  values: InvestigationRequirementV3[],
): InvestigationRequirementV3[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Investigation requirements are malformed.');
  }
  const requirements = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'requirementId',
      'text',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    assertDigest(record.provenanceDigest);
    return {
      requirementId: boundedText(record.requirementId, 'requirement ID'),
      text: boundedText(record.text, 'investigation requirement'),
      semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      provenanceDigest: record.provenanceDigest as string,
    };
  });
  const sorted = requirements.sort((left, right) =>
    left.requirementId.localeCompare(right.requirementId),
  );
  assertUnique(
    sorted.map(({ requirementId }) => requirementId),
    'requirement IDs',
  );
  return sorted;
}

function validateWhyCoverage(
  view: MaterializedEvidenceView,
  overlays: InvestigationWhyOverlayV3[],
  knowledgeReuse: InvestigationKnowledgeReuseDecision[],
): void {
  const hitsByKey = new Map(view.grouping.hits.map((hit) => [hit.hitKey, hit]));
  const required = new Map<
    string,
    {
      pathIdentity: { rawBase64: string; utf8: string | null };
      blobOid: string;
      contentSha256: string;
      hitKeys: Set<string>;
      groupRefs: Map<string, InvestigationGroupRef>;
    }
  >();
  for (const disposition of view.dispositions) {
    if (disposition.classification !== 'load-bearing') continue;
    for (const hitKey of disposition.coveredHitKeys) {
      const hit = hitsByKey.get(hitKey)!;
      if (hit.sourceObject.contentSha256 === null) {
        throw new ManifestValidationError(
          'SOURCE_ANCHOR_UNRESOLVED',
          'Load-bearing source has no replayable blob content.',
        );
      }
      const key = sourceTupleKey(hit.path.rawBase64, hit.sourceObject.objectId);
      let row = required.get(key);
      if (row === undefined) {
        row = {
          pathIdentity: hit.path,
          blobOid: hit.sourceObject.objectId,
          contentSha256: hit.sourceObject.contentSha256,
          hitKeys: new Set(),
          groupRefs: new Map(),
        };
        required.set(key, row);
      }
      row.hitKeys.add(hitKey);
      row.groupRefs.set(disposition.groupRef.key, disposition.groupRef);
    }
  }

  const covered = new Set<string>();
  for (const overlay of overlays) {
    const key = sourceTupleKey(overlay.pathIdentity.rawBase64, overlay.blobOid);
    const row = required.get(key);
    if (
      row === undefined ||
      covered.has(key) ||
      canonicalJson(row.pathIdentity) !== canonicalJson(overlay.pathIdentity) ||
      row.contentSha256 !== overlay.contentSha256
    ) {
      throw new ManifestValidationError(
        'SOURCE_ANCHOR_UNRESOLVED',
        'WHY overlay does not map one-to-one to current load-bearing source.',
      );
    }
    const expectedRefs = [...row.groupRefs.values()].sort(
      (left, right) => left.index - right.index,
    );
    if (canonicalJson(expectedRefs) !== canonicalJson(overlay.groupRefs)) {
      throw new ManifestValidationError(
        'SOURCE_ANCHOR_UNRESOLVED',
        'WHY overlay Group references are stale.',
      );
    }
    const hitKeysCovered = new Set<string>();
    for (const anchor of overlay.anchors) {
      if (
        anchor.pathIdentity.rawBase64 !== row.pathIdentity.rawBase64 ||
        anchor.blobOid !== row.blobOid
      ) {
        throw new ManifestValidationError(
          'SOURCE_ANCHOR_UNRESOLVED',
          'WHY source anchor targets a different Git object.',
        );
      }
      const match = view.grouping.hits.find(
        (hit) =>
          row.hitKeys.has(hit.hitKey) &&
          hit.termId === anchor.termId &&
          hit.byteOffset === anchor.byteRange.start &&
          hit.byteOffset + hit.byteLength === anchor.byteRange.end,
      );
      if (match === undefined) {
        throw new ManifestValidationError(
          'SOURCE_ANCHOR_UNRESOLVED',
          'WHY source anchor does not resolve to a current hit.',
        );
      }
      hitKeysCovered.add(match.hitKey);
    }
    if (hitKeysCovered.size !== row.hitKeys.size) {
      throw new ManifestValidationError(
        'SOURCE_ANCHOR_UNRESOLVED',
        'WHY overlay does not anchor every current load-bearing hit.',
      );
    }
    covered.add(key);
  }
  for (const decision of knowledgeReuse) {
    const key = sourceTupleKey(
      decision.pathIdentity.rawBase64,
      decision.blobOid,
    );
    const row = required.get(key);
    if (
      row === undefined ||
      covered.has(key) ||
      canonicalJson(row.pathIdentity) !== canonicalJson(decision.pathIdentity)
    ) {
      throw new ManifestValidationError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Knowledge reuse does not map one-to-one to current load-bearing source.',
      );
    }
    covered.add(key);
  }
  if (covered.size !== required.size) {
    throw new ManifestValidationError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Every load-bearing Git path/blob requires one WHY overlay or fresh knowledge reuse.',
    );
  }
}

function normalizeSourceAnchor(value: unknown): InvestigationSourceAnchor {
  const record = assertRecord(value);
  assertExactKeys(record, ['pathIdentity', 'blobOid', 'byteRange', 'termId']);
  assertGitObjectId(record.blobOid);
  assertDigest(record.termId);
  const byteRange = assertRecord(record.byteRange);
  assertExactKeys(byteRange, ['start', 'end']);
  if (
    !Number.isSafeInteger(byteRange.start) ||
    !Number.isSafeInteger(byteRange.end) ||
    (byteRange.start as number) < 0 ||
    (byteRange.end as number) <= (byteRange.start as number)
  ) {
    throw unrepresentable('Source anchor byte range is malformed.');
  }
  return {
    pathIdentity: normalizePathIdentity(record.pathIdentity),
    blobOid: record.blobOid as string,
    byteRange: {
      start: byteRange.start as number,
      end: byteRange.end as number,
    },
    termId: record.termId as string,
  };
}

function normalizeGroupRef(value: unknown): InvestigationGroupRef {
  const record = assertRecord(value);
  assertExactKeys(record, ['index', 'key', 'leafDigest']);
  if (!Number.isSafeInteger(record.index) || (record.index as number) < 0) {
    throw unrepresentable('Compact Group reference index is malformed.');
  }
  assertDigest(record.leafDigest);
  return {
    index: record.index as number,
    key: boundedText(record.key, 'compact Group key'),
    leafDigest: record.leafDigest as string,
  };
}

function normalizePathIdentity(value: unknown): {
  rawBase64: string;
  utf8: string | null;
} {
  const record = assertRecord(value);
  assertExactKeys(record, ['rawBase64', 'utf8']);
  if (
    typeof record.rawBase64 !== 'string' ||
    (record.utf8 !== null && typeof record.utf8 !== 'string')
  ) {
    throw unrepresentable('Raw Git path identity is malformed.');
  }
  const raw = Buffer.from(record.rawBase64, 'base64');
  if (
    raw.length === 0 ||
    raw.toString('base64') !== record.rawBase64 ||
    raw.includes(0) ||
    raw[0] === 0x2f ||
    raw.at(-1) === 0x2f
  ) {
    throw unrepresentable('Raw Git path identity is malformed.');
  }
  if (record.utf8 !== null) {
    const utf8 = raw.toString('utf8');
    if (
      utf8 !== record.utf8 ||
      Buffer.compare(Buffer.from(utf8, 'utf8'), raw) !== 0
    ) {
      throw unrepresentable('Display path does not match raw Git bytes.');
    }
  }
  return { rawBase64: record.rawBase64, utf8: record.utf8 };
}

function normalizeAuthoringIdentity(
  state: InvestigationAuthoringState,
): ManifestIdentity {
  const record = assertRecord(state);
  assertExactKeys(
    record,
    state.applicabilityKind === 'ordinary'
      ? [
          'schemaVersion',
          'applicabilityKind',
          'repositoryId',
          'changeId',
          'investigationId',
          'normalizedIntent',
          'authoring',
          'ordinary',
        ]
      : [
          'schemaVersion',
          'applicabilityKind',
          'repositoryId',
          'changeId',
          'investigationId',
          'normalizedIntent',
          'authoring',
          'exemption',
        ],
  );
  if (record.schemaVersion !== 1) {
    throw unrepresentable('Authoring-state schema is malformed.');
  }
  const normalizedIntent = normalizeIntent(record.normalizedIntent);
  return {
    schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
    kind: INVESTIGATION_MANIFEST_V3_KIND,
    repositoryId: boundedText(record.repositoryId, 'repository ID'),
    changeId: boundedText(record.changeId, 'change ID'),
    investigationId: boundedText(record.investigationId, 'investigation ID'),
    normalizedIntent,
    intentDigest: digest(normalizedIntent),
    authoring: normalizeAuthoring(record.authoring),
  };
}

function parseManifestIdentity(
  record: Record<string, unknown>,
): ManifestIdentity {
  if (
    record.schemaVersion !== INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION ||
    record.kind !== INVESTIGATION_MANIFEST_V3_KIND
  ) {
    throw unrepresentable('Manifest v3 identity is malformed.');
  }
  const normalizedIntent = normalizeIntent(record.normalizedIntent);
  assertDigest(record.intentDigest);
  if (record.intentDigest !== digest(normalizedIntent)) {
    throw new ManifestValidationError(
      'TERM_INTEGRITY_MISMATCH',
      'Tracked normalized intent does not match intentDigest.',
    );
  }
  return {
    schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
    kind: INVESTIGATION_MANIFEST_V3_KIND,
    repositoryId: boundedText(record.repositoryId, 'repository ID'),
    changeId: boundedText(record.changeId, 'change ID'),
    investigationId: boundedText(record.investigationId, 'investigation ID'),
    normalizedIntent,
    intentDigest: record.intentDigest as string,
    authoring: normalizeAuthoring(record.authoring),
  };
}

function normalizeIntent(value: unknown): NormalizedChangeIntent {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'summary',
    'explicitPaths',
    'explicitSymbols',
    'explicitConfigKeys',
    'renamePairs',
  ]);
  if (record.schemaVersion !== 1) {
    throw unrepresentable('Normalized intent schema is malformed.');
  }
  const explicitPaths = normalizeTextArray(record.explicitPaths);
  const explicitSymbols = normalizeTextArray(record.explicitSymbols);
  const explicitConfigKeys = normalizeTextArray(record.explicitConfigKeys);
  if (!Array.isArray(record.renamePairs)) {
    throw unrepresentable('Normalized intent rename pairs are malformed.');
  }
  const renamePairs = record.renamePairs.map((value) => {
    const pair = assertRecord(value);
    assertExactKeys(pair, ['from', 'to']);
    const from = boundedText(pair.from, 'rename source');
    const to = boundedText(pair.to, 'rename target');
    if (from === to) {
      throw unrepresentable('Normalized intent rename is a no-op.');
    }
    return { from, to };
  });
  assertUnique(
    renamePairs.map((pair) => canonicalJson(pair)),
    'rename pairs',
  );
  return {
    schemaVersion: 1,
    summary: boundedText(record.summary, 'intent summary'),
    explicitPaths,
    explicitSymbols,
    explicitConfigKeys,
    renamePairs,
  };
}

function normalizeAuthoring(value: unknown): {
  sessionRevision: number;
  sessionSnapshotDigest: string;
} {
  const record = assertRecord(value);
  assertExactKeys(record, ['sessionRevision', 'sessionSnapshotDigest']);
  if (
    !Number.isSafeInteger(record.sessionRevision) ||
    (record.sessionRevision as number) < 0
  ) {
    throw unrepresentable('Authoring session revision is malformed.');
  }
  assertDigest(record.sessionSnapshotDigest);
  return {
    sessionRevision: record.sessionRevision as number,
    sessionSnapshotDigest: record.sessionSnapshotDigest as string,
  };
}

function normalizeBaseline(value: unknown): InvestigationV3Baseline {
  const record = assertRecord(value);
  assertExactKeys(record, ['commitOid', 'treeOid']);
  assertGitObjectId(record.commitOid);
  assertGitObjectId(record.treeOid);
  if (
    (record.commitOid as string).length !== (record.treeOid as string).length
  ) {
    throw unrepresentable('Baseline object formats disagree.');
  }
  return {
    commitOid: record.commitOid as string,
    treeOid: record.treeOid as string,
  };
}

function assertIntentFloor(
  intent: NormalizedChangeIntent,
  canonicalTerms: PreviewInvestigationTerm[],
): void {
  const terms = new Map(canonicalTerms.map((term) => [term.termId, term]));
  const required = [
    ...intent.explicitPaths.map((value) => ({
      kind: 'literal-path' as const,
      value,
    })),
    ...intent.explicitSymbols.map((value) => ({
      kind: 'symbol' as const,
      value,
    })),
    ...intent.explicitConfigKeys.map((value) => ({
      kind: 'config-key' as const,
      value,
    })),
    ...intent.renamePairs.flatMap(({ from, to }) => [
      { kind: 'literal-content' as const, value: from },
      { kind: 'literal-content' as const, value: to },
    ]),
  ];
  for (const input of required) {
    const expected = normalizeInvestigationTerm(input);
    const actual = terms.get(expected.termId);
    if (
      actual === undefined ||
      !actual.provenance.some(({ source }) => source === 'engine')
    ) {
      throw new ManifestValidationError(
        'TERM_INTEGRITY_MISMATCH',
        `Normalized intent floor term is missing: ${input.kind}.`,
      );
    }
  }
}

function parseApproval(value: unknown): InvestigationApprovalV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'investigationTargetDigest',
    'semanticAuthor',
    'approvalProvenanceDigest',
    'semanticAssurance',
    'sealDigest',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-approval' ||
    record.semanticAssurance !== SEMANTIC_ASSURANCE
  ) {
    throw unrepresentable('Investigation approval identity is malformed.');
  }
  assertDigest(record.investigationTargetDigest);
  assertDigest(record.approvalProvenanceDigest);
  assertDigest(record.sealDigest);
  return {
    schemaVersion: 1,
    kind: 'investigation-approval',
    investigationTargetDigest: record.investigationTargetDigest as string,
    semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
    approvalProvenanceDigest: record.approvalProvenanceDigest as string,
    semanticAssurance: SEMANTIC_ASSURANCE,
    sealDigest: record.sealDigest as string,
  };
}

function normalizeSemanticAuthor(value: unknown): InvestigationSemanticAuthor {
  const record = assertRecord(value);
  assertExactKeys(record, ['id', 'provenance']);
  return {
    id: boundedText(record.id, 'semantic author ID'),
    provenance: boundedText(record.provenance, 'semantic author provenance'),
  };
}

function assertManifestTop(value: unknown): Record<string, unknown> {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'repositoryId',
    'changeId',
    'investigationId',
    'normalizedIntent',
    'intentDigest',
    'authoring',
    'applicability',
    'investigationApproval',
    'manifestDigest',
  ]);
  return record;
}

function assertDraftShape(
  value: unknown,
): asserts value is InvestigationManifestDraftV3 {
  const record = assertManifestTop(value);
  if (
    record.schemaVersion !== INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION ||
    record.kind !== INVESTIGATION_MANIFEST_V3_KIND ||
    record.investigationApproval !== null ||
    record.manifestDigest !== null
  ) {
    throw unrepresentable('Investigation draft identity is malformed.');
  }
  parseManifestIdentity(record);
}

function investigationTargetDigest(
  manifest: ManifestIdentity,
  applicabilityContentDigest: string,
): string {
  return digestWithDomain('investigation-target/v3', {
    schemaVersion: manifest.schemaVersion,
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    intentDigest: manifest.intentDigest,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    applicabilityContentDigest,
  });
}

function normalizeDigestArray(value: unknown, allowEmpty: boolean): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string' || !DIGEST.test(entry))
  ) {
    throw unrepresentable('Digest reference array is malformed.');
  }
  const sorted = [...value].sort();
  assertUnique(sorted, 'digest references');
  return sorted;
}

function normalizeTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw unrepresentable('Text array is malformed.');
  }
  const values = value.map((entry) => boundedText(entry, 'text value'));
  assertUnique(values, 'text values');
  return values;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : boundedText(value, label);
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw unrepresentable(`${label} is malformed.`);
  }
  return value;
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw unrepresentable('Digest is malformed.');
  }
}

function assertGitObjectId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    throw unrepresentable('Git object identity is malformed.');
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw unrepresentable(`${label} contain duplicates.`);
  }
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw unrepresentable('Manifest object is malformed.');
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    !keys.every((key) => expected.includes(key))
  ) {
    throw unrepresentable('Manifest object has unknown or missing properties.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceTupleKey(pathRawBase64: string, blobOid: string): string {
  return canonicalJson([pathRawBase64, blobOid]);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestWithDomain(domain: string, value: unknown): string {
  return digest({ domain, value });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

class ManifestValidationError extends Error {
  readonly code: InvestigationV3FailureCode;

  constructor(code: InvestigationV3FailureCode, message: string) {
    super(message);
    this.name = 'ManifestValidationError';
    this.code = code;
  }
}

function unrepresentable(message: string): ManifestValidationError {
  return new ManifestValidationError('MANIFEST_UNREPRESENTABLE', message);
}

function failureCode(error: unknown): InvestigationV3FailureCode {
  if (error instanceof ManifestValidationError) return error.code;
  if (error instanceof WorkflowError) {
    const directCodes = new Set([
      'TERM_INTEGRITY_MISMATCH',
      'REPLAY_INPUT_MISSING',
      'REPLAY_CLOSURE_UNSUPPORTED',
      'MANIFEST_UNREPRESENTABLE',
      'RECONSTRUCTION_MISMATCH',
      'SEMANTIC_COMPLETENESS_FAILURE',
      'SOURCE_ANCHOR_UNRESOLVED',
      'REVIEW_TARGET_STALE',
      'PROJECTION_PIPELINE_FORBIDDEN',
    ]);
    return directCodes.has(error.code) ? error.code : 'RECONSTRUCTION_MISMATCH';
  }
  return 'RECONSTRUCTION_MISMATCH';
}

function blocked(
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'],
  candidate: unknown,
  error: unknown,
): { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  return blockedWithCode(
    attemptedTransition,
    candidate,
    failureCode(error),
    error instanceof Error
      ? error.message
      : 'Unknown v3 investigation failure.',
    error instanceof WorkflowError ? error.details : undefined,
  );
}

function blockedWithCode(
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'],
  candidate: unknown,
  code: InvestigationV3FailureCode,
  message: string,
  details?: Record<string, unknown>,
): { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  const candidateDigest = safeCandidateDigest(candidate);
  const detailsDigest = digest({ code, message, details: details ?? null });
  const missingAssuranceFacts = missingAssuranceFactsFor(code);
  const identityInput = {
    attemptedTransition,
    candidateDigest,
    failureCode: code,
    detailsDigest,
    missingAssuranceFacts,
  };
  return {
    outcome: 'blocked',
    blocker: {
      schemaVersion: 1,
      kind: 'investigation-v3-failure',
      failureIdentity: digestWithDomain(
        'investigation-v3-failure/v1',
        identityInput,
      ),
      ...identityInput,
    },
  };
}

function safeCandidateDigest(value: unknown): string {
  try {
    return digestWithDomain('investigation-v3-candidate/v1', value);
  } catch {
    return digestWithDomain('investigation-v3-candidate/v1', 'unrepresentable');
  }
}

function missingAssuranceFactsFor(code: string): string[] {
  switch (code) {
    case 'TERM_INTEGRITY_MISMATCH':
      return ['canonical-term-composition'];
    case 'REPLAY_INPUT_MISSING':
    case 'REPLAY_CLOSURE_UNSUPPORTED':
      return ['pinned-git-replay'];
    case 'SEMANTIC_COMPLETENESS_FAILURE':
      return ['complete-semantic-decisions'];
    case 'SOURCE_ANCHOR_UNRESOLVED':
      return ['resolvable-source-anchors'];
    case 'REVIEW_TARGET_STALE':
      return ['current-authority-snapshot'];
    default:
      return [];
  }
}
