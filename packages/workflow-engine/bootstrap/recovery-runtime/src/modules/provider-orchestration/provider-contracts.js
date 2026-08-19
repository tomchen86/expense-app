import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError, } from '../../foundation/errors/errors.js';
import { isProviderId, requireProviderCapability, } from './provider-registry.js';
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUEST_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;
export const PROPOSE_POLICY_DIGEST = sha256(canonicalJson({ schema: 'workflow-propose-policy.v2' }));
export const PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST = sha256(canonicalJson({ schema: 'workflow-propose-exemption-session-store.v1' }));
/**
 * The code-owned positive maxima for a single provider invocation. Repository
 * policy may lower these but never raise them, and a request may only bind
 * limits within these bounds.
 */
export const MAX_PROVIDER_LIMITS = Object.freeze({
    timeoutMs: 3_600_000,
    aggregateOutputBytes: 1_048_576,
});
const ROLE_PURPOSE = {
    'blind-surveyor': 'survey',
    'plan-reviewer': 'plan-review',
    'task-diff-reviewer': 'task-diff-review',
    'task-implementer': 'task-implementation',
};
const REQUEST_INPUT_KEYS = [
    'invocationId',
    'nonce',
    'purpose',
    'providerId',
    'roleAssignment',
    'capabilityProfile',
    'repositoryId',
    'baseCommit',
    'baseTree',
    'targetDigest',
    'inputManifestDigest',
    'authorizationNodeId',
    'writeAllowedPaths',
    'outputSchema',
    'evaluatorVersion',
    'policyDigest',
    'limits',
];
const ROLE_ASSIGNMENT_KEYS = [
    'role',
    'providerId',
    'sessionId',
    'targetDigest',
    'requiredIndependence',
    'achievedIndependence',
];
const GRANTED_ROLE_ASSIGNMENT_KEYS = [
    'role',
    'providerId',
    'sessionId',
    'targetDigest',
    'requiredIndependence',
    'achievedIndependence',
    'providerIndependent',
    'sessionIndependent',
    'engineSpawned',
    'orchestration',
    'grantId',
    'degradedForm',
    'authorizedEffect',
    'author',
    'participant',
    'callableProviderIds',
    'directHumanReviewAttestationDigest',
];
const OUTPUT_SCHEMA_KEYS = ['id', 'version', 'digest'];
const LIMITS_KEYS = ['timeoutMs', 'aggregateOutputBytes'];
const REQUEST_BINDING_KEYS = [
    'requestDigest',
    'invocationId',
    'nonce',
    'purpose',
    'providerId',
    'roleAssignmentDigest',
    'capabilityProfile',
    'repositoryId',
    'baseCommit',
    'baseTree',
    'targetDigest',
    'inputManifestDigest',
    'authorizationNodeId',
    'outputSchema',
    'evaluatorVersion',
    'policyDigest',
    'limits',
];
const RESULT_KEYS = [
    'schemaVersion',
    ...REQUEST_BINDING_KEYS,
    'observedTouchedPaths',
    'output',
];
export function createProviderInvocationRequest(input) {
    // Reject unknown or missing input keys before any field is trusted.
    if (!isRecord(input) || !hasExactKeys(input, REQUEST_INPUT_KEYS)) {
        throw requestInvalid();
    }
    if (!isNonEmptyString(input.invocationId) ||
        !isNonce(input.nonce) ||
        !isPurpose(input.purpose) ||
        !isProviderId(input.providerId) ||
        input.capabilityProfile !== 'repository-read-only' ||
        !isNonEmptyString(input.repositoryId) ||
        !GIT_OBJECT_ID.test(input.baseCommit) ||
        !GIT_OBJECT_ID.test(input.baseTree) ||
        !HEX64.test(input.targetDigest) ||
        !HEX64.test(input.inputManifestDigest) ||
        !HEX64.test(input.authorizationNodeId) ||
        !HEX64.test(input.policyDigest) ||
        !isNonEmptyString(input.evaluatorVersion) ||
        !isOutputSchema(input.outputSchema) ||
        !isProviderRoleAssignment(input.roleAssignment) ||
        !isWriteAllowedPaths(input.writeAllowedPaths) ||
        !isBoundedLimits(input.limits)) {
        throw requestInvalid();
    }
    // Read-only requests must have no writable paths.
    if (input.writeAllowedPaths.length !== 0) {
        throw requestInvalid();
    }
    // The assignment must select the same provider, target, and role the request
    // binds. Each role maps to one code-owned capability purpose.
    if (input.providerId !== input.roleAssignment.providerId ||
        input.targetDigest !== input.roleAssignment.targetDigest ||
        ROLE_PURPOSE[input.roleAssignment.role] !== input.purpose) {
        throw requestInvalid();
    }
    // The provider must be registered and declare the requested capability.
    try {
        requireProviderCapability(input.providerId, input.purpose, input.capabilityProfile);
    }
    catch {
        throw requestInvalid();
    }
    const roleAssignment = deepFreeze(structuredClone(input.roleAssignment));
    const outputSchema = deepFreeze(structuredClone(input.outputSchema));
    const limits = Object.freeze({
        timeoutMs: input.limits.timeoutMs,
        aggregateOutputBytes: input.limits.aggregateOutputBytes,
    });
    const roleAssignmentDigest = sha256(canonicalJson(roleAssignment));
    const binding = {
        schemaVersion: REQUEST_SCHEMA_VERSION,
        invocationId: input.invocationId,
        nonce: input.nonce,
        purpose: input.purpose,
        providerId: input.providerId,
        roleAssignmentDigest,
        capabilityProfile: input.capabilityProfile,
        repositoryId: input.repositoryId,
        baseCommit: input.baseCommit,
        baseTree: input.baseTree,
        targetDigest: input.targetDigest,
        inputManifestDigest: input.inputManifestDigest,
        authorizationNodeId: input.authorizationNodeId,
        writeAllowedPaths: [],
        outputSchema,
        evaluatorVersion: input.evaluatorVersion,
        policyDigest: input.policyDigest,
        limits,
    };
    const requestDigest = sha256(canonicalJson(binding));
    const request = {
        schemaVersion: REQUEST_SCHEMA_VERSION,
        invocationId: input.invocationId,
        nonce: input.nonce,
        purpose: input.purpose,
        providerId: input.providerId,
        roleAssignment,
        roleAssignmentDigest,
        capabilityProfile: input.capabilityProfile,
        repositoryId: input.repositoryId,
        baseCommit: input.baseCommit,
        baseTree: input.baseTree,
        targetDigest: input.targetDigest,
        inputManifestDigest: input.inputManifestDigest,
        authorizationNodeId: input.authorizationNodeId,
        writeAllowedPaths: [],
        outputSchema,
        evaluatorVersion: input.evaluatorVersion,
        policyDigest: input.policyDigest,
        limits,
        requestDigest,
    };
    return deepFreeze(request);
}
export function recreateProviderInvocationRequest(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            ...REQUEST_INPUT_KEYS,
            'roleAssignmentDigest',
            'requestDigest',
        ])) {
        throw requestInvalid();
    }
    const request = createProviderInvocationRequest({
        invocationId: value.invocationId,
        nonce: value.nonce,
        purpose: value.purpose,
        providerId: value.providerId,
        roleAssignment: value.roleAssignment,
        capabilityProfile: value.capabilityProfile,
        repositoryId: value.repositoryId,
        baseCommit: value.baseCommit,
        baseTree: value.baseTree,
        targetDigest: value.targetDigest,
        inputManifestDigest: value.inputManifestDigest,
        authorizationNodeId: value.authorizationNodeId,
        writeAllowedPaths: value.writeAllowedPaths,
        outputSchema: value.outputSchema,
        evaluatorVersion: value.evaluatorVersion,
        policyDigest: value.policyDigest,
        limits: value.limits,
    });
    if (canonicalJson(request) !== canonicalJson(value)) {
        throw requestInvalid();
    }
    return request;
}
/**
 * Evaluate a bounded provider process against its request. A process failure,
 * malformed or ambiguous result, unbound field, observed mutation, excess
 * output, or invalid output never produces successful evidence; each raises a
 * typed WorkflowError instead.
 */
export function evaluateProviderProcess(request, outcome, outputValidator) {
    // 1. Process-level failure — timeout (flag or elapsed), signal, spawn error,
    //    or non-zero exit — is never a success.
    assertProviderProcessSucceeded(outcome, request.limits.timeoutMs);
    // 2. Exactly one JSON value on stdout.
    const parsed = parseSingleJson(outcome.stdout);
    if (parsed.ok === false) {
        throw resultInvalid();
    }
    const result = parsed.value;
    // 3. Exact result shape: every expected field present, no extra field, valid
    //    scalar/nested structure. This runs before drift/binding classification.
    if (!isRecord(result) ||
        !hasExactKeys(result, RESULT_KEYS) ||
        result.schemaVersion !== RESULT_SCHEMA_VERSION ||
        !isStringArray(result.observedTouchedPaths) ||
        !isOutputSchema(result.outputSchema) ||
        !isBoundedLimits(result.limits)) {
        throw resultInvalid();
    }
    const observedTouchedPaths = result.observedTouchedPaths;
    // 4. Aggregate UTF-8 bytes across stdout + stderr + normalized semantic
    //    output.
    let normalizedOutput;
    try {
        normalizedOutput = canonicalJson(result.output);
    }
    catch {
        throw resultInvalid();
    }
    const aggregateBytes = Buffer.byteLength(outcome.stdout, 'utf8') +
        Buffer.byteLength(outcome.stderr, 'utf8') +
        Buffer.byteLength(normalizedOutput, 'utf8');
    if (aggregateBytes > request.limits.aggregateOutputBytes) {
        throw outputLimitExceeded();
    }
    // 5. Every request binding must match exactly.
    for (const key of REQUEST_BINDING_KEYS) {
        if (!bindingMatches(result[key], request[key])) {
            throw resultUnbound(key);
        }
    }
    // 6. Read-only results must observe no touched path.
    if (observedTouchedPaths.length !== 0) {
        throw readOnlyDrift();
    }
    // 7. The validator must be bound to the same output schema, and the typed
    //    output — canonically cloned and deeply frozen before the validator sees
    //    it — must satisfy it. A throwing validator is a rejection, not a crash.
    if (outputValidator.id !== request.outputSchema.id ||
        outputValidator.version !== request.outputSchema.version ||
        outputValidator.digest !== request.outputSchema.digest) {
        throw outputInvalid();
    }
    const output = deepFreeze(structuredClone(result.output));
    let valid;
    try {
        valid = outputValidator.validate(output);
    }
    catch {
        throw outputInvalid();
    }
    // Only a literal `true` is acceptance; a truthy non-boolean is a rejection.
    if (valid !== true) {
        throw outputInvalid();
    }
    const outputDigest = sha256(canonicalJson({
        id: request.outputSchema.id,
        version: request.outputSchema.version,
        output,
    }));
    return Object.freeze({
        requestDigest: request.requestDigest,
        invocationId: request.invocationId,
        purpose: request.purpose,
        providerId: request.providerId,
        output,
        outputDigest,
        runtimeObservation: null,
    });
}
function bindingMatches(actual, expected) {
    if (typeof expected === 'object' && expected !== null) {
        let actualCanonical;
        let expectedCanonical;
        try {
            actualCanonical = canonicalJson(actual);
            expectedCanonical = canonicalJson(expected);
        }
        catch {
            return false;
        }
        return actualCanonical === expectedCanonical;
    }
    return actual === expected;
}
function parseSingleJson(text) {
    try {
        // JSON.parse rejects trailing non-whitespace, so a second concatenated
        // value or truncated object fails here.
        return { ok: true, value: JSON.parse(text) };
    }
    catch {
        return { ok: false };
    }
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isNonce(value) {
    return typeof value === 'string' && value.length >= 16;
}
function isPurpose(value) {
    return (value === 'survey' ||
        value === 'plan-review' ||
        value === 'task-diff-review' ||
        value === 'task-implementation');
}
function isOutputSchema(value) {
    return (isRecord(value) &&
        hasExactKeys(value, OUTPUT_SCHEMA_KEYS) &&
        isNonEmptyString(value.id) &&
        isPositiveInteger(value.version) &&
        typeof value.digest === 'string' &&
        HEX64.test(value.digest));
}
export function isProviderRoleAssignment(value) {
    // An ordinary role assignment used by an invocation request is valid only
    // when both independence fields are provider-independent; a forged assignment
    // that weakens either field is rejected.
    const ordinary = isRecord(value) &&
        hasExactKeys(value, ROLE_ASSIGNMENT_KEYS) &&
        (value.role === 'blind-surveyor' ||
            value.role === 'plan-reviewer' ||
            value.role === 'task-diff-reviewer' ||
            value.role === 'task-implementer') &&
        isProviderId(value.providerId) &&
        isNonEmptyString(value.sessionId) &&
        typeof value.targetDigest === 'string' &&
        HEX64.test(value.targetDigest) &&
        value.requiredIndependence === 'provider-independent' &&
        value.achievedIndependence === 'provider-independent';
    if (ordinary) {
        return true;
    }
    return isGrantedSameProviderAssignment(value);
}
function isGrantedSameProviderAssignment(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, GRANTED_ROLE_ASSIGNMENT_KEYS) ||
        (value.role !== 'blind-surveyor' &&
            value.role !== 'plan-reviewer' &&
            value.role !== 'task-diff-reviewer' &&
            value.role !== 'task-implementer') ||
        !isProviderId(value.providerId) ||
        !isNonEmptyString(value.sessionId) ||
        typeof value.targetDigest !== 'string' ||
        !HEX64.test(value.targetDigest) ||
        value.requiredIndependence !== 'provider-independent' ||
        value.achievedIndependence !== 'session-independent' ||
        value.providerIndependent !== false ||
        value.sessionIndependent !== true ||
        value.engineSpawned !== true ||
        value.orchestration !== 'engine-spawned-provider' ||
        typeof value.grantId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.grantId) ||
        value.degradedForm !== 'same-provider-fresh-session' ||
        value.authorizedEffect !== 'role-independence-degradation-only' ||
        !isRecordedParticipant(value.author) ||
        !isRecordedParticipant(value.participant) ||
        !Array.isArray(value.callableProviderIds) ||
        value.callableProviderIds.length !== 1 ||
        value.callableProviderIds[0] !== value.providerId ||
        value.directHumanReviewAttestationDigest !== null) {
        return false;
    }
    return (value.author.providerId === value.providerId &&
        typeof value.author.sessionId === 'string' &&
        value.author.sessionId !== value.sessionId &&
        value.participant.providerId === value.providerId &&
        value.participant.sessionId === value.sessionId &&
        value.participant.engineSpawned === true);
}
function isRecordedParticipant(value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'providerId',
            'sessionId',
            'principalId',
            'identityAssurance',
            'engineSpawned',
        ]) &&
        (value.providerId === null || isProviderId(value.providerId)) &&
        (value.sessionId === null || isNonEmptyString(value.sessionId)) &&
        (value.principalId === null || isNonEmptyString(value.principalId)) &&
        [
            'self-declared',
            'runtime-hint',
            'adapter-assigned',
            'maintainer-signed',
        ].includes(String(value.identityAssurance)) &&
        typeof value.engineSpawned === 'boolean');
}
function isWriteAllowedPaths(value) {
    return isStringArray(value);
}
function isStringArray(value) {
    return (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}
function isBoundedLimits(value) {
    return (isRecord(value) &&
        hasExactKeys(value, LIMITS_KEYS) &&
        isPositiveInteger(value.timeoutMs) &&
        value.timeoutMs <= MAX_PROVIDER_LIMITS.timeoutMs &&
        isPositiveInteger(value.aggregateOutputBytes) &&
        value.aggregateOutputBytes <= MAX_PROVIDER_LIMITS.aggregateOutputBytes);
}
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
        Object.freeze(value);
    }
    return value;
}
function requestInvalid() {
    return workflowError('PROVIDER_REQUEST_INVALID', 'Provider invocation request is malformed or exceeds bounded limits.', ExitCode.usage);
}
function resultInvalid() {
    return workflowError('PROVIDER_RESULT_INVALID', 'Provider result is malformed, ambiguous, or has an unexpected shape.', ExitCode.verification);
}
function resultUnbound(field) {
    return workflowError('PROVIDER_RESULT_UNBOUND', `Provider result field "${field}" is not bound to the invocation request.`, ExitCode.verification);
}
export function assertProviderProcessSucceeded(outcome, timeoutMs) {
    if (outcome.timedOut || outcome.elapsedMs > timeoutMs) {
        throw workflowError('PROVIDER_TIMEOUT', 'Provider process exceeded its bound execution timeout.', ExitCode.verification);
    }
    if (outcome.spawnErrorCode !== null) {
        if ([
            'EAI_AGAIN',
            'ECONNABORTED',
            'ECONNREFUSED',
            'ECONNRESET',
            'ENETDOWN',
            'ENETUNREACH',
            'ETIMEDOUT',
        ].includes(outcome.spawnErrorCode)) {
            throw workflowError('NETWORK_TRANSIENT', 'Provider process could not start because of a transient network failure.', ExitCode.verification);
        }
        if (outcome.spawnErrorCode === 'ENOENT') {
            throw workflowError('PROVIDER_TOOL_UNAVAILABLE', 'The configured provider executable is unavailable.', ExitCode.verification);
        }
        throw workflowError('PROVIDER_PROCESS_CRASH', 'Provider process failed during process creation.', ExitCode.verification);
    }
    if (outcome.signal !== null) {
        throw workflowError('PROVIDER_PROCESS_CRASH', 'Provider process terminated from an operating-system signal.', ExitCode.verification);
    }
    if (outcome.exitCode !== 0 &&
        /(?:\b429\b|rate[\s_-]*limit|too many requests)/iu.test(`${outcome.stdout}\n${outcome.stderr}`)) {
        const retryAfterMs = extractProviderRetryAfterMs(`${outcome.stdout}\n${outcome.stderr}`);
        throw workflowError('PROVIDER_RATE_LIMIT', 'Provider process reported a rate limit.', ExitCode.verification, retryAfterMs === null ? {} : { details: { retryAfterMs } });
    }
    if (outcome.exitCode !== 0) {
        throw workflowError('PROVIDER_PROCESS_NONZERO', 'Provider process exited with a non-zero status.', ExitCode.verification);
    }
}
/**
 * Preserve only a bounded numeric Retry-After hint. HTTP dates are deliberately
 * ignored because the provider process outcome has no trusted response clock.
 */
function extractProviderRetryAfterMs(output) {
    const millisecondMatch = output.match(/(?:retry[-_ ]after[-_ ]ms|retry_after_ms)\s*[:=]\s*(\d{1,9})/iu);
    const secondMatch = output.match(/(?:retry[-_ ]after|retry_after)\s*[:=]\s*(\d{1,7})(?:\s*(?:s|sec|seconds?))?/iu);
    const value = millisecondMatch
        ? Number(millisecondMatch[1])
        : secondMatch
            ? Number(secondMatch[1]) * 1_000
            : null;
    return value !== null && Number.isSafeInteger(value) && value <= 86_400_000
        ? value
        : null;
}
function outputLimitExceeded() {
    return workflowError('PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'Provider aggregate output exceeded the bounded byte limit.', ExitCode.verification);
}
function readOnlyDrift() {
    return workflowError('PROVIDER_READ_ONLY_DRIFT', 'Read-only provider result observed a repository mutation.', ExitCode.verification);
}
function outputInvalid() {
    return workflowError('PROVIDER_OUTPUT_INVALID', 'Provider output failed its bound output schema validation.', ExitCode.verification);
}
