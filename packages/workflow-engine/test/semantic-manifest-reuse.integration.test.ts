import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { InvestigationFullBlobManifestEntry } from '../src/investigation-why.ts';
import { createLedgerEntry } from '../src/semantic-ledger.ts';
import {
  updateLedgerIndex,
  writeLedgerEntry,
} from '../src/semantic-ledger-store.ts';
import {
  applyLedgerToFullBlobManifest,
  reviewTargetsFromManifestReuse,
} from '../src/semantic-manifest-reuse.ts';
import {
  buildCoverageManifest,
  requiredReviewSet,
} from '../src/review-coverage.ts';

const POLICY = `sha256:${'1'.repeat(64)}`;

function hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function repository(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manifest-reuse-')),
  );
}

function manifestEntry(
  filePath: string,
  content: string,
): InvestigationFullBlobManifestEntry {
  return {
    manifestEntryId: hex(`${filePath}:${content}`),
    path: {
      rawBase64: Buffer.from(filePath).toString('base64'),
      utf8: filePath,
    },
    treeDigest: hex('tree'),
    blob: {
      objectId: 'a'.repeat(40),
      objectType: 'blob',
      mode: '100644',
      byteSize: Buffer.byteLength(content),
      contentSha256: hex(content),
      lineCount: content.split('\n').length,
    },
    coveredHitIds: [],
    matchedTermIds: [],
    groupIds: [],
    dispositionNodeIds: [],
    relevantLocations: [],
    relationshipsToChange: [],
  } as unknown as InvestigationFullBlobManifestEntry;
}

function seed(root: string, filePath: string, content: string) {
  const entry = createLedgerEntry({
    schemaVersion: 1,
    kind: 'semantic-ledger-entry',
    subject: {
      subjectId: `seeded.${filePath.replace(/[^a-z]/g, '')}`,
      kind: 'file',
      path: filePath,
    },
    binding: {
      baselineCommit: 'a'.repeat(40),
      blobDigest: `sha256:${hex(content)}`,
      sourceDigest: `sha256:${hex(content)}`,
      semanticDigest: `sha256:${hex(content)}`,
      extractorVersion: 'file-fallback-v1',
    },
    why: {
      responsibility: `What ${filePath} is responsible for.`,
      protectedInvariants: ['Its contract holds.'],
      failureModes: [],
      reviewerQuestions: [],
    },
    semanticDependencies: [],
    policyDigest: POLICY,
    provenance: { changeId: 'seed', createdAtCommit: 'b'.repeat(40) },
    supersedes: null,
    status: 'current',
  } as never);
  writeLedgerEntry(root, entry);
  updateLedgerIndex(root, [entry]);
  return entry;
}

test('a repository with no ledger owes every entry', () => {
  // This is where every repository starts, and the answer must be the full
  // cost rather than a reassuring silence.
  const root = repository();
  const manifest = [manifestEntry('src/a.ts', 'alpha')];
  const reuse = applyLedgerToFullBlobManifest(root, manifest);
  assert.deepEqual(reuse.owed, manifest);
  assert.deepEqual(reuse.carried, []);
  assert.equal(reuse.plan, null);
});

test('an unchanged blob the ledger explains is carried, not re-explained', () => {
  const root = repository();
  const entry = seed(root, 'src/a.ts', 'alpha');
  const reuse = applyLedgerToFullBlobManifest(root, [
    manifestEntry('src/a.ts', 'alpha'),
    manifestEntry('src/b.ts', 'beta'),
  ]);
  assert.equal(reuse.owed.length, 1);
  assert.equal(reuse.owed[0]?.path.utf8, 'src/b.ts');
  assert.deepEqual(reuse.carried, [
    {
      manifestEntryId: hex('src/a.ts:alpha'),
      subjectId: entry.subject.subjectId,
      ledgerEntryId: entry.entryId,
    },
  ]);
});

test('a blob whose bytes moved is owed again however small the change', () => {
  // The engine has bytes here, not a parse. Claiming the meaning survived a
  // byte change would be asserting something it cannot demonstrate.
  const root = repository();
  seed(root, 'src/a.ts', 'alpha');
  const reuse = applyLedgerToFullBlobManifest(root, [
    manifestEntry('src/a.ts', 'alpha modified'),
  ]);
  assert.equal(reuse.owed.length, 1);
  assert.deepEqual(reuse.carried, []);
  assert.equal(reuse.plan?.reused, 0);
});

test('a path with more than one subject is never carried on one of them', () => {
  const root = repository();
  const first = createLedgerEntry({
    schemaVersion: 1,
    kind: 'semantic-ledger-entry',
    subject: { subjectId: 'seeded.one', kind: 'symbol', path: 'src/a.ts' },
    binding: {
      baselineCommit: 'a'.repeat(40),
      blobDigest: `sha256:${hex('alpha')}`,
      sourceDigest: `sha256:${hex('alpha')}`,
      semanticDigest: `sha256:${hex('alpha')}`,
      extractorVersion: 'ts-adapter-v1',
    },
    why: {
      responsibility: 'One of two things in this file.',
      protectedInvariants: ['It holds.'],
      failureModes: [],
      reviewerQuestions: [],
    },
    semanticDependencies: [],
    policyDigest: POLICY,
    provenance: { changeId: 'seed', createdAtCommit: 'b'.repeat(40) },
    supersedes: null,
    status: 'current',
  } as never);
  const second = createLedgerEntry({
    ...first,
    subject: { subjectId: 'seeded.two', kind: 'symbol', path: 'src/a.ts' },
    why: {
      responsibility: 'The other thing in this file.',
      protectedInvariants: ['It also holds.'],
      failureModes: [],
      reviewerQuestions: [],
    },
  } as never);
  writeLedgerEntry(root, first);
  writeLedgerEntry(root, second);
  updateLedgerIndex(root, [first, second]);

  const reuse = applyLedgerToFullBlobManifest(root, [
    manifestEntry('src/a.ts', 'alpha'),
  ]);
  // The manifest is blob-granular; one subject cannot vouch for the whole file.
  assert.equal(reuse.owed.length, 1);
  assert.deepEqual(reuse.carried, []);
});

test('the saving is reported honestly rather than assumed', () => {
  const root = repository();
  seed(root, 'src/a.ts', 'alpha');
  const reuse = applyLedgerToFullBlobManifest(root, [
    manifestEntry('src/a.ts', 'alpha'),
    manifestEntry('src/b.ts', 'beta'),
    manifestEntry('src/c.ts', 'gamma'),
  ]);
  assert.equal(reuse.carried.length, 1);
  assert.equal(reuse.owed.length, 2);
  assert.equal(reuse.plan?.reused, 1);
});

test('a carried entry is still shown to the reviewer, marked as carried', () => {
  // Otherwise the saving would certify itself: the entries nobody re-examined
  // would be exactly the ones nobody could examine.
  const root = repository();
  seed(root, 'src/a.ts', 'alpha');
  const reuse = applyLedgerToFullBlobManifest(root, [
    manifestEntry('src/a.ts', 'alpha'),
    manifestEntry('src/b.ts', 'beta'),
  ]);
  const targets = reviewTargetsFromManifestReuse(
    reuse,
    () => 'production-consumer',
  );
  assert.equal(targets.length, 2);
  assert.equal(
    targets.filter(({ reusedFromLedger }) => reusedFromLedger).length,
    1,
  );

  const manifest = buildCoverageManifest('critical', [...targets]);
  const required = requiredReviewSet(manifest, 'a'.repeat(64), 'b'.repeat(64));
  // Critical reviews everything, carried entries included.
  assert.equal(required.length, 2);
});
