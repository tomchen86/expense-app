import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError, type WorkflowError } from './errors.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import {
  normalizeInvestigationTerm,
  type InvestigationTermKind,
} from './investigation-terms.ts';
import type { LegacyPlanMigrationSubject } from './legacy-plan-migration.ts';
import { normalizeExactRepositoryPath } from './paths.ts';
import { isProviderId } from './provider-registry.ts';
import { isProviderRoleAssignment } from './provider-contracts.ts';
import type {
  IndependenceDimension,
  ProviderRoleAssignment,
} from './role-scheduler.ts';
import {
  assertPlanningGeneration,
  type PlanningGeneration,
} from './planning-generation.ts';

const PLAN_REVIEW_TYPE = 'plan-review';
const PLAN_REVIEW_SCHEMA = 'plan-review.v2';
const PLAN_REVIEW_EVALUATOR = 'plan-review.v2';
const PLAN_REVIEW_OUTPUT_SCHEMA_ID = 'plan-review-output.v2';
const PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID = 'plan-review-node-output.v2';

const PROVIDER_RESULT_TYPE = 'plan-review-provider-result';
const PROVIDER_RESULT_SCHEMA = 'plan-review-provider-result.v2';
const PROVIDER_RESULT_EVALUATOR = 'plan-review-provider-result.v2';
const PROVIDER_RESULT_OUTPUT_SCHEMA = 'plan-review-provider-result-output.v2';

const DISPOSITION_TYPE = 'plan-review-disposition';
const DISPOSITION_SCHEMA = 'plan-review-disposition.v1';
const DISPOSITION_EVALUATOR = 'plan-review-disposition.v1';
const DISPOSITION_OUTPUT_SCHEMA = 'plan-review-disposition-output.v1';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TARGET_SNAPSHOT_TYPE = 'plan-review-target-snapshot';
const TARGET_SNAPSHOT_SCHEMA = 'workflow.plan-review-target-snapshot.v1';
const TARGET_SNAPSHOT_OUTPUT_SCHEMA =
  'workflow.plan-review-target-snapshot-output.v1';
const TARGET_SNAPSHOT_FILE = /^\d{4}\.artifact$/;
const MAX_TARGET_SNAPSHOT_ARTIFACTS = 4_096;

export type PlanningArtifactMutability =
  'preserved-byte-identical' | 'replaceable-on-replanning' | 'engine-managed';

export type PlanReviewTargetSnapshotArtifact = {
  path: string;
  sha256: string;
  byteLength: number;
  lineCount: number;
  mode: '100644';
  snapshotFile: string;
  mutability: PlanningArtifactMutability;
};

export type PlanReviewMigrationContract = {
  legacyMigration: boolean;
  preservedPaths: string[];
  replaceablePaths: string[];
  engineManagedPaths: string[];
  guardSemanticDigest: string | null;
};

export type PlanReviewTargetSnapshot = {
  schemaVersion: 1;
  snapshotDigest: string;
  changeId: string;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  materializationNodeId: string;
  materializationResultDigest: string;
  artifacts: PlanReviewTargetSnapshotArtifact[];
  migration: PlanReviewMigrationContract;
};

export type CreatePlanReviewTargetSnapshotInput = {
  changeId: string;
  changePrefix: string;
  subject: PlanReviewSubject;
  materializationNode: EvidenceNode;
  artifacts: Map<string, Buffer>;
  legacyMigration: LegacyPlanMigrationSubject | null;
};

export const PLAN_REVIEW_MAX_PROPOSED_TERMS = 256;

const PLAN_REVIEW_LIMITS = Object.freeze({
  maxFindings: 128,
  maxSuggestions: 128,
  maxProposedTerms: PLAN_REVIEW_MAX_PROPOSED_TERMS,
  maxEvidencePerEntry: 64,
  maxInvestigationDependencies: 4096,
  maxSummaryBytes: 16 * 1024,
  maxObservationBytes: 16 * 1024,
  maxResidualRiskBytes: 16 * 1024,
  maxUncertaintyBytes: 16 * 1024,
  maxDispositionRationaleBytes: 16 * 1024,
  maxAuthorBytes: 1024,
  maxRepositoryPathBytes: 4096,
});

/**
 * The fixed scope-and-depth challenge surface a single exact-plan review must
 * cover. A submission attests the complete set; a missing area is incomplete
 * coverage and fails closed. It doubles as the allowed challenge category set.
 */
export const PLAN_REVIEW_COVERAGE = Object.freeze([
  'missing-scope',
  'missing-consumers',
  'weak-why',
  'unsupported-invariants',
  'contradictory-artifacts',
  'task-strategy-risks',
  'additional-search-terms',
] as const);

const COVERAGE_SET: ReadonlySet<string> = new Set<string>(PLAN_REVIEW_COVERAGE);
const FOLLOWUP_CATEGORIES: ReadonlySet<string> = new Set(['follow-up']);
const VERDICTS: ReadonlySet<string> = new Set([
  'advisory-approve',
  'advisory-reject',
]);
const SEVERITIES: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'informational',
]);
const TERM_KINDS: ReadonlySet<string> = new Set([
  'literal-content',
  'literal-path',
  'symbol',
  'config-key',
]);
const EVIDENCE_KINDS = [
  'planning-location',
  'repository-location',
  'investigation-node',
  'survey-record',
] as const;
const DISPOSITION_DECISIONS: ReadonlySet<string> = new Set([
  'mitigated',
  'rejected',
  'accepted',
]);
const INDEPENDENCE_DIMENSIONS: ReadonlySet<string> = new Set([
  'provider-independent',
  'principal-independent',
  'session-independent',
  'none',
]);

const SUBMISSION_KEYS = [
  'schemaVersion',
  'verdict',
  'coverage',
  'scopeAssessment',
  'findings',
  'proposedTerms',
  'suggestions',
  'residualRisk',
  'uncertainty',
] as const;

const OUTPUT_KEYS = [
  'schemaVersion',
  'planningGenerationId',
  'planTargetDigest',
  'subjectDigest',
  'assignment',
  'verdict',
  'coverage',
  'scopeAssessment',
  'findings',
  'suggestions',
  'proposedTerms',
  'residualRisk',
  'uncertainty',
  'requiredIndependence',
  'achievedIndependence',
] as const;

const SUBJECT_KEYS = [
  'schemaVersion',
  'subjectDigest',
  'planningGenerationId',
  'planTargetDigest',
  'reviewPolicyDigest',
  'requiredIndependence',
  'investigationBaseline',
  'investigationDependencies',
] as const;

const PROVIDER_RESULT_OUTPUT_KEYS = [
  'schemaVersion',
  'subjectDigest',
  'assignment',
  'submission',
  'runtimeAssurance',
] as const;

const ROLE_ASSIGNMENT_KEYS = [
  'role',
  'providerId',
  'sessionId',
  'targetDigest',
  'requiredIndependence',
  'achievedIndependence',
] as const;

export type PlanReviewVerdict = 'advisory-approve' | 'advisory-reject';
export type PlanReviewSeverity =
  'critical' | 'high' | 'medium' | 'low' | 'informational';

export type PlanReviewEvidence =
  | {
      kind: 'planning-location';
      path: string;
      line: number;
      observation: string;
    }
  | {
      kind: 'repository-location';
      path: string;
      line: number;
      observation: string;
    }
  | { kind: 'investigation-node'; nodeId: string; resultDigest: string }
  | { kind: 'survey-record'; nodeId: string; resultDigest: string };

export type PlanReviewProposedTerm = {
  kind: InvestigationTermKind;
  value: string;
};

/**
 * A submitted finding. Challenges are current-change required and demand
 * disposition; suggestions are independent follow-ups. The `kind` and
 * `currentChangeImpact` fields are deliberately wide so a malformed pairing is
 * rejected at validation rather than swallowed by the type.
 */
export type PlanReviewFinding = {
  kind: 'challenge' | 'suggestion';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'required' | 'independent-follow-up';
  summary: string;
  evidence: PlanReviewEvidence[];
};

export type PlanReviewScopeAssessment =
  | { kind: 'challenges' }
  | { kind: 'no-challenge'; evidence: PlanReviewEvidence[] };

export type PlanReviewSubmission = {
  schemaVersion: 2;
  verdict: PlanReviewVerdict;
  coverage: string[];
  scopeAssessment: PlanReviewScopeAssessment;
  findings: PlanReviewFinding[];
  proposedTerms: PlanReviewProposedTerm[];
  suggestions: PlanReviewFinding[];
  residualRisk: string;
  uncertainty: string;
};

export type PlanReviewChallenge = {
  findingId: string;
  kind: 'challenge';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'required';
  summary: string;
  evidence: PlanReviewEvidence[];
};

export type PlanReviewSuggestion = {
  suggestionId: string;
  kind: 'suggestion';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'independent-follow-up';
  summary: string;
  evidence: PlanReviewEvidence[];
};

export type PlanReviewReport = {
  schemaVersion: 2;
  nodeId: string;
  resultDigest: string;
  policyDigest: string;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  assignment: ProviderRoleAssignment;
  providerResultNodeId: string;
  providerResultResultDigest: string;
  verdict: PlanReviewVerdict;
  coverage: readonly string[];
  scopeAssessment: PlanReviewScopeAssessment;
  findings: PlanReviewChallenge[];
  suggestions: PlanReviewSuggestion[];
  proposedTerms: PlanReviewProposedTerm[];
  residualRisk: string;
  uncertainty: string;
  requiredIndependence: IndependenceDimension;
  achievedIndependence: IndependenceDimension;
};

export type PlanReviewSubjectInput = {
  generation: PlanningGeneration;
  reviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
};

export type PlanReviewSubject = {
  schemaVersion: 1;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  reviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
  investigationBaseline: { head: string; tree: string };
  investigationDependencies: Array<{
    role: string;
    nodeId: string;
    resultDigest: string;
  }>;
};

export type PlanReviewDispositionDecision =
  'mitigated' | 'rejected' | 'accepted';

export type PlanReviewDispositionEntry = {
  challengeId: string;
  decision: PlanReviewDispositionDecision;
  rationale: string;
  author: string;
};

export type PlanReviewDispositionInput = {
  reviewNode: EvidenceNode;
  policyDigest: string;
  dispositions: PlanReviewDispositionEntry[];
};

export type PlanReviewDispositionRecord = {
  reviewNodeId: string;
  reviewResultDigest: string;
  policyDigest: string;
  dispositions: PlanReviewDispositionEntry[];
};

export type PlanReviewNodeInput = {
  subject: PlanReviewSubject;
  assignment: ProviderRoleAssignment;
  providerResultNode: EvidenceNode;
  submission: PlanReviewSubmission;
};

export type PlanReviewProviderResultNodeInput = {
  subject: PlanReviewSubject;
  assignment: ProviderRoleAssignment;
  submission: PlanReviewSubmission;
  providerPolicyDigest: string;
  targetSnapshotNode: EvidenceNode;
  runtimeAssurance?: PlanReviewRuntimeAssurance;
};

export type PlanReviewRuntimeAssurance = {
  assurance: 'unchanged-governed-projection';
  projectionDigest: string;
  sameUserProcessConfined: false;
  residuals: string[];
  executableSha256: string;
};

type NormalizedFinding = {
  findingId: string;
  kind: 'challenge';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'required';
  summary: string;
  evidence: PlanReviewEvidence[];
};

type NormalizedSuggestion = {
  suggestionId: string;
  kind: 'suggestion';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'independent-follow-up';
  summary: string;
  evidence: PlanReviewEvidence[];
};

type NormalizedSubmission = {
  verdict: PlanReviewVerdict;
  coverage: string[];
  scopeAssessment: PlanReviewScopeAssessment;
  findings: NormalizedFinding[];
  suggestions: NormalizedSuggestion[];
  proposedTerms: PlanReviewProposedTerm[];
  residualRisk: string;
  uncertainty: string;
};

const PLAN_REVIEW_SCHEMA_GRAMMAR = {
  schema: 'plan-review-output-grammar.v2',
  id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
  version: 2,
  submissionKeys: [...SUBMISSION_KEYS],
  storedOutputKeys: [...OUTPUT_KEYS],
  subjectKeys: [...SUBJECT_KEYS],
  roleAssignmentKeys: [...ROLE_ASSIGNMENT_KEYS],
  providerResult: {
    type: PROVIDER_RESULT_TYPE,
    nodeSchema: PROVIDER_RESULT_SCHEMA,
    evaluator: PROVIDER_RESULT_EVALUATOR,
    outputSchema: PROVIDER_RESULT_OUTPUT_SCHEMA,
    outputKeys: [...PROVIDER_RESULT_OUTPUT_KEYS],
    exactInputRoles: ['assignment', 'subject', 'submission'],
    semanticParentRoles: [],
    provenanceParentRoles: [],
  },
  reviewNode: {
    type: PLAN_REVIEW_TYPE,
    nodeSchema: PLAN_REVIEW_SCHEMA,
    evaluator: PLAN_REVIEW_EVALUATOR,
    outputSchema: PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID,
    exactInputRoles: ['assignment', 'subject', 'submission'],
    semanticParentRoles: ['providerResult'],
    provenanceParentRoles: ['providerResult'],
  },
  coverage: [...PLAN_REVIEW_COVERAGE],
  verdicts: [...VERDICTS],
  challenge: {
    submissionKeys: [
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ],
    storedKeys: [
      'findingId',
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ],
    categories: [...PLAN_REVIEW_COVERAGE],
    impact: 'required',
  },
  suggestion: {
    submissionKeys: [
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ],
    storedKeys: [
      'suggestionId',
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ],
    categories: [...FOLLOWUP_CATEGORIES],
    impact: 'independent-follow-up',
  },
  scopeAssessment: {
    challengesKeys: ['kind'],
    noChallengeKeys: ['kind', 'evidence'],
    requiredScopeChallengeCategories: ['missing-consumers', 'missing-scope'],
  },
  evidence: {
    kinds: [...EVIDENCE_KINDS],
    repositoryLocationKeys: ['kind', 'line', 'observation', 'path'],
    graphKeys: ['kind', 'nodeId', 'resultDigest'],
  },
  proposedTermKeys: ['kind', 'value'],
  termKinds: [...TERM_KINDS],
  disposition: {
    entryKeys: ['author', 'challengeId', 'decision', 'rationale'],
    decisions: [...DISPOSITION_DECISIONS],
    outputKeys: ['schemaVersion', 'dispositions'],
    exactInputRoles: ['dispositions'],
    semanticParentRoles: ['review'],
    provenanceParentRoles: ['review'],
  },
  independenceDimensions: [...INDEPENDENCE_DIMENSIONS],
  severities: [...SEVERITIES],
  limits: PLAN_REVIEW_LIMITS,
} as const;

const PLAN_REVIEW_GRAMMAR_DIGEST = sha256(
  canonicalJson(PLAN_REVIEW_SCHEMA_GRAMMAR),
);

/**
 * The provider-facing JSON Schema. Its comment binds the stricter code-owned
 * semantic grammar (coverage completeness, finding/category pairings, sorted
 * uniqueness, and evidence rules) that JSON Schema alone cannot express.
 *
 * The shape is additionally constrained by what a structured-output endpoint
 * accepts: `oneOf` is rejected outright, a `const` must carry a sibling `type`,
 * and `uniqueItems` is not permitted. Both unions here are discriminated by an
 * exclusive `kind`, so `anyOf` is equivalent, and coverage uniqueness is
 * enforced by `assertCoverage` rather than by the wire schema.
 *
 * Provider CLIs infer their supported dialect. The canonical schema therefore
 * omits an external `$schema` URI so request identity, runtime bytes, provider
 * input, and native validation remain exact while avoiding a pre-launch resolver
 * failure.
 */
export const PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
  $comment: `workflow-semantic-grammar-sha256:${PLAN_REVIEW_GRAMMAR_DIGEST}`,
  type: 'object',
  additionalProperties: false,
  required: [...SUBMISSION_KEYS],
  properties: {
    schemaVersion: { type: 'integer', const: 2 },
    verdict: { enum: [...VERDICTS] },
    coverage: {
      type: 'array',
      minItems: PLAN_REVIEW_COVERAGE.length,
      maxItems: PLAN_REVIEW_COVERAGE.length,
      items: { enum: [...PLAN_REVIEW_COVERAGE] },
    },
    scopeAssessment: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { type: 'string', const: 'challenges' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'evidence'],
          properties: {
            kind: { type: 'string', const: 'no-challenge' },
            evidence: {
              type: 'array',
              minItems: 1,
              items: { $ref: '#/$defs/evidence' },
            },
          },
        },
      ],
    },
    findings: {
      type: 'array',
      maxItems: PLAN_REVIEW_LIMITS.maxFindings,
      items: { $ref: '#/$defs/finding' },
    },
    proposedTerms: {
      type: 'array',
      maxItems: PLAN_REVIEW_LIMITS.maxProposedTerms,
      items: { $ref: '#/$defs/term' },
    },
    suggestions: {
      type: 'array',
      maxItems: PLAN_REVIEW_LIMITS.maxSuggestions,
      items: { $ref: '#/$defs/suggestion' },
    },
    residualRisk: { type: 'string', minLength: 1 },
    uncertainty: { type: 'string', minLength: 1 },
  },
  $defs: {
    evidence: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'path', 'line', 'observation'],
          properties: {
            kind: {
              enum: ['planning-location', 'repository-location'],
            },
            path: { type: 'string', minLength: 1 },
            line: { type: 'integer', minimum: 1 },
            observation: { type: 'string', minLength: 1 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'nodeId', 'resultDigest'],
          properties: {
            kind: { enum: ['investigation-node', 'survey-record'] },
            nodeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      ],
    },
    finding: {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
      ],
      properties: {
        kind: { type: 'string', const: 'challenge' },
        severity: { enum: [...SEVERITIES] },
        category: { enum: [...PLAN_REVIEW_COVERAGE] },
        currentChangeImpact: { type: 'string', const: 'required' },
        summary: { type: 'string', minLength: 1 },
        evidence: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/evidence' },
        },
      },
    },
    suggestion: {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
      ],
      properties: {
        kind: { type: 'string', const: 'suggestion' },
        severity: { enum: [...SEVERITIES] },
        category: { type: 'string', const: 'follow-up' },
        currentChangeImpact: {
          type: 'string',
          const: 'independent-follow-up',
        },
        summary: { type: 'string', minLength: 1 },
        evidence: { type: 'array', items: { $ref: '#/$defs/evidence' } },
      },
    },
    term: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'value'],
      properties: {
        kind: { enum: [...TERM_KINDS] },
        value: { type: 'string', minLength: 1 },
      },
    },
  },
});

const PLAN_REVIEW_OUTPUT_DIGEST = sha256(
  canonicalJson(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA),
);

/**
 * The code-owned schema identity for a plan-review provider submission. The
 * digest binds the fixed coverage set, verdict values, evidence kinds, and term
 * kinds so the accepted output grammar is reviewed and replayed rather than
 * driven by an external policy file.
 */
export const PLAN_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
  version: 2,
  digest: PLAN_REVIEW_OUTPUT_DIGEST,
});

/**
 * The bound validator for a plan-review submission. It accepts only a strictly
 * shaped submission — exact keys, complete coverage, evidence-bound findings,
 * and enumerated terms — and returns a literal boolean so a generic semantic
 * action (an unknown proposal key) is rejected rather than admitted.
 */
export const PLAN_REVIEW_OUTPUT_VALIDATOR = Object.freeze({
  id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
  version: 2,
  digest: PLAN_REVIEW_OUTPUT_DIGEST,
  validate(value: unknown): boolean {
    try {
      assertPlanReviewSubmission(value);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Bind a planning generation into an immutable review subject. The subject
 * digest fixes the governing generation, exact plan target, investigation
 * baseline and dependencies, review policy, and required independence. The
 * review policy must match the generation's own review policy so a subject
 * cannot bind an inconsistent policy.
 */
export function createPlanReviewSubject(
  input: PlanReviewSubjectInput,
): PlanReviewSubject {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'generation',
      'reviewPolicyDigest',
      'requiredIndependence',
    ])
  ) {
    throw planReviewInvalid('Plan review subject input shape is malformed.');
  }
  let generation: PlanningGeneration;
  try {
    generation = assertPlanningGeneration(input.generation);
  } catch {
    throw planReviewInvalid('Plan review subject generation is malformed.');
  }
  const reviewPolicyDigest = input.reviewPolicyDigest;
  const requiredIndependence = input.requiredIndependence;
  const generationPolicy = generation.policies.reviewPolicyDigest;
  if (
    !isDigest(generation.planningGenerationId) ||
    !isDigest(generation.targetDigest) ||
    !isDigest(generationPolicy) ||
    !isDigest(reviewPolicyDigest) ||
    reviewPolicyDigest !== generationPolicy
  ) {
    throw planReviewInvalid(
      'Plan review policy digest must match the planning generation.',
    );
  }
  if (requiredIndependence !== 'provider-independent') {
    throw planReviewInvalid(
      'Plan review requires provider-independent separation.',
    );
  }
  const baseline = assertBaseline(generation.investigationBaseline);
  const dependencies = assertDependencies(generation.investigationDependencies);

  const fields = {
    planningGenerationId: generation.planningGenerationId,
    planTargetDigest: generation.targetDigest,
    reviewPolicyDigest,
    requiredIndependence,
    investigationBaseline: baseline,
    investigationDependencies: dependencies,
  };

  const subject: PlanReviewSubject = {
    schemaVersion: 1,
    subjectDigest: planReviewSubjectDigest(fields),
    planningGenerationId: fields.planningGenerationId,
    planTargetDigest: fields.planTargetDigest,
    reviewPolicyDigest: fields.reviewPolicyDigest,
    requiredIndependence: fields.requiredIndependence,
    investigationBaseline: fields.investigationBaseline,
    investigationDependencies: fields.investigationDependencies,
  };
  return assertPlanReviewSubject(subject);
}

/**
 * Strictly replay a serialized PlanReview subject. The subject is a closed
 * schema, carries canonical investigation dependencies, and must reproduce its
 * own digest. Construction separately validates the complete planning generation
 * so a caller cannot manufacture a subject from a trusted-looking generation ID.
 */
export function assertPlanReviewSubject(value: unknown): PlanReviewSubject {
  const record = assertExactKeys(value, SUBJECT_KEYS);
  if (
    record.schemaVersion !== 1 ||
    !isDigest(record.subjectDigest) ||
    !isDigest(record.planningGenerationId) ||
    !isDigest(record.planTargetDigest) ||
    !isDigest(record.reviewPolicyDigest) ||
    record.requiredIndependence !== 'provider-independent'
  ) {
    throw planReviewInvalid('Plan review subject binding is malformed.');
  }
  const investigationBaseline = assertBaseline(record.investigationBaseline);
  const investigationDependencies = assertDependencies(
    record.investigationDependencies,
  );
  const subject: PlanReviewSubject = {
    schemaVersion: 1,
    subjectDigest: record.subjectDigest,
    planningGenerationId: record.planningGenerationId,
    planTargetDigest: record.planTargetDigest,
    reviewPolicyDigest: record.reviewPolicyDigest,
    requiredIndependence: 'provider-independent',
    investigationBaseline,
    investigationDependencies,
  };
  if (planReviewSubjectDigest(subject) !== subject.subjectDigest) {
    throw planReviewInvalid('Plan review subject digest does not match.');
  }
  return deepFreeze(subject);
}

/**
 * Recompute the canonical subject digest from its governing fields. Live
 * construction and replay validation share this so a tampered subject whose
 * stored digest no longer matches its fields is detectable.
 */
export function planReviewSubjectDigest(fields: {
  planningGenerationId: string;
  planTargetDigest: string;
  reviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
  investigationBaseline: { head: string; tree: string };
  investigationDependencies: Array<{
    role: string;
    nodeId: string;
    resultDigest: string;
  }>;
}): string {
  return sha256(
    canonicalJson({
      schema: 'plan-review-subject.v1',
      planningGenerationId: fields.planningGenerationId,
      planTargetDigest: fields.planTargetDigest,
      reviewPolicyDigest: fields.reviewPolicyDigest,
      requiredIndependence: fields.requiredIndependence,
      investigationBaseline: fields.investigationBaseline,
      investigationDependencies: fields.investigationDependencies,
    }),
  );
}

/**
 * Wrap one already-validated provider semantic result in the exact evidence
 * shape consumed by PlanReview construction. Task 6.5 may bridge a real bounded
 * adapter result into this helper; the wrapper itself deliberately carries no
 * runtime-only launch metadata.
 */
export function createPlanReviewProviderResultNode(
  input: PlanReviewProviderResultNodeInput,
): EvidenceNode {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'subject',
      'assignment',
      'submission',
      'providerPolicyDigest',
      'targetSnapshotNode',
      ...(Object.hasOwn(input, 'runtimeAssurance')
        ? ['runtimeAssurance' as const]
        : []),
    ])
  ) {
    throw planReviewInvalid('Plan review provider result input is malformed.');
  }
  const subject = assertPlanReviewSubject(input.subject);
  const assignment = assertAssignment(input.assignment, subject);
  if (!isDigest(input.providerPolicyDigest)) {
    throw planReviewInvalid('Plan review provider policy digest is malformed.');
  }
  const normalized = assertPlanReviewSubmission(input.submission);
  assertSubmissionEvidenceBindings(normalized, subject);
  const submission = canonicalSubmission(normalized);
  const runtimeAssurance = assertPlanReviewRuntimeAssurance(
    input.runtimeAssurance ?? null,
  );
  const targetSnapshot = assertProviderTargetSnapshot(
    input.targetSnapshotNode,
    subject,
  );
  const assignmentDigest = planReviewAssignmentDigest(assignment);
  const submissionDigest = planReviewSubmissionDigest(submission);

  return createEvidenceNode({
    type: PROVIDER_RESULT_TYPE,
    nodeSchema: PROVIDER_RESULT_SCHEMA,
    evaluator: PROVIDER_RESULT_EVALUATOR,
    policyDigest: input.providerPolicyDigest,
    exactInputDigests: {
      assignment: assignmentDigest,
      subject: subject.subjectDigest,
      submission: submissionDigest,
      targetSnapshot: targetSnapshot.nodeId,
    },
    semanticParentResultDigests: {
      targetSnapshot: targetSnapshot.resultDigest,
    },
    provenanceParentNodeIds: { targetSnapshot: targetSnapshot.nodeId },
    outputSchema: PROVIDER_RESULT_OUTPUT_SCHEMA,
    output: {
      schemaVersion: 2,
      subjectDigest: subject.subjectDigest,
      assignment,
      submission,
      runtimeAssurance,
    },
    runtimeMetadata: {},
  });
}

export function planReviewAssignmentDigest(
  assignment: ProviderRoleAssignment,
): string {
  return sha256(
    canonicalJson({
      schema: 'plan-review-assignment.v1',
      assignment,
    }),
  );
}

export function planReviewSubmissionDigest(
  submission: PlanReviewSubmission,
): string {
  return sha256(
    canonicalJson({
      schema: 'plan-review-submission.v2',
      submission,
    }),
  );
}

/**
 * Construct an immutable exact-plan review evidence node from a strict
 * submission. The submission must carry complete coverage and an evidence-bound
 * challenge or structured no-challenge conclusion; the reviewer assignment must
 * bind this subject with achieved provider independence; and the provider result
 * must have observed the same subject. The node binds the subject, assignment,
 * and submission digests and derives its identity from that canonical content.
 */
export function createPlanReviewNode(input: PlanReviewNodeInput): EvidenceNode {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'subject',
      'assignment',
      'providerResultNode',
      'submission',
    ])
  ) {
    throw planReviewInvalid('Plan review node input shape is malformed.');
  }
  const subject = assertPlanReviewSubject(input.subject);
  const assignment = assertAssignment(input.assignment, subject);
  const normalized = assertPlanReviewSubmission(input.submission);
  assertSubmissionEvidenceBindings(normalized, subject);
  const submission = canonicalSubmission(normalized);
  const providerResult = assertProviderResult(
    input.providerResultNode,
    subject,
    assignment,
    submission,
  );

  const output = {
    schemaVersion: 2,
    planningGenerationId: subject.planningGenerationId,
    planTargetDigest: subject.planTargetDigest,
    subjectDigest: subject.subjectDigest,
    assignment,
    verdict: normalized.verdict,
    coverage: normalized.coverage,
    scopeAssessment: normalized.scopeAssessment,
    findings: normalized.findings,
    suggestions: normalized.suggestions,
    proposedTerms: normalized.proposedTerms,
    residualRisk: normalized.residualRisk,
    uncertainty: normalized.uncertainty,
    requiredIndependence: subject.requiredIndependence,
    achievedIndependence: assignment.achievedIndependence,
  };

  const submissionDigest = planReviewSubmissionDigest(submission);
  const assignmentDigest = planReviewAssignmentDigest(assignment);

  return createEvidenceNode({
    type: PLAN_REVIEW_TYPE,
    nodeSchema: PLAN_REVIEW_SCHEMA,
    evaluator: PLAN_REVIEW_EVALUATOR,
    policyDigest: subject.reviewPolicyDigest,
    exactInputDigests: {
      subject: subject.subjectDigest,
      assignment: assignmentDigest,
      submission: submissionDigest,
    },
    semanticParentResultDigests: {
      providerResult: providerResult.resultDigest,
    },
    provenanceParentNodeIds: { providerResult: providerResult.nodeId },
    outputSchema: PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID,
    output,
    runtimeMetadata: {},
  });
}

/**
 * Read a stored plan-review node back into a deeply frozen typed report. The
 * node identity, complete coverage, evidence-bound findings, recomputed finding
 * identities, scope conclusion, terms, and independence are all revalidated so a
 * tampered stored node fails closed.
 */
export function readPlanReviewNode(node: EvidenceNode): PlanReviewReport {
  const validated = assertStoredEvidenceNode(node, () =>
    planReviewInvalid('Plan review node envelope is malformed.'),
  );
  if (
    validated.type !== PLAN_REVIEW_TYPE ||
    validated.nodeSchema !== PLAN_REVIEW_SCHEMA ||
    validated.evaluator !== PLAN_REVIEW_EVALUATOR ||
    validated.outputSchema !== PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID
  ) {
    throw planReviewInvalid('Plan review node identity is unexpected.');
  }
  assertExactDigestRoles(
    validated.exactInputDigests,
    ['assignment', 'subject', 'submission'],
    'Plan review exact-input roles are unexpected.',
  );
  assertExactDigestRoles(
    validated.semanticParentResultDigests,
    ['providerResult'],
    'Plan review semantic-parent roles are unexpected.',
  );
  assertExactDigestRoles(
    validated.provenanceParentNodeIds,
    ['providerResult'],
    'Plan review provenance-parent roles are unexpected.',
  );
  if (Object.keys(validated.runtimeMetadata).length !== 0) {
    throw planReviewInvalid('Plan review runtime metadata must be empty.');
  }
  const subjectDigest = validated.exactInputDigests.subject;
  if (!isDigest(subjectDigest)) {
    throw planReviewInvalid('Plan review node is not bound to a subject.');
  }

  const output = assertExactKeys(validated.output, OUTPUT_KEYS);
  if (output.schemaVersion !== 2) {
    throw planReviewInvalid('Plan review output schema version must be 2.');
  }
  if (
    !isDigest(output.planningGenerationId) ||
    !isDigest(output.planTargetDigest) ||
    output.subjectDigest !== subjectDigest
  ) {
    throw planReviewInvalid('Plan review governing identities are malformed.');
  }
  const assignment = assertAssignmentForSubjectDigest(
    output.assignment,
    subjectDigest,
  );
  if (
    validated.exactInputDigests.assignment !==
    planReviewAssignmentDigest(assignment)
  ) {
    throw planReviewInvalid('Plan review assignment digest does not match.');
  }
  if (typeof output.verdict !== 'string' || !VERDICTS.has(output.verdict)) {
    throw planReviewInvalid('Plan review verdict is unexpected.');
  }
  const coverage = assertCoverage(output.coverage);
  const findings = assertBoundedArray(
    output.findings,
    PLAN_REVIEW_LIMITS.maxFindings,
    'Plan review contains too many stored findings.',
  ).map((entry) => assertStoredChallenge(entry));
  assertUniqueChallengeIds(findings.map((finding) => finding.findingId));
  assertCanonicalIdentityOrder(
    findings.map((finding) => finding.findingId),
    'Plan review challenges are not canonically sorted.',
  );
  const suggestions = assertBoundedArray(
    output.suggestions,
    PLAN_REVIEW_LIMITS.maxSuggestions,
    'Plan review contains too many stored suggestions.',
  ).map((entry) => assertStoredSuggestion(entry));
  assertCanonicalIdentityOrder(
    suggestions.map((suggestion) => suggestion.suggestionId),
    'Plan review suggestions are not canonically sorted.',
    true,
  );
  const proposedTerms = assertProposedTerms(output.proposedTerms);
  const residualRisk = assertBoundedRequiredText(
    output.residualRisk,
    PLAN_REVIEW_LIMITS.maxResidualRiskBytes,
    'Plan review residual risk is malformed.',
  );
  const uncertainty = assertBoundedRequiredText(
    output.uncertainty,
    PLAN_REVIEW_LIMITS.maxUncertaintyBytes,
    'Plan review uncertainty is malformed.',
  );
  const scopeAssessment = assertScopeAssessment(
    output.scopeAssessment,
    findings,
  );
  if (
    output.requiredIndependence !== assignment.requiredIndependence ||
    output.achievedIndependence !== assignment.achievedIndependence ||
    assignment.requiredIndependence !== 'provider-independent'
  ) {
    throw planReviewInvalid('Plan review independence labels are unexpected.');
  }
  const normalizedSubmission = assertPlanReviewSubmission({
    schemaVersion: 2,
    verdict: output.verdict,
    coverage,
    scopeAssessment,
    findings: findings.map(stripChallengeIdentity),
    proposedTerms,
    suggestions: suggestions.map(stripSuggestionIdentity),
    residualRisk,
    uncertainty,
  });
  const submission = canonicalSubmission(normalizedSubmission);
  const storedSubmission = {
    schemaVersion: 2,
    verdict: output.verdict,
    coverage: output.coverage,
    scopeAssessment: output.scopeAssessment,
    findings: findings.map(stripChallengeIdentity),
    proposedTerms: output.proposedTerms,
    suggestions: suggestions.map(stripSuggestionIdentity),
    residualRisk: output.residualRisk,
    uncertainty: output.uncertainty,
  };
  if (canonicalJson(storedSubmission) !== canonicalJson(submission)) {
    throw planReviewInvalid(
      'Plan review output is not canonically normalized.',
    );
  }
  if (
    validated.exactInputDigests.submission !==
    planReviewSubmissionDigest(submission)
  ) {
    throw planReviewInvalid('Plan review submission digest does not match.');
  }

  const report: PlanReviewReport = {
    schemaVersion: 2,
    nodeId: validated.nodeId,
    resultDigest: validated.resultDigest,
    policyDigest: validated.policyDigest,
    subjectDigest,
    planningGenerationId: output.planningGenerationId,
    planTargetDigest: output.planTargetDigest,
    assignment,
    providerResultNodeId: validated.provenanceParentNodeIds.providerResult,
    providerResultResultDigest:
      validated.semanticParentResultDigests.providerResult,
    verdict: output.verdict as PlanReviewVerdict,
    coverage,
    scopeAssessment,
    findings,
    suggestions,
    proposedTerms,
    residualRisk,
    uncertainty,
    requiredIndependence: assignment.requiredIndependence,
    achievedIndependence: assignment.achievedIndependence,
  };
  return deepFreeze(report);
}

/**
 * Bind a disposition for every named challenge into an immutable node that
 * descends from the exact review. Each disposition must name a real challenge in
 * the review with an allowed decision and rationale; an unknown or duplicated
 * challenge fails closed.
 */
export function createPlanReviewDispositionNode(
  input: PlanReviewDispositionInput,
): EvidenceNode {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['reviewNode', 'policyDigest', 'dispositions'])
  ) {
    throw planReviewInvalid('Plan review disposition input is malformed.');
  }
  const review = readPlanReviewNode(input.reviewNode);
  if (!isDigest(input.policyDigest)) {
    throw planReviewInvalid(
      'Plan review disposition policy digest is invalid.',
    );
  }
  const challengeIds = new Set(
    review.findings.map((finding) => finding.findingId),
  );
  const dispositions = assertBoundedArray(
    input.dispositions,
    PLAN_REVIEW_LIMITS.maxFindings,
    'Plan review contains too many dispositions.',
  ).map((entry) => assertDisposition(entry));
  if (dispositions.length === 0) {
    throw planReviewInvalid('Plan review disposition set must not be empty.');
  }
  const seen = new Set<string>();
  for (const disposition of dispositions) {
    if (!challengeIds.has(disposition.challengeId)) {
      throw planReviewInvalid('Disposition names an unknown challenge.');
    }
    if (seen.has(disposition.challengeId)) {
      throw planReviewInvalid('Disposition duplicates a challenge.');
    }
    seen.add(disposition.challengeId);
  }
  const sorted = [...dispositions].sort((left, right) =>
    left.challengeId < right.challengeId ? -1 : 1,
  );

  return createEvidenceNode({
    type: DISPOSITION_TYPE,
    nodeSchema: DISPOSITION_SCHEMA,
    evaluator: DISPOSITION_EVALUATOR,
    policyDigest: input.policyDigest,
    exactInputDigests: {
      dispositions: planReviewDispositionDigest(sorted),
    },
    semanticParentResultDigests: { review: input.reviewNode.resultDigest },
    provenanceParentNodeIds: { review: input.reviewNode.nodeId },
    outputSchema: DISPOSITION_OUTPUT_SCHEMA,
    output: { schemaVersion: 1, dispositions: sorted },
    runtimeMetadata: {},
  });
}

/**
 * Read a stored disposition node back into its typed record, revalidating the
 * bound review provenance, allowed decisions, and canonical ordering.
 */
export function readPlanReviewDispositionNode(
  node: EvidenceNode,
): PlanReviewDispositionRecord {
  const validated = assertStoredEvidenceNode(node, () =>
    planReviewInvalid('Plan review disposition envelope is malformed.'),
  );
  if (
    validated.type !== DISPOSITION_TYPE ||
    validated.nodeSchema !== DISPOSITION_SCHEMA ||
    validated.evaluator !== DISPOSITION_EVALUATOR ||
    validated.outputSchema !== DISPOSITION_OUTPUT_SCHEMA
  ) {
    throw planReviewInvalid('Plan review disposition identity is unexpected.');
  }
  assertExactDigestRoles(
    validated.exactInputDigests,
    ['dispositions'],
    'Plan review disposition exact-input roles are unexpected.',
  );
  assertExactDigestRoles(
    validated.semanticParentResultDigests,
    ['review'],
    'Plan review disposition semantic-parent roles are unexpected.',
  );
  assertExactDigestRoles(
    validated.provenanceParentNodeIds,
    ['review'],
    'Plan review disposition provenance-parent roles are unexpected.',
  );
  if (Object.keys(validated.runtimeMetadata).length !== 0) {
    throw planReviewInvalid(
      'Plan review disposition runtime metadata must be empty.',
    );
  }
  const reviewNodeId = validated.provenanceParentNodeIds.review;
  const reviewResultDigest = validated.semanticParentResultDigests.review;
  if (!isDigest(reviewNodeId) || !isDigest(reviewResultDigest)) {
    throw planReviewInvalid('Disposition is not bound to a review.');
  }
  const output = assertExactKeys(validated.output, [
    'schemaVersion',
    'dispositions',
  ]);
  if (output.schemaVersion !== 1) {
    throw planReviewInvalid('Disposition output schema version must be 1.');
  }
  const dispositions = assertBoundedArray(
    output.dispositions,
    PLAN_REVIEW_LIMITS.maxFindings,
    'Plan review contains too many dispositions.',
  ).map((entry) => assertDisposition(entry));
  if (dispositions.length === 0) {
    throw planReviewInvalid('Plan review disposition set must not be empty.');
  }
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const disposition of dispositions) {
    if (seen.has(disposition.challengeId)) {
      throw planReviewInvalid('Disposition duplicates a challenge.');
    }
    if (previous !== null && disposition.challengeId <= previous) {
      throw planReviewInvalid('Dispositions are not canonically sorted.');
    }
    seen.add(disposition.challengeId);
    previous = disposition.challengeId;
  }
  if (
    validated.exactInputDigests.dispositions !==
    planReviewDispositionDigest(dispositions)
  ) {
    throw planReviewInvalid(
      'Plan review disposition input digest does not match.',
    );
  }
  const record: PlanReviewDispositionRecord = {
    reviewNodeId,
    reviewResultDigest,
    policyDigest: validated.policyDigest,
    dispositions,
  };
  return deepFreeze(record);
}

function planReviewDispositionDigest(
  dispositions: PlanReviewDispositionEntry[],
): string {
  return sha256(
    canonicalJson({
      schema: 'plan-review-disposition-input.v1',
      dispositions,
    }),
  );
}

function assertAssignment(
  value: unknown,
  subject: PlanReviewSubject,
): ProviderRoleAssignment {
  return assertAssignmentForSubjectDigest(value, subject.subjectDigest);
}

function assertAssignmentForSubjectDigest(
  value: unknown,
  subjectDigest: string,
): ProviderRoleAssignment {
  if (!isProviderRoleAssignment(value)) {
    throw planReviewInvalid('Plan reviewer assignment shape is malformed.');
  }
  if (
    value.role !== 'plan-reviewer' ||
    !isProviderId(value.providerId) ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.trim().length === 0 ||
    Buffer.byteLength(value.sessionId, 'utf8') >
      PLAN_REVIEW_LIMITS.maxAuthorBytes ||
    value.targetDigest !== subjectDigest ||
    value.requiredIndependence !== 'provider-independent'
  ) {
    throw planReviewInvalid(
      'Plan reviewer assignment does not bind the subject.',
    );
  }
  return structuredClone(value);
}

function assertProviderResult(
  value: unknown,
  subject: PlanReviewSubject,
  assignment: ProviderRoleAssignment,
  expectedSubmission: PlanReviewSubmission,
): EvidenceNode {
  const node = assertStoredEvidenceNode(value, () =>
    planReviewInvalid('Provider result node is malformed.'),
  );
  if (
    node.type !== PROVIDER_RESULT_TYPE ||
    node.nodeSchema !== PROVIDER_RESULT_SCHEMA ||
    node.evaluator !== PROVIDER_RESULT_EVALUATOR ||
    node.outputSchema !== PROVIDER_RESULT_OUTPUT_SCHEMA
  ) {
    throw planReviewInvalid('Provider result node identity is unexpected.');
  }
  assertExactDigestRoles(
    node.exactInputDigests,
    ['assignment', 'subject', 'submission', 'targetSnapshot'],
    'Provider result exact-input roles are unexpected.',
  );
  assertExactDigestRoles(
    node.semanticParentResultDigests,
    ['targetSnapshot'],
    'Provider result semantic-parent roles are unexpected.',
  );
  assertExactDigestRoles(
    node.provenanceParentNodeIds,
    ['targetSnapshot'],
    'Provider result provenance-parent roles are unexpected.',
  );
  if (Object.keys(node.runtimeMetadata).length !== 0) {
    throw planReviewInvalid('Provider result runtime metadata must be empty.');
  }
  if (
    node.exactInputDigests.targetSnapshot !==
      node.provenanceParentNodeIds.targetSnapshot ||
    !isDigest(node.semanticParentResultDigests.targetSnapshot)
  ) {
    throw planReviewInvalid(
      'Provider result target snapshot binding is malformed.',
    );
  }
  const output = assertExactKeys(node.output, PROVIDER_RESULT_OUTPUT_KEYS);
  if (
    output.schemaVersion !== 2 ||
    output.subjectDigest !== subject.subjectDigest ||
    node.exactInputDigests.subject !== subject.subjectDigest
  ) {
    throw planReviewInvalid(
      'Provider result did not observe the review subject.',
    );
  }
  const storedAssignment = assertAssignment(output.assignment, subject);
  if (
    canonicalJson(storedAssignment) !== canonicalJson(assignment) ||
    node.exactInputDigests.assignment !==
      planReviewAssignmentDigest(storedAssignment)
  ) {
    throw planReviewInvalid(
      'Provider result did not use the reviewer assignment.',
    );
  }
  const normalizedSubmission = assertPlanReviewSubmission(output.submission);
  assertPlanReviewRuntimeAssurance(output.runtimeAssurance);
  assertSubmissionEvidenceBindings(normalizedSubmission, subject);
  const submission = canonicalSubmission(normalizedSubmission);
  if (
    canonicalJson(submission) !== canonicalJson(expectedSubmission) ||
    node.exactInputDigests.submission !== planReviewSubmissionDigest(submission)
  ) {
    throw planReviewInvalid(
      'Provider result semantic output differs from the review submission.',
    );
  }
  return node;
}

function assertProviderTargetSnapshot(
  value: unknown,
  subject: PlanReviewSubject,
): EvidenceNode {
  const node = assertStoredEvidenceNode(value, () =>
    planReviewInvalid('Provider target snapshot node is malformed.'),
  );
  let snapshot: PlanReviewTargetSnapshot;
  try {
    snapshot = readPlanReviewTargetSnapshotNode(node);
  } catch {
    throw planReviewInvalid('Provider target snapshot node is malformed.');
  }
  if (
    snapshot.subjectDigest !== subject.subjectDigest ||
    snapshot.planningGenerationId !== subject.planningGenerationId ||
    snapshot.planTargetDigest !== subject.planTargetDigest ||
    node.policyDigest !== subject.reviewPolicyDigest
  ) {
    throw planReviewInvalid(
      'Provider target snapshot does not bind the review subject.',
    );
  }
  return node;
}

function assertPlanReviewRuntimeAssurance(
  value: unknown,
): PlanReviewRuntimeAssurance | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'assurance',
      'projectionDigest',
      'sameUserProcessConfined',
      'residuals',
      'executableSha256',
    ]) ||
    value.assurance !== 'unchanged-governed-projection' ||
    !isDigest(value.projectionDigest) ||
    value.sameUserProcessConfined !== false ||
    !Array.isArray(value.residuals) ||
    value.residuals.length === 0 ||
    value.residuals.some(
      (residual) => typeof residual !== 'string' || residual.length === 0,
    ) ||
    new Set(value.residuals).size !== value.residuals.length ||
    !isDigest(value.executableSha256)
  ) {
    throw planReviewInvalid('Provider runtime assurance is malformed.');
  }
  return deepFreeze(structuredClone(value)) as PlanReviewRuntimeAssurance;
}

function assertPlanReviewSubmission(value: unknown): NormalizedSubmission {
  if (!isRecord(value) || !hasExactKeys(value, SUBMISSION_KEYS)) {
    throw planReviewInvalid('Plan review submission shape is malformed.');
  }
  if (value.schemaVersion !== 2) {
    throw planReviewInvalid('Plan review submission schema version must be 2.');
  }
  if (typeof value.verdict !== 'string' || !VERDICTS.has(value.verdict)) {
    throw planReviewInvalid('Plan review verdict is unexpected.');
  }
  const coverage = assertCoverage(value.coverage);
  const findings = assertBoundedArray(
    value.findings,
    PLAN_REVIEW_LIMITS.maxFindings,
    'Plan review contains too many findings.',
  )
    .map((entry) => assertSubmissionChallenge(entry))
    .sort((left, right) =>
      left.findingId < right.findingId
        ? -1
        : left.findingId > right.findingId
          ? 1
          : 0,
    );
  assertUniqueChallengeIds(findings.map((finding) => finding.findingId));
  const suggestions = assertBoundedArray(
    value.suggestions,
    PLAN_REVIEW_LIMITS.maxSuggestions,
    'Plan review contains too many suggestions.',
  )
    .map((entry) => assertSubmissionSuggestion(entry))
    .sort((left, right) =>
      left.suggestionId < right.suggestionId
        ? -1
        : left.suggestionId > right.suggestionId
          ? 1
          : 0,
    );
  const proposedTerms = assertProposedTerms(value.proposedTerms);
  const scopeAssessment = assertScopeAssessment(
    value.scopeAssessment,
    findings,
  );
  const residualRisk = assertBoundedRequiredText(
    value.residualRisk,
    PLAN_REVIEW_LIMITS.maxResidualRiskBytes,
    'Plan review residual risk is malformed.',
  );
  const uncertainty = assertBoundedRequiredText(
    value.uncertainty,
    PLAN_REVIEW_LIMITS.maxUncertaintyBytes,
    'Plan review uncertainty is malformed.',
  );
  return {
    verdict: value.verdict as PlanReviewVerdict,
    coverage,
    scopeAssessment,
    findings,
    suggestions,
    proposedTerms,
    residualRisk,
    uncertainty,
  };
}

function canonicalSubmission(
  submission: NormalizedSubmission,
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: submission.verdict,
    coverage: [...submission.coverage],
    scopeAssessment:
      submission.scopeAssessment.kind === 'challenges'
        ? { kind: 'challenges' }
        : {
            kind: 'no-challenge',
            evidence: submission.scopeAssessment.evidence.map((entry) => ({
              ...entry,
            })),
          },
    findings: submission.findings.map(stripChallengeIdentity),
    proposedTerms: submission.proposedTerms.map((term) => ({ ...term })),
    suggestions: submission.suggestions.map(stripSuggestionIdentity),
    residualRisk: submission.residualRisk,
    uncertainty: submission.uncertainty,
  };
}

function stripChallengeIdentity(finding: NormalizedFinding): PlanReviewFinding {
  return {
    kind: 'challenge',
    severity: finding.severity,
    category: finding.category,
    currentChangeImpact: 'required',
    summary: finding.summary,
    evidence: finding.evidence.map((entry) => ({ ...entry })),
  };
}

function stripSuggestionIdentity(
  suggestion: NormalizedSuggestion,
): PlanReviewFinding {
  return {
    kind: 'suggestion',
    severity: suggestion.severity,
    category: suggestion.category,
    currentChangeImpact: 'independent-follow-up',
    summary: suggestion.summary,
    evidence: suggestion.evidence.map((entry) => ({ ...entry })),
  };
}

function assertSubmissionEvidenceBindings(
  submission: NormalizedSubmission,
  subject: PlanReviewSubject,
): void {
  const allowedGraphEvidence = new Set(
    subject.investigationDependencies.map(
      ({ nodeId, resultDigest }) => `${nodeId}\u0000${resultDigest}`,
    ),
  );
  const evidence = [
    ...submission.findings.flatMap((finding) => finding.evidence),
    ...submission.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(submission.scopeAssessment.kind === 'no-challenge'
      ? submission.scopeAssessment.evidence
      : []),
  ];
  for (const citation of evidence) {
    if (
      (citation.kind === 'investigation-node' ||
        citation.kind === 'survey-record') &&
      !allowedGraphEvidence.has(
        `${citation.nodeId}\u0000${citation.resultDigest}`,
      )
    ) {
      throw planReviewInvalid(
        'Plan review graph evidence is not bound to the investigation subject.',
      );
    }
  }
}

function assertSubmissionChallenge(value: unknown): NormalizedFinding {
  const record = assertExactKeys(value, [
    'kind',
    'severity',
    'category',
    'currentChangeImpact',
    'summary',
    'evidence',
  ]);
  return normalizeChallenge(record);
}

function assertStoredChallenge(value: unknown): NormalizedFinding {
  const record = assertExactKeys(value, [
    'findingId',
    'kind',
    'severity',
    'category',
    'currentChangeImpact',
    'summary',
    'evidence',
  ]);
  const normalized = normalizeChallenge(record);
  if (record.findingId !== normalized.findingId) {
    throw planReviewInvalid('Plan review challenge identity does not match.');
  }
  if (
    canonicalJson(record) !==
    canonicalJson({
      findingId: normalized.findingId,
      ...stripChallengeIdentity(normalized),
    })
  ) {
    throw planReviewInvalid('Plan review challenge is not canonical.');
  }
  return normalized;
}

function normalizeChallenge(
  record: Record<string, unknown>,
): NormalizedFinding {
  if (record.kind !== 'challenge') {
    throw planReviewInvalid('A required finding must be a challenge.');
  }
  if (record.currentChangeImpact !== 'required') {
    throw planReviewInvalid('A challenge must be current-change required.');
  }
  const category = record.category;
  if (typeof category !== 'string' || !COVERAGE_SET.has(category)) {
    throw planReviewInvalid('Plan review challenge category is unexpected.');
  }
  const summary = assertSummary(record.summary);
  const severity = assertSeverity(record.severity);
  const evidence = assertEvidenceArray(record.evidence);
  return {
    findingId: findingDigest(
      'challenge',
      severity,
      category,
      'required',
      summary,
      evidence,
    ),
    kind: 'challenge',
    severity,
    category,
    currentChangeImpact: 'required',
    summary,
    evidence,
  };
}

function assertSubmissionSuggestion(value: unknown): NormalizedSuggestion {
  const record = assertExactKeys(value, [
    'kind',
    'severity',
    'category',
    'currentChangeImpact',
    'summary',
    'evidence',
  ]);
  return normalizeSuggestion(record);
}

function assertStoredSuggestion(value: unknown): NormalizedSuggestion {
  const record = assertExactKeys(value, [
    'suggestionId',
    'kind',
    'severity',
    'category',
    'currentChangeImpact',
    'summary',
    'evidence',
  ]);
  const normalized = normalizeSuggestion(record);
  if (record.suggestionId !== normalized.suggestionId) {
    throw planReviewInvalid('Plan review suggestion identity does not match.');
  }
  if (
    canonicalJson(record) !==
    canonicalJson({
      suggestionId: normalized.suggestionId,
      ...stripSuggestionIdentity(normalized),
    })
  ) {
    throw planReviewInvalid('Plan review suggestion is not canonical.');
  }
  return normalized;
}

function normalizeSuggestion(
  record: Record<string, unknown>,
): NormalizedSuggestion {
  if (record.kind !== 'suggestion') {
    throw planReviewInvalid('An independent finding must be a suggestion.');
  }
  if (record.currentChangeImpact !== 'independent-follow-up') {
    throw planReviewInvalid('A suggestion must be an independent follow-up.');
  }
  const category = record.category;
  if (typeof category !== 'string' || !FOLLOWUP_CATEGORIES.has(category)) {
    throw planReviewInvalid('Plan review suggestion category is unexpected.');
  }
  const summary = assertSummary(record.summary);
  const severity = assertSeverity(record.severity);
  const evidence = assertEvidenceArray(record.evidence);
  return {
    suggestionId: findingDigest(
      'suggestion',
      severity,
      category,
      'independent-follow-up',
      summary,
      evidence,
    ),
    kind: 'suggestion',
    severity,
    category,
    currentChangeImpact: 'independent-follow-up',
    summary,
    evidence,
  };
}

function assertScopeAssessment(
  value: unknown,
  findings: NormalizedFinding[],
): PlanReviewScopeAssessment {
  if (!isRecord(value)) {
    throw planReviewInvalid('Plan review scope assessment is malformed.');
  }
  if (value.kind === 'challenges') {
    assertExactKeys(value, ['kind']);
    if (
      !findings.some(
        ({ category }) =>
          category === 'missing-scope' || category === 'missing-consumers',
      )
    ) {
      throw planReviewInvalid(
        'A challenges scope assessment requires an explicit scope challenge.',
      );
    }
    return { kind: 'challenges' };
  }
  if (value.kind === 'no-challenge') {
    assertExactKeys(value, ['kind', 'evidence']);
    const evidence = assertEvidenceArray(value.evidence);
    if (
      findings.some(
        ({ category }) =>
          category === 'missing-scope' || category === 'missing-consumers',
      )
    ) {
      throw planReviewInvalid(
        'A no-challenge scope assessment cannot carry a scope challenge.',
      );
    }
    return { kind: 'no-challenge', evidence };
  }
  throw planReviewInvalid('Plan review scope assessment kind is unexpected.');
}

function assertCoverage(value: unknown): string[] {
  if (!isDenseArray(value) || value.length !== PLAN_REVIEW_COVERAGE.length) {
    throw planReviewInvalid('Plan review coverage is incomplete.');
  }
  const seen = new Set<string>();
  for (const area of value) {
    if (typeof area !== 'string' || !COVERAGE_SET.has(area) || seen.has(area)) {
      throw planReviewInvalid('Plan review coverage is malformed.');
    }
    seen.add(area);
  }
  for (const area of PLAN_REVIEW_COVERAGE) {
    if (!seen.has(area)) {
      throw planReviewInvalid('Plan review coverage is incomplete.');
    }
  }
  return [...PLAN_REVIEW_COVERAGE];
}

function assertProposedTerms(value: unknown): PlanReviewProposedTerm[] {
  const terms = assertBoundedArray(
    value,
    PLAN_REVIEW_LIMITS.maxProposedTerms,
    'Plan review contains too many proposed terms.',
  ).map((entry) => {
    const record = assertExactKeys(entry, ['kind', 'value']);
    const kind = record.kind;
    const termValue = record.value;
    if (typeof kind !== 'string' || !TERM_KINDS.has(kind)) {
      throw planReviewInvalid('Proposed term kind is unexpected.');
    }
    if (typeof termValue !== 'string') {
      throw planReviewInvalid('Proposed term value is malformed.');
    }
    let normalized;
    try {
      normalized = normalizeInvestigationTerm({
        kind: kind as InvestigationTermKind,
        value: termValue,
      });
    } catch {
      throw planReviewInvalid('Proposed term value is malformed.');
    }
    return {
      kind: normalized.kind,
      value: normalized.value,
      termId: normalized.termId,
    };
  });
  const unique = new Map<string, PlanReviewProposedTerm & { termId: string }>();
  for (const term of terms) {
    unique.set(term.termId, term);
  }
  return [...unique.values()]
    .sort((left, right) =>
      left.termId < right.termId ? -1 : left.termId > right.termId ? 1 : 0,
    )
    .map(({ kind, value: termValue }) => ({ kind, value: termValue }));
}

function assertEvidenceArray(value: unknown): PlanReviewEvidence[] {
  const array = assertBoundedArray(
    value,
    PLAN_REVIEW_LIMITS.maxEvidencePerEntry,
    'Plan review contains too many evidence citations.',
  );
  if (array.length === 0) {
    throw planReviewInvalid('At least one evidence citation is required.');
  }
  const unique = new Map<string, PlanReviewEvidence>();
  for (const entry of array.map((candidate) => assertEvidence(candidate))) {
    unique.set(canonicalJson(entry), entry);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, evidence]) => evidence);
}

function assertEvidence(value: unknown): PlanReviewEvidence {
  if (!isRecord(value)) {
    throw planReviewInvalid('Plan review evidence is malformed.');
  }
  const kind = value.kind;
  if (kind === 'planning-location' || kind === 'repository-location') {
    assertExactKeys(value, ['kind', 'path', 'line', 'observation']);
    const path = value.path;
    const line = value.line;
    const observation = value.observation;
    if (
      typeof path !== 'string' ||
      Buffer.byteLength(path, 'utf8') >
        PLAN_REVIEW_LIMITS.maxRepositoryPathBytes ||
      !Number.isInteger(line) ||
      (line as number) < 1 ||
      (line as number) > Number.MAX_SAFE_INTEGER ||
      !isBoundedNonBlankText(
        observation,
        PLAN_REVIEW_LIMITS.maxObservationBytes,
      )
    ) {
      throw planReviewInvalid('Repository-location evidence is malformed.');
    }
    let normalizedPath: string;
    try {
      normalizedPath = normalizeExactRepositoryPath(path);
    } catch {
      throw planReviewInvalid('Repository-location evidence is malformed.');
    }
    return {
      kind,
      path: normalizedPath,
      line: line as number,
      observation: observation as string,
    };
  }
  if (kind === 'investigation-node' || kind === 'survey-record') {
    assertExactKeys(value, ['kind', 'nodeId', 'resultDigest']);
    const nodeId = value.nodeId;
    const resultDigest = value.resultDigest;
    if (!isDigest(nodeId) || !isDigest(resultDigest)) {
      throw planReviewInvalid('Graph evidence digests are malformed.');
    }
    return kind === 'investigation-node'
      ? { kind: 'investigation-node', nodeId, resultDigest }
      : { kind: 'survey-record', nodeId, resultDigest };
  }
  throw planReviewInvalid('Plan review evidence kind is unexpected.');
}

function assertDisposition(value: unknown): PlanReviewDispositionEntry {
  const record = assertExactKeys(value, [
    'challengeId',
    'decision',
    'rationale',
    'author',
  ]);
  const challengeId = record.challengeId;
  const decision = record.decision;
  const rationale = record.rationale;
  const author = record.author;
  if (!isDigest(challengeId)) {
    throw planReviewInvalid('Disposition challenge identity is malformed.');
  }
  if (typeof decision !== 'string' || !DISPOSITION_DECISIONS.has(decision)) {
    throw planReviewInvalid('Disposition decision is unexpected.');
  }
  if (
    !isBoundedNonBlankText(
      rationale,
      PLAN_REVIEW_LIMITS.maxDispositionRationaleBytes,
    )
  ) {
    throw planReviewInvalid('Disposition rationale is required.');
  }
  if (!isBoundedNonBlankText(author, PLAN_REVIEW_LIMITS.maxAuthorBytes)) {
    throw planReviewInvalid('Disposition author is required.');
  }
  return {
    challengeId,
    decision: decision as PlanReviewDispositionDecision,
    rationale: rationale as string,
    author: author as string,
  };
}

function assertBaseline(value: unknown): { head: string; tree: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['head', 'tree'])) {
    throw planReviewInvalid('Investigation baseline is malformed.');
  }
  const head = value.head;
  const tree = value.tree;
  if (
    typeof head !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(head) ||
    typeof tree !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(tree) ||
    head.length !== tree.length
  ) {
    throw planReviewInvalid('Investigation baseline is malformed.');
  }
  return { head, tree };
}

function assertDependencies(value: unknown): Array<{
  role: string;
  nodeId: string;
  resultDigest: string;
}> {
  const dependencies = assertBoundedArray(
    value,
    PLAN_REVIEW_LIMITS.maxInvestigationDependencies,
    'Plan review subject has too many investigation dependencies.',
  ).map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['role', 'nodeId', 'resultDigest'])
    ) {
      throw planReviewInvalid('Investigation dependency is malformed.');
    }
    const role = entry.role;
    const nodeId = entry.nodeId;
    const resultDigest = entry.resultDigest;
    if (
      !isBoundedNonBlankText(role, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
      !isDigest(nodeId) ||
      !isDigest(resultDigest)
    ) {
      throw planReviewInvalid('Investigation dependency is malformed.');
    }
    return { role: role as string, nodeId, resultDigest };
  });
  const sorted = [...dependencies].sort((left, right) => {
    const leftKey = `${left.role}\u0000${left.nodeId}\u0000${left.resultDigest}`;
    const rightKey = `${right.role}\u0000${right.nodeId}\u0000${right.resultDigest}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const identities = new Set<string>();
  for (const dependency of sorted) {
    const identity = `${dependency.role}\u0000${dependency.nodeId}`;
    if (identities.has(identity)) {
      throw planReviewInvalid('Investigation dependency is duplicated.');
    }
    identities.add(identity);
  }
  if (canonicalJson(dependencies) !== canonicalJson(sorted)) {
    throw planReviewInvalid(
      'Investigation dependencies are not canonically sorted.',
    );
  }
  return sorted;
}

function assertSummary(value: unknown): string {
  return assertBoundedRequiredText(
    value,
    PLAN_REVIEW_LIMITS.maxSummaryBytes,
    'Plan review summary is required.',
  );
}

function assertSeverity(value: unknown): PlanReviewSeverity {
  if (typeof value !== 'string' || !SEVERITIES.has(value)) {
    throw planReviewInvalid('Plan review finding severity is unexpected.');
  }
  return value as PlanReviewSeverity;
}

function assertBoundedRequiredText(
  value: unknown,
  maximumBytes: number,
  message: string,
): string {
  if (!isBoundedNonBlankText(value, maximumBytes)) {
    throw planReviewInvalid(message);
  }
  return value as string;
}

function assertUniqueChallengeIds(ids: string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw planReviewInvalid('Plan review contains duplicate challenges.');
  }
}

function findingDigest(
  kind: 'challenge' | 'suggestion',
  severity: PlanReviewSeverity,
  category: string,
  currentChangeImpact: string,
  summary: string,
  evidence: PlanReviewEvidence[],
): string {
  return sha256(
    canonicalJson({
      schema: 'plan-review-finding.v2',
      kind,
      severity,
      category,
      currentChangeImpact,
      summary,
      evidence,
    }),
  );
}

function assertBoundedArray(
  value: unknown,
  maximum: number,
  message: string,
): unknown[] {
  const array = assertArray(value);
  if (array.length > maximum) {
    throw planReviewInvalid(message);
  }
  return array;
}

function assertArray(value: unknown): unknown[] {
  if (!isDenseArray(value)) {
    throw planReviewInvalid('Expected a plan review array value.');
  }
  return value;
}

function assertExactDigestRoles(
  value: Record<string, string>,
  roles: readonly string[],
  message: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...roles].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw planReviewInvalid(message);
  }
}

function assertCanonicalIdentityOrder(
  ids: string[],
  message: string,
  allowEqual = false,
): void {
  for (let index = 1; index < ids.length; index += 1) {
    if (
      ids[index - 1]! > ids[index]! ||
      (!allowEqual && ids[index - 1] === ids[index])
    ) {
      throw planReviewInvalid(message);
    }
  }
}

function isBoundedNonBlankText(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw planReviewInvalid('Plan review value has unexpected keys.');
  }
  return value;
}

export function createPlanReviewTargetSnapshotNode(
  input: CreatePlanReviewTargetSnapshotInput,
): EvidenceNode {
  const subject = assertPlanReviewSubject(input.subject);
  const materializationNode = assertStoredEvidenceNode(
    input.materializationNode,
    targetSnapshotInvalid,
  );
  if (
    materializationNode.type !== 'propose-planning-materialization' &&
    materializationNode.type !== 'propose-exemption-planning-materialization'
  ) {
    throw targetSnapshotInvalid();
  }
  const relativePaths = [...input.artifacts.keys()].sort(compareUtf8);
  if (
    relativePaths.length === 0 ||
    relativePaths.length > MAX_TARGET_SNAPSHOT_ARTIFACTS ||
    new Set(relativePaths).size !== relativePaths.length
  ) {
    throw targetSnapshotInvalid();
  }
  const artifacts = relativePaths.map((relativePath, index) => {
    const content = input.artifacts.get(relativePath);
    if (!content) throw targetSnapshotInvalid();
    const path = normalizeExactRepositoryPath(
      `${input.changePrefix}/${relativePath}`,
    );
    return {
      path,
      sha256: sha256(content),
      byteLength: content.byteLength,
      lineCount: targetSnapshotLineCount(content),
      mode: '100644' as const,
      snapshotFile: `${String(index).padStart(4, '0')}.artifact`,
      mutability: targetSnapshotMutabilityFor(
        relativePath,
        input.legacyMigration,
      ),
    };
  });
  const migration = createTargetSnapshotMigrationContract(
    artifacts,
    input.legacyMigration,
  );
  const fields = {
    changeId: input.changeId,
    subjectDigest: subject.subjectDigest,
    planningGenerationId: subject.planningGenerationId,
    planTargetDigest: subject.planTargetDigest,
    materializationNodeId: materializationNode.nodeId,
    materializationResultDigest: materializationNode.resultDigest,
    artifacts,
    migration,
  };
  const snapshot: PlanReviewTargetSnapshot = {
    schemaVersion: 1,
    snapshotDigest: createTargetSnapshotDigest(fields),
    ...fields,
  };
  return createEvidenceNode({
    type: TARGET_SNAPSHOT_TYPE,
    nodeSchema: TARGET_SNAPSHOT_SCHEMA,
    evaluator: TARGET_SNAPSHOT_SCHEMA,
    policyDigest: subject.reviewPolicyDigest,
    exactInputDigests: {
      subject: subject.subjectDigest,
      artifacts: sha256(canonicalJson(artifacts)),
      migration: sha256(canonicalJson(migration)),
      materialization: materializationNode.nodeId,
      materializationResult: materializationNode.resultDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: TARGET_SNAPSHOT_OUTPUT_SCHEMA,
    output: snapshot,
    runtimeMetadata: {},
  });
}

export function readPlanReviewTargetSnapshotNode(
  node: EvidenceNode,
): PlanReviewTargetSnapshot {
  const stored = assertStoredEvidenceNode(node, targetSnapshotInvalid);
  if (
    stored.type !== TARGET_SNAPSHOT_TYPE ||
    stored.nodeSchema !== TARGET_SNAPSHOT_SCHEMA ||
    stored.evaluator !== TARGET_SNAPSHOT_SCHEMA ||
    stored.outputSchema !== TARGET_SNAPSHOT_OUTPUT_SCHEMA ||
    Object.keys(stored.runtimeMetadata).length !== 0
  ) {
    throw targetSnapshotInvalid();
  }
  const snapshot = assertPlanReviewTargetSnapshot(stored.output);
  if (
    stored.exactInputDigests.subject !== snapshot.subjectDigest ||
    stored.exactInputDigests.artifacts !==
      sha256(canonicalJson(snapshot.artifacts)) ||
    stored.exactInputDigests.migration !==
      sha256(canonicalJson(snapshot.migration)) ||
    stored.exactInputDigests.materialization !==
      snapshot.materializationNodeId ||
    stored.exactInputDigests.materializationResult !==
      snapshot.materializationResultDigest ||
    Object.keys(stored.semanticParentResultDigests).length !== 0 ||
    Object.keys(stored.provenanceParentNodeIds).length !== 0
  ) {
    throw targetSnapshotInvalid();
  }
  return snapshot;
}

export function assertPlanReviewTargetSnapshot(
  value: unknown,
): PlanReviewTargetSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'snapshotDigest',
      'changeId',
      'subjectDigest',
      'planningGenerationId',
      'planTargetDigest',
      'materializationNodeId',
      'materializationResultDigest',
      'artifacts',
      'migration',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.changeId !== 'string' ||
    !isDigest(value.snapshotDigest) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.planningGenerationId) ||
    !isDigest(value.planTargetDigest) ||
    !isDigest(value.materializationNodeId) ||
    !isDigest(value.materializationResultDigest) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length > MAX_TARGET_SNAPSHOT_ARTIFACTS
  ) {
    throw targetSnapshotInvalid();
  }
  const artifacts = value.artifacts.map(assertTargetSnapshotArtifact);
  for (let index = 0; index < artifacts.length; index += 1) {
    if (
      artifacts[index]!.snapshotFile !==
        `${String(index).padStart(4, '0')}.artifact` ||
      (index > 0 &&
        compareUtf8(artifacts[index - 1]!.path, artifacts[index]!.path) >= 0)
    ) {
      throw targetSnapshotInvalid();
    }
  }
  const migration = assertTargetSnapshotMigrationContract(
    value.migration,
    artifacts,
  );
  const fields = {
    changeId: value.changeId,
    subjectDigest: value.subjectDigest,
    planningGenerationId: value.planningGenerationId,
    planTargetDigest: value.planTargetDigest,
    materializationNodeId: value.materializationNodeId,
    materializationResultDigest: value.materializationResultDigest,
    artifacts,
    migration,
  };
  if (createTargetSnapshotDigest(fields) !== value.snapshotDigest) {
    throw targetSnapshotInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    snapshotDigest: value.snapshotDigest,
    ...fields,
  }) as PlanReviewTargetSnapshot;
}

function assertTargetSnapshotArtifact(
  value: unknown,
): PlanReviewTargetSnapshotArtifact {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'path',
      'sha256',
      'byteLength',
      'lineCount',
      'mode',
      'snapshotFile',
      'mutability',
    ]) ||
    typeof value.path !== 'string' ||
    normalizeExactRepositoryPath(value.path) !== value.path ||
    !isDigest(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) < 0 ||
    !Number.isSafeInteger(value.lineCount) ||
    Number(value.lineCount) < 0 ||
    value.mode !== '100644' ||
    typeof value.snapshotFile !== 'string' ||
    !TARGET_SNAPSHOT_FILE.test(value.snapshotFile) ||
    ![
      'preserved-byte-identical',
      'replaceable-on-replanning',
      'engine-managed',
    ].includes(String(value.mutability))
  ) {
    throw targetSnapshotInvalid();
  }
  return {
    path: value.path,
    sha256: value.sha256,
    byteLength: value.byteLength as number,
    lineCount: value.lineCount as number,
    mode: '100644',
    snapshotFile: value.snapshotFile,
    mutability: value.mutability as PlanningArtifactMutability,
  };
}

function createTargetSnapshotMigrationContract(
  artifacts: PlanReviewTargetSnapshotArtifact[],
  migration: LegacyPlanMigrationSubject | null,
): PlanReviewMigrationContract {
  const byMutability = (kind: PlanningArtifactMutability) =>
    artifacts
      .filter(({ mutability }) => mutability === kind)
      .map(({ path }) => path);
  return {
    legacyMigration: migration !== null,
    preservedPaths: byMutability('preserved-byte-identical'),
    replaceablePaths: byMutability('replaceable-on-replanning'),
    engineManagedPaths: byMutability('engine-managed'),
    guardSemanticDigest: migration?.guardDigest ?? null,
  };
}

function assertTargetSnapshotMigrationContract(
  value: unknown,
  artifacts: PlanReviewTargetSnapshotArtifact[],
): PlanReviewMigrationContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'legacyMigration',
      'preservedPaths',
      'replaceablePaths',
      'engineManagedPaths',
      'guardSemanticDigest',
    ]) ||
    typeof value.legacyMigration !== 'boolean' ||
    (value.guardSemanticDigest !== null && !isDigest(value.guardSemanticDigest))
  ) {
    throw targetSnapshotInvalid();
  }
  const expected = {
    legacyMigration: value.legacyMigration,
    preservedPaths: artifacts
      .filter(({ mutability }) => mutability === 'preserved-byte-identical')
      .map(({ path }) => path),
    replaceablePaths: artifacts
      .filter(({ mutability }) => mutability === 'replaceable-on-replanning')
      .map(({ path }) => path),
    engineManagedPaths: artifacts
      .filter(({ mutability }) => mutability === 'engine-managed')
      .map(({ path }) => path),
    guardSemanticDigest: value.guardSemanticDigest as string | null,
  };
  if (
    canonicalJson(value.preservedPaths) !==
      canonicalJson(expected.preservedPaths) ||
    canonicalJson(value.replaceablePaths) !==
      canonicalJson(expected.replaceablePaths) ||
    canonicalJson(value.engineManagedPaths) !==
      canonicalJson(expected.engineManagedPaths) ||
    (!value.legacyMigration &&
      (expected.preservedPaths.length > 0 ||
        expected.guardSemanticDigest !== null))
  ) {
    throw targetSnapshotInvalid();
  }
  return expected;
}

function targetSnapshotMutabilityFor(
  relativePath: string,
  migration: LegacyPlanMigrationSubject | null,
): PlanningArtifactMutability {
  if (
    relativePath === '.openspec.yaml' ||
    relativePath === 'investigation.json'
  ) {
    return 'engine-managed';
  }
  if (migration === null) {
    return 'replaceable-on-replanning';
  }
  if (relativePath === 'execution.json') {
    return 'engine-managed';
  }
  if (Object.hasOwn(migration.preservedArtifactDigests, relativePath)) {
    return 'preserved-byte-identical';
  }
  if (
    Object.hasOwn(migration.replacedArtifactDigests, relativePath) ||
    ['design.md', 'guard.json'].includes(relativePath)
  ) {
    return 'replaceable-on-replanning';
  }
  throw targetSnapshotInvalid();
}

function createTargetSnapshotDigest(
  fields: Omit<PlanReviewTargetSnapshot, 'schemaVersion' | 'snapshotDigest'>,
): string {
  return sha256(
    canonicalJson({
      schema: TARGET_SNAPSHOT_SCHEMA,
      ...fields,
    }),
  );
}

export function planReviewSnapshotLineCount(content: Buffer): number {
  return targetSnapshotLineCount(content);
}

function targetSnapshotLineCount(content: Buffer): number {
  if (content.byteLength === 0) return 0;
  let count = 1;
  for (const byte of content) {
    if (byte === 0x0a) count += 1;
  }
  return content.at(-1) === 0x0a ? count - 1 : count;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function targetSnapshotInvalid(): WorkflowError {
  return workflowError(
    'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
    'PlanReview target snapshot is malformed or no longer bound.',
    ExitCode.verification,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string') &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor && descriptor.enumerable && 'value' in descriptor,
      );
    })
  );
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return false;
    }
  }
  return true;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function planReviewInvalid(message: string): WorkflowError {
  return workflowError('PLAN_REVIEW_INVALID', message, ExitCode.usage);
}
