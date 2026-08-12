import { ExitCode, workflowError } from './errors.ts';
import {
  TASK_DIFF_REVIEW_LIMITS,
  type TaskDiffReviewEvidence,
} from './task-diff-review-artifact.ts';

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Caller-authored response evidence for the current challenge set. This input
 * deliberately has no response digest, reviewer authority, disposition, or
 * closure field: the engine derives the response record and the existing
 * authenticated continuation path remains the only closure authority.
 */
export type TaskDiffReviewChallengeResponseInput = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-challenge-response-input.v1';
  reviewRecordDigest: string;
  responses: readonly Readonly<{
    challengeId: string;
    rationale: string;
    evidence: readonly TaskDiffReviewEvidence[];
  }>[];
}>;

export function parseTaskDiffReviewChallengeResponseInput(
  value: unknown,
): TaskDiffReviewChallengeResponseInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reviewRecordDigest',
      'responses',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-challenge-response-input.v1' ||
    typeof value.reviewRecordDigest !== 'string' ||
    !DIGEST.test(value.reviewRecordDigest) ||
    !Array.isArray(value.responses) ||
    value.responses.length === 0 ||
    value.responses.length > TASK_DIFF_REVIEW_LIMITS.maxFindings
  ) {
    throw responseInputInvalid();
  }
  const responses = value.responses.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['challengeId', 'rationale', 'evidence']) ||
      typeof candidate.challengeId !== 'string' ||
      !DIGEST.test(candidate.challengeId) ||
      typeof candidate.rationale !== 'string' ||
      !Array.isArray(candidate.evidence)
    ) {
      throw responseInputInvalid();
    }
    return {
      challengeId: candidate.challengeId,
      rationale: candidate.rationale,
      evidence: structuredClone(candidate.evidence) as TaskDiffReviewEvidence[],
    };
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-challenge-response-input.v1',
    reviewRecordDigest: value.reviewRecordDigest,
    responses,
  });
}

function responseInputInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_RESPONSE_INPUT_INVALID',
    'TaskDiffReview challenge response input must be an exact typed envelope without closure authority fields.',
    ExitCode.usage,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
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
