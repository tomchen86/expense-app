import { ExitCode, workflowError } from './errors.ts';

/**
 * What to surrender when the mandatory search floor is larger than the scan
 * can carry.
 *
 * The floor exists precisely so that terms cannot be dropped by whoever finds
 * them inconvenient, which makes an over-limit floor a genuine dilemma rather
 * than a matter of taste: something has to go, and the choice must not be the
 * author's. So the order is fixed and the surrender is announced.
 *
 * Identifiers go last because they are what a consumer actually writes.
 * Literals go before them because a consumer may have inlined the value rather
 * than named it, which is a real but narrower risk. Variants go first because
 * they are guesses about formatting, and a guess is the cheapest thing to
 * lose.
 *
 * Nothing here makes the loss acceptable. Any pruning escalates, so the
 * narrowed search is reviewed by someone rather than quietly accepted.
 */

export type FloorCandidate = Readonly<{
  value: string;
  kind: 'symbol' | 'literal' | 'variant';
}>;

export type FloorPruning = Readonly<{
  terms: readonly FloorCandidate[];
  dropped: readonly FloorCandidate[];
  escalated: boolean;
}>;

const PRIORITY: Readonly<Record<FloorCandidate['kind'], number>> =
  Object.freeze({ symbol: 0, literal: 1, variant: 2 });

export function pruneFloorToLimit(
  floor: readonly FloorCandidate[],
  limit: number,
): FloorPruning {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw workflowError(
      'FLOOR_PRUNING_INVALID',
      'A floor limit that admits no terms is a misconfiguration, not a pruning decision.',
      ExitCode.usage,
    );
  }
  const ordered = [...floor].sort(
    (left, right) =>
      PRIORITY[left.kind] - PRIORITY[right.kind] ||
      left.value.localeCompare(right.value),
  );
  const terms = ordered.slice(0, limit);
  const dropped = ordered.slice(limit);
  return Object.freeze({
    terms: Object.freeze(terms),
    dropped: Object.freeze(
      // Named in their own order so the record reads as a list of losses
      // rather than as leftovers.
      [...dropped].sort((left, right) => left.value.localeCompare(right.value)),
    ),
    escalated: dropped.length > 0,
  });
}
