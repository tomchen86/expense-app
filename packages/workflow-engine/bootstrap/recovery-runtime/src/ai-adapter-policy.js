import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from './foundation/errors/errors.js';
import { listBuiltInProviders, } from './modules/provider-orchestration/provider-registry.js';
export const REQUIRED_AI_ADAPTER_CONTROLS = [
    'separate-security-principal',
    'kernel-enforced-write-boundary',
    'git-common-directory-isolation',
    'network-egress-control',
    'secret-isolation',
    'subprocess-tree-confinement',
    'resource-limits',
    'immutable-runtime',
];
/**
 * The code-owned positive maxima for the diagnostic adapter policy. Repository
 * policy may lower these but never raise them.
 */
export const MAX_AI_ADAPTER_LIMITS = Object.freeze({
    timeoutMs: 3_600_000,
    aggregateOutputBytes: 1_048_576,
    maxConcurrent: 2,
});
export const DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING = Object.freeze({
    maxAttempts: 4,
    maxCumulativeRuntimeMs: 4 * 60 * 60 * 1_000,
    maxProviderCostMicros: 40_000_000,
    maxProviderTokens: 2_000_000,
    maxSameFailureFingerprint: 2,
    maxRepairAttempts: 2,
    deadlineMs: 14 * 24 * 60 * 60 * 1_000,
    providerLimits: Object.freeze({
        claude: 4,
        codex: 4,
    }),
    reservations: Object.freeze({
        claude: Object.freeze({
            providerCostMicros: 10_000_000,
            providerTokens: 500_000,
        }),
        codex: Object.freeze({
            providerCostMicros: 10_000_000,
            providerTokens: 500_000,
        }),
    }),
});
export function loadAiAdapterPolicy(repositoryRoot) {
    return parseAiAdapterPolicyDocument(readPlainPolicyFile(repositoryRoot));
}
/**
 * Validate one exact policy document while preserving its original bytes as the
 * digest authority. Durable per-Attempt snapshots use this same parser so a
 * private snapshot cannot silently admit a different policy grammar from the
 * tracked repository file.
 */
export function parseAiAdapterPolicyDocument(content) {
    const value = parsePolicyJson(content);
    if (!isAiAdapterPolicy(value)) {
        throw invalidPolicy();
    }
    return {
        policy: value,
        digest: crypto.createHash('sha256').update(content).digest('hex'),
        document: content,
    };
}
/**
 * Historical v1 execution-policy snapshots may contain the former v3 policy
 * document. This parser exists only for that durable read path; live policy
 * loading and every new snapshot remain strict v4.
 */
export function parseLegacyAiAdapterPolicyDocument(content) {
    const value = parsePolicyJson(content);
    if (!isLegacyAiAdapterPolicy(value)) {
        throw invalidPolicy();
    }
    return {
        policy: value,
        digest: crypto.createHash('sha256').update(content).digest('hex'),
        document: content,
    };
}
function parsePolicyJson(content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1_048_576) {
        throw invalidPolicy();
    }
    try {
        return JSON.parse(content);
    }
    catch {
        throw invalidPolicy();
    }
}
function readPlainPolicyFile(repositoryRoot) {
    const workflowDirectory = path.join(repositoryRoot, 'workflow');
    const policyPath = path.join(workflowDirectory, 'ai-adapter-policy.json');
    const directoryStats = fs.lstatSync(workflowDirectory, {
        throwIfNoEntry: false,
    });
    const policyStats = fs.lstatSync(policyPath, { throwIfNoEntry: false });
    if (!directoryStats?.isDirectory() ||
        directoryStats.isSymbolicLink() ||
        !policyStats?.isFile() ||
        policyStats.isSymbolicLink()) {
        throw invalidPolicy();
    }
    const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
    let descriptor;
    try {
        descriptor = fs.openSync(policyPath, fs.constants.O_RDONLY | noFollow);
        if (!fs.fstatSync(descriptor).isFile()) {
            throw invalidPolicy();
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    catch (error) {
        if (isPolicyError(error)) {
            throw error;
        }
        throw invalidPolicy();
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
function isAiAdapterPolicy(value) {
    if (!isRecord(value)) {
        return false;
    }
    const expectedKeys = [
        'launchPolicy',
        'limits',
        'mode',
        'providers',
        'requiredControls',
        'retryAccounting',
        'schemaVersion',
    ];
    const actualKeys = Object.keys(value).sort();
    return (JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
        value.schemaVersion === 4 &&
        value.mode === 'managed-read-only' &&
        value.launchPolicy === 'lifecycle-only' &&
        Array.isArray(value.requiredControls) &&
        JSON.stringify(value.requiredControls) ===
            JSON.stringify(REQUIRED_AI_ADAPTER_CONTROLS) &&
        isProvidersPolicy(value.providers) &&
        isLimitsPolicy(value.limits) &&
        isRetryAccounting(value.retryAccounting));
}
function isLegacyAiAdapterPolicy(value) {
    if (!isRecord(value))
        return false;
    const expectedKeys = [
        'launchPolicy',
        'limits',
        'mode',
        'providers',
        'requiredControls',
        'schemaVersion',
    ];
    return (JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(expectedKeys) &&
        value.schemaVersion === 3 &&
        value.mode === 'managed-read-only' &&
        value.launchPolicy === 'lifecycle-only' &&
        Array.isArray(value.requiredControls) &&
        JSON.stringify(value.requiredControls) ===
            JSON.stringify(REQUIRED_AI_ADAPTER_CONTROLS) &&
        isProvidersPolicy(value.providers) &&
        isLimitsPolicy(value.limits));
}
/**
 * Repository policy may only enable/disable the fixed built-in provider IDs. It
 * must supply exactly those IDs, each carrying only an `enabled` flag; any extra
 * ID, missing ID, or execution-authority field (command, path, module, prompt,
 * parser) fails closed.
 */
function isProvidersPolicy(value) {
    if (!isRecord(value)) {
        return false;
    }
    const expectedIds = listBuiltInProviders()
        .map((provider) => provider.id)
        .sort();
    const actualIds = Object.keys(value).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
        return false;
    }
    return Object.values(value).every((entry) => {
        return (isRecord(entry) &&
            Object.keys(entry).length === 1 &&
            typeof entry.enabled === 'boolean');
    });
}
/**
 * Repository policy may only lower the positive time/output/concurrency bounds.
 * Each limit must be a positive integer within the code-owned maxima.
 */
function isLimitsPolicy(value) {
    if (!isRecord(value)) {
        return false;
    }
    const expectedKeys = ['aggregateOutputBytes', 'maxConcurrent', 'timeoutMs'];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
        return false;
    }
    return (isBoundedPositiveInteger(value.timeoutMs, MAX_AI_ADAPTER_LIMITS.timeoutMs) &&
        isBoundedPositiveInteger(value.aggregateOutputBytes, MAX_AI_ADAPTER_LIMITS.aggregateOutputBytes) &&
        isBoundedPositiveInteger(value.maxConcurrent, MAX_AI_ADAPTER_LIMITS.maxConcurrent));
}
function isRetryAccounting(value) {
    if (!isRecord(value) ||
        JSON.stringify(Object.keys(value).sort()) !==
            JSON.stringify([
                'deadlineMs',
                'maxAttempts',
                'maxCumulativeRuntimeMs',
                'maxProviderCostMicros',
                'maxProviderTokens',
                'maxRepairAttempts',
                'maxSameFailureFingerprint',
                'providerLimits',
                'reservations',
            ].sort()) ||
        !isBoundedPositiveInteger(value.maxAttempts, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxAttempts) ||
        !isBoundedPositiveInteger(value.maxCumulativeRuntimeMs, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxCumulativeRuntimeMs) ||
        !isBoundedPositiveInteger(value.maxProviderCostMicros, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxProviderCostMicros) ||
        !isBoundedPositiveInteger(value.maxProviderTokens, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxProviderTokens) ||
        !isBoundedPositiveInteger(value.maxSameFailureFingerprint, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxSameFailureFingerprint) ||
        !isBoundedPositiveInteger(value.maxRepairAttempts, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxRepairAttempts) ||
        !isBoundedPositiveInteger(value.deadlineMs, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.deadlineMs) ||
        value.maxRepairAttempts > value.maxAttempts ||
        !isProviderLimits(value.providerLimits, value.maxAttempts) ||
        !isProviderReservations(value.reservations)) {
        return false;
    }
    return true;
}
function isProviderLimits(value, maxAttempts) {
    if (!hasExactProviderIds(value))
        return false;
    return Object.values(value).every((limit) => isBoundedPositiveInteger(limit, Math.min(4, maxAttempts)));
}
function isProviderReservations(value) {
    if (!hasExactProviderIds(value))
        return false;
    return Object.values(value).every((reservation) => isRecord(reservation) &&
        JSON.stringify(Object.keys(reservation).sort()) ===
            JSON.stringify(['providerCostMicros', 'providerTokens']) &&
        isBoundedPositiveInteger(reservation.providerCostMicros, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.reservations.claude
            .providerCostMicros) &&
        isBoundedPositiveInteger(reservation.providerTokens, DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.reservations.claude.providerTokens));
}
function hasExactProviderIds(value) {
    if (!isRecord(value))
        return false;
    const expectedIds = listBuiltInProviders()
        .map((provider) => provider.id)
        .sort();
    return (JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedIds));
}
function isBoundedPositiveInteger(value, maximum) {
    return (typeof value === 'number' &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= maximum);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalidPolicy() {
    return workflowError('AI_ADAPTER_POLICY_INVALID', 'AI adapter evaluation policy is missing, unsafe, or invalid.', ExitCode.guard);
}
function isPolicyError(error) {
    return (error instanceof Error &&
        'code' in error &&
        error.code === 'AI_ADAPTER_POLICY_INVALID');
}
