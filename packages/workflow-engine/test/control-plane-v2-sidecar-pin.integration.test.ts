import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { produceControlPlaneApprovalCandidateV2 } from '../src/control-plane-promotion-producer.ts';
import { interventionEngineArtifactRecordPath } from '../src/intervention-engine-artifact-store.ts';
import {
  persistedBootstrapSidecarSessionPath,
  readBootstrapSidecarPromotionPin,
  readPersistedControlPlaneUpdate,
} from '../src/intervention-control-persistence.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/intervention-control-updater-cli.ts';
import {
  readControlPlaneSupervisorState,
  recoverControlPlanePromotion,
  type ControlPlaneUpdaterAuditRecord,
} from '../src/intervention-control-updater.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REVIEWER,
  controlPlaneFixtureUpdaterDependencies,
  setupControlPlaneProducerFixture,
} from './control-plane-promotion-fixture.ts';

const NOW = new Date('2026-08-10T10:05:00.000Z');

function cryptoDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const value = await setupControlPlaneProducerFixture();
  const reviewCalls = { human: 0, sign: 0 };
  const grantCalls = { human: 0, sign: 0 };
  const produced = produceControlPlaneApprovalCandidateV2(
    fs.realpathSync(value.repository),
    value.stateRoot,
    value.frozen.candidateBundleDigest,
    {
      now: () => new Date('2026-08-10T10:03:00.000Z'),
      reviewSigner: value.signing.signer(
        CONTROL_PLANE_FIXTURE_REVIEWER,
        reviewCalls,
      ),
      verifyHumanSignature: value.signing.verifier,
      presentReviewSummary() {},
    },
  );
  const dependencies = controlPlaneFixtureUpdaterDependencies(
    value.frozen,
    value.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, grantCalls),
    value.signing.verifier,
    [],
    NOW,
  );
  const argv = [
    'approve-and-apply',
    produced.candidate.candidateId,
    '--task',
    value.frozen.mandateBinding.mandateTaskId,
  ];
  const grantId = `control-plane-approval-${produced.candidate.candidateId.slice('sha256:'.length)}`;
  const artifactPath = interventionEngineArtifactRecordPath(
    value.stateRoot,
    value.candidateArtifact.artifactId,
  );
  return { ...value, produced, dependencies, argv, grantId, artifactPath };
}

test('V2 missing artifact authority at RECOVERY_VERIFIED fails before supervisor switch', async () => {
  const value = await fixture();
  try {
    const removedPath = `${value.artifactPath}.removed`;
    const audit: ControlPlaneUpdaterAuditRecord[] = [];
    let removed = false;
    const dependencies = {
      ...value.dependencies,
      auditSink: {
        append(record: ControlPlaneUpdaterAuditRecord) {
          audit.push(record);
          if (record.event === 'recovery-verified' && !removed) {
            fs.renameSync(value.artifactPath, removedPath);
            removed = true;
          }
        },
      },
    };
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          value.argv,
          value.stateRoot,
          dependencies,
          fs.realpathSync(value.repository),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CONTROL_PLANE_V2_SIDECAR_AUTHORITY_REQUIRED',
    );
    assert.equal(
      readPersistedControlPlaneUpdate(value.stateRoot, value.grantId)
        .transaction.state,
      'RECOVERY_VERIFIED',
    );
    assert.equal(
      readControlPlaneSupervisorState(value.stateRoot).activeArtifact
        .artifactId,
      value.initialized.activeArtifact.artifactId,
    );
    assert.equal(
      audit.some((record) => record.event === 'switched'),
      false,
    );
  } finally {
    value.cleanup();
  }
});

test('V2 signed provenance rejects a coherent replacement artifact record', async () => {
  const value = await fixture();
  try {
    const replacement = JSON.parse(
      fs.readFileSync(value.artifactPath, 'utf8'),
    ) as Record<string, any>;
    replacement.createdAt = '2026-08-10T10:02:30.000Z';
    const { recordDigest: _artifactDigest, ...artifactPayload } = replacement;
    replacement.recordDigest = `sha256:${cryptoDigest(
      canonicalJson(artifactPayload),
    )}`;
    fs.writeFileSync(value.artifactPath, `${canonicalJson(replacement)}\n`, {
      mode: 0o600,
    });

    const sidecarPath = persistedBootstrapSidecarSessionPath(
      value.stateRoot,
      'parent-a',
    );
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<
      string,
      any
    >;
    sidecar.artifacts[0].evidenceDigest = replacement.recordDigest;
    sidecar.artifacts[0].readyAt = replacement.createdAt;
    const { recordDigest: _sidecarDigest, ...sidecarPayload } = sidecar;
    sidecar.recordDigest = `sha256:${cryptoDigest(
      canonicalJson(sidecarPayload),
    )}`;
    fs.writeFileSync(sidecarPath, `${canonicalJson(sidecar)}\n`, {
      mode: 0o600,
    });

    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          value.argv,
          value.stateRoot,
          value.dependencies,
          fs.realpathSync(value.repository),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_CONFLICT',
    );
    assert.equal(
      readControlPlaneSupervisorState(value.stateRoot).activeArtifact
        .artifactId,
      value.initialized.activeArtifact.artifactId,
    );
  } finally {
    value.cleanup();
  }
});

test('V2 FINALIZED replay cannot succeed without its pinned artifact record', async () => {
  const value = await fixture();
  const removedPath = `${value.artifactPath}.removed`;
  try {
    const dependencies = {
      ...value.dependencies,
      testHooks: {
        afterAtomicSwitch() {
          fs.renameSync(value.artifactPath, removedPath);
        },
      },
    };
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          value.argv,
          value.stateRoot,
          dependencies,
          fs.realpathSync(value.repository),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CONTROL_PLANE_V2_SIDECAR_AUTHORITY_REQUIRED',
    );
    const finalized = readPersistedControlPlaneUpdate(
      value.stateRoot,
      value.grantId,
    );
    assert.equal(finalized.transaction.state, 'FINALIZED');
    assert.equal(
      readBootstrapSidecarPromotionPin(
        value.stateRoot,
        finalized.transaction.txId,
      ).state,
      'commit-intent',
    );

    fs.renameSync(removedPath, value.artifactPath);
    const recovered = recoverControlPlanePromotion(
      value.stateRoot,
      value.grantId,
      value.dependencies,
    );
    assert.equal(recovered.record.transaction.state, 'FINALIZED');
    assert.equal(
      readBootstrapSidecarPromotionPin(
        value.stateRoot,
        recovered.record.transaction.txId,
      ).state,
      'finalized',
    );
  } finally {
    value.cleanup();
  }
});

test('V2 rollback terminalizes the exact reserved sidecar pin', async () => {
  const value = await fixture();
  try {
    const dependencies = {
      ...value.dependencies,
      testHooks: {
        afterAtomicSwitch() {
          const candidatePath = readControlPlaneSupervisorState(value.stateRoot)
            .activeArtifact.executablePath;
          fs.renameSync(candidatePath, `${candidatePath}.unavailable`);
        },
      },
    };
    const rolledBack = dispatchProductionControlPlaneUpdaterCommand(
      value.argv,
      value.stateRoot,
      dependencies,
      fs.realpathSync(value.repository),
    );
    if (rolledBack.record === null) {
      assert.fail('V2 rollback must retain its durable update record.');
    }
    assert.equal(rolledBack.record.transaction.state, 'ROLLED_BACK');
    assert.equal(
      readBootstrapSidecarPromotionPin(
        value.stateRoot,
        rolledBack.record.transaction.txId,
      ).state,
      'rolled-back',
    );
    assert.equal(
      readControlPlaneSupervisorState(value.stateRoot).activeArtifact
        .artifactId,
      value.initialized.activeArtifact.artifactId,
    );
  } finally {
    value.cleanup();
  }
});
