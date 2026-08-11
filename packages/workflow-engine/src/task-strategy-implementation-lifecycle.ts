import crypto from 'node:crypto';

import { parseAiAdapterPolicyDocument } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  collaborationPolicyDigestForPhase,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
} from './collaboration-grant.ts';
import {
  consumeCollaborationGrantUnderLifecycleLock,
  reserveCollaborationGrantUnderLifecycleLock,
  type CollaborationGrantUseProjection,
} from './collaboration-grant-store.ts';
import { createEvidenceNode } from './evidence-node.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from './evidence-object-store.ts';
import { ExitCode, workflowError } from './errors.ts';
import { previewExactStaging } from './git-transitions.ts';
import { runGit } from './git.ts';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import { createProviderInvocationRequest } from './provider-contracts.ts';
import {
  createProviderInvocation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
} from './provider-invocation-store.ts';
import type { ProviderId } from './provider-registry.ts';
import {
  admitRoleResult,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type AdmittedRoleResult,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RoleParticipant,
} from './role-scheduler.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from './session-store.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  assertTaskStrategyImplementationOutput,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
  type TaskStrategyImplementationOutput,
  type TaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
  createTaskStrategyImplementationResultBinding,
  createTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyImplementationReservation,
  type TaskStrategyImplementationResultBinding,
  type TaskStrategyImplementationReservation,
} from './task-strategy-provider-store.ts';
import {
  importTaskStrategyProviderPatchUnderLifecycleLock,
  validateTaskStrategyProviderPatch,
} from './task-strategy-patch.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchReservation,
} from './task-strategy-patch-store.ts';
import { readTaskStrategyTransaction } from './task-strategy-store.ts';
import {
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
  type TaskMandateBinding,
} from './task-mandate.ts';
import { inspectSession } from './verification.ts';

export type BeginTaskStrategyImplementationOptions = Readonly<{
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
  }>;
  testCrashAfter?: 'provider-result-persisted';
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
        | 'patch-imported'
        | 'provider-failed';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      failure: ReturnType<typeof readProviderInvocation>['failure'];
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
      const subject = createSubject(transaction);
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
      );
      const created =
        existing ??
        createImplementationReservation(
          context,
          runtime,
          transaction,
          subject,
          task,
          options.collaborationGrant,
          assertOwned,
        );
      if (!('recordDigest' in created)) return created;
      assertReservationCurrent(context, transaction, subject, created);
      ensureProviderInvocation(context, runtime, created, assertOwned);
      assertOwned();
      const status = renderStatus(runtime, created);
      return status.state === 'provider-succeeded-awaiting-import'
        ? reconcileProviderImplementationResult(
            cwd,
            context,
            runtime,
            transaction,
            created,
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
  const subject = createSubject(transaction);
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
  );
  if (reservation === null) {
    return Object.freeze({
      state: 'ready' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  assertReservationCurrent(context, transaction, subject, reservation);
  if (!providerInvocationExists(runtime, reservation.request.invocationId)) {
    return Object.freeze({
      state: 'reservation-persisted' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  return renderStatus(runtime, reservation);
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
  const subject = createSubject(transaction);
  const reservation = readTaskStrategyImplementationReservation(
    runtime,
    manifest.subject.sessionId,
  );
  if (reservation === null) throw requestConflict();
  assertReservationCurrent(context, transaction, subject, reservation);
  if (
    invocation.investigationId !== reservation.ownerInvestigationId ||
    canonicalJson(invocation.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding) ||
    canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
    canonicalJson(request) !== canonicalJson(reservation.request)
  ) {
    throw requestConflict();
  }
  return reservation;
}

function createImplementationReservation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  subject: TaskStrategyImplementationSubject,
  task: ReturnType<typeof implementationTask>,
  collaborationGrant:
    BeginTaskStrategyImplementationOptions['collaborationGrant'] | undefined,
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
      throw workflowError(
        'COLLABORATION_GRANT_FORM_REQUIRED',
        'Task implementation without a callable provider requires an explicitly submitted caller-supplied patch grant.',
        ExitCode.guard,
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

function ensureProviderInvocation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskStrategyImplementationReservation,
  assertOwned: () => void,
): void {
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
        retry: false,
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
      invocation.attempt !== 1 ||
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
    attempt: 1,
    manifest: reservation.manifest,
    request: reservation.request,
    createdAt: reservation.createdAt,
  });
  assertOwned();
}

function reconcileProviderImplementationResult(
  cwd: string,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  reservation: TaskStrategyImplementationReservation,
  options: BeginTaskStrategyImplementationOptions,
  assertOwned: () => void,
): TaskStrategyImplementationStatus {
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    return renderStatus(runtime, reservation);
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
    output.sourceTree !== transaction.red.candidateTree
  ) {
    throw implementationResultStale();
  }
  validateTaskStrategyProviderPatch(cwd, context.session.sessionId, {
    patch: Buffer.from(output.patchBase64, 'base64'),
    implementationReservationDigest: reservation.recordDigest,
  });

  let binding = readTaskStrategyImplementationResultBinding(
    runtime,
    context.session.sessionId,
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
  assertCurrentImplementationResultBinding(
    runtime,
    reservation,
    invocation,
    binding,
  );
  importTaskStrategyProviderPatchUnderLifecycleLock(
    cwd,
    context.session.sessionId,
    {
      patch: Buffer.from(binding.output.patchBase64, 'base64'),
      implementationResultBindingDigest: binding.bindingDigest,
    },
    assertOwned,
  );
  assertOwned();
  return renderStatus(runtime, reservation);
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
    const grantRequest = implementationGrantRequest(
      input.context,
      input.reservation.subject,
      requireRecordedRedAuthor(input.reservation.redAuthor),
      callableProviderIds,
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

function assertCurrentImplementationResultBinding(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskStrategyImplementationReservation,
  invocation: ReturnType<typeof readProviderInvocation>,
  binding: TaskStrategyImplementationResultBinding,
): void {
  if (
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    invocation.result.runtimeObservation === null
  ) {
    throw implementationResultStale();
  }
  const output = assertTaskStrategyImplementationOutput(
    invocation.result.output,
  );
  const authorization = readEvidenceNode(
    runtime,
    reservation.authorizationNodeId,
  );
  const requestReservation = readEvidenceNode(
    runtime,
    reservation.reservationNodeId,
  );
  const observationNode = readEvidenceNode(
    runtime,
    binding.providerObservationNodeId,
  );
  const resultNode = readEvidenceNode(runtime, binding.providerResultNodeId);
  const { resultDigest, ...roleResultBody } = binding.roleResult;
  if (
    binding.ownerInvestigationId !== reservation.ownerInvestigationId ||
    binding.sessionId !== reservation.sessionId ||
    binding.subjectDigest !== reservation.subject.subjectDigest ||
    binding.invocationId !== invocation.invocationId ||
    binding.requestDigest !== reservation.request.requestDigest ||
    binding.outputDigest !== invocation.result.outputDigest ||
    binding.runtimeObservationDigest !==
      sha256(canonicalJson(invocation.result.runtimeObservation)) ||
    canonicalJson(binding.output) !== canonicalJson(output) ||
    canonicalJson(binding.roleResult.assignment) !==
      canonicalJson(reservation.assignment) ||
    canonicalJson(binding.roleResult.author) !==
      canonicalJson(reservation.redAuthor) ||
    resultDigest !==
      sha256(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...roleResultBody,
        }),
      ) ||
    observationNode.resultDigest !== binding.providerObservationDigest ||
    observationNode.type !==
      'task-strategy-implementation-provider-observation' ||
    observationNode.nodeSchema !==
      'workflow.task-strategy-implementation-provider-observation.v1' ||
    observationNode.evaluator !== 'workflow-task-strategy.v1' ||
    observationNode.policyDigest !==
      TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    observationNode.outputSchema !==
      'workflow.task-strategy-implementation-provider-observation-output.v1' ||
    canonicalJson(observationNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        requestDigest: reservation.request.requestDigest,
        outputDigest: invocation.result.outputDigest,
        submission: output,
      }) ||
    observationNode.exactInputDigests.output !==
      invocation.result.outputDigest ||
    observationNode.exactInputDigests.request !==
      reservation.request.requestDigest ||
    observationNode.exactInputDigests.runtimeObservation !==
      binding.runtimeObservationDigest ||
    observationNode.exactInputDigests.subject !==
      reservation.subject.subjectDigest ||
    observationNode.semanticParentResultDigests.authorization !==
      authorization.resultDigest ||
    observationNode.semanticParentResultDigests.reservation !==
      requestReservation.resultDigest ||
    observationNode.provenanceParentNodeIds.authorization !==
      reservation.authorizationNodeId ||
    observationNode.provenanceParentNodeIds.reservation !==
      reservation.reservationNodeId ||
    canonicalJson(observationNode.runtimeMetadata) !==
      canonicalJson({
        runtimeObservation: invocation.result.runtimeObservation,
      }) ||
    resultNode.resultDigest !== binding.providerResultDigest ||
    resultNode.type !== 'task-strategy-implementation-provider-result' ||
    resultNode.nodeSchema !==
      'workflow.task-strategy-implementation-provider-result.v1' ||
    resultNode.evaluator !== 'workflow-task-strategy.v1' ||
    resultNode.policyDigest !== TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    resultNode.outputSchema !==
      'workflow.task-strategy-implementation-provider-result-output.v1' ||
    canonicalJson(resultNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        roleResult: binding.roleResult,
        output,
      }) ||
    resultNode.exactInputDigests.admission !==
      binding.roleResult.resultDigest ||
    resultNode.exactInputDigests.observation !== observationNode.resultDigest ||
    resultNode.exactInputDigests.subject !==
      reservation.subject.subjectDigest ||
    resultNode.semanticParentResultDigests.observation !==
      observationNode.resultDigest ||
    resultNode.provenanceParentNodeIds.observation !== observationNode.nodeId
  ) {
    throw implementationResultStale();
  }
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
  reservation: TaskStrategyImplementationReservation,
): TaskStrategyImplementationStatus {
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
    );
    const patchBinding = readTaskStrategyPatchCurrentBinding(
      runtime,
      reservation.sessionId,
    );
    if (resultBinding !== null) {
      assertCurrentImplementationResultBinding(
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
  if (
    transaction.changeId !== context.session.changeId ||
    transaction.taskId !== context.session.taskId ||
    transaction.baseline.head !== context.session.baseline.head ||
    transaction.baseline.tree !== context.session.baseline.tree ||
    (!redCandidateCurrent &&
      !isImportedImplementationCandidateCurrent(
        runtime,
        context.session.sessionId,
        transaction.red.candidateTree,
        preview.tree,
      ))
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_STALE',
      'The sealed RED transaction no longer matches the exact task candidate.',
      ExitCode.staleState,
    );
  }
  return transaction;
}

function isImportedImplementationCandidateCurrent(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  sessionId: string,
  redCandidateTree: string,
  currentTree: string,
): boolean {
  const binding = readTaskStrategyPatchCurrentBinding(runtime, sessionId);
  if (binding === null) return false;
  const record = readTaskStrategyPatchRecord(
    runtime,
    sessionId,
    binding.patchDigest,
  );
  const receipt = readTaskStrategyPatchImportReceipt(
    runtime,
    sessionId,
    binding.patchDigest,
  );
  const reservation = readTaskStrategyPatchReservation(runtime, sessionId);
  return (
    record !== null &&
    receipt !== null &&
    reservation !== null &&
    record.sourceTree === redCandidateTree &&
    record.candidateTree === currentTree &&
    reservation.sessionId === sessionId &&
    reservation.patchDigest === record.patchDigest &&
    reservation.recordDigest === record.recordDigest &&
    reservation.sourceTree === record.sourceTree &&
    reservation.candidateTree === record.candidateTree &&
    reservation.createdAt === record.createdAt &&
    receipt.recordDigest === record.recordDigest &&
    receipt.sessionId === sessionId &&
    receipt.patchDigest === record.patchDigest &&
    receipt.candidateTree === record.candidateTree &&
    binding.sessionId === sessionId &&
    binding.recordDigest === record.recordDigest &&
    binding.receiptDigest === receipt.receiptDigest &&
    binding.candidateTree === currentTree &&
    binding.createdAt === receipt.importedAt
  );
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
