import { ExitCode, workflowError } from './errors.ts';

/**
 * Reconciling what a change said it would do against what it did.
 *
 * The intent is recorded before implementation and the outcome after, in that
 * order and never merged. Writing the explanation afterwards produces an
 * account of whatever happened to be built, which always sounds coherent — the
 * point of claiming first is to make it possible to be wrong.
 *
 * Then every changed range of production source must be explained by one of a
 * fixed set of dispositions. A mutation nobody can account for blocks
 * completion, because the alternative is a change whose evidence describes a
 * different change than the one being committed.
 */

export type MutationDisposition =
  | 'existing-subject-changed'
  | 'new-subject'
  | 'subject-deleted'
  | 'subject-moved'
  | 'non-semantic-change'
  | 'generated-output'
  | 'vendored-or-external';

export type PlannedMutation = Readonly<{
  subjectId: string;
  intendedChange: string;
  invariantsToPreserve: readonly string[];
}>;

export type ChangedRange = Readonly<{
  path: string;
  startLine: number;
  endLine: number;
}>;

export type ActualMutation = Readonly<{
  subjectId: string;
  disposition: MutationDisposition;
  whatChanged: string;
  whyChanged: string;
  preservedInvariants: readonly string[];
  removedInvariants: readonly string[];
  ranges: readonly ChangedRange[];
}>;

export type ReconciliationVerdict = Readonly<{
  reconciled: boolean;
  unaccountedRanges: readonly ChangedRange[];
  unplannedSubjects: readonly string[];
  abandonedIntents: readonly string[];
  brokenInvariants: readonly string[];
}>;

export function reconcileImplementation(
  planned: readonly PlannedMutation[],
  actual: readonly ActualMutation[],
  changedRanges: readonly ChangedRange[],
): ReconciliationVerdict {
  const accounted = new Set(
    actual.flatMap(({ ranges }) => ranges.map(rangeKey)),
  );
  const unaccountedRanges = changedRanges.filter(
    (range) => !accounted.has(rangeKey(range)),
  );

  const plannedIds = new Set(planned.map(({ subjectId }) => subjectId));
  const actualIds = new Set(actual.map(({ subjectId }) => subjectId));

  // Touching something the plan never mentioned is not automatically wrong,
  // but it is always something a reviewer has to be told about.
  const unplannedSubjects = [...actualIds]
    .filter((subjectId) => !plannedIds.has(subjectId))
    .sort();
  const abandonedIntents = [...plannedIds]
    .filter((subjectId) => !actualIds.has(subjectId))
    .sort();

  // An invariant the plan promised to preserve, recorded afterwards as
  // removed, is the single most important thing this comparison can surface.
  const promised = new Map(
    planned.map(({ subjectId, invariantsToPreserve }) => [
      subjectId,
      new Set(invariantsToPreserve),
    ]),
  );
  const brokenInvariants = actual
    .flatMap(({ subjectId, removedInvariants }) =>
      removedInvariants
        .filter((invariant) => promised.get(subjectId)?.has(invariant) === true)
        .map((invariant) => `${subjectId}: ${invariant}`),
    )
    .sort();

  return Object.freeze({
    reconciled: unaccountedRanges.length === 0 && brokenInvariants.length === 0,
    unaccountedRanges: Object.freeze(unaccountedRanges),
    unplannedSubjects: Object.freeze(unplannedSubjects),
    abandonedIntents: Object.freeze(abandonedIntents),
    brokenInvariants: Object.freeze(brokenInvariants),
  });
}

export function assertImplementationReconciled(
  verdict: ReconciliationVerdict,
): void {
  if (verdict.brokenInvariants.length > 0) {
    throw workflowError(
      'SEMANTIC_INVARIANT_BROKEN',
      `The implementation removed ${verdict.brokenInvariants.length} invariant(s) the plan promised to preserve.`,
      ExitCode.verification,
      { details: { brokenInvariants: verdict.brokenInvariants } },
    );
  }
  if (verdict.unaccountedRanges.length > 0) {
    throw workflowError(
      'SEMANTIC_MUTATION_UNACCOUNTED',
      `${verdict.unaccountedRanges.length} changed range(s) are not explained by any recorded mutation.`,
      ExitCode.verification,
      { details: { unaccountedRanges: verdict.unaccountedRanges } },
    );
  }
}

function rangeKey(range: ChangedRange): string {
  return `${range.path}:${range.startLine}-${range.endLine}`;
}
