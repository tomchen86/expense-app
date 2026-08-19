import assert from 'node:assert/strict';
import test from 'node:test';

import { assessSemanticFreshness } from '../src/modules/why-knowledge/semantic-freshness.ts';
import {
  assertLedgerEntry,
  createLedgerEntry,
  dependencySetDigest,
  type LedgerEntryInput,
} from '../src/modules/why-knowledge/semantic-ledger.ts';
import { isWorkflowError } from './fixture.ts';

const POLICY = `sha256:${'1'.repeat(64)}`;

function input(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    schemaVersion: 1,
    kind: 'semantic-ledger-entry',
    subject: {
      subjectId: 'investigation.resume-propose',
      kind: 'symbol',
      path: 'packages/workflow-engine/src/application/propose/propose-orchestrator.ts',
      symbol: 'resumePropose',
    },
    binding: {
      baselineCommit: 'a'.repeat(40),
      blobDigest: `sha256:${'2'.repeat(64)}`,
      sourceDigest: `sha256:${'3'.repeat(64)}`,
      semanticDigest: `sha256:${'4'.repeat(64)}`,
      extractorVersion: 'ts-adapter-v1',
    },
    why: {
      responsibility:
        'Advances the propose state machine under a pinned checkpoint.',
      protectedInvariants: [
        'A checkpoint cannot be replayed against another revision.',
      ],
      failureModes: ['stale checkpoint acceptance'],
      reviewerQuestions: [
        'Can a succeeded invocation be rewritten instead of superseded?',
      ],
    },
    semanticDependencies: [
      {
        relation: 'validates-against',
        subjectId: 'investigation.checkpoint-envelope',
        entryId: `sha256:${'5'.repeat(64)}`,
      },
    ],
    policyDigest: POLICY,
    provenance: { changeId: 'demo-change', createdAtCommit: 'b'.repeat(40) },
    supersedes: null,
    status: 'current',
    ...overrides,
  } as LedgerEntryInput;
}

const ENTRY = createLedgerEntry(input());

function observed(overrides: Record<string, unknown> = {}) {
  return {
    present: true,
    sourceDigest: ENTRY.binding.sourceDigest,
    semanticDigest: ENTRY.binding.semanticDigest,
    currentDependencyEntryIds: {
      'investigation.checkpoint-envelope': `sha256:${'5'.repeat(64)}`,
    },
    currentPolicyDigest: POLICY,
    ...overrides,
  };
}

test('the same understanding always has the same identity', () => {
  assert.equal(createLedgerEntry(input()).entryId, ENTRY.entryId);
  const different = createLedgerEntry(
    input({
      why: { ...input().why, responsibility: 'Something else entirely.' },
    }),
  );
  assert.notEqual(different.entryId, ENTRY.entryId);
});

test('a claimed entry identity is recomputed, never believed', () => {
  assert.throws(
    () => assertLedgerEntry({ ...ENTRY, entryId: `sha256:${'0'.repeat(64)}` }),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
  assert.deepEqual(assertLedgerEntry({ ...ENTRY }), ENTRY);
});

test('dependency order does not change the dependency digest', () => {
  const forward = dependencySetDigest([
    { relation: 'a', subjectId: 'x', entryId: `sha256:${'6'.repeat(64)}` },
    { relation: 'b', subjectId: 'y', entryId: `sha256:${'7'.repeat(64)}` },
  ]);
  const reversed = dependencySetDigest([
    { relation: 'b', subjectId: 'y', entryId: `sha256:${'7'.repeat(64)}` },
    { relation: 'a', subjectId: 'x', entryId: `sha256:${'6'.repeat(64)}` },
  ]);
  assert.equal(reversed, forward);
});

test('an entry with no invariant is not evidence', () => {
  // "I learned that state synchronisation matters" cannot be checked later.
  assert.throws(
    () =>
      createLedgerEntry(
        input({
          why: { ...input().why, protectedInvariants: [] },
        }),
      ),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
});

test('an unchanged subject is reused', () => {
  const verdict = assessSemanticFreshness(ENTRY, observed());
  assert.equal(verdict.state, 'current');
  assert.equal(verdict.resolution, 'reuse');
});

test('reformatting without meaning change keeps the entry', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ sourceDigest: `sha256:${'9'.repeat(64)}` }),
  );
  assert.equal(verdict.state, 'exact-changed-semantic-same');
  assert.equal(verdict.resolution, 'reuse');
});

test('a changed meaning forces the WHY to be written again', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ semanticDigest: `sha256:${'8'.repeat(64)}` }),
  );
  assert.equal(verdict.state, 'subject-changed');
  assert.equal(verdict.resolution, 'regenerate');
});

test('an untouched consumer whose dependency moved must be revalidated', () => {
  // This is the case a "was the file modified?" check cannot see at all.
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({
      currentDependencyEntryIds: {
        'investigation.checkpoint-envelope': `sha256:${'f'.repeat(64)}`,
      },
    }),
  );
  assert.equal(verdict.state, 'dependency-changed');
  assert.equal(verdict.resolution, 'revalidate');
});

test('unknown dependency state is not treated as stability', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ currentDependencyEntryIds: undefined }),
  );
  assert.equal(verdict.state, 'dependency-changed');
});

test('a raised policy leaves the content standing but the assurance owed', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ currentPolicyDigest: `sha256:${'c'.repeat(64)}` }),
  );
  assert.equal(verdict.state, 'policy-stale');
  assert.equal(verdict.resolution, 'revalidate');
});

test('an ambiguous identity is resolved before its content is compared', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({
      identityAmbiguous: true,
      semanticDigest: `sha256:${'8'.repeat(64)}`,
    }),
  );
  assert.equal(verdict.state, 'identity-ambiguous');
  assert.equal(verdict.resolution, 'regenerate');
});

test('a deleted subject and a superseded entry are never reused', () => {
  assert.equal(
    assessSemanticFreshness(ENTRY, observed({ present: false })).state,
    'subject-deleted',
  );
  assert.equal(
    assessSemanticFreshness(
      createLedgerEntry(input({ status: 'superseded' })),
      observed(),
    ).state,
    'superseded',
  );
});
