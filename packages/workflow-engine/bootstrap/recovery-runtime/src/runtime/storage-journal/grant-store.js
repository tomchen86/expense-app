import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { isRecord } from '../../foundation/canonical-json/contract-values.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.js';
import { assertApprovalSubject, assertGrantChallenge, createApprovalSubject, } from '../../modules/authority/grant-core.js';
import { freezeGrantCanonical, GRANT_SHA256_DIGEST, GRANT_STABLE_ID, GRANT_UUID_V4, grantHasExactKeys, grantSameStrings, parseGrantTimestamp, } from '../../modules/authority/grant-primitives.js';
const MODULE_VERSION = /^[1-9][0-9]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const RECORD_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const MAX_FILE_BYTES = 1_048_576;
export function grantStorePaths(runtimeRoot) {
    const requestedRoot = path.resolve(runtimeRoot);
    const runtimeStats = fs.lstatSync(requestedRoot, { throwIfNoEntry: false });
    if (!runtimeStats?.isDirectory() || runtimeStats.isSymbolicLink()) {
        throw storeUnsafe();
    }
    const root = path.join(fs.realpathSync(requestedRoot), 'grants-v2');
    return Object.freeze({ root, records: path.join(root, 'records') });
}
export function persistGrantChallenge(paths, candidate) {
    initializeGrantStore(paths);
    const challenge = storeSafe(() => assertGrantChallenge(candidate));
    const record = freezeGrantCanonical({
        schemaVersion: 1,
        kind: 'grant-record.v1',
        state: 'pending',
        challenge,
        recordedAt: challenge.issuedAt,
    });
    const filePath = grantRecordPath(paths, challenge.challengeId);
    const existing = readOptionalCanonicalFile(filePath, assertGrantRecord);
    if (existing !== null) {
        if (existing.state === 'pending' &&
            canonicalJson(existing) === canonicalJson(record)) {
            return existing;
        }
        throw challengeUnavailable(challenge.challengeId);
    }
    createCanonicalFile(filePath, record);
    return record;
}
export function readGrantRecord(paths, challengeId) {
    assertChallengeId(challengeId);
    assertGrantStore(paths);
    const record = readOptionalCanonicalFile(grantRecordPath(paths, challengeId), assertGrantRecord);
    if (record === null) {
        throw workflowError('GRANT_CHALLENGE_NOT_FOUND', `Grant challenge ${challengeId} was not found.`, ExitCode.staleState);
    }
    if (record.challenge.challengeId !== challengeId)
        throw storeUnsafe();
    return record;
}
export function prepareGrantTransition(paths, input) {
    initializeGrantStore(paths);
    const challenge = storeSafe(() => assertGrantChallenge(input.challenge));
    assertChallengeId(challenge.challengeId);
    if (!GRANT_UUID_V4.test(input.operationId))
        throw storeUnsafe();
    const subject = assertSubjectForChallenge(challenge, input.subject);
    const preparedAt = parseGrantTimestamp(input.createdAt);
    if (preparedAt === null ||
        preparedAt.getTime() < new Date(challenge.issuedAt).getTime() ||
        preparedAt.getTime() > new Date(challenge.expiresAt).getTime()) {
        throw storeUnsafe();
    }
    const proofModules = assertProofModules(input.proofModules);
    assertProofMethod(subject, proofModules);
    const filePath = grantRecordPath(paths, challenge.challengeId);
    const current = readGrantRecord(paths, challenge.challengeId);
    if (current.state !== 'pending' ||
        canonicalJson(current.challenge) !== canonicalJson(challenge)) {
        throw challengeUnavailable(challenge.challengeId);
    }
    const prepared = freezeGrantCanonical({
        ...current,
        state: 'prepared',
        operationId: input.operationId,
        approvalSubject: subject,
        proofModules,
        preparedAt: preparedAt.toISOString(),
    });
    replaceCanonicalRecord(filePath, current, prepared, challenge.challengeId);
    return prepared;
}
export function recordGrantTransitionOutcome(paths, input) {
    assertChallengeId(input.challengeId);
    if (!GRANT_UUID_V4.test(input.operationId) ||
        !GRANT_SHA256_DIGEST.test(input.poststateDigest)) {
        throw storeUnsafe();
    }
    const outcome = assertTransitionOutcome(input.outcome);
    const completedAt = parseGrantTimestamp(input.completedAt);
    if (completedAt === null)
        throw storeUnsafe();
    const current = readGrantRecord(paths, input.challengeId);
    if (current.state === 'completed' || current.state === 'failed') {
        if (current.operationId === input.operationId &&
            current.poststateDigest === input.poststateDigest &&
            canonicalJson(current.outcome) === canonicalJson(outcome) &&
            current.completedAt === completedAt.toISOString() &&
            canonicalJson(current.audit) === canonicalJson(input.audit)) {
            return current;
        }
        throw challengeUnavailable(input.challengeId);
    }
    if (current.state !== 'prepared' ||
        current.operationId !== input.operationId ||
        completedAt.getTime() < new Date(current.preparedAt).getTime()) {
        throw challengeUnavailable(input.challengeId);
    }
    const audit = assertGrantAuditRecord(input.audit, current);
    const terminal = freezeGrantCanonical({
        ...current,
        state: outcome.outcome,
        poststateDigest: input.poststateDigest,
        outcome,
        completedAt: completedAt.toISOString(),
        audit,
    });
    replaceCanonicalRecord(grantRecordPath(paths, input.challengeId), current, terminal, input.challengeId);
    return terminal;
}
export function assertGrantLifecycleBarrier(runtimeRoot, allowedChallengeId) {
    if (allowedChallengeId != null)
        assertChallengeId(allowedChallengeId);
    const root = path.join(path.resolve(runtimeRoot), 'grants-v2');
    const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (rootStats === undefined)
        return;
    const paths = grantStorePaths(runtimeRoot);
    assertGrantStore(paths);
    let entries;
    try {
        entries = fs.readdirSync(paths.records, { withFileTypes: true });
    }
    catch {
        throw storeUnsafe();
    }
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink())
            throw storeUnsafe();
        if (!RECORD_FILE.test(entry.name)) {
            if (/\.tmp$/.test(entry.name))
                continue;
            throw storeUnsafe();
        }
        const record = readCanonicalFile(path.join(paths.records, entry.name), assertGrantRecord);
        if (record.state === 'prepared' &&
            record.challenge.challengeId !== allowedChallengeId) {
            throw workflowError('GRANT_TRANSITION_RECOVERY_REQUIRED', `Prepared grant ${record.challenge.challengeId} must be recovered before another repository lifecycle operation.`, ExitCode.staleState);
        }
    }
}
function assertGrantRecord(value) {
    return storeSafe(() => {
        if (!isRecord(value) || typeof value.state !== 'string') {
            throw storeUnsafe();
        }
        const state = value.state;
        const preparedKeys = [
            'operationId',
            'approvalSubject',
            'proofModules',
            'preparedAt',
        ];
        const terminalKeys = ['poststateDigest', 'outcome', 'completedAt', 'audit'];
        const extraKeys = state === 'pending'
            ? []
            : state === 'prepared'
                ? preparedKeys
                : state === 'completed' || state === 'failed'
                    ? [...preparedKeys, ...terminalKeys]
                    : null;
        if (extraKeys === null ||
            !grantHasExactKeys(value, [
                'schemaVersion',
                'kind',
                'state',
                'challenge',
                'recordedAt',
                ...extraKeys,
            ]) ||
            value.schemaVersion !== 1 ||
            value.kind !== 'grant-record.v1' ||
            typeof value.recordedAt !== 'string') {
            throw storeUnsafe();
        }
        const challenge = assertGrantChallenge(value.challenge);
        if (value.recordedAt !== challenge.issuedAt)
            throw storeUnsafe();
        const base = {
            schemaVersion: 1,
            kind: 'grant-record.v1',
            state: 'pending',
            challenge,
            recordedAt: challenge.issuedAt,
        };
        if (state === 'pending') {
            return freezeGrantCanonical(base);
        }
        const prepared = assertPreparedFields(value, base);
        if (state === 'prepared')
            return prepared;
        if (typeof value.poststateDigest !== 'string' ||
            !GRANT_SHA256_DIGEST.test(value.poststateDigest) ||
            typeof value.completedAt !== 'string') {
            throw storeUnsafe();
        }
        const completedAt = parseGrantTimestamp(value.completedAt);
        if (completedAt === null ||
            completedAt.getTime() < new Date(prepared.preparedAt).getTime()) {
            throw storeUnsafe();
        }
        const outcome = assertTransitionOutcome(value.outcome);
        if (outcome.outcome !== state)
            throw storeUnsafe();
        return freezeGrantCanonical({
            ...prepared,
            state,
            poststateDigest: value.poststateDigest,
            outcome,
            completedAt: completedAt.toISOString(),
            audit: assertGrantAuditRecord(value.audit, prepared),
        });
    });
}
function assertPreparedFields(value, base) {
    if (typeof value.operationId !== 'string' ||
        !GRANT_UUID_V4.test(value.operationId) ||
        !Array.isArray(value.proofModules) ||
        typeof value.preparedAt !== 'string') {
        throw storeUnsafe();
    }
    const subject = assertSubjectForChallenge(base.challenge, value.approvalSubject);
    const proofModules = assertProofModules(value.proofModules);
    const preparedAt = parseGrantTimestamp(value.preparedAt);
    if (preparedAt === null ||
        preparedAt.getTime() < new Date(base.challenge.issuedAt).getTime() ||
        preparedAt.getTime() > new Date(base.challenge.expiresAt).getTime()) {
        throw storeUnsafe();
    }
    assertProofMethod(subject, proofModules);
    return freezeGrantCanonical({
        ...base,
        state: 'prepared',
        operationId: value.operationId,
        approvalSubject: subject,
        proofModules,
        preparedAt: preparedAt.toISOString(),
    });
}
function assertSubjectForChallenge(challenge, value) {
    const subject = storeSafe(() => assertApprovalSubject(value));
    const recreated = storeSafe(() => createApprovalSubject(challenge, {
        choiceId: subject.choiceId,
        approvalMethod: subject.approvalMethod,
        reasonCode: subject.reasonCode,
        reason: subject.reason,
        sessionNonce: subject.sessionNonce,
    }, { now: new Date(challenge.issuedAt) }));
    if (canonicalJson(subject) !== canonicalJson(recreated))
        throw storeUnsafe();
    return subject;
}
function assertProofModules(value) {
    if (!Array.isArray(value) || value.length < 1)
        throw storeUnsafe();
    const identities = new Set();
    return freezeGrantCanonical(value.map((candidate) => {
        if (!isRecord(candidate) ||
            !grantHasExactKeys(candidate, [
                'moduleId',
                'version',
                'claim',
                'proofDigest',
                'identity',
            ]) ||
            typeof candidate.moduleId !== 'string' ||
            !GRANT_STABLE_ID.test(candidate.moduleId) ||
            typeof candidate.version !== 'string' ||
            !MODULE_VERSION.test(candidate.version) ||
            (candidate.claim !== 'fresh-local-device-owner' &&
                candidate.claim !== 'ssh-signature') ||
            typeof candidate.proofDigest !== 'string' ||
            !GRANT_SHA256_DIGEST.test(candidate.proofDigest) ||
            !(candidate.identity === null ||
                (typeof candidate.identity === 'string' &&
                    IDENTITY.test(candidate.identity)))) {
            throw storeUnsafe();
        }
        const identity = `${candidate.moduleId}@${candidate.version}:${candidate.claim}`;
        if (identities.has(identity))
            throw storeUnsafe();
        identities.add(identity);
        return {
            moduleId: candidate.moduleId,
            version: candidate.version,
            claim: candidate.claim,
            proofDigest: candidate.proofDigest,
            identity: candidate.identity,
        };
    }));
}
function assertProofMethod(subject, proofs) {
    if (proofs.length !== 1)
        throw storeUnsafe();
    const proof = proofs[0];
    if (subject.approvalMethod === 'human-presence'
        ? proof.claim !== 'fresh-local-device-owner' || proof.identity !== null
        : proof.claim !== 'ssh-signature' || typeof proof.identity !== 'string') {
        throw storeUnsafe();
    }
}
function assertTransitionOutcome(value) {
    if (!isRecord(value) ||
        !grantHasExactKeys(value, ['outcome', 'details']) ||
        (value.outcome !== 'completed' && value.outcome !== 'failed')) {
        throw storeUnsafe();
    }
    return freezeGrantCanonical({
        outcome: value.outcome,
        details: value.details,
    });
}
function assertGrantAuditRecord(value, prepared) {
    if (!isRecord(value) ||
        !grantHasExactKeys(value, [
            'approvalMethod',
            'authorityClass',
            'identity',
            'identityAssurance',
            'presenceAssurance',
            'proofModules',
        ]) ||
        value.approvalMethod !== prepared.approvalSubject.approvalMethod ||
        !Array.isArray(value.proofModules) ||
        !value.proofModules.every((module) => typeof module === 'string' &&
            /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/.test(module)) ||
        !grantSameStrings(value.proofModules, prepared.proofModules.map(({ moduleId, version }) => `${moduleId}@${version}`)) ||
        !auditAssuranceMatchesMethod(value, prepared)) {
        throw storeUnsafe();
    }
    return freezeGrantCanonical(value);
}
function auditAssuranceMatchesMethod(value, prepared) {
    if (value.approvalMethod === 'human-presence') {
        return (value.authorityClass === 'local-device-owner' &&
            value.identity === null &&
            value.identityAssurance === 'not-asserted' &&
            value.presenceAssurance === 'fresh-os-authentication');
    }
    const sshIdentity = prepared.proofModules[0]?.identity;
    return (value.approvalMethod === 'ssh' &&
        value.authorityClass === 'ssh-credential' &&
        typeof value.identity === 'string' &&
        value.identity === sshIdentity &&
        IDENTITY.test(value.identity) &&
        value.identityAssurance === 'policy-trusted-ssh-key' &&
        value.presenceAssurance === 'not-asserted');
}
function initializeGrantStore(paths) {
    for (const directory of [paths.root, paths.records]) {
        try {
            ensurePlainDirectory(directory);
        }
        catch {
            throw storeUnsafe();
        }
    }
    assertGrantStore(paths);
}
function assertGrantStore(paths) {
    try {
        if (path.dirname(paths.records) !== paths.root ||
            path.basename(paths.records) !== 'records') {
            throw storeUnsafe();
        }
        for (const directory of [paths.root, paths.records]) {
            const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
            if (!stats?.isDirectory() ||
                stats.isSymbolicLink() ||
                fs.realpathSync(directory) !== path.resolve(directory)) {
                throw storeUnsafe();
            }
        }
    }
    catch {
        throw storeUnsafe();
    }
}
function createCanonicalFile(filePath, value) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    }
    catch {
        throw storeUnsafe();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
}
function replaceCanonicalRecord(filePath, expected, replacement, challengeId) {
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
        createCanonicalFile(temporary, replacement);
        const current = readCanonicalFile(filePath, assertGrantRecord);
        if (canonicalJson(current) !== canonicalJson(expected)) {
            throw challengeUnavailable(challengeId);
        }
        fs.renameSync(temporary, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        removeTemporaryFile(temporary);
        if (error instanceof Error && 'code' in error)
            throw error;
        throw storeUnsafe();
    }
}
function readOptionalCanonicalFile(filePath, validate) {
    if (!fs.lstatSync(filePath, { throwIfNoEntry: false }))
        return null;
    return readCanonicalFile(filePath, validate);
}
function readCanonicalFile(filePath, validate) {
    let descriptor;
    try {
        const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
        if (!isPrivatePlainFile(before) || before.size > MAX_FILE_BYTES) {
            throw storeUnsafe();
        }
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        if (!isPrivatePlainFile(opened) ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size > MAX_FILE_BYTES) {
            throw storeUnsafe();
        }
        const document = fs.readFileSync(descriptor, 'utf8');
        const validated = validate(JSON.parse(document));
        if (document !== `${canonicalJson(validated)}\n`)
            throw storeUnsafe();
        return validated;
    }
    catch {
        throw storeUnsafe();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function isPrivatePlainFile(stats) {
    return Boolean(stats?.isFile() &&
        !stats.isSymbolicLink() &&
        stats.nlink === 1 &&
        (stats.mode & 0o777) === 0o600);
}
function removeTemporaryFile(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stats === undefined)
        return;
    if (!isPrivatePlainFile(stats))
        throw storeUnsafe();
    fs.unlinkSync(filePath);
}
function grantRecordPath(paths, challengeId) {
    assertChallengeId(challengeId);
    return path.join(paths.records, `${challengeId}.json`);
}
function assertChallengeId(value) {
    if (typeof value !== 'string' || !GRANT_UUID_V4.test(value)) {
        throw storeUnsafe();
    }
}
function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(descriptor);
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function storeSafe(operation) {
    try {
        return operation();
    }
    catch {
        throw storeUnsafe();
    }
}
function challengeUnavailable(challengeId) {
    return workflowError('GRANT_CHALLENGE_UNAVAILABLE', `Grant challenge ${challengeId} is not available.`, ExitCode.staleState);
}
function storeUnsafe() {
    return workflowError('GRANT_STORE_UNSAFE', 'Grant challenge storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
