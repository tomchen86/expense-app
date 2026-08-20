import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { canonicalExecutionBudgetGrantRequest, inspectExecutionBudgetGrantAuthorization, parseExecutionBudgetGrantRequest, } from "../../modules/authority/execution-governance.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { MAX_PROVIDER_LIMITS, } from "../../modules/provider-orchestration/provider-contracts.js";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * Bind a provider timeout above the repository policy ceiling to the exact
 * one-shot execution-budget request and its durable consume receipt. The base
 * policy remains the request's policyDigest authority; this object is only the
 * narrow per-Attempt exception.
 */
export function createProviderExecutionBudgetAuthority(request, basePolicy, input) {
    const core = validateAuthorityCore(request, basePolicy, input);
    return deepFreeze({
        ...core,
        authorityDigest: digestCanonical(core),
    });
}
export function validateProviderExecutionBudgetAuthority(request, basePolicy, value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'authorityDigest',
            'grantId',
            'grantRequest',
            'kind',
            'receipt',
            'schemaVersion',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-execution-budget-authority' ||
        typeof value.authorityDigest !== 'string' ||
        !SHA256.test(value.authorityDigest)) {
        throw invalidAuthority();
    }
    const core = validateAuthorityCore(request, basePolicy, {
        grantId: value.grantId,
        grantRequest: value.grantRequest,
        receipt: value.receipt,
    });
    if (value.authorityDigest !== digestCanonical(core)) {
        throw invalidAuthority();
    }
    return deepFreeze({ ...core, authorityDigest: value.authorityDigest });
}
export function assertDurableProviderExecutionBudgetAuthority(investigationsRoot, authority) {
    if (path.basename(investigationsRoot) !== 'investigations') {
        throw invalidAuthority();
    }
    try {
        const stored = inspectExecutionBudgetGrantAuthorization(path.dirname(investigationsRoot), authority.grantId);
        const requestDigest = digestText(canonicalExecutionBudgetGrantRequest(authority.grantRequest));
        const exactReceipt = stored.receipts.find(({ receiptId }) => receiptId === authority.receipt.receiptId);
        if (stored.payload.grantId !== authority.grantId ||
            stored.payload.requestDigest !== requestDigest ||
            stored.payload.maxUses !== 1 ||
            stored.state !== 'consumed' ||
            stored.remainingUses !== 0 ||
            stored.receipts.length !== 1 ||
            stored.payload.workflowId !== authority.grantRequest.workflowId ||
            stored.payload.epoch !== authority.grantRequest.epoch ||
            stored.payload.jobId !== authority.grantRequest.jobId ||
            canonicalJson(stored.payload.mandateBinding) !==
                canonicalJson(authority.grantRequest.mandateBinding) ||
            canonicalJson(stored.payload.allowedChanges) !==
                canonicalJson(authority.grantRequest.requestedChanges) ||
            exactReceipt === undefined ||
            canonicalJson(exactReceipt) !== canonicalJson(authority.receipt)) {
            throw invalidAuthority();
        }
    }
    catch {
        throw invalidAuthority();
    }
}
function validateAuthorityCore(request, basePolicy, input) {
    if (request.policyDigest !== basePolicy.digest ||
        request.limits.timeoutMs <= basePolicy.policy.limits.timeoutMs ||
        request.limits.timeoutMs > MAX_PROVIDER_LIMITS.timeoutMs ||
        typeof input.grantId !== 'string' ||
        !UUID_V4.test(input.grantId)) {
        throw invalidAuthority();
    }
    let grantRequest;
    try {
        grantRequest = parseExecutionBudgetGrantRequest(canonicalExecutionBudgetGrantRequest(input.grantRequest));
    }
    catch {
        throw invalidAuthority();
    }
    const receipt = validateReceipt(input.receipt);
    const requestDigest = digestText(canonicalExecutionBudgetGrantRequest(grantRequest));
    const timeoutChange = grantRequest.requestedChanges.find(({ path }) => path === '/timeoutMs');
    const ceilingChange = grantRequest.requestedChanges.find(({ path }) => path === '/providerPolicy/limits/timeoutMs');
    if (receipt.grantId !== input.grantId ||
        receipt.requestDigest !== requestDigest ||
        grantRequest.expiresAfterAttempts !== 1 ||
        receipt.workflowId !== grantRequest.workflowId ||
        receipt.epoch !== grantRequest.epoch ||
        receipt.jobId !== grantRequest.jobId ||
        receipt.attemptId !== `attempt-legacy-${request.invocationId}` ||
        receipt.useNumber !== 1 ||
        receipt.remainingUses !== 0 ||
        grantRequest.mandateBinding === undefined ||
        canonicalJson(receipt.mandateBinding) !==
            canonicalJson(grantRequest.mandateBinding) ||
        timeoutChange === undefined ||
        ceilingChange === undefined ||
        canonicalJson(timeoutChange) !==
            canonicalJson({
                path: '/timeoutMs',
                from: timeoutChange.from,
                to: request.limits.timeoutMs,
            }) ||
        !Number.isSafeInteger(timeoutChange.from) ||
        timeoutChange.from >= request.limits.timeoutMs ||
        canonicalJson(ceilingChange) !==
            canonicalJson({
                path: '/providerPolicy/limits/timeoutMs',
                from: basePolicy.policy.limits.timeoutMs,
                to: request.limits.timeoutMs,
            })) {
        throw invalidAuthority();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'provider-execution-budget-authority',
        grantId: input.grantId,
        grantRequest,
        receipt,
    });
}
function validateReceipt(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'attemptId',
            'consumedAt',
            'epoch',
            'grantId',
            'jobId',
            'kind',
            'mandateBinding',
            'receiptId',
            'remainingUses',
            'requestDigest',
            'schemaVersion',
            'useNumber',
            'workflowId',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'execution-budget-consume-receipt' ||
        typeof value.receiptId !== 'string' ||
        !SHA256.test(value.receiptId) ||
        typeof value.requestDigest !== 'string' ||
        !SHA256.test(value.requestDigest) ||
        typeof value.grantId !== 'string' ||
        !UUID_V4.test(value.grantId) ||
        typeof value.workflowId !== 'string' ||
        typeof value.jobId !== 'string' ||
        typeof value.attemptId !== 'string' ||
        !Number.isSafeInteger(value.epoch) ||
        value.epoch < 1 ||
        !Number.isSafeInteger(value.useNumber) ||
        value.useNumber < 1 ||
        !Number.isSafeInteger(value.remainingUses) ||
        value.remainingUses < 0 ||
        !isTimestamp(value.consumedAt)) {
        throw invalidAuthority();
    }
    const { receiptId, ...core } = value;
    if (receiptId !== digestText(canonicalJson(core))) {
        throw invalidAuthority();
    }
    return deepFreeze(structuredClone(value));
}
function invalidAuthority() {
    return workflowError('PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID', 'Provider timeout above the base policy ceiling requires the exact durable execution-budget receipt.', ExitCode.guard);
}
function digestCanonical(value) {
    return digestText(canonicalJson(value));
}
function digestText(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function isTimestamp(value) {
    if (typeof value !== 'string')
        return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    return (canonicalJson(Object.keys(value).sort()) ===
        canonicalJson([...expected].sort()));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
