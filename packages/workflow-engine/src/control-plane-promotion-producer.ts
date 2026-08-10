import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  bootstrapInterventionStateRoot,
  readInitialControlPlaneSupervisorAnchorEvidence,
  readBuiltInControlPlaneEngineArtifact,
  resolveControlPlaneEngineSelection,
} from '../bootstrap/control-plane-trust.ts';
import { canonicalJson, compareCanonicalStrings } from './canonical-json.ts';
import { ExitCode, workflowError, type ExitCodeValue } from './errors.ts';
import { discoverRepository, runGit, runGitBuffer } from './git.ts';
import {
  canonicalControlPlaneIndependentReviewAttestationPayloadV2,
  canonicalControlPlaneIndependentReviewAttestationPayloadV3,
  classifyProtectedCandidateImpactV2,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  controlPlaneCandidateDigestV2,
  controlPlanePromotionMaterialDigest,
  createControlPlanePromotionBundleV2,
  createControlPlanePromotionBundleV3,
  createControlPlanePromotionLineage,
  createControlPlanePromotionMaterial,
  createControlPlaneRecoveryBundleMaterial,
  normalizeControlPlaneTaskMandateBinding,
  type ControlPlaneIndependentReviewAttestationEnvelopeV2,
  type ControlPlaneIndependentReviewAttestationPayloadV2,
  type ControlPlaneIndependentReviewAttestationEnvelopeV3,
  type ControlPlaneIndependentReviewAttestationPayloadV3,
  type ControlPlanePromotionFileMaterial,
  type ExactControlPlaneChangeV2,
  type ProtectedCandidateImpact,
  type Sha256Digest,
} from './intervention-control.ts';
import {
  appendControlPlaneSupervisorHistoryRecord,
  controlPlaneSupervisorHistoryDirectory,
  createControlPlaneSupervisorHistoryAnchor,
  readControlPlaneSupervisorHistory,
  type VerifiedControlPlaneSupervisorHistory,
} from './control-plane-supervisor-history.ts';
import {
  findPersistedBootstrapSidecarSessionForIntervention,
  readPersistedControlPlaneUpdate,
  type PersistenceHumanSignatureVerifier,
} from './intervention-control-persistence.ts';
import {
  findPersistedControlPlaneApprovalCandidateV2ByMaterialDigestAndReviewer,
  findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer,
  persistControlPlaneApprovalCandidateV2,
  persistControlPlaneApprovalCandidateV3,
  readPersistedControlPlaneApprovalCandidateV2,
  readControlPlaneSupervisorState,
  type PersistedControlPlaneApprovalCandidateV2,
  type PersistedControlPlaneApprovalCandidateV3,
} from './intervention-control-updater.ts';
import { readInterventionEngineArtifact } from './intervention-maintenance.ts';
import {
  assertStoredCandidateSupportingArtifacts,
  readStoredImmutableCandidateBundle,
  type AnyImmutableCandidateBundle,
} from './maintainer-candidate.ts';
import type { MaintainerSignerProvider } from './maintainer-signer.ts';
import { loadProtectedCapabilitiesFromTrustBase } from './protected-capabilities.ts';

const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;

interface ExactGitFileState {
  path: string;
  mode: '100644' | '100755';
  objectId: string;
  content: Buffer;
  contentDigest: Sha256Digest;
}

interface DerivedFrozenCandidate {
  exactChanges: ExactControlPlaneChangeV2[];
  beforeFiles: ControlPlanePromotionFileMaterial[];
  afterFiles: ControlPlanePromotionFileMaterial[];
}

export interface ControlPlanePromotionReviewSummaryV2 {
  kind: 'control-plane-promotion-review-summary.v2';
  repositoryId: string;
  frozenCandidateBundleDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  affectedCapabilities: ProtectedCandidateImpact['affectedCapabilities'];
  candidateArtifactId: Sha256Digest;
  candidateExecutableProvenanceDigest: Sha256Digest;
  recoveryArtifactId: Sha256Digest;
  recoveryExecutableProvenanceDigest: Sha256Digest;
  rollbackTestReportDigest: Sha256Digest;
  behaviorChangeSummary: string;
  humanReadable: string;
}

export interface ControlPlanePromotionProducerDependencies {
  now?: () => Date;
  reviewSigner: MaintainerSignerProvider;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
  presentReviewSummary: (summary: ControlPlanePromotionReviewSummaryV2) => void;
}

export interface ControlPlanePromotionProducerResultV2 {
  kind: 'control-plane-promotion-producer-result.v2';
  action: 'produce-control-plane-approval-candidate';
  replayed: boolean;
  candidate: PersistedControlPlaneApprovalCandidateV2;
  summary: ControlPlanePromotionReviewSummaryV2;
}

export interface ControlPlanePromotionReviewSummaryV3 extends Omit<
  ControlPlanePromotionReviewSummaryV2,
  'kind' | 'humanReadable'
> {
  kind: 'control-plane-promotion-review-summary.v3';
  promotionLineageDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousSupervisorRecordDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  humanReadable: string;
}

export interface ControlPlanePromotionProducerDependenciesV3 extends Omit<
  ControlPlanePromotionProducerDependencies,
  'presentReviewSummary'
> {
  presentReviewSummary: (summary: ControlPlanePromotionReviewSummaryV3) => void;
}

export interface ControlPlanePromotionProducerResultV3 {
  kind: 'control-plane-promotion-producer-result.v3';
  action: 'produce-control-plane-approval-candidate';
  replayed: boolean;
  candidate: PersistedControlPlaneApprovalCandidateV3;
  summary: ControlPlanePromotionReviewSummaryV3;
}

/**
 * Produce the complete material-bound global promotion candidate from durable
 * repository state. The caller can name only a stored frozen candidate; Git
 * bytes, modes, closures, EngineArtifacts, executable provenance, rollback
 * evidence, review payload, and transaction identity are all recomputed here.
 */
export function produceControlPlaneApprovalCandidateV2(
  requestedRepositoryRoot: string,
  stateRoot: string,
  requestedCandidateBundleDigest: string,
  dependencies: ControlPlanePromotionProducerDependencies,
): ControlPlanePromotionProducerResultV2 {
  requireProducerDependencies(dependencies);
  const repository = discoverRepository(requestedRepositoryRoot);
  if (
    !path.isAbsolute(requestedRepositoryRoot) ||
    path.resolve(requestedRepositoryRoot) !== requestedRepositoryRoot ||
    fs.realpathSync(requestedRepositoryRoot) !== requestedRepositoryRoot ||
    requestedRepositoryRoot !== repository.repositoryRealPath ||
    repository.statusEntries.length !== 0
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_REPOSITORY_NOT_CLEAN',
      'Control-plane promotion material must be produced from the exact clean repository root.',
      ExitCode.conflict,
    );
  }
  assertProducerStateRoot(repository.gitCommonDirectory, stateRoot);
  const candidate = readStoredImmutableCandidateBundle(
    repository.gitCommonDirectory,
    requestedCandidateBundleDigest,
  );
  assertFrozenCandidatePrestate(repository, candidate);
  assertStoredCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    candidate.mandateBinding.changeId,
    candidate,
  );
  const derived = deriveFrozenCandidate(repository.repositoryRoot, candidate);
  const beforeManifest = loadProtectedCapabilitiesFromTrustBase(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
  );
  const afterManifest = loadProtectedCapabilitiesFromTrustBase(
    repository.repositoryRoot,
    candidate.candidateCommit,
  );
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest,
    afterManifest,
    changes: derived.exactChanges,
  });
  if (impact.class !== 'C') {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CLASSIFICATION_MISMATCH',
      'The frozen candidate does not recompute as a Class-C protected-capability change.',
      ExitCode.verification,
    );
  }

  const supervisor = readControlPlaneSupervisorState(stateRoot);
  if (
    supervisor.generation !== 1 ||
    supervisor.transition !== null ||
    supervisor.repositoryId !== candidate.repositoryId ||
    supervisor.activeArtifact.closureDigest !== beforeManifest.manifestDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_INITIAL_SUPERVISOR_MISMATCH',
      'The producer requires the exact generation-one supervisor selecting the candidate trust base.',
      ExitCode.staleState,
    );
  }
  const restartArtifact = readBuiltInControlPlaneEngineArtifact(stateRoot);
  if (
    restartArtifact.artifactId !== supervisor.activeArtifact.artifactId ||
    restartArtifact.executableDigest !==
      supervisor.activeArtifact.executableDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_RECOVERY_ARTIFACT_MISMATCH',
      'The built-in recovery EngineArtifact differs from generation one.',
      ExitCode.verification,
    );
  }

  const sidecar = findPersistedBootstrapSidecarSessionForIntervention(
    stateRoot,
    candidate.mandateBinding.changeId,
  );
  if (sidecar.artifacts.length !== 1) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_SELECTION_AMBIGUOUS',
      'A frozen global promotion requires exactly one durable sidecar EngineArtifact; caller-selected artifacts are forbidden.',
      ExitCode.conflict,
    );
  }
  const sidecarArtifact = sidecar.artifacts[0]!;
  const candidateArtifactRecord = readInterventionEngineArtifact(
    stateRoot,
    sidecarArtifact.artifactId,
  );
  if (
    sidecarArtifact.evidenceDigest !== candidateArtifactRecord.recordDigest ||
    sidecarArtifact.sourceDigest !==
      candidateArtifactRecord.artifact.sourceDigest ||
    sidecarArtifact.executableDigest !==
      candidateArtifactRecord.artifact.executableDigest ||
    candidateArtifactRecord.interventionChangeId !==
      candidate.mandateBinding.changeId
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_BINDING_MISMATCH',
      'The durable sidecar does not bind the exact candidate EngineArtifact record.',
      ExitCode.verification,
    );
  }
  const expectedArtifactSourceDigest = frozenCandidateSourceDigest(
    candidate.expectedOldCommit,
    derived.exactChanges,
  );
  if (
    candidateArtifactRecord.artifact.sourceDigest !==
    expectedArtifactSourceDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
      'The candidate EngineArtifact source snapshot does not match the exact frozen Class-C diff.',
      ExitCode.verification,
    );
  }

  const candidateExecutable = readStableExecutable(
    candidateArtifactRecord.executablePath,
    candidateArtifactRecord.artifact.executableDigest,
  );
  const restartExecutable = readStableExecutable(
    supervisor.activeArtifact.executablePath,
    restartArtifact.executableDigest,
  );
  const candidateSelfTest = runControlPlaneProbe(
    candidateArtifactRecord.executablePath,
    candidateArtifactRecord.artifact.executableDigest,
    '--control-plane-self-test',
    {
      kind: 'control-plane-self-test.v1',
      property: 'healthy',
      closureDigest: afterManifest.manifestDigest,
    },
  );
  const restartProbe = runControlPlaneProbe(
    supervisor.activeArtifact.executablePath,
    restartArtifact.executableDigest,
    '--control-plane-restart-probe',
    {
      kind: 'control-plane-restart.v1',
      property: 'ready',
      closureDigest: beforeManifest.manifestDigest,
    },
  );
  assertExecutableUnchanged(
    candidateArtifactRecord.executablePath,
    candidateExecutable,
    candidateArtifactRecord.artifact.executableDigest,
  );
  assertExecutableUnchanged(
    supervisor.activeArtifact.executablePath,
    restartExecutable,
    restartArtifact.executableDigest,
  );
  const rollbackReport = Buffer.from(
    `${canonicalJson({
      kind: 'control-plane-rollback-test-report.v2',
      candidate: {
        artifactId: candidateArtifactRecord.artifact.artifactId,
        executableDigest: candidateArtifactRecord.artifact.executableDigest,
        expectedClosureDigest: afterManifest.manifestDigest,
        response: candidateSelfTest,
      },
      recovery: {
        artifactId: restartArtifact.artifactId,
        executableDigest: restartArtifact.executableDigest,
        expectedClosureDigest: beforeManifest.manifestDigest,
        response: restartProbe,
      },
    })}\n`,
  );
  const rollbackTestReportDigest = rawDigest(rollbackReport);
  const recoveryBundle = createControlPlaneRecoveryBundleMaterial({
    repositoryId: candidate.repositoryId,
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact,
    restartExecutableBase64: restartExecutable.toString('base64'),
    restartExecutableProvenanceDigest: supervisor.recordDigest,
    previousFiles: derived.beforeFiles,
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest,
  });
  const mandateBinding = normalizeControlPlaneTaskMandateBinding({
    schemaVersion: candidate.mandateBinding.schemaVersion,
    parentTaskId: candidate.mandateBinding.mandateTaskId,
    mandateId: candidate.mandateBinding.mandateId,
    mandateDigest: candidate.mandateBinding.mandateDigest,
    changeId: candidate.mandateBinding.changeId,
    externalAuditRoot: candidate.mandateBinding.externalAuditRoot,
  });
  const behaviorChangeSummary =
    `Frozen Class-C candidate ${candidate.candidateBundleDigest} changes ` +
    `${derived.exactChanges.length} exact Git paths and affects ` +
    `${impact.affectedCapabilities.join(', ')}.`;
  const material = createControlPlanePromotionMaterial({
    mandateBinding,
    repositoryId: candidate.repositoryId,
    frozenCandidateBundleDigest: prefixedCandidateDigest(
      candidate.candidateBundleDigest,
    ),
    candidateDigest: controlPlaneCandidateDigestV2(derived.exactChanges),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    affectedCapabilities: impact.affectedCapabilities,
    behaviorChangeSummary,
    exactChanges: derived.exactChanges,
    candidateArtifact: candidateArtifactRecord.artifact,
    candidateExecutableBase64: candidateExecutable.toString('base64'),
    candidateExecutableProvenanceDigest: candidateArtifactRecord.recordDigest,
    candidateFiles: derived.afterFiles,
    recoveryBundle,
  });
  const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
  const summary = promotionReviewSummary(
    material,
    promotionMaterialDigest,
    rollbackTestReportDigest,
  );
  // Reading the configured public identity is non-authorizing and lets an
  // exact prior ceremony replay without another prompt or signature. New
  // ceremonies re-read it after human presence to detect provider drift.
  const replayReviewer = reviewerIdentity(dependencies.reviewSigner.identity());
  const existing =
    findPersistedControlPlaneApprovalCandidateV2ByMaterialDigestAndReviewer(
      stateRoot,
      promotionMaterialDigest,
      replayReviewer,
    );
  if (existing !== null) {
    const review = existing.bundle.independentReviewAttestation;
    if (
      !verifySignatureSafely(
        dependencies.verifyHumanSignature,
        canonicalControlPlaneIndependentReviewAttestationPayloadV2(
          review.payload,
        ),
        review.signature,
        replayReviewer,
        CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
      )
    ) {
      throw producerError(
        'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
        'The persisted independent review signature could not be verified for replay.',
        ExitCode.verification,
      );
    }
    return Object.freeze({
      kind: 'control-plane-promotion-producer-result.v2' as const,
      action: 'produce-control-plane-approval-candidate' as const,
      replayed: true,
      candidate: existing,
      summary,
    });
  }

  // The exact unsigned material is displayed before any signing operation.
  dependencies.presentReviewSummary(summary);
  dependencies.reviewSigner.assertHumanPresent();
  const reviewer = reviewerIdentity(dependencies.reviewSigner.identity());
  if (reviewer !== replayReviewer) {
    throw producerError(
      'CONTROL_PLANE_REVIEWER_IDENTITY_DRIFT',
      'The configured reviewer identity changed during the review ceremony.',
      ExitCode.staleState,
    );
  }
  const reviewedAt = producerNow(dependencies).toISOString();
  const reviewPayload: ControlPlaneIndependentReviewAttestationPayloadV2 = {
    kind: 'control-plane-independent-review.v2',
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    candidateDigest: material.candidateDigest,
    promotionMaterialDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    recoveryBundleDigest: material.recoveryBundle.bundleDigest,
    affectedCapabilities: [...material.affectedCapabilities],
    verdict: 'approved',
    reviewedAt,
    reviewSummary:
      'Independent reviewer approved the exact frozen promotion, executable provenance, and rollback-test evidence.',
    reviewer,
  };
  const signature = dependencies.reviewSigner
    .sign(
      canonicalControlPlaneIndependentReviewAttestationPayloadV2(reviewPayload),
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
    )
    .trim();
  if (
    !verifySignatureSafely(
      dependencies.verifyHumanSignature,
      canonicalControlPlaneIndependentReviewAttestationPayloadV2(reviewPayload),
      signature,
      reviewer,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
    )
  ) {
    throw producerError(
      'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
      'The independently produced review signature could not be verified.',
      ExitCode.verification,
    );
  }
  const review: ControlPlaneIndependentReviewAttestationEnvelopeV2 = {
    payload: reviewPayload,
    signature,
  };
  const bundle = createControlPlanePromotionBundleV2({
    material,
    independentReviewAttestation: review,
  });
  const persisted = persistControlPlaneApprovalCandidateV2(
    stateRoot,
    {
      txId: `control-plane-promotion-${bundle.bundleDigest.slice('sha256:'.length)}`,
      mandateBinding,
      beforeManifest,
      afterManifest,
      bundle,
    },
    new Date(reviewedAt),
  );
  return Object.freeze({
    kind: 'control-plane-promotion-producer-result.v2' as const,
    action: 'produce-control-plane-approval-candidate' as const,
    replayed: false,
    candidate: persisted,
    summary,
  });
}

/**
 * Produce a lineage-bound promotion candidate. V3 authority is derived from
 * the unique durable supervisor-history leaf; callers still name only the
 * stored frozen candidate and cannot supply predecessor or generation data.
 */
export function produceControlPlaneApprovalCandidateV3(
  requestedRepositoryRoot: string,
  stateRoot: string,
  requestedCandidateBundleDigest: string,
  dependencies: ControlPlanePromotionProducerDependenciesV3,
): ControlPlanePromotionProducerResultV3 {
  requireProducerDependencies(dependencies);
  const repository = discoverRepository(requestedRepositoryRoot);
  if (
    !path.isAbsolute(requestedRepositoryRoot) ||
    path.resolve(requestedRepositoryRoot) !== requestedRepositoryRoot ||
    fs.realpathSync(requestedRepositoryRoot) !== requestedRepositoryRoot ||
    requestedRepositoryRoot !== repository.repositoryRealPath ||
    repository.statusEntries.length !== 0
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_REPOSITORY_NOT_CLEAN',
      'Control-plane promotion material must be produced from the exact clean repository root.',
      ExitCode.conflict,
    );
  }
  assertProducerStateRoot(repository.gitCommonDirectory, stateRoot);
  const candidate = readStoredImmutableCandidateBundle(
    repository.gitCommonDirectory,
    requestedCandidateBundleDigest,
  );
  assertFrozenCandidatePrestate(repository, candidate);
  assertStoredCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    candidate.mandateBinding.changeId,
    candidate,
  );
  const derived = deriveFrozenCandidate(repository.repositoryRoot, candidate);
  const beforeManifest = loadProtectedCapabilitiesFromTrustBase(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
  );
  const afterManifest = loadProtectedCapabilitiesFromTrustBase(
    repository.repositoryRoot,
    candidate.candidateCommit,
  );
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest,
    afterManifest,
    changes: derived.exactChanges,
  });
  if (impact.class !== 'C') {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CLASSIFICATION_MISMATCH',
      'The frozen candidate does not recompute as a Class-C protected-capability change.',
      ExitCode.verification,
    );
  }

  const supervisor = readControlPlaneSupervisorState(stateRoot);
  if (supervisor.repositoryId !== candidate.repositoryId) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_SUPERVISOR_MISMATCH',
      'The supervisor repository identity differs from the frozen candidate.',
      ExitCode.staleState,
    );
  }
  const authority = ensureTerminalSupervisorHistory(
    repository.gitCommonDirectory,
    stateRoot,
    supervisor,
    candidate.expectedOldCommit,
  );
  const { history, restartArtifact } = authority;
  if (
    history.leaf.recordDigest !== history.records.at(-1)?.recordDigest ||
    history.generation !== supervisor.generation ||
    history.supervisorRecordDigest !== supervisor.recordDigest ||
    history.activeTrustCommit !== candidate.expectedOldCommit ||
    history.activeArtifact.artifactId !==
      supervisor.activeArtifact.artifactId ||
    history.activeArtifact.executableDigest !==
      supervisor.activeArtifact.executableDigest ||
    history.activeArtifact.closureDigest !==
      supervisor.activeArtifact.closureDigest ||
    supervisor.activeArtifact.closureDigest !== beforeManifest.manifestDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
      'The frozen candidate does not extend the exact terminal supervisor history leaf.',
      ExitCode.staleState,
    );
  }
  if (
    restartArtifact.artifactId !== supervisor.activeArtifact.artifactId ||
    restartArtifact.executableDigest !==
      supervisor.activeArtifact.executableDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_SUCCESSOR_ARTIFACT_UNAVAILABLE',
      'The terminal supervisor history does not resolve the exact active recovery artifact.',
      ExitCode.staleState,
    );
  }

  const sidecar = findPersistedBootstrapSidecarSessionForIntervention(
    stateRoot,
    candidate.mandateBinding.changeId,
  );
  if (sidecar.artifacts.length !== 1) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_SELECTION_AMBIGUOUS',
      'A frozen global promotion requires exactly one durable sidecar EngineArtifact; caller-selected artifacts are forbidden.',
      ExitCode.conflict,
    );
  }
  const sidecarArtifact = sidecar.artifacts[0]!;
  const candidateArtifactRecord = readInterventionEngineArtifact(
    stateRoot,
    sidecarArtifact.artifactId,
  );
  if (
    sidecarArtifact.evidenceDigest !== candidateArtifactRecord.recordDigest ||
    sidecarArtifact.sourceDigest !==
      candidateArtifactRecord.artifact.sourceDigest ||
    sidecarArtifact.executableDigest !==
      candidateArtifactRecord.artifact.executableDigest ||
    candidateArtifactRecord.interventionChangeId !==
      candidate.mandateBinding.changeId
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_BINDING_MISMATCH',
      'The durable sidecar does not bind the exact candidate EngineArtifact record.',
      ExitCode.verification,
    );
  }
  const expectedArtifactSourceDigest = frozenCandidateSourceDigest(
    candidate.expectedOldCommit,
    derived.exactChanges,
  );
  if (
    candidateArtifactRecord.artifact.sourceDigest !==
    expectedArtifactSourceDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
      'The candidate EngineArtifact source snapshot does not match the exact frozen Class-C diff.',
      ExitCode.verification,
    );
  }

  const candidateExecutable = readStableExecutable(
    candidateArtifactRecord.executablePath,
    candidateArtifactRecord.artifact.executableDigest,
  );
  const restartExecutable = readStableExecutable(
    supervisor.activeArtifact.executablePath,
    restartArtifact.executableDigest,
  );
  const candidateSelfTest = runControlPlaneProbe(
    candidateArtifactRecord.executablePath,
    candidateArtifactRecord.artifact.executableDigest,
    '--control-plane-self-test',
    {
      kind: 'control-plane-self-test.v1',
      property: 'healthy',
      closureDigest: afterManifest.manifestDigest,
    },
  );
  const restartProbe = runControlPlaneProbe(
    supervisor.activeArtifact.executablePath,
    restartArtifact.executableDigest,
    '--control-plane-restart-probe',
    {
      kind: 'control-plane-restart.v1',
      property: 'ready',
      closureDigest: beforeManifest.manifestDigest,
    },
  );
  assertExecutableUnchanged(
    candidateArtifactRecord.executablePath,
    candidateExecutable,
    candidateArtifactRecord.artifact.executableDigest,
  );
  assertExecutableUnchanged(
    supervisor.activeArtifact.executablePath,
    restartExecutable,
    restartArtifact.executableDigest,
  );
  const rollbackReport = Buffer.from(
    `${canonicalJson({
      kind: 'control-plane-rollback-test-report.v3',
      candidate: {
        artifactId: candidateArtifactRecord.artifact.artifactId,
        executableDigest: candidateArtifactRecord.artifact.executableDigest,
        expectedClosureDigest: afterManifest.manifestDigest,
        response: candidateSelfTest,
      },
      recovery: {
        artifactId: restartArtifact.artifactId,
        executableDigest: restartArtifact.executableDigest,
        expectedClosureDigest: beforeManifest.manifestDigest,
        response: restartProbe,
      },
    })}\n`,
  );
  const rollbackTestReportDigest = rawDigest(rollbackReport);
  const recoveryBundle = createControlPlaneRecoveryBundleMaterial({
    repositoryId: candidate.repositoryId,
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact,
    restartExecutableBase64: restartExecutable.toString('base64'),
    restartExecutableProvenanceDigest: supervisor.recordDigest,
    previousFiles: derived.beforeFiles,
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest,
  });
  const mandateBinding = normalizeControlPlaneTaskMandateBinding({
    schemaVersion: candidate.mandateBinding.schemaVersion,
    parentTaskId: candidate.mandateBinding.mandateTaskId,
    mandateId: candidate.mandateBinding.mandateId,
    mandateDigest: candidate.mandateBinding.mandateDigest,
    changeId: candidate.mandateBinding.changeId,
    externalAuditRoot: candidate.mandateBinding.externalAuditRoot,
  });
  const behaviorChangeSummary =
    `Frozen Class-C candidate ${candidate.candidateBundleDigest} changes ` +
    `${derived.exactChanges.length} exact Git paths and affects ` +
    `${impact.affectedCapabilities.join(', ')}.`;
  const material = createControlPlanePromotionMaterial({
    mandateBinding,
    repositoryId: candidate.repositoryId,
    frozenCandidateBundleDigest: prefixedCandidateDigest(
      candidate.candidateBundleDigest,
    ),
    candidateDigest: controlPlaneCandidateDigestV2(derived.exactChanges),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    affectedCapabilities: impact.affectedCapabilities,
    behaviorChangeSummary,
    exactChanges: derived.exactChanges,
    candidateArtifact: candidateArtifactRecord.artifact,
    candidateExecutableBase64: candidateExecutable.toString('base64'),
    candidateExecutableProvenanceDigest: candidateArtifactRecord.recordDigest,
    candidateFiles: derived.afterFiles,
    recoveryBundle,
  });
  const lineage = createControlPlanePromotionLineage({
    historyAnchorDigest: history.anchor.recordDigest,
    previousTerminalRecordDigest: history.leaf.recordDigest,
    previousSupervisorRecordDigest: supervisor.recordDigest,
    previousGeneration: supervisor.generation,
    candidateGeneration: supervisor.generation + 1,
    rollbackGeneration: supervisor.generation + 2,
    previousActiveTrustCommit: history.activeTrustCommit,
    candidateTrustCommit: candidate.candidateCommit,
  });
  const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
  const baseSummary = promotionReviewSummary(
    material,
    promotionMaterialDigest,
    rollbackTestReportDigest,
  );
  const summary = Object.freeze({
    ...baseSummary,
    kind: 'control-plane-promotion-review-summary.v3' as const,
    promotionLineageDigest: lineage.lineageDigest,
    previousGeneration: lineage.previousGeneration,
    candidateGeneration: lineage.candidateGeneration,
    rollbackGeneration: lineage.rollbackGeneration,
    previousSupervisorRecordDigest: lineage.previousSupervisorRecordDigest,
    previousTerminalRecordDigest: lineage.previousTerminalRecordDigest,
    humanReadable: [
      'Successive control-plane promotion review v3',
      `Lineage: ${lineage.lineageDigest}`,
      `History anchor: ${lineage.historyAnchorDigest}`,
      `Previous terminal: ${lineage.previousTerminalRecordDigest}`,
      `Supervisor generation: ${lineage.previousGeneration} -> ${lineage.candidateGeneration}`,
      baseSummary.humanReadable,
    ].join('\n'),
  });
  const replayReviewer = reviewerIdentity(dependencies.reviewSigner.identity());
  const existing =
    findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer(
      stateRoot,
      promotionMaterialDigest,
      lineage.lineageDigest,
      replayReviewer,
    );
  if (existing !== null) {
    const review = existing.bundle.independentReviewAttestation;
    if (
      !verifySignatureSafely(
        dependencies.verifyHumanSignature,
        canonicalControlPlaneIndependentReviewAttestationPayloadV3(
          review.payload,
        ),
        review.signature,
        replayReviewer,
        CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
      )
    ) {
      throw producerError(
        'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
        'The persisted successor review signature could not be verified for replay.',
        ExitCode.verification,
      );
    }
    return Object.freeze({
      kind: 'control-plane-promotion-producer-result.v3' as const,
      action: 'produce-control-plane-approval-candidate' as const,
      replayed: true,
      candidate: existing,
      summary,
    });
  }

  dependencies.presentReviewSummary(summary);
  dependencies.reviewSigner.assertHumanPresent();
  const reviewer = reviewerIdentity(dependencies.reviewSigner.identity());
  if (reviewer !== replayReviewer) {
    throw producerError(
      'CONTROL_PLANE_REVIEWER_IDENTITY_DRIFT',
      'The configured reviewer identity changed during the review ceremony.',
      ExitCode.staleState,
    );
  }
  const reviewedAt = producerNow(dependencies).toISOString();
  const reviewPayload: ControlPlaneIndependentReviewAttestationPayloadV3 = {
    kind: 'control-plane-independent-review.v3',
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    candidateDigest: material.candidateDigest,
    promotionMaterialDigest,
    promotionLineageDigest: lineage.lineageDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    recoveryBundleDigest: material.recoveryBundle.bundleDigest,
    affectedCapabilities: [...material.affectedCapabilities],
    verdict: 'approved',
    reviewedAt,
    reviewSummary:
      'Independent reviewer approved the exact successor material, predecessor lineage, and recovery evidence.',
    reviewer,
  };
  const signature = dependencies.reviewSigner
    .sign(
      canonicalControlPlaneIndependentReviewAttestationPayloadV3(reviewPayload),
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
    )
    .trim();
  if (
    !verifySignatureSafely(
      dependencies.verifyHumanSignature,
      canonicalControlPlaneIndependentReviewAttestationPayloadV3(reviewPayload),
      signature,
      reviewer,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
    )
  ) {
    throw producerError(
      'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
      'The independently produced successor review signature could not be verified.',
      ExitCode.verification,
    );
  }
  const review: ControlPlaneIndependentReviewAttestationEnvelopeV3 = {
    payload: reviewPayload,
    signature,
  };
  const bundle = createControlPlanePromotionBundleV3({
    material,
    lineage,
    independentReviewAttestation: review,
  });
  const persisted = persistControlPlaneApprovalCandidateV3(
    stateRoot,
    {
      txId: `control-plane-successor-${bundle.bundleDigest.slice('sha256:'.length)}`,
      mandateBinding,
      beforeManifest,
      afterManifest,
      bundle,
    },
    new Date(reviewedAt),
  );
  return Object.freeze({
    kind: 'control-plane-promotion-producer-result.v3' as const,
    action: 'produce-control-plane-approval-candidate' as const,
    replayed: false,
    candidate: persisted,
    summary,
  });
}

function ensureTerminalSupervisorHistory(
  gitCommonDirectory: string,
  stateRoot: string,
  supervisor: ReturnType<typeof readControlPlaneSupervisorState>,
  expectedActiveTrustCommit: string,
): {
  history: VerifiedControlPlaneSupervisorHistory;
  restartArtifact: ReturnType<typeof readBuiltInControlPlaneEngineArtifact>;
} {
  const directory = controlPlaneSupervisorHistoryDirectory(stateRoot);
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
    const history = readControlPlaneSupervisorHistory(stateRoot);
    if (supervisor.generation === 1) {
      return {
        history,
        restartArtifact: readBuiltInControlPlaneEngineArtifact(stateRoot),
      };
    }
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_ARTIFACT_UNAVAILABLE',
      'A non-initial history leaf must resolve its active artifact through a terminal update record.',
      ExitCode.staleState,
    );
  }
  if (supervisor.generation !== 1 || supervisor.transition !== null) {
    return createLegacyV2SupervisorHistoryAnchor(
      gitCommonDirectory,
      stateRoot,
      supervisor,
      expectedActiveTrustCommit,
    );
  }
  const evidence = readInitialControlPlaneSupervisorAnchorEvidence(
    stateRoot,
    supervisor.repositoryId,
  );
  if (
    evidence.activeTrustCommit !== expectedActiveTrustCommit ||
    evidence.supervisorRecordDigest !== supervisor.recordDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
      'Initial bootstrap evidence does not bind the frozen candidate trust base.',
      ExitCode.staleState,
    );
  }
  const anchor = createControlPlaneSupervisorHistoryAnchor({
    repositoryId: supervisor.repositoryId,
    generation: 1,
    supervisorRecordDigest: supervisor.recordDigest,
    activeArtifact: evidence.activeArtifact,
    activeTrustCommit: evidence.activeTrustCommit,
    authority: {
      kind: 'initial-bootstrap-anchor.v1',
      initialBootstrapPublishedDigest: evidence.publishedRecordDigest,
    },
    recordedAt: evidence.recordedAt,
  });
  appendControlPlaneSupervisorHistoryRecord(stateRoot, anchor);
  return {
    history: readControlPlaneSupervisorHistory(stateRoot),
    restartArtifact: readBuiltInControlPlaneEngineArtifact(stateRoot),
  };
}

function createLegacyV2SupervisorHistoryAnchor(
  gitCommonDirectory: string,
  stateRoot: string,
  supervisor: ReturnType<typeof readControlPlaneSupervisorState>,
  expectedActiveTrustCommit: string,
): {
  history: VerifiedControlPlaneSupervisorHistory;
  restartArtifact: ReturnType<typeof readBuiltInControlPlaneEngineArtifact>;
} {
  const transition = supervisor.transition;
  if (
    transition === null ||
    (supervisor.generation !== 2 && supervisor.generation !== 3)
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_REQUIRED',
      'A successor supervisor requires an existing verified history anchor.',
      ExitCode.staleState,
    );
  }
  // This invokes the bootstrap-owned V2 verifier before any legacy terminal is
  // promoted into a V3 history anchor.
  if (
    resolveControlPlaneEngineSelection(stateRoot, supervisor.repositoryId) ===
    null
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
      'The legacy V2 supervisor is not independently executable authority.',
      ExitCode.verification,
    );
  }
  const record = readPersistedControlPlaneUpdate(stateRoot, transition.grantId);
  if (
    record.kind !== 'persisted-control-plane-update.v2' ||
    record.grantState !== 'consumed' ||
    record.transaction.txId !== transition.txId ||
    (record.transaction.state !== 'FINALIZED' &&
      record.transaction.state !== 'ROLLED_BACK')
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
      'The legacy V2 update is not the exact terminal supervisor authority.',
      ExitCode.verification,
    );
  }
  const candidate = readPersistedControlPlaneApprovalCandidateV2(
    stateRoot,
    record.envelope.payload.promotionBundleDigest,
  );
  const material = candidate.bundle.material;
  const restartArtifact =
    record.transaction.state === 'FINALIZED'
      ? material.candidateArtifact
      : material.recoveryBundle.restartArtifact;
  const initial = readInitialControlPlaneSupervisorAnchorEvidence(
    stateRoot,
    supervisor.repositoryId,
  );
  const activeTrustCommit =
    record.transaction.state === 'FINALIZED'
      ? readStoredImmutableCandidateBundle(
          gitCommonDirectory,
          material.frozenCandidateBundleDigest.slice('sha256:'.length),
        ).candidateCommit
      : initial.activeTrustCommit;
  if (
    activeTrustCommit !== expectedActiveTrustCommit ||
    restartArtifact.artifactId !== supervisor.activeArtifact.artifactId ||
    restartArtifact.executableDigest !==
      supervisor.activeArtifact.executableDigest ||
    supervisor.activeArtifact.closureDigest !==
      (record.transaction.state === 'FINALIZED'
        ? material.afterClosureDigest
        : material.beforeClosureDigest)
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
      'The legacy V2 terminal artifact or trust commit differs from the successor prestate.',
      ExitCode.staleState,
    );
  }
  const anchor = createControlPlaneSupervisorHistoryAnchor({
    repositoryId: supervisor.repositoryId,
    generation: supervisor.generation,
    supervisorRecordDigest: supervisor.recordDigest,
    activeArtifact: {
      artifactId: supervisor.activeArtifact.artifactId,
      executableDigest: supervisor.activeArtifact.executableDigest,
      closureDigest: supervisor.activeArtifact.closureDigest,
    },
    activeTrustCommit,
    authority: {
      kind: 'legacy-v2-terminal-anchor.v1',
      initialBootstrapPublishedDigest: initial.publishedRecordDigest,
      grantId: transition.grantId,
      txId: transition.txId,
      terminalState: record.transaction.state,
      updateRecordDigest: record.recordDigest,
      transactionJournalDigest: record.transaction.journalDigest,
      grantEnvelopeDigest: rawDigest(canonicalJson(record.envelope)),
      promotionBundleDigest: candidate.bundle.bundleDigest,
    },
    recordedAt: record.updatedAt,
  });
  appendControlPlaneSupervisorHistoryRecord(stateRoot, anchor);
  return {
    history: readControlPlaneSupervisorHistory(stateRoot),
    restartArtifact,
  };
}

function assertFrozenCandidatePrestate(
  repository: ReturnType<typeof discoverRepository>,
  candidate: AnyImmutableCandidateBundle,
): void {
  const expectedTargetRef =
    repository.branch === null ? null : `refs/heads/${repository.branch}`;
  if (
    candidate.classification !== 'control-plane' ||
    candidate.manifest.trustBaseCommit !== candidate.expectedOldCommit ||
    repository.head !== candidate.expectedOldCommit ||
    candidate.targetRef !== expectedTargetRef
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_FROZEN_CANDIDATE_MISMATCH',
      'Production material requires a frozen Class-C candidate for the exact clean HEAD and target ref.',
      ExitCode.staleState,
    );
  }
  const tree = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${candidate.candidateCommit}^{tree}`,
  ]).trim();
  const parents = runGit(repository.repositoryRoot, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    candidate.candidateCommit,
  ])
    .trim()
    .split(/\s+/)
    .slice(1);
  const message = readGitCommitMessage(
    repository.repositoryRoot,
    candidate.candidateCommit,
  );
  if (
    tree !== candidate.resultTree ||
    canonicalJson(parents) !== canonicalJson([candidate.expectedOldCommit]) ||
    message !== candidate.commitMessage
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CANDIDATE_COMMIT_MISMATCH',
      'The frozen candidate commit does not bind the claimed tree, parent, and message.',
      ExitCode.verification,
    );
  }
}

function assertProducerStateRoot(
  gitCommonDirectory: string,
  stateRoot: string,
): void {
  const expected = bootstrapInterventionStateRoot(gitCommonDirectory);
  const stats =
    typeof stateRoot === 'string'
      ? fs.lstatSync(stateRoot, { throwIfNoEntry: false })
      : undefined;
  if (
    typeof stateRoot !== 'string' ||
    !path.isAbsolute(stateRoot) ||
    path.resolve(stateRoot) !== stateRoot ||
    stateRoot !== expected ||
    (stats !== undefined &&
      (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(stateRoot) !== stateRoot))
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH',
      'Control-plane producer state must be the bootstrap-derived store for the exact repository.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function readGitCommitMessage(
  repositoryRoot: string,
  candidateCommit: string,
): string {
  const commit = runGitBuffer(repositoryRoot, [
    'cat-file',
    'commit',
    candidateCommit,
  ]);
  const separator = commit.indexOf(Buffer.from('\n\n'));
  if (separator < 0) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CANDIDATE_COMMIT_MISMATCH',
      'The frozen candidate commit object has no canonical message boundary.',
      ExitCode.verification,
    );
  }
  return commit.subarray(separator + 2).toString('utf8');
}

function deriveFrozenCandidate(
  repositoryRoot: string,
  candidate: AnyImmutableCandidateBundle,
): DerivedFrozenCandidate {
  const changedPaths = runGitBuffer(repositoryRoot, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    candidate.expectedOldCommit,
    candidate.candidateCommit,
    '--',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort(compareCanonicalStrings);
  const manifestPaths = candidate.manifest.files.map(
    ({ path: filePath }) => filePath,
  );
  if (canonicalJson(changedPaths) !== canonicalJson(manifestPaths)) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_EXACT_DIFF_MISMATCH',
      'The candidate commit changed paths differ from the frozen patch manifest.',
      ExitCode.verification,
    );
  }
  const exactChanges: ExactControlPlaneChangeV2[] = [];
  const beforeFiles: ControlPlanePromotionFileMaterial[] = [];
  const afterFiles: ControlPlanePromotionFileMaterial[] = [];
  for (const manifestFile of candidate.manifest.files) {
    const before = readGitFileState(
      repositoryRoot,
      candidate.expectedOldCommit,
      manifestFile.path,
    );
    const after = readGitFileState(
      repositoryRoot,
      candidate.candidateCommit,
      manifestFile.path,
    );
    const operation =
      before === null ? 'add' : after === null ? 'delete' : 'modify';
    if (
      operation !== manifestFile.operation ||
      (before?.objectId ?? null) !== manifestFile.beforeBlobOid ||
      (before?.mode ?? null) !== manifestFile.beforeMode ||
      (after?.contentDigest.slice('sha256:'.length) ?? null) !==
        manifestFile.afterSha256 ||
      (after?.mode ?? null) !== manifestFile.afterMode
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_EXACT_DIFF_MISMATCH',
        `Git object bytes or modes for ${manifestFile.path} differ from the frozen patch manifest.`,
        ExitCode.verification,
      );
    }
    exactChanges.push({
      path: manifestFile.path,
      beforeDigest: before?.contentDigest ?? null,
      afterDigest: after?.contentDigest ?? null,
      beforeMode: before?.mode ?? null,
      afterMode: after?.mode ?? null,
    });
    if (before !== null) beforeFiles.push(promotionFile(before));
    if (after !== null) afterFiles.push(promotionFile(after));
  }
  return {
    exactChanges,
    beforeFiles,
    afterFiles,
  };
}

function frozenCandidateSourceDigest(
  expectedOldCommit: string,
  changes: ExactControlPlaneChangeV2[],
): Sha256Digest {
  const entries = [...changes]
    .sort((left, right) => compareCanonicalStrings(left.path, right.path))
    .map((change) => {
      if (change.afterDigest === null) {
        if (change.afterMode !== null) {
          throw producerError(
            'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
            'Deleted candidate source entry unexpectedly retains a Git mode.',
            ExitCode.verification,
          );
        }
        return { path: change.path, kind: 'deleted' as const };
      }
      if (change.afterMode === null) {
        throw producerError(
          'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
          'Candidate source entry is missing its exact Git mode.',
          ExitCode.verification,
        );
      }
      return {
        path: change.path,
        kind: 'file' as const,
        mode: change.afterMode,
        contentDigest: change.afterDigest,
      };
    });
  return rawDigest(
    canonicalJson({
      kind: 'intervention-engine-source-snapshot.v1',
      head: expectedOldCommit,
      entries,
    }),
  );
}

function readGitFileState(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): ExactGitFileState | null {
  const output = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${filePath}`,
  ]);
  if (output.length === 0) return null;
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (records.length !== 1) throw gitMaterialInvalid(filePath);
  const match = /^(\d{6}) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(
    records[0]!,
  );
  if (
    match === null ||
    match[3] !== filePath ||
    (match[1] !== '100644' && match[1] !== '100755')
  ) {
    throw gitMaterialInvalid(filePath);
  }
  const content = runGitBuffer(repositoryRoot, ['cat-file', 'blob', match[2]!]);
  return {
    path: filePath,
    mode: match[1] as '100644' | '100755',
    objectId: match[2]!,
    content,
    contentDigest: rawDigest(content),
  };
}

function promotionFile(
  state: ExactGitFileState,
): ControlPlanePromotionFileMaterial {
  return {
    path: state.path,
    mode: state.mode,
    contentBase64: state.content.toString('base64'),
    contentDigest: state.contentDigest,
  };
}

function readStableExecutable(
  executablePath: string,
  expectedDigest: Sha256Digest,
): Buffer {
  const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > MAX_EXECUTABLE_BYTES ||
    (stats.mode & 0o111) === 0
  ) {
    throw executableInvalid();
  }
  const content = fs.readFileSync(executablePath);
  if (rawDigest(content) !== expectedDigest) throw executableInvalid();
  return content;
}

function assertExecutableUnchanged(
  executablePath: string,
  expectedBytes: Buffer,
  expectedDigest: Sha256Digest,
): void {
  const observed = readStableExecutable(executablePath, expectedDigest);
  if (!observed.equals(expectedBytes)) throw executableInvalid();
}

function runControlPlaneProbe(
  executablePath: string,
  executableDigest: Sha256Digest,
  mode: '--control-plane-self-test' | '--control-plane-restart-probe',
  expected: {
    kind: 'control-plane-self-test.v1' | 'control-plane-restart.v1';
    property: 'healthy' | 'ready';
    closureDigest: Sha256Digest;
  },
): Record<string, unknown> {
  readStableExecutable(executablePath, executableDigest);
  const cwd = path.dirname(executablePath);
  const result = childProcess.spawnSync(executablePath, [mode], {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    windowsHide: true,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: cwd,
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw processEvidenceInvalid();
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw processEvidenceInvalid();
  }
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    Object.keys(response).sort().join(',') !==
      ['closureDigest', 'kind', expected.property].sort().join(',') ||
    (response as Record<string, unknown>).kind !== expected.kind ||
    (response as Record<string, unknown>)[expected.property] !== true ||
    (response as Record<string, unknown>).closureDigest !==
      expected.closureDigest
  ) {
    throw processEvidenceInvalid();
  }
  return response as Record<string, unknown>;
}

function promotionReviewSummary(
  material: ReturnType<typeof createControlPlanePromotionMaterial>,
  promotionMaterialDigest: Sha256Digest,
  rollbackTestReportDigest: Sha256Digest,
): ControlPlanePromotionReviewSummaryV2 {
  const humanReadable = [
    'Independent control-plane promotion review',
    `Repository: ${material.repositoryId}`,
    `Frozen Class-C candidate: ${material.frozenCandidateBundleDigest}`,
    `Promotion material: ${promotionMaterialDigest}`,
    `Candidate digest: ${material.candidateDigest}`,
    `Before closure: ${material.beforeClosureDigest}`,
    `After closure: ${material.afterClosureDigest}`,
    `Affected capabilities: ${material.affectedCapabilities.join(', ')}`,
    `Candidate EngineArtifact: ${material.candidateArtifact.artifactId}`,
    `Candidate executable provenance: ${material.candidateExecutableProvenanceDigest}`,
    `Recovery EngineArtifact: ${material.recoveryBundle.restartArtifact.artifactId}`,
    `Recovery executable provenance: ${material.recoveryBundle.restartExecutableProvenanceDigest}`,
    `Rollback-test evidence: ${rollbackTestReportDigest}`,
    `Behavior change: ${material.behaviorChangeSummary}`,
  ].join('\n');
  return Object.freeze({
    kind: 'control-plane-promotion-review-summary.v2' as const,
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    promotionMaterialDigest,
    candidateDigest: material.candidateDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    affectedCapabilities: [...material.affectedCapabilities],
    candidateArtifactId: material.candidateArtifact.artifactId,
    candidateExecutableProvenanceDigest:
      material.candidateExecutableProvenanceDigest,
    recoveryArtifactId: material.recoveryBundle.restartArtifact.artifactId,
    recoveryExecutableProvenanceDigest:
      material.recoveryBundle.restartExecutableProvenanceDigest,
    rollbackTestReportDigest,
    behaviorChangeSummary: material.behaviorChangeSummary,
    humanReadable,
  });
}

function producerNow(dependencies: { now?: () => Date }): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CLOCK_INVALID',
      'Control-plane producer clock is invalid.',
      ExitCode.usage,
    );
  }
  return new Date(now.getTime());
}

function requireProducerDependencies(dependencies: {
  reviewSigner: unknown;
  verifyHumanSignature: unknown;
  presentReviewSummary: unknown;
}): void {
  if (
    !dependencies.reviewSigner ||
    typeof dependencies.verifyHumanSignature !== 'function' ||
    typeof dependencies.presentReviewSummary !== 'function'
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_DEPENDENCIES_REQUIRED',
      'Production producer requires the independent review UI, signer, and trusted verifier.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function verifySignatureSafely(
  verifier: PersistenceHumanSignatureVerifier,
  payload: string,
  signature: string,
  identity: string,
  namespace: string,
): boolean {
  try {
    return verifier(payload, signature, identity, namespace);
  } catch {
    return false;
  }
}

function prefixedCandidateDigest(value: string): Sha256Digest {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_FROZEN_CANDIDATE_MISMATCH',
      'Frozen candidate digest is not canonical.',
      ExitCode.verification,
    );
  }
  return `sha256:${value}`;
}

function reviewerIdentity(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw producerError(
      'CONTROL_PLANE_REVIEWER_IDENTITY_INVALID',
      'The configured independent reviewer identity is not canonical.',
      ExitCode.unsafeEnvironment,
    );
  }
  return value;
}

function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function gitMaterialInvalid(filePath: string) {
  return producerError(
    'CONTROL_PLANE_PRODUCER_GIT_MATERIAL_INVALID',
    `Candidate path ${filePath} is not an exact regular Git blob.`,
    ExitCode.verification,
  );
}

function executableInvalid() {
  return producerError(
    'CONTROL_PLANE_PRODUCER_EXECUTABLE_INVALID',
    'Engine executable bytes, mode, or provenance changed during production.',
    ExitCode.verification,
  );
}

function processEvidenceInvalid() {
  return producerError(
    'CONTROL_PLANE_PRODUCER_ROLLBACK_TEST_FAILED',
    'Candidate self-test or recovery restart probe did not produce exact passing evidence.',
    ExitCode.verification,
  );
}

function producerError(code: string, message: string, exitCode: ExitCodeValue) {
  return workflowError(code, message, exitCode);
}
