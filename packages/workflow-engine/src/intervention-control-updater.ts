import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import {
  consumePersistedControlPlaneRecoveryGrant,
  controlPlaneRecoveryPrestateDigest,
  createControlPlaneRecoveryAuditRecord,
  createControlPlaneRecoveryFailure,
  createControlPlaneRecoveryGrantPayload,
  createControlPlaneRecoveryReceipt,
  expirePersistedControlPlaneRecoveryGrant,
  failPersistedControlPlaneRecoveryGrant,
  findPersistedControlPlaneRecoveryGrantForSource,
  preparePersistedControlPlaneRecoveryGrantConsumption,
  reservePersistedControlPlaneRecoveryGrant,
  throwControlPlaneRecoveryAlreadyConsumed,
  throwControlPlaneRecoveryFailed,
  verifyControlPlaneRecoveryGrant,
  type ControlPlaneRecoveryAuditRecord,
  type ControlPlaneRecoveryGrantEnvelope,
  type ControlPlaneRecoveryGrantPayload,
  type ControlPlaneRecoveryReceipt,
  type ControlPlaneRecoveryStateBinding,
  type PersistedControlPlaneRecoveryGrant,
} from './control-plane-recovery-grant.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  ensurePlainDirectory,
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from './filesystem-safety.ts';
import {
  classifyProtectedCandidateImpact,
  classifyProtectedCandidateImpactV2,
  controlPlaneCandidateDigest,
  controlPlaneCandidateDigestV2,
  controlPlaneIndependentReviewAttestationDigest,
  controlPlaneIndependentReviewAttestationDigestV2,
  controlPlaneIndependentReviewAttestationDigestV3,
  controlPlanePromotionBundleDigestV2,
  controlPlanePromotionBundleDigestV3,
  createEngineArtifact,
  normalizeControlPlaneTaskMandateBinding,
  verifyControlPlaneIndependentReviewAttestation,
  verifyControlPlaneIndependentReviewAttestationV2,
  verifyControlPlaneIndependentReviewAttestationV3,
  verifyControlPlaneGrant,
  verifyControlPlaneGrantV2,
  type ControlPlaneGrantEnvelope,
  type ControlPlaneGrantEnvelopeV2,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ControlPlaneIndependentReviewAttestationEnvelopeV2,
  type ControlPlanePromotionMaterial,
  type ControlPlanePromotionBundleV2,
  type ControlPlanePromotionBundleV3,
  type ControlPlaneTaskMandateBinding,
  type EngineArtifact,
  type ExactControlPlaneChange,
  type ExactControlPlaneChangeV2,
  type ProtectedCandidateImpact,
  type ProtectedCapabilityManifest,
  type Sha256Digest,
} from './intervention-control.ts';
import {
  advanceBootstrapSidecarPromotionPin,
  bootstrapSidecarPromotionPinPath,
  advancePersistedControlPlaneUpdate,
  controlPlaneUpdateRecordPath,
  interventionControlPersistencePaths,
  preparePersistedControlPlaneUpdate,
  preparePersistedControlPlaneUpdateV2,
  readPersistedControlPlaneUpdate,
  readBootstrapSidecarPromotionPin,
  recordBootstrapSidecarPromotionIfPresent,
  reserveBootstrapSidecarPromotion,
  type PersistedControlPlaneUpdateRecord,
  type PersistenceHumanSignatureVerifier,
} from './intervention-control-persistence.ts';

const SUPPORTED_UPDATER_VERSION = 1;
const SUPPORTED_UPDATER_VERSION_V2 = 2;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o500;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;

export interface ControlPlanePromotionFile {
  path: string;
  mode: '100644' | '100755';
  contentBase64: string;
  contentDigest: Sha256Digest;
}

export interface ControlPlaneRecoveryBundle {
  kind: 'control-plane-recovery-bundle.v1';
  repositoryId: string;
  previousClosureDigest: Sha256Digest;
  restartArtifact: EngineArtifact;
  restartExecutablePath: string;
  previousFiles: ControlPlanePromotionFile[];
  rollbackTestReportBase64: string;
  rollbackTestReportDigest: Sha256Digest;
  bundleDigest: Sha256Digest;
}

export interface ControlPlanePromotionBundle {
  kind: 'control-plane-promotion-bundle.v1';
  mandateBinding: ControlPlaneTaskMandateBinding;
  repositoryId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChange[];
  candidateArtifact: EngineArtifact;
  candidateExecutablePath: string;
  candidateFiles: ControlPlanePromotionFile[];
  recoveryBundle: ControlPlaneRecoveryBundle;
  independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelope;
  bundleDigest: Sha256Digest;
}

export interface PersistedControlPlaneApprovalCandidate {
  kind: 'persisted-control-plane-approval-candidate.v1';
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  txId: string;
  beforeManifest: ProtectedCapabilityManifest;
  afterManifest: ProtectedCapabilityManifest;
  bundle: ControlPlanePromotionBundle;
  createdAt: string;
  recordDigest: Sha256Digest;
}

export interface PersistedControlPlaneApprovalCandidateV2 {
  kind: 'persisted-control-plane-approval-candidate.v2';
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  txId: string;
  beforeManifest: ProtectedCapabilityManifest;
  afterManifest: ProtectedCapabilityManifest;
  bundle: ControlPlanePromotionBundleV2;
  createdAt: string;
  recordDigest: Sha256Digest;
}

export interface PersistedControlPlaneApprovalCandidateV3 {
  kind: 'persisted-control-plane-approval-candidate.v3';
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  txId: string;
  beforeManifest: ProtectedCapabilityManifest;
  afterManifest: ProtectedCapabilityManifest;
  bundle: ControlPlanePromotionBundleV3;
  createdAt: string;
  recordDigest: Sha256Digest;
}

export interface ControlPlaneApprovalSummary {
  kind: 'control-plane-approval-summary.v1';
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  candidateRecordDigest: Sha256Digest;
  repositoryId: string;
  candidateDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChange[];
  affectedCapabilities: ProtectedCandidateImpact['affectedCapabilities'];
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  rollbackTestReportDigest: Sha256Digest;
  independentReview: {
    attestationDigest: Sha256Digest;
    reviewer: string;
    reviewedAt: string;
    verdict: 'approved';
    reviewSummary: string;
  };
  behaviorChangeSummary: string;
  humanReadable: string;
}

export interface ControlPlaneApprovalPreflight {
  candidate: PersistedControlPlaneApprovalCandidate;
  summary: ControlPlaneApprovalSummary;
  supervisor: ControlPlaneSupervisorState;
}

export interface ControlPlaneApprovalSummaryV2 {
  kind: 'control-plane-approval-summary.v2';
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  candidateRecordDigest: Sha256Digest;
  repositoryId: string;
  frozenCandidateBundleDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChangeV2[];
  affectedCapabilities: ProtectedCandidateImpact['affectedCapabilities'];
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  rollbackTestReportDigest: Sha256Digest;
  independentReview: {
    attestationDigest: Sha256Digest;
    reviewer: string;
    reviewedAt: string;
    verdict: 'approved';
    reviewSummary: string;
  };
  behaviorChangeSummary: string;
  humanReadable: string;
}

export interface ControlPlaneApprovalPreflightV2 {
  candidate: PersistedControlPlaneApprovalCandidateV2;
  summary: ControlPlaneApprovalSummaryV2;
  supervisor: ControlPlaneSupervisorState;
}

export interface ControlPlaneApprovalSummaryV3 extends Omit<
  ControlPlaneApprovalSummaryV2,
  'kind' | 'humanReadable'
> {
  kind: 'control-plane-approval-summary.v3';
  promotionLineageDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousSupervisorRecordDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  humanReadable: string;
}

export interface ControlPlaneApprovalPreflightV3 {
  candidate: PersistedControlPlaneApprovalCandidateV3;
  summary: ControlPlaneApprovalSummaryV3;
  supervisor: ControlPlaneSupervisorState;
}

export interface ControlPlaneSupervisorState {
  kind: 'control-plane-supervisor-state.v1';
  repositoryId: string;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    closureDigest: Sha256Digest;
    executablePath: string;
  };
  generation: number;
  transition: {
    grantId: string;
    txId: string;
    phase: 'candidate-selected' | 'rollback-restored';
  } | null;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

export type ControlPlaneUpdaterAuditEvent =
  | 'prepared'
  | 'old-closure-verified'
  | 'candidate-verified'
  | 'recovery-verified'
  | 'switched'
  | 'self-tested'
  | 'rollback-required'
  | 'finalized'
  | 'rolled-back';

export interface ControlPlaneUpdaterAuditRecord {
  kind: 'control-plane-updater-audit.v1';
  recordId: Sha256Digest;
  repositoryId: string;
  mandateBinding: ControlPlaneTaskMandateBinding;
  parentTaskId: string;
  changeId: string;
  externalAuditRoot: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  sequence: number;
  event: ControlPlaneUpdaterAuditEvent;
  fromState: string;
  toState: string;
  evidenceDigest: Sha256Digest;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

export interface ControlPlaneUpdaterDependencies {
  now?: () => Date;
  consumedGrantIds: ReadonlySet<string>;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
  auditSink: {
    /** Implementations must make append idempotent by recordId. */
    append(record: ControlPlaneUpdaterAuditRecord): void;
  };
  revalidateTaskMandateBinding?: (
    binding: ControlPlaneTaskMandateBinding,
    phase: ControlPlaneTaskMandateValidationPhase,
  ) => void;
  testHooks?: {
    afterAtomicSwitch?: () => void;
  };
}

export type ControlPlaneTaskMandateValidationPhase =
  | 'approval-preflight'
  | 'before-persistence'
  | 'before-forward-effect'
  | 'before-atomic-switch';

export interface ControlPlanePromotionResult {
  record: PersistedControlPlaneUpdateRecord;
  supervisor: ControlPlaneSupervisorState;
}

export interface ControlPlaneRecoveryApprovalSummary {
  kind: 'control-plane-recovery-approval-summary.v1';
  recoveryGrantId: string;
  sourceControlPlaneGrantId: string;
  repositoryId: string;
  operation: 'rollback-control-plane';
  previousClosureDigest: Sha256Digest;
  currentClosureDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  controlPlaneUpdateRecordDigest: Sha256Digest;
  controlPlaneJournalDigest: Sha256Digest;
  supervisorStateDigest: Sha256Digest;
  supervisorGeneration: number;
  sourceTransactionState: ControlPlaneRecoveryGrantPayload['sourceTransactionState'];
  externalAuditRoot: string;
  humanSigner: string;
  issuedAt: string;
  expiresAt: string;
  approvalDigest: Sha256Digest;
  humanReadable: string;
}

export interface ControlPlaneRecoveryPreflight {
  payload: ControlPlaneRecoveryGrantPayload;
  summary: ControlPlaneRecoveryApprovalSummary;
}

export interface ControlPlaneRecoveryExecutorDependencies extends ControlPlaneUpdaterDependencies {
  recoveryAuditSink: {
    /** Implementations must make append idempotent by recordId. */
    append(record: ControlPlaneRecoveryAuditRecord): void;
  };
}

export interface ControlPlaneRecoveryRollbackResult {
  kind: 'control-plane-recovery-rollback-result.v1';
  action: 'rollback-control-plane';
  sourceControlPlaneGrantId: string;
  recoveryGrantId: string;
  record: PersistedControlPlaneRecoveryGrant;
  receipt: ControlPlaneRecoveryReceipt;
  controlPlaneUpdate: PersistedControlPlaneUpdateRecord;
  supervisor: ControlPlaneSupervisorState;
  effectsPerformed: boolean;
}

interface UpdaterPaths {
  root: string;
  supervisor: string;
  approvalCandidates: string;
  bundles: string;
  artifacts: string;
  operations: string;
  lock: string;
}

interface ProcessEvidence {
  closureDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
}

interface SelfTestEvidence extends ProcessEvidence {
  healthy: boolean;
}

interface ControlPlaneRecoveryContext {
  record: PersistedControlPlaneUpdateRecord;
  bundle: RuntimeControlPlanePromotionBundle;
  supervisor: ControlPlaneSupervisorState;
}

type StoredControlPlanePromotionBundle =
  ControlPlanePromotionBundle | ControlPlanePromotionBundleV2;

interface RuntimeControlPlanePromotionBundle {
  version: 1 | 2;
  storedBundle: StoredControlPlanePromotionBundle;
  mandateBinding: ControlPlaneTaskMandateBinding;
  repositoryId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  candidateArtifact: EngineArtifact;
  candidateExecutableProvenanceDigest: Sha256Digest | null;
  candidateExecutableBase64: string;
  recoveryBundle: {
    bundleDigest: Sha256Digest;
    previousClosureDigest: Sha256Digest;
    restartArtifact: EngineArtifact;
    restartExecutableBase64: string;
    rollbackTestReportDigest: Sha256Digest;
  };
  bundleDigest: Sha256Digest;
}

export function assertSameControlPlaneTaskMandateBinding(
  expected: ControlPlaneTaskMandateBinding,
  observed: ControlPlaneTaskMandateBinding,
): ControlPlaneTaskMandateBinding {
  const exactExpected = normalizeControlPlaneTaskMandateBinding(expected);
  const exactObserved = normalizeControlPlaneTaskMandateBinding(observed);
  if (canonicalJson(exactExpected) !== canonicalJson(exactObserved)) {
    throw workflowError(
      'CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH',
      'Control-plane authority does not match the exact parent Task Mandate binding.',
      ExitCode.staleState,
    );
  }
  return exactExpected;
}

export function createControlPlaneRecoveryBundle(input: {
  repositoryId: string;
  previousClosureDigest: Sha256Digest;
  restartArtifact: EngineArtifact;
  restartExecutablePath: string;
  previousFiles: ControlPlanePromotionFile[];
  rollbackTestReportBase64: string;
  rollbackTestReportDigest: Sha256Digest;
}): ControlPlaneRecoveryBundle {
  assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
  assertDigest(
    input.previousClosureDigest,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  const restartArtifact = verifyEngineArtifact(input.restartArtifact);
  const restartExecutablePath = safeLogicalPath(
    input.restartExecutablePath,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  const previousFiles = verifyPromotionFiles(
    input.previousFiles,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  const restartExecutable = previousFiles.find(
    (file) => file.path === restartExecutablePath,
  );
  if (
    restartExecutable?.mode !== '100755' ||
    restartExecutable.contentDigest !== restartArtifact.executableDigest
  ) {
    throw promotionBundleCorrupt(
      'Recovery executable does not match the restart artifact.',
    );
  }
  const rollbackTestReport = decodeCanonicalBase64(
    input.rollbackTestReportBase64,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  assertDigest(
    input.rollbackTestReportDigest,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  if (rawDigest(rollbackTestReport) !== input.rollbackTestReportDigest) {
    throw promotionBundleCorrupt('Rollback test report digest mismatch.');
  }
  const payload = {
    kind: 'control-plane-recovery-bundle.v1' as const,
    repositoryId: input.repositoryId,
    previousClosureDigest: input.previousClosureDigest,
    restartArtifact,
    restartExecutablePath,
    previousFiles,
    rollbackTestReportBase64: input.rollbackTestReportBase64,
    rollbackTestReportDigest: input.rollbackTestReportDigest,
  };
  return deepFreeze({ ...payload, bundleDigest: canonicalDigest(payload) });
}

export function createControlPlanePromotionBundle(input: {
  mandateBinding: ControlPlaneTaskMandateBinding;
  repositoryId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChange[];
  candidateArtifact: EngineArtifact;
  candidateExecutablePath: string;
  candidateFiles: ControlPlanePromotionFile[];
  recoveryBundle: ControlPlaneRecoveryBundle;
  independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelope;
}): ControlPlanePromotionBundle {
  const mandateBinding = normalizeControlPlaneTaskMandateBinding(
    input.mandateBinding,
  );
  assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
  const exactChanges = verifyExactChanges(input.exactChanges);
  if (
    input.candidateDigest !== controlPlaneCandidateDigest(exactChanges) ||
    !isDigest(input.beforeClosureDigest) ||
    !isDigest(input.afterClosureDigest)
  ) {
    throw promotionBundleCorrupt(
      'Promotion closure or candidate digest is invalid.',
    );
  }
  const candidateArtifact = verifyEngineArtifact(input.candidateArtifact);
  const candidateExecutablePath = safeLogicalPath(
    input.candidateExecutablePath,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  const candidateFiles = verifyPromotionFiles(
    input.candidateFiles,
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  const recoveryBundle = verifyRecoveryBundle(input.recoveryBundle);
  controlPlaneIndependentReviewAttestationDigest(
    input.independentReviewAttestation,
  );
  if (
    recoveryBundle.repositoryId !== input.repositoryId ||
    recoveryBundle.previousClosureDigest !== input.beforeClosureDigest
  ) {
    throw promotionBundleCorrupt(
      'Recovery bundle is not bound to the old closure.',
    );
  }
  assertFilesMatchChanges(candidateFiles, exactChanges, 'afterDigest');
  assertFilesMatchChanges(
    recoveryBundle.previousFiles,
    exactChanges,
    'beforeDigest',
  );
  const executable = candidateFiles.find(
    (file) => file.path === candidateExecutablePath,
  );
  if (
    executable?.mode !== '100755' ||
    executable.contentDigest !== candidateArtifact.executableDigest
  ) {
    throw promotionBundleCorrupt(
      'Candidate executable does not match the candidate artifact.',
    );
  }
  const payload = {
    kind: 'control-plane-promotion-bundle.v1' as const,
    mandateBinding,
    repositoryId: input.repositoryId,
    candidateDigest: input.candidateDigest,
    beforeClosureDigest: input.beforeClosureDigest,
    afterClosureDigest: input.afterClosureDigest,
    exactChanges,
    candidateArtifact,
    candidateExecutablePath,
    candidateFiles,
    recoveryBundle,
    independentReviewAttestation: structuredClone(
      input.independentReviewAttestation,
    ),
  };
  return deepFreeze({ ...payload, bundleDigest: canonicalDigest(payload) });
}

/**
 * Publish immutable, unsigned control-plane approval material. The human CLI
 * later addresses this record only by its content-bound candidate id; signed
 * grant envelopes are never accepted as command input.
 */
export function persistControlPlaneApprovalCandidate(
  storageRoot: string,
  input: {
    txId: string;
    mandateBinding: ControlPlaneTaskMandateBinding;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundle;
  },
  now = new Date(),
): PersistedControlPlaneApprovalCandidate {
  const bundle = verifyPromotionBundle(input.bundle);
  const mandateBinding = normalizeControlPlaneTaskMandateBinding(
    input.mandateBinding,
  );
  assertSameControlPlaneTaskMandateBinding(
    mandateBinding,
    bundle.mandateBinding,
  );
  const impact = assertApprovalCandidateBindings(
    input.beforeManifest,
    input.afterManifest,
    bundle,
  );
  if (impact.class !== 'C') {
    throw approvalCandidateCorrupt(
      'Approval candidate does not modify the protected control plane.',
    );
  }
  assertNonEmpty(input.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
  const createdAt = exactDate(
    now,
    'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
  ).toISOString();
  const candidate = withRecordDigest({
    kind: 'persisted-control-plane-approval-candidate.v1' as const,
    mandateBinding,
    candidateId: bundle.bundleDigest,
    txId: input.txId,
    beforeManifest: structuredClone(input.beforeManifest),
    afterManifest: structuredClone(input.afterManifest),
    bundle: structuredClone(bundle),
    createdAt,
  });
  return withUpdaterLock(storageRoot, 'persist-approval-candidate', () => {
    const paths = ensureUpdaterDirectories(storageRoot);
    const target = controlPlaneApprovalCandidatePath(
      storageRoot,
      candidate.candidateId,
    );
    const content = serializeCanonical(candidate);
    if (fs.existsSync(target)) {
      const existing = readPersistedControlPlaneApprovalCandidate(
        storageRoot,
        candidate.candidateId,
      );
      if (canonicalJson(existing) !== canonicalJson(candidate)) {
        throw workflowError(
          'CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT',
          'Candidate id is already bound to different approval bytes.',
          ExitCode.conflict,
        );
      }
      return existing;
    }
    ensurePrivateDirectory(paths.approvalCandidates);
    createPrivateFileExclusive(target, content);
    return deepFreeze(structuredClone(candidate));
  });
}

export function persistControlPlaneApprovalCandidateV2(
  storageRoot: string,
  input: {
    txId: string;
    mandateBinding: ControlPlaneTaskMandateBinding;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV2;
  },
  now = new Date(),
): PersistedControlPlaneApprovalCandidateV2 {
  controlPlanePromotionBundleDigestV2(input.bundle);
  const mandateBinding = normalizeControlPlaneTaskMandateBinding(
    input.mandateBinding,
  );
  assertSameControlPlaneTaskMandateBinding(
    mandateBinding,
    input.bundle.material.mandateBinding,
  );
  const impact = assertApprovalCandidateBindingsV2(
    input.beforeManifest,
    input.afterManifest,
    input.bundle,
  );
  if (impact.class !== 'C') {
    throw approvalCandidateCorrupt(
      'Approval candidate v2 does not modify the protected control plane.',
    );
  }
  assertNonEmpty(input.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
  const createdAt = exactDate(
    now,
    'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
  ).toISOString();
  const candidate = withRecordDigest({
    kind: 'persisted-control-plane-approval-candidate.v2' as const,
    mandateBinding,
    candidateId: input.bundle.bundleDigest,
    txId: input.txId,
    beforeManifest: structuredClone(input.beforeManifest),
    afterManifest: structuredClone(input.afterManifest),
    bundle: structuredClone(input.bundle),
    createdAt,
  });
  return withUpdaterLock(storageRoot, 'persist-approval-candidate', () => {
    const paths = ensureUpdaterDirectories(storageRoot);
    const target = controlPlaneApprovalCandidatePath(
      storageRoot,
      candidate.candidateId,
    );
    const content = serializeCanonical(candidate);
    if (fs.existsSync(target)) {
      const existing = readPersistedControlPlaneApprovalCandidateV2(
        storageRoot,
        candidate.candidateId,
      );
      if (canonicalJson(existing) !== canonicalJson(candidate)) {
        throw workflowError(
          'CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT',
          'Candidate id is already bound to different approval bytes.',
          ExitCode.conflict,
        );
      }
      return existing;
    }
    ensurePrivateDirectory(paths.approvalCandidates);
    createPrivateFileExclusive(target, content);
    return deepFreeze(structuredClone(candidate));
  });
}

export function persistControlPlaneApprovalCandidateV3(
  storageRoot: string,
  input: {
    txId: string;
    mandateBinding: ControlPlaneTaskMandateBinding;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV3;
  },
  now = new Date(),
): PersistedControlPlaneApprovalCandidateV3 {
  controlPlanePromotionBundleDigestV3(input.bundle);
  const mandateBinding = normalizeControlPlaneTaskMandateBinding(
    input.mandateBinding,
  );
  assertSameControlPlaneTaskMandateBinding(
    mandateBinding,
    input.bundle.material.mandateBinding,
  );
  const impact = assertApprovalCandidateBindingsV3(
    input.beforeManifest,
    input.afterManifest,
    input.bundle,
  );
  if (impact.class !== 'C') {
    throw approvalCandidateCorrupt(
      'Approval candidate v3 does not modify the protected control plane.',
    );
  }
  assertNonEmpty(input.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
  const createdAt = exactDate(
    now,
    'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
  ).toISOString();
  const candidate = withRecordDigest({
    kind: 'persisted-control-plane-approval-candidate.v3' as const,
    mandateBinding,
    candidateId: input.bundle.bundleDigest,
    txId: input.txId,
    beforeManifest: structuredClone(input.beforeManifest),
    afterManifest: structuredClone(input.afterManifest),
    bundle: structuredClone(input.bundle),
    createdAt,
  });
  return withUpdaterLock(storageRoot, 'persist-approval-candidate', () => {
    const paths = ensureUpdaterDirectories(storageRoot);
    const target = controlPlaneApprovalCandidatePath(
      storageRoot,
      candidate.candidateId,
    );
    const content = serializeCanonical(candidate);
    if (fs.existsSync(target)) {
      const existing = readPersistedControlPlaneApprovalCandidateV3(
        storageRoot,
        candidate.candidateId,
      );
      if (canonicalJson(existing) !== canonicalJson(candidate)) {
        throw workflowError(
          'CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT',
          'Candidate id is already bound to different approval bytes.',
          ExitCode.conflict,
        );
      }
      return existing;
    }
    ensurePrivateDirectory(paths.approvalCandidates);
    createPrivateFileExclusive(target, content);
    return deepFreeze(structuredClone(candidate));
  });
}

export function controlPlaneApprovalCandidatePath(
  storageRoot: string,
  candidateId: string,
): string {
  assertDigest(candidateId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
  return path.join(
    updaterPaths(storageRoot).approvalCandidates,
    `${candidateId.slice('sha256:'.length)}.json`,
  );
}

export function readPersistedControlPlaneApprovalCandidate(
  storageRoot: string,
  candidateId: string,
): PersistedControlPlaneApprovalCandidate {
  const value = readCanonicalPrivateRecord(
    controlPlaneApprovalCandidatePath(storageRoot, candidateId),
    'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND',
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'afterManifest',
      'beforeManifest',
      'bundle',
      'candidateId',
      'createdAt',
      'kind',
      'mandateBinding',
      'recordDigest',
      'txId',
    ]) ||
    value.kind !== 'persisted-control-plane-approval-candidate.v1' ||
    value.candidateId !== candidateId ||
    !verifyRecordDigest(value)
  ) {
    throw approvalCandidateCorrupt();
  }
  try {
    const candidate =
      value as unknown as PersistedControlPlaneApprovalCandidate;
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(
      candidate.mandateBinding,
    );
    assertNonEmpty(candidate.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
    if (!isCanonicalIso(candidate.createdAt)) {
      throw approvalCandidateCorrupt();
    }
    const bundle = verifyPromotionBundle(candidate.bundle);
    assertSameControlPlaneTaskMandateBinding(
      mandateBinding,
      bundle.mandateBinding,
    );
    if (bundle.bundleDigest !== candidate.candidateId) {
      throw approvalCandidateCorrupt(
        'Candidate id does not match the exact promotion bundle.',
      );
    }
    const impact = assertApprovalCandidateBindings(
      candidate.beforeManifest,
      candidate.afterManifest,
      bundle,
    );
    if (impact.class !== 'C') {
      throw approvalCandidateCorrupt(
        'Persisted candidate no longer classifies as control-plane.',
      );
    }
    return deepFreeze(
      structuredClone({ ...candidate, mandateBinding, bundle }),
    ) as PersistedControlPlaneApprovalCandidate;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT'
    ) {
      throw error;
    }
    throw approvalCandidateCorrupt();
  }
}

export function readPersistedControlPlaneApprovalCandidateV2(
  storageRoot: string,
  candidateId: string,
): PersistedControlPlaneApprovalCandidateV2 {
  const value = readCanonicalPrivateRecord(
    controlPlaneApprovalCandidatePath(storageRoot, candidateId),
    'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND',
  );
  if (
    isRecord(value) &&
    value.kind === 'persisted-control-plane-approval-candidate.v1'
  ) {
    throw workflowError(
      'CONTROL_PLANE_APPROVAL_CANDIDATE_LEGACY_READ_ONLY',
      'New production approval rejects legacy v1 candidates before human signing; v1 remains readable only for status and recovery.',
      ExitCode.guard,
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'afterManifest',
      'beforeManifest',
      'bundle',
      'candidateId',
      'createdAt',
      'kind',
      'mandateBinding',
      'recordDigest',
      'txId',
    ]) ||
    value.kind !== 'persisted-control-plane-approval-candidate.v2' ||
    value.candidateId !== candidateId ||
    !verifyRecordDigest(value)
  ) {
    throw approvalCandidateCorrupt();
  }
  try {
    const candidate =
      value as unknown as PersistedControlPlaneApprovalCandidateV2;
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(
      candidate.mandateBinding,
    );
    assertNonEmpty(candidate.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
    if (!isCanonicalIso(candidate.createdAt)) {
      throw approvalCandidateCorrupt();
    }
    controlPlanePromotionBundleDigestV2(candidate.bundle);
    assertSameControlPlaneTaskMandateBinding(
      mandateBinding,
      candidate.bundle.material.mandateBinding,
    );
    if (candidate.bundle.bundleDigest !== candidate.candidateId) {
      throw approvalCandidateCorrupt(
        'Candidate id does not match the exact reviewed promotion bundle.',
      );
    }
    const impact = assertApprovalCandidateBindingsV2(
      candidate.beforeManifest,
      candidate.afterManifest,
      candidate.bundle,
    );
    if (impact.class !== 'C') {
      throw approvalCandidateCorrupt(
        'Persisted candidate v2 no longer classifies as control-plane.',
      );
    }
    return deepFreeze(
      structuredClone({ ...candidate, mandateBinding }),
    ) as PersistedControlPlaneApprovalCandidateV2;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT'
    ) {
      throw error;
    }
    throw approvalCandidateCorrupt();
  }
}

export function readPersistedControlPlaneApprovalCandidateV3(
  storageRoot: string,
  candidateId: string,
): PersistedControlPlaneApprovalCandidateV3 {
  const value = readCanonicalPrivateRecord(
    controlPlaneApprovalCandidatePath(storageRoot, candidateId),
    'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND',
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'afterManifest',
      'beforeManifest',
      'bundle',
      'candidateId',
      'createdAt',
      'kind',
      'mandateBinding',
      'recordDigest',
      'txId',
    ]) ||
    value.kind !== 'persisted-control-plane-approval-candidate.v3' ||
    value.candidateId !== candidateId ||
    !verifyRecordDigest(value)
  ) {
    throw approvalCandidateCorrupt();
  }
  try {
    const candidate =
      value as unknown as PersistedControlPlaneApprovalCandidateV3;
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(
      candidate.mandateBinding,
    );
    assertNonEmpty(candidate.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
    if (!isCanonicalIso(candidate.createdAt)) {
      throw approvalCandidateCorrupt();
    }
    controlPlanePromotionBundleDigestV3(candidate.bundle);
    assertSameControlPlaneTaskMandateBinding(
      mandateBinding,
      candidate.bundle.material.mandateBinding,
    );
    if (candidate.bundle.bundleDigest !== candidate.candidateId) {
      throw approvalCandidateCorrupt(
        'Candidate id does not match the exact reviewed successor bundle.',
      );
    }
    const impact = assertApprovalCandidateBindingsV3(
      candidate.beforeManifest,
      candidate.afterManifest,
      candidate.bundle,
    );
    if (impact.class !== 'C') {
      throw approvalCandidateCorrupt(
        'Persisted candidate v3 no longer classifies as control-plane.',
      );
    }
    return deepFreeze(
      structuredClone({ ...candidate, mandateBinding }),
    ) as PersistedControlPlaneApprovalCandidateV3;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT'
    ) {
      throw error;
    }
    throw approvalCandidateCorrupt();
  }
}

export function findPersistedControlPlaneApprovalCandidateV2ByMaterialDigestAndReviewer(
  storageRoot: string,
  promotionMaterialDigest: Sha256Digest,
  reviewer: string,
): PersistedControlPlaneApprovalCandidateV2 | null {
  assertDigest(
    promotionMaterialDigest,
    'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID',
  );
  assertNonEmpty(reviewer, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
  const directory = updaterPaths(storageRoot).approvalCandidates;
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stats === undefined) {
    return null;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw approvalCandidateCorrupt(
      'Approval candidate storage is not a private directory.',
    );
  }
  const matches: PersistedControlPlaneApprovalCandidateV2[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      throw approvalCandidateCorrupt(
        'Approval candidate storage contains an unknown entry.',
      );
    }
    const candidateId = `sha256:${name.slice(0, -'.json'.length)}`;
    const raw = readCanonicalPrivateRecord(
      path.join(directory, name),
      'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND',
    );
    if (
      isRecord(raw) &&
      raw.kind === 'persisted-control-plane-approval-candidate.v2'
    ) {
      const candidate = readPersistedControlPlaneApprovalCandidateV2(
        storageRoot,
        candidateId,
      );
      if (
        candidate.bundle.promotionMaterialDigest === promotionMaterialDigest &&
        candidate.bundle.independentReviewAttestation.payload.reviewer ===
          reviewer
      ) {
        matches.push(candidate);
      }
    }
  }
  if (matches.length > 1) {
    throw workflowError(
      'CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT',
      'Multiple signed approval candidates bind the same promotion material and reviewer.',
      ExitCode.conflict,
    );
  }
  return matches[0] ?? null;
}

export function findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer(
  storageRoot: string,
  promotionMaterialDigest: Sha256Digest,
  promotionLineageDigest: Sha256Digest,
  reviewer: string,
): PersistedControlPlaneApprovalCandidateV3 | null {
  assertDigest(
    promotionMaterialDigest,
    'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID',
  );
  assertDigest(
    promotionLineageDigest,
    'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID',
  );
  assertNonEmpty(reviewer, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
  const directory = updaterPaths(storageRoot).approvalCandidates;
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw approvalCandidateCorrupt(
      'Approval candidate storage is not a private directory.',
    );
  }
  const matches: PersistedControlPlaneApprovalCandidateV3[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      throw approvalCandidateCorrupt(
        'Approval candidate storage contains an unknown entry.',
      );
    }
    const candidateId = `sha256:${name.slice(0, -'.json'.length)}`;
    const raw = readCanonicalPrivateRecord(
      path.join(directory, name),
      'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND',
    );
    if (
      isRecord(raw) &&
      raw.kind === 'persisted-control-plane-approval-candidate.v3'
    ) {
      const candidate = readPersistedControlPlaneApprovalCandidateV3(
        storageRoot,
        candidateId,
      );
      if (
        candidate.bundle.promotionMaterialDigest === promotionMaterialDigest &&
        candidate.bundle.promotionLineageDigest === promotionLineageDigest &&
        candidate.bundle.independentReviewAttestation.payload.reviewer ===
          reviewer
      ) {
        matches.push(candidate);
      }
    }
  }
  if (matches.length > 1) {
    throw workflowError(
      'CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT',
      'Multiple signed approval candidates bind the same successor material, lineage, and reviewer.',
      ExitCode.conflict,
    );
  }
  return matches[0] ?? null;
}

export function preflightControlPlaneApprovalCandidateV2(
  storageRoot: string,
  candidateId: string,
  context: {
    grantId: string;
    humanSigner: string;
    issuedAt: string;
    verifyHumanSignature: PersistenceHumanSignatureVerifier;
  },
): ControlPlaneApprovalPreflightV2 {
  assertNonEmpty(context.grantId, 'CONTROL_PLANE_GRANT_INVALID');
  assertNonEmpty(context.humanSigner, 'CONTROL_PLANE_GRANT_INVALID');
  if (
    fs.existsSync(controlPlaneUpdateRecordPath(storageRoot, context.grantId))
  ) {
    readPersistedControlPlaneUpdate(storageRoot, context.grantId);
    throw workflowError(
      'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
      'Control-Plane Grant already has a durable transaction.',
      ExitCode.conflict,
    );
  }
  const candidate = readPersistedControlPlaneApprovalCandidateV2(
    storageRoot,
    candidateId,
  );
  const impact = assertApprovalCandidateBindingsV2(
    candidate.beforeManifest,
    candidate.afterManifest,
    candidate.bundle,
  );
  const attestationDigest = controlPlaneIndependentReviewAttestationDigestV2(
    candidate.bundle.independentReviewAttestation,
  );
  verifyControlPlaneIndependentReviewAttestationV2(
    candidate.bundle.independentReviewAttestation,
    {
      material: candidate.bundle.material,
      expectedDigest: attestationDigest,
      grantHumanSigner: context.humanSigner,
      grantIssuedAt: context.issuedAt,
      verifyHumanSignature: context.verifyHumanSignature,
    },
  );
  const supervisor = readControlPlaneSupervisorState(storageRoot);
  assertSupervisorMatchesOldClosureV2(supervisor, candidate.bundle.material);
  const summary = controlPlaneApprovalSummaryV2(
    candidate,
    impact,
    attestationDigest,
  );
  return deepFreeze({ candidate, summary, supervisor });
}

export function preflightControlPlaneApprovalCandidateV3(
  storageRoot: string,
  candidateId: string,
  context: {
    grantId: string;
    humanSigner: string;
    issuedAt: string;
    verifyHumanSignature: PersistenceHumanSignatureVerifier;
  },
): ControlPlaneApprovalPreflightV3 {
  assertNonEmpty(context.grantId, 'CONTROL_PLANE_GRANT_INVALID');
  assertNonEmpty(context.humanSigner, 'CONTROL_PLANE_GRANT_INVALID');
  if (
    fs.existsSync(controlPlaneUpdateRecordPath(storageRoot, context.grantId))
  ) {
    readPersistedControlPlaneUpdate(storageRoot, context.grantId);
    throw workflowError(
      'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
      'Control-Plane Grant already has a durable transaction.',
      ExitCode.conflict,
    );
  }
  const candidate = readPersistedControlPlaneApprovalCandidateV3(
    storageRoot,
    candidateId,
  );
  const impact = assertApprovalCandidateBindingsV3(
    candidate.beforeManifest,
    candidate.afterManifest,
    candidate.bundle,
  );
  const attestationDigest = controlPlaneIndependentReviewAttestationDigestV3(
    candidate.bundle.independentReviewAttestation,
  );
  verifyControlPlaneIndependentReviewAttestationV3(
    candidate.bundle.independentReviewAttestation,
    {
      material: candidate.bundle.material,
      lineage: candidate.bundle.lineage,
      expectedDigest: attestationDigest,
      grantHumanSigner: context.humanSigner,
      grantIssuedAt: context.issuedAt,
      verifyHumanSignature: context.verifyHumanSignature,
    },
  );
  const supervisor = readControlPlaneSupervisorState(storageRoot);
  assertSupervisorMatchesOldClosureV2(supervisor, candidate.bundle.material);
  if (
    supervisor.generation !== candidate.bundle.lineage.previousGeneration ||
    supervisor.recordDigest !==
      candidate.bundle.lineage.previousSupervisorRecordDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_LINEAGE_STALE',
      'The successor lineage does not extend the current supervisor generation.',
      ExitCode.staleState,
    );
  }
  const summary = controlPlaneApprovalSummaryV3(
    candidate,
    impact,
    attestationDigest,
  );
  return deepFreeze({ candidate, summary, supervisor });
}

export function preflightControlPlaneApprovalCandidate(
  storageRoot: string,
  candidateId: string,
  context: {
    grantId: string;
    humanSigner: string;
    issuedAt: string;
    verifyHumanSignature: PersistenceHumanSignatureVerifier;
  },
): ControlPlaneApprovalPreflight {
  assertNonEmpty(context.grantId, 'CONTROL_PLANE_GRANT_INVALID');
  assertNonEmpty(context.humanSigner, 'CONTROL_PLANE_GRANT_INVALID');
  if (
    fs.existsSync(controlPlaneUpdateRecordPath(storageRoot, context.grantId))
  ) {
    readPersistedControlPlaneUpdate(storageRoot, context.grantId);
    throw workflowError(
      'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
      'Control-Plane Grant already has a durable transaction.',
      ExitCode.conflict,
    );
  }
  const candidate = readPersistedControlPlaneApprovalCandidate(
    storageRoot,
    candidateId,
  );
  const impact = assertApprovalCandidateBindings(
    candidate.beforeManifest,
    candidate.afterManifest,
    candidate.bundle,
  );
  const attestationDigest = controlPlaneIndependentReviewAttestationDigest(
    candidate.bundle.independentReviewAttestation,
  );
  verifyControlPlaneIndependentReviewAttestation(
    candidate.bundle.independentReviewAttestation,
    {
      expectedDigest: attestationDigest,
      repositoryId: candidate.bundle.repositoryId,
      candidateDigest: candidate.bundle.candidateDigest,
      beforeClosureDigest: candidate.bundle.beforeClosureDigest,
      afterClosureDigest: candidate.bundle.afterClosureDigest,
      recoveryBundleDigest: candidate.bundle.recoveryBundle.bundleDigest,
      affectedCapabilities: impact.affectedCapabilities,
      grantHumanSigner: context.humanSigner,
      grantIssuedAt: context.issuedAt,
      verifyHumanSignature: context.verifyHumanSignature,
    },
  );
  const supervisor = readControlPlaneSupervisorState(storageRoot);
  assertSupervisorMatchesOldClosure(
    supervisor,
    candidate.bundle.repositoryId,
    candidate.bundle,
  );
  const summary = controlPlaneApprovalSummary(
    candidate,
    impact,
    attestationDigest,
  );
  return deepFreeze({ candidate, summary, supervisor });
}

export function initializeControlPlaneSupervisorState(
  storageRoot: string,
  input: {
    repositoryId: string;
    closureDigest: Sha256Digest;
    artifact: EngineArtifact;
    executableBase64: string;
    now: Date;
  },
): ControlPlaneSupervisorState {
  return withUpdaterLock(storageRoot, 'initialize-supervisor', () => {
    const paths = ensureUpdaterDirectories(storageRoot);
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_SUPERVISOR_INVALID');
    assertDigest(input.closureDigest, 'CONTROL_PLANE_SUPERVISOR_INVALID');
    const artifact = verifyEngineArtifact(input.artifact);
    const bytes = decodeCanonicalBase64(
      input.executableBase64,
      'CONTROL_PLANE_SUPERVISOR_INVALID',
    );
    if (rawDigest(bytes) !== artifact.executableDigest) {
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_INVALID',
        'Initial executable does not match the engine artifact.',
        ExitCode.verification,
      );
    }
    const executablePath = materializeExecutable(paths, artifact, bytes);
    const at = exactDate(input.now, 'CONTROL_PLANE_SUPERVISOR_INVALID');
    const state = withRecordDigest({
      kind: 'control-plane-supervisor-state.v1' as const,
      repositoryId: input.repositoryId,
      activeArtifact: {
        artifactId: artifact.artifactId,
        executableDigest: artifact.executableDigest,
        closureDigest: input.closureDigest,
        executablePath,
      },
      generation: 1,
      transition: null,
      updatedAt: at.toISOString(),
    });
    if (fs.existsSync(paths.supervisor)) {
      const existing = readControlPlaneSupervisorState(storageRoot);
      if (canonicalJson(existing) !== canonicalJson(state)) {
        throw workflowError(
          'CONTROL_PLANE_SUPERVISOR_ALREADY_INITIALIZED',
          'A different control-plane supervisor state already exists.',
          ExitCode.conflict,
        );
      }
      return existing;
    }
    createPrivateFileExclusive(paths.supervisor, serializeCanonical(state));
    return state;
  });
}

export function readControlPlaneSupervisorState(
  storageRoot: string,
): ControlPlaneSupervisorState {
  const paths = updaterPaths(storageRoot);
  const value = readCanonicalPrivateRecord(
    paths.supervisor,
    'CONTROL_PLANE_SUPERVISOR_NOT_FOUND',
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'generation',
      'kind',
      'recordDigest',
      'repositoryId',
      'transition',
      'updatedAt',
    ]) ||
    value.kind !== 'control-plane-supervisor-state.v1' ||
    !verifyRecordDigest(value)
  ) {
    throw supervisorCorrupt();
  }
  const state = value as unknown as ControlPlaneSupervisorState;
  if (
    typeof state.repositoryId !== 'string' ||
    state.repositoryId.length === 0 ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    !isRecord(state.activeArtifact) ||
    !hasExactKeys(state.activeArtifact, [
      'artifactId',
      'closureDigest',
      'executableDigest',
      'executablePath',
    ]) ||
    !isDigest(state.activeArtifact.artifactId) ||
    !isDigest(state.activeArtifact.executableDigest) ||
    !isDigest(state.activeArtifact.closureDigest) ||
    !validTransition(state.transition) ||
    !isCanonicalIso(state.updatedAt)
  ) {
    throw supervisorCorrupt();
  }
  assertConfinedExecutable(
    paths,
    state.activeArtifact.executablePath,
    state.activeArtifact.executableDigest,
    state.activeArtifact.artifactId,
  );
  return deepFreeze(structuredClone(state));
}

/**
 * Build the only V1 Recovery Grant operation from durable updater state. The
 * caller supplies identity and clock only; repository state, closure digests,
 * bundle digests, and the recovery operation are derived under the updater
 * lock and cannot be supplied as CLI data.
 */
export function preflightControlPlaneRecoveryRollback(
  storageRoot: string,
  sourceControlPlaneGrantId: string,
  input: { humanSigner: string; issuedAt: string },
  dependencies: ControlPlaneRecoveryExecutorDependencies,
): ControlPlaneRecoveryPreflight {
  return withUpdaterLock(
    storageRoot,
    `recovery-preflight:${sourceControlPlaneGrantId}`,
    () => {
      requireRecoveryDependencies(dependencies);
      const now = updaterNow(dependencies);
      const issuedAt = exactDate(
        new Date(input.issuedAt),
        'HARNESS_RECOVERY_GRANT_CLOCK_INVALID',
      ).toISOString();
      if (issuedAt !== now.toISOString()) {
        throw workflowError(
          'HARNESS_RECOVERY_GRANT_CLOCK_INVALID',
          'Recovery Grant issuance time must come from the sealed executor clock.',
          ExitCode.guard,
        );
      }
      const existing = findPersistedControlPlaneRecoveryGrantForSource(
        storageRoot,
        sourceControlPlaneGrantId,
      );
      if (existing?.state === 'consumed') {
        throwControlPlaneRecoveryAlreadyConsumed();
      }
      if (existing?.state === 'failed') {
        throw recoveryRepairRequired();
      }
      if (
        existing?.state === 'reserved' ||
        existing?.state === 'completion-pending'
      ) {
        throw workflowError(
          'HARNESS_RECOVERY_GRANT_ALREADY_RESERVED',
          'An exact signed Recovery Grant is already active for this control-plane transaction.',
          ExitCode.conflict,
        );
      }
      const context = readControlPlaneRecoveryContext(
        storageRoot,
        sourceControlPlaneGrantId,
        dependencies,
      );
      assertInitialRecoveryContext(context);
      const payload = createControlPlaneRecoveryGrantPayload({
        ...recoveryStateBinding(context),
        issuedAt,
        humanSigner: input.humanSigner,
      });
      return deepFreeze({
        payload,
        summary: recoveryApprovalSummary(payload),
      });
    },
  );
}

/**
 * Consume a domain-separated Recovery Grant. This is deliberately absent from
 * src/cli.ts: the only production caller is the sealed harness-bootstrap
 * source entry, which passes an envelope derived from the preflight above.
 */
export function executeControlPlaneRecoveryRollback(
  storageRoot: string,
  envelope: ControlPlaneRecoveryGrantEnvelope,
  dependencies: ControlPlaneRecoveryExecutorDependencies,
): ControlPlaneRecoveryRollbackResult {
  const requestedSourceGrantId =
    isRecord(envelope) && isRecord(envelope.payload)
      ? envelope.payload.sourceControlPlaneGrantId
      : null;
  return withUpdaterLock(
    storageRoot,
    `recovery-execute:${
      typeof requestedSourceGrantId === 'string'
        ? requestedSourceGrantId
        : 'invalid'
    }`,
    () => {
      requireRecoveryDependencies(dependencies);
      const now = updaterNow(dependencies);
      const existing =
        typeof requestedSourceGrantId === 'string'
          ? findPersistedControlPlaneRecoveryGrantForSource(
              storageRoot,
              requestedSourceGrantId,
            )
          : null;
      if (existing?.state === 'consumed') {
        throwControlPlaneRecoveryAlreadyConsumed();
      }
      const requestedRecoveryGrantId =
        isRecord(envelope) && isRecord(envelope.payload)
          ? envelope.payload.grantId
          : null;
      if (
        existing?.state === 'expired' &&
        existing.envelope.payload.grantId === requestedRecoveryGrantId
      ) {
        throw workflowError(
          'HARNESS_RECOVERY_GRANT_EXPIRED',
          'Recovery Grant is an expired one-shot tombstone.',
          ExitCode.staleState,
        );
      }
      if (
        existing?.state === 'failed' &&
        existing.envelope.payload.grantId === requestedRecoveryGrantId
      ) {
        throwControlPlaneRecoveryFailed();
      }
      const pending =
        existing?.state === 'reserved' ||
        existing?.state === 'completion-pending'
          ? existing
          : null;
      if (
        pending !== null &&
        canonicalJson(pending.envelope) !== canonicalJson(envelope)
      ) {
        throw workflowError(
          'HARNESS_RECOVERY_GRANT_RESERVATION_MISMATCH',
          'Reserved Recovery Grant bytes differ from the requested envelope.',
          ExitCode.verification,
        );
      }

      // Signature and schema are always revalidated. Expiry is completion-
      // obligatory only after this exact reservation has begun a rollback.
      const payload = verifyControlPlaneRecoveryGrant(envelope, {
        now: new Date(
          isRecord(envelope) && isRecord(envelope.payload)
            ? String(envelope.payload.issuedAt)
            : Number.NaN,
        ),
        verifyHumanSignature: dependencies.verifyHumanSignature,
        enforceLive: false,
      });
      const context = readControlPlaneRecoveryContext(
        storageRoot,
        payload.sourceControlPlaneGrantId,
        dependencies,
      );
      const exactPrestate = recoveryContextMatchesPayload(context, payload);
      const envelopeDigest = canonicalDigest(envelope);
      if (
        pending?.state === 'reserved' &&
        exactPrestate &&
        now.getTime() >= Date.parse(payload.expiresAt)
      ) {
        const terminalExpiredAt = payload.expiresAt;
        dependencies.recoveryAuditSink.append(
          createControlPlaneRecoveryAuditRecord({
            payload,
            envelopeDigest,
            event: 'authorized',
            poststateDigest: null,
            receiptDigest: null,
            recordedAt: pending.createdAt,
          }),
        );
        dependencies.recoveryAuditSink.append(
          createControlPlaneRecoveryAuditRecord({
            payload,
            envelopeDigest,
            event: 'expired',
            poststateDigest: null,
            receiptDigest: null,
            recordedAt: terminalExpiredAt,
          }),
        );
        expirePersistedControlPlaneRecoveryGrant(storageRoot, {
          recoveryGrantId: payload.grantId,
          expectedRecordDigest: pending.recordDigest,
          expiredAt: terminalExpiredAt,
        });
        throw workflowError(
          'HARNESS_RECOVERY_GRANT_EXPIRED',
          'Recovery Grant expired before any rollback effect and was terminalized.',
          ExitCode.staleState,
        );
      }
      if (pending === null || exactPrestate) {
        verifyControlPlaneRecoveryGrant(envelope, {
          now,
          verifyHumanSignature: dependencies.verifyHumanSignature,
        });
      } else if (!isRecoveryCompletionContext(context, payload)) {
        throw recoveryStateBindingMismatch();
      }
      if (pending === null && !exactPrestate) {
        throw recoveryStateBindingMismatch();
      }

      const reservation =
        pending ??
        reservePersistedControlPlaneRecoveryGrant(
          storageRoot,
          envelope,
          now.toISOString(),
        );
      dependencies.recoveryAuditSink.append(
        createControlPlaneRecoveryAuditRecord({
          payload,
          envelopeDigest,
          event: 'authorized',
          poststateDigest: null,
          receiptDigest: null,
          recordedAt: reservation.createdAt,
        }),
      );

      const rollbackEffectPerformed =
        context.record.transaction.state !== 'ROLLED_BACK';
      let result: ControlPlanePromotionResult;
      try {
        result = driveControlPlanePromotion(
          storageRoot,
          payload.sourceControlPlaneGrantId,
          dependencies,
        );
      } catch (error) {
        const failedContext = readControlPlaneRecoveryContext(
          storageRoot,
          payload.sourceControlPlaneGrantId,
          dependencies,
        );
        if (isRollbackSelectedForRecoveryFailure(failedContext, payload)) {
          const failure = createControlPlaneRecoveryFailure({
            payload,
            errorCode: workflowFailureCode(error),
            selectedClosureDigest:
              failedContext.supervisor.activeArtifact.closureDigest,
            selectedArtifactId:
              failedContext.supervisor.activeArtifact.artifactId,
            supervisorStateDigest: failedContext.supervisor.recordDigest,
            supervisorGeneration: failedContext.supervisor.generation,
            controlPlaneJournalDigest:
              failedContext.record.transaction.journalDigest,
            failedAt: laterIso(
              failedContext.record.updatedAt,
              failedContext.supervisor.updatedAt,
            ),
          });
          failPersistedControlPlaneRecoveryGrant(storageRoot, {
            recoveryGrantId: payload.grantId,
            expectedRecordDigest: reservation.recordDigest,
            failure,
          });
          dependencies.recoveryAuditSink.append(
            createControlPlaneRecoveryAuditRecord({
              payload,
              envelopeDigest,
              event: 'failed',
              poststateDigest: failure.failureDigest,
              receiptDigest: null,
              recordedAt: failure.failedAt,
            }),
          );
        }
        throw error;
      }
      if (
        result.record.transaction.state !== 'ROLLED_BACK' ||
        result.supervisor.activeArtifact.closureDigest !==
          payload.previousClosureDigest
      ) {
        throw workflowError(
          'HARNESS_RECOVERY_ROLLBACK_INCOMPLETE',
          'Recovery executor did not restore the exact previous trusted closure.',
          ExitCode.verification,
        );
      }
      const poststateDigest = canonicalDigest({
        kind: 'control-plane-recovery-poststate.v1',
        controlPlaneUpdateRecordDigest: result.record.recordDigest,
        controlPlaneJournalDigest: result.record.transaction.journalDigest,
        supervisorStateDigest: result.supervisor.recordDigest,
        supervisorGeneration: result.supervisor.generation,
        selectedClosureDigest: result.supervisor.activeArtifact.closureDigest,
        selectedArtifactId: result.supervisor.activeArtifact.artifactId,
      });
      const completedAt = laterIso(
        result.record.updatedAt,
        result.supervisor.updatedAt,
      );
      const receipt = createControlPlaneRecoveryReceipt({
        payload,
        poststateDigest,
        controlPlaneJournalDigestAfter: result.record.transaction.journalDigest,
        supervisorStateDigestAfter: result.supervisor.recordDigest,
        completedAt,
      });
      dependencies.recoveryAuditSink.append(
        createControlPlaneRecoveryAuditRecord({
          payload,
          envelopeDigest,
          event: 'rolled-back',
          poststateDigest,
          receiptDigest: receipt.receiptDigest,
          recordedAt: completedAt,
        }),
      );
      const preparedConsumption =
        preparePersistedControlPlaneRecoveryGrantConsumption(storageRoot, {
          recoveryGrantId: payload.grantId,
          expectedRecordDigest: reservation.recordDigest,
          receipt,
        });
      // The terminal external audit is emitted only after a durable local
      // completion receipt has made the authority one-shot and resumable.
      dependencies.recoveryAuditSink.append(
        createControlPlaneRecoveryAuditRecord({
          payload,
          envelopeDigest,
          event: 'consumed',
          poststateDigest,
          receiptDigest: receipt.receiptDigest,
          recordedAt: completedAt,
        }),
      );
      const consumed = consumePersistedControlPlaneRecoveryGrant(storageRoot, {
        recoveryGrantId: payload.grantId,
        expectedRecordDigest: preparedConsumption.recordDigest,
      });
      return deepFreeze({
        kind: 'control-plane-recovery-rollback-result.v1' as const,
        action: 'rollback-control-plane' as const,
        sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
        recoveryGrantId: payload.grantId,
        record: consumed,
        receipt,
        controlPlaneUpdate: result.record,
        supervisor: result.supervisor,
        effectsPerformed: rollbackEffectPerformed,
      });
    },
  );
}

export function prepareControlPlanePromotion(
  storageRoot: string,
  input: {
    txId: string;
    envelope: ControlPlaneGrantEnvelope;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundle;
  },
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, 'prepare-promotion', () => {
    requireUpdaterDependencies(dependencies);
    const now = updaterNow(dependencies);
    if (input.envelope?.payload?.kind !== 'control-plane-grant.v1') {
      throw workflowError(
        'CONTROL_PLANE_GRANT_INVALID',
        'The minimal updater accepts only a Control-Plane Grant.',
        ExitCode.guard,
      );
    }
    const bundle = verifyPromotionBundle(input.bundle);
    assertPromotionBindings(
      input.envelope,
      input.beforeManifest,
      input.afterManifest,
      bundle,
    );
    if (input.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION) {
      throw workflowError(
        'CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED',
        'This minimal updater cannot execute the requested updater version.',
        ExitCode.guard,
      );
    }
    if (
      fs.existsSync(
        controlPlaneUpdateRecordPath(
          storageRoot,
          input.envelope.payload.grantId,
        ),
      )
    ) {
      readPersistedControlPlaneUpdate(
        storageRoot,
        input.envelope.payload.grantId,
      );
      throw workflowError(
        'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
        'Control-Plane Grant already has a durable transaction.',
        ExitCode.conflict,
      );
    }
    // Verify authority before creating any durable candidate material.
    verifyControlPlaneGrant(input.envelope, {
      now,
      beforeManifest: input.beforeManifest,
      afterManifest: input.afterManifest,
      changes: bundle.exactChanges,
      consumedGrantIds: dependencies.consumedGrantIds,
      verifyHumanSignature: dependencies.verifyHumanSignature,
    });
    verifyIndependentReviewForPromotion(
      input.envelope,
      bundle,
      dependencies.verifyHumanSignature,
    );
    revalidateControlPlaneTaskMandate(
      input.envelope.payload.mandateBinding,
      dependencies,
      'before-persistence',
    );
    const supervisor = readControlPlaneSupervisorState(storageRoot);
    assertSupervisorMatchesOldClosure(
      supervisor,
      input.envelope.payload.repositoryId,
      bundle,
    );
    const paths = ensureUpdaterDirectories(storageRoot);
    persistPromotionBundle(paths, input.envelope.payload.grantId, bundle);
    const runtimeBundle = runtimePromotionBundle(bundle);
    materializeBundleExecutables(paths, runtimeBundle);
    const record = preparePersistedControlPlaneUpdate(
      storageRoot,
      {
        txId: input.txId,
        envelope: input.envelope,
        beforeManifest: input.beforeManifest,
        afterManifest: input.afterManifest,
        changes: bundle.exactChanges,
      },
      {
        now: () => now,
        consumedGrantIds: dependencies.consumedGrantIds,
        verifyHumanSignature: dependencies.verifyHumanSignature,
      },
    );
    emitAuditHistory(record, runtimeBundle, dependencies);
    return { record, supervisor };
  });
}

export function prepareControlPlanePromotionV2(
  storageRoot: string,
  input: {
    txId: string;
    envelope: ControlPlaneGrantEnvelopeV2;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV2;
  },
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, 'prepare-promotion-v2', () => {
    requireUpdaterDependencies(dependencies);
    const now = updaterNow(dependencies);
    if (input.envelope?.payload?.kind !== 'control-plane-grant.v2') {
      throw workflowError(
        'CONTROL_PLANE_GRANT_INVALID',
        'The material-bound updater accepts only a Control-Plane Grant v2.',
        ExitCode.guard,
      );
    }
    controlPlanePromotionBundleDigestV2(input.bundle);
    assertApprovalCandidateBindingsV2(
      input.beforeManifest,
      input.afterManifest,
      input.bundle,
    );
    if (
      input.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION_V2
    ) {
      throw workflowError(
        'CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED',
        'This material-bound updater cannot execute the requested updater version.',
        ExitCode.guard,
      );
    }
    if (
      fs.existsSync(
        controlPlaneUpdateRecordPath(
          storageRoot,
          input.envelope.payload.grantId,
        ),
      )
    ) {
      readPersistedControlPlaneUpdate(
        storageRoot,
        input.envelope.payload.grantId,
      );
      throw workflowError(
        'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
        'Control-Plane Grant already has a durable transaction.',
        ExitCode.conflict,
      );
    }
    verifyControlPlaneGrantV2(input.envelope, {
      now,
      beforeManifest: input.beforeManifest,
      afterManifest: input.afterManifest,
      bundle: input.bundle,
      consumedGrantIds: dependencies.consumedGrantIds,
      verifyHumanSignature: dependencies.verifyHumanSignature,
    });
    revalidateControlPlaneTaskMandate(
      input.envelope.payload.mandateBinding,
      dependencies,
      'before-persistence',
    );
    const supervisor = readControlPlaneSupervisorState(storageRoot);
    assertSupervisorMatchesOldClosureV2(supervisor, input.bundle.material);
    const paths = ensureUpdaterDirectories(storageRoot);
    persistPromotionBundle(paths, input.envelope.payload.grantId, input.bundle);
    const runtimeBundle = runtimePromotionBundle(input.bundle);
    materializeBundleExecutables(paths, runtimeBundle);
    const record = preparePersistedControlPlaneUpdateV2(
      storageRoot,
      {
        txId: input.txId,
        envelope: input.envelope,
        beforeManifest: input.beforeManifest,
        afterManifest: input.afterManifest,
        bundle: input.bundle,
      },
      {
        now: () => now,
        consumedGrantIds: dependencies.consumedGrantIds,
        verifyHumanSignature: dependencies.verifyHumanSignature,
      },
    );
    emitAuditHistory(record, runtimeBundle, dependencies);
    return { record, supervisor };
  });
}

export function executeControlPlanePromotion(
  storageRoot: string,
  grantId: string,
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, `execute:${grantId}`, () =>
    driveControlPlanePromotion(storageRoot, grantId, dependencies),
  );
}

export function recoverControlPlanePromotion(
  storageRoot: string,
  grantId: string,
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, `recover:${grantId}`, () =>
    driveControlPlanePromotion(storageRoot, grantId, dependencies),
  );
}

function driveControlPlanePromotion(
  storageRoot: string,
  grantId: string,
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  requireUpdaterDependencies(dependencies);
  const paths = ensureUpdaterDirectories(storageRoot);
  let record = readPersistedControlPlaneUpdate(storageRoot, grantId);
  const bundle = readPromotionBundle(paths, grantId);
  verifyPersistedPromotion(record, bundle, dependencies);
  materializeBundleExecutables(paths, bundle);
  let supervisor = readControlPlaneSupervisorState(storageRoot);
  if (supervisor.repositoryId !== bundle.repositoryId) {
    throw supervisorCorrupt();
  }
  let switchedInThisInvocation = false;
  let conservativeRollback =
    record.transaction.state === 'SWITCHED' ||
    (record.transaction.state === 'RECOVERY_VERIFIED' &&
      supervisor.activeArtifact.artifactId ===
        bundle.candidateArtifact.artifactId);

  emitAuditHistory(record, bundle, dependencies);
  for (;;) {
    switch (record.transaction.state) {
      case 'PREPARED': {
        revalidateControlPlaneTaskMandate(
          record.envelope.payload.mandateBinding,
          dependencies,
          'before-forward-effect',
        );
        assertGrantLiveForForwardEffect(record, dependencies);
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        const evidence = canonicalDigest({
          kind: 'old-closure-evidence.v1',
          supervisorDigest: supervisor.recordDigest,
          closureDigest: supervisor.activeArtifact.closureDigest,
        });
        record = advanceRecord(record, storageRoot, {
          kind: 'old-closure-verified',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: evidence,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'OLD_CLOSURE_VERIFIED': {
        revalidateControlPlaneTaskMandate(
          record.envelope.payload.mandateBinding,
          dependencies,
          'before-forward-effect',
        );
        assertGrantLiveForForwardEffect(record, dependencies);
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        runtimePromotionBundle(bundle.storedBundle);
        const executablePath = materializedExecutablePath(
          paths,
          bundle.candidateArtifact,
        );
        assertConfinedExecutable(
          paths,
          executablePath,
          bundle.candidateArtifact.executableDigest,
        );
        record = advanceRecord(record, storageRoot, {
          kind: 'candidate-verified',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: canonicalDigest({
            kind: 'candidate-verification-evidence.v1',
            promotionBundleDigest: bundle.bundleDigest,
            artifactId: bundle.candidateArtifact.artifactId,
            executableDigest: bundle.candidateArtifact.executableDigest,
          }),
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'CANDIDATE_VERIFIED': {
        revalidateControlPlaneTaskMandate(
          record.envelope.payload.mandateBinding,
          dependencies,
          'before-forward-effect',
        );
        assertGrantLiveForForwardEffect(record, dependencies);
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        const restartPath = materializedExecutablePath(
          paths,
          bundle.recoveryBundle.restartArtifact,
        );
        const restart = runRestartProbe(
          paths,
          restartPath,
          bundle.recoveryBundle.restartArtifact.executableDigest,
          bundle.beforeClosureDigest,
        );
        record = advanceRecord(record, storageRoot, {
          kind: 'recovery-bundle-verified',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: canonicalDigest({
            kind: 'recovery-verification-evidence.v1',
            bundleDigest: bundle.recoveryBundle.bundleDigest,
            restartEvidenceDigest: restart.evidenceDigest,
          }),
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'RECOVERY_VERIFIED': {
        if (
          supervisor.activeArtifact.artifactId ===
            bundle.candidateArtifact.artifactId &&
          supervisor.activeArtifact.closureDigest === bundle.afterClosureDigest
        ) {
          conservativeRollback = true;
        } else {
          const promotionPin =
            record.kind === 'persisted-control-plane-update.v2'
              ? reserveBootstrapSidecarPromotion(storageRoot, {
                  interventionChangeId: bundle.candidateArtifact.sourceChangeId,
                  grantId,
                  txId: record.transaction.txId,
                  artifact: bundle.candidateArtifact,
                  candidateExecutableProvenanceDigest:
                    requiredV2CandidateExecutableProvenanceDigest(bundle),
                  closureDigest: bundle.afterClosureDigest,
                  at: record.updatedAt,
                })
              : null;
          requireV2SidecarAuthority(record, promotionPin, 'pre-switch pin');
          revalidateControlPlaneTaskMandate(
            record.envelope.payload.mandateBinding,
            dependencies,
            'before-atomic-switch',
          );
          assertGrantLiveForForwardEffect(record, dependencies);
          assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
          supervisor = selectSupervisorArtifact(
            storageRoot,
            supervisor,
            bundle.candidateArtifact,
            bundle.afterClosureDigest,
            record,
            'candidate-selected',
            updaterNow(dependencies),
          );
          switchedInThisInvocation = true;
          dependencies.testHooks?.afterAtomicSwitch?.();
        }
        record = advanceRecord(record, storageRoot, {
          kind: 'atomic-switch-completed',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: supervisor.recordDigest,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'SWITCHED': {
        assertSupervisorIsCandidate(supervisor, bundle);
        if (conservativeRollback || !switchedInThisInvocation) {
          record = advanceRecord(record, storageRoot, {
            kind: 'self-tests-failed',
            at: nextTransitionTime(record, dependencies),
            evidenceDigest: canonicalDigest({
              kind: 'conservative-crash-recovery.v1',
              supervisorDigest: supervisor.recordDigest,
            }),
          });
          emitAuditHistory(record, bundle, dependencies);
          continue;
        }
        const candidatePath = materializedExecutablePath(
          paths,
          bundle.candidateArtifact,
        );
        let selfTest: SelfTestEvidence;
        try {
          selfTest = runSelfTest(
            paths,
            candidatePath,
            bundle.candidateArtifact.executableDigest,
            bundle.afterClosureDigest,
          );
        } catch (error) {
          selfTest = {
            healthy: false,
            closureDigest: bundle.afterClosureDigest,
            evidenceDigest: canonicalDigest({
              kind: 'control-plane-self-test-failure.v1',
              failureCode: workflowFailureCode(error),
            }),
          };
        }
        record = advanceRecord(record, storageRoot, {
          kind: selfTest.healthy ? 'self-tests-passed' : 'self-tests-failed',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: selfTest.evidenceDigest,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'SELF_TESTED': {
        assertSupervisorIsCandidate(supervisor, bundle);
        const finalizedAt = nextTransitionTime(record, dependencies);
        const commitIntent =
          record.kind === 'persisted-control-plane-update.v2'
            ? advanceBootstrapSidecarPromotionPin(storageRoot, {
                txId: record.transaction.txId,
                expectedState: 'reserved',
                state: 'commit-intent',
                at: finalizedAt,
              })
            : null;
        requireV2SidecarAuthority(record, commitIntent, 'commit-intent pin');
        record = advanceRecord(record, storageRoot, {
          kind: 'finalize',
          at: finalizedAt,
          evidenceDigest: supervisor.recordDigest,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'ROLLBACK_REQUIRED': {
        if (
          supervisor.activeArtifact.artifactId ===
          bundle.candidateArtifact.artifactId
        ) {
          assertSupervisorIsCandidate(supervisor, bundle);
          supervisor = selectSupervisorArtifact(
            storageRoot,
            supervisor,
            bundle.recoveryBundle.restartArtifact,
            bundle.beforeClosureDigest,
            record,
            'rollback-restored',
            updaterNow(dependencies),
          );
        } else {
          assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        }
        const restartPath = materializedExecutablePath(
          paths,
          bundle.recoveryBundle.restartArtifact,
        );
        const restart = runRestartProbe(
          paths,
          restartPath,
          bundle.recoveryBundle.restartArtifact.executableDigest,
          bundle.beforeClosureDigest,
        );
        record = advanceRecord(record, storageRoot, {
          kind: 'rollback-completed',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: canonicalDigest({
            kind: 'rollback-completion-evidence.v1',
            supervisorDigest: supervisor.recordDigest,
            restartEvidenceDigest: restart.evidenceDigest,
          }),
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'FINALIZED':
        assertSupervisorIsCandidate(supervisor, bundle);
        emitAuditHistory(record, bundle, dependencies);
        const projection =
          record.kind === 'persisted-control-plane-update.v2'
            ? recordBootstrapSidecarPromotionIfPresent(storageRoot, {
                interventionChangeId: bundle.candidateArtifact.sourceChangeId,
                grantId,
                txId: record.transaction.txId,
                artifact: bundle.candidateArtifact,
                closureDigest: bundle.afterClosureDigest,
                evidenceDigest: record.transaction.journalDigest,
                at: record.updatedAt,
              })
            : null;
        requireV2SidecarAuthority(record, projection, 'final projection');
        const finalizedPin =
          record.kind === 'persisted-control-plane-update.v2'
            ? advanceBootstrapSidecarPromotionPin(storageRoot, {
                txId: record.transaction.txId,
                expectedState: 'commit-intent',
                state: 'finalized',
                at: record.updatedAt,
              })
            : null;
        requireV2SidecarAuthority(record, finalizedPin, 'finalized pin');
        return { record, supervisor };
      case 'ROLLED_BACK':
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        emitAuditHistory(record, bundle, dependencies);
        let rolledBackPin = null;
        if (
          record.kind === 'persisted-control-plane-update.v2' &&
          fs.existsSync(
            bootstrapSidecarPromotionPinPath(
              storageRoot,
              record.transaction.txId,
            ),
          )
        ) {
          const pin = readBootstrapSidecarPromotionPin(
            storageRoot,
            record.transaction.txId,
          );
          rolledBackPin = advanceBootstrapSidecarPromotionPin(storageRoot, {
            txId: record.transaction.txId,
            expectedState: pin.state,
            state: 'rolled-back',
            at: record.updatedAt,
          });
        }
        // A crash can leave a historical V2 supervisor effect-ahead of its
        // pin. Missing authority must never permit forward progress, but it
        // also must not strand the candidate during conservative rollback.
        if (rolledBackPin !== null) {
          requireV2SidecarAuthority(record, rolledBackPin, 'rollback pin');
        }
        return { record, supervisor };
    }
  }
}

function requiredV2CandidateExecutableProvenanceDigest(
  bundle: RuntimeControlPlanePromotionBundle,
): Sha256Digest {
  if (
    bundle.version !== 2 ||
    bundle.candidateExecutableProvenanceDigest === null
  ) {
    throw workflowError(
      'CONTROL_PLANE_V2_SIDECAR_AUTHORITY_REQUIRED',
      'Control-plane update v2 requires signed persisted-artifact provenance.',
      ExitCode.verification,
    );
  }
  return bundle.candidateExecutableProvenanceDigest;
}

function requireV2SidecarAuthority<T>(
  record: PersistedControlPlaneUpdateRecord,
  value: T | null,
  phase: string,
): T | null {
  if (record.kind === 'persisted-control-plane-update.v2' && value === null) {
    throw workflowError(
      'CONTROL_PLANE_V2_SIDECAR_AUTHORITY_REQUIRED',
      `Control-plane update v2 is missing its exact sidecar authority during ${phase}.`,
      ExitCode.verification,
    );
  }
  return value;
}

function verifyPersistedPromotion(
  record: PersistedControlPlaneUpdateRecord,
  bundle: RuntimeControlPlanePromotionBundle,
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  // Recheck the persisted human signature and every exact binding. Expiry is
  // intentionally checked separately before forward effects: once switched,
  // rollback/finalization must remain possible after expiry.
  if (record.kind === 'persisted-control-plane-update.v1') {
    if (
      bundle.version !== 1 ||
      bundle.storedBundle.kind !== 'control-plane-promotion-bundle.v1'
    ) {
      throw promotionBundleCorrupt(
        'Persisted v1 transaction is paired with a different bundle version.',
      );
    }
    const storedBundle = bundle.storedBundle;
    assertPromotionBindings(
      record.envelope,
      record.beforeManifest,
      record.afterManifest,
      storedBundle,
    );
    if (
      record.transaction.updaterVersion !== SUPPORTED_UPDATER_VERSION ||
      record.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION
    ) {
      throw workflowError(
        'CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED',
        'Persisted promotion requires a different minimal updater.',
        ExitCode.guard,
      );
    }
    verifyControlPlaneGrant(record.envelope, {
      now: new Date(record.envelope.payload.issuedAt),
      beforeManifest: record.beforeManifest,
      afterManifest: record.afterManifest,
      changes: storedBundle.exactChanges,
      consumedGrantIds: new Set<string>(),
      verifyHumanSignature: dependencies.verifyHumanSignature,
    });
    verifyIndependentReviewForPromotion(
      record.envelope,
      storedBundle,
      dependencies.verifyHumanSignature,
    );
    return;
  }
  if (
    bundle.version !== 2 ||
    bundle.storedBundle.kind !== 'control-plane-promotion-bundle.v2' ||
    record.transaction.updaterVersion !== SUPPORTED_UPDATER_VERSION_V2 ||
    record.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION_V2
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED',
      'Persisted material-bound promotion requires updater v2.',
      ExitCode.guard,
    );
  }
  verifyControlPlaneGrantV2(record.envelope, {
    now: new Date(record.envelope.payload.issuedAt),
    beforeManifest: record.beforeManifest,
    afterManifest: record.afterManifest,
    bundle: bundle.storedBundle,
    consumedGrantIds: new Set<string>(),
    verifyHumanSignature: dependencies.verifyHumanSignature,
  });
}

function readControlPlaneRecoveryContext(
  storageRoot: string,
  sourceControlPlaneGrantId: string,
  dependencies: ControlPlaneRecoveryExecutorDependencies,
): ControlPlaneRecoveryContext {
  const paths = ensureUpdaterDirectories(storageRoot);
  const record = readPersistedControlPlaneUpdate(
    storageRoot,
    sourceControlPlaneGrantId,
  );
  const bundle = readPromotionBundle(paths, sourceControlPlaneGrantId);
  verifyPersistedPromotion(record, bundle, dependencies);
  const supervisor = readControlPlaneSupervisorState(storageRoot);
  if (
    record.envelope.payload.grantId !== sourceControlPlaneGrantId ||
    record.transaction.grantId !== sourceControlPlaneGrantId ||
    record.transaction.txId !== supervisor.transition?.txId ||
    supervisor.transition.grantId !== sourceControlPlaneGrantId ||
    supervisor.repositoryId !== bundle.repositoryId ||
    record.transaction.beforeClosureDigest !== bundle.beforeClosureDigest ||
    record.transaction.afterClosureDigest !== bundle.afterClosureDigest ||
    record.transaction.recoveryBundleDigest !==
      bundle.recoveryBundle.bundleDigest
  ) {
    throw recoveryStateBindingMismatch();
  }
  return { record, bundle, supervisor };
}

function assertInitialRecoveryContext(
  context: ControlPlaneRecoveryContext,
): void {
  const { record, bundle, supervisor } = context;
  if (
    record.grantState !== 'reserved' ||
    !['RECOVERY_VERIFIED', 'SWITCHED', 'ROLLBACK_REQUIRED'].includes(
      record.transaction.state,
    ) ||
    supervisor.transition?.phase !== 'candidate-selected' ||
    supervisor.activeArtifact.artifactId !==
      bundle.candidateArtifact.artifactId ||
    supervisor.activeArtifact.executableDigest !==
      bundle.candidateArtifact.executableDigest ||
    supervisor.activeArtifact.closureDigest !== bundle.afterClosureDigest
  ) {
    throw workflowError(
      'HARNESS_RECOVERY_ROLLBACK_NOT_REQUIRED',
      'Recovery Grant requires the exact broken candidate closure to be selected by an incomplete control-plane transaction.',
      ExitCode.conflict,
    );
  }
}

function recoveryStateBinding(
  context: ControlPlaneRecoveryContext,
): ControlPlaneRecoveryStateBinding {
  const { record, bundle, supervisor } = context;
  assertInitialRecoveryContext(context);
  return {
    repositoryId: bundle.repositoryId,
    sourceControlPlaneGrantId: record.envelope.payload.grantId,
    previousClosureDigest: bundle.beforeClosureDigest,
    currentClosureDigest: bundle.afterClosureDigest,
    promotionBundleDigest: bundle.bundleDigest,
    recoveryBundleDigest: bundle.recoveryBundle.bundleDigest,
    controlPlaneUpdateRecordDigest: record.recordDigest,
    controlPlaneJournalDigest: record.transaction.journalDigest,
    sourceTransactionState: record.transaction
      .state as ControlPlaneRecoveryStateBinding['sourceTransactionState'],
    supervisorStateDigest: supervisor.recordDigest,
    supervisorGeneration: supervisor.generation,
    externalAuditRoot: record.envelope.payload.mandateBinding.externalAuditRoot,
  };
}

function recoveryContextMatchesPayload(
  context: ControlPlaneRecoveryContext,
  payload: ControlPlaneRecoveryGrantPayload,
): boolean {
  try {
    return (
      canonicalJson(recoveryStateBinding(context)) ===
      canonicalJson(recoveryBindingFromPayload(payload))
    );
  } catch {
    return false;
  }
}

function isRecoveryCompletionContext(
  context: ControlPlaneRecoveryContext,
  payload: ControlPlaneRecoveryGrantPayload,
): boolean {
  const { record, bundle, supervisor } = context;
  const stableIdentity =
    bundle.repositoryId === payload.repositoryId &&
    record.envelope.payload.grantId === payload.sourceControlPlaneGrantId &&
    bundle.beforeClosureDigest === payload.previousClosureDigest &&
    bundle.afterClosureDigest === payload.currentClosureDigest &&
    bundle.bundleDigest === payload.promotionBundleDigest &&
    bundle.recoveryBundle.bundleDigest === payload.recoveryBundleDigest &&
    record.envelope.payload.mandateBinding.externalAuditRoot ===
      payload.externalAuditRoot;
  if (!stableIdentity) return false;
  const state = record.transaction.state;
  const candidateSelected =
    ['SWITCHED', 'ROLLBACK_REQUIRED'].includes(state) &&
    record.grantState === 'reserved' &&
    supervisor.transition?.phase === 'candidate-selected' &&
    supervisor.activeArtifact.artifactId ===
      bundle.candidateArtifact.artifactId &&
    supervisor.activeArtifact.closureDigest === payload.currentClosureDigest &&
    supervisor.generation === payload.supervisorGeneration;
  const rollbackSelected =
    ['ROLLBACK_REQUIRED', 'ROLLED_BACK'].includes(state) &&
    supervisor.transition?.phase === 'rollback-restored' &&
    supervisor.activeArtifact.artifactId ===
      bundle.recoveryBundle.restartArtifact.artifactId &&
    supervisor.activeArtifact.closureDigest === payload.previousClosureDigest &&
    supervisor.generation === payload.supervisorGeneration + 1 &&
    (state === 'ROLLED_BACK') === (record.grantState === 'consumed');
  return candidateSelected || rollbackSelected;
}

function isRollbackSelectedForRecoveryFailure(
  context: ControlPlaneRecoveryContext,
  payload: ControlPlaneRecoveryGrantPayload,
): boolean {
  return (
    isRecoveryCompletionContext(context, payload) &&
    context.record.transaction.state === 'ROLLBACK_REQUIRED' &&
    context.record.grantState === 'reserved' &&
    context.supervisor.transition?.phase === 'rollback-restored' &&
    context.supervisor.activeArtifact.artifactId ===
      context.bundle.recoveryBundle.restartArtifact.artifactId &&
    context.supervisor.activeArtifact.closureDigest ===
      payload.previousClosureDigest
  );
}

function recoveryBindingFromPayload(
  payload: ControlPlaneRecoveryGrantPayload,
): ControlPlaneRecoveryStateBinding {
  return {
    repositoryId: payload.repositoryId,
    sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
    previousClosureDigest: payload.previousClosureDigest,
    currentClosureDigest: payload.currentClosureDigest,
    promotionBundleDigest: payload.promotionBundleDigest,
    recoveryBundleDigest: payload.recoveryBundleDigest,
    controlPlaneUpdateRecordDigest: payload.controlPlaneUpdateRecordDigest,
    controlPlaneJournalDigest: payload.controlPlaneJournalDigest,
    sourceTransactionState: payload.sourceTransactionState,
    supervisorStateDigest: payload.supervisorStateDigest,
    supervisorGeneration: payload.supervisorGeneration,
    externalAuditRoot: payload.externalAuditRoot,
  };
}

function recoveryApprovalSummary(
  payload: ControlPlaneRecoveryGrantPayload,
): ControlPlaneRecoveryApprovalSummary {
  return deepFreeze({
    kind: 'control-plane-recovery-approval-summary.v1',
    recoveryGrantId: payload.grantId,
    sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
    repositoryId: payload.repositoryId,
    operation: payload.operation,
    previousClosureDigest: payload.previousClosureDigest,
    currentClosureDigest: payload.currentClosureDigest,
    promotionBundleDigest: payload.promotionBundleDigest,
    recoveryBundleDigest: payload.recoveryBundleDigest,
    controlPlaneUpdateRecordDigest: payload.controlPlaneUpdateRecordDigest,
    controlPlaneJournalDigest: payload.controlPlaneJournalDigest,
    supervisorStateDigest: payload.supervisorStateDigest,
    supervisorGeneration: payload.supervisorGeneration,
    sourceTransactionState: payload.sourceTransactionState,
    externalAuditRoot: payload.externalAuditRoot,
    humanSigner: payload.humanSigner,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    approvalDigest: canonicalDigest(payload),
    humanReadable: [
      'Recovery operation: rollback-control-plane',
      `Recovery Grant: ${payload.grantId}`,
      `Repository: ${payload.repositoryId}`,
      `Source Control-Plane Grant: ${payload.sourceControlPlaneGrantId}`,
      `Source transaction state: ${payload.sourceTransactionState}`,
      `Current closure: ${payload.currentClosureDigest}`,
      `Restore closure: ${payload.previousClosureDigest}`,
      `Promotion bundle: ${payload.promotionBundleDigest}`,
      `Update record: ${payload.controlPlaneUpdateRecordDigest}`,
      `Update journal: ${payload.controlPlaneJournalDigest}`,
      `Supervisor state: ${payload.supervisorStateDigest} (generation ${payload.supervisorGeneration})`,
      `Recovery bundle: ${payload.recoveryBundleDigest}`,
      `External audit root: ${payload.externalAuditRoot}`,
      `Human signer: ${payload.humanSigner}`,
      `Approval digest: ${canonicalDigest(payload)}`,
      `Expires: ${payload.expiresAt}`,
    ].join('\n'),
  });
}

function recoveryStateBindingMismatch(): ReturnType<typeof workflowError> {
  return workflowError(
    'HARNESS_RECOVERY_STATE_BINDING_MISMATCH',
    'Recovery Grant no longer matches the exact control-plane journal, supervisor generation, and closure selection.',
    ExitCode.staleState,
  );
}

function recoveryRepairRequired(): ReturnType<typeof workflowError> {
  return workflowError(
    'HARNESS_RECOVERY_REPAIR_REQUIRED',
    'The immutable restart bundle failed verification; issue a distinct exact recovery operation instead of replaying this Grant.',
    ExitCode.conflict,
  );
}

function revalidateControlPlaneTaskMandate(
  binding: ControlPlaneTaskMandateBinding,
  dependencies: ControlPlaneUpdaterDependencies,
  phase: ControlPlaneTaskMandateValidationPhase,
): void {
  dependencies.revalidateTaskMandateBinding?.(
    normalizeControlPlaneTaskMandateBinding(binding),
    phase,
  );
}

function verifyIndependentReviewForPromotion(
  envelope: ControlPlaneGrantEnvelope,
  bundle: ControlPlanePromotionBundle,
  verifyHumanSignature: PersistenceHumanSignatureVerifier,
): void {
  verifyControlPlaneIndependentReviewAttestation(
    bundle.independentReviewAttestation,
    {
      expectedDigest: envelope.payload.independentReviewAttestationDigest,
      repositoryId: bundle.repositoryId,
      candidateDigest: bundle.candidateDigest,
      beforeClosureDigest: bundle.beforeClosureDigest,
      afterClosureDigest: bundle.afterClosureDigest,
      recoveryBundleDigest: bundle.recoveryBundle.bundleDigest,
      affectedCapabilities: envelope.payload.affectedCapabilities,
      grantHumanSigner: envelope.payload.humanSigner,
      grantIssuedAt: envelope.payload.issuedAt,
      verifyHumanSignature,
    },
  );
}

function assertPromotionBindings(
  envelope: ControlPlaneGrantEnvelope,
  beforeManifest: ProtectedCapabilityManifest,
  afterManifest: ProtectedCapabilityManifest,
  bundle: ControlPlanePromotionBundle,
): void {
  const payload = envelope.payload;
  if (
    canonicalJson(bundle.mandateBinding) !==
      canonicalJson(payload.mandateBinding) ||
    bundle.repositoryId !== payload.repositoryId ||
    bundle.candidateDigest !== payload.candidateDigest ||
    bundle.beforeClosureDigest !== payload.beforeClosureDigest ||
    bundle.afterClosureDigest !== payload.afterClosureDigest ||
    bundle.beforeClosureDigest !== beforeManifest.manifestDigest ||
    bundle.afterClosureDigest !== afterManifest.manifestDigest ||
    canonicalJson(bundle.exactChanges) !==
      canonicalJson(payload.exactChanges) ||
    bundle.recoveryBundle.bundleDigest !==
      payload.recoveryBundle.bundleDigest ||
    bundle.recoveryBundle.previousClosureDigest !==
      payload.recoveryBundle.previousClosureDigest ||
    bundle.recoveryBundle.restartArtifact.executableDigest !==
      payload.recoveryBundle.restartArtifactDigest ||
    bundle.recoveryBundle.rollbackTestReportDigest !==
      payload.recoveryBundle.rollbackTestReportDigest
  ) {
    throw promotionBundleCorrupt(
      'Promotion bundle does not match the exact Control-Plane Grant.',
    );
  }
}

function assertApprovalCandidateBindings(
  beforeManifest: ProtectedCapabilityManifest,
  afterManifest: ProtectedCapabilityManifest,
  bundle: ControlPlanePromotionBundle,
): ProtectedCandidateImpact {
  const impact = classifyProtectedCandidateImpact({
    beforeManifest,
    afterManifest,
    changes: bundle.exactChanges,
  });
  if (
    bundle.beforeClosureDigest !== beforeManifest.manifestDigest ||
    bundle.afterClosureDigest !== afterManifest.manifestDigest ||
    bundle.candidateDigest !== controlPlaneCandidateDigest(bundle.exactChanges)
  ) {
    throw approvalCandidateCorrupt(
      'Persisted manifests do not match the exact promotion bundle.',
    );
  }
  return impact;
}

function assertApprovalCandidateBindingsV2(
  beforeManifest: ProtectedCapabilityManifest,
  afterManifest: ProtectedCapabilityManifest,
  bundle: ControlPlanePromotionBundleV2,
): ProtectedCandidateImpact {
  controlPlanePromotionBundleDigestV2(bundle);
  const material = bundle.material;
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest,
    afterManifest,
    changes: material.exactChanges,
  });
  if (
    material.beforeClosureDigest !== beforeManifest.manifestDigest ||
    material.afterClosureDigest !== afterManifest.manifestDigest ||
    material.candidateDigest !==
      controlPlaneCandidateDigestV2(material.exactChanges)
  ) {
    throw approvalCandidateCorrupt(
      'Persisted manifests do not match the exact mode-aware promotion material.',
    );
  }
  return impact;
}

function assertApprovalCandidateBindingsV3(
  beforeManifest: ProtectedCapabilityManifest,
  afterManifest: ProtectedCapabilityManifest,
  bundle: ControlPlanePromotionBundleV3,
): ProtectedCandidateImpact {
  controlPlanePromotionBundleDigestV3(bundle);
  const material = bundle.material;
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest,
    afterManifest,
    changes: material.exactChanges,
  });
  if (
    material.beforeClosureDigest !== beforeManifest.manifestDigest ||
    material.afterClosureDigest !== afterManifest.manifestDigest ||
    material.candidateDigest !==
      controlPlaneCandidateDigestV2(material.exactChanges)
  ) {
    throw approvalCandidateCorrupt(
      'Persisted manifests do not match the exact successor promotion material.',
    );
  }
  return impact;
}

function controlPlaneApprovalSummary(
  candidate: PersistedControlPlaneApprovalCandidate,
  impact: ProtectedCandidateImpact,
  attestationDigest: Sha256Digest,
): ControlPlaneApprovalSummary {
  const review = candidate.bundle.independentReviewAttestation.payload;
  const affected = impact.affectedCapabilities.join(', ');
  const behaviorChangeSummary =
    `Independent review by ${review.reviewer} approved ` +
    `${candidate.bundle.exactChanges.length} exact control-plane changes ` +
    `affecting ${affected}: ${review.reviewSummary}`;
  const changedPaths = candidate.bundle.exactChanges
    .map(
      ({ path: changedPath, beforeDigest, afterDigest }) =>
        `- ${changedPath}: ${beforeDigest ?? '<absent>'} -> ${afterDigest ?? '<absent>'}`,
    )
    .join('\n');
  const humanReadable = [
    'Control-plane approval candidate',
    `Candidate id: ${candidate.candidateId}`,
    `Parent task: ${candidate.mandateBinding.parentTaskId}`,
    `Task mandate: ${candidate.mandateBinding.mandateId} (${candidate.mandateBinding.mandateDigest})`,
    `Change: ${candidate.mandateBinding.changeId}`,
    `External authority audit root: ${candidate.mandateBinding.externalAuditRoot}`,
    `Repository: ${candidate.bundle.repositoryId}`,
    `Affected capabilities: ${affected}`,
    `Before control-plane closure: ${candidate.bundle.beforeClosureDigest}`,
    `After control-plane closure: ${candidate.bundle.afterClosureDigest}`,
    `Recovery bundle: ${candidate.bundle.recoveryBundle.bundleDigest}`,
    `Rollback test report: ${candidate.bundle.recoveryBundle.rollbackTestReportDigest}`,
    `Independent review: PASS — ${attestationDigest}`,
    `Reviewer: ${review.reviewer} at ${review.reviewedAt}`,
    `Review summary: ${review.reviewSummary}`,
    `Exact changes (${candidate.bundle.exactChanges.length}):`,
    changedPaths,
  ].join('\n');
  return deepFreeze({
    kind: 'control-plane-approval-summary.v1' as const,
    mandateBinding: structuredClone(candidate.mandateBinding),
    candidateId: candidate.candidateId,
    candidateRecordDigest: candidate.recordDigest,
    repositoryId: candidate.bundle.repositoryId,
    candidateDigest: candidate.bundle.candidateDigest,
    exactChanges: candidate.bundle.exactChanges.map((change) => ({
      ...change,
    })),
    affectedCapabilities: [...impact.affectedCapabilities],
    beforeClosureDigest: candidate.bundle.beforeClosureDigest,
    afterClosureDigest: candidate.bundle.afterClosureDigest,
    recoveryBundleDigest: candidate.bundle.recoveryBundle.bundleDigest,
    rollbackTestReportDigest:
      candidate.bundle.recoveryBundle.rollbackTestReportDigest,
    independentReview: {
      attestationDigest,
      reviewer: review.reviewer,
      reviewedAt: review.reviewedAt,
      verdict: review.verdict,
      reviewSummary: review.reviewSummary,
    },
    behaviorChangeSummary,
    humanReadable,
  });
}

function controlPlaneApprovalSummaryV2(
  candidate: PersistedControlPlaneApprovalCandidateV2,
  impact: ProtectedCandidateImpact,
  attestationDigest: Sha256Digest,
): ControlPlaneApprovalSummaryV2 {
  const { material } = candidate.bundle;
  const review = candidate.bundle.independentReviewAttestation.payload;
  const affected = impact.affectedCapabilities.join(', ');
  const behaviorChangeSummary = material.behaviorChangeSummary;
  const changedPaths = material.exactChanges
    .map(
      ({
        path: changedPath,
        beforeDigest,
        afterDigest,
        beforeMode,
        afterMode,
      }) =>
        `- ${changedPath}: ${beforeDigest ?? '<absent>'} (${beforeMode ?? '<absent>'}) -> ${afterDigest ?? '<absent>'} (${afterMode ?? '<absent>'})`,
    )
    .join('\n');
  const humanReadable = [
    'Control-plane approval candidate v2',
    `Candidate id: ${candidate.candidateId}`,
    `Frozen Class-C candidate: ${material.frozenCandidateBundleDigest}`,
    `Promotion material: ${candidate.bundle.promotionMaterialDigest}`,
    `Reviewed promotion bundle: ${candidate.bundle.bundleDigest}`,
    `Parent task: ${candidate.mandateBinding.parentTaskId}`,
    `Task mandate: ${candidate.mandateBinding.mandateId} (${candidate.mandateBinding.mandateDigest})`,
    `Change: ${candidate.mandateBinding.changeId}`,
    `External authority audit root: ${candidate.mandateBinding.externalAuditRoot}`,
    `Repository: ${material.repositoryId}`,
    `Affected capabilities: ${affected}`,
    `Before control-plane closure: ${material.beforeClosureDigest}`,
    `After control-plane closure: ${material.afterClosureDigest}`,
    `Candidate executable provenance: ${material.candidateExecutableProvenanceDigest}`,
    `Recovery bundle: ${material.recoveryBundle.bundleDigest}`,
    `Recovery executable provenance: ${material.recoveryBundle.restartExecutableProvenanceDigest}`,
    `Rollback test report: ${material.recoveryBundle.rollbackTestReportDigest}`,
    `Independent review: PASS — ${attestationDigest}`,
    `Reviewer: ${review.reviewer} at ${review.reviewedAt}`,
    `Review summary: ${review.reviewSummary}`,
    `Behavior change: ${behaviorChangeSummary}`,
    `Exact mode-aware changes (${material.exactChanges.length}):`,
    changedPaths,
  ].join('\n');
  return deepFreeze({
    kind: 'control-plane-approval-summary.v2' as const,
    mandateBinding: structuredClone(candidate.mandateBinding),
    candidateId: candidate.candidateId,
    candidateRecordDigest: candidate.recordDigest,
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    candidateDigest: material.candidateDigest,
    promotionMaterialDigest: candidate.bundle.promotionMaterialDigest,
    promotionBundleDigest: candidate.bundle.bundleDigest,
    exactChanges: material.exactChanges.map((change) => ({ ...change })),
    affectedCapabilities: [...impact.affectedCapabilities],
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    recoveryBundleDigest: material.recoveryBundle.bundleDigest,
    rollbackTestReportDigest: material.recoveryBundle.rollbackTestReportDigest,
    independentReview: {
      attestationDigest,
      reviewer: review.reviewer,
      reviewedAt: review.reviewedAt,
      verdict: review.verdict,
      reviewSummary: review.reviewSummary,
    },
    behaviorChangeSummary,
    humanReadable,
  });
}

function controlPlaneApprovalSummaryV3(
  candidate: PersistedControlPlaneApprovalCandidateV3,
  impact: ProtectedCandidateImpact,
  attestationDigest: Sha256Digest,
): ControlPlaneApprovalSummaryV3 {
  const v2 = controlPlaneApprovalSummaryV2(
    {
      ...candidate,
      kind: 'persisted-control-plane-approval-candidate.v2',
      bundle: {
        kind: 'control-plane-promotion-bundle.v2',
        material: candidate.bundle.material,
        promotionMaterialDigest: candidate.bundle.promotionMaterialDigest,
        independentReviewAttestation: {
          payload: {
            ...candidate.bundle.independentReviewAttestation.payload,
            kind: 'control-plane-independent-review.v2',
          },
          signature: candidate.bundle.independentReviewAttestation.signature,
        },
        bundleDigest: candidate.bundle.bundleDigest,
      },
    },
    impact,
    attestationDigest,
  );
  const lineage = candidate.bundle.lineage;
  const humanReadable = [
    'Control-plane successor approval candidate v3',
    `Candidate id: ${candidate.candidateId}`,
    `Promotion lineage: ${lineage.lineageDigest}`,
    `History anchor: ${lineage.historyAnchorDigest}`,
    `Previous terminal: ${lineage.previousTerminalRecordDigest}`,
    `Previous supervisor: ${lineage.previousSupervisorRecordDigest}`,
    `Supervisor generation: ${lineage.previousGeneration} -> ${lineage.candidateGeneration}`,
    `Rollback generation: ${lineage.rollbackGeneration}`,
    `Trust commit: ${lineage.previousActiveTrustCommit} -> ${lineage.candidateTrustCommit}`,
    ...v2.humanReadable.split('\n').slice(1),
  ].join('\n');
  return deepFreeze({
    ...v2,
    kind: 'control-plane-approval-summary.v3' as const,
    promotionLineageDigest: lineage.lineageDigest,
    previousGeneration: lineage.previousGeneration,
    candidateGeneration: lineage.candidateGeneration,
    rollbackGeneration: lineage.rollbackGeneration,
    previousSupervisorRecordDigest: lineage.previousSupervisorRecordDigest,
    previousTerminalRecordDigest: lineage.previousTerminalRecordDigest,
    humanReadable,
  });
}

function verifyPromotionBundle(
  value: ControlPlanePromotionBundle,
): ControlPlanePromotionBundle {
  if (
    isRecord(value) &&
    !Object.prototype.hasOwnProperty.call(value, 'independentReviewAttestation')
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_ATTESTATION_MISSING',
      'Promotion bundle must carry the exact signed independent review bytes.',
      ExitCode.guard,
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'afterClosureDigest',
      'beforeClosureDigest',
      'bundleDigest',
      'candidateArtifact',
      'candidateDigest',
      'candidateExecutablePath',
      'candidateFiles',
      'exactChanges',
      'independentReviewAttestation',
      'kind',
      'mandateBinding',
      'recoveryBundle',
      'repositoryId',
    ]) ||
    value.kind !== 'control-plane-promotion-bundle.v1'
  ) {
    throw promotionBundleCorrupt('Unknown promotion bundle schema.');
  }
  const rebuilt = createControlPlanePromotionBundle({
    mandateBinding: value.mandateBinding,
    repositoryId: value.repositoryId,
    candidateDigest: value.candidateDigest,
    beforeClosureDigest: value.beforeClosureDigest,
    afterClosureDigest: value.afterClosureDigest,
    exactChanges: value.exactChanges,
    candidateArtifact: value.candidateArtifact,
    candidateExecutablePath: value.candidateExecutablePath,
    candidateFiles: value.candidateFiles,
    recoveryBundle: value.recoveryBundle,
    independentReviewAttestation: value.independentReviewAttestation,
  });
  if (rebuilt.bundleDigest !== value.bundleDigest) {
    throw promotionBundleCorrupt('Promotion bundle digest mismatch.');
  }
  return rebuilt;
}

function runtimePromotionBundle(
  value: StoredControlPlanePromotionBundle,
): RuntimeControlPlanePromotionBundle {
  if (value.kind === 'control-plane-promotion-bundle.v1') {
    const bundle = verifyPromotionBundle(value);
    const candidate = bundle.candidateFiles.find(
      (file) => file.path === bundle.candidateExecutablePath,
    )!;
    const restart = bundle.recoveryBundle.previousFiles.find(
      (file) => file.path === bundle.recoveryBundle.restartExecutablePath,
    )!;
    return deepFreeze({
      version: 1 as const,
      storedBundle: structuredClone(bundle),
      mandateBinding: structuredClone(bundle.mandateBinding),
      repositoryId: bundle.repositoryId,
      candidateDigest: bundle.candidateDigest,
      beforeClosureDigest: bundle.beforeClosureDigest,
      afterClosureDigest: bundle.afterClosureDigest,
      candidateArtifact: structuredClone(bundle.candidateArtifact),
      candidateExecutableProvenanceDigest: null,
      candidateExecutableBase64: candidate.contentBase64,
      recoveryBundle: {
        bundleDigest: bundle.recoveryBundle.bundleDigest,
        previousClosureDigest: bundle.recoveryBundle.previousClosureDigest,
        restartArtifact: structuredClone(bundle.recoveryBundle.restartArtifact),
        restartExecutableBase64: restart.contentBase64,
        rollbackTestReportDigest:
          bundle.recoveryBundle.rollbackTestReportDigest,
      },
      bundleDigest: bundle.bundleDigest,
    });
  }
  controlPlanePromotionBundleDigestV2(value);
  const { material } = value;
  return deepFreeze({
    version: 2 as const,
    storedBundle: structuredClone(value),
    mandateBinding: structuredClone(material.mandateBinding),
    repositoryId: material.repositoryId,
    candidateDigest: material.candidateDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    candidateArtifact: structuredClone(material.candidateArtifact),
    candidateExecutableProvenanceDigest:
      material.candidateExecutableProvenanceDigest,
    candidateExecutableBase64: material.candidateExecutableBase64,
    recoveryBundle: {
      bundleDigest: material.recoveryBundle.bundleDigest,
      previousClosureDigest: material.recoveryBundle.previousClosureDigest,
      restartArtifact: structuredClone(material.recoveryBundle.restartArtifact),
      restartExecutableBase64: material.recoveryBundle.restartExecutableBase64,
      rollbackTestReportDigest:
        material.recoveryBundle.rollbackTestReportDigest,
    },
    bundleDigest: value.bundleDigest,
  });
}

function verifyRecoveryBundle(
  value: ControlPlaneRecoveryBundle,
): ControlPlaneRecoveryBundle {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bundleDigest',
      'kind',
      'previousClosureDigest',
      'previousFiles',
      'repositoryId',
      'restartArtifact',
      'restartExecutablePath',
      'rollbackTestReportBase64',
      'rollbackTestReportDigest',
    ]) ||
    value.kind !== 'control-plane-recovery-bundle.v1'
  ) {
    throw promotionBundleCorrupt('Unknown recovery bundle schema.');
  }
  const rebuilt = createControlPlaneRecoveryBundle({
    repositoryId: value.repositoryId,
    previousClosureDigest: value.previousClosureDigest,
    restartArtifact: value.restartArtifact,
    restartExecutablePath: value.restartExecutablePath,
    previousFiles: value.previousFiles,
    rollbackTestReportBase64: value.rollbackTestReportBase64,
    rollbackTestReportDigest: value.rollbackTestReportDigest,
  });
  if (rebuilt.bundleDigest !== value.bundleDigest) {
    throw promotionBundleCorrupt('Recovery bundle digest mismatch.');
  }
  return rebuilt;
}

function verifyPromotionFiles(
  files: ControlPlanePromotionFile[],
  code: string,
): ControlPlanePromotionFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw workflowError(
      code,
      'Promotion file inventory is empty.',
      ExitCode.guard,
    );
  }
  const verified = files.map((file) => {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ['contentBase64', 'contentDigest', 'mode', 'path']) ||
      (file.mode !== '100644' && file.mode !== '100755')
    ) {
      throw workflowError(
        code,
        'Promotion file entry is invalid.',
        ExitCode.guard,
      );
    }
    const logicalPath = safeLogicalPath(file.path, code);
    assertDigest(file.contentDigest, code);
    const content = decodeCanonicalBase64(file.contentBase64, code);
    if (rawDigest(content) !== file.contentDigest) {
      throw workflowError(
        code,
        'Promotion file digest mismatch.',
        ExitCode.verification,
      );
    }
    return {
      path: logicalPath,
      mode: file.mode,
      contentBase64: file.contentBase64,
      contentDigest: file.contentDigest,
    };
  });
  assertSortedUniquePaths(
    verified.map((file) => file.path),
    code,
  );
  return verified;
}

function verifyExactChanges(
  changes: ExactControlPlaneChange[],
): ExactControlPlaneChange[] {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw promotionBundleCorrupt('Exact candidate diff is empty.');
  }
  const verified = changes.map((change) => {
    if (
      !isRecord(change) ||
      !hasExactKeys(change, ['afterDigest', 'beforeDigest', 'path'])
    ) {
      throw promotionBundleCorrupt('Exact candidate entry is invalid.');
    }
    safeLogicalPath(change.path, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT');
    if (
      (change.beforeDigest !== null && !isDigest(change.beforeDigest)) ||
      (change.afterDigest !== null && !isDigest(change.afterDigest)) ||
      (change.beforeDigest === null && change.afterDigest === null) ||
      change.beforeDigest === change.afterDigest
    ) {
      throw promotionBundleCorrupt('Exact candidate digest entry is invalid.');
    }
    return { ...change };
  });
  assertSortedUniquePaths(
    verified.map((change) => change.path),
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
  );
  return verified;
}

function assertFilesMatchChanges(
  files: ControlPlanePromotionFile[],
  changes: ExactControlPlaneChange[],
  side: 'beforeDigest' | 'afterDigest',
): void {
  const expected = changes
    .filter((change) => change[side] !== null)
    .map((change) => ({ path: change.path, digest: change[side] }));
  if (
    files.length !== expected.length ||
    files.some(
      (file, index) =>
        file.path !== expected[index]?.path ||
        file.contentDigest !== expected[index]?.digest,
    )
  ) {
    throw promotionBundleCorrupt(
      `Promotion file inventory does not match ${side}.`,
    );
  }
}

function materializeBundleExecutables(
  paths: UpdaterPaths,
  bundle: RuntimeControlPlanePromotionBundle,
): void {
  materializeExecutable(
    paths,
    bundle.candidateArtifact,
    decodeCanonicalBase64(
      bundle.candidateExecutableBase64,
      'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
    ),
  );
  materializeExecutable(
    paths,
    bundle.recoveryBundle.restartArtifact,
    decodeCanonicalBase64(
      bundle.recoveryBundle.restartExecutableBase64,
      'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
    ),
  );
}

function materializeExecutable(
  paths: UpdaterPaths,
  artifact: EngineArtifact,
  bytes: Buffer,
): string {
  if (
    bytes.length === 0 ||
    bytes.length > MAX_EXECUTABLE_BYTES ||
    rawDigest(bytes) !== artifact.executableDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_EXECUTABLE_INVALID',
      'Executable bytes do not match the engine artifact.',
      ExitCode.verification,
    );
  }
  const artifactDirectory = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
  );
  ensurePrivateDirectory(artifactDirectory);
  const executablePath = path.join(artifactDirectory, 'engine');
  const existing = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateExecutable(executablePath, artifact.executableDigest);
    return executablePath;
  }
  createPrivateExecutableExclusive(executablePath, bytes);
  assertPrivateExecutable(executablePath, artifact.executableDigest);
  return executablePath;
}

function selectSupervisorArtifact(
  storageRoot: string,
  current: ControlPlaneSupervisorState,
  artifact: EngineArtifact,
  closureDigest: Sha256Digest,
  record: PersistedControlPlaneUpdateRecord,
  phase: 'candidate-selected' | 'rollback-restored',
  now: Date,
): ControlPlaneSupervisorState {
  const paths = updaterPaths(storageRoot);
  const executablePath = materializedExecutablePath(paths, artifact);
  assertConfinedExecutable(paths, executablePath, artifact.executableDigest);
  const next = withRecordDigest({
    kind: 'control-plane-supervisor-state.v1' as const,
    repositoryId: current.repositoryId,
    activeArtifact: {
      artifactId: artifact.artifactId,
      executableDigest: artifact.executableDigest,
      closureDigest,
      executablePath,
    },
    generation: current.generation + 1,
    transition: {
      grantId: record.envelope.payload.grantId,
      txId: record.transaction.txId,
      phase,
    },
    updatedAt: exactDate(now, 'CONTROL_PLANE_SUPERVISOR_INVALID').toISOString(),
  });
  replacePrivateFileAtomicCas(
    paths.supervisor,
    current.recordDigest,
    serializeCanonical(next),
  );
  return next;
}

function assertSupervisorIsOldClosure(
  supervisor: ControlPlaneSupervisorState,
  envelope: ControlPlaneGrantEnvelope | ControlPlaneGrantEnvelopeV2,
  bundle: RuntimeControlPlanePromotionBundle,
): void {
  if (
    supervisor.repositoryId !== envelope.payload.repositoryId ||
    supervisor.activeArtifact.artifactId !==
      bundle.recoveryBundle.restartArtifact.artifactId ||
    supervisor.activeArtifact.executableDigest !==
      bundle.recoveryBundle.restartArtifact.executableDigest ||
    supervisor.activeArtifact.closureDigest !== bundle.beforeClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_OLD_CLOSURE_MISMATCH',
      'Supervisor is not selecting the exact grant-bound old closure.',
      ExitCode.staleState,
    );
  }
}

function assertSupervisorMatchesOldClosure(
  supervisor: ControlPlaneSupervisorState,
  repositoryId: string,
  bundle: ControlPlanePromotionBundle,
): void {
  if (
    supervisor.repositoryId !== repositoryId ||
    supervisor.activeArtifact.artifactId !==
      bundle.recoveryBundle.restartArtifact.artifactId ||
    supervisor.activeArtifact.executableDigest !==
      bundle.recoveryBundle.restartArtifact.executableDigest ||
    supervisor.activeArtifact.closureDigest !== bundle.beforeClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_OLD_CLOSURE_MISMATCH',
      'Supervisor is not selecting the exact grant-bound old closure.',
      ExitCode.staleState,
    );
  }
}

function assertSupervisorMatchesOldClosureV2(
  supervisor: ControlPlaneSupervisorState,
  material: ControlPlanePromotionMaterial,
): void {
  if (
    supervisor.repositoryId !== material.repositoryId ||
    supervisor.activeArtifact.artifactId !==
      material.recoveryBundle.restartArtifact.artifactId ||
    supervisor.activeArtifact.executableDigest !==
      material.recoveryBundle.restartArtifact.executableDigest ||
    supervisor.activeArtifact.closureDigest !== material.beforeClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_OLD_CLOSURE_MISMATCH',
      'Supervisor is not selecting the exact v2 grant-bound old closure.',
      ExitCode.staleState,
    );
  }
}

function assertSupervisorIsCandidate(
  supervisor: ControlPlaneSupervisorState,
  bundle: RuntimeControlPlanePromotionBundle,
): void {
  if (
    supervisor.repositoryId !== bundle.repositoryId ||
    supervisor.activeArtifact.artifactId !==
      bundle.candidateArtifact.artifactId ||
    supervisor.activeArtifact.executableDigest !==
      bundle.candidateArtifact.executableDigest ||
    supervisor.activeArtifact.closureDigest !== bundle.afterClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_CANDIDATE_SUPERVISOR_MISMATCH',
      'Supervisor is not selecting the exact candidate closure.',
      ExitCode.staleState,
    );
  }
}

function runSelfTest(
  paths: UpdaterPaths,
  executablePath: string,
  executableDigest: Sha256Digest,
  expectedClosureDigest: Sha256Digest,
): SelfTestEvidence {
  const value = runControlPlaneProcess(
    paths,
    executablePath,
    executableDigest,
    '--control-plane-self-test',
  );
  if (
    !hasExactKeys(value, ['closureDigest', 'healthy', 'kind']) ||
    value.kind !== 'control-plane-self-test.v1' ||
    typeof value.healthy !== 'boolean' ||
    value.closureDigest !== expectedClosureDigest
  ) {
    throw processVerificationFailed('Candidate self-test response is invalid.');
  }
  return {
    healthy: value.healthy,
    closureDigest: expectedClosureDigest,
    evidenceDigest: canonicalDigest(value),
  };
}

function runRestartProbe(
  paths: UpdaterPaths,
  executablePath: string,
  executableDigest: Sha256Digest,
  expectedClosureDigest: Sha256Digest,
): ProcessEvidence {
  const value = runControlPlaneProcess(
    paths,
    executablePath,
    executableDigest,
    '--control-plane-restart-probe',
  );
  if (
    !hasExactKeys(value, ['closureDigest', 'kind', 'ready']) ||
    value.kind !== 'control-plane-restart.v1' ||
    value.ready !== true ||
    value.closureDigest !== expectedClosureDigest
  ) {
    throw processVerificationFailed('Recovery restart response is invalid.');
  }
  return {
    closureDigest: expectedClosureDigest,
    evidenceDigest: canonicalDigest(value),
  };
}

function runControlPlaneProcess(
  paths: UpdaterPaths,
  executablePath: string,
  executableDigest: Sha256Digest,
  mode: '--control-plane-self-test' | '--control-plane-restart-probe',
): Record<string, unknown> {
  assertConfinedExecutable(paths, executablePath, executableDigest);
  const cwd = path.dirname(executablePath);
  const result = childProcess.spawnSync(executablePath, [mode], {
    cwd,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: cwd,
    },
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: PROCESS_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw processVerificationFailed(
      'Control-plane process did not exit cleanly.',
    );
  }
  if (
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > PROCESS_MAX_BUFFER_BYTES
  ) {
    throw processVerificationFailed('Control-plane process output is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw processVerificationFailed(
      'Control-plane process returned invalid JSON.',
    );
  }
  if (!isRecord(value)) {
    throw processVerificationFailed(
      'Control-plane process response is not an object.',
    );
  }
  return value;
}

function emitAuditHistory(
  record: PersistedControlPlaneUpdateRecord,
  bundle: RuntimeControlPlanePromotionBundle,
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  const prepared = createAuditRecord({
    repositoryId: bundle.repositoryId,
    ...controlPlaneAuditMandateFields(record.envelope.payload.mandateBinding),
    grantId: record.envelope.payload.grantId,
    txId: record.transaction.txId,
    grantEnvelopeDigest: canonicalDigest(record.envelope),
    promotionBundleDigest: bundle.bundleDigest,
    sequence: 0,
    event: 'prepared',
    fromState: 'PREPARED',
    toState: 'PREPARED',
    evidenceDigest: bundle.bundleDigest,
    recordedAt: record.createdAt,
  });
  dependencies.auditSink.append(prepared);
  for (const observation of record.observations) {
    dependencies.auditSink.append(
      createAuditRecord({
        repositoryId: bundle.repositoryId,
        ...controlPlaneAuditMandateFields(
          record.envelope.payload.mandateBinding,
        ),
        grantId: record.envelope.payload.grantId,
        txId: record.transaction.txId,
        grantEnvelopeDigest: canonicalDigest(record.envelope),
        promotionBundleDigest: bundle.bundleDigest,
        sequence: observation.sequence,
        event: auditEventForObservation(observation.eventKind),
        fromState: observation.fromState,
        toState: observation.toState,
        evidenceDigest: observation.evidenceDigest,
        recordedAt: observation.recordedAt,
      }),
    );
  }
}

function createAuditRecord(
  input: Omit<
    ControlPlaneUpdaterAuditRecord,
    'kind' | 'recordId' | 'recordDigest'
  >,
): ControlPlaneUpdaterAuditRecord {
  const identity = {
    kind: 'control-plane-updater-audit-id.v1' as const,
    repositoryId: input.repositoryId,
    mandateBinding: input.mandateBinding,
    grantId: input.grantId,
    txId: input.txId,
    sequence: input.sequence,
    event: input.event,
  };
  const payload = {
    kind: 'control-plane-updater-audit.v1' as const,
    recordId: canonicalDigest(identity),
    ...input,
  };
  return deepFreeze({ ...payload, recordDigest: canonicalDigest(payload) });
}

function controlPlaneAuditMandateFields(
  binding: ControlPlaneTaskMandateBinding,
): Pick<
  ControlPlaneUpdaterAuditRecord,
  'mandateBinding' | 'parentTaskId' | 'changeId' | 'externalAuditRoot'
> {
  const exact = normalizeControlPlaneTaskMandateBinding(binding);
  return {
    mandateBinding: exact,
    parentTaskId: exact.parentTaskId,
    changeId: exact.changeId,
    externalAuditRoot: exact.externalAuditRoot,
  };
}

function auditEventForObservation(
  event: string,
): ControlPlaneUpdaterAuditEvent {
  switch (event) {
    case 'old-closure-verified':
      return 'old-closure-verified';
    case 'candidate-verified':
      return 'candidate-verified';
    case 'recovery-bundle-verified':
      return 'recovery-verified';
    case 'atomic-switch-completed':
      return 'switched';
    case 'self-tests-passed':
      return 'self-tested';
    case 'self-tests-failed':
      return 'rollback-required';
    case 'finalize':
      return 'finalized';
    case 'rollback-completed':
      return 'rolled-back';
    default:
      throw workflowError(
        'CONTROL_PLANE_AUDIT_EVENT_INVALID',
        'Persisted updater observation has no audit event mapping.',
        ExitCode.verification,
      );
  }
}

function advanceRecord(
  current: PersistedControlPlaneUpdateRecord,
  storageRoot: string,
  input: {
    kind:
      | 'old-closure-verified'
      | 'candidate-verified'
      | 'recovery-bundle-verified'
      | 'atomic-switch-completed'
      | 'self-tests-passed'
      | 'self-tests-failed'
      | 'finalize'
      | 'rollback-completed';
    at: string;
    evidenceDigest: Sha256Digest;
  },
): PersistedControlPlaneUpdateRecord {
  return advancePersistedControlPlaneUpdate(storageRoot, {
    grantId: current.envelope.payload.grantId,
    expectedJournalDigest: current.transaction.journalDigest,
    event: { kind: input.kind, at: input.at },
    evidenceDigest: input.evidenceDigest,
  });
}

function assertGrantLiveForForwardEffect(
  record: PersistedControlPlaneUpdateRecord,
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  if (
    updaterNow(dependencies).getTime() >=
    Date.parse(record.envelope.payload.expiresAt)
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_EXPIRED',
      'Control-Plane Grant expired before the atomic switch.',
      ExitCode.staleState,
    );
  }
}

function nextTransitionTime(
  record: PersistedControlPlaneUpdateRecord,
  dependencies: ControlPlaneUpdaterDependencies,
): string {
  const now = updaterNow(dependencies).getTime();
  const previous = Date.parse(record.transaction.history.at(-1)!.at);
  return new Date(Math.max(now, previous + 1)).toISOString();
}

function persistPromotionBundle(
  paths: UpdaterPaths,
  grantId: string,
  bundle: StoredControlPlanePromotionBundle,
): void {
  const target = promotionBundlePath(paths, grantId);
  const content = serializeCanonical(bundle);
  if (fs.existsSync(target)) {
    if (
      readPrivateText(target, 'CONTROL_PLANE_PROMOTION_BUNDLE_NOT_FOUND') !==
      content
    ) {
      throw workflowError(
        'CONTROL_PLANE_PROMOTION_BUNDLE_CONFLICT',
        'Grant id is already bound to a different promotion bundle.',
        ExitCode.conflict,
      );
    }
    return;
  }
  createPrivateFileExclusive(target, content);
}

function readPromotionBundle(
  paths: UpdaterPaths,
  grantId: string,
): RuntimeControlPlanePromotionBundle {
  const value = readCanonicalPrivateRecord(
    promotionBundlePath(paths, grantId),
    'CONTROL_PLANE_PROMOTION_BUNDLE_NOT_FOUND',
  );
  if (!isRecord(value)) {
    throw promotionBundleCorrupt('Unknown promotion bundle schema.');
  }
  if (value.kind === 'control-plane-promotion-bundle.v1') {
    return runtimePromotionBundle(
      verifyPromotionBundle(value as unknown as ControlPlanePromotionBundle),
    );
  }
  if (value.kind === 'control-plane-promotion-bundle.v2') {
    const bundle = value as unknown as ControlPlanePromotionBundleV2;
    controlPlanePromotionBundleDigestV2(bundle);
    return runtimePromotionBundle(bundle);
  }
  throw promotionBundleCorrupt('Unknown promotion bundle schema.');
}

function promotionBundlePath(paths: UpdaterPaths, grantId: string): string {
  assertNonEmpty(grantId, 'CONTROL_PLANE_GRANT_INVALID');
  const name = crypto
    .createHash('sha256')
    .update(`control-plane-promotion\0${grantId}`)
    .digest('hex');
  return path.join(paths.bundles, `${name}.json`);
}

function updaterPaths(storageRoot: string): UpdaterPaths {
  const root = interventionControlPersistencePaths(storageRoot).root;
  const operations = path.join(root, 'operations');
  return {
    root,
    supervisor: path.join(root, 'control-plane-supervisor.json'),
    approvalCandidates: path.join(root, 'control-plane-approval-candidates'),
    bundles: path.join(root, 'control-plane-promotion-bundles'),
    artifacts: path.join(root, 'control-plane-artifacts'),
    operations,
    lock: path.join(operations, 'control-plane-updater.lock'),
  };
}

function ensureUpdaterDirectories(storageRoot: string): UpdaterPaths {
  const paths = updaterPaths(storageRoot);
  for (const directory of [
    paths.root,
    paths.approvalCandidates,
    paths.bundles,
    paths.artifacts,
    paths.operations,
  ]) {
    ensurePrivateDirectory(directory);
  }
  return paths;
}

function ensurePrivateDirectory(directory: string): void {
  ensurePlainDirectory(directory);
  const stats = fs.lstatSync(directory);
  if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw workflowError(
      'CONTROL_PLANE_STORAGE_UNSAFE',
      'Control-plane state directories must be private.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function withUpdaterLock<T>(
  storageRoot: string,
  operation: string,
  callback: () => T,
): T {
  const paths = updaterPaths(storageRoot);
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.operations);
  const ownerToken = crypto.randomUUID();
  const content = `${canonicalJson({
    kind: 'control-plane-updater-lock.v1',
    operation,
    pid: process.pid,
    ownerToken,
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        paths.lock,
        content,
        ownerToken,
        () =>
          workflowError(
            'CONTROL_PLANE_UPDATER_LOCK_UNSAFE',
            'Control-plane updater lock is unsafe.',
            ExitCode.unsafeEnvironment,
          ),
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const reclaimed = reclaimDeadPreparedLock(paths.lock, (raw) => {
        try {
          const value = JSON.parse(raw) as Record<string, unknown>;
          if (
            `${canonicalJson(value)}\n` !== raw ||
            !Number.isSafeInteger(value.pid) ||
            typeof value.ownerToken !== 'string'
          ) {
            return null;
          }
          return { pid: value.pid as number, ownerToken: value.ownerToken };
        } catch {
          return null;
        }
      });
      if (reclaimed === 'unsafe') {
        throw workflowError(
          'CONTROL_PLANE_UPDATER_LOCK_UNSAFE',
          'Control-plane updater lock is unsafe.',
          ExitCode.unsafeEnvironment,
        );
      }
      if (reclaimed === 'occupied') {
        throw workflowError(
          'CONTROL_PLANE_UPDATER_BUSY',
          'Another minimal updater process is active.',
          ExitCode.conflict,
        );
      }
    }
  }
  if (descriptor === undefined) {
    throw workflowError(
      'CONTROL_PLANE_UPDATER_BUSY',
      'Could not acquire the minimal updater lock.',
      ExitCode.conflict,
    );
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    result = callback();
  } catch (error) {
    failure = error;
  }
  try {
    releaseUpdaterLock(paths.lock, descriptor);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

function releaseUpdaterLock(lockPath: string, descriptor: number): void {
  try {
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.dev !== owned.dev ||
      observed.ino !== owned.ino
    ) {
      throw workflowError(
        'CONTROL_PLANE_UPDATER_LOCK_UNSAFE',
        'Minimal updater lost ownership of its lock.',
        ExitCode.unsafeEnvironment,
      );
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  } finally {
    fs.closeSync(descriptor);
  }
}

function materializedExecutablePath(
  paths: UpdaterPaths,
  artifact: EngineArtifact,
): string {
  return path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
    'engine',
  );
}

function assertConfinedExecutable(
  paths: UpdaterPaths,
  executablePath: string,
  expectedDigest: Sha256Digest,
  expectedArtifactId?: Sha256Digest,
): void {
  if (
    typeof executablePath !== 'string' ||
    !path.isAbsolute(executablePath) ||
    path.resolve(executablePath) !== executablePath
  ) {
    throw supervisorCorrupt();
  }
  const relative = path.relative(paths.artifacts, executablePath);
  if (
    relative.length === 0 ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.basename(executablePath) !== 'engine'
  ) {
    throw supervisorCorrupt();
  }
  if (
    expectedArtifactId !== undefined &&
    executablePath !==
      path.join(
        paths.artifacts,
        expectedArtifactId.slice('sha256:'.length),
        'engine',
      )
  ) {
    throw supervisorCorrupt();
  }
  assertPrivateExecutable(executablePath, expectedDigest);
  if (
    fs.realpathSync(path.dirname(executablePath)) !==
      path.dirname(executablePath) ||
    fs.realpathSync(executablePath) !== executablePath
  ) {
    throw supervisorCorrupt();
  }
}

function assertPrivateExecutable(
  executablePath: string,
  expectedDigest: Sha256Digest,
): void {
  const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_EXECUTABLE_BYTES
  ) {
    throw workflowError(
      'CONTROL_PLANE_EXECUTABLE_UNSAFE',
      'Materialized control-plane executable is unsafe.',
      ExitCode.unsafeEnvironment,
    );
  }
  const descriptor = fs.openSync(
    executablePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      rawDigest(fs.readFileSync(descriptor)) !== expectedDigest
    ) {
      throw workflowError(
        'CONTROL_PLANE_EXECUTABLE_DIGEST_MISMATCH',
        'Materialized executable digest changed.',
        ExitCode.verification,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function createPrivateExecutableExclusive(
  filePath: string,
  content: Buffer,
): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let failure: unknown;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_EXECUTABLE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_EXECUTABLE_MODE);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function createPrivateFileExclusive(filePath: string, content: string): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let failure: unknown;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function replacePrivateFileAtomicCas(
  filePath: string,
  expectedDigest: Sha256Digest,
  content: string,
): void {
  const current = readCanonicalPrivateRecord(
    filePath,
    'CONTROL_PLANE_SUPERVISOR_NOT_FOUND',
  );
  if (!isRecord(current) || current.recordDigest !== expectedDigest) {
    throw workflowError(
      'CONTROL_PLANE_SUPERVISOR_CAS_MISMATCH',
      'Supervisor state changed before the atomic switch.',
      ExitCode.staleState,
    );
  }
  assertPrivateRegularFile(filePath);
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let failure: unknown;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function readCanonicalPrivateRecord(
  filePath: string,
  notFoundCode: string,
): unknown {
  const raw = readPrivateText(filePath, notFoundCode);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw workflowError(
      'CONTROL_PLANE_STATE_CORRUPT',
      'Control-plane state is not valid JSON.',
      ExitCode.verification,
    );
  }
  if (`${canonicalJson(value)}\n` !== raw) {
    throw workflowError(
      'CONTROL_PLANE_STATE_CORRUPT',
      'Control-plane state is not canonical JSON.',
      ExitCode.verification,
    );
  }
  return value;
}

function readPrivateText(filePath: string, notFoundCode: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    throw workflowError(
      notFoundCode,
      'Control-plane state was not found.',
      ExitCode.conflict,
    );
  }
  assertPrivateRegularFile(filePath);
  if (stats.size > MAX_BUNDLE_BYTES) {
    throw workflowError(
      'CONTROL_PLANE_STATE_TOO_LARGE',
      'Control-plane state exceeds the maximum size.',
      ExitCode.guard,
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw workflowError(
        'CONTROL_PLANE_STATE_UNSAFE',
        'Control-plane state changed while being opened.',
        ExitCode.unsafeEnvironment,
      );
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateRegularFile(filePath: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw workflowError(
      'CONTROL_PLANE_STATE_UNSAFE',
      'Control-plane state must be a private regular file.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function serializeCanonical(value: unknown): string {
  const serialized = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES) {
    throw workflowError(
      'CONTROL_PLANE_STATE_TOO_LARGE',
      'Control-plane state exceeds the maximum size.',
      ExitCode.guard,
    );
  }
  return serialized;
}

function verifyEngineArtifact(artifact: EngineArtifact): EngineArtifact {
  const artifactKeys = [
    'artifactId',
    'canReadSessionSchemas',
    'executableDigest',
    'kind',
    'policySchemaVersion',
    'protocolVersion',
    'smokeReportDigest',
    'sourceChangeId',
    'sourceDigest',
    'writesSessionSchema',
  ];
  if (
    !isRecord(artifact) ||
    !hasExactKeys(
      artifact,
      'workflowBindingDigest' in artifact
        ? [...artifactKeys, 'workflowBindingDigest']
        : artifactKeys,
    ) ||
    artifact.kind !== 'engine-artifact.v1'
  ) {
    throw promotionBundleCorrupt('Engine artifact schema is invalid.');
  }
  const rebuilt = createEngineArtifact({
    sourceChangeId: artifact.sourceChangeId,
    sourceDigest: artifact.sourceDigest,
    executableDigest: artifact.executableDigest,
    protocolVersion: artifact.protocolVersion,
    canReadSessionSchemas: artifact.canReadSessionSchemas,
    writesSessionSchema: artifact.writesSessionSchema,
    policySchemaVersion: artifact.policySchemaVersion,
    smokeReportDigest: artifact.smokeReportDigest,
    ...(artifact.workflowBindingDigest === undefined
      ? {}
      : { workflowBindingDigest: artifact.workflowBindingDigest }),
  });
  if (rebuilt.artifactId !== artifact.artifactId) {
    throw promotionBundleCorrupt('Engine artifact digest mismatch.');
  }
  return rebuilt;
}

function decodeCanonicalBase64(value: string, code: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw workflowError(
      code,
      'Expected non-empty base64 bytes.',
      ExitCode.guard,
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > MAX_BUNDLE_BYTES) {
    throw workflowError(
      code,
      'Base64 bytes are non-canonical or too large.',
      ExitCode.guard,
    );
  }
  return bytes;
}

function safeLogicalPath(value: string, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[*?[\]{}]/.test(value) ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw workflowError(
      code,
      'Promotion contains an unsafe path.',
      ExitCode.guard,
    );
  }
  return value;
}

function assertSortedUniquePaths(values: string[], code: string): void {
  const expected = [...new Set(values)].sort();
  if (canonicalJson(values) !== canonicalJson(expected)) {
    throw workflowError(
      code,
      'Promotion paths must be sorted and unique.',
      ExitCode.guard,
    );
  }
}

function requireUpdaterDependencies(
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  if (
    dependencies?.consumedGrantIds === undefined ||
    typeof dependencies.verifyHumanSignature !== 'function' ||
    typeof dependencies.auditSink?.append !== 'function'
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATER_DEPENDENCY_REQUIRED',
      'Minimal updater requires trusted consumption, signature, and audit dependencies.',
      ExitCode.guard,
    );
  }
}

function requireRecoveryDependencies(
  dependencies: ControlPlaneRecoveryExecutorDependencies,
): void {
  requireUpdaterDependencies(dependencies);
  if (typeof dependencies.recoveryAuditSink?.append !== 'function') {
    throw workflowError(
      'HARNESS_RECOVERY_AUDIT_DEPENDENCY_REQUIRED',
      'Recovery executor requires an idempotent external audit sink.',
      ExitCode.guard,
    );
  }
}

function laterIso(...values: string[]): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
      throw workflowError(
        'HARNESS_RECOVERY_GRANT_CLOCK_INVALID',
        'Recovery transition timestamp is invalid.',
        ExitCode.verification,
      );
    }
    latest = Math.max(latest, time);
  }
  return new Date(latest).toISOString();
}

function updaterNow(dependencies: ControlPlaneUpdaterDependencies): Date {
  return exactDate(
    dependencies.now?.() ?? new Date(),
    'CONTROL_PLANE_UPDATER_CLOCK_INVALID',
  );
}

function exactDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      code,
      'Expected a valid updater clock.',
      ExitCode.usage,
    );
  }
  return new Date(value.getTime());
}

function validTransition(
  value: ControlPlaneSupervisorState['transition'],
): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['grantId', 'phase', 'txId']) &&
      typeof value.grantId === 'string' &&
      value.grantId.length > 0 &&
      typeof value.txId === 'string' &&
      value.txId.length > 0 &&
      (value.phase === 'candidate-selected' ||
        value.phase === 'rollback-restored'))
  );
}

function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertNonEmpty(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw workflowError(code, 'Expected a non-empty value.', ExitCode.usage);
  }
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (!isDigest(value)) {
    throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.usage);
  }
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(canonicalJson(value));
}

function withRecordDigest<T extends Record<string, unknown>>(
  payload: T,
): T & { recordDigest: Sha256Digest } {
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

function verifyRecordDigest(value: Record<string, unknown>): boolean {
  if (!isDigest(value.recordDigest)) return false;
  const { recordDigest, ...payload } = value;
  return canonicalDigest(payload) === recordDigest;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function promotionBundleCorrupt(message: string) {
  return workflowError(
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
    message,
    ExitCode.verification,
  );
}

function approvalCandidateCorrupt(
  message = 'Persisted control-plane approval candidate failed integrity verification.',
) {
  return workflowError(
    'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
    message,
    ExitCode.verification,
  );
}

function supervisorCorrupt() {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_CORRUPT',
    'Control-plane supervisor state failed integrity verification.',
    ExitCode.verification,
  );
}

function processVerificationFailed(message: string) {
  return workflowError(
    'CONTROL_PLANE_PROCESS_VERIFICATION_FAILED',
    message,
    ExitCode.verification,
  );
}

function workflowFailureCode(error: unknown): string {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'CONTROL_PLANE_PROCESS_FAILURE';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
