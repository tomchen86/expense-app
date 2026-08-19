import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assembleCurrentPromptFromStore,
  assessStoredAttemptResultEligibility,
  buildContextManifest,
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  inspectDurableRetentionCatalog,
  listDurablePruneReceipts,
  pinDurableEvidence,
  pruneDurableEvidence,
  readDurableEvidence,
  rolloverDurableEpochContextStore,
  storeDurableEvidence,
  withCurrentDurableEpochContextStore,
  type ContextManifest,
  type EvidenceRetentionRecord,
  type WorkflowContextState,
} from '../src/modules/authority/execution-governance.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const PRUNE_AT = new Date('2026-08-12T09:00:00.000Z');

function sha256(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function manifest(
  epoch: number,
  contractVersion: number,
  identity: string,
  content: string,
): ContextManifest {
  return buildContextManifest({
    workflowId: 'change-a',
    epoch,
    contractVersion,
    baselineDigest: `sha256:${String(epoch).repeat(64)}`,
    intentDigest: `sha256:${'a'.repeat(64)}`,
    termSetDigest: `sha256:${'b'.repeat(64)}`,
    planningSnapshotDigest: `sha256:${'c'.repeat(64)}`,
    items: [{ identity, content }],
  });
}

function workflow(currentManifest: ContextManifest): WorkflowContextState {
  return {
    workflowId: currentManifest.workflowId,
    currentEpoch: currentManifest.epoch,
    contractVersion: currentManifest.contractVersion,
    contextDigest: currentManifest.contextDigest,
    snapshotDigest: currentManifest.baselineDigest,
    status: 'active',
    checkpoint: 'main-terms',
    blocker: null,
  };
}

function evidence(input: {
  evidenceId: string;
  epoch: number;
  content: string;
  retention: EvidenceRetentionRecord['retention'];
  itemIdentity?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
}): EvidenceRetentionRecord {
  const createdAt = input.createdAt ?? '2026-07-01T00:00:00.000Z';
  return {
    schemaVersion: 1,
    kind: 'evidence-retention',
    evidenceId: input.evidenceId,
    itemIdentity: input.itemIdentity ?? null,
    workflowId: 'change-a',
    epoch: input.epoch,
    evidenceClass: 'raw',
    digest: sha256(input.content),
    retention: input.retention,
    createdAt,
    expiresAt:
      input.expiresAt ??
      (input.retention === 'expiring' ? '2026-07-08T00:00:00.000Z' : null),
    pin: null,
  };
}

test('durable epoch context CAS exposes only the current manifest and rejects late output', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-context-store-'));
  try {
    const firstManifest = manifest(1, 1, 'intent:stable', 'old intent');
    const initialized = initializeDurableEpochContextStore(store, {
      workflow: workflow(firstManifest),
      manifest: firstManifest,
      items: [{ identity: 'intent:stable', content: 'old intent' }],
      now: NOW,
    });
    assert.equal(initialized.generation, 1);
    assert.equal(
      assembleCurrentPromptFromStore(store, {
        workflowId: 'change-a',
        expectedEpoch: 1,
        expectedContextDigest: firstManifest.contextDigest,
      }),
      'old intent',
    );
    let guardedAcceptances = 0;
    withCurrentDurableEpochContextStore(
      store,
      {
        workflowId: 'change-a',
        expectedGeneration: initialized.generation,
        expectedEpoch: 1,
        expectedContextDigest: firstManifest.contextDigest,
        expectedManifest: firstManifest,
      },
      (current) => {
        assert.equal(current.generation, initialized.generation);
        guardedAcceptances += 1;
      },
    );
    assert.equal(guardedAcceptances, 1);

    const secondManifest = manifest(2, 2, 'intent:stable', 'current intent');
    const rolled = rolloverDurableEpochContextStore(store, {
      workflowId: 'change-a',
      expectedGeneration: initialized.generation,
      expectedEpoch: 1,
      expectedContextDigest: firstManifest.contextDigest,
      nextManifest: secondManifest,
      items: [{ identity: 'intent:stable', content: 'current intent' }],
      reason: 'The semantic validation contract changed.',
      restartFrom: 'main-terms',
      carriedForward: [],
      invalidated: ['plan-review'],
      verification: {
        check: 'semantic-contract-check',
        result: 'passed',
      },
      createdAt: new Date('2026-08-03T09:01:00.000Z'),
    });
    assert.equal(rolled.generation, 2);
    assert.equal(rolled.workflow.currentEpoch, 2);
    assert.equal(rolled.transitionReceipts.length, 1);
    assert.equal(
      assembleCurrentPromptFromStore(store, {
        workflowId: 'change-a',
        expectedEpoch: 2,
        expectedContextDigest: secondManifest.contextDigest,
      }),
      'current intent',
    );
    assert.throws(
      () =>
        assembleCurrentPromptFromStore(store, {
          workflowId: 'change-a',
          expectedEpoch: 1,
          expectedContextDigest: firstManifest.contextDigest,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_CONTEXT_STALE_EPOCH'),
    );
    assert.throws(
      () =>
        withCurrentDurableEpochContextStore(
          store,
          {
            workflowId: 'change-a',
            expectedGeneration: initialized.generation,
            expectedEpoch: 1,
            expectedContextDigest: firstManifest.contextDigest,
            expectedManifest: firstManifest,
          },
          () => {
            guardedAcceptances += 1;
          },
        ),
      (error) => isWorkflowError(error, 'EXECUTION_CONTEXT_CAS_MISMATCH'),
    );
    assert.equal(guardedAcceptances, 1);

    const staleEligibility = assessStoredAttemptResultEligibility(
      store,
      'change-a',
      {
        workflowId: 'change-a',
        jobId: 'job-plan-review-001',
        epoch: 1,
        contextDigest: firstManifest.contextDigest,
        snapshotDigest: firstManifest.baselineDigest,
        acceptedAttemptId: null,
        eligibleAttemptIds: ['attempt-old'],
      },
      {
        workflowId: 'change-a',
        jobId: 'job-plan-review-001',
        attemptId: 'attempt-old',
        epoch: 1,
        contextDigest: firstManifest.contextDigest,
        snapshotDigest: firstManifest.baselineDigest,
      },
    );
    assert.deepEqual(staleEligibility, {
      eligible: false,
      classification: 'stale',
      reasonCode: 'RESULT_STALE_EPOCH',
      doNotMerge: true,
    });

    assert.throws(
      () =>
        rolloverDurableEpochContextStore(store, {
          workflowId: 'change-a',
          expectedGeneration: 1,
          expectedEpoch: 1,
          expectedContextDigest: firstManifest.contextDigest,
          nextManifest: secondManifest,
          items: [{ identity: 'intent:stable', content: 'current intent' }],
          reason: 'Retry a stale epoch transition.',
          restartFrom: 'main-terms',
          carriedForward: [],
          invalidated: ['plan-review'],
          verification: null,
          createdAt: new Date('2026-08-03T09:02:00.000Z'),
        }),
      (error) => isWorkflowError(error, 'EXECUTION_CONTEXT_CAS_MISMATCH'),
    );
    assert.equal(
      inspectDurableEpochContextStore(store, 'change-a').generation,
      2,
    );
    const catalog = inspectDurableRetentionCatalog(store, 'change-a');
    const oldManifestRecord = catalog.records.find(
      (record) =>
        record.epoch === 1 && record.evidenceClass === 'manifest-item',
    );
    assert.ok(oldManifestRecord);
    const pruned = pruneDurableEvidence(store, {
      workflowId: 'change-a',
      expectedContextGeneration: 2,
      expectedEpoch: 2,
      expectedContextDigest: secondManifest.contextDigest,
      expectedCatalogGeneration: catalog.generation,
      now: PRUNE_AT,
    });
    assert.equal(
      pruned.receipt.deleted.some(
        ({ evidenceId }) => evidenceId === oldManifestRecord.evidenceId,
      ),
      true,
    );
    assert.equal(
      assembleCurrentPromptFromStore(store, {
        workflowId: 'change-a',
        expectedEpoch: 2,
        expectedContextDigest: secondManifest.contextDigest,
      }),
      'current intent',
    );
    assertPrivateStore(store);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('durable retention pruning writes a receipt and never removes active, pinned, or current-manifest evidence', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-store-'));
  try {
    const currentManifest = manifest(2, 2, 'intent:current', 'current intent');
    initializeDurableEpochContextStore(store, {
      workflow: workflow(currentManifest),
      manifest: currentManifest,
      items: [{ identity: 'intent:current', content: 'current intent' }],
      now: NOW,
    });

    let catalog = inspectDurableRetentionCatalog(store, 'change-a');
    catalog = storeDurableEvidence(store, {
      workflowId: 'change-a',
      expectedCatalogGeneration: catalog.generation,
      record: evidence({
        evidenceId: 'evidence-current-active',
        epoch: 2,
        content: 'active result',
        retention: 'active',
        createdAt: NOW.toISOString(),
      }),
      content: 'active result',
    });
    catalog = storeDurableEvidence(store, {
      workflowId: 'change-a',
      expectedCatalogGeneration: catalog.generation,
      record: evidence({
        evidenceId: 'evidence-old-expired',
        epoch: 1,
        content: 'expired raw output',
        retention: 'expiring',
      }),
      content: 'expired raw output',
    });
    catalog = storeDurableEvidence(store, {
      workflowId: 'change-a',
      expectedCatalogGeneration: catalog.generation,
      record: evidence({
        evidenceId: 'evidence-current-reference',
        epoch: 1,
        content: 'current intent',
        retention: 'expiring',
        itemIdentity: 'intent:current',
      }),
      content: 'current intent',
    });
    catalog = storeDurableEvidence(store, {
      workflowId: 'change-a',
      expectedCatalogGeneration: catalog.generation,
      record: evidence({
        evidenceId: 'evidence-to-pin',
        epoch: 1,
        content: 'human-pinned evidence',
        retention: 'expiring',
      }),
      content: 'human-pinned evidence',
    });
    catalog = pinDurableEvidence(store, {
      workflowId: 'change-a',
      evidenceId: 'evidence-to-pin',
      expectedCatalogGeneration: catalog.generation,
      decision: {
        actor: 'fixture-maintainer',
        reason: 'Retain for an explicit audit.',
        pinnedAt: NOW,
        humanConfirmed: true,
      },
    });

    const context = inspectDurableEpochContextStore(store, 'change-a');
    const result = pruneDurableEvidence(store, {
      workflowId: 'change-a',
      expectedContextGeneration: context.generation,
      expectedEpoch: context.workflow.currentEpoch,
      expectedContextDigest: context.workflow.contextDigest,
      expectedCatalogGeneration: catalog.generation,
      now: PRUNE_AT,
    });
    assert.equal(result.receipt.state, 'complete');
    assert.deepEqual(
      result.receipt.deleted.map(({ evidenceId }) => evidenceId),
      ['evidence-old-expired'],
    );
    assert.equal(
      result.catalog.records.some(
        ({ evidenceId }) => evidenceId === 'evidence-current-active',
      ),
      true,
    );
    assert.equal(
      result.catalog.records.some(
        ({ evidenceId }) => evidenceId === 'evidence-current-reference',
      ),
      true,
    );
    assert.equal(
      result.catalog.records.some(
        ({ evidenceId }) => evidenceId === 'evidence-to-pin',
      ),
      true,
    );
    assert.throws(
      () => readDurableEvidence(store, 'change-a', 'evidence-old-expired'),
      (error) => isWorkflowError(error, 'RETENTION_EVIDENCE_NOT_FOUND'),
    );
    assert.equal(
      readDurableEvidence(store, 'change-a', 'evidence-to-pin').content,
      'human-pinned evidence',
    );
    assert.equal(
      assembleCurrentPromptFromStore(store, {
        workflowId: 'change-a',
        expectedEpoch: 2,
        expectedContextDigest: currentManifest.contextDigest,
      }),
      'current intent',
    );
    assert.deepEqual(
      listDurablePruneReceipts(store, 'change-a').map(
        ({ receiptId, state }) => ({
          receiptId,
          state,
        }),
      ),
      [{ receiptId: result.receipt.receiptId, state: 'complete' }],
    );

    assert.throws(
      () =>
        storeDurableEvidence(store, {
          workflowId: 'change-a',
          expectedCatalogGeneration: result.catalog.generation,
          record: evidence({
            evidenceId: 'evidence-late-active',
            epoch: 1,
            content: 'late output',
            retention: 'active',
            createdAt: PRUNE_AT.toISOString(),
          }),
          content: 'late output',
        }),
      (error) => isWorkflowError(error, 'RETENTION_STALE_EPOCH'),
    );
    assert.throws(
      () =>
        storeDurableEvidence(store, {
          workflowId: 'change-a',
          expectedCatalogGeneration: result.catalog.generation,
          record: {
            ...evidence({
              evidenceId: 'evidence-self-pinned',
              epoch: 1,
              content: 'fabricated permanent evidence',
              retention: 'expiring',
            }),
            retention: 'pinned',
            expiresAt: null,
            pin: {
              actor: 'fixture-maintainer',
              reason: 'Fabricated without the explicit pin operation.',
              pinnedAt: NOW.toISOString(),
            },
          },
          content: 'fabricated permanent evidence',
        }),
      (error) => isWorkflowError(error, 'RETENTION_PIN_REQUIRES_HUMAN'),
    );
    assert.throws(
      () =>
        pruneDurableEvidence(store, {
          workflowId: 'change-a',
          expectedContextGeneration: context.generation,
          expectedEpoch: 2,
          expectedContextDigest: currentManifest.contextDigest,
          expectedCatalogGeneration: catalog.generation,
          now: PRUNE_AT,
        }),
      (error) => isWorkflowError(error, 'RETENTION_CATALOG_CAS_MISMATCH'),
    );
    assertPrivateStore(store);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

function assertPrivateStore(root: string): void {
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stats = fs.lstatSync(target);
      assert.equal(stats.isSymbolicLink(), false, target);
      if (stats.isDirectory()) {
        assert.equal(stats.mode & 0o077, 0, target);
        visit(target);
      } else {
        assert.equal(stats.isFile(), true, target);
        assert.equal(stats.mode & 0o777, 0o600, target);
      }
    }
  };
  visit(root);
}
