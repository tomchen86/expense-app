import { ExitCode, workflowError } from './errors.js';
/**
 * The single authority boundary shared by review domains. Callers must first
 * authenticate the closer through their domain-specific mechanism (for
 * example a fixed-runner provider result or a maintainer signature). This
 * verifier then enforces the exact subject binding and the common
 * author-cannot-close/disposition rules before an authority node is minted.
 */
export function assertAuthorizedReviewChallengeClosure(input) {
    if (!/^[0-9a-f]{64}$/.test(input.expectedSubjectDigest) ||
        input.authoritySubjectDigest !== input.expectedSubjectDigest ||
        input.authenticatedCloserId.length === 0 ||
        input.closures.some(({ closedBy }) => closedBy !== input.authenticatedCloserId) ||
        (!input.context.reviewerIds.includes(input.authenticatedCloserId) &&
            !input.context.domainOwnerIds.includes(input.authenticatedCloserId))) {
        throw challengeInvalid('Authenticated challenge closure is not bound to its exact subject and closer authority.');
    }
    assertChallengesClosed(input.challenges, input.closures, input.context);
}
export function assertChallengesClosed(challenges, closures, context) {
    const byId = new Map(challenges.map((challenge) => [challenge.challengeId, challenge]));
    const closedIds = new Set();
    for (const closure of closures) {
        const challenge = byId.get(closure.challengeId);
        if (challenge === undefined) {
            throw challengeInvalid(`Closure names unknown challenge ${closure.challengeId}.`);
        }
        assertClosureAuthority(challenge, closure, context);
        if (closure.disposition === 'superseded') {
            const successor = closure.supersededBy;
            if (successor === undefined || !byId.has(successor)) {
                throw challengeInvalid(`Challenge ${closure.challengeId} is superseded by a challenge that does not exist.`);
            }
            if (successor === closure.challengeId) {
                throw challengeInvalid(`Challenge ${closure.challengeId} cannot supersede itself.`);
            }
        }
        closedIds.add(closure.challengeId);
    }
    const open = challenges
        .map(({ challengeId }) => challengeId)
        .filter((challengeId) => !closedIds.has(challengeId));
    if (open.length > 0) {
        throw workflowError('REVIEW_CHALLENGE_OPEN', `${open.length} review challenge(s) remain open; a plan may not commit over an unanswered objection.`, ExitCode.verification, { details: { open } });
    }
}
function assertClosureAuthority(challenge, closure, context) {
    if (closure.closedBy === context.authorId) {
        throw challengeInvalid('An author may not close a challenge raised against their own plan.');
    }
    switch (closure.disposition) {
        case 'withdrawn':
            // Only the person who raised an objection can decide it was mistaken.
            if (closure.closedBy !== challenge.raisedBy) {
                throw challengeInvalid(`Only ${challenge.raisedBy} may withdraw challenge ${challenge.challengeId}.`);
            }
            return;
        case 'accepted':
        case 'rebutted':
            // The author may argue; a reviewer decides whether the argument lands.
            if (!context.reviewerIds.includes(closure.closedBy)) {
                throw challengeInvalid(`Challenge ${challenge.challengeId} was closed as ${closure.disposition} by ${closure.closedBy}, who is not a reviewer.`);
            }
            return;
        case 'waived':
            if (challenge.severity === 'forbidden-floor') {
                throw challengeInvalid(`Challenge ${challenge.challengeId} sits on a forbidden floor and cannot be waived.`);
            }
            if (!context.domainOwnerIds.includes(closure.closedBy)) {
                throw challengeInvalid(`Only a named domain owner may waive challenge ${challenge.challengeId}.`);
            }
            return;
        case 'superseded':
            if (!context.reviewerIds.includes(closure.closedBy) ||
                closure.closedBy === context.authorId) {
                throw challengeInvalid(`Challenge ${challenge.challengeId} may only be superseded by a reviewer.`);
            }
            return;
    }
}
/**
 * Whether resolving the challenges moved anything the review was bound to. A
 * changed target digest means the reviewed thing is not the thing being
 * committed, so the review is owed again over what actually changed.
 */
export function deltaReviewRequired(reviewedTargetDigests, currentTargetDigests) {
    return Object.freeze(Object.keys(currentTargetDigests)
        .filter((targetId) => reviewedTargetDigests[targetId] !== currentTargetDigests[targetId])
        .sort());
}
function challengeInvalid(message) {
    return workflowError('REVIEW_CHALLENGE_INVALID', message, ExitCode.guard);
}
