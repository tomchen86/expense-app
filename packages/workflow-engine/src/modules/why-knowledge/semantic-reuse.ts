import {
  assessSemanticFreshness,
  type FreshnessObservation,
  type FreshnessVerdict,
  type ResolutionMode,
} from './semantic-freshness.ts';
import type { LedgerEntry } from './semantic-ledger.ts';

/**
 * Decides, for one change, which understanding it inherits and which it owes.
 *
 * This is the answer to the cost problem the ledger exists for. Breadth is
 * untouched — the change still finds every subject its search reaches — but
 * depth is charged only where the previous explanation stopped holding. A
 * subject nobody disturbed is cited, not re-read.
 *
 * A subject with no entry at all is not a gap in the ledger to be tolerated;
 * it is simply work that has never been done, and it is charged in full.
 */

export type SubjectResolution = Readonly<{
  subjectId: string;
  resolution: ResolutionMode;
  state: FreshnessVerdict['state'] | 'missing-entry';
  reason: string;
  ledgerEntryId: string | null;
}>;

export type ReusePlan = Readonly<{
  resolutions: readonly SubjectResolution[];
  reused: number;
  revalidated: number;
  regenerated: number;
  /** Reused ÷ total, the honest measure of what the ledger saved. */
  reuseRate: number;
}>;

export function planSemanticReuse(
  subjects: readonly string[],
  entries: ReadonlyMap<string, LedgerEntry>,
  observations: ReadonlyMap<string, FreshnessObservation>,
): ReusePlan {
  const resolutions = [...subjects].sort().map((subjectId) => {
    const entry = entries.get(subjectId);
    const observation = observations.get(subjectId);
    if (entry === undefined) {
      return resolution(
        subjectId,
        'regenerate',
        'missing-entry',
        'No prior understanding of this subject has been recorded.',
        null,
      );
    }
    if (observation === undefined) {
      // Nothing observed means nothing verified; the entry cannot be trusted
      // simply because it exists.
      return resolution(
        subjectId,
        'regenerate',
        'identity-ambiguous',
        'The subject could not be observed in the current tree, so its entry cannot be checked.',
        entry.entryId,
      );
    }
    const verdict = assessSemanticFreshness(entry, observation);
    return resolution(
      subjectId,
      verdict.resolution,
      verdict.state,
      verdict.reason,
      entry.entryId,
    );
  });

  const counted = (mode: ResolutionMode) =>
    resolutions.filter((entry) => entry.resolution === mode).length;
  const reused = counted('reuse');
  return Object.freeze({
    resolutions: Object.freeze(resolutions),
    reused,
    revalidated: counted('revalidate'),
    regenerated: counted('regenerate'),
    reuseRate: resolutions.length === 0 ? 0 : reused / resolutions.length,
  });
}

/**
 * The subjects this change actually has to think about. Everything else is
 * cited from the ledger and still appears in the coverage manifest, because
 * reuse is a statement about depth and never about whether a reviewer may see
 * something.
 */
export function subjectsOwedDepth(plan: ReusePlan): readonly string[] {
  return Object.freeze(
    plan.resolutions
      .filter(({ resolution: mode }) => mode !== 'reuse')
      .map(({ subjectId }) => subjectId),
  );
}

function resolution(
  subjectId: string,
  mode: ResolutionMode,
  state: SubjectResolution['state'],
  reason: string,
  ledgerEntryId: string | null,
): SubjectResolution {
  return Object.freeze({
    subjectId,
    resolution: mode,
    state,
    reason,
    ledgerEntryId,
  });
}
