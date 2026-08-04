import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  advanceEngineAdoption,
  advanceMinimalUpdaterTransaction,
  assertLegacyGrantV1SigningAllowed,
  beginHarnessIntervention,
  canonicalControlPlaneGrantPayload,
  canonicalHarnessMaintenanceGrantPayload,
  classifyProtectedCandidateImpact,
  controlPlaneCandidateDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  createWipCheckpoint,
  decideControlPlaneRecovery,
  decideEngineAdoptionRecovery,
  finalizeEngineAdoption,
  prepareEngineAdoption,
  prepareMinimalUpdaterTransaction,
  protectedCapabilityClosureDigest,
  verifyControlPlaneGrant,
  verifyHarnessMaintenanceGrant,
  verifyLegacyGrantV1ReadOnly,
  verifyWipCheckpoint,
  validateWorkflowSupersedeReason,
  type ControlPlaneGrantEnvelope,
  type ExactControlPlaneChange,
  type HarnessMaintenanceGrantEnvelope,
  type ParentChangeState,
  type ProtectedCapabilityEntry,
} from '../src/intervention-control.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function parentState(): ParentChangeState {
  return {
    changeId: 'parent-A',
    status: 'active',
    engineBinding: digest('engine-E1'),
    sessionSchema: 'v4',
    blocker: null,
  };
}

test('content-addressed WIP checkpoint is immutable and intervention keeps the parent active', () => {
  const parent = parentState();
  const checkpoint = createWipCheckpoint({
    parentChangeId: parent.changeId,
    baseOid: 'a'.repeat(40),
    worktreeFingerprint: digest('worktree'),
    trackedTreeDigest: digest('tracked'),
    untrackedBundleDigest: digest('untracked'),
    sessionStateDigest: digest('session'),
    pendingIntentDigest: digest('pending-intent'),
    engineDigest: parent.engineBinding,
    policyDigest: digest('policy'),
    createdAt: NOW.toISOString(),
  });

  assert.equal(checkpoint.checkpointId.startsWith('sha256:'), true);
  assert.equal(Object.isFrozen(checkpoint), true);
  assert.deepEqual(verifyWipCheckpoint(checkpoint), checkpoint);

  const started = beginHarnessIntervention(
    parent,
    'intervention-B',
    checkpoint,
  );
  assert.equal(started.parent.status, 'active');
  assert.deepEqual(started.parent.blocker, {
    kind: 'harness-intervention',
    checkpointId: checkpoint.checkpointId,
    blockedBy: 'intervention-B',
  });
  assert.equal(started.relationship.kind, 'harness-intervention.v1');
  assert.equal(started.relationship.parentChangeId, 'parent-A');
  assert.equal(started.relationship.interventionChangeId, 'intervention-B');
  assert.equal(started.relationship.state, 'active');

  assert.throws(
    () =>
      beginHarnessIntervention(
        { ...parent, status: 'completed' },
        'intervention-C',
        checkpoint,
      ),
    hasCode('INTERVENTION_PARENT_NOT_ACTIVE'),
  );
  assert.throws(
    () =>
      beginHarnessIntervention(started.parent, 'intervention-C', checkpoint),
    hasCode('INTERVENTION_ALREADY_ACTIVE'),
  );

  const tampered = {
    ...checkpoint,
    trackedTreeDigest: digest('different-tracked-tree'),
  };
  assert.throws(
    () => verifyWipCheckpoint(tampered),
    hasCode('INTERVENTION_CHECKPOINT_DIGEST_MISMATCH'),
  );
});

function maintenanceGrant(
  engineFromDigest: `sha256:${string}`,
): HarnessMaintenanceGrantEnvelope {
  return {
    payload: {
      kind: 'harness-maintenance-grant.v1',
      grantId: 'grant-maintenance-1',
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
      reason:
        'Repair the blocked workflow engine through the intervention lane.',
    },
    signature: 'human-signature-bytes',
  };
}

function interventionFixture() {
  const parent = parentState();
  const checkpoint = createWipCheckpoint({
    parentChangeId: parent.changeId,
    baseOid: 'b'.repeat(40),
    worktreeFingerprint: digest('worktree-2'),
    trackedTreeDigest: digest('tracked-2'),
    untrackedBundleDigest: digest('untracked-2'),
    sessionStateDigest: digest('session-2'),
    pendingIntentDigest: digest('pending-intent-2'),
    engineDigest: parent.engineBinding,
    policyDigest: digest('policy-2'),
    createdAt: NOW.toISOString(),
  });
  const started = beginHarnessIntervention(
    parent,
    'intervention-B',
    checkpoint,
  );
  return { checkpoint, ...started };
}

test('maintenance grant is only verified and V1 adoption commits without a schema migration', () => {
  const fixture = interventionFixture();
  const envelope = maintenanceGrant(fixture.parent.engineBinding);
  const verifiedPayloads: string[] = [];
  const verifiedGrant = verifyHarnessMaintenanceGrant(envelope, {
    now: NOW,
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    verifyHumanSignature(payload, signature, signer, namespace) {
      verifiedPayloads.push(payload);
      assert.equal(signature, 'human-signature-bytes');
      assert.equal(signer, 'maintainer@example.test');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return true;
    },
  });
  assert.equal(
    verifiedPayloads[0],
    canonicalHarnessMaintenanceGrantPayload(envelope.payload),
  );

  const artifact = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-B'),
    executableDigest: digest('engine-E2'),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-E2'),
  });
  assert.equal(artifact.artifactId.startsWith('sha256:'), true);

  let journal = prepareEngineAdoption({
    txId: 'adoption-tx-1',
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    artifact,
    maintenanceGrant: verifiedGrant,
    priorLocalAdoptions: 0,
    now: NOW,
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'parent-checkpointed',
    at: '2026-08-03T10:01:00.000Z',
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'engine-binding-updated',
    at: '2026-08-03T10:02:00.000Z',
  });
  assert.deepEqual(decideEngineAdoptionRecovery(journal), {
    action: 'start-new-engine',
    authoritativeEngineDigest: artifact.executableDigest,
    blockerCleared: false,
  });
  assert.throws(
    () =>
      decideEngineAdoptionRecovery({
        ...journal,
        toEngineDigest: digest('tampered-adoption-binding'),
      }),
    hasCode('ENGINE_ADOPTION_JOURNAL_CORRUPT'),
  );
  journal = advanceEngineAdoption(journal, {
    kind: 'new-engine-started',
    at: '2026-08-03T10:03:00.000Z',
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'health-check-passed',
    at: '2026-08-03T10:04:00.000Z',
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'commit',
    at: '2026-08-03T10:05:00.000Z',
  });
  const committed = finalizeEngineAdoption(
    fixture.parent,
    fixture.relationship,
    journal,
  );
  assert.equal(committed.parent.engineBinding, artifact.executableDigest);
  assert.equal(committed.parent.status, 'active');
  assert.equal(committed.parent.blocker, null);
  assert.equal(committed.relationship.state, 'adopted');
  assert.deepEqual(decideEngineAdoptionRecovery(journal), {
    action: 'none',
    authoritativeEngineDigest: artifact.executableDigest,
    blockerCleared: true,
  });
});

test('adoption rejects a V1 schema change and health failure rolls back with blocker intact', () => {
  const fixture = interventionFixture();
  const envelope = maintenanceGrant(fixture.parent.engineBinding);
  const verifiedGrant = verifyHarnessMaintenanceGrant(envelope, {
    now: NOW,
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    verifyHumanSignature: () => true,
  });
  const incompatible = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-schema-change'),
    executableDigest: digest('engine-schema-v5'),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4', 'v5'],
    writesSessionSchema: 'v5',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-v5'),
  });
  assert.throws(
    () =>
      prepareEngineAdoption({
        txId: 'adoption-schema-change',
        parent: fixture.parent,
        relationship: fixture.relationship,
        checkpoint: fixture.checkpoint,
        artifact: incompatible,
        maintenanceGrant: verifiedGrant,
        priorLocalAdoptions: 0,
        now: NOW,
      }),
    hasCode('ENGINE_ADOPTION_SCHEMA_CHANGE_FORBIDDEN'),
  );

  const compatible = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-compatible'),
    executableDigest: digest('engine-compatible'),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-compatible'),
  });
  let journal = prepareEngineAdoption({
    txId: 'adoption-rollback',
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    artifact: compatible,
    maintenanceGrant: verifiedGrant,
    priorLocalAdoptions: 0,
    now: NOW,
  });
  for (const [kind, at] of [
    ['parent-checkpointed', '2026-08-03T10:01:00.000Z'],
    ['engine-binding-updated', '2026-08-03T10:02:00.000Z'],
    ['new-engine-started', '2026-08-03T10:03:00.000Z'],
    ['health-check-failed', '2026-08-03T10:04:00.000Z'],
    ['engine-binding-rolled-back', '2026-08-03T10:05:00.000Z'],
  ] as const) {
    journal = advanceEngineAdoption(journal, { kind, at });
  }
  const rolledBack = finalizeEngineAdoption(
    fixture.parent,
    fixture.relationship,
    journal,
  );
  assert.equal(
    rolledBack.parent.engineBinding,
    fixture.checkpoint.engineDigest,
  );
  assert.equal(rolledBack.parent.status, 'active');
  assert.equal(rolledBack.parent.blocker?.kind, 'harness-intervention');
  assert.equal(rolledBack.relationship.state, 'active');
  assert.deepEqual(decideEngineAdoptionRecovery(journal), {
    action: 'none',
    authoritativeEngineDigest: fixture.checkpoint.engineDigest,
    blockerCleared: false,
  });
});

function protectedEntries(): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints = [`packages/bootstrap/${capability}.ts`];
    const dependencies = [`packages/bootstrap/shared/${capability}.ts`];
    const contentDigest = digest(`protected-content:${capability}`);
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

test('protected capability closure classifies dependency and manifest changes as control-plane', () => {
  const manifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const dependency = manifest.entries[0].dependencies[0];
  const controlPlane = classifyProtectedCandidateImpact({
    beforeManifest: manifest,
    afterManifest: manifest,
    changes: [
      {
        path: dependency,
        beforeDigest: digest('dependency-before'),
        afterDigest: digest('dependency-after'),
      },
    ],
  });
  assert.equal(controlPlane.class, 'C');
  assert.equal(controlPlane.kind, 'control-plane');
  assert.deepEqual(controlPlane.affectedCapabilities, [
    manifest.entries[0].capability,
  ]);

  const ordinary = classifyProtectedCandidateImpact({
    beforeManifest: manifest,
    afterManifest: manifest,
    changes: [
      {
        path: 'apps/api/src/example.ts',
        beforeDigest: digest('api-before'),
        afterDigest: digest('api-after'),
      },
    ],
  });
  assert.deepEqual(ordinary, {
    class: 'A',
    kind: 'ordinary',
    affectedCapabilities: [],
    manifestChanged: false,
  });

  const manifestMutation = classifyProtectedCandidateImpact({
    beforeManifest: manifest,
    afterManifest: manifest,
    changes: [
      {
        path: manifest.manifestPath,
        beforeDigest: digest('manifest-before'),
        afterDigest: digest('manifest-after'),
      },
    ],
  });
  assert.equal(manifestMutation.class, 'C');
  assert.equal(manifestMutation.manifestChanged, true);

  const invalidEntries = protectedEntries();
  invalidEntries[0] = {
    ...invalidEntries[0],
    closureDigest: digest('forged-closure'),
  };
  assert.throws(
    () =>
      createProtectedCapabilityManifest({
        schemaVersion: 1,
        manifestPath: 'workflow/protected-capabilities.json',
        entries: invalidEntries,
      }),
    hasCode('PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH'),
  );
});

function exactControlPlaneChanges(
  manifest: ReturnType<typeof createProtectedCapabilityManifest>,
): ExactControlPlaneChange[] {
  return [
    {
      path: manifest.entries[0].entrypoints[0],
      beforeDigest: digest('control-before'),
      afterDigest: digest('control-after'),
    },
  ];
}

function controlPlaneEnvelope(
  beforeManifest: ReturnType<typeof createProtectedCapabilityManifest>,
  afterManifest: ReturnType<typeof createProtectedCapabilityManifest>,
  changes: ExactControlPlaneChange[],
): ControlPlaneGrantEnvelope {
  return {
    payload: {
      kind: 'control-plane-grant.v1',
      grantId: 'control-grant-1',
      mandateBinding: {
        schemaVersion: 1,
        parentTaskId: 'control-plane-task',
        mandateId: '33333333-3333-4333-8333-333333333333',
        mandateDigest: '3'.repeat(64),
        changeId: 'control-plane-change',
        externalAuditRoot: '/external/audit/control-plane',
      },
      repositoryId: 'github:example/expense-app',
      candidateDigest: controlPlaneCandidateDigest(changes),
      exactChanges: changes,
      beforeClosureDigest: beforeManifest.manifestDigest,
      afterClosureDigest: afterManifest.manifestDigest,
      affectedCapabilities: [beforeManifest.entries[0].capability],
      behaviorChangeSummary: 'Promote the repaired engine verifier closure.',
      recoveryBundle: {
        bundleDigest: digest('recovery-bundle'),
        previousClosureDigest: beforeManifest.manifestDigest,
        restartArtifactDigest: digest('restart-old-control-plane'),
        rollbackTestReportDigest: digest('rollback-test'),
      },
      independentReviewAttestationDigest: digest('independent-review'),
      updaterVersion: 1,
      oneShot: true,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'control-plane-human-signature',
  };
}

test('Control-Plane Grant binds exact closures/diff and minimal updater rolls back purely', () => {
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const changes = exactControlPlaneChanges(beforeManifest);
  const changedEntries = protectedEntries();
  changedEntries[0] = {
    ...changedEntries[0],
    contentDigest: changes[0].afterDigest!,
    closureDigest: protectedCapabilityClosureDigest(
      changedEntries[0].entrypoints,
      changedEntries[0].dependencies,
      changes[0].afterDigest!,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: changedEntries,
  });
  changes.push({
    path: beforeManifest.manifestPath,
    beforeDigest: beforeManifest.manifestDigest,
    afterDigest: afterManifest.manifestDigest,
  });
  const envelope = controlPlaneEnvelope(beforeManifest, afterManifest, changes);
  const signed: string[] = [];
  const verifiedGrant = verifyControlPlaneGrant(envelope, {
    now: NOW,
    beforeManifest,
    afterManifest,
    changes,
    consumedGrantIds: new Set(),
    verifyHumanSignature(payload, signature, signer, namespace) {
      signed.push(payload);
      assert.equal(signature, 'control-plane-human-signature');
      assert.equal(signer, 'maintainer@example.test');
      assert.equal(namespace, 'expense-app.control-plane-grant.v1');
      return true;
    },
  });
  assert.equal(signed[0], canonicalControlPlaneGrantPayload(envelope.payload));
  assert.equal(
    verifiedGrant.payload.mandateBinding.parentTaskId,
    'control-plane-task',
  );

  let tx = prepareMinimalUpdaterTransaction(verifiedGrant, {
    txId: 'control-update-1',
    now: NOW,
  });
  for (const [kind, at] of [
    ['old-closure-verified', '2026-08-03T10:01:00.000Z'],
    ['candidate-verified', '2026-08-03T10:02:00.000Z'],
    ['recovery-bundle-verified', '2026-08-03T10:03:00.000Z'],
    ['atomic-switch-completed', '2026-08-03T10:04:00.000Z'],
  ] as const) {
    tx = advanceMinimalUpdaterTransaction(tx, { kind, at });
  }
  assert.deepEqual(decideControlPlaneRecovery(tx), {
    action: 'rollback-with-recovery-bundle',
    authoritativeClosureDigest: beforeManifest.manifestDigest,
    terminal: false,
  });
  assert.throws(
    () =>
      advanceMinimalUpdaterTransaction(tx, {
        kind: 'finalize',
        at: '2026-08-03T10:04:30.000Z',
      }),
    hasCode('CONTROL_PLANE_UPDATE_TRANSITION_INVALID'),
  );
  tx = advanceMinimalUpdaterTransaction(tx, {
    kind: 'self-tests-failed',
    at: '2026-08-03T10:05:00.000Z',
  });
  tx = advanceMinimalUpdaterTransaction(tx, {
    kind: 'rollback-completed',
    at: '2026-08-03T10:06:00.000Z',
  });
  assert.equal(tx.state, 'ROLLED_BACK');
  assert.deepEqual(decideControlPlaneRecovery(tx), {
    action: 'none',
    authoritativeClosureDigest: beforeManifest.manifestDigest,
    terminal: true,
  });

  const stale = controlPlaneEnvelope(beforeManifest, afterManifest, changes);
  stale.payload.beforeClosureDigest = digest('wrong-before-closure');
  assert.throws(
    () =>
      verifyControlPlaneGrant(stale, {
        now: NOW,
        beforeManifest,
        afterManifest,
        changes,
        consumedGrantIds: new Set(),
        verifyHumanSignature: () => true,
      }),
    hasCode('CONTROL_PLANE_BEFORE_CLOSURE_MISMATCH'),
  );
  assert.throws(
    () =>
      verifyControlPlaneGrant(envelope, {
        now: NOW,
        beforeManifest,
        afterManifest,
        changes,
        consumedGrantIds: new Set(['control-grant-1']),
        verifyHumanSignature: () => true,
      }),
    hasCode('CONTROL_PLANE_GRANT_ALREADY_CONSUMED'),
  );
  const malformedMandate = controlPlaneEnvelope(
    beforeManifest,
    afterManifest,
    changes,
  );
  malformedMandate.payload.mandateBinding.externalAuditRoot = 'relative/audit';
  assert.throws(
    () =>
      verifyControlPlaneGrant(malformedMandate, {
        now: NOW,
        beforeManifest,
        afterManifest,
        changes,
        consumedGrantIds: new Set(),
        verifyHumanSignature: () => true,
      }),
    hasCode('CONTROL_PLANE_TASK_MANDATE_BINDING_INVALID'),
  );
});

test('minimal updater success finalizes only after self-test', () => {
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const changes = exactControlPlaneChanges(beforeManifest);
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries().map((entry, index) =>
      index === 0
        ? {
            ...entry,
            contentDigest: changes[0].afterDigest!,
            closureDigest: protectedCapabilityClosureDigest(
              entry.entrypoints,
              entry.dependencies,
              changes[0].afterDigest!,
            ),
          }
        : entry,
    ),
  });
  changes.push({
    path: beforeManifest.manifestPath,
    beforeDigest: beforeManifest.manifestDigest,
    afterDigest: afterManifest.manifestDigest,
  });
  const verified = verifyControlPlaneGrant(
    controlPlaneEnvelope(beforeManifest, afterManifest, changes),
    {
      now: NOW,
      beforeManifest,
      afterManifest,
      changes,
      consumedGrantIds: new Set(),
      verifyHumanSignature: () => true,
    },
  );
  let tx = prepareMinimalUpdaterTransaction(verified, {
    txId: 'control-update-success',
    now: NOW,
  });
  for (const [kind, at] of [
    ['old-closure-verified', '2026-08-03T10:01:00.000Z'],
    ['candidate-verified', '2026-08-03T10:02:00.000Z'],
    ['recovery-bundle-verified', '2026-08-03T10:03:00.000Z'],
    ['atomic-switch-completed', '2026-08-03T10:04:00.000Z'],
    ['self-tests-passed', '2026-08-03T10:05:00.000Z'],
    ['finalize', '2026-08-03T10:06:00.000Z'],
  ] as const) {
    tx = advanceMinimalUpdaterTransaction(tx, { kind, at });
  }
  assert.equal(tx.state, 'FINALIZED');
  assert.deepEqual(decideControlPlaneRecovery(tx), {
    action: 'none',
    authoritativeClosureDigest: afterManifest.manifestDigest,
    terminal: true,
  });
});

test('supersede rejects execution failures and legacy V1 grants are verification-only', () => {
  assert.deepEqual(validateWorkflowSupersedeReason('workflow-replaced'), {
    allowed: true,
    reason: 'workflow-replaced',
  });
  assert.throws(
    () => validateWorkflowSupersedeReason('provider-timeout'),
    hasCode('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN'),
  );
  assert.throws(
    () => validateWorkflowSupersedeReason('contract-or-baseline-change'),
    hasCode('SUPERSEDE_REQUIRES_EPOCH_ROLLOVER'),
  );
  assert.throws(
    () => validateWorkflowSupersedeReason('mystery-reason'),
    hasCode('SUPERSEDE_REASON_UNSUPPORTED'),
  );

  const signedPayload = '{"kind":"maintainer-grant.v1","grantId":"old-1"}';
  const result = verifyLegacyGrantV1ReadOnly(
    {
      kind: 'legacy-grant-v1-audit.v1',
      legacyKind: 'maintainer-grant.v1',
      grantId: 'old-1',
      signedPayload,
      payloadDigest: digest(signedPayload),
      signer: 'retired-maintainer@example.test',
      signature: 'historical-signature',
    },
    {
      verifyHumanSignature(payload, signature, signer, namespace) {
        assert.equal(payload, signedPayload);
        assert.equal(signature, 'historical-signature');
        assert.equal(signer, 'retired-maintainer@example.test');
        assert.equal(namespace, 'expense-app.workflow.maintainer-grant.v1');
        return true;
      },
    },
  );
  assert.deepEqual(result, {
    grantId: 'old-1',
    legacyKind: 'maintainer-grant.v1',
    mode: 'historical-read-only',
    signatureValid: true,
  });
  assert.throws(
    () => assertLegacyGrantV1SigningAllowed(),
    hasCode('LEGACY_GRANT_V1_NEW_SIGNING_DISABLED'),
  );
});
