import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recordAuthorityAuditEvent, verifyAuthorityAuditEvents, } from '../../authority-audit-service.js';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { ensurePlainDirectory } from '../../filesystem-safety.js';
import { discoverRepository, runGit } from '../../git.js';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.js';
import { createInteractiveSshSigner, } from '../../maintainer-signer.js';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;
const SUBJECT_KINDS = [
    'legacy-maintainer-grant',
    'human-resolution-grant',
    'collaboration-grant',
    'harness-maintenance-grant',
];
export const HUMAN_REVOCATION_SIGNATURE_NAMESPACE = 'expense-app.workflow.human-revocation.v1';
export function digestHumanRevocationSubject(bytes) {
    return digest(bytes);
}
export function canonicalHumanRevocationAuthorizationPayload(payload) {
    return `${canonicalJson(assertPayload(payload))}\n`;
}
export function canonicalHumanRevocationAuthorization(authorization) {
    const checked = assertHumanRevocationAuthorization(authorization);
    return `${canonicalJson(checked)}\n`;
}
export function parseHumanRevocationAuthorization(raw) {
    if (typeof raw !== 'string' ||
        !raw.endsWith('\n') ||
        Buffer.byteLength(raw) > 64 * 1024) {
        throw invalidRevocation();
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw invalidRevocation();
    }
    const checked = assertHumanRevocationAuthorization(value);
    if (`${canonicalJson(checked)}\n` !== raw)
        throw invalidRevocation();
    return checked;
}
export function assertHumanRevocationAuthorization(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['payload', 'signature']) ||
        typeof value.signature !== 'string' ||
        value.signature.length === 0 ||
        value.signature.length > 16_384 ||
        value.signature.includes('\r')) {
        throw invalidRevocation();
    }
    return deepFreeze({
        payload: assertPayload(value.payload),
        signature: value.signature,
    });
}
/**
 * Produces (or replays) a current-human signed revocation authorization,
 * durably prepares its exact bytes, and only then appends binding-derived
 * external audit. Callers terminalize their grant after this returns.
 */
export function authorizeHumanRevocation(cwd, rawBinding, rawOptions, preparationPath, existingAuthorization = null) {
    const binding = assertBinding(rawBinding);
    const reason = boundedText(rawOptions.reason, 1024, 'reason');
    const now = exactDate(rawOptions.now ?? new Date());
    const repository = discoverRepository(cwd);
    const policy = loadCurrentPolicy(repository.repositoryRoot);
    const origin = runGit(repository.repositoryRoot, [
        'remote',
        'get-url',
        'origin',
    ]).trim();
    if (origin !== policy.repository.origin ||
        binding.repositoryId !== policy.repository.id ||
        binding.repositoryOrigin !== policy.repository.origin) {
        throw workflowError('HUMAN_REVOCATION_REPOSITORY_MISMATCH', 'Revocation is not bound to the current trusted repository identity.', ExitCode.guard);
    }
    const signer = rawOptions.signer ??
        createInteractiveSshSigner(repository.repositoryRoot, policy);
    signer.assertHumanPresent();
    const actorIdentity = boundedText(signer.identity(), 192, 'signer identity');
    if (!policy.trustedSigners.some(({ identity }) => identity === actorIdentity)) {
        throw workflowError('HUMAN_REVOCATION_SIGNER_UNTRUSTED', 'Revocation requires a signer trusted by the current HEAD policy.', ExitCode.guard);
    }
    const prepared = readOptionalPreparation(preparationPath);
    if (existingAuthorization !== null &&
        prepared !== null &&
        canonicalHumanRevocationAuthorization(existingAuthorization) !==
            canonicalHumanRevocationAuthorization(prepared)) {
        throw revocationConflict();
    }
    let authorization = existingAuthorization ?? prepared;
    if (authorization !== null) {
        authorization = assertAuthorizationBinding(authorization, binding, reason);
        assertCurrentAuthorizationSignature(authorization, policy, signer);
    }
    else {
        const payload = assertPayload({
            schemaVersion: 1,
            kind: 'human-revocation-authorization.v1',
            ...structuredClone(binding),
            reason,
            revokedAt: now.toISOString(),
            signer: actorIdentity,
        });
        const signature = signer.sign(canonicalHumanRevocationAuthorizationPayload(payload), HUMAN_REVOCATION_SIGNATURE_NAMESPACE);
        authorization = assertHumanRevocationAuthorization({
            payload,
            signature,
        });
        assertCurrentAuthorizationSignature(authorization, policy, signer);
    }
    persistExactPreparation(preparationPath, authorization);
    appendRevocationAudit(repository.repositoryRoot, authorization);
    rawOptions.testAfterAudit?.();
    return authorization;
}
function appendRevocationAudit(repositoryRoot, authorization) {
    const payload = authorization.payload;
    if (payload.audit === null)
        return;
    const scope = Object.freeze({
        externalAuditRoot: payload.audit.externalAuditRoot,
        repositoryRoot,
        repositoryId: payload.audit.repositoryId,
    });
    verifyAuthorityAuditEvents(scope);
    const outcomeDigest = digest(canonicalHumanRevocationAuthorization(authorization));
    recordAuthorityAuditEvent(scope, {
        eventType: 'revoke',
        occurredAt: payload.revokedAt,
        idempotencyKey: digest(canonicalJson({
            schemaVersion: 1,
            kind: 'human-revocation-audit-identity.v1',
            subjectKind: payload.subjectKind,
            grantId: payload.grantId,
            grantDigest: payload.grantDigest,
            reason: payload.reason,
        })),
        actor: { kind: 'human', identity: payload.signer },
        taskId: payload.taskId,
        changeId: payload.changeId,
        workflowId: payload.workflowId,
        grantDigest: payload.grantDigest,
        candidateBundleDigest: null,
        prestateDigest: payload.grantDigest,
        poststateDigest: outcomeDigest,
        command: {
            name: `${payload.subjectKind}.revoke`,
            argvDigest: digest(canonicalJson({
                grantId: payload.grantId,
                reason: payload.reason,
            })),
        },
        providerInvocation: null,
        externalEffect: null,
        result: 'revoked',
        outcomeDigest,
        errorCode: null,
    });
}
function assertCurrentAuthorizationSignature(authorization, policy, verifier) {
    if (!policy.trustedSigners.some(({ identity }) => identity === authorization.payload.signer)) {
        throw workflowError('HUMAN_REVOCATION_SIGNER_UNTRUSTED', 'The durable revocation tombstone signer is no longer trusted.', ExitCode.guard);
    }
    verifier.verify(canonicalHumanRevocationAuthorizationPayload(authorization.payload), authorization.signature, authorization.payload.signer, HUMAN_REVOCATION_SIGNATURE_NAMESPACE);
}
function assertAuthorizationBinding(authorization, binding, reason) {
    const checked = assertHumanRevocationAuthorization(authorization);
    const observed = checked.payload;
    if (observed.reason !== reason ||
        canonicalJson({
            subjectKind: observed.subjectKind,
            grantId: observed.grantId,
            grantDigest: observed.grantDigest,
            repositoryId: observed.repositoryId,
            repositoryOrigin: observed.repositoryOrigin,
            changeId: observed.changeId,
            taskId: observed.taskId,
            workflowId: observed.workflowId,
            audit: observed.audit,
        }) !== canonicalJson(binding)) {
        throw revocationConflict();
    }
    return checked;
}
function persistExactPreparation(preparationPath, authorization) {
    if (!path.isAbsolute(preparationPath))
        throw invalidRevocation();
    const parent = path.dirname(preparationPath);
    ensurePlainDirectory(parent);
    fs.chmodSync(parent, 0o700);
    const bytes = canonicalHumanRevocationAuthorization(authorization);
    const existing = readOptionalPreparation(preparationPath);
    if (existing !== null) {
        if (canonicalHumanRevocationAuthorization(existing) !== bytes) {
            throw revocationConflict();
        }
        return;
    }
    let descriptor;
    try {
        descriptor = fs.openSync(preparationPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(descriptor, bytes, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fsyncDirectory(parent);
    }
    catch (error) {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        if (isNodeError(error) && error.code === 'EEXIST') {
            const raced = readOptionalPreparation(preparationPath);
            if (raced !== null &&
                canonicalHumanRevocationAuthorization(raced) === bytes) {
                return;
            }
            throw revocationConflict();
        }
        throw error;
    }
}
function readOptionalPreparation(preparationPath) {
    const stats = fs.lstatSync(preparationPath, { throwIfNoEntry: false });
    if (!stats)
        return null;
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o600) {
        throw invalidRevocation();
    }
    return parseHumanRevocationAuthorization(fs.readFileSync(preparationPath, 'utf8'));
}
function loadCurrentPolicy(repositoryRoot) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            'HEAD:workflow/maintainer-policy.json',
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error)
            throw error;
        throw workflowError('MAINTAINER_POLICY_INVALID', 'The current HEAD does not contain a valid maintainer policy.', ExitCode.guard);
    }
}
function assertBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'subjectKind',
            'grantId',
            'grantDigest',
            'repositoryId',
            'repositoryOrigin',
            'changeId',
            'taskId',
            'workflowId',
            'audit',
        ]) ||
        !SUBJECT_KINDS.includes(value.subjectKind) ||
        !validSubject(value.grantId) ||
        !SHA256.test(String(value.grantDigest)) ||
        !validSubject(value.repositoryId) ||
        typeof value.repositoryOrigin !== 'string' ||
        value.repositoryOrigin.length === 0 ||
        value.repositoryOrigin.length > 2048 ||
        !validSubject(value.changeId) ||
        !validNullableSubject(value.taskId) ||
        !validNullableSubject(value.workflowId)) {
        throw invalidRevocation();
    }
    let audit = null;
    if (value.audit !== null) {
        if (!isRecord(value.audit) ||
            !hasExactKeys(value.audit, ['externalAuditRoot', 'repositoryId']) ||
            typeof value.audit.externalAuditRoot !== 'string' ||
            !path.isAbsolute(value.audit.externalAuditRoot) ||
            path.normalize(value.audit.externalAuditRoot) !==
                value.audit.externalAuditRoot ||
            !SHA256.test(String(value.audit.repositoryId))) {
            throw invalidRevocation();
        }
        audit = Object.freeze({
            externalAuditRoot: value.audit.externalAuditRoot,
            repositoryId: value.audit.repositoryId,
        });
    }
    return deepFreeze({
        subjectKind: value.subjectKind,
        grantId: value.grantId,
        grantDigest: value.grantDigest,
        repositoryId: value.repositoryId,
        repositoryOrigin: value.repositoryOrigin,
        changeId: value.changeId,
        taskId: value.taskId,
        workflowId: value.workflowId,
        audit,
    });
}
function assertPayload(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'subjectKind',
            'grantId',
            'grantDigest',
            'repositoryId',
            'repositoryOrigin',
            'changeId',
            'taskId',
            'workflowId',
            'audit',
            'reason',
            'revokedAt',
            'signer',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'human-revocation-authorization.v1') {
        throw invalidRevocation();
    }
    const binding = assertBinding({
        subjectKind: value.subjectKind,
        grantId: value.grantId,
        grantDigest: value.grantDigest,
        repositoryId: value.repositoryId,
        repositoryOrigin: value.repositoryOrigin,
        changeId: value.changeId,
        taskId: value.taskId,
        workflowId: value.workflowId,
        audit: value.audit,
    });
    return deepFreeze({
        schemaVersion: 1,
        kind: 'human-revocation-authorization.v1',
        ...structuredClone(binding),
        reason: boundedText(value.reason, 1024, 'reason'),
        revokedAt: exactTimestamp(value.revokedAt),
        signer: boundedText(value.signer, 192, 'signer'),
    });
}
function validSubject(value) {
    return typeof value === 'string' && SUBJECT.test(value);
}
function validNullableSubject(value) {
    return value === null || validSubject(value);
}
function boundedText(value, max, label) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0 ||
        value.length > max ||
        containsControlCharacter(value)) {
        throw workflowError('HUMAN_REVOCATION_INVALID', `Human revocation ${label} is invalid.`, ExitCode.guard);
    }
    return value;
}
function containsControlCharacter(value) {
    return [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
}
function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
        throw invalidRevocation();
    return date;
}
function exactTimestamp(value) {
    if (typeof value !== 'string')
        throw invalidRevocation();
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
        throw invalidRevocation();
    }
    return value;
}
function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return (actual.length === sorted.length &&
        actual.every((key, index) => key === sorted[index]));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
    }
    return value;
}
function invalidRevocation() {
    return workflowError('HUMAN_REVOCATION_INVALID', 'Human revocation authorization is invalid or unsafe.', ExitCode.guard);
}
function revocationConflict() {
    return workflowError('HUMAN_REVOCATION_CONFLICT', 'The grant already has a different durable revocation authorization.', ExitCode.conflict);
}
