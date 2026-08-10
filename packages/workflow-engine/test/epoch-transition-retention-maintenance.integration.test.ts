import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assembleCurrentPromptFromStore,
  buildContextManifest,
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  inspectDurableRetentionCatalog,
  rolloverDurableEpochContextStore,
  type ContextManifest,
  type WorkflowContextState,
} from '../src/execution-governance.ts';
import { runDurableContextRetentionMaintenance } from '../src/retention-control.ts';

function manifest(epoch: number, content: string): ContextManifest {
  return buildContextManifest({
    workflowId: 'idle-transition-receipts',
    epoch,
    contractVersion: epoch,
    baselineDigest: `sha256:${String(epoch).repeat(64)}`,
    intentDigest: `sha256:${'a'.repeat(64)}`,
    termSetDigest: `sha256:${'b'.repeat(64)}`,
    planningSnapshotDigest: `sha256:${'c'.repeat(64)}`,
    items: [{ identity: 'intent:current', content }],
  });
}

function workflow(current: ContextManifest): WorkflowContextState {
  return {
    workflowId: current.workflowId,
    currentEpoch: current.epoch,
    contractVersion: current.contractVersion,
    contextDigest: current.contextDigest,
    snapshotDigest: current.baselineDigest,
    status: 'active',
    checkpoint: 'main-terms',
    blocker: null,
  };
}

test('retention maintenance compacts an expired epoch receipt without another rollover', () => {
  const storeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'epoch-receipt-maintenance-'),
  );
  try {
    const first = manifest(1, 'old intent');
    const initial = initializeDurableEpochContextStore(storeRoot, {
      workflow: workflow(first),
      manifest: first,
      items: [{ identity: 'intent:current', content: 'old intent' }],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = manifest(2, 'current intent');
    const rolled = rolloverDurableEpochContextStore(storeRoot, {
      workflowId: first.workflowId,
      expectedGeneration: initial.generation,
      expectedEpoch: first.epoch,
      expectedContextDigest: first.contextDigest,
      nextManifest: second,
      items: [{ identity: 'intent:current', content: 'current intent' }],
      reason: 'The semantic contract changed.',
      restartFrom: 'main-terms',
      carriedForward: [],
      invalidated: ['plan-review'],
      verification: { check: 'semantic-contract-check', result: 'passed' },
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    assert.equal(rolled.transitionReceipts.length, 1);
    assert.equal(rolled.transitionStubs.length, 0);

    const result = runDurableContextRetentionMaintenance(
      storeRoot,
      [first.workflowId],
      { limit: 10, now: new Date('2026-08-10T00:00:00.000Z') },
    );

    assert.deepEqual(result.compacted, [
      {
        workflowId: first.workflowId,
        fullReceiptsBefore: 1,
        fullReceiptsAfter: 0,
        stubsBefore: 0,
        stubsAfter: 1,
        discarded: [],
      },
    ]);
    const after = inspectDurableEpochContextStore(storeRoot, first.workflowId);
    assert.equal(after.generation, rolled.generation + 1);
    assert.equal(after.transitionReceipts.length, 0);
    assert.equal(after.transitionStubs.length, 1);
    assert.equal(after.workflow.currentEpoch, second.epoch);
    assert.equal(after.workflow.contextDigest, second.contextDigest);
    assert.equal(
      assembleCurrentPromptFromStore(storeRoot, {
        workflowId: first.workflowId,
        expectedEpoch: second.epoch,
        expectedContextDigest: second.contextDigest,
      }),
      'current intent',
    );
    assert.equal(
      inspectDurableRetentionCatalog(storeRoot, first.workflowId).records.some(
        ({ epoch }) => epoch === second.epoch,
      ),
      true,
    );
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});
