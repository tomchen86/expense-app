import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { createPrivateCanonicalJson, ensurePrivateInvestigationDirectory, privatePathExists, readPrivateCanonicalJson, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, } from './investigation-session-store.js';
import { assertInvocationId, } from '../session-workspace/paths.js';
import { providerRetentionRoot } from './provider-retention-receipt.js';
const DIGEST = /^[0-9a-f]{64}$/;
function catalogPaths(paths) {
    const root = path.join(providerRetentionRoot(paths).root, 'catalog');
    return {
        root,
        entries: path.join(root, 'entries'),
        head: path.join(root, 'head.json'),
        journal: path.join(root, 'registration.json'),
        cursor: path.join(root, 'cursor.json'),
        lock: path.join(paths.locks, 'provider-retention-catalog.lock'),
    };
}
export function registerProviderRetentionInvocation(paths, requestedInvocationId, createdAt) {
    const invocationId = assertInvocationId(requestedInvocationId);
    if (!isTimestamp(createdAt))
        throw catalogUnsafe();
    const stores = catalogPaths(paths);
    ensureCatalogDirectories(paths, stores);
    return withPrivateRuntimeLock(paths, stores.lock, () => {
        recoverRegistration(paths, stores);
        const entryId = sha256(invocationId);
        const existing = readEntry(paths, stores, entryId, false);
        if (existing !== null) {
            if (existing.invocationId !== invocationId)
                throw catalogUnsafe();
            return existing;
        }
        const head = readHead(paths, stores);
        const entry = createEntry({
            entryId,
            invocationId,
            nextEntryId: head?.headEntryId ?? null,
            createdAt,
        });
        const journal = createJournal({
            expectedGeneration: head?.generation ?? 0,
            expectedHeadEntryId: head?.headEntryId ?? null,
            entry,
        });
        createPrivateCanonicalJson(paths, stores.journal, journal, catalogUnsafe, 'PROVIDER_RETENTION_CATALOG_CONFLICT');
        recoverRegistration(paths, stores);
        return readEntry(paths, stores, entryId, true);
    }, 'PROVIDER_RETENTION_CATALOG_BUSY', catalogUnsafe);
}
export function readProviderRetentionCatalogBatch(paths, limit) {
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw catalogUnsafe();
    const stores = catalogPaths(paths);
    ensureCatalogDirectories(paths, stores);
    return withPrivateRuntimeLock(paths, stores.lock, () => {
        recoverRegistration(paths, stores);
        const head = readHead(paths, stores);
        const cursor = readCursor(paths, stores);
        const cursorBefore = cursor?.nextEntryId ?? null;
        let nextEntryId = cursorBefore ?? head?.headEntryId ?? null;
        const entries = [];
        const observed = new Set();
        while (nextEntryId !== null && entries.length < limit) {
            if (observed.has(nextEntryId))
                throw catalogUnsafe();
            observed.add(nextEntryId);
            const entry = readEntry(paths, stores, nextEntryId, true);
            entries.push(entry);
            nextEntryId = entry.nextEntryId;
        }
        return deepFreeze({ entries, cursorBefore, nextEntryId });
    }, 'PROVIDER_RETENTION_CATALOG_BUSY', catalogUnsafe);
}
export function commitProviderRetentionCatalogCursor(paths, batch) {
    if (batch.entries.length === 0)
        return;
    const stores = catalogPaths(paths);
    ensureCatalogDirectories(paths, stores);
    withPrivateRuntimeLock(paths, stores.lock, () => {
        recoverRegistration(paths, stores);
        const current = readCursor(paths, stores);
        if ((current?.nextEntryId ?? null) !== batch.cursorBefore) {
            throw catalogUnsafe();
        }
        const cursor = {
            schemaVersion: 1,
            kind: 'provider-retention-catalog-cursor',
            nextEntryId: batch.nextEntryId,
        };
        if (privatePathExists(paths, stores.cursor, catalogUnsafe)) {
            writePrivateCanonicalJsonAtomic(paths, stores.cursor, cursor, catalogUnsafe);
        }
        else {
            createPrivateCanonicalJson(paths, stores.cursor, cursor, catalogUnsafe, 'PROVIDER_RETENTION_CATALOG_CONFLICT');
        }
    }, 'PROVIDER_RETENTION_CATALOG_BUSY', catalogUnsafe);
}
export function readProviderRetentionCatalogEntry(paths, requestedEntryId) {
    const entryId = assertDigest(requestedEntryId);
    const stores = catalogPaths(paths);
    ensureCatalogDirectories(paths, stores);
    return readEntry(paths, stores, entryId, true);
}
function recoverRegistration(paths, stores) {
    if (!privatePathExists(paths, stores.journal, catalogUnsafe))
        return;
    const journal = assertJournal(readPrivateCanonicalJson(paths, stores.journal, catalogUnsafe));
    let head = readHead(paths, stores);
    const generation = head?.generation ?? 0;
    const headEntryId = head?.headEntryId ?? null;
    if (generation === journal.expectedGeneration &&
        headEntryId === journal.expectedHeadEntryId) {
        const existing = readEntry(paths, stores, journal.entry.entryId, false);
        if (existing === null) {
            createPrivateCanonicalJson(paths, entryPath(stores, journal.entry.entryId), journal.entry, catalogUnsafe, 'PROVIDER_RETENTION_CATALOG_CONFLICT');
        }
        else if (canonicalJson(existing) !== canonicalJson(journal.entry)) {
            throw catalogUnsafe();
        }
        const nextHead = createHead({
            generation: journal.expectedGeneration + 1,
            headEntryId: journal.entry.entryId,
            updatedAt: journal.entry.createdAt,
        });
        if (head === null) {
            createPrivateCanonicalJson(paths, stores.head, nextHead, catalogUnsafe, 'PROVIDER_RETENTION_CATALOG_CONFLICT');
        }
        else {
            writePrivateCanonicalJsonAtomic(paths, stores.head, nextHead, catalogUnsafe);
        }
        head = nextHead;
    }
    if (head?.generation !== journal.expectedGeneration + 1 ||
        head.headEntryId !== journal.entry.entryId ||
        canonicalJson(readEntry(paths, stores, journal.entry.entryId, true)) !==
            canonicalJson(journal.entry)) {
        throw catalogUnsafe();
    }
    fs.unlinkSync(stores.journal);
    fsyncDirectory(stores.root);
}
function ensureCatalogDirectories(paths, stores) {
    ensurePrivateInvestigationDirectory(paths, stores.entries, catalogUnsafe);
}
function readHead(paths, stores) {
    if (!privatePathExists(paths, stores.head, catalogUnsafe))
        return null;
    return assertHead(readPrivateCanonicalJson(paths, stores.head, catalogUnsafe));
}
function readCursor(paths, stores) {
    if (!privatePathExists(paths, stores.cursor, catalogUnsafe))
        return null;
    const value = readPrivateCanonicalJson(paths, stores.cursor, catalogUnsafe);
    if (!isRecord(value) ||
        !hasExactKeys(value, ['kind', 'nextEntryId', 'schemaVersion']) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-retention-catalog-cursor' ||
        (value.nextEntryId !== null && !isDigest(value.nextEntryId))) {
        throw catalogUnsafe();
    }
    return deepFreeze(value);
}
function readEntry(paths, stores, entryId, required) {
    const filePath = entryPath(stores, assertDigest(entryId));
    if (!privatePathExists(paths, filePath, catalogUnsafe)) {
        if (required)
            throw catalogUnsafe();
        return null;
    }
    const entry = assertEntry(readPrivateCanonicalJson(paths, filePath, catalogUnsafe));
    if (entry.entryId !== entryId)
        throw catalogUnsafe();
    return entry;
}
function entryPath(stores, entryId) {
    return path.join(stores.entries, `${assertDigest(entryId)}.json`);
}
function createEntry(value) {
    const payload = {
        schemaVersion: 1,
        kind: 'provider-retention-catalog-entry',
        ...value,
    };
    return assertEntry({
        ...payload,
        entryDigest: sha256(canonicalJson(payload)),
    });
}
function createHead(value) {
    const payload = {
        schemaVersion: 1,
        kind: 'provider-retention-catalog-head',
        ...value,
    };
    return assertHead({ ...payload, headDigest: sha256(canonicalJson(payload)) });
}
function createJournal(value) {
    const payload = {
        schemaVersion: 1,
        kind: 'provider-retention-catalog-registration',
        ...value,
    };
    return assertJournal({
        ...payload,
        journalDigest: sha256(canonicalJson(payload)),
    });
}
function assertEntry(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'createdAt',
            'entryDigest',
            'entryId',
            'invocationId',
            'kind',
            'nextEntryId',
            'schemaVersion',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-retention-catalog-entry' ||
        !isDigest(value.entryId) ||
        typeof value.invocationId !== 'string' ||
        value.entryId !== sha256(value.invocationId) ||
        (value.nextEntryId !== null && !isDigest(value.nextEntryId)) ||
        value.nextEntryId === value.entryId ||
        !isTimestamp(value.createdAt) ||
        !isDigest(value.entryDigest)) {
        throw catalogUnsafe();
    }
    assertInvocationId(value.invocationId);
    const payload = { ...value };
    delete payload.entryDigest;
    if (value.entryDigest !== sha256(canonicalJson(payload)))
        throw catalogUnsafe();
    return deepFreeze(value);
}
function assertHead(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'generation',
            'headDigest',
            'headEntryId',
            'kind',
            'schemaVersion',
            'updatedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-retention-catalog-head' ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 1 ||
        !isDigest(value.headEntryId) ||
        !isTimestamp(value.updatedAt) ||
        !isDigest(value.headDigest)) {
        throw catalogUnsafe();
    }
    const payload = { ...value };
    delete payload.headDigest;
    if (value.headDigest !== sha256(canonicalJson(payload)))
        throw catalogUnsafe();
    return deepFreeze(value);
}
function assertJournal(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'entry',
            'expectedGeneration',
            'expectedHeadEntryId',
            'journalDigest',
            'kind',
            'schemaVersion',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-retention-catalog-registration' ||
        !Number.isSafeInteger(value.expectedGeneration) ||
        value.expectedGeneration < 0 ||
        (value.expectedHeadEntryId !== null &&
            !isDigest(value.expectedHeadEntryId)) ||
        !isDigest(value.journalDigest)) {
        throw catalogUnsafe();
    }
    const entry = assertEntry(value.entry);
    const payload = { ...value, entry };
    delete payload.journalDigest;
    if (value.journalDigest !== sha256(canonicalJson(payload))) {
        throw catalogUnsafe();
    }
    return deepFreeze({
        ...value,
        entry,
    });
}
function assertDigest(value) {
    if (!DIGEST.test(value))
        throw catalogUnsafe();
    return value;
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isTimestamp(value) {
    return (typeof value === 'string' &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
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
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function catalogUnsafe() {
    return workflowError('PROVIDER_RETENTION_CATALOG_UNSAFE', 'Provider runtime retention catalog is missing, malformed, or tampered.', ExitCode.unsafeEnvironment);
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
