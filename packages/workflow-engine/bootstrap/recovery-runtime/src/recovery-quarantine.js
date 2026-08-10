import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { assertRecoveryAuthorityDomain, } from './recovery-authority.js';
export const RECOVERY_QUARANTINE_ENTER_NAMESPACE = 'HARNESS_RECOVERY_ENTER_QUARANTINE_V1';
export const RECOVERY_QUARANTINE_RELEASE_NAMESPACE = 'HARNESS_RECOVERY_RELEASE_QUARANTINE_V1';
export const RECOVERY_QUARANTINE_GRANT_TTL_MS = 5 * 60 * 1000;
/**
 * Substrate only: these APIs persist signed quarantine state, but no production
 * launcher currently reads the marker and this module therefore does not by
 * itself fence workflow execution.
 */
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GRANT_ID = /^quarantine-(?:enter|release)-[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@+:/-]{0,511}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const TEMPORARY = /^\.([a-z0-9][a-z0-9-]*\.json)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
export function createRecoveryQuarantineEnterGrantPayload(input) {
    const common = normalizeCreationBinding(input);
    const payloadWithoutId = {
        kind: 'recovery-quarantine-enter-grant.v1',
        operation: 'enter-quarantine',
        ...common,
        expiresAt: expiresAt(common.issuedAt),
        uses: 1,
        oneShot: true,
    };
    return normalizeEnterPayload({
        ...payloadWithoutId,
        grantId: grantId('enter', payloadWithoutId),
    });
}
export function createRecoveryQuarantineReleaseGrantPayload(input) {
    const common = normalizeCreationBinding(input);
    assertDigest(input.activeMarkerDigest, 'RECOVERY_QUARANTINE_GRANT_INVALID');
    const payloadWithoutId = {
        kind: 'recovery-quarantine-release-grant.v1',
        operation: 'release-quarantine',
        ...common,
        activeMarkerDigest: input.activeMarkerDigest,
        expiresAt: expiresAt(common.issuedAt),
        uses: 1,
        oneShot: true,
    };
    return normalizeReleasePayload({
        ...payloadWithoutId,
        grantId: grantId('release', payloadWithoutId),
    });
}
export function canonicalRecoveryQuarantineGrantPayload(payload) {
    return canonicalJson(normalizeGrantPayload(payload));
}
export function executeRecoveryQuarantineEnter(storageRoot, envelope, dependencies) {
    const operation = beginOperation(storageRoot, envelope, dependencies, 'enter-quarantine');
    const payload = operation.payload;
    let record = operation.record;
    const marker = createMarker(payload, operation.reservation.envelopeDigest);
    if (record.terminal === null) {
        const observed = readRecoveryQuarantineMarker(storageRoot);
        if (observed !== null && observed.markerDigest !== marker.markerDigest) {
            throw quarantineError('RECOVERY_QUARANTINE_ALREADY_ACTIVE', 'A different Recovery Quarantine marker is already active.', ExitCode.conflict);
        }
        if (observed === null) {
            ensureImmutable(operation.paths.marker, marker, dependencies, 'marker-published');
        }
        dependencies.hooks?.afterPhase('marker-durable');
        record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
        if (record.receipt === null) {
            const receipt = createReceipt(payload, marker.markerDigest, operation.reservation.reservedAt);
            ensureImmutable(operation.paths.receipt, receipt, dependencies, 'receipt-published');
        }
        dependencies.hooks?.afterPhase('receipt-durable');
        record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
        if (record.receipt === null)
            throw stateCorrupt();
        if (record.terminal === null) {
            const terminal = createTerminal(payload, operation.reservation.envelopeDigest, record.receipt);
            ensureImmutable(operation.paths.terminal, terminal, dependencies, 'terminal-published');
        }
        dependencies.hooks?.afterPhase('terminal-durable');
    }
    record = finishAudit(operation, dependencies);
    if (record.receipt === null)
        throw stateCorrupt();
    return deepFreeze({
        marker,
        markerPath: operation.paths.marker,
        receipt: record.receipt,
        record,
    });
}
export function executeRecoveryQuarantineRelease(storageRoot, envelope, dependencies) {
    const operation = beginOperation(storageRoot, envelope, dependencies, 'release-quarantine', true);
    const payload = operation.payload;
    let record = operation.record;
    const claim = createReleaseClaim(payload, operation.reservation.envelopeDigest, operation.reservation.reservedAt);
    ensureImmutable(operation.paths.releaseClaim, claim, dependencies, 'release-claim-published');
    dependencies.hooks?.afterPhase('release-claim-durable');
    if (record.terminal === null) {
        const marker = requireExactActiveMarker(storageRoot, payload);
        const enterRecord = readRecoveryQuarantineGrantRecord(storageRoot, marker.enterGrantId);
        if (enterRecord.terminal === null) {
            throw quarantineError('RECOVERY_QUARANTINE_ENTER_NOT_TERMINAL', 'Recovery Quarantine cannot be released before its enter Grant is consumed.', ExitCode.conflict);
        }
        record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
        if (record.receipt === null) {
            const receipt = createReceipt(payload, marker.markerDigest, operation.reservation.reservedAt);
            ensureImmutable(operation.paths.receipt, receipt, dependencies, 'receipt-published');
        }
        dependencies.hooks?.afterPhase('receipt-durable');
        record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
        if (record.receipt === null)
            throw stateCorrupt();
        if (record.terminal === null) {
            const terminal = createTerminal(payload, operation.reservation.envelopeDigest, record.receipt);
            ensureImmutable(operation.paths.terminal, terminal, dependencies, 'terminal-published');
        }
        dependencies.hooks?.afterPhase('terminal-durable');
    }
    const active = readRecoveryQuarantineMarker(storageRoot);
    if (active?.markerDigest === payload.activeMarkerDigest) {
        unlinkExactMarker(operation.paths.marker, active);
    }
    dependencies.hooks?.afterPhase('release-durable');
    record = finishAudit(operation, dependencies);
    if (record.receipt === null)
        throw stateCorrupt();
    return deepFreeze({ receipt: record.receipt, record });
}
export function readRecoveryQuarantineMarker(storageRoot) {
    const paths = quarantinePaths(storageRoot, false);
    if (paths === null)
        return null;
    reconcileTemporaries(paths.state);
    if (!fs.lstatSync(paths.marker, { throwIfNoEntry: false }))
        return null;
    return normalizeMarker(readCanonicalFile(paths.marker, [1]));
}
export function readRecoveryQuarantineGrantRecord(storageRoot, grantIdValue) {
    if (!GRANT_ID.test(grantIdValue))
        throw grantInvalid();
    const paths = grantPaths(storageRoot, grantIdValue, false);
    if (paths === null)
        throw stateCorrupt();
    reconcileTemporaries(paths.grantDirectory);
    const reservation = normalizeReservation(readCanonicalFile(paths.reservation, [1]));
    if (reservation.grantId !== grantIdValue)
        throw stateCorrupt();
    const receipt = readOptional(paths.receipt, normalizeReceipt);
    const terminal = readOptional(paths.terminal, normalizeTerminal);
    const audit = readOptional(paths.audit, normalizeAudit);
    const auditAcknowledgement = readOptional(paths.auditAcknowledgement, normalizeAuditAcknowledgement);
    assertRecordChain(reservation, receipt, terminal, audit, auditAcknowledgement);
    return deepFreeze({
        state: auditAcknowledgement !== null
            ? 'audited'
            : terminal !== null
                ? 'consumed'
                : receipt !== null
                    ? 'receipt-durable'
                    : 'reserved',
        reservation,
        receipt,
        terminal,
        audit,
        auditAcknowledgement,
    });
}
function beginOperation(storageRoot, rawEnvelope, dependencies, expectedOperation, validateReleaseMarkerBeforeReservation = false) {
    assertDependencies(dependencies);
    const payload = verifyEnvelope(rawEnvelope, dependencies, expectedOperation);
    const exactEnvelope = deepFreeze({
        payload,
        signature: rawEnvelope.signature,
    });
    const observedPaths = grantPaths(storageRoot, payload, false);
    if (observedPaths !== null) {
        reconcileTemporaries(observedPaths.grantDirectory);
    }
    const reservationExists = observedPaths === null
        ? undefined
        : fs.lstatSync(observedPaths.reservation, { throwIfNoEntry: false });
    let existing = null;
    if (reservationExists) {
        existing = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
        if (canonicalJson(existing.reservation.envelope) !==
            canonicalJson(exactEnvelope)) {
            throw stateCorrupt();
        }
        if (existing.auditAcknowledgement !== null)
            throw alreadyConsumed();
    }
    else {
        assertGrantWindow(payload, dependencies.now);
        if (validateReleaseMarkerBeforeReservation) {
            requireExactActiveMarker(storageRoot, payload);
        }
    }
    const paths = grantPaths(storageRoot, payload, true);
    if (paths === null)
        throw stateCorrupt();
    reconcileTemporaries(paths.grantDirectory);
    const now = exactDate(dependencies.now);
    const reservation = existing?.reservation ??
        createReservation(exactEnvelope, now.toISOString());
    if (existing === null) {
        ensureImmutable(paths.reservation, reservation, dependencies, 'reservation-published');
    }
    dependencies.hooks?.afterPhase('reservation-durable');
    const record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
    if (record.auditAcknowledgement !== null)
        throw alreadyConsumed();
    return {
        storageRoot,
        payload,
        reservation: record.reservation,
        record,
        paths,
    };
}
function verifyEnvelope(envelope, dependencies, expectedOperation) {
    if (!isRecord(envelope) ||
        !hasExactKeys(envelope, ['payload', 'signature']) ||
        typeof envelope.signature !== 'string' ||
        envelope.signature.length === 0) {
        throw grantInvalid();
    }
    const payload = normalizeGrantPayload(envelope.payload);
    if (payload.operation !== expectedOperation) {
        throw quarantineError('RECOVERY_QUARANTINE_OPERATION_MISMATCH', 'Recovery Quarantine Grant cannot be replayed into another operation.', ExitCode.guard);
    }
    const descriptor = dependencies.authorityDescriptor;
    if (payload.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
        payload.authorityDescriptorDigest !== descriptor.descriptorDigest ||
        payload.authorityGeneration !== descriptor.generation ||
        payload.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
        payload.externalAuditRoot !== dependencies.externalAuditRoot ||
        payload.humanSigner !== descriptor.signer.identity ||
        payload.signerFingerprint !== descriptor.signer.fingerprint) {
        throw quarantineError('RECOVERY_QUARANTINE_AUTHORITY_BINDING_MISMATCH', 'Recovery Quarantine Grant does not bind the exact loaded Recovery Authority and runtime.', ExitCode.verification);
    }
    const namespace = payload.operation === 'enter-quarantine'
        ? RECOVERY_QUARANTINE_ENTER_NAMESPACE
        : RECOVERY_QUARANTINE_RELEASE_NAMESPACE;
    assertRecoveryAuthorityDomain(descriptor, dependencies.authorityExpectations, namespace, payload.signerFingerprint);
    let verified = false;
    try {
        verified = dependencies.verifyHumanSignature(canonicalJson(payload), envelope.signature, payload.humanSigner, namespace);
    }
    catch {
        verified = false;
    }
    if (!verified) {
        throw quarantineError('RECOVERY_QUARANTINE_SIGNATURE_INVALID', 'Recovery Quarantine Grant signature is invalid for its exact operation domain.', ExitCode.verification);
    }
    return deepFreeze(payload);
}
function finishAudit(operation, dependencies) {
    let record = readRecoveryQuarantineGrantRecord(operation.storageRoot, operation.payload.grantId);
    if (record.receipt === null || record.terminal === null)
        throw stateCorrupt();
    if (record.auditAcknowledgement !== null)
        return record;
    const audit = record.audit ??
        createAuditRecord(operation.payload, operation.reservation.envelopeDigest, record.receipt, record.terminal);
    if (record.audit === null) {
        ensureImmutable(operation.paths.audit, audit, dependencies, 'audit-published');
    }
    dependencies.appendAudit(audit);
    dependencies.hooks?.afterPhase('audit-appended');
    const acknowledgement = createAuditAcknowledgement(audit, audit.recordedAt);
    ensureImmutable(operation.paths.auditAcknowledgement, acknowledgement, dependencies, 'audit-ack-published');
    record = readRecoveryQuarantineGrantRecord(operation.storageRoot, operation.payload.grantId);
    if (record.auditAcknowledgement === null)
        throw stateCorrupt();
    return record;
}
function requireExactActiveMarker(storageRoot, payload) {
    const marker = readRecoveryQuarantineMarker(storageRoot);
    if (marker === null || marker.markerDigest !== payload.activeMarkerDigest) {
        throw quarantineError('RECOVERY_QUARANTINE_MARKER_MISMATCH', 'Release Grant does not bind the exact active Recovery Quarantine marker.', ExitCode.staleState);
    }
    return marker;
}
function createMarker(payload, envelopeDigest) {
    const markerPayload = {
        kind: 'recovery-quarantine-marker.v1',
        repositoryId: payload.repositoryId,
        authorityDescriptorDigest: payload.authorityDescriptorDigest,
        authorityGeneration: payload.authorityGeneration,
        recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
        externalAuditRoot: payload.externalAuditRoot,
        enterGrantId: payload.grantId,
        enterEnvelopeDigest: envelopeDigest,
        enteredAt: payload.issuedAt,
    };
    return deepFreeze({
        ...markerPayload,
        markerDigest: canonicalDigest(markerPayload),
    });
}
function createReservation(envelope, reservedAt) {
    const payload = normalizeGrantPayload(envelope.payload);
    const reservationPayload = {
        kind: 'recovery-quarantine-reservation.v1',
        grantId: payload.grantId,
        operation: payload.operation,
        envelope: structuredClone(envelope),
        envelopeDigest: canonicalDigest(envelope),
        reservedAt: exactIso(reservedAt, 'RECOVERY_QUARANTINE_RECORD_INVALID'),
    };
    return deepFreeze({
        ...reservationPayload,
        reservationDigest: canonicalDigest(reservationPayload),
    });
}
function createReceipt(payload, markerDigest, completedAt) {
    const receiptPayload = {
        kind: 'recovery-quarantine-receipt.v1',
        grantId: payload.grantId,
        operation: payload.operation,
        repositoryId: payload.repositoryId,
        authorityDescriptorDigest: payload.authorityDescriptorDigest,
        authorityGeneration: payload.authorityGeneration,
        recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
        externalAuditRoot: payload.externalAuditRoot,
        markerDigest,
        result: payload.operation === 'enter-quarantine'
            ? 'quarantine-entered'
            : 'quarantine-released',
        completedAt: exactIso(completedAt, 'RECOVERY_QUARANTINE_RECORD_INVALID'),
    };
    return deepFreeze({
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    });
}
function createTerminal(payload, envelopeDigest, receipt) {
    const terminalPayload = {
        kind: 'recovery-quarantine-terminal.v1',
        state: 'consumed',
        grantId: payload.grantId,
        operation: payload.operation,
        envelopeDigest,
        receiptDigest: receipt.receiptDigest,
        markerDigest: receipt.markerDigest,
        consumedAt: receipt.completedAt,
    };
    return deepFreeze({
        ...terminalPayload,
        terminalDigest: canonicalDigest(terminalPayload),
    });
}
function createReleaseClaim(payload, envelopeDigest, claimedAt) {
    const claimPayload = {
        kind: 'recovery-quarantine-release-claim.v1',
        markerDigest: payload.activeMarkerDigest,
        releaseGrantId: payload.grantId,
        releaseEnvelopeDigest: envelopeDigest,
        claimedAt,
    };
    return deepFreeze({
        ...claimPayload,
        claimDigest: canonicalDigest(claimPayload),
    });
}
function createAuditRecord(payload, envelopeDigest, receipt, terminal) {
    const event = receipt.result;
    const recordId = canonicalDigest({
        kind: 'recovery-quarantine-audit-id.v1',
        grantId: payload.grantId,
        event,
        receiptDigest: receipt.receiptDigest,
    });
    const auditPayload = {
        kind: 'recovery-quarantine-audit.v1',
        recordId,
        grantId: payload.grantId,
        operation: payload.operation,
        repositoryId: payload.repositoryId,
        authorityDescriptorDigest: payload.authorityDescriptorDigest,
        authorityGeneration: payload.authorityGeneration,
        recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
        externalAuditRoot: payload.externalAuditRoot,
        humanSigner: payload.humanSigner,
        signerFingerprint: payload.signerFingerprint,
        event,
        markerDigest: receipt.markerDigest,
        envelopeDigest,
        receiptDigest: receipt.receiptDigest,
        terminalDigest: terminal.terminalDigest,
        recordedAt: terminal.consumedAt,
    };
    return deepFreeze({
        ...auditPayload,
        recordDigest: canonicalDigest(auditPayload),
    });
}
function createAuditAcknowledgement(audit, acknowledgedAt) {
    const acknowledgementPayload = {
        kind: 'recovery-quarantine-audit-ack.v1',
        grantId: audit.grantId,
        recordId: audit.recordId,
        recordDigest: audit.recordDigest,
        acknowledgedAt: exactIso(acknowledgedAt, 'RECOVERY_QUARANTINE_RECORD_INVALID'),
    };
    return deepFreeze({
        ...acknowledgementPayload,
        acknowledgementDigest: canonicalDigest(acknowledgementPayload),
    });
}
function normalizeCreationBinding(input) {
    if (!isRecord(input) ||
        !isIdentifier(input.repositoryId) ||
        !isDigest(input.authorityDescriptorDigest) ||
        !Number.isSafeInteger(input.authorityGeneration) ||
        input.authorityGeneration < 1 ||
        !isDigest(input.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(input.externalAuditRoot) ||
        !isIdentifier(input.humanSigner) ||
        typeof input.signerFingerprint !== 'string' ||
        !FINGERPRINT.test(input.signerFingerprint)) {
        throw grantInvalid();
    }
    return {
        repositoryId: input.repositoryId,
        authorityDescriptorDigest: input.authorityDescriptorDigest,
        authorityGeneration: input.authorityGeneration,
        recoveryRuntimeDigest: input.recoveryRuntimeDigest,
        externalAuditRoot: input.externalAuditRoot,
        humanSigner: input.humanSigner,
        signerFingerprint: input.signerFingerprint,
        issuedAt: exactIso(input.issuedAt, 'RECOVERY_QUARANTINE_GRANT_INVALID'),
    };
}
function normalizeGrantPayload(raw) {
    if (!isRecord(raw))
        throw grantInvalid();
    if (raw.operation === 'enter-quarantine')
        return normalizeEnterPayload(raw);
    if (raw.operation === 'release-quarantine')
        return normalizeReleasePayload(raw);
    throw grantInvalid();
}
function normalizeEnterPayload(raw) {
    const keys = [
        'authorityDescriptorDigest',
        'authorityGeneration',
        'expiresAt',
        'externalAuditRoot',
        'grantId',
        'humanSigner',
        'issuedAt',
        'kind',
        'oneShot',
        'operation',
        'recoveryRuntimeDigest',
        'repositoryId',
        'signerFingerprint',
        'uses',
    ];
    if (!isRecord(raw) ||
        !hasExactKeys(raw, keys) ||
        raw.kind !== 'recovery-quarantine-enter-grant.v1' ||
        raw.operation !== 'enter-quarantine') {
        throw grantInvalid();
    }
    const common = normalizeGrantCommon(raw);
    const payloadWithoutId = {
        kind: 'recovery-quarantine-enter-grant.v1',
        operation: 'enter-quarantine',
        repositoryId: common.repositoryId,
        authorityDescriptorDigest: common.authorityDescriptorDigest,
        authorityGeneration: common.authorityGeneration,
        recoveryRuntimeDigest: common.recoveryRuntimeDigest,
        externalAuditRoot: common.externalAuditRoot,
        humanSigner: common.humanSigner,
        signerFingerprint: common.signerFingerprint,
        issuedAt: common.issuedAt,
        expiresAt: common.expiresAt,
        uses: 1,
        oneShot: true,
    };
    const expectedId = grantId('enter', payloadWithoutId);
    if (raw.grantId !== expectedId)
        throw grantInvalid();
    return { ...payloadWithoutId, grantId: expectedId };
}
function normalizeReleasePayload(raw) {
    const keys = [
        'activeMarkerDigest',
        'authorityDescriptorDigest',
        'authorityGeneration',
        'expiresAt',
        'externalAuditRoot',
        'grantId',
        'humanSigner',
        'issuedAt',
        'kind',
        'oneShot',
        'operation',
        'recoveryRuntimeDigest',
        'repositoryId',
        'signerFingerprint',
        'uses',
    ];
    if (!isRecord(raw) ||
        !hasExactKeys(raw, keys) ||
        raw.kind !== 'recovery-quarantine-release-grant.v1' ||
        raw.operation !== 'release-quarantine' ||
        !isDigest(raw.activeMarkerDigest)) {
        throw grantInvalid();
    }
    const common = normalizeGrantCommon(raw);
    const payloadWithoutId = {
        kind: 'recovery-quarantine-release-grant.v1',
        operation: 'release-quarantine',
        repositoryId: common.repositoryId,
        authorityDescriptorDigest: common.authorityDescriptorDigest,
        authorityGeneration: common.authorityGeneration,
        recoveryRuntimeDigest: common.recoveryRuntimeDigest,
        externalAuditRoot: common.externalAuditRoot,
        humanSigner: common.humanSigner,
        signerFingerprint: common.signerFingerprint,
        issuedAt: common.issuedAt,
        expiresAt: common.expiresAt,
        uses: 1,
        oneShot: true,
        activeMarkerDigest: raw.activeMarkerDigest,
    };
    const expectedId = grantId('release', payloadWithoutId);
    if (raw.grantId !== expectedId)
        throw grantInvalid();
    return { ...payloadWithoutId, grantId: expectedId };
}
function normalizeGrantCommon(raw) {
    if (!isIdentifier(raw.repositoryId) ||
        !isDigest(raw.authorityDescriptorDigest) ||
        !Number.isSafeInteger(raw.authorityGeneration) ||
        Number(raw.authorityGeneration) < 1 ||
        !isDigest(raw.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(raw.externalAuditRoot) ||
        !isIdentifier(raw.humanSigner) ||
        typeof raw.signerFingerprint !== 'string' ||
        !FINGERPRINT.test(raw.signerFingerprint) ||
        raw.uses !== 1 ||
        raw.oneShot !== true) {
        throw grantInvalid();
    }
    const issuedAt = exactIso(raw.issuedAt, 'RECOVERY_QUARANTINE_GRANT_INVALID');
    const expiresAtValue = exactIso(raw.expiresAt, 'RECOVERY_QUARANTINE_GRANT_INVALID');
    const ttl = Date.parse(expiresAtValue) - Date.parse(issuedAt);
    if (ttl <= 0 || ttl > RECOVERY_QUARANTINE_GRANT_TTL_MS) {
        throw quarantineError('RECOVERY_QUARANTINE_GRANT_TTL_INVALID', 'Recovery Quarantine Grant must have a positive lifetime of at most five minutes.', ExitCode.guard);
    }
    return {
        repositoryId: raw.repositoryId,
        authorityDescriptorDigest: raw.authorityDescriptorDigest,
        authorityGeneration: Number(raw.authorityGeneration),
        recoveryRuntimeDigest: raw.recoveryRuntimeDigest,
        externalAuditRoot: raw.externalAuditRoot,
        humanSigner: raw.humanSigner,
        signerFingerprint: raw.signerFingerprint,
        issuedAt,
        expiresAt: expiresAtValue,
    };
}
function normalizeMarker(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'authorityDescriptorDigest',
            'authorityGeneration',
            'enterEnvelopeDigest',
            'enterGrantId',
            'enteredAt',
            'externalAuditRoot',
            'kind',
            'markerDigest',
            'recoveryRuntimeDigest',
            'repositoryId',
        ]) ||
        raw.kind !== 'recovery-quarantine-marker.v1' ||
        !isIdentifier(raw.repositoryId) ||
        !isDigest(raw.authorityDescriptorDigest) ||
        !Number.isSafeInteger(raw.authorityGeneration) ||
        Number(raw.authorityGeneration) < 1 ||
        !isDigest(raw.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(raw.externalAuditRoot) ||
        typeof raw.enterGrantId !== 'string' ||
        !GRANT_ID.test(raw.enterGrantId) ||
        !raw.enterGrantId.startsWith('quarantine-enter-') ||
        !isDigest(raw.enterEnvelopeDigest) ||
        !isDigest(raw.markerDigest)) {
        throw stateCorrupt();
    }
    const enteredAt = exactIso(raw.enteredAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const { markerDigest, ...payload } = raw;
    if (markerDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return structuredClone({ ...raw, enteredAt });
}
function normalizeReservation(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'envelope',
            'envelopeDigest',
            'grantId',
            'kind',
            'operation',
            'reservationDigest',
            'reservedAt',
        ]) ||
        raw.kind !== 'recovery-quarantine-reservation.v1' ||
        !isRecord(raw.envelope) ||
        !hasExactKeys(raw.envelope, ['payload', 'signature']) ||
        typeof raw.envelope.signature !== 'string' ||
        raw.envelope.signature.length === 0 ||
        !isDigest(raw.envelopeDigest) ||
        !isDigest(raw.reservationDigest)) {
        throw stateCorrupt();
    }
    const payload = normalizeGrantPayload(raw.envelope.payload);
    if (raw.grantId !== payload.grantId ||
        raw.operation !== payload.operation ||
        raw.envelopeDigest !== canonicalDigest(raw.envelope)) {
        throw stateCorrupt();
    }
    const reservedAt = exactIso(raw.reservedAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const { reservationDigest, ...recordPayload } = raw;
    if (reservationDigest !== canonicalDigest(recordPayload))
        throw stateCorrupt();
    return structuredClone({
        ...raw,
        envelope: { payload, signature: raw.envelope.signature },
        reservedAt,
    });
}
function normalizeReceipt(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'authorityDescriptorDigest',
            'authorityGeneration',
            'completedAt',
            'externalAuditRoot',
            'grantId',
            'kind',
            'markerDigest',
            'operation',
            'receiptDigest',
            'recoveryRuntimeDigest',
            'repositoryId',
            'result',
        ]) ||
        raw.kind !== 'recovery-quarantine-receipt.v1' ||
        typeof raw.grantId !== 'string' ||
        !GRANT_ID.test(raw.grantId) ||
        !['enter-quarantine', 'release-quarantine'].includes(String(raw.operation)) ||
        !isIdentifier(raw.repositoryId) ||
        !isDigest(raw.authorityDescriptorDigest) ||
        !Number.isSafeInteger(raw.authorityGeneration) ||
        Number(raw.authorityGeneration) < 1 ||
        !isDigest(raw.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(raw.externalAuditRoot) ||
        !isDigest(raw.markerDigest) ||
        !['quarantine-entered', 'quarantine-released'].includes(String(raw.result)) ||
        !isDigest(raw.receiptDigest)) {
        throw stateCorrupt();
    }
    const completedAt = exactIso(raw.completedAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const { receiptDigest, ...payload } = raw;
    if (receiptDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return structuredClone({ ...raw, completedAt });
}
function normalizeTerminal(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'consumedAt',
            'envelopeDigest',
            'grantId',
            'kind',
            'markerDigest',
            'operation',
            'receiptDigest',
            'state',
            'terminalDigest',
        ]) ||
        raw.kind !== 'recovery-quarantine-terminal.v1' ||
        raw.state !== 'consumed' ||
        typeof raw.grantId !== 'string' ||
        !GRANT_ID.test(raw.grantId) ||
        !['enter-quarantine', 'release-quarantine'].includes(String(raw.operation)) ||
        !isDigest(raw.envelopeDigest) ||
        !isDigest(raw.receiptDigest) ||
        !isDigest(raw.markerDigest) ||
        !isDigest(raw.terminalDigest)) {
        throw stateCorrupt();
    }
    const consumedAt = exactIso(raw.consumedAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const { terminalDigest, ...payload } = raw;
    if (terminalDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return structuredClone({ ...raw, consumedAt });
}
function normalizeAudit(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'authorityDescriptorDigest',
            'authorityGeneration',
            'envelopeDigest',
            'event',
            'externalAuditRoot',
            'grantId',
            'humanSigner',
            'kind',
            'markerDigest',
            'operation',
            'receiptDigest',
            'recordDigest',
            'recordId',
            'recordedAt',
            'recoveryRuntimeDigest',
            'repositoryId',
            'signerFingerprint',
            'terminalDigest',
        ]) ||
        raw.kind !== 'recovery-quarantine-audit.v1' ||
        typeof raw.grantId !== 'string' ||
        !GRANT_ID.test(raw.grantId) ||
        !['enter-quarantine', 'release-quarantine'].includes(String(raw.operation)) ||
        !isIdentifier(raw.repositoryId) ||
        !isDigest(raw.authorityDescriptorDigest) ||
        !Number.isSafeInteger(raw.authorityGeneration) ||
        Number(raw.authorityGeneration) < 1 ||
        !isDigest(raw.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(raw.externalAuditRoot) ||
        !isIdentifier(raw.humanSigner) ||
        typeof raw.signerFingerprint !== 'string' ||
        !FINGERPRINT.test(raw.signerFingerprint) ||
        !['quarantine-entered', 'quarantine-released'].includes(String(raw.event)) ||
        !isDigest(raw.markerDigest) ||
        !isDigest(raw.envelopeDigest) ||
        !isDigest(raw.receiptDigest) ||
        !isDigest(raw.terminalDigest) ||
        !isDigest(raw.recordId) ||
        !isDigest(raw.recordDigest)) {
        throw stateCorrupt();
    }
    const operation = raw.operation;
    const event = raw.event;
    if ((operation === 'enter-quarantine' && event !== 'quarantine-entered') ||
        (operation === 'release-quarantine' && event !== 'quarantine-released') ||
        (operation === 'enter-quarantine' &&
            !raw.grantId.startsWith('quarantine-enter-')) ||
        (operation === 'release-quarantine' &&
            !raw.grantId.startsWith('quarantine-release-'))) {
        throw stateCorrupt();
    }
    const recordedAt = exactIso(raw.recordedAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const expectedRecordId = canonicalDigest({
        kind: 'recovery-quarantine-audit-id.v1',
        grantId: raw.grantId,
        event,
        receiptDigest: raw.receiptDigest,
    });
    if (raw.recordId !== expectedRecordId)
        throw stateCorrupt();
    const { recordDigest, ...payload } = raw;
    if (recordDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return structuredClone({
        ...raw,
        operation,
        event,
        recordedAt,
    });
}
function normalizeAuditAcknowledgement(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'acknowledgedAt',
            'acknowledgementDigest',
            'grantId',
            'kind',
            'recordDigest',
            'recordId',
        ]) ||
        raw.kind !== 'recovery-quarantine-audit-ack.v1' ||
        typeof raw.grantId !== 'string' ||
        !GRANT_ID.test(raw.grantId) ||
        !isDigest(raw.recordId) ||
        !isDigest(raw.recordDigest) ||
        !isDigest(raw.acknowledgementDigest)) {
        throw stateCorrupt();
    }
    const acknowledgedAt = exactIso(raw.acknowledgedAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const { acknowledgementDigest, ...payload } = raw;
    if (acknowledgementDigest !== canonicalDigest(payload)) {
        throw stateCorrupt();
    }
    return structuredClone({
        ...raw,
        acknowledgedAt,
    });
}
function normalizeReleaseClaim(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, [
            'claimDigest',
            'claimedAt',
            'kind',
            'markerDigest',
            'releaseEnvelopeDigest',
            'releaseGrantId',
        ]) ||
        raw.kind !== 'recovery-quarantine-release-claim.v1' ||
        !isDigest(raw.markerDigest) ||
        typeof raw.releaseGrantId !== 'string' ||
        !raw.releaseGrantId.startsWith('quarantine-release-') ||
        !GRANT_ID.test(raw.releaseGrantId) ||
        !isDigest(raw.releaseEnvelopeDigest) ||
        !isDigest(raw.claimDigest)) {
        throw stateCorrupt();
    }
    const claimedAt = exactIso(raw.claimedAt, 'RECOVERY_QUARANTINE_STATE_CORRUPT');
    const { claimDigest, ...payload } = raw;
    if (claimDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return structuredClone({
        ...raw,
        claimedAt,
    });
}
function assertRecordChain(reservation, receipt, terminal, audit, acknowledgement) {
    const payload = reservation.envelope.payload;
    const reservedAt = Date.parse(reservation.reservedAt);
    if (reservedAt < Date.parse(payload.issuedAt) ||
        reservedAt >= Date.parse(payload.expiresAt)) {
        throw stateCorrupt();
    }
    const expectedMarkerDigest = payload.operation === 'enter-quarantine'
        ? createMarker(payload, reservation.envelopeDigest).markerDigest
        : payload.activeMarkerDigest;
    if (receipt !== null) {
        if (Date.parse(receipt.completedAt) < reservedAt)
            throw stateCorrupt();
        const expectedReceipt = createReceipt(payload, expectedMarkerDigest, receipt.completedAt);
        if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
            throw stateCorrupt();
        }
    }
    if (terminal !== null) {
        if (receipt === null)
            throw stateCorrupt();
        const expectedTerminal = createTerminal(payload, reservation.envelopeDigest, receipt);
        if (canonicalJson(terminal) !== canonicalJson(expectedTerminal)) {
            throw stateCorrupt();
        }
    }
    if (audit !== null) {
        if (receipt === null || terminal === null)
            throw stateCorrupt();
        const expectedAudit = createAuditRecord(payload, reservation.envelopeDigest, receipt, terminal);
        if (canonicalJson(audit) !== canonicalJson(expectedAudit)) {
            throw stateCorrupt();
        }
    }
    if (acknowledgement !== null) {
        if (audit === null)
            throw stateCorrupt();
        if (Date.parse(acknowledgement.acknowledgedAt) < Date.parse(audit.recordedAt)) {
            throw stateCorrupt();
        }
        const expectedAcknowledgement = createAuditAcknowledgement(audit, acknowledgement.acknowledgedAt);
        if (canonicalJson(acknowledgement) !== canonicalJson(expectedAcknowledgement)) {
            throw stateCorrupt();
        }
    }
}
function quarantinePaths(storageRoot, create) {
    assertPrivateDirectory(storageRoot);
    const state = path.join(storageRoot, 'recovery-quarantine');
    if (create) {
        ensurePrivateDirectory(storageRoot, state);
    }
    else if (fs.lstatSync(state, { throwIfNoEntry: false }) === undefined) {
        return null;
    }
    else {
        assertPrivateDirectory(state);
    }
    const grants = path.join(state, 'grants');
    const releaseClaims = path.join(state, 'release-claims');
    if (create) {
        ensurePrivateDirectory(state, grants);
        ensurePrivateDirectory(state, releaseClaims);
    }
    else {
        assertDirectoryWhenPresent(grants);
        assertDirectoryWhenPresent(releaseClaims);
    }
    return {
        state,
        grants,
        releaseClaims,
        marker: path.join(state, 'active-marker.json'),
    };
}
function grantPaths(storageRoot, grant, create) {
    const grantIdValue = typeof grant === 'string' ? grant : grant.grantId;
    if (!GRANT_ID.test(grantIdValue))
        throw grantInvalid();
    const paths = quarantinePaths(storageRoot, create);
    if (paths === null)
        return null;
    if (!create) {
        if (fs.lstatSync(paths.grants, { throwIfNoEntry: false }) === undefined) {
            return null;
        }
        assertPrivateDirectory(paths.grants);
    }
    const grantDirectory = path.join(paths.grants, digestHex(grantIdValue));
    if (create) {
        ensurePrivateDirectory(paths.grants, grantDirectory);
    }
    else if (fs.lstatSync(grantDirectory, { throwIfNoEntry: false }) === undefined) {
        return null;
    }
    else {
        assertPrivateDirectory(grantDirectory);
    }
    const claimKey = typeof grant !== 'string' && grant.operation === 'release-quarantine'
        ? grant.activeMarkerDigest.slice('sha256:'.length)
        : digestHex(grantIdValue);
    return {
        ...paths,
        grantDirectory,
        reservation: path.join(grantDirectory, 'reservation.json'),
        receipt: path.join(grantDirectory, 'receipt.json'),
        terminal: path.join(grantDirectory, 'terminal.json'),
        audit: path.join(grantDirectory, 'audit.json'),
        auditAcknowledgement: path.join(grantDirectory, 'audit-ack.json'),
        releaseClaim: path.join(paths.releaseClaims, `${claimKey}.json`),
    };
}
function ensureImmutable(filePath, value, dependencies, publishedPhase) {
    const directory = path.dirname(filePath);
    assertPrivateDirectory(directory);
    assertAllowedTarget(directory, path.basename(filePath));
    reconcileTemporaries(directory);
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
        assertCanonicalEqual(readCanonicalFile(filePath, [1]), value);
        return;
    }
    const text = `${canonicalJson(value)}\n`;
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_RECORD_BYTES)
        throw stateCorrupt();
    const digest = digestHex(text.slice(0, -1));
    const temporary = path.join(directory, `.${path.basename(filePath)}.${digest}.${crypto.randomUUID()}.tmp`);
    writePrivateFile(temporary, bytes);
    fsyncDirectory(directory);
    try {
        fs.linkSync(temporary, filePath);
    }
    catch (error) {
        if (!isNodeCode(error, 'EEXIST'))
            throw storeUnsafe();
        reconcileTemporaries(directory);
        if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
            throw stateCorrupt();
        }
        assertCanonicalEqual(readCanonicalFile(filePath, [1]), value);
        return;
    }
    assertExactHardLinkPair(temporary, filePath);
    assertCanonicalEqual(readCanonicalFile(filePath, [2]), value);
    fsyncDirectory(directory);
    dependencies.hooks?.afterPhase(publishedPhase);
    unlinkExactAlias(temporary, filePath);
    fsyncDirectory(directory);
    assertCanonicalEqual(readCanonicalFile(filePath, [1]), value);
}
/**
 * Reconcile only the exact hard-link publish window. Unlinked preparations,
 * incomplete files, and unrelated residue are preserved and never promoted.
 */
function reconcileTemporaries(directory) {
    assertPrivateDirectory(directory);
    for (const name of fs.readdirSync(directory).sort()) {
        const match = TEMPORARY.exec(name);
        if (match === null)
            continue;
        const targetName = match[1];
        const temporary = path.join(directory, name);
        assertAllowedTarget(directory, targetName);
        const inspected = inspectTemporary(temporary);
        if (inspected === null)
            continue;
        const { value, stats } = inspected;
        if (digestHex(canonicalJson(value)) !== match[2])
            throw stateCorrupt();
        validateTargetRecord(targetName, value);
        const target = path.join(directory, targetName);
        const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (targetStats === undefined) {
            if (stats.nlink !== 1)
                throw stateCorrupt();
            continue;
        }
        if (sameInode(stats, targetStats)) {
            assertExactHardLinkPair(temporary, target);
            assertCanonicalEqual(readCanonicalFile(target, [2]), value);
            unlinkExactAlias(temporary, target);
            fsyncDirectory(directory);
            continue;
        }
        if (stats.nlink !== 1)
            throw stateCorrupt();
        if (targetStats.nlink === 1) {
            const targetValue = readCanonicalFile(target, [1]);
            if (canonicalJson(targetValue) === canonicalJson(value)) {
                fs.unlinkSync(temporary);
                fsyncDirectory(directory);
            }
        }
    }
}
function inspectTemporary(filePath) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (before === undefined)
        return null;
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        ![1, 2].includes(before.nlink) ||
        (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !ownedByCurrentUser(before) ||
        safeRealpath(filePath) !== filePath ||
        before.size > MAX_RECORD_BYTES) {
        throw stateCorrupt();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const openedBefore = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(before, openedBefore, [1, 2]))
            throw stateCorrupt();
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(openedBefore, openedAfter, [1, 2])) {
            throw stateCorrupt();
        }
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!text.endsWith('\n'))
                return null;
            const value = JSON.parse(text);
            if (`${canonicalJson(value)}\n` !== text)
                return null;
            return { value, stats: openedAfter };
        }
        catch (error) {
            if (hasWorkflowCode(error, 'RECOVERY_QUARANTINE_STATE_CORRUPT')) {
                throw error;
            }
            return null;
        }
    }
    catch (error) {
        if (hasWorkflowCode(error))
            throw error;
        throw stateCorrupt();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function readCanonicalFile(filePath, allowedLinkCounts) {
    if (!isExactAbsolutePath(filePath))
        throw stateCorrupt();
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (before === undefined ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        !allowedLinkCounts.includes(before.nlink) ||
        (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !ownedByCurrentUser(before) ||
        safeRealpath(filePath) !== filePath ||
        before.size > MAX_RECORD_BYTES) {
        throw stateCorrupt();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const openedBefore = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
            throw stateCorrupt();
        }
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
            throw stateCorrupt();
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.endsWith('\n'))
            throw stateCorrupt();
        const value = JSON.parse(text);
        if (`${canonicalJson(value)}\n` !== text)
            throw stateCorrupt();
        return value;
    }
    catch (error) {
        if (hasWorkflowCode(error))
            throw error;
        throw stateCorrupt();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function readOptional(filePath, normalize) {
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
        return null;
    }
    return normalize(readCanonicalFile(filePath, [1]));
}
function unlinkExactMarker(markerPath, expected) {
    const before = fs.lstatSync(markerPath, { throwIfNoEntry: false });
    if (before === undefined)
        return;
    const observed = normalizeMarker(readCanonicalFile(markerPath, [1]));
    if (canonicalJson(observed) !== canonicalJson(expected))
        throw stateCorrupt();
    const immediatelyBefore = fs.lstatSync(markerPath, { throwIfNoEntry: false });
    if (immediatelyBefore === undefined ||
        !sameFileSnapshot(before, immediatelyBefore, [1])) {
        throw stateCorrupt();
    }
    fs.unlinkSync(markerPath);
    fsyncDirectory(path.dirname(markerPath));
}
function assertDependencies(dependencies) {
    if (!isRecord(dependencies) ||
        !isExactAbsolutePath(dependencies.externalAuditRoot) ||
        !(dependencies.now instanceof Date) ||
        !Number.isFinite(dependencies.now.getTime()) ||
        typeof dependencies.verifyHumanSignature !== 'function' ||
        typeof dependencies.appendAudit !== 'function' ||
        (dependencies.hooks !== undefined &&
            (!isRecord(dependencies.hooks) ||
                !hasExactKeys(dependencies.hooks, ['afterPhase']) ||
                typeof dependencies.hooks.afterPhase !== 'function'))) {
        throw quarantineError('RECOVERY_QUARANTINE_DEPENDENCIES_INVALID', 'Recovery Quarantine requires exact out-of-band authority, time, signature, and audit dependencies.', ExitCode.unsafeEnvironment);
    }
}
function assertGrantWindow(payload, nowValue) {
    const now = exactDate(nowValue).getTime();
    const issuedAtValue = Date.parse(payload.issuedAt);
    const expiresAtValue = Date.parse(payload.expiresAt);
    if (now < issuedAtValue) {
        throw quarantineError('RECOVERY_QUARANTINE_GRANT_NOT_YET_VALID', 'Recovery Quarantine Grant is not yet valid.', ExitCode.staleState);
    }
    if (now >= expiresAtValue) {
        throw quarantineError('RECOVERY_QUARANTINE_GRANT_EXPIRED', 'Recovery Quarantine Grant has expired.', ExitCode.staleState);
    }
}
function exactDate(value) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw quarantineError('RECOVERY_QUARANTINE_TIME_INVALID', 'Recovery Quarantine requires a valid injected time.', ExitCode.unsafeEnvironment);
    }
    return new Date(value.getTime());
}
function expiresAt(issuedAt) {
    const timestamp = Date.parse(exactIso(issuedAt, 'RECOVERY_QUARANTINE_GRANT_INVALID'));
    const result = new Date(timestamp + RECOVERY_QUARANTINE_GRANT_TTL_MS);
    if (!Number.isFinite(result.getTime()))
        throw grantInvalid();
    return result.toISOString();
}
function grantId(kind, value) {
    return `quarantine-${kind}-${digestHex(canonicalJson(value))}`;
}
function canonicalDigest(value) {
    return `sha256:${digestHex(canonicalJson(value))}`;
}
function digestHex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function assertDigest(value, code) {
    if (!isDigest(value)) {
        throw quarantineError(code, 'Recovery Quarantine digest is malformed.', ExitCode.guard);
    }
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isIdentifier(value) {
    return typeof value === 'string' && IDENTIFIER.test(value);
}
function isExactAbsolutePath(value) {
    return (typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.resolve(value) === value);
}
function exactIso(value, code) {
    if (typeof value !== 'string') {
        throw quarantineError(code, 'Recovery Quarantine timestamp is malformed.', ExitCode.guard);
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString() !== value) {
        throw quarantineError(code, 'Recovery Quarantine timestamp is malformed.', ExitCode.guard);
    }
    return value;
}
function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null));
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index]));
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        deepFreeze(nested);
    }
    return Object.freeze(value);
}
function assertAllowedTarget(directory, targetName) {
    const parent = path.basename(directory);
    const grandparent = path.basename(path.dirname(directory));
    const allowed = parent === 'recovery-quarantine'
        ? targetName === 'active-marker.json'
        : grandparent === 'grants'
            ? [
                'audit-ack.json',
                'audit.json',
                'receipt.json',
                'reservation.json',
                'terminal.json',
            ].includes(targetName)
            : parent === 'release-claims'
                ? /^[0-9a-f]{64}\.json$/.test(targetName)
                : false;
    if (!allowed)
        throw stateCorrupt();
}
function validateTargetRecord(targetName, value) {
    if (targetName === 'active-marker.json') {
        normalizeMarker(value);
    }
    else if (targetName === 'reservation.json') {
        normalizeReservation(value);
    }
    else if (targetName === 'receipt.json') {
        normalizeReceipt(value);
    }
    else if (targetName === 'terminal.json') {
        normalizeTerminal(value);
    }
    else if (targetName === 'audit.json') {
        normalizeAudit(value);
    }
    else if (targetName === 'audit-ack.json') {
        normalizeAuditAcknowledgement(value);
    }
    else if (/^[0-9a-f]{64}\.json$/.test(targetName)) {
        const claim = normalizeReleaseClaim(value);
        if (`${claim.markerDigest.slice('sha256:'.length)}.json` !== targetName) {
            throw stateCorrupt();
        }
    }
    else {
        throw stateCorrupt();
    }
}
function assertCanonicalEqual(observed, expected) {
    if (canonicalJson(observed) !== canonicalJson(expected))
        throw stateCorrupt();
}
function writePrivateFile(filePath, bytes) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        let offset = 0;
        while (offset < bytes.length) {
            const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
            if (written < 1)
                throw storeUnsafe();
            offset += written;
        }
        fs.fsyncSync(descriptor);
    }
    catch (error) {
        if (hasWorkflowCode(error))
            throw error;
        throw storeUnsafe();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function ensurePrivateDirectory(parent, directory) {
    assertPrivateDirectory(parent);
    if (path.dirname(directory) !== parent)
        throw storeUnsafe();
    if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
        try {
            fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
            fsyncDirectory(parent);
        }
        catch (error) {
            if (!isNodeCode(error, 'EEXIST'))
                throw storeUnsafe();
        }
    }
    assertPrivateDirectory(directory);
}
function assertDirectoryWhenPresent(directory) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
        assertPrivateDirectory(directory);
    }
}
function assertPrivateDirectory(directory) {
    if (!isExactAbsolutePath(directory))
        throw storeUnsafe();
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !ownedByCurrentUser(stats) ||
        safeRealpath(directory) !== directory) {
        throw storeUnsafe();
    }
}
function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(descriptor);
    }
    catch (error) {
        if (hasWorkflowCode(error))
            throw error;
        throw storeUnsafe();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function assertExactHardLinkPair(leftPath, rightPath) {
    const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
    const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
    if (left === undefined ||
        right === undefined ||
        !sameInode(left, right) ||
        left.nlink !== 2 ||
        right.nlink !== 2) {
        throw stateCorrupt();
    }
}
function unlinkExactAlias(alias, anchor) {
    assertExactHardLinkPair(alias, anchor);
    fs.unlinkSync(alias);
    const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
    if (anchorStats === undefined || anchorStats.nlink !== 1)
        throw stateCorrupt();
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
function quarantineError(code, message, exitCode) {
    return workflowError(code, message, exitCode);
}
function grantInvalid() {
    return quarantineError('RECOVERY_QUARANTINE_GRANT_INVALID', 'Recovery Quarantine Grant does not match its exact schema or intrinsic bindings.', ExitCode.guard);
}
function stateCorrupt() {
    return quarantineError('RECOVERY_QUARANTINE_STATE_CORRUPT', 'Recovery Quarantine durable state failed integrity verification.', ExitCode.verification);
}
function storeUnsafe() {
    return quarantineError('RECOVERY_QUARANTINE_STORE_UNSAFE', 'Recovery Quarantine durable store is unavailable or unsafe.', ExitCode.unsafeEnvironment);
}
function alreadyConsumed() {
    return quarantineError('RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED', 'Recovery Quarantine Grant is one-shot and has already been consumed.', ExitCode.conflict);
}
function hasWorkflowCode(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        (code === undefined || error.code === code));
}
function isNodeCode(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code);
}
