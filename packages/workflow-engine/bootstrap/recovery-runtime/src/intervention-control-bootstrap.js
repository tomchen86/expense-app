import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { ensurePlainDirectory } from './filesystem-safety.js';
import { readStoredInterventionEngineArtifact } from './intervention-engine-artifact-store.js';
import { createWipCheckpoint, verifyHarnessMaintenanceGrant, } from './intervention-control.js';
import { advancePersistedEngineAdoption, activeBootstrapSidecarPromotionPinTxIds, inFlightPersistedEngineAdoptionTxIds, interventionRecordPath, interventionControlPersistencePaths, persistInterventionPlan, recordBootstrapSidecarAbandoned, recordBootstrapSidecarAdopted, recordBootstrapSidecarWorkspaceMaterialized, readPersistedIntervention, recoverPersistedEngineAdoption, rollbackPersistedEngineAdoption, withInterventionParentOperation, } from './intervention-control-persistence.js';
const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const ENGINE_COMMAND_TIMEOUT_MS = 10_000;
const PRIVATE_EXECUTABLE_MODE = 0o500;
export function discoverBootstrapUntrackedAllowlist(repositoryRoot) {
    return listUntracked(canonicalRepositoryRoot(repositoryRoot));
}
/**
 * Projects a trusted durable session record into bootstrap-owned persistence.
 * The content-addressed target makes retries idempotent and prevents a caller
 * from selecting a mutable snapshot path outside the recovery state root.
 */
export function persistTrustedBootstrapSessionSnapshot(storageRoot, session) {
    const content = Buffer.from(`${canonicalJson(session)}\n`, 'utf8');
    if (content.length > MAX_SESSION_BYTES) {
        throw workflowError('BOOTSTRAP_SESSION_SNAPSHOT_TOO_LARGE', 'Durable workflow session exceeds the bootstrap size limit.', ExitCode.guard);
    }
    const digest = rawDigest(content);
    const snapshotPath = path.join(interventionControlPersistencePaths(storageRoot).root, 'session-snapshots', `${digest.slice('sha256:'.length)}.json`);
    try {
        createPrivateFileExclusive(snapshotPath, content);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
            throw error;
        }
    }
    const observed = readPrivateBytes(snapshotPath, 'BOOTSTRAP_SESSION_SNAPSHOT_NOT_FOUND', MAX_SESSION_BYTES);
    if (!observed.equals(content)) {
        throw workflowError('BOOTSTRAP_SESSION_SNAPSHOT_CONFLICT', 'Content-addressed durable session snapshot differs from its source.', ExitCode.staleState);
    }
    return snapshotPath;
}
export function capturePersistedWipIntervention(storageRoot, input) {
    const repositoryRoot = canonicalRepositoryRoot(input.repositoryRoot);
    const now = exactDate(input.now, 'BOOTSTRAP_CLOCK_INVALID');
    const baseOid = gitText(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    assertGitOid(baseOid, 'BOOTSTRAP_BASE_OID_INVALID');
    assertDigest(input.parent.engineBinding, 'BOOTSTRAP_ENGINE_DIGEST_INVALID');
    assertDigest(input.policyDigest, 'BOOTSTRAP_POLICY_DIGEST_INVALID');
    assertNonEmpty(input.pendingIntent, 'BOOTSTRAP_PENDING_INTENT_INVALID');
    if (Buffer.byteLength(input.pendingIntent, 'utf8') > MAX_SESSION_BYTES) {
        throw workflowError('BOOTSTRAP_PENDING_INTENT_INVALID', 'Pending intent exceeds the bootstrap size limit.', ExitCode.guard);
    }
    const workingTreePatch = gitBuffer(repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        'HEAD',
        '--',
    ]);
    const stagedPatch = gitBuffer(repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        '--cached',
        'HEAD',
        '--',
    ]);
    if (workingTreePatch.length > MAX_PATCH_BYTES ||
        stagedPatch.length > MAX_PATCH_BYTES) {
        throw workflowError('BOOTSTRAP_TRACKED_PATCH_TOO_LARGE', 'Tracked WIP patch exceeds the bootstrap size limit.', ExitCode.guard);
    }
    const trackedPaths = parseNulPaths(gitBuffer(repositoryRoot, ['diff', '--name-only', '-z', 'HEAD', '--']));
    const allowlist = validateUntrackedAllowlist(input.untrackedAllowlist);
    const observedUntracked = listUntracked(repositoryRoot);
    if (canonicalJson(allowlist) !== canonicalJson(observedUntracked)) {
        throw workflowError('BOOTSTRAP_UNTRACKED_ALLOWLIST_MISMATCH', 'Untracked allowlist must exactly cover every non-ignored untracked path.', ExitCode.guard, { details: { expected: observedUntracked, actual: allowlist } });
    }
    const untracked = captureUntrackedFiles(repositoryRoot, allowlist);
    const sessionSnapshotPath = canonicalPlainFile(assertPersistenceOwnedPath(storageRoot, input.sessionSnapshotPath, 'BOOTSTRAP_SESSION_SNAPSHOT_OUTSIDE_STATE'), MAX_SESSION_BYTES, 'BOOTSTRAP_SESSION_SNAPSHOT_UNSAFE');
    const sessionBytes = fs.readFileSync(sessionSnapshotPath);
    const status = gitBuffer(repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
    ]);
    const tracked = {
        paths: trackedPaths,
        workingTreePatchBase64: workingTreePatch.toString('base64'),
        stagedPatchBase64: stagedPatch.toString('base64'),
        workingTreePatchDigest: rawDigest(workingTreePatch),
        stagedPatchDigest: rawDigest(stagedPatch),
    };
    const trackedTreeDigest = canonicalDigest(tracked);
    const untrackedBundleDigest = canonicalDigest(untracked);
    const sessionStateDigest = rawDigest(sessionBytes);
    const pendingIntentDigest = rawDigest(Buffer.from(input.pendingIntent));
    const worktreeFingerprint = canonicalDigest({
        baseOid,
        statusDigest: rawDigest(status),
        trackedTreeDigest,
        untrackedBundleDigest,
        sessionStateDigest,
        pendingIntentDigest,
    });
    const checkpoint = createWipCheckpoint({
        parentChangeId: input.parent.changeId,
        baseOid,
        worktreeFingerprint,
        trackedTreeDigest,
        untrackedBundleDigest,
        sessionStateDigest,
        pendingIntentDigest,
        engineDigest: input.parent.engineBinding,
        policyDigest: input.policyDigest,
        createdAt: now.toISOString(),
    });
    const bundlePayload = {
        kind: 'harness-wip-bundle.v1',
        checkpointId: checkpoint.checkpointId,
        parentChangeId: input.parent.changeId,
        repositoryRoot,
        baseOid,
        tracked,
        untracked,
        session: {
            snapshotPath: sessionSnapshotPath,
            contentBase64: sessionBytes.toString('base64'),
            contentDigest: sessionStateDigest,
        },
        pendingIntent: input.pendingIntent,
        statusPorcelainBase64: status.toString('base64'),
        capturedAt: now.toISOString(),
    };
    const bundle = {
        ...bundlePayload,
        bundleDigest: canonicalDigest(bundlePayload),
    };
    persistWipBundle(storageRoot, bundle);
    const intervention = persistInterventionPlan(storageRoot, {
        parent: input.parent,
        interventionChangeId: input.interventionChangeId,
        checkpoint,
        childWorkspace: {
            parentWorkspacePath: repositoryRoot,
            childWorkspacePath: canonicalPlannedWorkspacePath(input.childWorkspacePath, repositoryRoot),
            changeRef: input.changeRef,
        },
        now,
        testAfterInterventionPersistedBeforeSidecar: input.testAfterInterventionPersistedBeforeSidecar,
    });
    return { intervention, bundle };
}
export function readPersistedWipBundle(storageRoot, checkpointId) {
    assertDigest(checkpointId, 'BOOTSTRAP_CHECKPOINT_ID_INVALID');
    const value = readCanonicalPrivateJson(wipBundlePath(storageRoot, checkpointId), 'BOOTSTRAP_WIP_BUNDLE_NOT_FOUND', MAX_BUNDLE_BYTES);
    if (!isRecord(value) ||
        value.kind !== 'harness-wip-bundle.v1' ||
        value.checkpointId !== checkpointId ||
        !hasExactKeys(value, [
            'baseOid',
            'bundleDigest',
            'capturedAt',
            'checkpointId',
            'kind',
            'parentChangeId',
            'pendingIntent',
            'repositoryRoot',
            'session',
            'statusPorcelainBase64',
            'tracked',
            'untracked',
        ])) {
        throw corruptWipBundle();
    }
    const bundle = value;
    const { bundleDigest, ...payload } = bundle;
    try {
        assertDigest(bundleDigest, 'BOOTSTRAP_WIP_BUNDLE_CORRUPT');
        if (!isRecord(bundle.tracked) ||
            !hasExactKeys(bundle.tracked, [
                'paths',
                'stagedPatchBase64',
                'stagedPatchDigest',
                'workingTreePatchBase64',
                'workingTreePatchDigest',
            ]) ||
            !isRecord(bundle.session) ||
            !hasExactKeys(bundle.session, [
                'contentBase64',
                'contentDigest',
                'snapshotPath',
            ]) ||
            canonicalDigest(payload) !== bundleDigest ||
            rawDigest(decodeCanonicalBase64(bundle.tracked.workingTreePatchBase64)) !== bundle.tracked.workingTreePatchDigest ||
            rawDigest(decodeCanonicalBase64(bundle.tracked.stagedPatchBase64)) !==
                bundle.tracked.stagedPatchDigest ||
            rawDigest(decodeCanonicalBase64(bundle.session.contentBase64)) !==
                bundle.session.contentDigest ||
            !Array.isArray(bundle.untracked) ||
            !Array.isArray(bundle.tracked.paths) ||
            typeof bundle.statusPorcelainBase64 !== 'string') {
            throw corruptWipBundle();
        }
        decodeCanonicalBase64(bundle.statusPorcelainBase64);
        for (const trackedPath of bundle.tracked.paths) {
            assertSafeRelativePath(trackedPath);
        }
        if (canonicalJson(bundle.tracked.paths) !==
            canonicalJson([...new Set(bundle.tracked.paths)].sort())) {
            throw corruptWipBundle();
        }
        for (const entry of bundle.untracked) {
            if (!isRecord(entry) ||
                !hasExactKeys(entry, ['contentBase64', 'contentDigest', 'mode', 'path'])) {
                throw corruptWipBundle();
            }
            assertSafeRelativePath(entry.path);
            if (!['100644', '100755'].includes(entry.mode) ||
                rawDigest(decodeCanonicalBase64(entry.contentBase64)) !==
                    entry.contentDigest) {
                throw corruptWipBundle();
            }
        }
        exactIso(bundle.capturedAt, 'BOOTSTRAP_WIP_BUNDLE_CORRUPT');
        assertGitOid(bundle.baseOid, 'BOOTSTRAP_WIP_BUNDLE_CORRUPT');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'BOOTSTRAP_WIP_BUNDLE_CORRUPT') {
            throw error;
        }
        throw corruptWipBundle();
    }
    return bundle;
}
export function restorePersistedWipBundle(storageRoot, input, dependencies) {
    const verifier = requireHumanVerifier(dependencies);
    const now = bootstrapNow(dependencies);
    const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
    verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
        now,
        parent: intervention.parent,
        relationship: intervention.relationship,
        checkpoint: intervention.checkpoint,
        verifyHumanSignature: verifier,
    });
    const bundle = readPersistedWipBundle(storageRoot, intervention.checkpoint.checkpointId);
    const repositoryRoot = canonicalRepositoryRoot(input.repositoryRoot);
    const sessionPath = assertPersistenceOwnedPath(storageRoot, input.sessionSnapshotPath, 'BOOTSTRAP_SESSION_SNAPSHOT_OUTSIDE_STATE');
    if (repositoryRoot !== intervention.childWorkspace.parentWorkspacePath ||
        repositoryRoot !== bundle.repositoryRoot ||
        sessionPath !== bundle.session.snapshotPath) {
        throw workflowError('BOOTSTRAP_RESTORE_BINDING_MISMATCH', 'Restore target differs from the signed intervention checkpoint.', ExitCode.verification);
    }
    assertCheckpointMatchesBundle(intervention, bundle);
    if (gitText(repositoryRoot, ['rev-parse', 'HEAD']).trim() !== bundle.baseOid) {
        throw workflowError('BOOTSTRAP_RESTORE_BASE_MISMATCH', 'Parent HEAD changed since checkpoint capture.', ExitCode.staleState);
    }
    const receiptPath = bootstrapReceiptPath(storageRoot, `restore-${bundle.checkpointId}`);
    if (fs.existsSync(receiptPath)) {
        const receipt = readBootstrapReceipt(receiptPath);
        assertRestoreReceipt(receipt, input.parentChangeId, repositoryRoot, bundle);
        verifyRestoredBundle(repositoryRoot, sessionPath, bundle);
        return receipt;
    }
    const alreadyRestored = restoredBundleMatches(repositoryRoot, sessionPath, bundle);
    if (!alreadyRestored &&
        gitBuffer(repositoryRoot, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
        ]).length !== 0) {
        throw workflowError('BOOTSTRAP_RESTORE_WORKTREE_NOT_CLEAN', 'WIP restore requires the exact clean checkpoint base.', ExitCode.conflict);
    }
    if (!alreadyRestored) {
        const priorSession = readOptionalPlainFile(sessionPath, MAX_SESSION_BYTES);
        let restoreFailure;
        try {
            applyGitPatch(repositoryRoot, decodeCanonicalBase64(bundle.tracked.workingTreePatchBase64), false);
            applyGitPatch(repositoryRoot, decodeCanonicalBase64(bundle.tracked.stagedPatchBase64), true);
            restoreUntrackedFiles(repositoryRoot, bundle.untracked);
            writePrivateFileAtomic(sessionPath, decodeCanonicalBase64(bundle.session.contentBase64));
            verifyRestoredBundle(repositoryRoot, sessionPath, bundle);
        }
        catch (error) {
            restoreFailure = error;
        }
        if (restoreFailure !== undefined) {
            rollbackFailedRestore(repositoryRoot, bundle, sessionPath, priorSession);
            throw restoreFailure;
        }
    }
    const receiptPayload = {
        kind: 'harness-wip-restore-receipt.v1',
        checkpointId: bundle.checkpointId,
        bundleDigest: bundle.bundleDigest,
        parentChangeId: input.parentChangeId,
        repositoryRoot,
        restoredAt: now.toISOString(),
        effectsPerformed: !alreadyRestored,
    };
    const receipt = {
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    };
    persistBootstrapReceipt(storageRoot, `restore-${bundle.checkpointId}`, receipt);
    return receipt;
}
export function materializeInterventionChildWorktree(storageRoot, input, dependencies) {
    const verifier = requireHumanVerifier(dependencies);
    const now = bootstrapNow(dependencies);
    const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
    verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
        now,
        parent: intervention.parent,
        relationship: intervention.relationship,
        checkpoint: intervention.checkpoint,
        verifyHumanSignature: verifier,
    });
    const repositoryRoot = canonicalRepositoryRoot(input.repositoryRoot);
    const metadata = intervention.childWorkspace;
    if (repositoryRoot !== metadata.parentWorkspacePath) {
        throw workflowError('BOOTSTRAP_CHILD_WORKTREE_PARENT_MISMATCH', 'Child worktree request is not bound to the persisted parent workspace.', ExitCode.verification);
    }
    readPersistedWipBundle(storageRoot, metadata.checkpointId);
    const receiptPath = bootstrapReceiptPath(storageRoot, `worktree-${metadata.workspaceId}`);
    if (fs.existsSync(receiptPath)) {
        const receipt = readBootstrapReceipt(receiptPath);
        assertMaterializationReceipt(receipt, repositoryRoot, metadata);
        verifyMaterializedWorktree(repositoryRoot, metadata);
        recordBootstrapSidecarWorkspaceMaterialized(storageRoot, {
            parentChangeId: input.parentChangeId,
            workspaceId: receipt.workspaceId,
            receiptDigest: receipt.receiptDigest,
            materializedAt: receipt.materializedAt,
        });
        return receipt;
    }
    if (fs.lstatSync(metadata.childWorkspacePath, { throwIfNoEntry: false })) {
        throw workflowError('BOOTSTRAP_CHILD_WORKTREE_PATH_OCCUPIED', 'Child worktree path became occupied after reservation.', ExitCode.conflict);
    }
    if (gitRefExists(repositoryRoot, metadata.changeRef)) {
        throw workflowError('BOOTSTRAP_CHILD_WORKTREE_REF_EXISTS', 'Reserved child change ref already exists.', ExitCode.conflict);
    }
    const branch = metadata.changeRef.slice('refs/heads/'.length);
    let failure;
    try {
        gitBuffer(repositoryRoot, [
            'worktree',
            'add',
            '-b',
            branch,
            metadata.childWorkspacePath,
            metadata.baseOid,
        ]);
        verifyMaterializedWorktree(repositoryRoot, metadata);
    }
    catch (error) {
        failure = error;
    }
    if (failure !== undefined) {
        gitBufferNoThrow(repositoryRoot, [
            'worktree',
            'remove',
            '--force',
            metadata.childWorkspacePath,
        ]);
        removeExactChildWorkspace(metadata.childWorkspacePath, repositoryRoot);
        throw failure;
    }
    const receiptPayload = {
        kind: 'intervention-child-worktree-materialized.v1',
        workspaceId: metadata.workspaceId,
        checkpointId: metadata.checkpointId,
        parentChangeId: metadata.parentChangeId,
        interventionChangeId: metadata.interventionChangeId,
        repositoryRoot,
        childWorkspacePath: metadata.childWorkspacePath,
        changeRef: metadata.changeRef,
        headOid: metadata.baseOid,
        materializedAt: now.toISOString(),
        effectsPerformed: true,
    };
    const receipt = {
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    };
    persistBootstrapReceipt(storageRoot, `worktree-${metadata.workspaceId}`, receipt);
    dependencies.testHooks?.afterWorktreeReceiptPersistedBeforeSidecar?.();
    recordBootstrapSidecarWorkspaceMaterialized(storageRoot, {
        parentChangeId: input.parentChangeId,
        workspaceId: receipt.workspaceId,
        receiptDigest: receipt.receiptDigest,
        materializedAt: receipt.materializedAt,
    });
    return receipt;
}
export function initializeLocalEngineBinding(storageRoot, bindingPath, input) {
    assertNonEmpty(input.parentChangeId, 'BOOTSTRAP_BINDING_INVALID');
    assertNonEmpty(input.interventionChangeId, 'BOOTSTRAP_BINDING_INVALID');
    assertNonEmpty(input.txId, 'BOOTSTRAP_BINDING_INVALID');
    assertNonEmpty(input.sessionSchema, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.checkpointId, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.engineDigest, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.artifactId, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.executableDigest, 'BOOTSTRAP_BINDING_INVALID');
    const parentWorkspacePath = canonicalRepositoryRoot(input.parentWorkspacePath);
    const expectedParentBranch = `refs/heads/work/${input.parentChangeId}`;
    if (input.parentBranch !== expectedParentBranch ||
        gitText(parentWorkspacePath, ['symbolic-ref', 'HEAD']).trim() !==
            expectedParentBranch ||
        input.executablePath !==
            localEngineArtifactPath(storageRoot, input.artifactId)) {
        throw workflowError('BOOTSTRAP_BINDING_PARENT_SCOPE_INVALID', 'Local binding requires the exact parent worktree branch and artifact path.', ExitCode.verification);
    }
    const now = exactDate(input.now, 'BOOTSTRAP_CLOCK_INVALID');
    const payload = {
        kind: 'local-parent-session-metadata.v2',
        parentChangeId: input.parentChangeId,
        parentWorkspacePath,
        parentBranch: input.parentBranch,
        interventionChangeId: input.interventionChangeId,
        txId: input.txId,
        checkpointId: input.checkpointId,
        engineDigest: input.engineDigest,
        activeArtifact: {
            artifactId: input.artifactId,
            executableDigest: input.executableDigest,
            executablePath: input.executablePath,
        },
        sessionSchema: input.sessionSchema,
        blocker: {
            kind: 'harness-intervention',
            checkpointId: input.checkpointId,
            blockedBy: input.interventionChangeId,
        },
        interventionState: 'active',
        generation: 1,
        updatedAt: now.toISOString(),
    };
    const binding = {
        ...payload,
        recordDigest: canonicalDigest(payload),
    };
    createPrivateFileExclusive(assertPersistenceOwnedPath(storageRoot, bindingPath, 'BOOTSTRAP_BINDING_OUTSIDE_STATE'), Buffer.from(`${canonicalJson(binding)}\n`));
    return binding;
}
export function readLocalEngineBinding(bindingPath) {
    const value = readCanonicalPrivateJson(canonicalAbsolutePath(bindingPath), 'BOOTSTRAP_BINDING_NOT_FOUND', 64 * 1024);
    if (!isRecord(value) ||
        value.kind !== 'local-parent-session-metadata.v2' ||
        !hasExactKeys(value, [
            'activeArtifact',
            'blocker',
            'checkpointId',
            'engineDigest',
            'generation',
            'interventionChangeId',
            'interventionState',
            'kind',
            'parentBranch',
            'parentChangeId',
            'parentWorkspacePath',
            'recordDigest',
            'sessionSchema',
            'txId',
            'updatedAt',
        ])) {
        throw corruptBinding();
    }
    const binding = value;
    const { recordDigest, ...payload } = binding;
    if (!isDigest(recordDigest) ||
        canonicalDigest(payload) !== recordDigest ||
        !Number.isSafeInteger(binding.generation) ||
        binding.generation < 1 ||
        !isDigest(binding.engineDigest) ||
        !isDigest(binding.checkpointId) ||
        !isRecord(binding.activeArtifact) ||
        !hasExactKeys(binding.activeArtifact, [
            'artifactId',
            'executableDigest',
            'executablePath',
        ]) ||
        !isDigest(binding.activeArtifact.artifactId) ||
        !isDigest(binding.activeArtifact.executableDigest) ||
        binding.activeArtifact.executablePath !==
            localEngineArtifactPath(bindingStateRoot(bindingPath), binding.activeArtifact.artifactId) ||
        typeof binding.txId !== 'string' ||
        binding.txId.length === 0 ||
        binding.txId.trim() !== binding.txId ||
        typeof binding.parentChangeId !== 'string' ||
        binding.parentChangeId.length === 0 ||
        binding.parentChangeId.trim() !== binding.parentChangeId ||
        binding.parentBranch !== `refs/heads/work/${binding.parentChangeId}` ||
        canonicalAbsolutePath(binding.parentWorkspacePath) !==
            binding.parentWorkspacePath ||
        !['active', 'adopted'].includes(binding.interventionState) ||
        (binding.interventionState === 'active'
            ? !isHarnessInterventionBlocker(binding.blocker, binding.checkpointId, binding.interventionChangeId)
            : binding.blocker !== null)) {
        throw corruptBinding();
    }
    exactIso(binding.updatedAt, 'BOOTSTRAP_BINDING_CORRUPT');
    return binding;
}
export function assertPersistedInterventionAbandonable(storageRoot, bindingPath, input) {
    const existingIntent = readOptionalAbandonmentIntent(storageRoot, input.parentChangeId, input.grantId);
    if (existingIntent !== null)
        return;
    const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
    const localBinding = readOptionalLocalEngineBinding(bindingPath);
    assertAbandonableProjection(intervention, localBinding, storageRoot);
}
export function abandonPersistedIntervention(storageRoot, bindingPath, input) {
    return withInterventionParentOperation(storageRoot, input.parentChangeId, () => abandonPersistedInterventionUnderParentLock(storageRoot, bindingPath, input));
}
function abandonPersistedInterventionUnderParentLock(storageRoot, bindingPath, input) {
    assertDigest(input.grantRecordDigest, 'INTERVENTION_ABANDONMENT_INVALID');
    assertNonEmpty(input.reason, 'INTERVENTION_ABANDONMENT_INVALID');
    exactIso(input.at, 'INTERVENTION_ABANDONMENT_INVALID');
    const safeBindingPath = assertPersistenceOwnedPath(storageRoot, bindingPath, 'BOOTSTRAP_BINDING_OUTSIDE_STATE');
    const paths = abandonmentPaths(storageRoot, input.parentChangeId, input.grantId);
    const existingIntent = readOptionalAbandonmentIntent(storageRoot, input.parentChangeId, input.grantId);
    let intent;
    let effectsPerformed = false;
    if (existingIntent === null) {
        const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
        const localBinding = readOptionalLocalEngineBinding(safeBindingPath);
        assertAbandonableProjection(intervention, localBinding, storageRoot);
        const payload = {
            kind: 'intervention-abandonment-intent.v1',
            parentChangeId: input.parentChangeId,
            grantId: input.grantId,
            grantRecordDigest: input.grantRecordDigest,
            reason: input.reason,
            abandonedAt: input.at,
            intervention: structuredClone(intervention),
            localBinding: localBinding === null ? null : structuredClone(localBinding),
        };
        intent = {
            ...payload,
            intentDigest: canonicalDigest(payload),
        };
        createPrivateFileExclusive(paths.intent, Buffer.from(`${canonicalJson(intent)}\n`));
        effectsPerformed = true;
        input.testAfterIntentPersisted?.();
    }
    else {
        intent = existingIntent;
        if (intent.grantRecordDigest !== input.grantRecordDigest ||
            intent.reason !== input.reason ||
            intent.abandonedAt !== input.at) {
            throw workflowError('INTERVENTION_ABANDONMENT_CONFLICT', 'Intervention abandonment already has a different human authorization.', ExitCode.conflict);
        }
    }
    if (fs.existsSync(paths.receipt)) {
        const receipt = readAbandonmentReceipt(paths.receipt, intent);
        return { intent, receipt, effectsPerformed: false };
    }
    if (intent.localBinding !== null) {
        const observedBinding = readOptionalLocalEngineBinding(safeBindingPath);
        if (observedBinding !== null) {
            if (observedBinding.recordDigest !== intent.localBinding.recordDigest) {
                throw workflowError('INTERVENTION_ABANDONMENT_BINDING_DRIFT', 'Parent engine binding changed after abandonment was authorized.', ExitCode.staleState);
            }
            fs.unlinkSync(safeBindingPath);
            fsyncDirectory(path.dirname(safeBindingPath));
            effectsPerformed = true;
        }
    }
    else if (readOptionalLocalEngineBinding(safeBindingPath) !== null) {
        throw workflowError('INTERVENTION_ABANDONMENT_BINDING_DRIFT', 'A parent engine binding appeared after abandonment was authorized.', ExitCode.staleState);
    }
    const activePath = interventionRecordPath(storageRoot, input.parentChangeId);
    if (fs.existsSync(activePath)) {
        const observed = readPersistedIntervention(storageRoot, input.parentChangeId);
        if (observed.recordDigest !== intent.intervention.recordDigest) {
            throw workflowError('INTERVENTION_ABANDONMENT_RECORD_DRIFT', 'Active intervention changed after abandonment was authorized.', ExitCode.staleState);
        }
        fs.unlinkSync(activePath);
        fsyncDirectory(path.dirname(activePath));
        effectsPerformed = true;
    }
    recordBootstrapSidecarAbandoned(storageRoot, {
        parentChangeId: input.parentChangeId,
        intervention: intent.intervention,
        evidenceDigest: intent.intentDigest,
        abandonedAt: intent.abandonedAt,
    });
    const receiptPayload = {
        kind: 'intervention-abandonment-receipt.v1',
        parentChangeId: input.parentChangeId,
        grantId: input.grantId,
        intentDigest: intent.intentDigest,
        completedAt: input.at,
        blockerCleared: true,
        bindingCleared: intent.localBinding !== null,
    };
    const receipt = {
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    };
    createPrivateFileExclusive(paths.receipt, Buffer.from(`${canonicalJson(receipt)}\n`));
    return { intent, receipt, effectsPerformed };
}
export function executePersistedAdoptionStep(storageRoot, input, dependencies) {
    const verifier = requireHumanVerifier(dependencies);
    const now = bootstrapNow(dependencies);
    exactIso(input.at, 'BOOTSTRAP_ADOPTION_TIMESTAMP_INVALID');
    const recovered = recoverPersistedEngineAdoption(storageRoot, input.txId);
    const current = recovered.record;
    if (current.artifactRecordDigest !== undefined) {
        const storedArtifact = readStoredInterventionEngineArtifact(storageRoot, current.journal.artifactId);
        if (storedArtifact.kind !== 'persisted-intervention-engine-artifact.v2' ||
            storedArtifact.recordDigest !== current.artifactRecordDigest ||
            (input.artifactRecordDigest !== undefined &&
                input.artifactRecordDigest !== storedArtifact.recordDigest) ||
            canonicalJson(storedArtifact.artifact) !==
                canonicalJson(input.artifact) ||
            storedArtifact.executablePath !== input.executablePath) {
            throw workflowError('BOOTSTRAP_ENGINE_ARTIFACT_RECORD_MISMATCH', 'Bootstrap execution requires the exact persisted artifact record bound by the adoption.', ExitCode.verification);
        }
    }
    if (current.journal.journalDigest !== input.expectedJournalDigest) {
        throw workflowError('BOOTSTRAP_ADOPTION_CAS_MISMATCH', 'Adoption journal changed before bootstrap execution.', ExitCode.staleState);
    }
    const intervention = readPersistedIntervention(storageRoot, current.journal.parentChangeId);
    if ([
        'start-new-engine',
        'run-health-check',
        'finalize-commit',
        'rollback-engine-binding',
        'none',
    ].includes(recovered.decision.action)) {
        verifyPersistedMaintenanceGrantForRecovery(current.maintenanceGrantEnvelope, intervention, current.journal, verifier);
    }
    else {
        verifyHarnessMaintenanceGrant(current.maintenanceGrantEnvelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: verifier,
        });
    }
    assertEngineArtifactIntegrity(input.artifact);
    if (input.artifact.artifactId !== current.journal.artifactId ||
        input.artifact.executableDigest !== current.journal.toEngineDigest ||
        input.artifact.writesSessionSchema !== current.journal.sessionSchema ||
        input.artifact.sourceChangeId !== current.journal.interventionChangeId ||
        (input.artifact.workflowBindingDigest !== undefined &&
            input.artifact.workflowBindingDigest !==
                current.journal.workflowBindingDigest)) {
        throw workflowError('BOOTSTRAP_ENGINE_ARTIFACT_MISMATCH', 'Engine artifact differs from the persisted adoption journal.', ExitCode.verification);
    }
    const bindingPath = assertPersistenceOwnedPath(storageRoot, input.bindingPath, 'BOOTSTRAP_BINDING_OUTSIDE_STATE');
    const binding = readLocalEngineBinding(bindingPath);
    if (binding.parentChangeId !== current.journal.parentChangeId ||
        binding.parentWorkspacePath !==
            intervention.childWorkspace.parentWorkspacePath ||
        binding.parentBranch !==
            `refs/heads/work/${current.journal.parentChangeId}` ||
        binding.interventionChangeId !== current.journal.interventionChangeId ||
        binding.txId !== current.journal.txId ||
        binding.checkpointId !== current.journal.checkpointId ||
        binding.sessionSchema !== current.journal.sessionSchema ||
        binding.activeArtifact.artifactId !== current.journal.artifactId ||
        binding.activeArtifact.executableDigest !==
            current.journal.toEngineDigest ||
        binding.activeArtifact.executablePath !==
            localEngineArtifactPath(storageRoot, current.journal.artifactId) ||
        (binding.interventionState === 'adopted' &&
            !['HEALTHY', 'COMMITTED'].includes(current.journal.state)) ||
        (current.journal.state === 'COMMITTED' &&
            binding.interventionState !== 'adopted')) {
        throw workflowError('BOOTSTRAP_BINDING_MISMATCH', 'Local engine binding does not belong to this adoption transaction.', ExitCode.verification);
    }
    const materializedExecutable = materializeLocalEngineExecutable(storageRoot, intervention, input.artifact, input.executablePath);
    const beforeJournalDigest = current.journal.journalDigest;
    let next;
    let evidence;
    let effectsPerformed = false;
    switch (recovered.decision.action) {
        case 'checkpoint-parent': {
            const bundle = readPersistedWipBundle(storageRoot, current.journal.checkpointId);
            assertCheckpointMatchesBundle(intervention, bundle);
            const restore = restorePersistedWipBundle(storageRoot, {
                parentChangeId: current.journal.parentChangeId,
                repositoryRoot: intervention.childWorkspace.parentWorkspacePath,
                sessionSnapshotPath: bundle.session.snapshotPath,
                maintenanceGrantEnvelope: current.maintenanceGrantEnvelope,
            }, dependencies);
            evidence = {
                action: 'checkpoint-parent',
                bundleDigest: bundle.bundleDigest,
                restoreReceiptDigest: restore.receiptDigest,
            };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'parent-checkpointed', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'update-engine-binding': {
            const updated = ensureBindingEngine(bindingPath, binding, current.journal.fromEngineDigest, current.journal.toEngineDigest, input.at);
            effectsPerformed = updated.recordDigest !== binding.recordDigest;
            dependencies.testHooks?.afterBindingUpdatedBeforeJournal?.();
            evidence = {
                action: 'update-engine-binding',
                beforeBindingDigest: binding.recordDigest,
                afterBindingDigest: updated.recordDigest,
            };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'engine-binding-updated', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'start-new-engine': {
            assertBindingEngine(binding, current.journal.toEngineDigest);
            const probe = runEngineExecutable(materializedExecutable, input.artifact.executableDigest, '--bootstrap-probe');
            if (probe.kind !== 'engine-bootstrap-probe.v1' ||
                probe.started !== true ||
                probe.sessionSchema !== current.journal.sessionSchema) {
                throw workflowError('BOOTSTRAP_ENGINE_START_FAILED', 'New engine bootstrap probe did not report a compatible start.', ExitCode.verification);
            }
            effectsPerformed = true;
            evidence = { action: 'start-new-engine', probe };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'new-engine-started', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'run-health-check': {
            assertBindingEngine(binding, current.journal.toEngineDigest);
            const health = runEngineExecutable(materializedExecutable, input.artifact.executableDigest, '--health-check');
            if (health.kind !== 'engine-health.v1' ||
                typeof health.healthy !== 'boolean' ||
                health.sessionSchema !== current.journal.sessionSchema) {
                throw workflowError('BOOTSTRAP_ENGINE_HEALTH_INVALID', 'Engine health check returned an invalid contract.', ExitCode.verification);
            }
            effectsPerformed = true;
            evidence = { action: 'run-health-check', health };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: {
                    kind: health.healthy ? 'health-check-passed' : 'health-check-failed',
                    at: input.at,
                },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'finalize-commit': {
            assertBindingEngine(binding, current.journal.toEngineDigest);
            const finalized = ensureBindingAdoptionFinalized(bindingPath, binding, current.journal.checkpointId, current.journal.interventionChangeId, input.at);
            effectsPerformed = finalized.recordDigest !== binding.recordDigest;
            evidence = {
                action: 'finalize-commit',
                beforeBindingDigest: binding.recordDigest,
                afterBindingDigest: finalized.recordDigest,
                blockerCleared: finalized.blocker === null,
            };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'commit', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'rollback-engine-binding': {
            const rolledBack = ensureBindingEngine(bindingPath, binding, current.journal.toEngineDigest, current.journal.fromEngineDigest, input.at);
            effectsPerformed = rolledBack.recordDigest !== binding.recordDigest;
            evidence = {
                action: 'rollback-engine-binding',
                beforeBindingDigest: binding.recordDigest,
                afterBindingDigest: rolledBack.recordDigest,
            };
            next = rollbackPersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                at: input.at,
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'none': {
            assertBindingEngine(binding, recovered.decision.authoritativeEngineDigest);
            evidence = { action: 'none', journalDigest: beforeJournalDigest };
            next = current;
            break;
        }
    }
    const evidenceDigest = canonicalDigest(evidence);
    const recordedAt = recovered.decision.action === 'none'
        ? (current.journal.history.at(-1)?.at ?? input.at)
        : input.at;
    const receiptPayload = {
        kind: 'bootstrap-adoption-step-receipt.v1',
        txId: input.txId,
        action: recovered.decision.action,
        beforeJournalDigest,
        afterJournalDigest: next.journal.journalDigest,
        evidenceDigest,
        recordedAt,
        effectsPerformed,
    };
    const receipt = {
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    };
    persistBootstrapReceipt(storageRoot, `adoption-${input.txId}-${beforeJournalDigest}-${recovered.decision.action}`, receipt);
    if (next.journal.state === 'COMMITTED' &&
        recovered.decision.action !== 'none') {
        dependencies.testHooks?.afterAdoptionReceiptPersistedBeforeSidecar?.();
    }
    if (next.journal.state === 'COMMITTED') {
        recordBootstrapSidecarAdopted(storageRoot, {
            parentChangeId: next.journal.parentChangeId,
            txId: next.journal.txId,
            artifact: input.artifact,
            journalDigest: next.journal.journalDigest,
            adoptedAt: next.journal.history.at(-1).at,
        });
    }
    return { record: next, receipt };
}
export function rebindLocalEngineAfterRolledBackAdoption(storageRoot, bindingPath, input) {
    const current = readLocalEngineBinding(bindingPath);
    if (current.parentChangeId !== input.parentChangeId ||
        current.interventionChangeId !== input.interventionChangeId ||
        current.checkpointId !== input.checkpointId ||
        current.engineDigest !== input.engineDigest ||
        current.sessionSchema !== input.sessionSchema ||
        current.interventionState !== 'active' ||
        !isHarnessInterventionBlocker(current.blocker, input.checkpointId, input.interventionChangeId)) {
        throw workflowError('BOOTSTRAP_PARENT_SESSION_RETRY_MISMATCH', 'A rolled-back parent session cannot be rebound to this repair attempt.', ExitCode.staleState);
    }
    const now = exactDate(input.now, 'BOOTSTRAP_CLOCK_INVALID');
    const executablePath = localEngineArtifactPath(storageRoot, input.artifactId);
    const { recordDigest: _recordDigest, ...payload } = current;
    const nextPayload = {
        ...payload,
        txId: input.txId,
        activeArtifact: {
            artifactId: input.artifactId,
            executableDigest: input.executableDigest,
            executablePath,
        },
        generation: current.generation + 1,
        updatedAt: now.toISOString(),
    };
    const next = {
        ...nextPayload,
        recordDigest: canonicalDigest(nextPayload),
    };
    replacePrivateFileAtomic(assertPersistenceOwnedPath(storageRoot, bindingPath, 'BOOTSTRAP_BINDING_OUTSIDE_STATE'), Buffer.from(`${canonicalJson(next)}\n`), current.recordDigest);
    return next;
}
function assertCheckpointMatchesBundle(intervention, bundle) {
    const checkpoint = intervention.checkpoint;
    if (bundle.checkpointId !== checkpoint.checkpointId ||
        bundle.parentChangeId !== checkpoint.parentChangeId ||
        bundle.baseOid !== checkpoint.baseOid ||
        canonicalDigest(bundle.tracked) !== checkpoint.trackedTreeDigest ||
        canonicalDigest(bundle.untracked) !== checkpoint.untrackedBundleDigest ||
        bundle.session.contentDigest !== checkpoint.sessionStateDigest ||
        rawDigest(Buffer.from(bundle.pendingIntent)) !==
            checkpoint.pendingIntentDigest) {
        throw workflowError('BOOTSTRAP_WIP_BUNDLE_CHECKPOINT_MISMATCH', 'WIP bundle bytes do not match the persisted checkpoint.', ExitCode.verification);
    }
}
function verifyRestoredBundle(repositoryRoot, sessionPath, bundle) {
    const working = gitBuffer(repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        'HEAD',
        '--',
    ]);
    const staged = gitBuffer(repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        '--cached',
        'HEAD',
        '--',
    ]);
    const status = gitBuffer(repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
    ]);
    if (rawDigest(working) !== bundle.tracked.workingTreePatchDigest ||
        rawDigest(staged) !== bundle.tracked.stagedPatchDigest ||
        status.toString('base64') !== bundle.statusPorcelainBase64 ||
        rawDigest(fs.readFileSync(sessionPath)) !== bundle.session.contentDigest) {
        throw workflowError('BOOTSTRAP_RESTORE_VERIFICATION_FAILED', 'Restored WIP does not reproduce the captured bytes.', ExitCode.verification);
    }
    for (const entry of bundle.untracked) {
        const target = safeRepositoryPath(repositoryRoot, entry.path);
        if (rawDigest(fs.readFileSync(target)) !== entry.contentDigest) {
            throw workflowError('BOOTSTRAP_RESTORE_VERIFICATION_FAILED', 'Restored untracked file digest mismatch.', ExitCode.verification);
        }
    }
}
function restoredBundleMatches(repositoryRoot, sessionPath, bundle) {
    try {
        verifyRestoredBundle(repositoryRoot, sessionPath, bundle);
        return true;
    }
    catch {
        return false;
    }
}
function assertRestoreReceipt(receipt, parentChangeId, repositoryRoot, bundle) {
    if (receipt.kind !== 'harness-wip-restore-receipt.v1' ||
        receipt.checkpointId !== bundle.checkpointId ||
        receipt.bundleDigest !== bundle.bundleDigest ||
        receipt.parentChangeId !== parentChangeId ||
        receipt.repositoryRoot !== repositoryRoot ||
        typeof receipt.effectsPerformed !== 'boolean') {
        throw workflowError('BOOTSTRAP_RECEIPT_CORRUPT', 'WIP restore receipt does not match the persisted checkpoint.', ExitCode.verification);
    }
    exactIso(receipt.restoredAt, 'BOOTSTRAP_RECEIPT_CORRUPT');
}
function rollbackFailedRestore(repositoryRoot, bundle, sessionPath, priorSession) {
    gitBufferNoThrow(repositoryRoot, ['reset', '--hard', bundle.baseOid]);
    for (const trackedPath of bundle.tracked.paths) {
        if (!pathExistsAtBase(repositoryRoot, bundle.baseOid, trackedPath)) {
            removeRestoredUntracked(repositoryRoot, trackedPath);
        }
    }
    for (const entry of bundle.untracked) {
        removeRestoredUntracked(repositoryRoot, entry.path);
    }
    if (priorSession === null) {
        try {
            fs.unlinkSync(sessionPath);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    else {
        writePrivateFileAtomic(sessionPath, priorSession);
    }
}
function pathExistsAtBase(repositoryRoot, baseOid, relativePath) {
    assertSafeRelativePath(relativePath);
    return (gitBuffer(repositoryRoot, [
        'ls-tree',
        '--name-only',
        '-z',
        baseOid,
        '--',
        relativePath,
    ]).length > 0);
}
function applyGitPatch(repositoryRoot, patchBytes, cached) {
    if (patchBytes.length === 0) {
        return;
    }
    gitBuffer(repositoryRoot, [
        'apply',
        '--binary',
        '--whitespace=nowarn',
        ...(cached ? ['--cached'] : []),
        '-',
    ], patchBytes);
}
function restoreUntrackedFiles(repositoryRoot, entries) {
    for (const entry of entries) {
        const target = safeRepositoryPath(repositoryRoot, entry.path);
        ensureSafeParentDirectories(repositoryRoot, path.dirname(target));
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
            throw workflowError('BOOTSTRAP_RESTORE_UNTRACKED_COLLISION', `Restore target already exists: ${entry.path}`, ExitCode.conflict);
        }
        fs.writeFileSync(target, decodeCanonicalBase64(entry.contentBase64), {
            mode: entry.mode === '100755' ? 0o755 : 0o644,
            flag: 'wx',
        });
    }
}
function captureUntrackedFiles(repositoryRoot, allowlist) {
    let total = 0;
    return allowlist.map((relativePath) => {
        const target = safeRepositoryPath(repositoryRoot, relativePath);
        const stats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stats?.isFile() || stats.isSymbolicLink()) {
            throw workflowError('BOOTSTRAP_UNTRACKED_FILE_UNSAFE', `Allowlisted untracked path is not a regular file: ${relativePath}`, ExitCode.guard);
        }
        if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
            throw workflowError('BOOTSTRAP_UNTRACKED_FILE_TOO_LARGE', `Allowlisted untracked file is too large: ${relativePath}`, ExitCode.guard);
        }
        const content = fs.readFileSync(target);
        total += content.length;
        if (total > MAX_UNTRACKED_TOTAL_BYTES) {
            throw workflowError('BOOTSTRAP_UNTRACKED_TOTAL_TOO_LARGE', 'Allowlisted untracked bytes exceed the total limit.', ExitCode.guard);
        }
        return {
            path: relativePath,
            mode: (stats.mode & 0o111) !== 0 ? '100755' : '100644',
            contentBase64: content.toString('base64'),
            contentDigest: rawDigest(content),
        };
    });
}
function validateUntrackedAllowlist(values) {
    if (!Array.isArray(values)) {
        throw workflowError('BOOTSTRAP_UNTRACKED_ALLOWLIST_INVALID', 'Untracked allowlist must be an array.', ExitCode.usage);
    }
    for (const value of values) {
        assertSafeRelativePath(value);
    }
    const normalized = [...new Set(values)].sort();
    if (canonicalJson(values) !== canonicalJson(normalized)) {
        throw workflowError('BOOTSTRAP_UNTRACKED_ALLOWLIST_INVALID', 'Untracked allowlist must be sorted and unique.', ExitCode.usage);
    }
    return normalized;
}
function listUntracked(repositoryRoot) {
    return parseNulPaths(gitBuffer(repositoryRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
    ]));
}
function parseNulPaths(output) {
    if (output.length === 0) {
        return [];
    }
    if (output.at(-1) !== 0) {
        throw workflowError('BOOTSTRAP_GIT_PATH_OUTPUT_INVALID', 'Git path output is not NUL terminated.', ExitCode.verification);
    }
    const bytes = output.subarray(0, output.length - 1);
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
        throw workflowError('BOOTSTRAP_GIT_PATH_OUTPUT_INVALID', 'Git path output is not valid UTF-8.', ExitCode.verification);
    }
    const values = decoded.split('\0');
    for (const value of values) {
        assertSafeRelativePath(value);
    }
    return [...new Set(values)].sort();
}
function persistWipBundle(storageRoot, bundle) {
    const directory = bootstrapBundleDirectory(storageRoot);
    ensurePrivateDirectory(directory);
    const content = Buffer.from(`${canonicalJson(bundle)}\n`);
    if (content.length > MAX_BUNDLE_BYTES) {
        throw workflowError('BOOTSTRAP_WIP_BUNDLE_TOO_LARGE', 'WIP bundle exceeds the persistence size limit.', ExitCode.guard);
    }
    const target = wipBundlePath(storageRoot, bundle.checkpointId);
    if (fs.existsSync(target)) {
        if (!readPrivateBytes(target, 'BOOTSTRAP_WIP_BUNDLE_NOT_FOUND', MAX_BUNDLE_BYTES).equals(content)) {
            throw workflowError('BOOTSTRAP_WIP_BUNDLE_COLLISION', 'Checkpoint bundle path contains different bytes.', ExitCode.verification);
        }
        return;
    }
    createPrivateFileExclusive(target, content);
}
function verifyMaterializedWorktree(repositoryRoot, metadata) {
    const childRoot = canonicalRepositoryRoot(metadata.childWorkspacePath);
    if (childRoot !== metadata.childWorkspacePath) {
        throw workflowError('BOOTSTRAP_CHILD_WORKTREE_VERIFICATION_FAILED', 'Materialized child root differs from the reservation.', ExitCode.verification);
    }
    const commonParent = fs.realpathSync(gitText(repositoryRoot, ['rev-parse', '--git-common-dir'])
        .trim()
        .startsWith('/')
        ? gitText(repositoryRoot, ['rev-parse', '--git-common-dir']).trim()
        : path.join(repositoryRoot, gitText(repositoryRoot, ['rev-parse', '--git-common-dir']).trim()));
    const childCommonRaw = gitText(childRoot, [
        'rev-parse',
        '--git-common-dir',
    ]).trim();
    const childCommon = fs.realpathSync(path.isAbsolute(childCommonRaw)
        ? childCommonRaw
        : path.join(childRoot, childCommonRaw));
    if (childCommon !== commonParent ||
        gitText(childRoot, ['rev-parse', 'HEAD']).trim() !== metadata.baseOid ||
        gitText(childRoot, ['symbolic-ref', 'HEAD']).trim() !== metadata.changeRef) {
        throw workflowError('BOOTSTRAP_CHILD_WORKTREE_VERIFICATION_FAILED', 'Materialized child worktree failed repository/ref/base verification.', ExitCode.verification);
    }
}
function assertMaterializationReceipt(receipt, repositoryRoot, metadata) {
    if (receipt.kind !== 'intervention-child-worktree-materialized.v1' ||
        receipt.workspaceId !== metadata.workspaceId ||
        receipt.checkpointId !== metadata.checkpointId ||
        receipt.parentChangeId !== metadata.parentChangeId ||
        receipt.interventionChangeId !== metadata.interventionChangeId ||
        receipt.repositoryRoot !== repositoryRoot ||
        receipt.childWorkspacePath !== metadata.childWorkspacePath ||
        receipt.changeRef !== metadata.changeRef ||
        receipt.headOid !== metadata.baseOid ||
        receipt.effectsPerformed !== true) {
        throw workflowError('BOOTSTRAP_RECEIPT_CORRUPT', 'Child worktree receipt does not match its reservation.', ExitCode.verification);
    }
}
function assertEngineArtifactIntegrity(artifact) {
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
    if (!isRecord(artifact) ||
        !hasExactKeys(artifact, 'workflowBindingDigest' in artifact
            ? [...artifactKeys, 'workflowBindingDigest']
            : artifactKeys) ||
        artifact.kind !== 'engine-artifact.v1') {
        throw workflowError('BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT', 'Engine artifact failed structural verification.', ExitCode.verification);
    }
    const { artifactId, ...payload } = artifact;
    if (!isDigest(artifactId) || canonicalDigest(payload) !== artifactId) {
        throw workflowError('BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT', 'Engine artifact failed content-addressed verification.', ExitCode.verification);
    }
}
function materializeLocalEngineExecutable(storageRoot, intervention, artifact, requestedExecutablePath) {
    const target = localEngineArtifactPath(storageRoot, artifact.artifactId);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        assertPrivateLocalEngineExecutable(target, artifact.executableDigest);
        return target;
    }
    const executablePath = canonicalPlainFile(requestedExecutablePath, MAX_UNTRACKED_FILE_BYTES, 'BOOTSTRAP_ENGINE_EXECUTABLE_UNSAFE');
    const childRoot = intervention.childWorkspace.childWorkspacePath;
    if (!isPathInside(childRoot, executablePath)) {
        throw workflowError('BOOTSTRAP_ENGINE_EXECUTABLE_OUTSIDE_CHILD', 'Engine executable must come from the intervention child workspace.', ExitCode.guard);
    }
    const sourceStats = fs.lstatSync(executablePath);
    if (sourceStats.nlink !== 1) {
        throw workflowError('BOOTSTRAP_ENGINE_EXECUTABLE_UNSAFE', 'Engine executable source must have exactly one link.', ExitCode.unsafeEnvironment);
    }
    const sourceDescriptor = fs.openSync(executablePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let executableBytes;
    try {
        const opened = fs.fstatSync(sourceDescriptor);
        executableBytes = fs.readFileSync(sourceDescriptor);
        if (opened.dev !== sourceStats.dev ||
            opened.ino !== sourceStats.ino ||
            opened.size !== sourceStats.size) {
            throw workflowError('BOOTSTRAP_ENGINE_EXECUTABLE_UNSAFE', 'Engine executable source changed while being opened.', ExitCode.unsafeEnvironment);
        }
    }
    finally {
        fs.closeSync(sourceDescriptor);
    }
    if (rawDigest(executableBytes) !== artifact.executableDigest) {
        throw workflowError('BOOTSTRAP_ENGINE_EXECUTABLE_DIGEST_MISMATCH', 'Engine executable bytes differ from the adopted artifact.', ExitCode.verification);
    }
    createPrivateExecutableExclusive(target, executableBytes);
    assertPrivateLocalEngineExecutable(target, artifact.executableDigest);
    return target;
}
function runEngineExecutable(executablePath, expectedDigest, mode) {
    assertPrivateLocalEngineExecutable(executablePath, expectedDigest);
    const executableDirectory = path.dirname(executablePath);
    const result = spawnSync(executablePath, [mode], {
        cwd: executableDirectory,
        encoding: 'utf8',
        timeout: ENGINE_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            LANG: 'C',
            LC_ALL: 'C',
            TMPDIR: executableDirectory,
        },
    });
    if (result.error ||
        result.status !== 0 ||
        typeof result.stdout !== 'string') {
        throw workflowError('BOOTSTRAP_ENGINE_COMMAND_FAILED', `Engine ${mode} command failed.`, ExitCode.verification);
    }
    let value;
    try {
        value = JSON.parse(result.stdout);
    }
    catch {
        throw workflowError('BOOTSTRAP_ENGINE_COMMAND_OUTPUT_INVALID', `Engine ${mode} command did not emit JSON.`, ExitCode.verification);
    }
    if (!isRecord(value)) {
        throw workflowError('BOOTSTRAP_ENGINE_COMMAND_OUTPUT_INVALID', `Engine ${mode} command output must be an object.`, ExitCode.verification);
    }
    return value;
}
function ensureBindingEngine(bindingPath, current, expectedFrom, target, at) {
    if (current.engineDigest === target) {
        return current;
    }
    if (current.engineDigest !== expectedFrom) {
        throw workflowError('BOOTSTRAP_BINDING_ENGINE_MISMATCH', 'Local engine binding is neither the expected source nor target.', ExitCode.staleState);
    }
    const { recordDigest: _recordDigest, ...currentPayload } = current;
    const payload = {
        ...currentPayload,
        engineDigest: target,
        generation: current.generation + 1,
        updatedAt: at,
    };
    const next = {
        ...payload,
        recordDigest: canonicalDigest(payload),
    };
    replacePrivateFileAtomic(bindingPath, Buffer.from(`${canonicalJson(next)}\n`), current.recordDigest);
    return next;
}
function ensureBindingAdoptionFinalized(bindingPath, current, checkpointId, interventionChangeId, at) {
    if (current.interventionState === 'adopted' && current.blocker === null) {
        return current;
    }
    if (current.interventionState !== 'active' ||
        !isHarnessInterventionBlocker(current.blocker, checkpointId, interventionChangeId)) {
        throw workflowError('BOOTSTRAP_PARENT_SESSION_CAS_MISMATCH', 'Parent session blocker changed before adoption finalization.', ExitCode.staleState);
    }
    const { recordDigest: _recordDigest, ...currentPayload } = current;
    const payload = {
        ...currentPayload,
        blocker: null,
        interventionState: 'adopted',
        generation: current.generation + 1,
        updatedAt: at,
    };
    const next = {
        ...payload,
        recordDigest: canonicalDigest(payload),
    };
    replacePrivateFileAtomic(bindingPath, Buffer.from(`${canonicalJson(next)}\n`), current.recordDigest);
    return next;
}
function assertBindingEngine(binding, expected) {
    if (binding.engineDigest !== expected) {
        throw workflowError('BOOTSTRAP_BINDING_ENGINE_MISMATCH', 'Local engine binding does not select the journal engine.', ExitCode.staleState);
    }
}
function isHarnessInterventionBlocker(value, checkpointId, interventionChangeId) {
    return (isRecord(value) &&
        hasExactKeys(value, ['blockedBy', 'checkpointId', 'kind']) &&
        value.kind === 'harness-intervention' &&
        value.checkpointId === checkpointId &&
        value.blockedBy === interventionChangeId);
}
function assertAbandonableProjection(intervention, localBinding, storageRoot) {
    const inFlightTxIds = inFlightPersistedEngineAdoptionTxIds(storageRoot, intervention.parent.changeId);
    const promotionTxIds = activeBootstrapSidecarPromotionPinTxIds(storageRoot, intervention.parent.changeId);
    if (promotionTxIds.length > 0) {
        throw workflowError('INTERVENTION_ABANDONMENT_PROMOTION_NOT_TERMINAL', 'An in-flight repository promotion must be recovered before intervention abandonment.', ExitCode.guard, { details: { txIds: promotionTxIds } });
    }
    if (localBinding === null) {
        if (inFlightTxIds.length > 0) {
            throw workflowError('INTERVENTION_ABANDONMENT_ADOPTION_NOT_TERMINAL', 'An in-flight adoption must be recovered before intervention abandonment.', ExitCode.guard, { details: { txIds: inFlightTxIds } });
        }
        return;
    }
    if (localBinding.parentChangeId !== intervention.parent.changeId ||
        localBinding.interventionChangeId !==
            intervention.relationship.interventionChangeId ||
        localBinding.checkpointId !== intervention.checkpoint.checkpointId ||
        localBinding.engineDigest !== intervention.checkpoint.engineDigest ||
        localBinding.interventionState !== 'active' ||
        !isHarnessInterventionBlocker(localBinding.blocker, intervention.checkpoint.checkpointId, intervention.relationship.interventionChangeId)) {
        throw workflowError('INTERVENTION_ABANDONMENT_PARENT_NOT_ROLLED_BACK', 'Intervention can be abandoned only while the parent is durably bound to its checkpoint engine and blocker.', ExitCode.guard);
    }
    const adoption = recoverPersistedEngineAdoption(storageRoot, localBinding.txId).record;
    if (adoption.journal.state !== 'ENGINE_BINDING_ROLLED_BACK' ||
        adoption.journal.parentChangeId !== intervention.parent.changeId ||
        adoption.journal.interventionChangeId !==
            intervention.relationship.interventionChangeId ||
        adoption.journal.checkpointId !== intervention.checkpoint.checkpointId) {
        throw workflowError('INTERVENTION_ABANDONMENT_ADOPTION_NOT_TERMINAL', 'An in-flight or committed adoption must be recovered before intervention abandonment.', ExitCode.guard);
    }
}
function readOptionalLocalEngineBinding(bindingPath) {
    if (!fs.existsSync(bindingPath))
        return null;
    return readLocalEngineBinding(bindingPath);
}
function abandonmentPaths(storageRoot, parentChangeId, grantId) {
    assertNonEmpty(parentChangeId, 'INTERVENTION_ABANDONMENT_INVALID');
    assertNonEmpty(grantId, 'INTERVENTION_ABANDONMENT_INVALID');
    const identity = crypto
        .createHash('sha256')
        .update(`intervention-abandonment\0${parentChangeId}\0${grantId}`)
        .digest('hex');
    const directory = path.join(interventionControlPersistencePaths(storageRoot).root, 'intervention-abandonments');
    return {
        intent: path.join(directory, `${identity}.intent.json`),
        receipt: path.join(directory, `${identity}.receipt.json`),
    };
}
function readOptionalAbandonmentIntent(storageRoot, parentChangeId, grantId) {
    const target = abandonmentPaths(storageRoot, parentChangeId, grantId).intent;
    if (!fs.existsSync(target))
        return null;
    const value = readCanonicalPrivateJson(target, 'INTERVENTION_ABANDONMENT_NOT_FOUND', MAX_BUNDLE_BYTES);
    if (!isRecord(value) ||
        value.kind !== 'intervention-abandonment-intent.v1' ||
        value.parentChangeId !== parentChangeId ||
        value.grantId !== grantId ||
        !hasExactKeys(value, [
            'abandonedAt',
            'grantId',
            'grantRecordDigest',
            'intentDigest',
            'intervention',
            'kind',
            'localBinding',
            'parentChangeId',
            'reason',
        ]) ||
        !isDigest(value.intentDigest) ||
        !isRecord(value.intervention)) {
        throw corruptAbandonment();
    }
    const { intentDigest, ...payload } = value;
    if (canonicalDigest(payload) !== intentDigest ||
        !isDigest(value.grantRecordDigest) ||
        typeof value.reason !== 'string' ||
        value.reason.trim() !== value.reason ||
        value.reason.length === 0 ||
        !verifyEmbeddedRecordDigest(value.intervention) ||
        (value.localBinding !== null &&
            (!isRecord(value.localBinding) ||
                !verifyEmbeddedRecordDigest(value.localBinding)))) {
        throw corruptAbandonment();
    }
    exactIso(String(value.abandonedAt), 'INTERVENTION_ABANDONMENT_CORRUPT');
    return value;
}
function readAbandonmentReceipt(receiptPath, intent) {
    const value = readCanonicalPrivateJson(receiptPath, 'INTERVENTION_ABANDONMENT_RECEIPT_NOT_FOUND', 1024 * 1024);
    if (!isRecord(value) ||
        value.kind !== 'intervention-abandonment-receipt.v1' ||
        value.parentChangeId !== intent.parentChangeId ||
        value.grantId !== intent.grantId ||
        value.intentDigest !== intent.intentDigest ||
        value.blockerCleared !== true ||
        value.bindingCleared !== (intent.localBinding !== null) ||
        !hasExactKeys(value, [
            'bindingCleared',
            'blockerCleared',
            'completedAt',
            'grantId',
            'intentDigest',
            'kind',
            'parentChangeId',
            'receiptDigest',
        ]) ||
        !isDigest(value.receiptDigest)) {
        throw corruptAbandonment();
    }
    const { receiptDigest, ...payload } = value;
    if (canonicalDigest(payload) !== receiptDigest) {
        throw corruptAbandonment();
    }
    exactIso(String(value.completedAt), 'INTERVENTION_ABANDONMENT_CORRUPT');
    return value;
}
function verifyEmbeddedRecordDigest(value) {
    if (!isDigest(value.recordDigest))
        return false;
    const { recordDigest, ...payload } = value;
    return canonicalDigest(payload) === recordDigest;
}
function corruptAbandonment() {
    return workflowError('INTERVENTION_ABANDONMENT_CORRUPT', 'Durable intervention abandonment evidence failed verification.', ExitCode.verification);
}
export function localEngineArtifactPath(storageRoot, artifactId) {
    assertDigest(artifactId, 'BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT');
    return path.join(interventionControlPersistencePaths(storageRoot).root, 'local-engine-artifacts', artifactId.slice('sha256:'.length), 'engine');
}
function bindingStateRoot(bindingPath) {
    const directory = path.dirname(canonicalAbsolutePath(bindingPath));
    return path.basename(directory) === 'local-parent-sessions'
        ? path.dirname(directory)
        : directory;
}
function bootstrapBundleDirectory(storageRoot) {
    return path.join(interventionControlPersistencePaths(storageRoot).root, 'bootstrap-wip-bundles');
}
function bootstrapReceiptDirectory(storageRoot) {
    return path.join(interventionControlPersistencePaths(storageRoot).root, 'bootstrap-receipts');
}
function wipBundlePath(storageRoot, checkpointId) {
    return path.join(bootstrapBundleDirectory(storageRoot), `${checkpointId.slice('sha256:'.length)}.json`);
}
function bootstrapReceiptPath(storageRoot, identity) {
    return path.join(bootstrapReceiptDirectory(storageRoot), `${crypto.createHash('sha256').update(identity).digest('hex')}.json`);
}
function persistBootstrapReceipt(storageRoot, identity, receipt) {
    const directory = bootstrapReceiptDirectory(storageRoot);
    ensurePrivateDirectory(directory);
    const target = bootstrapReceiptPath(storageRoot, identity);
    const content = Buffer.from(`${canonicalJson(receipt)}\n`);
    if (fs.existsSync(target)) {
        if (!readPrivateBytes(target, 'BOOTSTRAP_RECEIPT_NOT_FOUND', 1024 * 1024).equals(content)) {
            throw workflowError('BOOTSTRAP_RECEIPT_CONFLICT', 'Bootstrap receipt identity already contains different bytes.', ExitCode.conflict);
        }
        return;
    }
    createPrivateFileExclusive(target, content);
}
function readBootstrapReceipt(receiptPath) {
    const value = readCanonicalPrivateJson(receiptPath, 'BOOTSTRAP_RECEIPT_NOT_FOUND', 1024 * 1024);
    if (!isRecord(value) || !isDigest(value.receiptDigest)) {
        throw workflowError('BOOTSTRAP_RECEIPT_CORRUPT', 'Bootstrap receipt failed structural verification.', ExitCode.verification);
    }
    const { receiptDigest, ...payload } = value;
    if (canonicalDigest(payload) !== receiptDigest) {
        throw workflowError('BOOTSTRAP_RECEIPT_CORRUPT', 'Bootstrap receipt failed digest verification.', ExitCode.verification);
    }
    return value;
}
function canonicalRepositoryRoot(requestedRoot) {
    const absolute = canonicalAbsolutePath(requestedRoot);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw workflowError('BOOTSTRAP_REPOSITORY_UNSAFE', 'Bootstrap repository root must be a plain directory.', ExitCode.unsafeEnvironment);
    }
    const real = fs.realpathSync(absolute);
    if (real !== absolute) {
        throw workflowError('BOOTSTRAP_REPOSITORY_UNSAFE', 'Bootstrap repository root must be canonical.', ExitCode.unsafeEnvironment);
    }
    const topLevel = gitText(real, ['rev-parse', '--show-toplevel']).trim();
    if (fs.realpathSync(topLevel) !== real) {
        throw workflowError('BOOTSTRAP_REPOSITORY_UNSAFE', 'Requested path is not the exact Git worktree root.', ExitCode.unsafeEnvironment);
    }
    return real;
}
function canonicalPlannedWorkspacePath(requestedPath, repositoryRoot) {
    const absolute = canonicalAbsolutePath(requestedPath);
    const parent = path.dirname(absolute);
    if (!fs.existsSync(parent) || fs.realpathSync(parent) !== parent) {
        throw workflowError('BOOTSTRAP_CHILD_WORKSPACE_PARENT_UNSAFE', 'Child workspace parent directory must be canonical.', ExitCode.unsafeEnvironment);
    }
    if (parent !== path.dirname(repositoryRoot) ||
        absolute === repositoryRoot ||
        isPathInside(repositoryRoot, absolute) ||
        isPathInside(absolute, repositoryRoot)) {
        throw workflowError('BOOTSTRAP_CHILD_WORKSPACE_SCOPE_INVALID', 'Child workspace must be a disjoint sibling of the parent worktree.', ExitCode.guard);
    }
    return absolute;
}
function canonicalPlainFile(requestedPath, maxBytes, code) {
    const absolute = canonicalAbsolutePath(requestedPath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.size > maxBytes ||
        fs.realpathSync(absolute) !== absolute) {
        throw workflowError(code, 'Bootstrap file must be a bounded canonical regular file.', ExitCode.unsafeEnvironment);
    }
    return absolute;
}
function canonicalAbsolutePath(requestedPath) {
    if (typeof requestedPath !== 'string' ||
        !path.isAbsolute(requestedPath) ||
        path.resolve(requestedPath) !== requestedPath ||
        requestedPath === path.parse(requestedPath).root) {
        throw workflowError('BOOTSTRAP_PATH_INVALID', 'Bootstrap path must be an explicit normalized absolute path.', ExitCode.usage);
    }
    return requestedPath;
}
function assertPersistenceOwnedPath(storageRoot, requestedPath, code) {
    const root = interventionControlPersistencePaths(storageRoot).root;
    const absolute = canonicalAbsolutePath(requestedPath);
    if (!isPathInside(root, absolute)) {
        throw workflowError(code, 'Bootstrap mutable state must stay inside the persistence root.', ExitCode.guard);
    }
    return absolute;
}
function assertSafeRelativePath(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value !== value.normalize('NFC') ||
        path.isAbsolute(value) ||
        value.includes('\\') ||
        value
            .split('/')
            .some((part) => part === '' || part === '.' || part === '..') ||
        value === '.git' ||
        value.startsWith('.git/')) {
        throw workflowError('BOOTSTRAP_UNTRACKED_PATH_INVALID', 'Untracked allowlist path is unsafe.', ExitCode.usage);
    }
}
function safeRepositoryPath(repositoryRoot, relativePath) {
    assertSafeRelativePath(relativePath);
    const target = path.resolve(repositoryRoot, relativePath);
    if (!isPathInside(repositoryRoot, target)) {
        throw workflowError('BOOTSTRAP_UNTRACKED_PATH_INVALID', 'Untracked path escapes the repository root.', ExitCode.guard);
    }
    return target;
}
function ensureSafeParentDirectories(repositoryRoot, requestedDirectory) {
    const relative = path.relative(repositoryRoot, requestedDirectory);
    let current = repositoryRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stats = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stats) {
            fs.mkdirSync(current, { mode: 0o700 });
        }
        else if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw workflowError('BOOTSTRAP_RESTORE_PARENT_UNSAFE', 'Untracked restore parent is not a plain directory.', ExitCode.unsafeEnvironment);
        }
    }
}
function removeRestoredUntracked(repositoryRoot, relativePath) {
    const target = safeRepositoryPath(repositoryRoot, relativePath);
    try {
        fs.unlinkSync(target);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            throw error;
        }
    }
    let directory = path.dirname(target);
    while (directory !== repositoryRoot &&
        isPathInside(repositoryRoot, directory)) {
        try {
            fs.rmdirSync(directory);
        }
        catch (error) {
            if (isNodeError(error) &&
                ['ENOENT', 'ENOTEMPTY'].includes(error.code ?? '')) {
                break;
            }
            throw error;
        }
        directory = path.dirname(directory);
    }
}
function removeExactChildWorkspace(childPath, parentRoot) {
    if (!path.isAbsolute(childPath) ||
        childPath === parentRoot ||
        isPathInside(parentRoot, childPath) ||
        isPathInside(childPath, parentRoot)) {
        throw workflowError('BOOTSTRAP_CHILD_WORKTREE_CLEANUP_UNSAFE', 'Refusing to clean an unvalidated child workspace path.', ExitCode.unsafeEnvironment);
    }
    fs.rmSync(childPath, { recursive: true, force: true });
}
function isPathInside(parentPath, childPath) {
    const relative = path.relative(parentPath, childPath);
    return (relative.length > 0 &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative));
}
function gitBuffer(repositoryRoot, args, input) {
    const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
        input,
        encoding: null,
        maxBuffer: MAX_BUNDLE_BYTES,
        env: {
            ...process.env,
            LANG: 'C',
            LC_ALL: 'C',
        },
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
        const stderr = Buffer.isBuffer(result.stderr)
            ? result.stderr.toString('utf8').slice(0, 1000)
            : '';
        throw workflowError('BOOTSTRAP_GIT_COMMAND_FAILED', `Git command failed: ${args[0] ?? 'unknown'}`, ExitCode.verification, { details: { status: result.status, stderr } });
    }
    return result.stdout;
}
function gitBufferNoThrow(repositoryRoot, args) {
    spawnSync('git', ['-C', repositoryRoot, ...args], {
        encoding: null,
        maxBuffer: MAX_BUNDLE_BYTES,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
}
function gitText(repositoryRoot, args) {
    return gitBuffer(repositoryRoot, args).toString('utf8');
}
function gitRefExists(repositoryRoot, ref) {
    const result = spawnSync('git', ['-C', repositoryRoot, 'show-ref', '--verify', '--quiet', ref], { encoding: null, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    if (result.status === 0) {
        return true;
    }
    if (result.status === 1) {
        return false;
    }
    throw workflowError('BOOTSTRAP_GIT_COMMAND_FAILED', 'Unable to inspect reserved child change ref.', ExitCode.verification);
}
function createPrivateFileExclusive(filePath, content) {
    ensurePrivateDirectory(path.dirname(filePath));
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
}
function createPrivateExecutableExclusive(filePath, content) {
    ensurePrivateDirectory(path.dirname(filePath));
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, PRIVATE_EXECUTABLE_MODE);
    try {
        fs.fchmodSync(descriptor, PRIVATE_EXECUTABLE_MODE);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
}
function assertPrivateLocalEngineExecutable(filePath, expectedDigest) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
        stats.size < 1 ||
        stats.size > MAX_UNTRACKED_FILE_BYTES ||
        fs.realpathSync(filePath) !== filePath) {
        throw workflowError('BOOTSTRAP_LOCAL_ENGINE_ARTIFACT_UNSAFE', 'Materialized local engine artifact is missing, indirect, or unsafe.', ExitCode.unsafeEnvironment);
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        const bytes = fs.readFileSync(descriptor);
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            opened.size !== stats.size ||
            rawDigest(bytes) !== expectedDigest) {
            throw workflowError('BOOTSTRAP_LOCAL_ENGINE_ARTIFACT_DIGEST_MISMATCH', 'Materialized local engine artifact digest changed.', ExitCode.verification);
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function writePrivateFileAtomic(filePath, content) {
    const absolute = canonicalAbsolutePath(filePath);
    ensurePrivateDirectory(path.dirname(absolute));
    const temporaryPath = `${absolute}.${crypto.randomUUID()}.tmp`;
    createPrivateFileExclusive(temporaryPath, content);
    fs.renameSync(temporaryPath, absolute);
    fsyncDirectory(path.dirname(absolute));
}
function replacePrivateFileAtomic(filePath, content, expectedRecordDigest) {
    const current = readLocalEngineBinding(filePath);
    if (current.recordDigest !== expectedRecordDigest) {
        throw workflowError('BOOTSTRAP_BINDING_CAS_MISMATCH', 'Local engine binding changed before atomic replacement.', ExitCode.staleState);
    }
    writePrivateFileAtomic(filePath, content);
}
function ensurePrivateDirectory(directory) {
    ensurePlainDirectory(directory);
    const stats = fs.statSync(directory);
    if ((stats.mode & 0o077) !== 0) {
        fs.chmodSync(directory, 0o700);
    }
}
function readCanonicalPrivateJson(filePath, notFoundCode, maxBytes) {
    const bytes = readPrivateBytes(filePath, notFoundCode, maxBytes);
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(bytes)) {
        throw workflowError('BOOTSTRAP_PERSISTENCE_OBJECT_CORRUPT', 'Bootstrap persistence object is not valid UTF-8.', ExitCode.verification);
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw workflowError('BOOTSTRAP_PERSISTENCE_OBJECT_CORRUPT', 'Bootstrap persistence object is not JSON.', ExitCode.verification);
    }
    if (`${canonicalJson(value)}\n` !== raw) {
        throw workflowError('BOOTSTRAP_PERSISTENCE_OBJECT_CORRUPT', 'Bootstrap persistence object is not canonical.', ExitCode.verification);
    }
    return value;
}
function readPrivateBytes(filePath, notFoundCode, maxBytes) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        throw workflowError(notFoundCode, 'Bootstrap persistence object was not found.', ExitCode.conflict);
    }
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > maxBytes) {
        throw workflowError('BOOTSTRAP_PERSISTENCE_OBJECT_UNSAFE', 'Bootstrap persistence object is not a bounded private file.', ExitCode.unsafeEnvironment);
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            opened.nlink !== 1 ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.size > maxBytes) {
            throw workflowError('BOOTSTRAP_PERSISTENCE_OBJECT_UNSAFE', 'Bootstrap persistence object changed while being opened.', ExitCode.unsafeEnvironment);
        }
        return fs.readFileSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function readOptionalPlainFile(filePath, maxBytes) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        return null;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
        throw workflowError('BOOTSTRAP_SESSION_SNAPSHOT_UNSAFE', 'Existing session snapshot target is unsafe.', ExitCode.unsafeEnvironment);
    }
    return fs.readFileSync(filePath);
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
function decodeCanonicalBase64(value) {
    if (typeof value !== 'string' ||
        value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw corruptWipBundle();
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) {
        throw corruptWipBundle();
    }
    return decoded;
}
function rawDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function canonicalDigest(value) {
    return rawDigest(Buffer.from(canonicalJson(value)));
}
function verifyPersistedMaintenanceGrantForRecovery(envelope, intervention, journal, verifier) {
    const payload = envelope.payload;
    if (payload.grantId !== journal.grantId ||
        payload.parentChangeId !== journal.parentChangeId ||
        payload.interventionChangeId !== journal.interventionChangeId ||
        payload.engineFromDigest !== journal.fromEngineDigest ||
        payload.sessionSchema !== journal.sessionSchema ||
        journal.checkpointId !== intervention.checkpoint.checkpointId) {
        throw workflowError('BOOTSTRAP_RECOVERY_GRANT_INVALID', 'Persisted recovery grant no longer matches the adoption journal.', ExitCode.verification);
    }
    try {
        const issuedAt = new Date(payload.issuedAt);
        if (!Number.isFinite(issuedAt.getTime())) {
            throw new Error('invalid issuedAt');
        }
        // An already-prepared transaction must remain safely recoverable after
        // expiry. Revalidate every grant binding and the human signature at its
        // original issue time, while deliberately omitting only the live TTL gate.
        verifyHarnessMaintenanceGrant(envelope, {
            now: issuedAt,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: verifier,
        });
    }
    catch {
        throw workflowError('BOOTSTRAP_RECOVERY_GRANT_INVALID', 'Persisted recovery grant failed binding or signature verification.', ExitCode.verification);
    }
}
function requireHumanVerifier(dependencies) {
    if (dependencies.verifyHumanSignature === undefined) {
        throw workflowError('BOOTSTRAP_HUMAN_VERIFIER_REQUIRED', 'Bootstrap effect requires a trusted human grant verifier.', ExitCode.guard);
    }
    return dependencies.verifyHumanSignature;
}
function bootstrapNow(dependencies) {
    return exactDate(dependencies.now?.() ?? new Date(), 'BOOTSTRAP_CLOCK_INVALID');
}
function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError(code, 'Bootstrap clock is invalid.', ExitCode.unsafeEnvironment);
    }
    return new Date(value.getTime());
}
function exactIso(value, code) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw workflowError(code, 'Bootstrap timestamp is invalid.', ExitCode.verification);
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
function assertGitOid(value, code) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
        throw workflowError(code, 'Expected a full Git object id.', ExitCode.verification);
    }
}
function assertNonEmpty(value, code) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0) {
        throw workflowError(code, 'Expected a non-empty trimmed string.', ExitCode.usage);
    }
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function corruptWipBundle() {
    return workflowError('BOOTSTRAP_WIP_BUNDLE_CORRUPT', 'Persisted WIP bundle failed integrity verification.', ExitCode.verification);
}
function corruptBinding() {
    return workflowError('BOOTSTRAP_BINDING_CORRUPT', 'Local engine binding failed integrity verification.', ExitCode.verification);
}
