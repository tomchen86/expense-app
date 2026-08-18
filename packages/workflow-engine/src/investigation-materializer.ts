import { canonicalJson } from './canonical-json.ts';
import {
  applyInvestigationDispositionDecisions,
  applyInvestigationSemanticGroupDecisions,
  type AppliedInvestigationDisposition,
  type InvestigationDispositionDecision,
  type InvestigationFinalGroupFact,
  type InvestigationSemanticGroupDecision,
} from './investigation-domain.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import {
  deriveInvestigationGroupFacts,
  type DeclaredInvestigationRoot,
  type InvestigationGroupFacts,
  type ReviewedPathRelationship,
} from './investigation-groups.ts';
import {
  deriveInvestigationCommitments,
  investigationTermSetDigest,
  type InvestigationDerivedCommitments,
} from './investigation-roots.ts';
import {
  scanInvestigationTreeFacts,
  type InvestigationScanFacts,
} from './investigation-scanner.ts';
import {
  INVESTIGATION_LIMITS,
  previewInvestigationTermUnion,
  type InvestigationLimits,
  type InvestigationTermContribution,
  type PreviewInvestigationTerm,
} from './investigation-terms.ts';
import type { InvestigationSemanticAuthor } from './investigation-applicability.ts';
import type { MutationClassPolicy } from './mutation-class-policy.ts';

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type InvestigationV3Baseline = {
  commitOid: string;
  treeOid: string;
};

export type InvestigationScanSaturationDecision = {
  saturatedTermIds: string[];
  acknowledgeIncompleteScan: true;
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

export type InvestigationReplayAuthoringInput = {
  baseline: InvestigationV3Baseline;
  termContributions: InvestigationTermContribution[];
  canonicalTerms: PreviewInvestigationTerm[];
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
  semanticGroupDecisions: InvestigationSemanticGroupDecision[];
  dispositionDecisions: InvestigationDispositionDecision[];
};

/**
 * Process-local replay result. `toJSON` fails closed so this transient view
 * cannot accidentally become a tracked or durable authority artifact.
 */
export class MaterializedEvidenceView {
  readonly #state: {
    scanFacts: InvestigationScanFacts;
    grouping: InvestigationGroupFacts;
    finalGroups: InvestigationFinalGroupFact[];
    dispositions: AppliedInvestigationDisposition[];
    commitments: InvestigationDerivedCommitments;
    termSetDigest: string;
    canonicalTerms: PreviewInvestigationTerm[];
    limits: InvestigationLimits;
  };

  constructor(input: {
    scanFacts: InvestigationScanFacts;
    grouping: InvestigationGroupFacts;
    finalGroups: InvestigationFinalGroupFact[];
    dispositions: AppliedInvestigationDisposition[];
    commitments: InvestigationDerivedCommitments;
    termSetDigest: string;
    canonicalTerms: PreviewInvestigationTerm[];
    limits: InvestigationLimits;
  }) {
    this.#state = deepFreeze(structuredClone(input));
    Object.freeze(this);
  }

  get scanFacts(): InvestigationScanFacts {
    return this.#state.scanFacts;
  }

  get grouping(): InvestigationGroupFacts {
    return this.#state.grouping;
  }

  get finalGroups(): InvestigationFinalGroupFact[] {
    return this.#state.finalGroups;
  }

  get dispositions(): AppliedInvestigationDisposition[] {
    return this.#state.dispositions;
  }

  get commitments(): InvestigationDerivedCommitments {
    return this.#state.commitments;
  }

  get termSetDigest(): string {
    return this.#state.termSetDigest;
  }

  get canonicalTerms(): PreviewInvestigationTerm[] {
    return this.#state.canonicalTerms;
  }

  get limits(): InvestigationLimits {
    return this.#state.limits;
  }

  toJSON(): never {
    throw workflowError(
      'PROJECTION_PIPELINE_FORBIDDEN',
      'MaterializedEvidenceView is process-local and must never be serialized.',
      ExitCode.guard,
    );
  }
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

export function materializeInvestigationEvidenceView(input: {
  repositoryRoot: string;
  authoring: InvestigationReplayAuthoringInput;
}): MaterializedEvidenceView {
  assertBaseline(input.repositoryRoot, input.authoring.baseline);
  const preview = previewInvestigationTermUnion(
    input.authoring.termContributions,
    input.authoring.scanner.limits ?? { ...INVESTIGATION_LIMITS },
  );
  if (preview.outcome !== 'ready') {
    throw workflowError(
      'TERM_INTEGRITY_MISMATCH',
      'Persisted term contributions do not produce a replayable canonical union.',
      ExitCode.guard,
      { details: { violations: preview.violations } },
    );
  }
  if (
    canonicalJson(preview.terms) !==
    canonicalJson(input.authoring.canonicalTerms)
  ) {
    throw workflowError(
      'TERM_INTEGRITY_MISMATCH',
      'Persisted canonical terms do not match their complete contributions.',
      ExitCode.guard,
    );
  }
  const limits = input.authoring.scanner.limits ?? { ...INVESTIGATION_LIMITS };
  const scan = scanInvestigationTreeFacts({
    repositoryRoot: input.repositoryRoot,
    treeOid: input.authoring.baseline.treeOid,
    terms: preview.terms,
    limits,
    allowSaturatedTerms: input.authoring.scanner.allowSaturatedTerms,
  });
  if (scan.outcome !== 'ready') {
    throw workflowError(
      'REPLAY_CLOSURE_UNSUPPORTED',
      'Pinned scanner replay requires deterministic narrowing.',
      ExitCode.guard,
      { details: { violations: scan.violations } },
    );
  }
  assertSaturationDecision(
    scan.saturatedTermIds ?? [],
    input.authoring.scanner.saturationDecision,
  );
  const grouping = deriveInvestigationGroupFacts({
    scanFacts: scan.facts,
    mutationPolicy: input.authoring.grouping.mutationPolicy,
    declaredRoots: input.authoring.grouping.declaredRoots,
    reviewedRelationships: input.authoring.grouping.reviewedRelationships,
  });
  const finalGroups = applyInvestigationSemanticGroupDecisions({
    mechanical: grouping,
    decisions: input.authoring.semanticGroupDecisions,
  });
  const dispositions = applyInvestigationDispositionDecisions({
    finalGroups,
    decisions: input.authoring.dispositionDecisions,
  });
  const commitments = deriveInvestigationCommitments({
    scanFacts: scan.facts,
    grouping,
    finalGroups,
    dispositions,
    effectiveTermIds: preview.terms.map(({ termId }) => termId),
  });
  return new MaterializedEvidenceView({
    scanFacts: scan.facts,
    grouping,
    finalGroups,
    dispositions,
    commitments,
    termSetDigest: investigationTermSetDigest(preview.terms),
    canonicalTerms: structuredClone(preview.terms),
    limits: structuredClone(limits),
  });
}

function assertBaseline(
  repositoryRoot: string,
  baseline: InvestigationV3Baseline,
): void {
  if (
    typeof baseline !== 'object' ||
    baseline === null ||
    Object.keys(baseline).length !== 2 ||
    !Object.keys(baseline).every((key) =>
      ['commitOid', 'treeOid'].includes(key),
    ) ||
    !GIT_OBJECT_ID.test(baseline.commitOid) ||
    !GIT_OBJECT_ID.test(baseline.treeOid) ||
    baseline.commitOid.length !== baseline.treeOid.length
  ) {
    throw workflowError(
      'REPLAY_INPUT_MISSING',
      'Investigation baseline identity is malformed.',
      ExitCode.guard,
    );
  }
  let commitOid: string;
  let treeOid: string;
  try {
    commitOid = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${baseline.commitOid}^{commit}`,
    ]).trim();
    treeOid = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${baseline.commitOid}^{tree}`,
    ]).trim();
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw workflowError(
        'REPLAY_INPUT_MISSING',
        'Pinned investigation commit or tree is unavailable.',
        ExitCode.staleState,
        { details: { causeCode: error.code } },
      );
    }
    throw error;
  }
  if (commitOid !== baseline.commitOid || treeOid !== baseline.treeOid) {
    throw workflowError(
      'RECONSTRUCTION_MISMATCH',
      'Pinned commit does not resolve to the recorded investigation tree.',
      ExitCode.staleState,
    );
  }
}

function assertSaturationDecision(
  saturatedTermIds: string[],
  decision: InvestigationScanSaturationDecision | null,
): void {
  const saturated = [...saturatedTermIds].sort();
  if (saturated.length === 0) {
    if (decision !== null) {
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'A scan-saturation decision exists for a complete replay.',
        ExitCode.guard,
      );
    }
    return;
  }
  if (
    decision === null ||
    decision.acknowledgeIncompleteScan !== true ||
    canonicalJson([...decision.saturatedTermIds].sort()) !==
      canonicalJson(saturated) ||
    typeof decision.rationale !== 'string' ||
    decision.rationale.trim().length === 0 ||
    typeof decision.semanticAuthor?.id !== 'string' ||
    decision.semanticAuthor.id.trim().length === 0 ||
    typeof decision.semanticAuthor.provenance !== 'string' ||
    decision.semanticAuthor.provenance.trim().length === 0 ||
    !DIGEST.test(decision.provenanceDigest)
  ) {
    throw workflowError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Saturated replay lacks its exact semantic acknowledgement.',
      ExitCode.guard,
    );
  }
}
