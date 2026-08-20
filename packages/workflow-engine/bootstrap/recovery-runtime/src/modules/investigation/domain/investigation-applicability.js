import crypto from 'node:crypto';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
import { normalizeExactRepositoryPath } from "../../../runtime/session-workspace/paths.js";
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RATIONALE_BYTES = 4096;
const MAX_AUTHOR_BYTES = 1024;
const MAX_PROVENANCE_BYTES = 1024;
const MAX_DECLARED_PATHS = 4096;
const MAX_RESEARCH_BUDGET_MINUTES = 480;
export const INVESTIGATION_EXEMPTION_CATEGORIES = Object.freeze([
    'documentation-only',
    'formatting-only',
    'deterministic-generated-projection',
    'time-boxed-research',
]);
export const INVESTIGATION_CHANGE_CLASSES = Object.freeze([
    ...INVESTIGATION_EXEMPTION_CATEGORIES,
    'security',
    'migration',
    'shared-contract',
    'public-api',
    'rename-removal',
    'behavioral',
]);
const EXEMPTION_CATEGORIES = new Set(INVESTIGATION_EXEMPTION_CATEGORIES);
const CHANGE_CLASSES = new Set(INVESTIGATION_CHANGE_CLASSES);
const INELIGIBLE_CHANGE_CLASSES = new Set([
    'security',
    'migration',
    'shared-contract',
    'public-api',
    'rename-removal',
    'behavioral',
]);
const APPLICABILITY_POLICY = Object.freeze({
    schema: 'investigation-applicability-policy.v1',
    exemptionCategories: [...INVESTIGATION_EXEMPTION_CATEGORIES],
    ineligibleChangeClasses: [...INELIGIBLE_CHANGE_CLASSES].sort(),
    requiredBehaviorReliance: 'none-declared',
    maxDeclaredPaths: MAX_DECLARED_PATHS,
    maxRationaleBytes: MAX_RATIONALE_BYTES,
    maxResearchBudgetMinutes: MAX_RESEARCH_BUDGET_MINUTES,
});
export const INVESTIGATION_APPLICABILITY_POLICY_DIGEST = sha256(canonicalJson(APPLICABILITY_POLICY));
/**
 * Create the exact applicability subject consumed by later readiness, review,
 * and CI transitions. An exemption is a separate semantic branch; it never
 * creates empty scan, disposition, or WHY evidence.
 */
export function createInvestigationApplicability(input) {
    if (!isRecord(input) || typeof input.kind !== 'string') {
        throw applicabilityInvalid();
    }
    const baseline = assertBaseline(input.baseline);
    const intentDigest = assertDigest(input.intentDigest);
    if (input.kind === 'sealed-investigation') {
        assertExactKeys(input, [
            'kind',
            'baseline',
            'intentDigest',
            'sealNodeId',
            'sealResultDigest',
        ]);
        const semantic = {
            kind: input.kind,
            baseline,
            intentDigest,
            sealNodeId: assertDigest(input.sealNodeId),
            sealResultDigest: assertDigest(input.sealResultDigest),
        };
        return deepFreeze({
            schemaVersion: 1,
            ...semantic,
            policyDigest: INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
            applicabilityDigest: applicabilityDigest(semantic),
        });
    }
    if (input.kind !== 'investigation-exemption') {
        throw applicabilityInvalid();
    }
    assertExactKeys(input, [
        'kind',
        'category',
        'baseline',
        'intentDigest',
        'declaredPaths',
        'declaredChangeClasses',
        'rationale',
        'semanticAuthor',
        'nonTrivialBehaviorReliance',
        'researchBudgetMinutes',
    ]);
    if (typeof input.category !== 'string' ||
        !EXEMPTION_CATEGORIES.has(input.category)) {
        throw exemptionInvalid();
    }
    const declaredChangeClasses = assertChangeClasses(input.declaredChangeClasses);
    if (!declaredChangeClasses.includes(input.category) ||
        declaredChangeClasses.some((value) => INELIGIBLE_CHANGE_CLASSES.has(value))) {
        throw exemptionIneligible();
    }
    if (input.nonTrivialBehaviorReliance !== 'none-declared') {
        throw exemptionIneligible();
    }
    const researchBudgetMinutes = assertResearchBudget(input.category, input.researchBudgetMinutes);
    const semantic = {
        kind: input.kind,
        category: input.category,
        baseline,
        intentDigest,
        declaredPaths: assertDeclaredPaths(input.declaredPaths),
        declaredChangeClasses,
        rationale: assertBoundedText(input.rationale, MAX_RATIONALE_BYTES),
        semanticAuthor: assertSemanticAuthor(input.semanticAuthor),
        nonTrivialBehaviorReliance: input.nonTrivialBehaviorReliance,
        researchBudgetMinutes,
    };
    return deepFreeze({
        schemaVersion: 1,
        ...semantic,
        policyDigest: INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
        applicabilityDigest: applicabilityDigest(semantic),
    });
}
export function assertInvestigationApplicability(value) {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw applicabilityInvalid();
    }
    const policyDigest = value.policyDigest;
    const storedDigest = value.applicabilityDigest;
    if (policyDigest !== INVESTIGATION_APPLICABILITY_POLICY_DIGEST ||
        typeof storedDigest !== 'string') {
        throw applicabilityInvalid();
    }
    const input = { ...value };
    delete input.schemaVersion;
    delete input.policyDigest;
    delete input.applicabilityDigest;
    const normalized = createInvestigationApplicability(input);
    if (normalized.applicabilityDigest !== storedDigest) {
        throw applicabilityInvalid();
    }
    return normalized;
}
function applicabilityDigest(value) {
    return sha256(canonicalJson({
        schema: 'investigation-applicability-subject.v1',
        policyDigest: INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
        value,
    }));
}
function assertBaseline(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['head', 'tree']) ||
        typeof value.head !== 'string' ||
        !GIT_OBJECT_ID.test(value.head) ||
        typeof value.tree !== 'string' ||
        !GIT_OBJECT_ID.test(value.tree) ||
        value.head.length !== value.tree.length) {
        throw applicabilityInvalid();
    }
    return { head: value.head, tree: value.tree };
}
function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw applicabilityInvalid();
    }
    return value;
}
function assertDeclaredPaths(value) {
    if (!Array.isArray(value) ||
        value.length < 1 ||
        value.length > MAX_DECLARED_PATHS) {
        throw exemptionInvalid();
    }
    let normalized;
    try {
        normalized = value.map((entry) => normalizeExactRepositoryPath(entry));
    }
    catch {
        throw exemptionInvalid();
    }
    normalized.sort();
    if (normalized.length !== new Set(normalized).size) {
        throw exemptionInvalid();
    }
    return normalized;
}
function assertChangeClasses(value) {
    if (!Array.isArray(value) || value.length < 1) {
        throw exemptionInvalid();
    }
    const classes = value.map((entry) => {
        if (typeof entry !== 'string' || !CHANGE_CLASSES.has(entry)) {
            throw exemptionInvalid();
        }
        return entry;
    });
    classes.sort();
    if (classes.length !== new Set(classes).size) {
        throw exemptionInvalid();
    }
    return classes;
}
function assertSemanticAuthor(value) {
    if (!isRecord(value) || !hasExactKeys(value, ['id', 'provenance'])) {
        throw exemptionInvalid();
    }
    return {
        id: assertBoundedText(value.id, MAX_AUTHOR_BYTES),
        provenance: assertBoundedText(value.provenance, MAX_PROVENANCE_BYTES),
    };
}
function assertResearchBudget(category, value) {
    if (category === 'time-boxed-research') {
        if (!Number.isInteger(value) ||
            value < 1 ||
            value > MAX_RESEARCH_BUDGET_MINUTES) {
            throw exemptionInvalid();
        }
        return value;
    }
    if (value !== null) {
        throw exemptionInvalid();
    }
    return null;
}
function assertBoundedText(value, maximumBytes) {
    if (typeof value !== 'string' ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, 'utf8') > maximumBytes ||
        hasForbiddenControl(value)) {
        throw exemptionInvalid();
    }
    return value;
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
function assertExactKeys(value, keys) {
    if (!hasExactKeys(value, keys)) {
        throw applicabilityInvalid();
    }
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
function isRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
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
function applicabilityInvalid() {
    return workflowError('INVESTIGATION_APPLICABILITY_INVALID', 'Investigation applicability is malformed or not canonical.', ExitCode.usage);
}
function exemptionInvalid() {
    return workflowError('INVESTIGATION_EXEMPTION_INVALID', 'Investigation exemption is malformed or exceeds its bounded contract.', ExitCode.usage);
}
function exemptionIneligible() {
    return workflowError('INVESTIGATION_EXEMPTION_INELIGIBLE', 'Investigation exemption cannot authorize this declared change class.', ExitCode.guard);
}
