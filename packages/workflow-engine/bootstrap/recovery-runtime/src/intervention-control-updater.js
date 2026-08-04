import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { ensurePlainDirectory, publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from './filesystem-safety.js';
import { classifyProtectedCandidateImpact, controlPlaneCandidateDigest, controlPlaneIndependentReviewAttestationDigest, createEngineArtifact, normalizeControlPlaneTaskMandateBinding, verifyControlPlaneIndependentReviewAttestation, verifyControlPlaneGrant, } from './intervention-control.js';
import { advancePersistedControlPlaneUpdate, controlPlaneUpdateRecordPath, interventionControlPersistencePaths, preparePersistedControlPlaneUpdate, readPersistedControlPlaneUpdate, } from './intervention-control-persistence.js';
const SUPPORTED_UPDATER_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o500;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;
export function assertSameControlPlaneTaskMandateBinding(expected, observed) {
    const exactExpected = normalizeControlPlaneTaskMandateBinding(expected);
    const exactObserved = normalizeControlPlaneTaskMandateBinding(observed);
    if (canonicalJson(exactExpected) !== canonicalJson(exactObserved)) {
        throw workflowError('CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH', 'Control-plane authority does not match the exact parent Task Mandate binding.', ExitCode.staleState);
    }
    return exactExpected;
}
export function createControlPlaneRecoveryBundle(input) {
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    assertDigest(input.previousClosureDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    const restartArtifact = verifyEngineArtifact(input.restartArtifact);
    const restartExecutablePath = safeLogicalPath(input.restartExecutablePath, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    const previousFiles = verifyPromotionFiles(input.previousFiles, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    const restartExecutable = previousFiles.find((file) => file.path === restartExecutablePath);
    if (restartExecutable?.mode !== '100755' ||
        restartExecutable.contentDigest !== restartArtifact.executableDigest) {
        throw promotionBundleCorrupt('Recovery executable does not match the restart artifact.');
    }
    const rollbackTestReport = decodeCanonicalBase64(input.rollbackTestReportBase64, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    assertDigest(input.rollbackTestReportDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    if (rawDigest(rollbackTestReport) !== input.rollbackTestReportDigest) {
        throw promotionBundleCorrupt('Rollback test report digest mismatch.');
    }
    const payload = {
        kind: 'control-plane-recovery-bundle.v1',
        repositoryId: input.repositoryId,
        previousClosureDigest: input.previousClosureDigest,
        restartArtifact,
        restartExecutablePath,
        previousFiles,
        rollbackTestReportBase64: input.rollbackTestReportBase64,
        rollbackTestReportDigest: input.rollbackTestReportDigest,
    };
    return deepFreeze({ ...payload, bundleDigest: canonicalDigest(payload) });
}
export function createControlPlanePromotionBundle(input) {
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(input.mandateBinding);
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    const exactChanges = verifyExactChanges(input.exactChanges);
    if (input.candidateDigest !== controlPlaneCandidateDigest(exactChanges) ||
        !isDigest(input.beforeClosureDigest) ||
        !isDigest(input.afterClosureDigest)) {
        throw promotionBundleCorrupt('Promotion closure or candidate digest is invalid.');
    }
    const candidateArtifact = verifyEngineArtifact(input.candidateArtifact);
    const candidateExecutablePath = safeLogicalPath(input.candidateExecutablePath, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    const candidateFiles = verifyPromotionFiles(input.candidateFiles, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    const recoveryBundle = verifyRecoveryBundle(input.recoveryBundle);
    controlPlaneIndependentReviewAttestationDigest(input.independentReviewAttestation);
    if (recoveryBundle.repositoryId !== input.repositoryId ||
        recoveryBundle.previousClosureDigest !== input.beforeClosureDigest) {
        throw promotionBundleCorrupt('Recovery bundle is not bound to the old closure.');
    }
    assertFilesMatchChanges(candidateFiles, exactChanges, 'afterDigest');
    assertFilesMatchChanges(recoveryBundle.previousFiles, exactChanges, 'beforeDigest');
    const executable = candidateFiles.find((file) => file.path === candidateExecutablePath);
    if (executable?.mode !== '100755' ||
        executable.contentDigest !== candidateArtifact.executableDigest) {
        throw promotionBundleCorrupt('Candidate executable does not match the candidate artifact.');
    }
    const payload = {
        kind: 'control-plane-promotion-bundle.v1',
        mandateBinding,
        repositoryId: input.repositoryId,
        candidateDigest: input.candidateDigest,
        beforeClosureDigest: input.beforeClosureDigest,
        afterClosureDigest: input.afterClosureDigest,
        exactChanges,
        candidateArtifact,
        candidateExecutablePath,
        candidateFiles,
        recoveryBundle,
        independentReviewAttestation: structuredClone(input.independentReviewAttestation),
    };
    return deepFreeze({ ...payload, bundleDigest: canonicalDigest(payload) });
}
/**
 * Publish immutable, unsigned control-plane approval material. The human CLI
 * later addresses this record only by its content-bound candidate id; signed
 * grant envelopes are never accepted as command input.
 */
export function persistControlPlaneApprovalCandidate(storageRoot, input, now = new Date()) {
    const bundle = verifyPromotionBundle(input.bundle);
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(input.mandateBinding);
    assertSameControlPlaneTaskMandateBinding(mandateBinding, bundle.mandateBinding);
    const impact = assertApprovalCandidateBindings(input.beforeManifest, input.afterManifest, bundle);
    if (impact.class !== 'C') {
        throw approvalCandidateCorrupt('Approval candidate does not modify the protected control plane.');
    }
    assertNonEmpty(input.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
    const createdAt = exactDate(now, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT').toISOString();
    const candidate = withRecordDigest({
        kind: 'persisted-control-plane-approval-candidate.v1',
        mandateBinding,
        candidateId: bundle.bundleDigest,
        txId: input.txId,
        beforeManifest: structuredClone(input.beforeManifest),
        afterManifest: structuredClone(input.afterManifest),
        bundle: structuredClone(bundle),
        createdAt,
    });
    return withUpdaterLock(storageRoot, 'persist-approval-candidate', () => {
        const paths = ensureUpdaterDirectories(storageRoot);
        const target = controlPlaneApprovalCandidatePath(storageRoot, candidate.candidateId);
        const content = serializeCanonical(candidate);
        if (fs.existsSync(target)) {
            const existing = readPersistedControlPlaneApprovalCandidate(storageRoot, candidate.candidateId);
            if (canonicalJson(existing) !== canonicalJson(candidate)) {
                throw workflowError('CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT', 'Candidate id is already bound to different approval bytes.', ExitCode.conflict);
            }
            return existing;
        }
        ensurePrivateDirectory(paths.approvalCandidates);
        createPrivateFileExclusive(target, content);
        return deepFreeze(structuredClone(candidate));
    });
}
export function controlPlaneApprovalCandidatePath(storageRoot, candidateId) {
    assertDigest(candidateId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
    return path.join(updaterPaths(storageRoot).approvalCandidates, `${candidateId.slice('sha256:'.length)}.json`);
}
export function readPersistedControlPlaneApprovalCandidate(storageRoot, candidateId) {
    const value = readCanonicalPrivateRecord(controlPlaneApprovalCandidatePath(storageRoot, candidateId), 'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'afterManifest',
            'beforeManifest',
            'bundle',
            'candidateId',
            'createdAt',
            'kind',
            'mandateBinding',
            'recordDigest',
            'txId',
        ]) ||
        value.kind !== 'persisted-control-plane-approval-candidate.v1' ||
        value.candidateId !== candidateId ||
        !verifyRecordDigest(value)) {
        throw approvalCandidateCorrupt();
    }
    try {
        const candidate = value;
        const mandateBinding = normalizeControlPlaneTaskMandateBinding(candidate.mandateBinding);
        assertNonEmpty(candidate.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
        if (!isCanonicalIso(candidate.createdAt)) {
            throw approvalCandidateCorrupt();
        }
        const bundle = verifyPromotionBundle(candidate.bundle);
        assertSameControlPlaneTaskMandateBinding(mandateBinding, bundle.mandateBinding);
        if (bundle.bundleDigest !== candidate.candidateId) {
            throw approvalCandidateCorrupt('Candidate id does not match the exact promotion bundle.');
        }
        const impact = assertApprovalCandidateBindings(candidate.beforeManifest, candidate.afterManifest, bundle);
        if (impact.class !== 'C') {
            throw approvalCandidateCorrupt('Persisted candidate no longer classifies as control-plane.');
        }
        return deepFreeze(structuredClone({ ...candidate, mandateBinding, bundle }));
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT') {
            throw error;
        }
        throw approvalCandidateCorrupt();
    }
}
export function preflightControlPlaneApprovalCandidate(storageRoot, candidateId, context) {
    assertNonEmpty(context.grantId, 'CONTROL_PLANE_GRANT_INVALID');
    assertNonEmpty(context.humanSigner, 'CONTROL_PLANE_GRANT_INVALID');
    if (fs.existsSync(controlPlaneUpdateRecordPath(storageRoot, context.grantId))) {
        readPersistedControlPlaneUpdate(storageRoot, context.grantId);
        throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED', 'Control-Plane Grant already has a durable transaction.', ExitCode.conflict);
    }
    const candidate = readPersistedControlPlaneApprovalCandidate(storageRoot, candidateId);
    const impact = assertApprovalCandidateBindings(candidate.beforeManifest, candidate.afterManifest, candidate.bundle);
    const attestationDigest = controlPlaneIndependentReviewAttestationDigest(candidate.bundle.independentReviewAttestation);
    verifyControlPlaneIndependentReviewAttestation(candidate.bundle.independentReviewAttestation, {
        expectedDigest: attestationDigest,
        repositoryId: candidate.bundle.repositoryId,
        candidateDigest: candidate.bundle.candidateDigest,
        beforeClosureDigest: candidate.bundle.beforeClosureDigest,
        afterClosureDigest: candidate.bundle.afterClosureDigest,
        recoveryBundleDigest: candidate.bundle.recoveryBundle.bundleDigest,
        affectedCapabilities: impact.affectedCapabilities,
        grantHumanSigner: context.humanSigner,
        grantIssuedAt: context.issuedAt,
        verifyHumanSignature: context.verifyHumanSignature,
    });
    const supervisor = readControlPlaneSupervisorState(storageRoot);
    assertSupervisorMatchesOldClosure(supervisor, candidate.bundle.repositoryId, candidate.bundle);
    const summary = controlPlaneApprovalSummary(candidate, impact, attestationDigest);
    return deepFreeze({ candidate, summary, supervisor });
}
export function initializeControlPlaneSupervisorState(storageRoot, input) {
    return withUpdaterLock(storageRoot, 'initialize-supervisor', () => {
        const paths = ensureUpdaterDirectories(storageRoot);
        assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_SUPERVISOR_INVALID');
        assertDigest(input.closureDigest, 'CONTROL_PLANE_SUPERVISOR_INVALID');
        const artifact = verifyEngineArtifact(input.artifact);
        const bytes = decodeCanonicalBase64(input.executableBase64, 'CONTROL_PLANE_SUPERVISOR_INVALID');
        if (rawDigest(bytes) !== artifact.executableDigest) {
            throw workflowError('CONTROL_PLANE_SUPERVISOR_INVALID', 'Initial executable does not match the engine artifact.', ExitCode.verification);
        }
        const executablePath = materializeExecutable(paths, artifact, bytes);
        const at = exactDate(input.now, 'CONTROL_PLANE_SUPERVISOR_INVALID');
        const state = withRecordDigest({
            kind: 'control-plane-supervisor-state.v1',
            repositoryId: input.repositoryId,
            activeArtifact: {
                artifactId: artifact.artifactId,
                executableDigest: artifact.executableDigest,
                closureDigest: input.closureDigest,
                executablePath,
            },
            generation: 1,
            transition: null,
            updatedAt: at.toISOString(),
        });
        if (fs.existsSync(paths.supervisor)) {
            const existing = readControlPlaneSupervisorState(storageRoot);
            if (canonicalJson(existing) !== canonicalJson(state)) {
                throw workflowError('CONTROL_PLANE_SUPERVISOR_ALREADY_INITIALIZED', 'A different control-plane supervisor state already exists.', ExitCode.conflict);
            }
            return existing;
        }
        createPrivateFileExclusive(paths.supervisor, serializeCanonical(state));
        return state;
    });
}
export function readControlPlaneSupervisorState(storageRoot) {
    const paths = updaterPaths(storageRoot);
    const value = readCanonicalPrivateRecord(paths.supervisor, 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'activeArtifact',
            'generation',
            'kind',
            'recordDigest',
            'repositoryId',
            'transition',
            'updatedAt',
        ]) ||
        value.kind !== 'control-plane-supervisor-state.v1' ||
        !verifyRecordDigest(value)) {
        throw supervisorCorrupt();
    }
    const state = value;
    if (typeof state.repositoryId !== 'string' ||
        state.repositoryId.length === 0 ||
        !Number.isSafeInteger(state.generation) ||
        state.generation < 1 ||
        !isRecord(state.activeArtifact) ||
        !hasExactKeys(state.activeArtifact, [
            'artifactId',
            'closureDigest',
            'executableDigest',
            'executablePath',
        ]) ||
        !isDigest(state.activeArtifact.artifactId) ||
        !isDigest(state.activeArtifact.executableDigest) ||
        !isDigest(state.activeArtifact.closureDigest) ||
        !validTransition(state.transition) ||
        !isCanonicalIso(state.updatedAt)) {
        throw supervisorCorrupt();
    }
    assertConfinedExecutable(paths, state.activeArtifact.executablePath, state.activeArtifact.executableDigest, state.activeArtifact.artifactId);
    return deepFreeze(structuredClone(state));
}
export function prepareControlPlanePromotion(storageRoot, input, dependencies) {
    return withUpdaterLock(storageRoot, 'prepare-promotion', () => {
        requireUpdaterDependencies(dependencies);
        const now = updaterNow(dependencies);
        if (input.envelope?.payload?.kind !== 'control-plane-grant.v1') {
            throw workflowError('CONTROL_PLANE_GRANT_INVALID', 'The minimal updater accepts only a Control-Plane Grant.', ExitCode.guard);
        }
        const bundle = verifyPromotionBundle(input.bundle);
        assertPromotionBindings(input.envelope, input.beforeManifest, input.afterManifest, bundle);
        if (input.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION) {
            throw workflowError('CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED', 'This minimal updater cannot execute the requested updater version.', ExitCode.guard);
        }
        if (fs.existsSync(controlPlaneUpdateRecordPath(storageRoot, input.envelope.payload.grantId))) {
            readPersistedControlPlaneUpdate(storageRoot, input.envelope.payload.grantId);
            throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED', 'Control-Plane Grant already has a durable transaction.', ExitCode.conflict);
        }
        // Verify authority before creating any durable candidate material.
        verifyControlPlaneGrant(input.envelope, {
            now,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            changes: bundle.exactChanges,
            consumedGrantIds: dependencies.consumedGrantIds,
            verifyHumanSignature: dependencies.verifyHumanSignature,
        });
        verifyIndependentReviewForPromotion(input.envelope, bundle, dependencies.verifyHumanSignature);
        revalidateControlPlaneTaskMandate(input.envelope.payload.mandateBinding, dependencies, 'before-persistence');
        const supervisor = readControlPlaneSupervisorState(storageRoot);
        assertSupervisorIsOldClosure(supervisor, input.envelope, bundle);
        const paths = ensureUpdaterDirectories(storageRoot);
        persistPromotionBundle(paths, input.envelope.payload.grantId, bundle);
        materializeBundleExecutables(paths, bundle);
        const record = preparePersistedControlPlaneUpdate(storageRoot, {
            txId: input.txId,
            envelope: input.envelope,
            beforeManifest: input.beforeManifest,
            afterManifest: input.afterManifest,
            changes: bundle.exactChanges,
        }, {
            now: () => now,
            consumedGrantIds: dependencies.consumedGrantIds,
            verifyHumanSignature: dependencies.verifyHumanSignature,
        });
        emitAuditHistory(record, bundle, dependencies);
        return { record, supervisor };
    });
}
export function executeControlPlanePromotion(storageRoot, grantId, dependencies) {
    return withUpdaterLock(storageRoot, `execute:${grantId}`, () => driveControlPlanePromotion(storageRoot, grantId, dependencies));
}
export function recoverControlPlanePromotion(storageRoot, grantId, dependencies) {
    return withUpdaterLock(storageRoot, `recover:${grantId}`, () => driveControlPlanePromotion(storageRoot, grantId, dependencies));
}
function driveControlPlanePromotion(storageRoot, grantId, dependencies) {
    requireUpdaterDependencies(dependencies);
    const paths = ensureUpdaterDirectories(storageRoot);
    let record = readPersistedControlPlaneUpdate(storageRoot, grantId);
    const bundle = readPromotionBundle(paths, grantId);
    verifyPersistedPromotion(record, bundle, dependencies);
    materializeBundleExecutables(paths, bundle);
    let supervisor = readControlPlaneSupervisorState(storageRoot);
    if (supervisor.repositoryId !== bundle.repositoryId) {
        throw supervisorCorrupt();
    }
    let switchedInThisInvocation = false;
    let conservativeRollback = record.transaction.state === 'SWITCHED' ||
        (record.transaction.state === 'RECOVERY_VERIFIED' &&
            supervisor.activeArtifact.artifactId ===
                bundle.candidateArtifact.artifactId);
    emitAuditHistory(record, bundle, dependencies);
    for (;;) {
        switch (record.transaction.state) {
            case 'PREPARED': {
                revalidateControlPlaneTaskMandate(record.envelope.payload.mandateBinding, dependencies, 'before-forward-effect');
                assertGrantLiveForForwardEffect(record, dependencies);
                assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
                const evidence = canonicalDigest({
                    kind: 'old-closure-evidence.v1',
                    supervisorDigest: supervisor.recordDigest,
                    closureDigest: supervisor.activeArtifact.closureDigest,
                });
                record = advanceRecord(record, storageRoot, {
                    kind: 'old-closure-verified',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: evidence,
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'OLD_CLOSURE_VERIFIED': {
                revalidateControlPlaneTaskMandate(record.envelope.payload.mandateBinding, dependencies, 'before-forward-effect');
                assertGrantLiveForForwardEffect(record, dependencies);
                assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
                verifyPromotionBundle(bundle);
                const executablePath = materializedExecutablePath(paths, bundle.candidateArtifact);
                assertConfinedExecutable(paths, executablePath, bundle.candidateArtifact.executableDigest);
                record = advanceRecord(record, storageRoot, {
                    kind: 'candidate-verified',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: canonicalDigest({
                        kind: 'candidate-verification-evidence.v1',
                        promotionBundleDigest: bundle.bundleDigest,
                        artifactId: bundle.candidateArtifact.artifactId,
                        executableDigest: bundle.candidateArtifact.executableDigest,
                    }),
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'CANDIDATE_VERIFIED': {
                revalidateControlPlaneTaskMandate(record.envelope.payload.mandateBinding, dependencies, 'before-forward-effect');
                assertGrantLiveForForwardEffect(record, dependencies);
                assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
                const restartPath = materializedExecutablePath(paths, bundle.recoveryBundle.restartArtifact);
                const restart = runRestartProbe(paths, restartPath, bundle.recoveryBundle.restartArtifact.executableDigest, bundle.beforeClosureDigest);
                record = advanceRecord(record, storageRoot, {
                    kind: 'recovery-bundle-verified',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: canonicalDigest({
                        kind: 'recovery-verification-evidence.v1',
                        bundleDigest: bundle.recoveryBundle.bundleDigest,
                        restartEvidenceDigest: restart.evidenceDigest,
                    }),
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'RECOVERY_VERIFIED': {
                if (supervisor.activeArtifact.artifactId ===
                    bundle.candidateArtifact.artifactId &&
                    supervisor.activeArtifact.closureDigest === bundle.afterClosureDigest) {
                    conservativeRollback = true;
                }
                else {
                    revalidateControlPlaneTaskMandate(record.envelope.payload.mandateBinding, dependencies, 'before-atomic-switch');
                    assertGrantLiveForForwardEffect(record, dependencies);
                    assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
                    supervisor = selectSupervisorArtifact(storageRoot, supervisor, bundle.candidateArtifact, bundle.afterClosureDigest, record, 'candidate-selected', updaterNow(dependencies));
                    switchedInThisInvocation = true;
                    dependencies.testHooks?.afterAtomicSwitch?.();
                }
                record = advanceRecord(record, storageRoot, {
                    kind: 'atomic-switch-completed',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: supervisor.recordDigest,
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'SWITCHED': {
                assertSupervisorIsCandidate(supervisor, bundle);
                if (conservativeRollback || !switchedInThisInvocation) {
                    record = advanceRecord(record, storageRoot, {
                        kind: 'self-tests-failed',
                        at: nextTransitionTime(record, dependencies),
                        evidenceDigest: canonicalDigest({
                            kind: 'conservative-crash-recovery.v1',
                            supervisorDigest: supervisor.recordDigest,
                        }),
                    });
                    emitAuditHistory(record, bundle, dependencies);
                    continue;
                }
                const candidatePath = materializedExecutablePath(paths, bundle.candidateArtifact);
                let selfTest;
                try {
                    selfTest = runSelfTest(paths, candidatePath, bundle.candidateArtifact.executableDigest, bundle.afterClosureDigest);
                }
                catch (error) {
                    selfTest = {
                        healthy: false,
                        closureDigest: bundle.afterClosureDigest,
                        evidenceDigest: canonicalDigest({
                            kind: 'control-plane-self-test-failure.v1',
                            failureCode: workflowFailureCode(error),
                        }),
                    };
                }
                record = advanceRecord(record, storageRoot, {
                    kind: selfTest.healthy ? 'self-tests-passed' : 'self-tests-failed',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: selfTest.evidenceDigest,
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'SELF_TESTED': {
                assertSupervisorIsCandidate(supervisor, bundle);
                record = advanceRecord(record, storageRoot, {
                    kind: 'finalize',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: supervisor.recordDigest,
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'ROLLBACK_REQUIRED': {
                if (supervisor.activeArtifact.artifactId ===
                    bundle.candidateArtifact.artifactId) {
                    assertSupervisorIsCandidate(supervisor, bundle);
                    supervisor = selectSupervisorArtifact(storageRoot, supervisor, bundle.recoveryBundle.restartArtifact, bundle.beforeClosureDigest, record, 'rollback-restored', updaterNow(dependencies));
                }
                else {
                    assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
                }
                const restartPath = materializedExecutablePath(paths, bundle.recoveryBundle.restartArtifact);
                const restart = runRestartProbe(paths, restartPath, bundle.recoveryBundle.restartArtifact.executableDigest, bundle.beforeClosureDigest);
                record = advanceRecord(record, storageRoot, {
                    kind: 'rollback-completed',
                    at: nextTransitionTime(record, dependencies),
                    evidenceDigest: canonicalDigest({
                        kind: 'rollback-completion-evidence.v1',
                        supervisorDigest: supervisor.recordDigest,
                        restartEvidenceDigest: restart.evidenceDigest,
                    }),
                });
                emitAuditHistory(record, bundle, dependencies);
                continue;
            }
            case 'FINALIZED':
                assertSupervisorIsCandidate(supervisor, bundle);
                emitAuditHistory(record, bundle, dependencies);
                return { record, supervisor };
            case 'ROLLED_BACK':
                assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
                emitAuditHistory(record, bundle, dependencies);
                return { record, supervisor };
        }
    }
}
function verifyPersistedPromotion(record, bundle, dependencies) {
    assertPromotionBindings(record.envelope, record.beforeManifest, record.afterManifest, bundle);
    if (record.transaction.updaterVersion !== SUPPORTED_UPDATER_VERSION ||
        record.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION) {
        throw workflowError('CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED', 'Persisted promotion requires a different minimal updater.', ExitCode.guard);
    }
    // Recheck the persisted human signature and every exact binding. Expiry is
    // intentionally checked separately before forward effects: once switched,
    // rollback/finalization must remain possible after expiry.
    verifyControlPlaneGrant(record.envelope, {
        now: new Date(record.envelope.payload.issuedAt),
        beforeManifest: record.beforeManifest,
        afterManifest: record.afterManifest,
        changes: bundle.exactChanges,
        consumedGrantIds: new Set(),
        verifyHumanSignature: dependencies.verifyHumanSignature,
    });
    verifyIndependentReviewForPromotion(record.envelope, bundle, dependencies.verifyHumanSignature);
}
function revalidateControlPlaneTaskMandate(binding, dependencies, phase) {
    dependencies.revalidateTaskMandateBinding?.(normalizeControlPlaneTaskMandateBinding(binding), phase);
}
function verifyIndependentReviewForPromotion(envelope, bundle, verifyHumanSignature) {
    verifyControlPlaneIndependentReviewAttestation(bundle.independentReviewAttestation, {
        expectedDigest: envelope.payload.independentReviewAttestationDigest,
        repositoryId: bundle.repositoryId,
        candidateDigest: bundle.candidateDigest,
        beforeClosureDigest: bundle.beforeClosureDigest,
        afterClosureDigest: bundle.afterClosureDigest,
        recoveryBundleDigest: bundle.recoveryBundle.bundleDigest,
        affectedCapabilities: envelope.payload.affectedCapabilities,
        grantHumanSigner: envelope.payload.humanSigner,
        grantIssuedAt: envelope.payload.issuedAt,
        verifyHumanSignature,
    });
}
function assertPromotionBindings(envelope, beforeManifest, afterManifest, bundle) {
    const payload = envelope.payload;
    if (canonicalJson(bundle.mandateBinding) !==
        canonicalJson(payload.mandateBinding) ||
        bundle.repositoryId !== payload.repositoryId ||
        bundle.candidateDigest !== payload.candidateDigest ||
        bundle.beforeClosureDigest !== payload.beforeClosureDigest ||
        bundle.afterClosureDigest !== payload.afterClosureDigest ||
        bundle.beforeClosureDigest !== beforeManifest.manifestDigest ||
        bundle.afterClosureDigest !== afterManifest.manifestDigest ||
        canonicalJson(bundle.exactChanges) !==
            canonicalJson(payload.exactChanges) ||
        bundle.recoveryBundle.bundleDigest !==
            payload.recoveryBundle.bundleDigest ||
        bundle.recoveryBundle.previousClosureDigest !==
            payload.recoveryBundle.previousClosureDigest ||
        bundle.recoveryBundle.restartArtifact.executableDigest !==
            payload.recoveryBundle.restartArtifactDigest ||
        bundle.recoveryBundle.rollbackTestReportDigest !==
            payload.recoveryBundle.rollbackTestReportDigest) {
        throw promotionBundleCorrupt('Promotion bundle does not match the exact Control-Plane Grant.');
    }
}
function assertApprovalCandidateBindings(beforeManifest, afterManifest, bundle) {
    const impact = classifyProtectedCandidateImpact({
        beforeManifest,
        afterManifest,
        changes: bundle.exactChanges,
    });
    if (bundle.beforeClosureDigest !== beforeManifest.manifestDigest ||
        bundle.afterClosureDigest !== afterManifest.manifestDigest ||
        bundle.candidateDigest !== controlPlaneCandidateDigest(bundle.exactChanges)) {
        throw approvalCandidateCorrupt('Persisted manifests do not match the exact promotion bundle.');
    }
    return impact;
}
function controlPlaneApprovalSummary(candidate, impact, attestationDigest) {
    const review = candidate.bundle.independentReviewAttestation.payload;
    const affected = impact.affectedCapabilities.join(', ');
    const behaviorChangeSummary = `Independent review by ${review.reviewer} approved ` +
        `${candidate.bundle.exactChanges.length} exact control-plane changes ` +
        `affecting ${affected}: ${review.reviewSummary}`;
    const changedPaths = candidate.bundle.exactChanges
        .map(({ path: changedPath, beforeDigest, afterDigest }) => `- ${changedPath}: ${beforeDigest ?? '<absent>'} -> ${afterDigest ?? '<absent>'}`)
        .join('\n');
    const humanReadable = [
        'Control-plane approval candidate',
        `Candidate id: ${candidate.candidateId}`,
        `Parent task: ${candidate.mandateBinding.parentTaskId}`,
        `Task mandate: ${candidate.mandateBinding.mandateId} (${candidate.mandateBinding.mandateDigest})`,
        `Change: ${candidate.mandateBinding.changeId}`,
        `External authority audit root: ${candidate.mandateBinding.externalAuditRoot}`,
        `Repository: ${candidate.bundle.repositoryId}`,
        `Affected capabilities: ${affected}`,
        `Before control-plane closure: ${candidate.bundle.beforeClosureDigest}`,
        `After control-plane closure: ${candidate.bundle.afterClosureDigest}`,
        `Recovery bundle: ${candidate.bundle.recoveryBundle.bundleDigest}`,
        `Rollback test report: ${candidate.bundle.recoveryBundle.rollbackTestReportDigest}`,
        `Independent review: PASS — ${attestationDigest}`,
        `Reviewer: ${review.reviewer} at ${review.reviewedAt}`,
        `Review summary: ${review.reviewSummary}`,
        `Exact changes (${candidate.bundle.exactChanges.length}):`,
        changedPaths,
    ].join('\n');
    return deepFreeze({
        kind: 'control-plane-approval-summary.v1',
        mandateBinding: structuredClone(candidate.mandateBinding),
        candidateId: candidate.candidateId,
        candidateRecordDigest: candidate.recordDigest,
        repositoryId: candidate.bundle.repositoryId,
        candidateDigest: candidate.bundle.candidateDigest,
        exactChanges: candidate.bundle.exactChanges.map((change) => ({
            ...change,
        })),
        affectedCapabilities: [...impact.affectedCapabilities],
        beforeClosureDigest: candidate.bundle.beforeClosureDigest,
        afterClosureDigest: candidate.bundle.afterClosureDigest,
        recoveryBundleDigest: candidate.bundle.recoveryBundle.bundleDigest,
        rollbackTestReportDigest: candidate.bundle.recoveryBundle.rollbackTestReportDigest,
        independentReview: {
            attestationDigest,
            reviewer: review.reviewer,
            reviewedAt: review.reviewedAt,
            verdict: review.verdict,
            reviewSummary: review.reviewSummary,
        },
        behaviorChangeSummary,
        humanReadable,
    });
}
function verifyPromotionBundle(value) {
    if (isRecord(value) &&
        !Object.prototype.hasOwnProperty.call(value, 'independentReviewAttestation')) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_MISSING', 'Promotion bundle must carry the exact signed independent review bytes.', ExitCode.guard);
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'afterClosureDigest',
            'beforeClosureDigest',
            'bundleDigest',
            'candidateArtifact',
            'candidateDigest',
            'candidateExecutablePath',
            'candidateFiles',
            'exactChanges',
            'independentReviewAttestation',
            'kind',
            'mandateBinding',
            'recoveryBundle',
            'repositoryId',
        ]) ||
        value.kind !== 'control-plane-promotion-bundle.v1') {
        throw promotionBundleCorrupt('Unknown promotion bundle schema.');
    }
    const rebuilt = createControlPlanePromotionBundle({
        mandateBinding: value.mandateBinding,
        repositoryId: value.repositoryId,
        candidateDigest: value.candidateDigest,
        beforeClosureDigest: value.beforeClosureDigest,
        afterClosureDigest: value.afterClosureDigest,
        exactChanges: value.exactChanges,
        candidateArtifact: value.candidateArtifact,
        candidateExecutablePath: value.candidateExecutablePath,
        candidateFiles: value.candidateFiles,
        recoveryBundle: value.recoveryBundle,
        independentReviewAttestation: value.independentReviewAttestation,
    });
    if (rebuilt.bundleDigest !== value.bundleDigest) {
        throw promotionBundleCorrupt('Promotion bundle digest mismatch.');
    }
    return rebuilt;
}
function verifyRecoveryBundle(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'bundleDigest',
            'kind',
            'previousClosureDigest',
            'previousFiles',
            'repositoryId',
            'restartArtifact',
            'restartExecutablePath',
            'rollbackTestReportBase64',
            'rollbackTestReportDigest',
        ]) ||
        value.kind !== 'control-plane-recovery-bundle.v1') {
        throw promotionBundleCorrupt('Unknown recovery bundle schema.');
    }
    const rebuilt = createControlPlaneRecoveryBundle({
        repositoryId: value.repositoryId,
        previousClosureDigest: value.previousClosureDigest,
        restartArtifact: value.restartArtifact,
        restartExecutablePath: value.restartExecutablePath,
        previousFiles: value.previousFiles,
        rollbackTestReportBase64: value.rollbackTestReportBase64,
        rollbackTestReportDigest: value.rollbackTestReportDigest,
    });
    if (rebuilt.bundleDigest !== value.bundleDigest) {
        throw promotionBundleCorrupt('Recovery bundle digest mismatch.');
    }
    return rebuilt;
}
function verifyPromotionFiles(files, code) {
    if (!Array.isArray(files) || files.length === 0) {
        throw workflowError(code, 'Promotion file inventory is empty.', ExitCode.guard);
    }
    const verified = files.map((file) => {
        if (!isRecord(file) ||
            !hasExactKeys(file, ['contentBase64', 'contentDigest', 'mode', 'path']) ||
            (file.mode !== '100644' && file.mode !== '100755')) {
            throw workflowError(code, 'Promotion file entry is invalid.', ExitCode.guard);
        }
        const logicalPath = safeLogicalPath(file.path, code);
        assertDigest(file.contentDigest, code);
        const content = decodeCanonicalBase64(file.contentBase64, code);
        if (rawDigest(content) !== file.contentDigest) {
            throw workflowError(code, 'Promotion file digest mismatch.', ExitCode.verification);
        }
        return {
            path: logicalPath,
            mode: file.mode,
            contentBase64: file.contentBase64,
            contentDigest: file.contentDigest,
        };
    });
    assertSortedUniquePaths(verified.map((file) => file.path), code);
    return verified;
}
function verifyExactChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
        throw promotionBundleCorrupt('Exact candidate diff is empty.');
    }
    const verified = changes.map((change) => {
        if (!isRecord(change) ||
            !hasExactKeys(change, ['afterDigest', 'beforeDigest', 'path'])) {
            throw promotionBundleCorrupt('Exact candidate entry is invalid.');
        }
        safeLogicalPath(change.path, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
        if ((change.beforeDigest !== null && !isDigest(change.beforeDigest)) ||
            (change.afterDigest !== null && !isDigest(change.afterDigest)) ||
            (change.beforeDigest === null && change.afterDigest === null) ||
            change.beforeDigest === change.afterDigest) {
            throw promotionBundleCorrupt('Exact candidate digest entry is invalid.');
        }
        return { ...change };
    });
    assertSortedUniquePaths(verified.map((change) => change.path), 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    return verified;
}
function assertFilesMatchChanges(files, changes, side) {
    const expected = changes
        .filter((change) => change[side] !== null)
        .map((change) => ({ path: change.path, digest: change[side] }));
    if (files.length !== expected.length ||
        files.some((file, index) => file.path !== expected[index]?.path ||
            file.contentDigest !== expected[index]?.digest)) {
        throw promotionBundleCorrupt(`Promotion file inventory does not match ${side}.`);
    }
}
function materializeBundleExecutables(paths, bundle) {
    const candidate = bundle.candidateFiles.find((file) => file.path === bundle.candidateExecutablePath);
    materializeExecutable(paths, bundle.candidateArtifact, decodeCanonicalBase64(candidate.contentBase64, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT'));
    const restart = bundle.recoveryBundle.previousFiles.find((file) => file.path === bundle.recoveryBundle.restartExecutablePath);
    materializeExecutable(paths, bundle.recoveryBundle.restartArtifact, decodeCanonicalBase64(restart.contentBase64, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT'));
}
function materializeExecutable(paths, artifact, bytes) {
    if (bytes.length === 0 ||
        bytes.length > MAX_EXECUTABLE_BYTES ||
        rawDigest(bytes) !== artifact.executableDigest) {
        throw workflowError('CONTROL_PLANE_EXECUTABLE_INVALID', 'Executable bytes do not match the engine artifact.', ExitCode.verification);
    }
    const artifactDirectory = path.join(paths.artifacts, artifact.artifactId.slice('sha256:'.length));
    ensurePrivateDirectory(artifactDirectory);
    const executablePath = path.join(artifactDirectory, 'engine');
    const existing = fs.lstatSync(executablePath, { throwIfNoEntry: false });
    if (existing) {
        assertPrivateExecutable(executablePath, artifact.executableDigest);
        return executablePath;
    }
    createPrivateExecutableExclusive(executablePath, bytes);
    assertPrivateExecutable(executablePath, artifact.executableDigest);
    return executablePath;
}
function selectSupervisorArtifact(storageRoot, current, artifact, closureDigest, record, phase, now) {
    const paths = updaterPaths(storageRoot);
    const executablePath = materializedExecutablePath(paths, artifact);
    assertConfinedExecutable(paths, executablePath, artifact.executableDigest);
    const next = withRecordDigest({
        kind: 'control-plane-supervisor-state.v1',
        repositoryId: current.repositoryId,
        activeArtifact: {
            artifactId: artifact.artifactId,
            executableDigest: artifact.executableDigest,
            closureDigest,
            executablePath,
        },
        generation: current.generation + 1,
        transition: {
            grantId: record.envelope.payload.grantId,
            txId: record.transaction.txId,
            phase,
        },
        updatedAt: exactDate(now, 'CONTROL_PLANE_SUPERVISOR_INVALID').toISOString(),
    });
    replacePrivateFileAtomicCas(paths.supervisor, current.recordDigest, serializeCanonical(next));
    return next;
}
function assertSupervisorIsOldClosure(supervisor, envelope, bundle) {
    assertSupervisorMatchesOldClosure(supervisor, envelope.payload.repositoryId, bundle);
}
function assertSupervisorMatchesOldClosure(supervisor, repositoryId, bundle) {
    if (supervisor.repositoryId !== repositoryId ||
        supervisor.activeArtifact.artifactId !==
            bundle.recoveryBundle.restartArtifact.artifactId ||
        supervisor.activeArtifact.executableDigest !==
            bundle.recoveryBundle.restartArtifact.executableDigest ||
        supervisor.activeArtifact.closureDigest !== bundle.beforeClosureDigest) {
        throw workflowError('CONTROL_PLANE_OLD_CLOSURE_MISMATCH', 'Supervisor is not selecting the exact grant-bound old closure.', ExitCode.staleState);
    }
}
function assertSupervisorIsCandidate(supervisor, bundle) {
    if (supervisor.repositoryId !== bundle.repositoryId ||
        supervisor.activeArtifact.artifactId !==
            bundle.candidateArtifact.artifactId ||
        supervisor.activeArtifact.executableDigest !==
            bundle.candidateArtifact.executableDigest ||
        supervisor.activeArtifact.closureDigest !== bundle.afterClosureDigest) {
        throw workflowError('CONTROL_PLANE_CANDIDATE_SUPERVISOR_MISMATCH', 'Supervisor is not selecting the exact candidate closure.', ExitCode.staleState);
    }
}
function runSelfTest(paths, executablePath, executableDigest, expectedClosureDigest) {
    const value = runControlPlaneProcess(paths, executablePath, executableDigest, '--control-plane-self-test');
    if (!hasExactKeys(value, ['closureDigest', 'healthy', 'kind']) ||
        value.kind !== 'control-plane-self-test.v1' ||
        typeof value.healthy !== 'boolean' ||
        value.closureDigest !== expectedClosureDigest) {
        throw processVerificationFailed('Candidate self-test response is invalid.');
    }
    return {
        healthy: value.healthy,
        closureDigest: expectedClosureDigest,
        evidenceDigest: canonicalDigest(value),
    };
}
function runRestartProbe(paths, executablePath, executableDigest, expectedClosureDigest) {
    const value = runControlPlaneProcess(paths, executablePath, executableDigest, '--control-plane-restart-probe');
    if (!hasExactKeys(value, ['closureDigest', 'kind', 'ready']) ||
        value.kind !== 'control-plane-restart.v1' ||
        value.ready !== true ||
        value.closureDigest !== expectedClosureDigest) {
        throw processVerificationFailed('Recovery restart response is invalid.');
    }
    return {
        closureDigest: expectedClosureDigest,
        evidenceDigest: canonicalDigest(value),
    };
}
function runControlPlaneProcess(paths, executablePath, executableDigest, mode) {
    assertConfinedExecutable(paths, executablePath, executableDigest);
    const cwd = path.dirname(executablePath);
    const result = childProcess.spawnSync(executablePath, [mode], {
        cwd,
        env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            LANG: 'C',
            LC_ALL: 'C',
            TMPDIR: cwd,
        },
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: PROCESS_MAX_BUFFER_BYTES,
        windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
        throw processVerificationFailed('Control-plane process did not exit cleanly.');
    }
    if (typeof result.stdout !== 'string' ||
        Buffer.byteLength(result.stdout) > PROCESS_MAX_BUFFER_BYTES) {
        throw processVerificationFailed('Control-plane process output is invalid.');
    }
    let value;
    try {
        value = JSON.parse(result.stdout.trim());
    }
    catch {
        throw processVerificationFailed('Control-plane process returned invalid JSON.');
    }
    if (!isRecord(value)) {
        throw processVerificationFailed('Control-plane process response is not an object.');
    }
    return value;
}
function emitAuditHistory(record, bundle, dependencies) {
    const prepared = createAuditRecord({
        repositoryId: bundle.repositoryId,
        ...controlPlaneAuditMandateFields(record.envelope.payload.mandateBinding),
        grantId: record.envelope.payload.grantId,
        txId: record.transaction.txId,
        grantEnvelopeDigest: canonicalDigest(record.envelope),
        promotionBundleDigest: bundle.bundleDigest,
        sequence: 0,
        event: 'prepared',
        fromState: 'PREPARED',
        toState: 'PREPARED',
        evidenceDigest: bundle.bundleDigest,
        recordedAt: record.createdAt,
    });
    dependencies.auditSink.append(prepared);
    for (const observation of record.observations) {
        dependencies.auditSink.append(createAuditRecord({
            repositoryId: bundle.repositoryId,
            ...controlPlaneAuditMandateFields(record.envelope.payload.mandateBinding),
            grantId: record.envelope.payload.grantId,
            txId: record.transaction.txId,
            grantEnvelopeDigest: canonicalDigest(record.envelope),
            promotionBundleDigest: bundle.bundleDigest,
            sequence: observation.sequence,
            event: auditEventForObservation(observation.eventKind),
            fromState: observation.fromState,
            toState: observation.toState,
            evidenceDigest: observation.evidenceDigest,
            recordedAt: observation.recordedAt,
        }));
    }
}
function createAuditRecord(input) {
    const identity = {
        kind: 'control-plane-updater-audit-id.v1',
        repositoryId: input.repositoryId,
        mandateBinding: input.mandateBinding,
        grantId: input.grantId,
        txId: input.txId,
        sequence: input.sequence,
        event: input.event,
    };
    const payload = {
        kind: 'control-plane-updater-audit.v1',
        recordId: canonicalDigest(identity),
        ...input,
    };
    return deepFreeze({ ...payload, recordDigest: canonicalDigest(payload) });
}
function controlPlaneAuditMandateFields(binding) {
    const exact = normalizeControlPlaneTaskMandateBinding(binding);
    return {
        mandateBinding: exact,
        parentTaskId: exact.parentTaskId,
        changeId: exact.changeId,
        externalAuditRoot: exact.externalAuditRoot,
    };
}
function auditEventForObservation(event) {
    switch (event) {
        case 'old-closure-verified':
            return 'old-closure-verified';
        case 'candidate-verified':
            return 'candidate-verified';
        case 'recovery-bundle-verified':
            return 'recovery-verified';
        case 'atomic-switch-completed':
            return 'switched';
        case 'self-tests-passed':
            return 'self-tested';
        case 'self-tests-failed':
            return 'rollback-required';
        case 'finalize':
            return 'finalized';
        case 'rollback-completed':
            return 'rolled-back';
        default:
            throw workflowError('CONTROL_PLANE_AUDIT_EVENT_INVALID', 'Persisted updater observation has no audit event mapping.', ExitCode.verification);
    }
}
function advanceRecord(current, storageRoot, input) {
    return advancePersistedControlPlaneUpdate(storageRoot, {
        grantId: current.envelope.payload.grantId,
        expectedJournalDigest: current.transaction.journalDigest,
        event: { kind: input.kind, at: input.at },
        evidenceDigest: input.evidenceDigest,
    });
}
function assertGrantLiveForForwardEffect(record, dependencies) {
    if (updaterNow(dependencies).getTime() >=
        Date.parse(record.envelope.payload.expiresAt)) {
        throw workflowError('CONTROL_PLANE_GRANT_EXPIRED', 'Control-Plane Grant expired before the atomic switch.', ExitCode.staleState);
    }
}
function nextTransitionTime(record, dependencies) {
    const now = updaterNow(dependencies).getTime();
    const previous = Date.parse(record.transaction.history.at(-1).at);
    return new Date(Math.max(now, previous + 1)).toISOString();
}
function persistPromotionBundle(paths, grantId, bundle) {
    const target = promotionBundlePath(paths, grantId);
    const content = serializeCanonical(bundle);
    if (fs.existsSync(target)) {
        if (readPrivateText(target, 'CONTROL_PLANE_PROMOTION_BUNDLE_NOT_FOUND') !==
            content) {
            throw workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_CONFLICT', 'Grant id is already bound to a different promotion bundle.', ExitCode.conflict);
        }
        return;
    }
    createPrivateFileExclusive(target, content);
}
function readPromotionBundle(paths, grantId) {
    const value = readCanonicalPrivateRecord(promotionBundlePath(paths, grantId), 'CONTROL_PLANE_PROMOTION_BUNDLE_NOT_FOUND');
    return verifyPromotionBundle(value);
}
function promotionBundlePath(paths, grantId) {
    assertNonEmpty(grantId, 'CONTROL_PLANE_GRANT_INVALID');
    const name = crypto
        .createHash('sha256')
        .update(`control-plane-promotion\0${grantId}`)
        .digest('hex');
    return path.join(paths.bundles, `${name}.json`);
}
function updaterPaths(storageRoot) {
    const root = interventionControlPersistencePaths(storageRoot).root;
    const operations = path.join(root, 'operations');
    return {
        root,
        supervisor: path.join(root, 'control-plane-supervisor.json'),
        approvalCandidates: path.join(root, 'control-plane-approval-candidates'),
        bundles: path.join(root, 'control-plane-promotion-bundles'),
        artifacts: path.join(root, 'control-plane-artifacts'),
        operations,
        lock: path.join(operations, 'control-plane-updater.lock'),
    };
}
function ensureUpdaterDirectories(storageRoot) {
    const paths = updaterPaths(storageRoot);
    for (const directory of [
        paths.root,
        paths.approvalCandidates,
        paths.bundles,
        paths.artifacts,
        paths.operations,
    ]) {
        ensurePrivateDirectory(directory);
    }
    return paths;
}
function ensurePrivateDirectory(directory) {
    ensurePlainDirectory(directory);
    const stats = fs.lstatSync(directory);
    if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw workflowError('CONTROL_PLANE_STORAGE_UNSAFE', 'Control-plane state directories must be private.', ExitCode.unsafeEnvironment);
    }
}
function withUpdaterLock(storageRoot, operation, callback) {
    const paths = updaterPaths(storageRoot);
    ensurePrivateDirectory(paths.root);
    ensurePrivateDirectory(paths.operations);
    const ownerToken = crypto.randomUUID();
    const content = `${canonicalJson({
        kind: 'control-plane-updater-lock.v1',
        operation,
        pid: process.pid,
        ownerToken,
    })}\n`;
    let descriptor;
    for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
        try {
            descriptor = publishPreparedExclusiveLock(paths.lock, content, ownerToken, () => workflowError('CONTROL_PLANE_UPDATER_LOCK_UNSAFE', 'Control-plane updater lock is unsafe.', ExitCode.unsafeEnvironment));
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
            const reclaimed = reclaimDeadPreparedLock(paths.lock, (raw) => {
                try {
                    const value = JSON.parse(raw);
                    if (`${canonicalJson(value)}\n` !== raw ||
                        !Number.isSafeInteger(value.pid) ||
                        typeof value.ownerToken !== 'string') {
                        return null;
                    }
                    return { pid: value.pid, ownerToken: value.ownerToken };
                }
                catch {
                    return null;
                }
            });
            if (reclaimed === 'unsafe') {
                throw workflowError('CONTROL_PLANE_UPDATER_LOCK_UNSAFE', 'Control-plane updater lock is unsafe.', ExitCode.unsafeEnvironment);
            }
            if (reclaimed === 'occupied') {
                throw workflowError('CONTROL_PLANE_UPDATER_BUSY', 'Another minimal updater process is active.', ExitCode.conflict);
            }
        }
    }
    if (descriptor === undefined) {
        throw workflowError('CONTROL_PLANE_UPDATER_BUSY', 'Could not acquire the minimal updater lock.', ExitCode.conflict);
    }
    let result;
    let failure;
    try {
        result = callback();
    }
    catch (error) {
        failure = error;
    }
    try {
        releaseUpdaterLock(paths.lock, descriptor);
    }
    catch (error) {
        failure ??= error;
    }
    if (failure !== undefined)
        throw failure;
    return result;
}
function releaseUpdaterLock(lockPath, descriptor) {
    try {
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (!observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino) {
            throw workflowError('CONTROL_PLANE_UPDATER_LOCK_UNSAFE', 'Minimal updater lost ownership of its lock.', ExitCode.unsafeEnvironment);
        }
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function materializedExecutablePath(paths, artifact) {
    return path.join(paths.artifacts, artifact.artifactId.slice('sha256:'.length), 'engine');
}
function assertConfinedExecutable(paths, executablePath, expectedDigest, expectedArtifactId) {
    if (typeof executablePath !== 'string' ||
        !path.isAbsolute(executablePath) ||
        path.resolve(executablePath) !== executablePath) {
        throw supervisorCorrupt();
    }
    const relative = path.relative(paths.artifacts, executablePath);
    if (relative.length === 0 ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        path.basename(executablePath) !== 'engine') {
        throw supervisorCorrupt();
    }
    if (expectedArtifactId !== undefined &&
        executablePath !==
            path.join(paths.artifacts, expectedArtifactId.slice('sha256:'.length), 'engine')) {
        throw supervisorCorrupt();
    }
    assertPrivateExecutable(executablePath, expectedDigest);
    if (fs.realpathSync(path.dirname(executablePath)) !==
        path.dirname(executablePath) ||
        fs.realpathSync(executablePath) !== executablePath) {
        throw supervisorCorrupt();
    }
}
function assertPrivateExecutable(executablePath, expectedDigest) {
    const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
        stats.size < 1 ||
        stats.size > MAX_EXECUTABLE_BYTES) {
        throw workflowError('CONTROL_PLANE_EXECUTABLE_UNSAFE', 'Materialized control-plane executable is unsafe.', ExitCode.unsafeEnvironment);
    }
    const descriptor = fs.openSync(executablePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            rawDigest(fs.readFileSync(descriptor)) !== expectedDigest) {
            throw workflowError('CONTROL_PLANE_EXECUTABLE_DIGEST_MISMATCH', 'Materialized executable digest changed.', ExitCode.verification);
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function createPrivateExecutableExclusive(filePath, content) {
    ensurePrivateDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    let failure;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, PRIVATE_EXECUTABLE_MODE);
        fs.fchmodSync(descriptor, PRIVATE_EXECUTABLE_MODE);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporaryPath, filePath);
        fs.unlinkSync(temporaryPath);
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
        if (!isNodeError(error) || error.code !== 'ENOENT')
            failure ??= error;
    }
    if (failure !== undefined)
        throw failure;
}
function createPrivateFileExclusive(filePath, content) {
    ensurePrivateDirectory(path.dirname(filePath));
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
        fs.unlinkSync(temporaryPath);
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
        if (!isNodeError(error) || error.code !== 'ENOENT')
            failure ??= error;
    }
    if (failure !== undefined)
        throw failure;
}
function replacePrivateFileAtomicCas(filePath, expectedDigest, content) {
    const current = readCanonicalPrivateRecord(filePath, 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND');
    if (!isRecord(current) || current.recordDigest !== expectedDigest) {
        throw workflowError('CONTROL_PLANE_SUPERVISOR_CAS_MISMATCH', 'Supervisor state changed before the atomic switch.', ExitCode.staleState);
    }
    assertPrivateRegularFile(filePath);
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
        if (!isNodeError(error) || error.code !== 'ENOENT')
            failure ??= error;
    }
    if (failure !== undefined)
        throw failure;
}
function readCanonicalPrivateRecord(filePath, notFoundCode) {
    const raw = readPrivateText(filePath, notFoundCode);
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw workflowError('CONTROL_PLANE_STATE_CORRUPT', 'Control-plane state is not valid JSON.', ExitCode.verification);
    }
    if (`${canonicalJson(value)}\n` !== raw) {
        throw workflowError('CONTROL_PLANE_STATE_CORRUPT', 'Control-plane state is not canonical JSON.', ExitCode.verification);
    }
    return value;
}
function readPrivateText(filePath, notFoundCode) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        throw workflowError(notFoundCode, 'Control-plane state was not found.', ExitCode.conflict);
    }
    assertPrivateRegularFile(filePath);
    if (stats.size > MAX_BUNDLE_BYTES) {
        throw workflowError('CONTROL_PLANE_STATE_TOO_LARGE', 'Control-plane state exceeds the maximum size.', ExitCode.guard);
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
            throw workflowError('CONTROL_PLANE_STATE_UNSAFE', 'Control-plane state changed while being opened.', ExitCode.unsafeEnvironment);
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function assertPrivateRegularFile(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw workflowError('CONTROL_PLANE_STATE_UNSAFE', 'Control-plane state must be a private regular file.', ExitCode.unsafeEnvironment);
    }
}
function serializeCanonical(value) {
    const serialized = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES) {
        throw workflowError('CONTROL_PLANE_STATE_TOO_LARGE', 'Control-plane state exceeds the maximum size.', ExitCode.guard);
    }
    return serialized;
}
function verifyEngineArtifact(artifact) {
    if (!isRecord(artifact) ||
        !hasExactKeys(artifact, [
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
        ]) ||
        artifact.kind !== 'engine-artifact.v1') {
        throw promotionBundleCorrupt('Engine artifact schema is invalid.');
    }
    const rebuilt = createEngineArtifact({
        sourceChangeId: artifact.sourceChangeId,
        sourceDigest: artifact.sourceDigest,
        executableDigest: artifact.executableDigest,
        protocolVersion: artifact.protocolVersion,
        canReadSessionSchemas: artifact.canReadSessionSchemas,
        writesSessionSchema: artifact.writesSessionSchema,
        policySchemaVersion: artifact.policySchemaVersion,
        smokeReportDigest: artifact.smokeReportDigest,
    });
    if (rebuilt.artifactId !== artifact.artifactId) {
        throw promotionBundleCorrupt('Engine artifact digest mismatch.');
    }
    return rebuilt;
}
function decodeCanonicalBase64(value, code) {
    if (typeof value !== 'string' || value.length === 0) {
        throw workflowError(code, 'Expected non-empty base64 bytes.', ExitCode.guard);
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value || bytes.length > MAX_BUNDLE_BYTES) {
        throw workflowError(code, 'Base64 bytes are non-canonical or too large.', ExitCode.guard);
    }
    return bytes;
}
function safeLogicalPath(value, code) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value !== value.normalize('NFC') ||
        value.startsWith('/') ||
        value.includes('\\') ||
        /[*?[\]{}]/.test(value) ||
        value
            .split('/')
            .some((part) => part === '' || part === '.' || part === '..')) {
        throw workflowError(code, 'Promotion contains an unsafe path.', ExitCode.guard);
    }
    return value;
}
function assertSortedUniquePaths(values, code) {
    const expected = [...new Set(values)].sort();
    if (canonicalJson(values) !== canonicalJson(expected)) {
        throw workflowError(code, 'Promotion paths must be sorted and unique.', ExitCode.guard);
    }
}
function requireUpdaterDependencies(dependencies) {
    if (dependencies?.consumedGrantIds === undefined ||
        typeof dependencies.verifyHumanSignature !== 'function' ||
        typeof dependencies.auditSink?.append !== 'function') {
        throw workflowError('CONTROL_PLANE_UPDATER_DEPENDENCY_REQUIRED', 'Minimal updater requires trusted consumption, signature, and audit dependencies.', ExitCode.guard);
    }
}
function updaterNow(dependencies) {
    return exactDate(dependencies.now?.() ?? new Date(), 'CONTROL_PLANE_UPDATER_CLOCK_INVALID');
}
function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError(code, 'Expected a valid updater clock.', ExitCode.usage);
    }
    return new Date(value.getTime());
}
function validTransition(value) {
    return (value === null ||
        (isRecord(value) &&
            hasExactKeys(value, ['grantId', 'phase', 'txId']) &&
            typeof value.grantId === 'string' &&
            value.grantId.length > 0 &&
            typeof value.txId === 'string' &&
            value.txId.length > 0 &&
            (value.phase === 'candidate-selected' ||
                value.phase === 'rollback-restored')));
}
function isCanonicalIso(value) {
    return (typeof value === 'string' &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
function assertNonEmpty(value, code) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0) {
        throw workflowError(code, 'Expected a non-empty value.', ExitCode.usage);
    }
}
function assertDigest(value, code) {
    if (!isDigest(value)) {
        throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.usage);
    }
}
function isDigest(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function rawDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function canonicalDigest(value) {
    return rawDigest(canonicalJson(value));
}
function withRecordDigest(payload) {
    return { ...payload, recordDigest: canonicalDigest(payload) };
}
function verifyRecordDigest(value) {
    if (!isDigest(value.recordDigest))
        return false;
    const { recordDigest, ...payload } = value;
    return canonicalDigest(payload) === recordDigest;
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function isRecord(value) {
    return (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
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
function promotionBundleCorrupt(message) {
    return workflowError('CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT', message, ExitCode.verification);
}
function approvalCandidateCorrupt(message = 'Persisted control-plane approval candidate failed integrity verification.') {
    return workflowError('CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT', message, ExitCode.verification);
}
function supervisorCorrupt() {
    return workflowError('CONTROL_PLANE_SUPERVISOR_CORRUPT', 'Control-plane supervisor state failed integrity verification.', ExitCode.verification);
}
function processVerificationFailed(message) {
    return workflowError('CONTROL_PLANE_PROCESS_VERIFICATION_FAILED', message, ExitCode.verification);
}
function workflowFailureCode(error) {
    return error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string'
        ? error.code
        : 'CONTROL_PLANE_PROCESS_FAILURE';
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
