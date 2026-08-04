import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from './filesystem-safety.js';
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREPARED_LOCK_ALIAS = /^append\.lock\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const LOCK_RECLAIM_CLAIM = /^append\.lock\.reclaim\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const FINAL_RECORD_NAME = /^([0-9]{16})-([0-9a-f]{64})\.json$/;
const PUBLICATION_RECORD_NAME = /^\.([0-9]{16})-([0-9a-f]{64})\.json\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;
const MAX_PATH_BYTES = 4_096;
const MAX_REPOSITORY_ID_BYTES = 512;
const MAX_RECORD_BYTES = 4_096;
const LOCK_NAME = 'append.lock';
const RECORD_KEYS = [
    'candidateBundleDigest',
    'eventType',
    'grantDigest',
    'idempotencyKey',
    'kind',
    'occurredAt',
    'poststateDigest',
    'prestateDigest',
    'previousRecordDigest',
    'repositoryId',
    'result',
    'resultDigest',
    'schemaVersion',
    'sequence',
];
const APPEND_INPUT_KEYS = [
    'candidateBundleDigest',
    'eventType',
    'grantDigest',
    'idempotencyKey',
    'occurredAt',
    'poststateDigest',
    'prestateDigest',
    'result',
    'resultDigest',
];
const SCOPE_KEYS = [
    'externalAuditRoot',
    'repositoryId',
    'repositoryRoot',
];
const LOCK_KEYS = [
    'kind',
    'ownerToken',
    'pid',
    'repositoryId',
    'schemaVersion',
];
export const AUTHORITY_AUDIT_EVENT_TYPES = Object.freeze([
    'abort',
    'apply-grant',
    'branch-update',
    'candidate-bundle',
    'cas',
    'command',
    'control-plane-grant',
    'error',
    'escalation-request',
    'external-effect',
    'file-change',
    'grant-consume',
    'poststate',
    'provider-invocation',
    'recovery',
    'revoke',
    'rollback',
    'supersede',
    'task-mandate',
]);
export const AUTHORITY_AUDIT_RESULTS = Object.freeze([
    'aborted',
    'failed',
    'recorded',
    'revoked',
    'rolled-back',
    'succeeded',
    'superseded',
]);
export function deriveAuthorityAuditRepositoryId(repositoryIdentity) {
    if (typeof repositoryIdentity !== 'string' ||
        repositoryIdentity.length === 0 ||
        repositoryIdentity.trim() !== repositoryIdentity ||
        Buffer.byteLength(repositoryIdentity) > MAX_REPOSITORY_ID_BYTES ||
        [...repositoryIdentity].some((character) => {
            const point = character.codePointAt(0) ?? 0;
            return point <= 31 || (point >= 127 && point <= 159);
        })) {
        throw invalidScope();
    }
    return sha256Digest(canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-repository.v1',
        repositoryIdentity,
    }));
}
export function authorityAuditLedgerPaths(scope) {
    const checked = assertScope(scope);
    return ledgerPathsForScope(checked);
}
function ledgerPathsForScope(checked) {
    const namespace = checked.repositoryId.slice('sha256:'.length);
    const repositories = path.join(checked.externalAuditRoot, 'repositories');
    const repository = path.join(repositories, namespace);
    return Object.freeze({
        externalAuditRoot: checked.externalAuditRoot,
        repositories,
        repository,
        events: path.join(repository, 'events'),
        records: path.join(repository, 'records'),
        locks: path.join(repository, 'locks'),
        appendLock: path.join(repository, 'locks', LOCK_NAME),
    });
}
export function appendAuthorityAuditRecord(scope, rawInput, options = {}) {
    const input = assertAppendInput(rawInput);
    const prepared = prepareLedger(scope);
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId);
        const records = scanRecords(prepared.paths, prepared.scope.repositoryId);
        const duplicate = records.find(({ record }) => record.idempotencyKey === input.idempotencyKey);
        if (duplicate !== undefined) {
            if (!recordMatchesInput(duplicate.record, input)) {
                throw idempotencyConflict();
            }
            return duplicate;
        }
        const previous = records.at(-1);
        const record = freezeRecord({
            schemaVersion: 1,
            kind: 'authority-audit-record.v1',
            repositoryId: prepared.scope.repositoryId,
            sequence: (previous?.record.sequence ?? 0) + 1,
            occurredAt: input.occurredAt,
            eventType: input.eventType,
            idempotencyKey: input.idempotencyKey,
            previousRecordDigest: previous?.recordDigest ?? null,
            grantDigest: input.grantDigest,
            candidateBundleDigest: input.candidateBundleDigest,
            prestateDigest: input.prestateDigest,
            poststateDigest: input.poststateDigest,
            result: input.result,
            resultDigest: input.resultDigest,
        });
        const content = canonicalRecordContent(record);
        const entry = freezeEntry({
            recordDigest: sha256Digest(content),
            record,
        });
        publishRecord(prepared.paths, entry, content, options);
        return entry;
    });
}
export function scanAuthorityAuditLedger(scope) {
    const prepared = prepareLedger(scope);
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId);
        const records = scanRecords(prepared.paths, prepared.scope.repositoryId);
        const head = records.at(-1);
        return Object.freeze({
            repositoryId: prepared.scope.repositoryId,
            recordCount: records.length,
            headSequence: head?.record.sequence ?? 0,
            headRecordDigest: head?.recordDigest ?? null,
            records: Object.freeze(records),
        });
    });
}
function prepareLedger(rawScope) {
    const scope = assertScope(rawScope);
    const paths = ledgerPathsForScope(scope);
    assertRepositoryRoot(scope.repositoryRoot);
    ensurePrivateRoot(paths.externalAuditRoot);
    const realAuditRoot = fs.realpathSync(paths.externalAuditRoot);
    const realRepositoryRoot = fs.realpathSync(scope.repositoryRoot);
    if (pathsOverlap(realAuditRoot, realRepositoryRoot)) {
        throw externalRootRequired();
    }
    ensurePrivateDirectory(paths.repositories);
    ensurePrivateDirectory(paths.repository);
    ensurePrivateDirectory(paths.events);
    ensurePrivateDirectory(paths.records);
    ensurePrivateDirectory(paths.locks);
    assertLayout(paths);
    return Object.freeze({ scope, paths });
}
function assertScope(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, SCOPE_KEYS)) {
        throw invalidScope();
    }
    const externalAuditRoot = assertAbsolutePath(raw.externalAuditRoot);
    const repositoryRoot = assertAbsolutePath(raw.repositoryRoot);
    const repositoryId = assertDigest(raw.repositoryId, invalidScope);
    if (pathsOverlap(externalAuditRoot, repositoryRoot)) {
        throw externalRootRequired();
    }
    return Object.freeze({
        externalAuditRoot,
        repositoryRoot,
        repositoryId,
    });
}
function assertAppendInput(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, APPEND_INPUT_KEYS)) {
        throw invalidRecord();
    }
    if (!includes(AUTHORITY_AUDIT_EVENT_TYPES, raw.eventType) ||
        !includes(AUTHORITY_AUDIT_RESULTS, raw.result) ||
        !isCanonicalTimestamp(raw.occurredAt)) {
        throw invalidRecord();
    }
    return Object.freeze({
        eventType: raw.eventType,
        occurredAt: raw.occurredAt,
        idempotencyKey: assertDigest(raw.idempotencyKey, invalidRecord),
        grantDigest: assertNullableDigest(raw.grantDigest, invalidRecord),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest, invalidRecord),
        prestateDigest: assertNullableDigest(raw.prestateDigest, invalidRecord),
        poststateDigest: assertNullableDigest(raw.poststateDigest, invalidRecord),
        result: raw.result,
        resultDigest: assertDigest(raw.resultDigest, invalidRecord),
    });
}
function assertStoredRecord(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, RECORD_KEYS)) {
        throw invalidLedger();
    }
    if (raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-record.v1' ||
        !Number.isSafeInteger(raw.sequence) ||
        typeof raw.sequence !== 'number' ||
        raw.sequence < 1 ||
        !includes(AUTHORITY_AUDIT_EVENT_TYPES, raw.eventType) ||
        !includes(AUTHORITY_AUDIT_RESULTS, raw.result) ||
        !isCanonicalTimestamp(raw.occurredAt)) {
        throw invalidLedger();
    }
    return freezeRecord({
        schemaVersion: 1,
        kind: 'authority-audit-record.v1',
        repositoryId: assertDigest(raw.repositoryId, invalidLedger),
        sequence: raw.sequence,
        occurredAt: raw.occurredAt,
        eventType: raw.eventType,
        idempotencyKey: assertDigest(raw.idempotencyKey, invalidLedger),
        previousRecordDigest: assertNullableDigest(raw.previousRecordDigest, invalidLedger),
        grantDigest: assertNullableDigest(raw.grantDigest, invalidLedger),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest, invalidLedger),
        prestateDigest: assertNullableDigest(raw.prestateDigest, invalidLedger),
        poststateDigest: assertNullableDigest(raw.poststateDigest, invalidLedger),
        result: raw.result,
        resultDigest: assertDigest(raw.resultDigest, invalidLedger),
    });
}
function recoverRecordPublications(paths, repositoryId) {
    const entries = fs.readdirSync(paths.records).sort();
    const publications = entries.filter((entry) => PUBLICATION_RECORD_NAME.test(entry));
    for (const entry of entries) {
        if (!FINAL_RECORD_NAME.test(entry) &&
            !PUBLICATION_RECORD_NAME.test(entry)) {
            throw invalidLedger();
        }
    }
    // First remove publication aliases whose final content-addressed record is
    // already present. This restores each final file to nlink=1 before scanning.
    for (const publication of publications) {
        const parsed = parsePublication(paths, publication, repositoryId);
        const finalPath = path.join(paths.records, parsed.finalName);
        const finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
        if (finalStats === undefined) {
            continue;
        }
        const final = readRecordPath(finalPath, [1, 2]);
        if (final.content !== parsed.content ||
            (parsed.stats.nlink === 2 &&
                (parsed.stats.dev !== final.stats.dev ||
                    parsed.stats.ino !== final.stats.ino))) {
            throw invalidLedger();
        }
        fs.unlinkSync(parsed.path);
        fsyncDirectory(paths.records);
    }
    let records = scanRecords(paths, repositoryId, true);
    for (const publication of publications) {
        const publicationPath = path.join(paths.records, publication);
        if (!fs.existsSync(publicationPath)) {
            continue;
        }
        const parsed = parsePublication(paths, publication, repositoryId);
        const finalPath = path.join(paths.records, parsed.finalName);
        const existing = fs.lstatSync(finalPath, { throwIfNoEntry: false });
        if (existing !== undefined) {
            const final = readRecordPath(finalPath, [1]);
            if (final.content !== parsed.content) {
                throw invalidLedger();
            }
            fs.unlinkSync(parsed.path);
            fsyncDirectory(paths.records);
            continue;
        }
        if (parsed.stats.nlink !== 1) {
            throw unsafeFilesystem();
        }
        const head = records.at(-1);
        if (parsed.record.repositoryId !== repositoryId ||
            parsed.record.sequence !== (head?.record.sequence ?? 0) + 1 ||
            parsed.record.previousRecordDigest !== (head?.recordDigest ?? null)) {
            throw invalidLedger();
        }
        try {
            fs.linkSync(parsed.path, finalPath);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST') {
                throw error;
            }
            throw invalidLedger();
        }
        fsyncDirectory(paths.records);
        fs.unlinkSync(parsed.path);
        fsyncDirectory(paths.records);
        records = scanRecords(paths, repositoryId, true);
    }
}
function scanRecords(paths, repositoryId, allowPublications = false) {
    const observedNames = fs.readdirSync(paths.records).sort();
    if (observedNames.some((name) => !FINAL_RECORD_NAME.test(name) &&
        !(allowPublications && PUBLICATION_RECORD_NAME.test(name)))) {
        throw invalidLedger();
    }
    const names = observedNames.filter((name) => FINAL_RECORD_NAME.test(name));
    const records = [];
    const idempotencyKeys = new Set();
    let expectedPrevious = null;
    let expectedSequence = 1;
    for (const name of names) {
        const match = FINAL_RECORD_NAME.exec(name);
        if (match === null || match[1] === undefined || match[2] === undefined) {
            throw invalidLedger();
        }
        const sequence = Number(match[1]);
        const recordPath = path.join(paths.records, name);
        const stored = readRecordPath(recordPath, [1]);
        const record = parseCanonicalRecord(stored.content);
        const recordDigest = sha256Digest(stored.content);
        if (sequence !== expectedSequence ||
            record.sequence !== expectedSequence ||
            record.repositoryId !== repositoryId ||
            record.previousRecordDigest !== expectedPrevious ||
            match[2] !== recordDigest.slice('sha256:'.length) ||
            idempotencyKeys.has(record.idempotencyKey)) {
            throw invalidLedger();
        }
        idempotencyKeys.add(record.idempotencyKey);
        records.push(freezeEntry({ recordDigest, record }));
        expectedPrevious = recordDigest;
        expectedSequence += 1;
    }
    return records;
}
function parsePublication(paths, name, repositoryId) {
    const match = PUBLICATION_RECORD_NAME.exec(name);
    if (match === null ||
        match[1] === undefined ||
        match[2] === undefined ||
        match[3] === undefined ||
        !UUID_V4.test(match[3])) {
        throw invalidLedger();
    }
    const publicationPath = path.join(paths.records, name);
    const stored = readRecordPath(publicationPath, [1, 2]);
    const record = parseCanonicalRecord(stored.content);
    const digest = sha256Digest(stored.content).slice('sha256:'.length);
    if (record.repositoryId !== repositoryId ||
        record.sequence !== Number(match[1]) ||
        digest !== match[2]) {
        throw invalidLedger();
    }
    return Object.freeze({
        path: publicationPath,
        finalName: `${match[1]}-${match[2]}.json`,
        content: stored.content,
        record,
        stats: stored.stats,
    });
}
function parseCanonicalRecord(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw invalidLedger();
    }
    const record = assertStoredRecord(parsed);
    if (content !== canonicalRecordContent(record)) {
        throw invalidLedger();
    }
    return record;
}
function publishRecord(paths, entry, content, options) {
    const digest = entry.recordDigest.slice('sha256:'.length);
    const baseName = recordFileName(entry.record.sequence, digest);
    const finalPath = path.join(paths.records, baseName);
    const publicationPath = path.join(paths.records, `.${baseName}.${crypto.randomUUID()}.publish.tmp`);
    let descriptor;
    let published = false;
    try {
        descriptor = fs.openSync(publicationPath, fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        const written = fs.fstatSync(descriptor);
        if (!written.isFile() ||
            written.nlink !== 1 ||
            (written.mode & 0o777) !== 0o600 ||
            written.size !== Buffer.byteLength(content)) {
            throw unsafeFilesystem();
        }
        fs.closeSync(descriptor);
        descriptor = undefined;
        options.testAfterRecordPreparation?.();
        fs.linkSync(publicationPath, finalPath);
        published = true;
        fsyncDirectory(paths.records);
        fs.unlinkSync(publicationPath);
        fsyncDirectory(paths.records);
        const final = readRecordPath(finalPath, [1]);
        if (final.content !== content) {
            throw invalidLedger();
        }
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        // A fully written publication file is deliberately retained. On the next
        // locked scan it is either completed as the unique valid next record or
        // rejected fail-closed. Once the hard link exists, it is an orphaned
        // durable record and must never be deleted as rollback cleanup.
        if (!published) {
            fsyncDirectory(paths.records);
        }
        throw error;
    }
}
function withLedgerLock(paths, repositoryId, operation) {
    assertLockEntriesBeforeAcquire(paths);
    const reclaimed = reclaimDeadPreparedLock(paths.appendLock, (content) => parseLockOwner(content, repositoryId));
    if (reclaimed === 'occupied') {
        throw lockBusy();
    }
    if (reclaimed === 'unsafe') {
        throw lockUnsafe();
    }
    const ownerToken = crypto.randomUUID();
    const content = `${canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-lock.v1',
        repositoryId,
        pid: process.pid,
        ownerToken,
    })}\n`;
    let descriptor;
    try {
        descriptor = publishPreparedExclusiveLock(paths.appendLock, content, ownerToken, lockUnsafe);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw lockBusy();
        }
        throw error;
    }
    const assertOwned = () => {
        if (descriptor === undefined) {
            throw lockUnsafe();
        }
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(paths.appendLock, {
            throwIfNoEntry: false,
        });
        if (!observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content) {
            throw lockUnsafe();
        }
    };
    let result;
    try {
        assertOwned();
        assertExactDirectoryEntries(paths.locks, [LOCK_NAME]);
        result = operation();
        assertOwned();
    }
    catch (error) {
        releaseLedgerLock(paths, descriptor, assertOwned);
        descriptor = undefined;
        throw error;
    }
    releaseLedgerLock(paths, descriptor, assertOwned);
    descriptor = undefined;
    return result;
}
function releaseLedgerLock(paths, descriptor, assertOwned) {
    assertOwned();
    fs.closeSync(descriptor);
    fs.unlinkSync(paths.appendLock);
    fsyncDirectory(paths.locks);
}
function parseLockOwner(content, repositoryId) {
    if (Buffer.byteLength(content) > 1_024) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return null;
    }
    if (!isPlainRecord(parsed) ||
        !hasExactKeys(parsed, LOCK_KEYS) ||
        parsed.schemaVersion !== 1 ||
        parsed.kind !== 'authority-audit-lock.v1' ||
        parsed.repositoryId !== repositoryId ||
        !Number.isSafeInteger(parsed.pid) ||
        typeof parsed.pid !== 'number' ||
        parsed.pid < 1 ||
        typeof parsed.ownerToken !== 'string' ||
        !UUID_V4.test(parsed.ownerToken) ||
        content !== `${canonicalJson(parsed)}\n`) {
        return null;
    }
    return { pid: parsed.pid, ownerToken: parsed.ownerToken };
}
function assertLockEntriesBeforeAcquire(paths) {
    const entries = fs.readdirSync(paths.locks);
    const hasLock = entries.includes(LOCK_NAME);
    for (const entry of entries) {
        if (entry === LOCK_NAME) {
            continue;
        }
        const isPreparedAlias = PREPARED_LOCK_ALIAS.test(entry);
        const isReclaimClaim = LOCK_RECLAIM_CLAIM.test(entry);
        if (!hasLock || (!isPreparedAlias && !isReclaimClaim)) {
            throw lockUnsafe();
        }
    }
}
function readRecordPath(filePath, allowedLinks) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before?.isFile() ||
        before.isSymbolicLink() ||
        !allowedLinks.includes(before.nlink) ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > MAX_RECORD_BYTES) {
        throw unsafeFilesystem();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            !opened.isFile() ||
            !allowedLinks.includes(opened.nlink) ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.size !== before.size) {
            throw unsafeFilesystem();
        }
        const content = fs.readFileSync(descriptor, 'utf8');
        const after = fs.fstatSync(descriptor);
        if (after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs ||
            Buffer.byteLength(content) !== opened.size) {
            throw unsafeFilesystem();
        }
        return { content, stats: after };
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
function assertLayout(paths) {
    assertPrivateDirectory(paths.externalAuditRoot);
    assertPrivateDirectory(paths.repositories);
    assertPrivateDirectory(paths.repository);
    assertPrivateDirectory(paths.events);
    assertPrivateDirectory(paths.records);
    assertPrivateDirectory(paths.locks);
    assertExactDirectoryEntries(paths.externalAuditRoot, ['repositories']);
    assertExactDirectoryEntries(paths.repository, ['events', 'locks', 'records']);
    for (const namespace of fs.readdirSync(paths.repositories)) {
        if (!/^[0-9a-f]{64}$/.test(namespace)) {
            throw unsafeFilesystem();
        }
        assertPrivateDirectory(path.join(paths.repositories, namespace));
    }
}
function ensurePrivateRoot(directory) {
    const parent = path.dirname(directory);
    assertPlainDirectory(parent);
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing === undefined) {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        fsyncDirectory(parent);
    }
    assertPrivateDirectory(directory);
}
function ensurePrivateDirectory(directory) {
    assertPrivateDirectory(path.dirname(directory));
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing === undefined) {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        fsyncDirectory(path.dirname(directory));
    }
    assertPrivateDirectory(directory);
}
function assertRepositoryRoot(directory) {
    assertPlainDirectory(directory);
}
function assertPlainDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory) {
        throw unsafeFilesystem();
    }
}
function assertPrivateDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700 ||
        fs.realpathSync(directory) !== directory) {
        throw unsafeFilesystem();
    }
}
function assertExactDirectoryEntries(directory, expected) {
    const observed = fs.readdirSync(directory).sort();
    const sortedExpected = [...expected].sort();
    if (observed.length !== sortedExpected.length ||
        observed.some((entry, index) => entry !== sortedExpected[index])) {
        throw unsafeFilesystem();
    }
}
function assertAbsolutePath(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        Buffer.byteLength(raw) > MAX_PATH_BYTES ||
        raw.includes('\0') ||
        !path.isAbsolute(raw) ||
        path.normalize(raw) !== raw) {
        throw invalidScope();
    }
    return raw;
}
function recordMatchesInput(record, input) {
    return APPEND_INPUT_KEYS.every((key) => record[key] === input[key]);
}
function canonicalRecordContent(record) {
    return `${canonicalJson(record)}\n`;
}
function recordFileName(sequence, digest) {
    const encodedSequence = sequence.toString().padStart(16, '0');
    if (encodedSequence.length !== 16 || !/^[0-9a-f]{64}$/.test(digest)) {
        throw invalidLedger();
    }
    return `${encodedSequence}-${digest}.json`;
}
function freezeRecord(record) {
    return Object.freeze(record);
}
function freezeEntry(entry) {
    return Object.freeze(entry);
}
function sha256Digest(content) {
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}
function assertDigest(raw, makeError) {
    if (typeof raw !== 'string' || !SHA256_DIGEST.test(raw)) {
        throw makeError();
    }
    return raw;
}
function assertNullableDigest(raw, makeError) {
    return raw === null ? null : assertDigest(raw, makeError);
}
function isCanonicalTimestamp(raw) {
    if (typeof raw !== 'string' || !CANONICAL_TIMESTAMP.test(raw)) {
        return false;
    }
    const timestamp = Date.parse(raw);
    return (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === raw);
}
function hasExactKeys(record, expected) {
    const keys = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    return (keys.length === sortedExpected.length &&
        keys.every((key, index) => key === sortedExpected[index]));
}
function includes(values, raw) {
    return typeof raw === 'string' && values.includes(raw);
}
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function pathsOverlap(first, second) {
    return isWithin(first, second) || isWithin(second, first);
}
function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return (relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative)));
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
function readDescriptorContent(descriptor, byteLength) {
    const bytes = Buffer.alloc(byteLength);
    const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
    return bytes.subarray(0, count).toString('utf8');
}
function invalidScope() {
    return workflowError('AUTHORITY_AUDIT_SCOPE_INVALID', 'Authority audit ledger scope must use explicit canonical absolute paths and a digest repository identity.', ExitCode.usage);
}
function externalRootRequired() {
    return workflowError('AUTHORITY_AUDIT_EXTERNAL_ROOT_REQUIRED', 'Authority audit storage must be physically separate from the repository.', ExitCode.guard);
}
function invalidRecord() {
    return workflowError('AUTHORITY_AUDIT_RECORD_INVALID', 'Authority audit input does not match the bounded canonical record schema.', ExitCode.usage);
}
function invalidLedger() {
    return workflowError('AUTHORITY_AUDIT_LEDGER_INVALID', 'Authority audit ledger failed canonical, sequence, digest, or hash-chain verification.', ExitCode.staleState);
}
function unsafeFilesystem() {
    return workflowError('AUTHORITY_AUDIT_FILESYSTEM_UNSAFE', 'Authority audit storage has unsafe paths, file types, links, or permissions.', ExitCode.unsafeEnvironment);
}
function lockBusy() {
    return workflowError('AUTHORITY_AUDIT_LOCK_BUSY', 'Another authority audit append or verification operation owns the ledger lock.', ExitCode.conflict);
}
function lockUnsafe() {
    return workflowError('AUTHORITY_AUDIT_LOCK_UNSAFE', 'Authority audit ledger lock state is unsafe or cannot be proven current.', ExitCode.staleState);
}
function idempotencyConflict() {
    return workflowError('AUTHORITY_AUDIT_IDEMPOTENCY_CONFLICT', 'Authority audit idempotency key already identifies different record content.', ExitCode.conflict);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
