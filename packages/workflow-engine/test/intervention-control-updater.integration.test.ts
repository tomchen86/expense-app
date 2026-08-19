import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import {
  controlPlaneCandidateDigest,
  controlPlaneIndependentReviewAttestationDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ControlPlaneGrantEnvelope,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import {
  createControlPlanePromotionBundle,
  createControlPlaneRecoveryBundle,
  executeControlPlanePromotion,
  initializeControlPlaneSupervisorState,
  prepareControlPlanePromotion,
  readControlPlaneSupervisorState,
  recoverControlPlanePromotion,
  type ControlPlaneUpdaterAuditRecord,
} from '../src/application/control-plane/intervention-control-updater.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES as TYPED_REQUIRED_PROTECTED_CAPABILITIES,
  type ProtectedCapabilitiesManifest as TypedProtectedCapabilitiesManifest,
} from '../src/protected-capabilities.ts';
import {
  setupFinalizedControlPlanePromotionFixture,
  setupInitialControlPlaneBootstrapFixture,
} from './control-plane-promotion-fixture.ts';
import { createFixtureRepository } from './fixture.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const SOURCE_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCE_PROMOTION_STATE = path.join(
  SOURCE_REPOSITORY_ROOT,
  '.git',
  'workflow-engine',
  'intervention-control',
  'control-plane-supervisor.json',
);
const WORKFLOW_LAUNCHER = path.join(
  SOURCE_REPOSITORY_ROOT,
  'packages',
  'workflow-engine',
  'bootstrap',
  'workflow-launcher.ts',
);

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function protectedEntries(): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints =
      capability === 'control-plane.update'
        ? ['packages/workflow-engine/engine.mjs']
        : [`packages/bootstrap/${capability}.ts`];
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

function engineSource(
  closureDigest: string,
  healthy: boolean,
  engine = 'E2',
): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--control-plane-self-test') {
  process.stdout.write(JSON.stringify({kind:'control-plane-self-test.v1',healthy:${healthy ? 'true' : 'false'},closureDigest:'${closureDigest}'}) + '\\n');
  process.exit(0);
}
if (mode === '--control-plane-restart-probe') {
  process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'}) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({kind:'ordinary-engine.v1',engine:'${engine}',argv:process.argv.slice(2)}) + '\\n');
process.exit(mode === '--launcher-exit-7' ? 7 : 0);
`;
}

function fixture(
  healthy: boolean,
  candidateSourceFactory: (closureDigest: string) => string = (closureDigest) =>
    engineSource(closureDigest, healthy),
  repositoryRoot?: string,
) {
  const root =
    repositoryRoot === undefined
      ? fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-updater-')),
        )
      : fs.realpathSync(repositoryRoot);
  fs.chmodSync(root, 0o700);
  const mandateBinding = {
    schemaVersion: 1 as const,
    parentTaskId: 'control-plane-task',
    mandateId: '22222222-2222-4222-8222-222222222222',
    mandateDigest: '2'.repeat(64),
    changeId: 'control-plane-change',
    externalAuditRoot: path.join(root, 'external-audit'),
  };
  const storageRoot =
    repositoryRoot === undefined
      ? path.join(root, 'state')
      : path.join(root, '.git', 'workflow-engine', 'intervention-control');
  if (repositoryRoot === undefined) {
    fs.mkdirSync(storageRoot, { mode: 0o700 });
  }
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const changedEntries = protectedEntries();
  const controlIndex = changedEntries.findIndex(
    (entry) => entry.capability === 'control-plane.update',
  );
  const provisionalAfter = digest('candidate-control-plane-content');
  changedEntries[controlIndex] = {
    ...changedEntries[controlIndex],
    contentDigest: provisionalAfter,
    closureDigest: protectedCapabilityClosureDigest(
      changedEntries[controlIndex].entrypoints,
      changedEntries[controlIndex].dependencies,
      provisionalAfter,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries: changedEntries,
  });
  const oldSource = engineSource(beforeManifest.manifestDigest, true, 'E1');
  const candidateSource = candidateSourceFactory(afterManifest.manifestDigest);
  const executablePath = 'packages/workflow-engine/engine.mjs';
  const manifestPath = beforeManifest.manifestPath;
  const beforeManifestBytes = Buffer.from(
    canonicalJson(
      Object.fromEntries(
        Object.entries(beforeManifest).filter(
          ([key]) => key !== 'manifestDigest',
        ),
      ),
    ),
  );
  const afterManifestBytes = Buffer.from(
    canonicalJson(
      Object.fromEntries(
        Object.entries(afterManifest).filter(
          ([key]) => key !== 'manifestDigest',
        ),
      ),
    ),
  );
  assert.equal(digest(beforeManifestBytes), beforeManifest.manifestDigest);
  assert.equal(digest(afterManifestBytes), afterManifest.manifestDigest);
  const changes: ExactControlPlaneChange[] = [
    {
      path: executablePath,
      beforeDigest: digest(oldSource),
      afterDigest: digest(candidateSource),
    },
    {
      path: manifestPath,
      beforeDigest: beforeManifest.manifestDigest,
      afterDigest: afterManifest.manifestDigest,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const oldArtifact = createEngineArtifact({
    sourceChangeId: 'control-plane-E1',
    sourceDigest: digest('source-E1'),
    executableDigest: digest(oldSource),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-E1'),
  });
  const candidateArtifact = createEngineArtifact({
    sourceChangeId: 'control-plane-E2',
    sourceDigest: digest('source-E2'),
    executableDigest: digest(candidateSource),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest(`smoke-E2:${healthy}`),
  });
  const rollbackReport = Buffer.from('rollback tested\n');
  const recoveryBundle = createControlPlaneRecoveryBundle({
    repositoryId: 'github:example/expense-app',
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact: oldArtifact,
    restartExecutablePath: executablePath,
    previousFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: Buffer.from(oldSource).toString('base64'),
        contentDigest: digest(oldSource),
      },
      {
        path: manifestPath,
        mode: '100644' as const,
        contentBase64: beforeManifestBytes.toString('base64'),
        contentDigest: beforeManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest: digest(rollbackReport),
  });
  const independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelope =
    {
      payload: {
        kind: 'control-plane-independent-review.v1' as const,
        repositoryId: 'github:example/expense-app',
        candidateDigest: controlPlaneCandidateDigest(changes),
        beforeClosureDigest: beforeManifest.manifestDigest,
        afterClosureDigest: afterManifest.manifestDigest,
        recoveryBundleDigest: recoveryBundle.bundleDigest,
        affectedCapabilities: ['control-plane.update'],
        verdict: 'approved' as const,
        reviewedAt: '2026-08-03T09:50:00.000Z',
        reviewSummary:
          'Verified the exact closure transition and executable rollback path.',
        reviewer: 'reviewer@example.test',
      },
      signature: 'independent-review-signature',
    };
  const promotionBundle = createControlPlanePromotionBundle({
    mandateBinding,
    repositoryId: 'github:example/expense-app',
    candidateDigest: controlPlaneCandidateDigest(changes),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    exactChanges: changes,
    candidateArtifact,
    candidateExecutablePath: executablePath,
    candidateFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: Buffer.from(candidateSource).toString('base64'),
        contentDigest: digest(candidateSource),
      },
      {
        path: manifestPath,
        mode: '100644' as const,
        contentBase64: afterManifestBytes.toString('base64'),
        contentDigest: afterManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    recoveryBundle,
    independentReviewAttestation,
  });
  const envelope: ControlPlaneGrantEnvelope = {
    payload: {
      kind: 'control-plane-grant.v1',
      grantId: `control-promotion-${healthy ? 'healthy' : 'unhealthy'}`,
      mandateBinding,
      repositoryId: promotionBundle.repositoryId,
      candidateDigest: promotionBundle.candidateDigest,
      exactChanges: changes,
      beforeClosureDigest: beforeManifest.manifestDigest,
      afterClosureDigest: afterManifest.manifestDigest,
      affectedCapabilities: ['control-plane.update'],
      behaviorChangeSummary:
        'Atomically select the verified E2 default artifact.',
      recoveryBundle: {
        bundleDigest: recoveryBundle.bundleDigest,
        previousClosureDigest: recoveryBundle.previousClosureDigest,
        restartArtifactDigest: oldArtifact.executableDigest,
        rollbackTestReportDigest: recoveryBundle.rollbackTestReportDigest,
      },
      independentReviewAttestationDigest:
        controlPlaneIndependentReviewAttestationDigest(
          independentReviewAttestation,
        ),
      updaterVersion: 1,
      oneShot: true,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'control-plane-human-signature',
  };
  initializeControlPlaneSupervisorState(storageRoot, {
    repositoryId: envelope.payload.repositoryId,
    closureDigest: beforeManifest.manifestDigest,
    artifact: oldArtifact,
    executableBase64: Buffer.from(oldSource).toString('base64'),
    now: NOW,
  });
  return {
    root,
    storageRoot,
    mandateBinding,
    beforeManifest,
    afterManifest,
    changes,
    recoveryBundle,
    promotionBundle,
    independentReviewAttestation,
    envelope,
    oldArtifact,
    candidateArtifact,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function dependencies(
  audit: ControlPlaneUpdaterAuditRecord[],
  options: {
    now?: Date;
    afterAtomicSwitch?: () => void;
    verifiedNamespaces?: string[];
    revalidateMandate?: (
      binding: ReturnType<typeof fixture>['mandateBinding'],
      phase: string,
    ) => void;
  } = {},
) {
  return {
    now: () => options.now ?? NOW,
    consumedGrantIds: new Set<string>(),
    verifyHumanSignature(
      _payload: string,
      signature: string,
      signer: string,
      namespace: string,
    ) {
      options.verifiedNamespaces?.push(namespace);
      if (namespace === 'expense-app.control-plane-grant.v1') {
        assert.equal(signature, 'control-plane-human-signature');
        assert.equal(signer, 'maintainer@example.test');
        return true;
      }
      if (namespace === 'expense-app.control-plane-independent-review.v1') {
        assert.equal(signature, 'independent-review-signature');
        assert.equal(signer, 'reviewer@example.test');
        return true;
      }
      return false;
    },
    auditSink: {
      append(record: ControlPlaneUpdaterAuditRecord) {
        const previous = audit.find(
          (candidate) => candidate.recordId === record.recordId,
        );
        if (previous) assert.deepEqual(previous, record);
        else audit.push(record);
      },
    },
    ...(options.revalidateMandate
      ? { revalidateTaskMandateBinding: options.revalidateMandate }
      : {}),
    testHooks: {
      ...(options.afterAtomicSwitch
        ? { afterAtomicSwitch: options.afterAtomicSwitch }
        : {}),
    },
  };
}

function reviewVariant(
  value: ReturnType<typeof fixture>,
  mutate: (review: ControlPlaneIndependentReviewAttestationEnvelope) => void,
  options: { updateGrantDigest?: boolean } = {},
) {
  const bundle = structuredClone(value.promotionBundle);
  mutate(bundle.independentReviewAttestation);
  const { bundleDigest: _previousDigest, ...bundlePayload } = bundle;
  bundle.bundleDigest = digest(canonicalJson(bundlePayload));
  const envelope = structuredClone(value.envelope);
  if (options.updateGrantDigest !== false) {
    envelope.payload.independentReviewAttestationDigest = digest(
      canonicalJson(bundle.independentReviewAttestation),
    );
  }
  return { bundle, envelope };
}

test('minimal updater and production manifest loader share the protected capability vocabulary', () => {
  assert.deepEqual(
    REQUIRED_PROTECTED_CAPABILITIES,
    TYPED_REQUIRED_PROTECTED_CAPABILITIES,
  );
  const pure = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const typed: TypedProtectedCapabilitiesManifest = {
    ...pure,
    manifestPath: 'workflow/protected-capabilities.json',
  };
  assert.deepEqual(typed, pure);
});

test('minimal updater rejects a grant that names review evidence without carrying its signed bytes', () => {
  const value = fixture(true);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    const missingReviewBytes = structuredClone(value.promotionBundle) as
      Record<string, unknown> | typeof value.promotionBundle;
    delete (missingReviewBytes as Record<string, unknown>)[
      'independentReviewAttestation'
    ];
    assert.throws(
      () =>
        prepareControlPlanePromotion(
          value.storageRoot,
          {
            txId: 'promotion-review-bytes-missing',
            envelope: value.envelope,
            beforeManifest: value.beforeManifest,
            afterManifest: value.afterManifest,
            bundle: missingReviewBytes as typeof value.promotionBundle,
          },
          dependencies(audit),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_REVIEW_ATTESTATION_MISSING',
    );
  } finally {
    value.cleanup();
  }
});

test('minimal updater rejects tampered, misbound, invalid, and non-independent review attestations with stable codes', () => {
  const value = fixture(true);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    const cases: Array<{
      code: string;
      updateGrantDigest?: boolean;
      mutate: (
        review: ControlPlaneIndependentReviewAttestationEnvelope,
      ) => void;
    }> = [
      {
        code: 'CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH',
        updateGrantDigest: false,
        mutate: (review) => {
          review.payload.reviewSummary = 'Tampered after grant issuance.';
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_REPOSITORY_MISMATCH',
        mutate: (review) => {
          review.payload.repositoryId = 'github:attacker/other';
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_CANDIDATE_MISMATCH',
        mutate: (review) => {
          review.payload.candidateDigest = digest('wrong-review-candidate');
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_CLOSURE_MISMATCH',
        mutate: (review) => {
          review.payload.afterClosureDigest = digest('wrong-review-closure');
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_RECOVERY_MISMATCH',
        mutate: (review) => {
          review.payload.recoveryBundleDigest = digest('wrong-review-recovery');
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_CAPABILITY_MISMATCH',
        mutate: (review) => {
          review.payload.affectedCapabilities = ['authorization.verify'];
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
        mutate: (review) => {
          review.signature = 'invalid-review-signature';
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID',
        mutate: (review) => {
          review.payload.reviewedAt = '2026-08-03T09:56:00.000Z';
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT',
        mutate: (review) => {
          review.payload.reviewer = 'maintainer@example.test';
        },
      },
      {
        code: 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
        mutate: (review) => {
          (review.payload as unknown as Record<string, unknown>).unexpected =
            true;
        },
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const variant = reviewVariant(value, candidate.mutate, {
        updateGrantDigest: candidate.updateGrantDigest,
      });
      assert.throws(
        () =>
          prepareControlPlanePromotion(
            value.storageRoot,
            {
              txId: `promotion-invalid-review-${index}`,
              envelope: variant.envelope,
              beforeManifest: value.beforeManifest,
              afterManifest: value.afterManifest,
              bundle: variant.bundle,
            },
            dependencies(audit),
          ),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === candidate.code,
        candidate.code,
      );
    }
  } finally {
    value.cleanup();
  }
});

test('minimal updater verifies exact bundles, switches the default artifact, self-tests, audits, and consumes once', () => {
  assert.equal(fs.existsSync(SOURCE_PROMOTION_STATE), false);
  const value = fixture(true);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    const prepared = prepareControlPlanePromotion(
      value.storageRoot,
      {
        txId: 'promotion-success-1',
        envelope: value.envelope,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: value.promotionBundle,
      },
      dependencies(audit),
    );
    assert.equal(prepared.record.transaction.state, 'PREPARED');
    const completed = executeControlPlanePromotion(
      value.storageRoot,
      value.envelope.payload.grantId,
      dependencies(audit),
    );
    assert.equal(completed.record.transaction.state, 'FINALIZED');
    assert.equal(completed.record.grantState, 'consumed');
    const supervisor = readControlPlaneSupervisorState(value.storageRoot);
    assert.equal(
      supervisor.activeArtifact.artifactId,
      value.candidateArtifact.artifactId,
    );
    assert.equal(
      supervisor.activeArtifact.closureDigest,
      value.afterManifest.manifestDigest,
    );
    assert.equal(supervisor.generation, 2);
    assert.equal(
      audit.some((record) => record.event === 'finalized'),
      true,
    );
    assert.throws(
      () =>
        prepareControlPlanePromotion(
          value.storageRoot,
          {
            txId: 'promotion-replay',
            envelope: value.envelope,
            beforeManifest: value.beforeManifest,
            afterManifest: value.afterManifest,
            bundle: value.promotionBundle,
          },
          dependencies(audit),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code ===
          'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
    );
  } finally {
    value.cleanup();
    assert.equal(fs.existsSync(SOURCE_PROMOTION_STATE), false);
  }
});

test('self-test failure restarts the old closure and rolls the pointer back', () => {
  const value = fixture(false);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    prepareControlPlanePromotion(
      value.storageRoot,
      {
        txId: 'promotion-unhealthy-1',
        envelope: value.envelope,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: value.promotionBundle,
      },
      dependencies(audit),
    );
    const completed = executeControlPlanePromotion(
      value.storageRoot,
      value.envelope.payload.grantId,
      dependencies(audit),
    );
    assert.equal(completed.record.transaction.state, 'ROLLED_BACK');
    const supervisor = readControlPlaneSupervisorState(value.storageRoot);
    assert.equal(
      supervisor.activeArtifact.artifactId,
      value.oldArtifact.artifactId,
    );
    assert.equal(
      supervisor.activeArtifact.closureDigest,
      value.beforeManifest.manifestDigest,
    );
    assert.equal(supervisor.generation, 3);
    assert.equal(
      audit.some((record) => record.event === 'rolled-back'),
      true,
    );
  } finally {
    value.cleanup();
  }
});

test('crash after the atomic switch recovers conservatively and idempotently rolls back', () => {
  const value = fixture(true);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  const verifiedNamespaces: string[] = [];
  try {
    prepareControlPlanePromotion(
      value.storageRoot,
      {
        txId: 'promotion-crash-1',
        envelope: value.envelope,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: value.promotionBundle,
      },
      dependencies(audit, { verifiedNamespaces }),
    );
    assert.throws(
      () =>
        executeControlPlanePromotion(
          value.storageRoot,
          value.envelope.payload.grantId,
          dependencies(audit, {
            verifiedNamespaces,
            afterAtomicSwitch() {
              throw new Error('simulated crash');
            },
          }),
        ),
      /simulated crash/,
    );
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.candidateArtifact.artifactId,
    );
    const recovered = recoverControlPlanePromotion(
      value.storageRoot,
      value.envelope.payload.grantId,
      dependencies(audit, {
        now: new Date('2026-08-03T12:00:00.000Z'),
        verifiedNamespaces,
        revalidateMandate() {
          throw workflowError(
            'TASK_MANDATE_REVOKED',
            'The parent mandate was revoked after the atomic switch.',
            ExitCode.staleState,
          );
        },
      }),
    );
    assert.equal(recovered.record.transaction.state, 'ROLLED_BACK');
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.oldArtifact.artifactId,
    );
    const replay = recoverControlPlanePromotion(
      value.storageRoot,
      value.envelope.payload.grantId,
      dependencies(audit, {
        now: new Date('2026-08-03T13:00:00.000Z'),
        verifiedNamespaces,
      }),
    );
    assert.deepEqual(replay.record, recovered.record);
    assert.equal(audit.length > 0, true);
    for (const record of audit) {
      assert.deepEqual(record.mandateBinding, value.mandateBinding);
      assert.equal(record.parentTaskId, value.mandateBinding.parentTaskId);
      assert.equal(record.changeId, value.mandateBinding.changeId);
      assert.equal(
        record.externalAuditRoot,
        value.mandateBinding.externalAuditRoot,
      );
    }
    assert.equal(
      verifiedNamespaces.filter(
        (namespace) =>
          namespace === 'expense-app.control-plane-independent-review.v1',
      ).length >= 4,
      true,
    );
  } finally {
    value.cleanup();
  }
});

test('promotion rejects ordinary grants and any candidate or recovery byte mismatch', () => {
  const value = fixture(true);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    const ordinary = structuredClone(value.envelope) as unknown as {
      payload: { kind: string };
    };
    ordinary.payload.kind = 'apply-grant.v2';
    assert.throws(
      () =>
        prepareControlPlanePromotion(
          value.storageRoot,
          {
            txId: 'ordinary-grant-rejected',
            envelope: ordinary as unknown as ControlPlaneGrantEnvelope,
            beforeManifest: value.beforeManifest,
            afterManifest: value.afterManifest,
            bundle: value.promotionBundle,
          },
          dependencies(audit),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_GRANT_INVALID',
    );

    const crossTask = structuredClone(value.envelope);
    crossTask.payload.mandateBinding.parentTaskId = 'another-task';
    assert.throws(
      () =>
        prepareControlPlanePromotion(
          value.storageRoot,
          {
            txId: 'cross-task-grant-rejected',
            envelope: crossTask,
            beforeManifest: value.beforeManifest,
            afterManifest: value.afterManifest,
            bundle: value.promotionBundle,
          },
          dependencies(audit),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
    );

    const tampered = structuredClone(value.promotionBundle);
    tampered.candidateFiles[0].contentBase64 =
      Buffer.from('tampered').toString('base64');
    assert.throws(
      () =>
        prepareControlPlanePromotion(
          value.storageRoot,
          {
            txId: 'tampered-candidate-rejected',
            envelope: value.envelope,
            beforeManifest: value.beforeManifest,
            afterManifest: value.afterManifest,
            bundle: tampered,
          },
          dependencies(audit),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
    );
  } finally {
    value.cleanup();
  }
});

test('materialized executable tampering fails closed before the default pointer can switch', () => {
  const value = fixture(true);
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    prepareControlPlanePromotion(
      value.storageRoot,
      {
        txId: 'promotion-tampered-executable',
        envelope: value.envelope,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: value.promotionBundle,
      },
      dependencies(audit),
    );
    const candidatePath = path.join(
      value.storageRoot,
      'control-plane-artifacts',
      value.candidateArtifact.artifactId.slice('sha256:'.length),
      'engine',
    );
    fs.chmodSync(candidatePath, 0o700);
    fs.writeFileSync(candidatePath, 'tampered executable\n');
    fs.chmodSync(candidatePath, 0o500);
    assert.throws(
      () =>
        executeControlPlanePromotion(
          value.storageRoot,
          value.envelope.payload.grantId,
          dependencies(audit),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_EXECUTABLE_DIGEST_MISMATCH',
    );
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.oldArtifact.artifactId,
    );
  } finally {
    value.cleanup();
  }
});

test('candidate process receives only the bounded environment and confined cwd', () => {
  const value = fixture(
    true,
    (closureDigest) => `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--control-plane-self-test') {
  const allowed = new Set(['LANG','LC_ALL','PATH','TMPDIR','__CF_USER_TEXT_ENCODING']);
  const healthy = ['LANG','LC_ALL','PATH','TMPDIR'].every((key) => key in process.env) && Object.keys(process.env).every((key) => allowed.has(key)) && process.cwd() === process.env.TMPDIR;
  process.stdout.write(JSON.stringify({kind:'control-plane-self-test.v1',healthy,closureDigest:'${closureDigest}'}) + '\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    prepareControlPlanePromotion(
      value.storageRoot,
      {
        txId: 'promotion-process-confinement',
        envelope: value.envelope,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: value.promotionBundle,
      },
      dependencies(audit),
    );
    const completed = executeControlPlanePromotion(
      value.storageRoot,
      value.envelope.payload.grantId,
      dependencies(audit),
    );
    assert.equal(completed.record.transaction.state, 'FINALIZED');
  } finally {
    value.cleanup();
  }
});

test('candidate output above the process bound triggers deterministic rollback', () => {
  const value = fixture(
    true,
    (closureDigest) => `#!/usr/bin/env node
if (process.argv[2] === '--control-plane-self-test') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
  process.exit(0);
}
process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'}) + '\\n');
`,
  );
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    prepareControlPlanePromotion(
      value.storageRoot,
      {
        txId: 'promotion-output-bound',
        envelope: value.envelope,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: value.promotionBundle,
      },
      dependencies(audit),
    );
    const completed = executeControlPlanePromotion(
      value.storageRoot,
      value.envelope.payload.grantId,
      dependencies(audit),
    );
    assert.equal(completed.record.transaction.state, 'ROLLED_BACK');
    assert.equal(
      completed.supervisor.activeArtifact.artifactId,
      value.oldArtifact.artifactId,
    );
  } finally {
    value.cleanup();
  }
});

test('trusted workflow launcher uses built-in E1 only before supervisor initialization', () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(SOURCE_REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const enginePackage = JSON.parse(
    fs.readFileSync(
      path.join(
        SOURCE_REPOSITORY_ROOT,
        'packages',
        'workflow-engine',
        'package.json',
      ),
      'utf8',
    ),
  ) as { scripts: Record<string, string> };
  assert.equal(
    rootPackage.scripts.workflow,
    'node --experimental-strip-types packages/workflow-engine/bootstrap/workflow-launcher.ts',
  );
  assert.equal(
    enginePackage.scripts.workflow,
    'node --experimental-strip-types bootstrap/workflow-launcher.ts',
  );

  const repository = createFixtureRepository();
  try {
    const launched = runWorkflowLauncher(repository, ['--help']);
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /^Usage:/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('trusted workflow launcher selection is independent of a tampered src tree', async () => {
  const value = await setupInitialControlPlaneBootstrapFixture({
    builtInEntrypointBytes: initialLauncherEngineSource(),
    now: NOW,
  });
  const isolatedPackage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-launcher-trust-boundary-'),
  );
  const marker = path.join(isolatedPackage, 'mutable-src-loaded');
  try {
    const enginePackage = path.join(
      isolatedPackage,
      'packages',
      'workflow-engine',
    );
    const bootstrap = path.join(enginePackage, 'bootstrap');
    const mutableSource = path.join(enginePackage, 'src');
    fs.mkdirSync(bootstrap, { recursive: true });
    fs.mkdirSync(mutableSource, { recursive: true });
    fs.writeFileSync(
      path.join(enginePackage, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`,
    );
    fs.cpSync(path.dirname(WORKFLOW_LAUNCHER), bootstrap, { recursive: true });
    const maliciousModule = `import fs from 'node:fs';
fs.writeFileSync(process.env.LAUNCHER_SRC_TAMPER_MARKER, 'loaded\\n');
export function bootstrapInterventionStateRoot() { return process.env.LAUNCHER_ATTACKER_STATE_ROOT; }
export function resolveControlPlaneEngineSelection() { return null; }
`;
    fs.writeFileSync(
      path.join(mutableSource, 'intervention-control-bootstrap-cli.ts'),
      maliciousModule,
    );
    fs.writeFileSync(
      path.join(mutableSource, 'intervention-control-updater.ts'),
      maliciousModule,
    );
    fs.writeFileSync(
      path.join(mutableSource, 'cli.ts'),
      `throw new Error('mutable built-in engine must not run');\n`,
    );

    const launched = runWorkflowLauncher(
      value.repository,
      ['ordinary-command'],
      {
        launcherPath: path.join(bootstrap, 'workflow-launcher.ts'),
        env: {
          ...process.env,
          LAUNCHER_SRC_TAMPER_MARKER: marker,
          LAUNCHER_ATTACKER_STATE_ROOT: path.join(isolatedPackage, 'attacker'),
        },
      },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'ordinary-engine.v1',
      engine: 'E1',
      argv: ['ordinary-command'],
    });
    assert.equal(fs.existsSync(marker), false);
  } finally {
    value.cleanup();
    fs.rmSync(isolatedPackage, { recursive: true, force: true });
  }
});

test('trusted workflow launcher rejects a tampered built-in E1 dependency', () => {
  const repository = createFixtureRepository();
  const isolatedPackage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-launcher-built-in-closure-'),
  );
  try {
    const sourceEnginePackage = path.resolve(
      path.dirname(WORKFLOW_LAUNCHER),
      '..',
    );
    const enginePackage = path.join(
      isolatedPackage,
      'packages',
      'workflow-engine',
    );
    fs.mkdirSync(enginePackage, { recursive: true });
    fs.cpSync(
      path.join(sourceEnginePackage, 'bootstrap'),
      path.join(enginePackage, 'bootstrap'),
      { recursive: true },
    );
    fs.cpSync(
      path.join(sourceEnginePackage, 'src'),
      path.join(enginePackage, 'src'),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(sourceEnginePackage, 'package.json'),
      path.join(enginePackage, 'package.json'),
    );
    fs.appendFileSync(
      path.join(enginePackage, 'src', 'errors.ts'),
      '\n// untrusted dependency mutation\n',
    );

    const launched = runWorkflowLauncher(repository, ['--help'], {
      launcherPath: path.join(
        enginePackage,
        'bootstrap',
        'workflow-launcher.ts',
      ),
    });
    assert.notEqual(launched.status, 0);
    assert.equal(launched.stdout, '');
    assert.match(launched.stderr, /WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(isolatedPackage, { recursive: true, force: true });
  }
});

test('trusted workflow launcher selects finalized E2 and preserves argv and exit status', async () => {
  const value = await setupFinalizedControlPlanePromotionFixture({
    candidateExecutableFactory: (closureDigest) =>
      Buffer.from(engineSource(closureDigest, true)),
  });
  try {
    assert.equal(value.record.transaction.state, 'FINALIZED');

    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
      '--exact-argument',
    ]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'ordinary-engine.v1',
      engine: 'E2',
      argv: ['ordinary-command', '--exact-argument'],
    });

    const exited = runWorkflowLauncher(value.repository, ['--launcher-exit-7']);
    assert.equal(exited.status, 7, exited.stderr);
    assert.equal(JSON.parse(exited.stdout).engine, 'E2');
  } finally {
    value.cleanup();
  }
});

test('trusted workflow launcher rejects a noncanonical terminal update record', async () => {
  const value = await setupFinalizedControlPlanePromotionFixture();
  try {
    assert.equal(value.record.transaction.state, 'FINALIZED');
    fs.appendFileSync(
      onlyPrivateJsonFile(path.join(value.stateRoot, 'control-updates')),
      ' ',
    );

    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
    ]);
    assert.notEqual(launched.status, 0);
    assert.equal(launched.stdout, '');
    assert.match(launched.stderr, /CONTROL_PLANE_SUPERVISOR_CORRUPT/);
  } finally {
    value.cleanup();
  }
});

test('trusted workflow launcher selects restored E1 after failed promotion', async () => {
  const value = await setupFinalizedControlPlanePromotionFixture({
    builtInEntrypointBytes: initialLauncherEngineSource(),
  });
  try {
    const rolledBack = installTerminalV2RollbackFixture(value);
    assert.equal(
      requireRecordField(rolledBack, 'transaction').state,
      'ROLLED_BACK',
    );

    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
    ]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'ordinary-engine.v1',
      engine: 'E1',
      argv: ['ordinary-command'],
    });
  } finally {
    value.cleanup();
  }
});

test('trusted workflow launcher fails closed for missing, malformed, or mismatched supervisor authority', async () => {
  for (const [name, tamper] of [
    [
      'missing initialized pointer',
      (value: InitialControlPlaneFixture) => {
        fs.unlinkSync(supervisorPath(value.stateRoot));
      },
    ],
    [
      'closure mismatch',
      (value: InitialControlPlaneFixture) => {
        rewriteSupervisor(value.stateRoot, (supervisor) => {
          const active = supervisor.activeArtifact as Record<string, unknown>;
          active.closureDigest = digest('wrong-active-closure');
        });
      },
    ],
    [
      'artifact path mismatch',
      (value: InitialControlPlaneFixture) => {
        const supervisor = readControlPlaneSupervisorState(value.stateRoot);
        const alternate = path.join(
          value.stateRoot,
          'control-plane-artifacts',
          'alternate-artifact',
        );
        fs.mkdirSync(alternate, { mode: 0o700 });
        const alternateExecutable = path.join(alternate, 'engine');
        fs.copyFileSync(
          supervisor.activeArtifact.executablePath,
          alternateExecutable,
        );
        fs.chmodSync(alternateExecutable, 0o500);
        rewriteSupervisor(value.stateRoot, (record) => {
          const active = record.activeArtifact as Record<string, unknown>;
          active.executablePath = alternateExecutable;
        });
      },
    ],
    [
      'artifact digest mismatch',
      (value: InitialControlPlaneFixture) => {
        const executable = readControlPlaneSupervisorState(value.stateRoot)
          .activeArtifact.executablePath;
        fs.chmodSync(executable, 0o700);
        fs.writeFileSync(executable, '#!/usr/bin/env node\nprocess.exit(0);\n');
        fs.chmodSync(executable, 0o500);
      },
    ],
    [
      'artifact symlink',
      (value: InitialControlPlaneFixture) => {
        const executable = readControlPlaneSupervisorState(value.stateRoot)
          .activeArtifact.executablePath;
        const target = `${executable}.target`;
        fs.renameSync(executable, target);
        fs.symlinkSync(path.basename(target), executable);
      },
    ],
  ] as const) {
    const value = await setupInitialControlPlaneBootstrapFixture({ now: NOW });
    try {
      tamper(value);
      const launched = runWorkflowLauncher(value.repository, [
        'ordinary-command',
      ]);
      assert.notEqual(launched.status, 0, name);
      assert.equal(launched.stdout, '', name);
      assert.match(
        launched.stderr,
        /CONTROL_PLANE_(?:SUPERVISOR|EXECUTABLE|PROCESS)/,
        name,
      );
    } finally {
      value.cleanup();
    }
  }
});

type InitialControlPlaneFixture = Awaited<
  ReturnType<typeof setupInitialControlPlaneBootstrapFixture>
>;

type FinalizedControlPlaneFixture = Awaited<
  ReturnType<typeof setupFinalizedControlPlanePromotionFixture>
>;

function initialLauncherEngineSource(): string {
  return `#!/usr/bin/env node
process.stdout.write(JSON.stringify({kind:'ordinary-engine.v1',engine:'E1',argv:process.argv.slice(2)}) + '\\n');
process.exit(process.argv[2] === '--launcher-exit-7' ? 7 : 0);
`;
}

function installTerminalV2RollbackFixture(
  fixture: FinalizedControlPlaneFixture,
): Record<string, unknown> {
  const updatePath = onlyPrivateJsonFile(
    path.join(fixture.stateRoot, 'control-updates'),
  );
  const update = readPrivateRecord(updatePath);
  const transaction = requireRecordField(update, 'transaction');
  assert.equal(Array.isArray(transaction.history), true);
  assert.equal(Array.isArray(update.observations), true);
  const history = transaction.history as Array<Record<string, unknown>>;
  const observations = update.observations as Array<Record<string, unknown>>;
  history.at(-2)!.state = 'ROLLBACK_REQUIRED';
  history.at(-1)!.state = 'ROLLED_BACK';
  observations.at(-2)!.toState = 'ROLLBACK_REQUIRED';
  observations.at(-2)!.eventKind = 'self-tests-failed';
  observations.at(-1)!.fromState = 'ROLLBACK_REQUIRED';
  observations.at(-1)!.toState = 'ROLLED_BACK';
  observations.at(-1)!.eventKind = 'rollback-completed';
  transaction.state = 'ROLLED_BACK';
  transaction.journalDigest = recordDigest(transaction, 'journalDigest');
  update.recordDigest = recordDigest(update, 'recordDigest');
  writePrivateRecord(updatePath, update);

  rewriteSupervisor(fixture.stateRoot, (supervisor) => {
    supervisor.generation = 3;
    supervisor.activeArtifact = { ...fixture.initialized.activeArtifact };
    requireRecordField(supervisor, 'transition').phase = 'rollback-restored';
  });
  return update;
}

function onlyPrivateJsonFile(directory: string): string {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.isFile(), true);
  assert.equal(entries[0]?.isSymbolicLink(), false);
  assert.match(entries[0]?.name ?? '', /^[0-9a-f]{64}\.json$/);
  return path.join(directory, entries[0]!.name);
}

function readPrivateRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
  );
  return value as Record<string, unknown>;
}

function requireRecordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const fieldValue = value[field];
  assert.equal(
    typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue),
    true,
  );
  return fieldValue as Record<string, unknown>;
}

function recordDigest(
  value: Record<string, unknown>,
  field: string,
): `sha256:${string}` {
  const payload = { ...value };
  delete payload[field];
  return digest(canonicalJson(payload));
}

function writePrivateRecord(
  filePath: string,
  value: Record<string, unknown>,
): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
}

function runWorkflowLauncher(
  repository: string,
  argv: string[],
  options: {
    launcherPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return childProcess.spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      options.launcherPath ?? WORKFLOW_LAUNCHER,
      ...argv,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: options.env ?? process.env,
    },
  );
}

function supervisorPath(storageRoot: string): string {
  return path.join(storageRoot, 'control-plane-supervisor.json');
}

function rewriteSupervisor(
  storageRoot: string,
  mutate: (supervisor: Record<string, unknown>) => void,
): void {
  const filePath = supervisorPath(storageRoot);
  const supervisor = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(supervisor);
  delete supervisor.recordDigest;
  supervisor.recordDigest = digest(canonicalJson(supervisor));
  fs.writeFileSync(filePath, `${canonicalJson(supervisor)}\n`, { mode: 0o600 });
}
