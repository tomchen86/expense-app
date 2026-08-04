import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  privatePathExists,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import { assertInvocationId, type InvestigationRuntimePaths } from './paths.ts';
import { providerRetentionRoot } from './provider-retention-receipt.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export type ProviderRetentionCatalogEntry = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retention-catalog-entry';
  entryId: string;
  invocationId: string;
  nextEntryId: string | null;
  createdAt: string;
  entryDigest: string;
}>;

type ProviderRetentionCatalogHead = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retention-catalog-head';
  generation: number;
  headEntryId: string;
  updatedAt: string;
  headDigest: string;
}>;

type ProviderRetentionCatalogJournal = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retention-catalog-registration';
  expectedGeneration: number;
  expectedHeadEntryId: string | null;
  entry: ProviderRetentionCatalogEntry;
  journalDigest: string;
}>;

type ProviderRetentionCatalogCursor = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retention-catalog-cursor';
  nextEntryId: string | null;
}>;

export type ProviderRetentionCatalogBatch = Readonly<{
  entries: ProviderRetentionCatalogEntry[];
  cursorBefore: string | null;
  nextEntryId: string | null;
}>;

function catalogPaths(paths: InvestigationRuntimePaths) {
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

export function registerProviderRetentionInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  createdAt: string,
): ProviderRetentionCatalogEntry {
  const invocationId = assertInvocationId(requestedInvocationId);
  if (!isTimestamp(createdAt)) throw catalogUnsafe();
  const stores = catalogPaths(paths);
  ensureCatalogDirectories(paths, stores);
  return withPrivateRuntimeLock(
    paths,
    stores.lock,
    () => {
      recoverRegistration(paths, stores);
      const entryId = sha256(invocationId);
      const existing = readEntry(paths, stores, entryId, false);
      if (existing !== null) {
        if (existing.invocationId !== invocationId) throw catalogUnsafe();
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
      createPrivateCanonicalJson(
        paths,
        stores.journal,
        journal,
        catalogUnsafe,
        'PROVIDER_RETENTION_CATALOG_CONFLICT',
      );
      recoverRegistration(paths, stores);
      return readEntry(paths, stores, entryId, true)!;
    },
    'PROVIDER_RETENTION_CATALOG_BUSY',
    catalogUnsafe,
  );
}

export function readProviderRetentionCatalogBatch(
  paths: InvestigationRuntimePaths,
  limit: number,
): ProviderRetentionCatalogBatch {
  if (!Number.isSafeInteger(limit) || limit < 0) throw catalogUnsafe();
  const stores = catalogPaths(paths);
  ensureCatalogDirectories(paths, stores);
  return withPrivateRuntimeLock(
    paths,
    stores.lock,
    () => {
      recoverRegistration(paths, stores);
      const head = readHead(paths, stores);
      const cursor = readCursor(paths, stores);
      const cursorBefore = cursor?.nextEntryId ?? null;
      let nextEntryId = cursorBefore ?? head?.headEntryId ?? null;
      const entries: ProviderRetentionCatalogEntry[] = [];
      const observed = new Set<string>();
      while (nextEntryId !== null && entries.length < limit) {
        if (observed.has(nextEntryId)) throw catalogUnsafe();
        observed.add(nextEntryId);
        const entry = readEntry(paths, stores, nextEntryId, true)!;
        entries.push(entry);
        nextEntryId = entry.nextEntryId;
      }
      return deepFreeze({ entries, cursorBefore, nextEntryId });
    },
    'PROVIDER_RETENTION_CATALOG_BUSY',
    catalogUnsafe,
  );
}

export function commitProviderRetentionCatalogCursor(
  paths: InvestigationRuntimePaths,
  batch: ProviderRetentionCatalogBatch,
): void {
  if (batch.entries.length === 0) return;
  const stores = catalogPaths(paths);
  ensureCatalogDirectories(paths, stores);
  withPrivateRuntimeLock(
    paths,
    stores.lock,
    () => {
      recoverRegistration(paths, stores);
      const current = readCursor(paths, stores);
      if ((current?.nextEntryId ?? null) !== batch.cursorBefore) {
        throw catalogUnsafe();
      }
      const cursor: ProviderRetentionCatalogCursor = {
        schemaVersion: 1,
        kind: 'provider-retention-catalog-cursor',
        nextEntryId: batch.nextEntryId,
      };
      if (privatePathExists(paths, stores.cursor, catalogUnsafe)) {
        writePrivateCanonicalJsonAtomic(
          paths,
          stores.cursor,
          cursor,
          catalogUnsafe,
        );
      } else {
        createPrivateCanonicalJson(
          paths,
          stores.cursor,
          cursor,
          catalogUnsafe,
          'PROVIDER_RETENTION_CATALOG_CONFLICT',
        );
      }
    },
    'PROVIDER_RETENTION_CATALOG_BUSY',
    catalogUnsafe,
  );
}

export function readProviderRetentionCatalogEntry(
  paths: InvestigationRuntimePaths,
  requestedEntryId: string,
): ProviderRetentionCatalogEntry {
  const entryId = assertDigest(requestedEntryId);
  const stores = catalogPaths(paths);
  ensureCatalogDirectories(paths, stores);
  return readEntry(paths, stores, entryId, true)!;
}

function recoverRegistration(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof catalogPaths>,
): void {
  if (!privatePathExists(paths, stores.journal, catalogUnsafe)) return;
  const journal = assertJournal(
    readPrivateCanonicalJson(paths, stores.journal, catalogUnsafe),
  );
  let head = readHead(paths, stores);
  const generation = head?.generation ?? 0;
  const headEntryId = head?.headEntryId ?? null;
  if (
    generation === journal.expectedGeneration &&
    headEntryId === journal.expectedHeadEntryId
  ) {
    const existing = readEntry(paths, stores, journal.entry.entryId, false);
    if (existing === null) {
      createPrivateCanonicalJson(
        paths,
        entryPath(stores, journal.entry.entryId),
        journal.entry,
        catalogUnsafe,
        'PROVIDER_RETENTION_CATALOG_CONFLICT',
      );
    } else if (canonicalJson(existing) !== canonicalJson(journal.entry)) {
      throw catalogUnsafe();
    }
    const nextHead = createHead({
      generation: journal.expectedGeneration + 1,
      headEntryId: journal.entry.entryId,
      updatedAt: journal.entry.createdAt,
    });
    if (head === null) {
      createPrivateCanonicalJson(
        paths,
        stores.head,
        nextHead,
        catalogUnsafe,
        'PROVIDER_RETENTION_CATALOG_CONFLICT',
      );
    } else {
      writePrivateCanonicalJsonAtomic(
        paths,
        stores.head,
        nextHead,
        catalogUnsafe,
      );
    }
    head = nextHead;
  }
  if (
    head?.generation !== journal.expectedGeneration + 1 ||
    head.headEntryId !== journal.entry.entryId ||
    canonicalJson(readEntry(paths, stores, journal.entry.entryId, true)) !==
      canonicalJson(journal.entry)
  ) {
    throw catalogUnsafe();
  }
  fs.unlinkSync(stores.journal);
  fsyncDirectory(stores.root);
}

function ensureCatalogDirectories(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof catalogPaths>,
): void {
  ensurePrivateInvestigationDirectory(paths, stores.entries, catalogUnsafe);
}

function readHead(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof catalogPaths>,
): ProviderRetentionCatalogHead | null {
  if (!privatePathExists(paths, stores.head, catalogUnsafe)) return null;
  return assertHead(
    readPrivateCanonicalJson(paths, stores.head, catalogUnsafe),
  );
}

function readCursor(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof catalogPaths>,
): ProviderRetentionCatalogCursor | null {
  if (!privatePathExists(paths, stores.cursor, catalogUnsafe)) return null;
  const value = readPrivateCanonicalJson(paths, stores.cursor, catalogUnsafe);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'nextEntryId', 'schemaVersion']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retention-catalog-cursor' ||
    (value.nextEntryId !== null && !isDigest(value.nextEntryId))
  ) {
    throw catalogUnsafe();
  }
  return deepFreeze(value as ProviderRetentionCatalogCursor);
}

function readEntry(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof catalogPaths>,
  entryId: string,
  required: boolean,
): ProviderRetentionCatalogEntry | null {
  const filePath = entryPath(stores, assertDigest(entryId));
  if (!privatePathExists(paths, filePath, catalogUnsafe)) {
    if (required) throw catalogUnsafe();
    return null;
  }
  const entry = assertEntry(
    readPrivateCanonicalJson(paths, filePath, catalogUnsafe),
  );
  if (entry.entryId !== entryId) throw catalogUnsafe();
  return entry;
}

function entryPath(
  stores: ReturnType<typeof catalogPaths>,
  entryId: string,
): string {
  return path.join(stores.entries, `${assertDigest(entryId)}.json`);
}

function createEntry(
  value: Omit<
    ProviderRetentionCatalogEntry,
    'schemaVersion' | 'kind' | 'entryDigest'
  >,
): ProviderRetentionCatalogEntry {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-retention-catalog-entry' as const,
    ...value,
  };
  return assertEntry({
    ...payload,
    entryDigest: sha256(canonicalJson(payload)),
  });
}

function createHead(
  value: Omit<
    ProviderRetentionCatalogHead,
    'schemaVersion' | 'kind' | 'headDigest'
  >,
): ProviderRetentionCatalogHead {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-retention-catalog-head' as const,
    ...value,
  };
  return assertHead({ ...payload, headDigest: sha256(canonicalJson(payload)) });
}

function createJournal(
  value: Omit<
    ProviderRetentionCatalogJournal,
    'schemaVersion' | 'kind' | 'journalDigest'
  >,
): ProviderRetentionCatalogJournal {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-retention-catalog-registration' as const,
    ...value,
  };
  return assertJournal({
    ...payload,
    journalDigest: sha256(canonicalJson(payload)),
  });
}

function assertEntry(value: unknown): ProviderRetentionCatalogEntry {
  if (
    !isRecord(value) ||
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
    !isDigest(value.entryDigest)
  ) {
    throw catalogUnsafe();
  }
  assertInvocationId(value.invocationId);
  const payload = { ...value };
  delete payload.entryDigest;
  if (value.entryDigest !== sha256(canonicalJson(payload)))
    throw catalogUnsafe();
  return deepFreeze(value as ProviderRetentionCatalogEntry);
}

function assertHead(value: unknown): ProviderRetentionCatalogHead {
  if (
    !isRecord(value) ||
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
    (value.generation as number) < 1 ||
    !isDigest(value.headEntryId) ||
    !isTimestamp(value.updatedAt) ||
    !isDigest(value.headDigest)
  ) {
    throw catalogUnsafe();
  }
  const payload = { ...value };
  delete payload.headDigest;
  if (value.headDigest !== sha256(canonicalJson(payload)))
    throw catalogUnsafe();
  return deepFreeze(value as ProviderRetentionCatalogHead);
}

function assertJournal(value: unknown): ProviderRetentionCatalogJournal {
  if (
    !isRecord(value) ||
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
    (value.expectedGeneration as number) < 0 ||
    (value.expectedHeadEntryId !== null &&
      !isDigest(value.expectedHeadEntryId)) ||
    !isDigest(value.journalDigest)
  ) {
    throw catalogUnsafe();
  }
  const entry = assertEntry(value.entry);
  const payload: Record<string, unknown> = { ...value, entry };
  delete payload.journalDigest;
  if (value.journalDigest !== sha256(canonicalJson(payload))) {
    throw catalogUnsafe();
  }
  return deepFreeze({
    ...(value as Omit<ProviderRetentionCatalogJournal, 'entry'>),
    entry,
  });
}

function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw catalogUnsafe();
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function catalogUnsafe() {
  return workflowError(
    'PROVIDER_RETENTION_CATALOG_UNSAFE',
    'Provider runtime retention catalog is missing, malformed, or tampered.',
    ExitCode.unsafeEnvironment,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
