import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, WorkflowError, workflowError, } from '../../foundation/errors/errors.js';
import { discoverRepository, runGit } from '../../git.js';
import { parseMaintainerPolicy, } from './maintainer-policy.js';
import { createInteractiveSshSigner, } from '../../maintainer-signer.js';
import { collaborationGrantStorePaths, storeAvailableCollaborationGrant, } from '../../collaboration-grant-store.js';
import { isProviderId, } from '../provider-orchestration/provider-registry.js';
import { assertChangeId, assertTaskId } from '../../paths.js';
export const COLLABORATION_GRANT_SIGNATURE_NAMESPACE = 'expense-app.workflow.collaboration-grant.v1';
export const DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE = 'expense-app.workflow.direct-human-review.v1';
export const COLLABORATION_GRANT_AUTHORIZED_EFFECT = 'role-independence-degradation-only';
export const COLLABORATION_GRANT_REPLAY_SCOPE = 'repository-common-dir-local';
export const COLLABORATION_GRANT_RESIDUALS = Object.freeze([
    'GLOBAL_CROSS_CLONE_ONE_USE_NOT_PROVEN',
    'GIT_COMMON_DIR_STATE_IS_COOPERATIVE_NOT_REMOTE_ATTESTED',
    'TRACKED_HISTORY_ONE_USE_REQUIRES_AGGREGATE_VALIDATION',
    'LOCAL_WALL_CLOCK_NOT_EXTERNALLY_ATTESTED',
]);
export const COLLABORATION_GRANT_MAX_TTL_MINUTES = 30;
export const COLLABORATION_GRANT_POLICY = deepFreeze({
    schemaVersion: 1,
    policyId: 'expense-app.workflow.collaboration-policy.v1',
    permittedForms: {
        'blind-survey': ['same-provider-fresh-session', 'caller-supplied'],
        'plan-review': [
            'same-provider-fresh-session',
            'caller-supplied',
            'direct-human-review',
        ],
        'task-implementation': [
            'same-provider-fresh-session',
            'caller-supplied',
        ],
    },
    trustCriticalDirectHumanRequiredPhases: [],
});
export const COLLABORATION_GRANT_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(JSON.stringify(COLLABORATION_GRANT_POLICY))
    .digest('hex');
export const TASK_DIFF_REVIEW_COLLABORATION_POLICY = deepFreeze({
    schemaVersion: 1,
    policyId: 'expense-app.workflow.collaboration-policy.task-diff-review.v1',
    permittedForms: {
        'task-diff-review': [
            'same-provider-fresh-session',
            'caller-supplied',
            'direct-human-review',
        ],
    },
    trustCriticalDirectHumanRequiredPhases: [],
});
export const TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(JSON.stringify(TASK_DIFF_REVIEW_COLLABORATION_POLICY))
    .digest('hex');
export const COLLABORATION_GRANT_RETAINED_OBLIGATIONS = Object.freeze([
    'engine-search-floor',
    'typed-term-contributions',
    'effective-union-scan',
    'hit-dispositions',
    'why-ledger',
    'structured-role-content',
    'challenge-dispositions',
    'registered-checks',
    'allowed-paths',
    'freshness',
    'managed-transition-authority',
]);
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/;
const PAYLOAD_KEYS = [
    'version',
    'grantId',
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
    'availableActor',
    'degradedForm',
    'authorizedEffect',
    'reason',
    'issuedAt',
    'expiresAt',
    'maxUses',
    'signer',
];
const DIRECT_HUMAN_PAYLOAD_KEYS = [
    'version',
    'grantId',
    'signedEnvelopeDigest',
    'transitionDigest',
    'targetDigest',
    'reviewNodeId',
    'reviewResultDigest',
    'signedAt',
    'signer',
];
export function canonicalCollaborationGrantPayload(payload) {
    return `${JSON.stringify({
        version: payload.version,
        grantId: payload.grantId,
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        policyBlob: payload.policyBlob,
        collaborationPolicyDigest: payload.collaborationPolicyDigest,
        changeId: payload.changeId,
        taskId: payload.taskId,
        baselineCommit: payload.baselineCommit,
        baselineTree: payload.baselineTree,
        targetDigest: payload.targetDigest,
        lifecyclePhase: payload.lifecyclePhase,
        rolePair: canonicalRolePair(payload.rolePair),
        availableActor: canonicalAvailableActor(payload.availableActor),
        degradedForm: payload.degradedForm,
        authorizedEffect: payload.authorizedEffect,
        reason: payload.reason,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        maxUses: payload.maxUses,
        signer: payload.signer,
    })}\n`;
}
export function canonicalCollaborationGrantEnvelope(envelope) {
    const payload = JSON.parse(canonicalCollaborationGrantPayload(envelope.payload));
    return `${JSON.stringify({ payload, signature: envelope.signature })}\n`;
}
export function collaborationGrantEnvelopeDigest(envelope) {
    return crypto
        .createHash('sha256')
        .update(canonicalCollaborationGrantEnvelope(envelope))
        .digest('hex');
}
export function canonicalDirectHumanReviewPayload(payload) {
    return `${JSON.stringify({
        version: payload.version,
        grantId: payload.grantId,
        signedEnvelopeDigest: payload.signedEnvelopeDigest,
        transitionDigest: payload.transitionDigest,
        targetDigest: payload.targetDigest,
        reviewNodeId: payload.reviewNodeId,
        reviewResultDigest: payload.reviewResultDigest,
        signedAt: payload.signedAt,
        signer: payload.signer,
    })}\n`;
}
export function canonicalDirectHumanReviewAttestation(attestation) {
    const payload = JSON.parse(canonicalDirectHumanReviewPayload(attestation.payload));
    return `${JSON.stringify({ payload, signature: attestation.signature })}\n`;
}
export function directHumanReviewAttestationDigest(attestation) {
    return crypto
        .createHash('sha256')
        .update(canonicalDirectHumanReviewAttestation(attestation))
        .digest('hex');
}
export function parseDirectHumanReviewAttestation(raw) {
    try {
        if (typeof raw !== 'string' || raw.length > 32_768) {
            throw new Error('invalid attestation size');
        }
        const value = JSON.parse(raw);
        if (!isPlainRecord(value) ||
            !hasExactDataKeys(value, ['payload', 'signature']) ||
            !isPlainRecord(value.payload) ||
            !hasExactDataKeys(value.payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
            typeof value.signature !== 'string') {
            throw new Error('invalid attestation shape');
        }
        const attestation = {
            payload: value.payload,
            signature: value.signature,
        };
        assertDirectHumanReviewPayload(attestation.payload);
        assertArmoredSignature(attestation.signature);
        if (canonicalDirectHumanReviewAttestation(attestation) !== raw) {
            throw new Error('non-canonical attestation');
        }
        return deepFreeze(attestation);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'COLLABORATION_SIGNATURE_INVALID') {
            throw error;
        }
        throw workflowError('DIRECT_HUMAN_REVIEW_INVALID', 'Direct-human review attestation is invalid.', ExitCode.guard);
    }
}
export function assertCollaborationGrantId(value) {
    if (typeof value !== 'string' || !GRANT_ID.test(value)) {
        throw collaborationInvalid('Collaboration grant ID is invalid.');
    }
    return value;
}
export function parseCollaborationGrantEnvelope(raw) {
    try {
        if (typeof raw !== 'string' || raw.length > 32_768) {
            throw new Error('invalid envelope size');
        }
        const value = JSON.parse(raw);
        if (!isPlainRecord(value) ||
            !hasExactDataKeys(value, ['payload', 'signature']) ||
            !isPlainRecord(value.payload) ||
            !hasExactDataKeys(value.payload, PAYLOAD_KEYS) ||
            typeof value.signature !== 'string') {
            throw new Error('invalid envelope shape');
        }
        const envelope = {
            payload: value.payload,
            signature: value.signature,
        };
        assertArmoredSignature(envelope.signature);
        assertCollaborationGrantId(envelope.payload.grantId);
        assertCollaborationPayloadShape(envelope.payload);
        if (canonicalCollaborationGrantEnvelope(envelope) !== raw) {
            throw new Error('non-canonical envelope');
        }
        return deepFreeze(envelope);
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw error.code === 'COLLABORATION_SIGNATURE_INVALID'
                ? error
                : collaborationInvalid('Collaboration grant envelope is invalid.');
        }
        throw collaborationInvalid('Collaboration grant envelope is invalid.');
    }
}
export function issueCollaborationGrant(cwd, request, options = {}) {
    const repository = discoverRepository(cwd);
    const baselineCommit = exactRepositoryCommit(repository.repositoryRoot, request.baselineCommit);
    const baselineTree = runGit(repository.repositoryRoot, [
        'rev-parse',
        `${baselineCommit}^{tree}`,
    ]).trim();
    if (request.baselineTree !== baselineTree) {
        throw collaborationBindingMismatch('Requested baseline tree does not match the exact baseline commit.');
    }
    const mergeBase = runGit(repository.repositoryRoot, [
        'merge-base',
        baselineCommit,
        repository.head,
    ]).trim();
    if (mergeBase !== baselineCommit) {
        throw collaborationBindingMismatch('Requested baseline is not an ancestor of the current repository head.');
    }
    const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
    const origin = runGit(repository.repositoryRoot, [
        'remote',
        'get-url',
        'origin',
    ]).trim();
    if (origin !== policy.repository.origin) {
        throw collaborationBindingMismatch('Repository origin does not match the trusted maintainer policy.');
    }
    const policyBlob = runGit(repository.repositoryRoot, [
        'rev-parse',
        `${baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    const now = exactDate(options.now ?? new Date());
    const ttlMinutes = request.ttlMinutes ?? COLLABORATION_GRANT_MAX_TTL_MINUTES;
    const maxUses = request.maxUses ?? 1;
    if (!Number.isInteger(ttlMinutes) ||
        ttlMinutes < 1 ||
        ttlMinutes >
            Math.min(policy.maxTtlMinutes, COLLABORATION_GRANT_MAX_TTL_MINUTES) ||
        maxUses !== 1) {
        throw collaborationInvalid('Collaboration grant bounds exceed trusted policy.');
    }
    const grantId = assertCollaborationGrantId(options.grantId ?? crypto.randomUUID());
    const store = collaborationGrantStorePaths(repository.gitCommonDirectory);
    if ([store.available, store.reserved, store.terminal].some((directory) => fsExistsGrant(directory, grantId))) {
        throw workflowError('COLLABORATION_GRANT_EXISTS', `Collaboration grant ${grantId} already has local state.`, ExitCode.conflict);
    }
    const signer = options.signer ??
        createInteractiveSshSigner(repository.repositoryRoot, policy);
    signer.assertHumanPresent();
    const signerIdentity = signer.identity();
    const payload = {
        version: 1,
        grantId,
        repositoryId: policy.repository.id,
        repositoryOrigin: policy.repository.origin,
        policyBlob,
        collaborationPolicyDigest: collaborationPolicyDigestForPhase(request.lifecyclePhase),
        changeId: request.changeId,
        taskId: request.taskId,
        baselineCommit,
        baselineTree,
        targetDigest: request.targetDigest,
        lifecyclePhase: request.lifecyclePhase,
        rolePair: request.rolePair,
        availableActor: request.degradedForm === 'direct-human-review'
            ? {
                kind: 'direct-human',
                identity: signerIdentity,
                assurance: 'maintainer-signed',
            }
            : request.availableActor,
        degradedForm: request.degradedForm,
        authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
        reason: request.reason,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
        maxUses: 1,
        signer: signerIdentity,
    };
    validateCollaborationGrantPayload(payload, policy, {
        now,
        expectedPolicyBlob: policyBlob,
    });
    const canonicalPayload = canonicalCollaborationGrantPayload(payload);
    let signature;
    try {
        signature = signer.sign(canonicalPayload, COLLABORATION_GRANT_SIGNATURE_NAMESPACE);
        assertArmoredSignature(signature);
        signer.verify(canonicalPayload, signature, signerIdentity, COLLABORATION_GRANT_SIGNATURE_NAMESPACE);
    }
    catch (error) {
        throw collaborationSignatureInvalid(error);
    }
    const envelope = deepFreeze({ payload, signature });
    const availableEnvelopePath = storeAvailableCollaborationGrant(repository.gitCommonDirectory, envelope);
    return { grantId, availableEnvelopePath, envelope };
}
/**
 * Sign exact direct-human review content separately from the grant that permits
 * degraded PlanReview or TaskDiffReview continuation. This second signature
 * proves who supplied the review bytes; the continuation grant alone never
 * creates that claim.
 */
export function createDirectHumanReviewAttestation(cwd, request, options = {}) {
    const repository = discoverRepository(cwd);
    const grant = parseCollaborationGrantEnvelope(canonicalCollaborationGrantEnvelope(request.grantEnvelope));
    const payload = grant.payload;
    if (payload.degradedForm !== 'direct-human-review' ||
        (payload.lifecyclePhase !== 'plan-review' &&
            payload.lifecyclePhase !== 'task-diff-review') ||
        payload.availableActor.kind !== 'direct-human') {
        throw workflowError('DIRECT_HUMAN_REVIEW_INVALID', 'This collaboration grant does not authorize direct-human review.', ExitCode.guard);
    }
    const baselineCommit = exactRepositoryCommit(repository.repositoryRoot, payload.baselineCommit);
    const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
    const verifier = options.signer ??
        createInteractiveSshSigner(repository.repositoryRoot, policy);
    const now = exactDate(options.now ?? new Date());
    validateCollaborationGrantEnvelope(grant, policy, {
        now,
        expected: bindingFromPayload(payload),
        verifier,
    });
    verifier.assertHumanPresent();
    const identity = verifier.identity();
    if (identity !== payload.signer ||
        identity !== payload.availableActor.identity) {
        throw workflowError('DIRECT_HUMAN_REVIEW_INVALID', 'Direct-human review signer does not match the exact collaboration grant.', ExitCode.guard);
    }
    const attestationPayload = {
        version: 1,
        grantId: payload.grantId,
        signedEnvelopeDigest: collaborationGrantEnvelopeDigest(grant),
        transitionDigest: exactDigestValue(request.transitionDigest, 'transition digest'),
        targetDigest: payload.targetDigest,
        reviewNodeId: exactDigestValue(request.reviewNodeId, 'review node ID'),
        reviewResultDigest: exactDigestValue(request.reviewResultDigest, 'review result digest'),
        signedAt: now.toISOString(),
        signer: identity,
    };
    const canonical = canonicalDirectHumanReviewPayload(attestationPayload);
    let signature;
    try {
        signature = verifier.sign(canonical, DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE);
        assertArmoredSignature(signature);
        verifier.verify(canonical, signature, identity, DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE);
    }
    catch (error) {
        throw collaborationSignatureInvalid(error);
    }
    return deepFreeze({ payload: attestationPayload, signature });
}
export function validateDirectHumanReviewAttestation(attestation, options) {
    if (!isPlainRecord(attestation) ||
        !hasExactDataKeys(attestation, ['payload', 'signature']) ||
        !isPlainRecord(attestation.payload) ||
        !hasExactDataKeys(attestation.payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
        typeof attestation.signature !== 'string') {
        throw directHumanReviewInvalid();
    }
    const parsed = parseDirectHumanReviewAttestation(canonicalDirectHumanReviewAttestation(attestation));
    const grant = validateCollaborationGrantEnvelope(options.grantEnvelope, options.policy, {
        now: options.now,
        expected: bindingFromPayload(options.grantEnvelope.payload),
        verifier: options.verifier,
        allowExpired: true,
    });
    const grantPayload = grant.payload;
    const signedAt = exactTimestamp(parsed.payload.signedAt);
    if (grantPayload.degradedForm !== 'direct-human-review' ||
        grantPayload.availableActor.kind !== 'direct-human' ||
        parsed.payload.grantId !== grantPayload.grantId ||
        parsed.payload.signedEnvelopeDigest !==
            collaborationGrantEnvelopeDigest(grant) ||
        parsed.payload.transitionDigest !== options.transitionDigest ||
        parsed.payload.targetDigest !== grantPayload.targetDigest ||
        parsed.payload.reviewNodeId !== options.reviewNodeId ||
        parsed.payload.reviewResultDigest !== options.reviewResultDigest ||
        parsed.payload.signer !== grantPayload.signer ||
        parsed.payload.signer !== grantPayload.availableActor.identity ||
        signedAt === undefined ||
        signedAt < Date.parse(grantPayload.issuedAt) ||
        signedAt > Date.parse(grantPayload.expiresAt) ||
        signedAt > exactDate(options.now).getTime() + 30_000) {
        throw directHumanReviewInvalid();
    }
    try {
        options.verifier.verify(canonicalDirectHumanReviewPayload(parsed.payload), parsed.signature, parsed.payload.signer, DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE);
    }
    catch (error) {
        throw collaborationSignatureInvalid(error);
    }
    return parsed;
}
export function validateCollaborationGrantEnvelope(envelope, policy, options) {
    if (!isPlainRecord(envelope) ||
        !hasExactDataKeys(envelope, ['payload', 'signature']) ||
        !isPlainRecord(envelope.payload) ||
        !hasExactDataKeys(envelope.payload, PAYLOAD_KEYS) ||
        typeof envelope.signature !== 'string') {
        throw collaborationInvalid('Collaboration grant envelope shape is invalid.');
    }
    const parsed = parseCollaborationGrantEnvelope(canonicalCollaborationGrantEnvelope(envelope));
    validateCollaborationGrantPayload(parsed.payload, policy, {
        now: options.now,
        expectedPolicyBlob: options.expected.policyBlob,
        allowExpired: options.allowExpired,
    });
    if (canonicalExpectedBinding(bindingFromPayload(parsed.payload)) !==
        canonicalExpectedBinding(options.expected)) {
        throw collaborationBindingMismatch('Collaboration grant does not match the exact requested transition.');
    }
    try {
        options.verifier.verify(canonicalCollaborationGrantPayload(parsed.payload), parsed.signature, parsed.payload.signer, COLLABORATION_GRANT_SIGNATURE_NAMESPACE);
    }
    catch (error) {
        throw collaborationSignatureInvalid(error);
    }
    return parsed;
}
export function validateCollaborationGrantPayload(payload, policy, options) {
    assertCollaborationPayloadShape(payload);
    if (payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        payload.policyBlob !== options.expectedPolicyBlob ||
        payload.collaborationPolicyDigest !==
            collaborationPolicyDigestForPhase(payload.lifecyclePhase) ||
        !policy.trustedSigners.some(({ identity }) => identity === payload.signer) ||
        payload.maxUses !== 1 ||
        policy.maxUses !== 1) {
        throw collaborationBindingMismatch('Collaboration grant does not match trusted repository policy.');
    }
    const issuedAt = exactTimestamp(payload.issuedAt);
    const expiresAt = exactTimestamp(payload.expiresAt);
    const now = exactDate(options.now).getTime();
    if (issuedAt === undefined ||
        expiresAt === undefined ||
        issuedAt > expiresAt ||
        expiresAt - issuedAt >
            Math.min(policy.maxTtlMinutes, COLLABORATION_GRANT_MAX_TTL_MINUTES) *
                60_000 ||
        issuedAt > now + 30_000) {
        throw collaborationInvalid('Collaboration grant has invalid time bounds.');
    }
    if (!options.allowExpired && expiresAt < now) {
        throw workflowError('COLLABORATION_GRANT_EXPIRED', 'Collaboration grant has expired.', ExitCode.staleState);
    }
}
/**
 * Reject a grant or signed envelope claimed more than once across a complete
 * subject. Every collaboration grant is issued with `maxUses: 1`, so a repeated
 * identity is a duplicate claim even when each use validated in isolation.
 * Live transitions and CI replay share this rule; neither consults the mutable
 * common-directory reservation store to apply it.
 */
export function assertUniqueCollaborationGrantUses(uses) {
    const grantIds = new Set();
    const envelopeDigests = new Set();
    for (const use of uses) {
        if (grantIds.has(use.grantId) ||
            envelopeDigests.has(use.signedEnvelopeDigest)) {
            throw workflowError('COLLABORATION_GRANT_USE_DUPLICATE', 'A collaboration grant use is claimed more than once in this subject.', ExitCode.staleState);
        }
        grantIds.add(use.grantId);
        envelopeDigests.add(use.signedEnvelopeDigest);
    }
}
export function bindingFromPayload(payload) {
    return {
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        policyBlob: payload.policyBlob,
        collaborationPolicyDigest: payload.collaborationPolicyDigest,
        changeId: payload.changeId,
        taskId: payload.taskId,
        baselineCommit: payload.baselineCommit,
        baselineTree: payload.baselineTree,
        targetDigest: payload.targetDigest,
        lifecyclePhase: payload.lifecyclePhase,
        rolePair: canonicalRolePair(payload.rolePair),
        availableActor: canonicalAvailableActor(payload.availableActor),
        degradedForm: payload.degradedForm,
        reason: payload.reason,
    };
}
function assertCollaborationPayloadShape(payload) {
    if (!isPlainRecord(payload) ||
        !hasExactDataKeys(payload, PAYLOAD_KEYS) ||
        payload.version !== 1 ||
        !GRANT_ID.test(payload.grantId) ||
        typeof payload.repositoryId !== 'string' ||
        payload.repositoryId.length === 0 ||
        typeof payload.repositoryOrigin !== 'string' ||
        payload.repositoryOrigin.length === 0 ||
        !FULL_OID.test(payload.policyBlob) ||
        !DIGEST.test(payload.collaborationPolicyDigest) ||
        !FULL_OID.test(payload.baselineCommit) ||
        !FULL_OID.test(payload.baselineTree) ||
        payload.baselineCommit.length !== payload.baselineTree.length ||
        !DIGEST.test(payload.targetDigest) ||
        payload.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
        payload.maxUses !== 1 ||
        !validReason(payload.reason) ||
        !IDENTITY.test(payload.signer)) {
        throw collaborationInvalid('Collaboration grant payload shape is invalid.');
    }
    try {
        assertChangeId(payload.changeId);
        if (payload.taskId !== null) {
            assertTaskId(payload.taskId);
        }
    }
    catch {
        throw collaborationInvalid('Collaboration grant change or task binding is invalid.');
    }
    assertRolePhase(payload.lifecyclePhase, payload.rolePair);
    if (!collaborationPermittedForms(payload.lifecyclePhase).includes(payload.degradedForm)) {
        throw collaborationInvalid('Collaboration policy does not permit this degraded form.');
    }
    assertAvailableActor(payload.availableActor, payload.degradedForm, payload);
}
export function collaborationPolicyDigestForPhase(phase) {
    return phase === 'task-diff-review'
        ? TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST
        : COLLABORATION_GRANT_POLICY_DIGEST;
}
function collaborationPermittedForms(phase) {
    return phase === 'task-diff-review'
        ? TASK_DIFF_REVIEW_COLLABORATION_POLICY.permittedForms['task-diff-review']
        : COLLABORATION_GRANT_POLICY.permittedForms[phase];
}
function assertRolePhase(phase, rolePair) {
    if (!isPlainRecord(rolePair) ||
        !hasExactDataKeys(rolePair, ['authorRole', 'conflictingRole'])) {
        throw collaborationInvalid('Collaboration grant role pair is invalid.');
    }
    const valid = (phase === 'blind-survey' &&
        rolePair.authorRole === 'investigation-author' &&
        rolePair.conflictingRole === 'blind-surveyor') ||
        (phase === 'plan-review' &&
            rolePair.authorRole === 'plan-author' &&
            rolePair.conflictingRole === 'plan-reviewer') ||
        (phase === 'task-diff-review' &&
            rolePair.authorRole === 'task-implementer' &&
            rolePair.conflictingRole === 'task-diff-reviewer') ||
        (phase === 'task-implementation' &&
            rolePair.authorRole === 'red-author' &&
            rolePair.conflictingRole === 'task-implementer');
    if (!valid) {
        throw collaborationInvalid('Collaboration grant lifecycle phase and roles do not match.');
    }
}
function assertAvailableActor(actor, form, payload) {
    if (!isPlainRecord(actor)) {
        throw collaborationInvalid('Collaboration grant available actor is invalid.');
    }
    if (form === 'same-provider-fresh-session' &&
        hasExactDataKeys(actor, ['kind', 'providerId', 'assurance']) &&
        actor.kind === 'provider' &&
        isProviderId(actor.providerId) &&
        isActorAssurance(actor.assurance)) {
        return;
    }
    if (form === 'caller-supplied' &&
        hasExactDataKeys(actor, ['kind', 'callerId', 'assurance']) &&
        actor.kind === 'caller' &&
        typeof actor.callerId === 'string' &&
        IDENTITY.test(actor.callerId) &&
        isActorAssurance(actor.assurance)) {
        return;
    }
    if (form === 'direct-human-review' &&
        (payload.lifecyclePhase === 'plan-review' ||
            payload.lifecyclePhase === 'task-diff-review') &&
        hasExactDataKeys(actor, ['kind', 'identity', 'assurance']) &&
        actor.kind === 'direct-human' &&
        actor.identity === payload.signer &&
        actor.assurance === 'maintainer-signed') {
        return;
    }
    throw collaborationInvalid('Collaboration grant degraded form and available actor do not match.');
}
function canonicalRolePair(pair) {
    return {
        authorRole: pair.authorRole,
        conflictingRole: pair.conflictingRole,
    };
}
function canonicalAvailableActor(actor) {
    if (actor.kind === 'provider') {
        return {
            kind: 'provider',
            providerId: actor.providerId,
            assurance: actor.assurance,
        };
    }
    if (actor.kind === 'caller') {
        return {
            kind: 'caller',
            callerId: actor.callerId,
            assurance: actor.assurance,
        };
    }
    return {
        kind: 'direct-human',
        identity: actor.identity,
        assurance: 'maintainer-signed',
    };
}
function canonicalExpectedBinding(binding) {
    return JSON.stringify({
        repositoryId: binding.repositoryId,
        repositoryOrigin: binding.repositoryOrigin,
        policyBlob: binding.policyBlob,
        collaborationPolicyDigest: binding.collaborationPolicyDigest,
        changeId: binding.changeId,
        taskId: binding.taskId,
        baselineCommit: binding.baselineCommit,
        baselineTree: binding.baselineTree,
        targetDigest: binding.targetDigest,
        lifecyclePhase: binding.lifecyclePhase,
        rolePair: canonicalRolePair(binding.rolePair),
        availableActor: canonicalAvailableActor(binding.availableActor),
        degradedForm: binding.degradedForm,
        reason: binding.reason,
    });
}
function loadPolicyAtCommit(repositoryRoot, commit) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            `${commit}:workflow/maintainer-policy.json`,
        ])));
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw error;
        }
        throw collaborationInvalid('The exact baseline does not contain a valid maintainer policy.');
    }
}
function exactRepositoryCommit(repositoryRoot, requested) {
    if (typeof requested !== 'string' || !FULL_OID.test(requested)) {
        throw collaborationInvalid('Collaboration grant baseline must be a full commit object ID.');
    }
    const resolved = runGit(repositoryRoot, [
        'rev-parse',
        `${requested}^{commit}`,
    ]).trim();
    if (resolved !== requested) {
        throw collaborationBindingMismatch('Collaboration grant baseline is not the exact requested commit.');
    }
    return resolved;
}
function assertArmoredSignature(signature) {
    if (typeof signature !== 'string' ||
        signature.length > 16_384 ||
        signature.includes('\r') ||
        !/^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/.test(signature)) {
        throw workflowError('COLLABORATION_SIGNATURE_INVALID', 'Collaboration grant SSH signature is invalid.', ExitCode.verification);
    }
}
function assertDirectHumanReviewPayload(payload) {
    if (!isPlainRecord(payload) ||
        !hasExactDataKeys(payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
        payload.version !== 1 ||
        !GRANT_ID.test(payload.grantId) ||
        !DIGEST.test(payload.signedEnvelopeDigest) ||
        !DIGEST.test(payload.transitionDigest) ||
        !DIGEST.test(payload.targetDigest) ||
        !DIGEST.test(payload.reviewNodeId) ||
        !DIGEST.test(payload.reviewResultDigest) ||
        exactTimestamp(payload.signedAt) === undefined ||
        !IDENTITY.test(payload.signer)) {
        throw directHumanReviewInvalid();
    }
}
function exactDigestValue(value, label) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw workflowError('DIRECT_HUMAN_REVIEW_INVALID', `Direct-human review ${label} is invalid.`, ExitCode.guard);
    }
    return value;
}
function isActorAssurance(value) {
    return (value === 'self-declared' ||
        value === 'runtime-hint' ||
        value === 'adapter-assigned');
}
function validReason(value) {
    return (typeof value === 'string' &&
        value.length >= 12 &&
        value.length <= 500 &&
        value.trim() === value &&
        ![...value].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 31 || (code >= 127 && code <= 159);
        }));
}
function exactTimestamp(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value
        ? time
        : undefined;
}
function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw collaborationInvalid('Collaboration grant time is invalid.');
    }
    return date;
}
function isPlainRecord(value) {
    if (typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        return false;
    }
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor && descriptor.enumerable === true);
}
function hasExactDataKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    return (actual.length === keys.length &&
        actual.every((entry, index) => entry === keys[index]));
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
function fsExistsGrant(directory, grantId) {
    return fs.existsSync(path.join(directory, `${grantId}.json`));
}
function collaborationInvalid(message) {
    return workflowError('COLLABORATION_GRANT_INVALID', message, ExitCode.guard);
}
function collaborationBindingMismatch(message) {
    return workflowError('COLLABORATION_GRANT_BINDING_MISMATCH', message, ExitCode.guard);
}
function collaborationSignatureInvalid(cause) {
    return workflowError('COLLABORATION_SIGNATURE_INVALID', 'Collaboration grant SSH signature is invalid.', ExitCode.verification, {
        details: {
            cause: cause instanceof Error ? cause.message : String(cause),
        },
    });
}
function directHumanReviewInvalid() {
    return workflowError('DIRECT_HUMAN_REVIEW_INVALID', 'Direct-human review attestation is invalid.', ExitCode.guard);
}
