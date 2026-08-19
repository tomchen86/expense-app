import type { LedgerEntry } from './semantic-ledger.ts';
import { dependencySetDigest } from './semantic-ledger.ts';

/**
 * Whether an understanding recorded earlier can still be relied on.
 *
 * This is the whole point of the ledger, and the only part where being wrong
 * is expensive: reusing a stale entry means a change proceeds on an
 * explanation that stopped being true. So every reason an entry might no
 * longer hold is a distinct state with a distinct remedy, and anything the
 * engine cannot decide resolves toward re-examination rather than reuse.
 *
 * Three things can move underneath an entry. The subject's own meaning can
 * change. Something it depends on can change, which invalidates it even though
 * its own bytes are untouched — the case a file-modification check misses
 * entirely. And the policy that judged it sufficient can be raised, which
 * leaves the content correct but the assurance owed.
 */

export type FreshnessState =
  | 'current'
  | 'exact-changed-semantic-same'
  | 'subject-changed'
  | 'dependency-changed'
  | 'policy-stale'
  | 'identity-ambiguous'
  | 'subject-deleted'
  | 'superseded';

export type ResolutionMode = 'reuse' | 'revalidate' | 'regenerate';

export type FreshnessObservation = Readonly<{
  /** Absent when the subject no longer resolves in the current tree. */
  present: boolean;
  sourceDigest?: string;
  semanticDigest?: string;
  /** Current entry IDs of the subjects this entry declared it depends on. */
  currentDependencyEntryIds?: Readonly<Record<string, string>>;
  identityAmbiguous?: boolean;
  currentPolicyDigest: string;
}>;

export type FreshnessVerdict = Readonly<{
  state: FreshnessState;
  resolution: ResolutionMode;
  reason: string;
}>;

export function assessSemanticFreshness(
  entry: LedgerEntry,
  observed: FreshnessObservation,
): FreshnessVerdict {
  if (entry.status === 'superseded' || entry.status === 'tombstone') {
    return verdict(
      'superseded',
      'regenerate',
      'The entry has already been replaced and is history, not authority.',
    );
  }
  if (!observed.present) {
    return verdict(
      'subject-deleted',
      'regenerate',
      'The subject no longer exists in the current tree.',
    );
  }
  // Ambiguity is checked before content: if the engine is not sure this is the
  // same subject, comparing its bytes answers the wrong question.
  if (observed.identityAmbiguous === true) {
    return verdict(
      'identity-ambiguous',
      'regenerate',
      'The subject may have moved or been split; identity cannot be carried forward on a guess.',
    );
  }
  if (observed.semanticDigest !== entry.binding.semanticDigest) {
    return verdict(
      'subject-changed',
      'regenerate',
      'The subject means something different than when it was explained.',
    );
  }
  if (dependenciesMoved(entry, observed)) {
    // The consumer's own bytes are untouched; what it relies on is not.
    return verdict(
      'dependency-changed',
      'revalidate',
      'Something this subject depends on changed, so the explanation may no longer follow.',
    );
  }
  if (observed.currentPolicyDigest !== entry.policyDigest) {
    return verdict(
      'policy-stale',
      'revalidate',
      'The content still holds but was judged under a different assurance policy.',
    );
  }
  if (observed.sourceDigest !== entry.binding.sourceDigest) {
    // Formatting moved, meaning did not.
    return verdict(
      'exact-changed-semantic-same',
      'reuse',
      'The bytes changed but the meaning did not; the entry stands with a note.',
    );
  }
  return verdict('current', 'reuse', 'Nothing it depended on has moved.');
}

function dependenciesMoved(
  entry: LedgerEntry,
  observed: FreshnessObservation,
): boolean {
  const current = observed.currentDependencyEntryIds;
  if (current === undefined) {
    // Unknown dependency state is not evidence of stability.
    return entry.semanticDependencies.length > 0;
  }
  return (
    dependencySetDigest(
      entry.semanticDependencies.map((dependency) => ({
        ...dependency,
        entryId: current[dependency.subjectId] ?? dependency.entryId,
      })),
    ) !== entry.dependencySetDigest
  );
}

function verdict(
  state: FreshnessState,
  resolution: ResolutionMode,
  reason: string,
): FreshnessVerdict {
  return Object.freeze({ state, resolution, reason });
}
