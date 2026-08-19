import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { resolveControlPlaneEngineSelection } from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
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
} from '../src/modules/authority/intervention-control.ts';
import {
  produceControlPlaneApprovalCandidateV2,
  produceControlPlaneApprovalCandidateV3,
} from '../src/application/control-plane/control-plane-promotion-producer.ts';
import {
  readControlPlaneSupervisorHistory,
  readControlPlaneSupervisorHistoryProgress,
} from '../src/runtime/storage-journal/control-plane-supervisor-history.ts';
import {
  persistControlPlaneApprovalCandidateV3,
  preflightControlPlaneApprovalCandidateV3,
  readControlPlaneSupervisorState,
  readPersistedControlPlaneApprovalCandidateV3,
} from '../src/application/control-plane/intervention-control-updater.ts';
import { readPersistedControlPlaneUpdate } from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/intervention-control-updater-cli.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REVIEWER,
  controlPlaneFixtureUpdaterDependencies,
  prepareSuccessorControlPlaneCandidate,
  setupControlPlaneProducerFixture,
  setupFinalizedControlPlanePromotionFixture,
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

    const persisted = persistControlPlaneApprovalCandidateV3(
      fixture.stateRoot,
      {
        txId: 'successor-transaction',
        mandateBinding: material.mandateBinding,
        beforeManifest: fixture.beforeManifest,
        afterManifest: produced.candidate.afterManifest,
        bundle,
      },
      new Date(reviewedAt),
    );
    assert.equal(
      persisted.kind,
      'persisted-control-plane-approval-candidate.v3',
    );
    assert.equal(
      readPersistedControlPlaneApprovalCandidateV3(
        fixture.stateRoot,
        persisted.candidateId,
      ).recordDigest,
      persisted.recordDigest,
    );
    assert.equal(
      preflightControlPlaneApprovalCandidateV3(
        fixture.stateRoot,
        persisted.candidateId,
        {
          grantId: grantPayload.grantId,
          humanSigner: grantPayload.humanSigner,
          issuedAt,
          verifyHumanSignature: fixture.signing.verifier,
        },
      ).summary.promotionLineageDigest,
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

test('production successor producer derives and persists the initial history anchor', async () => {
  const fixture = await setupControlPlaneProducerFixture();
  try {
    const calls = { human: 0, sign: 0 };
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      fixture.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: fixture.signing.signer(
          CONTROL_PLANE_FIXTURE_REVIEWER,
          calls,
        ),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    assert.equal(produced.replayed, false);
    assert.equal(
      produced.candidate.kind,
      'persisted-control-plane-approval-candidate.v3',
    );
    const history = readControlPlaneSupervisorHistory(fixture.stateRoot);
    assert.equal(history.generation, 1);
    assert.equal(
      produced.candidate.bundle.lineage.historyAnchorDigest,
      history.anchor.recordDigest,
    );
    assert.equal(
      produced.candidate.bundle.lineage.previousTerminalRecordDigest,
      history.leaf.recordDigest,
    );
    assert.equal(
      produced.candidate.bundle.lineage.previousSupervisorRecordDigest,
      fixture.initialized.recordDigest,
    );
    assert.deepEqual(calls, { human: 1, sign: 1 });
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      [
        'approve-and-apply',
        produced.candidate.candidateId,
        '--task',
        fixture.frozen.mandateBinding.mandateTaskId,
      ],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        fixture.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
          human: 0,
          sign: 0,
        }),
        fixture.signing.verifier,
        [],
        new Date('2026-08-10T10:04:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(promoted.record?.kind, 'persisted-control-plane-update.v3');
    assert.equal(promoted.supervisor.generation, 2);
    assert.equal(
      resolveControlPlaneEngineSelection(
        fixture.stateRoot,
        promoted.supervisor.repositoryId,
      )?.recordDigest,
      promoted.supervisor.recordDigest,
    );
  } finally {
    fixture.cleanup();
  }
});

test('production successor producer anchors an independently verified V2 terminal', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  const successor = prepareSuccessorControlPlaneCandidate(fixture);
  try {
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      successor.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:08:00.000Z'),
        reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const history = readControlPlaneSupervisorHistory(fixture.stateRoot);
    assert.equal(history.anchor.authority.kind, 'legacy-v2-terminal-anchor.v1');
    assert.equal(history.generation, 2);
    assert.equal(produced.candidate.bundle.lineage.previousGeneration, 2);
    assert.equal(
      produced.candidate.bundle.lineage.previousSupervisorRecordDigest,
      fixture.supervisor.recordDigest,
    );
    assert.equal(
      produced.candidate.bundle.lineage.previousActiveTrustCommit,
      fixture.frozen.candidateCommit,
    );
    assert.equal(
      produced.candidate.bundle.lineage.candidateTrustCommit,
      successor.frozen.candidateCommit,
    );
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      [
        'approve-and-apply',
        produced.candidate.candidateId,
        '--task',
        successor.frozen.mandateBinding.mandateTaskId,
      ],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        successor.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
          human: 0,
          sign: 0,
        }),
        fixture.signing.verifier,
        [],
        new Date('2026-08-10T10:09:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(promoted.record?.kind, 'persisted-control-plane-update.v3');
    assert.equal(promoted.record.transaction.state, 'FINALIZED');
    assert.equal(promoted.supervisor.generation, 3);
    assert.equal(
      resolveControlPlaneEngineSelection(
        fixture.stateRoot,
        promoted.supervisor.repositoryId,
      )?.recordDigest,
      promoted.supervisor.recordDigest,
    );
    const terminalHistory = readControlPlaneSupervisorHistory(
      fixture.stateRoot,
    );
    assert.equal(terminalHistory.generation, 3);
    assert.equal(
      terminalHistory.leaf.kind,
      'control-plane-supervisor-history-terminal.v1',
    );
    const next = prepareSuccessorControlPlaneCandidate(
      {
        repository: fixture.repository,
        stateRoot: fixture.stateRoot,
        frozen: successor.frozen,
      },
      {
        changeId: 'intervention-d',
        parentChangeId: 'parent-c',
        mandateId: '44444444-4444-4444-8444-444444444444',
        content: 'fixture protected control-plane candidate v3 generation 4\n',
        commitMessage: 'Promote another successor intervention engine',
      },
    );
    try {
      const producedAgain = produceControlPlaneApprovalCandidateV3(
        fs.realpathSync(fixture.repository),
        fixture.stateRoot,
        next.frozen.candidateBundleDigest,
        {
          now: () => new Date('2026-08-10T10:10:00.000Z'),
          reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
            human: 0,
            sign: 0,
          }),
          verifyHumanSignature: fixture.signing.verifier,
          presentReviewSummary() {},
        },
      );
      assert.equal(
        producedAgain.candidate.bundle.lineage.previousGeneration,
        3,
      );
      assert.equal(
        producedAgain.candidate.bundle.lineage.previousTerminalRecordDigest,
        terminalHistory.leaf.recordDigest,
      );
      const promotedAgain = dispatchProductionControlPlaneUpdaterCommand(
        [
          'approve-and-apply',
          producedAgain.candidate.candidateId,
          '--task',
          next.frozen.mandateBinding.mandateTaskId,
        ],
        fixture.stateRoot,
        controlPlaneFixtureUpdaterDependencies(
          next.frozen,
          fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
            human: 0,
            sign: 0,
          }),
          fixture.signing.verifier,
          [],
          new Date('2026-08-10T10:11:00.000Z'),
        ),
        fs.realpathSync(fixture.repository),
      );
      assert.equal(
        promotedAgain.record?.kind,
        'persisted-control-plane-update.v3',
      );
      assert.equal(promotedAgain.record.transaction.state, 'FINALIZED');
      assert.equal(promotedAgain.supervisor.generation, 4);
      assert.equal(
        resolveControlPlaneEngineSelection(
          fixture.stateRoot,
          promotedAgain.supervisor.repositoryId,
        )?.recordDigest,
        promotedAgain.supervisor.recordDigest,
      );
      assert.equal(
        readControlPlaneSupervisorHistory(fixture.stateRoot).generation,
        4,
      );
      const supervisorPath = `${fixture.stateRoot}/control-plane-supervisor.json`;
      const redigestedSupervisor = withRecordDigest({
        ...readCanonicalFixtureRecord(supervisorPath),
        generation: 999,
      });
      writeCanonicalFixtureRecord(supervisorPath, redigestedSupervisor);
      assert.throws(
        () =>
          resolveControlPlaneEngineSelection(
            fixture.stateRoot,
            promotedAgain.supervisor.repositoryId,
          ),
        /terminal promotion result/,
      );
    } finally {
      next.cleanup();
    }
  } finally {
    successor.cleanup();
    fixture.cleanup();
  }
});

test('successor recovery publishes an already durable history transition before continuing', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  const successor = prepareSuccessorControlPlaneCandidate(fixture);
  try {
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      successor.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:12:00.000Z'),
        reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const dependencies = controlPlaneFixtureUpdaterDependencies(
      successor.frozen,
      fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
        human: 0,
        sign: 0,
      }),
      fixture.signing.verifier,
      [],
      new Date('2026-08-10T10:13:00.000Z'),
    );
    Object.assign(dependencies, {
      testHooks: {
        afterSupervisorHistoryTransition() {
          throw new Error('history-transition-crash');
        },
      },
    });
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            successor.frozen.mandateBinding.mandateTaskId,
          ],
          fixture.stateRoot,
          dependencies,
          fs.realpathSync(fixture.repository),
        ),
      /history-transition-crash/,
    );

    const grantId = approvalGrantId(produced.candidate.candidateId);
    assert.equal(
      readPersistedControlPlaneUpdate(fixture.stateRoot, grantId).transaction
        .state,
      'RECOVERY_VERIFIED',
    );
    assert.equal(
      readControlPlaneSupervisorState(fixture.stateRoot).recordDigest,
      fixture.supervisor.recordDigest,
    );
    const interruptedHistory = readControlPlaneSupervisorHistoryProgress(
      fixture.stateRoot,
    );
    assert.equal(
      interruptedHistory.leaf.kind,
      'control-plane-supervisor-history-transition.v1',
    );

    const recovered = dispatchProductionControlPlaneUpdaterCommand(
      ['recover', grantId],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        successor.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
          human: 0,
          sign: 0,
        }),
        fixture.signing.verifier,
        [],
        new Date('2026-08-10T10:14:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(recovered.record?.transaction.state, 'FINALIZED');
    assert.equal(recovered.supervisor.generation, 3);
    assert.equal(
      readControlPlaneSupervisorHistoryProgress(fixture.stateRoot).leaf.kind,
      'control-plane-supervisor-history-terminal.v1',
    );
  } finally {
    successor.cleanup();
    fixture.cleanup();
  }
});

test('successor recovery seals an already terminal transaction exactly once', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  const successor = prepareSuccessorControlPlaneCandidate(fixture);
  try {
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      successor.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:15:00.000Z'),
        reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const dependencies = controlPlaneFixtureUpdaterDependencies(
      successor.frozen,
      fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
        human: 0,
        sign: 0,
      }),
      fixture.signing.verifier,
      [],
      new Date('2026-08-10T10:16:00.000Z'),
    );
    Object.assign(dependencies, {
      testHooks: {
        beforeTerminalHistorySeal() {
          throw new Error('terminal-history-seal-crash');
        },
      },
    });
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            successor.frozen.mandateBinding.mandateTaskId,
          ],
          fixture.stateRoot,
          dependencies,
          fs.realpathSync(fixture.repository),
        ),
      /terminal-history-seal-crash/,
    );

    const grantId = approvalGrantId(produced.candidate.candidateId);
    assert.equal(
      readPersistedControlPlaneUpdate(fixture.stateRoot, grantId).transaction
        .state,
      'FINALIZED',
    );
    assert.equal(
      readControlPlaneSupervisorHistoryProgress(fixture.stateRoot).leaf.kind,
      'control-plane-supervisor-history-transition.v1',
    );

    const recovered = dispatchProductionControlPlaneUpdaterCommand(
      ['recover', grantId],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        successor.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
          human: 0,
          sign: 0,
        }),
        fixture.signing.verifier,
        [],
        new Date('2026-08-10T10:17:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(recovered.record?.transaction.state, 'FINALIZED');
    assert.equal(
      readControlPlaneSupervisorHistory(fixture.stateRoot).leaf.kind,
      'control-plane-supervisor-history-terminal.v1',
    );
  } finally {
    successor.cleanup();
    fixture.cleanup();
  }
});

test('successor switch crash seals the exact rollback lineage for bootstrap selection', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  const successor = prepareSuccessorControlPlaneCandidate(fixture);
  try {
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      successor.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:18:00.000Z'),
        reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const dependencies = controlPlaneFixtureUpdaterDependencies(
      successor.frozen,
      fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
        human: 0,
        sign: 0,
      }),
      fixture.signing.verifier,
      [],
      new Date('2026-08-10T10:19:00.000Z'),
    );
    Object.assign(dependencies, {
      testHooks: {
        afterAtomicSwitch() {
          throw new Error('successor-switch-crash');
        },
      },
    });
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            successor.frozen.mandateBinding.mandateTaskId,
          ],
          fixture.stateRoot,
          dependencies,
          fs.realpathSync(fixture.repository),
        ),
      /successor-switch-crash/,
    );
    const grantId = approvalGrantId(produced.candidate.candidateId);
    const recovered = dispatchProductionControlPlaneUpdaterCommand(
      ['recover', grantId],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        successor.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
          human: 0,
          sign: 0,
        }),
        fixture.signing.verifier,
        [],
        new Date('2026-08-10T10:20:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(recovered.record?.transaction.state, 'ROLLED_BACK');
    assert.equal(recovered.supervisor.generation, 4);
    const terminal = readControlPlaneSupervisorHistory(fixture.stateRoot).leaf;
    assert.equal(terminal.kind, 'control-plane-supervisor-history-terminal.v1');
    assert.equal(
      terminal.kind === 'control-plane-supervisor-history-terminal.v1'
        ? terminal.terminalState
        : null,
      'ROLLED_BACK',
    );
    assert.equal(
      resolveControlPlaneEngineSelection(
        fixture.stateRoot,
        recovered.supervisor.repositoryId,
      )?.recordDigest,
      recovered.supervisor.recordDigest,
    );
  } finally {
    successor.cleanup();
    fixture.cleanup();
  }
});

test('sealed successor selection rejects a fully redigested signature substitution', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  const successor = prepareSuccessorControlPlaneCandidate(fixture);
  try {
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      successor.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:18:00.000Z'),
        reviewSigner: fixture.signing.signer(CONTROL_PLANE_FIXTURE_REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      [
        'approve-and-apply',
        produced.candidate.candidateId,
        '--task',
        successor.frozen.mandateBinding.mandateTaskId,
      ],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        successor.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, {
          human: 0,
          sign: 0,
        }),
        fixture.signing.verifier,
        [],
        new Date('2026-08-10T10:19:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(
      resolveControlPlaneEngineSelection(
        fixture.stateRoot,
        promoted.supervisor.repositoryId,
      )?.recordDigest,
      promoted.supervisor.recordDigest,
    );

    const grantId = approvalGrantId(produced.candidate.candidateId);
    const updateDirectory = `${fixture.stateRoot}/control-updates`;
    const updatePath = fs
      .readdirSync(updateDirectory)
      .map((name) => `${updateDirectory}/${name}`)
      .find(
        (candidatePath) =>
          readCanonicalFixtureRecord(candidatePath).kind ===
            'persisted-control-plane-update.v3' &&
          (
            readCanonicalFixtureRecord(candidatePath).envelope as Record<
              string,
              unknown
            >
          ).payload !== undefined,
      );
    assert.ok(updatePath);
    const update = readCanonicalFixtureRecord(updatePath);
    const envelope = structuredClone(
      update.envelope as Record<string, unknown>,
    );
    const payload = envelope.payload as Parameters<
      typeof canonicalControlPlaneGrantPayloadV3
    >[0];
    envelope.signature = fixture.signing
      .signer(CONTROL_PLANE_FIXTURE_REVIEWER, { human: 0, sign: 0 })
      .sign(
        canonicalControlPlaneGrantPayloadV3(payload),
        CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
      )
      .trim();
    const forgedUpdate = withRecordDigest({ ...update, envelope });
    writeCanonicalFixtureRecord(updatePath, forgedUpdate);

    const historyDirectory = `${fixture.stateRoot}/control-plane-supervisor-history`;
    const history = fs.readdirSync(historyDirectory).map((name) => ({
      path: `${historyDirectory}/${name}`,
      record: readCanonicalFixtureRecord(`${historyDirectory}/${name}`),
    }));
    const transition = history.find(
      ({ record }) =>
        record.kind === 'control-plane-supervisor-history-transition.v1' &&
        record.grantId === grantId,
    );
    const terminal = history.find(
      ({ record }) =>
        record.kind === 'control-plane-supervisor-history-terminal.v1' &&
        record.grantId === grantId,
    );
    assert.ok(transition);
    assert.ok(terminal);
    const grantEnvelopeDigest = canonicalFixtureDigest(envelope);
    const forgedTransition = withRecordDigest({
      ...transition.record,
      grantEnvelopeDigest,
    });
    const forgedTerminal = withRecordDigest({
      ...terminal.record,
      previousRecordDigest: forgedTransition.recordDigest,
      grantEnvelopeDigest,
      updateRecordDigest: forgedUpdate.recordDigest,
    });
    fs.unlinkSync(transition.path);
    fs.unlinkSync(terminal.path);
    writeCanonicalFixtureRecord(
      `${historyDirectory}/${forgedTransition.recordDigest.slice('sha256:'.length)}.json`,
      forgedTransition,
    );
    writeCanonicalFixtureRecord(
      `${historyDirectory}/${forgedTerminal.recordDigest.slice('sha256:'.length)}.json`,
      forgedTerminal,
    );

    assert.throws(
      () =>
        resolveControlPlaneEngineSelection(
          fixture.stateRoot,
          promoted.supervisor.repositoryId,
        ),
      /terminal promotion result/,
    );
  } finally {
    successor.cleanup();
    fixture.cleanup();
  }
});

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function approvalGrantId(candidateId: string): string {
  return `control-plane-approval-${candidateId.slice('sha256:'.length)}`;
}

function canonicalFixtureDigest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function withRecordDigest(
  value: Record<string, unknown>,
): Record<string, unknown> & { recordDigest: `sha256:${string}` } {
  const { recordDigest: _recordDigest, ...payload } = value;
  return { ...payload, recordDigest: canonicalFixtureDigest(payload) };
}

function readCanonicalFixtureRecord(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const value = JSON.parse(raw) as unknown;
  assert.equal(`${canonicalJson(value)}\n`, raw);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function writeCanonicalFixtureRecord(
  filePath: string,
  value: Record<string, unknown>,
): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function commit(label: string): string {
  return crypto.createHash('sha256').update(`commit:${label}`).digest('hex');
}
