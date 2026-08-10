import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  controlPlanePromotionLineageDigest,
  createControlPlanePromotionLineage,
} from '../src/intervention-control.ts';

// Substrate-only: no production producer, updater, persistence, or bootstrap
// selector consumes this value object yet.
test('promotion lineage substrate binds the exact append-only supervisor predecessor', () => {
  const lineage = createControlPlanePromotionLineage({
    historyAnchorDigest: digest('anchor'),
    previousTerminalRecordDigest: digest('terminal-2'),
    previousSupervisorRecordDigest: digest('supervisor-2'),
    previousGeneration: 2,
    candidateGeneration: 3,
    rollbackGeneration: 4,
    previousActiveTrustCommit: commit('trusted-2'),
    candidateTrustCommit: commit('candidate-3'),
  });

  assert.equal(lineage.kind, 'control-plane-promotion-lineage.v1');
  assert.equal(lineage.candidateGeneration, lineage.previousGeneration + 1);
  assert.equal(lineage.rollbackGeneration, lineage.previousGeneration + 2);
  assert.equal(
    lineage.lineageDigest,
    controlPlanePromotionLineageDigest(lineage),
  );
  assert.throws(() =>
    createControlPlanePromotionLineage({
      ...lineage,
      candidateGeneration: 99,
    }),
  );
});

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function commit(label: string): string {
  return crypto.createHash('sha256').update(`commit:${label}`).digest('hex');
}
