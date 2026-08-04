import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
/**
 * The exact governed mutation classes the scanner and grouping projection see.
 * The list is explicit and ordered so it is reviewed with the engine source. It
 * is grouping and later-closure metadata only; it never filters scan visibility.
 * `live` is the default class for a path that no reviewed rule selects.
 */
export const MUTATION_CLASSES = [
    'live',
    'prohibited',
    'generated',
    'mirror',
    'append-only',
    'immutable',
    'historical-reference',
];
const MUTATION_CLASS_SET = new Set(MUTATION_CLASSES);
const POLICY_SCHEMA = 'mutation-class-policy.v1';
/**
 * Validate a reviewed mutation-class rule set and bind it to a stable digest.
 * Rules are a semantic set: each is strictly validated with exact keys,
 * canonically sorted by rule ID, and hashed in canonical order, so input order
 * never changes identity. A malformed rule, an unknown class, a duplicate rule
 * ID, a non-canonical raw selector, or a hidden extra key fails closed.
 */
export function createMutationClassPolicy(input) {
    if (typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        !hasExactKeys(input, ['rules'])) {
        throw policyInvalid('Mutation-class policy input is malformed.');
    }
    const { rules, policyDigest } = normalizePolicyRules(input.rules);
    return { policyDigest, rules };
}
/**
 * Recompute a policy's digest from its rules and confirm it matches the recorded
 * digest, returning the normalized rules. A fabricated or mutated rule set that
 * retains an old digest fails closed. Every public consumption boundary calls
 * this before trusting a policy.
 */
export function assertMutationClassPolicy(policy) {
    if (typeof policy !== 'object' ||
        policy === null ||
        Array.isArray(policy) ||
        !hasExactKeys(policy, [
            'policyDigest',
            'rules',
        ])) {
        throw policyInvalid('Mutation-class policy is malformed.');
    }
    const { rules, policyDigest } = normalizePolicyRules(policy.rules);
    if (typeof policy.policyDigest !== 'string' ||
        policy.policyDigest !== policyDigest) {
        throw policyInvalid('Mutation-class policy digest does not match its rules.');
    }
    return { rules, policyDigest };
}
/**
 * Classify one path against the policy. The policy digest is recomputed from its
 * rules and compared, so a fabricated or mutated rule set cannot retain an old
 * digest. The path identity is validated by raw-byte round trip and fatal UTF-8
 * consistency. A single agreed class is returned; an unmatched path is `live`;
 * conflicting rules fail closed.
 */
export function classifyMutationPath(policy, path) {
    const { rules } = assertMutationClassPolicy(policy);
    const identity = assertPathIdentity(path);
    const matched = new Set();
    for (const rule of rules) {
        if (selectorMatches(rule.selector, identity)) {
            matched.add(rule.mutationClass);
        }
    }
    if (matched.size > 1) {
        throw policyInvalid('Path is claimed by conflicting mutation-class rules.');
    }
    const mutationClass = matched.size === 1 ? [...matched][0] : 'live';
    return { mutationClass, policyDigest: policy.policyDigest };
}
/**
 * The single path-identity validator reused at every public boundary. It rejects
 * a non-object, unexpected keys, empty or non-canonical Base64, and any UTF-8
 * field that disagrees with the raw bytes (a spoofed rendering or a null that
 * hides valid UTF-8). Callers pass their own error factory so the failure carries
 * the right domain code.
 */
export function assertPathIdentity(value, invalid = policyInvalid) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalid('Path identity is malformed.');
    }
    const record = value;
    const keys = Object.keys(record);
    if (keys.length !== 2 ||
        !Object.prototype.hasOwnProperty.call(record, 'rawBase64') ||
        !Object.prototype.hasOwnProperty.call(record, 'utf8')) {
        throw invalid('Path identity keys are unexpected.');
    }
    const raw = assertCanonicalNonemptyBase64(record.rawBase64, invalid);
    let decoded;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    }
    catch {
        decoded = null;
    }
    if (record.utf8 === null) {
        if (decoded !== null) {
            throw invalid('Path identity hides valid UTF-8 bytes as null.');
        }
    }
    else if (typeof record.utf8 === 'string') {
        if (decoded === null || decoded !== record.utf8) {
            throw invalid('Path identity UTF-8 does not match its raw bytes.');
        }
    }
    else {
        throw invalid('Path identity UTF-8 field is malformed.');
    }
    return { raw, utf8: record.utf8 };
}
function normalizePolicyRules(rules) {
    if (!Array.isArray(rules)) {
        throw policyInvalid('Mutation-class policy requires a rule array.');
    }
    const seenRuleIds = new Set();
    const normalized = [];
    for (const rule of rules) {
        if (typeof rule !== 'object' ||
            rule === null ||
            Array.isArray(rule) ||
            !hasExactKeys(rule, [
                'ruleId',
                'mutationClass',
                'selector',
            ]) ||
            typeof rule.ruleId !== 'string' ||
            rule.ruleId.length === 0 ||
            !MUTATION_CLASS_SET.has(rule.mutationClass) ||
            !isValidSelector(rule.selector)) {
            throw policyInvalid('Mutation-class rule is malformed.');
        }
        if (seenRuleIds.has(rule.ruleId)) {
            throw policyInvalid(`Duplicate mutation-class rule ID: ${rule.ruleId}`);
        }
        seenRuleIds.add(rule.ruleId);
        normalized.push(structuredClone(rule));
    }
    normalized.sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0);
    const policyDigest = sha256(canonicalJson({ schema: POLICY_SCHEMA, rules: normalized }));
    return { rules: normalized, policyDigest };
}
function isValidSelector(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const selector = value;
    switch (selector.kind) {
        case 'path-prefix':
        case 'exact-path':
            return (hasExactKeys(selector, ['kind', 'path']) &&
                typeof selector.path === 'string' &&
                selector.path.length > 0);
        case 'raw-prefix':
            if (!hasExactKeys(selector, ['kind', 'rawBase64']) ||
                typeof selector.rawBase64 !== 'string') {
                return false;
            }
            try {
                assertCanonicalNonemptyBase64(selector.rawBase64);
            }
            catch {
                return false;
            }
            return true;
        default:
            return false;
    }
}
function selectorMatches(selector, identity) {
    switch (selector.kind) {
        case 'path-prefix':
            return (identity.utf8 !== null &&
                (identity.utf8 === selector.path ||
                    identity.utf8.startsWith(`${selector.path}/`)));
        case 'exact-path':
            return identity.utf8 !== null && identity.utf8 === selector.path;
        case 'raw-prefix': {
            const prefix = Buffer.from(selector.rawBase64, 'base64');
            return (identity.raw.byteLength >= prefix.byteLength &&
                identity.raw.subarray(0, prefix.byteLength).equals(prefix));
        }
        default:
            return false;
    }
}
function assertCanonicalNonemptyBase64(value, invalid = policyInvalid) {
    if (typeof value !== 'string' || value.length === 0) {
        throw invalid('Base64 value must be a non-empty string.');
    }
    const raw = Buffer.from(value, 'base64');
    if (raw.byteLength === 0 || raw.toString('base64') !== value) {
        throw invalid('Base64 value is not canonical.');
    }
    return raw;
}
function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function policyInvalid(message = 'Mutation-class policy input is malformed.') {
    return workflowError('MUTATION_CLASS_POLICY_INVALID', message, ExitCode.usage);
}
