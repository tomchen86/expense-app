import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson, compareCanonicalStrings } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
export const HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE = 'expense-app.harness-maintenance-grant.v1';
export const CONTROL_PLANE_SIGNATURE_NAMESPACE = 'expense-app.control-plane-grant.v1';
export const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE = 'expense-app.control-plane-independent-review.v1';
export const CONTROL_PLANE_SIGNATURE_NAMESPACE_V2 = 'expense-app.control-plane-grant.v2';
export const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2 = 'expense-app.control-plane-independent-review.v2';
export const CONTROL_PLANE_SIGNATURE_NAMESPACE_V3 = 'expense-app.control-plane-grant.v3';
export const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3 = 'expense-app.control-plane-independent-review.v3';
function verifyHumanSignatureSafely(verifier, payload, signature, signer, namespace) {
    try {
        return verifier(payload, signature, signer, namespace);
    }
    catch {
        return false;
    }
}
function sha256(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function canonicalDigest(value) {
    return sha256(canonicalJson(value));
}
function assertDigest(value, code) {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw workflowError(code, 'Expected a canonical sha256 digest.', ExitCode.usage);
    }
}
function assertNonEmpty(value, code, label) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0) {
        throw workflowError(code, `${label} must be a non-empty trimmed string.`, ExitCode.usage);
    }
}
function assertIsoTimestamp(value, code) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw workflowError(code, 'Expected a canonical ISO-8601 timestamp.', ExitCode.usage);
    }
}
function assertSortedUnique(values, code) {
    const expected = [...new Set(values)].sort(compareCanonicalStrings);
    if (canonicalJson(values) !== canonicalJson(expected)) {
        throw workflowError(code, 'Values must be sorted and unique.', ExitCode.usage);
    }
}
function assertSafePath(value, allowGlob, code) {
    assertNonEmpty(value, code, 'Path');
    if (value !== value.normalize('NFC') ||
        value.startsWith('/') ||
        value.includes('\\') ||
        value
            .split('/')
            .some((part) => part === '' || part === '.' || part === '..') ||
        (!allowGlob && /[*?[\]{}]/.test(value))) {
        throw workflowError(code, `Unsafe path: ${value}`, ExitCode.usage);
    }
}
function freezeDeep(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freezeDeep(child);
        }
        Object.freeze(value);
    }
    return value;
}
function sameJson(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}
function hasExactObjectKeys(value, keys) {
    return (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        sameJson(Object.keys(value).sort(), [...keys].sort()));
}
function assertMonotonicTimestamp(previous, next, code) {
    assertIsoTimestamp(next, code);
    if (Date.parse(next) < Date.parse(previous)) {
        throw workflowError(code, 'Journal timestamps must be monotonic.', ExitCode.staleState);
    }
}
function checkpointPayload(input) {
    return {
        kind: 'harness-wip-checkpoint.v1',
        parentChangeId: input.parentChangeId,
        baseOid: input.baseOid,
        worktreeFingerprint: input.worktreeFingerprint,
        trackedTreeDigest: input.trackedTreeDigest,
        untrackedBundleDigest: input.untrackedBundleDigest,
        sessionStateDigest: input.sessionStateDigest,
        pendingIntentDigest: input.pendingIntentDigest,
        engineDigest: input.engineDigest,
        policyDigest: input.policyDigest,
        createdAt: input.createdAt,
    };
}
function validateCheckpointInput(input) {
    assertNonEmpty(input.parentChangeId, 'INTERVENTION_CHECKPOINT_INVALID', 'Parent change id');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseOid)) {
        throw workflowError('INTERVENTION_CHECKPOINT_INVALID', 'Checkpoint baseOid must be a full Git object id.', ExitCode.usage);
    }
    for (const digest of [
        input.worktreeFingerprint,
        input.trackedTreeDigest,
        input.untrackedBundleDigest,
        input.sessionStateDigest,
        input.pendingIntentDigest,
        input.engineDigest,
        input.policyDigest,
    ]) {
        assertDigest(digest, 'INTERVENTION_CHECKPOINT_INVALID');
    }
    assertIsoTimestamp(input.createdAt, 'INTERVENTION_CHECKPOINT_INVALID');
}
export function createWipCheckpoint(input) {
    validateCheckpointInput(input);
    const payload = checkpointPayload(input);
    return freezeDeep({
        ...payload,
        checkpointId: canonicalDigest(payload),
    });
}
export function verifyWipCheckpoint(checkpoint) {
    validateCheckpointInput(checkpoint);
    if (checkpoint.kind !== 'harness-wip-checkpoint.v1') {
        throw workflowError('INTERVENTION_CHECKPOINT_INVALID', 'Unknown WIP checkpoint schema.', ExitCode.usage);
    }
    assertDigest(checkpoint.checkpointId, 'INTERVENTION_CHECKPOINT_INVALID');
    const expected = canonicalDigest(checkpointPayload(checkpoint));
    if (checkpoint.checkpointId !== expected) {
        throw workflowError('INTERVENTION_CHECKPOINT_DIGEST_MISMATCH', 'WIP checkpoint content no longer matches its immutable digest.', ExitCode.verification, { details: { expected, actual: checkpoint.checkpointId } });
    }
    return freezeDeep({ ...checkpoint });
}
export function beginHarnessIntervention(parent, interventionChangeId, checkpointValue) {
    const checkpoint = verifyWipCheckpoint(checkpointValue);
    assertNonEmpty(interventionChangeId, 'INTERVENTION_CHANGE_ID_INVALID', 'Intervention change id');
    if (parent.status !== 'active') {
        throw workflowError('INTERVENTION_PARENT_NOT_ACTIVE', 'An intervention can only block an active parent change.', ExitCode.conflict);
    }
    if (parent.blocker?.kind === 'harness-intervention') {
        throw workflowError('INTERVENTION_ALREADY_ACTIVE', 'The parent already has an active harness intervention.', ExitCode.conflict);
    }
    if (parent.blocker !== null) {
        throw workflowError('INTERVENTION_PARENT_BLOCKED', 'The parent has another blocker that must be resolved first.', ExitCode.conflict);
    }
    assertDigest(parent.engineBinding, 'INTERVENTION_PARENT_INVALID');
    assertNonEmpty(parent.sessionSchema, 'INTERVENTION_PARENT_INVALID', 'Session schema');
    if (checkpoint.parentChangeId !== parent.changeId ||
        checkpoint.engineDigest !== parent.engineBinding) {
        throw workflowError('INTERVENTION_CHECKPOINT_PARENT_MISMATCH', 'Checkpoint is not bound to the exact parent and engine state.', ExitCode.verification);
    }
    if (interventionChangeId === parent.changeId) {
        throw workflowError('INTERVENTION_SELF_REFERENCE_FORBIDDEN', 'The intervention change must be distinct from its parent.', ExitCode.usage);
    }
    const blocker = {
        kind: 'harness-intervention',
        checkpointId: checkpoint.checkpointId,
        blockedBy: interventionChangeId,
    };
    return freezeDeep({
        parent: { ...parent, blocker },
        relationship: {
            kind: 'harness-intervention.v1',
            parentChangeId: parent.changeId,
            interventionChangeId,
            checkpointId: checkpoint.checkpointId,
            unblocks: parent.changeId,
            state: 'active',
        },
    });
}
function engineArtifactPayload(input) {
    return {
        kind: 'engine-artifact.v1',
        sourceChangeId: input.sourceChangeId,
        sourceDigest: input.sourceDigest,
        executableDigest: input.executableDigest,
        protocolVersion: input.protocolVersion,
        canReadSessionSchemas: input.canReadSessionSchemas,
        writesSessionSchema: input.writesSessionSchema,
        policySchemaVersion: input.policySchemaVersion,
        smokeReportDigest: input.smokeReportDigest,
        ...(input.workflowBindingDigest === undefined
            ? {}
            : { workflowBindingDigest: input.workflowBindingDigest }),
    };
}
export function createEngineArtifact(input) {
    assertNonEmpty(input.sourceChangeId, 'ENGINE_ARTIFACT_INVALID', 'Source change id');
    assertDigest(input.sourceDigest, 'ENGINE_ARTIFACT_INVALID');
    assertDigest(input.executableDigest, 'ENGINE_ARTIFACT_INVALID');
    assertDigest(input.smokeReportDigest, 'ENGINE_ARTIFACT_INVALID');
    if (input.workflowBindingDigest !== undefined) {
        assertDigest(input.workflowBindingDigest, 'ENGINE_ARTIFACT_INVALID');
    }
    if (!Number.isSafeInteger(input.protocolVersion) ||
        input.protocolVersion < 1) {
        throw workflowError('ENGINE_ARTIFACT_INVALID', 'Invalid engine protocol version.', ExitCode.usage);
    }
    if (!Number.isSafeInteger(input.policySchemaVersion) ||
        input.policySchemaVersion < 1) {
        throw workflowError('ENGINE_ARTIFACT_INVALID', 'Invalid policy schema version.', ExitCode.usage);
    }
    assertNonEmpty(input.writesSessionSchema, 'ENGINE_ARTIFACT_INVALID', 'Written session schema');
    for (const schema of input.canReadSessionSchemas) {
        assertNonEmpty(schema, 'ENGINE_ARTIFACT_INVALID', 'Readable session schema');
    }
    assertSortedUnique(input.canReadSessionSchemas, 'ENGINE_ARTIFACT_INVALID');
    if (!input.canReadSessionSchemas.includes(input.writesSessionSchema)) {
        throw workflowError('ENGINE_ARTIFACT_INVALID', 'Engine must be able to read the session schema that it writes.', ExitCode.usage);
    }
    const payload = engineArtifactPayload(input);
    return freezeDeep({ ...payload, artifactId: canonicalDigest(payload) });
}
const MAINTENANCE_OPERATIONS = [
    'adopt-engine-into-parent',
    'build-engine-artifact',
    'create-isolated-workspace',
    'modify-engine',
    'run-engine-tests',
];
const MAINTENANCE_WAIVERS = [
    'active-change-exclusivity',
    'clean-worktree-required',
    'engine-path-protection',
    'parent-terminalization-required',
    'selected-workflow-check',
];
export function canonicalHarnessMaintenanceGrantPayload(payload) {
    return `${canonicalJson(payload)}\n`;
}
function validateMaintenancePayload(payload) {
    if (payload.kind !== 'harness-maintenance-grant.v1') {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Unknown maintenance grant schema.', ExitCode.usage);
    }
    for (const [value, label] of [
        [payload.grantId, 'Grant id'],
        [payload.parentChangeId, 'Parent change id'],
        [payload.interventionChangeId, 'Intervention change id'],
        [payload.sessionSchema, 'Session schema'],
        [payload.humanSigner, 'Human signer'],
        [payload.reason, 'Reason'],
    ]) {
        assertNonEmpty(value, 'MAINTENANCE_GRANT_INVALID', label);
    }
    assertDigest(payload.engineFromDigest, 'MAINTENANCE_GRANT_INVALID');
    if (payload.parentChangeId === payload.interventionChangeId) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Parent and intervention must differ.', ExitCode.usage);
    }
    if (!Array.isArray(payload.scope.paths) || payload.scope.paths.length === 0) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Maintenance scope needs exact path globs.', ExitCode.usage);
    }
    for (const path of payload.scope.paths) {
        assertSafePath(path, true, 'MAINTENANCE_GRANT_INVALID');
    }
    assertSortedUnique(payload.scope.paths, 'MAINTENANCE_GRANT_INVALID');
    if (!Array.isArray(payload.scope.operations) ||
        payload.scope.operations.length === 0) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Maintenance scope needs operations.', ExitCode.usage);
    }
    assertSortedUnique(payload.scope.operations, 'MAINTENANCE_GRANT_INVALID');
    if (payload.scope.operations.some((operation) => !MAINTENANCE_OPERATIONS.includes(operation))) {
        throw workflowError('MAINTENANCE_GRANT_OPERATION_UNKNOWN', 'Unknown maintenance operation.', ExitCode.guard);
    }
    if (!payload.scope.operations.includes('adopt-engine-into-parent')) {
        throw workflowError('MAINTENANCE_GRANT_ADOPTION_NOT_AUTHORIZED', 'Maintenance grant does not authorize local engine adoption.', ExitCode.guard);
    }
    assertSortedUnique(payload.waivers, 'MAINTENANCE_GRANT_INVALID');
    if (payload.waivers.some((waiver) => !MAINTENANCE_WAIVERS.includes(waiver))) {
        throw workflowError('MAINTENANCE_GRANT_NONWAIVABLE_INVARIANT', 'Maintenance grant attempts to waive a recovery invariant.', ExitCode.guard);
    }
    if (payload.maxLocalAdoptions !== 1) {
        throw workflowError('MAINTENANCE_GRANT_V1_ADOPTION_LIMIT_INVALID', 'V1 maintenance grants authorize exactly one local adoption.', ExitCode.guard);
    }
    assertIsoTimestamp(payload.issuedAt, 'MAINTENANCE_GRANT_INVALID');
    assertIsoTimestamp(payload.expiresAt, 'MAINTENANCE_GRANT_INVALID');
    if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Maintenance grant expiry must follow issue time.', ExitCode.usage);
    }
}
export function verifyHarnessMaintenanceGrant(envelope, context) {
    validateMaintenancePayload(envelope.payload);
    assertNonEmpty(envelope.signature, 'MAINTENANCE_GRANT_SIGNATURE_INVALID', 'Signature');
    const checkpoint = verifyWipCheckpoint(context.checkpoint);
    const blocker = context.parent.blocker;
    if (context.parent.status !== 'active' ||
        blocker?.kind !== 'harness-intervention' ||
        blocker.checkpointId !== checkpoint.checkpointId ||
        blocker.blockedBy !== context.relationship.interventionChangeId ||
        context.relationship.state !== 'active' ||
        context.relationship.parentChangeId !== context.parent.changeId ||
        context.relationship.checkpointId !== checkpoint.checkpointId) {
        throw workflowError('MAINTENANCE_GRANT_INTERVENTION_MISMATCH', 'Maintenance grant requires the exact active intervention relationship.', ExitCode.verification);
    }
    const payload = envelope.payload;
    if (payload.parentChangeId !== context.parent.changeId ||
        payload.interventionChangeId !==
            context.relationship.interventionChangeId ||
        payload.engineFromDigest !== context.parent.engineBinding ||
        payload.engineFromDigest !== checkpoint.engineDigest ||
        payload.sessionSchema !== context.parent.sessionSchema) {
        throw workflowError('MAINTENANCE_GRANT_BINDING_MISMATCH', 'Maintenance grant does not match the parent checkpoint and engine binding.', ExitCode.verification);
    }
    if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
        throw workflowError('MAINTENANCE_GRANT_EXPIRED', 'Maintenance grant has expired.', ExitCode.staleState);
    }
    const signatureValid = verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalHarnessMaintenanceGrantPayload(payload), envelope.signature, payload.humanSigner, HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE);
    if (!signatureValid) {
        throw workflowError('MAINTENANCE_GRANT_SIGNATURE_INVALID', 'Human maintenance grant signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: { ...payload },
        signature: envelope.signature,
        verifiedAt: context.now.toISOString(),
        verification: 'human-signature-verified',
    });
}
function adoptionJournalPayload(journal) {
    return { ...journal };
}
function buildAdoptionJournal(journal) {
    return freezeDeep({
        ...journal,
        journalDigest: canonicalDigest(adoptionJournalPayload(journal)),
    });
}
function verifyAdoptionJournal(journal) {
    assertDigest(journal.journalDigest, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
    if ((journal.workflowBindingDigest === undefined) !==
        (journal.workflowStatus === undefined) ||
        (journal.workflowBindingDigest !== undefined &&
            journal.workflowStatus !== 'repair-active')) {
        throw workflowError('ENGINE_ADOPTION_JOURNAL_CORRUPT', 'Engine adoption workflow binding is incomplete.', ExitCode.verification);
    }
    if (journal.workflowBindingDigest !== undefined) {
        assertDigest(journal.workflowBindingDigest, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
    }
    const { journalDigest, ...payload } = journal;
    if (canonicalDigest(adoptionJournalPayload(payload)) !== journalDigest ||
        journal.history.length === 0 ||
        journal.history.at(-1)?.state !== journal.state) {
        throw workflowError('ENGINE_ADOPTION_JOURNAL_CORRUPT', 'Engine adoption journal failed integrity verification.', ExitCode.verification);
    }
    for (let index = 1; index < journal.history.length; index += 1) {
        assertMonotonicTimestamp(journal.history[index - 1].at, journal.history[index].at, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
    }
}
export function prepareEngineAdoption(input) {
    assertNonEmpty(input.txId, 'ENGINE_ADOPTION_INVALID', 'Adoption transaction id');
    const checkpoint = verifyWipCheckpoint(input.checkpoint);
    const rebuiltArtifact = createEngineArtifact(input.artifact);
    if (rebuiltArtifact.artifactId !== input.artifact.artifactId) {
        throw workflowError('ENGINE_ARTIFACT_DIGEST_MISMATCH', 'Engine artifact digest mismatch.', ExitCode.verification);
    }
    if (input.parent.status !== 'active' ||
        input.parent.blocker?.kind !== 'harness-intervention' ||
        input.parent.blocker.checkpointId !== checkpoint.checkpointId ||
        input.parent.blocker.blockedBy !==
            input.relationship.interventionChangeId ||
        input.relationship.state !== 'active' ||
        input.relationship.checkpointId !== checkpoint.checkpointId ||
        input.artifact.sourceChangeId !== input.relationship.interventionChangeId) {
        throw workflowError('ENGINE_ADOPTION_INTERVENTION_MISMATCH', 'Adoption is not bound to the exact active intervention.', ExitCode.verification);
    }
    if (input.maintenanceGrant.verification !== 'human-signature-verified' ||
        input.maintenanceGrant.payload.grantId.length === 0 ||
        input.maintenanceGrant.payload.parentChangeId !== input.parent.changeId ||
        input.maintenanceGrant.payload.interventionChangeId !==
            input.relationship.interventionChangeId ||
        input.maintenanceGrant.payload.engineFromDigest !==
            input.parent.engineBinding) {
        throw workflowError('ENGINE_ADOPTION_GRANT_MISMATCH', 'Verified maintenance grant does not authorize this adoption.', ExitCode.guard);
    }
    if (input.now.getTime() >= Date.parse(input.maintenanceGrant.payload.expiresAt)) {
        throw workflowError('ENGINE_ADOPTION_GRANT_EXPIRED', 'Maintenance grant expired before adoption.', ExitCode.staleState);
    }
    if (!Number.isSafeInteger(input.priorLocalAdoptions) ||
        input.priorLocalAdoptions < 0 ||
        input.priorLocalAdoptions >=
            input.maintenanceGrant.payload.maxLocalAdoptions) {
        throw workflowError('ENGINE_ADOPTION_LIMIT_EXHAUSTED', 'Maintenance grant local adoption limit is exhausted.', ExitCode.conflict);
    }
    if (input.artifact.writesSessionSchema !== input.parent.sessionSchema ||
        input.maintenanceGrant.payload.sessionSchema !==
            input.parent.sessionSchema ||
        !input.artifact.canReadSessionSchemas.includes(input.parent.sessionSchema)) {
        throw workflowError('ENGINE_ADOPTION_SCHEMA_CHANGE_FORBIDDEN', 'V1 local adoption cannot modify the durable session schema.', ExitCode.guard);
    }
    const at = input.now.toISOString();
    if ((input.workflowBindingDigest === undefined) !==
        (input.workflowStatus === undefined) ||
        (input.workflowBindingDigest !== undefined &&
            input.workflowStatus !== 'repair-active')) {
        throw workflowError('ENGINE_ADOPTION_WORKFLOW_BINDING_INVALID', 'Workflow binding digest and status must be supplied together.', ExitCode.verification);
    }
    if (input.workflowBindingDigest !== undefined) {
        assertDigest(input.workflowBindingDigest, 'ENGINE_ADOPTION_WORKFLOW_BINDING_INVALID');
    }
    return buildAdoptionJournal({
        kind: 'engine-adoption-journal.v1',
        txId: input.txId,
        grantId: input.maintenanceGrant.payload.grantId,
        parentChangeId: input.parent.changeId,
        interventionChangeId: input.relationship.interventionChangeId,
        checkpointId: checkpoint.checkpointId,
        fromEngineDigest: input.parent.engineBinding,
        toEngineDigest: input.artifact.executableDigest,
        artifactId: input.artifact.artifactId,
        sessionSchema: input.parent.sessionSchema,
        ...(input.workflowBindingDigest === undefined
            ? {}
            : {
                workflowBindingDigest: input.workflowBindingDigest,
                workflowStatus: input.workflowStatus,
            }),
        state: 'PREPARED',
        history: [{ state: 'PREPARED', at }],
    });
}
const ADOPTION_TRANSITIONS = {
    PREPARED: { 'parent-checkpointed': 'PARENT_CHECKPOINTED' },
    PARENT_CHECKPOINTED: { 'engine-binding-updated': 'ENGINE_BINDING_UPDATED' },
    ENGINE_BINDING_UPDATED: { 'new-engine-started': 'NEW_ENGINE_STARTED' },
    NEW_ENGINE_STARTED: {
        'health-check-passed': 'HEALTHY',
        'health-check-failed': 'ROLLBACK_REQUIRED',
    },
    ROLLBACK_REQUIRED: {
        'engine-binding-rolled-back': 'ENGINE_BINDING_ROLLED_BACK',
    },
    HEALTHY: { commit: 'COMMITTED' },
    COMMITTED: {},
    ENGINE_BINDING_ROLLED_BACK: {},
};
export function advanceEngineAdoption(journal, event) {
    verifyAdoptionJournal(journal);
    const nextState = ADOPTION_TRANSITIONS[journal.state][event.kind];
    if (nextState === undefined) {
        throw workflowError('ENGINE_ADOPTION_TRANSITION_INVALID', `Cannot apply ${event.kind} while adoption is ${journal.state}.`, ExitCode.conflict);
    }
    assertMonotonicTimestamp(journal.history.at(-1).at, event.at, 'ENGINE_ADOPTION_TRANSITION_INVALID');
    const { journalDigest: _journalDigest, ...payload } = journal;
    return buildAdoptionJournal({
        ...payload,
        state: nextState,
        history: [...journal.history, { state: nextState, at: event.at }],
    });
}
export function decideEngineAdoptionRecovery(journal) {
    verifyAdoptionJournal(journal);
    switch (journal.state) {
        case 'PREPARED':
            return {
                action: 'checkpoint-parent',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
        case 'PARENT_CHECKPOINTED':
            return {
                action: 'update-engine-binding',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
        case 'ENGINE_BINDING_UPDATED':
            return {
                action: 'start-new-engine',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: false,
            };
        case 'NEW_ENGINE_STARTED':
            return {
                action: 'run-health-check',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: false,
            };
        case 'ROLLBACK_REQUIRED':
            return {
                action: 'rollback-engine-binding',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
        case 'HEALTHY':
            return {
                action: 'finalize-commit',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: false,
            };
        case 'COMMITTED':
            return {
                action: 'none',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: true,
            };
        case 'ENGINE_BINDING_ROLLED_BACK':
            return {
                action: 'none',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
    }
}
export function finalizeEngineAdoption(parent, relationship, journal) {
    verifyAdoptionJournal(journal);
    if (parent.status !== 'active' ||
        parent.blocker?.kind !== 'harness-intervention' ||
        parent.changeId !== journal.parentChangeId ||
        parent.blocker.checkpointId !== journal.checkpointId ||
        parent.blocker.blockedBy !== journal.interventionChangeId ||
        relationship.parentChangeId !== journal.parentChangeId ||
        relationship.interventionChangeId !== journal.interventionChangeId ||
        relationship.state !== 'active') {
        throw workflowError('ENGINE_ADOPTION_FINALIZE_MISMATCH', 'Parent or intervention relationship changed during adoption.', ExitCode.staleState);
    }
    if (journal.state === 'COMMITTED') {
        return freezeDeep({
            parent: {
                ...parent,
                engineBinding: journal.toEngineDigest,
                blocker: null,
            },
            relationship: { ...relationship, state: 'adopted' },
        });
    }
    if (journal.state === 'ENGINE_BINDING_ROLLED_BACK') {
        return freezeDeep({
            parent: { ...parent, engineBinding: journal.fromEngineDigest },
            relationship: { ...relationship },
        });
    }
    throw workflowError('ENGINE_ADOPTION_NOT_TERMINAL', 'Adoption can only finalize after commit or durable rollback.', ExitCode.conflict);
}
// ---------------------------------------------------------------------------
// M11: protected capability closure and candidate classification
// ---------------------------------------------------------------------------
export const REQUIRED_PROTECTED_CAPABILITIES = [
    'adoption.journal',
    'apply.journal',
    'audit.append',
    'authorization.verify',
    'control-plane.update',
    'effect.monitor',
    'human.trust-roots',
    'policy.classify',
    'recovery.rollback',
    'ref-generation.ledger',
    'sandbox.enforce',
    'workflow.abort-or-supersede',
];
export function protectedCapabilityClosureDigest(entrypoints, dependencies, contentDigest) {
    for (const path of [...entrypoints, ...dependencies]) {
        assertSafePath(path, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
    }
    assertSortedUnique(entrypoints, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
    assertSortedUnique(dependencies, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
    assertDigest(contentDigest, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
    return canonicalDigest({ entrypoints, dependencies, contentDigest });
}
function protectedManifestPayload(input) {
    return { ...input };
}
export function createProtectedCapabilityManifest(input) {
    if (input.schemaVersion !== 1) {
        throw workflowError('PROTECTED_CAPABILITY_MANIFEST_INVALID', 'Unknown manifest schema.', ExitCode.usage);
    }
    assertSafePath(input.manifestPath, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
    const entries = [...input.entries]
        .map((entry) => {
        if (!REQUIRED_PROTECTED_CAPABILITIES.includes(entry.capability)) {
            throw workflowError('PROTECTED_CAPABILITY_UNKNOWN', `Unknown protected capability: ${String(entry.capability)}`, ExitCode.guard);
        }
        if (entry.entrypoints.length === 0) {
            throw workflowError('PROTECTED_CAPABILITY_MANIFEST_INVALID', `Protected capability ${entry.capability} needs an entrypoint.`, ExitCode.usage);
        }
        for (const path of [...entry.entrypoints, ...entry.dependencies]) {
            assertSafePath(path, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
        }
        assertSortedUnique(entry.entrypoints, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
        assertSortedUnique(entry.dependencies, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
        assertDigest(entry.contentDigest, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
        assertDigest(entry.closureDigest, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
        if (entry.closureDigest !==
            protectedCapabilityClosureDigest(entry.entrypoints, entry.dependencies, entry.contentDigest)) {
            throw workflowError('PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH', `Protected capability ${entry.capability} closure digest is invalid.`, ExitCode.verification);
        }
        return {
            capability: entry.capability,
            entrypoints: [...entry.entrypoints],
            dependencies: [...entry.dependencies],
            contentDigest: entry.contentDigest,
            closureDigest: entry.closureDigest,
        };
    })
        .sort((left, right) => compareCanonicalStrings(left.capability, right.capability));
    assertSortedUnique(entries.map((entry) => entry.capability), 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
    const missing = REQUIRED_PROTECTED_CAPABILITIES.filter((capability) => !entries.some((entry) => entry.capability === capability));
    if (missing.length > 0) {
        throw workflowError('PROTECTED_CAPABILITY_REQUIRED_MISSING', `Protected capability manifest is missing: ${missing.join(', ')}`, ExitCode.guard);
    }
    const payload = protectedManifestPayload({
        kind: 'protected-capability-manifest.v1',
        schemaVersion: 1,
        manifestPath: input.manifestPath,
        entries,
    });
    return freezeDeep({ ...payload, manifestDigest: canonicalDigest(payload) });
}
function verifyProtectedManifest(manifest) {
    const rebuilt = createProtectedCapabilityManifest(manifest);
    if (rebuilt.manifestDigest !== manifest.manifestDigest) {
        throw workflowError('PROTECTED_CAPABILITY_MANIFEST_DIGEST_MISMATCH', 'Protected capability manifest digest mismatch.', ExitCode.verification);
    }
}
function normalizedExactChanges(changes) {
    if (changes.length === 0) {
        throw workflowError('CONTROL_PLANE_EXACT_DIFF_INVALID', 'Candidate exact diff is empty.', ExitCode.usage);
    }
    const normalized = changes
        .map((change) => {
        assertSafePath(change.path, false, 'CONTROL_PLANE_EXACT_DIFF_INVALID');
        if (change.beforeDigest !== null) {
            assertDigest(change.beforeDigest, 'CONTROL_PLANE_EXACT_DIFF_INVALID');
        }
        if (change.afterDigest !== null) {
            assertDigest(change.afterDigest, 'CONTROL_PLANE_EXACT_DIFF_INVALID');
        }
        if ((change.beforeDigest === null && change.afterDigest === null) ||
            change.beforeDigest === change.afterDigest) {
            throw workflowError('CONTROL_PLANE_EXACT_DIFF_INVALID', 'Exact diff contains a no-op.', ExitCode.usage);
        }
        return { ...change };
    })
        .sort((left, right) => compareCanonicalStrings(left.path, right.path));
    assertSortedUnique(normalized.map((change) => change.path), 'CONTROL_PLANE_EXACT_DIFF_INVALID');
    return normalized;
}
export function controlPlaneCandidateDigest(changes) {
    return canonicalDigest({
        kind: 'control-plane-candidate.v1',
        changes: normalizedExactChanges(changes),
    });
}
export function classifyProtectedCandidateImpact(input) {
    verifyProtectedManifest(input.beforeManifest);
    verifyProtectedManifest(input.afterManifest);
    const changes = normalizedExactChanges(input.changes);
    const changedPaths = new Set(changes.map((change) => change.path));
    const manifestChanged = changedPaths.has(input.beforeManifest.manifestPath) ||
        input.beforeManifest.manifestDigest !== input.afterManifest.manifestDigest;
    const capabilities = new Set();
    for (const capability of REQUIRED_PROTECTED_CAPABILITIES) {
        const before = input.beforeManifest.entries.find((entry) => entry.capability === capability);
        const after = input.afterManifest.entries.find((entry) => entry.capability === capability);
        const paths = new Set([
            ...before.entrypoints,
            ...before.dependencies,
            ...after.entrypoints,
            ...after.dependencies,
        ]);
        if (before.closureDigest !== after.closureDigest ||
            [...changedPaths].some((path) => paths.has(path))) {
            capabilities.add(capability);
        }
    }
    const affectedCapabilities = [...capabilities].sort(compareCanonicalStrings);
    const controlPlane = manifestChanged || affectedCapabilities.length > 0;
    return freezeDeep(controlPlane
        ? {
            class: 'C',
            kind: 'control-plane',
            affectedCapabilities,
            manifestChanged,
        }
        : {
            class: 'A',
            kind: 'ordinary',
            affectedCapabilities: [],
            manifestChanged: false,
        });
}
export function canonicalControlPlaneIndependentReviewAttestationPayload(payload) {
    return `${canonicalJson(payload)}\n`;
}
export function controlPlaneIndependentReviewAttestationDigest(envelope) {
    validateControlPlaneIndependentReviewAttestation(envelope);
    return canonicalDigest(envelope);
}
export function verifyControlPlaneIndependentReviewAttestation(envelope, context) {
    validateControlPlaneIndependentReviewAttestation(envelope);
    assertDigest(context.expectedDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    const attestationDigest = canonicalDigest(envelope);
    if (attestationDigest !== context.expectedDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Independent review bytes do not match the grant-bound digest.', ExitCode.verification);
    }
    const payload = envelope.payload;
    assertIsoTimestamp(context.grantIssuedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
        throw workflowError('CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID', 'Independent review must be completed before grant issuance.', ExitCode.guard);
    }
    if (payload.reviewer === context.grantHumanSigner) {
        throw workflowError('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT', 'The independent reviewer must differ from the grant signer.', ExitCode.guard);
    }
    if (payload.repositoryId !== context.repositoryId) {
        throw workflowError('CONTROL_PLANE_REVIEW_REPOSITORY_MISMATCH', 'Independent review is bound to a different repository.', ExitCode.verification);
    }
    if (payload.candidateDigest !== context.candidateDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_CANDIDATE_MISMATCH', 'Independent review is bound to a different candidate.', ExitCode.verification);
    }
    if (payload.beforeClosureDigest !== context.beforeClosureDigest ||
        payload.afterClosureDigest !== context.afterClosureDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_CLOSURE_MISMATCH', 'Independent review is bound to different protected closures.', ExitCode.verification);
    }
    if (payload.recoveryBundleDigest !== context.recoveryBundleDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_RECOVERY_MISMATCH', 'Independent review is bound to a different recovery bundle.', ExitCode.verification);
    }
    if (!sameJson(payload.affectedCapabilities, context.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_CAPABILITY_MISMATCH', 'Independent review does not bind the exact affected capabilities.', ExitCode.verification);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneIndependentReviewAttestationPayload(payload), envelope.signature, payload.reviewer, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE)) {
        throw workflowError('CONTROL_PLANE_REVIEW_SIGNATURE_INVALID', 'Independent review attestation signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            affectedCapabilities: [...payload.affectedCapabilities],
        },
        signature: envelope.signature,
        attestationDigest,
        verification: 'independent-human-signature-verified',
    });
}
function validateControlPlaneIndependentReviewAttestation(envelope) {
    if (!hasExactObjectKeys(envelope, ['payload', 'signature']) ||
        !hasExactObjectKeys(envelope.payload, [
            'affectedCapabilities',
            'afterClosureDigest',
            'beforeClosureDigest',
            'candidateDigest',
            'kind',
            'recoveryBundleDigest',
            'repositoryId',
            'reviewSummary',
            'reviewedAt',
            'reviewer',
            'verdict',
        ]) ||
        envelope.payload.kind !== 'control-plane-independent-review.v1' ||
        envelope.payload.verdict !== 'approved') {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review attestation has an unknown or non-approved schema.', ExitCode.guard);
    }
    const payload = envelope.payload;
    for (const [value, label] of [
        [payload.repositoryId, 'Repository id'],
        [payload.reviewSummary, 'Review summary'],
        [payload.reviewer, 'Reviewer'],
        [envelope.signature, 'Review signature'],
    ]) {
        assertNonEmpty(value, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', label);
    }
    for (const digest of [
        payload.candidateDigest,
        payload.beforeClosureDigest,
        payload.afterClosureDigest,
        payload.recoveryBundleDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    }
    if (!Array.isArray(payload.affectedCapabilities) ||
        payload.affectedCapabilities.some((capability) => !REQUIRED_PROTECTED_CAPABILITIES.includes(capability))) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review contains an unknown protected capability.', ExitCode.guard);
    }
    assertSortedUnique(payload.affectedCapabilities, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertIsoTimestamp(payload.reviewedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
}
export function normalizeControlPlaneTaskMandateBinding(value) {
    if (!hasExactObjectKeys(value, [
        'changeId',
        'externalAuditRoot',
        'mandateDigest',
        'mandateId',
        'parentTaskId',
        'schemaVersion',
    ])) {
        throw invalidControlPlaneTaskMandateBinding();
    }
    const raw = value;
    if (raw.schemaVersion !== 1 ||
        typeof raw.parentTaskId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.parentTaskId) ||
        typeof raw.mandateId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.mandateId) ||
        typeof raw.mandateDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(raw.mandateDigest) ||
        typeof raw.changeId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.changeId) ||
        typeof raw.externalAuditRoot !== 'string' ||
        !path.isAbsolute(raw.externalAuditRoot) ||
        path.normalize(raw.externalAuditRoot) !== raw.externalAuditRoot ||
        raw.externalAuditRoot === path.parse(raw.externalAuditRoot).root) {
        throw invalidControlPlaneTaskMandateBinding();
    }
    return freezeDeep({
        schemaVersion: 1,
        parentTaskId: raw.parentTaskId,
        mandateId: raw.mandateId,
        mandateDigest: raw.mandateDigest,
        changeId: raw.changeId,
        externalAuditRoot: raw.externalAuditRoot,
    });
}
function invalidControlPlaneTaskMandateBinding() {
    return workflowError('CONTROL_PLANE_TASK_MANDATE_BINDING_INVALID', 'Control-Plane Grant requires an exact parent Task Mandate binding and absolute external audit root.', ExitCode.guard);
}
export function canonicalControlPlaneGrantPayload(payload) {
    return `${canonicalJson(payload)}\n`;
}
export function verifyControlPlaneGrant(envelope, context) {
    const payload = envelope.payload;
    if (!hasExactObjectKeys(payload, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateDigest',
        'exactChanges',
        'expiresAt',
        'grantId',
        'humanSigner',
        'independentReviewAttestationDigest',
        'issuedAt',
        'kind',
        'mandateBinding',
        'oneShot',
        'recoveryBundle',
        'repositoryId',
        'updaterVersion',
    ]) ||
        payload.kind !== 'control-plane-grant.v1' ||
        payload.oneShot !== true) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Unknown or non-one-shot control-plane grant.', ExitCode.guard);
    }
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(payload.mandateBinding);
    for (const [value, label] of [
        [payload.grantId, 'Grant id'],
        [payload.repositoryId, 'Repository id'],
        [payload.behaviorChangeSummary, 'Behavior change summary'],
        [payload.humanSigner, 'Human signer'],
        [envelope.signature, 'Signature'],
    ]) {
        assertNonEmpty(value, 'CONTROL_PLANE_GRANT_INVALID', label);
    }
    if (context.consumedGrantIds.has(payload.grantId)) {
        throw workflowError('CONTROL_PLANE_GRANT_ALREADY_CONSUMED', 'One-shot Control-Plane Grant has already been consumed.', ExitCode.conflict);
    }
    verifyProtectedManifest(context.beforeManifest);
    verifyProtectedManifest(context.afterManifest);
    if (payload.beforeClosureDigest !== context.beforeManifest.manifestDigest) {
        throw workflowError('CONTROL_PLANE_BEFORE_CLOSURE_MISMATCH', 'Control-Plane Grant is stale for the current protected closure.', ExitCode.staleState);
    }
    if (payload.afterClosureDigest !== context.afterManifest.manifestDigest) {
        throw workflowError('CONTROL_PLANE_AFTER_CLOSURE_MISMATCH', 'Control-Plane Grant does not bind the candidate protected closure.', ExitCode.verification);
    }
    const exactChanges = normalizedExactChanges(context.changes);
    if (!sameJson(payload.exactChanges, exactChanges)) {
        throw workflowError('CONTROL_PLANE_EXACT_DIFF_MISMATCH', 'Control-Plane Grant exact diff differs from the candidate.', ExitCode.verification);
    }
    const expectedCandidateDigest = controlPlaneCandidateDigest(exactChanges);
    assertDigest(payload.candidateDigest, 'CONTROL_PLANE_GRANT_INVALID');
    if (payload.candidateDigest !== expectedCandidateDigest) {
        throw workflowError('CONTROL_PLANE_CANDIDATE_DIGEST_MISMATCH', 'Control-Plane Grant candidate digest mismatch.', ExitCode.verification);
    }
    if (context.beforeManifest.manifestDigest !==
        context.afterManifest.manifestDigest &&
        !exactChanges.some((change) => change.path === context.beforeManifest.manifestPath &&
            change.beforeDigest === context.beforeManifest.manifestDigest &&
            change.afterDigest === context.afterManifest.manifestDigest)) {
        throw workflowError('CONTROL_PLANE_MANIFEST_DIFF_MISSING', 'Changed protected manifest is absent from the exact candidate diff.', ExitCode.verification);
    }
    const impact = classifyProtectedCandidateImpact({
        beforeManifest: context.beforeManifest,
        afterManifest: context.afterManifest,
        changes: exactChanges,
    });
    if (impact.class !== 'C') {
        throw workflowError('CONTROL_PLANE_GRANT_NOT_REQUIRED', 'Candidate does not affect a protected capability.', ExitCode.usage);
    }
    assertSortedUnique(payload.affectedCapabilities, 'CONTROL_PLANE_GRANT_INVALID');
    if (!sameJson(payload.affectedCapabilities, impact.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_CAPABILITY_IMPACT_MISMATCH', 'Control-Plane Grant affected capabilities are not exact.', ExitCode.verification);
    }
    for (const digest of [
        payload.beforeClosureDigest,
        payload.afterClosureDigest,
        payload.recoveryBundle.bundleDigest,
        payload.recoveryBundle.previousClosureDigest,
        payload.recoveryBundle.restartArtifactDigest,
        payload.recoveryBundle.rollbackTestReportDigest,
        payload.independentReviewAttestationDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_GRANT_INVALID');
    }
    if (payload.recoveryBundle.previousClosureDigest !== payload.beforeClosureDigest) {
        throw workflowError('CONTROL_PLANE_RECOVERY_BUNDLE_MISMATCH', 'Recovery bundle does not restore the exact previous closure.', ExitCode.verification);
    }
    if (!Number.isSafeInteger(payload.updaterVersion) ||
        payload.updaterVersion < 1) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Invalid minimal updater version.', ExitCode.usage);
    }
    assertIsoTimestamp(payload.issuedAt, 'CONTROL_PLANE_GRANT_INVALID');
    assertIsoTimestamp(payload.expiresAt, 'CONTROL_PLANE_GRANT_INVALID');
    if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-plane grant expiry is invalid.', ExitCode.usage);
    }
    if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
        throw workflowError('CONTROL_PLANE_GRANT_EXPIRED', 'Control-Plane Grant has expired.', ExitCode.staleState);
    }
    const signatureValid = verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneGrantPayload(payload), envelope.signature, payload.humanSigner, CONTROL_PLANE_SIGNATURE_NAMESPACE);
    if (!signatureValid) {
        throw workflowError('CONTROL_PLANE_GRANT_SIGNATURE_INVALID', 'Human Control-Plane Grant signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            mandateBinding: { ...mandateBinding },
            exactChanges: exactChanges.map((change) => ({ ...change })),
        },
        signature: envelope.signature,
        verifiedAt: context.now.toISOString(),
        verification: 'human-signature-verified',
    });
}
// ---------------------------------------------------------------------------
// Control-plane promotion material v1 and material-bound grant/review v2
// ---------------------------------------------------------------------------
const MAX_CONTROL_PLANE_PROMOTION_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_PLANE_PROMOTION_FILE_BYTES = 16 * 1024 * 1024;
const CONTROL_PLANE_GRANT_V2_MAX_TTL_MS = 5 * 60 * 1000;
export function createControlPlanePromotionLineage(input) {
    const keys = [
        'candidateGeneration',
        'candidateTrustCommit',
        'historyAnchorDigest',
        'previousActiveTrustCommit',
        'previousGeneration',
        'previousSupervisorRecordDigest',
        'previousTerminalRecordDigest',
        'rollbackGeneration',
    ];
    const hasKind = Object.prototype.hasOwnProperty.call(input, 'kind');
    if (!hasExactObjectKeys(input, hasKind ? [...keys, 'kind'] : keys) ||
        (hasKind && input.kind !== 'control-plane-promotion-lineage.v1')) {
        throw promotionLineageError('Unknown promotion lineage schema.');
    }
    for (const digest of [
        input.historyAnchorDigest,
        input.previousTerminalRecordDigest,
        input.previousSupervisorRecordDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_PROMOTION_LINEAGE_INVALID');
    }
    if (!Number.isSafeInteger(input.previousGeneration) ||
        input.previousGeneration < 1 ||
        input.candidateGeneration !== input.previousGeneration + 1 ||
        input.rollbackGeneration !== input.previousGeneration + 2 ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.previousActiveTrustCommit) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.candidateTrustCommit)) {
        throw promotionLineageError('Promotion lineage generations or trust commits are invalid.');
    }
    const payload = {
        kind: 'control-plane-promotion-lineage.v1',
        historyAnchorDigest: input.historyAnchorDigest,
        previousTerminalRecordDigest: input.previousTerminalRecordDigest,
        previousSupervisorRecordDigest: input.previousSupervisorRecordDigest,
        previousGeneration: input.previousGeneration,
        candidateGeneration: input.candidateGeneration,
        rollbackGeneration: input.rollbackGeneration,
        previousActiveTrustCommit: input.previousActiveTrustCommit,
        candidateTrustCommit: input.candidateTrustCommit,
    };
    return freezeDeep({ ...payload, lineageDigest: canonicalDigest(payload) });
}
function verifyControlPlanePromotionLineage(value) {
    if (!hasExactObjectKeys(value, [
        'candidateGeneration',
        'candidateTrustCommit',
        'historyAnchorDigest',
        'kind',
        'lineageDigest',
        'previousActiveTrustCommit',
        'previousGeneration',
        'previousSupervisorRecordDigest',
        'previousTerminalRecordDigest',
        'rollbackGeneration',
    ])) {
        throw promotionLineageError('Unknown promotion lineage schema.');
    }
    const lineage = value;
    assertDigest(lineage.lineageDigest, 'CONTROL_PLANE_PROMOTION_LINEAGE_INVALID');
    const rebuilt = createControlPlanePromotionLineage({
        kind: lineage.kind,
        historyAnchorDigest: lineage.historyAnchorDigest,
        previousTerminalRecordDigest: lineage.previousTerminalRecordDigest,
        previousSupervisorRecordDigest: lineage.previousSupervisorRecordDigest,
        previousGeneration: lineage.previousGeneration,
        candidateGeneration: lineage.candidateGeneration,
        rollbackGeneration: lineage.rollbackGeneration,
        previousActiveTrustCommit: lineage.previousActiveTrustCommit,
        candidateTrustCommit: lineage.candidateTrustCommit,
    });
    if (!sameJson(rebuilt, lineage)) {
        throw promotionLineageError('Promotion lineage digest or bytes mismatch.');
    }
    return rebuilt;
}
export function controlPlanePromotionLineageDigest(lineage) {
    return verifyControlPlanePromotionLineage(lineage).lineageDigest;
}
function promotionLineageError(message) {
    return workflowError('CONTROL_PLANE_PROMOTION_LINEAGE_INVALID', message, ExitCode.guard);
}
function promotionMaterialError(message) {
    return workflowError('CONTROL_PLANE_PROMOTION_MATERIAL_INVALID', message, ExitCode.guard);
}
function recoveryMaterialError(message) {
    return workflowError('CONTROL_PLANE_RECOVERY_MATERIAL_INVALID', message, ExitCode.guard);
}
function normalizedExactChangesV2(value, code = 'CONTROL_PLANE_EXACT_DIFF_INVALID') {
    if (!Array.isArray(value) || value.length === 0) {
        throw workflowError(code, 'Mode-aware candidate exact diff is empty.', ExitCode.usage);
    }
    const normalized = value
        .map((change) => {
        if (!hasExactObjectKeys(change, [
            'afterDigest',
            'afterMode',
            'beforeDigest',
            'beforeMode',
            'path',
        ])) {
            throw workflowError(code, 'Mode-aware exact diff has an unknown schema.', ExitCode.usage);
        }
        assertSafePath(change.path, false, code);
        const beforePresent = change.beforeDigest !== null;
        const afterPresent = change.afterDigest !== null;
        if (beforePresent) {
            assertDigest(change.beforeDigest, code);
        }
        if (afterPresent) {
            assertDigest(change.afterDigest, code);
        }
        if (beforePresent !== (change.beforeMode !== null) ||
            afterPresent !== (change.afterMode !== null) ||
            (change.beforeMode !== null &&
                change.beforeMode !== '100644' &&
                change.beforeMode !== '100755') ||
            (change.afterMode !== null &&
                change.afterMode !== '100644' &&
                change.afterMode !== '100755') ||
            (!beforePresent && !afterPresent) ||
            (change.beforeDigest === change.afterDigest &&
                change.beforeMode === change.afterMode)) {
            throw workflowError(code, 'Mode-aware exact diff has an invalid file state or a no-op.', ExitCode.usage);
        }
        return {
            path: change.path,
            beforeDigest: change.beforeDigest,
            afterDigest: change.afterDigest,
            beforeMode: change.beforeMode,
            afterMode: change.afterMode,
        };
    })
        .sort((left, right) => compareCanonicalStrings(left.path, right.path));
    assertSortedUnique(normalized.map((change) => change.path), code);
    return normalized;
}
export function controlPlaneCandidateDigestV2(changes) {
    return canonicalDigest({
        kind: 'control-plane-candidate.v2',
        changes: normalizedExactChangesV2(changes),
    });
}
export function classifyProtectedCandidateImpactV2(input) {
    verifyProtectedManifest(input.beforeManifest);
    verifyProtectedManifest(input.afterManifest);
    const changes = normalizedExactChangesV2(input.changes);
    const changedPaths = new Set(changes.map((change) => change.path));
    const manifestChanged = changedPaths.has(input.beforeManifest.manifestPath) ||
        input.beforeManifest.manifestDigest !== input.afterManifest.manifestDigest;
    const capabilities = new Set();
    for (const capability of REQUIRED_PROTECTED_CAPABILITIES) {
        const before = input.beforeManifest.entries.find((entry) => entry.capability === capability);
        const after = input.afterManifest.entries.find((entry) => entry.capability === capability);
        const protectedPaths = new Set([
            ...before.entrypoints,
            ...before.dependencies,
            ...after.entrypoints,
            ...after.dependencies,
        ]);
        if (before.closureDigest !== after.closureDigest ||
            [...changedPaths].some((changedPath) => protectedPaths.has(changedPath))) {
            capabilities.add(capability);
        }
    }
    const affectedCapabilities = [...capabilities].sort(compareCanonicalStrings);
    return freezeDeep(manifestChanged || affectedCapabilities.length > 0
        ? {
            class: 'C',
            kind: 'control-plane',
            affectedCapabilities,
            manifestChanged,
        }
        : {
            class: 'A',
            kind: 'ordinary',
            affectedCapabilities: [],
            manifestChanged: false,
        });
}
function decodeCanonicalPromotionBase64(value, code) {
    if (typeof value !== 'string' ||
        value.length >
            Math.ceil((MAX_CONTROL_PLANE_PROMOTION_FILE_BYTES * 4) / 3) + 4) {
        throw workflowError(code, 'Promotion material contains invalid or oversized base64.', ExitCode.guard);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length > MAX_CONTROL_PLANE_PROMOTION_FILE_BYTES ||
        decoded.toString('base64') !== value) {
        throw workflowError(code, 'Promotion material base64 must be canonical and bounded.', ExitCode.guard);
    }
    return decoded;
}
function rawPromotionDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function normalizeControlPlanePromotionFiles(value, code) {
    if (!Array.isArray(value) || value.length === 0) {
        throw workflowError(code, 'Promotion file inventory is empty.', ExitCode.guard);
    }
    let totalBytes = 0;
    const files = value
        .map((entry) => {
        if (!hasExactObjectKeys(entry, [
            'contentBase64',
            'contentDigest',
            'mode',
            'path',
        ])) {
            throw workflowError(code, 'Promotion file inventory has an unknown schema.', ExitCode.guard);
        }
        const file = entry;
        assertSafePath(file.path, false, code);
        if (file.mode !== '100644' && file.mode !== '100755') {
            throw workflowError(code, 'Promotion file mode is not supported.', ExitCode.guard);
        }
        assertDigest(file.contentDigest, code);
        const content = decodeCanonicalPromotionBase64(file.contentBase64, code);
        totalBytes += content.length;
        if (totalBytes > MAX_CONTROL_PLANE_PROMOTION_BYTES ||
            rawPromotionDigest(content) !== file.contentDigest) {
            throw workflowError(code, 'Promotion file content does not match its digest or size bound.', ExitCode.guard);
        }
        return {
            path: file.path,
            mode: file.mode,
            contentBase64: file.contentBase64,
            contentDigest: file.contentDigest,
        };
    })
        .sort((left, right) => compareCanonicalStrings(left.path, right.path));
    assertSortedUnique(files.map((file) => file.path), code);
    return files;
}
function normalizePromotionEngineArtifact(value, code) {
    const artifactKeys = [
        'artifactId',
        'canReadSessionSchemas',
        'executableDigest',
        'kind',
        'policySchemaVersion',
        'protocolVersion',
        'smokeReportDigest',
        'sourceChangeId',
        'sourceDigest',
        'writesSessionSchema',
    ];
    if (!hasExactObjectKeys(value, value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'workflowBindingDigest' in value
        ? [...artifactKeys, 'workflowBindingDigest']
        : artifactKeys)) {
        throw workflowError(code, 'Promotion EngineArtifact has an unknown schema.', ExitCode.guard);
    }
    const artifact = value;
    if (artifact.kind !== 'engine-artifact.v1') {
        throw workflowError(code, 'Promotion EngineArtifact kind is not supported.', ExitCode.guard);
    }
    const rebuilt = createEngineArtifact(artifact);
    if (rebuilt.artifactId !== artifact.artifactId) {
        throw workflowError(code, 'Promotion EngineArtifact digest mismatch.', ExitCode.verification);
    }
    return rebuilt;
}
function assertPromotionFilesMatchChanges(files, changes, side, code) {
    const expected = changes
        .filter((change) => side === 'before'
        ? change.beforeDigest !== null
        : change.afterDigest !== null)
        .map((change) => ({
        path: change.path,
        mode: side === 'before' ? change.beforeMode : change.afterMode,
        contentDigest: side === 'before' ? change.beforeDigest : change.afterDigest,
    }));
    const observed = files.map((file) => ({
        path: file.path,
        mode: file.mode,
        contentDigest: file.contentDigest,
    }));
    if (!sameJson(observed, expected)) {
        throw workflowError(code, `Promotion ${side} file inventory does not match the exact diff and modes.`, ExitCode.verification);
    }
}
function normalizeAffectedCapabilitiesV2(value, code) {
    if (!Array.isArray(value) ||
        value.some((capability) => !REQUIRED_PROTECTED_CAPABILITIES.includes(capability))) {
        throw workflowError(code, 'Promotion material contains an unknown protected capability.', ExitCode.guard);
    }
    assertSortedUnique(value, code);
    return [...value];
}
export function createControlPlaneRecoveryBundleMaterial(input) {
    if (!hasExactObjectKeys(input, [
        'previousClosureDigest',
        'previousFiles',
        'repositoryId',
        'restartArtifact',
        'restartExecutableBase64',
        'restartExecutableProvenanceDigest',
        'rollbackTestReportBase64',
        'rollbackTestReportDigest',
    ])) {
        throw recoveryMaterialError('Unknown recovery material input schema.');
    }
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID', 'Repository id');
    assertDigest(input.previousClosureDigest, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    const restartArtifact = normalizePromotionEngineArtifact(input.restartArtifact, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    assertDigest(input.restartExecutableProvenanceDigest, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    const previousFiles = normalizeControlPlanePromotionFiles(input.previousFiles, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    const restartExecutable = decodeCanonicalPromotionBase64(input.restartExecutableBase64, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    if (rawPromotionDigest(restartExecutable) !== restartArtifact.executableDigest) {
        throw recoveryMaterialError('Recovery executable does not match the restart EngineArtifact.');
    }
    const rollbackTestReport = decodeCanonicalPromotionBase64(input.rollbackTestReportBase64, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    assertDigest(input.rollbackTestReportDigest, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    if (rawPromotionDigest(rollbackTestReport) !== input.rollbackTestReportDigest) {
        throw recoveryMaterialError('Rollback-test evidence digest mismatch.');
    }
    const payload = {
        kind: 'control-plane-recovery-bundle.v2',
        repositoryId: input.repositoryId,
        previousClosureDigest: input.previousClosureDigest,
        restartArtifact,
        restartExecutableBase64: input.restartExecutableBase64,
        restartExecutableProvenanceDigest: input.restartExecutableProvenanceDigest,
        previousFiles,
        rollbackTestReportBase64: input.rollbackTestReportBase64,
        rollbackTestReportDigest: input.rollbackTestReportDigest,
    };
    return freezeDeep({ ...payload, bundleDigest: canonicalDigest(payload) });
}
function verifyControlPlaneRecoveryBundleMaterial(value) {
    if (!hasExactObjectKeys(value, [
        'bundleDigest',
        'kind',
        'previousClosureDigest',
        'previousFiles',
        'repositoryId',
        'restartArtifact',
        'restartExecutableBase64',
        'restartExecutableProvenanceDigest',
        'rollbackTestReportBase64',
        'rollbackTestReportDigest',
    ])) {
        throw recoveryMaterialError('Unknown recovery material schema.');
    }
    const material = value;
    if (material.kind !== 'control-plane-recovery-bundle.v2') {
        throw recoveryMaterialError('Unknown recovery material kind.');
    }
    const rebuilt = createControlPlaneRecoveryBundleMaterial({
        repositoryId: material.repositoryId,
        previousClosureDigest: material.previousClosureDigest,
        restartArtifact: material.restartArtifact,
        restartExecutableBase64: material.restartExecutableBase64,
        restartExecutableProvenanceDigest: material.restartExecutableProvenanceDigest,
        previousFiles: material.previousFiles,
        rollbackTestReportBase64: material.rollbackTestReportBase64,
        rollbackTestReportDigest: material.rollbackTestReportDigest,
    });
    if (!sameJson(rebuilt, material)) {
        throw recoveryMaterialError('Recovery material digest or bytes mismatch.');
    }
    return rebuilt;
}
export function createControlPlanePromotionMaterial(input) {
    const keys = [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateArtifact',
        'candidateDigest',
        'candidateExecutableBase64',
        'candidateExecutableProvenanceDigest',
        'candidateFiles',
        'exactChanges',
        'frozenCandidateBundleDigest',
        'mandateBinding',
        'recoveryBundle',
        'repositoryId',
    ];
    const hasKind = Object.prototype.hasOwnProperty.call(input, 'kind');
    if (!hasExactObjectKeys(input, hasKind ? [...keys, 'kind'] : keys) ||
        (hasKind && input.kind !== 'control-plane-promotion-material.v1')) {
        throw promotionMaterialError('Unknown promotion material schema.');
    }
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(input.mandateBinding);
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID', 'Repository id');
    assertNonEmpty(input.behaviorChangeSummary, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID', 'Behavior change summary');
    for (const digest of [
        input.frozenCandidateBundleDigest,
        input.candidateDigest,
        input.beforeClosureDigest,
        input.afterClosureDigest,
        input.candidateExecutableProvenanceDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    }
    const exactChanges = normalizedExactChangesV2(input.exactChanges, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    if (input.candidateDigest !== controlPlaneCandidateDigestV2(exactChanges)) {
        throw promotionMaterialError('Promotion candidate digest does not match the mode-aware exact diff.');
    }
    const affectedCapabilities = normalizeAffectedCapabilitiesV2(input.affectedCapabilities, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    const candidateArtifact = normalizePromotionEngineArtifact(input.candidateArtifact, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    if (candidateArtifact.sourceChangeId !== mandateBinding.changeId) {
        throw promotionMaterialError('Candidate EngineArtifact is not bound to the Task Mandate change.');
    }
    const candidateExecutable = decodeCanonicalPromotionBase64(input.candidateExecutableBase64, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    const candidateFiles = normalizeControlPlanePromotionFiles(input.candidateFiles, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    const recoveryBundle = verifyControlPlaneRecoveryBundleMaterial(input.recoveryBundle);
    if (recoveryBundle.repositoryId !== input.repositoryId ||
        recoveryBundle.previousClosureDigest !== input.beforeClosureDigest) {
        throw promotionMaterialError('Recovery material is not bound to the repository and old closure.');
    }
    assertPromotionFilesMatchChanges(candidateFiles, exactChanges, 'after', 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    assertPromotionFilesMatchChanges(recoveryBundle.previousFiles, exactChanges, 'before', 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    if (rawPromotionDigest(candidateExecutable) !==
        candidateArtifact.executableDigest) {
        throw promotionMaterialError('Candidate executable does not match the candidate EngineArtifact.');
    }
    return freezeDeep({
        kind: 'control-plane-promotion-material.v1',
        mandateBinding,
        repositoryId: input.repositoryId,
        frozenCandidateBundleDigest: input.frozenCandidateBundleDigest,
        candidateDigest: input.candidateDigest,
        beforeClosureDigest: input.beforeClosureDigest,
        afterClosureDigest: input.afterClosureDigest,
        affectedCapabilities,
        behaviorChangeSummary: input.behaviorChangeSummary,
        exactChanges,
        candidateArtifact,
        candidateExecutableBase64: input.candidateExecutableBase64,
        candidateExecutableProvenanceDigest: input.candidateExecutableProvenanceDigest,
        candidateFiles,
        recoveryBundle,
    });
}
function verifyControlPlanePromotionMaterial(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateArtifact',
        'candidateDigest',
        'candidateExecutableBase64',
        'candidateExecutableProvenanceDigest',
        'candidateFiles',
        'exactChanges',
        'frozenCandidateBundleDigest',
        'kind',
        'mandateBinding',
        'recoveryBundle',
        'repositoryId',
    ])) {
        throw promotionMaterialError('Unknown promotion material schema.');
    }
    const rebuilt = createControlPlanePromotionMaterial(value);
    if (!sameJson(rebuilt, value)) {
        throw promotionMaterialError('Promotion material is not canonical.');
    }
    return rebuilt;
}
/**
 * This digest deliberately excludes every review or grant signature. A reviewer
 * signs this complete executable/artifact/recovery material; the later grant
 * can then bind both this digest and the final bundle (which includes review
 * bytes) without a signature cycle.
 */
export function controlPlanePromotionMaterialDigest(material) {
    return canonicalDigest(verifyControlPlanePromotionMaterial(material));
}
function validateControlPlaneIndependentReviewPayloadV2(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'candidateDigest',
        'frozenCandidateBundleDigest',
        'kind',
        'promotionMaterialDigest',
        'recoveryBundleDigest',
        'repositoryId',
        'reviewSummary',
        'reviewedAt',
        'reviewer',
        'verdict',
    ])) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v2 has an unknown schema.', ExitCode.guard);
    }
    const payload = value;
    if (payload.kind !== 'control-plane-independent-review.v2' ||
        payload.verdict !== 'approved') {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v2 is not an approved supported attestation.', ExitCode.guard);
    }
    for (const [field, label] of [
        [payload.repositoryId, 'Repository id'],
        [payload.reviewSummary, 'Review summary'],
        [payload.reviewer, 'Reviewer'],
    ]) {
        assertNonEmpty(field, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', label);
    }
    for (const digest of [
        payload.frozenCandidateBundleDigest,
        payload.candidateDigest,
        payload.promotionMaterialDigest,
        payload.beforeClosureDigest,
        payload.afterClosureDigest,
        payload.recoveryBundleDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    }
    normalizeAffectedCapabilitiesV2(payload.affectedCapabilities, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertIsoTimestamp(payload.reviewedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
}
function validateControlPlaneIndependentReviewAttestationV2(value) {
    if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v2 envelope has an unknown schema.', ExitCode.guard);
    }
    const envelope = value;
    validateControlPlaneIndependentReviewPayloadV2(envelope.payload);
    assertNonEmpty(envelope.signature, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Review signature');
}
export function canonicalControlPlaneIndependentReviewAttestationPayloadV2(payload) {
    validateControlPlaneIndependentReviewPayloadV2(payload);
    return `${canonicalJson(payload)}\n`;
}
export function controlPlaneIndependentReviewAttestationDigestV2(envelope) {
    validateControlPlaneIndependentReviewAttestationV2(envelope);
    return canonicalDigest(envelope);
}
export function verifyControlPlaneIndependentReviewAttestationV2(envelope, context) {
    validateControlPlaneIndependentReviewAttestationV2(envelope);
    const material = verifyControlPlanePromotionMaterial(context.material);
    assertDigest(context.expectedDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertNonEmpty(context.grantHumanSigner, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Grant signer');
    assertIsoTimestamp(context.grantIssuedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    const attestationDigest = canonicalDigest(envelope);
    if (attestationDigest !== context.expectedDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Independent review v2 bytes do not match the grant-bound digest.', ExitCode.verification);
    }
    const payload = envelope.payload;
    if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
        throw workflowError('CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID', 'Independent review must be completed before grant issuance.', ExitCode.guard);
    }
    if (payload.reviewer === context.grantHumanSigner) {
        throw workflowError('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT', 'The independent reviewer must differ from the grant signer.', ExitCode.guard);
    }
    const materialDigest = controlPlanePromotionMaterialDigest(material);
    if (payload.promotionMaterialDigest !== materialDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Independent review is bound to different promotion material.', ExitCode.verification);
    }
    if (payload.repositoryId !== material.repositoryId ||
        payload.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        payload.candidateDigest !== material.candidateDigest ||
        payload.beforeClosureDigest !== material.beforeClosureDigest ||
        payload.afterClosureDigest !== material.afterClosureDigest ||
        payload.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
        !sameJson(payload.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Independent review denormalized bindings differ from promotion material.', ExitCode.verification);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneIndependentReviewAttestationPayloadV2(payload), envelope.signature, payload.reviewer, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2)) {
        throw workflowError('CONTROL_PLANE_REVIEW_SIGNATURE_INVALID', 'Independent review v2 signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            affectedCapabilities: [...payload.affectedCapabilities],
        },
        signature: envelope.signature,
        attestationDigest,
        verification: 'independent-human-signature-verified',
    });
}
export function createControlPlanePromotionBundleV2(input) {
    if (!hasExactObjectKeys(input, ['independentReviewAttestation', 'material'])) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_INVALID', 'Promotion bundle v2 input has an unknown schema.', ExitCode.guard);
    }
    const material = verifyControlPlanePromotionMaterial(input.material);
    const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
    validateControlPlaneIndependentReviewAttestationV2(input.independentReviewAttestation);
    const review = input.independentReviewAttestation.payload;
    if (review.promotionMaterialDigest !== promotionMaterialDigest ||
        review.repositoryId !== material.repositoryId ||
        review.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        review.candidateDigest !== material.candidateDigest ||
        review.beforeClosureDigest !== material.beforeClosureDigest ||
        review.afterClosureDigest !== material.afterClosureDigest ||
        review.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
        !sameJson(review.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Signed review does not bind the exact promotion material.', ExitCode.verification);
    }
    const payload = {
        kind: 'control-plane-promotion-bundle.v2',
        material,
        promotionMaterialDigest,
        independentReviewAttestation: structuredClone(input.independentReviewAttestation),
    };
    return freezeDeep({ ...payload, bundleDigest: canonicalDigest(payload) });
}
function verifyControlPlanePromotionBundleV2(value) {
    if (!hasExactObjectKeys(value, [
        'bundleDigest',
        'independentReviewAttestation',
        'kind',
        'material',
        'promotionMaterialDigest',
    ])) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_INVALID', 'Promotion bundle v2 has an unknown schema.', ExitCode.guard);
    }
    const bundle = value;
    if (bundle.kind !== 'control-plane-promotion-bundle.v2') {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_INVALID', 'Promotion bundle v2 kind is not supported.', ExitCode.guard);
    }
    assertDigest(bundle.promotionMaterialDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
    assertDigest(bundle.bundleDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
    const rebuilt = createControlPlanePromotionBundleV2({
        material: bundle.material,
        independentReviewAttestation: bundle.independentReviewAttestation,
    });
    if (!sameJson(rebuilt, bundle)) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH', 'Promotion bundle v2 digest or canonical bytes mismatch.', ExitCode.verification);
    }
    return rebuilt;
}
export function controlPlanePromotionBundleDigestV2(bundle) {
    return verifyControlPlanePromotionBundleV2(bundle).bundleDigest;
}
function validateControlPlaneGrantPayloadV2(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateDigest',
        'exactChanges',
        'expiresAt',
        'frozenCandidateBundleDigest',
        'grantId',
        'humanSigner',
        'independentReviewAttestationDigest',
        'issuedAt',
        'kind',
        'mandateBinding',
        'oneShot',
        'promotionBundleDigest',
        'promotionMaterialDigest',
        'recoveryBundle',
        'repositoryId',
        'updaterVersion',
    ])) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 has an unknown schema.', ExitCode.guard);
    }
    const payload = value;
    if (payload.kind !== 'control-plane-grant.v2' ||
        payload.oneShot !== true ||
        payload.updaterVersion !== 2) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 must be one-shot and require updater v2.', ExitCode.guard);
    }
    normalizeControlPlaneTaskMandateBinding(payload.mandateBinding);
    for (const [field, label] of [
        [payload.grantId, 'Grant id'],
        [payload.repositoryId, 'Repository id'],
        [payload.behaviorChangeSummary, 'Behavior change summary'],
        [payload.humanSigner, 'Human signer'],
    ]) {
        assertNonEmpty(field, 'CONTROL_PLANE_GRANT_INVALID', label);
    }
    for (const digest of [
        payload.frozenCandidateBundleDigest,
        payload.candidateDigest,
        payload.promotionMaterialDigest,
        payload.promotionBundleDigest,
        payload.beforeClosureDigest,
        payload.afterClosureDigest,
        payload.independentReviewAttestationDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_GRANT_INVALID');
    }
    const exactChanges = normalizedExactChangesV2(payload.exactChanges, 'CONTROL_PLANE_GRANT_INVALID');
    if (!sameJson(exactChanges, payload.exactChanges)) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 exact changes are not canonical.', ExitCode.guard);
    }
    normalizeAffectedCapabilitiesV2(payload.affectedCapabilities, 'CONTROL_PLANE_GRANT_INVALID');
    if (!hasExactObjectKeys(payload.recoveryBundle, [
        'bundleDigest',
        'previousClosureDigest',
        'restartArtifactDigest',
        'rollbackTestReportDigest',
    ])) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 recovery binding has an unknown schema.', ExitCode.guard);
    }
    for (const digest of [
        payload.recoveryBundle.bundleDigest,
        payload.recoveryBundle.previousClosureDigest,
        payload.recoveryBundle.restartArtifactDigest,
        payload.recoveryBundle.rollbackTestReportDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_GRANT_INVALID');
    }
    if (payload.recoveryBundle.previousClosureDigest !== payload.beforeClosureDigest) {
        throw workflowError('CONTROL_PLANE_RECOVERY_BUNDLE_MISMATCH', 'Grant recovery material does not restore the exact old closure.', ExitCode.verification);
    }
    assertIsoTimestamp(payload.issuedAt, 'CONTROL_PLANE_GRANT_INVALID');
    assertIsoTimestamp(payload.expiresAt, 'CONTROL_PLANE_GRANT_INVALID');
    const lifetimeMs = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
    if (lifetimeMs <= 0 || lifetimeMs > CONTROL_PLANE_GRANT_V2_MAX_TTL_MS) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 expiry must be within five minutes of issuance.', ExitCode.usage);
    }
}
function validateControlPlaneGrantEnvelopeV2(value) {
    if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 envelope has an unknown schema.', ExitCode.guard);
    }
    const envelope = value;
    validateControlPlaneGrantPayloadV2(envelope.payload);
    assertNonEmpty(envelope.signature, 'CONTROL_PLANE_GRANT_INVALID', 'Signature');
}
export function canonicalControlPlaneGrantPayloadV2(payload) {
    validateControlPlaneGrantPayloadV2(payload);
    return `${canonicalJson(payload)}\n`;
}
export function verifyControlPlaneGrantV2(envelope, context) {
    validateControlPlaneGrantEnvelopeV2(envelope);
    const payload = envelope.payload;
    if (context.consumedGrantIds.has(payload.grantId)) {
        throw workflowError('CONTROL_PLANE_GRANT_ALREADY_CONSUMED', 'One-shot Control-Plane Grant v2 has already been consumed.', ExitCode.conflict);
    }
    const bundle = verifyControlPlanePromotionBundleV2(context.bundle);
    if (payload.promotionBundleDigest !== bundle.bundleDigest) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH', 'Control-Plane Grant v2 is bound to a different reviewed bundle.', ExitCode.verification);
    }
    const material = bundle.material;
    if (payload.promotionMaterialDigest !== bundle.promotionMaterialDigest ||
        payload.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        payload.candidateDigest !== material.candidateDigest ||
        payload.repositoryId !== material.repositoryId ||
        payload.beforeClosureDigest !== material.beforeClosureDigest ||
        payload.afterClosureDigest !== material.afterClosureDigest ||
        payload.behaviorChangeSummary !== material.behaviorChangeSummary ||
        !sameJson(payload.mandateBinding, material.mandateBinding) ||
        !sameJson(payload.exactChanges, material.exactChanges) ||
        !sameJson(payload.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_PROMOTION_MATERIAL_MISMATCH', 'Control-Plane Grant v2 does not bind the exact promotion material.', ExitCode.verification);
    }
    const recovery = material.recoveryBundle;
    if (payload.recoveryBundle.bundleDigest !== recovery.bundleDigest ||
        payload.recoveryBundle.previousClosureDigest !==
            recovery.previousClosureDigest ||
        payload.recoveryBundle.restartArtifactDigest !==
            recovery.restartArtifact.executableDigest ||
        payload.recoveryBundle.rollbackTestReportDigest !==
            recovery.rollbackTestReportDigest) {
        throw workflowError('CONTROL_PLANE_RECOVERY_BUNDLE_MISMATCH', 'Control-Plane Grant v2 recovery binding is not exact.', ExitCode.verification);
    }
    const reviewDigest = controlPlaneIndependentReviewAttestationDigestV2(bundle.independentReviewAttestation);
    if (payload.independentReviewAttestationDigest !== reviewDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Control-Plane Grant v2 binds different independent-review bytes.', ExitCode.verification);
    }
    verifyProtectedManifest(context.beforeManifest);
    verifyProtectedManifest(context.afterManifest);
    if (payload.beforeClosureDigest !== context.beforeManifest.manifestDigest) {
        throw workflowError('CONTROL_PLANE_BEFORE_CLOSURE_MISMATCH', 'Control-Plane Grant v2 is stale for the old protected closure.', ExitCode.staleState);
    }
    if (payload.afterClosureDigest !== context.afterManifest.manifestDigest) {
        throw workflowError('CONTROL_PLANE_AFTER_CLOSURE_MISMATCH', 'Control-Plane Grant v2 does not bind the candidate protected closure.', ExitCode.verification);
    }
    const exactChanges = normalizedExactChangesV2(payload.exactChanges);
    if (context.beforeManifest.manifestDigest !==
        context.afterManifest.manifestDigest &&
        !exactChanges.some((change) => change.path === context.beforeManifest.manifestPath)) {
        throw workflowError('CONTROL_PLANE_MANIFEST_DIFF_MISSING', 'Changed protected manifest is absent from the exact candidate diff.', ExitCode.verification);
    }
    if (payload.candidateDigest !== controlPlaneCandidateDigestV2(exactChanges)) {
        throw workflowError('CONTROL_PLANE_CANDIDATE_DIGEST_MISMATCH', 'Control-Plane Grant v2 candidate digest mismatch.', ExitCode.verification);
    }
    const impact = classifyProtectedCandidateImpactV2({
        beforeManifest: context.beforeManifest,
        afterManifest: context.afterManifest,
        changes: exactChanges,
    });
    if (impact.class !== 'C') {
        throw workflowError('CONTROL_PLANE_GRANT_NOT_REQUIRED', 'Candidate does not affect a protected capability.', ExitCode.usage);
    }
    if (!sameJson(payload.affectedCapabilities, impact.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_CAPABILITY_IMPACT_MISMATCH', 'Control-Plane Grant v2 affected capabilities are not exact.', ExitCode.verification);
    }
    if (!Number.isFinite(context.now.getTime())) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v2 verification time is invalid.', ExitCode.usage);
    }
    if (context.now.getTime() < Date.parse(payload.issuedAt)) {
        throw workflowError('CONTROL_PLANE_GRANT_NOT_YET_VALID', 'Control-Plane Grant v2 cannot be used before issuance.', ExitCode.staleState);
    }
    if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
        throw workflowError('CONTROL_PLANE_GRANT_EXPIRED', 'Control-Plane Grant v2 has expired.', ExitCode.staleState);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneGrantPayloadV2(payload), envelope.signature, payload.humanSigner, CONTROL_PLANE_SIGNATURE_NAMESPACE_V2)) {
        throw workflowError('CONTROL_PLANE_GRANT_SIGNATURE_INVALID', 'Human Control-Plane Grant v2 signature could not be verified.', ExitCode.verification);
    }
    verifyControlPlaneIndependentReviewAttestationV2(bundle.independentReviewAttestation, {
        material,
        expectedDigest: payload.independentReviewAttestationDigest,
        grantHumanSigner: payload.humanSigner,
        grantIssuedAt: payload.issuedAt,
        verifyHumanSignature: context.verifyHumanSignature,
    });
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(payload.mandateBinding);
    return freezeDeep({
        payload: {
            ...payload,
            mandateBinding,
            exactChanges: exactChanges.map((change) => ({ ...change })),
            affectedCapabilities: [...payload.affectedCapabilities],
            recoveryBundle: { ...payload.recoveryBundle },
        },
        signature: envelope.signature,
        verifiedAt: context.now.toISOString(),
        verification: 'human-signature-verified',
    });
}
function reviewPayloadV2Projection(payload) {
    const { promotionLineageDigest: _promotionLineageDigest, ...rest } = payload;
    return { ...rest, kind: 'control-plane-independent-review.v2' };
}
function validateControlPlaneIndependentReviewPayloadV3(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'candidateDigest',
        'frozenCandidateBundleDigest',
        'kind',
        'promotionLineageDigest',
        'promotionMaterialDigest',
        'recoveryBundleDigest',
        'repositoryId',
        'reviewSummary',
        'reviewedAt',
        'reviewer',
        'verdict',
    ]) ||
        value.kind !== 'control-plane-independent-review.v3') {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v3 has an unknown schema.', ExitCode.guard);
    }
    const payload = value;
    assertDigest(payload.promotionLineageDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    validateControlPlaneIndependentReviewPayloadV2(reviewPayloadV2Projection(payload));
}
function validateControlPlaneIndependentReviewAttestationV3(value) {
    if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v3 envelope has an unknown schema.', ExitCode.guard);
    }
    const envelope = value;
    validateControlPlaneIndependentReviewPayloadV3(envelope.payload);
    assertNonEmpty(envelope.signature, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Review signature');
}
export function canonicalControlPlaneIndependentReviewAttestationPayloadV3(payload) {
    validateControlPlaneIndependentReviewPayloadV3(payload);
    return `${canonicalJson(payload)}\n`;
}
export function controlPlaneIndependentReviewAttestationDigestV3(envelope) {
    validateControlPlaneIndependentReviewAttestationV3(envelope);
    return canonicalDigest(envelope);
}
export function verifyControlPlaneIndependentReviewAttestationV3(envelope, context) {
    validateControlPlaneIndependentReviewAttestationV3(envelope);
    const material = verifyControlPlanePromotionMaterial(context.material);
    const lineage = verifyControlPlanePromotionLineage(context.lineage);
    assertDigest(context.expectedDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertNonEmpty(context.grantHumanSigner, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Grant signer');
    assertIsoTimestamp(context.grantIssuedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    const attestationDigest = canonicalDigest(envelope);
    const payload = envelope.payload;
    if (attestationDigest !== context.expectedDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Independent review v3 bytes do not match the grant-bound digest.', ExitCode.verification);
    }
    if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
        throw workflowError('CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID', 'Independent review must be completed before grant issuance.', ExitCode.guard);
    }
    if (payload.reviewer === context.grantHumanSigner) {
        throw workflowError('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT', 'The independent reviewer must differ from the grant signer.', ExitCode.guard);
    }
    if (payload.promotionMaterialDigest !==
        controlPlanePromotionMaterialDigest(material) ||
        payload.promotionLineageDigest !== lineage.lineageDigest ||
        payload.repositoryId !== material.repositoryId ||
        payload.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        payload.candidateDigest !== material.candidateDigest ||
        payload.beforeClosureDigest !== material.beforeClosureDigest ||
        payload.afterClosureDigest !== material.afterClosureDigest ||
        payload.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
        !sameJson(payload.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Independent review v3 does not bind the exact material and predecessor lineage.', ExitCode.verification);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneIndependentReviewAttestationPayloadV3(payload), envelope.signature, payload.reviewer, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3)) {
        throw workflowError('CONTROL_PLANE_REVIEW_SIGNATURE_INVALID', 'Independent review v3 signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            affectedCapabilities: [...payload.affectedCapabilities],
        },
        signature: envelope.signature,
        attestationDigest,
        verification: 'independent-human-signature-verified',
    });
}
export function createControlPlanePromotionBundleV3(input) {
    if (!hasExactObjectKeys(input, [
        'independentReviewAttestation',
        'lineage',
        'material',
    ])) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_INVALID', 'Promotion bundle v3 input has an unknown schema.', ExitCode.guard);
    }
    const material = verifyControlPlanePromotionMaterial(input.material);
    const lineage = verifyControlPlanePromotionLineage(input.lineage);
    validateControlPlaneIndependentReviewAttestationV3(input.independentReviewAttestation);
    const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
    const review = input.independentReviewAttestation.payload;
    if (review.promotionMaterialDigest !== promotionMaterialDigest ||
        review.promotionLineageDigest !== lineage.lineageDigest ||
        review.repositoryId !== material.repositoryId ||
        review.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        review.candidateDigest !== material.candidateDigest ||
        review.beforeClosureDigest !== material.beforeClosureDigest ||
        review.afterClosureDigest !== material.afterClosureDigest ||
        review.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
        !sameJson(review.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Signed review does not bind the exact v3 promotion material and lineage.', ExitCode.verification);
    }
    const payload = {
        kind: 'control-plane-promotion-bundle.v3',
        material,
        promotionMaterialDigest,
        lineage,
        promotionLineageDigest: lineage.lineageDigest,
        independentReviewAttestation: structuredClone(input.independentReviewAttestation),
    };
    return freezeDeep({ ...payload, bundleDigest: canonicalDigest(payload) });
}
export function verifyControlPlanePromotionBundleV3(value) {
    if (!hasExactObjectKeys(value, [
        'bundleDigest',
        'independentReviewAttestation',
        'kind',
        'lineage',
        'material',
        'promotionLineageDigest',
        'promotionMaterialDigest',
    ]) ||
        value.kind !== 'control-plane-promotion-bundle.v3') {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_INVALID', 'Promotion bundle v3 has an unknown schema.', ExitCode.guard);
    }
    const bundle = value;
    assertDigest(bundle.promotionMaterialDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
    assertDigest(bundle.promotionLineageDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
    assertDigest(bundle.bundleDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
    const rebuilt = createControlPlanePromotionBundleV3({
        material: bundle.material,
        lineage: bundle.lineage,
        independentReviewAttestation: bundle.independentReviewAttestation,
    });
    if (!sameJson(rebuilt, bundle)) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH', 'Promotion bundle v3 digest or canonical bytes mismatch.', ExitCode.verification);
    }
    return rebuilt;
}
export function controlPlanePromotionBundleDigestV3(bundle) {
    return verifyControlPlanePromotionBundleV3(bundle).bundleDigest;
}
function grantPayloadV2Projection(payload, promotionBundleDigest, reviewDigest) {
    const { promotionLineageDigest: _promotionLineageDigest, ...rest } = payload;
    return {
        ...rest,
        kind: 'control-plane-grant.v2',
        promotionBundleDigest,
        independentReviewAttestationDigest: reviewDigest,
        updaterVersion: 2,
    };
}
function validateControlPlaneGrantPayloadV3(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateDigest',
        'exactChanges',
        'expiresAt',
        'frozenCandidateBundleDigest',
        'grantId',
        'humanSigner',
        'independentReviewAttestationDigest',
        'issuedAt',
        'kind',
        'mandateBinding',
        'oneShot',
        'promotionBundleDigest',
        'promotionLineageDigest',
        'promotionMaterialDigest',
        'recoveryBundle',
        'repositoryId',
        'updaterVersion',
    ]) ||
        value.kind !== 'control-plane-grant.v3' ||
        value.updaterVersion !== 3) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v3 has an unknown schema or updater version.', ExitCode.guard);
    }
    const payload = value;
    assertDigest(payload.promotionLineageDigest, 'CONTROL_PLANE_GRANT_INVALID');
    validateControlPlaneGrantPayloadV2(grantPayloadV2Projection(payload, payload.promotionBundleDigest, payload.independentReviewAttestationDigest));
}
function validateControlPlaneGrantEnvelopeV3(value) {
    if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
        throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'Control-Plane Grant v3 envelope has an unknown schema.', ExitCode.guard);
    }
    const envelope = value;
    validateControlPlaneGrantPayloadV3(envelope.payload);
    assertNonEmpty(envelope.signature, 'CONTROL_PLANE_GRANT_INVALID', 'Signature');
}
export function canonicalControlPlaneGrantPayloadV3(payload) {
    validateControlPlaneGrantPayloadV3(payload);
    return `${canonicalJson(payload)}\n`;
}
export function verifyControlPlaneGrantV3(envelope, context) {
    validateControlPlaneGrantEnvelopeV3(envelope);
    const payload = envelope.payload;
    const bundle = verifyControlPlanePromotionBundleV3(context.bundle);
    if (context.consumedGrantIds.has(payload.grantId)) {
        throw workflowError('CONTROL_PLANE_GRANT_ALREADY_CONSUMED', 'One-shot Control-Plane Grant v3 has already been consumed.', ExitCode.conflict);
    }
    const reviewDigest = controlPlaneIndependentReviewAttestationDigestV3(bundle.independentReviewAttestation);
    if (payload.promotionBundleDigest !== bundle.bundleDigest ||
        payload.promotionMaterialDigest !== bundle.promotionMaterialDigest ||
        payload.promotionLineageDigest !== bundle.promotionLineageDigest ||
        payload.independentReviewAttestationDigest !== reviewDigest) {
        throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH', 'Control-Plane Grant v3 binds a different material, lineage, review, or bundle.', ExitCode.verification);
    }
    // Reuse the complete v2 material/classification/time validation with a
    // structural projection. Authority is checked separately below against the
    // actual v3 payloads and namespaces, so no v2 signature can authorize v3.
    const projectedReview = {
        payload: reviewPayloadV2Projection(bundle.independentReviewAttestation.payload),
        signature: bundle.independentReviewAttestation.signature,
    };
    const projectedBundle = createControlPlanePromotionBundleV2({
        material: bundle.material,
        independentReviewAttestation: projectedReview,
    });
    const projectedGrant = {
        payload: grantPayloadV2Projection(payload, projectedBundle.bundleDigest, controlPlaneIndependentReviewAttestationDigestV2(projectedReview)),
        signature: envelope.signature,
    };
    verifyControlPlaneGrantV2(projectedGrant, {
        now: context.now,
        beforeManifest: context.beforeManifest,
        afterManifest: context.afterManifest,
        bundle: projectedBundle,
        consumedGrantIds: context.consumedGrantIds,
        verifyHumanSignature: () => true,
    });
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneGrantPayloadV3(payload), envelope.signature, payload.humanSigner, CONTROL_PLANE_SIGNATURE_NAMESPACE_V3)) {
        throw workflowError('CONTROL_PLANE_GRANT_SIGNATURE_INVALID', 'Human Control-Plane Grant v3 signature could not be verified.', ExitCode.verification);
    }
    verifyControlPlaneIndependentReviewAttestationV3(bundle.independentReviewAttestation, {
        material: bundle.material,
        lineage: bundle.lineage,
        expectedDigest: reviewDigest,
        grantHumanSigner: payload.humanSigner,
        grantIssuedAt: payload.issuedAt,
        verifyHumanSignature: context.verifyHumanSignature,
    });
    return freezeDeep({
        payload: {
            ...payload,
            mandateBinding: { ...payload.mandateBinding },
            exactChanges: payload.exactChanges.map((change) => ({ ...change })),
            affectedCapabilities: [...payload.affectedCapabilities],
            recoveryBundle: { ...payload.recoveryBundle },
        },
        signature: envelope.signature,
        verifiedAt: context.now.toISOString(),
        verification: 'human-signature-verified',
    });
}
function minimalUpdaterPayload(tx) {
    return { ...tx };
}
function buildMinimalUpdaterTransaction(tx) {
    return freezeDeep({
        ...tx,
        journalDigest: canonicalDigest(minimalUpdaterPayload(tx)),
    });
}
function verifyMinimalUpdaterTransaction(tx) {
    assertDigest(tx.journalDigest, 'CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT');
    const { journalDigest, ...payload } = tx;
    if (canonicalDigest(minimalUpdaterPayload(payload)) !== journalDigest ||
        tx.history.length === 0 ||
        tx.history.at(-1)?.state !== tx.state) {
        throw workflowError('CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT', 'Minimal updater journal failed integrity verification.', ExitCode.verification);
    }
}
export function prepareMinimalUpdaterTransaction(grant, input) {
    assertNonEmpty(input.txId, 'CONTROL_PLANE_UPDATE_INVALID', 'Control-plane transaction id');
    if (grant.verification !== 'human-signature-verified' ||
        grant.payload.oneShot !== true) {
        throw workflowError('CONTROL_PLANE_UPDATE_GRANT_INVALID', 'Minimal updater requires a verified one-shot Control-Plane Grant.', ExitCode.guard);
    }
    if (input.now.getTime() >= Date.parse(grant.payload.expiresAt)) {
        throw workflowError('CONTROL_PLANE_UPDATE_GRANT_EXPIRED', 'Grant expired before updater preparation.', ExitCode.staleState);
    }
    const at = input.now.toISOString();
    return buildMinimalUpdaterTransaction({
        kind: 'minimal-control-plane-updater.v1',
        txId: input.txId,
        grantId: grant.payload.grantId,
        candidateDigest: grant.payload.candidateDigest,
        beforeClosureDigest: grant.payload.beforeClosureDigest,
        afterClosureDigest: grant.payload.afterClosureDigest,
        recoveryBundleDigest: grant.payload.recoveryBundle.bundleDigest,
        updaterVersion: grant.payload.updaterVersion,
        state: 'PREPARED',
        history: [{ state: 'PREPARED', at }],
    });
}
const MINIMAL_UPDATER_TRANSITIONS = {
    PREPARED: { 'old-closure-verified': 'OLD_CLOSURE_VERIFIED' },
    OLD_CLOSURE_VERIFIED: { 'candidate-verified': 'CANDIDATE_VERIFIED' },
    CANDIDATE_VERIFIED: { 'recovery-bundle-verified': 'RECOVERY_VERIFIED' },
    RECOVERY_VERIFIED: { 'atomic-switch-completed': 'SWITCHED' },
    SWITCHED: {
        'self-tests-passed': 'SELF_TESTED',
        'self-tests-failed': 'ROLLBACK_REQUIRED',
    },
    SELF_TESTED: { finalize: 'FINALIZED' },
    ROLLBACK_REQUIRED: { 'rollback-completed': 'ROLLED_BACK' },
    FINALIZED: {},
    ROLLED_BACK: {},
};
export function advanceMinimalUpdaterTransaction(tx, event) {
    verifyMinimalUpdaterTransaction(tx);
    const nextState = MINIMAL_UPDATER_TRANSITIONS[tx.state][event.kind];
    if (nextState === undefined) {
        throw workflowError('CONTROL_PLANE_UPDATE_TRANSITION_INVALID', `Cannot apply ${event.kind} while updater is ${tx.state}.`, ExitCode.conflict);
    }
    assertMonotonicTimestamp(tx.history.at(-1).at, event.at, 'CONTROL_PLANE_UPDATE_TRANSITION_INVALID');
    const { journalDigest: _journalDigest, ...payload } = tx;
    return buildMinimalUpdaterTransaction({
        ...payload,
        state: nextState,
        history: [...tx.history, { state: nextState, at: event.at }],
    });
}
export function decideControlPlaneRecovery(tx) {
    verifyMinimalUpdaterTransaction(tx);
    switch (tx.state) {
        case 'PREPARED':
        case 'OLD_CLOSURE_VERIFIED':
        case 'CANDIDATE_VERIFIED':
        case 'RECOVERY_VERIFIED':
            return {
                action: 'resume-verification',
                authoritativeClosureDigest: tx.beforeClosureDigest,
                terminal: false,
            };
        case 'SWITCHED':
        case 'ROLLBACK_REQUIRED':
            return {
                action: 'rollback-with-recovery-bundle',
                authoritativeClosureDigest: tx.beforeClosureDigest,
                terminal: false,
            };
        case 'SELF_TESTED':
            return {
                action: 'finalize',
                authoritativeClosureDigest: tx.afterClosureDigest,
                terminal: false,
            };
        case 'FINALIZED':
            return {
                action: 'none',
                authoritativeClosureDigest: tx.afterClosureDigest,
                terminal: true,
            };
        case 'ROLLED_BACK':
            return {
                action: 'none',
                authoritativeClosureDigest: tx.beforeClosureDigest,
                terminal: true,
            };
    }
}
// ---------------------------------------------------------------------------
// M11: supersede restriction and legacy v1 read-only verification
// ---------------------------------------------------------------------------
export const WORKFLOW_SUPERSEDE_REASONS = [
    'semantic-decision-no-continuing-value',
    'user-abandoned-goal-for-different-workflow',
    'workflow-replaced',
    'workflows-merged',
];
const EXECUTION_FAILURE_REASONS = new Set([
    'environment-drift',
    'execution-limit-change',
    'network-error',
    'provider-adapter-upgrade',
    'provider-process-failure',
    'provider-timeout',
    'rate-limit',
    'retry-policy-change',
    'schema-invalid',
    'validator-repair',
    'worker-crash',
]);
export function validateWorkflowSupersedeReason(reason) {
    if (WORKFLOW_SUPERSEDE_REASONS.includes(reason)) {
        return { allowed: true, reason: reason };
    }
    if (EXECUTION_FAILURE_REASONS.has(reason)) {
        throw workflowError('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN', 'Execution failures must use retry, repair, grant, or recovery; they cannot supersede a workflow.', ExitCode.guard);
    }
    if (reason === 'contract-or-baseline-change') {
        throw workflowError('SUPERSEDE_REQUIRES_EPOCH_ROLLOVER', 'Contract or baseline changes require an epoch rollover, not supersede.', ExitCode.guard);
    }
    throw workflowError('SUPERSEDE_REASON_UNSUPPORTED', 'Supersede requires an explicit workflow-replacement reason.', ExitCode.usage);
}
export function verifyLegacyGrantV1ReadOnly(record, context) {
    if (record.kind !== 'legacy-grant-v1-audit.v1' ||
        record.legacyKind !== 'maintainer-grant.v1') {
        throw workflowError('LEGACY_GRANT_V1_INVALID', 'Unknown legacy grant audit record.', ExitCode.usage);
    }
    for (const [value, label] of [
        [record.grantId, 'Grant id'],
        [record.signedPayload, 'Signed payload'],
        [record.signer, 'Signer'],
        [record.signature, 'Signature'],
    ]) {
        assertNonEmpty(value, 'LEGACY_GRANT_V1_INVALID', label);
    }
    assertDigest(record.payloadDigest, 'LEGACY_GRANT_V1_INVALID');
    if (sha256(record.signedPayload) !== record.payloadDigest) {
        throw workflowError('LEGACY_GRANT_V1_PAYLOAD_DIGEST_MISMATCH', 'Historical grant payload digest mismatch.', ExitCode.verification);
    }
    const signatureValid = verifyHumanSignatureSafely(context.verifyHumanSignature, record.signedPayload, record.signature, record.signer, 'expense-app.workflow.maintainer-grant.v1');
    if (!signatureValid) {
        throw workflowError('LEGACY_GRANT_V1_SIGNATURE_INVALID', 'Historical V1 grant signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        grantId: record.grantId,
        legacyKind: record.legacyKind,
        mode: 'historical-read-only',
        signatureValid: true,
    });
}
export function assertLegacyGrantV1SigningAllowed() {
    throw workflowError('LEGACY_GRANT_V1_NEW_SIGNING_DISABLED', 'New V1 grant signing is disabled; V1 records are historical read-only evidence.', ExitCode.guard);
}
