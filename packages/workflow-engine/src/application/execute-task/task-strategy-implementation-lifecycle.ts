import crypto from 'node:crypto';

import { parseAiAdapterPolicyDocument } from '../../runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  bindingFromPayload,
  collaborationPolicyDigestForPhase,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
} from '../../modules/authority/collaboration-grant.ts';
import {
  consumeCollaborationGrantUnderLifecycleLock,
  inspectCollaborationGrantsUnderLifecycleLock,
  readReservedCollaborationGrantUnderLifecycleLock,
  reserveCollaborationGrantUnderLifecycleLock,
  type CollaborationGrantUseProjection,
} from '../../runtime/storage-journal/collaboration-grant-store.ts';
import { createEvidenceNode } from '../../adapters/compatibility/investigation-v2/evidence-node.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../../runtime/storage-journal/evidence-object-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  createReplacementAttempt,
  providerExecutionEnvironmentDigest,
  providerExecutionPolicySnapshot,
} from '../../modules/provider-orchestration/execution-core.ts';
import { previewExactStaging } from '../../runtime/repository-transaction/git-transitions.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from '../../composition-root/lifecycle-context.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  createProviderInvocation,
  createProviderRetryReservation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  type ProviderRetryDecisionBinding,
  type ProviderRetryReservationV2,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import { authorizeAutomaticProviderRetry } from '../../modules/provider-orchestration/provider-retry-decision.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  admitRoleResult,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type AdmittedRoleResult,
  type GrantedRoleAssignment,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RoleParticipant,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../../runtime/session-workspace/session-store.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  assertTaskStrategyImplementationOutput,
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
  type TaskStrategyImplementationOutput,
  type TaskStrategyImplementationSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  resolveCurrentTaskStrategyCorrection,
  type TaskStrategyCorrectionProjection,
} from './task-strategy-correction.ts';
import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  readTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
} from '../../runtime/storage-journal/task-strategy-correction-store.ts';
import {
  listTaskStrategyCorrectionRounds,
  publishTaskStrategyCorrectionRoundImport,
  publishTaskStrategyCorrectionRoundResult,
  readTaskStrategyCorrectionRound,
  reserveTaskStrategyCorrectionRound,
  type TaskStrategyCorrectionReservationAuthority,
  type TaskStrategyCorrectionResultAuthority,
} from '../../runtime/storage-journal/task-strategy-correction-round-store.ts';
import {
  assertTaskStrategyCallerImplementationAuthorityCurrent,
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent,
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  createTaskStrategyCallerImplementationBinding,
  createTaskStrategyCallerImplementationReservation,
  createTaskStrategyImplementationResultBinding,
  createTaskStrategyImplementationReservation,
  readCurrentTaskStrategyImplementationProviderAttempt,
  readTaskStrategyImplementationProviderAttempt,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyImplementationReservation,
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
  type TaskStrategyCallerImplementationBinding,
  type TaskStrategyCallerImplementationReservation,
  type TaskStrategyImplementationResultBinding,
  type TaskStrategyImplementationReservation,
  type TaskStrategyImplementationProviderAttempt,
} from '../../runtime/storage-journal/task-strategy-provider-store.ts';
import {
  importTaskStrategyCallerPatchUnderLifecycleLock,
  importTaskStrategyProviderPatchUnderLifecycleLock,
  type ImportedTaskStrategyPatch,
  validateTaskStrategyCallerPatch,
  validateTaskStrategyProviderPatch,
} from './task-strategy-patch.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchRecord,
} from '../../runtime/storage-journal/task-strategy-patch-store.ts';
import { readTaskStrategyTransaction } from '../../runtime/storage-journal/task-strategy-store.ts';
import {
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
  type TaskMandateBinding,
} from '../../modules/authority/task-mandate.ts';
import { inspectSession } from '../finalize/verification.ts';

export type BeginTaskStrategyImplementationOptions = Readonly<{
  retryProviderFailure?: boolean;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
    callerSupplied?: Readonly<{
      callerId: string;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
      patch: string | Buffer;
    }>;
  }>;
  testCrashAfter?:
    | 'provider-retry-reservation-persisted'
    | 'provider-result-persisted'
    | 'patch-applied'
    | 'receipt-persisted'
    | 'provider-patch-imported';
}>;

type TaskStrategyRedAuthor = Readonly<{
  providerId: ProviderId;
  sessionId: string;
  principalId: string;
  identityAssurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  engineSpawned: false;
}>;

export type TaskStrategyImplementationStatus =
  | Readonly<{
      state: 'provider-not-required';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
    }>
  | Readonly<{
      state: 'ready' | 'reservation-persisted';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
    }>
  | Readonly<{
      state: 'collaboration-grant-required';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      inputSchema: Readonly<{
        schemaVersion: 1;
        kind: 'collaboration-grant-selection';
        lifecyclePhase: 'task-implementation';
        conflictingRole: 'task-implementer';
        grantRequest: CollaborationGrantRequest | null;
        allowedDegradedForms: readonly (
          'same-provider-fresh-session' | 'caller-supplied'
        )[];
        resumeOption: '--grant <grant-id>';
      }>;
    }>
  | Readonly<{
      state:
        | 'waiting-for-provider'
        | 'provider-succeeded-awaiting-import'
        | 'provider-failed';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      failure: ReturnType<typeof readProviderInvocation>['failure'];
    }>
  | Readonly<{
      state: 'caller-supplied-awaiting-import' | 'patch-imported';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      assignment: ProviderRoleAssignment | GrantedRoleAssignment;
      ownerInvestigationId: string | null;
      invocationId: string | null;
      failure: null;
    }>;

export function beginTaskStrategyImplementation(
  cwd: string,
  requestedSessionId: string,
  options: BeginTaskStrategyImplementationOptions = {},
): TaskStrategyImplementationStatus {
  const initial = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
    withSessionOperation(initial.runtime, requestedSessionId, () => {
      assertOwned();
      const context = loadActiveSessionContext(cwd, requestedSessionId);
      const runtime = loadInvestigationRuntimeContext(cwd).runtime;
      const transaction = requireCurrentRedTransaction(cwd, context);
      // Older sealed RED records embedded the exact evidence node before the
      // content-addressed object store became a scheduling dependency. Only
      // this mutating transition may publish those same verified bytes;
      // inspection and owner-currentness checks remain strictly read-only.
      writeEvidenceNode(runtime, transaction.red.evidenceNode);
      const task = implementationTask(cwd, context, transaction);
      const current = resolveCurrentImplementationSubject(
        cwd,
        context,
        transaction,
      );
      const subject = current.subject;
      if (transaction.strategy === 'tdd-single-agent') {
        return Object.freeze({
          state: 'provider-not-required' as const,
          sessionId: context.session.sessionId,
          subject,
        });
      }
      const existing = readTaskStrategyImplementationReservation(
        runtime,
        context.session.sessionId,
        subject.subjectDigest,
      );
      const created =
        existing ??
        createImplementationReservation(
          context,
          runtime,
          transaction,
          subject,
          current.greenFailureRecord,
          task,
          options.collaborationGrant,
          options.testCrashAfter,
          assertOwned,
        );
      if (!('recordDigest' in created)) return created;
      assertReservationCurrent(context, transaction, subject, created);
      ensureProviderCorrectionRoundReservation(
        runtime,
        transaction,
        created,
        current.greenFailureRecord,
      );
      let attempt = readCurrentTaskStrategyImplementationProviderAttempt(
        runtime,
        created,
      );
      if (
        options.retryProviderFailure === true &&
        providerInvocationExists(runtime, attempt.request.invocationId) &&
        readProviderInvocation(runtime, attempt.request.invocationId).state ===
          'failed'
      ) {
        const retry = reserveProviderRetryAttempt(
          context,
          runtime,
          created,
          attempt,
          options,
          assertOwned,
        );
        if ('state' in retry) return retry;
        attempt = retry;
      }
      ensureProviderInvocation(context, runtime, attempt, assertOwned);
      assertOwned();
      const status = renderStatus(runtime, created, attempt);
      return status.state === 'provider-succeeded-awaiting-import' ||
        (status.state === 'patch-imported' &&
          providerCorrectionRoundNeedsReconciliation(
            runtime,
            transaction,
            created,
          ))
        ? reconcileProviderImplementationResult(
            cwd,
            context,
            runtime,
            transaction,
            created,
            attempt,
            options,
            assertOwned,
          )
        : status;
    }),
  );
}

export function inspectTaskStrategyImplementation(
  cwd: string,
  requestedSessionId: string,
): TaskStrategyImplementationStatus {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const transaction = requireCurrentRedTransaction(cwd, context);
  const subject = resolveCurrentImplementationSubject(
    cwd,
    context,
    transaction,
  ).subject;
  if (transaction.strategy === 'tdd-single-agent') {
    return Object.freeze({
      state: 'provider-not-required' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  const reservation = readTaskStrategyImplementationReservation(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  if (reservation === null) {
    const callerReservation = readTaskStrategyCallerImplementationReservation(
      runtime,
      context.session.sessionId,
      subject.subjectDigest,
    );
    const callerBinding = readTaskStrategyCallerImplementationBinding(
      runtime,
      context.session.sessionId,
      subject.subjectDigest,
    );
    if (callerReservation !== null || callerBinding !== null) {
      if (callerReservation === null) throw implementationResultStale();
      assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
        runtime,
        transaction,
        subject,
        callerReservation,
      );
      if (callerBinding !== null) {
        assertTaskStrategyCallerImplementationAuthorityCurrent(
          runtime,
          transaction,
          subject,
          callerReservation,
          callerBinding,
        );
      }
      return renderCallerImplementationStatus(
        runtime,
        subject,
        callerReservation,
        callerBinding,
      );
    }
    return Object.freeze({
      state: 'ready' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  assertReservationCurrent(context, transaction, subject, reservation);
  const attempt = readCurrentTaskStrategyImplementationProviderAttempt(
    runtime,
    reservation,
  );
  if (!providerInvocationExists(runtime, attempt.request.invocationId)) {
    return Object.freeze({
      state: 'reservation-persisted' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  return renderStatus(runtime, reservation, attempt);
}

export function assertTaskStrategyImplementationProviderOwnerCurrent(
  cwd: string,
  requestedInvocationId: string,
): TaskStrategyImplementationReservation {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const invocation = readProviderInvocation(runtime, requestedInvocationId);
  const manifest = readProviderInvocationManifest(
    runtime,
    requestedInvocationId,
  );
  const request = readProviderInvocationRequest(runtime, requestedInvocationId);
  if (manifest.kind !== 'task-strategy-implementation-manifest') {
    throw requestConflict();
  }
  const context = loadActiveSessionContext(cwd, manifest.subject.sessionId);
  const transaction = requireCurrentRedTransaction(cwd, context);
  const subject = resolveCurrentImplementationSubject(
    cwd,
    context,
    transaction,
  ).subject;
  const reservation = readTaskStrategyImplementationReservation(
    runtime,
    manifest.subject.sessionId,
    subject.subjectDigest,
  );
  if (reservation === null) throw requestConflict();
  assertReservationCurrent(context, transaction, subject, reservation);
  if (
    invocation.investigationId !== reservation.ownerInvestigationId ||
    canonicalJson(invocation.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding) ||
    canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
    (invocation.attempt === 1 &&
      invocation.invocationId !== reservation.request.invocationId)
  ) {
    throw requestConflict();
  }
  const attempt = readTaskStrategyImplementationProviderAttempt(
    runtime,
    reservation,
    invocation.invocationId,
  );
  const current = readCurrentTaskStrategyImplementationProviderAttempt(
    runtime,
    reservation,
  );
  if (
    canonicalJson(request) !== canonicalJson(attempt.request) ||
    current.request.invocationId !== attempt.request.invocationId
  ) {
    throw requestConflict();
  }
  return taskStrategyImplementationReservationForAttempt(attempt);
}

function createImplementationReservation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  subject: TaskStrategyImplementationSubject,
  greenFailureRecord: TaskStrategyGreenFailureRecord | null,
  task: ReturnType<typeof implementationTask>,
  collaborationGrant:
    BeginTaskStrategyImplementationOptions['collaborationGrant'] | undefined,
  testCrashAfter: BeginTaskStrategyImplementationOptions['testCrashAfter'],
  assertOwned: () => void,
): TaskStrategyImplementationReservation | TaskStrategyImplementationStatus {
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  const seed = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-strategy-implementation-owner.v1',
      sessionId: context.session.sessionId,
      subjectDigest: subject.subjectDigest,
    }),
  );
  const providerSessionId = `provider-session-task-implementation-${seed}`;
  const redAuthor = recordRedAuthor(transaction);
  const author: RoleParticipant = {
    providerId: redAuthor.providerId ?? undefined,
    sessionId: redAuthor.sessionId ?? undefined,
    principalId: redAuthor.principalId ?? undefined,
    identityAssurance: redAuthor.identityAssurance,
    engineSpawned: false,
  };
  const candidates = (['codex', 'claude'] as const).map((providerId) => ({
    providerId,
    sessionId: providerSessionId,
    enabled: policy.policy.providers[providerId].enabled,
    available: policy.policy.providers[providerId].enabled,
  }));
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author,
    targetDigest: subject.subjectDigest,
    candidates,
  });
  let assignment: ProviderRoleAssignment;
  if (scheduled.outcome !== 'assigned') {
    const callableProviderIds = candidates
      .filter(({ enabled, available }) => enabled && available)
      .map(({ providerId }) => providerId);
    const grantRequest = implementationGrantRequest(
      context,
      subject,
      redAuthor,
      callableProviderIds,
    );
    if (collaborationGrant === undefined) {
      return collaborationPause(
        context.session.sessionId,
        subject,
        grantRequest,
      );
    }
    if (grantRequest === null) {
      return importCallerSuppliedImplementation(
        context,
        runtime,
        transaction,
        subject,
        greenFailureRecord,
        author,
        collaborationGrant,
        testCrashAfter,
        assertOwned,
      );
    }
    const expected = deriveCollaborationGrantBinding(
      context.git.repositoryRoot,
      grantRequest,
    );
    const reservation = reserveCollaborationGrantUnderLifecycleLock(
      context.git.repositoryRoot,
      collaborationGrant.grantId,
      {
        transitionDigest: sha256(
          canonicalJson({
            schemaVersion: 1,
            kind: 'collaboration-role-transition',
            expectedBinding: expected,
          }),
        ),
        expected,
        ...(collaborationGrant.now === undefined
          ? {}
          : { now: collaborationGrant.now }),
        ...(collaborationGrant.verifier === undefined
          ? {}
          : { verifier: collaborationGrant.verifier }),
      },
      assertOwned,
    );
    assignment = authorizeGrantedOrdinaryRole({
      role: 'task-implementer',
      author,
      targetDigest: subject.subjectDigest,
      reservation,
      actualParticipant: {
        providerId: redAuthor.providerId ?? undefined,
        sessionId: providerSessionId,
        principalId: `collaboration-grant:${reservation.grantId}:task-implementer`,
        identityAssurance: redAuthor.identityAssurance,
        engineSpawned: true,
      },
      callableProviderIds,
    }) as GrantedSameProviderRoleAssignment;
  } else {
    assignment = scheduled.assignment;
  }

  const ownerInvestigationId = `investigation-task-implementation-${seed}`;
  const mandateBinding = (context.session.mandateBinding ??
    null) as TaskMandateBinding | null;
  const authorization = createEvidenceNode({
    type: 'task-strategy-implementation-authorization',
    nodeSchema: 'workflow.task-strategy-implementation-authorization.v1',
    evaluator: 'workflow-task-strategy.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    exactInputDigests: {
      assignment: sha256(canonicalJson(assignment)),
      author: sha256(canonicalJson(redAuthor)),
      mandate: sha256(canonicalJson(mandateBinding)),
      session: sha256(
        canonicalJson({
          sessionId: context.session.sessionId,
          changeId: context.session.changeId,
          taskId: context.session.taskId,
        }),
      ),
      subject: subject.subjectDigest,
      transaction: transaction.recordDigest,
    },
    semanticParentResultDigests: {
      red: transaction.red.evidenceResultDigest,
    },
    provenanceParentNodeIds: { red: transaction.red.evidenceNodeId },
    outputSchema:
      'workflow.task-strategy-implementation-authorization-output.v1',
    output: {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      subject,
      redAuthor,
      assignment,
      mandateBinding,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorization);
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: context.config.repositoryName,
    baseCommit: context.session.baseline.head,
    baseTree: context.session.baseline.tree,
    subject,
    behaviorContractRefs: task.behaviorContractRefs,
    implementationPathScopes: task.implementationPathScopes,
    ...(greenFailureRecord === null ? {} : { greenFailureRecord }),
  });
  const request = createProviderInvocationRequest({
    invocationId: `invocation-task-implementation-${seed}`,
    nonce: `task-implementation-${seed}`,
    purpose: 'task-implementation',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: context.config.repositoryName,
    baseCommit: context.session.baseline.head,
    baseTree: context.session.baseline.tree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: authorization.nodeId,
    writeAllowedPaths: [],
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-strategy-implementation.v1',
    policyDigest: policy.digest,
    limits: {
      timeoutMs: policy.policy.limits.timeoutMs,
      aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
    },
  });
  const requestReservation = createEvidenceNode({
    type: 'task-strategy-implementation-request-reservation',
    nodeSchema: 'workflow.task-strategy-implementation-reservation.v1',
    evaluator: 'workflow-task-strategy.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    exactInputDigests: {
      manifest: request.inputManifestDigest,
      request: request.requestDigest,
      subject: subject.subjectDigest,
    },
    semanticParentResultDigests: {
      authorization: authorization.resultDigest,
    },
    provenanceParentNodeIds: { authorization: authorization.nodeId },
    outputSchema: 'workflow.task-strategy-implementation-reservation-output.v1',
    output: {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      subject,
      redAuthor,
      assignment,
      manifest,
      request,
      mandateBinding,
    },
    runtimeMetadata: {},
  });
  storeProviderExecutionPolicySnapshot(runtime, request, policy);
  writeEvidenceNode(runtime, requestReservation);
  return createTaskStrategyImplementationReservation(runtime, {
    ownerInvestigationId,
    sessionId: context.session.sessionId,
    changeId: context.session.changeId,
    taskId: context.session.taskId,
    repositoryRoot: context.git.repositoryRealPath,
    gitCommonDirectory: context.git.gitCommonDirectory,
    branch: context.session.branch,
    baseline: context.session.baseline,
    mandateBinding,
    subject,
    redAuthor,
    assignment,
    manifest,
    request,
    authorizationNodeId: authorization.nodeId,
    reservationNodeId: requestReservation.nodeId,
    createdAt: transaction.createdAt,
  });
}

function importCallerSuppliedImplementation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  subject: TaskStrategyImplementationSubject,
  greenFailureRecord: TaskStrategyGreenFailureRecord | null,
  author: RoleParticipant,
  collaborationGrant: NonNullable<
    BeginTaskStrategyImplementationOptions['collaborationGrant']
  >,
  testCrashAfter: BeginTaskStrategyImplementationOptions['testCrashAfter'],
  assertOwned: () => void,
): TaskStrategyImplementationStatus {
  const submitted = collaborationGrant.callerSupplied;
  if (submitted === undefined) {
    throw workflowError(
      'COLLABORATION_GRANT_FORM_REQUIRED',
      'A caller-supplied task implementation grant requires the exact caller identity, assurance, and bounded patch bytes.',
      ExitCode.guard,
    );
  }
  const patchBytes = Buffer.isBuffer(submitted.patch)
    ? Buffer.from(submitted.patch)
    : Buffer.from(submitted.patch, 'utf8');
  const output = assertTaskStrategyImplementationOutput({
    schemaVersion: 1,
    kind: 'task-strategy-patch-output.v1',
    sessionId: context.session.sessionId,
    sourceTree: subject.sourceTree,
    patchBase64: patchBytes.toString('base64'),
    patchDigest: sha256Bytes(patchBytes),
  });
  const callerImplementer = Object.freeze({
    providerId: null,
    principalId: submitted.callerId,
    assurance: submitted.assurance,
    degradedForm: 'caller-supplied' as const,
    grantId: collaborationGrant.grantId,
  });
  let reservation = readTaskStrategyCallerImplementationReservation(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  if (reservation === null) {
    const validation = validateTaskStrategyCallerPatch(
      context.git.repositoryRoot,
      context.session.sessionId,
      {
        patch: patchBytes,
        callerImplementer,
        implementationSubjectDigest: subject.subjectDigest,
      },
    );
    if (
      validation.patchDigest !== output.patchDigest ||
      validation.sourceTree !== output.sourceTree
    ) {
      throw implementationResultStale();
    }
  }

  const grantRequest = callerImplementationGrantRequest(
    context,
    subject,
    submitted.callerId,
    submitted.assurance,
  );
  const expectedBinding = deriveCollaborationGrantBinding(
    context.git.repositoryRoot,
    grantRequest,
  );
  const transitionDigest = collaborationTransitionDigest(expectedBinding);
  if (reservation === null) {
    const inspection = inspectCollaborationGrantsUnderLifecycleLock(
      context.git.gitCommonDirectory,
      collaborationGrant.grantId,
      assertOwned,
    )[0];
    if (inspection === undefined) throw implementationResultStale();
    const grantReservation =
      inspection.state === 'available'
        ? reserveCollaborationGrantUnderLifecycleLock(
            context.git.repositoryRoot,
            collaborationGrant.grantId,
            {
              transitionDigest,
              expected: expectedBinding,
              ...(collaborationGrant.now === undefined
                ? {}
                : { now: collaborationGrant.now }),
              ...(collaborationGrant.verifier === undefined
                ? {}
                : { verifier: collaborationGrant.verifier }),
            },
            assertOwned,
          )
        : inspection.state === 'reserved'
          ? readReservedCollaborationGrantUnderLifecycleLock(
              context.git.gitCommonDirectory,
              collaborationGrant.grantId,
              assertOwned,
            )
          : null;
    if (
      grantReservation === null ||
      grantReservation.transitionDigest !== transitionDigest ||
      canonicalJson(bindingFromPayload(grantReservation.envelope.payload)) !==
        canonicalJson(expectedBinding)
    ) {
      throw implementationResultStale();
    }
    const assignment = authorizeGrantedOrdinaryRole({
      role: 'task-implementer',
      author,
      targetDigest: subject.subjectDigest,
      reservation: grantReservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: submitted.callerId,
        identityAssurance: submitted.assurance,
        engineSpawned: false,
      },
      callableProviderIds: [],
    });
    const submissionNode = createEvidenceNode({
      type: 'task-strategy-implementation-caller-submission',
      nodeSchema: 'workflow.task-strategy-implementation-caller-submission.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        caller: sha256(
          canonicalJson({
            callerId: submitted.callerId,
            assurance: submitted.assurance,
          }),
        ),
        output: sha256(canonicalJson(output)),
        subject: subject.subjectDigest,
        transition: transitionDigest,
      },
      semanticParentResultDigests: {
        red: transaction.red.evidenceResultDigest,
      },
      provenanceParentNodeIds: { red: transaction.red.evidenceNodeId },
      outputSchema:
        'workflow.task-strategy-implementation-caller-submission-output.v1',
      output: {
        sessionId: context.session.sessionId,
        subjectDigest: subject.subjectDigest,
        transitionDigest,
        caller: {
          callerId: submitted.callerId,
          assurance: submitted.assurance,
        },
        assignment,
        output,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, submissionNode);
    reservation = createTaskStrategyCallerImplementationReservation(runtime, {
      sessionId: context.session.sessionId,
      subjectDigest: subject.subjectDigest,
      grantId: grantReservation.grantId,
      transitionDigest,
      assignment,
      submissionNodeId: submissionNode.nodeId,
      submissionResultDigest: submissionNode.resultDigest,
      output,
      createdAt: grantReservation.reservedAt,
    });
  }
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
    runtime,
    transaction,
    subject,
    reservation,
  );
  if (
    reservation.grantId !== collaborationGrant.grantId ||
    reservation.assignment.participant.principalId !== submitted.callerId ||
    reservation.assignment.participant.identityAssurance !==
      submitted.assurance ||
    canonicalJson(reservation.output) !== canonicalJson(output)
  ) {
    throw implementationResultStale();
  }
  ensureCallerCorrectionRoundReservation(
    runtime,
    transaction,
    subject,
    greenFailureRecord,
    reservation,
  );

  let binding = readTaskStrategyCallerImplementationBinding(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  if (binding === null) {
    const maintainerPolicy = parseMaintainerPolicy(
      JSON.parse(
        runGit(context.git.repositoryRoot, [
          'show',
          `${expectedBinding.baselineCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    const verifier =
      collaborationGrant.verifier ??
      createInteractiveSshSigner(context.git.repositoryRoot, maintainerPolicy);
    const now = collaborationGrant.now ?? new Date();
    const consumed = consumeCollaborationGrantUnderLifecycleLock(
      context.git.gitCommonDirectory,
      reservation.grantId,
      {
        transitionDigest,
        assignment: reservation.assignment,
        contentAdmission: {
          kind: 'task-implementation',
          nodeId: reservation.submissionNodeId,
          resultDigest: reservation.submissionResultDigest,
          current: true,
        },
        now,
      },
      assertOwned,
    );
    if (consumed.use === undefined) throw implementationResultStale();
    const content = {
      kind: 'task-implementation' as const,
      nodeId: reservation.submissionNodeId,
      resultDigest: reservation.submissionResultDigest,
      outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
      evaluator: 'task-strategy-implementation.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      contentDigest: reservation.submissionResultDigest,
      current: true as const,
    };
    const roleResult = admitRoleResult({
      assignment: reservation.assignment,
      author: reservation.assignment.author,
      participant: reservation.assignment.participant,
      content,
      providerInvocation: null,
      grantUse: consumed.use,
      grantValidation: {
        now,
        expectedBinding,
        policy: maintainerPolicy,
        verifier,
        transitionDigest,
      },
    });
    const resultNode = createEvidenceNode({
      type: 'task-strategy-implementation-caller-result',
      nodeSchema: 'workflow.task-strategy-implementation-caller-result.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        admission: roleResult.resultDigest,
        submission: reservation.submissionResultDigest,
        subject: subject.subjectDigest,
        transition: transitionDigest,
      },
      semanticParentResultDigests: {
        submission: reservation.submissionResultDigest,
      },
      provenanceParentNodeIds: {
        submission: reservation.submissionNodeId,
      },
      outputSchema:
        'workflow.task-strategy-implementation-caller-result-output.v1',
      output: {
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subjectDigest,
        roleResult,
        output: reservation.output,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, resultNode);
    binding = createTaskStrategyCallerImplementationBinding(runtime, {
      sessionId: reservation.sessionId,
      subjectDigest: reservation.subjectDigest,
      transitionDigest: reservation.transitionDigest,
      submissionNodeId: reservation.submissionNodeId,
      submissionResultDigest: reservation.submissionResultDigest,
      resultNodeId: resultNode.nodeId,
      resultDigest: resultNode.resultDigest,
      roleResult,
      output: reservation.output,
      createdAt: reservation.createdAt,
    });
    if (collaborationGrant.callerSupplied !== undefined) {
      if (
        collaborationGrant.callerSupplied.callerId !== submitted.callerId ||
        canonicalJson(reservation.output) !== canonicalJson(output)
      ) {
        throw implementationResultStale();
      }
    }
  }
  assertTaskStrategyCallerImplementationAuthorityCurrent(
    runtime,
    transaction,
    subject,
    reservation,
    binding,
  );
  if (testCrashAfter === 'provider-result-persisted') {
    throw new Error(
      'Simulated task implementation interruption after caller result persistence.',
    );
  }
  const imported = importTaskStrategyCallerPatchUnderLifecycleLock(
    context.git.repositoryRoot,
    context.session.sessionId,
    {
      patch: Buffer.from(binding.output.patchBase64, 'base64'),
      callerImplementationBindingDigest: binding.bindingDigest,
      implementationSubjectDigest: subject.subjectDigest,
      ...(testCrashAfter === 'patch-applied' ||
      testCrashAfter === 'receipt-persisted'
        ? { testCrashAfter }
        : {}),
    },
    assertOwned,
  );
  publishCallerCorrectionRoundArtifacts(
    runtime,
    transaction,
    subject,
    reservation,
    binding,
    imported,
  );
  assertOwned();
  return renderCallerImplementationStatus(
    runtime,
    subject,
    reservation,
    binding,
  );
}

function reserveProviderRetryAttempt(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  root: TaskStrategyImplementationReservation,
  failedAttempt: TaskStrategyImplementationProviderAttempt,
  options: BeginTaskStrategyImplementationOptions,
  assertOwned: () => void,
):
  TaskStrategyImplementationProviderAttempt | TaskStrategyImplementationStatus {
  const failed = readProviderInvocation(
    runtime,
    failedAttempt.request.invocationId,
  );
  if (
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    failed.attempt !== failedAttempt.attempt
  ) {
    throw providerRetryDenied(
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_NOT_ALLOWED',
      root.sessionId,
    );
  }
  const nextAttempt = failed.attempt + 1;
  const retrySeed = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-strategy-implementation-transport-retry.v1',
      rootReservationDigest: root.recordDigest,
      failedInvocationId: failed.invocationId,
      failedRevision: failed.revision,
      failure: failed.failure,
      attempt: nextAttempt,
    }),
  );
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  let assignment = failedAttempt.assignment;
  let authorizationNode = readEvidenceNode(
    runtime,
    failedAttempt.authorizationNodeId,
  );
  let replacementRequest = createProviderRetryRequest({
    failedAttempt,
    assignment,
    authorizationNodeId: authorizationNode.nodeId,
    policy,
    retrySeed,
  });
  let authorization = authorizeAutomaticProviderRetry(runtime, {
    failed,
    failedRequest: failedAttempt.request,
    replacementRequest,
    replacementExecutionPolicy: policy,
  });
  let strategyChanges: string[] = [];
  if (authorization.decision.retryMode === 'strategy-change') {
    const changed = authorizeTaskStrategyRetryStrategyChange({
      context,
      root,
      failedAttempt,
      retrySeed,
      policy,
      collaborationGrant: options.collaborationGrant,
      assertOwned,
    });
    if ('state' in changed) return changed;
    assignment = changed.assignment;
    strategyChanges =
      failedAttempt.assignment.providerId === assignment.providerId
        ? [
            `provider-session:${failedAttempt.assignment.sessionId}->${assignment.sessionId}`,
          ]
        : [
            `provider:${failedAttempt.assignment.providerId}->${assignment.providerId}`,
          ];
    authorizationNode = createProviderRetryAuthorization(
      runtime,
      root,
      assignment,
    );
    replacementRequest = createProviderRetryRequest({
      failedAttempt,
      assignment,
      authorizationNodeId: authorizationNode.nodeId,
      policy,
      retrySeed,
    });
    authorization = authorizeAutomaticProviderRetry(runtime, {
      failed,
      failedRequest: failedAttempt.request,
      replacementRequest,
      replacementExecutionPolicy: policy,
    });
  } else if (options.collaborationGrant !== undefined) {
    if (
      !('grantId' in root.assignment) ||
      root.assignment.grantId !== options.collaborationGrant.grantId
    ) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_GRANT_OWNER_MISMATCH',
        root.sessionId,
      );
    }
  }
  const retryMode = authorization.decision.retryMode;
  if (
    !authorization.decision.retryable ||
    !authorization.decision.automatic ||
    (retryMode !== 'same-input' && retryMode !== 'strategy-change') ||
    (retryMode === 'strategy-change' && strategyChanges.length === 0)
  ) {
    throw providerRetryDenied(
      authorization.decision.reasonCode,
      root.sessionId,
    );
  }
  const replacement = createReplacementAttempt({
    workflow: authorization.workflow,
    job: authorization.job,
    previousAttempt: authorization.attempt,
    attemptId: `attempt-legacy-${replacementRequest.invocationId}`,
    retryMode,
    currentExecutionPolicy: providerExecutionPolicySnapshot(replacementRequest),
    strategyChanges,
    environmentDigest: providerExecutionEnvironmentDigest(replacementRequest),
    createdAt: authorization.evaluatedAt,
  });
  if (
    replacement.job.jobId !== authorization.job.jobId ||
    replacement.attempt.attemptNumber !== nextAttempt ||
    replacement.attempt.retryOf !== authorization.attempt.attemptId
  ) {
    throw providerRetryDenied(
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_LINEAGE_INVALID',
      root.sessionId,
    );
  }
  const retryDecision: ProviderRetryDecisionBinding = Object.freeze({
    schemaVersion: 1,
    kind: 'provider-retry-decision-binding',
    executionJobId: authorization.job.jobId,
    executionRevision: authorization.executionRevision,
    failedAttemptId: authorization.attempt.attemptId,
    evidenceDigest: authorization.evidenceDigest,
    evaluatedAt: authorization.evaluatedAt,
  });
  const requestReservation = createProviderRetryRequestReservation(
    runtime,
    root,
    failedAttempt,
    replacementRequest,
    authorizationNode,
    retryDecision,
  );
  const persisted = createProviderRetryReservation(runtime, {
    investigationId: root.ownerInvestigationId,
    changeId: root.changeId,
    attempt: nextAttempt,
    previousInvocationId: failed.invocationId,
    manifest: root.manifest,
    request: replacementRequest,
    executionPolicy: policy,
    retryDecision,
    replacement: {
      attemptId: replacement.attempt.attemptId,
      retryMode: replacement.attempt.retryMode as
        'same-input' | 'strategy-change',
      strategyChanges: [...replacement.attempt.strategyChanges],
      environmentDigest: replacement.attempt.environmentDigest,
      executionGrantId: replacement.attempt.grantId,
      authorizationNodeId: authorizationNode.nodeId,
      reservationNodeId: requestReservation.nodeId,
    },
    ...(root.mandateBinding === null
      ? {}
      : { mandateBinding: root.mandateBinding }),
    createdAt: authorization.evaluatedAt,
  });
  if (persisted.schemaVersion !== 3) {
    throw providerRetryDenied(
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_RESERVATION_INVALID',
      root.sessionId,
    );
  }
  if (options.testCrashAfter === 'provider-retry-reservation-persisted') {
    throw new Error(
      'Simulated task implementation interruption after provider retry reservation persistence.',
    );
  }
  return readCurrentTaskStrategyImplementationProviderAttempt(runtime, root);
}

function createProviderRetryRequest(input: {
  failedAttempt: TaskStrategyImplementationProviderAttempt;
  assignment: ProviderRoleAssignment;
  authorizationNodeId: string;
  policy: ReturnType<typeof baselineAdapterPolicy>;
  retrySeed: string;
}) {
  return createProviderInvocationRequest({
    invocationId: `invocation-task-implementation-retry-${input.retrySeed}`,
    nonce: `task-implementation-retry-${input.retrySeed}`,
    purpose: input.failedAttempt.request.purpose,
    providerId: input.assignment.providerId,
    roleAssignment: input.assignment,
    capabilityProfile: input.failedAttempt.request.capabilityProfile,
    repositoryId: input.failedAttempt.request.repositoryId,
    baseCommit: input.failedAttempt.request.baseCommit,
    baseTree: input.failedAttempt.request.baseTree,
    targetDigest: input.failedAttempt.request.targetDigest,
    inputManifestDigest: input.failedAttempt.request.inputManifestDigest,
    authorizationNodeId: input.authorizationNodeId,
    writeAllowedPaths: [...input.failedAttempt.request.writeAllowedPaths],
    outputSchema: input.failedAttempt.request.outputSchema,
    evaluatorVersion: input.failedAttempt.request.evaluatorVersion,
    policyDigest: input.policy.digest,
    limits: {
      timeoutMs: input.policy.policy.limits.timeoutMs,
      aggregateOutputBytes: input.policy.policy.limits.aggregateOutputBytes,
    },
  });
}

function createProviderRetryAuthorization(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  root: TaskStrategyImplementationReservation,
  assignment: ProviderRoleAssignment,
) {
  const authorization = createEvidenceNode({
    type: 'task-strategy-implementation-authorization',
    nodeSchema: 'workflow.task-strategy-implementation-authorization.v1',
    evaluator: 'workflow-task-strategy.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    exactInputDigests: {
      assignment: sha256(canonicalJson(assignment)),
      author: sha256(canonicalJson(root.redAuthor)),
      mandate: sha256(canonicalJson(root.mandateBinding)),
      session: sha256(
        canonicalJson({
          sessionId: root.sessionId,
          changeId: root.changeId,
          taskId: root.taskId,
        }),
      ),
      subject: root.subject.subjectDigest,
      transaction: root.subject.transactionDigest,
    },
    semanticParentResultDigests: {
      red: root.subject.redEvidenceResultDigest,
    },
    provenanceParentNodeIds: { red: root.subject.redEvidenceNodeId },
    outputSchema:
      'workflow.task-strategy-implementation-authorization-output.v1',
    output: {
      ownerInvestigationId: root.ownerInvestigationId,
      sessionId: root.sessionId,
      changeId: root.changeId,
      taskId: root.taskId,
      subject: root.subject,
      redAuthor: root.redAuthor,
      assignment,
      mandateBinding: root.mandateBinding,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorization);
  return authorization;
}

function createProviderRetryRequestReservation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  root: TaskStrategyImplementationReservation,
  failedAttempt: TaskStrategyImplementationProviderAttempt,
  request: ReturnType<typeof createProviderInvocationRequest>,
  authorization: ReturnType<typeof createEvidenceNode>,
  retryDecision: ProviderRetryDecisionBinding,
) {
  const failed = readProviderInvocation(
    runtime,
    failedAttempt.request.invocationId,
  );
  if (failed.failure === null) throw implementationResultStale();
  const reservation = createEvidenceNode({
    type: 'task-strategy-implementation-request-reservation',
    nodeSchema: 'workflow.task-strategy-implementation-reservation.v1',
    evaluator: 'workflow-task-strategy.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    exactInputDigests: {
      failure: sha256(canonicalJson(failed.failure)),
      manifest: request.inputManifestDigest,
      previousRequest: failedAttempt.request.requestDigest,
      request: request.requestDigest,
      retryDecision: retryDecision.evidenceDigest,
      subject: root.subject.subjectDigest,
    },
    semanticParentResultDigests: {
      authorization: authorization.resultDigest,
    },
    provenanceParentNodeIds: { authorization: authorization.nodeId },
    outputSchema: 'workflow.task-strategy-implementation-reservation-output.v1',
    output: {
      ownerInvestigationId: root.ownerInvestigationId,
      sessionId: root.sessionId,
      changeId: root.changeId,
      taskId: root.taskId,
      subject: root.subject,
      redAuthor: root.redAuthor,
      assignment: request.roleAssignment,
      manifest: root.manifest,
      request,
      mandateBinding: root.mandateBinding,
      previousInvocationId: failed.invocationId,
      retryDecision,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, reservation);
  return reservation;
}

function authorizeTaskStrategyRetryStrategyChange(input: {
  context: ReturnType<typeof loadActiveSessionContext>;
  root: TaskStrategyImplementationReservation;
  failedAttempt: TaskStrategyImplementationProviderAttempt;
  retrySeed: string;
  policy: ReturnType<typeof baselineAdapterPolicy>;
  collaborationGrant:
    BeginTaskStrategyImplementationOptions['collaborationGrant'] | undefined;
  assertOwned: () => void;
}):
  | Readonly<{ assignment: ProviderRoleAssignment }>
  | TaskStrategyImplementationStatus {
  const providerSessionId = `provider-session-task-implementation-retry-${input.retrySeed}`;
  const redAuthor = requireRecordedRedAuthor(input.root.redAuthor);
  const author: RoleParticipant = {
    providerId: redAuthor.providerId,
    sessionId: redAuthor.sessionId,
    principalId: redAuthor.principalId,
    identityAssurance: redAuthor.identityAssurance,
    engineSpawned: false,
  };
  let candidates = (['codex', 'claude'] as const)
    .filter(
      (providerId) =>
        providerId !== input.failedAttempt.assignment.providerId &&
        input.policy.policy.providers[providerId].enabled,
    )
    .map((providerId) => ({
      providerId,
      sessionId: providerSessionId,
      enabled: true,
      available: true,
    }));
  if (candidates.length === 0) {
    const currentProvider = input.failedAttempt.assignment.providerId;
    if (!input.policy.policy.providers[currentProvider].enabled) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_STRATEGY_UNAVAILABLE',
        input.root.sessionId,
      );
    }
    candidates = [
      {
        providerId: currentProvider,
        sessionId: providerSessionId,
        enabled: true,
        available: true,
      },
    ];
  }
  if (candidates.length !== 1) {
    throw providerRetryDenied(
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_STRATEGY_UNAVAILABLE',
      input.root.sessionId,
    );
  }
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author,
    targetDigest: input.root.subject.subjectDigest,
    candidates,
  });
  if (scheduled.outcome === 'assigned') {
    return Object.freeze({ assignment: scheduled.assignment });
  }
  const callableProviderIds = candidates.map(({ providerId }) => providerId);
  const grantRequest = implementationGrantRequest(
    input.context,
    input.root.subject,
    redAuthor,
    callableProviderIds,
  );
  if (grantRequest === null) {
    throw providerRetryDenied(
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_STRATEGY_UNAVAILABLE',
      input.root.sessionId,
    );
  }
  if (input.collaborationGrant === undefined) {
    return collaborationPause(
      input.root.sessionId,
      input.root.subject,
      grantRequest,
    );
  }
  const expected = deriveCollaborationGrantBinding(
    input.context.git.repositoryRoot,
    grantRequest,
  );
  const transitionDigest = collaborationTransitionDigest(expected);
  const inspection = inspectCollaborationGrantsUnderLifecycleLock(
    input.context.git.gitCommonDirectory,
    input.collaborationGrant.grantId,
    input.assertOwned,
  )[0];
  if (inspection === undefined) throw implementationResultStale();
  const grantReservation =
    inspection.state === 'available'
      ? reserveCollaborationGrantUnderLifecycleLock(
          input.context.git.repositoryRoot,
          input.collaborationGrant.grantId,
          {
            transitionDigest,
            expected,
            ...(input.collaborationGrant.now === undefined
              ? {}
              : { now: input.collaborationGrant.now }),
            ...(input.collaborationGrant.verifier === undefined
              ? {}
              : { verifier: input.collaborationGrant.verifier }),
          },
          input.assertOwned,
        )
      : inspection.state === 'reserved'
        ? readReservedCollaborationGrantUnderLifecycleLock(
            input.context.git.gitCommonDirectory,
            input.collaborationGrant.grantId,
            input.assertOwned,
          )
        : null;
  if (
    grantReservation === null ||
    grantReservation.transitionDigest !== transitionDigest ||
    canonicalJson(bindingFromPayload(grantReservation.envelope.payload)) !==
      canonicalJson(expected)
  ) {
    throw implementationResultStale();
  }
  const providerId = callableProviderIds[0]!;
  return Object.freeze({
    assignment: authorizeGrantedOrdinaryRole({
      role: 'task-implementer',
      author,
      targetDigest: input.root.subject.subjectDigest,
      reservation: grantReservation,
      actualParticipant: {
        providerId,
        sessionId: providerSessionId,
        principalId: `collaboration-grant:${grantReservation.grantId}:task-implementer`,
        identityAssurance: redAuthor.identityAssurance,
        engineSpawned: true,
      },
      callableProviderIds,
    }) as GrantedSameProviderRoleAssignment,
  });
}

function ensureProviderInvocation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  attempt: TaskStrategyImplementationProviderAttempt,
  assertOwned: () => void,
): void {
  const reservation = taskStrategyImplementationReservationForAttempt(attempt);
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  storeProviderExecutionPolicySnapshot(runtime, reservation.request, policy);
  if (reservation.mandateBinding !== null) {
    authorizeTaskMandateProviderReservationUnderLifecycleLock(
      context.git.repositoryRoot,
      reservation.mandateBinding,
      reservation.request.invocationId,
      {
        providerId: reservation.request.providerId,
        dataTypes: [
          'diff',
          'repository-metadata',
          'source-code',
          'test-output',
        ],
        sourceCode: true,
        secrets: false,
        retry: attempt.attempt > 1,
        budget: null,
        requestDigest: reservation.request.requestDigest,
      },
      assertOwned,
    );
  }
  if (providerInvocationExists(runtime, reservation.request.invocationId)) {
    const invocation = readProviderInvocation(
      runtime,
      reservation.request.invocationId,
    );
    const request = readProviderInvocationRequest(
      runtime,
      reservation.request.invocationId,
    );
    const manifest = readProviderInvocationManifest(
      runtime,
      reservation.request.invocationId,
    );
    if (
      invocation.investigationId !== reservation.ownerInvestigationId ||
      invocation.changeId !== reservation.changeId ||
      invocation.attempt !== attempt.attempt ||
      invocation.requestDigest !== reservation.request.requestDigest ||
      canonicalJson(invocation.mandateBinding ?? null) !==
        canonicalJson(reservation.mandateBinding) ||
      canonicalJson(request) !== canonicalJson(reservation.request) ||
      canonicalJson(manifest) !== canonicalJson(reservation.manifest)
    ) {
      throw requestConflict();
    }
    return;
  }
  createProviderInvocation(runtime, {
    investigationId: reservation.ownerInvestigationId,
    changeId: reservation.changeId,
    ...(reservation.mandateBinding === null
      ? {}
      : { mandateBinding: reservation.mandateBinding }),
    attempt: attempt.attempt,
    manifest: reservation.manifest,
    request: reservation.request,
    createdAt: reservation.createdAt,
  });
  assertOwned();
}

function ensureProviderCorrectionRoundReservation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  reservation: TaskStrategyImplementationReservation,
  greenFailureRecord: TaskStrategyGreenFailureRecord | null,
): void {
  const correction = reservation.subject.correction;
  if (greenFailureRecord === null) {
    if (correction !== undefined) throw implementationResultStale();
    return;
  }
  if (
    correction === undefined ||
    correction.greenFailureRecordDigest !== greenFailureRecord.recordDigest ||
    correction.greenFailureSubjectDigest !== greenFailureRecord.subjectDigest ||
    correction.candidateTree !== greenFailureRecord.candidateTree ||
    correction.failingCheckFingerprint !==
      greenFailureRecord.failingCheck.failureFingerprint ||
    canonicalJson(correction.currentPatchHead) !==
      canonicalJson(greenFailureRecord.currentPatchHead)
  ) {
    throw implementationResultStale();
  }
  reserveTaskStrategyCorrectionRound(runtime, {
    sessionId: reservation.sessionId,
    round: correction.round,
    policy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
    predecessorFailure: greenFailureRecord,
    correctionSubjectDigest: reservation.subject.subjectDigest,
    redSourceTree: transaction.red.candidateTree,
    authority: providerCorrectionReservationAuthority(reservation),
    createdAt: reservation.createdAt,
  });
}

function ensureCallerCorrectionRoundReservation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  subject: TaskStrategyImplementationSubject,
  greenFailureRecord: TaskStrategyGreenFailureRecord | null,
  reservation: TaskStrategyCallerImplementationReservation,
): void {
  const correction = subject.correction;
  if (greenFailureRecord === null) {
    if (correction !== undefined) throw implementationResultStale();
    return;
  }
  if (
    correction === undefined ||
    correction.greenFailureRecordDigest !== greenFailureRecord.recordDigest ||
    correction.greenFailureSubjectDigest !== greenFailureRecord.subjectDigest ||
    correction.candidateTree !== greenFailureRecord.candidateTree ||
    correction.failingCheckFingerprint !==
      greenFailureRecord.failingCheck.failureFingerprint ||
    canonicalJson(correction.currentPatchHead) !==
      canonicalJson(greenFailureRecord.currentPatchHead)
  ) {
    throw implementationResultStale();
  }
  reserveTaskStrategyCorrectionRound(runtime, {
    sessionId: reservation.sessionId,
    round: correction.round,
    policy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
    predecessorFailure: greenFailureRecord,
    correctionSubjectDigest: subject.subjectDigest,
    redSourceTree: transaction.red.candidateTree,
    authority: callerCorrectionReservationAuthority(reservation),
    createdAt: reservation.createdAt,
  });
}

function callerCorrectionReservationAuthority(
  reservation: TaskStrategyCallerImplementationReservation,
): Extract<
  TaskStrategyCorrectionReservationAuthority,
  { kind: 'caller-supplied' }
> {
  return Object.freeze({
    kind: 'caller-supplied' as const,
    callerReservation: Object.freeze({
      reservationDigest: reservation.reservationDigest,
      grantId: reservation.grantId,
      transitionDigest: reservation.transitionDigest,
      submissionNodeId: reservation.submissionNodeId,
      submissionResultDigest: reservation.submissionResultDigest,
    }),
  });
}

function callerCorrectionResultAuthority(
  reservation: TaskStrategyCallerImplementationReservation,
  binding: TaskStrategyCallerImplementationBinding,
): Extract<TaskStrategyCorrectionResultAuthority, { kind: 'caller-supplied' }> {
  return Object.freeze({
    ...callerCorrectionReservationAuthority(reservation),
    kind: 'caller-supplied' as const,
    callerResult: Object.freeze({
      bindingDigest: binding.bindingDigest,
      resultNodeId: binding.resultNodeId,
      resultDigest: binding.resultDigest,
      roleResultDigest: binding.roleResult.resultDigest,
      grantUseDigest: sha256(canonicalJson(binding.roleResult.grantUse)),
    }),
  });
}

function publishCallerCorrectionRoundArtifacts(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyCallerImplementationReservation,
  binding: TaskStrategyCallerImplementationBinding,
  imported: ImportedTaskStrategyPatch,
): void {
  const correction = subject.correction;
  if (correction === undefined) return;
  const authority = callerCorrectionResultAuthority(reservation, binding);
  publishTaskStrategyCorrectionRoundResult(runtime, {
    sessionId: reservation.sessionId,
    currentRedTransactionDigest: transaction.recordDigest,
    round: correction.round,
    correctionSubjectDigest: subject.subjectDigest,
    authority,
    patchResult: {
      sourceTree: imported.record.sourceTree,
      targetCandidateTree: imported.record.candidateTree,
      patchRecordDigest: imported.record.recordDigest,
      patchDigest: imported.record.patchDigest,
    },
    createdAt: binding.createdAt,
  });
  publishTaskStrategyCorrectionRoundImport(runtime, {
    sessionId: reservation.sessionId,
    currentRedTransactionDigest: transaction.recordDigest,
    round: correction.round,
    correctionSubjectDigest: subject.subjectDigest,
    authority,
    importReceipt: {
      patchRecordDigest: imported.record.recordDigest,
      patchDigest: imported.record.patchDigest,
      receiptDigest: imported.receipt.receiptDigest,
      candidateTree: imported.record.candidateTree,
    },
    currentPatchHead: {
      bindingDigest: imported.binding.bindingDigest,
      recordDigest: imported.record.recordDigest,
      patchDigest: imported.record.patchDigest,
      receiptDigest: imported.receipt.receiptDigest,
    },
    importedAt: imported.receipt.importedAt,
  });
}

function providerCorrectionRoundNeedsReconciliation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  reservation: TaskStrategyImplementationReservation,
): boolean {
  const correction = reservation.subject.correction;
  if (correction === undefined) return false;
  return (
    readTaskStrategyCorrectionRound(
      runtime,
      reservation.sessionId,
      transaction.recordDigest,
      correction.round,
    )?.importRecord === null
  );
}

function providerCorrectionReservationAuthority(
  reservation: TaskStrategyImplementationReservation,
): Extract<TaskStrategyCorrectionReservationAuthority, { kind: 'provider' }> {
  return Object.freeze({
    kind: 'provider' as const,
    providerRequest: Object.freeze({
      ownerInvestigationId: reservation.ownerInvestigationId,
      invocationId: reservation.request.invocationId,
      requestDigest: reservation.request.requestDigest,
    }),
    providerReservation: Object.freeze({
      reservationDigest: reservation.recordDigest,
      authorizationNodeId: reservation.authorizationNodeId,
      reservationNodeId: reservation.reservationNodeId,
    }),
  });
}

function providerCorrectionResultAuthority(
  reservation: TaskStrategyImplementationReservation,
  attempt: TaskStrategyImplementationProviderAttempt,
  binding: TaskStrategyImplementationResultBinding,
): TaskStrategyCorrectionResultAuthority {
  return Object.freeze({
    ...providerCorrectionReservationAuthority(reservation),
    kind: 'provider' as const,
    providerAttempt: Object.freeze({
      attempt: attempt.attempt,
      attemptReservationDigest:
        taskStrategyImplementationProviderAttemptReservationDigest(attempt),
      invocationId: attempt.request.invocationId,
      requestDigest: attempt.request.requestDigest,
    }),
    providerResult: Object.freeze({
      bindingDigest: binding.bindingDigest,
      invocationId: binding.invocationId,
      requestDigest: binding.requestDigest,
      outputDigest: binding.outputDigest,
      providerResultNodeId: binding.providerResultNodeId,
      providerResultDigest: binding.providerResultDigest,
    }),
  });
}

function publishProviderCorrectionRoundArtifacts(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  reservation: TaskStrategyImplementationReservation,
  attempt: TaskStrategyImplementationProviderAttempt,
  binding: TaskStrategyImplementationResultBinding,
  imported: ImportedTaskStrategyPatch,
): void {
  const correction = reservation.subject.correction;
  if (correction === undefined) return;
  const authority = providerCorrectionResultAuthority(
    reservation,
    attempt,
    binding,
  );
  publishTaskStrategyCorrectionRoundResult(runtime, {
    sessionId: reservation.sessionId,
    currentRedTransactionDigest: transaction.recordDigest,
    round: correction.round,
    correctionSubjectDigest: reservation.subject.subjectDigest,
    authority,
    patchResult: {
      sourceTree: imported.record.sourceTree,
      targetCandidateTree: imported.record.candidateTree,
      patchRecordDigest: imported.record.recordDigest,
      patchDigest: imported.record.patchDigest,
    },
    createdAt: binding.createdAt,
  });
  publishTaskStrategyCorrectionRoundImport(runtime, {
    sessionId: reservation.sessionId,
    currentRedTransactionDigest: transaction.recordDigest,
    round: correction.round,
    correctionSubjectDigest: reservation.subject.subjectDigest,
    authority,
    importReceipt: {
      patchRecordDigest: imported.record.recordDigest,
      patchDigest: imported.record.patchDigest,
      receiptDigest: imported.receipt.receiptDigest,
      candidateTree: imported.record.candidateTree,
    },
    currentPatchHead: {
      bindingDigest: imported.binding.bindingDigest,
      recordDigest: imported.record.recordDigest,
      patchDigest: imported.record.patchDigest,
      receiptDigest: imported.receipt.receiptDigest,
    },
    importedAt: imported.receipt.importedAt,
  });
}

function reconcileProviderImplementationResult(
  cwd: string,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  root: TaskStrategyImplementationReservation,
  attempt: TaskStrategyImplementationProviderAttempt,
  options: BeginTaskStrategyImplementationOptions,
  assertOwned: () => void,
): TaskStrategyImplementationStatus {
  const reservation = taskStrategyImplementationReservationForAttempt(attempt);
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    return renderStatus(runtime, root, attempt);
  }
  if (invocation.result.runtimeObservation === null) {
    throw workflowError(
      'TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OBSERVATION_REQUIRED',
      'Task implementation import requires a fixed-runner repository observation.',
      ExitCode.verification,
    );
  }
  const output = assertTaskStrategyImplementationOutput(
    invocation.result.output,
  );
  if (
    output.sessionId !== context.session.sessionId ||
    output.sourceTree !== reservation.subject.sourceTree
  ) {
    throw implementationResultStale();
  }
  const durablePatchRecord = readTaskStrategyPatchRecord(
    runtime,
    context.session.sessionId,
    output.patchDigest,
    output.sourceTree,
  );
  if (durablePatchRecord === null) {
    validateTaskStrategyProviderPatch(cwd, context.session.sessionId, {
      patch: Buffer.from(output.patchBase64, 'base64'),
      implementationReservationDigest: reservation.recordDigest,
      implementationSubjectDigest: reservation.subject.subjectDigest,
    });
  }

  let binding = readTaskStrategyImplementationResultBinding(
    runtime,
    context.session.sessionId,
    reservation.subject.subjectDigest,
  );
  if (binding === null) {
    const authorization = readEvidenceNode(
      runtime,
      reservation.authorizationNodeId,
    );
    const requestReservation = readEvidenceNode(
      runtime,
      reservation.reservationNodeId,
    );
    const observationNode = createEvidenceNode({
      type: 'task-strategy-implementation-provider-observation',
      nodeSchema:
        'workflow.task-strategy-implementation-provider-observation.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        output: invocation.result.outputDigest,
        request: reservation.request.requestDigest,
        runtimeObservation: sha256(
          canonicalJson(invocation.result.runtimeObservation),
        ),
        subject: reservation.subject.subjectDigest,
      },
      semanticParentResultDigests: {
        authorization: authorization.resultDigest,
        reservation: requestReservation.resultDigest,
      },
      provenanceParentNodeIds: {
        authorization: authorization.nodeId,
        reservation: requestReservation.nodeId,
      },
      outputSchema:
        'workflow.task-strategy-implementation-provider-observation-output.v1',
      output: {
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        requestDigest: reservation.request.requestDigest,
        outputDigest: invocation.result.outputDigest,
        submission: output,
      },
      runtimeMetadata: {
        runtimeObservation: invocation.result.runtimeObservation,
      },
    });
    writeEvidenceNode(runtime, observationNode);
    const roleResult = admitTaskStrategyImplementationProviderResult({
      context,
      reservation,
      invocation: { ...invocation, result: invocation.result },
      observationNode,
      validation: options.collaborationGrant,
      assertOwned,
    });
    const resultNode = createEvidenceNode({
      type: 'task-strategy-implementation-provider-result',
      nodeSchema: 'workflow.task-strategy-implementation-provider-result.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        admission: roleResult.resultDigest,
        observation: observationNode.resultDigest,
        subject: reservation.subject.subjectDigest,
      },
      semanticParentResultDigests: {
        observation: observationNode.resultDigest,
      },
      provenanceParentNodeIds: { observation: observationNode.nodeId },
      outputSchema:
        'workflow.task-strategy-implementation-provider-result-output.v1',
      output: {
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        roleResult,
        output,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, resultNode);
    binding = createTaskStrategyImplementationResultBinding(runtime, {
      ownerInvestigationId: reservation.ownerInvestigationId,
      sessionId: reservation.sessionId,
      subjectDigest: reservation.subject.subjectDigest,
      invocationId: invocation.invocationId,
      requestDigest: reservation.request.requestDigest,
      outputDigest: invocation.result.outputDigest,
      runtimeObservationDigest: sha256(
        canonicalJson(invocation.result.runtimeObservation),
      ),
      providerObservationNodeId: observationNode.nodeId,
      providerObservationDigest: observationNode.resultDigest,
      providerResultNodeId: resultNode.nodeId,
      providerResultDigest: resultNode.resultDigest,
      roleResult,
      output,
      createdAt: invocation.updatedAt,
    });
    if (options.testCrashAfter === 'provider-result-persisted') {
      throw new Error(
        'Simulated task implementation interruption after provider result persistence.',
      );
    }
  }
  assertTaskStrategyImplementationProviderAuthorityCurrent(
    runtime,
    reservation,
    invocation,
    binding,
  );
  const imported = importTaskStrategyProviderPatchUnderLifecycleLock(
    cwd,
    context.session.sessionId,
    {
      patch: Buffer.from(binding.output.patchBase64, 'base64'),
      implementationResultBindingDigest: binding.bindingDigest,
      implementationSubjectDigest: reservation.subject.subjectDigest,
      ...(options.testCrashAfter === 'patch-applied' ||
      options.testCrashAfter === 'receipt-persisted'
        ? { testCrashAfter: options.testCrashAfter }
        : {}),
    },
    assertOwned,
  );
  if (options.testCrashAfter === 'provider-patch-imported') {
    throw new Error(
      'Simulated task implementation interruption after provider patch import.',
    );
  }
  publishProviderCorrectionRoundArtifacts(
    runtime,
    transaction,
    root,
    attempt,
    binding,
    imported,
  );
  assertOwned();
  return renderStatus(runtime, root, attempt);
}

function admitTaskStrategyImplementationProviderResult(input: {
  context: ReturnType<typeof loadActiveSessionContext>;
  reservation: TaskStrategyImplementationReservation;
  invocation: ReturnType<typeof readProviderInvocation> & {
    result: NonNullable<ReturnType<typeof readProviderInvocation>['result']>;
  };
  observationNode: ReturnType<typeof createEvidenceNode>;
  validation: BeginTaskStrategyImplementationOptions['collaborationGrant'];
  assertOwned: () => void;
}): AdmittedRoleResult {
  const assignment = input.reservation.assignment;
  const content = {
    kind: 'task-implementation' as const,
    nodeId: input.observationNode.nodeId,
    resultDigest: input.observationNode.resultDigest,
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluator: input.reservation.request.evaluatorVersion,
    policyDigest: input.reservation.request.policyDigest,
    contentDigest: input.observationNode.resultDigest,
    current: true as const,
  };
  let grantUse: CollaborationGrantUseProjection | null = null;
  let grantValidation: NonNullable<
    Parameters<typeof admitRoleResult>[0]['grantValidation']
  > | null = null;
  if ('grantId' in assignment) {
    if (
      input.validation !== undefined &&
      input.validation.grantId !== assignment.grantId
    ) {
      throw implementationResultStale();
    }
    const adapterPolicy = baselineAdapterPolicy(
      input.context.git.repositoryRoot,
      input.context.session.baseline.head,
    );
    const callableProviderIds = (['codex', 'claude'] as const).filter(
      (providerId) => adapterPolicy.policy.providers[providerId].enabled,
    );
    const grantCallableProviderIds =
      assignment.degradedForm === 'same-provider-fresh-session' &&
      assignment.providerId === input.reservation.redAuthor.providerId
        ? [assignment.providerId]
        : callableProviderIds;
    const grantRequest = implementationGrantRequest(
      input.context,
      input.reservation.subject,
      requireRecordedRedAuthor(input.reservation.redAuthor),
      grantCallableProviderIds,
    );
    if (grantRequest === null) throw implementationResultStale();
    const expectedBinding = deriveCollaborationGrantBinding(
      input.context.git.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'collaboration-role-transition',
        expectedBinding,
      }),
    );
    const maintainerPolicy = parseMaintainerPolicy(
      JSON.parse(
        runGit(input.context.git.repositoryRoot, [
          'show',
          `${expectedBinding.baselineCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    const verifier =
      input.validation?.verifier ??
      createInteractiveSshSigner(
        input.context.git.repositoryRoot,
        maintainerPolicy,
      );
    const now = input.validation?.now ?? new Date();
    const consumed = consumeCollaborationGrantUnderLifecycleLock(
      input.context.git.gitCommonDirectory,
      assignment.grantId,
      {
        transitionDigest,
        assignment,
        contentAdmission: {
          kind: content.kind,
          nodeId: content.nodeId,
          resultDigest: content.resultDigest,
          current: true,
        },
        now,
      },
      input.assertOwned,
    );
    if (consumed.use === undefined) throw implementationResultStale();
    grantUse = consumed.use;
    grantValidation = {
      now,
      expectedBinding,
      policy: maintainerPolicy,
      verifier,
      transitionDigest,
    };
  }
  return admitRoleResult({
    assignment,
    author: input.reservation.redAuthor,
    participant:
      'grantId' in assignment
        ? assignment.participant
        : {
            providerId: assignment.providerId,
            sessionId: assignment.sessionId,
            principalId: null,
            identityAssurance: 'adapter-assigned',
            engineSpawned: true,
          },
    content,
    providerInvocation: {
      invocationId: input.invocation.invocationId,
      requestDigest: input.reservation.request.requestDigest,
      outputDigest: input.invocation.result.outputDigest,
      providerId: input.reservation.request.providerId,
      sessionId: assignment.sessionId,
      targetDigest: input.reservation.subject.subjectDigest,
      engineSpawned: true,
    },
    grantUse,
    grantValidation,
  });
}

function requireRecordedRedAuthor(
  value: TaskStrategyImplementationReservation['redAuthor'],
): TaskStrategyRedAuthor {
  if (
    value.providerId === null ||
    value.sessionId === null ||
    value.principalId === null ||
    value.identityAssurance === 'maintainer-signed' ||
    value.engineSpawned !== false
  ) {
    throw implementationResultStale();
  }
  return Object.freeze({
    providerId: value.providerId,
    sessionId: value.sessionId,
    principalId: value.principalId,
    identityAssurance: value.identityAssurance,
    engineSpawned: false,
  });
}

function renderCallerImplementationStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyCallerImplementationReservation,
  binding: TaskStrategyCallerImplementationBinding | null,
): TaskStrategyImplementationStatus {
  const patchBinding = readTaskStrategyPatchCurrentBinding(
    runtime,
    reservation.sessionId,
    subject.sourceTree,
  );
  const imported =
    binding !== null &&
    patchBinding !== null &&
    patchBinding.patchDigest === binding.output.patchDigest &&
    patchBinding.candidateTree !== binding.output.sourceTree;
  return Object.freeze({
    state: imported
      ? ('patch-imported' as const)
      : ('caller-supplied-awaiting-import' as const),
    sessionId: reservation.sessionId,
    subject,
    assignment: reservation.assignment,
    ownerInvestigationId: null,
    invocationId: null,
    failure: null,
  });
}

function implementationResultStale() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
    'The provider result no longer matches its exact sealed RED subject, assignment, observation, or patch bytes.',
    ExitCode.staleState,
  );
}

function renderStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  root: TaskStrategyImplementationReservation,
  attempt: TaskStrategyImplementationProviderAttempt,
): TaskStrategyImplementationStatus {
  if (attempt.root.recordDigest !== root.recordDigest) {
    throw implementationResultStale();
  }
  const reservation = taskStrategyImplementationReservationForAttempt(attempt);
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  let state:
    | 'waiting-for-provider'
    | 'provider-succeeded-awaiting-import'
    | 'patch-imported'
    | 'provider-failed';
  if (invocation.state === 'succeeded' && invocation.result !== null) {
    const resultBinding = readTaskStrategyImplementationResultBinding(
      runtime,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    );
    const patchBinding = readTaskStrategyPatchCurrentBinding(
      runtime,
      reservation.sessionId,
      reservation.subject.sourceTree,
    );
    if (resultBinding !== null) {
      assertTaskStrategyImplementationProviderAuthorityCurrent(
        runtime,
        reservation,
        invocation,
        resultBinding,
      );
    }
    state =
      resultBinding !== null &&
      patchBinding !== null &&
      patchBinding.patchDigest === resultBinding.output.patchDigest &&
      patchBinding.candidateTree !== resultBinding.output.sourceTree
        ? 'patch-imported'
        : 'provider-succeeded-awaiting-import';
  } else {
    state =
      invocation.state === 'failed'
        ? 'provider-failed'
        : 'waiting-for-provider';
  }
  if (state === 'patch-imported') {
    return Object.freeze({
      state,
      sessionId: reservation.sessionId,
      subject: reservation.subject,
      assignment: reservation.assignment,
      ownerInvestigationId: reservation.ownerInvestigationId,
      invocationId: reservation.request.invocationId,
      failure: null,
    });
  }
  return Object.freeze({
    state,
    sessionId: reservation.sessionId,
    subject: reservation.subject,
    assignment: reservation.assignment,
    ownerInvestigationId: reservation.ownerInvestigationId,
    invocationId: reservation.request.invocationId,
    failure: invocation.failure,
  });
}

function requireCurrentRedTransaction(
  cwd: string,
  context: ReturnType<typeof loadActiveSessionContext>,
) {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const transaction = readTaskStrategyTransaction(
    runtime,
    context.session.sessionId,
  );
  if (transaction === null) {
    throw workflowError(
      'TASK_STRATEGY_RED_REQUIRED',
      'Task implementation requires an engine-sealed RED transaction.',
      ExitCode.guard,
    );
  }
  const inspection = inspectSession(cwd, context.session.sessionId, {
    expectedSession: context.session,
  });
  const preview = previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  );
  const redCandidateCurrent =
    transaction.red.candidateTree === preview.tree &&
    canonicalJson(transaction.red.changedPaths) ===
      canonicalJson(inspection.changedPaths);
  const currentPatchHead =
    resolveCurrentTaskStrategyCorrection(inspection).head;
  const recoverableCorrection = readRecoverableCorrectionCandidate(
    runtime,
    transaction,
    preview.tree,
  );
  const importedCandidateCurrent =
    currentPatchHead !== null &&
    currentPatchHead.record.candidateTree === preview.tree;
  if (
    transaction.changeId !== context.session.changeId ||
    transaction.taskId !== context.session.taskId ||
    transaction.baseline.head !== context.session.baseline.head ||
    transaction.baseline.tree !== context.session.baseline.tree ||
    (!redCandidateCurrent &&
      !importedCandidateCurrent &&
      !recoverableCorrection)
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_STALE',
      'The sealed RED transaction no longer matches the exact task candidate.',
      ExitCode.staleState,
    );
  }
  return transaction;
}

function readRecoverableCorrectionCandidate(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  currentTree: string,
): boolean {
  const rounds = listTaskStrategyCorrectionRounds(
    runtime,
    transaction.sessionId,
    transaction.recordDigest,
  );
  const latest = rounds.at(-1);
  if (latest === undefined || latest.importRecord !== null) {
    return false;
  }
  const binding =
    latest.reservation.authority.kind === 'provider'
      ? readTaskStrategyImplementationResultBinding(
          runtime,
          transaction.sessionId,
          latest.reservation.correctionSubjectDigest,
        )
      : latest.reservation.authority.kind === 'caller-supplied'
        ? readTaskStrategyCallerImplementationBinding(
            runtime,
            transaction.sessionId,
            latest.reservation.correctionSubjectDigest,
          )
        : null;
  if (binding === null) return false;
  const patchDigest = binding.output.patchDigest;
  const record = readTaskStrategyPatchRecord(
    runtime,
    transaction.sessionId,
    patchDigest,
    binding.output.sourceTree,
  );
  return record !== null && record.candidateTree === currentTree;
}

function implementationTask(
  cwd: string,
  context: ReturnType<typeof loadActiveSessionContext>,
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
) {
  const inspection = inspectSession(cwd, context.session.sessionId, {
    expectedSession: context.session,
  });
  const task = inspection.contract.execution?.tasks[context.session.taskId];
  if (
    task === undefined ||
    (task.strategy !== 'cross-agent-tdd' &&
      task.strategy !== 'tdd-single-agent') ||
    task.strategy !== transaction.strategy ||
    sha256(canonicalJson(task)) !== transaction.taskContractDigest
  ) {
    throw workflowError(
      'TASK_STRATEGY_CONTRACT_STALE',
      'The sealed RED transaction no longer matches its reviewed task contract.',
      ExitCode.staleState,
    );
  }
  return task;
}

function resolveCurrentImplementationSubject(
  cwd: string,
  context: ReturnType<typeof loadActiveSessionContext>,
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
): Readonly<{
  subject: TaskStrategyImplementationSubject;
  greenFailureRecord: TaskStrategyGreenFailureRecord | null;
}> {
  const initialSubject = createSubject(transaction);
  const inspection = inspectSession(cwd, context.session.sessionId, {
    expectedSession: context.session,
  });
  const projection = resolveCurrentTaskStrategyCorrection(inspection);
  if (projection.transaction.recordDigest !== transaction.recordDigest) {
    throw implementationResultStale();
  }
  if (projection.exhausted) {
    throw workflowError(
      'TASK_STRATEGY_CORRECTION_EXHAUSTED',
      'The bounded task-strategy correction budget is exhausted.',
      ExitCode.guard,
    );
  }
  const correction = resolveCorrectionSubjectInput(inspection, projection);
  if (correction === null) {
    return Object.freeze({
      subject: initialSubject,
      greenFailureRecord: null,
    });
  }
  return Object.freeze({
    subject: createTaskStrategyCorrectionSubject({
      subject: initialSubject,
      round: correction.round,
      greenFailureRecord: correction.greenFailureRecord,
    }),
    greenFailureRecord: correction.greenFailureRecord,
  });
}

function resolveCorrectionSubjectInput(
  inspection: ReturnType<typeof inspectSession>,
  projection: TaskStrategyCorrectionProjection,
): Readonly<{
  round: number;
  greenFailureRecord: TaskStrategyGreenFailureRecord;
}> | null {
  if (projection.failure !== null) {
    return Object.freeze({
      round: projection.completedCorrectionRounds + 1,
      greenFailureRecord: projection.failure,
    });
  }
  if (projection.completedCorrectionRounds === 0) return null;
  if (projection.head === null) throw implementationResultStale();
  const runtime = loadInvestigationRuntimeContext(
    inspection.git.repositoryRoot,
  ).runtime;
  const greenFailureRecord = readTaskStrategyGreenFailureRecord(
    runtime,
    inspection.session.sessionId,
    projection.head.record.sourceTree,
  );
  if (greenFailureRecord === null) throw implementationResultStale();
  return Object.freeze({
    round: projection.completedCorrectionRounds,
    greenFailureRecord,
  });
}

function createSubject(
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
): TaskStrategyImplementationSubject {
  return createTaskStrategyImplementationSubject({
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    taskContractDigest: transaction.taskContractDigest,
    sourceTree: transaction.red.candidateTree,
    failureFingerprint: transaction.red.failureFingerprint,
    redEvidenceNodeId: transaction.red.evidenceNodeId,
    redEvidenceResultDigest: transaction.red.evidenceResultDigest,
    testPaths: transaction.red.testPaths,
    fixturePaths: transaction.red.fixturePaths,
    frozenFiles: transaction.red.files,
  });
}

function recordRedAuthor(
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
): TaskStrategyRedAuthor {
  return Object.freeze({
    providerId: transaction.author.providerId,
    sessionId: transaction.sessionId,
    principalId: `provider:${transaction.author.providerId}`,
    identityAssurance: transaction.author.assurance,
    engineSpawned: false,
  });
}

function assertReservationCurrent(
  context: ReturnType<typeof loadActiveSessionContext>,
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyImplementationReservation,
): void {
  if (
    reservation.sessionId !== context.session.sessionId ||
    reservation.changeId !== context.session.changeId ||
    reservation.taskId !== context.session.taskId ||
    reservation.repositoryRoot !== context.git.repositoryRealPath ||
    reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
    reservation.branch !== context.session.branch ||
    canonicalJson(reservation.baseline) !==
      canonicalJson(context.session.baseline) ||
    canonicalJson(reservation.mandateBinding) !==
      canonicalJson(context.session.mandateBinding ?? null) ||
    canonicalJson(reservation.subject) !== canonicalJson(subject) ||
    reservation.createdAt !== transaction.createdAt
  ) {
    throw requestConflict();
  }
}

function implementationGrantRequest(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskStrategyImplementationSubject,
  redAuthor: TaskStrategyRedAuthor,
  callableProviderIds: readonly ProviderId[],
): CollaborationGrantRequest | null {
  const providerId = redAuthor.providerId;
  if (
    providerId === null ||
    (redAuthor.identityAssurance !== 'self-declared' &&
      redAuthor.identityAssurance !== 'runtime-hint' &&
      redAuthor.identityAssurance !== 'adapter-assigned') ||
    callableProviderIds.length !== 1 ||
    callableProviderIds[0] !== providerId
  ) {
    return null;
  }
  return {
    changeId: context.session.changeId,
    taskId: context.session.taskId,
    baselineCommit: context.session.baseline.head,
    baselineTree: context.session.baseline.tree,
    targetDigest: subject.subjectDigest,
    lifecyclePhase: 'task-implementation',
    rolePair: {
      authorRole: 'red-author',
      conflictingRole: 'task-implementer',
    },
    availableActor: {
      kind: 'provider',
      providerId,
      assurance: redAuthor.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason:
      'No provider-independent task implementer is enabled for this exact sealed RED subject.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function callerImplementationGrantRequest(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskStrategyImplementationSubject,
  callerId: string,
  assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned',
): CollaborationGrantRequest {
  return {
    changeId: context.session.changeId,
    taskId: context.session.taskId,
    baselineCommit: context.session.baseline.head,
    baselineTree: context.session.baseline.tree,
    targetDigest: subject.subjectDigest,
    lifecyclePhase: 'task-implementation',
    rolePair: {
      authorRole: 'red-author',
      conflictingRole: 'task-implementer',
    },
    availableActor: { kind: 'caller', callerId, assurance },
    degradedForm: 'caller-supplied',
    reason:
      'No callable task implementation provider is enabled for this exact sealed RED subject.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function collaborationPause(
  sessionId: string,
  subject: TaskStrategyImplementationSubject,
  grantRequest: CollaborationGrantRequest | null,
): TaskStrategyImplementationStatus {
  return Object.freeze({
    state: 'collaboration-grant-required' as const,
    sessionId,
    subject,
    inputSchema: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'collaboration-grant-selection' as const,
      lifecyclePhase: 'task-implementation' as const,
      conflictingRole: 'task-implementer' as const,
      grantRequest,
      allowedDegradedForms: Object.freeze(
        grantRequest === null
          ? (['caller-supplied'] as const)
          : (['same-provider-fresh-session'] as const),
      ),
      resumeOption: '--grant <grant-id>' as const,
    }),
  });
}

function deriveCollaborationGrantBinding(
  repositoryRoot: string,
  request: CollaborationGrantRequest,
): CollaborationGrantExpectedBinding {
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${request.baselineCommit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return {
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${request.baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
    collaborationPolicyDigest: collaborationPolicyDigestForPhase(
      request.lifecyclePhase,
    ),
    changeId: request.changeId,
    taskId: request.taskId,
    baselineCommit: request.baselineCommit,
    baselineTree: request.baselineTree,
    targetDigest: request.targetDigest,
    lifecyclePhase: request.lifecyclePhase,
    rolePair: request.rolePair,
    availableActor: request.availableActor,
    degradedForm: request.degradedForm,
    reason: request.reason,
  };
}

function collaborationTransitionDigest(
  expectedBinding: CollaborationGrantExpectedBinding,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'collaboration-role-transition',
      expectedBinding,
    }),
  );
}

function baselineAdapterPolicy(repositoryRoot: string, commit: string) {
  try {
    return parseAiAdapterPolicyDocument(
      runGit(repositoryRoot, [
        'show',
        `${commit}:workflow/ai-adapter-policy.json`,
      ]),
    );
  } catch (error) {
    throw workflowError(
      'TASK_STRATEGY_IMPLEMENTATION_BASELINE_POLICY_INVALID',
      'Task implementation could not verify its baseline adapter policy.',
      ExitCode.staleState,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function requestConflict() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT',
    'Task implementation provider work differs from its current sealed RED owner.',
    ExitCode.staleState,
  );
}

function providerRetryDenied(reasonCode: string, sessionId: string) {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_RETRY_DENIED',
    'The bounded provider RetryDecision does not authorize this exact task implementation replacement Attempt.',
    ExitCode.guard,
    {
      details: { reasonCode },
      recovery: `pnpm workflow resume ${sessionId} --json`,
    },
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Bytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
