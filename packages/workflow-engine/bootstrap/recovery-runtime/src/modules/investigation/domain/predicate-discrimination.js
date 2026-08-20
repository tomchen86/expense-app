import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
import { evaluateHitPredicate, } from "./hit-predicate.js";
/**
 * Whether a class predicate says anything.
 *
 * A class disposition replaces one hand-written rationale per hit with one per
 * class, on the claim that its members are the same kind of thing. The claim is
 * worthless if the predicate is true of every hit the term produced — "the
 * window mentions the term" is true by construction, yet it would pass any
 * check that only asked whether the members match.
 *
 * So a predicate must do both jobs: hold for every member, and reject most of
 * the hits that are not members. The second is the one that cannot be faked.
 */
export const DISCRIMINATION_THRESHOLD = 0.9;
export function assessPredicateDiscrimination(predicate, members, controls, options = {}) {
    const threshold = options.threshold ?? DISCRIMINATION_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw workflowError('PREDICATE_DISCRIMINATION_INVALID', 'A discrimination threshold is a proportion between zero and one.', ExitCode.usage);
    }
    const reasons = [];
    const membersMatched = members.filter((member) => evaluateHitPredicate(predicate, member)).length;
    // A hit with no stored window cannot match anything, so counting it as a
    // rejection would let a tautology borrow discrimination it does not have.
    // Excluding it from the denominator is the difference between measuring the
    // predicate and measuring the evidence.
    const comparable = controls.filter((control) => control.window !== null && control.window.utf8 !== null);
    const controlRejected = comparable.filter((control) => !evaluateHitPredicate(predicate, control)).length;
    const rejectionRate = comparable.length === 0 ? 0 : controlRejected / comparable.length;
    if (members.length === 0) {
        reasons.push('empty-class:a class with no members explains nothing');
    }
    if (membersMatched !== members.length) {
        reasons.push(`member-not-matched:${members.length - membersMatched} of ${members.length} members fail the predicate`);
    }
    if (comparable.length === 0) {
        reasons.push('no-control-hits:discrimination cannot be shown against an empty comparison set');
    }
    else if (controlRejected === 0) {
        // A predicate that rejects nothing is true of every hit the term produced,
        // so it explains nothing about why these hits belong together. This holds
        // at any threshold: otherwise the bar could be configured to zero and the
        // whole check would become a formality.
        reasons.push('vacuous-predicate:no control hit is rejected, so the predicate is true of every hit');
    }
    else if (rejectionRate < threshold) {
        reasons.push(`weak-discrimination:${controlRejected}/${comparable.length} controls rejected, below the ${threshold} bar`);
    }
    return Object.freeze({
        admissible: reasons.length === 0,
        memberCount: members.length,
        membersMatched,
        controlCount: comparable.length,
        controlRejected,
        rejectionRate,
        threshold,
        reasons: Object.freeze(reasons),
    });
}
