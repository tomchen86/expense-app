import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError } from './foundation/errors/errors.js';
import { publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from './filesystem-safety.js';
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREPARED_LOCK_ALIAS = /^append\.lock\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const LOCK_RECLAIM_CLAIM = /^append\.lock\.reclaim\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const FINAL_RECORD_NAME = /^([0-9]{16})-([0-9a-f]{64})\.json$/;
const PUBLICATION_RECORD_NAME = /^\.([0-9]{16})-([0-9a-f]{64})\.json\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;
const PRIVATE_PUBLICATION_NAME = /^\.(.+)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;
const MAX_PATH_BYTES = 4_096;
const MAX_REPOSITORY_ID_BYTES = 512;
const MAX_RECORD_BYTES = 4_096;
const MAX_METADATA_BYTES = 32_768;
const MAX_ANCHOR_BACKEND_RECEIPT_BYTES = 16_384;
const MAX_DESTRUCTION_SIGNATURE_BYTES = 8_192;
const AUDIT_DESTRUCTION_GRANT_MAX_TTL_MS = 10 * 60 * 1_000;
const AUDIT_EVENT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const LOCK_NAME = 'append.lock';
const PROFILE_STATE_NAME = 'profile.json';
const PROTECTED_CONFIGURATION_NAME = 'protected-configuration.json';
const RETENTION_CHECKPOINT_NAME = 'retention-checkpoint.json';
const RETENTION_CHECKPOINT_NEXT_NAME = 'retention-checkpoint.next.json';
const MAINTENANCE_JOURNAL_NAME = 'maintenance-journal.json';
const RECORD_KEYS = [
    'candidateBundleDigest',
    'eventType',
    'grantDigest',
    'idempotencyKey',
    'kind',
    'occurredAt',
    'poststateDigest',
    'prestateDigest',
    'previousRecordDigest',
    'repositoryId',
    'result',
    'resultDigest',
    'schemaVersion',
    'sequence',
];
const APPEND_INPUT_KEYS = [
    'candidateBundleDigest',
    'eventType',
    'grantDigest',
    'idempotencyKey',
    'occurredAt',
    'poststateDigest',
    'prestateDigest',
    'result',
    'resultDigest',
];
const SCOPE_KEYS = [
    'externalAuditRoot',
    'repositoryId',
    'repositoryRoot',
];
const PROFILE_STATE_KEYS = [
    'kind',
    'policyDigest',
    'policyVersion',
    'profile',
    'repositoryId',
    'schemaVersion',
];
const PROTECTED_CONFIGURATION_KEYS = [
    'backendId',
    'backendRoot',
    'configurationDigest',
    'destructionPublicKeyDigest',
    'destructionPublicKeyPem',
    'kind',
    'repositoryId',
    'schemaVersion',
];
const FILESYSTEM_WORM_RECEIPT_KEYS = [
    'backendId',
    'kind',
    'objectName',
    'payloadDigest',
    'repositoryId',
    'schemaVersion',
];
const RETENTION_CHECKPOINT_KEYS = [
    'grantDigest',
    'kind',
    'policyDigest',
    'previousCheckpointDigest',
    'profile',
    'prunedAt',
    'prunedThroughRecordDigest',
    'prunedThroughSequence',
    'reason',
    'repositoryId',
    'schemaVersion',
    'tombstoneDigest',
];
const MAINTENANCE_JOURNAL_KEYS = [
    'checkpoint',
    'checkpointDigest',
    'kind',
    'repositoryId',
    'schemaVersion',
    'tombstone',
    'tombstoneDigest',
];
const ANCHOR_RECEIPT_KEYS = [
    'anchoredAt',
    'backendId',
    'backendReceipt',
    'headRecordDigest',
    'headSequence',
    'kind',
    'policyDigest',
    'profile',
    'repositoryId',
    'schemaVersion',
];
const DESTRUCTION_PAYLOAD_KEYS = [
    'domain',
    'expectedHeadRecordDigest',
    'expectedHeadSequence',
    'expiresAt',
    'grantId',
    'issuedAt',
    'kind',
    'profile',
    'reasonDigest',
    'remoteAnchorDisposition',
    'repositoryId',
    'schemaVersion',
    'signerIdentity',
    'throughRecordDigest',
    'throughSequence',
    'uses',
];
const DESTRUCTION_ENVELOPE_KEYS = [
    'kind',
    'payload',
    'schemaVersion',
    'signature',
];
const DESTRUCTION_TOMBSTONE_KEYS = [
    'destroyedAt',
    'destroyedThroughRecordDigest',
    'destroyedThroughSequence',
    'expectedHeadRecordDigest',
    'expectedHeadSequence',
    'grantDigest',
    'grantEnvelope',
    'kind',
    'previousCheckpointDigest',
    'reasonDigest',
    'remoteAnchorDisposition',
    'repositoryId',
    'schemaVersion',
    'signerIdentity',
];
const LOCK_KEYS = [
    'kind',
    'ownerToken',
    'pid',
    'repositoryId',
    'schemaVersion',
];
export const AUTHORITY_AUDIT_EVENT_TYPES = Object.freeze([
    'abort',
    'apply-grant',
    'branch-update',
    'candidate-bundle',
    'cas',
    'command',
    'control-plane-grant',
    'error',
    'escalation-request',
    'external-effect',
    'file-change',
    'grant-consume',
    'poststate',
    'provider-invocation',
    'recovery',
    'revoke',
    'rollback',
    'supersede',
    'task-mandate',
]);
export const AUTHORITY_AUDIT_RESULTS = Object.freeze([
    'aborted',
    'failed',
    'recorded',
    'revoked',
    'rolled-back',
    'succeeded',
    'superseded',
]);
export const AUTHORITY_AUDIT_PROFILE_POLICIES = deepFreeze({
    development: {
        schemaVersion: 1,
        profile: 'development',
        maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
        minimumRecentRecords: 20,
        anchorMode: 'none',
        destructionMode: 'automatic-retention-only',
    },
    protected: {
        schemaVersion: 1,
        profile: 'protected',
        maxAgeMs: null,
        minimumRecentRecords: null,
        anchorMode: 'backend-receipt',
        destructionMode: 'exact-human-grant-with-tombstone',
    },
});
export function deriveAuthorityAuditRepositoryId(repositoryIdentity) {
    if (typeof repositoryIdentity !== 'string' ||
        repositoryIdentity.length === 0 ||
        repositoryIdentity.trim() !== repositoryIdentity ||
        Buffer.byteLength(repositoryIdentity) > MAX_REPOSITORY_ID_BYTES ||
        [...repositoryIdentity].some((character) => {
            const point = character.codePointAt(0) ?? 0;
            return point <= 31 || (point >= 127 && point <= 159);
        })) {
        throw invalidScope();
    }
    return sha256Digest(canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-repository.v1',
        repositoryIdentity,
    }));
}
export function authorityAuditLedgerPaths(scope) {
    const checked = assertScope(scope);
    return ledgerPathsForScope(checked);
}
export function configureProtectedAuthorityAuditLedger(scope, input) {
    const prepared = prepareLedger({ ...scope, profile: 'protected' });
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    const backendRoot = assertProtectedBackendRoot(input.backendRoot, prepared.scope);
    const destructionPublicKeyPem = canonicalDestructionPublicKey(input.destructionPublicKeyPem);
    const core = {
        schemaVersion: 1,
        kind: 'authority-audit-protected-configuration.v1',
        repositoryId: prepared.scope.repositoryId,
        backendId: 'filesystem-worm.v1',
        backendRoot,
        destructionPublicKeyPem,
        destructionPublicKeyDigest: sha256Digest(destructionPublicKeyPem),
    };
    const configuration = deepFreeze({
        ...core,
        configurationDigest: sha256Digest(canonicalJson(core)),
    });
    const bytes = canonicalProtectedConfiguration(configuration);
    const existing = fs.lstatSync(prepared.paths.protectedConfiguration, {
        throwIfNoEntry: false,
    });
    if (existing !== undefined) {
        const stored = readProtectedConfiguration(prepared.paths);
        if (canonicalProtectedConfiguration(stored) !== bytes) {
            throw protectedConfigurationMismatch();
        }
        return stored;
    }
    if (fs.readdirSync(prepared.paths.events).length > 0 ||
        fs.readdirSync(prepared.paths.records).length > 0 ||
        fs.readdirSync(prepared.paths.anchors).length > 0 ||
        fs.readdirSync(prepared.paths.tombstones).length > 0 ||
        fs.lstatSync(prepared.paths.retentionCheckpoint, {
            throwIfNoEntry: false,
        }) ||
        fs.lstatSync(prepared.paths.maintenanceJournal, { throwIfNoEntry: false })) {
        throw protectedConfigurationMismatch();
    }
    writeExclusivePrivateFile(prepared.paths.protectedConfiguration, bytes, protectedConfigurationInvalid);
    fsyncDirectory(prepared.paths.metadata);
    return readProtectedConfiguration(prepared.paths);
}
export function readProtectedAuthorityAuditConfiguration(scope) {
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    return readProtectedConfiguration(prepared.paths);
}
export function createPinnedAuthorityAuditAnchorBackend(scope) {
    const configuration = readProtectedAuthorityAuditConfiguration(scope);
    const backendPaths = ensureFilesystemWormBackend(configuration);
    return Object.freeze({
        backendId: configuration.backendId,
        publish(canonicalPayload) {
            const payloadDigest = sha256Digest(canonicalPayload);
            const objectName = `${payloadDigest.slice('sha256:'.length)}.anchor`;
            recoverPrivateFilePublications(backendPaths.anchors, (name) => /^[0-9a-f]{64}\.anchor$/.test(name), anchorBackendInvalid);
            publishImmutableObject(path.join(backendPaths.anchors, objectName), canonicalPayload, anchorBackendInvalid);
            fsyncDirectory(backendPaths.anchors);
            return canonicalJson({
                schemaVersion: 1,
                kind: 'authority-audit-filesystem-worm-receipt.v1',
                repositoryId: configuration.repositoryId,
                backendId: configuration.backendId,
                payloadDigest,
                objectName,
            });
        },
        verify(canonicalPayload, backendReceipt) {
            try {
                recoverPrivateFilePublications(backendPaths.anchors, (name) => /^[0-9a-f]{64}\.anchor$/.test(name), anchorBackendInvalid);
                const raw = JSON.parse(backendReceipt);
                if (!isPlainRecord(raw) ||
                    !hasExactKeys(raw, FILESYSTEM_WORM_RECEIPT_KEYS) ||
                    raw.schemaVersion !== 1 ||
                    raw.kind !== 'authority-audit-filesystem-worm-receipt.v1' ||
                    raw.repositoryId !== configuration.repositoryId ||
                    raw.backendId !== configuration.backendId ||
                    typeof raw.objectName !== 'string' ||
                    !/^[0-9a-f]{64}\.anchor$/.test(raw.objectName) ||
                    backendReceipt !== canonicalJson(raw)) {
                    return false;
                }
                const payloadDigest = assertDigest(raw.payloadDigest, anchorInvalid);
                if (payloadDigest !== sha256Digest(canonicalPayload) ||
                    raw.objectName !== `${payloadDigest.slice('sha256:'.length)}.anchor`) {
                    return false;
                }
                return (readExactPrivateFile(path.join(backendPaths.anchors, raw.objectName), MAX_METADATA_BYTES, anchorBackendInvalid) === canonicalPayload);
            }
            catch {
                return false;
            }
        },
    });
}
export function createPinnedAuditDestructionSignatureVerifier(scope) {
    const configuration = readProtectedAuthorityAuditConfiguration(scope);
    const publicKey = crypto.createPublicKey(configuration.destructionPublicKeyPem);
    return (input) => {
        try {
            return crypto.verify(null, Buffer.from(input.payload), publicKey, Buffer.from(input.signature, 'base64'));
        }
        catch {
            return false;
        }
    };
}
function ledgerPathsForScope(checked) {
    const namespace = checked.repositoryId.slice('sha256:'.length);
    const repositories = path.join(checked.externalAuditRoot, 'repositories');
    const repository = path.join(repositories, namespace);
    const metadata = path.join(repository, 'metadata');
    return Object.freeze({
        externalAuditRoot: checked.externalAuditRoot,
        repositories,
        repository,
        events: path.join(repository, 'events'),
        records: path.join(repository, 'records'),
        locks: path.join(repository, 'locks'),
        appendLock: path.join(repository, 'locks', LOCK_NAME),
        metadata,
        profileState: path.join(metadata, PROFILE_STATE_NAME),
        protectedConfiguration: path.join(metadata, PROTECTED_CONFIGURATION_NAME),
        retentionCheckpoint: path.join(metadata, RETENTION_CHECKPOINT_NAME),
        retentionCheckpointNext: path.join(metadata, RETENTION_CHECKPOINT_NEXT_NAME),
        maintenanceJournal: path.join(metadata, MAINTENANCE_JOURNAL_NAME),
        anchors: path.join(metadata, 'anchors'),
        tombstones: path.join(metadata, 'tombstones'),
    });
}
export function appendAuthorityAuditRecord(scope, rawInput, options = {}) {
    const input = assertAppendInput(rawInput);
    const maintenanceDate = options.now?.() ?? new Date();
    if (!(maintenanceDate instanceof Date) ||
        !Number.isFinite(maintenanceDate.getTime())) {
        throw maintenanceInvalid();
    }
    const maintenanceNow = assertMaintenanceTimestamp(maintenanceDate.toISOString());
    if (Date.parse(input.occurredAt) >
        Date.parse(maintenanceNow) + AUDIT_EVENT_MAX_FUTURE_SKEW_MS) {
        throw invalidRecord();
    }
    const prepared = prepareLedger(scope);
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const checkpoint = readRetentionCheckpoint(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const records = scanRecords(prepared.paths, prepared.scope.repositoryId, false, checkpoint);
        const duplicate = records.find(({ record }) => record.idempotencyKey === input.idempotencyKey);
        if (duplicate !== undefined) {
            if (!recordMatchesInput(duplicate.record, input)) {
                throw idempotencyConflict();
            }
            return duplicate;
        }
        const previous = records.at(-1);
        const previousSequence = previous?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0;
        const previousDigest = previous?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null;
        const record = freezeRecord({
            schemaVersion: 1,
            kind: 'authority-audit-record.v1',
            repositoryId: prepared.scope.repositoryId,
            sequence: previousSequence + 1,
            occurredAt: input.occurredAt,
            eventType: input.eventType,
            idempotencyKey: input.idempotencyKey,
            previousRecordDigest: previousDigest,
            grantDigest: input.grantDigest,
            candidateBundleDigest: input.candidateBundleDigest,
            prestateDigest: input.prestateDigest,
            poststateDigest: input.poststateDigest,
            result: input.result,
            resultDigest: input.resultDigest,
        });
        const content = canonicalRecordContent(record);
        const entry = freezeEntry({
            recordDigest: sha256Digest(content),
            record,
        });
        publishRecord(prepared.paths, entry, content, options);
        if (prepared.profile === 'development') {
            compactDevelopmentUnderLock(prepared, maintenanceNow);
        }
        return entry;
    });
}
export function scanAuthorityAuditLedger(scope) {
    const prepared = prepareLedger(scope);
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const checkpoint = readRetentionCheckpoint(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const records = scanRecords(prepared.paths, prepared.scope.repositoryId, false, checkpoint);
        const head = records.at(-1);
        return Object.freeze({
            repositoryId: prepared.scope.repositoryId,
            profile: prepared.profile,
            recordCount: records.length,
            prunedRecordCount: checkpoint?.prunedThroughSequence ?? 0,
            headSequence: head?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0,
            headRecordDigest: head?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null,
            records: Object.freeze(records),
        });
    });
}
/**
 * Runs the code-owned development retention policy. The live suffix remains
 * hash-linked to a compact checkpoint; expired event objects and records are
 * physically removed. A durable journal makes every crash window converge to
 * that same checkpoint before normal append/scan work resumes.
 */
export function compactDevelopmentAuthorityAuditLedger(scope, input, hooks = {}) {
    const now = assertMaintenanceTimestamp(input.now);
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'development')
        throw protectedProfile();
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        return compactDevelopmentUnderLock(prepared, now, hooks);
    });
}
function compactDevelopmentUnderLock(prepared, now, hooks = {}) {
    if (prepared.profile !== 'development')
        throw protectedProfile();
    const previousCheckpoint = readRetentionCheckpoint(prepared.paths, prepared.scope.repositoryId, prepared.profile);
    const records = scanRecords(prepared.paths, prepared.scope.repositoryId, false, previousCheckpoint);
    const policy = AUTHORITY_AUDIT_PROFILE_POLICIES.development;
    const maximumPrunable = Math.max(0, records.length - policy.minimumRecentRecords);
    const cutoff = Date.parse(now) - policy.maxAgeMs;
    let count = 0;
    while (count < maximumPrunable &&
        Date.parse(records[count].record.occurredAt) <= cutoff) {
        count += 1;
    }
    if (count === 0) {
        return compactionResult('development', 0, records.length, previousCheckpoint);
    }
    const target = records[count - 1];
    const checkpoint = createRetentionCheckpoint({
        repositoryId: prepared.scope.repositoryId,
        profile: 'development',
        prunedThroughSequence: target.record.sequence,
        prunedThroughRecordDigest: target.recordDigest,
        prunedAt: now,
        reason: 'development-retention',
        grantDigest: null,
        tombstoneDigest: null,
        previousCheckpoint,
    });
    const journal = createMaintenanceJournal(checkpoint, null);
    executeAuditMaintenance(prepared.paths, journal, hooks);
    return compactionResult('development', count, records.length - count, checkpoint);
}
export function anchorProtectedAuthorityAuditLedger(scope, input) {
    const anchoredAt = assertMaintenanceTimestamp(input.anchoredAt);
    const backend = assertAnchorBackend(input.backend);
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const scan = scanLedgerUnderLock(prepared);
        if (scan.headRecordDigest === null || scan.headSequence < 1) {
            throw anchorInvalid();
        }
        const payload = canonicalAnchorPayload({
            repositoryId: prepared.scope.repositoryId,
            policyDigest: authorityAuditPolicyDigest('protected'),
            headSequence: scan.headSequence,
            headRecordDigest: scan.headRecordDigest,
            anchoredAt,
            backendId: backend.backendId,
        });
        const backendReceipt = backend.publish(payload);
        if (typeof backendReceipt !== 'string' ||
            backendReceipt.length === 0 ||
            Buffer.byteLength(backendReceipt) > MAX_ANCHOR_BACKEND_RECEIPT_BYTES ||
            !backend.verify(payload, backendReceipt)) {
            throw anchorBackendInvalid();
        }
        const receipt = deepFreeze({
            schemaVersion: 1,
            kind: 'authority-audit-anchor-receipt.v1',
            repositoryId: prepared.scope.repositoryId,
            profile: 'protected',
            policyDigest: authorityAuditPolicyDigest('protected'),
            headSequence: scan.headSequence,
            headRecordDigest: scan.headRecordDigest,
            anchoredAt,
            backendId: backend.backendId,
            backendReceipt,
        });
        const bytes = canonicalAnchorReceipt(receipt);
        const receiptDigest = sha256Digest(bytes);
        const receiptPath = path.join(prepared.paths.anchors, `${receiptDigest.slice('sha256:'.length)}.json`);
        publishImmutableObject(receiptPath, bytes, anchorInvalid);
        fsyncDirectory(prepared.paths.anchors);
        return deepFreeze({ receiptDigest, receiptPath, receipt });
    });
}
export function verifyProtectedAuthorityAuditAnchors(scope, rawBackends) {
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    const backends = new Map();
    for (const rawBackend of rawBackends) {
        const backend = assertAnchorBackend(rawBackend);
        if (backends.has(backend.backendId))
            throw anchorBackendInvalid();
        backends.set(backend.backendId, backend);
    }
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const scan = scanLedgerUnderLock(prepared);
        const bySequence = new Map(scan.records.map((entry) => [entry.record.sequence, entry.recordDigest]));
        const prunedBySequence = protectedCheckpointDigestHistory(prepared.paths);
        const receipts = readAnchorPublications(prepared.paths);
        for (const publication of receipts) {
            const backend = backends.get(publication.receipt.backendId);
            if (backend === undefined)
                throw anchorBackendRequired();
            const payload = canonicalAnchorPayload({
                repositoryId: publication.receipt.repositoryId,
                policyDigest: publication.receipt.policyDigest,
                headSequence: publication.receipt.headSequence,
                headRecordDigest: publication.receipt.headRecordDigest,
                anchoredAt: publication.receipt.anchoredAt,
                backendId: publication.receipt.backendId,
            });
            if (!backend.verify(payload, publication.receipt.backendReceipt)) {
                throw anchorInvalid();
            }
            const retainedDigest = bySequence.get(publication.receipt.headSequence);
            if (publication.receipt.repositoryId !== prepared.scope.repositoryId ||
                publication.receipt.policyDigest !==
                    authorityAuditPolicyDigest('protected') ||
                publication.receipt.headSequence > scan.headSequence ||
                (retainedDigest !== undefined &&
                    retainedDigest !== publication.receipt.headRecordDigest) ||
                (retainedDigest === undefined &&
                    prunedBySequence.get(publication.receipt.headSequence) !==
                        publication.receipt.headRecordDigest)) {
                throw anchorInvalid();
            }
        }
        return deepFreeze({
            schemaVersion: 1,
            kind: 'authority-audit-anchor-verification.v1',
            repositoryId: prepared.scope.repositoryId,
            ok: true,
            currentHeadAnchored: receipts.some(({ receipt }) => receipt.headSequence === scan.headSequence &&
                receipt.headRecordDigest === scan.headRecordDigest),
            receipts,
        });
    });
}
export function canonicalAuditDestructionGrantPayload(rawPayload) {
    return `${canonicalJson(assertAuditDestructionGrantPayload(rawPayload))}\n`;
}
export function canonicalAuditDestructionGrantEnvelope(rawEnvelope) {
    return `${canonicalJson(assertAuditDestructionGrantEnvelope(rawEnvelope))}\n`;
}
export function destroyProtectedAuthorityAuditLedger(scope, rawEnvelope, input, hooks = {}) {
    const now = assertMaintenanceTimestamp(input.now);
    const envelope = assertAuditDestructionGrantEnvelope(rawEnvelope);
    if (typeof input.verifyHumanSignature !== 'function') {
        throw destructionGrantInvalid();
    }
    const canonicalPayload = canonicalAuditDestructionGrantPayload(envelope.payload);
    if (!input.verifyHumanSignature({
        domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
        payload: canonicalPayload,
        signerIdentity: envelope.payload.signerIdentity,
        signature: envelope.signature,
    })) {
        throw destructionGrantInvalid();
    }
    assertDestructionGrantTime(envelope.payload, now);
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const payload = envelope.payload;
        const priorGrantUse = readDestructionTombstones(prepared.paths).find(({ grantEnvelope }) => grantEnvelope.payload.grantId === payload.grantId);
        if (priorGrantUse !== undefined) {
            throw destructionGrantConsumed();
        }
        const grantDigest = sha256Digest(`${canonicalJson(envelope)}\n`);
        const tombstonePath = path.join(prepared.paths.tombstones, `${grantDigest.slice('sha256:'.length)}.json`);
        if (fs.lstatSync(tombstonePath, { throwIfNoEntry: false })) {
            // Validate before reporting consumption so a forged/tampered marker can
            // never turn into a benign replay response.
            const tombstone = parseDestructionTombstone(readExactPrivateFile(tombstonePath, MAX_METADATA_BYTES, destructionTombstoneInvalid));
            if (tombstone.grantDigest !== grantDigest) {
                throw destructionTombstoneInvalid();
            }
            throw destructionGrantConsumed();
        }
        const scan = scanLedgerUnderLock(prepared);
        if (payload.repositoryId !== prepared.scope.repositoryId ||
            payload.expectedHeadSequence !== scan.headSequence ||
            payload.expectedHeadRecordDigest !== scan.headRecordDigest ||
            payload.throughSequence <= scan.prunedRecordCount ||
            payload.throughSequence > scan.headSequence) {
            throw destructionGrantBindingInvalid();
        }
        const target = scan.records.find(({ record }) => record.sequence === payload.throughSequence);
        if (target === undefined ||
            target.recordDigest !== payload.throughRecordDigest) {
            throw destructionGrantBindingInvalid();
        }
        const previousCheckpoint = readRetentionCheckpoint(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const previousCheckpointDigest = checkpointDigest(previousCheckpoint);
        const tombstone = deepFreeze({
            schemaVersion: 1,
            kind: 'authority-audit-destruction-tombstone.v1',
            repositoryId: prepared.scope.repositoryId,
            grantDigest,
            grantEnvelope: envelope,
            signerIdentity: payload.signerIdentity,
            expectedHeadSequence: payload.expectedHeadSequence,
            expectedHeadRecordDigest: payload.expectedHeadRecordDigest,
            destroyedThroughSequence: payload.throughSequence,
            destroyedThroughRecordDigest: payload.throughRecordDigest,
            destroyedAt: now,
            reasonDigest: payload.reasonDigest,
            remoteAnchorDisposition: payload.remoteAnchorDisposition,
            previousCheckpointDigest,
        });
        const tombstoneDigest = sha256Digest(canonicalTombstone(tombstone));
        const checkpoint = createRetentionCheckpoint({
            repositoryId: prepared.scope.repositoryId,
            profile: 'protected',
            prunedThroughSequence: target.record.sequence,
            prunedThroughRecordDigest: target.recordDigest,
            prunedAt: now,
            reason: 'protected-destruction',
            grantDigest,
            tombstoneDigest,
            previousCheckpoint,
        });
        executeAuditMaintenance(prepared.paths, createMaintenanceJournal(checkpoint, tombstone), hooks);
        return compactionResult('protected', payload.throughSequence -
            (previousCheckpoint?.prunedThroughSequence ?? 0), scan.recordCount -
            (payload.throughSequence -
                (previousCheckpoint?.prunedThroughSequence ?? 0)), checkpoint);
    });
}
function prepareLedger(rawScope) {
    const scope = assertScope(rawScope);
    const paths = ledgerPathsForScope(scope);
    assertRepositoryRoot(scope.repositoryRoot);
    ensurePrivateRoot(paths.externalAuditRoot);
    const realAuditRoot = fs.realpathSync(paths.externalAuditRoot);
    const realRepositoryRoot = fs.realpathSync(scope.repositoryRoot);
    if (pathsOverlap(realAuditRoot, realRepositoryRoot)) {
        throw externalRootRequired();
    }
    ensurePrivateDirectory(paths.repositories);
    ensurePrivateDirectory(paths.repository);
    ensurePrivateDirectory(paths.events);
    ensurePrivateDirectory(paths.records);
    ensurePrivateDirectory(paths.locks);
    ensurePrivateDirectory(paths.metadata);
    ensurePrivateDirectory(paths.anchors);
    ensurePrivateDirectory(paths.tombstones);
    recoverPrivateFilePublications(paths.metadata, (name) => name === PROFILE_STATE_NAME ||
        name === PROTECTED_CONFIGURATION_NAME ||
        name === RETENTION_CHECKPOINT_NEXT_NAME ||
        name === MAINTENANCE_JOURNAL_NAME, maintenanceInvalid);
    recoverPrivateFilePublications(paths.anchors, (name) => /^[0-9a-f]{64}\.json$/.test(name), anchorInvalid);
    recoverPrivateFilePublications(paths.tombstones, (name) => /^[0-9a-f]{64}\.json$/.test(name), destructionTombstoneInvalid);
    const profile = ensureAuthorityAuditProfile(paths, scope);
    assertLayout(paths);
    assertProfileArtifactBindings(paths, scope, profile);
    return Object.freeze({ scope, paths, profile });
}
function assertScope(raw) {
    if (!isPlainRecord(raw) ||
        (!hasExactKeys(raw, SCOPE_KEYS) &&
            !hasExactKeys(raw, [...SCOPE_KEYS, 'profile']))) {
        throw invalidScope();
    }
    const externalAuditRoot = assertAbsolutePath(raw.externalAuditRoot);
    const repositoryRoot = assertAbsolutePath(raw.repositoryRoot);
    const repositoryId = assertDigest(raw.repositoryId, invalidScope);
    const profile = raw.profile === undefined
        ? undefined
        : assertAuditProfile(raw.profile, invalidScope);
    if (pathsOverlap(externalAuditRoot, repositoryRoot)) {
        throw externalRootRequired();
    }
    return Object.freeze({
        externalAuditRoot,
        repositoryRoot,
        repositoryId,
        ...(profile === undefined ? {} : { profile }),
    });
}
function ensureAuthorityAuditProfile(paths, scope) {
    const existingStats = fs.lstatSync(paths.profileState, {
        throwIfNoEntry: false,
    });
    const existing = existingStats === undefined
        ? null
        : parseAuthorityAuditProfileState(readExactPrivateFile(paths.profileState, MAX_METADATA_BYTES, unsafeFilesystem));
    const requested = scope.profile ?? existing?.profile ?? 'development';
    const state = deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-profile.v1',
        repositoryId: scope.repositoryId,
        profile: requested,
        policyVersion: 1,
        policyDigest: authorityAuditPolicyDigest(requested),
    });
    const bytes = `${canonicalJson(state)}\n`;
    if (existing === null) {
        if (!isUninitializedAuditLayout(paths))
            throw invalidProfile();
        try {
            writeExclusivePrivateFile(paths.profileState, bytes, unsafeFilesystem);
            fsyncDirectory(paths.metadata);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
        }
    }
    const stored = existing ??
        parseAuthorityAuditProfileState(readExactPrivateFile(paths.profileState, MAX_METADATA_BYTES, unsafeFilesystem));
    if (stored.repositoryId !== scope.repositoryId)
        throw invalidProfile();
    if (stored.profile !== requested)
        throw profileMismatch();
    if (stored.policyVersion !== 1 ||
        stored.policyDigest !== authorityAuditPolicyDigest(stored.profile)) {
        throw invalidProfile();
    }
    return stored.profile;
}
function isUninitializedAuditLayout(paths) {
    return (fs.readdirSync(paths.events).length === 0 &&
        fs.readdirSync(paths.records).length === 0 &&
        fs.readdirSync(paths.locks).length === 0 &&
        fs.readdirSync(paths.anchors).length === 0 &&
        fs.readdirSync(paths.tombstones).length === 0 &&
        fs
            .readdirSync(paths.metadata)
            .every((entry) => entry === 'anchors' ||
            entry === 'tombstones' ||
            entry === PROTECTED_CONFIGURATION_NAME));
}
function assertProfileArtifactBindings(paths, scope, profile) {
    const repositoryId = scope.repositoryId;
    const anchors = readAnchorPublications(paths);
    const tombstones = readDestructionTombstones(paths);
    const configurationStats = fs.lstatSync(paths.protectedConfiguration, {
        throwIfNoEntry: false,
    });
    if (profile === 'development' &&
        (anchors.length > 0 ||
            tombstones.length > 0 ||
            configurationStats !== undefined)) {
        throw profileMismatch();
    }
    const configuration = configurationStats === undefined ? null : readProtectedConfiguration(paths);
    if (configuration !== null) {
        assertProtectedBackendRoot(configuration.backendRoot, scope);
    }
    if (anchors.some(({ receipt }) => receipt.repositoryId !== repositoryId ||
        receipt.policyDigest !== authorityAuditPolicyDigest('protected')) ||
        tombstones.some(({ repositoryId: observed }) => observed !== repositoryId) ||
        (configuration !== null && configuration.repositoryId !== repositoryId)) {
        throw profileMismatch();
    }
}
function assertProtectedBackendRoot(raw, scope) {
    const backendRoot = assertProtectedConfigurationPath(raw);
    assertPrivateDirectory(backendRoot);
    const realBackendRoot = fs.realpathSync(backendRoot);
    const realRepositoryRoot = fs.realpathSync(scope.repositoryRoot);
    const realAuditRoot = fs.realpathSync(scope.externalAuditRoot);
    if (realBackendRoot !== backendRoot ||
        pathsOverlap(realBackendRoot, realRepositoryRoot) ||
        pathsOverlap(realBackendRoot, realAuditRoot)) {
        throw protectedConfigurationInvalid();
    }
    return backendRoot;
}
function assertProtectedConfigurationPath(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        Buffer.byteLength(raw) > MAX_PATH_BYTES ||
        raw.includes('\0') ||
        !path.isAbsolute(raw) ||
        path.normalize(raw) !== raw) {
        throw protectedConfigurationInvalid();
    }
    return raw;
}
function canonicalDestructionPublicKey(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        raw.includes('\0') ||
        Buffer.byteLength(raw) > MAX_METADATA_BYTES) {
        throw protectedConfigurationInvalid();
    }
    try {
        const key = crypto.createPublicKey(raw);
        if (key.asymmetricKeyType !== 'ed25519') {
            throw protectedConfigurationInvalid();
        }
        const canonical = key.export({ type: 'spki', format: 'pem' });
        if (typeof canonical !== 'string') {
            throw protectedConfigurationInvalid();
        }
        return canonical;
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_INVALID') {
            throw error;
        }
        throw protectedConfigurationInvalid();
    }
}
function canonicalProtectedConfiguration(configuration) {
    return `${canonicalJson(configuration)}\n`;
}
function parseProtectedConfiguration(bytes) {
    const raw = parseJson(bytes, protectedConfigurationInvalid);
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, PROTECTED_CONFIGURATION_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-protected-configuration.v1' ||
        raw.backendId !== 'filesystem-worm.v1') {
        throw protectedConfigurationInvalid();
    }
    const destructionPublicKeyPem = canonicalDestructionPublicKey(raw.destructionPublicKeyPem);
    if (destructionPublicKeyPem !== raw.destructionPublicKeyPem) {
        throw protectedConfigurationInvalid();
    }
    const core = {
        schemaVersion: 1,
        kind: 'authority-audit-protected-configuration.v1',
        repositoryId: assertDigest(raw.repositoryId, protectedConfigurationInvalid),
        backendId: 'filesystem-worm.v1',
        backendRoot: assertProtectedConfigurationPath(raw.backendRoot),
        destructionPublicKeyPem,
        destructionPublicKeyDigest: assertDigest(raw.destructionPublicKeyDigest, protectedConfigurationInvalid),
    };
    const configuration = deepFreeze({
        ...core,
        configurationDigest: assertDigest(raw.configurationDigest, protectedConfigurationInvalid),
    });
    if (configuration.destructionPublicKeyDigest !==
        sha256Digest(configuration.destructionPublicKeyPem) ||
        configuration.configurationDigest !== sha256Digest(canonicalJson(core)) ||
        bytes !== canonicalProtectedConfiguration(configuration)) {
        throw protectedConfigurationInvalid();
    }
    return configuration;
}
function readProtectedConfiguration(paths) {
    return parseProtectedConfiguration(readExactPrivateFile(paths.protectedConfiguration, MAX_METADATA_BYTES, protectedConfigurationInvalid));
}
function ensureFilesystemWormBackend(configuration) {
    const backendRoot = configuration.backendRoot;
    assertPrivateDirectory(backendRoot);
    for (const entry of fs.readdirSync(backendRoot)) {
        if (entry !== 'repositories')
            throw anchorBackendInvalid();
    }
    const repositories = path.join(backendRoot, 'repositories');
    ensurePrivateDirectory(repositories);
    for (const namespace of fs.readdirSync(repositories)) {
        if (!/^[0-9a-f]{64}$/.test(namespace))
            throw anchorBackendInvalid();
        assertPrivateDirectory(path.join(repositories, namespace));
    }
    const repository = path.join(repositories, configuration.repositoryId.slice('sha256:'.length));
    ensurePrivateDirectory(repository);
    for (const entry of fs.readdirSync(repository)) {
        if (entry !== 'anchors')
            throw anchorBackendInvalid();
    }
    const anchors = path.join(repository, 'anchors');
    ensurePrivateDirectory(anchors);
    assertExactDirectoryEntries(backendRoot, ['repositories']);
    assertExactDirectoryEntries(repository, ['anchors']);
    return Object.freeze({ repositories, repository, anchors });
}
function parseAuthorityAuditProfileState(bytes) {
    const raw = parseJson(bytes, invalidProfile);
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, PROFILE_STATE_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-profile.v1' ||
        raw.policyVersion !== 1) {
        throw invalidProfile();
    }
    const state = deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-profile.v1',
        repositoryId: assertDigest(raw.repositoryId, invalidProfile),
        profile: assertAuditProfile(raw.profile, invalidProfile),
        policyVersion: 1,
        policyDigest: assertDigest(raw.policyDigest, invalidProfile),
    });
    if (bytes !== `${canonicalJson(state)}\n`)
        throw invalidProfile();
    return state;
}
function authorityAuditPolicyDigest(profile) {
    return sha256Digest(canonicalJson(AUTHORITY_AUDIT_PROFILE_POLICIES[profile]));
}
function assertAuditProfile(raw, makeError) {
    if (raw !== 'development' && raw !== 'protected')
        throw makeError();
    return raw;
}
function scanLedgerUnderLock(prepared) {
    const checkpoint = readRetentionCheckpoint(prepared.paths, prepared.scope.repositoryId, prepared.profile);
    const records = scanRecords(prepared.paths, prepared.scope.repositoryId, false, checkpoint);
    const head = records.at(-1);
    return deepFreeze({
        repositoryId: prepared.scope.repositoryId,
        profile: prepared.profile,
        recordCount: records.length,
        prunedRecordCount: checkpoint?.prunedThroughSequence ?? 0,
        headSequence: head?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0,
        headRecordDigest: head?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null,
        records,
    });
}
function createRetentionCheckpoint(input) {
    if (input.previousCheckpoint !== null &&
        (input.previousCheckpoint.repositoryId !== input.repositoryId ||
            input.previousCheckpoint.profile !== input.profile ||
            input.prunedThroughSequence <=
                input.previousCheckpoint.prunedThroughSequence ||
            Date.parse(input.prunedAt) <
                Date.parse(input.previousCheckpoint.prunedAt))) {
        throw maintenanceInvalid();
    }
    const checkpoint = deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-retention-checkpoint.v1',
        repositoryId: input.repositoryId,
        profile: input.profile,
        policyDigest: authorityAuditPolicyDigest(input.profile),
        prunedThroughSequence: input.prunedThroughSequence,
        prunedThroughRecordDigest: input.prunedThroughRecordDigest,
        prunedAt: input.prunedAt,
        reason: input.reason,
        grantDigest: input.grantDigest,
        tombstoneDigest: input.tombstoneDigest,
        previousCheckpointDigest: checkpointDigest(input.previousCheckpoint),
    });
    return assertRetentionCheckpoint(checkpoint);
}
function createMaintenanceJournal(checkpoint, tombstone) {
    const tombstoneDigest = tombstone === null ? null : sha256Digest(canonicalTombstone(tombstone));
    if (checkpoint.tombstoneDigest !== tombstoneDigest) {
        throw maintenanceInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-maintenance-journal.v1',
        repositoryId: checkpoint.repositoryId,
        checkpoint,
        checkpointDigest: sha256Digest(canonicalCheckpoint(checkpoint)),
        tombstone,
        tombstoneDigest,
    });
}
function executeAuditMaintenance(paths, journal, hooks) {
    if (fs.lstatSync(paths.maintenanceJournal, { throwIfNoEntry: false })) {
        throw maintenanceInvalid();
    }
    writeExclusivePrivateFile(paths.maintenanceJournal, canonicalMaintenanceJournal(journal), maintenanceInvalid, hooks.testAfterJournalPreparation);
    fsyncDirectory(paths.metadata);
    completeAuditMaintenance(paths, journal, hooks);
}
function recoverAuditMaintenance(paths, profile) {
    const journalStats = fs.lstatSync(paths.maintenanceJournal, {
        throwIfNoEntry: false,
    });
    if (journalStats === undefined) {
        if (fs.lstatSync(paths.retentionCheckpointNext, { throwIfNoEntry: false })) {
            throw maintenanceInvalid();
        }
        return;
    }
    const journal = parseMaintenanceJournal(readExactPrivateFile(paths.maintenanceJournal, MAX_METADATA_BYTES, maintenanceInvalid));
    if (journal.repositoryId !==
        `sha256:${path.basename(paths.repository)}` ||
        journal.checkpoint.profile !== profile) {
        throw maintenanceInvalid();
    }
    completeAuditMaintenance(paths, journal, {});
}
function completeAuditMaintenance(paths, journal, hooks) {
    if (journal.tombstone !== null) {
        const tombstonePath = path.join(paths.tombstones, `${journal.tombstone.grantDigest.slice('sha256:'.length)}.json`);
        publishImmutableObject(tombstonePath, canonicalTombstone(journal.tombstone), destructionTombstoneInvalid, hooks.testAfterTombstonePreparation);
        fsyncDirectory(paths.tombstones);
    }
    hooks.testAfterTombstonePublication?.();
    publishRetentionCheckpoint(paths, journal.checkpoint, hooks);
    hooks.testAfterCheckpointPublication?.();
    removePrunedAuditPrefix(paths, journal.checkpoint, hooks);
    fs.unlinkSync(paths.maintenanceJournal);
    fsyncDirectory(paths.metadata);
}
function publishRetentionCheckpoint(paths, next, hooks) {
    const nextBytes = canonicalCheckpoint(next);
    const current = readRetentionCheckpoint(paths, next.repositoryId, next.profile);
    if (current !== null && canonicalCheckpoint(current) === nextBytes) {
        if (fs.lstatSync(paths.retentionCheckpointNext, { throwIfNoEntry: false })) {
            const prepared = readExactPrivateFile(paths.retentionCheckpointNext, MAX_METADATA_BYTES, maintenanceInvalid);
            if (prepared !== nextBytes)
                throw maintenanceInvalid();
            fs.unlinkSync(paths.retentionCheckpointNext);
            fsyncDirectory(paths.metadata);
        }
        return;
    }
    if (checkpointDigest(current) !== next.previousCheckpointDigest) {
        throw maintenanceInvalid();
    }
    const preparedStats = fs.lstatSync(paths.retentionCheckpointNext, {
        throwIfNoEntry: false,
    });
    if (preparedStats === undefined) {
        writeExclusivePrivateFile(paths.retentionCheckpointNext, nextBytes, maintenanceInvalid, hooks.testAfterCheckpointPreparation);
        fsyncDirectory(paths.metadata);
    }
    else if (readExactPrivateFile(paths.retentionCheckpointNext, MAX_METADATA_BYTES, maintenanceInvalid) !== nextBytes) {
        throw maintenanceInvalid();
    }
    fs.renameSync(paths.retentionCheckpointNext, paths.retentionCheckpoint);
    fsyncDirectory(paths.metadata);
    if (canonicalCheckpoint(readRetentionCheckpoint(paths, next.repositoryId, next.profile)) !== nextBytes) {
        throw maintenanceInvalid();
    }
}
function removePrunedAuditPrefix(paths, checkpoint, hooks) {
    const names = fs.readdirSync(paths.records).sort();
    const retainedResultDigests = new Set();
    for (const name of names) {
        const match = FINAL_RECORD_NAME.exec(name);
        if (match === null || match[1] === undefined)
            throw invalidLedger();
        if (Number(match[1]) <= checkpoint.prunedThroughSequence)
            continue;
        retainedResultDigests.add(parseCanonicalRecord(readRecordPath(path.join(paths.records, name), [1]).content).resultDigest);
    }
    for (const name of names) {
        const match = FINAL_RECORD_NAME.exec(name);
        if (match === null || match[1] === undefined || match[2] === undefined) {
            throw invalidLedger();
        }
        const sequence = Number(match[1]);
        if (sequence > checkpoint.prunedThroughSequence)
            continue;
        const recordPath = path.join(paths.records, name);
        const stored = readRecordPath(recordPath, [1]);
        const record = parseCanonicalRecord(stored.content);
        if (record.repositoryId !== checkpoint.repositoryId ||
            record.sequence !== sequence ||
            sha256Digest(stored.content).slice('sha256:'.length) !== match[2]) {
            throw invalidLedger();
        }
        const eventPath = path.join(paths.events, `${record.resultDigest.slice('sha256:'.length)}.json`);
        if (!retainedResultDigests.has(record.resultDigest) &&
            fs.lstatSync(eventPath, { throwIfNoEntry: false })) {
            const eventBytes = readExactPrivateFile(eventPath, MAX_RECORD_BYTES, unsafeFilesystem);
            if (sha256Digest(eventBytes) !== record.resultDigest) {
                throw invalidLedger();
            }
            fs.unlinkSync(eventPath);
            fsyncDirectory(paths.events);
        }
        fs.unlinkSync(recordPath);
        fsyncDirectory(paths.records);
        hooks.testAfterEntryRemoval?.();
    }
    if (fs.readdirSync(paths.records).some((name) => {
        const match = FINAL_RECORD_NAME.exec(name);
        return (match !== null && Number(match[1]) <= checkpoint.prunedThroughSequence);
    })) {
        throw maintenanceInvalid();
    }
}
function readRetentionCheckpoint(paths, repositoryId, profile) {
    const stats = fs.lstatSync(paths.retentionCheckpoint, {
        throwIfNoEntry: false,
    });
    if (stats === undefined) {
        if (profile === 'protected' &&
            fs.readdirSync(paths.tombstones).length > 0 &&
            !fs.lstatSync(paths.maintenanceJournal, { throwIfNoEntry: false })) {
            throw maintenanceInvalid();
        }
        return null;
    }
    const checkpoint = parseRetentionCheckpoint(readExactPrivateFile(paths.retentionCheckpoint, MAX_METADATA_BYTES, maintenanceInvalid));
    if (checkpoint.repositoryId !== repositoryId ||
        checkpoint.profile !== profile ||
        checkpoint.policyDigest !== authorityAuditPolicyDigest(profile)) {
        throw maintenanceInvalid();
    }
    if (profile === 'protected') {
        assertProtectedCheckpointTombstoneBinding(paths, checkpoint);
        if (!fs.lstatSync(paths.maintenanceJournal, { throwIfNoEntry: false })) {
            const reconstructed = reconstructProtectedCheckpointHistory(paths);
            if (reconstructed.length === 0 ||
                canonicalCheckpoint(reconstructed.at(-1)) !==
                    canonicalCheckpoint(checkpoint)) {
                throw destructionTombstoneInvalid();
            }
        }
    }
    return checkpoint;
}
function reconstructProtectedCheckpointHistory(paths) {
    const tombstones = readDestructionTombstones(paths).sort((left, right) => left.destroyedThroughSequence - right.destroyedThroughSequence);
    const grantIds = new Set();
    const checkpoints = [];
    let previous = null;
    for (const tombstone of tombstones) {
        const grantId = tombstone.grantEnvelope.payload.grantId;
        if (grantIds.has(grantId) ||
            tombstone.previousCheckpointDigest !== checkpointDigest(previous)) {
            throw destructionTombstoneInvalid();
        }
        grantIds.add(grantId);
        const checkpoint = createRetentionCheckpoint({
            repositoryId: tombstone.repositoryId,
            profile: 'protected',
            prunedThroughSequence: tombstone.destroyedThroughSequence,
            prunedThroughRecordDigest: tombstone.destroyedThroughRecordDigest,
            prunedAt: tombstone.destroyedAt,
            reason: 'protected-destruction',
            grantDigest: tombstone.grantDigest,
            tombstoneDigest: sha256Digest(canonicalTombstone(tombstone)),
            previousCheckpoint: previous,
        });
        checkpoints.push(checkpoint);
        previous = checkpoint;
    }
    return checkpoints;
}
function protectedCheckpointDigestHistory(paths) {
    return new Map(reconstructProtectedCheckpointHistory(paths).map((checkpoint) => [
        checkpoint.prunedThroughSequence,
        checkpoint.prunedThroughRecordDigest,
    ]));
}
function assertProtectedCheckpointTombstoneBinding(paths, checkpoint) {
    if (checkpoint.profile !== 'protected' ||
        checkpoint.grantDigest === null ||
        checkpoint.tombstoneDigest === null) {
        throw maintenanceInvalid();
    }
    const tombstonePath = path.join(paths.tombstones, `${checkpoint.grantDigest.slice('sha256:'.length)}.json`);
    let tombstone;
    try {
        tombstone = parseDestructionTombstone(readExactPrivateFile(tombstonePath, MAX_METADATA_BYTES, destructionTombstoneInvalid));
    }
    catch {
        throw destructionTombstoneInvalid();
    }
    if (tombstone.grantDigest !== checkpoint.grantDigest ||
        sha256Digest(canonicalTombstone(tombstone)) !==
            checkpoint.tombstoneDigest ||
        tombstone.repositoryId !== checkpoint.repositoryId ||
        tombstone.destroyedThroughSequence !== checkpoint.prunedThroughSequence ||
        tombstone.destroyedThroughRecordDigest !==
            checkpoint.prunedThroughRecordDigest ||
        tombstone.destroyedAt !== checkpoint.prunedAt ||
        tombstone.previousCheckpointDigest !== checkpoint.previousCheckpointDigest) {
        throw destructionTombstoneInvalid();
    }
}
function parseRetentionCheckpoint(bytes) {
    const raw = parseJson(bytes, maintenanceInvalid);
    const checkpoint = assertRetentionCheckpoint(raw);
    if (bytes !== canonicalCheckpoint(checkpoint))
        throw maintenanceInvalid();
    return checkpoint;
}
function assertRetentionCheckpoint(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, RETENTION_CHECKPOINT_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-retention-checkpoint.v1' ||
        !Number.isSafeInteger(raw.prunedThroughSequence) ||
        typeof raw.prunedThroughSequence !== 'number' ||
        raw.prunedThroughSequence < 1 ||
        !isCanonicalTimestamp(raw.prunedAt) ||
        (raw.reason !== 'development-retention' &&
            raw.reason !== 'protected-destruction')) {
        throw maintenanceInvalid();
    }
    const profile = assertAuditProfile(raw.profile, maintenanceInvalid);
    const grantDigest = assertNullableDigest(raw.grantDigest, maintenanceInvalid);
    const tombstoneDigest = assertNullableDigest(raw.tombstoneDigest, maintenanceInvalid);
    if ((profile === 'development' &&
        (raw.reason !== 'development-retention' ||
            grantDigest !== null ||
            tombstoneDigest !== null)) ||
        (profile === 'protected' &&
            (raw.reason !== 'protected-destruction' ||
                grantDigest === null ||
                tombstoneDigest === null))) {
        throw maintenanceInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-retention-checkpoint.v1',
        repositoryId: assertDigest(raw.repositoryId, maintenanceInvalid),
        profile,
        policyDigest: assertDigest(raw.policyDigest, maintenanceInvalid),
        prunedThroughSequence: raw.prunedThroughSequence,
        prunedThroughRecordDigest: assertDigest(raw.prunedThroughRecordDigest, maintenanceInvalid),
        prunedAt: raw.prunedAt,
        reason: raw.reason,
        grantDigest,
        tombstoneDigest,
        previousCheckpointDigest: assertNullableDigest(raw.previousCheckpointDigest, maintenanceInvalid),
    });
}
function canonicalCheckpoint(checkpoint) {
    return `${canonicalJson(assertRetentionCheckpoint(checkpoint))}\n`;
}
function checkpointDigest(checkpoint) {
    return checkpoint === null
        ? null
        : sha256Digest(canonicalCheckpoint(checkpoint));
}
function parseMaintenanceJournal(bytes) {
    const raw = parseJson(bytes, maintenanceInvalid);
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, MAINTENANCE_JOURNAL_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-maintenance-journal.v1') {
        throw maintenanceInvalid();
    }
    const checkpoint = assertRetentionCheckpoint(raw.checkpoint);
    const checkpointValueDigest = assertDigest(raw.checkpointDigest, maintenanceInvalid);
    const tombstone = raw.tombstone === null ? null : assertDestructionTombstone(raw.tombstone);
    const tombstoneDigest = assertNullableDigest(raw.tombstoneDigest, maintenanceInvalid);
    const journal = deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-maintenance-journal.v1',
        repositoryId: assertDigest(raw.repositoryId, maintenanceInvalid),
        checkpoint,
        checkpointDigest: checkpointValueDigest,
        tombstone,
        tombstoneDigest,
    });
    if (journal.repositoryId !== checkpoint.repositoryId ||
        checkpointValueDigest !== sha256Digest(canonicalCheckpoint(checkpoint)) ||
        tombstoneDigest !==
            (tombstone === null
                ? null
                : sha256Digest(canonicalTombstone(tombstone))) ||
        checkpoint.tombstoneDigest !== tombstoneDigest ||
        bytes !== canonicalMaintenanceJournal(journal)) {
        throw maintenanceInvalid();
    }
    return journal;
}
function canonicalMaintenanceJournal(journal) {
    return `${canonicalJson(journal)}\n`;
}
function compactionResult(profile, pruned, retained, checkpoint) {
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-compaction.v1',
        profile,
        pruned,
        retained,
        prunedThroughSequence: checkpoint?.prunedThroughSequence ?? 0,
        prunedThroughRecordDigest: checkpoint?.prunedThroughRecordDigest ?? null,
        checkpointDigest: checkpointDigest(checkpoint),
    });
}
function assertAnchorBackend(raw) {
    if (!isPlainRecord(raw) ||
        typeof raw.backendId !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.backendId) ||
        typeof raw.publish !== 'function' ||
        typeof raw.verify !== 'function') {
        throw anchorBackendInvalid();
    }
    return raw;
}
function canonicalAnchorPayload(input) {
    return `${canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-anchor-payload.v1',
        repositoryId: input.repositoryId,
        profile: 'protected',
        policyDigest: input.policyDigest,
        headSequence: input.headSequence,
        headRecordDigest: input.headRecordDigest,
        anchoredAt: input.anchoredAt,
        backendId: input.backendId,
    })}\n`;
}
function canonicalAnchorReceipt(receipt) {
    return `${canonicalJson(assertAnchorReceipt(receipt))}\n`;
}
function assertAnchorReceipt(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, ANCHOR_RECEIPT_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-anchor-receipt.v1' ||
        raw.profile !== 'protected' ||
        !Number.isSafeInteger(raw.headSequence) ||
        typeof raw.headSequence !== 'number' ||
        raw.headSequence < 1 ||
        !isCanonicalTimestamp(raw.anchoredAt) ||
        typeof raw.backendId !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.backendId) ||
        typeof raw.backendReceipt !== 'string' ||
        raw.backendReceipt.length === 0 ||
        raw.backendReceipt.trim() !== raw.backendReceipt ||
        raw.backendReceipt.includes('\0') ||
        Buffer.byteLength(raw.backendReceipt) > MAX_ANCHOR_BACKEND_RECEIPT_BYTES) {
        throw anchorInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-anchor-receipt.v1',
        repositoryId: assertDigest(raw.repositoryId, anchorInvalid),
        profile: 'protected',
        policyDigest: assertDigest(raw.policyDigest, anchorInvalid),
        headSequence: raw.headSequence,
        headRecordDigest: assertDigest(raw.headRecordDigest, anchorInvalid),
        anchoredAt: raw.anchoredAt,
        backendId: raw.backendId,
        backendReceipt: raw.backendReceipt,
    });
}
function parseAnchorReceipt(raw) {
    const receipt = assertAnchorReceipt(parseJson(raw, anchorInvalid));
    if (raw !== canonicalAnchorReceipt(receipt))
        throw anchorInvalid();
    return receipt;
}
function readAnchorPublications(paths) {
    const result = [];
    for (const name of fs.readdirSync(paths.anchors).sort()) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined)
            throw anchorInvalid();
        const receiptPath = path.join(paths.anchors, name);
        const bytes = readExactPrivateFile(receiptPath, MAX_METADATA_BYTES, anchorInvalid);
        const receiptDigest = sha256Digest(bytes);
        if (receiptDigest.slice('sha256:'.length) !== match[1]) {
            throw anchorInvalid();
        }
        result.push(deepFreeze({
            receiptDigest,
            receiptPath,
            receipt: parseAnchorReceipt(bytes),
        }));
    }
    return result;
}
function assertAnchorDirectoryLocal(directory) {
    for (const name of fs.readdirSync(directory)) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined)
            throw anchorInvalid();
        const bytes = readExactPrivateFile(path.join(directory, name), MAX_METADATA_BYTES, anchorInvalid);
        if (sha256Digest(bytes).slice('sha256:'.length) !== match[1]) {
            throw anchorInvalid();
        }
        parseAnchorReceipt(bytes);
    }
}
function assertAuditDestructionGrantPayload(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, DESTRUCTION_PAYLOAD_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'audit-destruction-grant.v1' ||
        raw.domain !== 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1' ||
        typeof raw.grantId !== 'string' ||
        !UUID_V4.test(raw.grantId) ||
        raw.profile !== 'protected' ||
        !Number.isSafeInteger(raw.expectedHeadSequence) ||
        typeof raw.expectedHeadSequence !== 'number' ||
        raw.expectedHeadSequence < 1 ||
        !Number.isSafeInteger(raw.throughSequence) ||
        typeof raw.throughSequence !== 'number' ||
        raw.throughSequence < 1 ||
        raw.throughSequence > raw.expectedHeadSequence ||
        !isCanonicalTimestamp(raw.issuedAt) ||
        !isCanonicalTimestamp(raw.expiresAt) ||
        Date.parse(raw.expiresAt) <= Date.parse(raw.issuedAt) ||
        Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt) >
            AUDIT_DESTRUCTION_GRANT_MAX_TTL_MS ||
        raw.uses !== 1 ||
        typeof raw.signerIdentity !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(raw.signerIdentity) ||
        (raw.remoteAnchorDisposition !== 'retain' &&
            raw.remoteAnchorDisposition !== 'deletion-authorized')) {
        throw destructionGrantInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'audit-destruction-grant.v1',
        domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
        grantId: raw.grantId,
        repositoryId: assertDigest(raw.repositoryId, destructionGrantInvalid),
        profile: 'protected',
        expectedHeadSequence: raw.expectedHeadSequence,
        expectedHeadRecordDigest: assertDigest(raw.expectedHeadRecordDigest, destructionGrantInvalid),
        throughSequence: raw.throughSequence,
        throughRecordDigest: assertDigest(raw.throughRecordDigest, destructionGrantInvalid),
        issuedAt: raw.issuedAt,
        expiresAt: raw.expiresAt,
        uses: 1,
        signerIdentity: raw.signerIdentity,
        reasonDigest: assertDigest(raw.reasonDigest, destructionGrantInvalid),
        remoteAnchorDisposition: raw.remoteAnchorDisposition,
    });
}
function assertAuditDestructionGrantEnvelope(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, DESTRUCTION_ENVELOPE_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'audit-destruction-grant-envelope.v1' ||
        typeof raw.signature !== 'string' ||
        raw.signature.length === 0 ||
        raw.signature.trim() !== raw.signature ||
        raw.signature.includes('\0') ||
        Buffer.byteLength(raw.signature) > MAX_DESTRUCTION_SIGNATURE_BYTES) {
        throw destructionGrantInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'audit-destruction-grant-envelope.v1',
        payload: assertAuditDestructionGrantPayload(raw.payload),
        signature: raw.signature,
    });
}
function assertDestructionGrantTime(payload, now) {
    const observed = Date.parse(now);
    if (observed < Date.parse(payload.issuedAt) ||
        observed >= Date.parse(payload.expiresAt)) {
        throw destructionGrantExpired();
    }
}
function assertDestructionTombstone(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, DESTRUCTION_TOMBSTONE_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-destruction-tombstone.v1' ||
        !Number.isSafeInteger(raw.expectedHeadSequence) ||
        typeof raw.expectedHeadSequence !== 'number' ||
        raw.expectedHeadSequence < 1 ||
        !Number.isSafeInteger(raw.destroyedThroughSequence) ||
        typeof raw.destroyedThroughSequence !== 'number' ||
        raw.destroyedThroughSequence < 1 ||
        raw.destroyedThroughSequence > raw.expectedHeadSequence ||
        !isCanonicalTimestamp(raw.destroyedAt) ||
        typeof raw.signerIdentity !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(raw.signerIdentity) ||
        (raw.remoteAnchorDisposition !== 'retain' &&
            raw.remoteAnchorDisposition !== 'deletion-authorized')) {
        throw destructionTombstoneInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-destruction-tombstone.v1',
        repositoryId: assertDigest(raw.repositoryId, destructionTombstoneInvalid),
        grantDigest: assertDigest(raw.grantDigest, destructionTombstoneInvalid),
        grantEnvelope: assertAuditDestructionGrantEnvelope(raw.grantEnvelope),
        signerIdentity: raw.signerIdentity,
        expectedHeadSequence: raw.expectedHeadSequence,
        expectedHeadRecordDigest: assertDigest(raw.expectedHeadRecordDigest, destructionTombstoneInvalid),
        destroyedThroughSequence: raw.destroyedThroughSequence,
        destroyedThroughRecordDigest: assertDigest(raw.destroyedThroughRecordDigest, destructionTombstoneInvalid),
        destroyedAt: raw.destroyedAt,
        reasonDigest: assertDigest(raw.reasonDigest, destructionTombstoneInvalid),
        remoteAnchorDisposition: raw.remoteAnchorDisposition,
        previousCheckpointDigest: assertNullableDigest(raw.previousCheckpointDigest, destructionTombstoneInvalid),
    });
}
function canonicalTombstone(tombstone) {
    const checked = assertDestructionTombstone(tombstone);
    if (checked.grantDigest !==
        sha256Digest(`${canonicalJson(checked.grantEnvelope)}\n`) ||
        checked.grantEnvelope.payload.repositoryId !== checked.repositoryId ||
        checked.grantEnvelope.payload.signerIdentity !== checked.signerIdentity ||
        checked.grantEnvelope.payload.expectedHeadSequence !==
            checked.expectedHeadSequence ||
        checked.grantEnvelope.payload.expectedHeadRecordDigest !==
            checked.expectedHeadRecordDigest ||
        checked.grantEnvelope.payload.throughSequence !==
            checked.destroyedThroughSequence ||
        checked.grantEnvelope.payload.throughRecordDigest !==
            checked.destroyedThroughRecordDigest ||
        checked.grantEnvelope.payload.reasonDigest !== checked.reasonDigest ||
        checked.grantEnvelope.payload.remoteAnchorDisposition !==
            checked.remoteAnchorDisposition ||
        Date.parse(checked.destroyedAt) <
            Date.parse(checked.grantEnvelope.payload.issuedAt) ||
        Date.parse(checked.destroyedAt) >=
            Date.parse(checked.grantEnvelope.payload.expiresAt)) {
        throw destructionTombstoneInvalid();
    }
    return `${canonicalJson(checked)}\n`;
}
function parseDestructionTombstone(raw) {
    const tombstone = assertDestructionTombstone(parseJson(raw, destructionTombstoneInvalid));
    if (raw !== canonicalTombstone(tombstone)) {
        throw destructionTombstoneInvalid();
    }
    return tombstone;
}
function assertTombstoneDirectoryLocal(directory) {
    for (const name of fs.readdirSync(directory)) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined) {
            throw destructionTombstoneInvalid();
        }
        const tombstone = parseDestructionTombstone(readExactPrivateFile(path.join(directory, name), MAX_METADATA_BYTES, destructionTombstoneInvalid));
        if (tombstone.grantDigest.slice('sha256:'.length) !== match[1]) {
            throw destructionTombstoneInvalid();
        }
    }
}
function readDestructionTombstones(paths) {
    return fs.readdirSync(paths.tombstones).map((name) => {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined) {
            throw destructionTombstoneInvalid();
        }
        const tombstone = parseDestructionTombstone(readExactPrivateFile(path.join(paths.tombstones, name), MAX_METADATA_BYTES, destructionTombstoneInvalid));
        if (tombstone.grantDigest.slice('sha256:'.length) !== match[1]) {
            throw destructionTombstoneInvalid();
        }
        return tombstone;
    });
}
function assertAppendInput(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, APPEND_INPUT_KEYS)) {
        throw invalidRecord();
    }
    if (!includes(AUTHORITY_AUDIT_EVENT_TYPES, raw.eventType) ||
        !includes(AUTHORITY_AUDIT_RESULTS, raw.result) ||
        !isCanonicalTimestamp(raw.occurredAt)) {
        throw invalidRecord();
    }
    return Object.freeze({
        eventType: raw.eventType,
        occurredAt: raw.occurredAt,
        idempotencyKey: assertDigest(raw.idempotencyKey, invalidRecord),
        grantDigest: assertNullableDigest(raw.grantDigest, invalidRecord),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest, invalidRecord),
        prestateDigest: assertNullableDigest(raw.prestateDigest, invalidRecord),
        poststateDigest: assertNullableDigest(raw.poststateDigest, invalidRecord),
        result: raw.result,
        resultDigest: assertDigest(raw.resultDigest, invalidRecord),
    });
}
function assertStoredRecord(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, RECORD_KEYS)) {
        throw invalidLedger();
    }
    if (raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-record.v1' ||
        !Number.isSafeInteger(raw.sequence) ||
        typeof raw.sequence !== 'number' ||
        raw.sequence < 1 ||
        !includes(AUTHORITY_AUDIT_EVENT_TYPES, raw.eventType) ||
        !includes(AUTHORITY_AUDIT_RESULTS, raw.result) ||
        !isCanonicalTimestamp(raw.occurredAt)) {
        throw invalidLedger();
    }
    return freezeRecord({
        schemaVersion: 1,
        kind: 'authority-audit-record.v1',
        repositoryId: assertDigest(raw.repositoryId, invalidLedger),
        sequence: raw.sequence,
        occurredAt: raw.occurredAt,
        eventType: raw.eventType,
        idempotencyKey: assertDigest(raw.idempotencyKey, invalidLedger),
        previousRecordDigest: assertNullableDigest(raw.previousRecordDigest, invalidLedger),
        grantDigest: assertNullableDigest(raw.grantDigest, invalidLedger),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest, invalidLedger),
        prestateDigest: assertNullableDigest(raw.prestateDigest, invalidLedger),
        poststateDigest: assertNullableDigest(raw.poststateDigest, invalidLedger),
        result: raw.result,
        resultDigest: assertDigest(raw.resultDigest, invalidLedger),
    });
}
function recoverRecordPublications(paths, repositoryId, profile) {
    const entries = fs.readdirSync(paths.records).sort();
    const publications = entries.filter((entry) => PUBLICATION_RECORD_NAME.test(entry));
    for (const entry of entries) {
        if (!FINAL_RECORD_NAME.test(entry) &&
            !PUBLICATION_RECORD_NAME.test(entry)) {
            throw invalidLedger();
        }
    }
    // First remove publication aliases whose final content-addressed record is
    // already present. This restores each final file to nlink=1 before scanning.
    for (const publication of publications) {
        const parsed = parsePublication(paths, publication, repositoryId);
        const finalPath = path.join(paths.records, parsed.finalName);
        const finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
        if (finalStats === undefined) {
            continue;
        }
        const final = readRecordPath(finalPath, [1, 2]);
        if (final.content !== parsed.content ||
            (parsed.stats.nlink === 2 &&
                (parsed.stats.dev !== final.stats.dev ||
                    parsed.stats.ino !== final.stats.ino))) {
            throw invalidLedger();
        }
        fs.unlinkSync(parsed.path);
        fsyncDirectory(paths.records);
    }
    const checkpoint = readRetentionCheckpoint(paths, repositoryId, profile);
    let records = scanRecords(paths, repositoryId, true, checkpoint);
    for (const publication of publications) {
        const publicationPath = path.join(paths.records, publication);
        if (!fs.existsSync(publicationPath)) {
            continue;
        }
        const parsed = parsePublication(paths, publication, repositoryId);
        const finalPath = path.join(paths.records, parsed.finalName);
        const existing = fs.lstatSync(finalPath, { throwIfNoEntry: false });
        if (existing !== undefined) {
            const final = readRecordPath(finalPath, [1]);
            if (final.content !== parsed.content) {
                throw invalidLedger();
            }
            fs.unlinkSync(parsed.path);
            fsyncDirectory(paths.records);
            continue;
        }
        if (parsed.stats.nlink !== 1) {
            throw unsafeFilesystem();
        }
        const head = records.at(-1);
        const expectedPreviousSequence = head?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0;
        const expectedPreviousDigest = head?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null;
        if (parsed.record.repositoryId !== repositoryId ||
            parsed.record.sequence !== expectedPreviousSequence + 1 ||
            parsed.record.previousRecordDigest !== expectedPreviousDigest) {
            throw invalidLedger();
        }
        try {
            fs.linkSync(parsed.path, finalPath);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST') {
                throw error;
            }
            throw invalidLedger();
        }
        fsyncDirectory(paths.records);
        fs.unlinkSync(parsed.path);
        fsyncDirectory(paths.records);
        records = scanRecords(paths, repositoryId, true, checkpoint);
    }
}
function scanRecords(paths, repositoryId, allowPublications = false, checkpoint = null) {
    const observedNames = fs.readdirSync(paths.records).sort();
    if (observedNames.some((name) => !FINAL_RECORD_NAME.test(name) &&
        !(allowPublications && PUBLICATION_RECORD_NAME.test(name)))) {
        throw invalidLedger();
    }
    const names = observedNames.filter((name) => FINAL_RECORD_NAME.test(name));
    const records = [];
    const idempotencyKeys = new Set();
    let expectedPrevious = checkpoint?.prunedThroughRecordDigest ?? null;
    let expectedSequence = (checkpoint?.prunedThroughSequence ?? 0) + 1;
    for (const name of names) {
        const match = FINAL_RECORD_NAME.exec(name);
        if (match === null || match[1] === undefined || match[2] === undefined) {
            throw invalidLedger();
        }
        const sequence = Number(match[1]);
        const recordPath = path.join(paths.records, name);
        const stored = readRecordPath(recordPath, [1]);
        const record = parseCanonicalRecord(stored.content);
        const recordDigest = sha256Digest(stored.content);
        if (sequence !== expectedSequence ||
            record.sequence !== expectedSequence ||
            record.repositoryId !== repositoryId ||
            record.previousRecordDigest !== expectedPrevious ||
            match[2] !== recordDigest.slice('sha256:'.length) ||
            idempotencyKeys.has(record.idempotencyKey)) {
            throw invalidLedger();
        }
        idempotencyKeys.add(record.idempotencyKey);
        records.push(freezeEntry({ recordDigest, record }));
        expectedPrevious = recordDigest;
        expectedSequence += 1;
    }
    return records;
}
function parsePublication(paths, name, repositoryId) {
    const match = PUBLICATION_RECORD_NAME.exec(name);
    if (match === null ||
        match[1] === undefined ||
        match[2] === undefined ||
        match[3] === undefined ||
        !UUID_V4.test(match[3])) {
        throw invalidLedger();
    }
    const publicationPath = path.join(paths.records, name);
    const stored = readRecordPath(publicationPath, [1, 2]);
    const record = parseCanonicalRecord(stored.content);
    const digest = sha256Digest(stored.content).slice('sha256:'.length);
    if (record.repositoryId !== repositoryId ||
        record.sequence !== Number(match[1]) ||
        digest !== match[2]) {
        throw invalidLedger();
    }
    return Object.freeze({
        path: publicationPath,
        finalName: `${match[1]}-${match[2]}.json`,
        content: stored.content,
        record,
        stats: stored.stats,
    });
}
function parseCanonicalRecord(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw invalidLedger();
    }
    const record = assertStoredRecord(parsed);
    if (content !== canonicalRecordContent(record)) {
        throw invalidLedger();
    }
    return record;
}
function publishRecord(paths, entry, content, options) {
    const digest = entry.recordDigest.slice('sha256:'.length);
    const baseName = recordFileName(entry.record.sequence, digest);
    const finalPath = path.join(paths.records, baseName);
    const publicationPath = path.join(paths.records, `.${baseName}.${crypto.randomUUID()}.publish.tmp`);
    let descriptor;
    let published = false;
    try {
        descriptor = fs.openSync(publicationPath, fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        const written = fs.fstatSync(descriptor);
        if (!written.isFile() ||
            written.nlink !== 1 ||
            (written.mode & 0o777) !== 0o600 ||
            written.size !== Buffer.byteLength(content)) {
            throw unsafeFilesystem();
        }
        fs.closeSync(descriptor);
        descriptor = undefined;
        options.testAfterRecordPreparation?.();
        fs.linkSync(publicationPath, finalPath);
        published = true;
        fsyncDirectory(paths.records);
        fs.unlinkSync(publicationPath);
        fsyncDirectory(paths.records);
        const final = readRecordPath(finalPath, [1]);
        if (final.content !== content) {
            throw invalidLedger();
        }
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        // A fully written publication file is deliberately retained. On the next
        // locked scan it is either completed as the unique valid next record or
        // rejected fail-closed. Once the hard link exists, it is an orphaned
        // durable record and must never be deleted as rollback cleanup.
        if (!published) {
            fsyncDirectory(paths.records);
        }
        throw error;
    }
}
function withLedgerLock(paths, repositoryId, operation) {
    assertLockEntriesBeforeAcquire(paths);
    const reclaimed = reclaimDeadPreparedLock(paths.appendLock, (content) => parseLockOwner(content, repositoryId));
    if (reclaimed === 'occupied') {
        throw lockBusy();
    }
    if (reclaimed === 'unsafe') {
        throw lockUnsafe();
    }
    const ownerToken = crypto.randomUUID();
    const content = `${canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-lock.v1',
        repositoryId,
        pid: process.pid,
        ownerToken,
    })}\n`;
    let descriptor;
    try {
        descriptor = publishPreparedExclusiveLock(paths.appendLock, content, ownerToken, lockUnsafe);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw lockBusy();
        }
        throw error;
    }
    const assertOwned = () => {
        if (descriptor === undefined) {
            throw lockUnsafe();
        }
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(paths.appendLock, {
            throwIfNoEntry: false,
        });
        if (!observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content) {
            throw lockUnsafe();
        }
    };
    let result;
    try {
        assertOwned();
        assertExactDirectoryEntries(paths.locks, [LOCK_NAME]);
        result = operation();
        assertOwned();
    }
    catch (error) {
        releaseLedgerLock(paths, descriptor, assertOwned);
        descriptor = undefined;
        throw error;
    }
    releaseLedgerLock(paths, descriptor, assertOwned);
    descriptor = undefined;
    return result;
}
function releaseLedgerLock(paths, descriptor, assertOwned) {
    assertOwned();
    fs.closeSync(descriptor);
    fs.unlinkSync(paths.appendLock);
    fsyncDirectory(paths.locks);
}
function parseLockOwner(content, repositoryId) {
    if (Buffer.byteLength(content) > 1_024) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return null;
    }
    if (!isPlainRecord(parsed) ||
        !hasExactKeys(parsed, LOCK_KEYS) ||
        parsed.schemaVersion !== 1 ||
        parsed.kind !== 'authority-audit-lock.v1' ||
        parsed.repositoryId !== repositoryId ||
        !Number.isSafeInteger(parsed.pid) ||
        typeof parsed.pid !== 'number' ||
        parsed.pid < 1 ||
        typeof parsed.ownerToken !== 'string' ||
        !UUID_V4.test(parsed.ownerToken) ||
        content !== `${canonicalJson(parsed)}\n`) {
        return null;
    }
    return { pid: parsed.pid, ownerToken: parsed.ownerToken };
}
function assertLockEntriesBeforeAcquire(paths) {
    const entries = fs.readdirSync(paths.locks);
    const hasLock = entries.includes(LOCK_NAME);
    for (const entry of entries) {
        if (entry === LOCK_NAME) {
            continue;
        }
        const isPreparedAlias = PREPARED_LOCK_ALIAS.test(entry);
        const isReclaimClaim = LOCK_RECLAIM_CLAIM.test(entry);
        if (!hasLock || (!isPreparedAlias && !isReclaimClaim)) {
            throw lockUnsafe();
        }
    }
}
function readRecordPath(filePath, allowedLinks) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before?.isFile() ||
        before.isSymbolicLink() ||
        !allowedLinks.includes(before.nlink) ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > MAX_RECORD_BYTES) {
        throw unsafeFilesystem();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            !opened.isFile() ||
            !allowedLinks.includes(opened.nlink) ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.size !== before.size) {
            throw unsafeFilesystem();
        }
        const content = fs.readFileSync(descriptor, 'utf8');
        const after = fs.fstatSync(descriptor);
        if (after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs ||
            Buffer.byteLength(content) !== opened.size) {
            throw unsafeFilesystem();
        }
        return { content, stats: after };
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
function readExactPrivateFile(filePath, maximumBytes, makeError) {
    return readPrivateFileWithAllowedLinks(filePath, maximumBytes, [1], makeError);
}
function readPrivateFileWithAllowedLinks(filePath, maximumBytes, allowedLinks, makeError) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before?.isFile() ||
        before.isSymbolicLink() ||
        !allowedLinks.includes(before.nlink) ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > maximumBytes) {
        throw makeError();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            !allowedLinks.includes(opened.nlink) ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.size !== before.size) {
            throw makeError();
        }
        const content = fs.readFileSync(descriptor, 'utf8');
        const after = fs.fstatSync(descriptor);
        if (after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs ||
            Buffer.byteLength(content) !== opened.size) {
            throw makeError();
        }
        return content;
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function writePreparedPrivateFile(filePath, content, makeError) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600 ||
            stats.size !== Buffer.byteLength(content)) {
            throw makeError();
        }
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function writeExclusivePrivateFile(filePath, content, makeError, testAfterPreparation) {
    const directory = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const contentDigest = sha256Digest(content).slice('sha256:'.length);
    const preparationPath = path.join(directory, `.${baseName}.${contentDigest}.${crypto.randomUUID()}.publish.tmp`);
    writePreparedPrivateFile(preparationPath, content, makeError);
    fsyncDirectory(directory);
    testAfterPreparation?.();
    try {
        fs.linkSync(preparationPath, filePath);
        fsyncDirectory(directory);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST')
            throw error;
        if (readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content) {
            throw makeError();
        }
    }
    fs.unlinkSync(preparationPath);
    fsyncDirectory(directory);
    if (readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content) {
        throw makeError();
    }
}
function publishImmutableObject(filePath, content, makeError, testAfterPreparation) {
    const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (existing !== undefined) {
        if (readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content) {
            throw makeError();
        }
        return;
    }
    try {
        writeExclusivePrivateFile(filePath, content, makeError, testAfterPreparation);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST')
            throw error;
        if (readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content) {
            throw makeError();
        }
    }
}
function recoverPrivateFilePublications(directory, isAllowedFinalName, makeError) {
    const recoveredFinalPaths = new Set();
    for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith('.publish.tmp'))
            continue;
        const match = PRIVATE_PUBLICATION_NAME.exec(name);
        if (match === null ||
            match[1] === undefined ||
            match[2] === undefined ||
            !isAllowedFinalName(match[1])) {
            throw makeError();
        }
        const preparationPath = path.join(directory, name);
        const stats = fs.lstatSync(preparationPath, { throwIfNoEntry: false });
        if (stats === undefined ||
            !stats.isFile() ||
            stats.isSymbolicLink() ||
            (stats.nlink !== 1 && stats.nlink !== 2) ||
            (stats.mode & 0o777) !== 0o600 ||
            stats.size > MAX_METADATA_BYTES) {
            throw makeError();
        }
        if (stats.size === 0) {
            if (stats.nlink !== 1)
                throw makeError();
            fs.unlinkSync(preparationPath);
            fsyncDirectory(directory);
            continue;
        }
        const content = readPrivateFileWithAllowedLinks(preparationPath, MAX_METADATA_BYTES, [1, 2], makeError);
        if (sha256Digest(content).slice('sha256:'.length) !== match[2]) {
            if (stats.nlink !== 1)
                throw makeError();
            fs.unlinkSync(preparationPath);
            fsyncDirectory(directory);
            continue;
        }
        const finalPath = path.join(directory, match[1]);
        let finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
        if (finalStats === undefined) {
            const currentPreparationStats = fs.lstatSync(preparationPath);
            if (currentPreparationStats.nlink !== 1)
                throw makeError();
            try {
                fs.linkSync(preparationPath, finalPath);
                fsyncDirectory(directory);
            }
            catch (error) {
                if (!isNodeError(error) || error.code !== 'EEXIST')
                    throw error;
            }
            finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
        }
        if (finalStats === undefined ||
            readPrivateFileWithAllowedLinks(finalPath, MAX_METADATA_BYTES, [1, 2], makeError) !== content) {
            throw makeError();
        }
        const currentPreparationStats = fs.lstatSync(preparationPath);
        if (currentPreparationStats.nlink === 2 &&
            (currentPreparationStats.dev !== finalStats.dev ||
                currentPreparationStats.ino !== finalStats.ino)) {
            throw makeError();
        }
        fs.unlinkSync(preparationPath);
        fsyncDirectory(directory);
        recoveredFinalPaths.add(finalPath);
    }
    for (const finalPath of recoveredFinalPaths) {
        readExactPrivateFile(finalPath, MAX_METADATA_BYTES, makeError);
    }
}
function parseJson(raw, makeError) {
    try {
        return JSON.parse(raw);
    }
    catch {
        throw makeError();
    }
}
function assertMaintenanceTimestamp(raw) {
    if (!isCanonicalTimestamp(raw))
        throw maintenanceInvalid();
    return raw;
}
function assertLayout(paths) {
    assertPrivateDirectory(paths.externalAuditRoot);
    assertPrivateDirectory(paths.repositories);
    assertPrivateDirectory(paths.repository);
    assertPrivateDirectory(paths.events);
    assertPrivateDirectory(paths.records);
    assertPrivateDirectory(paths.locks);
    assertPrivateDirectory(paths.metadata);
    assertPrivateDirectory(paths.anchors);
    assertPrivateDirectory(paths.tombstones);
    assertExactDirectoryEntries(paths.externalAuditRoot, ['repositories']);
    assertExactDirectoryEntries(paths.repository, [
        'events',
        'locks',
        'metadata',
        'records',
    ]);
    const metadataEntries = fs.readdirSync(paths.metadata);
    for (const entry of metadataEntries) {
        if (entry !== PROFILE_STATE_NAME &&
            entry !== PROTECTED_CONFIGURATION_NAME &&
            entry !== RETENTION_CHECKPOINT_NAME &&
            entry !== RETENTION_CHECKPOINT_NEXT_NAME &&
            entry !== MAINTENANCE_JOURNAL_NAME &&
            entry !== 'anchors' &&
            entry !== 'tombstones') {
            throw unsafeFilesystem();
        }
    }
    if (!metadataEntries.includes(PROFILE_STATE_NAME)) {
        throw unsafeFilesystem();
    }
    assertAnchorDirectoryLocal(paths.anchors);
    assertTombstoneDirectoryLocal(paths.tombstones);
    for (const namespace of fs.readdirSync(paths.repositories)) {
        if (!/^[0-9a-f]{64}$/.test(namespace)) {
            throw unsafeFilesystem();
        }
        assertPrivateDirectory(path.join(paths.repositories, namespace));
    }
}
function ensurePrivateRoot(directory) {
    const parent = path.dirname(directory);
    assertPlainDirectory(parent);
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing === undefined) {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        fsyncDirectory(parent);
    }
    assertPrivateDirectory(directory);
}
function ensurePrivateDirectory(directory) {
    assertPrivateDirectory(path.dirname(directory));
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing === undefined) {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        fsyncDirectory(path.dirname(directory));
    }
    assertPrivateDirectory(directory);
}
function assertRepositoryRoot(directory) {
    assertPlainDirectory(directory);
}
function assertPlainDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory) {
        throw unsafeFilesystem();
    }
}
function assertPrivateDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700 ||
        fs.realpathSync(directory) !== directory) {
        throw unsafeFilesystem();
    }
}
function assertExactDirectoryEntries(directory, expected) {
    const observed = fs.readdirSync(directory).sort();
    const sortedExpected = [...expected].sort();
    if (observed.length !== sortedExpected.length ||
        observed.some((entry, index) => entry !== sortedExpected[index])) {
        throw unsafeFilesystem();
    }
}
function assertAbsolutePath(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        Buffer.byteLength(raw) > MAX_PATH_BYTES ||
        raw.includes('\0') ||
        !path.isAbsolute(raw) ||
        path.normalize(raw) !== raw) {
        throw invalidScope();
    }
    return raw;
}
function recordMatchesInput(record, input) {
    return APPEND_INPUT_KEYS.every((key) => record[key] === input[key]);
}
function canonicalRecordContent(record) {
    return `${canonicalJson(record)}\n`;
}
function recordFileName(sequence, digest) {
    const encodedSequence = sequence.toString().padStart(16, '0');
    if (encodedSequence.length !== 16 || !/^[0-9a-f]{64}$/.test(digest)) {
        throw invalidLedger();
    }
    return `${encodedSequence}-${digest}.json`;
}
function freezeRecord(record) {
    return Object.freeze(record);
}
function freezeEntry(entry) {
    return Object.freeze(entry);
}
function sha256Digest(content) {
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}
function assertDigest(raw, makeError) {
    if (typeof raw !== 'string' || !SHA256_DIGEST.test(raw)) {
        throw makeError();
    }
    return raw;
}
function assertNullableDigest(raw, makeError) {
    return raw === null ? null : assertDigest(raw, makeError);
}
function isCanonicalTimestamp(raw) {
    if (typeof raw !== 'string' || !CANONICAL_TIMESTAMP.test(raw)) {
        return false;
    }
    const timestamp = Date.parse(raw);
    return (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === raw);
}
function hasExactKeys(record, expected) {
    const keys = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    return (keys.length === sortedExpected.length &&
        keys.every((key, index) => key === sortedExpected[index]));
}
function includes(values, raw) {
    return typeof raw === 'string' && values.includes(raw);
}
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function pathsOverlap(first, second) {
    return isWithin(first, second) || isWithin(second, first);
}
function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return (relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative)));
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
function readDescriptorContent(descriptor, byteLength) {
    const bytes = Buffer.alloc(byteLength);
    const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
    return bytes.subarray(0, count).toString('utf8');
}
function invalidScope() {
    return workflowError('AUTHORITY_AUDIT_SCOPE_INVALID', 'Authority audit ledger scope must use explicit canonical absolute paths and a digest repository identity.', ExitCode.usage);
}
function externalRootRequired() {
    return workflowError('AUTHORITY_AUDIT_EXTERNAL_ROOT_REQUIRED', 'Authority audit storage must be physically separate from the repository.', ExitCode.guard);
}
function invalidRecord() {
    return workflowError('AUTHORITY_AUDIT_RECORD_INVALID', 'Authority audit input does not match the bounded canonical record schema.', ExitCode.usage);
}
function invalidLedger() {
    return workflowError('AUTHORITY_AUDIT_LEDGER_INVALID', 'Authority audit ledger failed canonical, sequence, digest, or hash-chain verification.', ExitCode.staleState);
}
function unsafeFilesystem() {
    return workflowError('AUTHORITY_AUDIT_FILESYSTEM_UNSAFE', 'Authority audit storage has unsafe paths, file types, links, or permissions.', ExitCode.unsafeEnvironment);
}
function lockBusy() {
    return workflowError('AUTHORITY_AUDIT_LOCK_BUSY', 'Another authority audit append or verification operation owns the ledger lock.', ExitCode.conflict);
}
function lockUnsafe() {
    return workflowError('AUTHORITY_AUDIT_LOCK_UNSAFE', 'Authority audit ledger lock state is unsafe or cannot be proven current.', ExitCode.staleState);
}
function idempotencyConflict() {
    return workflowError('AUTHORITY_AUDIT_IDEMPOTENCY_CONFLICT', 'Authority audit idempotency key already identifies different record content.', ExitCode.conflict);
}
function invalidProfile() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_INVALID', 'Persisted authority audit profile or code-owned policy binding is invalid.', ExitCode.staleState);
}
function profileMismatch() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_MISMATCH', 'Authority audit profile is already persisted and cannot be downgraded or mixed.', ExitCode.guard);
}
function protectedProfile() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_PROTECTED', 'Protected audit records cannot be pruned by development retention maintenance.', ExitCode.guard);
}
function developmentProfile() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_DEVELOPMENT', 'This authority audit operation requires the persisted protected profile.', ExitCode.guard);
}
function protectedConfigurationInvalid() {
    return workflowError('AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_INVALID', 'Protected authority audit configuration is missing, malformed, unsafe, or no longer bound to its pinned backend and destruction key.', ExitCode.staleState);
}
function protectedConfigurationMismatch() {
    return workflowError('AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_MISMATCH', 'Protected authority audit backend and destruction public key are already pinned and cannot be replaced.', ExitCode.guard);
}
function maintenanceInvalid() {
    return workflowError('AUTHORITY_AUDIT_MAINTENANCE_INVALID', 'Authority audit retention checkpoint or maintenance journal is missing, malformed, or tampered.', ExitCode.staleState);
}
function anchorInvalid() {
    return workflowError('AUTHORITY_AUDIT_ANCHOR_INVALID', 'Protected authority audit anchor receipt is malformed, tampered, or not bound to ledger history.', ExitCode.staleState);
}
function anchorBackendInvalid() {
    return workflowError('AUTHORITY_AUDIT_ANCHOR_BACKEND_INVALID', 'Protected authority audit anchor backend did not produce a verifiable bounded receipt.', ExitCode.verification);
}
function anchorBackendRequired() {
    return workflowError('AUTHORITY_AUDIT_ANCHOR_BACKEND_REQUIRED', 'Protected authority audit verification requires the exact backend verifier named by every receipt.', ExitCode.guard);
}
function destructionGrantInvalid() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_INVALID', 'Audit destruction requires an exact domain-separated, human-verified, single-use grant.', ExitCode.verification);
}
function destructionGrantExpired() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_EXPIRED', 'Audit-Destruction Grant is not currently valid.', ExitCode.staleState);
}
function destructionGrantBindingInvalid() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_BINDING_INVALID', 'Audit-Destruction Grant does not bind the exact current ledger head and prefix.', ExitCode.staleState);
}
function destructionGrantConsumed() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_CONSUMED', 'Audit-Destruction Grant already has a durable tombstone and cannot replay.', ExitCode.conflict);
}
function destructionTombstoneInvalid() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_TOMBSTONE_INVALID', 'Protected authority audit destruction tombstone is missing, malformed, or tampered.', ExitCode.staleState);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
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
