import { ExitCode, workflowError, type WorkflowError } from './errors.ts';
import {
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
  type InvestigationMainTermInput,
  type InvestigationTermInput,
  type InvestigationTermKind,
  type InvestigationTermSource,
  type InvestigationTermUnionPreview,
} from './investigation-terms.ts';
import {
  PLAN_REVIEW_MAX_PROPOSED_TERMS,
  readPlanReviewNode,
} from './plan-review.ts';
import {
  validatePlanReview,
  type ValidatePlanReviewInput,
} from './plan-review-validation.ts';

/**
 * The caller-supplied contribution channels the reviewer projector may union
 * with. The `reviewer` source is exclusively engine-injected from the immutable
 * review report, so a caller cannot pre-seed it.
 */
const ALLOWED_EXISTING_SOURCES: ReadonlySet<string> = new Set([
  'engine',
  'main',
  'survey',
]);

/**
 * Semantic limits produce `requires-narrowing`, while these larger input limits
 * cap the work required to produce that preview. Without a separate hard
 * processing ceiling an arbitrarily large rejected proposal could still exhaust
 * memory before the semantic violation was reported.
 */
const MAX_EXISTING_CONTRIBUTIONS = INVESTIGATION_LIMITS.maxEffectiveTerms;
const MAX_EXISTING_RAW_TERMS =
  INVESTIGATION_LIMITS.maxEffectiveTerms +
  INVESTIGATION_LIMITS.maxMainTerms +
  INVESTIGATION_LIMITS.maxSurveyTerms;
const MAX_PREVIEW_RAW_TERMS =
  MAX_EXISTING_RAW_TERMS + PLAN_REVIEW_MAX_PROPOSED_TERMS;
const MAX_REVIEWER_INPUT_TERMS = PLAN_REVIEW_MAX_PROPOSED_TERMS;
const MAX_REFERENCE_BYTES = 512;
const MAX_MAIN_TERM_SEMANTIC_BYTES = 4096;

export type ProjectPlanReviewTermsInput = {
  validationInput: ValidatePlanReviewInput;
  existingContributions: InvestigationTermContribution[];
};

export type PlanReviewTermProjection = {
  reviewNodeId: string;
  reviewResultDigest: string;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  reviewPolicyDigest: string;
  preview: InvestigationTermUnionPreview;
};

/**
 * Project a current PlanReview's `proposedTerms` — and only those — into the
 * fixed bounded term union. Currentness is recomputed from the complete canonical
 * validation context at the projection boundary; a caller cannot substitute a
 * `current: true` DTO. Reviewer terms are read directly from the immutable report
 * under engine-owned provenance, while every existing contribution is
 * snapshotted and normalized through the same fixed term grammar before union.
 */
export function projectPlanReviewTerms(
  input: ProjectPlanReviewTermsInput,
): PlanReviewTermProjection {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['validationInput', 'existingContributions'])
  ) {
    throw projectionInvalid('Plan review term projection input is malformed.');
  }

  let validation: ReturnType<typeof validatePlanReview>;
  try {
    validation = validatePlanReview(input.validationInput);
  } catch {
    throw projectionInvalid(
      'Plan review validation context is malformed or unbound.',
    );
  }
  if (!validation.current) {
    throw projectionInvalid(
      'Plan review terms project only from a current review.',
    );
  }

  const reviewNode = input.validationInput.reviewNode;
  let review: ReturnType<typeof readPlanReviewNode>;
  try {
    review = readPlanReviewNode(reviewNode);
  } catch {
    throw projectionInvalid('Plan review report is malformed or unbound.');
  }
  const existing = assertExistingContributions(input.existingContributions);
  const reviewerTerms = assertTerms(
    review.proposedTerms,
    MAX_REVIEWER_INPUT_TERMS,
    'Plan review proposed terms exceed the bounded projection input.',
  );
  const existingTermCount = existing.reduce(
    (total, contribution) => total + contribution.terms.length,
    0,
  );
  if (existingTermCount + reviewerTerms.length > MAX_PREVIEW_RAW_TERMS) {
    throw projectionInvalid(
      'Plan review term projection exceeds its bounded raw input.',
    );
  }

  const reviewerContribution: InvestigationTermContribution = {
    source: 'reviewer',
    reference: reviewNode.nodeId,
    terms: reviewerTerms,
  };
  const preview = previewInvestigationTermUnion([
    ...existing,
    reviewerContribution,
  ]);

  return deepFreeze({
    reviewNodeId: validation.reviewNodeId,
    reviewResultDigest: validation.reviewResultDigest,
    subjectDigest: validation.subjectDigest,
    planningGenerationId: validation.planningGenerationId,
    planTargetDigest: validation.planTargetDigest,
    reviewPolicyDigest: validation.reviewPolicyDigest,
    preview,
  });
}

function assertExistingContributions(
  value: unknown,
): InvestigationTermContribution[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_EXISTING_CONTRIBUTIONS ||
    !isDenseArray(value)
  ) {
    throw projectionInvalid(
      'Existing term contributions exceed the bounded input shape.',
    );
  }

  let rawTermCount = 0;
  return value.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ['source', 'reference', 'terms'])
    ) {
      throw projectionInvalid('Existing term contribution shape is malformed.');
    }
    const source = entry.source;
    const reference = entry.reference;
    const terms = entry.terms;
    if (typeof source !== 'string' || !ALLOWED_EXISTING_SOURCES.has(source)) {
      throw projectionInvalid(
        'Reviewer term provenance is engine-owned and cannot be caller-supplied.',
      );
    }
    if (
      typeof reference !== 'string' ||
      reference.length === 0 ||
      Buffer.byteLength(reference, 'utf8') > MAX_REFERENCE_BYTES ||
      !isControlFree(reference)
    ) {
      throw projectionInvalid(
        'Existing term contribution reference is malformed.',
      );
    }
    if (
      !Array.isArray(terms) ||
      terms.length > MAX_EXISTING_RAW_TERMS ||
      !isDenseArray(terms)
    ) {
      throw projectionInvalid(
        'Existing term contribution terms exceed the bounded input shape.',
      );
    }
    rawTermCount += terms.length;
    if (rawTermCount > MAX_EXISTING_RAW_TERMS) {
      throw projectionInvalid(
        'Existing term contributions exceed the bounded raw input.',
      );
    }
    return {
      source: source as InvestigationTermContribution['source'],
      reference,
      terms: assertTerms(
        terms,
        MAX_EXISTING_RAW_TERMS,
        'Existing term contribution exceeds the bounded raw input.',
        source as InvestigationTermSource,
      ),
    } as InvestigationTermContribution;
  });
}

function assertTerms(
  value: unknown,
  maximum: number,
  overLimitMessage: string,
  source: InvestigationTermSource = 'reviewer',
): Array<InvestigationTermInput | InvestigationMainTermInput> {
  if (!Array.isArray(value) || value.length > maximum || !isDenseArray(value)) {
    throw projectionInvalid(overLimitMessage);
  }
  return value.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(
        entry,
        source === 'main'
          ? ['kind', 'value', 'rationale', 'expectedRelationship']
          : ['kind', 'value'],
      ) ||
      typeof entry.kind !== 'string' ||
      typeof entry.value !== 'string'
    ) {
      throw projectionInvalid('Investigation term shape is malformed.');
    }
    try {
      const normalized = normalizeInvestigationTerm({
        kind: entry.kind as InvestigationTermKind,
        value: entry.value,
      });
      if (source !== 'main') {
        return { kind: normalized.kind, value: normalized.value };
      }
      if (
        !isBoundedSemanticText(entry.rationale) ||
        !isBoundedSemanticText(entry.expectedRelationship)
      ) {
        throw projectionInvalid(
          'Main investigation term metadata is malformed.',
        );
      }
      return {
        kind: normalized.kind,
        value: normalized.value,
        rationale: entry.rationale,
        expectedRelationship: entry.expectedRelationship,
      };
    } catch {
      throw projectionInvalid(
        'Investigation term does not satisfy the fixed term grammar.',
      );
    }
  });
}

function isBoundedSemanticText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_MAIN_TERM_SEMANTIC_BYTES &&
    isControlFree(value)
  );
}

function isDenseArray(value: unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }
  }
  return true;
}

function isControlFree(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function projectionInvalid(message: string): WorkflowError {
  return workflowError(
    'PLAN_REVIEW_TERM_PROJECTION_INVALID',
    message,
    ExitCode.usage,
  );
}
