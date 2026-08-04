import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { assertLedgerEntry, type LedgerEntry } from './semantic-ledger.ts';

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

export type LedgerIndex = Readonly<{
  schemaVersion: 1;
  kind: 'semantic-ledger-index';
  subjects: Readonly<Record<string, Readonly<{ currentEntryId: string }>>>;
}>;

export function ledgerObjectPath(entryId: string): string {
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
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const serialized = `${canonicalJson(validated)}\n`;
  if (fs.existsSync(absolute)) {
    // Content-addressed: the same identity must already hold the same bytes,
    // and if it does not, something has rewritten history.
    if (fs.readFileSync(absolute, 'utf8') !== serialized) {
      throw ledgerStoreInvalid(
        `Ledger object ${validated.entryId} already exists with different content.`,
      );
    }
    return relative;
  }
  fs.writeFileSync(absolute, serialized);
  return relative;
}

export function readLedgerEntry(
  repositoryRoot: string,
  entryId: string,
): LedgerEntry {
  const absolute = path.join(repositoryRoot, ledgerObjectPath(entryId));
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch {
    throw ledgerStoreInvalid(`Ledger object ${entryId} is missing.`);
  }
  const entry = assertLedgerEntry(JSON.parse(raw));
  if (entry.entryId !== entryId) {
    throw ledgerStoreInvalid(
      `Ledger object at ${entryId} identifies itself as ${entry.entryId}.`,
    );
  }
  return entry;
}

export function readLedgerIndex(repositoryRoot: string): LedgerIndex {
  const absolute = path.join(repositoryRoot, ledgerIndexPath());
  if (!fs.existsSync(absolute)) {
    return Object.freeze({
      schemaVersion: 1,
      kind: 'semantic-ledger-index',
      subjects: Object.freeze({}),
    });
  }
  return assertLedgerIndex(JSON.parse(fs.readFileSync(absolute, 'utf8')));
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
  for (const entry of entries) {
    if (entry.status !== 'current') {
      throw ledgerStoreInvalid(
        `Entry ${entry.entryId} is ${entry.status} and cannot be the current authority.`,
      );
    }
    const existing = subjects[entry.subject.subjectId]?.currentEntryId;
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
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${canonicalJson(next)}\n`);
  return next;
}

export function assertLedgerIndex(value: unknown): LedgerIndex {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    (value as Record<string, unknown>).kind !== 'semantic-ledger-index'
  ) {
    throw ledgerStoreInvalid('Ledger index is malformed.');
  }
  const subjects = (value as Record<string, unknown>).subjects;
  if (typeof subjects !== 'object' || subjects === null) {
    throw ledgerStoreInvalid('Ledger index is malformed.');
  }
  for (const entry of Object.values(subjects as Record<string, unknown>)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { currentEntryId?: unknown }).currentEntryId !== 'string'
    ) {
      throw ledgerStoreInvalid('Ledger index names a malformed entry.');
    }
  }
  return Object.freeze(value as LedgerIndex);
}

function ledgerStoreInvalid(message: string) {
  return workflowError(
    'SEMANTIC_LEDGER_STORE_INVALID',
    message,
    ExitCode.guard,
  );
}
