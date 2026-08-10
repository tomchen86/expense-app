import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  controlPlaneSupervisorHistoryRecordDigest,
  createControlPlaneSupervisorHistoryAnchor,
  createControlPlaneSupervisorHistoryTerminal,
  createControlPlaneSupervisorHistoryTransition,
  verifyControlPlaneSupervisorHistory,
  verifyControlPlaneSupervisorHistoryProgress,
} from '../src/control-plane-supervisor-history.ts';
import { WorkflowError } from '../src/errors.ts';

const AT = '2026-08-10T10:00:00.000Z';

test('strict history schemas and self-digests reject substitutions and unknown fields', () => {
  const anchor = initialAnchor();
  const verified = verifyControlPlaneSupervisorHistory([anchor]);
  assert.equal(verified.leaf.recordDigest, anchor.recordDigest);
  assert.equal(verified.generation, 1);

  const unknown = resign({ ...anchor, unexpected: true });
  assert.throws(
    () => verifyControlPlaneSupervisorHistory([unknown]),
    hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_RECORD_INVALID'),
  );

  assert.throws(
    () =>
      verifyControlPlaneSupervisorHistory([
        { ...anchor, recordDigest: digest('substituted') },
      ]),
    hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_RECORD_INVALID'),
  );
});

test('successive finalized promotions form a contiguous terminal chain', () => {
  const anchor = initialAnchor();
  const selected2 = candidateTransition(anchor, 2, 'candidate-2');
  const terminal2 = createControlPlaneSupervisorHistoryTerminal({
    previous: selected2,
    terminalState: 'FINALIZED',
    updateRecordDigest: digest('update-2'),
    transactionJournalDigest: digest('journal-final-2'),
    recordedAt: '2026-08-10T10:00:02.000Z',
  });
  const selected3 = candidateTransition(terminal2, 3, 'candidate-3');
  const terminal3 = createControlPlaneSupervisorHistoryTerminal({
    previous: selected3,
    terminalState: 'FINALIZED',
    updateRecordDigest: digest('update-3'),
    transactionJournalDigest: digest('journal-final-3'),
    recordedAt: '2026-08-10T10:00:04.000Z',
  });

  const history = verifyControlPlaneSupervisorHistory([
    terminal3,
    selected2,
    anchor,
    selected3,
    terminal2,
  ]);
  assert.equal(history.records.length, 5);
  assert.equal(history.leaf.recordDigest, terminal3.recordDigest);
  assert.equal(history.generation, 3);
  assert.equal(history.activeTrustCommit, terminal3.activeTrustCommit);
});

test('rollback is exactly N to N+1 candidate then N+2 restored terminal', () => {
  const anchor = initialAnchor();
  const selected = candidateTransition(anchor, 2, 'bad-candidate');
  const restored = createControlPlaneSupervisorHistoryTransition({
    previous: selected,
    phase: 'rollback-restored',
    toSupervisorRecordDigest: digest('supervisor-3'),
    activeArtifact: anchor.activeArtifact,
    activeTrustCommit: anchor.activeTrustCommit,
    grantId: selected.grantId,
    txId: selected.txId,
    grantEnvelopeDigest: selected.grantEnvelopeDigest,
    promotionBundleDigest: selected.promotionBundleDigest,
    promotionLineageDigest: selected.promotionLineageDigest,
    sourceTransactionState: 'ROLLBACK_REQUIRED',
    sourceJournalDigest: digest('journal-rollback-required'),
    recordedAt: '2026-08-10T10:00:02.000Z',
  });
  const terminal = createControlPlaneSupervisorHistoryTerminal({
    previous: restored,
    terminalState: 'ROLLED_BACK',
    updateRecordDigest: digest('update-rolled-back'),
    transactionJournalDigest: digest('journal-rolled-back'),
    recordedAt: '2026-08-10T10:00:03.000Z',
  });

  const history = verifyControlPlaneSupervisorHistory([
    anchor,
    selected,
    restored,
    terminal,
  ]);
  assert.equal(selected.fromGeneration, 1);
  assert.equal(selected.toGeneration, 2);
  assert.equal(restored.fromGeneration, 2);
  assert.equal(restored.toGeneration, 3);
  assert.equal(history.generation, 3);
  assert.deepEqual(restored.activeArtifact, anchor.activeArtifact);
});

test('history rejects gaps, forks, invalid rollback ancestry, and transition leaves', () => {
  const anchor = initialAnchor();
  const selected = candidateTransition(anchor, 2, 'candidate-a');
  const fork = candidateTransition(anchor, 2, 'candidate-b');

  assert.throws(
    () => verifyControlPlaneSupervisorHistoryProgress([anchor, selected, fork]),
    hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_FORK'),
  );

  const gap = resign({ ...selected, sequence: 2 });
  assert.throws(
    () => verifyControlPlaneSupervisorHistoryProgress([anchor, gap]),
    hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_GAP'),
  );

  assert.throws(
    () => verifyControlPlaneSupervisorHistory([anchor, selected]),
    hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL'),
  );

  const badRollback = resign({
    ...selected,
    phase: 'rollback-restored',
    sourceTransactionState: 'ROLLBACK_REQUIRED',
  });
  assert.throws(
    () => verifyControlPlaneSupervisorHistoryProgress([anchor, badRollback]),
    hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_TRANSITION_INVALID'),
  );
});

function initialAnchor() {
  return createControlPlaneSupervisorHistoryAnchor({
    repositoryId: 'expense-app-fixture',
    generation: 1,
    supervisorRecordDigest: digest('supervisor-1'),
    activeArtifact: {
      artifactId: digest('artifact-1'),
      executableDigest: digest('executable-1'),
      closureDigest: digest('closure-1'),
    },
    activeTrustCommit: commit('initial-trust'),
    authority: {
      kind: 'initial-bootstrap-anchor.v1',
      initialBootstrapPublishedDigest: digest('initial-published'),
    },
    recordedAt: AT,
  });
}

function candidateTransition(
  previous: Parameters<
    typeof createControlPlaneSupervisorHistoryTransition
  >[0]['previous'],
  generation: number,
  label: string,
) {
  return createControlPlaneSupervisorHistoryTransition({
    previous,
    phase: 'candidate-selected',
    toSupervisorRecordDigest: digest(`supervisor-${generation}-${label}`),
    activeArtifact: {
      artifactId: digest(`artifact-${label}`),
      executableDigest: digest(`executable-${label}`),
      closureDigest: digest(`closure-${label}`),
    },
    activeTrustCommit: commit(label),
    grantId: `grant-${label}`,
    txId: `tx-${label}`,
    grantEnvelopeDigest: digest(`grant-envelope-${label}`),
    promotionBundleDigest: digest(`bundle-${label}`),
    promotionLineageDigest: digest(`lineage-${label}`),
    sourceTransactionState: 'RECOVERY_VERIFIED',
    sourceJournalDigest: digest(`journal-recovery-${label}`),
    recordedAt: new Date(
      Date.parse(AT) + (generation - 1) * 2_000 - 1_000,
    ).toISOString(),
  });
}

function resign<T extends Record<string, unknown>>(
  record: T,
): T & { recordDigest: `sha256:${string}` } {
  const { recordDigest: _recordDigest, ...payload } = record;
  return {
    ...record,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  };
}

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function commit(label: string): string {
  return crypto.createHash('sha256').update(`commit:${label}`).digest('hex');
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}
