import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptApplyPrestate,
  advanceApplyJournal,
  assertCandidateChecksFresh,
  buildImmutableCandidateBundle,
  canonicalImmutableCandidateBundle,
  createApplyJournal,
  createRefGenerationLedger,
  ensureDurableRefGenerationLedger,
  parseImmutableCandidateBundle,
  readStoredImmutableCandidateBundle,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
  recoverApplyJournal,
  recordRefGenerationTransition,
  storeImmutableCandidateBundle,
  terminalizeApplyGrant,
  type CandidateChecksAttestation,
} from '../src/maintainer-candidate.ts';
import type { PatchManifest } from '../src/maintainer-manifest.ts';
import { canonicalPatchManifest } from '../src/maintainer-manifest.ts';
import { isWorkflowError } from './fixture.ts';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const ENVIRONMENT = 'e'.repeat(64);
const mandateBinding = {
  schemaVersion: 1 as const,
  mandateTaskId: 'demo-task',
  mandateId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: '1'.repeat(64),
  changeId: 'demo-change',
  externalAuditRoot: path.join(os.tmpdir(), 'candidate-audit-root'),
};

const manifestBody: PatchManifest = {
  schema: 'maintainer-patch-manifest.v2',
  profile: 'workflow-engine-bootstrap',
  profileVersion: 1,
  trustBaseCommit: OID_A,
  policyDigest: DIGEST,
  files: [
    {
      path: 'packages/workflow-engine/src/example.ts',
      role: 'implementation',
      operation: 'modify',
      beforeBlobOid: OID_A,
      afterSha256: DIGEST,
      beforeMode: '100644',
      afterMode: '100644',
    },
  ],
  patchDigest: '',
};
const manifest: PatchManifest = {
  ...manifestBody,
  patchDigest: crypto
    .createHash('sha256')
    .update(canonicalPatchManifest(manifestBody))
    .digest('hex'),
};

function checks(
  completedAt = '2026-08-03T09:00:00.000Z',
): CandidateChecksAttestation {
  return {
    schemaVersion: 2,
    candidateTree: TREE,
    patchDigest: manifest.patchDigest,
    trustBaseCommit: OID_A,
    checks: [
      {
        checkId: 'workflow-tests',
        definitionDigest: '2'.repeat(64),
        commandDigest: '3'.repeat(64),
        runnerDigest: '4'.repeat(64),
        environmentDigest: ENVIRONMENT,
        resultDigest: '5'.repeat(64),
        outcome: 'passed',
        startedAt: '2026-08-03T08:59:00.000Z',
        completedAt,
        reuseClass: 'toolchain-dependent',
        maxAgeMs: 86_400_000,
        externalSnapshotDigest: null,
        dependsOn: ['harness-engine', 'runner', 'source-tree'],
      },
    ],
  };
}

function candidateBundle() {
  return buildImmutableCandidateBundle({
    mandateBinding,
    repositoryId: 'github:R_fixture',
    targetRef: 'refs/heads/work/demo-change',
    expectedOldCommit: OID_A,
    expectedRefGeneration: 7,
    candidateCommit: OID_B,
    resultTree: TREE,
    commitMessage: 'Apply exact candidate\n',
    manifest,
    checksAttestation: checks(),
    effectsManifestDigest: '6'.repeat(64),
    providerInvocationsDigest: '7'.repeat(64),
    classification: 'ordinary',
    recoveryPlanDigest: '8'.repeat(64),
    createdAt: '2026-08-03T09:01:00.000Z',
  });
}

test('immutable candidate identity binds commit, result tree, manifests, effects, and message', () => {
  const candidate = candidateBundle();

  assert.match(candidate.candidateBundleDigest, /^[0-9a-f]{64}$/);
  assert.equal(candidate.resultTree, TREE);
  assert.equal(candidate.expectedRefGeneration, 7);
  const { candidateBundleDigest: _candidateBundleDigest, ...candidateInput } =
    candidate;
  const changedMessage = buildImmutableCandidateBundle({
    ...candidateInput,
    commitMessage: 'Apply different candidate\n',
  });
  assert.notEqual(
    changedMessage.candidateBundleDigest,
    candidate.candidateBundleDigest,
  );

  const canonical = canonicalImmutableCandidateBundle(candidate);
  assert.deepEqual(parseImmutableCandidateBundle(canonical), candidate);
  const unknown = JSON.parse(canonical) as Record<string, unknown>;
  unknown.untrusted = true;
  assert.throws(
    () => parseImmutableCandidateBundle(`${JSON.stringify(unknown)}\n`),
    (error) => isWorkflowError(error, 'APPLY_CANDIDATE_INVALID'),
  );
});

test('immutable candidate store is private, content-addressed, canonical, and idempotent', () => {
  const gitCommonDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-candidate-store-')),
  );
  const candidate = candidateBundle();
  try {
    const stored = storeImmutableCandidateBundle(gitCommonDirectory, candidate);
    assert.equal(
      path.basename(stored),
      `${candidate.candidateBundleDigest}.json`,
    );
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(stored)).mode & 0o777, 0o700);
    assert.deepEqual(
      readStoredImmutableCandidateBundle(
        gitCommonDirectory,
        candidate.candidateBundleDigest,
      ),
      candidate,
    );
    assert.equal(
      storeImmutableCandidateBundle(gitCommonDirectory, candidate),
      stored,
    );

    fs.chmodSync(stored, 0o644);
    assert.throws(
      () =>
        readStoredImmutableCandidateBundle(
          gitCommonDirectory,
          candidate.candidateBundleDigest,
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_STORE_INVALID'),
    );
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});

test('attestation freshness is anchored to original completion and selective dependencies', () => {
  assert.doesNotThrow(() =>
    assertCandidateChecksFresh(checks(), {
      now: new Date('2026-08-04T08:59:59.000Z'),
      candidateTree: TREE,
      patchDigest: manifest.patchDigest,
      trustBaseCommit: OID_A,
      requiredChecks: ['workflow-tests'],
      environmentDigest: ENVIRONMENT,
      changedDependencies: [],
    }),
  );
  assert.throws(
    () =>
      assertCandidateChecksFresh(checks(), {
        now: new Date('2026-08-04T09:00:01.000Z'),
        candidateTree: TREE,
        patchDigest: manifest.patchDigest,
        trustBaseCommit: OID_A,
        requiredChecks: ['workflow-tests'],
        environmentDigest: ENVIRONMENT,
        changedDependencies: [],
      }),
    (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
  );
  assert.throws(
    () =>
      assertCandidateChecksFresh(checks(), {
        now: new Date('2026-08-03T09:01:00.000Z'),
        candidateTree: TREE,
        patchDigest: manifest.patchDigest,
        trustBaseCommit: OID_A,
        requiredChecks: ['workflow-tests'],
        environmentDigest: ENVIRONMENT,
        changedDependencies: ['harness-engine'],
      }),
    (error) => isWorkflowError(error, 'APPLY_ATTESTATION_INVALIDATED'),
  );
});

test('ref generation rejects ABA even when the object id returns to the approved base', () => {
  let ledger = createRefGenerationLedger('refs/heads/work/demo-change', OID_A);
  ledger = recordRefGenerationTransition(ledger, {
    expectedOid: OID_A,
    expectedGeneration: 0,
    nextOid: OID_B,
    reason: 'apply',
    at: '2026-08-03T09:02:00.000Z',
  });
  ledger = recordRefGenerationTransition(ledger, {
    expectedOid: OID_B,
    expectedGeneration: 1,
    nextOid: OID_A,
    reason: 'rollback',
    at: '2026-08-03T09:03:00.000Z',
  });

  assert.equal(ledger.currentOid, OID_A);
  assert.equal(ledger.generation, 2);
  assert.throws(
    () => acceptApplyPrestate(ledger, OID_A, 0),
    (error) => isWorkflowError(error, 'APPLY_REF_GENERATION_MISMATCH'),
  );
});

test('ref generation ledger persists an atomic monotonic transition outside candidate data', () => {
  const gitCommonDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ref-generation-ledger-')),
  );
  try {
    const created = ensureDurableRefGenerationLedger(
      gitCommonDirectory,
      'refs/heads/work/demo-change',
      OID_A,
    );
    assert.equal(created.generation, 0);
    recordDurableRefGenerationTransitionUnderLifecycleLock(
      gitCommonDirectory,
      {
        ref: created.ref,
        expectedOid: OID_A,
        expectedGeneration: 0,
        nextOid: OID_B,
        reason: 'apply',
        at: '2026-08-03T09:02:00.000Z',
      },
      () => {},
    );
    const reread = readDurableRefGenerationLedger(
      gitCommonDirectory,
      created.ref,
      true,
    );
    assert.equal(reread.currentOid, OID_B);
    assert.equal(reread.generation, 1);
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});

test('apply journal recovery distinguishes pre-CAS expiry from post-CAS completion', () => {
  const journal = createApplyJournal({
    txId: 'tx-12345678',
    grantId: '33333333-3333-4333-8333-333333333333',
    targetRef: 'refs/heads/work/demo-change',
    expectedOldCommit: OID_A,
    expectedRefGeneration: 0,
    candidateCommit: OID_B,
    candidateBundleDigest: DIGEST,
    createdAt: '2026-08-03T09:00:00.000Z',
  });

  assert.deepEqual(
    recoverApplyJournal(journal, {
      observedRef: OID_A,
      now: new Date('2026-08-03T09:05:01.000Z'),
      grantExpiresAt: '2026-08-03T09:05:00.000Z',
    }),
    { action: 'terminalize-expired' },
  );
  assert.deepEqual(
    recoverApplyJournal(journal, {
      observedRef: OID_B,
      now: new Date('2026-08-03T09:05:01.000Z'),
      grantExpiresAt: '2026-08-03T09:05:00.000Z',
    }),
    { action: 'complete-after-cas' },
  );
  assert.deepEqual(
    recoverApplyJournal(journal, {
      observedRef: 'f'.repeat(40),
      now: new Date('2026-08-03T09:04:00.000Z'),
      grantExpiresAt: '2026-08-03T09:05:00.000Z',
    }),
    { action: 'manual-reconciliation' },
  );
});

test('grant terminalization releases reservation while retaining candidate and attestation', () => {
  const terminal = terminalizeApplyGrant(
    {
      grantId: '33333333-3333-4333-8333-333333333333',
      state: 'applying',
      reservationId: 'tx-12345678',
      candidateBundleDigest: DIGEST,
      checksAttestationDigest: '9'.repeat(64),
    },
    'expired',
  );
  assert.equal(terminal.state, 'expired');
  assert.equal(terminal.reservationId, null);
  assert.equal(terminal.candidateBundleDigest, DIGEST);
  assert.equal(terminal.checksAttestationDigest, '9'.repeat(64));

  const journal = createApplyJournal({
    txId: 'tx-12345678',
    grantId: terminal.grantId,
    targetRef: 'refs/heads/work/demo-change',
    expectedOldCommit: OID_A,
    expectedRefGeneration: 0,
    candidateCommit: OID_B,
    candidateBundleDigest: DIGEST,
    createdAt: '2026-08-03T09:00:00.000Z',
  });
  const refUpdated = advanceApplyJournal(journal, 'REF_UPDATED', {
    at: '2026-08-03T09:01:00.000Z',
    observedRef: OID_B,
  });
  assert.equal(refUpdated.state, 'REF_UPDATED');
  assert.throws(
    () =>
      advanceApplyJournal(journal, 'COMPLETE', {
        at: '2026-08-03T09:01:00.000Z',
      }),
    (error) => isWorkflowError(error, 'APPLY_JOURNAL_TRANSITION_INVALID'),
  );
});
