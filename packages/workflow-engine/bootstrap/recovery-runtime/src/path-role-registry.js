import { isRecord, isStringArray } from './contract-values.js';
import { ExitCode, workflowError } from './errors.js';
import { matchesAllowedPath, normalizePolicyPath } from './paths.js';
/**
 * What a repository path is, for the purpose of deciding how much planning
 * evidence it owes. Planning compression attributes one hand-written rationale
 * to a whole class of scan hits, which is only safe where a mistake is cheap to
 * discover. These roles name the places where it is not.
 *
 * A path that no rule claims is `unregistered`, which is deliberately distinct
 * from `ordinary`: an unclassified path has not been judged safe, it has merely
 * not been judged.
 */
export const PATH_ROLES = Object.freeze([
    'control-plane',
    'grant',
    'lifecycle',
    'policy',
    'verification-infrastructure',
    'contract-surface',
    'ordinary',
]);
const ROLE_SET = new Set(PATH_ROLES);
/**
 * Roles whose paths may never be folded into a class disposition. A mistake in
 * any of them is discovered late and costs more than the authoring it saves.
 */
const COMPRESSIBLE_ROLES = new Set(['ordinary']);
export function parsePathRoleRegistry(value) {
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'path-role-registry' ||
        !isRecord(value.roles)) {
        throw registryInvalid('Path role registry is malformed.');
    }
    const claimed = new Map();
    const rules = [];
    for (const [role, patterns] of Object.entries(value.roles)) {
        if (!ROLE_SET.has(role)) {
            throw registryInvalid(`Path role registry declares unknown role ${role}.`);
        }
        if (!isStringArray(patterns) || patterns.length === 0) {
            throw registryInvalid(`Path role ${role} declares no usable patterns.`);
        }
        for (const raw of patterns) {
            let pattern;
            try {
                pattern = normalizePolicyPath(raw);
            }
            catch {
                throw registryInvalid(`Path role ${role} declares an unusable pattern ${JSON.stringify(raw)}.`);
            }
            const existing = claimed.get(pattern);
            if (existing !== undefined) {
                throw registryInvalid(`Pattern ${pattern} is claimed by both ${existing} and ${role}.`);
            }
            claimed.set(pattern, role);
            rules.push({ pattern, role: role });
        }
    }
    if (rules.length === 0) {
        throw registryInvalid('Path role registry declares no rules.');
    }
    // Narrowest first: an exact registration must outrank a prefix that also
    // covers it, or a broad sibling pattern would launder a risky file.
    rules.sort((left, right) => specificity(right.pattern) - specificity(left.pattern) ||
        left.pattern.localeCompare(right.pattern));
    return Object.freeze({
        schemaVersion: 1,
        kind: 'path-role-registry',
        rules: Object.freeze(rules.map((rule) => Object.freeze(rule))),
    });
}
export function resolvePathRole(registry, candidatePath) {
    for (const { pattern, role } of registry.rules) {
        if (matchesAllowedPath(candidatePath, pattern)) {
            return Object.freeze({ registered: true, role, pattern });
        }
    }
    return Object.freeze({ registered: false, role: null, pattern: null });
}
/**
 * Whether a path's scan hits may be disposed of as part of an equivalence
 * class rather than individually. Fails deep: an unregistered path is never
 * eligible, so forgetting to classify something costs authoring effort rather
 * than assurance.
 */
export function compressionEligible(resolution) {
    return resolution.registered && COMPRESSIBLE_ROLES.has(resolution.role);
}
/** An exact path is narrower than any prefix; a longer prefix is narrower. */
function specificity(pattern) {
    return pattern.endsWith('/**') ? pattern.length - 3 : pattern.length + 1_000;
}
function registryInvalid(message) {
    return workflowError('PATH_ROLE_REGISTRY_INVALID', message, ExitCode.usage);
}
