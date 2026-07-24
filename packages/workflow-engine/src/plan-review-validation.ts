import { ExitCode, workflowError } from './errors.ts';
import type { EvidenceNode } from './evidence-node.ts';
import { assertPlanTarget, type PlanTarget } from './plan-target.ts';
import {
  assertPlanningGeneration,
  type PlanningGeneration,
} from './planning-generation.ts';
import {
  assertPlanReviewSubject,
  readPlanReviewDispositionNode,
  readPlanReviewNode,
  type PlanReviewEvidence,
  type PlanReviewSubject,
  type PlanReviewSuggestion,
  type PlanReviewVerdict,
} from './plan-review.ts';
import { normalizeExactRepositoryPath } from './paths.ts';
import { isProviderId, type ProviderId } from './provider-registry.ts';
import type {
  AdmittedRoleResult,
  IndependenceDimension,
} from './role-scheduler.ts';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RESOLVED_REPOSITORY_LOCATIONS = 16_384;

export type PlanReviewOrdinaryIndependenceAuthorization = {
  kind: 'ordinary-provider-independent';
  planAuthorProviderId: ProviderId;
};

export type PlanReviewAdmittedRoleAuthorization = {
  kind: 'admitted-role-result';
  roleResult: AdmittedRoleResult;
};

export type PlanReviewResolvedRepositoryLocation = {
  path: string;
  blobOid: string;
  lineCount: number;
};

/**
 * Content-pure validation consumes this canonical projection rather than
 * trusting a `file:line` string. Live and CI callers must derive it
 * independently from the exact pinned Git tree named here.
 */
export type PlanReviewRepositoryEvidence = {
  tree: string;
  locations: PlanReviewResolvedRepositoryLocation[];
};

/**
 * Inputs to the content-pure PlanReview validator. The authorization and
 * repository-evidence projections are facts, not authorities: live and CI
 * callers must independently derive them from the governing actor/evidence DAG
 * and `readPinnedTrackedTree` respectively. Accepting caller-authored values
 * here and treating `eligible` as transition authority would be self-attestation.
 */
export type ValidatePlanReviewInput = {
  reviewNode: EvidenceNode;
  dispositionNode: EvidenceNode | null;
  subject: PlanReviewSubject;
  generation: PlanningGeneration;
  target: PlanTarget;
  expectedReviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
  independenceAuthorization:
    | PlanReviewOrdinaryIndependenceAuthorization
    | PlanReviewAdmittedRoleAuthorization;
  repositoryEvidence: PlanReviewRepositoryEvidence;
};

/**
 * A replayable, content-pure verdict on one exact PlanReview. `current` and
 * `eligible` are conditional on independently derived validation inputs;
 * neither field by itself authorizes a lifecycle transition. Given those facts,
 * `eligible` additionally requires every challenge dispositioned and
 * provider independence recomputed. The advisory verdict is reported but never
 * gates eligibility, and independent follow-ups surface as deduplicated
 * non-blocking intake candidates that never carry a repository issue identity.
 */
export type PlanReviewValidation = {
  current: boolean;
  eligible: boolean;
  advisoryVerdict: PlanReviewVerdict;
  staleReasons: string[];
  undispositionedChallengeIds: string[];
  intakeCandidates: PlanReviewSuggestion[];
  planningGenerationId: string;
  planTargetDigest: string;
  subjectDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  reviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
  achievedIndependence: IndependenceDimension;
  roleResultForm: AdmittedRoleResult['form'] | 'ordinary-provider-legacy';
  orchestration:
    AdmittedRoleResult['orchestration'] | 'legacy-caller-authorization';
  degradationAuthorized: boolean;
};

/**
 * Validate a stored PlanReview against its governing plan target, planning
 * generation, subject, review policy, and required independence. Ordinary
 * authorized implementation descendants never appear here, so they cannot stale
 * the review; a changed plan target, superseding generation, investigation
 * dependency, review policy, or independence requirement does. The advisory
 * verdict is surfaced but does not replace the currentness or disposition gates.
 */
export function validatePlanReview(
  input: ValidatePlanReviewInput,
): PlanReviewValidation {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'reviewNode',
      'dispositionNode',
      'subject',
      'generation',
      'target',
      'expectedReviewPolicyDigest',
      'requiredIndependence',
      'independenceAuthorization',
      'repositoryEvidence',
    ]) ||
    !DIGEST_PATTERN.test(input.expectedReviewPolicyDigest)
  ) {
    throw planReviewInvalid('Plan review validation input is malformed.');
  }

  const review = readPlanReviewNode(input.reviewNode);
  const subject = assertPlanReviewSubject(input.subject);
  const generation = assertPlanningGeneration(input.generation);
  const target = assertPlanTarget(input.target);
  const independenceAuthorization = assertIndependenceAuthorization(
    input.independenceAuthorization,
  );
  const repositoryEvidence = assertRepositoryEvidence(input.repositoryEvidence);

  const staleReasons = new Set<string>();
  if (review.subjectDigest !== subject.subjectDigest) {
    staleReasons.add('SUBJECT_BINDING_MISMATCH');
  }
  if (
    subject.planTargetDigest !== target.targetDigest ||
    generation.targetDigest !== target.targetDigest ||
    review.planTargetDigest !== target.targetDigest
  ) {
    staleReasons.add('PLAN_TARGET_MISMATCH');
  }
  if (
    subject.planningGenerationId !== generation.planningGenerationId ||
    review.planningGenerationId !== generation.planningGenerationId
  ) {
    staleReasons.add('PLANNING_GENERATION_MISMATCH');
  }
  if (
    review.policyDigest !== input.expectedReviewPolicyDigest ||
    review.policyDigest !== input.reviewNode.policyDigest
  ) {
    staleReasons.add('REVIEW_NODE_POLICY_MISMATCH');
  }
  if (
    subject.reviewPolicyDigest !== input.expectedReviewPolicyDigest ||
    generation.policies.reviewPolicyDigest !== input.expectedReviewPolicyDigest
  ) {
    staleReasons.add('REVIEW_POLICY_MISMATCH');
  }
  if (subject.requiredIndependence !== input.requiredIndependence) {
    staleReasons.add('INDEPENDENCE_MISMATCH');
  }
  if (
    review.assignment.targetDigest !== subject.subjectDigest ||
    review.assignment.requiredIndependence !== input.requiredIndependence ||
    review.requiredIndependence !== input.requiredIndependence
  ) {
    staleReasons.add('REVIEW_BINDING_MISMATCH');
  }
  if (
    subject.investigationBaseline.head !==
      generation.investigationBaseline.head ||
    subject.investigationBaseline.tree !==
      generation.investigationBaseline.tree ||
    !sameInvestigationDependencies(
      subject.investigationDependencies,
      generation.investigationDependencies,
    )
  ) {
    staleReasons.add('INVESTIGATION_DEPENDENCY_MISMATCH');
  }
  if (!reviewEvidenceIsBound(review, generation, repositoryEvidence)) {
    staleReasons.add('REPOSITORY_EVIDENCE_MISMATCH');
  }

  const admittedRoleResult =
    independenceAuthorization.kind === 'admitted-role-result'
      ? independenceAuthorization.roleResult
      : null;
  const legacyPlanAuthorProviderId =
    independenceAuthorization.kind === 'ordinary-provider-independent'
      ? independenceAuthorization.planAuthorProviderId
      : null;
  const achievedIndependence: IndependenceDimension = admittedRoleResult
    ? admittedRoleResult.achievedIndependence
    : review.assignment.providerId !== legacyPlanAuthorProviderId
      ? 'provider-independent'
      : 'none';
  const roleResultForm = admittedRoleResult
    ? admittedRoleResult.form
    : ('ordinary-provider-legacy' as const);
  const orchestration = admittedRoleResult
    ? admittedRoleResult.orchestration
    : ('legacy-caller-authorization' as const);
  const degradationAuthorized =
    admittedRoleResult !== null &&
    admittedRoleResult.form !== 'ordinary-provider';
  if (
    admittedRoleResult &&
    (admittedRoleResult.role !== 'plan-reviewer' ||
      admittedRoleResult.targetDigest !== subject.subjectDigest ||
      admittedRoleResult.content.nodeId !== review.nodeId ||
      admittedRoleResult.content.resultDigest !== review.resultDigest ||
      admittedRoleResult.content.policyDigest !== review.policyDigest ||
      admittedRoleResult.assignment.providerId !==
        review.assignment.providerId ||
      admittedRoleResult.assignment.sessionId !== review.assignment.sessionId ||
      admittedRoleResult.assignment.targetDigest !==
        review.assignment.targetDigest)
  ) {
    staleReasons.add('REVIEW_ROLE_RESULT_MISMATCH');
  }
  if (
    review.achievedIndependence !== achievedIndependence ||
    review.assignment.achievedIndependence !== achievedIndependence
  ) {
    staleReasons.add('REVIEWER_PROVIDER_INDEPENDENCE_MISMATCH');
  }

  const dispositioned = readDispositions(
    input.dispositionNode,
    input.reviewNode,
    input.expectedReviewPolicyDigest,
  );
  const challengeIds = new Set(
    review.findings.map((finding) => finding.findingId),
  );
  for (const challengeId of dispositioned) {
    if (!challengeIds.has(challengeId)) {
      throw planReviewInvalid(
        'Plan review disposition names an unknown challenge.',
      );
    }
  }
  const undispositionedChallengeIds = review.findings
    .map((finding) => finding.findingId)
    .filter((findingId) => !dispositioned.has(findingId))
    .sort((left, right) => (left < right ? -1 : 1));

  const current = staleReasons.size === 0;
  const independenceSatisfied =
    review.requiredIndependence === input.requiredIndependence &&
    (achievedIndependence === review.requiredIndependence ||
      degradationAuthorized);

  const eligible =
    current &&
    undispositionedChallengeIds.length === 0 &&
    independenceSatisfied;

  const validation: PlanReviewValidation = {
    current,
    eligible,
    advisoryVerdict: review.verdict,
    staleReasons: [...staleReasons].sort((left, right) =>
      left < right ? -1 : 1,
    ),
    undispositionedChallengeIds,
    intakeCandidates: current ? dedupeIntakeCandidates(review.suggestions) : [],
    planningGenerationId: generation.planningGenerationId,
    planTargetDigest: target.targetDigest,
    subjectDigest: subject.subjectDigest,
    reviewNodeId: review.nodeId,
    reviewResultDigest: review.resultDigest,
    reviewPolicyDigest: review.policyDigest,
    requiredIndependence: input.requiredIndependence,
    achievedIndependence,
    roleResultForm,
    orchestration,
    degradationAuthorized,
  };
  return deepFreeze(validation);
}

function readDispositions(
  dispositionNode: EvidenceNode | null,
  reviewNode: EvidenceNode,
  expectedReviewPolicyDigest: string,
): Set<string> {
  if (dispositionNode === null) {
    return new Set();
  }
  const record = readPlanReviewDispositionNode(dispositionNode);
  if (
    record.reviewNodeId !== reviewNode.nodeId ||
    record.reviewResultDigest !== reviewNode.resultDigest ||
    record.policyDigest !== expectedReviewPolicyDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_INVALID',
      'Plan review disposition is not bound to the reviewed node and policy.',
      ExitCode.usage,
    );
  }
  return new Set(record.dispositions.map((entry) => entry.challengeId));
}

function reviewEvidenceIsBound(
  review: ReturnType<typeof readPlanReviewNode>,
  generation: PlanningGeneration,
  repositoryEvidence: PlanReviewRepositoryEvidence,
): boolean {
  const dependencies = new Set(
    generation.investigationDependencies.map(
      ({ nodeId, resultDigest }) => `${nodeId}\0${resultDigest}`,
    ),
  );
  const citations = [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  if (
    repositoryEvidence.tree !== generation.investigationBaseline.tree ||
    !repositoryLocationsExactlyCoverCitations(repositoryEvidence, citations)
  ) {
    return false;
  }
  const locations = new Map(
    repositoryEvidence.locations.map((location) => [location.path, location]),
  );
  return citations.every((citation) => {
    if (citation.kind === 'repository-location') {
      const location = locations.get(citation.path);
      return location !== undefined && citation.line <= location.lineCount;
    }
    return dependencies.has(`${citation.nodeId}\0${citation.resultDigest}`);
  });
}

function repositoryLocationsExactlyCoverCitations(
  repositoryEvidence: PlanReviewRepositoryEvidence,
  citations: PlanReviewEvidence[],
): boolean {
  const citedPaths = new Set(
    citations
      .filter(
        (
          citation,
        ): citation is Extract<
          PlanReviewEvidence,
          { kind: 'repository-location' }
        > => citation.kind === 'repository-location',
      )
      .map(({ path }) => path),
  );
  return (
    citedPaths.size === repositoryEvidence.locations.length &&
    repositoryEvidence.locations.every(({ path }) => citedPaths.has(path))
  );
}

function assertIndependenceAuthorization(
  value: unknown,
):
  | PlanReviewOrdinaryIndependenceAuthorization
  | PlanReviewAdmittedRoleAuthorization {
  if (
    isPlainRecord(value) &&
    hasExactKeys(value, ['kind', 'roleResult']) &&
    value.kind === 'admitted-role-result' &&
    isAdmittedRoleResultShape(value.roleResult)
  ) {
    return {
      kind: 'admitted-role-result',
      roleResult: structuredClone(value.roleResult),
    };
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['kind', 'planAuthorProviderId']) ||
    value.kind !== 'ordinary-provider-independent' ||
    !isProviderId(value.planAuthorProviderId)
  ) {
    throw planReviewInvalid(
      'Plan review independence authorization is malformed.',
    );
  }
  return {
    kind: 'ordinary-provider-independent',
    planAuthorProviderId: value.planAuthorProviderId,
  };
}

function isAdmittedRoleResultShape(
  value: unknown,
): value is AdmittedRoleResult {
  return (
    isPlainRecord(value) &&
    value.schemaVersion === 1 &&
    value.role === 'plan-reviewer' &&
    typeof value.targetDigest === 'string' &&
    DIGEST_PATTERN.test(value.targetDigest) &&
    typeof value.resultDigest === 'string' &&
    DIGEST_PATTERN.test(value.resultDigest) &&
    typeof value.form === 'string' &&
    [
      'ordinary-provider',
      'granted-same-provider',
      'granted-caller-supplied',
      'direct-human-attestation',
    ].includes(value.form) &&
    typeof value.orchestration === 'string' &&
    isPlainRecord(value.assignment) &&
    isPlainRecord(value.content) &&
    typeof value.content.nodeId === 'string' &&
    DIGEST_PATTERN.test(value.content.nodeId) &&
    typeof value.content.resultDigest === 'string' &&
    DIGEST_PATTERN.test(value.content.resultDigest) &&
    typeof value.content.policyDigest === 'string' &&
    DIGEST_PATTERN.test(value.content.policyDigest)
  );
}

function assertRepositoryEvidence(
  value: unknown,
): PlanReviewRepositoryEvidence {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['tree', 'locations']) ||
    typeof value.tree !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(value.tree) ||
    !isDenseArray(value.locations) ||
    value.locations.length > MAX_RESOLVED_REPOSITORY_LOCATIONS
  ) {
    throw planReviewInvalid('Resolved repository evidence is malformed.');
  }

  const locations = value.locations.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ['path', 'blobOid', 'lineCount']) ||
      typeof entry.path !== 'string' ||
      typeof entry.blobOid !== 'string' ||
      !GIT_OBJECT_ID_PATTERN.test(entry.blobOid) ||
      entry.blobOid.length !== (value.tree as string).length ||
      typeof entry.lineCount !== 'number' ||
      !Number.isSafeInteger(entry.lineCount) ||
      entry.lineCount < 0
    ) {
      throw planReviewInvalid('Resolved repository location is malformed.');
    }
    let path: string;
    try {
      path = normalizeExactRepositoryPath(entry.path);
    } catch {
      throw planReviewInvalid('Resolved repository path is malformed.');
    }
    if (path !== entry.path) {
      throw planReviewInvalid('Resolved repository path is not canonical.');
    }
    return {
      path,
      blobOid: entry.blobOid,
      lineCount: entry.lineCount,
    };
  });
  for (let index = 1; index < locations.length; index += 1) {
    if (compareUtf8(locations[index - 1]!.path, locations[index]!.path) >= 0) {
      throw planReviewInvalid(
        'Resolved repository locations are not canonical.',
      );
    }
  }
  return { tree: value.tree, locations };
}

function sameInvestigationDependencies(
  left: PlanningGeneration['investigationDependencies'],
  right: PlanningGeneration['investigationDependencies'],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (dependency, index) =>
      dependency.role === right[index]?.role &&
      dependency.nodeId === right[index]?.nodeId &&
      dependency.resultDigest === right[index]?.resultDigest,
  );
}

function dedupeIntakeCandidates(
  suggestions: PlanReviewSuggestion[],
): PlanReviewSuggestion[] {
  const unique = new Map<string, PlanReviewSuggestion>();
  for (const suggestion of suggestions) {
    if (!unique.has(suggestion.suggestionId)) {
      unique.set(suggestion.suggestionId, suggestion);
    }
  }
  return [...unique.values()].sort((left, right) => {
    if (left.summary !== right.summary) {
      return left.summary < right.summary ? -1 : 1;
    }
    return left.suggestionId < right.suggestionId ? -1 : 1;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
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

function planReviewInvalid(message: string) {
  return workflowError('PLAN_REVIEW_INVALID', message, ExitCode.usage);
}
