import { ExitCode, workflowError } from './errors.ts';

/**
 * How a reviewer's objection ends.
 *
 * The rule that matters is not which dispositions exist but who may apply
 * them. An author who could close a challenge by disagreeing with it would
 * make review advisory, and a review nobody can lose is not a review. So
 * every closure names an authority, and the authorities are chosen so that
 * the author is never the last word on an objection raised against them.
 *
 * A challenge left open blocks the plan at every tier. Tiers decide how much
 * a reviewer must examine before they may raise anything; once something is
 * raised, no tier lets it be carried past.
 */

export type ChallengeDisposition =
  'accepted' | 'rebutted' | 'superseded' | 'withdrawn' | 'waived';

export type ChallengeSeverity = 'ordinary' | 'forbidden-floor';

export type Challenge = Readonly<{
  challengeId: string;
  raisedBy: string;
  severity: ChallengeSeverity;
  targetId: string;
}>;

export type ChallengeClosure = Readonly<{
  challengeId: string;
  disposition: ChallengeDisposition;
  closedBy: string;
  /** For `superseded`, the challenge that replaces this one. */
  supersededBy?: string;
}>;

export type ClosureContext = Readonly<{
  authorId: string;
  reviewerIds: readonly string[];
  domainOwnerIds: readonly string[];
}>;

export function assertChallengesClosed(
  challenges: readonly Challenge[],
  closures: readonly ChallengeClosure[],
  context: ClosureContext,
): void {
  const byId = new Map(
    challenges.map((challenge) => [challenge.challengeId, challenge]),
  );
  const closedIds = new Set<string>();

  for (const closure of closures) {
    const challenge = byId.get(closure.challengeId);
    if (challenge === undefined) {
      throw challengeInvalid(
        `Closure names unknown challenge ${closure.challengeId}.`,
      );
    }
    assertClosureAuthority(challenge, closure, context);
    if (closure.disposition === 'superseded') {
      const successor = closure.supersededBy;
      if (successor === undefined || !byId.has(successor)) {
        throw challengeInvalid(
          `Challenge ${closure.challengeId} is superseded by a challenge that does not exist.`,
        );
      }
      if (successor === closure.challengeId) {
        throw challengeInvalid(
          `Challenge ${closure.challengeId} cannot supersede itself.`,
        );
      }
    }
    closedIds.add(closure.challengeId);
  }

  const open = challenges
    .map(({ challengeId }) => challengeId)
    .filter((challengeId) => !closedIds.has(challengeId));
  if (open.length > 0) {
    throw workflowError(
      'REVIEW_CHALLENGE_OPEN',
      `${open.length} review challenge(s) remain open; a plan may not commit over an unanswered objection.`,
      ExitCode.verification,
      { details: { open } },
    );
  }
}

function assertClosureAuthority(
  challenge: Challenge,
  closure: ChallengeClosure,
  context: ClosureContext,
): void {
  if (closure.closedBy === context.authorId) {
    throw challengeInvalid(
      'An author may not close a challenge raised against their own plan.',
    );
  }
  switch (closure.disposition) {
    case 'withdrawn':
      // Only the person who raised an objection can decide it was mistaken.
      if (closure.closedBy !== challenge.raisedBy) {
        throw challengeInvalid(
          `Only ${challenge.raisedBy} may withdraw challenge ${challenge.challengeId}.`,
        );
      }
      return;
    case 'accepted':
    case 'rebutted':
      // The author may argue; a reviewer decides whether the argument lands.
      if (!context.reviewerIds.includes(closure.closedBy)) {
        throw challengeInvalid(
          `Challenge ${challenge.challengeId} was closed as ${closure.disposition} by ${closure.closedBy}, who is not a reviewer.`,
        );
      }
      return;
    case 'waived':
      if (challenge.severity === 'forbidden-floor') {
        throw challengeInvalid(
          `Challenge ${challenge.challengeId} sits on a forbidden floor and cannot be waived.`,
        );
      }
      if (!context.domainOwnerIds.includes(closure.closedBy)) {
        throw challengeInvalid(
          `Only a named domain owner may waive challenge ${challenge.challengeId}.`,
        );
      }
      return;
    case 'superseded':
      if (
        !context.reviewerIds.includes(closure.closedBy) ||
        closure.closedBy === context.authorId
      ) {
        throw challengeInvalid(
          `Challenge ${challenge.challengeId} may only be superseded by a reviewer.`,
        );
      }
      return;
  }
}

/**
 * Whether resolving the challenges moved anything the review was bound to. A
 * changed target digest means the reviewed thing is not the thing being
 * committed, so the review is owed again over what actually changed.
 */
export function deltaReviewRequired(
  reviewedTargetDigests: Readonly<Record<string, string>>,
  currentTargetDigests: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.freeze(
    Object.keys(currentTargetDigests)
      .filter(
        (targetId) =>
          reviewedTargetDigests[targetId] !== currentTargetDigests[targetId],
      )
      .sort(),
  );
}

function challengeInvalid(message: string) {
  return workflowError('REVIEW_CHALLENGE_INVALID', message, ExitCode.guard);
}
