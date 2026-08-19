import crypto from 'node:crypto';
import { scanAuthorityAuditLedger, } from '../../authority-audit-ledger.js';
import { recordAuthorityAuditEvent, } from '../../authority-audit-service.js';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { WorkflowError } from '../../foundation/errors/errors.js';
/**
 * Audit one refusal only after a caller has independently verified the
 * durable authority binding used to construct `binding`. The idempotency key
 * excludes wall-clock time; retry after an audit-only crash recovers the first
 * durable occurrence and reproduces the exact event bytes.
 */
export function recordAuthorityRefusal(binding, error, options = {}) {
    const identity = {
        schemaVersion: 1,
        kind: 'authority-refusal-audit-identity.v1',
        family: binding.family,
        operation: binding.operation,
        subjectId: binding.subjectId,
        actor: binding.actor,
        taskId: binding.taskId,
        changeId: binding.changeId,
        workflowId: binding.workflowId,
        grantDigest: binding.grantDigest,
        bindingDigest: binding.bindingDigest,
        refusalIdentity: binding.refusalIdentity,
        errorCode: error.code,
    };
    const idempotencyKey = digest(canonicalJson(identity));
    const durableOccurrence = scanAuthorityAuditLedger(binding.scope).records.find(({ record }) => record.idempotencyKey === idempotencyKey)
        ?.record.occurredAt;
    const occurredAt = durableOccurrence ?? exactDate(options.now ?? new Date()).toISOString();
    const outcomeDigest = digest(canonicalJson({
        schemaVersion: 1,
        kind: 'authority-refusal-audit-outcome.v1',
        identity,
        result: 'failed',
    }));
    const entry = recordAuthorityAuditEvent(binding.scope, {
        eventType: 'error',
        occurredAt,
        idempotencyKey,
        actor: binding.actor,
        taskId: binding.taskId,
        changeId: binding.changeId,
        workflowId: binding.workflowId,
        grantDigest: binding.grantDigest,
        candidateBundleDigest: binding.candidateBundleDigest ?? null,
        prestateDigest: binding.bindingDigest,
        poststateDigest: null,
        command: {
            name: binding.operation,
            argvDigest: digest(canonicalJson({
                family: binding.family,
                operation: binding.operation,
                subjectId: binding.subjectId,
                refusalIdentity: binding.refusalIdentity,
            })),
        },
        providerInvocation: null,
        externalEffect: null,
        result: 'failed',
        outcomeDigest,
        errorCode: error.code,
    }, 
    // The refusal is stamped with the caller's clock, so the ledger has to
    // judge it against the same one; reading a different clock would make it
    // reject the record as implausibly dated and lose the refusal evidence.
    options.serviceHooks?.now !== undefined || options.now === undefined
        ? options.serviceHooks
        : { ...options.serviceHooks, now: () => exactDate(options.now) });
    options.onRecord?.(entry);
    return entry;
}
export function withAuthorityRefusalAudit(binding, options, operation) {
    try {
        return operation();
    }
    catch (error) {
        if (!(error instanceof WorkflowError) ||
            error.code.startsWith('AUTHORITY_AUDIT_')) {
            throw error;
        }
        try {
            recordAuthorityRefusal(binding, error, options);
        }
        catch (auditError) {
            attachAuthorityAuditFailure(error, auditError);
        }
        throw error;
    }
}
function attachAuthorityAuditFailure(refusal, auditError) {
    try {
        const currentCause = refusal.cause;
        const cause = currentCause === undefined
            ? auditError
            : new AggregateError([currentCause, auditError], 'Authority refusal audit also failed.');
        Object.defineProperty(refusal, 'cause', {
            configurable: true,
            enumerable: false,
            value: cause,
            writable: false,
        });
    }
    catch {
        // The stable, verified refusal remains authoritative even when a frozen
        // error object cannot carry the secondary audit infrastructure failure.
    }
}
export function authorityRefusalDigest(value) {
    return digest(canonicalJson(value));
}
function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new TypeError('Authority refusal audit time is invalid.');
    }
    return date;
}
