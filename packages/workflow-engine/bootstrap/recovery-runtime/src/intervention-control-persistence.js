import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { ensurePlainDirectory, publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from './filesystem-safety.js';
import { advanceEngineAdoption, advanceMinimalUpdaterTransaction, beginHarnessIntervention, createWipCheckpoint, decideControlPlaneRecovery, decideEngineAdoptionRecovery, prepareEngineAdoption, prepareMinimalUpdaterTransaction, verifyControlPlaneGrant, verifyHarnessMaintenanceGrant, verifyWipCheckpoint, } from './intervention-control.js';
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
export function interventionControlPersistencePaths(requestedRoot) {
    const root = assertStorageRoot(requestedRoot);
    return {
        root,
        checkpoints: path.join(root, 'checkpoints'),
        interventions: path.join(root, 'interventions'),
        adoptions: path.join(root, 'adoptions'),
        controlUpdates: path.join(root, 'control-updates'),
        operations: path.join(root, 'operations'),
    };
}
export function interventionRecordPath(storageRoot, parentChangeId) {
    return path.join(interventionControlPersistencePaths(storageRoot).interventions, `${identityFileName('intervention', parentChangeId)}.json`);
}
export function engineAdoptionRecordPath(storageRoot, txId) {
    return path.join(interventionControlPersistencePaths(storageRoot).adoptions, `${identityFileName('adoption', txId)}.json`);
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
                return existing;
            }
            throw workflowError('INTERVENTION_PERSISTENCE_ACTIVE_CONFLICT', 'The parent already has a different persisted intervention.', ExitCode.conflict);
        }
        assertUniqueChildWorkspaceReservation(storageRoot, candidate);
        writeContentAddressedCheckpoint(storageRoot, checkpoint);
        createPrivateFileExclusive(target, serializeRecord(candidate));
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
export function preparePersistedEngineAdoption(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    const now = persistenceNow(dependencies);
    return withPersistenceOperation(storageRoot, 'adoption-reservation', () => {
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
        });
        const record = withRecordDigest({
            kind: 'persisted-engine-adoption.v1',
            journal,
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
export function recoverPersistedEngineAdoption(storageRoot, txId) {
    const record = readPersistedEngineAdoption(storageRoot, txId);
    return { record, decision: decideEngineAdoptionRecovery(record.journal) };
}
export function rollbackPersistedEngineAdoption(storageRoot, input) {
    const current = readPersistedEngineAdoption(storageRoot, input.txId);
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
        value.kind !== 'persisted-engine-adoption.v1' ||
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
        ]) ||
        !verifyRecordDigest(value)) {
        throw adoptionRecordCorrupt();
    }
    const record = value;
    try {
        if (record.journal.txId !== txId ||
            record.effectsPerformed !== false ||
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
        const next = withRecordDigest({
            kind: current.kind,
            grantState,
            transaction,
            envelope: current.envelope,
            beforeManifest: current.beforeManifest,
            afterManifest: current.afterManifest,
            changes: current.changes,
            observations: [...current.observations, observation],
            createdAt: current.createdAt,
            updatedAt: input.event.at,
            effectsPerformed: false,
        });
        replacePrivateFileAtomic(controlPlaneUpdateRecordPath(storageRoot, input.grantId), serializeRecord(next));
        return next;
    });
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
        value.kind !== 'persisted-control-plane-update.v1' ||
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
