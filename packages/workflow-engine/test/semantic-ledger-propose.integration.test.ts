import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { EvidenceNode } from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import {
  getProposeStatus,
  type OrdinaryProposeOutput,
} from '../src/application/propose/propose-orchestrator.ts';
import {
  ledgerIndexPath,
  ledgerObjectPath,
  readLedgerEntry,
  readLedgerIndex,
} from '../src/runtime/storage-journal/semantic-ledger-store.ts';
import {
  assertLedgerEntry,
  createLedgerEntry,
  type LedgerEntryInput,
} from '../src/modules/why-knowledge/semantic-ledger.ts';
import { projectInvestigationWhyToLedger } from '../src/runtime/managed-documents/transaction/semantic-ledger-projection.ts';
import { PROPOSE_POLICY_DIGEST } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { isWorkflowError } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TARGET = 'src/ledger-target.ts';
const TERM = 'SemanticLedgerProductionNeedle';
const INITIAL = `${TERM} initial contract\n`;
const CHANGED = `${TERM} changed contract\n`;

test('entry identity covers the canonical object except entryId', () => {
  const input: LedgerEntryInput = {
    schemaVersion: 1,
    kind: 'semantic-ledger-entry',
    subject: {
      subjectId: 'file.identity-contract',
      kind: 'file',
      path: 'src/identity-contract.ts',
    },
    binding: {
      baselineCommit: '1'.repeat(40),
      blobDigest: digest('blob'),
      sourceDigest: digest('source'),
      semanticDigest: digest('semantic'),
      extractorVersion: 'test.v1',
    },
    why: {
      responsibility: 'Own the ledger identity contract.',
      protectedInvariants: ['One identity names one canonical object.'],
      failureModes: [],
      reviewerQuestions: [],
    },
    semanticDependencies: [
      {
        relation: 'calls',
        subjectId: 'file.second',
        entryId: digest('second'),
      },
      {
        relation: 'calls',
        subjectId: 'file.first',
        entryId: digest('first'),
      },
    ],
    policyDigest: digest('policy'),
    provenance: {
      changeId: 'identity-a',
      createdAtCommit: '1'.repeat(40),
    },
    supersedes: null,
    status: 'current',
  };
  const entry = createLedgerEntry(input);
  const reordered = createLedgerEntry({
    ...input,
    semanticDependencies: [...input.semanticDependencies].reverse(),
  });
  assert.equal(reordered.entryId, entry.entryId);
  assert.deepEqual(reordered.semanticDependencies, entry.semanticDependencies);

  const changedProvenance = createLedgerEntry({
    ...input,
    provenance: { ...input.provenance, changeId: 'identity-b' },
  });
  assert.notEqual(changedProvenance.entryId, entry.entryId);

  const changedStatus = createLedgerEntry({
    ...input,
    status: 'superseded',
  });
  assert.notEqual(changedStatus.entryId, entry.entryId);

  assert.throws(
    () => assertLedgerEntry({ ...entry, unexpected: true }),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
  assert.throws(
    () =>
      assertLedgerEntry({
        ...entry,
        subject: { ...entry.subject, unexpected: true },
      }),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
});

test('ledger store rejects malformed identities, indexes, and symlink roots', () => {
  assert.throws(
    () => ledgerObjectPath('../../outside'),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_STORE_INVALID'),
  );

  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'semantic-ledger-store-'),
  );
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'semantic-ledger-outside-'),
  );
  try {
    const root = path.join(repository, 'workflow/semantic-ledger');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'index.json'),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'semantic-ledger-index',
        subjects: {
          '../invalid-subject': { currentEntryId: '../../outside' },
        },
        unexpected: true,
      })}\n`,
    );
    assert.throws(
      () => readLedgerIndex(repository),
      (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_STORE_INVALID'),
    );

    fs.rmSync(root, { recursive: true });
    fs.symlinkSync(outside, root);
    assert.throws(
      () => readLedgerIndex(repository),
      (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_STORE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('propose remains read-only while an explicit unmounted projection is replay-safe', () => {
  const first = drive(TARGET, INITIAL, 'semantic-ledger-writer');
  try {
    const sealed = seal(first);
    assert.equal(sealed.state, 'awaiting-planning-contribution');

    // Normative production promotion belongs after implementation
    // reconciliation. Sealing or reading an investigation must not promote an
    // author WHY answer into tracked reusable authority.
    assert.deepEqual(ledgerFiles(first.repository), new Map());
    const status = getProposeStatus(
      first.repository,
      first.investigationId,
    ) as OrdinaryProposeOutput;
    assert.equal(status.state, 'awaiting-planning-contribution');
    assert.deepEqual(ledgerFiles(first.repository), new Map());

    project(first.repository, first.changeId, sealed);
    const index = readLedgerIndex(first.repository);
    const subjectIds = Object.keys(index.subjects);
    assert.equal(subjectIds.length, 1);
    const subjectId = subjectIds[0]!;
    const firstEntryId = index.subjects[subjectId]!.currentEntryId;
    const entry = readLedgerEntry(first.repository, firstEntryId);
    assert.equal(entry.subject.kind, 'file');
    assert.equal(entry.subject.path, TARGET);
    assert.equal(entry.binding.blobDigest, `sha256:${sha256(INITIAL)}`);
    assert.equal(entry.binding.sourceDigest, `sha256:${sha256(INITIAL)}`);
    assert.match(entry.binding.semanticDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.why.responsibility, whyAnswer('unused').why);
    assert.deepEqual(entry.why.protectedInvariants, [
      whyAnswer('unused').protectedInvariant,
    ]);
    assert.equal(entry.provenance.changeId, first.changeId);
    assert.equal(entry.supersedes, null);
    assert.match(entry.policyDigest, /^sha256:[0-9a-f]{64}$/);

    const originalLedger = ledgerFiles(first.repository);
    assert.ok(originalLedger.has(ledgerIndexPath()));

    // The pure projector itself is byte-idempotent. It is deliberately not
    // mounted on the production status path.
    project(first.repository, first.changeId, sealed);
    assert.deepEqual(ledgerFiles(first.repository), originalLedger);

    // Object-first/index-second is recoverable: losing the index after the
    // immutable object landed is repaired by an explicit projection replay.
    fs.unlinkSync(path.join(first.repository, ledgerIndexPath()));
    project(first.repository, first.changeId, sealed);
    assert.deepEqual(ledgerFiles(first.repository), originalLedger);

    const inheritedFiles = Object.fromEntries(originalLedger);
    const unchanged = drive(
      TARGET,
      INITIAL,
      'semantic-ledger-reuse',
      inheritedFiles,
    );
    try {
      const afterDispositions = submitAllDispositions(unchanged);
      assert.equal(
        afterDispositions.semanticReuse?.carried.some(
          (claim) =>
            claim.subjectId === subjectId &&
            claim.ledgerEntryId === firstEntryId,
        ),
        true,
      );
      assert.equal(
        afterDispositions.work?.fullBlobManifest.some(
          ({ path: manifestPath }) => manifestPath === TARGET,
        ),
        false,
      );
    } finally {
      unchanged.dispose();
    }

    const stale = drive(
      TARGET,
      CHANGED,
      'semantic-ledger-stale',
      inheritedFiles,
    );
    try {
      const afterDispositions = submitAllDispositions(stale);
      assert.equal(
        afterDispositions.semanticReuse?.resolutions.some(
          (resolution) =>
            resolution.subjectId === subjectId &&
            resolution.state === 'subject-changed' &&
            resolution.resolution === 'regenerate',
        ),
        true,
      );
      assert.equal(
        afterDispositions.work?.fullBlobManifest.some(
          ({ path: manifestPath }) => manifestPath === TARGET,
        ),
        true,
      );

      const resealed = stale.submit({
        answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
          ({ manifestEntryId }) => whyAnswer(manifestEntryId),
        ),
      });
      assert.equal(resealed.state, 'awaiting-planning-contribution');
      assert.deepEqual(ledgerFiles(stale.repository), originalLedger);
      project(stale.repository, stale.changeId, resealed);
      const successorId = readLedgerIndex(stale.repository).subjects[subjectId]!
        .currentEntryId;
      assert.notEqual(successorId, firstEntryId);
      const successor = readLedgerEntry(stale.repository, successorId);
      assert.equal(successor.supersedes, firstEntryId);
      assert.equal(successor.binding.blobDigest, `sha256:${sha256(CHANGED)}`);
      // Supersession moves only the index; history stays readable.
      assert.equal(
        readLedgerEntry(stale.repository, firstEntryId).entryId,
        firstEntryId,
      );
    } finally {
      stale.dispose();
    }
  } finally {
    first.dispose();
  }
});

function drive(
  target: string,
  content: string,
  changeId: string,
  inherited: Record<string, string> = {},
) {
  return driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    explicitPaths: [target],
    explicitSymbols: [],
    files: {
      ...inherited,
      [target]: content,
      'workflow/path-roles.json': `${canonicalJson({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: { ordinary: ['src/**'] },
      })}\n`,
    },
  });
}

function project(
  repository: string,
  changeId: string,
  output: OrdinaryProposeOutput,
): void {
  const investigation = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'openspec/changes', changeId, 'investigation.json'),
      'utf8',
    ),
  ) as { nodes: EvidenceNode[] };
  projectInvestigationWhyToLedger({
    repositoryRoot: repository,
    changeId,
    baselineCommit: output.investigation!.baseline.head,
    whyNodes: investigation.nodes.filter(
      ({ type }) => type === 'investigation-why',
    ),
    policyDigest: PROPOSE_POLICY_DIGEST,
  });
}

function seal(fixture: ReturnType<typeof drive>) {
  const afterDispositions = submitAllDispositions(fixture);
  assert.equal(afterDispositions.state, 'awaiting-ledger-answers');
  return fixture.submit({
    answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
      ({ manifestEntryId }) => whyAnswer(manifestEntryId),
    ),
  });
}

function submitAllDispositions(fixture: ReturnType<typeof drive>) {
  return fixture.submit({
    dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
      groupId,
      classification: 'load-bearing' as const,
      rationale: 'The ledger target is a production semantic subject.',
      author: 'codex',
    })),
  });
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'The target owns the production semantic ledger contract.',
    protectedInvariant:
      'Content-addressed claims remain bound to exact source bytes.',
    reviewerQuestion:
      'Can stale source bytes continue to reuse the previous understanding?',
    answer:
      'No. Freshness regenerates the claim and names the superseded entry.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}

function ledgerFiles(repository: string): Map<string, string> {
  const root = path.join(repository, 'workflow/semantic-ledger');
  const files = new Map<string, string>();
  if (!fs.existsSync(root)) return files;
  walk(root);
  return new Map(
    [...files].sort(([left], [right]) => left.localeCompare(right)),
  );

  function walk(directory: string): void {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
      } else if (stats.isFile() && !stats.isSymbolicLink()) {
        files.set(
          path.relative(repository, absolute).split(path.sep).join('/'),
          fs.readFileSync(absolute, 'utf8'),
        );
      }
    }
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digest(value: string): string {
  return `sha256:${sha256(value)}`;
}
