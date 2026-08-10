import { ExitCode, workflowError } from './errors.ts';
import {
  executeControlPlanePromotion,
  assertSameControlPlaneTaskMandateBinding,
  preflightControlPlaneApprovalCandidate,
  prepareControlPlanePromotion,
  readPersistedControlPlaneApprovalCandidate,
  readControlPlaneSupervisorState,
  recoverControlPlanePromotion,
  type ControlPlaneApprovalSummary,
  type ControlPlanePromotionBundle,
  type ControlPlaneSupervisorState,
  type ControlPlaneUpdaterDependencies,
} from './intervention-control-updater.ts';
import {
  readPersistedControlPlaneUpdate,
  type PersistedControlPlaneUpdateRecord,
} from './intervention-control-persistence.ts';
import type {
  ControlPlaneGrantEnvelope,
  ControlPlaneGrantPayload,
  ControlPlaneTaskMandateBinding,
} from './intervention-control.ts';
import {
  canonicalControlPlaneGrantPayload,
  CONTROL_PLANE_SIGNATURE_NAMESPACE,
  normalizeControlPlaneTaskMandateBinding,
} from './intervention-control.ts';
import type { MaintainerSignerProvider } from './maintainer-signer.ts';
import type { TaskMandateBinding } from './task-mandate.ts';

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

export interface ControlPlaneUpdaterCliDependencies extends ControlPlaneUpdaterDependencies {
  approvalSigner?: MaintainerSignerProvider;
  presentApprovalSummary?: (summary: ControlPlaneApprovalSummary) => void;
  resolveTaskMandateBinding?: (
    parentTaskId: string,
  ) => ControlPlaneTaskMandateBinding;
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
export function dispatchControlPlaneUpdaterCommand(
  argv: readonly string[],
  stateRoot: string,
  dependencies: ControlPlaneUpdaterCliDependencies,
  _requestBaseDirectory = process.cwd(),
): ControlPlaneUpdaterCliResult {
  if (
    argv[0] === 'approve-and-apply' &&
    argv.length === 4 &&
    isNonEmpty(argv[1]) &&
    argv[2] === '--task' &&
    isNonEmpty(argv[3])
  ) {
    const candidateId = argv[1];
    const parentTaskId = argv[3];
    const signer = dependencies.approvalSigner;
    const presentSummary = dependencies.presentApprovalSummary;
    if (!signer || !presentSummary) {
      throw workflowError(
        'CONTROL_PLANE_APPROVAL_UI_REQUIRED',
        'Approve-and-apply requires a controlling-terminal signer and summary presenter.',
        ExitCode.unsafeEnvironment,
      );
    }
    // Parse the immutable candidate before touching the signer so corrupt or
    // drifted candidate bytes can never be presented as approvable.
    const candidate = readPersistedControlPlaneApprovalCandidate(
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
    const preflight = preflightControlPlaneApprovalCandidate(
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
    revalidateTaskMandateBinding(resolvedMandate, 'approval-preflight');
    presentSummary(preflight.summary);
    const payload = controlPlaneGrantPayload(
      grantId,
      humanSigner,
      issuedAt,
      preflight.summary,
      preflight.candidate.bundle,
    );
    const signature = signer.sign(
      canonicalControlPlaneGrantPayload(payload),
      CONTROL_PLANE_SIGNATURE_NAMESPACE,
    );
    const current = readPersistedControlPlaneApprovalCandidate(
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
    const envelope: ControlPlaneGrantEnvelope = { payload, signature };
    prepareControlPlanePromotion(
      stateRoot,
      {
        txId: current.txId,
        envelope,
        beforeManifest: current.beforeManifest,
        afterManifest: current.afterManifest,
        bundle: current.bundle,
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
    controlPlaneUpdaterUsage(),
    ExitCode.usage,
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

function controlPlaneApprovalGrantId(candidateId: string): string {
  return `control-plane-approval-${candidateId.slice('sha256:'.length)}`;
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

function controlPlaneGrantPayload(
  grantId: string,
  humanSigner: string,
  issuedAt: string,
  summary: ControlPlaneApprovalSummary,
  bundle: ControlPlanePromotionBundle,
): ControlPlaneGrantPayload {
  return {
    kind: 'control-plane-grant.v1',
    grantId,
    mandateBinding: structuredClone(summary.mandateBinding),
    repositoryId: summary.repositoryId,
    candidateDigest: summary.candidateDigest,
    exactChanges: summary.exactChanges.map((change) => ({ ...change })),
    beforeClosureDigest: summary.beforeClosureDigest,
    afterClosureDigest: summary.afterClosureDigest,
    affectedCapabilities: [...summary.affectedCapabilities],
    behaviorChangeSummary: summary.behaviorChangeSummary,
    recoveryBundle: {
      bundleDigest: summary.recoveryBundleDigest,
      previousClosureDigest: bundle.recoveryBundle.previousClosureDigest,
      restartArtifactDigest:
        bundle.recoveryBundle.restartArtifact.executableDigest,
      rollbackTestReportDigest: summary.rollbackTestReportDigest,
    },
    independentReviewAttestationDigest:
      summary.independentReview.attestationDigest,
    updaterVersion: 1,
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

function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}
