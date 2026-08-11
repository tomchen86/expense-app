import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { normalizePolicyPath } from './paths.js';
const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const REPOSITORY_ID = /^github:[A-Za-z0-9_.:/-]+$/;
const MAX_REPOSITORY_ID_BYTES = 512;
export const TASK_DIFF_REVIEW_COVERAGE = Object.freeze([
    'correctness-and-invariants',
    'spec-and-design-conformance',
    'test-adequacy',
    'scope-and-unaccounted-bytes',
    'trust-boundaries-and-security',
    'consumers-generated-and-mirrored-artifacts',
    'residual-risk-and-uncertainty',
]);
const TASK_DIFF_REVIEW_POLICY = Object.freeze({
    schemaVersion: 1,
    kind: 'task-diff-review-policy.v1',
    requiredIndependence: 'provider-independent',
    behavioralStrategies: ['cross-agent-tdd'],
    mechanicallySatisfiedStrategies: ['mechanical-transform', 'direct-reviewed'],
    riskyPathRoles: [
        'control-plane',
        'grant',
        'lifecycle',
        'policy',
        'verification-infrastructure',
        'contract-surface',
        'unregistered',
    ],
    coverage: TASK_DIFF_REVIEW_COVERAGE,
});
export const TASK_DIFF_REVIEW_POLICY_DIGEST = sha256(canonicalJson(TASK_DIFF_REVIEW_POLICY));
export function taskDiffReviewRequirement(input) {
    const paths = normalizeRolePaths(input.paths);
    if (input.diffReview === 'required') {
        return freezeRequirement({
            required: true,
            basis: 'explicit',
            riskPaths: [],
        });
    }
    if (input.strategy === 'cross-agent-tdd') {
        return freezeRequirement({
            required: true,
            basis: 'behavioral-strategy',
            riskPaths: [],
        });
    }
    const risky = paths.filter(({ role }) => role !== 'ordinary');
    if (risky.length > 0) {
        return freezeRequirement({
            required: true,
            basis: 'risk-role',
            riskPaths: risky,
        });
    }
    return freezeRequirement({
        required: false,
        basis: input.strategy === 'mechanical-transform'
            ? 'mechanical-evidence'
            : 'policy-not-triggered',
        riskPaths: [],
    });
}
export function createTaskDiffReviewSubject(input) {
    const transitions = normalizeTransitions(input.transitions);
    const reviewRequirement = parseReviewRequirement(input.reviewRequirement);
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-subject.v1',
        repositoryId: normalizeRepositoryId(input.repositoryId),
        changeId: normalizeChangeId(input.changeId),
        taskId: normalizeTaskId(input.taskId),
        baseCommit: normalizeObjectId(input.baseCommit),
        baseTree: normalizeObjectId(input.baseTree),
        candidateTree: normalizeObjectId(input.candidateTree),
        changedPaths: transitions.map(({ path }) => path),
        transitions,
        patchDigest: patchDigest(transitions),
        taskContractDigest: normalizeDigest(input.taskContractDigest),
        requiredCheckPolicyDigest: normalizeDigest(input.requiredCheckPolicyDigest),
        checkEvidenceDigest: normalizeDigest(input.checkEvidenceDigest),
        planningGenerationId: normalizeDigest(input.planningGenerationId),
        planTargetDigest: normalizeDigest(input.planTargetDigest),
        planReviewNodeId: normalizeDigest(input.planReviewNodeId),
        planningAssuranceDigest: normalizeDigest(input.planningAssuranceDigest),
        reviewPolicyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
        reviewRequirement,
        requiredIndependence: 'provider-independent',
        coverage: TASK_DIFF_REVIEW_COVERAGE,
    };
    return parseTaskDiffReviewSubject({
        ...body,
        subjectDigest: sha256(canonicalJson(body)),
    });
}
/**
 * Candidate freshness is intentionally narrower than the complete review
 * record. A verdict follows the exact candidate tree and base-to-candidate
 * transition manifest; timestamps, sessions, check reruns, and other runtime
 * metadata cannot expire it.
 */
export function taskDiffReviewCandidateIdentityDigest(candidate) {
    const subject = parseTaskDiffReviewSubject(candidate);
    return sha256(canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-candidate-identity.v1',
        candidateTree: subject.candidateTree,
        patchDigest: subject.patchDigest,
    }));
}
/**
 * Determine whether one current candidate needs no review, exact reuse, a
 * transition-delta review, or a full review. This is a content-only decision:
 * it has no clock, session generation, or mutable-current pointer.
 */
export function deriveTaskDiffReviewCandidatePlan(input) {
    const current = parseTaskDiffReviewSubject(input.current);
    const candidateIdentityDigest = taskDiffReviewCandidateIdentityDigest(current);
    if (!current.reviewRequirement.required) {
        return deepFreeze({
            action: 'not-required',
            candidateIdentityDigest,
            basis: current.reviewRequirement.basis,
        });
    }
    if (input.predecessor === undefined) {
        return deepFreeze({
            action: 'review',
            candidateIdentityDigest,
            scope: createTaskDiffReviewScope({
                current,
                mode: 'full',
                reviewedPaths: current.changedPaths,
                predecessor: null,
            }),
        });
    }
    const previous = parseTaskDiffReviewSubject(input.predecessor.subject);
    assertCompatibleCandidatePredecessor(current, previous);
    const predecessor = normalizeCandidatePredecessor(input.predecessor);
    if (candidateIdentityDigest === taskDiffReviewCandidateIdentityDigest(previous)) {
        return deepFreeze({
            action: 'reuse',
            candidateIdentityDigest,
            predecessor,
        });
    }
    const changedPaths = transitionDeltaPaths(previous, current);
    const riskPaths = new Set([
        ...previous.reviewRequirement.riskPaths.map(({ path }) => path),
        ...current.reviewRequirement.riskPaths.map(({ path }) => path),
    ]);
    const mode = changedPaths.some((changedPath) => riskPaths.has(changedPath))
        ? 'full'
        : 'delta';
    return deepFreeze({
        action: 'review',
        candidateIdentityDigest,
        scope: createTaskDiffReviewScope({
            current,
            mode,
            reviewedPaths: mode === 'full' || changedPaths.length === 0
                ? current.changedPaths
                : changedPaths,
            predecessor,
        }),
    });
}
export function parseTaskDiffReviewScope(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'scopeDigest',
            'currentSubjectDigest',
            'candidateIdentityDigest',
            'mode',
            'reviewedPaths',
            'predecessor',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-scope.v1' ||
        (value.mode !== 'full' && value.mode !== 'delta') ||
        !Array.isArray(value.reviewedPaths) ||
        value.reviewedPaths.length === 0) {
        throw subjectInvalid();
    }
    const reviewedPaths = value.reviewedPaths
        .map((reviewedPath) => normalizeExactPath(reviewedPath))
        .sort();
    if (reviewedPaths.some((reviewedPath, index) => index > 0 && reviewedPath === reviewedPaths[index - 1])) {
        throw subjectInvalid();
    }
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-scope.v1',
        scopeDigest: normalizeDigest(value.scopeDigest),
        currentSubjectDigest: normalizeDigest(value.currentSubjectDigest),
        candidateIdentityDigest: normalizeDigest(value.candidateIdentityDigest),
        mode: value.mode,
        reviewedPaths,
        predecessor: value.predecessor === null
            ? null
            : parseTaskDiffReviewPredecessor(value.predecessor),
    };
    if (record.scopeDigest !== sha256(canonicalJson(scopeWithoutDigest(record)))) {
        throw subjectInvalid();
    }
    return deepFreeze(record);
}
export function parseTaskDiffReviewSubject(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'subjectDigest',
            'repositoryId',
            'changeId',
            'taskId',
            'baseCommit',
            'baseTree',
            'candidateTree',
            'changedPaths',
            'transitions',
            'patchDigest',
            'taskContractDigest',
            'requiredCheckPolicyDigest',
            'checkEvidenceDigest',
            'planningGenerationId',
            'planTargetDigest',
            'planReviewNodeId',
            'planningAssuranceDigest',
            'reviewPolicyDigest',
            'reviewRequirement',
            'requiredIndependence',
            'coverage',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-subject.v1' ||
        value.reviewPolicyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
        value.requiredIndependence !== 'provider-independent' ||
        canonicalJson(value.coverage) !== canonicalJson(TASK_DIFF_REVIEW_COVERAGE)) {
        throw subjectInvalid();
    }
    const transitions = normalizeTransitions(value.transitions);
    const changedPaths = transitions.map(({ path }) => path);
    if (canonicalJson(value.changedPaths) !== canonicalJson(changedPaths)) {
        throw subjectInvalid();
    }
    const reviewRequirement = parseReviewRequirement(value.reviewRequirement);
    const subject = {
        schemaVersion: 1,
        kind: 'task-diff-review-subject.v1',
        subjectDigest: normalizeDigest(value.subjectDigest),
        repositoryId: normalizeRepositoryId(value.repositoryId),
        changeId: normalizeChangeId(value.changeId),
        taskId: normalizeTaskId(value.taskId),
        baseCommit: normalizeObjectId(value.baseCommit),
        baseTree: normalizeObjectId(value.baseTree),
        candidateTree: normalizeObjectId(value.candidateTree),
        changedPaths,
        transitions,
        patchDigest: normalizeDigest(value.patchDigest),
        taskContractDigest: normalizeDigest(value.taskContractDigest),
        requiredCheckPolicyDigest: normalizeDigest(value.requiredCheckPolicyDigest),
        checkEvidenceDigest: normalizeDigest(value.checkEvidenceDigest),
        planningGenerationId: normalizeDigest(value.planningGenerationId),
        planTargetDigest: normalizeDigest(value.planTargetDigest),
        planReviewNodeId: normalizeDigest(value.planReviewNodeId),
        planningAssuranceDigest: normalizeDigest(value.planningAssuranceDigest),
        reviewPolicyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
        reviewRequirement,
        requiredIndependence: 'provider-independent',
        coverage: TASK_DIFF_REVIEW_COVERAGE,
    };
    if (subject.patchDigest !== patchDigest(transitions) ||
        subject.subjectDigest !==
            sha256(canonicalJson(subjectWithoutDigest(subject)))) {
        throw subjectInvalid();
    }
    return deepFreeze(subject);
}
function subjectWithoutDigest(subject) {
    const { subjectDigest: _subjectDigest, ...body } = subject;
    return body;
}
function createTaskDiffReviewScope(input) {
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-scope.v1',
        currentSubjectDigest: input.current.subjectDigest,
        candidateIdentityDigest: taskDiffReviewCandidateIdentityDigest(input.current),
        mode: input.mode,
        reviewedPaths: [...input.reviewedPaths].sort(),
        predecessor: input.predecessor,
    };
    return parseTaskDiffReviewScope({
        ...body,
        scopeDigest: sha256(canonicalJson(body)),
    });
}
function scopeWithoutDigest(scope) {
    const { scopeDigest: _scopeDigest, ...body } = scope;
    return body;
}
function normalizeCandidatePredecessor(candidate) {
    return deepFreeze({
        subjectDigest: parseTaskDiffReviewSubject(candidate.subject).subjectDigest,
        reviewRecordDigest: normalizeDigest(candidate.reviewRecordDigest),
        finalAssuranceCommitmentDigest: candidate.finalAssuranceCommitmentDigest === null
            ? null
            : normalizeDigest(candidate.finalAssuranceCommitmentDigest),
    });
}
function parseTaskDiffReviewPredecessor(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'subjectDigest',
            'reviewRecordDigest',
            'finalAssuranceCommitmentDigest',
        ])) {
        throw subjectInvalid();
    }
    return deepFreeze({
        subjectDigest: normalizeDigest(value.subjectDigest),
        reviewRecordDigest: normalizeDigest(value.reviewRecordDigest),
        finalAssuranceCommitmentDigest: value.finalAssuranceCommitmentDigest === null
            ? null
            : normalizeDigest(value.finalAssuranceCommitmentDigest),
    });
}
function assertCompatibleCandidatePredecessor(current, previous) {
    if (current.repositoryId !== previous.repositoryId ||
        current.changeId !== previous.changeId ||
        current.taskId !== previous.taskId ||
        current.baseCommit !== previous.baseCommit ||
        current.baseTree !== previous.baseTree) {
        throw subjectInvalid();
    }
}
function transitionDeltaPaths(previous, current) {
    const previousTransitions = new Map(previous.transitions.map((transition) => [transition.path, transition]));
    const currentTransitions = new Map(current.transitions.map((transition) => [transition.path, transition]));
    return Object.freeze([...new Set([...previousTransitions.keys(), ...currentTransitions.keys()])]
        .sort()
        .filter((candidatePath) => canonicalJson(previousTransitions.get(candidatePath) ?? null) !==
        canonicalJson(currentTransitions.get(candidatePath) ?? null)));
}
function patchDigest(transitions) {
    return sha256(canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-patch-manifest.v1',
        transitions,
    }));
}
function normalizeTransitions(value) {
    if (!Array.isArray(value) || value.length === 0)
        throw subjectInvalid();
    const transitions = value.map((transition) => {
        if (!isRecord(transition) ||
            !hasExactKeys(transition, ['path', 'before', 'after'])) {
            throw subjectInvalid();
        }
        const normalized = {
            path: normalizeExactPath(transition.path),
            before: normalizeTreeEntry(transition.before),
            after: normalizeTreeEntry(transition.after),
        };
        if ((normalized.before === null && normalized.after === null) ||
            (normalized.before !== null &&
                normalized.after !== null &&
                canonicalJson(normalized.before) === canonicalJson(normalized.after))) {
            throw subjectInvalid();
        }
        return normalized;
    });
    transitions.sort((left, right) => left.path.localeCompare(right.path));
    if (transitions.some((transition, index) => index > 0 && transition.path === transitions[index - 1].path)) {
        throw subjectInvalid();
    }
    return Object.freeze(transitions.map((transition) => Object.freeze({
        ...transition,
        before: transition.before === null ? null : Object.freeze(transition.before),
        after: transition.after === null ? null : Object.freeze(transition.after),
    })));
}
function normalizeTreeEntry(value) {
    if (value === null)
        return null;
    if (!isRecord(value) ||
        !hasExactKeys(value, ['mode', 'objectId']) ||
        !['100644', '100755', '120000', '160000'].includes(String(value.mode))) {
        throw subjectInvalid();
    }
    return {
        mode: value.mode,
        objectId: normalizeObjectId(value.objectId),
    };
}
function parseReviewRequirement(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['required', 'basis', 'riskPaths']) ||
        typeof value.required !== 'boolean' ||
        ![
            'explicit',
            'behavioral-strategy',
            'risk-role',
            'mechanical-evidence',
            'policy-not-triggered',
        ].includes(String(value.basis)) ||
        !Array.isArray(value.riskPaths)) {
        throw subjectInvalid();
    }
    const riskPaths = normalizeRolePaths(value.riskPaths);
    const basis = value.basis;
    if ((basis === 'risk-role'
        ? !value.required || riskPaths.length === 0
        : riskPaths.length !== 0) ||
        (['explicit', 'behavioral-strategy'].includes(basis) && !value.required) ||
        (['mechanical-evidence', 'policy-not-triggered'].includes(basis) &&
            value.required)) {
        throw subjectInvalid();
    }
    return freezeRequirement({
        required: value.required,
        basis,
        riskPaths,
    });
}
function normalizeRolePaths(value) {
    if (!Array.isArray(value))
        throw subjectInvalid();
    const paths = value.map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, ['path', 'role']) ||
            ![
                'control-plane',
                'grant',
                'lifecycle',
                'policy',
                'verification-infrastructure',
                'contract-surface',
                'ordinary',
                'unregistered',
            ].includes(String(entry.role))) {
            throw subjectInvalid();
        }
        return {
            path: normalizeExactPath(entry.path),
            role: entry.role,
        };
    });
    paths.sort((left, right) => left.path.localeCompare(right.path));
    if (paths.some((entry, index) => index > 0 && entry.path === paths[index - 1].path)) {
        throw subjectInvalid();
    }
    return Object.freeze(paths.map((entry) => Object.freeze(entry)));
}
function freezeRequirement(value) {
    return Object.freeze({
        ...value,
        riskPaths: Object.freeze(value.riskPaths.map((entry) => Object.freeze({ ...entry }))),
    });
}
function normalizeRepositoryId(value) {
    if (typeof value !== 'string' ||
        !REPOSITORY_ID.test(value) ||
        Buffer.byteLength(value) > MAX_REPOSITORY_ID_BYTES) {
        throw subjectInvalid();
    }
    return value;
}
function normalizeChangeId(value) {
    if (typeof value !== 'string' || !CHANGE_ID.test(value)) {
        throw subjectInvalid();
    }
    return value;
}
function normalizeTaskId(value) {
    if (typeof value !== 'string' || !TASK_ID.test(value)) {
        throw subjectInvalid();
    }
    return value;
}
function normalizeExactPath(value) {
    if (typeof value !== 'string')
        throw subjectInvalid();
    let normalized;
    try {
        normalized = normalizePolicyPath(value);
    }
    catch {
        throw subjectInvalid();
    }
    if (normalized !== value || normalized.endsWith('/**')) {
        throw subjectInvalid();
    }
    return normalized;
}
function normalizeDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw subjectInvalid();
    }
    return value;
}
function normalizeObjectId(value) {
    if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
        throw subjectInvalid();
    }
    return value;
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function subjectInvalid() {
    return workflowError('TASK_DIFF_REVIEW_SUBJECT_INVALID', 'TaskDiffReview subject is malformed or not canonically bound.', ExitCode.staleState);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
