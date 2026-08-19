import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REQUIRED_PROTECTED_CAPABILITIES,
  controlPlaneCandidateDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  type ControlPlaneGrantEnvelope,
  type ExactControlPlaneChange,
  type HarnessMaintenanceGrantEnvelope,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import {
  advancePersistedControlPlaneUpdate,
  advancePersistedEngineAdoption,
  controlPlaneUpdateRecordPath,
  interventionControlPersistencePaths,
  interventionRecordPath,
  persistInterventionPlan,
  preparePersistedControlPlaneUpdate,
  preparePersistedEngineAdoption,
  readPersistedIntervention,
  recoverPersistedControlPlaneUpdate,
  recoverPersistedEngineAdoption,
  rollbackPersistedEngineAdoption,
} from '../src/intervention-control-persistence.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function temporaryFixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-control-persistence-')),
  );
  fs.chmodSync(root, 0o700);
  const parentWorkspacePath = path.join(root, 'parent-worktree');
  const childWorkspacePath = path.join(root, 'intervention-worktree');
  fs.mkdirSync(parentWorkspacePath, { mode: 0o700 });
  return {
    root,
    storeRoot: path.join(root, 'state'),
    parentWorkspacePath,
    childWorkspacePath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function interventionInput(fixture: ReturnType<typeof temporaryFixture>) {
  return {
    parent: {
      changeId: 'parent-A',
      status: 'active' as const,
      engineBinding: digest('engine-E1'),
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    checkpoint: {
      parentChangeId: 'parent-A',
      baseOid: 'a'.repeat(40),
      worktreeFingerprint: digest('worktree'),
      trackedTreeDigest: digest('tracked'),
      untrackedBundleDigest: digest('untracked'),
      sessionStateDigest: digest('session'),
      pendingIntentDigest: digest('pending-intent'),
      engineDigest: digest('engine-E1'),
      policyDigest: digest('policy'),
      createdAt: NOW.toISOString(),
    },
    childWorkspace: {
      parentWorkspacePath: fixture.parentWorkspacePath,
      childWorkspacePath: fixture.childWorkspacePath,
      changeRef: 'refs/heads/work/intervention-B',
    },
    now: NOW,
  };
}

test('checkpoint and child worktree plan persist atomically without creating the worktree', () => {
  const fixture = temporaryFixture();
  try {
    const record = persistInterventionPlan(
      fixture.storeRoot,
      interventionInput(fixture),
    );
    assert.equal(record.kind, 'persisted-harness-intervention.v1');
    assert.equal(record.parent.status, 'active');
    assert.equal(record.childWorkspace.state, 'planned');
    assert.equal(record.childWorkspace.effectsPerformed, false);
    assert.equal(
      record.childWorkspace.childWorkspacePath,
      fixture.childWorkspacePath,
    );
    assert.equal(fs.existsSync(fixture.childWorkspacePath), false);

    const paths = interventionControlPersistencePaths(fixture.storeRoot);
    assert.equal(fs.readdirSync(paths.checkpoints).length, 1);
    assert.equal(
      fs.statSync(interventionRecordPath(fixture.storeRoot, 'parent-A')).mode &
        0o777,
      0o600,
    );
    assert.deepEqual(
      readPersistedIntervention(fixture.storeRoot, 'parent-A'),
      record,
    );
    assert.deepEqual(
      persistInterventionPlan(fixture.storeRoot, interventionInput(fixture)),
      record,
    );

    assert.throws(
      () =>
        persistInterventionPlan(fixture.storeRoot, {
          ...interventionInput(fixture),
          interventionChangeId: 'intervention-C',
          childWorkspace: {
            ...interventionInput(fixture).childWorkspace,
            childWorkspacePath: path.join(fixture.root, 'other-child'),
            changeRef: 'refs/heads/work/intervention-C',
          },
        }),
      hasCode('INTERVENTION_PERSISTENCE_ACTIVE_CONFLICT'),
    );

    const otherParentWorkspace = path.join(fixture.root, 'other-parent');
    fs.mkdirSync(otherParentWorkspace, { mode: 0o700 });
    const other = interventionInput(fixture);
    assert.throws(
      () =>
        persistInterventionPlan(fixture.storeRoot, {
          ...other,
          parent: { ...other.parent, changeId: 'parent-D' },
          interventionChangeId: 'intervention-D',
          checkpoint: {
            ...other.checkpoint,
            parentChangeId: 'parent-D',
          },
          childWorkspace: {
            parentWorkspacePath: otherParentWorkspace,
            childWorkspacePath: fixture.childWorkspacePath,
            changeRef: 'refs/heads/work/intervention-D',
          },
        }),
      hasCode('INTERVENTION_CHILD_WORKSPACE_RESERVATION_CONFLICT'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('persisted intervention corruption and overlapping workspace paths fail closed', () => {
  const fixture = temporaryFixture();
  try {
    assert.throws(
      () =>
        persistInterventionPlan(fixture.storeRoot, {
          ...interventionInput(fixture),
          childWorkspace: {
            ...interventionInput(fixture).childWorkspace,
            childWorkspacePath: path.join(
              fixture.parentWorkspacePath,
              'nested-child',
            ),
          },
        }),
      hasCode('INTERVENTION_CHILD_WORKSPACE_NOT_ISOLATED'),
    );

    persistInterventionPlan(fixture.storeRoot, interventionInput(fixture));
    const recordPath = interventionRecordPath(fixture.storeRoot, 'parent-A');
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      recordDigest: string;
      relationship: { interventionChangeId: string };
    };
    parsed.relationship.interventionChangeId = 'tampered-intervention';
    fs.writeFileSync(recordPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => readPersistedIntervention(fixture.storeRoot, 'parent-A'),
      hasCode('INTERVENTION_PERSISTENCE_RECORD_CORRUPT'),
    );
  } finally {
    fixture.cleanup();
  }
});

function maintenanceEnvelope(
  engineFromDigest: `sha256:${string}`,
): HarnessMaintenanceGrantEnvelope {
  return {
    payload: {
      kind: 'harness-maintenance-grant.v1',
      grantId: 'maintenance-persist-1',
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      scope: {
        paths: ['packages/harness-runtime/**', 'packages/workflow-engine/**'],
        operations: [
          'adopt-engine-into-parent',
          'build-engine-artifact',
          'create-isolated-workspace',
          'modify-engine',
          'run-engine-tests',
        ],
      },
      waivers: [
        'active-change-exclusivity',
        'clean-worktree-required',
        'engine-path-protection',
      ],
      engineFromDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Repair the blocked engine through a recoverable intervention.',
    },
    signature: 'maintenance-human-signature',
  };
}

test('adoption journal persists CAS transitions and crash recovery through rollback', () => {
  const fixture = temporaryFixture();
  try {
    const intervention = persistInterventionPlan(
      fixture.storeRoot,
      interventionInput(fixture),
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('source-E2'),
      executableDigest: digest('engine-E2'),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('smoke-E2'),
    });
    const prepared = preparePersistedEngineAdoption(
      fixture.storeRoot,
      {
        txId: 'adoption-persist-1',
        parentChangeId: 'parent-A',
        artifact,
        maintenanceGrantEnvelope: maintenanceEnvelope(
          intervention.parent.engineBinding,
        ),
        priorLocalAdoptions: 0,
      },
      {
        now: () => NOW,
        verifyHumanSignature(_payload, signature, _signer, namespace) {
          assert.equal(signature, 'maintenance-human-signature');
          assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
          return true;
        },
      },
    );
    assert.equal(prepared.journal.state, 'PREPARED');
    assert.equal(prepared.observations.length, 0);
    assert.throws(
      () =>
        preparePersistedEngineAdoption(
          fixture.storeRoot,
          {
            txId: 'adoption-persist-replay',
            parentChangeId: 'parent-A',
            artifact,
            maintenanceGrantEnvelope: maintenanceEnvelope(
              intervention.parent.engineBinding,
            ),
            priorLocalAdoptions: 0,
          },
          {
            now: () => NOW,
            verifyHumanSignature: () => true,
          },
        ),
      hasCode('INTERVENTION_ADOPTION_ALREADY_ACTIVE'),
    );

    const checkpointed = advancePersistedEngineAdoption(fixture.storeRoot, {
      txId: prepared.journal.txId,
      expectedJournalDigest: prepared.journal.journalDigest,
      event: {
        kind: 'parent-checkpointed',
        at: '2026-08-03T10:01:00.000Z',
      },
      evidenceDigest: digest('checkpoint-observation'),
    });
    assert.throws(
      () =>
        advancePersistedEngineAdoption(fixture.storeRoot, {
          txId: prepared.journal.txId,
          expectedJournalDigest: prepared.journal.journalDigest,
          event: {
            kind: 'engine-binding-updated',
            at: '2026-08-03T10:02:00.000Z',
          },
          evidenceDigest: digest('stale-binding-observation'),
        }),
      hasCode('INTERVENTION_ADOPTION_CAS_MISMATCH'),
    );
    let current = advancePersistedEngineAdoption(fixture.storeRoot, {
      txId: prepared.journal.txId,
      expectedJournalDigest: checkpointed.journal.journalDigest,
      event: {
        kind: 'engine-binding-updated',
        at: '2026-08-03T10:02:00.000Z',
      },
      evidenceDigest: digest('binding-observation'),
    });
    assert.deepEqual(
      recoverPersistedEngineAdoption(fixture.storeRoot, prepared.journal.txId)
        .decision,
      {
        action: 'start-new-engine',
        authoritativeEngineDigest: artifact.executableDigest,
        blockerCleared: false,
      },
    );

    for (const [event, evidenceDigest] of [
      [
        {
          kind: 'new-engine-started',
          at: '2026-08-03T10:03:00.000Z',
        },
        digest('engine-start-observation'),
      ],
      [
        {
          kind: 'health-check-failed',
          at: '2026-08-03T10:04:00.000Z',
        },
        digest('health-failure-observation'),
      ],
    ] as const) {
      current = advancePersistedEngineAdoption(fixture.storeRoot, {
        txId: current.journal.txId,
        expectedJournalDigest: current.journal.journalDigest,
        event,
        evidenceDigest,
      });
    }
    assert.equal(
      recoverPersistedEngineAdoption(fixture.storeRoot, current.journal.txId)
        .decision.action,
      'rollback-engine-binding',
    );
    const rolledBack = rollbackPersistedEngineAdoption(fixture.storeRoot, {
      txId: current.journal.txId,
      expectedJournalDigest: current.journal.journalDigest,
      at: '2026-08-03T10:05:00.000Z',
      evidenceDigest: digest('rollback-observation'),
    });
    assert.equal(rolledBack.journal.state, 'ENGINE_BINDING_ROLLED_BACK');
    assert.equal(rolledBack.observations.length, 5);
    assert.equal(
      recoverPersistedEngineAdoption(fixture.storeRoot, rolledBack.journal.txId)
        .decision.authoritativeEngineDigest,
      intervention.parent.engineBinding,
    );
  } finally {
    fixture.cleanup();
  }
});

test('persisted adoption cannot start without an injected human verifier', () => {
  const fixture = temporaryFixture();
  try {
    const intervention = persistInterventionPlan(
      fixture.storeRoot,
      interventionInput(fixture),
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('source-no-verifier'),
      executableDigest: digest('engine-no-verifier'),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('smoke-no-verifier'),
    });
    assert.throws(
      () =>
        preparePersistedEngineAdoption(
          fixture.storeRoot,
          {
            txId: 'adoption-no-verifier',
            parentChangeId: 'parent-A',
            artifact,
            maintenanceGrantEnvelope: maintenanceEnvelope(
              intervention.parent.engineBinding,
            ),
            priorLocalAdoptions: 0,
          },
          { now: () => NOW },
        ),
      hasCode('INTERVENTION_PERSISTENCE_HUMAN_VERIFIER_REQUIRED'),
    );
  } finally {
    fixture.cleanup();
  }
});

function protectedEntries(): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints = [`packages/bootstrap/${capability}.ts`];
    const dependencies = [`packages/bootstrap/shared/${capability}.ts`];
    const contentDigest = digest(`content:${capability}`);
    return {
      capability,
      entrypoints,
      dependencies,
      contentDigest,
      closureDigest: protectedCapabilityClosureDigest(
        entrypoints,
        dependencies,
        contentDigest,
      ),
    };
  });
}

function controlPlaneFixture() {
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const entries = protectedEntries();
  const changedContent = digest('changed-control-content');
  entries[0] = {
    ...entries[0],
    contentDigest: changedContent,
    closureDigest: protectedCapabilityClosureDigest(
      entries[0].entrypoints,
      entries[0].dependencies,
      changedContent,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries,
  });
  const changes: ExactControlPlaneChange[] = [
    {
      path: beforeManifest.entries[0].entrypoints[0],
      beforeDigest: beforeManifest.entries[0].contentDigest,
      afterDigest: changedContent,
    },
    {
      path: beforeManifest.manifestPath,
      beforeDigest: beforeManifest.manifestDigest,
      afterDigest: afterManifest.manifestDigest,
    },
  ];
  const envelope: ControlPlaneGrantEnvelope = {
    payload: {
      kind: 'control-plane-grant.v1',
      grantId: 'control-persist-1',
      mandateBinding: {
        schemaVersion: 1,
        parentTaskId: 'control-plane-task',
        mandateId: '44444444-4444-4444-8444-444444444444',
        mandateDigest: '4'.repeat(64),
        changeId: 'control-plane-change',
        externalAuditRoot: '/external/audit/control-plane',
      },
      repositoryId: 'github:example/expense-app',
      candidateDigest: controlPlaneCandidateDigest(changes),
      exactChanges: changes,
      beforeClosureDigest: beforeManifest.manifestDigest,
      afterClosureDigest: afterManifest.manifestDigest,
      affectedCapabilities: [beforeManifest.entries[0].capability],
      behaviorChangeSummary: 'Update the protected engine closure.',
      recoveryBundle: {
        bundleDigest: digest('recovery-bundle'),
        previousClosureDigest: beforeManifest.manifestDigest,
        restartArtifactDigest: digest('restart-old-closure'),
        rollbackTestReportDigest: digest('rollback-test'),
      },
      independentReviewAttestationDigest: digest('independent-review'),
      updaterVersion: 1,
      oneShot: true,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'control-human-signature',
  };
  return { beforeManifest, afterManifest, changes, envelope };
}

test('minimal updater transaction persists reservation, recovery, rollback, and one-shot consume', () => {
  const fixture = temporaryFixture();
  try {
    const control = controlPlaneFixture();
    let record = preparePersistedControlPlaneUpdate(
      fixture.storeRoot,
      {
        txId: 'control-update-persist-1',
        envelope: control.envelope,
        beforeManifest: control.beforeManifest,
        afterManifest: control.afterManifest,
        changes: control.changes,
      },
      {
        now: () => NOW,
        consumedGrantIds: new Set(),
        verifyHumanSignature(_payload, signature, _signer, namespace) {
          assert.equal(signature, 'control-human-signature');
          assert.equal(namespace, 'expense-app.control-plane-grant.v1');
          return true;
        },
      },
    );
    assert.equal(record.grantState, 'reserved');
    assert.equal(record.transaction.state, 'PREPARED');
    assert.equal(record.effectsPerformed, false);

    for (const [kind, at, evidence] of [
      [
        'old-closure-verified',
        '2026-08-03T10:01:00.000Z',
        'old-closure-evidence',
      ],
      ['candidate-verified', '2026-08-03T10:02:00.000Z', 'candidate-evidence'],
      [
        'recovery-bundle-verified',
        '2026-08-03T10:03:00.000Z',
        'recovery-evidence',
      ],
      [
        'atomic-switch-completed',
        '2026-08-03T10:04:00.000Z',
        'switch-observation',
      ],
    ] as const) {
      record = advancePersistedControlPlaneUpdate(fixture.storeRoot, {
        grantId: control.envelope.payload.grantId,
        expectedJournalDigest: record.transaction.journalDigest,
        event: { kind, at },
        evidenceDigest: digest(evidence),
      });
    }
    assert.deepEqual(
      recoverPersistedControlPlaneUpdate(
        fixture.storeRoot,
        control.envelope.payload.grantId,
      ).decision,
      {
        action: 'rollback-with-recovery-bundle',
        authoritativeClosureDigest: control.beforeManifest.manifestDigest,
        terminal: false,
      },
    );

    for (const [kind, at, evidence] of [
      ['self-tests-failed', '2026-08-03T10:05:00.000Z', 'self-test-failure'],
      ['rollback-completed', '2026-08-03T10:06:00.000Z', 'rollback-complete'],
    ] as const) {
      record = advancePersistedControlPlaneUpdate(fixture.storeRoot, {
        grantId: control.envelope.payload.grantId,
        expectedJournalDigest: record.transaction.journalDigest,
        event: { kind, at },
        evidenceDigest: digest(evidence),
      });
    }
    assert.equal(record.transaction.state, 'ROLLED_BACK');
    assert.equal(record.grantState, 'consumed');
    assert.equal(record.observations.length, 6);

    assert.throws(
      () =>
        preparePersistedControlPlaneUpdate(
          fixture.storeRoot,
          {
            txId: 'control-update-replay',
            envelope: control.envelope,
            beforeManifest: control.beforeManifest,
            afterManifest: control.afterManifest,
            changes: control.changes,
          },
          {
            now: () => NOW,
            consumedGrantIds: new Set(),
            verifyHumanSignature: () => true,
          },
        ),
      hasCode('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED'),
    );

    const recordPath = controlPlaneUpdateRecordPath(
      fixture.storeRoot,
      control.envelope.payload.grantId,
    );
    assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(fixture.root, 'refs')), false);

    const tampered = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      transaction: { state: string };
    };
    tampered.transaction.state = 'FINALIZED';
    fs.writeFileSync(recordPath, `${JSON.stringify(tampered)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () =>
        recoverPersistedControlPlaneUpdate(
          fixture.storeRoot,
          control.envelope.payload.grantId,
        ),
      hasCode('INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT'),
    );
  } finally {
    fixture.cleanup();
  }
});
