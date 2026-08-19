import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { interventionEngineArtifactRecordPath, readStoredInterventionEngineArtifact, } from './intervention-engine-artifact-store.js';
import { ensurePlainDirectory, publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from '../repository-transaction/filesystem-safety.js';
import { advanceEngineAdoption, advanceMinimalUpdaterTransaction, beginHarnessIntervention, createWipCheckpoint, decideControlPlaneRecovery, decideEngineAdoptionRecovery, prepareEngineAdoption, prepareMinimalUpdaterTransaction, verifyControlPlaneGrant, verifyControlPlaneGrantV2, verifyControlPlaneGrantV3, verifyHarnessMaintenanceGrant, verifyWipCheckpoint, } from '../../modules/authority/intervention-control.js';
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
export function interventionControlPersistencePaths(requestedRoot) {
    const root = assertStorageRoot(requestedRoot);
    return {
        root,
        checkpoints: path.join(root, 'checkpoints'),
        interventions: path.join(root, 'interventions'),
        sidecarSessions: path.join(root, 'sidecar-sessions'),
        sidecarHistory: path.join(root, 'sidecar-session-history'),
        sidecarPromotionPins: path.join(root, 'sidecar-promotion-pins'),
        adoptions: path.join(root, 'adoptions'),
        controlUpdates: path.join(root, 'control-updates'),
        operations: path.join(root, 'operations'),
    };
}
export function interventionRecordPath(storageRoot, parentChangeId) {
    return path.join(interventionControlPersistencePaths(storageRoot).interventions, `${identityFileName('intervention', parentChangeId)}.json`);
}
export function persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId) {
    return path.join(interventionControlPersistencePaths(storageRoot).sidecarSessions, `${identityFileName('sidecar-session', parentChangeId)}.json`);
}
export function engineAdoptionRecordPath(storageRoot, txId) {
    return path.join(interventionControlPersistencePaths(storageRoot).adoptions, `${identityFileName('adoption', txId)}.json`);
}
export function bootstrapSidecarPromotionPinPath(storageRoot, txId) {
    return path.join(interventionControlPersistencePaths(storageRoot).sidecarPromotionPins, `${identityFileName('sidecar-promotion-pin', txId)}.json`);
}
export function controlPlaneUpdateRecordPath(storageRoot, grantId) {
    return path.join(interventionControlPersistencePaths(storageRoot).controlUpdates, `${identityFileName('control-update', grantId)}.json`);
}
export function persistInterventionPlan(storageRoot, input) {
    const now = exactDate(input.now, 'INTERVENTION_PERSISTENCE_CLOCK_INVALID');
    const checkpoint = createWipCheckpoint(input.checkpoint);
    const projection = beginHarnessIntervention(input.parent, input.interventionChangeId, checkpoint);
    const childWorkspace = createChildWorktreeMetadata({
        parentChangeId: projection.parent.changeId,
        interventionChangeId: projection.relationship.interventionChangeId,
        checkpoint,
        ...input.childWorkspace,
        createdAt: now.toISOString(),
    });
    const candidate = withRecordDigest({
        kind: 'persisted-harness-intervention.v1',
        parent: projection.parent,
        relationship: projection.relationship,
        checkpoint,
        childWorkspace,
        createdAt: now.toISOString(),
    });
    return withPersistenceOperation(storageRoot, 'intervention-reservation', () => {
        ensurePersistenceDirectories(storageRoot);
        const target = interventionRecordPath(storageRoot, input.parent.changeId);
        if (fs.existsSync(target)) {
            const existing = readPersistedIntervention(storageRoot, input.parent.changeId);
            if (sameInterventionPlan(existing, candidate)) {
                ensureBootstrapSidecarSession(storageRoot, existing);
                return existing;
            }
            throw workflowError('INTERVENTION_PERSISTENCE_ACTIVE_CONFLICT', 'The parent already has a different persisted intervention.', ExitCode.conflict);
        }
        assertUniqueChildWorkspaceReservation(storageRoot, candidate);
        writeContentAddressedCheckpoint(storageRoot, checkpoint);
        createPrivateFileExclusive(target, serializeRecord(candidate));
        input.testAfterInterventionPersistedBeforeSidecar?.();
        ensureBootstrapSidecarSession(storageRoot, candidate);
        return candidate;
    });
}
export function readPersistedIntervention(storageRoot, parentChangeId) {
    const value = readCanonicalRecord(interventionRecordPath(storageRoot, parentChangeId), 'INTERVENTION_PERSISTENCE_NOT_FOUND');
    if (!isRecord(value) ||
        value.kind !== 'persisted-harness-intervention.v1' ||
        !hasExactKeys(value, [
            'checkpoint',
            'childWorkspace',
            'createdAt',
            'kind',
            'parent',
            'recordDigest',
            'relationship',
        ]) ||
        !verifyRecordDigest(value)) {
        throw corruptPersistenceRecord();
    }
    const record = value;
    try {
        const checkpoint = verifyWipCheckpoint(record.checkpoint);
        verifyStoredCheckpoint(storageRoot, checkpoint);
        verifyChildWorktreeMetadata(record.childWorkspace);
        if (record.parent.changeId !== parentChangeId ||
            record.parent.status !== 'active' ||
            record.parent.blocker?.kind !== 'harness-intervention' ||
            record.parent.blocker.checkpointId !== checkpoint.checkpointId ||
            record.parent.blocker.blockedBy !==
                record.relationship.interventionChangeId ||
            record.relationship.parentChangeId !== parentChangeId ||
            record.relationship.checkpointId !== checkpoint.checkpointId ||
            record.relationship.state !== 'active' ||
            record.childWorkspace.parentChangeId !== parentChangeId ||
            record.childWorkspace.interventionChangeId !==
                record.relationship.interventionChangeId ||
            record.childWorkspace.checkpointId !== checkpoint.checkpointId ||
            record.childWorkspace.baseOid !== checkpoint.baseOid) {
            throw corruptPersistenceRecord();
        }
        exactIso(record.createdAt, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT') {
            throw error;
        }
        throw corruptPersistenceRecord();
    }
    return record;
}
export function readPersistedBootstrapSidecarSession(storageRoot, parentChangeId) {
    const value = readCanonicalRecord(persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId), 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND');
    if (isRecord(value) && value.kind === 'bootstrap-sidecar-session.v2') {
        return projectBootstrapSidecarSessionV1(parseBootstrapSidecarWorkflow(value, parentChangeId));
    }
    return parseBootstrapSidecarSession(value, parentChangeId);
}
export function readPersistedBootstrapSidecarWorkflow(storageRoot, parentChangeId) {
    return parseBootstrapSidecarWorkflow(readCanonicalRecord(persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId), 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND'), parentChangeId);
}
export function findPersistedBootstrapSidecarSessionForIntervention(storageRoot, interventionChangeId) {
    assertSidecarIdentityText(interventionChangeId);
    const directory = interventionControlPersistencePaths(storageRoot).sidecarSessions;
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw workflowError('INTERVENTION_SIDECAR_SESSION_NOT_FOUND', 'No durable bootstrap sidecar session exists for the intervention.', ExitCode.conflict);
    }
    const matches = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => {
        const value = readCanonicalRecord(path.join(directory, name), 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND');
        return isRecord(value) && value.kind === 'bootstrap-sidecar-session.v2'
            ? projectBootstrapSidecarSessionV1(parseBootstrapSidecarWorkflow(value))
            : parseBootstrapSidecarSession(value);
    })
        .filter((record) => record.identity.interventionChangeId === interventionChangeId &&
        record.state === 'repair-active');
    if (matches.length !== 1) {
        throw workflowError(matches.length === 0
            ? 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND'
            : 'INTERVENTION_SIDECAR_SESSION_CONFLICT', matches.length === 0
            ? 'No active bootstrap sidecar session matches the intervention.'
            : 'Multiple active bootstrap sidecar sessions match the intervention.', ExitCode.conflict);
    }
    return matches[0];
}
export function recordBootstrapSidecarWorkspaceMaterialized(storageRoot, input) {
    assertDigest(input.workspaceId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(input.receiptDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.materializedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    return updateBootstrapSidecarSession(storageRoot, input.parentChangeId, (current) => {
        assertSidecarActive(current);
        if (current.identity.workspaceId !== input.workspaceId) {
            throw sidecarProjectionConflict('Materialized workspace differs from the sidecar identity.');
        }
        if (current.workspace.state === 'materialized') {
            if (current.workspace.receiptDigest !== input.receiptDigest ||
                current.workspace.materializedAt !== input.materializedAt) {
                throw sidecarProjectionConflict('Sidecar workspace already has different materialization evidence.');
            }
            return current;
        }
        return appendBootstrapSidecarEvent(current, {
            workspace: {
                ...current.workspace,
                state: 'materialized',
                receiptDigest: input.receiptDigest,
                materializedAt: input.materializedAt,
            },
        }, {
            eventKind: 'workspace-materialized',
            evidenceDigest: input.receiptDigest,
            recordedAt: input.materializedAt,
        });
    });
}
export function recordBootstrapSidecarArtifactReady(storageRoot, input) {
    assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.readyAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    return updateBootstrapSidecarSession(storageRoot, input.parentChangeId, (current) => {
        assertSidecarActive(current);
        assertSidecarArtifactSource(current, input.artifact);
        return ensureBootstrapSidecarArtifact(current, {
            artifact: input.artifact,
            evidenceDigest: input.evidenceDigest,
            readyAt: input.readyAt,
        });
    });
}
export function recordBootstrapSidecarAdopted(storageRoot, input) {
    assertSidecarIdentityText(input.txId);
    assertDigest(input.journalDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.adoptedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    const artifactRecord = readStoredInterventionEngineArtifact(storageRoot, input.artifact.artifactId);
    if (artifactRecord.kind !== 'persisted-intervention-engine-artifact.v2' ||
        artifactRecord.parentChangeId !== input.parentChangeId ||
        canonicalJson(artifactRecord.artifact) !== canonicalJson(input.artifact)) {
        throw sidecarProjectionConflict('Successful adoption must project the exact persisted v2 artifact record.');
    }
    return updateBootstrapSidecarSession(storageRoot, input.parentChangeId, (observed) => {
        assertSidecarArtifactSource(observed, input.artifact);
        if (observed.state === 'adopted') {
            if (observed.adoption?.txId !== input.txId ||
                observed.adoption.artifactId !== input.artifact.artifactId ||
                observed.adoption.journalDigest !== input.journalDigest ||
                observed.adoption.adoptedAt !== input.adoptedAt) {
                throw sidecarProjectionConflict('Adopted workflow differs from the successful adoption replay.');
            }
            return observed;
        }
        assertSidecarActive(observed);
        if (artifactRecord.workflowBindingDigest !==
            observed.workflowBinding.workflowBindingDigest) {
            throw sidecarProjectionConflict('Persisted artifact record belongs to a different Workflow binding.');
        }
        let current = ensureBootstrapSidecarArtifact(observed, {
            artifact: input.artifact,
            evidenceDigest: artifactRecord.recordDigest,
            readyAt: artifactRecord.createdAt,
        });
        const adoption = {
            txId: input.txId,
            artifactId: input.artifact.artifactId,
            journalDigest: input.journalDigest,
            adoptedAt: input.adoptedAt,
            workflowBindingDigest: current.workflowBinding.workflowBindingDigest,
            workflowStatus: 'repair-active',
        };
        if (current.adoption !== null) {
            if (canonicalJson(current.adoption) !== canonicalJson(adoption)) {
                throw sidecarProjectionConflict('Sidecar already belongs to a different successful local adoption.');
            }
            return current;
        }
        if (current.parentUnblock.state !== 'blocking') {
            throw sidecarProjectionConflict('Sidecar parent relation was resolved before local adoption.');
        }
        current = appendBootstrapSidecarEvent(current, {
            adoption,
            state: 'adopted',
            workflowBinding: transitionBootstrapMaintenanceWorkflow(current.workflowBinding, 'adopted'),
            parentUnblock: {
                kind: 'sidecar-unblocks-parent.v1',
                parentChangeId: current.identity.parentChangeId,
                state: 'unblocked',
                resolution: 'local-adoption',
                resolvedByTxId: input.txId,
                resolvedAt: input.adoptedAt,
            },
        }, {
            eventKind: 'adopted-by-parent',
            evidenceDigest: input.journalDigest,
            recordedAt: input.adoptedAt,
        });
        return current;
    });
}
export function reserveBootstrapSidecarPromotion(storageRoot, input) {
    assertSidecarIdentityText(input.interventionChangeId);
    assertSidecarIdentityText(input.grantId);
    assertSidecarIdentityText(input.txId);
    assertDigest(input.candidateExecutableProvenanceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(input.closureDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.at, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    ensurePersistenceDirectories(storageRoot);
    const artifactPath = interventionEngineArtifactRecordPath(storageRoot, input.artifact.artifactId);
    if (!fs.existsSync(artifactPath))
        return null;
    const artifactRecord = readStoredInterventionEngineArtifact(storageRoot, input.artifact.artifactId);
    if (artifactRecord.kind !== 'persisted-intervention-engine-artifact.v2' ||
        artifactRecord.recordDigest !== input.candidateExecutableProvenanceDigest ||
        artifactRecord.interventionChangeId !== input.interventionChangeId ||
        canonicalJson(artifactRecord.artifact) !== canonicalJson(input.artifact)) {
        throw sidecarProjectionConflict('Promotion reservation differs from the exact persisted v2 artifact record.');
    }
    return withInterventionParentOperation(storageRoot, artifactRecord.parentChangeId, () => {
        const sidecar = readPersistedBootstrapSidecarWorkflow(storageRoot, artifactRecord.parentChangeId);
        const workflowBindingDigest = activeBootstrapMaintenanceWorkflowBindingDigest(sidecar.workflowBinding);
        const matchingArtifact = sidecar.artifacts.filter((artifact) => artifact.artifactId === input.artifact.artifactId &&
            artifact.evidenceDigest === artifactRecord.recordDigest &&
            artifact.readyAt === artifactRecord.createdAt);
        if (!['repair-active', 'adopted'].includes(sidecar.state) ||
            artifactRecord.workflowBindingDigest !== workflowBindingDigest ||
            matchingArtifact.length !== 1) {
            throw sidecarProjectionConflict('Promotion reservation requires the exact current sidecar generation and artifact projection.');
        }
        const candidate = withRecordDigest({
            kind: 'bootstrap-sidecar-promotion-pin.v1',
            parentChangeId: artifactRecord.parentChangeId,
            interventionChangeId: input.interventionChangeId,
            sidecarSessionId: sidecar.sidecarSessionId,
            workflowBindingDigest,
            artifactId: input.artifact.artifactId,
            artifactRecordDigest: artifactRecord.recordDigest,
            sourceDigest: input.artifact.sourceDigest,
            executableDigest: input.artifact.executableDigest,
            closureDigest: input.closureDigest,
            grantId: input.grantId,
            txId: input.txId,
            state: 'reserved',
            createdAt: input.at,
            updatedAt: input.at,
        });
        const target = bootstrapSidecarPromotionPinPath(storageRoot, input.txId);
        if (fs.existsSync(target)) {
            const existing = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
            const { state: _existingState, updatedAt: _existingUpdatedAt, recordDigest: _existingDigest, ...existingIdentity } = existing;
            const { state: _candidateState, updatedAt: _candidateUpdatedAt, recordDigest: _candidateDigest, ...candidateIdentity } = candidate;
            if (canonicalJson(existingIdentity) !== canonicalJson(candidateIdentity)) {
                throw sidecarProjectionConflict('Promotion transaction is already pinned to a different sidecar generation.');
            }
            return existing;
        }
        createPrivateFileExclusive(target, serializeRecord(candidate));
        return candidate;
    });
}
export function advanceBootstrapSidecarPromotionPin(storageRoot, input) {
    exactIso(input.at, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    const target = bootstrapSidecarPromotionPinPath(storageRoot, input.txId);
    if (!fs.existsSync(target))
        return null;
    const observed = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
    return withInterventionParentOperation(storageRoot, observed.parentChangeId, () => {
        const current = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
        if (current.state === input.state)
            return current;
        if (current.state !== input.expectedState) {
            throw sidecarProjectionConflict('Promotion pin state changed before the requested transition.');
        }
        const sidecar = readPersistedBootstrapSidecarWorkflow(storageRoot, current.parentChangeId);
        if (sidecar.sidecarSessionId !== current.sidecarSessionId ||
            activeBootstrapMaintenanceWorkflowBindingDigest(sidecar.workflowBinding) !== current.workflowBindingDigest) {
            throw sidecarProjectionConflict('Promotion pin no longer matches the exact current sidecar generation.');
        }
        const { recordDigest: _recordDigest, ...payload } = current;
        const next = withRecordDigest({
            ...payload,
            state: input.state,
            updatedAt: input.at,
        });
        replacePrivateFileAtomic(target, serializeRecord(next));
        return next;
    });
}
export function readBootstrapSidecarPromotionPin(storageRoot, txId) {
    const value = readCanonicalRecord(bootstrapSidecarPromotionPinPath(storageRoot, txId), 'INTERVENTION_SIDECAR_PROMOTION_PIN_NOT_FOUND');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'artifactId',
            'artifactRecordDigest',
            'closureDigest',
            'createdAt',
            'executableDigest',
            'grantId',
            'interventionChangeId',
            'kind',
            'parentChangeId',
            'recordDigest',
            'sidecarSessionId',
            'sourceDigest',
            'state',
            'txId',
            'updatedAt',
            'workflowBindingDigest',
        ]) ||
        value.kind !== 'bootstrap-sidecar-promotion-pin.v1' ||
        !verifyRecordDigest(value) ||
        ![
            value.artifactId,
            value.artifactRecordDigest,
            value.closureDigest,
            value.executableDigest,
            value.recordDigest,
            value.sidecarSessionId,
            value.sourceDigest,
            value.workflowBindingDigest,
        ].every(isDigest) ||
        !['reserved', 'commit-intent', 'finalized', 'rolled-back'].includes(String(value.state)) ||
        ![
            value.grantId,
            value.interventionChangeId,
            value.parentChangeId,
            value.txId,
        ].every((entry) => typeof entry === 'string' && entry.length > 0 && entry.trim() === entry) ||
        !isCanonicalIso(value.createdAt) ||
        !isCanonicalIso(value.updatedAt) ||
        Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
        throw sidecarProjectionConflict('Promotion pin failed integrity verification.');
    }
    return value;
}
export function activeBootstrapSidecarPromotionPinTxIds(storageRoot, parentChangeId) {
    const directory = interventionControlPersistencePaths(storageRoot).sidecarPromotionPins;
    if (!fs.existsSync(directory))
        return [];
    const txIds = [];
    for (const name of fs.readdirSync(directory).sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) {
            throw sidecarProjectionConflict('Promotion pin store contains an unexpected entry.');
        }
        const raw = readCanonicalRecord(path.join(directory, name), 'INTERVENTION_SIDECAR_PROMOTION_PIN_NOT_FOUND');
        if (!isRecord(raw) || typeof raw.txId !== 'string') {
            throw sidecarProjectionConflict('Promotion pin store contains an invalid identity.');
        }
        const pin = readBootstrapSidecarPromotionPin(storageRoot, raw.txId);
        if (pin.parentChangeId === parentChangeId &&
            ['reserved', 'commit-intent'].includes(pin.state)) {
            txIds.push(pin.txId);
        }
    }
    return txIds;
}
export function recordBootstrapSidecarPromotionIfPresent(storageRoot, input) {
    assertSidecarIdentityText(input.interventionChangeId);
    assertSidecarIdentityText(input.grantId);
    assertSidecarIdentityText(input.txId);
    assertDigest(input.closureDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.at, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    ensurePersistenceDirectories(storageRoot);
    const artifactPath = interventionEngineArtifactRecordPath(storageRoot, input.artifact.artifactId);
    if (!fs.existsSync(artifactPath))
        return null;
    const artifactRecord = readStoredInterventionEngineArtifact(storageRoot, input.artifact.artifactId);
    if (artifactRecord.kind !== 'persisted-intervention-engine-artifact.v2' ||
        artifactRecord.interventionChangeId !== input.interventionChangeId ||
        canonicalJson(artifactRecord.artifact) !== canonicalJson(input.artifact)) {
        throw sidecarProjectionConflict('Repository promotion differs from the exact persisted v2 artifact record.');
    }
    const pin = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
    if (!['commit-intent', 'finalized'].includes(pin.state) ||
        pin.parentChangeId !== artifactRecord.parentChangeId ||
        pin.interventionChangeId !== input.interventionChangeId ||
        pin.grantId !== input.grantId ||
        pin.artifactId !== input.artifact.artifactId ||
        pin.artifactRecordDigest !== artifactRecord.recordDigest ||
        pin.closureDigest !== input.closureDigest) {
        throw sidecarProjectionConflict('Repository promotion is missing the exact pre-effect sidecar pin.');
    }
    return withInterventionParentOperation(storageRoot, artifactRecord.parentChangeId, () => updateBootstrapSidecarSession(storageRoot, artifactRecord.parentChangeId, (observed) => {
        if (!['repair-active', 'adopted'].includes(observed.state)) {
            throw sidecarProjectionConflict('An abandoned workflow cannot accept repository promotion evidence.');
        }
        assertSidecarArtifactSource(observed, input.artifact);
        if (artifactRecord.workflowBindingDigest !==
            activeBootstrapMaintenanceWorkflowBindingDigest(observed.workflowBinding)) {
            throw sidecarProjectionConflict('Repository promotion artifact belongs to a different Workflow generation.');
        }
        let current = ensureBootstrapSidecarArtifact(observed, {
            artifact: input.artifact,
            evidenceDigest: artifactRecord.recordDigest,
            readyAt: artifactRecord.createdAt,
        });
        const promotion = {
            grantId: input.grantId,
            txId: input.txId,
            artifactId: input.artifact.artifactId,
            closureDigest: input.closureDigest,
            evidenceDigest: input.evidenceDigest,
            promotedAt: input.at,
        };
        if (current.promotion !== null) {
            if (canonicalJson(current.promotion) !== canonicalJson(promotion)) {
                throw sidecarProjectionConflict('Sidecar already belongs to a different repository promotion.');
            }
            return current;
        }
        current = appendBootstrapSidecarEvent(current, { promotion }, {
            eventKind: 'repository-default-promoted',
            evidenceDigest: input.evidenceDigest,
            recordedAt: input.at,
        });
        return current;
    }));
}
export function recordBootstrapSidecarAbandoned(storageRoot, input) {
    assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.abandonedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (!fs.existsSync(persistedBootstrapSidecarSessionPath(storageRoot, input.parentChangeId))) {
        ensureBootstrapSidecarSession(storageRoot, input.intervention);
    }
    return updateBootstrapSidecarSession(storageRoot, input.parentChangeId, (current) => {
        if (current.state === 'abandoned')
            return current;
        if (current.adoption !== null ||
            current.parentUnblock.state !== 'blocking') {
            throw sidecarProjectionConflict('An adopted sidecar cannot be abandoned as a pre-adoption repair.');
        }
        return appendBootstrapSidecarEvent(current, {
            state: 'abandoned',
            workflowBinding: transitionBootstrapMaintenanceWorkflow(current.workflowBinding, 'abandoned'),
            parentUnblock: {
                kind: 'sidecar-unblocks-parent.v1',
                parentChangeId: current.identity.parentChangeId,
                state: 'unblocked',
                resolution: 'abandonment',
                resolvedByTxId: null,
                resolvedAt: input.abandonedAt,
            },
        }, {
            eventKind: 'intervention-abandoned',
            evidenceDigest: input.evidenceDigest,
            recordedAt: input.abandonedAt,
        });
    });
}
export function preparePersistedEngineAdoption(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    const now = persistenceNow(dependencies);
    return withInterventionParentOperation(storageRoot, input.parentChangeId, () => {
        ensurePersistenceDirectories(storageRoot);
        const target = engineAdoptionRecordPath(storageRoot, input.txId);
        if (fs.existsSync(target)) {
            throw workflowError('INTERVENTION_ADOPTION_TRANSACTION_EXISTS', 'Engine adoption transaction already exists.', ExitCode.conflict);
        }
        const adoptionHistory = inspectAdoptionHistory(storageRoot, input.parentChangeId, input.maintenanceGrantEnvelope.payload.grantId);
        if (adoptionHistory.inFlightTxIds.length > 0) {
            throw workflowError('INTERVENTION_ADOPTION_ALREADY_ACTIVE', 'Another engine adoption transaction for this parent still requires recovery.', ExitCode.conflict, { details: { txIds: adoptionHistory.inFlightTxIds } });
        }
        const durablePriorAdoptions = adoptionHistory.successfulCount;
        if (input.priorLocalAdoptions !== durablePriorAdoptions) {
            throw workflowError('INTERVENTION_ADOPTION_COUNT_MISMATCH', 'Requested prior adoption count differs from durable history.', ExitCode.staleState);
        }
        const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
        const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(storageRoot, input.parentChangeId);
        const activeBindingDigest = sidecarWorkflow.workflowBinding.workflowBindingDigest;
        if (sidecarWorkflow.workflowBinding.status !== 'repair-active') {
            throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_NOT_ACTIVE', 'Engine adoption requires the active bootstrap-maintenance Workflow.', ExitCode.conflict);
        }
        if (input.artifact.workflowBindingDigest !== undefined &&
            input.artifact.workflowBindingDigest !== activeBindingDigest) {
            throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_MISMATCH', 'Engine adoption artifact is not bound to the exact active bootstrap-maintenance Workflow.', ExitCode.verification);
        }
        let storedArtifact;
        try {
            storedArtifact = readStoredInterventionEngineArtifact(storageRoot, input.artifact.artifactId);
        }
        catch (error) {
            if (error instanceof Error &&
                'code' in error &&
                error.code === 'INTERVENTION_ENGINE_ARTIFACT_NOT_FOUND') {
                storedArtifact = null;
            }
            else {
                throw error;
            }
        }
        if (storedArtifact !== null &&
            (storedArtifact.kind !== 'persisted-intervention-engine-artifact.v2' ||
                storedArtifact.parentChangeId !== input.parentChangeId ||
                storedArtifact.workflowBindingDigest !== activeBindingDigest ||
                canonicalJson(storedArtifact.artifact) !==
                    canonicalJson(input.artifact))) {
            throw workflowError('INTERVENTION_ADOPTION_ARTIFACT_RECORD_MISMATCH', 'Persisted artifact record does not match the exact adoption input and Workflow binding.', ExitCode.verification);
        }
        if (input.artifactAuthority !== undefined &&
            (storedArtifact === null ||
                input.artifactAuthority.recordDigest !==
                    storedArtifact.recordDigest ||
                input.artifactAuthority.createdAt !== storedArtifact.createdAt ||
                input.artifactAuthority.workflowBindingDigest !==
                    storedArtifact.workflowBindingDigest)) {
            throw workflowError('INTERVENTION_ADOPTION_ARTIFACT_AUTHORITY_STALE', 'Persisted artifact authority changed before the parent-scoped adoption reservation.', ExitCode.staleState);
        }
        const artifactAuthority = storedArtifact === null
            ? undefined
            : {
                recordDigest: storedArtifact.recordDigest,
                createdAt: storedArtifact.createdAt,
                workflowBindingDigest: storedArtifact.workflowBindingDigest,
            };
        if (artifactAuthority !== undefined &&
            artifactAuthority.workflowBindingDigest !== activeBindingDigest) {
            throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_MISMATCH', 'Persisted artifact authority is not bound to the exact active bootstrap-maintenance Workflow.', ExitCode.verification);
        }
        const maintenanceGrant = verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature,
        });
        const journal = prepareEngineAdoption({
            txId: input.txId,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            artifact: input.artifact,
            maintenanceGrant,
            priorLocalAdoptions: durablePriorAdoptions,
            now,
            workflowBindingDigest: activeBindingDigest,
            workflowStatus: 'repair-active',
        });
        recordBootstrapSidecarArtifactReady(storageRoot, {
            parentChangeId: input.parentChangeId,
            artifact: input.artifact,
            evidenceDigest: artifactAuthority?.recordDigest ??
                canonicalDigest({
                    kind: 'engine-adoption-workflow-artifact.v1',
                    artifactId: input.artifact.artifactId,
                    sourceDigest: input.artifact.sourceDigest,
                    executableDigest: input.artifact.executableDigest,
                    workflowBindingDigest: activeBindingDigest,
                }),
            readyAt: artifactAuthority?.createdAt ?? now.toISOString(),
        });
        const record = withRecordDigest({
            kind: 'persisted-engine-adoption.v2',
            journal,
            ...(artifactAuthority === undefined
                ? {}
                : { artifactRecordDigest: artifactAuthority.recordDigest }),
            maintenanceGrantEnvelope: input.maintenanceGrantEnvelope,
            grantEnvelopeDigest: canonicalDigest(input.maintenanceGrantEnvelope),
            observations: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            effectsPerformed: false,
        });
        createPrivateFileExclusive(target, serializeRecord(record));
        return record;
    });
}
export function advancePersistedEngineAdoption(storageRoot, input) {
    assertDigest(input.evidenceDigest, 'INTERVENTION_ADOPTION_EVIDENCE_INVALID');
    return withPersistenceOperation(storageRoot, `adoption:${input.txId}`, () => {
        const current = readPersistedEngineAdoption(storageRoot, input.txId);
        assertPersistedAdoptionWorkflowBinding(storageRoot, current);
        if (current.journal.journalDigest !== input.expectedJournalDigest) {
            throw workflowError('INTERVENTION_ADOPTION_CAS_MISMATCH', 'Engine adoption journal changed since it was read.', ExitCode.staleState);
        }
        const fromState = current.journal.state;
        const journal = advanceEngineAdoption(current.journal, input.event);
        const observation = {
            sequence: current.observations.length + 1,
            eventKind: input.event.kind,
            fromState,
            toState: journal.state,
            evidenceDigest: input.evidenceDigest,
            recordedAt: input.event.at,
        };
        const next = withRecordDigest({
            kind: current.kind,
            journal,
            ...(current.artifactRecordDigest === undefined
                ? {}
                : { artifactRecordDigest: current.artifactRecordDigest }),
            maintenanceGrantEnvelope: current.maintenanceGrantEnvelope,
            grantEnvelopeDigest: current.grantEnvelopeDigest,
            observations: [...current.observations, observation],
            createdAt: current.createdAt,
            updatedAt: input.event.at,
            effectsPerformed: false,
        });
        replacePrivateFileAtomic(engineAdoptionRecordPath(storageRoot, input.txId), serializeRecord(next));
        return next;
    });
}
export function renewPersistedEngineAdoptionAuthority(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    const now = persistenceNow(dependencies);
    return withPersistenceOperation(storageRoot, `adoption:${input.txId}`, () => {
        const current = readPersistedEngineAdoption(storageRoot, input.txId);
        assertPersistedAdoptionWorkflowBinding(storageRoot, current);
        if (current.journal.journalDigest !== input.expectedJournalDigest) {
            throw workflowError('INTERVENTION_ADOPTION_CAS_MISMATCH', 'Engine adoption journal changed before maintenance authority renewal.', ExitCode.staleState);
        }
        if (!['PREPARED', 'PARENT_CHECKPOINTED'].includes(current.journal.state)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_TOO_LATE', 'Maintenance authority can only be renewed before the engine binding switches.', ExitCode.conflict);
        }
        const previousPayload = current.maintenanceGrantEnvelope.payload;
        if (previousPayload.grantId !== current.journal.grantId) {
            throw adoptionRecordCorrupt();
        }
        if (now.getTime() < Date.parse(previousPayload.expiresAt)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_NOT_REQUIRED', 'The persisted maintenance authority has not expired.', ExitCode.conflict);
        }
        const intervention = readPersistedIntervention(storageRoot, current.journal.parentChangeId);
        const renewedGrant = verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature,
        });
        const renewedPayload = renewedGrant.payload;
        if (renewedPayload.grantId === previousPayload.grantId) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_GRANT_REUSED', 'Expired maintenance authority must be replaced by a newly issued grant.', ExitCode.conflict);
        }
        if (Date.parse(renewedPayload.issuedAt) <
            Date.parse(previousPayload.expiresAt)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_ISSUANCE_INVALID', 'Renewed maintenance authority must be issued after the previous authority expires.', ExitCode.verification);
        }
        if (canonicalDigest(maintenanceRenewalAuthority(previousPayload)) !==
            canonicalDigest(maintenanceRenewalAuthority(renewedPayload))) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_SCOPE_MISMATCH', 'Renewed maintenance authority differs from the exact persisted adoption authority.', ExitCode.verification);
        }
        const at = now.toISOString();
        if (Date.parse(at) < Date.parse(current.journal.history.at(-1).at)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_CLOCK_INVALID', 'Maintenance authority renewal cannot move the adoption journal clock backward.', ExitCode.staleState);
        }
        const { journalDigest: _journalDigest, ...journalPayload } = current.journal;
        const nextJournalPayload = {
            ...journalPayload,
            grantId: renewedPayload.grantId,
            history: [
                ...current.journal.history,
                { state: current.journal.state, at },
            ],
        };
        const journal = {
            ...nextJournalPayload,
            journalDigest: canonicalDigest(nextJournalPayload),
        };
        const renewedEnvelopeDigest = canonicalDigest(input.maintenanceGrantEnvelope);
        const observation = {
            sequence: current.observations.length + 1,
            eventKind: 'maintenance-grant-renewed',
            fromState: current.journal.state,
            toState: current.journal.state,
            evidenceDigest: canonicalDigest({
                kind: 'engine-adoption-authority-renewal.v1',
                previousGrantEnvelopeDigest: current.grantEnvelopeDigest,
                renewedGrantEnvelopeDigest: renewedEnvelopeDigest,
                previousJournalDigest: current.journal.journalDigest,
                renewedJournalDigest: journal.journalDigest,
            }),
            recordedAt: at,
        };
        const next = withRecordDigest({
            kind: current.kind,
            journal,
            ...(current.artifactRecordDigest === undefined
                ? {}
                : { artifactRecordDigest: current.artifactRecordDigest }),
            maintenanceGrantEnvelope: input.maintenanceGrantEnvelope,
            grantEnvelopeDigest: renewedEnvelopeDigest,
            observations: [...current.observations, observation],
            createdAt: current.createdAt,
            updatedAt: at,
            effectsPerformed: false,
        });
        replacePrivateFileAtomic(engineAdoptionRecordPath(storageRoot, input.txId), serializeRecord(next));
        return next;
    });
}
export function recoverPersistedEngineAdoption(storageRoot, txId) {
    const record = readPersistedEngineAdoption(storageRoot, txId);
    assertPersistedAdoptionWorkflowBinding(storageRoot, record);
    return { record, decision: decideEngineAdoptionRecovery(record.journal) };
}
export function rollbackPersistedEngineAdoption(storageRoot, input) {
    const current = readPersistedEngineAdoption(storageRoot, input.txId);
    assertPersistedAdoptionWorkflowBinding(storageRoot, current);
    if (current.journal.state !== 'ROLLBACK_REQUIRED') {
        throw workflowError('INTERVENTION_ADOPTION_ROLLBACK_NOT_REQUIRED', 'Engine adoption is not waiting for a durable binding rollback.', ExitCode.conflict);
    }
    return advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: input.expectedJournalDigest,
        event: { kind: 'engine-binding-rolled-back', at: input.at },
        evidenceDigest: input.evidenceDigest,
    });
}
export function readPersistedEngineAdoption(storageRoot, txId) {
    const value = readCanonicalRecord(engineAdoptionRecordPath(storageRoot, txId), 'INTERVENTION_ADOPTION_NOT_FOUND');
    if (!isRecord(value) ||
        !['persisted-engine-adoption.v1', 'persisted-engine-adoption.v2'].includes(String(value.kind)) ||
        !hasExactKeys(value, [
            'createdAt',
            'effectsPerformed',
            'grantEnvelopeDigest',
            'journal',
            'kind',
            'maintenanceGrantEnvelope',
            'observations',
            'recordDigest',
            'updatedAt',
        ].concat(Object.prototype.hasOwnProperty.call(value, 'artifactRecordDigest')
            ? ['artifactRecordDigest']
            : [])) ||
        !verifyRecordDigest(value)) {
        throw adoptionRecordCorrupt();
    }
    const record = value;
    try {
        if (record.journal.txId !== txId ||
            record.effectsPerformed !== false ||
            (record.artifactRecordDigest !== undefined &&
                !/^sha256:[0-9a-f]{64}$/.test(record.artifactRecordDigest)) ||
            canonicalDigest(record.maintenanceGrantEnvelope) !==
                record.grantEnvelopeDigest) {
            throw adoptionRecordCorrupt();
        }
        decideEngineAdoptionRecovery(record.journal);
        validateObservations(record.observations, record.journal.history.length - 1, record.journal.state);
        exactIso(record.createdAt, 'INTERVENTION_ADOPTION_RECORD_CORRUPT');
        exactIso(record.updatedAt, 'INTERVENTION_ADOPTION_RECORD_CORRUPT');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_ADOPTION_RECORD_CORRUPT') {
            throw error;
        }
        throw adoptionRecordCorrupt();
    }
    return record;
}
function assertPersistedAdoptionWorkflowBinding(storageRoot, record) {
    if (record.kind !== 'persisted-engine-adoption.v2' ||
        record.journal.workflowBindingDigest === undefined ||
        record.journal.workflowStatus !== 'repair-active') {
        throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_REQUIRED', 'Historical adoption metadata cannot cross a bootstrap Workflow authority boundary.', ExitCode.verification);
    }
    const sidecar = readPersistedBootstrapSidecarWorkflow(storageRoot, record.journal.parentChangeId);
    const activeBindingDigest = activeBootstrapMaintenanceWorkflowBindingDigest(sidecar.workflowBinding);
    if (record.journal.workflowBindingDigest !== activeBindingDigest ||
        ![
            sidecar.identity.interventionChangeId,
            sidecar.workflowBinding.changeId,
        ].every((changeId) => changeId === record.journal.interventionChangeId) ||
        (record.journal.state === 'COMMITTED'
            ? !['repair-active', 'adopted'].includes(sidecar.workflowBinding.status)
            : sidecar.workflowBinding.status !== 'repair-active')) {
        throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_MISMATCH', 'Persisted adoption no longer matches the exact bootstrap-maintenance Workflow binding and status.', ExitCode.verification);
    }
    return sidecar;
}
export function preparePersistedControlPlaneUpdate(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    if (dependencies.consumedGrantIds === undefined) {
        throw workflowError('INTERVENTION_CONTROL_CONSUMPTION_STATE_REQUIRED', 'Minimal updater preparation requires trusted grant consumption state.', ExitCode.guard);
    }
    const consumedGrantIds = dependencies.consumedGrantIds;
    const now = persistenceNow(dependencies);
    const grantId = input.envelope.payload.grantId;
    return withPersistenceOperation(storageRoot, 'control-update-reservation', () => {
        ensurePersistenceDirectories(storageRoot);
        const target = controlPlaneUpdateRecordPath(storageRoot, grantId);
        if (fs.existsSync(target)) {
            // Parse the record before reporting the reservation so corruption can
            // never be mistaken for a legitimate replay rejection.
            readPersistedControlPlaneUpdate(storageRoot, grantId);
            throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED', 'Control-Plane Grant already has a durable transaction.', ExitCode.conflict);
        }
        assertUniqueControlTransactionId(storageRoot, input.txId);
        const grant = verifyControlPlaneGrant(input.envelope, {
            now,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            changes: input.changes,
            consumedGrantIds,
            verifyHumanSignature,
        });
        const transaction = prepareMinimalUpdaterTransaction(grant, {
            txId: input.txId,
            now,
        });
        const record = withRecordDigest({
            kind: 'persisted-control-plane-update.v1',
            grantState: 'reserved',
            transaction,
            envelope: input.envelope,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            changes: input.changes,
            observations: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            effectsPerformed: false,
        });
        createPrivateFileExclusive(target, serializeRecord(record));
        return record;
    });
}
export function preparePersistedControlPlaneUpdateV2(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    if (dependencies.consumedGrantIds === undefined) {
        throw workflowError('INTERVENTION_CONTROL_CONSUMPTION_STATE_REQUIRED', 'Minimal updater v2 preparation requires trusted grant consumption state.', ExitCode.guard);
    }
    const consumedGrantIds = dependencies.consumedGrantIds;
    const now = persistenceNow(dependencies);
    const grantId = input.envelope.payload.grantId;
    return withPersistenceOperation(storageRoot, 'control-update-reservation', () => {
        ensurePersistenceDirectories(storageRoot);
        const target = controlPlaneUpdateRecordPath(storageRoot, grantId);
        if (fs.existsSync(target)) {
            readPersistedControlPlaneUpdate(storageRoot, grantId);
            throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED', 'Control-Plane Grant already has a durable transaction.', ExitCode.conflict);
        }
        assertUniqueControlTransactionId(storageRoot, input.txId);
        const grant = verifyControlPlaneGrantV2(input.envelope, {
            now,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            bundle: input.bundle,
            consumedGrantIds,
            verifyHumanSignature,
        });
        const transaction = prepareMinimalUpdaterTransaction(grant, {
            txId: input.txId,
            now,
        });
        const record = withRecordDigest({
            kind: 'persisted-control-plane-update.v2',
            grantState: 'reserved',
            transaction,
            envelope: input.envelope,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            changes: input.bundle.material.exactChanges,
            observations: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            effectsPerformed: false,
        });
        createPrivateFileExclusive(target, serializeRecord(record));
        return record;
    });
}
export function preparePersistedControlPlaneUpdateV3(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    if (dependencies.consumedGrantIds === undefined) {
        throw workflowError('INTERVENTION_CONTROL_CONSUMPTION_STATE_REQUIRED', 'Minimal updater v3 preparation requires trusted grant consumption state.', ExitCode.guard);
    }
    const consumedGrantIds = dependencies.consumedGrantIds;
    const now = persistenceNow(dependencies);
    const grantId = input.envelope.payload.grantId;
    return withPersistenceOperation(storageRoot, 'control-update-reservation', () => {
        ensurePersistenceDirectories(storageRoot);
        const target = controlPlaneUpdateRecordPath(storageRoot, grantId);
        if (fs.existsSync(target)) {
            readPersistedControlPlaneUpdate(storageRoot, grantId);
            throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED', 'Control-Plane Grant already has a durable transaction.', ExitCode.conflict);
        }
        assertUniqueControlTransactionId(storageRoot, input.txId);
        const grant = verifyControlPlaneGrantV3(input.envelope, {
            now,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            bundle: input.bundle,
            consumedGrantIds,
            verifyHumanSignature,
        });
        const transaction = prepareMinimalUpdaterTransaction(grant, {
            txId: input.txId,
            now,
        });
        const record = withRecordDigest({
            kind: 'persisted-control-plane-update.v3',
            grantState: 'reserved',
            transaction,
            envelope: input.envelope,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            changes: input.bundle.material.exactChanges,
            observations: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            effectsPerformed: false,
        });
        createPrivateFileExclusive(target, serializeRecord(record));
        return record;
    });
}
export function advancePersistedControlPlaneUpdate(storageRoot, input) {
    assertDigest(input.evidenceDigest, 'INTERVENTION_CONTROL_UPDATE_EVIDENCE_INVALID');
    return withPersistenceOperation(storageRoot, `control-update:${input.grantId}`, () => {
        const current = readPersistedControlPlaneUpdate(storageRoot, input.grantId);
        if (current.transaction.journalDigest !== input.expectedJournalDigest) {
            throw workflowError('INTERVENTION_CONTROL_UPDATE_CAS_MISMATCH', 'Minimal updater journal changed since it was read.', ExitCode.staleState);
        }
        if (current.grantState === 'consumed') {
            throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_CONSUMED', 'Control-Plane Grant transaction is terminal and cannot replay.', ExitCode.conflict);
        }
        const fromState = current.transaction.state;
        const transaction = advanceMinimalUpdaterTransaction(current.transaction, input.event);
        const observation = {
            sequence: current.observations.length + 1,
            eventKind: input.event.kind,
            fromState,
            toState: transaction.state,
            evidenceDigest: input.evidenceDigest,
            recordedAt: input.event.at,
        };
        const grantState = transaction.state === 'FINALIZED' || transaction.state === 'ROLLED_BACK'
            ? 'consumed'
            : 'reserved';
        const next = advanceControlPlaneUpdateRecord(current, transaction, observation, grantState, input.event.at);
        replacePrivateFileAtomic(controlPlaneUpdateRecordPath(storageRoot, input.grantId), serializeRecord(next));
        return next;
    });
}
function advanceControlPlaneUpdateRecord(current, transaction, observation, grantState, updatedAt) {
    const common = {
        grantState,
        transaction,
        beforeManifest: current.beforeManifest,
        afterManifest: current.afterManifest,
        observations: [...current.observations, observation],
        createdAt: current.createdAt,
        updatedAt,
        effectsPerformed: false,
    };
    switch (current.kind) {
        case 'persisted-control-plane-update.v1':
            return withRecordDigest({
                ...common,
                kind: current.kind,
                envelope: current.envelope,
                changes: current.changes,
            });
        case 'persisted-control-plane-update.v2':
            return withRecordDigest({
                ...common,
                kind: current.kind,
                envelope: current.envelope,
                changes: current.changes,
            });
        case 'persisted-control-plane-update.v3':
            return withRecordDigest({
                ...common,
                kind: current.kind,
                envelope: current.envelope,
                changes: current.changes,
            });
    }
}
export function recoverPersistedControlPlaneUpdate(storageRoot, grantId) {
    const record = readPersistedControlPlaneUpdate(storageRoot, grantId);
    return {
        record,
        decision: decideControlPlaneRecovery(record.transaction),
    };
}
export function readPersistedControlPlaneUpdate(storageRoot, grantId) {
    const value = readCanonicalRecord(controlPlaneUpdateRecordPath(storageRoot, grantId), 'INTERVENTION_CONTROL_UPDATE_NOT_FOUND');
    if (!isRecord(value) ||
        (value.kind !== 'persisted-control-plane-update.v1' &&
            value.kind !== 'persisted-control-plane-update.v2' &&
            value.kind !== 'persisted-control-plane-update.v3') ||
        !hasExactKeys(value, [
            'afterManifest',
            'beforeManifest',
            'changes',
            'createdAt',
            'effectsPerformed',
            'envelope',
            'grantState',
            'kind',
            'observations',
            'recordDigest',
            'transaction',
            'updatedAt',
        ]) ||
        !verifyRecordDigest(value)) {
        throw controlUpdateRecordCorrupt();
    }
    const record = value;
    try {
        if (record.envelope.payload.grantId !== grantId ||
            record.transaction.grantId !== grantId ||
            record.effectsPerformed !== false ||
            (record.grantState === 'consumed') !==
                (record.transaction.state === 'FINALIZED' ||
                    record.transaction.state === 'ROLLED_BACK')) {
            throw controlUpdateRecordCorrupt();
        }
        decideControlPlaneRecovery(record.transaction);
        validateObservations(record.observations, record.transaction.history.length - 1, record.transaction.state);
        exactIso(record.createdAt, 'INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT');
        exactIso(record.updatedAt, 'INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT') {
            throw error;
        }
        throw controlUpdateRecordCorrupt();
    }
    return record;
}
function ensureBootstrapSidecarSession(storageRoot, intervention) {
    const target = persistedBootstrapSidecarSessionPath(storageRoot, intervention.parent.changeId);
    const identity = {
        parentChangeId: intervention.parent.changeId,
        interventionChangeId: intervention.relationship.interventionChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
    };
    const createdAt = intervention.createdAt;
    const workflowBinding = createBootstrapMaintenanceWorkflow(intervention, 'repair-active');
    const payload = {
        kind: 'bootstrap-sidecar-session.v2',
        sidecarSessionId: canonicalDigest({
            kind: 'bootstrap-sidecar-session-identity.v2',
            ...identity,
            workflowId: workflowBinding.workflowId,
        }),
        identity,
        workflowBinding,
        state: 'repair-active',
        parentUnblock: {
            kind: 'sidecar-unblocks-parent.v1',
            parentChangeId: intervention.parent.changeId,
            state: 'blocking',
            resolution: null,
            resolvedByTxId: null,
            resolvedAt: null,
        },
        workspace: {
            childWorkspacePath: intervention.childWorkspace.childWorkspacePath,
            changeRef: intervention.childWorkspace.changeRef,
            state: 'planned',
            receiptDigest: null,
            materializedAt: null,
        },
        artifacts: [],
        adoption: null,
        promotion: null,
        history: [
            {
                sequence: 1,
                eventKind: 'sidecar-created',
                evidenceDigest: intervention.recordDigest,
                recordedAt: createdAt,
            },
        ],
        createdAt,
        updatedAt: createdAt,
    };
    const record = withRecordDigest(payload);
    if (fs.existsSync(target)) {
        const existing = readPersistedBootstrapSidecarWorkflow(storageRoot, intervention.parent.changeId);
        if (sidecarMatchesIntervention(existing, intervention))
            return existing;
        if (existing.state !== 'abandoned') {
            throw sidecarProjectionConflict('Persisted intervention differs from its active bootstrap sidecar identity.');
        }
        const archivePath = path.join(interventionControlPersistencePaths(storageRoot).sidecarHistory, `${identityFileName('sidecar-session-history', existing.sidecarSessionId)}.json`);
        if (fs.existsSync(archivePath)) {
            const archived = parseBootstrapSidecarWorkflow(readCanonicalRecord(archivePath, 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND'));
            if (canonicalJson(archived) !== canonicalJson(existing)) {
                throw sidecarProjectionConflict('Archived sidecar generation differs from the current tombstone.');
            }
        }
        else {
            createPrivateFileExclusive(archivePath, serializeRecord(existing));
        }
        replacePrivateFileAtomic(target, serializeRecord(record));
        return record;
    }
    createPrivateFileExclusive(target, serializeRecord(record));
    return record;
}
function updateBootstrapSidecarSession(storageRoot, parentChangeId, update) {
    return withPersistenceOperation(storageRoot, `sidecar-session:${parentChangeId}`, () => {
        const current = readPersistedBootstrapSidecarWorkflow(storageRoot, parentChangeId);
        const next = update(current);
        if (next.recordDigest === current.recordDigest)
            return current;
        parseBootstrapSidecarWorkflow(next, parentChangeId);
        replacePrivateFileAtomic(persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId), serializeRecord(next));
        return next;
    });
}
function appendBootstrapSidecarEvent(current, patch, event) {
    assertDigest(event.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(event.recordedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    const { recordDigest: _recordDigest, ...payload } = current;
    const updatedAt = Date.parse(event.recordedAt) > Date.parse(current.updatedAt)
        ? event.recordedAt
        : current.updatedAt;
    const next = withRecordDigest({
        ...payload,
        ...patch,
        history: [
            ...current.history,
            {
                sequence: current.history.length + 1,
                ...event,
            },
        ],
        updatedAt,
    });
    return next;
}
function ensureBootstrapSidecarArtifact(current, input) {
    assertDigest(input.artifact.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(input.artifact.sourceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(input.artifact.executableDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    const candidate = {
        artifactId: input.artifact.artifactId,
        sourceDigest: input.artifact.sourceDigest,
        executableDigest: input.artifact.executableDigest,
        evidenceDigest: input.evidenceDigest,
        readyAt: input.readyAt,
        workflowBindingDigest: activeBootstrapMaintenanceWorkflowBindingDigest(current.workflowBinding),
        workflowStatus: 'repair-active',
    };
    const existing = current.artifacts.find((artifact) => artifact.artifactId === input.artifact.artifactId);
    if (existing !== undefined) {
        if (existing.sourceDigest !== candidate.sourceDigest ||
            existing.executableDigest !== candidate.executableDigest ||
            existing.evidenceDigest !== candidate.evidenceDigest ||
            existing.readyAt !== candidate.readyAt ||
            existing.workflowBindingDigest !== candidate.workflowBindingDigest ||
            existing.workflowStatus !== candidate.workflowStatus) {
            throw sidecarProjectionConflict('Artifact id already has different sidecar content digests.');
        }
        return current;
    }
    return appendBootstrapSidecarEvent(current, { artifacts: [...current.artifacts, candidate] }, {
        eventKind: 'artifact-ready',
        evidenceDigest: input.evidenceDigest,
        recordedAt: input.readyAt,
    });
}
function assertSidecarArtifactSource(current, artifact) {
    if (artifact.sourceChangeId !== current.identity.interventionChangeId) {
        throw sidecarProjectionConflict('Engine artifact source does not belong to this sidecar.');
    }
    if (artifact.workflowBindingDigest !== undefined &&
        artifact.workflowBindingDigest !==
            activeBootstrapMaintenanceWorkflowBindingDigest(current.workflowBinding)) {
        throw sidecarProjectionConflict('Engine artifact belongs to a different bootstrap Workflow binding.');
    }
}
function assertSidecarActive(current) {
    if (current.state !== 'repair-active') {
        throw sidecarProjectionConflict('An abandoned sidecar cannot accept repair lifecycle events.');
    }
}
function sidecarMatchesIntervention(sidecar, intervention) {
    const expectedIdentity = {
        parentChangeId: intervention.parent.changeId,
        interventionChangeId: intervention.relationship.interventionChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
    };
    return (sidecar.sidecarSessionId ===
        canonicalDigest({
            kind: 'bootstrap-sidecar-session-identity.v2',
            ...expectedIdentity,
            workflowId: sidecar.workflowBinding.workflowId,
        }) &&
        canonicalJson(sidecar.identity) === canonicalJson(expectedIdentity) &&
        sidecar.workspace.childWorkspacePath ===
            intervention.childWorkspace.childWorkspacePath &&
        sidecar.workspace.changeRef === intervention.childWorkspace.changeRef &&
        canonicalJson(sidecar.workflowBinding) ===
            canonicalJson(createBootstrapMaintenanceWorkflow(intervention, sidecar.workflowBinding.status)) &&
        sidecar.state === 'repair-active');
}
function bootstrapMaintenanceWorkflowId(input) {
    return canonicalDigest({
        kind: 'bootstrap-maintenance-workflow-identity.v1',
        changeId: input.changeId,
        parentChangeId: input.parentChangeId,
        checkpointId: input.checkpointId,
        workspaceId: input.workspaceId,
    });
}
function bootstrapMaintenanceWorkflowPayload(binding) {
    return { ...binding };
}
function createBootstrapMaintenanceWorkflow(intervention, status) {
    const payload = {
        kind: 'bootstrap-maintenance-workflow.v1',
        workflowType: 'bootstrap-maintenance',
        workflowId: bootstrapMaintenanceWorkflowId({
            changeId: intervention.relationship.interventionChangeId,
            parentChangeId: intervention.parent.changeId,
            checkpointId: intervention.checkpoint.checkpointId,
            workspaceId: intervention.childWorkspace.workspaceId,
        }),
        changeId: intervention.relationship.interventionChangeId,
        parentChangeId: intervention.parent.changeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
        repositoryRoot: intervention.childWorkspace.childWorkspacePath,
        changeRef: intervention.childWorkspace.changeRef,
        baselineOid: intervention.childWorkspace.baseOid,
        status,
    };
    return {
        ...payload,
        workflowBindingDigest: canonicalDigest(bootstrapMaintenanceWorkflowPayload(payload)),
    };
}
function transitionBootstrapMaintenanceWorkflow(current, status) {
    const { workflowBindingDigest: _workflowBindingDigest, ...payload } = current;
    const next = { ...payload, status };
    return {
        ...next,
        workflowBindingDigest: canonicalDigest(bootstrapMaintenanceWorkflowPayload(next)),
    };
}
export function activeBootstrapMaintenanceWorkflowBindingDigest(current) {
    return transitionBootstrapMaintenanceWorkflow(current, 'repair-active')
        .workflowBindingDigest;
}
function parseBootstrapSidecarWorkflow(value, expectedParentChangeId) {
    try {
        if (!isRecord(value) ||
            value.kind !== 'bootstrap-sidecar-session.v2' ||
            !hasExactKeys(value, [
                'adoption',
                'artifacts',
                'createdAt',
                'history',
                'identity',
                'kind',
                'parentUnblock',
                'promotion',
                'recordDigest',
                'sidecarSessionId',
                'state',
                'updatedAt',
                'workflowBinding',
                'workspace',
            ]) ||
            !verifyRecordDigest(value)) {
            throw new Error('invalid sidecar workflow record');
        }
        const record = value;
        validateBootstrapSidecarWorkflow(record, expectedParentChangeId);
        return record;
    }
    catch {
        throw workflowError('INTERVENTION_SIDECAR_SESSION_CORRUPT', 'Bootstrap sidecar Workflow metadata is corrupt or inconsistent.', ExitCode.verification);
    }
}
function validateBootstrapSidecarWorkflow(record, expectedParentChangeId) {
    const binding = record.workflowBinding;
    if (!isRecord(binding) ||
        !hasExactKeys(binding, [
            'baselineOid',
            'changeId',
            'changeRef',
            'checkpointId',
            'kind',
            'parentChangeId',
            'repositoryRoot',
            'status',
            'workflowBindingDigest',
            'workflowId',
            'workflowType',
            'workspaceId',
        ]) ||
        binding.kind !== 'bootstrap-maintenance-workflow.v1' ||
        binding.workflowType !== 'bootstrap-maintenance' ||
        !['repair-active', 'adopted', 'abandoned'].includes(binding.status) ||
        binding.status !== record.state) {
        throw new Error('invalid bootstrap workflow binding');
    }
    assertSidecarIdentityText(binding.changeId);
    assertSidecarIdentityText(binding.parentChangeId);
    assertDigest(binding.workflowId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(binding.checkpointId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(binding.workspaceId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(binding.workflowBindingDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertAbsoluteWorkspacePath(binding.repositoryRoot);
    assertSafeChangeRef(binding.changeRef);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.baselineOid)) {
        throw new Error('invalid bootstrap workflow baseline');
    }
    const { workflowBindingDigest, ...bindingPayload } = binding;
    if (canonicalDigest(bootstrapMaintenanceWorkflowPayload(bindingPayload)) !==
        workflowBindingDigest ||
        binding.workflowId !==
            bootstrapMaintenanceWorkflowId({
                changeId: binding.changeId,
                parentChangeId: binding.parentChangeId,
                checkpointId: binding.checkpointId,
                workspaceId: binding.workspaceId,
            }) ||
        binding.changeId !== record.identity.interventionChangeId ||
        binding.parentChangeId !== record.identity.parentChangeId ||
        binding.checkpointId !== record.identity.checkpointId ||
        binding.workspaceId !== record.identity.workspaceId ||
        binding.repositoryRoot !== record.workspace.childWorkspacePath ||
        binding.changeRef !== record.workspace.changeRef ||
        (expectedParentChangeId !== undefined &&
            binding.parentChangeId !== expectedParentChangeId) ||
        record.sidecarSessionId !==
            canonicalDigest({
                kind: 'bootstrap-sidecar-session-identity.v2',
                ...record.identity,
                workflowId: binding.workflowId,
            })) {
        throw new Error('bootstrap workflow identity mismatch');
    }
    const activeBindingDigest = activeBootstrapMaintenanceWorkflowBindingDigest(binding);
    for (const artifact of record.artifacts) {
        if (!isRecord(artifact) ||
            !hasExactKeys(artifact, [
                'artifactId',
                'evidenceDigest',
                'executableDigest',
                'readyAt',
                'sourceDigest',
                'workflowBindingDigest',
                'workflowStatus',
            ]) ||
            artifact.workflowStatus !== 'repair-active' ||
            artifact.workflowBindingDigest !== activeBindingDigest) {
            throw new Error('artifact workflow binding mismatch');
        }
    }
    if (record.adoption !== null &&
        (!isRecord(record.adoption) ||
            !hasExactKeys(record.adoption, [
                'adoptedAt',
                'artifactId',
                'journalDigest',
                'txId',
                'workflowBindingDigest',
                'workflowStatus',
            ]) ||
            record.adoption.workflowStatus !== 'repair-active' ||
            record.adoption.workflowBindingDigest !== activeBindingDigest)) {
        throw new Error('adoption workflow binding mismatch');
    }
    if ((record.state === 'repair-active' && record.adoption !== null) ||
        (record.state === 'adopted' && record.adoption === null) ||
        (record.state === 'abandoned' && record.adoption !== null)) {
        throw new Error('bootstrap workflow status mismatch');
    }
    validateBootstrapSidecarSession(projectBootstrapSidecarSessionV1(record), expectedParentChangeId);
}
function projectBootstrapSidecarSessionV1(record) {
    const identity = { ...record.identity };
    const artifacts = record.artifacts.map(({ workflowBindingDigest: _workflowBindingDigest, workflowStatus: _workflowStatus, ...artifact }) => artifact);
    const adoption = record.adoption === null
        ? null
        : (({ workflowBindingDigest: _workflowBindingDigest, workflowStatus: _workflowStatus, ...value }) => value)(record.adoption);
    return withRecordDigest({
        kind: 'bootstrap-sidecar-session.v1',
        sidecarSessionId: canonicalDigest({
            kind: 'bootstrap-sidecar-session-identity.v1',
            ...identity,
        }),
        identity,
        state: record.state === 'adopted' ? 'repair-active' : record.state,
        parentUnblock: structuredClone(record.parentUnblock),
        workspace: structuredClone(record.workspace),
        artifacts,
        adoption,
        promotion: structuredClone(record.promotion),
        history: structuredClone(record.history),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    });
}
function parseBootstrapSidecarSession(value, expectedParentChangeId) {
    try {
        if (!isRecord(value) ||
            value.kind !== 'bootstrap-sidecar-session.v1' ||
            !hasExactKeys(value, [
                'adoption',
                'artifacts',
                'createdAt',
                'history',
                'identity',
                'kind',
                'parentUnblock',
                'promotion',
                'recordDigest',
                'sidecarSessionId',
                'state',
                'updatedAt',
                'workspace',
            ]) ||
            !verifyRecordDigest(value)) {
            throw new Error('invalid sidecar record');
        }
        const record = value;
        validateBootstrapSidecarSession(record, expectedParentChangeId);
        return record;
    }
    catch {
        throw workflowError('INTERVENTION_SIDECAR_SESSION_CORRUPT', 'Bootstrap sidecar session metadata is corrupt or inconsistent.', ExitCode.verification);
    }
}
function validateBootstrapSidecarSession(record, expectedParentChangeId) {
    if (!isRecord(record.identity) ||
        !hasExactKeys(record.identity, [
            'checkpointId',
            'interventionChangeId',
            'parentChangeId',
            'workspaceId',
        ]) ||
        !isRecord(record.parentUnblock) ||
        !hasExactKeys(record.parentUnblock, [
            'kind',
            'parentChangeId',
            'resolution',
            'resolvedAt',
            'resolvedByTxId',
            'state',
        ]) ||
        !isRecord(record.workspace) ||
        !hasExactKeys(record.workspace, [
            'changeRef',
            'childWorkspacePath',
            'materializedAt',
            'receiptDigest',
            'state',
        ])) {
        throw new Error('invalid sidecar structure');
    }
    assertSidecarIdentityText(record.identity.parentChangeId);
    assertSidecarIdentityText(record.identity.interventionChangeId);
    assertDigest(record.identity.checkpointId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.identity.workspaceId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.sidecarSessionId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (expectedParentChangeId !== undefined &&
        record.identity.parentChangeId !== expectedParentChangeId) {
        throw new Error('sidecar parent mismatch');
    }
    if (record.sidecarSessionId !==
        canonicalDigest({
            kind: 'bootstrap-sidecar-session-identity.v1',
            ...record.identity,
        })) {
        throw new Error('sidecar identity digest mismatch');
    }
    assertAbsoluteWorkspacePath(record.workspace.childWorkspacePath);
    assertSafeChangeRef(record.workspace.changeRef);
    if (record.parentUnblock.kind !== 'sidecar-unblocks-parent.v1' ||
        record.parentUnblock.parentChangeId !== record.identity.parentChangeId ||
        !['repair-active', 'abandoned'].includes(record.state)) {
        throw new Error('sidecar relationship mismatch');
    }
    if (record.workspace.state === 'planned') {
        if (record.workspace.receiptDigest !== null ||
            record.workspace.materializedAt !== null) {
            throw new Error('planned sidecar has materialization evidence');
        }
    }
    else if (record.workspace.state === 'materialized') {
        if (record.workspace.receiptDigest === null ||
            record.workspace.materializedAt === null) {
            throw new Error('materialized sidecar lacks evidence');
        }
        assertDigest(record.workspace.receiptDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        exactIso(record.workspace.materializedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    }
    else {
        throw new Error('invalid workspace state');
    }
    if (!Array.isArray(record.artifacts)) {
        throw new Error('invalid sidecar artifacts');
    }
    const artifactIds = new Set();
    for (const artifact of record.artifacts) {
        if (!isRecord(artifact) ||
            !hasExactKeys(artifact, [
                'artifactId',
                'evidenceDigest',
                'executableDigest',
                'readyAt',
                'sourceDigest',
            ])) {
            throw new Error('invalid sidecar artifact');
        }
        assertDigest(artifact.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        assertDigest(artifact.sourceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        assertDigest(artifact.executableDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        assertDigest(artifact.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        exactIso(artifact.readyAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        if (artifactIds.has(artifact.artifactId)) {
            throw new Error('duplicate sidecar artifact');
        }
        artifactIds.add(artifact.artifactId);
    }
    validateBootstrapSidecarAdoption(record, artifactIds);
    validateBootstrapSidecarPromotion(record, artifactIds);
    validateBootstrapSidecarRelation(record);
    validateBootstrapSidecarHistory(record);
}
function validateBootstrapSidecarAdoption(record, artifactIds) {
    if (record.adoption === null)
        return;
    if (!isRecord(record.adoption) ||
        !hasExactKeys(record.adoption, [
            'adoptedAt',
            'artifactId',
            'journalDigest',
            'txId',
        ])) {
        throw new Error('invalid sidecar adoption');
    }
    assertSidecarIdentityText(record.adoption.txId);
    assertDigest(record.adoption.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.adoption.journalDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(record.adoption.adoptedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (!artifactIds.has(record.adoption.artifactId)) {
        throw new Error('adoption artifact is not ready');
    }
}
function validateBootstrapSidecarPromotion(record, artifactIds) {
    if (record.promotion === null)
        return;
    if (!isRecord(record.promotion) ||
        !hasExactKeys(record.promotion, [
            'artifactId',
            'closureDigest',
            'evidenceDigest',
            'grantId',
            'promotedAt',
            'txId',
        ])) {
        throw new Error('invalid sidecar promotion');
    }
    assertSidecarIdentityText(record.promotion.grantId);
    assertSidecarIdentityText(record.promotion.txId);
    assertDigest(record.promotion.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.promotion.closureDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.promotion.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(record.promotion.promotedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (!artifactIds.has(record.promotion.artifactId)) {
        throw new Error('promotion artifact is not ready');
    }
}
function validateBootstrapSidecarRelation(record) {
    const relation = record.parentUnblock;
    if (relation.state === 'blocking') {
        if (relation.resolution !== null ||
            relation.resolvedByTxId !== null ||
            relation.resolvedAt !== null ||
            record.adoption !== null ||
            record.state !== 'repair-active') {
            throw new Error('invalid blocking relation');
        }
        return;
    }
    if (relation.state !== 'unblocked' || relation.resolvedAt === null) {
        throw new Error('invalid resolved relation');
    }
    exactIso(relation.resolvedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (relation.resolution === 'local-adoption') {
        if (record.adoption === null ||
            relation.resolvedByTxId !== record.adoption.txId ||
            relation.resolvedAt !== record.adoption.adoptedAt ||
            record.state !== 'repair-active') {
            throw new Error('invalid adoption relation');
        }
        return;
    }
    if (relation.resolution !== 'abandonment' ||
        relation.resolvedByTxId !== null ||
        record.adoption !== null ||
        record.state !== 'abandoned') {
        throw new Error('invalid abandonment relation');
    }
}
function validateBootstrapSidecarHistory(record) {
    if (!Array.isArray(record.history) || record.history.length === 0) {
        throw new Error('missing sidecar history');
    }
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const [index, entry] of record.history.entries()) {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, [
                'eventKind',
                'evidenceDigest',
                'recordedAt',
                'sequence',
            ]) ||
            entry.sequence !== index + 1 ||
            ![
                'sidecar-created',
                'workspace-materialized',
                'artifact-ready',
                'adopted-by-parent',
                'repository-default-promoted',
                'intervention-abandoned',
            ].includes(entry.eventKind)) {
            throw new Error('invalid sidecar history entry');
        }
        assertDigest(entry.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        exactIso(entry.recordedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        latestAt = Math.max(latestAt, Date.parse(entry.recordedAt));
    }
    if (record.history[0].eventKind !== 'sidecar-created' ||
        record.history[0].recordedAt !== record.createdAt ||
        new Date(latestAt).toISOString() !== record.updatedAt ||
        record.history.filter((entry) => entry.eventKind === 'sidecar-created')
            .length !== 1 ||
        record.history.filter((entry) => entry.eventKind === 'workspace-materialized').length !== (record.workspace.state === 'materialized' ? 1 : 0) ||
        record.history.filter((entry) => entry.eventKind === 'artifact-ready')
            .length !== record.artifacts.length ||
        record.history.filter((entry) => entry.eventKind === 'adopted-by-parent')
            .length !== (record.adoption === null ? 0 : 1) ||
        record.history.filter((entry) => entry.eventKind === 'repository-default-promoted').length !== (record.promotion === null ? 0 : 1) ||
        record.history.filter((entry) => entry.eventKind === 'intervention-abandoned').length !== (record.state === 'abandoned' ? 1 : 0)) {
        throw new Error('sidecar history does not match projection');
    }
    exactIso(record.createdAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(record.updatedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
}
function assertSidecarIdentityText(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value) {
        throw workflowError('INTERVENTION_SIDECAR_SESSION_INVALID', 'Sidecar identity must be a non-empty trimmed string.', ExitCode.usage);
    }
}
function sidecarProjectionConflict(message) {
    return workflowError('INTERVENTION_SIDECAR_SESSION_CONFLICT', message, ExitCode.conflict);
}
function createChildWorktreeMetadata(input) {
    const parentWorkspacePath = assertAbsoluteWorkspacePath(input.parentWorkspacePath);
    const childWorkspacePath = assertAbsoluteWorkspacePath(input.childWorkspacePath);
    if (parentWorkspacePath === childWorkspacePath ||
        isPathInside(parentWorkspacePath, childWorkspacePath) ||
        isPathInside(childWorkspacePath, parentWorkspacePath)) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_NOT_ISOLATED', 'Parent and intervention workspace paths must be disjoint.', ExitCode.guard);
    }
    assertExistingPlainWorkspace(parentWorkspacePath);
    if (fs.lstatSync(childWorkspacePath, { throwIfNoEntry: false })) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_PATH_OCCUPIED', 'Planned intervention workspace path already exists.', ExitCode.conflict);
    }
    assertSafeChangeRef(input.changeRef);
    const identity = childWorktreeIdentity({
        parentChangeId: input.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        checkpointId: input.checkpoint.checkpointId,
        parentWorkspacePath,
        childWorkspacePath,
        changeRef: input.changeRef,
    });
    const payload = {
        kind: 'intervention-child-worktree.v1',
        workspaceId: canonicalDigest(identity),
        parentChangeId: input.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        checkpointId: input.checkpoint.checkpointId,
        baseOid: input.checkpoint.baseOid,
        parentWorkspacePath,
        childWorkspacePath,
        changeRef: input.changeRef,
        state: 'planned',
        createdAt: input.createdAt,
        effectsPerformed: false,
    };
    return { ...payload, metadataDigest: canonicalDigest(payload) };
}
function verifyChildWorktreeMetadata(metadata) {
    const { metadataDigest, ...payload } = metadata;
    const expectedWorkspaceId = canonicalDigest(childWorktreeIdentity(metadata));
    if (metadata.kind !== 'intervention-child-worktree.v1' ||
        metadata.state !== 'planned' ||
        metadata.effectsPerformed !== false ||
        canonicalDigest(payload) !== metadataDigest ||
        metadata.workspaceId !== expectedWorkspaceId ||
        metadata.parentWorkspacePath === metadata.childWorkspacePath ||
        isPathInside(metadata.parentWorkspacePath, metadata.childWorkspacePath) ||
        isPathInside(metadata.childWorkspacePath, metadata.parentWorkspacePath)) {
        throw corruptPersistenceRecord();
    }
    assertDigest(metadata.workspaceId, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    assertDigest(metadata.checkpointId, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    exactIso(metadata.createdAt, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    assertAbsoluteWorkspacePath(metadata.parentWorkspacePath);
    assertAbsoluteWorkspacePath(metadata.childWorkspacePath);
    assertSafeChangeRef(metadata.changeRef);
}
function childWorktreeIdentity(input) {
    return {
        kind: 'intervention-child-worktree-identity.v1',
        parentChangeId: input.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        checkpointId: input.checkpointId,
        parentWorkspacePath: input.parentWorkspacePath,
        childWorkspacePath: input.childWorkspacePath,
        changeRef: input.changeRef,
    };
}
function writeContentAddressedCheckpoint(storageRoot, checkpoint) {
    const paths = interventionControlPersistencePaths(storageRoot);
    const target = path.join(paths.checkpoints, `${checkpoint.checkpointId.slice('sha256:'.length)}.json`);
    const content = `${canonicalJson(checkpoint)}\n`;
    if (fs.existsSync(target)) {
        if (readPrivateFile(target, 'INTERVENTION_CHECKPOINT_STORE_CORRUPT') !==
            content) {
            throw workflowError('INTERVENTION_CHECKPOINT_STORE_COLLISION', 'Content-addressed checkpoint path contains different bytes.', ExitCode.verification);
        }
        return;
    }
    createPrivateFileExclusive(target, content);
}
function verifyStoredCheckpoint(storageRoot, checkpoint) {
    const paths = interventionControlPersistencePaths(storageRoot);
    const target = path.join(paths.checkpoints, `${checkpoint.checkpointId.slice('sha256:'.length)}.json`);
    const expected = `${canonicalJson(checkpoint)}\n`;
    let observed;
    try {
        observed = readPrivateFile(target, 'INTERVENTION_CHECKPOINT_STORE_MISSING');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_CHECKPOINT_STORE_MISSING') {
            throw workflowError('INTERVENTION_CHECKPOINT_STORE_MISSING', 'Persisted intervention checkpoint object is missing.', ExitCode.verification);
        }
        throw error;
    }
    if (observed !== expected) {
        throw workflowError('INTERVENTION_CHECKPOINT_STORE_CORRUPT', 'Persisted intervention checkpoint object has changed.', ExitCode.verification);
    }
}
function sameInterventionPlan(left, right) {
    return (left.checkpoint.checkpointId === right.checkpoint.checkpointId &&
        left.relationship.interventionChangeId ===
            right.relationship.interventionChangeId &&
        left.childWorkspace.parentWorkspacePath ===
            right.childWorkspace.parentWorkspacePath &&
        left.childWorkspace.childWorkspacePath ===
            right.childWorkspace.childWorkspacePath &&
        left.childWorkspace.changeRef === right.childWorkspace.changeRef);
}
function assertUniqueChildWorkspaceReservation(storageRoot, candidate) {
    const paths = interventionControlPersistencePaths(storageRoot);
    for (const name of fs.readdirSync(paths.interventions).sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) {
            throw corruptPersistenceRecord();
        }
        const value = readCanonicalRecord(path.join(paths.interventions, name), 'INTERVENTION_PERSISTENCE_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.parent) ||
            typeof value.parent.changeId !== 'string' ||
            name !== `${identityFileName('intervention', value.parent.changeId)}.json`) {
            throw corruptPersistenceRecord();
        }
        const existing = readPersistedIntervention(storageRoot, value.parent.changeId);
        if (existing.childWorkspace.workspaceId ===
            candidate.childWorkspace.workspaceId ||
            existing.childWorkspace.childWorkspacePath ===
                candidate.childWorkspace.childWorkspacePath ||
            existing.childWorkspace.changeRef === candidate.childWorkspace.changeRef) {
            throw workflowError('INTERVENTION_CHILD_WORKSPACE_RESERVATION_CONFLICT', 'Child workspace path or change ref is already reserved.', ExitCode.conflict);
        }
    }
}
function inspectAdoptionHistory(storageRoot, parentChangeId, grantId) {
    const paths = interventionControlPersistencePaths(storageRoot);
    if (!fs.existsSync(paths.adoptions)) {
        return { successfulCount: 0, inFlightTxIds: [] };
    }
    let successfulCount = 0;
    const inFlightTxIds = [];
    for (const name of fs.readdirSync(paths.adoptions).sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) {
            throw workflowError('INTERVENTION_ADOPTION_STORE_UNSAFE', 'Adoption store contains an unexpected entry.', ExitCode.unsafeEnvironment);
        }
        const value = readCanonicalRecord(path.join(paths.adoptions, name), 'INTERVENTION_ADOPTION_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.journal) ||
            typeof value.journal.txId !== 'string' ||
            !isRecord(value.maintenanceGrantEnvelope) ||
            !isRecord(value.maintenanceGrantEnvelope.payload)) {
            throw adoptionRecordCorrupt();
        }
        if (name !== `${identityFileName('adoption', value.journal.txId)}.json`) {
            throw adoptionRecordCorrupt();
        }
        const record = readPersistedEngineAdoption(storageRoot, value.journal.txId);
        if (record.journal.parentChangeId === parentChangeId &&
            !['COMMITTED', 'ENGINE_BINDING_ROLLED_BACK'].includes(record.journal.state)) {
            inFlightTxIds.push(record.journal.txId);
        }
        if (record.maintenanceGrantEnvelope.payload.grantId === grantId &&
            record.journal.state === 'COMMITTED') {
            successfulCount += 1;
        }
    }
    return { successfulCount, inFlightTxIds };
}
export function inFlightPersistedEngineAdoptionTxIds(storageRoot, parentChangeId) {
    return inspectAdoptionHistory(storageRoot, parentChangeId, '').inFlightTxIds;
}
function maintenanceRenewalAuthority(payload) {
    return {
        kind: payload.kind,
        parentChangeId: payload.parentChangeId,
        interventionChangeId: payload.interventionChangeId,
        scope: payload.scope,
        waivers: payload.waivers,
        engineFromDigest: payload.engineFromDigest,
        sessionSchema: payload.sessionSchema,
        maxLocalAdoptions: payload.maxLocalAdoptions,
        reason: payload.reason,
    };
}
function assertUniqueControlTransactionId(storageRoot, txId) {
    const paths = interventionControlPersistencePaths(storageRoot);
    for (const name of fs.readdirSync(paths.controlUpdates).sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) {
            throw controlUpdateRecordCorrupt();
        }
        const value = readCanonicalRecord(path.join(paths.controlUpdates, name), 'INTERVENTION_CONTROL_UPDATE_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.envelope) ||
            !isRecord(value.envelope.payload) ||
            typeof value.envelope.payload.grantId !== 'string') {
            throw controlUpdateRecordCorrupt();
        }
        const grantId = value.envelope.payload.grantId;
        if (name !== `${identityFileName('control-update', grantId)}.json`) {
            throw controlUpdateRecordCorrupt();
        }
        const record = readPersistedControlPlaneUpdate(storageRoot, grantId);
        if (record.transaction.txId === txId) {
            throw workflowError('INTERVENTION_CONTROL_TRANSACTION_ID_CONFLICT', 'Minimal updater transaction id already exists.', ExitCode.conflict);
        }
    }
}
function validateObservations(observations, expectedCount, terminalState) {
    if (!Array.isArray(observations) || observations.length !== expectedCount) {
        throw new Error('Observation count mismatch.');
    }
    for (let index = 0; index < observations.length; index += 1) {
        const observation = observations[index];
        if (observation.sequence !== index + 1 ||
            typeof observation.eventKind !== 'string' ||
            observation.eventKind.length === 0 ||
            typeof observation.fromState !== 'string' ||
            typeof observation.toState !== 'string') {
            throw new Error('Observation is invalid.');
        }
        assertDigest(observation.evidenceDigest, 'OBSERVATION_INVALID');
        exactIso(observation.recordedAt, 'OBSERVATION_INVALID');
        if (index > 0 &&
            observations[index - 1].toState !== observation.fromState) {
            throw new Error('Observation chain is discontinuous.');
        }
    }
    if (observations.length > 0 &&
        observations.at(-1)?.toState !== terminalState) {
        throw new Error('Observation state does not match journal.');
    }
}
function ensurePersistenceDirectories(storageRoot) {
    const paths = interventionControlPersistencePaths(storageRoot);
    for (const directory of [
        paths.root,
        paths.checkpoints,
        paths.interventions,
        paths.sidecarSessions,
        paths.sidecarHistory,
        paths.sidecarPromotionPins,
        paths.adoptions,
        paths.controlUpdates,
        paths.operations,
    ]) {
        ensurePlainDirectory(directory);
        const stats = fs.statSync(directory);
        if ((stats.mode & 0o077) !== 0) {
            try {
                fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
            }
            catch {
                throw workflowError('INTERVENTION_PERSISTENCE_DIRECTORY_UNSAFE', 'Persistence directory permissions are not private.', ExitCode.unsafeEnvironment);
            }
        }
    }
}
function withPersistenceOperation(storageRoot, operationKey, operation) {
    ensurePersistenceDirectories(storageRoot);
    const paths = interventionControlPersistencePaths(storageRoot);
    const lockPath = path.join(paths.operations, `${identityFileName('operation', operationKey)}.lock`);
    const ownerToken = crypto.randomUUID();
    const content = `${canonicalJson({ operationKey, ownerToken, pid: process.pid })}\n`;
    let descriptor;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            descriptor = publishPreparedExclusiveLock(lockPath, content, ownerToken, unsafePersistenceLock);
            break;
        }
        catch (error) {
            if (isNodeError(error) && error.code === 'EEXIST' && attempt === 0) {
                const reclaimed = reclaimDeadPreparedLock(lockPath, (raw) => {
                    let value;
                    try {
                        value = JSON.parse(raw);
                    }
                    catch {
                        return null;
                    }
                    if (!isRecord(value) ||
                        value.operationKey !== operationKey ||
                        typeof value.ownerToken !== 'string' ||
                        !Number.isSafeInteger(value.pid) ||
                        `${canonicalJson(value)}\n` !== raw) {
                        return null;
                    }
                    return {
                        pid: value.pid,
                        ownerToken: value.ownerToken,
                    };
                });
                if (reclaimed === 'absent' || reclaimed === 'reclaimed') {
                    continue;
                }
                if (reclaimed === 'unsafe') {
                    throw unsafePersistenceLock();
                }
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workflowError('INTERVENTION_PERSISTENCE_OPERATION_CONFLICT', 'A persistence operation is already in progress.', ExitCode.conflict);
            }
            throw error;
        }
    }
    if (descriptor === undefined) {
        throw unsafePersistenceLock();
    }
    try {
        return operation();
    }
    finally {
        releasePersistenceLock(lockPath, descriptor, content);
    }
}
export function withInterventionParentOperation(storageRoot, parentChangeId, operation) {
    if (typeof parentChangeId !== 'string' ||
        parentChangeId.length === 0 ||
        parentChangeId.trim() !== parentChangeId) {
        throw workflowError('INTERVENTION_PARENT_OPERATION_INVALID', 'Parent lifecycle operation requires an exact parent change id.', ExitCode.usage);
    }
    return withPersistenceOperation(storageRoot, `parent-lifecycle:${parentChangeId}`, operation);
}
function releasePersistenceLock(lockPath, descriptor, content) {
    try {
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        const buffer = Buffer.alloc(Buffer.byteLength(content));
        const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        if (!owned.isFile() ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== PRIVATE_FILE_MODE ||
            !observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            bytes !== buffer.length ||
            buffer.toString('utf8') !== content) {
            throw unsafePersistenceLock();
        }
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function createPrivateFileExclusive(filePath, content) {
    ensurePlainDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    let failure;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        failure = error;
    }
    if (descriptor !== undefined) {
        try {
            fs.closeSync(descriptor);
        }
        catch (error) {
            failure ??= error;
        }
    }
    try {
        fs.unlinkSync(temporaryPath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            failure ??= error;
        }
    }
    if (failure !== undefined) {
        throw failure;
    }
}
function replacePrivateFileAtomic(filePath, content) {
    assertPrivateRegularFile(filePath, 'INTERVENTION_PERSISTENCE_RECORD_UNSAFE');
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    let failure;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        failure = error;
    }
    if (descriptor !== undefined) {
        try {
            fs.closeSync(descriptor);
        }
        catch (error) {
            failure ??= error;
        }
    }
    try {
        fs.unlinkSync(temporaryPath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            failure ??= error;
        }
    }
    if (failure !== undefined) {
        throw failure;
    }
}
function readCanonicalRecord(filePath, notFoundCode) {
    const content = readPrivateFile(filePath, notFoundCode);
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw workflowError('INTERVENTION_PERSISTENCE_RECORD_CORRUPT', 'Persistence record is not valid JSON.', ExitCode.verification);
    }
    if (`${canonicalJson(value)}\n` !== content) {
        throw corruptPersistenceRecord();
    }
    return value;
}
function readPrivateFile(filePath, notFoundCode) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        throw workflowError(notFoundCode, 'Intervention persistence record was not found.', ExitCode.conflict);
    }
    assertPrivateRegularFile(filePath, 'INTERVENTION_PERSISTENCE_RECORD_UNSAFE');
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            opened.size > MAX_RECORD_BYTES) {
            throw workflowError('INTERVENTION_PERSISTENCE_RECORD_UNSAFE', 'Persistence record changed while being opened or is too large.', ExitCode.unsafeEnvironment);
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function assertPrivateRegularFile(filePath, code) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw workflowError(code, 'Persistence record is not a private regular file.', ExitCode.unsafeEnvironment);
    }
}
function serializeRecord(value) {
    const serialized = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        throw workflowError('INTERVENTION_PERSISTENCE_RECORD_TOO_LARGE', 'Persistence record exceeds the four-megabyte limit.', ExitCode.guard);
    }
    return serialized;
}
function withRecordDigest(payload) {
    return { ...payload, recordDigest: canonicalDigest(payload) };
}
function verifyRecordDigest(value) {
    if (!isDigest(value.recordDigest)) {
        return false;
    }
    const { recordDigest, ...payload } = value;
    return canonicalDigest(payload) === recordDigest;
}
function canonicalDigest(value) {
    return `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(value))
        .digest('hex')}`;
}
function identityFileName(kind, identity) {
    if (typeof identity !== 'string' ||
        identity.trim() !== identity ||
        identity.length === 0) {
        throw workflowError('INTERVENTION_PERSISTENCE_ID_INVALID', 'Persistence identity must be a non-empty trimmed string.', ExitCode.usage);
    }
    return crypto
        .createHash('sha256')
        .update(`${kind}\0${identity}`)
        .digest('hex');
}
function assertStorageRoot(requestedRoot) {
    if (typeof requestedRoot !== 'string' || !path.isAbsolute(requestedRoot)) {
        throw workflowError('INTERVENTION_PERSISTENCE_ROOT_INVALID', 'Persistence root must be an explicit absolute path.', ExitCode.usage);
    }
    const root = path.resolve(requestedRoot);
    if (root === path.parse(root).root) {
        throw workflowError('INTERVENTION_PERSISTENCE_ROOT_INVALID', 'Filesystem root cannot be used as intervention persistence.', ExitCode.guard);
    }
    return root;
}
function assertAbsoluteWorkspacePath(value) {
    if (typeof value !== 'string' ||
        !path.isAbsolute(value) ||
        path.resolve(value) !== value ||
        value === path.parse(value).root) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_PATH_INVALID', 'Workspace path must be an explicit normalized absolute path.', ExitCode.usage);
    }
    return value;
}
function assertExistingPlainWorkspace(workspacePath) {
    const stats = fs.lstatSync(workspacePath, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(workspacePath) !== workspacePath) {
        throw workflowError('INTERVENTION_PARENT_WORKSPACE_UNSAFE', 'Parent workspace must be an existing plain directory.', ExitCode.unsafeEnvironment);
    }
}
function isPathInside(parentPath, childPath) {
    const relative = path.relative(parentPath, childPath);
    return (relative.length > 0 &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative));
}
function assertSafeChangeRef(value) {
    const hasControlOrSpace = typeof value === 'string' &&
        [...value].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0x20 || codePoint === 0x7f;
        });
    if (typeof value !== 'string' ||
        !value.startsWith('refs/heads/') ||
        value.includes('..') ||
        value.includes('@{') ||
        value.includes('\\') ||
        value.includes('//') ||
        value.endsWith('/') ||
        value.endsWith('.lock') ||
        hasControlOrSpace ||
        /[~^:?*[\]]/.test(value)) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_REF_INVALID', 'Child workspace metadata requires a safe branch ref.', ExitCode.usage);
    }
}
function requireHumanVerifier(dependencies) {
    if (dependencies.verifyHumanSignature === undefined) {
        throw workflowError('INTERVENTION_PERSISTENCE_HUMAN_VERIFIER_REQUIRED', 'A trusted human signature verifier is required.', ExitCode.guard);
    }
    return dependencies.verifyHumanSignature;
}
function persistenceNow(dependencies) {
    return exactDate(dependencies.now?.() ?? new Date(), 'INTERVENTION_PERSISTENCE_CLOCK_INVALID');
}
function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError(code, 'Persistence clock is invalid.', ExitCode.unsafeEnvironment);
    }
    return new Date(value.getTime());
}
function exactIso(value, code) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw workflowError(code, 'Stored timestamp is invalid.', ExitCode.verification);
    }
}
function assertDigest(value, code) {
    if (!isDigest(value)) {
        throw workflowError(code, 'Expected a canonical sha256 digest.', ExitCode.usage);
    }
}
function isDigest(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function isCanonicalIso(value) {
    return (typeof value === 'string' &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
function hasExactKeys(value, keys) {
    return (JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...keys].sort()));
}
function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype);
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
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function corruptPersistenceRecord() {
    return workflowError('INTERVENTION_PERSISTENCE_RECORD_CORRUPT', 'Persisted intervention record failed integrity verification.', ExitCode.verification);
}
function adoptionRecordCorrupt() {
    return workflowError('INTERVENTION_ADOPTION_RECORD_CORRUPT', 'Persisted adoption record failed integrity verification.', ExitCode.verification);
}
function controlUpdateRecordCorrupt() {
    return workflowError('INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT', 'Persisted minimal updater record failed integrity verification.', ExitCode.verification);
}
function unsafePersistenceLock() {
    return workflowError('INTERVENTION_PERSISTENCE_LOCK_UNSAFE', 'Persistence operation lock is unsafe.', ExitCode.unsafeEnvironment);
}
