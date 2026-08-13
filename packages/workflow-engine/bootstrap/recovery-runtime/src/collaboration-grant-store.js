import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT, COLLABORATION_GRANT_REPLAY_SCOPE, COLLABORATION_GRANT_RESIDUALS, COLLABORATION_GRANT_RETAINED_OBLIGATIONS, assertCollaborationGrantId, canonicalCollaborationGrantEnvelope, collaborationGrantEnvelopeDigest, directHumanReviewAttestationDigest, bindingFromPayload, parseCollaborationGrantEnvelope, parseDirectHumanReviewAttestation, validateCollaborationGrantEnvelope, validateDirectHumanReviewAttestation, } from './collaboration-grant.js';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.js';
import { ExitCode, workflowError } from './errors.js';
import { ensurePlainDirectory } from './filesystem-safety.js';
import { discoverRepository, runGit } from './git.js';
import { parseMaintainerPolicy, } from './maintainer-policy.js';
import { createInteractiveSshSigner, } from './maintainer-signer.js';
import { runtimePaths, withRepositoryLifecycleOperation, } from './session-store.js';
import { assertHumanRevocationAuthorization, authorizeHumanRevocation, canonicalHumanRevocationAuthorization, digestHumanRevocationSubject, } from './human-revocation.js';
import { inspectTaskMandate } from './task-mandate.js';
const DIGEST = /^[0-9a-f]{64}$/;
const STATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
export function collaborationGrantStorePaths(gitCommonDirectory) {
    const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
    const root = path.join(runtime.root, 'collaboration-grants');
    return {
        runtime,
        root,
        available: path.join(root, 'available'),
        reserved: path.join(root, 'reserved'),
        terminal: path.join(root, 'terminal'),
        revocationAuthorizations: path.join(root, 'revocation-authorizations'),
    };
}
export function storeAvailableCollaborationGrant(gitCommonDirectory, envelope) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    const parsed = parseCollaborationGrantEnvelope(canonicalCollaborationGrantEnvelope(envelope));
    const grantId = assertCollaborationGrantId(parsed.payload.grantId);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        ensureStoreDirectories(paths);
        assertOwned();
        assertNoState(paths, grantId);
        const target = statePath(paths.available, grantId);
        createPrivateFileAtomic(target, canonicalCollaborationGrantEnvelope(parsed));
        return target;
    });
}
/**
 * Verify and atomically reserve one exact grant against repository facts.
 * Validation and `reservedAt` share the same engine-owned clock value; callers
 * cannot substitute a no-op validation callback or a second timestamp.
 */
export function reserveCollaborationGrant(cwd, requestedGrantId, request) {
    const repository = discoverRepository(cwd);
    const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => reserveCollaborationGrantUnderLifecycleLock(cwd, requestedGrantId, request, assertOwned));
}
export function reserveCollaborationGrantUnderLifecycleLock(cwd, requestedGrantId, request, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(request.transitionDigest, 'transition digest');
    const repository = discoverRepository(cwd);
    const baselineCommit = exactRepositoryCommit(repository.repositoryRoot, request.expected.baselineCommit);
    const baselineTree = runGit(repository.repositoryRoot, [
        'rev-parse',
        `${baselineCommit}^{tree}`,
    ]).trim();
    const mergeBase = runGit(repository.repositoryRoot, [
        'merge-base',
        baselineCommit,
        repository.head,
    ]).trim();
    if (mergeBase !== baselineCommit) {
        throw bindingMismatch();
    }
    const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
    const policyBlob = runGit(repository.repositoryRoot, [
        'rev-parse',
        `${baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    const origin = runGit(repository.repositoryRoot, [
        'remote',
        'get-url',
        'origin',
    ]).trim();
    if (request.expected.baselineTree !== baselineTree ||
        request.expected.policyBlob !== policyBlob ||
        request.expected.repositoryId !== policy.repository.id ||
        request.expected.repositoryOrigin !== policy.repository.origin ||
        origin !== policy.repository.origin) {
        throw bindingMismatch();
    }
    const now = exactDate(request.now ?? new Date());
    const verifier = request.verifier ??
        createInteractiveSshSigner(repository.repositoryRoot, policy);
    const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        throw unavailableGrant(grantId);
    }
    assertNonterminalUnambiguous(paths, grantId);
    if (fs.existsSync(statePath(paths.reserved, grantId))) {
        throw unavailableGrant(grantId);
    }
    const availablePath = statePath(paths.available, grantId);
    if (!fs.existsSync(availablePath)) {
        throw unavailableGrant(grantId);
    }
    const envelope = readAvailable(availablePath, grantId);
    try {
        validateCollaborationGrantEnvelope(envelope, policy, {
            now,
            expected: request.expected,
            verifier,
        });
    }
    catch (error) {
        if (error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'COLLABORATION_GRANT_EXPIRED') {
            const terminal = {
                schemaVersion: 1,
                state: 'expired',
                grantId,
                transitionDigest,
                reason: 'Grant expired before reservation',
                recordedAt: now.toISOString(),
                envelope,
                use: null,
            };
            assertOwned();
            createPrivateFileAtomic(terminalPath, serialize(terminal));
            cleanupNonterminal(paths, grantId, envelope, transitionDigest);
        }
        throw error;
    }
    assertOwned();
    const record = {
        schemaVersion: 1,
        state: 'reserved',
        grantId,
        transitionDigest,
        repositoryRoot: repository.repositoryRoot,
        reservedAt: now.toISOString(),
        envelope,
    };
    const reservedPath = statePath(paths.reserved, grantId);
    fs.renameSync(availablePath, reservedPath);
    fsyncDirectory(paths.available);
    fsyncDirectory(paths.reserved);
    replacePrivateFileAtomic(reservedPath, serialize(record));
    assertOwned();
    return deepFreeze(record);
}
/**
 * Select and reserve a signed caller-supplied or direct-human grant without
 * asking the lifecycle caller to trust actor or reason fields from an
 * unverified local envelope. The caller supplies only immutable transition
 * facts and the forms it is prepared to admit. The complete binding and its
 * transition digest are derived from the signed payload after those facts
 * match.
 *
 * Repeating the exact selection reuses an existing durable reservation. That
 * replay verifies the signed envelope again but does not add a second
 * wall-clock freshness rule after the grant was reserved while valid.
 */
export function selectAndReserveCollaborationGrantUnderLifecycleLock(cwd, requestedGrantId, request, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const allowedDegradedForms = assertSelectableDegradedForms(request.allowedDegradedForms);
    const repository = discoverRepository(cwd);
    const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        throw unavailableGrant(grantId);
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservedPath = statePath(paths.reserved, grantId);
    if (fs.existsSync(reservedPath)) {
        const reservation = readReservation(reservedPath, grantId);
        const expectedBinding = assertSelectedGrantBinding(reservation.envelope, request.expectedCore, allowedDegradedForms);
        const transitionDigest = collaborationRoleTransitionDigest(expectedBinding);
        if (reservation.repositoryRoot !== repository.repositoryRoot ||
            reservation.transitionDigest !== transitionDigest) {
            throw bindingMismatch();
        }
        const context = loadSelectionValidationContext(repository.repositoryRoot, request.expectedCore, request.now, request.verifier);
        validateCollaborationGrantEnvelope(reservation.envelope, context.policy, {
            now: context.now,
            expected: expectedBinding,
            verifier: context.verifier,
            allowExpired: true,
        });
        assertOwned();
        return deepFreeze({ reservation, expectedBinding });
    }
    const availablePath = statePath(paths.available, grantId);
    if (!fs.existsSync(availablePath)) {
        throw unavailableGrant(grantId);
    }
    const available = readAvailable(availablePath, grantId);
    const expectedBinding = assertSelectedGrantBinding(available, request.expectedCore, allowedDegradedForms);
    const reservation = reserveCollaborationGrantUnderLifecycleLock(repository.repositoryRoot, grantId, {
        transitionDigest: collaborationRoleTransitionDigest(expectedBinding),
        expected: expectedBinding,
        ...(request.now === undefined ? {} : { now: request.now }),
        ...(request.verifier === undefined ? {} : { verifier: request.verifier }),
    }, assertOwned);
    return deepFreeze({
        reservation,
        expectedBinding: bindingFromPayload(reservation.envelope.payload),
    });
}
export function readReservedCollaborationGrant(gitCommonDirectory, requestedGrantId) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => readReservedCollaborationGrantUnderLifecycleLock(gitCommonDirectory, requestedGrantId, assertOwned));
}
export function readReservedCollaborationGrantUnderLifecycleLock(gitCommonDirectory, requestedGrantId, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        throw unavailableGrant(grantId);
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservation = readReservation(statePath(paths.reserved, grantId), grantId);
    assertOwned();
    return reservation;
}
export function consumeCollaborationGrant(gitCommonDirectory, requestedGrantId, request) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => consumeCollaborationGrantUnderLifecycleLock(gitCommonDirectory, requestedGrantId, request, assertOwned));
}
export function consumeCollaborationGrantUnderLifecycleLock(gitCommonDirectory, requestedGrantId, request, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(request.transitionDigest, 'transition digest');
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        if (terminal.state !== 'consumed' ||
            !terminal.use ||
            !consumptionMatches(terminal.use, request, transitionDigest)) {
            throw unavailableGrant(grantId);
        }
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        return inspectTerminal(terminal);
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservation = readReservation(statePath(paths.reserved, grantId), grantId);
    if (reservation.transitionDigest !== transitionDigest) {
        throw unavailableGrant(grantId);
    }
    let assignment;
    let structuredContent;
    let directHumanReviewAttestation;
    try {
        assignment = assertGrantedAssignment(request.assignment, reservation.envelope);
        const contentAdmission = assertContentAdmission(request.contentAdmission, reservation.envelope.payload.lifecyclePhase);
        structuredContent = {
            kind: contentAdmission.kind,
            nodeId: contentAdmission.nodeId,
            resultDigest: contentAdmission.resultDigest,
        };
        directHumanReviewAttestation = assertDirectHumanAttestationReference(request.directHumanReviewAttestation ?? null, assignment, reservation.envelope, transitionDigest, structuredContent);
    }
    catch (error) {
        const failed = {
            schemaVersion: 1,
            state: 'failed',
            grantId,
            transitionDigest,
            reason: 'Exact role-result content admission failed',
            recordedAt: exactDate(request.now ?? new Date()).toISOString(),
            envelope: reservation.envelope,
            use: null,
        };
        assertOwned();
        createPrivateFileAtomic(terminalPath, serialize(failed));
        cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
        assertOwned();
        throw error;
    }
    const use = {
        schemaVersion: 1,
        grantId,
        signedEnvelopeDigest: collaborationGrantEnvelopeDigest(reservation.envelope),
        transitionDigest,
        reservedAt: reservation.reservedAt,
        lifecyclePhase: reservation.envelope.payload.lifecyclePhase,
        targetDigest: reservation.envelope.payload.targetDigest,
        degradedForm: reservation.envelope.payload.degradedForm,
        authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
        assignment,
        structuredContent,
        contentAuthority: 'reference-only-requires-governing-validator',
        directHumanReviewAttestation,
        retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
        replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
        residuals: COLLABORATION_GRANT_RESIDUALS,
        envelope: reservation.envelope,
    };
    const terminal = {
        schemaVersion: 1,
        state: 'consumed',
        grantId,
        transitionDigest,
        reason: 'Exact structured collaboration reference bound; governing validation remains required',
        recordedAt: exactDate(request.now ?? new Date()).toISOString(),
        envelope: reservation.envelope,
        use,
    };
    assertOwned();
    createPrivateFileAtomic(terminalPath, serialize(terminal));
    cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
    assertOwned();
    return inspectTerminal(terminal);
}
export function readExactConsumedCollaborationGrantUse(gitCommonDirectory, requestedGrantId, request) {
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(request.transitionDigest, 'transition digest');
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    existingStateDirectories(paths);
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        assertResidualCopiesMatch(paths, grantId, terminal.envelope, terminal.transitionDigest);
        if (terminal.state !== 'consumed' ||
            terminal.use === null ||
            !consumptionMatches(terminal.use, request, transitionDigest)) {
            throw unavailableGrant(grantId);
        }
        return terminal.use;
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservedPath = statePath(paths.reserved, grantId);
    if (fs.existsSync(reservedPath)) {
        const reservation = readReservation(reservedPath, grantId);
        if (reservation.transitionDigest !== transitionDigest) {
            throw unavailableGrant(grantId);
        }
        const assignment = assertGrantedAssignment(request.assignment, reservation.envelope);
        const contentAdmission = assertContentAdmission(request.contentAdmission, reservation.envelope.payload.lifecyclePhase);
        assertDirectHumanAttestationReference(request.directHumanReviewAttestation ?? null, assignment, reservation.envelope, transitionDigest, {
            kind: contentAdmission.kind,
            nodeId: contentAdmission.nodeId,
            resultDigest: contentAdmission.resultDigest,
        });
        return null;
    }
    const availablePath = statePath(paths.available, grantId);
    if (fs.existsSync(availablePath)) {
        readAvailable(availablePath, grantId);
    }
    return null;
}
/**
 * Recompute the portable, trust-relevant meaning of a consumed collaboration
 * grant without reading Git-common-dir bearer state. Local and CI callers must
 * supply independently derived assignment and current content admission facts;
 * references stored in the use projection never validate themselves.
 */
export function validateCollaborationGrantUseProjection(value, options) {
    if (!isRecord(value)) {
        throw invalidUse();
    }
    let envelope;
    let use;
    try {
        envelope = parseCollaborationGrantEnvelope(`${JSON.stringify(value.envelope)}\n`);
        use = assertStoredUse(value, envelope);
        validateCollaborationGrantEnvelope(envelope, options.policy, {
            now: exactDate(options.now),
            expected: options.expectedBinding,
            verifier: options.verifier,
            allowExpired: true,
        });
    }
    catch (error) {
        if (error &&
            typeof error === 'object' &&
            'code' in error &&
            String(error.code).startsWith('COLLABORATION_SIGNATURE')) {
            throw error;
        }
        throw invalidUse();
    }
    const transitionDigest = exactDigest(options.transitionDigest, 'transition digest');
    const expectedAssignment = assertGrantedAssignment(options.expectedAssignment, envelope);
    const contentAdmission = assertContentAdmission(options.contentAdmission, envelope.payload.lifecyclePhase);
    if (use.transitionDigest !== transitionDigest ||
        JSON.stringify(use.assignment) !== JSON.stringify(expectedAssignment) ||
        JSON.stringify(use.structuredContent) !==
            JSON.stringify({
                kind: contentAdmission.kind,
                nodeId: contentAdmission.nodeId,
                resultDigest: contentAdmission.resultDigest,
            })) {
        throw invalidUse();
    }
    if (envelope.payload.degradedForm === 'direct-human-review') {
        if (!use.directHumanReviewAttestation) {
            throw invalidUse();
        }
        try {
            validateDirectHumanReviewAttestation(use.directHumanReviewAttestation, {
                now: exactDate(options.now),
                grantEnvelope: envelope,
                policy: options.policy,
                verifier: options.verifier,
                transitionDigest,
                reviewNodeId: contentAdmission.nodeId,
                reviewResultDigest: contentAdmission.resultDigest,
            });
        }
        catch (error) {
            if (error &&
                typeof error === 'object' &&
                'code' in error &&
                String(error.code).startsWith('COLLABORATION_SIGNATURE')) {
                throw error;
            }
            throw invalidUse();
        }
    }
    return use;
}
/**
 * Validate the complete tracked closure, not merely one projection. A locally
 * consumed grant is still cooperative common-dir state; history-wide one-use
 * follows only when the governing transition passes every projected use
 * through this aggregate validator.
 */
export function validateCollaborationGrantUseSet(entries) {
    if (!Array.isArray(entries)) {
        throw invalidUse();
    }
    const uses = entries.map(({ value, options }) => validateCollaborationGrantUseProjection(value, options));
    const grantIds = new Set();
    const envelopeDigests = new Set();
    for (const use of uses) {
        if (grantIds.has(use.grantId) ||
            envelopeDigests.has(use.signedEnvelopeDigest)) {
            throw invalidUse();
        }
        grantIds.add(use.grantId);
        envelopeDigests.add(use.signedEnvelopeDigest);
    }
    return Object.freeze(uses);
}
export function failCollaborationReservation(gitCommonDirectory, requestedGrantId, requestedTransitionDigest, reason, now = new Date()) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => failCollaborationReservationUnderLifecycleLock(gitCommonDirectory, requestedGrantId, requestedTransitionDigest, reason, now, assertOwned));
}
export function failCollaborationReservationUnderLifecycleLock(gitCommonDirectory, requestedGrantId, requestedTransitionDigest, reason, now, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(requestedTransitionDigest, 'transition digest');
    const terminalReason = nonEmpty(reason, 'failure reason');
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        if (terminal.state !== 'failed' ||
            terminal.transitionDigest !== transitionDigest ||
            terminal.reason !== terminalReason) {
            throw unavailableGrant(grantId);
        }
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        return inspectTerminal(terminal);
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservation = readReservation(statePath(paths.reserved, grantId), grantId);
    if (reservation.transitionDigest !== transitionDigest) {
        throw unavailableGrant(grantId);
    }
    const terminal = {
        schemaVersion: 1,
        state: 'failed',
        grantId,
        transitionDigest,
        reason: terminalReason,
        recordedAt: exactDate(now).toISOString(),
        envelope: reservation.envelope,
        use: null,
    };
    assertOwned();
    createPrivateFileAtomic(terminalPath, serialize(terminal));
    cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
    assertOwned();
    return inspectTerminal(terminal);
}
export function revokeCollaborationGrant(cwd, requestedGrantId, options) {
    const repository = discoverRepository(cwd);
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        assertOwned();
        const target = readCollaborationRevocationTarget(paths, grantId, assertOwned);
        const payload = target.envelope.payload;
        const historicalPolicy = loadPolicyAtCommit(repository.repositoryRoot, payload.baselineCommit);
        const historicalVerifier = options.verifier ??
            createInteractiveSshSigner(repository.repositoryRoot, historicalPolicy);
        validateCollaborationGrantEnvelope(target.envelope, historicalPolicy, {
            now: exactDate(options.now ?? new Date()),
            expected: bindingFromPayload(payload),
            verifier: historicalVerifier,
            allowExpired: true,
        });
        let audit = null;
        if (payload.taskId !== null) {
            const mandate = inspectTaskMandate(repository.repositoryRoot, payload.taskId, {
                now: options.now,
                signer: options.verifier ?? options.signer,
            });
            if (mandate.legacyReadOnly ||
                mandate.changeId !== payload.changeId ||
                mandate.externalAuditRoot === undefined) {
                throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Collaboration revocation task mandate binding is unavailable or different.', ExitCode.guard);
            }
            audit = {
                externalAuditRoot: mandate.externalAuditRoot,
                repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
            };
        }
        const authorization = authorizeHumanRevocation(repository.repositoryRoot, {
            subjectKind: 'collaboration-grant',
            grantId,
            grantDigest: digestHumanRevocationSubject(canonicalCollaborationGrantEnvelope(target.envelope)),
            repositoryId: payload.repositoryId,
            repositoryOrigin: payload.repositoryOrigin,
            changeId: payload.changeId,
            taskId: payload.taskId,
            workflowId: null,
            audit,
        }, options, path.join(paths.revocationAuthorizations, `${grantId}.json`), target.authorization);
        return terminallyRevokeCollaborationGrant(paths, target, authorization, assertOwned);
    });
}
function readCollaborationRevocationTarget(paths, grantId, assertOwned) {
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        return {
            state: terminal.state,
            envelope: terminal.envelope,
            transitionDigest: terminal.transitionDigest,
            reason: terminal.reason,
            authorization: terminal.revocationAuthorization ?? null,
        };
    }
    assertNonterminalUnambiguous(paths, grantId);
    const availablePath = statePath(paths.available, grantId);
    const reservedPath = statePath(paths.reserved, grantId);
    const available = fs.existsSync(availablePath)
        ? readAvailable(availablePath, grantId)
        : undefined;
    const reservation = fs.existsSync(reservedPath)
        ? readReservationOrInterrupted(reservedPath, grantId)
        : undefined;
    if (!available && !reservation)
        throw grantNotFound(grantId);
    const envelope = available ?? reservation?.envelope;
    if (!envelope ||
        (available &&
            reservation &&
            canonicalCollaborationGrantEnvelope(available) !==
                canonicalCollaborationGrantEnvelope(reservation.envelope))) {
        throw ambiguousGrant(grantId);
    }
    return {
        state: reservation ? 'reserved' : 'available',
        envelope,
        transitionDigest: reservation?.transitionDigest ?? null,
        reason: null,
        authorization: null,
    };
}
function terminallyRevokeCollaborationGrant(paths, target, rawAuthorization, assertOwned) {
    const authorization = assertHumanRevocationAuthorization(rawAuthorization);
    const grantId = target.envelope.payload.grantId;
    if (authorization.payload.subjectKind !== 'collaboration-grant' ||
        authorization.payload.grantId !== grantId) {
        throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Collaboration revocation authorization is bound elsewhere.', ExitCode.conflict);
    }
    if (target.state === 'revoked') {
        if (target.reason !== authorization.payload.reason ||
            target.authorization === null ||
            canonicalHumanRevocationAuthorization(target.authorization) !==
                canonicalHumanRevocationAuthorization(authorization)) {
            throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Collaboration grant already has a different revocation tombstone.', ExitCode.conflict);
        }
        return inspectTerminal(readTerminal(statePath(paths.terminal, grantId), grantId));
    }
    if (target.state !== 'available' && target.state !== 'reserved') {
        throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Only active collaboration authority can be revoked.', ExitCode.guard);
    }
    const terminal = {
        schemaVersion: 1,
        state: 'revoked',
        grantId,
        transitionDigest: target.transitionDigest,
        reason: authorization.payload.reason,
        recordedAt: authorization.payload.revokedAt,
        envelope: target.envelope,
        use: null,
        revocationAuthorization: authorization,
    };
    assertOwned();
    createPrivateFileAtomic(statePath(paths.terminal, grantId), serialize(terminal));
    cleanupNonterminal(paths, grantId, target.envelope, target.transitionDigest);
    assertOwned();
    return inspectTerminal(terminal);
}
export function inspectCollaborationGrants(gitCommonDirectory, requestedGrantId) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => inspectCollaborationGrantsUnderLifecycleLock(gitCommonDirectory, requestedGrantId, assertOwned));
}
/**
 * Read one durable grant state without acquiring a lifecycle lock or creating,
 * chmodding, repairing, or otherwise changing the collaboration store. This is
 * the status/replay surface; transition callers use the locked APIs above.
 */
export function readCollaborationGrantInspection(gitCommonDirectory, requestedGrantId) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    if (!assertExistingStoreReadOnlySafe(paths))
        return null;
    return (inspectOne(paths, assertCollaborationGrantId(requestedGrantId)) ?? null);
}
/**
 * List every durable grant state through the same strict, mutation-free reader
 * used by status replay. This deliberately does not acquire the repository
 * lifecycle lock or create/repair any store directory.
 */
export function listCollaborationGrantInspections(gitCommonDirectory) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    if (!assertExistingStoreReadOnlySafe(paths))
        return Object.freeze([]);
    const grantIds = [
        ...new Set(existingStateDirectories(paths).flatMap(({ directory }) => listGrantIds(directory))),
    ].sort();
    return Object.freeze(grantIds.flatMap((grantId) => {
        const inspection = inspectOne(paths, grantId);
        return inspection === undefined ? [] : [inspection];
    }));
}
export function inspectCollaborationGrantsUnderLifecycleLock(gitCommonDirectory, requestedGrantId, assertOwned) {
    assertOwned();
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const grantId = requestedGrantId
        ? assertCollaborationGrantId(requestedGrantId)
        : undefined;
    const directories = existingStateDirectories(paths);
    const grantIds = grantId
        ? [grantId]
        : [
            ...new Set(directories.flatMap(({ directory }) => listGrantIds(directory))),
        ].sort();
    const inspected = grantIds.map((id) => inspectOne(paths, id));
    if (grantId && inspected[0] === undefined) {
        throw grantNotFound(grantId);
    }
    const results = inspected.filter((entry) => entry !== undefined);
    assertOwned();
    return results;
}
function inspectOne(paths, grantId) {
    const availablePath = statePath(paths.available, grantId);
    const reservedPath = statePath(paths.reserved, grantId);
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        assertResidualCopiesMatch(paths, grantId, terminal.envelope, terminal.transitionDigest);
        return inspectTerminal(terminal);
    }
    assertNonterminalUnambiguous(paths, grantId);
    if (fs.existsSync(availablePath)) {
        return inspectEnvelope(readAvailable(availablePath, grantId), 'available');
    }
    if (fs.existsSync(reservedPath)) {
        const reservation = readReservation(reservedPath, grantId);
        return {
            ...inspectEnvelope(reservation.envelope, 'reserved'),
            transitionDigest: reservation.transitionDigest,
        };
    }
    return undefined;
}
function inspectEnvelope(envelope, state) {
    return deepFreeze({
        grantId: envelope.payload.grantId,
        state,
        changeId: envelope.payload.changeId,
        taskId: envelope.payload.taskId,
        lifecyclePhase: envelope.payload.lifecyclePhase,
        targetDigest: envelope.payload.targetDigest,
        degradedForm: envelope.payload.degradedForm,
        issuedAt: envelope.payload.issuedAt,
        expiresAt: envelope.payload.expiresAt,
        signer: envelope.payload.signer,
        signedEnvelopeDigest: collaborationGrantEnvelopeDigest(envelope),
    });
}
function inspectTerminal(terminal) {
    return deepFreeze({
        ...inspectEnvelope(terminal.envelope, 'available'),
        state: terminal.state,
        ...(terminal.transitionDigest
            ? { transitionDigest: terminal.transitionDigest }
            : {}),
        terminalReason: terminal.reason,
        ...(terminal.use ? { use: terminal.use } : {}),
    });
}
function readAvailable(filePath, grantId) {
    const envelope = parseCollaborationGrantEnvelope(readPrivateFile(filePath));
    if (envelope.payload.grantId !== grantId) {
        throw ambiguousGrant(grantId);
    }
    return envelope;
}
function readReservation(filePath, grantId) {
    const value = parseRecord(readPrivateFile(filePath));
    const envelope = parseCollaborationGrantEnvelope(`${JSON.stringify(value.envelope)}\n`);
    if (!hasExactKeys(value, [
        'schemaVersion',
        'state',
        'grantId',
        'transitionDigest',
        'repositoryRoot',
        'reservedAt',
        'envelope',
    ]) ||
        value.schemaVersion !== 1 ||
        value.state !== 'reserved' ||
        value.grantId !== grantId ||
        typeof value.transitionDigest !== 'string' ||
        !DIGEST.test(value.transitionDigest) ||
        typeof value.reservedAt !== 'string' ||
        !isExactTimestamp(value.reservedAt) ||
        Date.parse(value.reservedAt) < Date.parse(envelope.payload.issuedAt) ||
        Date.parse(value.reservedAt) > Date.parse(envelope.payload.expiresAt) ||
        typeof value.repositoryRoot !== 'string' ||
        !path.isAbsolute(value.repositoryRoot)) {
        throw ambiguousGrant(grantId);
    }
    if (envelope.payload.grantId !== grantId) {
        throw ambiguousGrant(grantId);
    }
    return deepFreeze({
        ...value,
        envelope,
    });
}
function readReservationOrInterrupted(filePath, grantId) {
    try {
        return readReservation(filePath, grantId);
    }
    catch {
        try {
            return { envelope: readAvailable(filePath, grantId) };
        }
        catch {
            throw ambiguousGrant(grantId);
        }
    }
}
function readTerminal(filePath, grantId) {
    const value = parseRecord(readPrivateFile(filePath));
    const hasAuthorization = Object.prototype.hasOwnProperty.call(value, 'revocationAuthorization');
    if (!hasExactKeys(value, [
        'schemaVersion',
        'state',
        'grantId',
        'transitionDigest',
        'reason',
        'recordedAt',
        'envelope',
        'use',
        ...(hasAuthorization ? ['revocationAuthorization'] : []),
    ]) ||
        value.schemaVersion !== 1 ||
        !['revoked', 'consumed', 'failed', 'expired'].includes(String(value.state)) ||
        value.grantId !== grantId ||
        (value.transitionDigest !== null &&
            (typeof value.transitionDigest !== 'string' ||
                !DIGEST.test(value.transitionDigest))) ||
        typeof value.reason !== 'string' ||
        value.reason.trim().length === 0 ||
        typeof value.recordedAt !== 'string' ||
        !isExactTimestamp(value.recordedAt)) {
        throw ambiguousGrant(grantId);
    }
    const envelope = parseCollaborationGrantEnvelope(`${JSON.stringify(value.envelope)}\n`);
    if (envelope.payload.grantId !== grantId) {
        throw ambiguousGrant(grantId);
    }
    let use = null;
    if (value.state === 'consumed') {
        use = assertStoredUse(value.use, envelope);
        if (value.transitionDigest === null ||
            value.transitionDigest !== use.transitionDigest) {
            throw ambiguousGrant(grantId);
        }
    }
    else {
        if (value.use !== null ||
            (value.state !== 'revoked' && value.transitionDigest === null)) {
            throw ambiguousGrant(grantId);
        }
    }
    let revocationAuthorization;
    if (hasAuthorization) {
        revocationAuthorization = assertHumanRevocationAuthorization(value.revocationAuthorization);
        if (value.state !== 'revoked' ||
            revocationAuthorization.payload.subjectKind !== 'collaboration-grant' ||
            revocationAuthorization.payload.grantId !== grantId ||
            revocationAuthorization.payload.reason !== value.reason ||
            revocationAuthorization.payload.revokedAt !== value.recordedAt) {
            throw ambiguousGrant(grantId);
        }
    }
    return deepFreeze({
        ...value,
        envelope,
        use,
        ...(revocationAuthorization ? { revocationAuthorization } : {}),
    });
}
function assertStoredUse(value, envelope) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'grantId',
            'signedEnvelopeDigest',
            'transitionDigest',
            'reservedAt',
            'lifecyclePhase',
            'targetDigest',
            'degradedForm',
            'authorizedEffect',
            'assignment',
            'structuredContent',
            'contentAuthority',
            'directHumanReviewAttestation',
            'retainedObligations',
            'replayScope',
            'residuals',
            'envelope',
        ]) ||
        value.schemaVersion !== 1 ||
        value.grantId !== envelope.payload.grantId ||
        value.signedEnvelopeDigest !== collaborationGrantEnvelopeDigest(envelope) ||
        typeof value.transitionDigest !== 'string' ||
        !DIGEST.test(value.transitionDigest) ||
        typeof value.reservedAt !== 'string' ||
        !isExactTimestamp(value.reservedAt) ||
        Date.parse(value.reservedAt) < Date.parse(envelope.payload.issuedAt) ||
        Date.parse(value.reservedAt) > Date.parse(envelope.payload.expiresAt) ||
        value.lifecyclePhase !== envelope.payload.lifecyclePhase ||
        value.targetDigest !== envelope.payload.targetDigest ||
        value.degradedForm !== envelope.payload.degradedForm ||
        value.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
        value.contentAuthority !== 'reference-only-requires-governing-validator' ||
        !Array.isArray(value.retainedObligations) ||
        JSON.stringify(value.retainedObligations) !==
            JSON.stringify(COLLABORATION_GRANT_RETAINED_OBLIGATIONS) ||
        value.replayScope !== COLLABORATION_GRANT_REPLAY_SCOPE ||
        !Array.isArray(value.residuals) ||
        JSON.stringify(value.residuals) !==
            JSON.stringify(COLLABORATION_GRANT_RESIDUALS) ||
        canonicalCollaborationGrantEnvelope(parseCollaborationGrantEnvelope(`${JSON.stringify(value.envelope)}\n`)) !== canonicalCollaborationGrantEnvelope(envelope)) {
        throw ambiguousGrant(envelope.payload.grantId);
    }
    const assignment = assertGrantedAssignment(value.assignment, envelope);
    const structuredContent = assertStructuredContent(value.structuredContent, envelope.payload.lifecyclePhase);
    const directHumanReviewAttestation = assertDirectHumanAttestationReference(value.directHumanReviewAttestation, assignment, envelope, value.transitionDigest, structuredContent);
    return deepFreeze({
        schemaVersion: 1,
        grantId: envelope.payload.grantId,
        signedEnvelopeDigest: collaborationGrantEnvelopeDigest(envelope),
        transitionDigest: value.transitionDigest,
        reservedAt: value.reservedAt,
        lifecyclePhase: envelope.payload.lifecyclePhase,
        targetDigest: envelope.payload.targetDigest,
        degradedForm: envelope.payload.degradedForm,
        authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
        assignment,
        structuredContent,
        contentAuthority: 'reference-only-requires-governing-validator',
        directHumanReviewAttestation,
        retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
        replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
        residuals: COLLABORATION_GRANT_RESIDUALS,
        envelope,
    });
}
function assertGrantedAssignment(value, envelope) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'role',
            'providerId',
            'sessionId',
            'targetDigest',
            'requiredIndependence',
            'achievedIndependence',
            'providerIndependent',
            'sessionIndependent',
            'engineSpawned',
            'orchestration',
            'grantId',
            'degradedForm',
            'authorizedEffect',
            'author',
            'participant',
            'callableProviderIds',
            ...('degradedAuthorityOverride' in value
                ? ['degradedAuthorityOverride']
                : []),
            'directHumanReviewAttestationDigest',
        ]) ||
        value.role !== envelope.payload.rolePair.conflictingRole ||
        value.targetDigest !== envelope.payload.targetDigest ||
        value.requiredIndependence !== 'provider-independent' ||
        value.providerIndependent !== false ||
        value.grantId !== envelope.payload.grantId ||
        value.degradedForm !== envelope.payload.degradedForm ||
        value.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT) {
        throw invalidUse();
    }
    const common = {
        role: envelope.payload.rolePair.conflictingRole,
        targetDigest: value.targetDigest,
        requiredIndependence: 'provider-independent',
        providerIndependent: false,
        grantId: value.grantId,
        degradedForm: envelope.payload.degradedForm,
        authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
        author: assertRecordedParticipant(value.author),
        participant: assertRecordedParticipant(value.participant),
        callableProviderIds: assertCallableProviderIds(value.callableProviderIds),
        ...('degradedAuthorityOverride' in value
            ? {
                degradedAuthorityOverride: assertTaskDiffChallengeClosureAuthorityOverride(value.degradedAuthorityOverride, value.role, value.targetDigest),
            }
            : {}),
    };
    if (envelope.payload.degradedForm === 'same-provider-fresh-session' &&
        envelope.payload.availableActor.kind === 'provider' &&
        value.providerId === envelope.payload.availableActor.providerId &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        value.achievedIndependence === 'session-independent' &&
        value.sessionIndependent === true &&
        value.engineSpawned === true &&
        value.orchestration === 'engine-spawned-provider') {
        if (common.author.providerId !== envelope.payload.availableActor.providerId ||
            common.participant.providerId !==
                envelope.payload.availableActor.providerId ||
            common.participant.sessionId !== value.sessionId ||
            common.participant.engineSpawned !== true ||
            common.participant.identityAssurance !==
                envelope.payload.availableActor.assurance ||
            typeof common.author.sessionId !== 'string' ||
            common.author.sessionId === common.participant.sessionId ||
            JSON.stringify(common.callableProviderIds) !==
                JSON.stringify([envelope.payload.availableActor.providerId]) ||
            common.degradedAuthorityOverride !== undefined ||
            value.directHumanReviewAttestationDigest !== null) {
            throw invalidUse();
        }
        return deepFreeze({
            ...common,
            providerId: envelope.payload.availableActor.providerId,
            sessionId: value.sessionId,
            achievedIndependence: 'session-independent',
            sessionIndependent: true,
            engineSpawned: true,
            orchestration: 'engine-spawned-provider',
            directHumanReviewAttestationDigest: null,
        });
    }
    const expectedOrchestration = envelope.payload.degradedForm === 'caller-supplied'
        ? 'caller-supplied'
        : 'direct-human-review';
    if (envelope.payload.degradedForm !== 'same-provider-fresh-session' &&
        value.providerId === null &&
        value.sessionId === null &&
        value.achievedIndependence === 'none' &&
        value.sessionIndependent === false &&
        value.engineSpawned === false &&
        value.orchestration === expectedOrchestration) {
        const expectedPrincipal = envelope.payload.availableActor.kind === 'caller'
            ? envelope.payload.availableActor.callerId
            : envelope.payload.availableActor.kind === 'direct-human'
                ? envelope.payload.availableActor.identity
                : undefined;
        if (common.participant.providerId !== null ||
            common.participant.sessionId !== null ||
            common.participant.engineSpawned !== false ||
            common.participant.principalId !== expectedPrincipal ||
            (common.callableProviderIds.length !== 0 &&
                common.degradedAuthorityOverride === undefined) ||
            (envelope.payload.degradedForm === 'caller-supplied'
                ? value.directHumanReviewAttestationDigest !== null ||
                    common.participant.identityAssurance !==
                        envelope.payload.availableActor.assurance
                : typeof value.directHumanReviewAttestationDigest !== 'string' ||
                    !DIGEST.test(value.directHumanReviewAttestationDigest) ||
                    common.participant.identityAssurance !== 'maintainer-signed')) {
            throw invalidUse();
        }
        return deepFreeze({
            ...common,
            providerId: null,
            sessionId: null,
            achievedIndependence: 'none',
            sessionIndependent: false,
            engineSpawned: false,
            orchestration: expectedOrchestration,
            directHumanReviewAttestationDigest: value.directHumanReviewAttestationDigest,
        });
    }
    throw invalidUse();
}
function assertTaskDiffChallengeClosureAuthorityOverride(value, role, targetDigest) {
    if (role !== 'task-diff-reviewer' ||
        !isRecord(value) ||
        !hasExactKeys(value, [
            'kind',
            'targetDigest',
            'subjectDigest',
            'reviewRecordDigest',
            'responseDigest',
        ]) ||
        value.kind !== 'task-diff-challenge-closure' ||
        typeof targetDigest !== 'string' ||
        value.targetDigest !== targetDigest ||
        typeof value.subjectDigest !== 'string' ||
        !DIGEST.test(value.subjectDigest) ||
        typeof value.reviewRecordDigest !== 'string' ||
        !DIGEST.test(value.reviewRecordDigest) ||
        typeof value.responseDigest !== 'string' ||
        !DIGEST.test(value.responseDigest) ||
        value.targetDigest !==
            crypto
                .createHash('sha256')
                .update(canonicalJson({
                schema: 'workflow.task-diff-external-continuation-target.v1',
                subjectDigest: value.subjectDigest,
                reviewRecordDigest: value.reviewRecordDigest,
                responseDigest: value.responseDigest,
            }))
                .digest('hex')) {
        throw invalidUse();
    }
    return deepFreeze({
        kind: 'task-diff-challenge-closure',
        targetDigest: value.targetDigest,
        subjectDigest: value.subjectDigest,
        reviewRecordDigest: value.reviewRecordDigest,
        responseDigest: value.responseDigest,
    });
}
function assertRecordedParticipant(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'providerId',
            'sessionId',
            'principalId',
            'identityAssurance',
            'engineSpawned',
        ]) ||
        ![null, 'codex', 'claude'].includes(value.providerId) ||
        (value.sessionId !== null &&
            (typeof value.sessionId !== 'string' || value.sessionId.length === 0)) ||
        (value.principalId !== null &&
            (typeof value.principalId !== 'string' ||
                value.principalId.length === 0)) ||
        ![
            'self-declared',
            'runtime-hint',
            'adapter-assigned',
            'maintainer-signed',
        ].includes(String(value.identityAssurance)) ||
        typeof value.engineSpawned !== 'boolean') {
        throw invalidUse();
    }
    return deepFreeze({
        providerId: value.providerId,
        sessionId: value.sessionId,
        principalId: value.principalId,
        identityAssurance: value.identityAssurance,
        engineSpawned: value.engineSpawned,
    });
}
function assertCallableProviderIds(value) {
    if (!Array.isArray(value) ||
        value.some((providerId) => !['codex', 'claude'].includes(providerId)) ||
        value.length !== new Set(value).size ||
        JSON.stringify(value) !== JSON.stringify([...value].sort())) {
        throw invalidUse();
    }
    return Object.freeze([...value]);
}
function assertDirectHumanAttestationReference(value, assignment, envelope, transitionDigest, structuredContent) {
    if (envelope.payload.degradedForm !== 'direct-human-review') {
        if (value !== null ||
            assignment.directHumanReviewAttestationDigest !== null) {
            throw invalidUse();
        }
        return null;
    }
    if (value === null ||
        assignment.directHumanReviewAttestationDigest === null) {
        throw invalidUse();
    }
    const parsed = parseDirectHumanReviewAttestation(`${JSON.stringify(value)}\n`);
    if (parsed.payload.grantId !== envelope.payload.grantId ||
        parsed.payload.signedEnvelopeDigest !==
            collaborationGrantEnvelopeDigest(envelope) ||
        parsed.payload.transitionDigest !== transitionDigest ||
        parsed.payload.targetDigest !== envelope.payload.targetDigest ||
        parsed.payload.reviewNodeId !== structuredContent.nodeId ||
        parsed.payload.reviewResultDigest !== structuredContent.resultDigest ||
        directHumanReviewAttestationDigest(parsed) !==
            assignment.directHumanReviewAttestationDigest) {
        throw invalidUse();
    }
    return parsed;
}
function assertStructuredContent(value, phase) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['kind', 'nodeId', 'resultDigest']) ||
        value.kind !== phase ||
        typeof value.nodeId !== 'string' ||
        !DIGEST.test(value.nodeId) ||
        typeof value.resultDigest !== 'string' ||
        !DIGEST.test(value.resultDigest)) {
        throw invalidUse();
    }
    return deepFreeze({
        kind: value.kind,
        nodeId: value.nodeId,
        resultDigest: value.resultDigest,
    });
}
function assertContentAdmission(value, phase) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['kind', 'nodeId', 'resultDigest', 'current']) ||
        value.current !== true) {
        throw invalidUse();
    }
    const structured = assertStructuredContent({
        kind: value.kind,
        nodeId: value.nodeId,
        resultDigest: value.resultDigest,
    }, phase);
    return deepFreeze({ ...structured, current: true });
}
function consumptionMatches(use, request, transitionDigest) {
    try {
        const assignment = assertGrantedAssignment(request.assignment, use.envelope);
        const contentAdmission = assertContentAdmission(request.contentAdmission, use.lifecyclePhase);
        const structuredContent = {
            kind: contentAdmission.kind,
            nodeId: contentAdmission.nodeId,
            resultDigest: contentAdmission.resultDigest,
        };
        const directHumanReviewAttestation = assertDirectHumanAttestationReference(request.directHumanReviewAttestation ?? null, assignment, use.envelope, transitionDigest, structuredContent);
        return (use.transitionDigest === transitionDigest &&
            JSON.stringify(use.assignment) === JSON.stringify(assignment) &&
            JSON.stringify(use.structuredContent) ===
                JSON.stringify(structuredContent) &&
            JSON.stringify(use.directHumanReviewAttestation) ===
                JSON.stringify(directHumanReviewAttestation));
    }
    catch {
        return false;
    }
}
function cleanupNonterminal(paths, grantId, expected, expectedTransitionDigest) {
    for (const directory of [paths.available, paths.reserved]) {
        const target = statePath(directory, grantId);
        if (!fs.existsSync(target)) {
            continue;
        }
        const residual = directory === paths.available
            ? { envelope: readAvailable(target, grantId) }
            : readReservationOrInterrupted(target, grantId);
        const observed = residual.envelope;
        if (canonicalCollaborationGrantEnvelope(observed) !==
            canonicalCollaborationGrantEnvelope(expected) ||
            (directory === paths.reserved &&
                (residual.transitionDigest === undefined
                    ? expectedTransitionDigest !== null
                    : residual.transitionDigest !== expectedTransitionDigest))) {
            throw ambiguousGrant(grantId);
        }
        fs.unlinkSync(target);
        fsyncDirectory(directory);
    }
}
function assertResidualCopiesMatch(paths, grantId, expected, expectedTransitionDigest) {
    for (const directory of [paths.available, paths.reserved]) {
        const target = statePath(directory, grantId);
        if (!fs.existsSync(target)) {
            continue;
        }
        const residual = directory === paths.available
            ? { envelope: readAvailable(target, grantId) }
            : readReservationOrInterrupted(target, grantId);
        const observed = residual.envelope;
        if (canonicalCollaborationGrantEnvelope(observed) !==
            canonicalCollaborationGrantEnvelope(expected) ||
            (directory === paths.reserved &&
                (residual.transitionDigest === undefined
                    ? expectedTransitionDigest !== null
                    : residual.transitionDigest !== expectedTransitionDigest))) {
            throw ambiguousGrant(grantId);
        }
    }
}
function ensureStoreDirectories(paths) {
    for (const directory of [
        paths.root,
        paths.available,
        paths.reserved,
        paths.terminal,
        paths.revocationAuthorizations,
    ]) {
        const existed = fs.existsSync(directory);
        ensurePlainDirectory(directory);
        fs.chmodSync(directory, 0o700);
        const stats = fs.lstatSync(directory);
        if (!stats.isDirectory() ||
            stats.isSymbolicLink() ||
            fs.realpathSync(directory) !== path.resolve(directory) ||
            (stats.mode & 0o777) !== 0o700) {
            throw unsafeStore();
        }
        if (!existed) {
            fsyncDirectory(path.dirname(directory));
        }
        if (directory !== paths.root) {
            for (const entry of fs.readdirSync(directory)) {
                if (!STATE_FILE.test(entry)) {
                    throw unsafeStore();
                }
            }
        }
    }
}
function existingStateDirectories(paths) {
    return [paths.available, paths.reserved, paths.terminal].flatMap((directory) => {
        const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!stats) {
            return [];
        }
        if (!stats.isDirectory() ||
            stats.isSymbolicLink() ||
            fs.realpathSync(directory) !== path.resolve(directory) ||
            (stats.mode & 0o777) !== 0o700) {
            throw unsafeStore();
        }
        return [{ directory }];
    });
}
function assertExistingStoreReadOnlySafe(paths) {
    const rootStats = fs.lstatSync(paths.root, { throwIfNoEntry: false });
    if (!rootStats)
        return false;
    assertExistingPrivateDirectory(paths.root, rootStats);
    const allowed = new Set([
        path.basename(paths.available),
        path.basename(paths.reserved),
        path.basename(paths.terminal),
        path.basename(paths.revocationAuthorizations),
    ]);
    for (const entry of fs.readdirSync(paths.root)) {
        if (!allowed.has(entry))
            throw unsafeStore();
        const directory = path.join(paths.root, entry);
        const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!stats)
            throw unsafeStore();
        assertExistingPrivateDirectory(directory, stats);
        for (const name of fs.readdirSync(directory)) {
            if (!STATE_FILE.test(name))
                throw unsafeStore();
            const filePath = path.join(directory, name);
            const fileStats = fs.lstatSync(filePath, { throwIfNoEntry: false });
            if (!fileStats ||
                !fileStats.isFile() ||
                fileStats.isSymbolicLink() ||
                fileStats.nlink !== 1 ||
                (fileStats.mode & 0o777) !== 0o600) {
                throw unsafeStore();
            }
        }
    }
    return true;
}
function assertExistingPrivateDirectory(directory, stats) {
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== path.resolve(directory) ||
        (stats.mode & 0o777) !== 0o700) {
        throw unsafeStore();
    }
}
function assertNoState(paths, grantId) {
    if ([paths.available, paths.reserved, paths.terminal].some((directory) => fs.existsSync(statePath(directory, grantId)))) {
        throw unavailableGrant(grantId);
    }
}
function assertNonterminalUnambiguous(paths, grantId) {
    const states = [paths.available, paths.reserved].filter((directory) => fs.existsSync(statePath(directory, grantId)));
    if (states.length > 1) {
        throw ambiguousGrant(grantId);
    }
}
function listGrantIds(directory) {
    return fs.readdirSync(directory).map((entry) => {
        if (!STATE_FILE.test(entry)) {
            throw unsafeStore();
        }
        return assertCollaborationGrantId(entry.slice(0, -'.json'.length));
    });
}
function statePath(directory, grantId) {
    return path.join(directory, `${assertCollaborationGrantId(grantId)}.json`);
}
function createPrivateFileAtomic(filePath, content) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            noFollowFlag(), 0o600);
        assertPrivateDescriptor(descriptor);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporaryPath, filePath);
        fs.unlinkSync(temporaryPath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporaryPath, { force: true });
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw unavailableGrant(path.basename(filePath, '.json'));
        }
        throw error;
    }
}
function replacePrivateFileAtomic(filePath, content) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            noFollowFlag(), 0o600);
        assertPrivateDescriptor(descriptor);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporaryPath, { force: true });
    }
}
function readPrivateFile(filePath) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
        assertPrivateDescriptor(descriptor);
        return fs.readFileSync(descriptor, 'utf8');
    }
    catch {
        throw unsafeStore();
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
function assertPrivateDescriptor(descriptor) {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) {
        throw unsafeStore();
    }
}
function noFollowFlag() {
    return typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
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
function serialize(value) {
    return `${JSON.stringify(value)}\n`;
}
function parseRecord(raw) {
    try {
        const value = JSON.parse(raw);
        if (!isRecord(value) || raw !== `${JSON.stringify(value)}\n`) {
            throw new Error('not canonical');
        }
        return value;
    }
    catch {
        throw unsafeStore();
    }
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return (actual.length === sorted.length &&
        actual.every((entry, index) => entry === sorted[index]));
}
function assertSelectableDegradedForms(value) {
    if (!Array.isArray(value) ||
        value.length === 0 ||
        value.some((entry) => entry !== 'caller-supplied' && entry !== 'direct-human-review') ||
        new Set(value).size !== value.length) {
        throw bindingMismatch();
    }
    return Object.freeze([...value].sort());
}
function assertSelectedGrantBinding(envelope, expectedCore, allowedDegradedForms) {
    if (!isRecord(expectedCore) ||
        !hasExactKeys(expectedCore, [
            'repositoryId',
            'repositoryOrigin',
            'policyBlob',
            'collaborationPolicyDigest',
            'changeId',
            'taskId',
            'baselineCommit',
            'baselineTree',
            'targetDigest',
            'lifecyclePhase',
            'rolePair',
        ])) {
        throw bindingMismatch();
    }
    const expectedBinding = bindingFromPayload(envelope.payload);
    const observedCore = {
        repositoryId: expectedBinding.repositoryId,
        repositoryOrigin: expectedBinding.repositoryOrigin,
        policyBlob: expectedBinding.policyBlob,
        collaborationPolicyDigest: expectedBinding.collaborationPolicyDigest,
        changeId: expectedBinding.changeId,
        taskId: expectedBinding.taskId,
        baselineCommit: expectedBinding.baselineCommit,
        baselineTree: expectedBinding.baselineTree,
        targetDigest: expectedBinding.targetDigest,
        lifecyclePhase: expectedBinding.lifecyclePhase,
        rolePair: expectedBinding.rolePair,
    };
    let coreMatches = false;
    try {
        coreMatches =
            canonicalJson(observedCore) === canonicalJson(expectedCore) &&
                allowedDegradedForms.includes(expectedBinding.degradedForm);
    }
    catch {
        throw bindingMismatch();
    }
    const actorMatchesForm = (expectedBinding.degradedForm === 'caller-supplied' &&
        expectedBinding.availableActor.kind === 'caller') ||
        (expectedBinding.degradedForm === 'direct-human-review' &&
            expectedBinding.availableActor.kind === 'direct-human');
    if (!coreMatches || !actorMatchesForm) {
        throw bindingMismatch();
    }
    return deepFreeze(expectedBinding);
}
function loadSelectionValidationContext(repositoryRoot, expectedCore, requestedNow, requestedVerifier) {
    const baselineCommit = exactRepositoryCommit(repositoryRoot, expectedCore.baselineCommit);
    const baselineTree = runGit(repositoryRoot, [
        'rev-parse',
        `${baselineCommit}^{tree}`,
    ]).trim();
    const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const mergeBase = runGit(repositoryRoot, [
        'merge-base',
        baselineCommit,
        head,
    ]).trim();
    const policy = loadPolicyAtCommit(repositoryRoot, baselineCommit);
    const policyBlob = runGit(repositoryRoot, [
        'rev-parse',
        `${baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
    if (mergeBase !== baselineCommit ||
        expectedCore.baselineTree !== baselineTree ||
        expectedCore.policyBlob !== policyBlob ||
        expectedCore.repositoryId !== policy.repository.id ||
        expectedCore.repositoryOrigin !== policy.repository.origin ||
        origin !== policy.repository.origin) {
        throw bindingMismatch();
    }
    return {
        now: exactDate(requestedNow ?? new Date()),
        policy,
        verifier: requestedVerifier ?? createInteractiveSshSigner(repositoryRoot, policy),
    };
}
function collaborationRoleTransitionDigest(expectedBinding) {
    return crypto
        .createHash('sha256')
        .update(canonicalJson({
        schemaVersion: 1,
        kind: 'collaboration-role-transition',
        expectedBinding,
    }))
        .digest('hex');
}
function exactDigest(value, label) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw workflowError('COLLABORATION_GRANT_USE_INVALID', `Collaboration grant ${label} is invalid.`, ExitCode.guard);
    }
    return value;
}
function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw invalidUse();
    }
    return date;
}
function isExactTimestamp(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function loadPolicyAtCommit(repositoryRoot, commit) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            `${commit}:workflow/maintainer-policy.json`,
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
            throw error;
        }
        throw workflowError('COLLABORATION_GRANT_INVALID', 'The exact baseline does not contain a valid maintainer policy.', ExitCode.guard);
    }
}
function exactRepositoryCommit(repositoryRoot, requested) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(requested)) {
        throw bindingMismatch();
    }
    const resolved = runGit(repositoryRoot, [
        'rev-parse',
        `${requested}^{commit}`,
    ]).trim();
    if (resolved !== requested) {
        throw bindingMismatch();
    }
    return resolved;
}
function nonEmpty(value, label) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0 ||
        value.length > 500) {
        throw workflowError('COLLABORATION_GRANT_USE_INVALID', `Collaboration grant ${label} is invalid.`, ExitCode.guard);
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
function invalidUse() {
    return workflowError('COLLABORATION_GRANT_USE_INVALID', 'Collaboration grant use requires exact role assignment and structured content.', ExitCode.guard);
}
function bindingMismatch() {
    return workflowError('COLLABORATION_GRANT_BINDING_MISMATCH', 'Collaboration reservation facts do not match the exact repository baseline.', ExitCode.guard);
}
function unavailableGrant(grantId) {
    return workflowError('COLLABORATION_GRANT_UNAVAILABLE', `Collaboration grant ${grantId} is unavailable for this transition.`, ExitCode.conflict);
}
function grantNotFound(grantId) {
    return workflowError('COLLABORATION_GRANT_NOT_FOUND', `Collaboration grant ${grantId} does not exist in local state.`, ExitCode.guard);
}
function ambiguousGrant(grantId) {
    return workflowError('COLLABORATION_GRANT_STATE_AMBIGUOUS', `Collaboration grant ${grantId} has ambiguous or malformed local state.`, ExitCode.staleState);
}
function unsafeStore() {
    return workflowError('COLLABORATION_GRANT_STORE_UNSAFE', 'Collaboration grant storage is malformed or unsafe.', ExitCode.staleState);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
