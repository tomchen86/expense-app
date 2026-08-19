import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resolveControlPlaneEngineSelection } from '../bootstrap/control-plane-trust.ts';
import {
  produceControlPlaneApprovalCandidateV2,
  type ControlPlanePromotionReviewSummaryV2,
} from '../src/application/control-plane/control-plane-promotion-producer.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/intervention-control-updater-cli.ts';
import type { ControlPlaneApprovalSummaryV2 } from '../src/application/control-plane/intervention-control-updater.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER as GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REPOSITORY_ID as REPOSITORY_ID,
  CONTROL_PLANE_FIXTURE_REVIEWER as REVIEWER,
  controlPlaneFixtureDigest as digest,
  controlPlaneFixtureUpdaterDependencies as updaterDependencies,
  setupControlPlaneProducerFixture as setupProducerFixture,
} from './control-plane-promotion-fixture.ts';

test('clean frozen Class-C candidate produces exact reviewed material and existing updater consumes V2', async () => {
  const fixture = await setupProducerFixture();
  const {
    repository,
    stateRoot,
    initialized,
    beforeManifest,
    frozen,
    candidateArtifact,
    signing,
  } = fixture;
  try {
    const reviewCalls = { present: 0, human: 0, sign: 0 };
    const reviewSummaries: ControlPlanePromotionReviewSummaryV2[] = [];
    const reviewer = signing.signer(REVIEWER, reviewCalls);
    const verifyHumanSignature = signing.verifier;
    const produced = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(repository),
      stateRoot,
      frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: reviewer,
        verifyHumanSignature,
        presentReviewSummary(summary) {
          reviewCalls.present += 1;
          reviewSummaries.push(summary);
        },
      },
    );
    assert.equal(produced.replayed, false);
    assert.equal(
      produced.candidate.kind,
      'persisted-control-plane-approval-candidate.v2',
    );
    assert.equal(
      produced.candidate.bundle.material.frozenCandidateBundleDigest,
      `sha256:${frozen.candidateBundleDigest}`,
    );
    assert.notEqual(
      produced.candidate.bundle.material.exactChanges.find(
        ({ path: filePath }) =>
          filePath === 'workflow/protected-capabilities.json',
      )?.beforeDigest,
      beforeManifest.manifestDigest,
      'raw manifest blob digest remains distinct from semantic closure digest',
    );
    assert.equal(
      produced.candidate.bundle.material.beforeClosureDigest,
      beforeManifest.manifestDigest,
    );
    assert.match(
      produced.candidate.bundle.independentReviewAttestation.signature,
      /-----BEGIN SSH SIGNATURE-----/,
    );
    assert.equal(
      produced.candidate.bundle.material.candidateExecutableProvenanceDigest.startsWith(
        'sha256:',
      ),
      true,
    );
    assert.equal(
      produced.candidate.bundle.material.recoveryBundle
        .restartExecutableProvenanceDigest,
      initialized.recordDigest,
    );
    assert.match(
      Buffer.from(
        produced.candidate.bundle.material.recoveryBundle
          .rollbackTestReportBase64,
        'base64',
      ).toString('utf8'),
      /control-plane-rollback-test-report\.v2/,
    );
    assert.deepEqual(reviewCalls, { present: 1, human: 1, sign: 1 });
    assert.equal(reviewSummaries.length, 1);

    const replayed = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(repository),
      stateRoot,
      frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:04:00.000Z'),
        reviewSigner: reviewer,
        verifyHumanSignature,
        presentReviewSummary() {
          reviewCalls.present += 1;
        },
      },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(
      replayed.candidate.recordDigest,
      produced.candidate.recordDigest,
    );
    assert.deepEqual(reviewCalls, { present: 1, human: 1, sign: 1 });

    const sameIdentityCalls = { present: 0, human: 0, sign: 0 };
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            frozen.mandateBinding.mandateTaskId,
          ],
          stateRoot,
          updaterDependencies(
            frozen,
            signing.signer(REVIEWER, sameIdentityCalls),
            verifyHumanSignature,
          ),
          fs.realpathSync(repository),
        ),
      hasCode('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT'),
    );
    assert.equal(sameIdentityCalls.sign, 0);

    const replacementReviewCalls = { present: 0, human: 0, sign: 0 };
    const independentlyReviewed = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(repository),
      stateRoot,
      frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:04:30.000Z'),
        reviewSigner: signing.signer(GRANT_SIGNER, replacementReviewCalls),
        verifyHumanSignature,
        presentReviewSummary() {
          replacementReviewCalls.present += 1;
        },
      },
    );
    assert.equal(independentlyReviewed.replayed, false);
    assert.notEqual(
      independentlyReviewed.candidate.candidateId,
      produced.candidate.candidateId,
    );
    assert.deepEqual(replacementReviewCalls, {
      present: 1,
      human: 1,
      sign: 1,
    });

    const grantCalls = { present: 0, human: 0, sign: 0 };
    const approvalSummaries: ControlPlaneApprovalSummaryV2[] = [];
    const dependencies = updaterDependencies(
      frozen,
      signing.signer(REVIEWER, grantCalls),
      verifyHumanSignature,
      approvalSummaries,
    );
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      [
        'approve-and-apply',
        independentlyReviewed.candidate.candidateId,
        '--task',
        frozen.mandateBinding.mandateTaskId,
      ],
      stateRoot,
      dependencies,
      fs.realpathSync(repository),
    );
    assert.equal(promoted.action, 'approve-and-apply');
    assert.equal(promoted.record?.kind, 'persisted-control-plane-update.v2');
    assert.equal(promoted.record?.transaction.updaterVersion, 2);
    assert.equal(promoted.record?.transaction.state, 'FINALIZED');
    assert.match(
      promoted.record?.envelope.signature ?? '',
      /-----BEGIN SSH SIGNATURE-----/,
    );
    assert.equal(
      promoted.supervisor.activeArtifact.artifactId,
      candidateArtifact.artifactId,
    );
    assert.deepEqual(grantCalls, { present: 0, human: 1, sign: 1 });
    assert.equal(approvalSummaries.length, 1);

    // This is the immutable bootstrap consumer gate: the ordinary launcher
    // must select the artifact from the finalized V2 terminal record.
    const launcherSelection = resolveControlPlaneEngineSelection(
      stateRoot,
      REPOSITORY_ID,
    );
    assert.equal(
      launcherSelection?.activeArtifact.artifactId,
      candidateArtifact.artifactId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('producer rejects a sidecar EngineArtifact whose source is not the frozen candidate diff', async () => {
  const fixture = await setupProducerFixture({
    artifactSourceDigest: digest('caller-selected-unrelated-source'),
  });
  const calls = { present: 0, human: 0, sign: 0 };
  try {
    assert.throws(
      () =>
        produceControlPlaneApprovalCandidateV2(
          fs.realpathSync(fixture.repository),
          fixture.stateRoot,
          fixture.frozen.candidateBundleDigest,
          {
            now: () => new Date('2026-08-10T10:03:00.000Z'),
            reviewSigner: fixture.signing.signer(REVIEWER, calls),
            verifyHumanSignature: fixture.signing.verifier,
            presentReviewSummary() {
              calls.present += 1;
            },
          },
        ),
      hasCode('CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH'),
    );
    assert.deepEqual(calls, { present: 0, human: 0, sign: 0 });
  } finally {
    fixture.cleanup();
  }
});

test('producer rejects a caller-selected state store before reading or signing', async () => {
  const fixture = await setupProducerFixture();
  const calls = { present: 0, human: 0, sign: 0 };
  try {
    assert.throws(
      () =>
        produceControlPlaneApprovalCandidateV2(
          fs.realpathSync(fixture.repository),
          `${fixture.stateRoot}-other-repository`,
          fixture.frozen.candidateBundleDigest,
          {
            now: () => new Date('2026-08-10T10:03:00.000Z'),
            reviewSigner: fixture.signing.signer(REVIEWER, calls),
            verifyHumanSignature: fixture.signing.verifier,
            presentReviewSummary() {
              calls.present += 1;
            },
          },
        ),
      hasCode('CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH'),
    );
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            digest('nonexistent-persisted-candidate'),
            '--task',
            fixture.frozen.mandateBinding.mandateTaskId,
          ],
          `${fixture.stateRoot}-other-repository`,
          updaterDependencies(
            fixture.frozen,
            fixture.signing.signer(REVIEWER, calls),
            fixture.signing.verifier,
          ),
          fs.realpathSync(fixture.repository),
        ),
      hasCode('CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH'),
    );
    assert.deepEqual(calls, { present: 0, human: 0, sign: 0 });
  } finally {
    fixture.cleanup();
  }
});

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}
