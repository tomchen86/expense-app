import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, WorkflowError, workflowError } from './errors.js';
import { discoverRepository, runGit } from './git.js';
import { parseMaintainerPolicy } from './maintainer-policy.js';
import { recordAuthorityAuditEvent, verifyAuthorityAuditEvents, } from './authority-audit-service.js';
import { deriveAuthorityAuditRepositoryId, } from './authority-audit-ledger.js';
import { abandonPersistedIntervention, assertPersistedInterventionAbandonable, capturePersistedWipIntervention, discoverBootstrapUntrackedAllowlist, executePersistedAdoptionStep, initializeLocalEngineBinding, localEngineArtifactPath, materializeInterventionChildWorktree, readLocalEngineBinding, rebindLocalEngineAfterRolledBackAdoption, } from './intervention-control-bootstrap.js';
import { engineAdoptionRecordPath, preparePersistedEngineAdoption, readPersistedIntervention, recoverPersistedEngineAdoption, } from './intervention-control-persistence.js';
import { canonicalHarnessMaintenanceGrantPayload, HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE, verifyHarnessMaintenanceGrant, } from './intervention-control.js';
import { buildAndPersistInterventionEngineArtifact, maintenanceApprovalSummary, maintenanceGrantId, persistMaintenanceGrantRecord, readInterventionEngineArtifact, readMaintenanceGrantForParent, revokeMaintenanceGrantForParent, terminalizeExpiredMaintenanceGrantForParent, } from './intervention-maintenance.js';
import { runtimePaths } from './session-store.js';
const MAX_REQUEST_BYTES = 1024 * 1024;
/**
 * Effectful local-only harness-bootstrap CLI. The repository-default engine
 * channel is intentionally absent: global promotion belongs to the minimal
 * control-plane updater and cannot be requested through this dispatcher.
 */
export function dispatchBootstrapInterventionCommand(argv, cwd, dependencies = {}) {
    if (argv[0] === 'promote') {
        throw workflowError('INTERVENTION_BOOTSTRAP_GLOBAL_PROMOTION_FORBIDDEN', 'Local bootstrap adoption cannot promote a repository-default engine.', ExitCode.guard);
    }
    const repository = discoverRepository(cwd);
    const stateRoot = bootstrapInterventionStateRoot(repository.gitCommonDirectory);
    if ((argv.length === 5 &&
        argv[0] === 'change' &&
        argv[1] === 'intervene' &&
        argv[3] === '--reason') ||
        (argv.length === 5 &&
            argv[0] === 'engine' &&
            argv[1] === 'adopt' &&
            argv[3] === '--into')) {
        throw workflowError('INTERVENTION_AUTHORITY_AUDIT_ROOT_REQUIRED', 'Effectful maintenance commands require --audit-root <absolute-path>.', ExitCode.guard);
    }
    if (argv[0] === 'change' &&
        argv[1] === 'intervene' &&
        argv.length === 7 &&
        isNonEmpty(argv[2]) &&
        argv[3] === '--reason' &&
        isNonEmpty(argv[4]) &&
        argv[5] === '--audit-root' &&
        isNonEmpty(argv[6])) {
        const auditScope = maintenanceAuditScope(repository.repositoryRoot, repository.gitCommonDirectory, argv[6]);
        return dispatchHumanIntervention(argv[2], argv[4], repository.repositoryRoot, stateRoot, auditScope, dependencies, argv);
    }
    if (argv[0] === 'change' &&
        argv[1] === 'revoke-intervention' &&
        argv.length === 5 &&
        isNonEmpty(argv[2]) &&
        argv[3] === '--reason' &&
        isNonEmpty(argv[4])) {
        let before = readMaintenanceGrantForParent(stateRoot, argv[2]);
        verifyAuthorityAuditEvents({
            externalAuditRoot: before.authorityAudit.externalAuditRoot,
            repositoryRoot: repository.repositoryRoot,
            repositoryId: before.authorityAudit.repositoryId,
        });
        before = terminalizeExpiredMaintenanceGrantForParent(stateRoot, argv[2], cliNow(dependencies));
        if (before.state === 'expired') {
            refuseMaintenanceCommand(dependencies, repository.repositoryRoot, argv, before, workflowError('MAINTENANCE_GRANT_EXPIRED', 'Expired maintenance authority cannot be revoked.', ExitCode.staleState));
        }
        if (!dependencies.verifyHumanSignature) {
            throw workflowError('INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED', 'Maintenance revocation requires a trusted historical signature verifier.', ExitCode.unsafeEnvironment);
        }
        const bindingPath = parentBindingPath(stateRoot, argv[2]);
        assertPersistedInterventionAbandonable(stateRoot, bindingPath, {
            parentChangeId: argv[2],
            grantId: before.envelope.payload.grantId,
        });
        const revoked = revokeMaintenanceGrantForParent(repository.repositoryRoot, stateRoot, argv[2], {
            reason: argv[4],
            now: cliNow(dependencies),
            signer: dependencies.maintenanceSigner,
            verifyHumanSignature: dependencies.verifyHumanSignature,
            testAfterAudit: dependencies.testHooks?.afterAuthorityAuditRecorded,
        });
        const abandoned = abandonPersistedIntervention(stateRoot, bindingPath, {
            parentChangeId: argv[2],
            grantId: revoked.envelope.payload.grantId,
            grantRecordDigest: revoked.recordDigest,
            reason: revoked.revocationReason,
            at: revoked.revokedAt,
            testAfterIntentPersisted: dependencies.testHooks?.afterAbandonmentIntentPersisted,
        });
        return result({
            action: 'revoke-intervention',
            stateRoot,
            bindingPath,
            parentChangeId: argv[2],
            checkpointId: revoked.checkpointId,
            effectsPerformed: before.state !== 'revoked' || abandoned.effectsPerformed,
        });
    }
    if (argv[0] === 'engine' &&
        argv[1] === 'build-artifact' &&
        argv.length === 11 &&
        isNonEmpty(argv[2]) &&
        argv[3] === '--for' &&
        isNonEmpty(argv[4]) &&
        argv[5] === '--protocol-version' &&
        isPositiveInteger(argv[6]) &&
        argv[7] === '--policy-schema-version' &&
        isPositiveInteger(argv[8]) &&
        argv[9] === '--audit-root' &&
        isNonEmpty(argv[10])) {
        const auditScope = maintenanceAuditScope(repository.repositoryRoot, repository.gitCommonDirectory, argv[10]);
        return dispatchPersistedEngineArtifactBuild(argv[2], argv[4], Number.parseInt(argv[6], 10), Number.parseInt(argv[8], 10), stateRoot, auditScope, dependencies, argv);
    }
    if (argv[0] === 'engine' &&
        argv[1] === 'adopt' &&
        argv.length === 7 &&
        isNonEmpty(argv[2]) &&
        argv[3] === '--into' &&
        isNonEmpty(argv[4]) &&
        argv[5] === '--audit-root' &&
        isNonEmpty(argv[6])) {
        const auditScope = maintenanceAuditScope(repository.repositoryRoot, repository.gitCommonDirectory, argv[6]);
        return dispatchPersistedEngineAdoption(argv[2], argv[4], stateRoot, auditScope, dependencies, argv);
    }
    if ((argv[0] === 'worktree' && argv.includes('--grant')) ||
        (argv[0] === 'prepare-adoption' && argv.includes('--request')) ||
        (argv[0] === 'adopt' && argv.includes('--request')) ||
        (argv[0] === 'change' &&
            argv[1] === 'intervene' &&
            argv.includes('--request')) ||
        (argv[0] === 'engine' && argv[1] === 'adopt' && argv.includes('--request'))) {
        throw workflowError('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED', 'Production maintenance accepts only persisted parent, grant, checkpoint, and artifact records; caller-supplied envelopes and manifests are disabled.', ExitCode.guard);
    }
    if (argv[0] === 'checkpoint') {
        if (argv.length !== 4 || !isNonEmpty(argv[1]) || argv[2] !== '--request') {
            throw bootstrapInterventionUsageError();
        }
        const request = readCheckpointRequest(argv[3], cwd);
        if (request.parent.changeId !== argv[1]) {
            throw workflowError('INTERVENTION_BOOTSTRAP_PARENT_ARGUMENT_MISMATCH', 'Checkpoint parent argument differs from the request manifest.', ExitCode.verification);
        }
        const captured = capturePersistedWipIntervention(stateRoot, {
            repositoryRoot: repository.repositoryRoot,
            parent: request.parent,
            interventionChangeId: request.interventionChangeId,
            childWorkspacePath: request.childWorkspacePath,
            changeRef: request.changeRef,
            untrackedAllowlist: request.untrackedAllowlist,
            sessionSnapshotPath: request.sessionSnapshotPath,
            pendingIntent: request.pendingIntent,
            policyDigest: request.policyDigest,
            now: cliNow(dependencies),
        });
        return result({
            action: 'checkpoint',
            stateRoot,
            bindingPath: parentBindingPath(stateRoot, argv[1]),
            parentChangeId: argv[1],
            checkpointId: captured.intervention.checkpoint.checkpointId,
            workspaceId: captured.intervention.childWorkspace.workspaceId,
            intervention: captured.intervention,
            effectsPerformed: true,
        });
    }
    if (argv[0] === 'worktree') {
        if (argv.length !== 4 || !isNonEmpty(argv[1]) || argv[2] !== '--grant') {
            throw bootstrapInterventionUsageError();
        }
        const envelope = readMaintenanceGrantEnvelope(argv[3], cwd);
        const receipt = materializeInterventionChildWorktree(stateRoot, {
            parentChangeId: argv[1],
            repositoryRoot: repository.repositoryRoot,
            maintenanceGrantEnvelope: envelope,
        }, dependencies);
        return result({
            action: 'worktree',
            stateRoot,
            bindingPath: parentBindingPath(stateRoot, argv[1]),
            parentChangeId: argv[1],
            checkpointId: receipt.checkpointId,
            workspaceId: receipt.workspaceId,
            effectsPerformed: receipt.effectsPerformed,
        });
    }
    if (argv[0] === 'prepare-adoption') {
        if (argv.length !== 4 || !isNonEmpty(argv[1]) || argv[2] !== '--request') {
            throw bootstrapInterventionUsageError();
        }
        const parentChangeId = argv[1];
        const request = readPrepareAdoptionRequest(argv[3], cwd);
        const intervention = readPersistedIntervention(stateRoot, parentChangeId);
        const adoption = preparePersistedEngineAdoption(stateRoot, {
            txId: request.txId,
            parentChangeId,
            artifact: request.artifact,
            maintenanceGrantEnvelope: request.maintenanceGrantEnvelope,
            priorLocalAdoptions: request.priorLocalAdoptions,
        }, dependencies);
        const bindingPath = parentBindingPath(stateRoot, parentChangeId);
        const parentSession = initializeOrVerifyParentSession(stateRoot, bindingPath, intervention, adoption, request.artifact, cliNow(dependencies));
        return result({
            action: 'prepare-adoption',
            stateRoot,
            bindingPath,
            parentChangeId,
            txId: request.txId,
            checkpointId: intervention.checkpoint.checkpointId,
            workspaceId: intervention.childWorkspace.workspaceId,
            journalDigest: adoption.journal.journalDigest,
            adoptionState: adoption.journal.state,
            intervention,
            adoption,
            parentSession,
            effectsPerformed: true,
        });
    }
    if (argv[0] === 'adopt') {
        if (argv.length !== 4 || !isNonEmpty(argv[1]) || argv[2] !== '--request') {
            throw bootstrapInterventionUsageError();
        }
        const txId = argv[1];
        const request = readAdoptStepRequest(argv[3], cwd);
        const before = recoverPersistedEngineAdoption(stateRoot, txId);
        const intervention = readPersistedIntervention(stateRoot, before.record.journal.parentChangeId);
        const bindingPath = parentBindingPath(stateRoot, before.record.journal.parentChangeId);
        const now = cliNow(dependencies);
        if (readOptionalParentSession(bindingPath) === null) {
            if (!['PREPARED', 'PARENT_CHECKPOINTED'].includes(before.record.journal.state)) {
                throw workflowError('INTERVENTION_BOOTSTRAP_PARENT_SESSION_MISSING', 'Parent session metadata is missing after the engine binding may have changed.', ExitCode.unsafeEnvironment);
            }
            initializeLocalEngineBinding(stateRoot, bindingPath, {
                parentChangeId: intervention.parent.changeId,
                parentWorkspacePath: intervention.childWorkspace.parentWorkspacePath,
                parentBranch: `refs/heads/work/${intervention.parent.changeId}`,
                interventionChangeId: intervention.relationship.interventionChangeId,
                txId,
                checkpointId: intervention.checkpoint.checkpointId,
                engineDigest: intervention.parent.engineBinding,
                artifactId: request.artifact.artifactId,
                executableDigest: request.artifact.executableDigest,
                executablePath: localEngineArtifactPath(stateRoot, request.artifact.artifactId),
                sessionSchema: intervention.parent.sessionSchema,
                now,
            });
        }
        const stepped = executePersistedAdoptionStep(stateRoot, {
            txId,
            expectedJournalDigest: request.expectedJournalDigest,
            bindingPath,
            artifact: request.artifact,
            executablePath: request.executablePath,
            at: now.toISOString(),
        }, dependencies);
        const parentSession = readLocalEngineBinding(bindingPath);
        assertCommittedParentSession(stepped.record, parentSession);
        return result({
            action: 'adopt',
            stateRoot,
            bindingPath,
            parentChangeId: stepped.record.journal.parentChangeId,
            txId,
            checkpointId: stepped.record.journal.checkpointId,
            journalDigest: stepped.record.journal.journalDigest,
            adoptionState: stepped.record.journal.state,
            adoption: stepped.record,
            parentSession,
            effectsPerformed: stepped.receipt.effectsPerformed,
        });
    }
    if (argv[0] === 'recover') {
        if (argv.length !== 2 || !isNonEmpty(argv[1])) {
            throw bootstrapInterventionUsageError();
        }
        const recovered = recoverPersistedEngineAdoption(stateRoot, argv[1]);
        const bindingPath = parentBindingPath(stateRoot, recovered.record.journal.parentChangeId);
        const parentSession = readOptionalParentSession(bindingPath);
        if (parentSession === null) {
            if (recovered.decision.blockerCleared) {
                throw workflowError('INTERVENTION_BOOTSTRAP_RECOVERY_SESSION_MISMATCH', 'Recovery claims a cleared blocker but parent session metadata is missing.', ExitCode.verification);
            }
        }
        else {
            assertRecoveryParentSession(recovered.record, recovered.decision, parentSession);
        }
        return result({
            action: 'recover',
            stateRoot,
            bindingPath,
            parentChangeId: recovered.record.journal.parentChangeId,
            txId: argv[1],
            checkpointId: recovered.record.journal.checkpointId,
            journalDigest: recovered.record.journal.journalDigest,
            adoptionState: recovered.record.journal.state,
            adoption: recovered.record,
            parentSession,
            decision: recovered.decision,
            effectsPerformed: false,
        });
    }
    if (argv[0] === 'status') {
        if ((argv.length !== 2 && argv.length !== 4) ||
            !isNonEmpty(argv[1]) ||
            (argv.length === 4 && argv[2] !== '--tx') ||
            (argv.length === 4 && !isNonEmpty(argv[3]))) {
            throw bootstrapInterventionUsageError();
        }
        const parentChangeId = argv[1];
        const intervention = readPersistedIntervention(stateRoot, parentChangeId);
        const bindingPath = parentBindingPath(stateRoot, parentChangeId);
        const parentSession = readOptionalParentSession(bindingPath);
        const recovered = argv.length === 4
            ? recoverPersistedEngineAdoption(stateRoot, argv[3])
            : null;
        if (recovered !== null &&
            recovered.record.journal.parentChangeId !== parentChangeId) {
            throw workflowError('INTERVENTION_BOOTSTRAP_STATUS_BINDING_MISMATCH', 'Requested adoption transaction belongs to another parent.', ExitCode.verification);
        }
        if (recovered !== null) {
            if (parentSession === null) {
                if (recovered.decision.blockerCleared) {
                    throw workflowError('INTERVENTION_BOOTSTRAP_RECOVERY_SESSION_MISMATCH', 'Committed adoption is missing live parent session metadata.', ExitCode.verification);
                }
            }
            else {
                assertRecoveryParentSession(recovered.record, recovered.decision, parentSession);
            }
        }
        return result({
            action: 'status',
            stateRoot,
            bindingPath,
            parentChangeId,
            txId: argv.length === 4 ? argv[3] : null,
            checkpointId: intervention.checkpoint.checkpointId,
            workspaceId: intervention.childWorkspace.workspaceId,
            journalDigest: recovered?.record.journal.journalDigest ?? null,
            adoptionState: recovered?.record.journal.state ?? null,
            intervention,
            adoption: recovered?.record ?? null,
            parentSession,
            decision: recovered?.decision ?? null,
            effectsPerformed: false,
        });
    }
    throw bootstrapInterventionUsageError();
}
export function bootstrapInterventionStateRoot(gitCommonDirectory) {
    return path.join(runtimePaths(gitCommonDirectory, 'workflow-engine').root, 'intervention-control');
}
export function bootstrapInterventionUsage() {
    return [
        'Usage:',
        '  pnpm workflow change intervene <parent-change-id> --reason <text> --audit-root <absolute-path> [--json]',
        '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json]',
        '  pnpm workflow engine build-artifact <absolute-executable-path> --for <parent-change-id> --protocol-version <positive-integer> --policy-schema-version <positive-integer> --audit-root <absolute-path> [--json]',
        '  pnpm workflow engine adopt <artifact-id> --into <parent-change-id> --audit-root <absolute-path> [--json]',
        '  pnpm workflow intervention status <parent-change-id> [--tx <tx-id>] [--json]',
        '  pnpm workflow intervention recover <tx-id> [--json]',
        'Caller-supplied maintenance envelopes and adoption manifests are disabled.',
        'Global engine promotion is intentionally unavailable from this command.',
    ].join('\n');
}
function dispatchPersistedEngineArtifactBuild(executablePath, parentChangeId, protocolVersion, policySchemaVersion, stateRoot, auditScope, dependencies, argv) {
    const intervention = readPersistedIntervention(stateRoot, parentChangeId);
    let grant = readMaintenanceGrantForParent(stateRoot, parentChangeId);
    assertMaintenanceAuditBinding(grant, auditScope, auditScope.repositoryRoot, dependencies, argv);
    grant = terminalizeExpiredMaintenanceGrantForParent(stateRoot, parentChangeId, cliNow(dependencies));
    if (grant.state !== 'available') {
        refuseMaintenanceCommand(dependencies, auditScope.repositoryRoot, argv, grant, workflowError(grant.state === 'expired'
            ? 'MAINTENANCE_GRANT_EXPIRED'
            : 'MAINTENANCE_GRANT_REVOKED', 'Only active maintenance authority can build an engine artifact.', grant.state === 'expired' ? ExitCode.staleState : ExitCode.conflict));
    }
    try {
        verifyHarnessMaintenanceGrant(grant.envelope, {
            now: cliNow(dependencies),
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: requireMaintenanceVerifier(dependencies),
        });
        if (!grant.envelope.payload.scope.operations.includes('build-engine-artifact')) {
            throw workflowError('MAINTENANCE_GRANT_BUILD_NOT_AUTHORIZED', 'Maintenance authority does not permit engine artifact builds.', ExitCode.guard);
        }
        const engineArtifact = buildAndPersistInterventionEngineArtifact(stateRoot, {
            parentChangeId,
            executablePath,
            protocolVersion,
            policySchemaVersion,
            now: cliNow(dependencies),
        });
        recordMaintenanceAudit(dependencies, {
            scope: auditScope,
            actorIdentity: grant.envelope.payload.humanSigner,
            argv,
            at: engineArtifact.createdAt,
            parentChangeId,
            grantDigest: digestCanonical(grant.envelope),
            checkpointId: intervention.checkpoint.checkpointId,
            result: 'succeeded',
            outcomeDigest: engineArtifact.recordDigest,
        });
        return result({
            action: 'engine-build-artifact',
            stateRoot,
            bindingPath: parentBindingPath(stateRoot, parentChangeId),
            parentChangeId,
            checkpointId: intervention.checkpoint.checkpointId,
            workspaceId: intervention.childWorkspace.workspaceId,
            intervention,
            engineArtifact,
            effectsPerformed: true,
        });
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            refuseMaintenanceCommand(dependencies, auditScope.repositoryRoot, argv, grant, error);
        }
        throw error;
    }
}
function dispatchHumanIntervention(parentChangeId, reason, repositoryRoot, stateRoot, auditScope, dependencies, argv) {
    let intervention = readOptionalIntervention(stateRoot, parentChangeId);
    const interventionChangeId = intervention?.relationship.interventionChangeId ??
        interventionId(parentChangeId, reason);
    let grant = intervention === null
        ? null
        : readOptionalMaintenanceGrant(stateRoot, parentChangeId);
    let signer = null;
    let presentSummary = null;
    if (grant === null) {
        signer = dependencies.maintenanceSigner ?? null;
        presentSummary = dependencies.presentMaintenanceSummary ?? null;
        if (!signer || !presentSummary || !dependencies.verifyHumanSignature) {
            throw workflowError('INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED', 'Maintenance approval requires a controlling-terminal signer, summary presenter, and trusted verifier.', ExitCode.unsafeEnvironment);
        }
        verifyAuthorityAuditEvents(auditScope);
    }
    if (intervention === null) {
        const resolve = dependencies.resolveParentDurableState;
        if (!resolve) {
            throw workflowError('INTERVENTION_PARENT_DURABLE_STATE_REQUIRED', 'Human intervention requires a trusted durable parent-state resolver.', ExitCode.guard);
        }
        const durable = resolve({
            parentChangeId,
            repositoryRoot,
            stateRoot,
            reason,
        });
        if (durable.parent.changeId !== parentChangeId) {
            throw workflowError('INTERVENTION_PARENT_DURABLE_STATE_MISMATCH', 'Trusted durable parent state belongs to another change.', ExitCode.verification);
        }
        const childWorkspacePath = path.join(path.dirname(repositoryRoot), `${path.basename(repositoryRoot)}-${interventionChangeId}`);
        intervention = capturePersistedWipIntervention(stateRoot, {
            repositoryRoot,
            parent: durable.parent,
            interventionChangeId,
            childWorkspacePath,
            changeRef: `refs/heads/work/${interventionChangeId}`,
            untrackedAllowlist: discoverBootstrapUntrackedAllowlist(repositoryRoot),
            sessionSnapshotPath: durable.sessionSnapshotPath,
            pendingIntent: durable.pendingIntent,
            policyDigest: durable.policyDigest,
            now: cliNow(dependencies),
        }).intervention;
    }
    if (grant !== null) {
        assertMaintenanceAuditBinding(grant, auditScope, repositoryRoot, dependencies, argv);
        grant = terminalizeExpiredMaintenanceGrantForParent(stateRoot, parentChangeId, cliNow(dependencies));
        if (grant.state === 'expired') {
            if (grant.summary.reason !== reason) {
                refuseMaintenanceCommand(dependencies, repositoryRoot, argv, grant, workflowError('INTERVENTION_REASON_BINDING_MISMATCH', 'Expired maintenance authority was issued for a different intervention reason.', ExitCode.conflict));
            }
            grant = null;
        }
        if (grant?.state === 'revoked') {
            refuseMaintenanceCommand(dependencies, repositoryRoot, argv, grant, workflowError('MAINTENANCE_GRANT_REVOKED', 'Maintenance grant was revoked before the child workspace was materialized.', ExitCode.conflict));
        }
    }
    if (grant === null && signer === null) {
        signer = dependencies.maintenanceSigner ?? null;
        presentSummary = dependencies.presentMaintenanceSummary ?? null;
        if (!signer || !presentSummary || !dependencies.verifyHumanSignature) {
            throw workflowError('INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED', 'Maintenance renewal requires a controlling-terminal signer, summary presenter, and trusted verifier.', ExitCode.unsafeEnvironment);
        }
        verifyAuthorityAuditEvents(auditScope);
    }
    const summary = maintenanceApprovalSummary({
        parentChangeId,
        interventionChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        engineFromDigest: intervention.parent.engineBinding,
        sessionSchema: intervention.parent.sessionSchema,
        reason,
        childWorkspace: {
            path: intervention.childWorkspace.childWorkspacePath,
            changeRef: intervention.childWorkspace.changeRef,
        },
        authorityAudit: {
            externalAuditRoot: auditScope.externalAuditRoot,
            repositoryId: auditScope.repositoryId,
        },
    });
    if (grant === null) {
        const verifyHumanSignature = dependencies.verifyHumanSignature;
        if (!signer || !presentSummary || !verifyHumanSignature) {
            throw workflowError('INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED', 'Maintenance approval UI dependencies changed during authorization.', ExitCode.unsafeEnvironment);
        }
        presentSummary(summary);
        signer.assertHumanPresent();
        const humanSigner = signer.identity();
        assertCurrentTrustedMaintenanceSigner(repositoryRoot, humanSigner);
        const now = cliNow(dependencies);
        const payload = {
            kind: 'harness-maintenance-grant.v1',
            grantId: maintenanceGrantId(parentChangeId, intervention.checkpoint.checkpointId, now.toISOString(), interventionChangeId),
            parentChangeId,
            interventionChangeId,
            scope: structuredClone(summary.scope),
            waivers: [...summary.waivers],
            engineFromDigest: intervention.parent.engineBinding,
            sessionSchema: intervention.parent.sessionSchema,
            maxLocalAdoptions: 1,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
            humanSigner,
            reason,
        };
        const envelope = {
            payload,
            signature: signer.sign(canonicalHarnessMaintenanceGrantPayload(payload), HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE),
        };
        verifyHarnessMaintenanceGrant(envelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature,
        });
        grant = persistMaintenanceGrantRecord(stateRoot, {
            envelope,
            summary,
            now,
        });
        recordMaintenanceAudit(dependencies, {
            scope: auditScope,
            actorIdentity: humanSigner,
            argv,
            at: grant.createdAt,
            parentChangeId,
            grantDigest: digestCanonical(envelope),
            checkpointId: intervention.checkpoint.checkpointId,
            result: 'recorded',
            outcomeDigest: grant.recordDigest,
        });
        dependencies.testHooks?.afterMaintenanceGrantPersisted?.();
    }
    assertMaintenanceAuditBinding(grant, auditScope, repositoryRoot, dependencies, argv);
    if (grant.summary.reason !== reason) {
        refuseMaintenanceCommand(dependencies, repositoryRoot, argv, grant, workflowError('INTERVENTION_REASON_BINDING_MISMATCH', 'Persisted maintenance grant was issued for a different reason.', ExitCode.conflict));
    }
    const alreadyMaterialized = fs.existsSync(intervention.childWorkspace.childWorkspacePath);
    let receipt;
    try {
        receipt = materializeInterventionChildWorktree(stateRoot, {
            parentChangeId,
            repositoryRoot,
            maintenanceGrantEnvelope: grant.envelope,
        }, dependencies);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'MAINTENANCE_GRANT_EXPIRED') {
            const expired = terminalizeExpiredMaintenanceGrantForParent(stateRoot, parentChangeId, cliNow(dependencies));
            refuseMaintenanceCommand(dependencies, repositoryRoot, argv, expired, error);
        }
        throw error;
    }
    recordMaintenanceAudit(dependencies, {
        scope: auditScope,
        actorIdentity: grant.envelope.payload.humanSigner,
        argv,
        at: receipt.materializedAt,
        parentChangeId,
        grantDigest: digestCanonical(grant.envelope),
        checkpointId: receipt.checkpointId,
        result: 'succeeded',
        outcomeDigest: receipt.receiptDigest,
    });
    return result({
        action: 'intervene',
        stateRoot,
        bindingPath: parentBindingPath(stateRoot, parentChangeId),
        parentChangeId,
        checkpointId: receipt.checkpointId,
        workspaceId: receipt.workspaceId,
        intervention,
        effectsPerformed: receipt.effectsPerformed && !alreadyMaterialized,
    });
}
function dispatchPersistedEngineAdoption(artifactId, parentChangeId, stateRoot, auditScope, dependencies, argv) {
    const intervention = readPersistedIntervention(stateRoot, parentChangeId);
    let grant = readMaintenanceGrantForParent(stateRoot, parentChangeId);
    assertMaintenanceAuditBinding(grant, auditScope, auditScope.repositoryRoot, dependencies, argv);
    grant = terminalizeExpiredMaintenanceGrantForParent(stateRoot, parentChangeId, cliNow(dependencies));
    if (grant.state === 'expired') {
        refuseMaintenanceCommand(dependencies, auditScope.repositoryRoot, argv, grant, workflowError('MAINTENANCE_GRANT_EXPIRED', 'Expired maintenance authority cannot begin an engine adoption.', ExitCode.staleState));
    }
    if (grant.state === 'revoked') {
        refuseMaintenanceCommand(dependencies, auditScope.repositoryRoot, argv, grant, workflowError('MAINTENANCE_GRANT_REVOKED', 'Revoked maintenance authority cannot begin an engine adoption.', ExitCode.conflict));
    }
    let artifactRecord;
    try {
        artifactRecord = readInterventionEngineArtifact(stateRoot, artifactId);
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            refuseMaintenanceCommand(dependencies, auditScope.repositoryRoot, argv, grant, error);
        }
        throw error;
    }
    if (artifactRecord.parentChangeId !== parentChangeId) {
        refuseMaintenanceCommand(dependencies, auditScope.repositoryRoot, argv, grant, workflowError('INTERVENTION_ENGINE_ARTIFACT_PARENT_MISMATCH', 'Persisted engine artifact belongs to another parent intervention.', ExitCode.verification));
    }
    const txId = adoptionTransactionId(parentChangeId, artifactRecord.artifact.artifactId);
    const bindingPath = parentBindingPath(stateRoot, parentChangeId);
    let effectsPerformed = false;
    if (!fs.existsSync(engineAdoptionRecordPath(stateRoot, txId))) {
        const adoption = preparePersistedEngineAdoption(stateRoot, {
            txId,
            parentChangeId,
            artifact: artifactRecord.artifact,
            maintenanceGrantEnvelope: grant.envelope,
            priorLocalAdoptions: 0,
        }, dependencies);
        initializeOrVerifyParentSession(stateRoot, bindingPath, intervention, adoption, artifactRecord.artifact, cliNow(dependencies));
        effectsPerformed = true;
    }
    for (let step = 0; step < 16; step += 1) {
        const recovered = recoverPersistedEngineAdoption(stateRoot, txId);
        if (recovered.decision.action === 'none') {
            const parentSession = readOptionalParentSession(bindingPath);
            if (parentSession === null) {
                throw workflowError('INTERVENTION_BOOTSTRAP_PARENT_SESSION_MISSING', 'Terminal adoption is missing parent session metadata.', ExitCode.verification);
            }
            const resultKind = recovered.record.journal.state === 'COMMITTED'
                ? 'succeeded'
                : 'rolled-back';
            recordMaintenanceAudit(dependencies, {
                scope: auditScope,
                actorIdentity: grant.envelope.payload.humanSigner,
                argv,
                at: recovered.record.updatedAt,
                parentChangeId,
                grantDigest: digestCanonical(grant.envelope),
                checkpointId: intervention.checkpoint.checkpointId,
                result: resultKind,
                outcomeDigest: recovered.record.recordDigest,
            });
            return result({
                action: 'engine-adopt',
                stateRoot,
                bindingPath,
                parentChangeId,
                txId,
                checkpointId: intervention.checkpoint.checkpointId,
                workspaceId: intervention.childWorkspace.workspaceId,
                journalDigest: recovered.record.journal.journalDigest,
                adoptionState: recovered.record.journal.state,
                intervention,
                adoption: recovered.record,
                parentSession,
                decision: recovered.decision,
                effectsPerformed,
            });
        }
        const stepped = executePersistedAdoptionStep(stateRoot, {
            txId,
            expectedJournalDigest: recovered.record.journal.journalDigest,
            bindingPath,
            artifact: artifactRecord.artifact,
            executablePath: artifactRecord.executablePath,
            at: nextAdoptionTime(recovered.record, dependencies),
        }, dependencies);
        effectsPerformed ||= stepped.receipt.effectsPerformed;
        dependencies.testHooks?.afterAdoptionStep?.();
    }
    throw workflowError('INTERVENTION_ADOPTION_STEP_LIMIT_EXCEEDED', 'Engine adoption did not reach a terminal state within its bounded transition count.', ExitCode.verification);
}
function interventionId(parentChangeId, reason) {
    if (!isNonEmpty(parentChangeId) || !isNonEmpty(reason)) {
        throw workflowError('INTERVENTION_HUMAN_REQUEST_INVALID', 'Human intervention requires an exact parent change and reason.', ExitCode.usage);
    }
    return `intervention-${crypto
        .createHash('sha256')
        .update(`harness-intervention\0${parentChangeId}\0${reason}\0${crypto.randomUUID()}`)
        .digest('hex')
        .slice(0, 24)}`;
}
function adoptionTransactionId(parentChangeId, artifactId) {
    return `adoption-${crypto
        .createHash('sha256')
        .update(`local-engine-adoption\0${parentChangeId}\0${artifactId}`)
        .digest('hex')}`;
}
function readOptionalIntervention(stateRoot, parentChangeId) {
    try {
        return readPersistedIntervention(stateRoot, parentChangeId);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'INTERVENTION_PERSISTENCE_NOT_FOUND') {
            return null;
        }
        throw error;
    }
}
function readOptionalMaintenanceGrant(stateRoot, parentChangeId) {
    try {
        return readMaintenanceGrantForParent(stateRoot, parentChangeId);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'MAINTENANCE_GRANT_RECORD_NOT_FOUND') {
            return null;
        }
        throw error;
    }
}
function maintenanceAuditScope(repositoryRoot, gitCommonDirectory, requestedAuditRoot) {
    if (!path.isAbsolute(requestedAuditRoot) ||
        path.normalize(requestedAuditRoot) !== requestedAuditRoot) {
        throw workflowError('INTERVENTION_AUTHORITY_AUDIT_ROOT_INVALID', 'Maintenance commands require an exact canonical absolute audit root.', ExitCode.usage);
    }
    return Object.freeze({
        externalAuditRoot: requestedAuditRoot,
        repositoryRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(`git-common:${gitCommonDirectory}`),
    });
}
function assertCurrentTrustedMaintenanceSigner(repositoryRoot, signerIdentity) {
    let policy;
    try {
        policy = parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            'HEAD:workflow/maintainer-policy.json',
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error)
            throw error;
        throw workflowError('MAINTAINER_POLICY_INVALID', 'The current HEAD does not contain a valid maintainer policy.', ExitCode.guard);
    }
    const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
    if (origin !== policy.repository.origin ||
        !policy.trustedSigners.some(({ identity }) => identity === signerIdentity)) {
        throw workflowError('MAINTENANCE_GRANT_SIGNER_UNTRUSTED', 'Maintenance approval requires a signer trusted by the current HEAD policy.', ExitCode.guard);
    }
}
function assertMaintenanceAuditBinding(grant, scope, repositoryRoot, dependencies, argv) {
    const boundScope = Object.freeze({
        externalAuditRoot: grant.authorityAudit.externalAuditRoot,
        repositoryRoot,
        repositoryId: grant.authorityAudit.repositoryId,
    });
    verifyAuthorityAuditEvents(boundScope);
    if (grant.authorityAudit.externalAuditRoot !== scope.externalAuditRoot ||
        grant.authorityAudit.repositoryId !== scope.repositoryId) {
        refuseMaintenanceCommand(dependencies, repositoryRoot, argv, grant, workflowError('INTERVENTION_AUTHORITY_AUDIT_BINDING_MISMATCH', 'Maintenance command audit root differs from the persisted grant binding.', ExitCode.verification));
    }
}
function refuseMaintenanceCommand(dependencies, repositoryRoot, argv, grant, error) {
    const scope = Object.freeze({
        externalAuditRoot: grant.authorityAudit.externalAuditRoot,
        repositoryRoot,
        repositoryId: grant.authorityAudit.repositoryId,
    });
    verifyAuthorityAuditEvents(scope);
    const outcomeDigest = digestCanonical({
        kind: 'maintenance-command-refusal.v1',
        argv: [...argv],
        errorCode: error.code,
        grantRecordDigest: grant.recordDigest,
    });
    recordMaintenanceAudit(dependencies, {
        scope,
        actorIdentity: grant.envelope.payload.humanSigner,
        argv,
        at: grant.updatedAt,
        parentChangeId: grant.parentChangeId,
        grantDigest: digestCanonical(grant.envelope),
        checkpointId: grant.checkpointId,
        result: 'failed',
        outcomeDigest,
        errorCode: error.code,
    });
    throw error;
}
function recordMaintenanceAudit(dependencies, input) {
    const eventType = input.result === 'failed'
        ? 'error'
        : input.result === 'recorded'
            ? 'escalation-request'
            : input.result === 'revoked'
                ? 'revoke'
                : input.result === 'rolled-back'
                    ? 'rollback'
                    : 'command';
    const commandName = input.argv.slice(0, 2).join('.');
    recordAuthorityAuditEvent(input.scope, {
        eventType,
        occurredAt: input.at,
        idempotencyKey: digestCanonical({
            kind: 'maintenance-command-audit-identity.v1',
            argv: [...input.argv],
            grantDigest: input.grantDigest,
            result: input.result,
            outcomeDigest: input.outcomeDigest,
        }),
        actor: { kind: 'human', identity: input.actorIdentity },
        taskId: null,
        changeId: input.parentChangeId,
        workflowId: null,
        grantDigest: input.grantDigest,
        candidateBundleDigest: input.checkpointId,
        prestateDigest: null,
        poststateDigest: input.outcomeDigest,
        command: {
            name: commandName,
            argvDigest: digestCanonical([...input.argv]),
        },
        providerInvocation: null,
        externalEffect: null,
        result: input.result,
        outcomeDigest: input.outcomeDigest,
        errorCode: input.errorCode ?? null,
    });
    dependencies.testHooks?.afterAuthorityAuditRecorded?.();
}
function digestCanonical(value) {
    return `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(value))
        .digest('hex')}`;
}
function nextAdoptionTime(record, dependencies) {
    const previous = Date.parse(record.journal.history.at(-1).at);
    const now = cliNow(dependencies).getTime();
    return new Date(Math.max(now, previous + 1)).toISOString();
}
function result(input) {
    return {
        kind: 'bootstrap-intervention-cli-result.v1',
        bindingPath: null,
        parentChangeId: null,
        txId: null,
        checkpointId: null,
        workspaceId: null,
        journalDigest: null,
        adoptionState: null,
        intervention: null,
        adoption: null,
        parentSession: null,
        decision: null,
        engineArtifact: null,
        ...input,
    };
}
function parentBindingPath(stateRoot, parentChangeId) {
    const identity = crypto
        .createHash('sha256')
        .update(`parent-session\0${parentChangeId}`)
        .digest('hex');
    return path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
}
function initializeOrVerifyParentSession(stateRoot, bindingPath, intervention, adoption, artifact, now) {
    const existing = readOptionalParentSession(bindingPath);
    if (existing === null) {
        return initializeLocalEngineBinding(stateRoot, bindingPath, {
            parentChangeId: intervention.parent.changeId,
            parentWorkspacePath: intervention.childWorkspace.parentWorkspacePath,
            parentBranch: `refs/heads/work/${intervention.parent.changeId}`,
            interventionChangeId: intervention.relationship.interventionChangeId,
            txId: adoption.journal.txId,
            checkpointId: intervention.checkpoint.checkpointId,
            engineDigest: intervention.parent.engineBinding,
            artifactId: artifact.artifactId,
            executableDigest: artifact.executableDigest,
            executablePath: localEngineArtifactPath(stateRoot, artifact.artifactId),
            sessionSchema: intervention.parent.sessionSchema,
            now,
        });
    }
    if (existing.parentChangeId !== intervention.parent.changeId ||
        existing.parentWorkspacePath !==
            intervention.childWorkspace.parentWorkspacePath ||
        existing.parentBranch !==
            `refs/heads/work/${intervention.parent.changeId}` ||
        existing.interventionChangeId !==
            intervention.relationship.interventionChangeId ||
        existing.txId !== adoption.journal.txId ||
        existing.checkpointId !== intervention.checkpoint.checkpointId ||
        existing.engineDigest !== intervention.parent.engineBinding ||
        existing.activeArtifact.artifactId !== artifact.artifactId ||
        existing.activeArtifact.executableDigest !== artifact.executableDigest ||
        existing.activeArtifact.executablePath !==
            localEngineArtifactPath(stateRoot, artifact.artifactId) ||
        existing.sessionSchema !== intervention.parent.sessionSchema ||
        existing.interventionState !== 'active') {
        const previous = recoverPersistedEngineAdoption(stateRoot, existing.txId);
        if (previous.record.journal.state === 'ENGINE_BINDING_ROLLED_BACK' &&
            previous.record.journal.parentChangeId === intervention.parent.changeId &&
            previous.record.journal.interventionChangeId ===
                intervention.relationship.interventionChangeId &&
            previous.record.journal.checkpointId ===
                intervention.checkpoint.checkpointId &&
            existing.engineDigest === intervention.parent.engineBinding &&
            existing.interventionState === 'active') {
            return rebindLocalEngineAfterRolledBackAdoption(stateRoot, bindingPath, {
                parentChangeId: intervention.parent.changeId,
                interventionChangeId: intervention.relationship.interventionChangeId,
                txId: adoption.journal.txId,
                checkpointId: intervention.checkpoint.checkpointId,
                engineDigest: intervention.parent.engineBinding,
                artifactId: artifact.artifactId,
                executableDigest: artifact.executableDigest,
                sessionSchema: intervention.parent.sessionSchema,
                now,
            });
        }
        throw workflowError('INTERVENTION_BOOTSTRAP_PARENT_SESSION_CONFLICT', 'Existing parent session metadata does not match the intervention checkpoint.', ExitCode.conflict);
    }
    return existing;
}
function readOptionalParentSession(bindingPath) {
    try {
        return readLocalEngineBinding(bindingPath);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'BOOTSTRAP_BINDING_NOT_FOUND') {
            return null;
        }
        throw error;
    }
}
function assertCommittedParentSession(adoption, parentSession) {
    if (adoption.journal.state === 'COMMITTED' &&
        (parentSession.parentChangeId !== adoption.journal.parentChangeId ||
            parentSession.engineDigest !== adoption.journal.toEngineDigest ||
            parentSession.blocker !== null ||
            parentSession.interventionState !== 'adopted')) {
        throw workflowError('INTERVENTION_BOOTSTRAP_PARENT_FINALIZATION_INCOMPLETE', 'Committed adoption did not atomically clear the parent blocker and engine overlay.', ExitCode.verification);
    }
}
function assertRecoveryParentSession(adoption, decision, parentSession) {
    const allowedEngineDigests = adoption.journal.state === 'PARENT_CHECKPOINTED' ||
        adoption.journal.state === 'ROLLBACK_REQUIRED'
        ? new Set([
            adoption.journal.fromEngineDigest,
            adoption.journal.toEngineDigest,
        ])
        : new Set([
            ['PREPARED', 'ENGINE_BINDING_ROLLED_BACK'].includes(adoption.journal.state)
                ? adoption.journal.fromEngineDigest
                : adoption.journal.toEngineDigest,
        ]);
    const bindingMayAlreadyBeFinalized = adoption.journal.state === 'HEALTHY' ||
        adoption.journal.state === 'COMMITTED';
    const bindingIsAdopted = parentSession.interventionState === 'adopted' &&
        parentSession.blocker === null;
    if (parentSession.parentChangeId !== adoption.journal.parentChangeId ||
        parentSession.interventionChangeId !==
            adoption.journal.interventionChangeId ||
        parentSession.checkpointId !== adoption.journal.checkpointId ||
        !allowedEngineDigests.has(parentSession.engineDigest) ||
        (bindingIsAdopted && !bindingMayAlreadyBeFinalized) ||
        (!bindingIsAdopted && adoption.journal.state === 'COMMITTED') ||
        (parentSession.interventionState === 'adopted') !==
            (parentSession.blocker === null) ||
        (decision.blockerCleared &&
            (parentSession.blocker !== null ||
                parentSession.interventionState !== 'adopted' ||
                parentSession.engineDigest !== decision.authoritativeEngineDigest))) {
        throw workflowError('INTERVENTION_BOOTSTRAP_RECOVERY_SESSION_MISMATCH', 'Recovery decision and live parent session metadata disagree.', ExitCode.verification);
    }
}
function readCheckpointRequest(filePath, cwd) {
    const value = readRequestObject(filePath, cwd);
    assertExactKeys(value, [
        'changeRef',
        'childWorkspacePath',
        'interventionChangeId',
        'kind',
        'parent',
        'pendingIntent',
        'policyDigest',
        'sessionSnapshotPath',
        'untrackedAllowlist',
    ]);
    if (value.kind !== 'intervention-checkpoint-request.v1' ||
        !isRecord(value.parent)) {
        throw invalidRequest();
    }
    return value;
}
function readPrepareAdoptionRequest(filePath, cwd) {
    const value = readRequestObject(filePath, cwd);
    assertExactKeys(value, [
        'artifact',
        'kind',
        'maintenanceGrantEnvelope',
        'priorLocalAdoptions',
        'txId',
    ]);
    if (value.kind !== 'intervention-prepare-adoption-request.v1' ||
        !isRecord(value.artifact) ||
        !isRecord(value.maintenanceGrantEnvelope)) {
        throw invalidRequest();
    }
    return value;
}
function readAdoptStepRequest(filePath, cwd) {
    const value = readRequestObject(filePath, cwd);
    assertExactKeys(value, [
        'artifact',
        'executablePath',
        'expectedJournalDigest',
        'kind',
    ]);
    if (value.kind !== 'intervention-adopt-step-request.v1' ||
        !isRecord(value.artifact)) {
        throw invalidRequest();
    }
    return value;
}
function readMaintenanceGrantEnvelope(filePath, cwd) {
    const value = readRequestObject(filePath, cwd);
    assertExactKeys(value, ['payload', 'signature']);
    if (!isRecord(value.payload) || !isNonEmpty(value.signature)) {
        throw invalidRequest();
    }
    return value;
}
function readRequestObject(requestedPath, cwd) {
    const filePath = path.resolve(cwd, requestedPath);
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.size > MAX_REQUEST_BYTES) {
        throw workflowError('INTERVENTION_BOOTSTRAP_REQUEST_UNSAFE', 'Bootstrap request must be a bounded regular JSON file.', ExitCode.unsafeEnvironment);
    }
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        throw invalidRequest();
    }
    if (!isRecord(value)) {
        throw invalidRequest();
    }
    rejectPromotionIntent(value);
    return value;
}
function rejectPromotionIntent(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            rejectPromotionIntent(item);
        return;
    }
    if (!isRecord(value))
        return;
    for (const [key, child] of Object.entries(value)) {
        if ([
            'defaultEngine',
            'globalPromotion',
            'promote',
            'repositoryDefault',
        ].includes(key)) {
            throw workflowError('INTERVENTION_BOOTSTRAP_GLOBAL_PROMOTION_FORBIDDEN', 'Bootstrap request contains repository-default promotion intent.', ExitCode.guard);
        }
        rejectPromotionIntent(child);
    }
}
function assertExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const canonicalExpected = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
        throw invalidRequest();
    }
}
function cliNow(dependencies) {
    const now = dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw workflowError('INTERVENTION_BOOTSTRAP_CLOCK_INVALID', 'Bootstrap CLI clock returned an invalid date.', ExitCode.unsafeEnvironment);
    }
    return new Date(now.getTime());
}
function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype);
}
function isNonEmpty(value) {
    return (typeof value === 'string' && value.trim() === value && value.length > 0);
}
function isPositiveInteger(value) {
    return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}
function requireMaintenanceVerifier(dependencies) {
    if (!dependencies.verifyHumanSignature) {
        throw workflowError('INTERVENTION_MAINTENANCE_VERIFIER_REQUIRED', 'Maintenance artifact build requires a trusted signature verifier.', ExitCode.unsafeEnvironment);
    }
    return dependencies.verifyHumanSignature;
}
function invalidRequest() {
    return workflowError('INTERVENTION_BOOTSTRAP_REQUEST_INVALID', 'Bootstrap request manifest does not match its exact command schema.', ExitCode.usage);
}
function bootstrapInterventionUsageError() {
    return workflowError('INTERVENTION_BOOTSTRAP_USAGE', bootstrapInterventionUsage(), ExitCode.usage);
}
