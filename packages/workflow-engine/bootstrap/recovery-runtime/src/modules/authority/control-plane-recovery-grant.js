import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError, } from '../../foundation/errors/errors.js';
export const HARNESS_RECOVERY_SIGNATURE_NAMESPACE = 'HARNESS_RECOVERY_GRANT_V1';
export const CONTROL_PLANE_RECOVERY_GRANT_TTL_MS = 5 * 60 * 1000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECOVERY_GRANT_ID = /^recovery-[0-9a-f]{64}$/;
const RECOVERY_RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const RECOVERY_RECORD_TEMPORARY = /^\.([0-9a-f]{64}\.json)\.(absent|[0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const LEGACY_RECOVERY_RECORD_TEMPORARY = /^\.([0-9a-f]{64}\.json)\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const PAYLOAD_KEYS = [
    'controlPlaneJournalDigest',
    'controlPlaneUpdateRecordDigest',
    'currentClosureDigest',
    'expiresAt',
    'externalAuditRoot',
    'grantId',
    'humanSigner',
    'issuedAt',
    'kind',
    'oneShot',
    'operation',
    'previousClosureDigest',
    'promotionBundleDigest',
    'recoveryBundleDigest',
    'repositoryId',
    'sourceControlPlaneGrantId',
    'sourceTransactionState',
    'supervisorGeneration',
    'supervisorStateDigest',
    'uses',
];
export function createControlPlaneRecoveryGrantPayload(binding) {
    const issuedAt = exactIso(binding.issuedAt, 'HARNESS_RECOVERY_GRANT_INVALID');
    const expiresAt = new Date(Date.parse(issuedAt) + CONTROL_PLANE_RECOVERY_GRANT_TTL_MS).toISOString();
    const grantId = recoveryGrantId({
        repositoryId: binding.repositoryId,
        sourceControlPlaneGrantId: binding.sourceControlPlaneGrantId,
        previousClosureDigest: binding.previousClosureDigest,
        currentClosureDigest: binding.currentClosureDigest,
        promotionBundleDigest: binding.promotionBundleDigest,
        recoveryBundleDigest: binding.recoveryBundleDigest,
        controlPlaneUpdateRecordDigest: binding.controlPlaneUpdateRecordDigest,
        controlPlaneJournalDigest: binding.controlPlaneJournalDigest,
        sourceTransactionState: binding.sourceTransactionState,
        supervisorStateDigest: binding.supervisorStateDigest,
        supervisorGeneration: binding.supervisorGeneration,
        externalAuditRoot: binding.externalAuditRoot,
        issuedAt,
        expiresAt,
        humanSigner: binding.humanSigner,
    });
    return normalizePayload({
        kind: 'harness-recovery-grant.v1',
        grantId,
        repositoryId: binding.repositoryId,
        sourceControlPlaneGrantId: binding.sourceControlPlaneGrantId,
        operation: 'rollback-control-plane',
        previousClosureDigest: binding.previousClosureDigest,
        currentClosureDigest: binding.currentClosureDigest,
        promotionBundleDigest: binding.promotionBundleDigest,
        recoveryBundleDigest: binding.recoveryBundleDigest,
        controlPlaneUpdateRecordDigest: binding.controlPlaneUpdateRecordDigest,
        controlPlaneJournalDigest: binding.controlPlaneJournalDigest,
        sourceTransactionState: binding.sourceTransactionState,
        supervisorStateDigest: binding.supervisorStateDigest,
        supervisorGeneration: binding.supervisorGeneration,
        externalAuditRoot: binding.externalAuditRoot,
        uses: 1,
        oneShot: true,
        issuedAt,
        expiresAt,
        humanSigner: binding.humanSigner,
    });
}
export function canonicalControlPlaneRecoveryGrantPayload(payload) {
    return canonicalJson(normalizePayload(payload));
}
export function verifyControlPlaneRecoveryGrant(envelope, input) {
    if (!isRecord(envelope) ||
        !hasExactKeys(envelope, ['payload', 'signature']) ||
        !isRecord(envelope.payload) ||
        !isNonEmpty(envelope.signature) ||
        typeof input.verifyHumanSignature !== 'function') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant envelope is malformed.');
    }
    const payload = normalizePayload(envelope.payload);
    let verified = false;
    try {
        verified = input.verifyHumanSignature(canonicalJson(payload), envelope.signature, payload.humanSigner, HARNESS_RECOVERY_SIGNATURE_NAMESPACE);
    }
    catch {
        verified = false;
    }
    if (!verified) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_SIGNATURE_INVALID', 'Recovery Grant signature is invalid for HARNESS_RECOVERY_GRANT_V1.');
    }
    const now = exactDate(input.now, 'HARNESS_RECOVERY_GRANT_CLOCK_INVALID');
    if ((input.enforceLive ?? true) &&
        now.getTime() < Date.parse(payload.issuedAt)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_NOT_YET_VALID', 'Recovery Grant activation window has not started.', ExitCode.staleState);
    }
    if ((input.enforceLive ?? true) &&
        now.getTime() >= Date.parse(payload.expiresAt)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Recovery Grant activation window has expired.', ExitCode.staleState);
    }
    return deepFreeze(structuredClone(payload));
}
export function controlPlaneRecoveryPrestateDigest(payload) {
    const exact = normalizePayload(payload);
    return canonicalDigest({
        kind: 'control-plane-recovery-prestate.v1',
        repositoryId: exact.repositoryId,
        sourceControlPlaneGrantId: exact.sourceControlPlaneGrantId,
        previousClosureDigest: exact.previousClosureDigest,
        currentClosureDigest: exact.currentClosureDigest,
        promotionBundleDigest: exact.promotionBundleDigest,
        recoveryBundleDigest: exact.recoveryBundleDigest,
        controlPlaneUpdateRecordDigest: exact.controlPlaneUpdateRecordDigest,
        controlPlaneJournalDigest: exact.controlPlaneJournalDigest,
        sourceTransactionState: exact.sourceTransactionState,
        supervisorStateDigest: exact.supervisorStateDigest,
        supervisorGeneration: exact.supervisorGeneration,
    });
}
export function createControlPlaneRecoveryReceipt(input) {
    const payload = normalizePayload(input.payload);
    assertDigest(input.poststateDigest, 'HARNESS_RECOVERY_RECEIPT_INVALID');
    assertDigest(input.controlPlaneJournalDigestAfter, 'HARNESS_RECOVERY_RECEIPT_INVALID');
    assertDigest(input.supervisorStateDigestAfter, 'HARNESS_RECOVERY_RECEIPT_INVALID');
    const receiptPayload = {
        kind: 'control-plane-recovery-receipt.v1',
        recoveryGrantId: payload.grantId,
        sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
        repositoryId: payload.repositoryId,
        operation: payload.operation,
        previousClosureDigest: payload.previousClosureDigest,
        currentClosureDigest: payload.currentClosureDigest,
        prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
        poststateDigest: input.poststateDigest,
        controlPlaneJournalDigestBefore: payload.controlPlaneJournalDigest,
        controlPlaneJournalDigestAfter: input.controlPlaneJournalDigestAfter,
        supervisorStateDigestBefore: payload.supervisorStateDigest,
        supervisorStateDigestAfter: input.supervisorStateDigestAfter,
        result: 'rolled-back',
        completedAt: exactIso(input.completedAt, 'HARNESS_RECOVERY_RECEIPT_INVALID'),
    };
    return deepFreeze({
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    });
}
export function createControlPlaneRecoveryFailure(input) {
    const payload = normalizePayload(input.payload);
    assertIdentifier(input.errorCode, 'HARNESS_RECOVERY_FAILURE_INVALID');
    assertIdentifier(input.selectedArtifactId, 'HARNESS_RECOVERY_FAILURE_INVALID');
    assertDigest(input.selectedClosureDigest, 'HARNESS_RECOVERY_FAILURE_INVALID');
    assertDigest(input.supervisorStateDigest, 'HARNESS_RECOVERY_FAILURE_INVALID');
    assertDigest(input.controlPlaneJournalDigest, 'HARNESS_RECOVERY_FAILURE_INVALID');
    if (!Number.isSafeInteger(input.supervisorGeneration) ||
        input.supervisorGeneration < payload.supervisorGeneration) {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Recovery failure supervisor generation is invalid.');
    }
    const failurePayload = {
        kind: 'control-plane-recovery-failure.v1',
        recoveryGrantId: payload.grantId,
        sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
        stage: 'restart-verification',
        errorCode: input.errorCode,
        selectedClosureDigest: input.selectedClosureDigest,
        selectedArtifactId: input.selectedArtifactId,
        supervisorStateDigest: input.supervisorStateDigest,
        supervisorGeneration: input.supervisorGeneration,
        controlPlaneJournalDigest: input.controlPlaneJournalDigest,
        failedAt: exactIso(input.failedAt, 'HARNESS_RECOVERY_FAILURE_INVALID'),
    };
    return deepFreeze({
        ...failurePayload,
        failureDigest: canonicalDigest(failurePayload),
    });
}
export function createControlPlaneRecoveryAuditRecord(input) {
    const payload = normalizePayload(input.payload);
    assertDigest(input.envelopeDigest, 'HARNESS_RECOVERY_AUDIT_INVALID');
    if (input.poststateDigest !== null) {
        assertDigest(input.poststateDigest, 'HARNESS_RECOVERY_AUDIT_INVALID');
    }
    if (input.receiptDigest !== null) {
        assertDigest(input.receiptDigest, 'HARNESS_RECOVERY_AUDIT_INVALID');
    }
    const sequence = input.event === 'authorized'
        ? 0
        : input.event === 'rolled-back' ||
            input.event === 'expired' ||
            input.event === 'failed'
            ? 1
            : 2;
    const identity = {
        kind: 'control-plane-recovery-audit-id.v1',
        recoveryGrantId: payload.grantId,
        event: input.event,
        sequence,
    };
    const recordPayload = {
        kind: 'control-plane-recovery-audit.v1',
        recordId: canonicalDigest(identity),
        repositoryId: payload.repositoryId,
        externalAuditRoot: payload.externalAuditRoot,
        recoveryGrantId: payload.grantId,
        sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
        humanSigner: payload.humanSigner,
        operation: payload.operation,
        sequence,
        event: input.event,
        grantEnvelopeDigest: input.envelopeDigest,
        promotionBundleDigest: payload.promotionBundleDigest,
        prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
        poststateDigest: input.poststateDigest,
        receiptDigest: input.receiptDigest,
        recordedAt: exactIso(input.recordedAt, 'HARNESS_RECOVERY_AUDIT_INVALID'),
    };
    return deepFreeze({
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    });
}
export function reservePersistedControlPlaneRecoveryGrant(storageRoot, envelope, at) {
    const payload = normalizePayload(envelope.payload);
    exactIso(at, 'HARNESS_RECOVERY_RECORD_INVALID');
    const createdAt = payload.issuedAt;
    const target = recoveryRecordPath(storageRoot, payload.grantId, true);
    const envelopeDigest = canonicalDigest(envelope);
    const recordPayload = {
        kind: 'persisted-control-plane-recovery-grant.v1',
        state: 'reserved',
        envelope: structuredClone(envelope),
        envelopeDigest,
        prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
        receipt: null,
        failure: null,
        createdAt,
        updatedAt: createdAt,
    };
    const record = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    const bytes = serializeRecord(record);
    reconcileRecoveryRecordTemporaries(path.dirname(target), {
        targetName: path.basename(target),
        expectedOldRecordDigest: null,
        nextRecordDigest: record.recordDigest,
        bytes,
    });
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        const existing = readPersistedControlPlaneRecoveryGrant(storageRoot, payload.grantId);
        if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
            throw recoveryRecordCorrupt();
        }
        if (existing.state === 'consumed')
            throw recoveryAlreadyConsumed();
        if (existing.state === 'failed')
            throw recoveryAlreadyFailed();
        if (existing.state === 'expired') {
            throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Recovery Grant is an expired one-shot tombstone.', ExitCode.staleState);
        }
        return existing;
    }
    replaceAtomic(target, bytes, null, record.recordDigest);
    return deepFreeze(record);
}
export function consumePersistedControlPlaneRecoveryGrant(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        throw recoveryAlreadyFailed();
    if (current.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Expired Recovery Grant cannot be consumed.', ExitCode.staleState);
    }
    if (current.state !== 'completion-pending' || current.receipt === null) {
        throw recoveryError('HARNESS_RECOVERY_CONSUMPTION_NOT_PREPARED', 'Recovery Grant consumption requires a durable completion receipt before terminalization.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before consumption.', ExitCode.staleState);
    }
    const receipt = current.receipt;
    const recordPayload = {
        kind: current.kind,
        state: 'consumed',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: receipt.completedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function preparePersistedControlPlaneRecoveryGrantConsumption(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        throw recoveryAlreadyFailed();
    if (current.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Expired Recovery Grant cannot prepare consumption.', ExitCode.staleState);
    }
    const receipt = normalizeReceipt(input.receipt);
    if (receipt.recoveryGrantId !== current.envelope.payload.grantId ||
        receipt.prestateDigest !== current.prestateDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Recovery receipt does not consume the exact reserved prestate.');
    }
    if (current.state === 'completion-pending') {
        if (canonicalJson(current.receipt) !== canonicalJson(receipt)) {
            throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Prepared Recovery Grant completion differs from the exact durable receipt.');
        }
        return current;
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before completion preparation.', ExitCode.staleState);
    }
    const recordPayload = {
        kind: current.kind,
        state: 'completion-pending',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: receipt.completedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function failPersistedControlPlaneRecoveryGrant(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        return current;
    if (current.state !== 'reserved') {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_STATE_INVALID', 'Only a reserved Recovery Grant can terminalize after restart verification failure.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before failure terminalization.', ExitCode.staleState);
    }
    const failure = normalizeFailure(input.failure);
    if (failure.recoveryGrantId !== current.envelope.payload.grantId ||
        failure.sourceControlPlaneGrantId !==
            current.envelope.payload.sourceControlPlaneGrantId) {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Recovery failure does not bind the exact reserved Grant.');
    }
    const recordPayload = {
        kind: current.kind,
        state: 'failed',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt: null,
        failure,
        createdAt: current.createdAt,
        updatedAt: failure.failedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function expirePersistedControlPlaneRecoveryGrant(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'expired')
        return current;
    if (current.state !== 'reserved') {
        throw recoveryError('HARNESS_RECOVERY_COMPLETION_OBLIGATORY', 'A Recovery Grant with a durable completion receipt cannot expire before terminal audit completion.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before expiry terminalization.', ExitCode.staleState);
    }
    const expiredAt = exactIso(input.expiredAt, 'HARNESS_RECOVERY_RECORD_INVALID');
    if (Date.parse(expiredAt) < Date.parse(current.envelope.payload.expiresAt)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_NOT_EXPIRED', 'Recovery Grant cannot terminalize before its activation window ends.', ExitCode.conflict);
    }
    const recordPayload = {
        kind: current.kind,
        state: 'expired',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt: null,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: expiredAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function readPersistedControlPlaneRecoveryGrant(storageRoot, recoveryGrantId) {
    const value = readCanonicalRecord(recoveryRecordPath(storageRoot, recoveryGrantId, false));
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'createdAt',
            'envelope',
            'envelopeDigest',
            'failure',
            'kind',
            'prestateDigest',
            'receipt',
            'recordDigest',
            'state',
            'updatedAt',
        ]) ||
        value.kind !== 'persisted-control-plane-recovery-grant.v1' ||
        !verifyRecordDigest(value) ||
        !isRecord(value.envelope) ||
        !hasExactKeys(value.envelope, ['payload', 'signature']) ||
        !isRecord(value.envelope.payload) ||
        !isNonEmpty(value.envelope.signature) ||
        !isDigest(value.envelopeDigest) ||
        canonicalDigest(value.envelope) !== value.envelopeDigest ||
        !isDigest(value.prestateDigest) ||
        ![
            'reserved',
            'completion-pending',
            'consumed',
            'expired',
            'failed',
        ].includes(String(value.state))) {
        throw recoveryRecordCorrupt();
    }
    const payload = normalizePayload(value.envelope.payload);
    if (payload.grantId !== recoveryGrantId ||
        value.prestateDigest !== controlPlaneRecoveryPrestateDigest(payload)) {
        throw recoveryRecordCorrupt();
    }
    const createdAt = exactIso(value.createdAt, 'HARNESS_RECOVERY_RECORD_CORRUPT');
    const updatedAt = exactIso(value.updatedAt, 'HARNESS_RECOVERY_RECORD_CORRUPT');
    if (Date.parse(updatedAt) < Date.parse(createdAt))
        throw recoveryRecordCorrupt();
    const receipt = value.receipt === null ? null : normalizeReceipt(value.receipt);
    const failure = value.failure === null ? null : normalizeFailure(value.failure);
    if (((value.state === 'reserved' || value.state === 'expired') &&
        (receipt !== null || failure !== null)) ||
        ((value.state === 'completion-pending' || value.state === 'consumed') &&
            (receipt === null || failure !== null)) ||
        (value.state === 'failed' && (receipt !== null || failure === null)) ||
        (receipt !== null &&
            (receipt.recoveryGrantId !== payload.grantId ||
                receipt.sourceControlPlaneGrantId !==
                    payload.sourceControlPlaneGrantId ||
                receipt.repositoryId !== payload.repositoryId ||
                receipt.operation !== payload.operation ||
                receipt.previousClosureDigest !== payload.previousClosureDigest ||
                receipt.currentClosureDigest !== payload.currentClosureDigest ||
                receipt.controlPlaneJournalDigestBefore !==
                    payload.controlPlaneJournalDigest ||
                receipt.supervisorStateDigestBefore !== payload.supervisorStateDigest ||
                receipt.prestateDigest !== value.prestateDigest)) ||
        (failure !== null &&
            (failure.recoveryGrantId !== payload.grantId ||
                failure.sourceControlPlaneGrantId !==
                    payload.sourceControlPlaneGrantId ||
                failure.selectedClosureDigest !== payload.previousClosureDigest ||
                Date.parse(failure.failedAt) < Date.parse(createdAt)))) {
        throw recoveryRecordCorrupt();
    }
    return deepFreeze(structuredClone(value));
}
export function findPersistedControlPlaneRecoveryGrantForSource(storageRoot, sourceControlPlaneGrantId) {
    assertIdentifier(sourceControlPlaneGrantId, 'HARNESS_RECOVERY_GRANT_INVALID');
    const directory = recoveryRecordsDirectory(storageRoot, false);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false }))
        return null;
    assertPrivateDirectory(directory);
    reconcileRecoveryRecordTemporaries(directory);
    const entries = fs.readdirSync(directory).sort();
    if (entries.some((entry) => !RECOVERY_RECORD_NAME.test(entry) &&
        !RECOVERY_RECORD_TEMPORARY.test(entry) &&
        !LEGACY_RECOVERY_RECORD_TEMPORARY.test(entry))) {
        throw recoveryRecordCorrupt();
    }
    const matches = entries
        .filter((entry) => RECOVERY_RECORD_NAME.test(entry))
        .map((entry) => readPersistedControlPlaneRecoveryGrant(storageRoot, recoveryGrantIdFromRecordPath(directory, entry)))
        .filter((record) => record.envelope.payload.sourceControlPlaneGrantId ===
        sourceControlPlaneGrantId);
    const active = matches.filter(({ state }) => state !== 'expired' && state !== 'failed');
    if (active.length > 1)
        throw recoveryRecordCorrupt();
    if (active.length === 1)
        return active[0];
    return (matches.sort((left, right) => left.updatedAt < right.updatedAt
        ? 1
        : left.updatedAt > right.updatedAt
            ? -1
            : left.envelope.payload.grantId < right.envelope.payload.grantId
                ? 1
                : left.envelope.payload.grantId > right.envelope.payload.grantId
                    ? -1
                    : 0)[0] ?? null);
}
export function throwControlPlaneRecoveryAlreadyConsumed() {
    throw recoveryAlreadyConsumed();
}
export function throwControlPlaneRecoveryFailed() {
    throw recoveryAlreadyFailed();
}
function normalizePayload(raw) {
    if (!isRecord(raw) || !hasExactKeys(raw, PAYLOAD_KEYS)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant payload has unknown, missing, or malformed fields.');
    }
    if (raw.kind !== 'harness-recovery-grant.v1' ||
        !RECOVERY_GRANT_ID.test(String(raw.grantId)) ||
        !isNonEmpty(raw.repositoryId) ||
        !isNonEmpty(raw.sourceControlPlaneGrantId) ||
        raw.operation !== 'rollback-control-plane' ||
        !isDigest(raw.previousClosureDigest) ||
        !isDigest(raw.currentClosureDigest) ||
        raw.previousClosureDigest === raw.currentClosureDigest ||
        !isDigest(raw.promotionBundleDigest) ||
        !isDigest(raw.recoveryBundleDigest) ||
        !isDigest(raw.controlPlaneUpdateRecordDigest) ||
        !isDigest(raw.controlPlaneJournalDigest) ||
        !['RECOVERY_VERIFIED', 'SWITCHED', 'ROLLBACK_REQUIRED'].includes(String(raw.sourceTransactionState)) ||
        !isDigest(raw.supervisorStateDigest) ||
        !Number.isSafeInteger(raw.supervisorGeneration) ||
        Number(raw.supervisorGeneration) < 2 ||
        !isExactAbsolutePath(raw.externalAuditRoot) ||
        raw.uses !== 1 ||
        raw.oneShot !== true ||
        !isNonEmpty(raw.humanSigner)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant payload has invalid authority or state bindings.');
    }
    const issuedAt = exactIso(raw.issuedAt, 'HARNESS_RECOVERY_GRANT_INVALID');
    const expiresAt = exactIso(raw.expiresAt, 'HARNESS_RECOVERY_GRANT_INVALID');
    const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
    if (ttl <= 0 || ttl > CONTROL_PLANE_RECOVERY_GRANT_TTL_MS) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_TTL_INVALID', 'Recovery Grant must use a positive activation window of at most five minutes.');
    }
    const expectedGrantId = recoveryGrantId({
        repositoryId: raw.repositoryId,
        sourceControlPlaneGrantId: raw.sourceControlPlaneGrantId,
        previousClosureDigest: raw.previousClosureDigest,
        currentClosureDigest: raw.currentClosureDigest,
        promotionBundleDigest: raw.promotionBundleDigest,
        recoveryBundleDigest: raw.recoveryBundleDigest,
        controlPlaneUpdateRecordDigest: raw.controlPlaneUpdateRecordDigest,
        controlPlaneJournalDigest: raw.controlPlaneJournalDigest,
        sourceTransactionState: raw.sourceTransactionState,
        supervisorStateDigest: raw.supervisorStateDigest,
        supervisorGeneration: Number(raw.supervisorGeneration),
        externalAuditRoot: raw.externalAuditRoot,
        issuedAt,
        expiresAt,
        humanSigner: raw.humanSigner,
    });
    if (raw.grantId !== expectedGrantId) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant identity does not match its signed activation identity.');
    }
    return {
        kind: raw.kind,
        grantId: raw.grantId,
        repositoryId: raw.repositoryId,
        sourceControlPlaneGrantId: raw.sourceControlPlaneGrantId,
        operation: raw.operation,
        previousClosureDigest: raw.previousClosureDigest,
        currentClosureDigest: raw.currentClosureDigest,
        promotionBundleDigest: raw.promotionBundleDigest,
        recoveryBundleDigest: raw.recoveryBundleDigest,
        controlPlaneUpdateRecordDigest: raw.controlPlaneUpdateRecordDigest,
        controlPlaneJournalDigest: raw.controlPlaneJournalDigest,
        sourceTransactionState: raw.sourceTransactionState,
        supervisorStateDigest: raw.supervisorStateDigest,
        supervisorGeneration: Number(raw.supervisorGeneration),
        externalAuditRoot: raw.externalAuditRoot,
        uses: 1,
        oneShot: true,
        issuedAt,
        expiresAt,
        humanSigner: raw.humanSigner,
    };
}
function normalizeReceipt(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'completedAt',
            'controlPlaneJournalDigestAfter',
            'controlPlaneJournalDigestBefore',
            'currentClosureDigest',
            'kind',
            'operation',
            'poststateDigest',
            'prestateDigest',
            'previousClosureDigest',
            'receiptDigest',
            'recoveryGrantId',
            'repositoryId',
            'result',
            'sourceControlPlaneGrantId',
            'supervisorStateDigestAfter',
            'supervisorStateDigestBefore',
        ]) ||
        raw.kind !== 'control-plane-recovery-receipt.v1' ||
        !RECOVERY_GRANT_ID.test(String(raw.recoveryGrantId)) ||
        !isNonEmpty(raw.sourceControlPlaneGrantId) ||
        !isNonEmpty(raw.repositoryId) ||
        raw.operation !== 'rollback-control-plane' ||
        !isDigest(raw.previousClosureDigest) ||
        !isDigest(raw.currentClosureDigest) ||
        !isDigest(raw.prestateDigest) ||
        !isDigest(raw.poststateDigest) ||
        !isDigest(raw.controlPlaneJournalDigestBefore) ||
        !isDigest(raw.controlPlaneJournalDigestAfter) ||
        !isDigest(raw.supervisorStateDigestBefore) ||
        !isDigest(raw.supervisorStateDigestAfter) ||
        raw.result !== 'rolled-back' ||
        !isDigest(raw.receiptDigest)) {
        throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Control-plane recovery receipt is malformed.');
    }
    const completedAt = exactIso(raw.completedAt, 'HARNESS_RECOVERY_RECEIPT_INVALID');
    const { receiptDigest, ...payload } = raw;
    if (receiptDigest !== canonicalDigest(payload)) {
        throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Control-plane recovery receipt digest is invalid.');
    }
    return structuredClone(raw);
}
function normalizeFailure(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'controlPlaneJournalDigest',
            'errorCode',
            'failedAt',
            'failureDigest',
            'kind',
            'recoveryGrantId',
            'selectedArtifactId',
            'selectedClosureDigest',
            'sourceControlPlaneGrantId',
            'stage',
            'supervisorGeneration',
            'supervisorStateDigest',
        ]) ||
        raw.kind !== 'control-plane-recovery-failure.v1' ||
        !RECOVERY_GRANT_ID.test(String(raw.recoveryGrantId)) ||
        !isNonEmpty(raw.sourceControlPlaneGrantId) ||
        raw.stage !== 'restart-verification' ||
        !isNonEmpty(raw.errorCode) ||
        !isDigest(raw.selectedClosureDigest) ||
        !isNonEmpty(raw.selectedArtifactId) ||
        !isDigest(raw.supervisorStateDigest) ||
        !Number.isSafeInteger(raw.supervisorGeneration) ||
        Number(raw.supervisorGeneration) < 2 ||
        !isDigest(raw.controlPlaneJournalDigest) ||
        !isDigest(raw.failureDigest)) {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Persisted Recovery Grant failure is malformed.');
    }
    const failedAt = exactIso(raw.failedAt, 'HARNESS_RECOVERY_FAILURE_INVALID');
    const { failureDigest, ...payload } = raw;
    if (failureDigest !== canonicalDigest(payload)) {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Persisted Recovery Grant failure digest is invalid.');
    }
    return structuredClone({
        ...raw,
        failedAt,
    });
}
function recoveryGrantId(input) {
    assertIdentifier(input.sourceControlPlaneGrantId, 'HARNESS_RECOVERY_GRANT_INVALID');
    assertIdentifier(input.humanSigner, 'HARNESS_RECOVERY_GRANT_INVALID');
    return `recovery-${canonicalDigest({
        kind: 'harness-recovery-grant-identity.v2',
        ...input,
    }).slice('sha256:'.length)}`;
}
function recoveryRecordsDirectory(storageRoot, create) {
    const root = path.resolve(storageRoot);
    if (root !== storageRoot) {
        throw recoveryError('HARNESS_RECOVERY_STATE_UNSAFE', 'Recovery state root must be an exact absolute path.', ExitCode.unsafeEnvironment);
    }
    const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!rootStats?.isDirectory() ||
        rootStats.isSymbolicLink() ||
        fs.realpathSync(root) !== root ||
        (rootStats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !ownedByCurrentUser(rootStats)) {
        throw recoveryStateUnsafe();
    }
    const directory = path.join(root, 'control-plane-recovery-grants');
    if (create && !fs.lstatSync(directory, { throwIfNoEntry: false })) {
        try {
            fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
            fsyncDirectory(root);
        }
        catch (error) {
            if (!isNodeCode(error, 'EEXIST'))
                throw recoveryStateUnsafe();
        }
    }
    return directory;
}
function recoveryRecordPath(storageRoot, recoveryGrantId, createDirectory) {
    if (!RECOVERY_GRANT_ID.test(recoveryGrantId)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant ID is malformed.');
    }
    const directory = recoveryRecordsDirectory(storageRoot, createDirectory);
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
        assertPrivateDirectory(directory);
    }
    return path.join(directory, `${rawDigest(`control-plane-recovery\0${recoveryGrantId}`).slice('sha256:'.length)}.json`);
}
function recoveryGrantIdFromRecordPath(directory, entry) {
    const value = readCanonicalRecord(path.join(directory, entry));
    if (!isRecord(value) ||
        !isRecord(value.envelope) ||
        !isRecord(value.envelope.payload) ||
        typeof value.envelope.payload.grantId !== 'string') {
        throw recoveryRecordCorrupt();
    }
    const grantId = value.envelope.payload.grantId;
    const expected = `${rawDigest(`control-plane-recovery\0${grantId}`).slice('sha256:'.length)}.json`;
    if (entry !== expected)
        throw recoveryRecordCorrupt();
    return grantId;
}
function assertPrivateDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!path.isAbsolute(directory) ||
        path.resolve(directory) !== directory ||
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory ||
        (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !ownedByCurrentUser(stats)) {
        throw recoveryStateUnsafe();
    }
}
function readCanonicalRecord(filePath, allowedLinkCounts = [1]) {
    const inspected = inspectPrivateRecordFile(filePath, allowedLinkCounts);
    if (inspected.value === null)
        throw recoveryRecordCorrupt();
    return inspected.value;
}
function inspectPrivateRecordFile(filePath, allowedLinkCounts) {
    if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
        throw recoveryRecordCorrupt();
    }
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before?.isFile() ||
        before.isSymbolicLink() ||
        !allowedLinkCounts.includes(before.nlink) ||
        (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !ownedByCurrentUser(before) ||
        safeRealpath(filePath) !== filePath ||
        before.size > MAX_RECORD_BYTES) {
        throw recoveryRecordCorrupt();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const openedBefore = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
            throw recoveryRecordCorrupt();
        }
        const raw = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
            throw recoveryRecordCorrupt();
        }
        let bytes;
        try {
            bytes = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        }
        catch {
            return { bytes: '', raw, stats: openedAfter, value: null };
        }
        try {
            if (!bytes.endsWith('\n')) {
                return { bytes, raw, stats: openedAfter, value: null };
            }
            const value = JSON.parse(bytes);
            if (`${canonicalJson(value)}\n` !== bytes) {
                return { bytes, raw, stats: openedAfter, value: null };
            }
            return { bytes, raw, stats: openedAfter, value };
        }
        catch {
            return { bytes, raw, stats: openedAfter, value: null };
        }
    }
    catch (error) {
        if (isWorkflowCode(error))
            throw error;
        throw recoveryRecordCorrupt();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function writeExclusive(filePath, bytes) {
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    try {
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, bytes, 'utf8');
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
}
function replaceAtomic(filePath, bytes, expectedOldRecordDigest, nextRecordDigest) {
    const directory = path.dirname(filePath);
    const expectation = {
        targetName: path.basename(filePath),
        expectedOldRecordDigest,
        nextRecordDigest,
        bytes,
    };
    reconcileRecoveryRecordTemporaries(directory, expectation);
    const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (expectedOldRecordDigest === null && existing) {
        const current = readCanonicalRecord(filePath);
        if (!isRecord(current) ||
            current.recordDigest !== nextRecordDigest ||
            serializeRecord(current) !== bytes) {
            throw recoveryRecordCorrupt();
        }
        assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
        return;
    }
    const expected = expectedOldRecordDigest === null
        ? 'absent'
        : expectedOldRecordDigest.slice('sha256:'.length);
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${expected}.${nextRecordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`);
    try {
        writeExclusive(temporary, bytes);
        if (expectedOldRecordDigest === null) {
            try {
                fs.linkSync(temporary, filePath);
            }
            catch (error) {
                if (!isNodeCode(error, 'EEXIST'))
                    throw recoveryStateUnsafe();
                const raced = readCanonicalRecord(filePath);
                if (!isRecord(raced) ||
                    raced.recordDigest !== nextRecordDigest ||
                    serializeRecord(raced) !== bytes) {
                    throw recoveryRecordCorrupt();
                }
                unlinkOwnedPreparationIfPresent(temporary, bytes);
                assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
                return;
            }
            assertExactHardLinkPair(temporary, filePath);
            const published = readCanonicalRecord(filePath, [2]);
            if (!isRecord(published) ||
                published.recordDigest !== nextRecordDigest ||
                serializeRecord(published) !== bytes) {
                throw recoveryRecordCorrupt();
            }
            fsyncDirectory(directory);
            unlinkExactAlias(temporary, filePath);
            fsyncDirectory(directory);
            assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
            return;
        }
        else {
            const currentValue = readCanonicalRecord(filePath);
            if (!isRecord(currentValue) ||
                currentValue.recordDigest !== expectedOldRecordDigest) {
                throw recoveryRecordCorrupt();
            }
        }
        fs.renameSync(temporary, filePath);
        fsyncDirectory(directory);
        assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
    }
    finally {
        unlinkOwnedPreparationIfPresent(temporary, bytes);
    }
}
function assertExactPublishedRecord(filePath, expectedRecordDigest, expectedBytes) {
    const published = readCanonicalRecord(filePath);
    if (!isRecord(published) ||
        published.recordDigest !== expectedRecordDigest ||
        serializeRecord(published) !== expectedBytes) {
        throw recoveryRecordCorrupt();
    }
}
function reconcileRecoveryRecordTemporaries(directory, expectation) {
    assertPrivateDirectory(directory);
    reconcileCleanupQuarantine(directory);
    const entries = fs.readdirSync(directory).sort();
    const recognized = entries
        .map((entry) => ({
        entry,
        current: RECOVERY_RECORD_TEMPORARY.exec(entry),
        legacy: LEGACY_RECOVERY_RECORD_TEMPORARY.exec(entry),
    }))
        .filter(({ current, legacy }) => current !== null || legacy !== null);
    if (entries.some((entry) => !RECOVERY_RECORD_NAME.test(entry) &&
        !RECOVERY_RECORD_TEMPORARY.test(entry) &&
        !LEGACY_RECOVERY_RECORD_TEMPORARY.test(entry))) {
        throw recoveryRecordCorrupt();
    }
    recoverExactPartialFinal(directory, expectation);
    for (const match of recognized) {
        const temporaryPath = path.join(directory, match.entry);
        const targetName = (match.current ?? match.legacy)[1];
        const targetPath = path.join(directory, targetName);
        if (expectation?.targetName === targetName &&
            match.current !== null &&
            !expectationMatchesPreparation(expectation, targetName, match)) {
            throw recoveryRecordCorrupt();
        }
        const inspected = inspectPrivateRecordFile(temporaryPath, [1, 2]);
        const targetStats = fs.lstatSync(targetPath, {
            throwIfNoEntry: false,
        });
        if (targetStats && sameInode(inspected.stats, targetStats)) {
            assertExactHardLinkPair(temporaryPath, targetPath);
            if (inspected.value === null)
                throw recoveryRecordCorrupt();
            assertPreparedRecord(inspected.value, targetName, match.current?.[3]);
            const targetValue = readCanonicalRecord(targetPath, [2]);
            if (canonicalJson(targetValue) !== canonicalJson(inspected.value)) {
                throw recoveryRecordCorrupt();
            }
            unlinkExactAlias(temporaryPath, targetPath);
            fsyncDirectory(directory);
            continue;
        }
        if (inspected.stats.nlink !== 1)
            throw recoveryRecordCorrupt();
        if (!isRecord(inspected.value)) {
            if (expectationMatchesPreparation(expectation, targetName, match) &&
                (match.current !== null
                    ? isStrictBytePrefix(inspected.raw, expectation.bytes)
                    : isRecoverableLegacyFinalPrefix(inspected.raw, expectation.bytes))) {
                unlinkExactSingleFile(temporaryPath, inspected.stats);
                fsyncDirectory(directory);
                continue;
            }
            if (match.current !== null) {
                const namedExpected = match.current[2];
                if (!targetStats && namedExpected === 'absent')
                    continue;
                if (targetStats?.nlink === 1) {
                    const currentValue = readCanonicalRecord(targetPath);
                    if (isRecord(currentValue) &&
                        namedExpected !== 'absent' &&
                        currentValue.recordDigest === `sha256:${namedExpected}`) {
                        continue;
                    }
                }
            }
            throw recoveryRecordCorrupt();
        }
        assertPreparedRecord(inspected.value, targetName, match.current?.[3]);
        if (!targetStats) {
            if (expectationMatchesPreparation(expectation, targetName, match) &&
                inspected.bytes === expectation.bytes) {
                unlinkExactSingleFile(temporaryPath, inspected.stats);
                fsyncDirectory(directory);
                continue;
            }
            if (match.current?.[2] === 'absent')
                continue;
            throw recoveryRecordCorrupt();
        }
        const currentValue = readCanonicalRecord(targetPath);
        if (canonicalJson(currentValue) === canonicalJson(inspected.value)) {
            unlinkExactSingleFile(temporaryPath, inspected.stats);
            fsyncDirectory(directory);
            continue;
        }
        if (match.legacy !== null || !isRecord(currentValue)) {
            throw recoveryRecordCorrupt();
        }
        const namedExpected = match.current[2];
        if (namedExpected === 'absent' ||
            currentValue.recordDigest !== `sha256:${namedExpected}`) {
            throw recoveryRecordCorrupt();
        }
        if (expectationMatchesPreparation(expectation, targetName, match) &&
            inspected.bytes === expectation.bytes) {
            unlinkExactSingleFile(temporaryPath, inspected.stats);
            fsyncDirectory(directory);
        }
    }
    const expectedTarget = expectation === undefined
        ? undefined
        : path.join(directory, expectation.targetName);
    if (expectedTarget &&
        fs.lstatSync(expectedTarget, { throwIfNoEntry: false })) {
        const stats = fs.lstatSync(expectedTarget);
        if (stats.nlink !== 1)
            throw recoveryRecordCorrupt();
    }
}
function reconcileCleanupQuarantine(recordsDirectory) {
    const quarantineRoot = path.join(path.dirname(recordsDirectory), 'control-plane-recovery-cleanup-quarantine');
    if (fs.lstatSync(quarantineRoot, { throwIfNoEntry: false }) === undefined) {
        return;
    }
    assertPrivateDirectory(quarantineRoot);
    for (const entry of fs.readdirSync(quarantineRoot).sort()) {
        if (!/^cleanup-[A-Za-z0-9]{6}$/.test(entry)) {
            throw recoveryRecordCorrupt();
        }
        const operationDirectory = path.join(quarantineRoot, entry);
        assertPrivateDirectory(operationDirectory);
        const contents = fs.readdirSync(operationDirectory).sort();
        if (contents.length === 0) {
            continue;
        }
        const ambiguousTargets = contents.filter((name) => /^ambiguous-target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name));
        for (const ambiguous of ambiguousTargets) {
            inspectPrivateRecordFile(path.join(operationDirectory, ambiguous), [1]);
        }
        const authoritative = contents.filter((name) => !ambiguousTargets.includes(name));
        if (canonicalJson(authoritative) !== canonicalJson(['residue']) &&
            canonicalJson(authoritative) !== canonicalJson(['anchor', 'residue'])) {
            throw recoveryRecordCorrupt();
        }
        const residue = path.join(operationDirectory, 'residue');
        const inspected = inspectPrivateRecordFile(residue, [1, 2]);
        if (inspected.stats.nlink === 1) {
            if (canonicalJson(authoritative) !== canonicalJson(['residue'])) {
                throw recoveryRecordCorrupt();
            }
            continue;
        }
        if (!isRecord(inspected.value)) {
            throw recoveryRecordCorrupt();
        }
        const target = path.join(recordsDirectory, expectedRecoveryRecordName(inspected.value));
        detachQuarantinedHardLink(operationDirectory, residue, target, inspected.value);
    }
}
function recoverExactPartialFinal(directory, expectation) {
    if (expectation === undefined)
        return;
    const target = path.join(directory, expectation.targetName);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stats === undefined || stats.nlink !== 1)
        return;
    const inspected = inspectPrivateRecordFile(target, [1]);
    if (inspected.value !== null)
        return;
    if (!isRecoverableLegacyFinalPrefix(inspected.raw, expectation.bytes)) {
        throw recoveryRecordCorrupt();
    }
    unlinkExactSingleFile(target, inspected.stats);
    fsyncDirectory(directory);
}
function expectationMatchesPreparation(expectation, targetName, match) {
    if (expectation === undefined || expectation.targetName !== targetName) {
        return false;
    }
    if (match.legacy !== null)
        return true;
    const expected = expectation.expectedOldRecordDigest === null
        ? 'absent'
        : expectation.expectedOldRecordDigest.slice('sha256:'.length);
    return (match.current?.[2] === expected &&
        match.current[3] === expectation.nextRecordDigest.slice('sha256:'.length));
}
function assertPreparedRecord(value, targetName, namedNextDigest) {
    if (!isRecord(value) ||
        !verifyRecordDigest(value) ||
        expectedRecoveryRecordName(value) !== targetName ||
        (namedNextDigest !== undefined &&
            value.recordDigest !== `sha256:${namedNextDigest}`)) {
        throw recoveryRecordCorrupt();
    }
}
function isStrictBytePrefix(prefix, exact) {
    const expected = Buffer.from(exact, 'utf8');
    return (prefix.length < expected.length &&
        prefix.equals(expected.subarray(0, prefix.length)));
}
function isRecoverableLegacyFinalPrefix(prefix, exact) {
    if (!isStrictBytePrefix(prefix, exact))
        return false;
    let expected;
    try {
        expected = JSON.parse(exact);
    }
    catch {
        return false;
    }
    if (!isRecord(expected) ||
        typeof expected.createdAt !== 'string' ||
        !isDigest(expected.envelopeDigest)) {
        return false;
    }
    const envelopeAnchor = `,"envelopeDigest":${JSON.stringify(expected.envelopeDigest)},`;
    const envelopeAnchorStart = exact.indexOf(envelopeAnchor);
    if (envelopeAnchorStart < 0)
        return false;
    const provenLength = envelopeAnchorStart + envelopeAnchor.length;
    return (prefix.length >= provenLength &&
        prefix
            .subarray(0, provenLength)
            .equals(Buffer.from(exact.slice(0, provenLength), 'utf8')));
}
function unlinkOwnedPreparationIfPresent(temporary, expectedBytes) {
    const stats = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (stats === undefined || stats.nlink === 2)
        return;
    const inspected = inspectPrivateRecordFile(temporary, [1]);
    const exact = Buffer.from(expectedBytes, 'utf8');
    if (!inspected.raw.equals(exact) &&
        !isStrictBytePrefix(inspected.raw, expectedBytes)) {
        throw recoveryRecordCorrupt();
    }
    unlinkExactSingleFile(temporary, inspected.stats);
    fsyncDirectory(path.dirname(temporary));
}
function unlinkExactSingleFile(filePath, expected) {
    quarantineVerifiedPath(filePath, expected, [1]);
}
function assertExactHardLinkPair(leftPath, rightPath) {
    const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
    const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
    if (left === undefined ||
        right === undefined ||
        !sameInode(left, right) ||
        left.nlink !== 2 ||
        right.nlink !== 2) {
        throw recoveryRecordCorrupt();
    }
}
function unlinkExactAlias(alias, anchor) {
    assertExactHardLinkPair(alias, anchor);
    const aliasStats = fs.lstatSync(alias);
    const anchorBefore = fs.lstatSync(anchor);
    const value = readCanonicalRecord(alias, [2]);
    if (!isRecord(value))
        throw recoveryRecordCorrupt();
    const quarantined = quarantineVerifiedPath(alias, aliasStats, [2], {
        filePath: anchor,
        stats: anchorBefore,
    });
    detachQuarantinedHardLink(quarantined.operationDirectory, quarantined.residue, anchor, value);
    const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
    if (anchorStats === undefined ||
        sameInode(anchorBefore, anchorStats) ||
        anchorStats.nlink !== 1 ||
        anchorStats.size !== Buffer.byteLength(serializeRecord(value)) ||
        (anchorStats.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !ownedByCurrentUser(anchorStats)) {
        throw recoveryRecordCorrupt();
    }
}
function quarantineVerifiedPath(filePath, expected, allowedLinkCounts, anchor) {
    const sourceDirectory = path.dirname(filePath);
    const storageRoot = path.dirname(sourceDirectory);
    assertPrivateDirectory(storageRoot);
    const quarantineRoot = path.join(storageRoot, 'control-plane-recovery-cleanup-quarantine');
    const existingRoot = fs.lstatSync(quarantineRoot, {
        throwIfNoEntry: false,
    });
    if (existingRoot === undefined) {
        try {
            fs.mkdirSync(quarantineRoot, { mode: PRIVATE_DIRECTORY_MODE });
            fsyncDirectory(storageRoot);
        }
        catch (error) {
            if (!isNodeCode(error, 'EEXIST'))
                throw recoveryStateUnsafe();
        }
    }
    assertPrivateDirectory(quarantineRoot);
    const operationDirectory = fs.mkdtempSync(path.join(quarantineRoot, 'cleanup-'));
    fs.chmodSync(operationDirectory, PRIVATE_DIRECTORY_MODE);
    fsyncDirectory(quarantineRoot);
    const residue = path.join(operationDirectory, 'residue');
    try {
        fs.renameSync(filePath, residue);
        fsyncDirectory(sourceDirectory);
        fsyncDirectory(operationDirectory);
    }
    catch {
        throw recoveryRecordCorrupt();
    }
    const moved = fs.lstatSync(residue, { throwIfNoEntry: false });
    if (moved === undefined ||
        !sameFileAfterRename(expected, moved, allowedLinkCounts)) {
        throw recoveryRecordCorrupt();
    }
    if (anchor !== undefined) {
        const observedAnchor = fs.lstatSync(anchor.filePath, {
            throwIfNoEntry: false,
        });
        if (observedAnchor === undefined ||
            !sameInode(anchor.stats, observedAnchor) ||
            observedAnchor.nlink !== 2 ||
            observedAnchor.size !== anchor.stats.size ||
            (observedAnchor.mode & 0o777) !== PRIVATE_FILE_MODE ||
            !ownedByCurrentUser(observedAnchor)) {
            throw recoveryRecordCorrupt();
        }
    }
    return { operationDirectory, residue };
}
function detachQuarantinedHardLink(operationDirectory, residue, target, value) {
    const expectedName = expectedRecoveryRecordName(value);
    assertPreparedRecord(value, expectedName, undefined);
    if (path.basename(target) !== expectedName)
        throw recoveryRecordCorrupt();
    const bytes = serializeRecord(value);
    const anchor = path.join(operationDirectory, 'anchor');
    const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
    if (anchorStats === undefined) {
        assertExactHardLinkPair(residue, target);
        const targetValue = readCanonicalRecord(target, [2]);
        if (canonicalJson(targetValue) !== canonicalJson(value)) {
            throw recoveryRecordCorrupt();
        }
        try {
            fs.renameSync(target, anchor);
            fsyncDirectory(path.dirname(target));
            fsyncDirectory(operationDirectory);
        }
        catch {
            throw recoveryRecordCorrupt();
        }
    }
    assertExactHardLinkPair(residue, anchor);
    const residueValue = readCanonicalRecord(residue, [2]);
    const movedAnchorValue = readCanonicalRecord(anchor, [2]);
    if (canonicalJson(residueValue) !== canonicalJson(value) ||
        canonicalJson(movedAnchorValue) !== canonicalJson(value)) {
        throw recoveryRecordCorrupt();
    }
    let targetBeforePublish = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetBeforePublish !== undefined) {
        const inspectedTarget = inspectPrivateRecordFile(target, [1]);
        if (inspectedTarget.value === null) {
            if (!isStrictBytePrefix(inspectedTarget.raw, bytes)) {
                throw recoveryRecordCorrupt();
            }
            const ambiguous = path.join(operationDirectory, `ambiguous-target-${crypto.randomUUID()}`);
            try {
                fs.renameSync(target, ambiguous);
                fsyncDirectory(path.dirname(target));
                fsyncDirectory(operationDirectory);
            }
            catch {
                throw recoveryRecordCorrupt();
            }
            const movedAmbiguous = fs.lstatSync(ambiguous, {
                throwIfNoEntry: false,
            });
            if (movedAmbiguous === undefined ||
                !sameFileAfterRename(inspectedTarget.stats, movedAmbiguous, [1])) {
                throw recoveryRecordCorrupt();
            }
            targetBeforePublish = undefined;
        }
    }
    if (targetBeforePublish === undefined) {
        writeExclusive(target, bytes);
        assertExactPublishedRecord(target, value.recordDigest, bytes);
    }
    else {
        const current = readCanonicalRecord(target);
        assertPreparedRecord(current, expectedName, undefined);
    }
    const targetStats = fs.lstatSync(target);
    const oldStats = fs.lstatSync(residue);
    if (targetStats.nlink !== 1 || sameInode(targetStats, oldStats)) {
        throw recoveryRecordCorrupt();
    }
}
function expectedRecoveryRecordName(value) {
    if (!isRecord(value.envelope) ||
        !isRecord(value.envelope.payload) ||
        typeof value.envelope.payload.grantId !== 'string' ||
        !RECOVERY_GRANT_ID.test(value.envelope.payload.grantId)) {
        throw recoveryRecordCorrupt();
    }
    return `${rawDigest(`control-plane-recovery\0${value.envelope.payload.grantId}`).slice('sha256:'.length)}.json`;
}
function sameFileAfterRename(left, right, allowedLinkCounts) {
    return (sameInode(left, right) &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        allowedLinkCounts.includes(right.nlink) &&
        (right.mode & 0o777) === PRIVATE_FILE_MODE &&
        left.mtimeMs === right.mtimeMs &&
        ownedByCurrentUser(right));
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function sameInode(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function sameFileSnapshot(left, right, allowedLinkCounts) {
    return (sameInode(left, right) &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        allowedLinkCounts.includes(right.nlink) &&
        (right.mode & 0o777) === PRIVATE_FILE_MODE &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs &&
        ownedByCurrentUser(right));
}
function ownedByCurrentUser(stats) {
    return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}
function safeRealpath(filePath) {
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return null;
    }
}
function serializeRecord(value) {
    const bytes = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
        throw recoveryRecordCorrupt();
    return bytes;
}
function verifyRecordDigest(value) {
    if (!isDigest(value.recordDigest))
        return false;
    const { recordDigest, ...payload } = value;
    return recordDigest === canonicalDigest(payload);
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function exactIso(value, code) {
    if (typeof value !== 'string' ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw recoveryError(code, 'Recovery timestamp is not canonical UTC.');
    }
    return value;
}
function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw recoveryError(code, 'Recovery clock is invalid.');
    }
    return new Date(value.getTime());
}
function assertDigest(value, code) {
    if (!isDigest(value))
        throw recoveryError(code, 'Expected a SHA-256 digest.');
}
function assertIdentifier(value, code) {
    if (!isNonEmpty(value)) {
        throw recoveryError(code, 'Recovery identity is invalid.');
    }
}
function isNonEmpty(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 255 &&
        value.trim() === value &&
        !value.includes('\0') &&
        !value.includes('\n') &&
        !value.includes('\r'));
}
function isExactAbsolutePath(value) {
    return (typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        !value.includes('\0'));
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function canonicalDigest(value) {
    return rawDigest(canonicalJson(value));
}
function rawDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const nested of Object.values(value))
        deepFreeze(nested);
    return value;
}
function recoveryAlreadyConsumed() {
    return recoveryError('HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED', 'Recovery Grant is a consumed one-shot tombstone and cannot replay.', ExitCode.conflict);
}
function recoveryAlreadyFailed() {
    return recoveryError('HARNESS_RECOVERY_GRANT_FAILED', 'Recovery Grant terminalized after restart verification failed and cannot replay.', ExitCode.conflict);
}
function recoveryRecordCorrupt() {
    return recoveryError('HARNESS_RECOVERY_RECORD_CORRUPT', 'Persisted Recovery Grant or receipt failed canonical integrity verification.', ExitCode.verification);
}
function recoveryStateUnsafe() {
    return recoveryError('HARNESS_RECOVERY_STATE_UNSAFE', 'Recovery state must remain in exact private non-symlink storage.', ExitCode.unsafeEnvironment);
}
function recoveryError(code, message, exitCode = ExitCode.guard) {
    return workflowError(code, message, exitCode);
}
function isWorkflowCode(error) {
    return error instanceof Error && 'code' in error;
}
function isNodeCode(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code);
}
