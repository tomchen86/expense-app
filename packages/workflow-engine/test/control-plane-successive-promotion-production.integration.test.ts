import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  canonicalControlPlaneGrantPayloadV3,
  canonicalControlPlaneIndependentReviewAttestationPayloadV3,
  controlPlaneIndependentReviewAttestationDigestV3,
  controlPlanePromotionLineageDigest,
  controlPlanePromotionMaterialDigest,
  createControlPlanePromotionBundleV3,
  createControlPlanePromotionLineage,
  verifyControlPlaneGrantV3,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
} from '../src/intervention-control.ts';
import { produceControlPlaneApprovalCandidateV2 } from '../src/control-plane-promotion-producer.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REVIEWER,
  setupControlPlaneProducerFixture,
} from './control-plane-promotion-fixture.ts';

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

test('successor review and grant signatures bind the exact promotion lineage', async () => {
  const fixture = await setupControlPlaneProducerFixture();
  try {
    const produced = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      fixture.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const material = produced.candidate.bundle.material;
    const lineage = createControlPlanePromotionLineage({
      historyAnchorDigest: digest('history-anchor'),
      previousTerminalRecordDigest: digest('previous-terminal'),
      previousSupervisorRecordDigest: fixture.initialized.recordDigest,
      previousGeneration: 1,
      candidateGeneration: 2,
      rollbackGeneration: 3,
      previousActiveTrustCommit: fixture.frozen.expectedOldCommit,
      candidateTrustCommit: fixture.frozen.candidateCommit,
    });
    const reviewedAt = '2026-08-10T10:04:00.000Z';
    const reviewPayload = {
      kind: 'control-plane-independent-review.v3' as const,
      repositoryId: material.repositoryId,
      frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
      candidateDigest: material.candidateDigest,
      promotionMaterialDigest: controlPlanePromotionMaterialDigest(material),
      promotionLineageDigest: lineage.lineageDigest,
      beforeClosureDigest: material.beforeClosureDigest,
      afterClosureDigest: material.afterClosureDigest,
      recoveryBundleDigest: material.recoveryBundle.bundleDigest,
      affectedCapabilities: [...material.affectedCapabilities],
      verdict: 'approved' as const,
      reviewedAt,
      reviewSummary: 'Approved the exact successor lineage.',
      reviewer: CONTROL_PLANE_FIXTURE_REVIEWER,
    };
    const review = {
      payload: reviewPayload,
      signature: fixture.signing
        .signer(CONTROL_PLANE_FIXTURE_REVIEWER, { human: 0, sign: 0 })
        .sign(
          canonicalControlPlaneIndependentReviewAttestationPayloadV3(
            reviewPayload,
          ),
          CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
        )
        .trim(),
    };
    const bundle = createControlPlanePromotionBundleV3({
      material,
      lineage,
      independentReviewAttestation: review,
    });
    const issuedAt = '2026-08-10T10:05:00.000Z';
    const grantPayload = {
      kind: 'control-plane-grant.v3' as const,
      grantId: 'successor-grant',
      mandateBinding: material.mandateBinding,
      repositoryId: material.repositoryId,
      frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
      candidateDigest: material.candidateDigest,
      promotionMaterialDigest: bundle.promotionMaterialDigest,
      promotionLineageDigest: bundle.promotionLineageDigest,
      promotionBundleDigest: bundle.bundleDigest,
      exactChanges: material.exactChanges,
      beforeClosureDigest: material.beforeClosureDigest,
      afterClosureDigest: material.afterClosureDigest,
      affectedCapabilities: material.affectedCapabilities,
      behaviorChangeSummary: material.behaviorChangeSummary,
      recoveryBundle: {
        bundleDigest: material.recoveryBundle.bundleDigest,
        previousClosureDigest: material.recoveryBundle.previousClosureDigest,
        restartArtifactDigest:
          material.recoveryBundle.restartArtifact.executableDigest,
        rollbackTestReportDigest:
          material.recoveryBundle.rollbackTestReportDigest,
      },
      independentReviewAttestationDigest:
        controlPlaneIndependentReviewAttestationDigestV3(review),
      updaterVersion: 3 as const,
      oneShot: true as const,
      issuedAt,
      expiresAt: '2026-08-10T10:10:00.000Z',
      humanSigner: CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
    };
    const grantEnvelope = {
      payload: grantPayload,
      signature: fixture.signing
        .signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, { human: 0, sign: 0 })
        .sign(
          canonicalControlPlaneGrantPayloadV3(grantPayload),
          CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
        )
        .trim(),
    };
    const verified = verifyControlPlaneGrantV3(grantEnvelope, {
      now: new Date(issuedAt),
      beforeManifest: fixture.beforeManifest,
      afterManifest: produced.candidate.afterManifest,
      bundle,
      consumedGrantIds: new Set(),
      verifyHumanSignature: fixture.signing.verifier,
    });
    assert.equal(
      verified.payload.promotionLineageDigest,
      lineage.lineageDigest,
    );

    assert.throws(() =>
      verifyControlPlaneGrantV3(
        {
          ...grantEnvelope,
          payload: {
            ...grantPayload,
            promotionLineageDigest: digest('substituted-lineage'),
          },
        },
        {
          now: new Date(issuedAt),
          beforeManifest: fixture.beforeManifest,
          afterManifest: produced.candidate.afterManifest,
          bundle,
          consumedGrantIds: new Set(),
          verifyHumanSignature: fixture.signing.verifier,
        },
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function commit(label: string): string {
  return crypto.createHash('sha256').update(`commit:${label}`).digest('hex');
}
