import crypto from 'node:crypto';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
export const INVESTIGATION_TERM_MATCHING = 'case-sensitive-literal-v1';
const TERM_KINDS = new Set([
    'literal-content',
    'literal-path',
    'symbol',
    'config-key',
]);
const MAX_TERM_BYTES = 256;
const MAX_TERM_SEMANTIC_TEXT_BYTES = 4096;
/**
 * Code-owned V1 resource maxima. Provided limits may lower any field but never
 * exceed the fixed maximum, so scans are formatted, reviewed, and replayed with
 * the engine source rather than an unbounded external policy file.
 */
export const INVESTIGATION_LIMITS = {
    maxMainTerms: 64,
    maxSurveyTerms: 64,
    maxReviewerTerms: 32,
    maxEffectiveTerms: 128,
    maxHitsPerTerm: 512,
    maxTotalHits: 4096,
    maxHitDispositionWorkItems: 4096,
    maxScanCpuMillis: 30000,
    maxScanWorkBytes: 30000 * 512 * 1024,
    maxBlobBytes: 2 * 1024 * 1024,
    maxTotalScannedBlobBytes: 64 * 1024 * 1024,
};
/**
 * Reject a limit set that is not integer-bounded or that raises any field above
 * its fixed maximum. Lowering is allowed; exceeding a code-owned cap is not.
 */
export function assertInvestigationLimits(limits) {
    for (const key of Object.keys(INVESTIGATION_LIMITS)) {
        const value = limits[key];
        if (!Number.isInteger(value) ||
            value < 1 ||
            value > INVESTIGATION_LIMITS[key]) {
            throw workflowError('INVESTIGATION_LIMITS_INVALID', `Investigation limit ${String(key)} is out of range.`, ExitCode.usage, { details: { key, value, maximum: INVESTIGATION_LIMITS[key] } });
        }
    }
    return limits;
}
/**
 * Normalize a typed term: validate the kind and byte-bounded control-free value,
 * preserve exact bytes and spaces, and derive the semantic `termId`. Any invalid
 * shape raises `INVESTIGATION_TERM_INVALID`.
 */
export function normalizeInvestigationTerm(input) {
    if (typeof input !== 'object' ||
        input === null ||
        !TERM_KINDS.has(input.kind) ||
        typeof input.value !== 'string') {
        throw termInvalid();
    }
    const value = input.value;
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength < 1 || byteLength > MAX_TERM_BYTES) {
        throw termInvalid();
    }
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        const isControl = codePoint <= 0x1f ||
            codePoint === 0x7f ||
            (codePoint >= 0x80 && codePoint <= 0x9f);
        const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
        if (isControl || isLoneSurrogate) {
            throw termInvalid();
        }
    }
    const kind = input.kind;
    return {
        termId: sha256(canonicalJson({
            schema: 'investigation-term-v1',
            kind,
            value,
            matching: INVESTIGATION_TERM_MATCHING,
        })),
        kind,
        value,
        matching: INVESTIGATION_TERM_MATCHING,
    };
}
/**
 * Deduplicate a term union by semantic identity, retaining every unique sorted
 * provenance entry, and preview per-source and effective resource cost. Input
 * order is irrelevant; the result is deeply frozen and snapshotted so mutating a
 * source contribution afterwards cannot alter it.
 */
export function previewInvestigationTermUnion(contributions, limits = { ...INVESTIGATION_LIMITS }) {
    assertInvestigationLimits(limits);
    const rawCounts = {
        engine: 0,
        main: 0,
        survey: 0,
        reviewer: 0,
    };
    const union = new Map();
    for (const contribution of contributions) {
        assertContribution(contribution);
        rawCounts[contribution.source] += contribution.terms.length;
        for (const rawTerm of contribution.terms) {
            const term = normalizeInvestigationTerm(rawTerm);
            const entry = union.get(term.termId) ?? {
                term,
                provenance: new Map(),
            };
            const mainTerm = contribution.source === 'main'
                ? rawTerm
                : null;
            const provenance = {
                source: contribution.source,
                reference: contribution.reference,
                rationale: mainTerm?.rationale ?? null,
                expectedRelationship: mainTerm?.expectedRelationship ?? null,
            };
            entry.provenance.set(canonicalJson(provenance), provenance);
            union.set(term.termId, entry);
        }
    }
    const terms = [...union.values()]
        .map(({ term, provenance }) => ({
        termId: term.termId,
        kind: term.kind,
        value: term.value,
        matching: term.matching,
        provenance: [...provenance.values()].sort(compareProvenance),
    }))
        .sort((left, right) => (left.termId < right.termId ? -1 : 1));
    const violations = [];
    addLimitViolation(violations, 'MAIN_TERM_LIMIT_EXCEEDED', limits.maxMainTerms, rawCounts.main);
    addLimitViolation(violations, 'SURVEY_TERM_LIMIT_EXCEEDED', limits.maxSurveyTerms, rawCounts.survey);
    addLimitViolation(violations, 'REVIEWER_TERM_LIMIT_EXCEEDED', limits.maxReviewerTerms, rawCounts.reviewer);
    addLimitViolation(violations, 'EFFECTIVE_TERM_LIMIT_EXCEEDED', limits.maxEffectiveTerms, terms.length);
    violations.sort((left, right) => (left.code < right.code ? -1 : 1));
    const preview = violations.length > 0
        ? { outcome: 'requires-narrowing', rawCounts, terms, violations }
        : { outcome: 'ready', rawCounts, terms };
    return deepFreeze(preview);
}
function addLimitViolation(violations, code, limit, observed) {
    if (observed > limit) {
        violations.push({ code, limit, observed });
    }
}
function compareProvenance(left, right) {
    if (left.source !== right.source) {
        return left.source < right.source ? -1 : 1;
    }
    if (left.reference === right.reference) {
        const leftMetadata = `${left.rationale ?? ''}\u0000${left.expectedRelationship ?? ''}`;
        const rightMetadata = `${right.rationale ?? ''}\u0000${right.expectedRelationship ?? ''}`;
        return leftMetadata < rightMetadata
            ? -1
            : leftMetadata > rightMetadata
                ? 1
                : 0;
    }
    return left.reference < right.reference ? -1 : 1;
}
function assertContribution(value) {
    if (typeof value !== 'object' ||
        value === null ||
        !['engine', 'main', 'survey', 'reviewer'].includes(value.source) ||
        typeof value.reference !== 'string' ||
        value.reference.trim().length === 0 ||
        !Array.isArray(value.terms)) {
        throw termInvalid();
    }
    for (const term of value.terms) {
        if (typeof term !== 'object' || term === null) {
            throw termInvalid();
        }
        const record = term;
        const expectedKeys = value.source === 'main'
            ? ['kind', 'value', 'rationale', 'expectedRelationship']
            : ['kind', 'value'];
        if (!hasExactKeys(record, expectedKeys)) {
            throw termInvalid();
        }
        if (value.source === 'main') {
            assertSemanticText(record.rationale);
            assertSemanticText(record.expectedRelationship);
        }
    }
}
function assertSemanticText(value) {
    if (typeof value !== 'string' ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, 'utf8') > MAX_TERM_SEMANTIC_TEXT_BYTES ||
        hasForbiddenControl(value)) {
        throw termInvalid();
    }
}
function hasForbiddenControl(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 0x1f ||
            codePoint === 0x7f ||
            (codePoint >= 0x80 && codePoint <= 0x9f)) {
            return true;
        }
    }
    return false;
}
function hasExactKeys(value, keys) {
    const ownKeys = Reflect.ownKeys(value);
    return (ownKeys.length === keys.length &&
        ownKeys.every((key) => typeof key === 'string') &&
        keys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor);
        }));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function termInvalid() {
    return workflowError('INVESTIGATION_TERM_INVALID', 'Investigation term kind or value is invalid.', ExitCode.usage);
}
