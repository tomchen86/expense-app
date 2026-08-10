import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
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

export type FloorPruning<T extends FloorCandidate = FloorCandidate> = Readonly<{
  terms: readonly T[];
  dropped: readonly T[];
  escalated: boolean;
}>;

export type IdentifiedFloorCandidate = FloorCandidate &
  Readonly<{
    termId: string;
    floorKind: string;
  }>;

export type FloorOverflowDecision = Readonly<{
  schemaVersion: 1;
  kind: 'floor-overflow-decision';
  limit: number;
  retainedLimit: number;
  reservedNonFloorTerms: number;
  observed: number;
  escalated: boolean;
  reasons: readonly string[];
  dropped: readonly Readonly<{
    termId: string;
    kind: string;
    value: string;
    reason: string;
  }>[];
}>;

export type FloorOverflowResolution = Readonly<{
  terms: readonly IdentifiedFloorCandidate[];
  decision: FloorOverflowDecision;
}>;

const PRIORITY: Readonly<Record<FloorCandidate['kind'], number>> =
  Object.freeze({ symbol: 0, literal: 1, variant: 2 });

const DROPPED_TERM_REASON = 'fixed-priority-floor-overflow-concession';
export const FLOOR_OVERFLOW_MANDATORY_CONTRIBUTION_RESERVE = 2;

/** Binds the fixed surrender order and its mandatory assurance consequence. */
export const FLOOR_OVERFLOW_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(
    canonicalJson({
      schemaVersion: 1,
      kind: 'floor-overflow-policy',
      retentionPriority: PRIORITY,
      droppedTermReason: DROPPED_TERM_REASON,
      overflowAssurance: {
        escalated: true,
        planning: 'individual-only',
        review: 'target-complete',
      },
      mandatoryContributionReserve: {
        main: 1,
        survey: 1,
      },
    }),
  )
  .digest('hex');

export function pruneFloorToLimit<T extends FloorCandidate>(
  floor: readonly T[],
  limit: number,
): FloorPruning<T> {
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

/**
 * Resolves only an overflow owned by the engine floor itself. Caller-authored,
 * survey, and reviewer terms are deliberately absent from this API so they can
 * never buy capacity by evicting a mandatory floor term.
 */
export function resolveFloorOverflow(
  floor: readonly IdentifiedFloorCandidate[],
  limit: number,
  reservedNonFloorTerms = 0,
): FloorOverflowResolution {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(reservedNonFloorTerms) ||
    reservedNonFloorTerms < 0 ||
    reservedNonFloorTerms >= limit
  ) {
    throw workflowError(
      'FLOOR_PRUNING_INVALID',
      'The fixed non-floor reserve must leave capacity for the engine floor.',
      ExitCode.usage,
    );
  }
  const retainedLimit = limit - reservedNonFloorTerms;
  // The reserve is paid only after the floor itself crosses the public scan
  // limit. A near-full floor is never cut merely because a caller supplied a
  // distinct term.
  const pruning =
    floor.length > limit
      ? pruneFloorToLimit(floor, retainedLimit)
      : Object.freeze({
          terms: Object.freeze([...floor]),
          dropped: Object.freeze([]),
          escalated: false,
        });
  const overflowReason = `engine-floor-overflow:${floor.length}>${limit}`;
  return Object.freeze({
    terms: Object.freeze([...pruning.terms]),
    decision: Object.freeze({
      schemaVersion: 1,
      kind: 'floor-overflow-decision',
      limit,
      retainedLimit,
      reservedNonFloorTerms,
      observed: floor.length,
      escalated: pruning.escalated,
      reasons: Object.freeze(pruning.escalated ? [overflowReason] : []),
      dropped: Object.freeze(
        pruning.dropped.map(({ termId, floorKind, value, kind }) =>
          Object.freeze({
            termId,
            kind: floorKind,
            value,
            reason: `${DROPPED_TERM_REASON}:${kind}`,
          }),
        ),
      ),
    }),
  });
}
