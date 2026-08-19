import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseTaskDiffReviewContinuationSubmission,
  parseTaskDiffReviewSubmission,
  TASK_DIFF_REVIEW_LIMITS,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewEvidence,
  type TaskDiffReviewSubmission,
} from './task-diff-review-artifact.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export type TaskDiffReviewExternalSubmissionInput = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-submission-input.v1';
  subjectDigest: string;
  submission: TaskDiffReviewSubmission;
}>;

export type TaskDiffReviewExternalClosureInput = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-closure-input.v1';
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  proposedDispositions: TaskDiffReviewContinuationSubmission['proposedDispositions'];
}>;

/**
 * Public authority-free closure request. The caller supplies evidence and an
 * advisory disposition proposal, while the engine derives the canonical
 * response digest from the current authenticated review.
 */
export type TaskDiffReviewExternalClosureRequestInput = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-external-closure-request.v1';
  subjectDigest: string;
  reviewRecordDigest: string;
  responses: TaskDiffReviewChallengeResponseInput['responses'];
  proposedDispositions: TaskDiffReviewContinuationSubmission['proposedDispositions'];
}>;

export function parseTaskDiffReviewExternalSubmissionInput(
  value: unknown,
): TaskDiffReviewExternalSubmissionInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'subjectDigest',
      'submission',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-submission-input.v1' ||
    !isDigest(value.subjectDigest)
  ) {
    throw externalInputInvalid();
  }
  let submission: TaskDiffReviewSubmission;
  try {
    submission = parseTaskDiffReviewSubmission(value.submission);
  } catch {
    throw externalInputInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-submission-input.v1',
    subjectDigest: value.subjectDigest,
    submission,
  });
}

export function parseTaskDiffReviewExternalClosureInput(
  value: unknown,
): TaskDiffReviewExternalClosureInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'proposedDispositions',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-closure-input.v1' ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.reviewRecordDigest) ||
    !isDigest(value.responseDigest)
  ) {
    throw externalInputInvalid();
  }
  let submission: TaskDiffReviewContinuationSubmission;
  try {
    submission = parseTaskDiffReviewContinuationSubmission({
      schemaVersion: 1,
      reviewRecordDigest: value.reviewRecordDigest,
      responseDigest: value.responseDigest,
      proposedDispositions: value.proposedDispositions,
    });
  } catch {
    throw externalInputInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-closure-input.v1',
    subjectDigest: value.subjectDigest,
    reviewRecordDigest: submission.reviewRecordDigest,
    responseDigest: submission.responseDigest,
    proposedDispositions: submission.proposedDispositions,
  });
}

export function parseTaskDiffReviewExternalClosureRequestInput(
  value: unknown,
): TaskDiffReviewExternalClosureRequestInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'subjectDigest',
      'reviewRecordDigest',
      'responses',
      'proposedDispositions',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-external-closure-request.v1' ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.reviewRecordDigest)
  ) {
    throw externalInputInvalid();
  }
  try {
    const response = parseTaskDiffReviewChallengeResponseInput({
      schemaVersion: 1,
      kind: 'task-diff-review-challenge-response-input.v1',
      reviewRecordDigest: value.reviewRecordDigest,
      responses: value.responses,
    });
    const continuation = parseTaskDiffReviewContinuationSubmission({
      schemaVersion: 1,
      reviewRecordDigest: value.reviewRecordDigest,
      responseDigest: '0'.repeat(64),
      proposedDispositions: value.proposedDispositions,
    });
    const responseChallengeIds = response.responses
      .map(({ challengeId }) => challengeId)
      .sort();
    const dispositionChallengeIds = continuation.proposedDispositions.map(
      ({ challengeId }) => challengeId,
    );
    if (
      new Set(responseChallengeIds).size !== responseChallengeIds.length ||
      responseChallengeIds.join('\0') !== dispositionChallengeIds.join('\0')
    ) {
      throw externalInputInvalid();
    }
    return deepFreeze({
      schemaVersion: 1,
      kind: 'task-diff-review-external-closure-request.v1',
      subjectDigest: value.subjectDigest,
      reviewRecordDigest: response.reviewRecordDigest,
      responses: response.responses,
      proposedDispositions: continuation.proposedDispositions,
    });
  } catch {
    throw externalInputInvalid();
  }
}

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

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function externalInputInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID',
    'External TaskDiffReview input must be an exact subject-bound advisory envelope without authority or closure fields.',
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
