import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { FreshnessObservation } from '../src/modules/why-knowledge/semantic-freshness.ts';
import {
  createLedgerEntry,
  type LedgerEntry,
} from '../src/modules/why-knowledge/semantic-ledger.ts';
import {
  readLedgerEntry,
  readLedgerIndex,
  updateLedgerIndex,
  writeLedgerEntry,
} from '../src/semantic-ledger-store.ts';
import {
  planSemanticReuse,
  subjectsOwedDepth,
} from '../src/modules/why-knowledge/semantic-reuse.ts';
import { isWorkflowError } from './fixture.ts';

const POLICY = `sha256:${'1'.repeat(64)}`;

function entryFor(
  subjectId: string,
  overrides: Record<string, unknown> = {},
): LedgerEntry {
  return createLedgerEntry({
    schemaVersion: 1,
    kind: 'semantic-ledger-entry',
    subject: { subjectId, kind: 'symbol', path: `src/${subjectId}.ts` },
    binding: {
      baselineCommit: 'a'.repeat(40),
      blobDigest: `sha256:${'2'.repeat(64)}`,
      sourceDigest: `sha256:${'3'.repeat(64)}`,
      semanticDigest: `sha256:${'4'.repeat(64)}`,
      extractorVersion: 'ts-adapter-v1',
    },
    why: {
      responsibility: `What ${subjectId} is for.`,
      protectedInvariants: ['It holds.'],
      failureModes: [],
      reviewerQuestions: [],
    },
    semanticDependencies: [],
    policyDigest: POLICY,
    provenance: { changeId: 'demo', createdAtCommit: 'b'.repeat(40) },
    supersedes: null,
    status: 'current',
    ...overrides,
  } as never);
}

function fresh(entry: LedgerEntry): FreshnessObservation {
  return {
    present: true,
    sourceDigest: entry.binding.sourceDigest,
    semanticDigest: entry.binding.semanticDigest,
    currentDependencyEntryIds: {},
    currentPolicyDigest: POLICY,
  };
}

function repository(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ledger-')),
  );
}

test('an entry round-trips through the store byte for byte', () => {
  const root = repository();
  const entry = entryFor('alpha');
  writeLedgerEntry(root, entry);
  assert.deepEqual(readLedgerEntry(root, entry.entryId), entry);
});

test('the index names one current entry per subject and survives a rebuild', () => {
  const root = repository();
  const entry = entryFor('alpha');
  writeLedgerEntry(root, entry);
  updateLedgerIndex(root, [entry]);
  assert.deepEqual(readLedgerIndex(root).subjects, {
    alpha: { currentEntryId: entry.entryId },
  });
});

test('replacing an understanding must name the one it replaces', () => {
  const root = repository();
  const first = entryFor('alpha');
  writeLedgerEntry(root, first);
  updateLedgerIndex(root, [first]);

  const orphan = entryFor('alpha', {
    why: {
      responsibility: 'A different account.',
      protectedInvariants: ['It still holds.'],
      failureModes: [],
      reviewerQuestions: [],
    },
  });
  assert.throws(
    () => updateLedgerIndex(root, [orphan]),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_STORE_INVALID'),
  );

  const successor = entryFor('alpha', {
    why: {
      responsibility: 'A different account.',
      protectedInvariants: ['It still holds.'],
      failureModes: [],
      reviewerQuestions: [],
    },
    supersedes: first.entryId,
  });
  writeLedgerEntry(root, successor);
  updateLedgerIndex(root, [successor]);
  // The replaced understanding is still readable; only the index moved.
  assert.deepEqual(readLedgerEntry(root, first.entryId), first);
  assert.equal(
    readLedgerIndex(root).subjects.alpha.currentEntryId,
    successor.entryId,
  );
});

test('a superseded entry may not be made current', () => {
  const root = repository();
  assert.throws(
    () =>
      updateLedgerIndex(root, [entryFor('alpha', { status: 'superseded' })]),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_STORE_INVALID'),
  );
});

test('a tombstone retires exactly the current entry without deleting history', () => {
  const root = repository();
  const current = entryFor('alpha');
  writeLedgerEntry(root, current);
  updateLedgerIndex(root, [current]);
  const tombstone = entryFor('alpha', {
    binding: {
      ...current.binding,
      sourceDigest: `sha256:${'8'.repeat(64)}`,
      semanticDigest: `sha256:${'9'.repeat(64)}`,
    },
    supersedes: current.entryId,
    status: 'tombstone',
  });
  writeLedgerEntry(root, tombstone);
  updateLedgerIndex(root, [tombstone]);

  assert.equal(readLedgerIndex(root).subjects.alpha, undefined);
  assert.deepEqual(readLedgerEntry(root, current.entryId), current);
  assert.deepEqual(readLedgerEntry(root, tombstone.entryId), tombstone);

  const wrong = entryFor('alpha', {
    supersedes: `sha256:${'f'.repeat(64)}`,
    status: 'tombstone',
  });
  writeLedgerEntry(root, wrong);
  assert.throws(
    () => updateLedgerIndex(root, [wrong]),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_STORE_INVALID'),
  );
});

test('a change pays depth only for what stopped holding', () => {
  // The whole point: thirty-six subjects in reach, four that actually moved.
  const subjects = Array.from({ length: 36 }, (_, index) => `subject-${index}`);
  const entries = new Map(
    subjects.map((subjectId) => [subjectId, entryFor(subjectId)]),
  );
  const observations = new Map(
    subjects.map((subjectId) => [
      subjectId,
      fresh(entries.get(subjectId)!) as FreshnessObservation,
    ]),
  );
  // One changed meaning, one raised policy, one deleted, one never recorded.
  observations.set('subject-0', {
    ...fresh(entries.get('subject-0')!),
    semanticDigest: `sha256:${'9'.repeat(64)}`,
  });
  observations.set('subject-1', {
    ...fresh(entries.get('subject-1')!),
    currentPolicyDigest: `sha256:${'c'.repeat(64)}`,
  });
  observations.set('subject-2', {
    ...fresh(entries.get('subject-2')!),
    present: false,
  });
  entries.delete('subject-3');

  const plan = planSemanticReuse(subjects, entries, observations);
  assert.equal(plan.reused, 32);
  assert.equal(plan.revalidated, 1);
  assert.equal(plan.regenerated, 3);
  assert.equal(Math.round(plan.reuseRate * 100), 89);
  assert.deepEqual([...subjectsOwedDepth(plan)].sort(), [
    'subject-0',
    'subject-1',
    'subject-2',
    'subject-3',
  ]);
});

test('a subject that cannot be observed is never quietly reused', () => {
  const plan = planSemanticReuse(
    ['alpha'],
    new Map([['alpha', entryFor('alpha')]]),
    new Map(),
  );
  assert.equal(plan.resolutions[0].resolution, 'regenerate');
  assert.equal(plan.reused, 0);
});

test('reuse never removes a subject from what a reviewer can see', () => {
  const subjects = ['alpha', 'beta'];
  const entries = new Map(subjects.map((id) => [id, entryFor(id)]));
  const observations = new Map(
    subjects.map((id) => [id, fresh(entries.get(id)!) as FreshnessObservation]),
  );
  const plan = planSemanticReuse(subjects, entries, observations);
  // Every subject is still accounted for, whatever its depth resolution.
  assert.deepEqual(
    plan.resolutions.map(({ subjectId }) => subjectId),
    subjects,
  );
  assert.deepEqual(subjectsOwedDepth(plan), []);
});
