import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendControlPlaneSupervisorHistoryRecord,
  controlPlaneSupervisorHistoryDirectory,
  controlPlaneSupervisorHistoryPendingPath,
  controlPlaneSupervisorHistoryRecordPath,
  createControlPlaneSupervisorHistoryAnchor,
  createControlPlaneSupervisorHistoryTerminal,
  createControlPlaneSupervisorHistoryTransition,
  readControlPlaneSupervisorHistory,
  readControlPlaneSupervisorHistoryProgress,
} from '../src/runtime/storage-journal/control-plane-supervisor-history.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

test('append publishes private records and reads only a terminal leaf', () => {
  const fixture = stateRoot();
  try {
    const anchor = initialAnchor();
    const appended = appendControlPlaneSupervisorHistoryRecord(
      fixture.root,
      anchor,
    );
    assert.equal(appended.replayed, false);
    assert.equal(readControlPlaneSupervisorHistory(fixture.root).generation, 1);
    assert.equal(
      fs.statSync(controlPlaneSupervisorHistoryDirectory(fixture.root)).mode &
        0o777,
      0o700,
    );
    assert.equal(
      fs.statSync(
        controlPlaneSupervisorHistoryRecordPath(
          fixture.root,
          anchor.recordDigest,
        ),
      ).mode & 0o777,
      0o600,
    );

    const selected = candidateTransition(anchor);
    appendControlPlaneSupervisorHistoryRecord(fixture.root, selected);
    assert.equal(
      readControlPlaneSupervisorHistoryProgress(fixture.root).leaf.kind,
      'control-plane-supervisor-history-transition.v1',
    );
    assert.throws(
      () => readControlPlaneSupervisorHistory(fixture.root),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL'),
    );

    const terminal = createControlPlaneSupervisorHistoryTerminal({
      previous: selected,
      terminalState: 'FINALIZED',
      updateRecordDigest: digest('update-final'),
      transactionJournalDigest: digest('journal-final'),
      recordedAt: '2026-08-10T10:00:02.000Z',
    });
    appendControlPlaneSupervisorHistoryRecord(fixture.root, terminal);
    assert.equal(
      readControlPlaneSupervisorHistory(fixture.root).leaf.recordDigest,
      terminal.recordDigest,
    );
  } finally {
    fixture.cleanup();
  }
});

test('prepared and hard-linked crash phases reconcile without duplicating history', () => {
  for (const phase of ['PREPARED', 'HARD_LINKED'] as const) {
    const fixture = stateRoot();
    try {
      const anchor = initialAnchor();
      assert.throws(
        () =>
          appendControlPlaneSupervisorHistoryRecord(fixture.root, anchor, {
            testAfterDurablePhase(observed) {
              if (observed === phase) throw new Error(`crash:${phase}`);
            },
          }),
        new RegExp(`crash:${phase}`),
      );

      const pendingPath = controlPlaneSupervisorHistoryPendingPath(
        fixture.root,
        anchor.recordDigest,
      );
      assert.equal(fs.existsSync(pendingPath), true);
      if (phase === 'HARD_LINKED') {
        assert.equal(
          fs.statSync(
            controlPlaneSupervisorHistoryRecordPath(
              fixture.root,
              anchor.recordDigest,
            ),
          ).nlink,
          2,
        );
      }

      const replayed = appendControlPlaneSupervisorHistoryRecord(
        fixture.root,
        anchor,
      );
      assert.equal(replayed.replayed, true);
      assert.equal(fs.existsSync(pendingPath), false);
      const target = controlPlaneSupervisorHistoryRecordPath(
        fixture.root,
        anchor.recordDigest,
      );
      assert.equal(fs.statSync(target).nlink, 1);
      assert.equal(
        readControlPlaneSupervisorHistory(fixture.root).records.length,
        1,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('history storage rejects wrong modes, symlinks, foreign hardlinks, and residue', () => {
  const wrongMode = stateRoot();
  try {
    fs.mkdirSync(controlPlaneSupervisorHistoryDirectory(wrongMode.root), {
      mode: 0o755,
    });
    fs.chmodSync(controlPlaneSupervisorHistoryDirectory(wrongMode.root), 0o755);
    assert.throws(
      () =>
        appendControlPlaneSupervisorHistoryRecord(
          wrongMode.root,
          initialAnchor(),
        ),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_STORAGE_UNSAFE'),
    );
  } finally {
    wrongMode.cleanup();
  }

  const symlink = stateRoot();
  try {
    const real = path.join(symlink.root, 'real-history');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, controlPlaneSupervisorHistoryDirectory(symlink.root));
    assert.throws(
      () =>
        appendControlPlaneSupervisorHistoryRecord(
          symlink.root,
          initialAnchor(),
        ),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_STORAGE_UNSAFE'),
    );
  } finally {
    symlink.cleanup();
  }

  const recordMode = stateRoot();
  try {
    const anchor = initialAnchor();
    appendControlPlaneSupervisorHistoryRecord(recordMode.root, anchor);
    fs.chmodSync(
      controlPlaneSupervisorHistoryRecordPath(
        recordMode.root,
        anchor.recordDigest,
      ),
      0o644,
    );
    assert.throws(
      () => readControlPlaneSupervisorHistory(recordMode.root),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_STORAGE_UNSAFE'),
    );
  } finally {
    recordMode.cleanup();
  }

  const recordSymlink = stateRoot();
  try {
    const anchor = initialAnchor();
    const directory = controlPlaneSupervisorHistoryDirectory(
      recordSymlink.root,
    );
    fs.mkdirSync(directory, { mode: 0o700 });
    const foreign = path.join(recordSymlink.root, 'foreign-record');
    fs.writeFileSync(foreign, 'foreign', { mode: 0o600 });
    fs.symlinkSync(
      foreign,
      controlPlaneSupervisorHistoryRecordPath(
        recordSymlink.root,
        anchor.recordDigest,
      ),
    );
    assert.throws(
      () => readControlPlaneSupervisorHistory(recordSymlink.root),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_UNKNOWN_RESIDUE'),
    );
  } finally {
    recordSymlink.cleanup();
  }

  const hardlink = stateRoot();
  try {
    const anchor = initialAnchor();
    appendControlPlaneSupervisorHistoryRecord(hardlink.root, anchor);
    fs.linkSync(
      controlPlaneSupervisorHistoryRecordPath(
        hardlink.root,
        anchor.recordDigest,
      ),
      path.join(hardlink.root, 'foreign-link'),
    );
    assert.throws(
      () => readControlPlaneSupervisorHistory(hardlink.root),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_STORAGE_UNSAFE'),
    );
  } finally {
    hardlink.cleanup();
  }

  const residue = stateRoot();
  try {
    appendControlPlaneSupervisorHistoryRecord(residue.root, initialAnchor());
    fs.writeFileSync(
      path.join(controlPlaneSupervisorHistoryDirectory(residue.root), 'junk'),
      'junk',
      { mode: 0o600 },
    );
    assert.throws(
      () => readControlPlaneSupervisorHistory(residue.root),
      hasCode('CONTROL_PLANE_SUPERVISOR_HISTORY_UNKNOWN_RESIDUE'),
    );
  } finally {
    residue.cleanup();
  }
});

function stateRoot(): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'control-plane-history-'),
  );
  fs.chmodSync(root, 0o700);
  return {
    root: fs.realpathSync(root),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

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
    recordedAt: '2026-08-10T10:00:00.000Z',
  });
}

function candidateTransition(previous: ReturnType<typeof initialAnchor>) {
  return createControlPlaneSupervisorHistoryTransition({
    previous,
    phase: 'candidate-selected',
    toSupervisorRecordDigest: digest('supervisor-2'),
    activeArtifact: {
      artifactId: digest('artifact-2'),
      executableDigest: digest('executable-2'),
      closureDigest: digest('closure-2'),
    },
    activeTrustCommit: commit('candidate-2'),
    grantId: 'grant-candidate-2',
    txId: 'tx-candidate-2',
    grantEnvelopeDigest: digest('grant-envelope-2'),
    promotionBundleDigest: digest('bundle-2'),
    promotionLineageDigest: digest('lineage-2'),
    sourceTransactionState: 'RECOVERY_VERIFIED',
    sourceJournalDigest: digest('journal-recovery-2'),
    recordedAt: '2026-08-10T10:00:01.000Z',
  });
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
