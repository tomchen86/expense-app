import {
  applyInvestigationDispositionDecisions,
  applyInvestigationSemanticGroupDecisions,
  type InvestigationDispositionDecision,
} from './investigation-domain.ts';
import type { FloorOverflowDecision } from './floor-overflow-pruning.ts';
import type { InvestigationGroupFacts } from './investigation-groups.ts';
import {
  buildInvestigationManifestDraft,
  createInvestigationV3Blocker,
  sealInvestigationManifestDraft,
  validateForAuthority,
  type InvestigationAssuranceFacts,
  type InvestigationManifestDraftV3,
  type InvestigationManifestV3,
  type InvestigationV3Blocker,
  type InvestigationV3RoleResult,
} from './investigation-manifest.ts';
import {
  MaterializedEvidenceView,
  type InvestigationScanSaturationDecision,
  type InvestigationV3Baseline,
} from './investigation-materializer.ts';
import {
  deriveInvestigationCommitments,
  investigationTermSetDigest,
} from './investigation-roots.ts';
import type { InvestigationScanFacts } from './investigation-scanner.ts';
import {
  compareInvestigationV2V3Shadow,
  type InvestigationShadowParityReport,
  type InvestigationV2ShadowOracle,
} from './investigation-shadow-parity.ts';
import type {
  InvestigationTermContribution,
  PreviewInvestigationTerm,
} from './investigation-terms.ts';
import {
  INVESTIGATION_LIMITS,
  type InvestigationLimits,
} from './investigation-terms.ts';
import type {
  InvestigationKnowledgeReuseDecision,
  InvestigationWhyOverlayV3,
} from './investigation-manifest.ts';
import {
  buildInvestigationV3WhyAuthoring,
  deriveInvestigationV3WhyRequirements,
  mapLegacyWhyAuthoringToV3Sources,
  type LegacyKnowledgeCarry,
  type LegacyWhyAuthoringAnswer,
  type LegacyWhyAuthoringRow,
} from './investigation-why-domain.ts';
import type { InvestigationSemanticAuthor } from './investigation-applicability.ts';
import type { MutationClassPolicy } from './mutation-class-policy.ts';
import type { NormalizedChangeIntent } from './provider-invocation-store.ts';
import type {
  DeclaredInvestigationRoot,
  ReviewedPathRelationship,
} from './investigation-groups.ts';

export type InvestigationV3ShadowBuildInput = {
  repositoryRoot: string;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  normalizedIntent: NormalizedChangeIntent;
  authoring: {
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
  baseline: InvestigationV3Baseline;
  termContributions: InvestigationTermContribution[];
  canonicalTerms: PreviewInvestigationTerm[];
  scanFacts: InvestigationScanFacts;
  groupFacts: InvestigationGroupFacts;
  scanner: {
    limits?: InvestigationLimits;
    allowSaturatedTerms: boolean;
    saturationDecision: InvestigationScanSaturationDecision | null;
  };
  grouping: {
    mutationPolicy: MutationClassPolicy;
    declaredRoots: DeclaredInvestigationRoot[];
    reviewedRelationships: ReviewedPathRelationship[];
  };
  dispositionDecisions: InvestigationDispositionDecision[];
  whyAuthoring:
    | {
        kind: 'direct-v3';
        whyOverlays: InvestigationWhyOverlayV3[];
        knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
      }
    | {
        kind: 'legacy-v2-shadow';
        manifestRows: LegacyWhyAuthoringRow[];
        answers: LegacyWhyAuthoringAnswer[];
        carried: LegacyKnowledgeCarry[];
        checkpointProvenanceDigest: string;
      };
  investigationRoleResults: InvestigationV3RoleResult[];
  floorOverflowDecision: FloorOverflowDecision | null;
  assuranceFacts: InvestigationAssuranceFacts;
  approval: {
    semanticAuthor: InvestigationSemanticAuthor;
    approvalProvenanceDigest: string;
  };
  v2Oracle: InvestigationV2ShadowOracle;
};

export type InvestigationV3ShadowBuildResult =
  | {
      outcome: 'matched';
      draft: InvestigationManifestDraftV3;
      manifest: InvestigationManifestV3;
      parity: InvestigationShadowParityReport;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

/**
 * Non-authoritative v3 shadow build from common raw/domain inputs. It never
 * publishes a current ref and contains no grant mechanics. A mismatch or any
 * construction failure is reduced to the same structured v3 failure contract
 * that a future central Grant Core producer adapter will consume.
 */
export function buildInvestigationV3Shadow(
  input: InvestigationV3ShadowBuildInput,
): InvestigationV3ShadowBuildResult {
  try {
    const finalGroups = applyInvestigationSemanticGroupDecisions({
      mechanical: input.groupFacts,
      decisions: [],
    });
    const dispositions = applyInvestigationDispositionDecisions({
      finalGroups,
      decisions: input.dispositionDecisions,
    });
    const commitments = deriveInvestigationCommitments({
      scanFacts: input.scanFacts,
      grouping: input.groupFacts,
      finalGroups,
      dispositions,
      effectiveTermIds: input.canonicalTerms.map(({ termId }) => termId),
    });
    const view = new MaterializedEvidenceView({
      scanFacts: structuredClone(input.scanFacts),
      grouping: structuredClone(input.groupFacts),
      finalGroups,
      dispositions,
      commitments,
      termSetDigest: investigationTermSetDigest(input.canonicalTerms),
      canonicalTerms: structuredClone(input.canonicalTerms),
      limits: structuredClone(input.scanner.limits ?? INVESTIGATION_LIMITS),
    });
    const whyAuthoring =
      input.whyAuthoring.kind === 'direct-v3'
        ? {
            whyOverlays: structuredClone(input.whyAuthoring.whyOverlays),
            knowledgeReuseDecisions: structuredClone(
              input.whyAuthoring.knowledgeReuseDecisions,
            ),
          }
        : (() => {
            const mapped = mapLegacyWhyAuthoringToV3Sources({
              requirements: deriveInvestigationV3WhyRequirements(view),
              manifestRows: input.whyAuthoring.manifestRows,
              answers: input.whyAuthoring.answers,
              carried: input.whyAuthoring.carried,
              checkpointProvenanceDigest:
                input.whyAuthoring.checkpointProvenanceDigest,
            });
            return buildInvestigationV3WhyAuthoring({
              view,
              answers: mapped.answers,
              knowledgeReuse: mapped.knowledgeReuse,
            });
          })();
    const built = buildInvestigationManifestDraft({
      repositoryRoot: input.repositoryRoot,
      state: {
        schemaVersion: 1,
        applicabilityKind: 'ordinary',
        repositoryId: input.repositoryId,
        changeId: input.changeId,
        investigationId: input.investigationId,
        normalizedIntent: structuredClone(input.normalizedIntent),
        authoring: structuredClone(input.authoring),
        ordinary: {
          baseline: structuredClone(input.baseline),
          termContributions: structuredClone(input.termContributions),
          canonicalTerms: structuredClone(input.canonicalTerms),
          scanner: structuredClone(input.scanner),
          grouping: structuredClone(input.grouping),
          semanticGroupDecisions: [],
          dispositionDecisions: structuredClone(input.dispositionDecisions),
          whyOverlays: whyAuthoring.whyOverlays,
          knowledgeReuseDecisions: whyAuthoring.knowledgeReuseDecisions,
          investigationRoleResults: structuredClone(
            input.investigationRoleResults,
          ),
          floorOverflowDecision: structuredClone(input.floorOverflowDecision),
          exceptions: [],
          investigationRequirements: [],
          assuranceFacts: structuredClone(input.assuranceFacts),
        },
      },
    });
    if (built.outcome !== 'built') return built;
    const parity = compareInvestigationV2V3Shadow({
      v2: input.v2Oracle,
      v3: { draft: built.draft, view },
    });
    const sealed = sealInvestigationManifestDraft({
      draft: built.draft,
      approval: structuredClone(input.approval),
    });
    if (sealed.outcome !== 'sealed') return sealed;
    const verified = validateForAuthority({
      repositoryRoot: input.repositoryRoot,
      manifest: sealed.manifest,
      expected: {
        repositoryId: input.repositoryId,
        changeId: input.changeId,
        investigationId: input.investigationId,
        sessionRevision: input.authoring.sessionRevision,
        sessionSnapshotDigest: input.authoring.sessionSnapshotDigest,
      },
    });
    if (verified.outcome !== 'verified') return verified;
    return {
      outcome: 'matched',
      draft: built.draft,
      manifest: sealed.manifest,
      parity,
    };
  } catch (error) {
    return {
      outcome: 'blocked',
      blocker: createInvestigationV3Blocker({
        attemptedTransition: 'authority-validation',
        candidate: shadowCandidate(input),
        failureCode:
          error instanceof Error &&
          'code' in error &&
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'RECONSTRUCTION_MISMATCH',
        message:
          error instanceof Error
            ? error.message
            : 'Unknown Investigation v3 shadow failure.',
      }),
    };
  }
}

function shadowCandidate(input: InvestigationV3ShadowBuildInput) {
  return {
    schemaVersion: 1,
    kind: 'investigation-v3-shadow-candidate',
    repositoryId: input.repositoryId,
    changeId: input.changeId,
    investigationId: input.investigationId,
    authoring: input.authoring,
    baseline: input.baseline,
    termIds: input.canonicalTerms.map(({ termId }) => termId).sort(),
  };
}
