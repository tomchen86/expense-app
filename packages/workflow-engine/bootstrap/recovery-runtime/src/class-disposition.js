import { ExitCode, workflowError } from './errors.js';
import { evaluateHitPredicate, parseHitPredicate, } from './hit-predicate.js';
import { compressionEligible, resolvePathRole, } from './path-role-registry.js';
import { assessPredicateDiscrimination } from './predicate-discrimination.js';
/**
 * One written judgement covering a set of scan hits that are the same kind of
 * thing.
 *
 * This is the mechanism that makes planning cheaper: instead of a hand-written
 * disposition per group, an author writes one rationale for an equivalence
 * class and the engine proves the membership. What it deliberately does not do
 * is change what the evidence looks like afterwards — a class expands into
 * ordinary per-group disposition answers, so every existing rule about
 * dispositions partitioning groups keeps applying to the expanded nodes rather
 * than being relaxed to accommodate a new shape.
 *
 * The saving is therefore in authoring, not in coverage: every group still
 * carries exactly one disposition, and a group the engine cannot prove belongs
 * simply falls back to being written individually.
 */
const CLASSIFICATIONS = new Set([
    'load-bearing',
    'test-or-mirror',
    'generated',
    'incidental-reference',
    'irrelevant',
]);
export function parseClassDisposition(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw classInvalid('A class disposition is an object.');
    }
    const raw = value;
    if (raw.schemaVersion !== 1 || raw.kind !== 'class-disposition') {
        throw classInvalid('Class disposition identity is wrong.');
    }
    const classId = nonEmptyString(raw.classId, 'classId');
    const classification = nonEmptyString(raw.classification, 'classification');
    if (!CLASSIFICATIONS.has(classification)) {
        throw classInvalid(`Unknown classification ${classification}.`);
    }
    const rationale = nonEmptyString(raw.rationale, 'rationale');
    const author = nonEmptyString(raw.author, 'author');
    if (!Array.isArray(raw.members) ||
        raw.members.length === 0 ||
        raw.members.some((member) => typeof member !== 'string' || member === '')) {
        throw classInvalid('A class lists at least one member group.');
    }
    if (new Set(raw.members).size !== raw.members.length) {
        throw classInvalid(`Class ${classId} lists a member twice.`);
    }
    let predicate;
    try {
        predicate = parseHitPredicate(raw.predicate);
    }
    catch (error) {
        throw classInvalid(`Class ${classId} predicate is unusable: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    return Object.freeze({
        schemaVersion: 1,
        kind: 'class-disposition',
        classId,
        predicate,
        classification,
        rationale,
        author,
        members: Object.freeze([...raw.members].sort()),
    });
}
/**
 * Proves each class and turns it into ordinary disposition answers.
 *
 * Everything a class claims is checked against evidence the engine already
 * holds: that each member group's hits really do satisfy the predicate, that
 * the predicate distinguishes them from the hits that are not members, and
 * that no member sits on a path where a mistaken class would be expensive.
 * Failing any of these refuses the class rather than downgrading it, because a
 * class that half-holds is a rationale attached to hits it does not describe.
 */
export function expandClassDispositions(classes, groups, registry, options = {}) {
    const saturated = new Set(options.saturatedTermIds ?? []);
    const groupsById = new Map(groups.map((group) => [group.groupId, group]));
    const claimed = new Map();
    const dispositions = [];
    for (const declared of classes) {
        const members = [];
        for (const groupId of declared.members) {
            const group = groupsById.get(groupId);
            if (group === undefined) {
                throw classInvalid(`Class ${declared.classId} claims unknown group ${groupId}.`);
            }
            const owner = claimed.get(groupId);
            if (owner !== undefined) {
                throw classInvalid(`Group ${groupId} is claimed by both ${owner} and ${declared.classId}.`);
            }
            claimed.set(groupId, declared.classId);
            members.push(group);
        }
        for (const group of members) {
            // A term that hit its ceiling returned a truncated view of where it
            // occurs, so nothing drawn from it can be shown to be complete. Its
            // groups are judged one at a time until the search itself is sound.
            if (group.termId !== undefined && saturated.has(group.termId)) {
                throw classInvalid(`Group ${group.groupId} comes from saturated term ${group.termId}, whose hits are known to be incomplete.`);
            }
            for (const groupHit of group.hits) {
                const resolution = resolvePathRole(registry, groupHit.path);
                if (!compressionEligible(resolution)) {
                    throw classInvalid(`Group ${group.groupId} hits ${groupHit.path}, whose role ${resolution.role ?? 'unregistered'} is never folded into a class.`);
                }
                if (!evaluateHitPredicate(declared.predicate, groupHit)) {
                    // Naming what the hit actually looks like: a class claim is about
                    // this text, so a refusal that withholds it cannot be acted on.
                    const seen = groupHit.window === null
                        ? 'no stored window'
                        : `${JSON.stringify((groupHit.window.utf8 ?? '').slice(0, 200))}${groupHit.window.truncated ? ' (truncated)' : ''}`;
                    throw classInvalid(`Group ${group.groupId} has a hit in ${groupHit.path} that the class predicate does not describe: ${seen}.`);
                }
            }
        }
        // The control set is every hit outside this class: the predicate has to
        // separate its members from the rest of what the same scan produced.
        const memberIds = new Set(declared.members);
        const controls = groups
            .filter((group) => !memberIds.has(group.groupId))
            .flatMap((group) => group.hits);
        const verdict = assessPredicateDiscrimination(declared.predicate, members.flatMap((group) => group.hits), controls);
        if (!verdict.admissible) {
            throw classInvalid(`Class ${declared.classId} is not admissible: ${verdict.reasons.join('; ')}`);
        }
        for (const group of members) {
            dispositions.push(Object.freeze({
                groupId: group.groupId,
                classification: declared.classification,
                rationale: declared.rationale,
                author: declared.author,
                classId: declared.classId,
            }));
        }
    }
    return Object.freeze({
        dispositions: Object.freeze(dispositions),
        uncovered: Object.freeze(groups
            .map(({ groupId }) => groupId)
            .filter((groupId) => !claimed.has(groupId))
            .sort()),
    });
}
function nonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw classInvalid(`Class disposition ${field} is empty.`);
    }
    return value;
}
function classInvalid(message) {
    return workflowError('CLASS_DISPOSITION_INVALID', message, ExitCode.usage);
}
