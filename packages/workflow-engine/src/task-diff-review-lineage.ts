import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  deriveTaskDiffReviewCandidatePlan,
  type TaskDiffReviewCandidatePlan,
  type TaskDiffReviewScope,
  type TaskDiffReviewSubject,
} from './task-diff-review.ts';

export type TaskDiffReviewLineageEntry = Readonly<{
  source: 'provider' | 'external';
  subject: TaskDiffReviewSubject;
  reviewRecordDigest: string;
  reviewScope: TaskDiffReviewScope;
  finalAssuranceCommitmentDigest: string | null;
}>;

export type ResolvedTaskDiffReviewLineage = Readonly<{
  candidatePlan: TaskDiffReviewCandidatePlan;
  predecessor: TaskDiffReviewLineageEntry | null;
}>;

/**
 * Resolve one fully replayed, source-neutral TaskDiffReview history. The
 * immutable successor scope is the semantic edge; store projections are only
 * crash/audit indexes and never override this graph.
 */
export function resolveTaskDiffReviewLineage(input: {
  current: TaskDiffReviewSubject;
  entries: readonly TaskDiffReviewLineageEntry[];
}): ResolvedTaskDiffReviewLineage {
  if (input.entries.length === 0) {
    return Object.freeze({
      candidatePlan: deriveTaskDiffReviewCandidatePlan({
        current: input.current,
      }),
      predecessor: null,
    });
  }

  const byReview = new Map<string, TaskDiffReviewLineageEntry>();
  const bySubject = new Map<string, TaskDiffReviewLineageEntry>();
  for (const entry of input.entries) {
    if (
      entry.subject.subjectDigest !== entry.reviewScope.currentSubjectDigest ||
      byReview.has(entry.reviewRecordDigest) ||
      bySubject.has(entry.subject.subjectDigest)
    ) {
      throw lineageConflict();
    }
    byReview.set(entry.reviewRecordDigest, entry);
    bySubject.set(entry.subject.subjectDigest, entry);
  }

  const childByPredecessor = new Map<string, string>();
  const childDigests = new Set<string>();
  for (const entry of input.entries) {
    const predecessor = entry.reviewScope.predecessor;
    if (predecessor === null) continue;
    const parent = byReview.get(predecessor.reviewRecordDigest);
    if (
      parent === undefined ||
      parent.subject.subjectDigest !== predecessor.subjectDigest ||
      parent.finalAssuranceCommitmentDigest !==
        predecessor.finalAssuranceCommitmentDigest ||
      childByPredecessor.has(predecessor.reviewRecordDigest)
    ) {
      throw lineageConflict();
    }
    childByPredecessor.set(
      predecessor.reviewRecordDigest,
      entry.reviewRecordDigest,
    );
    childDigests.add(entry.reviewRecordDigest);
  }

  const roots = input.entries.filter(
    (entry) => !childDigests.has(entry.reviewRecordDigest),
  );
  const leaves = input.entries.filter(
    (entry) => !childByPredecessor.has(entry.reviewRecordDigest),
  );
  if (roots.length !== 1 || leaves.length !== 1) throw lineageConflict();

  const visited = new Set<string>();
  let cursor: TaskDiffReviewLineageEntry | undefined = roots[0];
  while (cursor !== undefined) {
    if (visited.has(cursor.reviewRecordDigest)) throw lineageConflict();
    visited.add(cursor.reviewRecordDigest);
    const childDigest = childByPredecessor.get(cursor.reviewRecordDigest);
    cursor = childDigest === undefined ? undefined : byReview.get(childDigest);
    if (childDigest !== undefined && cursor === undefined) {
      throw lineageConflict();
    }
  }
  if (visited.size !== input.entries.length) throw lineageConflict();

  const predecessor = leaves[0]!;
  const candidatePlan = deriveTaskDiffReviewCandidatePlan({
    current: input.current,
    predecessor: {
      subject: predecessor.subject,
      reviewRecordDigest: predecessor.reviewRecordDigest,
      finalAssuranceCommitmentDigest:
        predecessor.finalAssuranceCommitmentDigest,
    },
  });
  return Object.freeze({ candidatePlan, predecessor });
}

export function taskDiffReviewLineageEntryEqual(
  left: TaskDiffReviewLineageEntry,
  right: TaskDiffReviewLineageEntry,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function lineageConflict() {
  return workflowError(
    'TASK_DIFF_REVIEW_LINEAGE_CONFLICT',
    'TaskDiffReview history is ambiguous, incomplete, forked, or cyclic; no current review may be selected.',
    ExitCode.guard,
  );
}
