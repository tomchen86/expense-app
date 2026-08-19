import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  dispatchInterventionControlCommand,
  parseInterventionControlCommand,
} from '../src/intervention-control-cli.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  controlPlaneCandidateDigest,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  type ControlPlaneGrantEnvelope,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function interveneRequest() {
  return {
    interventionChangeId: 'intervention-B',
    parent: {
      changeId: 'parent-A',
      status: 'active',
      engineBinding: digest('engine-E1'),
      sessionSchema: 'v4',
      blocker: null,
    },
    checkpoint: {
      parentChangeId: 'parent-A',
      baseOid: 'a'.repeat(40),
      worktreeFingerprint: digest('worktree'),
      trackedTreeDigest: digest('tracked'),
      untrackedBundleDigest: digest('untracked'),
      sessionStateDigest: digest('session'),
      pendingIntentDigest: digest('intent'),
      engineDigest: digest('engine-E1'),
      policyDigest: digest('policy'),
      createdAt: NOW.toISOString(),
    },
  };
}

test('production parser rejects caller-supplied intervention and adoption JSON before dispatch', () => {
  const request = interveneRequest();
  const argv = ['change', 'intervene', 'parent-A', '--request', json(request)];
  for (const callerSupplied of [
    argv,
    ['engine', 'adopt', '--request', json({ action: 'prepare' })],
  ]) {
    assert.throws(
      () => parseInterventionControlCommand(callerSupplied),
      hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
    );
    assert.throws(
      () => dispatchInterventionControlCommand(callerSupplied),
      hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
    );
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
      grantId: 'control-grant-cli-1',
      mandateBinding: {
        schemaVersion: 1,
        parentTaskId: 'control-plane-task',
        mandateId: '55555555-5555-4555-8555-555555555555',
        mandateDigest: '5'.repeat(64),
        changeId: 'control-plane-change',
        externalAuditRoot: '/external/audit/control-plane',
      },
      repositoryId: 'github:example/expense-app',
      candidateDigest: controlPlaneCandidateDigest(changes),
      exactChanges: changes,
      beforeClosureDigest: beforeManifest.manifestDigest,
      afterClosureDigest: afterManifest.manifestDigest,
      affectedCapabilities: [beforeManifest.entries[0].capability],
      behaviorChangeSummary: 'Update one protected verifier dependency.',
      recoveryBundle: {
        bundleDigest: digest('recovery-bundle'),
        previousClosureDigest: beforeManifest.manifestDigest,
        restartArtifactDigest: digest('restart-old-closure'),
        rollbackTestReportDigest: digest('rollback-test-report'),
      },
      independentReviewAttestationDigest: digest('independent-review'),
      updaterVersion: 1,
      oneShot: true,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'human-control-signature',
  };
  return { beforeManifest, afterManifest, changes, envelope };
}

test('control-plane classify and verify-grant remain read-only and require human verification', () => {
  const fixture = controlPlaneFixture();
  const classification = dispatchInterventionControlCommand([
    'control-plane',
    'classify',
    '--request',
    json({
      beforeManifest: fixture.beforeManifest,
      afterManifest: fixture.afterManifest,
      changes: fixture.changes,
    }),
  ]);
  assert.equal(classification.kind, 'control-plane-classify');
  if (classification.kind !== 'control-plane-classify') {
    assert.fail('Expected a protected capability classification.');
  }
  assert.equal(classification.impact.class, 'C');
  assert.equal(classification.effectsPerformed, false);

  const verified = dispatchInterventionControlCommand(
    [
      'control-plane',
      'verify-grant',
      '--request',
      json({
        envelope: fixture.envelope,
        beforeManifest: fixture.beforeManifest,
        afterManifest: fixture.afterManifest,
        changes: fixture.changes,
      }),
    ],
    {
      now: () => NOW,
      consumedControlPlaneGrantIds: new Set(),
      verifyHumanSignature(_payload, signature, _signer, namespace) {
        assert.equal(signature, 'human-control-signature');
        assert.equal(namespace, 'expense-app.control-plane-grant.v1');
        return true;
      },
    },
  );
  assert.equal(verified.kind, 'control-plane-verify-grant');
  if (verified.kind !== 'control-plane-verify-grant') {
    assert.fail('Expected a verified Control-Plane Grant.');
  }
  assert.equal(verified.grant.verification, 'human-signature-verified');
  assert.equal(verified.effectsPerformed, false);

  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'control-plane',
        'verify-grant',
        '--request',
        json({
          beforeManifest: fixture.beforeManifest,
          afterManifest: fixture.afterManifest,
          changes: fixture.changes,
        }),
      ]),
    hasCode('INTERVENTION_CONTROL_HUMAN_SIGNED_ENVELOPE_REQUIRED'),
  );
});

test('dispatcher rejects promotion and live ref mutation rather than performing effects', () => {
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'engine',
        'promote',
        digest('engine-E2'),
      ]),
    hasCode('INTERVENTION_CONTROL_GLOBAL_PROMOTION_FORBIDDEN'),
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'control-plane',
        'update-ref',
        'refs/heads/main',
      ]),
    hasCode('INTERVENTION_CONTROL_LIVE_REF_MUTATION_FORBIDDEN'),
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'control-plane',
        'classify',
        '--request',
        json({ updateRef: 'refs/heads/main' }),
      ]),
    hasCode('INTERVENTION_CONTROL_LIVE_REF_MUTATION_FORBIDDEN'),
  );
});

test('workflow supersede validation and malformed requests retain domain error codes', () => {
  assert.deepEqual(
    dispatchInterventionControlCommand([
      'workflow',
      'validate-supersede-reason',
      'workflow-replaced',
    ]),
    {
      kind: 'workflow-supersede-reason',
      validation: { allowed: true, reason: 'workflow-replaced' },
      effectsPerformed: false,
    },
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'workflow',
        'validate-supersede-reason',
        'provider-timeout',
      ]),
    hasCode('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN'),
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'change',
        'intervene',
        'parent-A',
        '--request',
        '{bad-json',
      ]),
    hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
  );
  assert.throws(
    () => dispatchInterventionControlCommand(['unknown', 'command']),
    hasCode('INTERVENTION_CONTROL_COMMAND_UNSUPPORTED'),
  );
});
