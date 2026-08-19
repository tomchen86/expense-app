import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './modules/authority/authority-refusal-audit.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import { discoverRepository } from './git.ts';
import {
  executeControlPlanePromotion,
  assertSameControlPlaneTaskMandateBinding,
  preflightControlPlaneApprovalCandidateV2,
  preflightControlPlaneApprovalCandidateV3,
  prepareControlPlanePromotionV2,
  prepareControlPlanePromotionV3,
  readPersistedControlPlaneApprovalCandidateCurrent,
  readPersistedControlPlaneApprovalCandidateV2,
  readControlPlaneSupervisorState,
  recoverControlPlanePromotion,
  type ControlPlaneApprovalPreflightV2,
  type ControlPlaneApprovalPreflightV3,
  type ControlPlaneApprovalSummary,
  type ControlPlaneApprovalSummaryV2,
  type ControlPlaneApprovalSummaryV3,
  type PersistedControlPlaneApprovalCandidateV3,
  type ControlPlaneSupervisorState,
  type ControlPlaneUpdaterDependencies,
} from './application/control-plane/intervention-control-updater.ts';
import {
  readPersistedControlPlaneUpdate,
  type PersistedControlPlaneUpdateRecord,
  type PersistedControlPlaneUpdateRecordV1,
} from './intervention-control-persistence.ts';
import type {
  ControlPlaneGrantEnvelopeV2,
  ControlPlaneGrantEnvelopeV3,
  ControlPlaneGrantPayloadV2,
  ControlPlaneGrantPayloadV3,
  ControlPlanePromotionBundleV2,
  ControlPlanePromotionBundleV3,
  ControlPlaneTaskMandateBinding,
} from './modules/authority/intervention-control.ts';
import {
  canonicalControlPlaneGrantPayloadV2,
  canonicalControlPlaneGrantPayloadV3,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  normalizeControlPlaneTaskMandateBinding,
} from './modules/authority/intervention-control.ts';
import type { MaintainerSignerProvider } from './maintainer-signer.ts';
import type { TaskMandateBinding } from './modules/authority/task-mandate.ts';

const CONTROL_PLANE_GRANT_TTL_MS = 5 * 60 * 1000;

export type ControlPlaneUpdaterCliAction =
  'approve-and-apply' | 'recover' | 'status';

export interface ControlPlaneUpdaterCliResult {
  kind: 'control-plane-updater-cli-result.v1';
  action: ControlPlaneUpdaterCliAction;
  grantId: string;
  stateRoot: string;
  record: PersistedControlPlaneUpdateRecord | null;
  supervisor: ControlPlaneSupervisorState;
  effectsPerformed: boolean;
}

export interface LegacyControlPlaneUpdaterCliResult extends Omit<
  ControlPlaneUpdaterCliResult,
  'record'
> {
  record: PersistedControlPlaneUpdateRecordV1 | null;
}

export interface ControlPlaneUpdaterCliDependencies extends ControlPlaneUpdaterDependencies {
  approvalSigner?: MaintainerSignerProvider;
  /** Legacy read-only presenter; new approval admission is v2-only. */
  presentApprovalSummary?: (summary: ControlPlaneApprovalSummary) => void;
  presentApprovalSummaryV2?: (summary: ControlPlaneApprovalSummaryV2) => void;
  presentApprovalSummaryV3?: (summary: ControlPlaneApprovalSummaryV3) => void;
  resolveTaskMandateBinding?: (
    parentTaskId: string,
  ) => ControlPlaneTaskMandateBinding;
}

export interface LegacyControlPlaneUpdaterCliDependencies extends ControlPlaneUpdaterCliDependencies {
  presentApprovalSummary: (summary: ControlPlaneApprovalSummary) => void;
  presentApprovalSummaryV2?: never;
}

export function controlPlaneTaskMandateBindingFromTaskMandate(
  binding: TaskMandateBinding,
): ControlPlaneTaskMandateBinding {
  return normalizeControlPlaneTaskMandateBinding({
    schemaVersion: binding.schemaVersion,
    parentTaskId: binding.mandateTaskId,
    mandateId: binding.mandateId,
    mandateDigest: binding.mandateDigest,
    changeId: binding.changeId,
    externalAuditRoot: binding.externalAuditRoot,
  });
}

export function taskMandateBindingFromControlPlane(
  binding: ControlPlaneTaskMandateBinding,
): TaskMandateBinding {
  const exact = normalizeControlPlaneTaskMandateBinding(binding);
  return {
    schemaVersion: exact.schemaVersion,
    mandateTaskId: exact.parentTaskId,
    mandateId: exact.mandateId,
    mandateDigest: exact.mandateDigest,
    changeId: exact.changeId,
    externalAuditRoot: exact.externalAuditRoot,
  };
}

/**
 * Effectful minimal-updater command surface. Unlike the pure M11 dispatcher,
 * this surface is allowed to switch the repository-default artifact, but only
 * through an exact one-shot Control-Plane Grant and a required external audit
 * sink supplied by the embedding process.
 */
export function dispatchProductionControlPlaneUpdaterCommand(
  argv: readonly string[],
  stateRoot: string,
  dependencies: ControlPlaneUpdaterCliDependencies,
  requestBaseDirectory = process.cwd(),
): ControlPlaneUpdaterCliResult {
  if (
    argv[0] === 'approve-and-apply' &&
    argv.length === 4 &&
    isNonEmpty(argv[1]) &&
    argv[2] === '--task' &&
    isNonEmpty(argv[3])
  ) {
    assertProductionControlPlaneStateRoot(requestBaseDirectory, stateRoot);
    const candidateId = argv[1];
    const parentTaskId = argv[3];
    const signer = dependencies.approvalSigner;
    if (!signer) {
      throw workflowError(
        'CONTROL_PLANE_APPROVAL_UI_REQUIRED',
        'Approve-and-apply requires a controlling-terminal signer and summary presenter.',
        ExitCode.unsafeEnvironment,
      );
    }
    // Parse the immutable candidate before touching the signer so corrupt or
    // drifted candidate bytes can never be presented as approvable.
    const candidate = readPersistedControlPlaneApprovalCandidateCurrent(
      stateRoot,
      candidateId,
    );
    if (candidate.mandateBinding.parentTaskId !== parentTaskId) {
      throw workflowError(
        'CONTROL_PLANE_PARENT_TASK_MISMATCH',
        'Approval candidate belongs to a different parent task.',
        ExitCode.guard,
      );
    }
    if (candidate.kind === 'persisted-control-plane-approval-candidate.v3') {
      return approveAndApplyControlPlaneCandidateV3({
        requestBaseDirectory,
        stateRoot,
        candidate,
        candidateId,
        parentTaskId,
        signer,
        dependencies,
      });
    }
    const presentSummary = dependencies.presentApprovalSummaryV2;
    if (!presentSummary) {
      throw workflowError(
        'CONTROL_PLANE_APPROVAL_UI_REQUIRED',
        'Approve-and-apply requires a controlling-terminal signer and summary presenter.',
        ExitCode.unsafeEnvironment,
      );
    }
    const resolveTaskMandateBinding = dependencies.resolveTaskMandateBinding;
    const revalidateTaskMandateBinding =
      dependencies.revalidateTaskMandateBinding;
    if (!resolveTaskMandateBinding || !revalidateTaskMandateBinding) {
      throw workflowError(
        'CONTROL_PLANE_TASK_MANDATE_VALIDATOR_REQUIRED',
        'Production control-plane approval requires an active Task Mandate resolver and revalidator.',
        ExitCode.unsafeEnvironment,
      );
    }
    const resolvedMandate = normalizeControlPlaneTaskMandateBinding(
      resolveTaskMandateBinding(parentTaskId),
    );
    assertSameControlPlaneTaskMandateBinding(
      candidate.mandateBinding,
      resolvedMandate,
    );
    revalidateTaskMandateBinding(resolvedMandate, 'approval-preflight');
    signer.assertHumanPresent();
    const humanSigner = signer.identity();
    const issuedAt = exactNow(dependencies).toISOString();
    const grantId = controlPlaneApprovalGrantId(candidateId);
    const preflight = preflightControlPlaneApprovalCandidateV2(
      stateRoot,
      candidateId,
      {
        grantId,
        humanSigner,
        issuedAt,
        verifyHumanSignature: dependencies.verifyHumanSignature,
      },
    );
    assertSameControlPlaneTaskMandateBinding(
      resolvedMandate,
      preflight.candidate.mandateBinding,
    );
    const approval = withAuthorityRefusalAudit(
      controlPlaneApprovalRefusalBinding(
        requestBaseDirectory,
        preflight,
        grantId,
        humanSigner,
      ),
      { now: new Date(issuedAt) },
      () => {
        revalidateTaskMandateBinding(resolvedMandate, 'approval-preflight');
        presentSummary(preflight.summary);
        const payload = controlPlaneGrantPayloadV2(
          grantId,
          humanSigner,
          issuedAt,
          preflight.summary,
          preflight.candidate.bundle,
        );
        const signature = signer
          .sign(
            canonicalControlPlaneGrantPayloadV2(payload),
            CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
          )
          .trim();
        const current = readPersistedControlPlaneApprovalCandidateV2(
          stateRoot,
          candidateId,
        );
        if (current.recordDigest !== preflight.candidate.recordDigest) {
          throw workflowError(
            'CONTROL_PLANE_APPROVAL_CANDIDATE_DRIFT',
            'Persisted candidate changed after the approval summary was presented.',
            ExitCode.staleState,
          );
        }
        assertSameControlPlaneTaskMandateBinding(
          resolvedMandate,
          current.mandateBinding,
        );
        revalidateTaskMandateBinding(resolvedMandate, 'before-persistence');
        return {
          current,
          envelope: {
            payload,
            signature,
          } satisfies ControlPlaneGrantEnvelopeV2,
        };
      },
    );
    // Durable preparation can reserve a grant before a later audit-sink
    // failure. It therefore stays outside refusal handling and remains owned
    // by the control-plane transaction's recovery path.
    prepareControlPlanePromotionV2(
      stateRoot,
      {
        txId: approval.current.txId,
        envelope: approval.envelope,
        beforeManifest: approval.current.beforeManifest,
        afterManifest: approval.current.afterManifest,
        bundle: approval.current.bundle,
      },
      dependencies,
    );
    const completed = executeControlPlanePromotion(
      stateRoot,
      grantId,
      dependencies,
    );
    return result({
      action: 'approve-and-apply',
      grantId,
      stateRoot,
      record: completed.record,
      supervisor: completed.supervisor,
      effectsPerformed: true,
    });
  }

  if (argv.includes('--audit-root')) {
    throw workflowError(
      'CONTROL_PLANE_CALLER_AUDIT_ROOT_DISABLED',
      'Control-plane authority audit scope is derived only from the durable signed Task Mandate binding.',
      ExitCode.guard,
    );
  }

  if (argv[0] === 'promote' || argv.includes('--request')) {
    throw workflowError(
      'CONTROL_PLANE_CALLER_SUPPLIED_REQUEST_DISABLED',
      'Production control-plane approval accepts only a persisted candidate id; caller-supplied signed envelopes and request JSON are disabled.',
      ExitCode.guard,
    );
  }

  if (argv[0] === 'recover' && argv.length === 2 && isNonEmpty(argv[1])) {
    assertProductionControlPlaneStateRoot(requestBaseDirectory, stateRoot);
    if (!dependencies.revalidateTaskMandateBinding) {
      throw workflowError(
        'CONTROL_PLANE_TASK_MANDATE_VALIDATOR_REQUIRED',
        'Production control-plane recovery requires a durable Task Mandate revalidator.',
        ExitCode.unsafeEnvironment,
      );
    }
    const recovered = recoverControlPlanePromotion(
      stateRoot,
      argv[1],
      dependencies,
    );
    return result({
      action: 'recover',
      grantId: argv[1],
      stateRoot,
      record: recovered.record,
      supervisor: recovered.supervisor,
      effectsPerformed: true,
    });
  }

  if (argv[0] === 'status' && argv.length === 2 && isNonEmpty(argv[1])) {
    assertProductionControlPlaneStateRoot(requestBaseDirectory, stateRoot);
    return result({
      action: 'status',
      grantId: argv[1],
      stateRoot,
      record: readPersistedControlPlaneUpdate(stateRoot, argv[1]),
      supervisor: readControlPlaneSupervisorState(stateRoot),
      effectsPerformed: false,
    });
  }

  throw workflowError(
    'CONTROL_PLANE_UPDATER_COMMAND_UNSUPPORTED',
    productionControlPlaneUpdaterUsage(),
    ExitCode.usage,
  );
}

function approveAndApplyControlPlaneCandidateV3(input: {
  requestBaseDirectory: string;
  stateRoot: string;
  candidate: PersistedControlPlaneApprovalCandidateV3;
  candidateId: string;
  parentTaskId: string;
  signer: MaintainerSignerProvider;
  dependencies: ControlPlaneUpdaterCliDependencies;
}): ControlPlaneUpdaterCliResult {
  const {
    requestBaseDirectory,
    stateRoot,
    candidate,
    candidateId,
    parentTaskId,
    signer,
    dependencies,
  } = input;
  const presentSummary = dependencies.presentApprovalSummaryV3;
  const resolveTaskMandateBinding = dependencies.resolveTaskMandateBinding;
  const revalidateTaskMandateBinding =
    dependencies.revalidateTaskMandateBinding;
  if (!presentSummary) {
    throw workflowError(
      'CONTROL_PLANE_APPROVAL_UI_REQUIRED',
      'Successor approve-and-apply requires a V3 summary presenter.',
      ExitCode.unsafeEnvironment,
    );
  }
  if (!resolveTaskMandateBinding || !revalidateTaskMandateBinding) {
    throw workflowError(
      'CONTROL_PLANE_TASK_MANDATE_VALIDATOR_REQUIRED',
      'Production successor approval requires an active Task Mandate resolver and revalidator.',
      ExitCode.unsafeEnvironment,
    );
  }
  const resolvedMandate = normalizeControlPlaneTaskMandateBinding(
    resolveTaskMandateBinding(parentTaskId),
  );
  assertSameControlPlaneTaskMandateBinding(
    candidate.mandateBinding,
    resolvedMandate,
  );
  revalidateTaskMandateBinding(resolvedMandate, 'approval-preflight');
  signer.assertHumanPresent();
  const humanSigner = signer.identity();
  const issuedAt = exactNow(dependencies).toISOString();
  const grantId = controlPlaneApprovalGrantId(candidateId);
  const preflight = preflightControlPlaneApprovalCandidateV3(
    stateRoot,
    candidateId,
    {
      grantId,
      humanSigner,
      issuedAt,
      verifyHumanSignature: dependencies.verifyHumanSignature,
    },
  );
  assertSameControlPlaneTaskMandateBinding(
    resolvedMandate,
    preflight.candidate.mandateBinding,
  );
  const approval = withAuthorityRefusalAudit(
    controlPlaneApprovalRefusalBinding(
      requestBaseDirectory,
      preflight,
      grantId,
      humanSigner,
    ),
    { now: new Date(issuedAt) },
    () => {
      revalidateTaskMandateBinding(resolvedMandate, 'approval-preflight');
      presentSummary(preflight.summary);
      const payload = controlPlaneGrantPayloadV3(
        grantId,
        humanSigner,
        issuedAt,
        preflight.summary,
        preflight.candidate.bundle,
      );
      const signature = signer
        .sign(
          canonicalControlPlaneGrantPayloadV3(payload),
          CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
        )
        .trim();
      const current = readPersistedControlPlaneApprovalCandidateCurrent(
        stateRoot,
        candidateId,
      );
      if (
        current.kind !== 'persisted-control-plane-approval-candidate.v3' ||
        current.recordDigest !== preflight.candidate.recordDigest
      ) {
        throw workflowError(
          'CONTROL_PLANE_APPROVAL_CANDIDATE_DRIFT',
          'Persisted successor candidate changed after the approval summary was presented.',
          ExitCode.staleState,
        );
      }
      assertSameControlPlaneTaskMandateBinding(
        resolvedMandate,
        current.mandateBinding,
      );
      revalidateTaskMandateBinding(resolvedMandate, 'before-persistence');
      return {
        current,
        envelope: {
          payload,
          signature,
        } satisfies ControlPlaneGrantEnvelopeV3,
      };
    },
  );
  prepareControlPlanePromotionV3(
    stateRoot,
    {
      txId: approval.current.txId,
      envelope: approval.envelope,
      beforeManifest: approval.current.beforeManifest,
      afterManifest: approval.current.afterManifest,
      bundle: approval.current.bundle,
    },
    dependencies,
  );
  const completed = executeControlPlanePromotion(
    stateRoot,
    grantId,
    dependencies,
  );
  return result({
    action: 'approve-and-apply',
    grantId,
    stateRoot,
    record: completed.record,
    supervisor: completed.supervisor,
    effectsPerformed: true,
  });
}

/**
 * Legacy compatibility surface is read-only for new approval admission. It
 * can inspect or recover only a durable v1 transaction and never signs one.
 */
export function dispatchControlPlaneUpdaterCommand(
  argv: readonly string[],
  stateRoot: string,
  dependencies: LegacyControlPlaneUpdaterCliDependencies,
  requestBaseDirectory?: string,
): LegacyControlPlaneUpdaterCliResult;
export function dispatchControlPlaneUpdaterCommand(
  argv: readonly string[],
  stateRoot: string,
  dependencies: ControlPlaneUpdaterCliDependencies,
  requestBaseDirectory?: string,
): ControlPlaneUpdaterCliResult;
export function dispatchControlPlaneUpdaterCommand(
  argv: readonly string[],
  stateRoot: string,
  dependencies: ControlPlaneUpdaterCliDependencies,
  requestBaseDirectory = process.cwd(),
): ControlPlaneUpdaterCliResult {
  if (argv[0] === 'approve-and-apply') {
    throw legacyControlPlaneCandidateReadOnly();
  }
  if (argv[0] === 'status' && argv.length === 2 && isNonEmpty(argv[1])) {
    const record = requireLegacyControlPlaneUpdateRecord(
      readPersistedControlPlaneUpdate(stateRoot, argv[1]),
    );
    return legacyResult({
      action: 'status',
      grantId: argv[1],
      stateRoot,
      record,
      supervisor: readControlPlaneSupervisorState(stateRoot),
      effectsPerformed: false,
    });
  }
  if (argv[0] === 'recover' && argv.length === 2 && isNonEmpty(argv[1])) {
    requireLegacyControlPlaneUpdateRecord(
      readPersistedControlPlaneUpdate(stateRoot, argv[1]),
    );
    if (!dependencies.revalidateTaskMandateBinding) {
      throw workflowError(
        'CONTROL_PLANE_TASK_MANDATE_VALIDATOR_REQUIRED',
        'Legacy control-plane recovery requires a durable Task Mandate revalidator.',
        ExitCode.unsafeEnvironment,
      );
    }
    const recovered = recoverControlPlanePromotion(
      stateRoot,
      argv[1],
      dependencies,
    );
    return legacyResult({
      action: 'recover',
      grantId: argv[1],
      stateRoot,
      record: requireLegacyControlPlaneUpdateRecord(recovered.record),
      supervisor: recovered.supervisor,
      effectsPerformed: true,
    });
  }
  return dispatchProductionControlPlaneUpdaterCommand(
    argv,
    stateRoot,
    dependencies,
    requestBaseDirectory,
  );
}

export function controlPlaneUpdaterUsage(): string {
  return [
    'Usage: pnpm workflow control-plane <command> [--json]',
    '  control-plane approve-and-apply <candidate-id> --task <parent-task-id>',
    '  control-plane recover <grant-id>',
    '  control-plane status <grant-id>',
  ].join('\n');
}

function productionControlPlaneUpdaterUsage(): string {
  return [
    'Usage: pnpm workflow control-plane <command> [--json]',
    '  control-plane produce <frozen-candidate-bundle-digest>',
    '  control-plane approve-and-apply <candidate-id> --task <parent-task-id>',
    '  control-plane recover <grant-id>',
    '  control-plane status <grant-id>',
  ].join('\n');
}

function controlPlaneApprovalGrantId(candidateId: string): string {
  return `control-plane-approval-${candidateId.slice('sha256:'.length)}`;
}

function controlPlaneApprovalRefusalBinding(
  requestBaseDirectory: string,
  preflight: ControlPlaneApprovalPreflightV2 | ControlPlaneApprovalPreflightV3,
  grantId: string,
  humanSigner: string,
): AuthorityRefusalAuditBinding {
  const repository = discoverRepository(requestBaseDirectory);
  const bindingIdentity = {
    schemaVersion: 1,
    kind: 'control-plane-approval-refusal-binding.v1',
    candidateId: preflight.candidate.candidateId,
    candidateRecordDigest: preflight.candidate.recordDigest,
    mandateBinding: preflight.candidate.mandateBinding,
    promotionBundleDigest: preflight.summary.promotionBundleDigest,
    supervisorRecordDigest: preflight.supervisor.recordDigest,
    grantId,
    humanSigner,
  } as const;
  return {
    scope: {
      externalAuditRoot: preflight.candidate.mandateBinding.externalAuditRoot,
      repositoryRoot: repository.repositoryRealPath,
      repositoryId: deriveAuthorityAuditRepositoryId(
        preflight.summary.repositoryId,
      ),
    },
    family: 'control-plane',
    operation: 'control-plane.approve-and-apply',
    subjectId: preflight.candidate.candidateId,
    actor: { kind: 'engine', identity: 'control-plane-updater' },
    taskId: preflight.candidate.mandateBinding.parentTaskId,
    changeId: preflight.candidate.mandateBinding.changeId,
    workflowId: preflight.candidate.txId,
    grantDigest: null,
    candidateBundleDigest: preflight.summary.promotionBundleDigest,
    bindingDigest: authorityRefusalDigest(bindingIdentity),
    refusalIdentity: bindingIdentity,
  };
}

function exactNow(dependencies: ControlPlaneUpdaterCliDependencies): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw workflowError(
      'CONTROL_PLANE_APPROVAL_TIME_INVALID',
      'Control-plane approval time is invalid.',
      ExitCode.guard,
    );
  }
  return new Date(now.getTime());
}

function controlPlaneGrantPayloadV2(
  grantId: string,
  humanSigner: string,
  issuedAt: string,
  summary: ControlPlaneApprovalSummaryV2,
  bundle: ControlPlanePromotionBundleV2,
): ControlPlaneGrantPayloadV2 {
  return {
    kind: 'control-plane-grant.v2',
    grantId,
    mandateBinding: structuredClone(summary.mandateBinding),
    repositoryId: summary.repositoryId,
    frozenCandidateBundleDigest: summary.frozenCandidateBundleDigest,
    candidateDigest: summary.candidateDigest,
    promotionMaterialDigest: summary.promotionMaterialDigest,
    promotionBundleDigest: summary.promotionBundleDigest,
    exactChanges: summary.exactChanges.map((change) => ({ ...change })),
    beforeClosureDigest: summary.beforeClosureDigest,
    afterClosureDigest: summary.afterClosureDigest,
    affectedCapabilities: [...summary.affectedCapabilities],
    behaviorChangeSummary: summary.behaviorChangeSummary,
    recoveryBundle: {
      bundleDigest: summary.recoveryBundleDigest,
      previousClosureDigest:
        bundle.material.recoveryBundle.previousClosureDigest,
      restartArtifactDigest:
        bundle.material.recoveryBundle.restartArtifact.executableDigest,
      rollbackTestReportDigest: summary.rollbackTestReportDigest,
    },
    independentReviewAttestationDigest:
      summary.independentReview.attestationDigest,
    updaterVersion: 2,
    oneShot: true,
    issuedAt,
    expiresAt: new Date(
      Date.parse(issuedAt) + CONTROL_PLANE_GRANT_TTL_MS,
    ).toISOString(),
    humanSigner,
  };
}

function controlPlaneGrantPayloadV3(
  grantId: string,
  humanSigner: string,
  issuedAt: string,
  summary: ControlPlaneApprovalSummaryV3,
  bundle: ControlPlanePromotionBundleV3,
): ControlPlaneGrantPayloadV3 {
  return {
    kind: 'control-plane-grant.v3',
    grantId,
    mandateBinding: structuredClone(summary.mandateBinding),
    repositoryId: summary.repositoryId,
    frozenCandidateBundleDigest: summary.frozenCandidateBundleDigest,
    candidateDigest: summary.candidateDigest,
    promotionMaterialDigest: summary.promotionMaterialDigest,
    promotionLineageDigest: summary.promotionLineageDigest,
    promotionBundleDigest: summary.promotionBundleDigest,
    exactChanges: summary.exactChanges.map((change) => ({ ...change })),
    beforeClosureDigest: summary.beforeClosureDigest,
    afterClosureDigest: summary.afterClosureDigest,
    affectedCapabilities: [...summary.affectedCapabilities],
    behaviorChangeSummary: summary.behaviorChangeSummary,
    recoveryBundle: {
      bundleDigest: summary.recoveryBundleDigest,
      previousClosureDigest:
        bundle.material.recoveryBundle.previousClosureDigest,
      restartArtifactDigest:
        bundle.material.recoveryBundle.restartArtifact.executableDigest,
      rollbackTestReportDigest: summary.rollbackTestReportDigest,
    },
    independentReviewAttestationDigest:
      summary.independentReview.attestationDigest,
    updaterVersion: 3,
    oneShot: true,
    issuedAt,
    expiresAt: new Date(
      Date.parse(issuedAt) + CONTROL_PLANE_GRANT_TTL_MS,
    ).toISOString(),
    humanSigner,
  };
}

function result(
  input: Omit<ControlPlaneUpdaterCliResult, 'kind'>,
): ControlPlaneUpdaterCliResult {
  return { kind: 'control-plane-updater-cli-result.v1', ...input };
}

function legacyResult(
  input: Omit<LegacyControlPlaneUpdaterCliResult, 'kind'>,
): LegacyControlPlaneUpdaterCliResult {
  return { kind: 'control-plane-updater-cli-result.v1', ...input };
}

function requireLegacyControlPlaneUpdateRecord(
  record: PersistedControlPlaneUpdateRecord,
): PersistedControlPlaneUpdateRecordV1 {
  if (record.kind !== 'persisted-control-plane-update.v1') {
    throw legacyControlPlaneCandidateReadOnly();
  }
  return record;
}

function legacyControlPlaneCandidateReadOnly(): ReturnType<
  typeof workflowError
> {
  return workflowError(
    'CONTROL_PLANE_APPROVAL_CANDIDATE_LEGACY_READ_ONLY',
    'The legacy updater surface cannot admit, sign, or operate on a V2 approval candidate.',
    ExitCode.guard,
  );
}

function assertProductionControlPlaneStateRoot(
  requestBaseDirectory: string,
  stateRoot: string,
): void {
  const repository = discoverRepository(requestBaseDirectory);
  if (
    stateRoot !== bootstrapInterventionStateRoot(repository.gitCommonDirectory)
  ) {
    throw workflowError(
      'CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH',
      'Production control-plane commands require the bootstrap-derived store for the exact repository.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}
