import fs from 'node:fs';
import path from 'node:path';

import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertLedgerEntry,
  isSemanticSubjectId,
  type LedgerEntry,
} from '../../modules/why-knowledge/semantic-ledger.ts';

/**
 * Where the ledger lives.
 *
 * In the repository, tracked by Git, content-addressed. That choice is load
 * bearing rather than incidental: freshness is decided by comparing an entry
 * against a pinned commit, so the entries themselves have to be readable at
 * that commit. A store held anywhere else could not answer "what did we
 * understand when this baseline was current" — it would only ever know what we
 * understand now.
 *
 * The index names one current entry per subject. Objects are immutable and
 * never deleted, so superseded understanding stays readable; only the index
 * moves. A local cache may be discarded at any time because everything in it
 * is derivable from what Git already holds.
 */

export const LEDGER_ROOT = 'workflow/semantic-ledger';
const LEDGER_ENTRY_ID = /^sha256:[0-9a-f]{64}$/;

export type LedgerIndex = Readonly<{
  schemaVersion: 1;
  kind: 'semantic-ledger-index';
  subjects: Readonly<Record<string, Readonly<{ currentEntryId: string }>>>;
}>;

export function ledgerObjectPath(entryId: string): string {
  if (!LEDGER_ENTRY_ID.test(entryId)) {
    throw ledgerStoreInvalid('Ledger object identity is malformed.');
  }
  const hex = entryId.replace(/^sha256:/, '');
  return `${LEDGER_ROOT}/objects/sha256/${hex.slice(0, 2)}/${hex.slice(2)}.json`;
}

export function ledgerIndexPath(): string {
  return `${LEDGER_ROOT}/index.json`;
}

export function writeLedgerEntry(
  repositoryRoot: string,
  entry: LedgerEntry,
): string {
  const validated = assertLedgerEntry(entry);
  const relative = ledgerObjectPath(validated.entryId);
  const absolute = path.join(repositoryRoot, relative);
  assertSafeLedgerParents(repositoryRoot, absolute);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  assertSafeLedgerParents(repositoryRoot, absolute);
  const serialized = `${canonicalJson(validated)}\n`;
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw ledgerStoreInvalid(
        `Ledger object ${validated.entryId} is not a plain file.`,
      );
    }
    // Content-addressed: the same identity must already hold the same bytes,
    // and if it does not, something has rewritten history.
    if (fs.readFileSync(absolute, 'utf8') !== serialized) {
      throw ledgerStoreInvalid(
        `Ledger object ${validated.entryId} already exists with different content.`,
      );
    }
    return relative;
  }
  replaceTextAtomic(absolute, serialized, {
    allowCreate: true,
    defaultMode: 0o644,
  });
  return relative;
}

export function readLedgerEntry(
  repositoryRoot: string,
  entryId: string,
): LedgerEntry {
  const absolute = path.join(repositoryRoot, ledgerObjectPath(entryId));
  assertSafeLedgerParents(repositoryRoot, absolute);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    existing === undefined ||
    !existing.isFile() ||
    existing.isSymbolicLink()
  ) {
    throw ledgerStoreInvalid(`Ledger object ${entryId} is missing or unsafe.`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch {
    throw ledgerStoreInvalid(`Ledger object ${entryId} is missing.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ledgerStoreInvalid(`Ledger object ${entryId} is malformed.`);
  }
  const entry = assertLedgerEntry(parsed);
  if (entry.entryId !== entryId) {
    throw ledgerStoreInvalid(
      `Ledger object at ${entryId} identifies itself as ${entry.entryId}.`,
    );
  }
  if (raw !== `${canonicalJson(entry)}\n`) {
    throw ledgerStoreInvalid(`Ledger object ${entryId} is not canonical.`);
  }
  return entry;
}

export function readLedgerIndex(repositoryRoot: string): LedgerIndex {
  const absolute = path.join(repositoryRoot, ledgerIndexPath());
  assertSafeLedgerParents(repositoryRoot, absolute);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (existing === undefined) {
    return Object.freeze({
      schemaVersion: 1,
      kind: 'semantic-ledger-index',
      subjects: Object.freeze({}),
    });
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw ledgerStoreInvalid('Ledger index is not a plain file.');
  }
  const raw = fs.readFileSync(absolute, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ledgerStoreInvalid('Ledger index is malformed.');
  }
  const index = assertLedgerIndex(parsed);
  if (raw !== `${canonicalJson(index)}\n`) {
    throw ledgerStoreInvalid('Ledger index is not canonical.');
  }
  return index;
}

/**
 * Points a subject at a new current entry. The previous entry is not removed;
 * it becomes history that a reader can still reach, which is what lets an
 * approval be re-examined later on the terms it was actually given.
 */
export function updateLedgerIndex(
  repositoryRoot: string,
  entries: readonly LedgerEntry[],
): LedgerIndex {
  const index = readLedgerIndex(repositoryRoot);
  const subjects: Record<string, { currentEntryId: string }> = {
    ...index.subjects,
  };
  for (const candidate of entries) {
    const entry = assertLedgerEntry(candidate);
    if (entry.status === 'superseded') {
      throw ledgerStoreInvalid(
        `Entry ${entry.entryId} is ${entry.status} and cannot be the current authority.`,
      );
    }
    const stored = readLedgerEntry(repositoryRoot, entry.entryId);
    if (canonicalJson(stored) !== canonicalJson(entry)) {
      throw ledgerStoreInvalid(
        `Ledger object ${entry.entryId} does not match the index candidate.`,
      );
    }
    const existing = subjects[entry.subject.subjectId]?.currentEntryId;
    if (entry.status === 'tombstone') {
      if (existing === undefined) {
        if (entry.supersedes !== null) {
          throw ledgerStoreInvalid(
            `Tombstone ${entry.entryId} names a missing current entry.`,
          );
        }
        continue;
      }
      if (entry.supersedes !== existing) {
        throw ledgerStoreInvalid(
          `Tombstone ${entry.entryId} does not retire ${existing}.`,
        );
      }
      delete subjects[entry.subject.subjectId];
      continue;
    }
    if (existing === entry.entryId) {
      // Object-first/index-second projection is replayable. Once the exact
      // entry is current, repeating the transaction is a no-op rather than a
      // demand that an entry supersede itself.
      continue;
    }
    if (existing !== undefined && entry.supersedes !== existing) {
      // Replacing an understanding without naming the one it replaces would
      // lose the chain that makes the history readable.
      throw ledgerStoreInvalid(
        `Entry ${entry.entryId} replaces ${existing} without superseding it.`,
      );
    }
    subjects[entry.subject.subjectId] = { currentEntryId: entry.entryId };
  }
  const next: LedgerIndex = Object.freeze({
    schemaVersion: 1,
    kind: 'semantic-ledger-index',
    subjects: Object.freeze(subjects),
  });
  const absolute = path.join(repositoryRoot, ledgerIndexPath());
  const serialized = `${canonicalJson(next)}\n`;
  assertSafeLedgerParents(repositoryRoot, absolute);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    existing !== undefined &&
    (!existing.isFile() || existing.isSymbolicLink())
  ) {
    throw ledgerStoreInvalid('Ledger index is not a plain file.');
  }
  if (
    existing !== undefined &&
    fs.readFileSync(absolute, 'utf8') === serialized
  ) {
    return next;
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  assertSafeLedgerParents(repositoryRoot, absolute);
  replaceTextAtomic(absolute, serialized, {
    allowCreate: true,
    defaultMode: 0o644,
  });
  return next;
}

export function assertLedgerIndex(value: unknown): LedgerIndex {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['kind', 'schemaVersion', 'subjects']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'semantic-ledger-index'
  ) {
    throw ledgerStoreInvalid('Ledger index is malformed.');
  }
  const subjects = value.subjects;
  if (!isPlainRecord(subjects)) {
    throw ledgerStoreInvalid('Ledger index is malformed.');
  }
  const normalizedSubjects: Record<string, { currentEntryId: string }> = {};
  for (const [subjectId, entry] of Object.entries(subjects).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      !isSemanticSubjectId(subjectId) ||
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ['currentEntryId']) ||
      typeof entry.currentEntryId !== 'string' ||
      !LEDGER_ENTRY_ID.test(entry.currentEntryId)
    ) {
      throw ledgerStoreInvalid('Ledger index names a malformed entry.');
    }
    normalizedSubjects[subjectId] = Object.freeze({
      currentEntryId: entry.currentEntryId,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'semantic-ledger-index',
    subjects: Object.freeze(normalizedSubjects),
  });
}

function assertSafeLedgerParents(repositoryRoot: string, target: string): void {
  const relative = path.relative(repositoryRoot, target);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw ledgerStoreInvalid('Ledger path escapes the repository.');
  }
  let current = repositoryRoot;
  for (const segment of path.dirname(relative).split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      stats !== undefined &&
      (!stats.isDirectory() || stats.isSymbolicLink())
    ) {
      throw ledgerStoreInvalid('Ledger parent path is not a plain directory.');
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function ledgerStoreInvalid(message: string) {
  return workflowError(
    'SEMANTIC_LEDGER_STORE_INVALID',
    message,
    ExitCode.guard,
  );
}
