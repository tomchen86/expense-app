import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  capturePersistedWipIntervention,
  executePersistedAdoptionStep,
  initializeLocalEngineBinding,
  localEngineArtifactPath,
  materializeInterventionChildWorktree,
} from '../src/intervention-control-bootstrap.ts';
import { createEngineArtifact } from '../src/intervention-control.ts';
import {
  advanceBootstrapSidecarPromotionPin,
  preparePersistedEngineAdoption,
  readPersistedBootstrapSidecarSession,
  readPersistedIntervention,
  recoverPersistedEngineAdoption,
  recordBootstrapSidecarPromotionIfPresent,
  reserveBootstrapSidecarPromotion,
} from '../src/intervention-control-persistence.ts';
import {
  persistInterventionEngineArtifact,
  readInterventionEngineArtifact,
} from '../src/intervention-maintenance.ts';

const NOW = new Date('2026-08-10T01:00:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repository: string, args: string[]): string {
  return childProcess.execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function crash(label: string): () => never {
  return () => {
    throw new Error(`simulated crash: ${label}`);
  };
}

function humanDependencies(
  now: Date,
  testHooks: Record<string, () => void> = {},
) {
  return {
    now: () => now,
    verifyHumanSignature(
      _payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      assert.equal(signature, 'sidecar-human-signature');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return true;
    },
    testHooks,
  };
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-sidecar-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = path.join(root, 'parent');
  const child = path.join(root, 'child');
  const stateRoot = path.join(root, 'state');
  const bindingPath = path.join(stateRoot, 'engine-binding.json');
  const sessionSnapshotPath = path.join(stateRoot, 'parent-session.json');
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  git(repository, ['init', '-b', 'work/parent-A']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create sidecar fixture']);
  fs.writeFileSync(sessionSnapshotPath, '{"step":"repair-required"}\n', {
    mode: 0o600,
  });

  const engineFromDigest = digest('sidecar-engine-E1');
  const captureInput = {
    repositoryRoot: repository,
    parent: {
      changeId: 'parent-A',
      status: 'active' as const,
      engineBinding: engineFromDigest,
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    childWorkspacePath: child,
    changeRef: 'refs/heads/work/intervention-B',
    untrackedAllowlist: [] as string[],
    sessionSnapshotPath,
    pendingIntent: 'Resume A only after B adopts a healthy engine.',
    policyDigest: digest('sidecar-policy'),
    now: NOW,
  };
  const maintenanceGrantEnvelope = {
    payload: {
      kind: 'harness-maintenance-grant.v1' as const,
      grantId: 'sidecar-maintenance-grant',
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      scope: {
        paths: ['packages/harness-runtime/**', 'packages/workflow-engine/**'],
        operations: [
          'adopt-engine-into-parent' as const,
          'build-engine-artifact' as const,
          'create-isolated-workspace' as const,
          'modify-engine' as const,
          'run-engine-tests' as const,
        ],
      },
      waivers: [
        'active-change-exclusivity' as const,
        'clean-worktree-required' as const,
        'engine-path-protection' as const,
      ],
      engineFromDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-10T00:55:00.000Z',
      expiresAt: '2026-08-10T02:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Create and exercise the durable sidecar repair lifecycle.',
    },
    signature: 'sidecar-human-signature',
  };
  return {
    root,
    repository,
    child,
    stateRoot,
    bindingPath,
    engineFromDigest,
    captureInput,
    maintenanceGrantEnvelope,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function engineExecutableSource(): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
process.exit(2);
`;
}

test('SidecarSession V1 durably repairs every post-authority crash window', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        capturePersistedWipIntervention(value.stateRoot, {
          ...value.captureInput,
          testAfterInterventionPersistedBeforeSidecar: crash('sidecar create'),
        }),
      /simulated crash: sidecar create/,
    );
    assert.equal(
      readPersistedIntervention(value.stateRoot, 'parent-A').parent.blocker
        ?.blockedBy,
      'intervention-B',
    );
    assert.throws(
      () => readPersistedBootstrapSidecarSession(value.stateRoot, 'parent-A'),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND',
    );

    const captured = capturePersistedWipIntervention(
      value.stateRoot,
      value.captureInput,
    );
    const planned = readPersistedBootstrapSidecarSession(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(planned.kind, 'bootstrap-sidecar-session.v1');
    assert.equal(planned.state, 'repair-active');
    assert.deepEqual(planned.identity, {
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      checkpointId: captured.intervention.checkpoint.checkpointId,
      workspaceId: captured.intervention.childWorkspace.workspaceId,
    });
    assert.deepEqual(planned.parentUnblock, {
      kind: 'sidecar-unblocks-parent.v1',
      parentChangeId: 'parent-A',
      state: 'blocking',
      resolution: null,
      resolvedByTxId: null,
      resolvedAt: null,
    });
    assert.equal(planned.workspace.state, 'planned');
    assert.deepEqual(planned.artifacts, []);
    assert.equal(planned.adoption, null);
    assert.equal(planned.promotion, null);
    assert.deepEqual(
      planned.history.map((entry) => entry.eventKind),
      ['sidecar-created'],
    );

    const materializationInput = {
      parentChangeId: 'parent-A',
      repositoryRoot: value.repository,
      maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
    };
    assert.throws(
      () =>
        materializeInterventionChildWorktree(
          value.stateRoot,
          materializationInput,
          humanDependencies(new Date('2026-08-10T01:01:00.000Z'), {
            afterWorktreeReceiptPersistedBeforeSidecar: crash(
              'workspace projection',
            ),
          }),
        ),
      /simulated crash: workspace projection/,
    );
    assert.equal(
      readPersistedBootstrapSidecarSession(value.stateRoot, 'parent-A')
        .workspace.state,
      'planned',
    );
    const materialized = materializeInterventionChildWorktree(
      value.stateRoot,
      materializationInput,
      humanDependencies(new Date('2026-08-10T01:01:00.000Z')),
    );
    assert.equal(materialized.effectsPerformed, true);
    assert.equal(
      readPersistedBootstrapSidecarSession(value.stateRoot, 'parent-A')
        .workspace.receiptDigest,
      materialized.receiptDigest,
    );

    const executablePath = path.join(value.child, 'engine-probe.mjs');
    const source = engineExecutableSource();
    fs.writeFileSync(executablePath, source, { mode: 0o755 });
    fs.chmodSync(executablePath, 0o755);
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('sidecar-engine-source-E2'),
      executableDigest: digest(source),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('sidecar-engine-smoke-E2'),
    });
    const artifactInput = {
      parentChangeId: 'parent-A',
      artifact,
      executablePath,
      now: new Date('2026-08-10T01:02:00.000Z'),
    };
    assert.throws(
      () =>
        persistInterventionEngineArtifact(value.stateRoot, {
          ...artifactInput,
          testAfterArtifactPersistedBeforeSidecar: crash('artifact projection'),
        }),
      /simulated crash: artifact projection/,
    );
    assert.equal(
      readInterventionEngineArtifact(value.stateRoot, artifact.artifactId)
        .artifact.artifactId,
      artifact.artifactId,
    );
    assert.equal(
      readPersistedBootstrapSidecarSession(value.stateRoot, 'parent-A')
        .artifacts.length,
      0,
    );
    const artifactRecord = persistInterventionEngineArtifact(value.stateRoot, {
      ...artifactInput,
      now: new Date('2026-08-10T01:02:30.000Z'),
    });
    assert.equal(
      readPersistedBootstrapSidecarSession(
        value.stateRoot,
        'parent-A',
      ).artifacts.at(-1)?.evidenceDigest,
      artifactRecord.recordDigest,
    );

    const prepared = preparePersistedEngineAdoption(
      value.stateRoot,
      {
        txId: 'sidecar-local-adoption',
        parentChangeId: 'parent-A',
        artifact,
        maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
        priorLocalAdoptions: 0,
      },
      humanDependencies(new Date('2026-08-10T01:03:00.000Z')),
    );
    initializeLocalEngineBinding(value.stateRoot, value.bindingPath, {
      parentChangeId: 'parent-A',
      parentWorkspacePath: value.repository,
      parentBranch: 'refs/heads/work/parent-A',
      interventionChangeId: 'intervention-B',
      txId: prepared.journal.txId,
      checkpointId: captured.intervention.checkpoint.checkpointId,
      engineDigest: value.engineFromDigest,
      artifactId: artifact.artifactId,
      executableDigest: artifact.executableDigest,
      executablePath: localEngineArtifactPath(
        value.stateRoot,
        artifact.artifactId,
      ),
      sessionSchema: 'v4',
      now: new Date('2026-08-10T01:03:00.000Z'),
    });

    let journalDigest = prepared.journal.journalDigest;
    for (const at of [
      '2026-08-10T01:04:00.000Z',
      '2026-08-10T01:05:00.000Z',
      '2026-08-10T01:06:00.000Z',
      '2026-08-10T01:07:00.000Z',
    ]) {
      const stepped = executePersistedAdoptionStep(
        value.stateRoot,
        {
          txId: prepared.journal.txId,
          expectedJournalDigest: journalDigest,
          bindingPath: value.bindingPath,
          artifact,
          executablePath,
          at,
        },
        humanDependencies(new Date(at)),
      );
      journalDigest = stepped.record.journal.journalDigest;
    }
    const committedAt = '2026-08-10T01:08:00.000Z';
    assert.throws(
      () =>
        executePersistedAdoptionStep(
          value.stateRoot,
          {
            txId: prepared.journal.txId,
            expectedJournalDigest: journalDigest,
            bindingPath: value.bindingPath,
            artifact,
            executablePath,
            at: committedAt,
          },
          humanDependencies(new Date(committedAt), {
            afterAdoptionReceiptPersistedBeforeSidecar: crash(
              'adoption projection',
            ),
          }),
        ),
      /simulated crash: adoption projection/,
    );
    const committed = recoverPersistedEngineAdoption(
      value.stateRoot,
      prepared.journal.txId,
    );
    assert.equal(committed.record.journal.state, 'COMMITTED');
    assert.equal(
      readPersistedBootstrapSidecarSession(value.stateRoot, 'parent-A')
        .parentUnblock.state,
      'blocking',
    );
    const recovered = executePersistedAdoptionStep(
      value.stateRoot,
      {
        txId: prepared.journal.txId,
        expectedJournalDigest: committed.record.journal.journalDigest,
        bindingPath: value.bindingPath,
        artifact,
        executablePath,
        at: '2026-08-10T01:09:00.000Z',
      },
      humanDependencies(new Date('2026-08-10T01:09:00.000Z')),
    );
    assert.equal(recovered.receipt.action, 'none');
    const adopted = readPersistedBootstrapSidecarSession(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(adopted.adoption?.txId, prepared.journal.txId);
    assert.deepEqual(adopted.parentUnblock, {
      kind: 'sidecar-unblocks-parent.v1',
      parentChangeId: 'parent-A',
      state: 'unblocked',
      resolution: 'local-adoption',
      resolvedByTxId: prepared.journal.txId,
      resolvedAt: committedAt,
    });

    const promotionInput = {
      interventionChangeId: 'intervention-B',
      grantId: 'sidecar-control-plane-grant',
      txId: 'sidecar-global-promotion',
      artifact,
      closureDigest: digest('sidecar-default-closure-E2'),
      evidenceDigest: digest('sidecar-global-promotion-evidence'),
      at: '2026-08-10T01:10:00.000Z',
    };
    reserveBootstrapSidecarPromotion(value.stateRoot, {
      ...promotionInput,
      candidateExecutableProvenanceDigest: artifactRecord.recordDigest,
      at: '2026-08-10T01:09:30.000Z',
    });
    advanceBootstrapSidecarPromotionPin(value.stateRoot, {
      txId: promotionInput.txId,
      expectedState: 'reserved',
      state: 'commit-intent',
      at: '2026-08-10T01:09:45.000Z',
    });
    const promoted = recordBootstrapSidecarPromotionIfPresent(
      value.stateRoot,
      promotionInput,
    );
    assert.notEqual(promoted, null);
    const replayedPromotion = recordBootstrapSidecarPromotionIfPresent(
      value.stateRoot,
      promotionInput,
    );
    assert.deepEqual(replayedPromotion, promoted);

    const terminal = readPersistedBootstrapSidecarSession(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(terminal.promotion?.grantId, 'sidecar-control-plane-grant');
    assert.deepEqual(
      terminal.history.map((entry) => entry.eventKind),
      [
        'sidecar-created',
        'workspace-materialized',
        'artifact-ready',
        'adopted-by-parent',
        'repository-default-promoted',
      ],
    );
  } finally {
    value.cleanup();
  }
});
