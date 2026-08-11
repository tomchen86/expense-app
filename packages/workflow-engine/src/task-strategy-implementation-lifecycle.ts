import crypto from 'node:crypto';

import { parseAiAdapterPolicyDocument } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  collaborationPolicyDigestForPhase,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
} from './collaboration-grant.ts';
import { reserveCollaborationGrantUnderLifecycleLock } from './collaboration-grant-store.ts';
import { createEvidenceNode } from './evidence-node.ts';
import { writeEvidenceNode } from './evidence-object-store.ts';
import { ExitCode, workflowError } from './errors.ts';
import { previewExactStaging } from './git-transitions.ts';
import { runGit } from './git.ts';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import type { MaintainerSignerProvider } from './maintainer-signer.ts';
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
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
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
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
  type TaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
  createTaskStrategyImplementationReservation,
  readTaskStrategyImplementationReservation,
  type TaskStrategyImplementationReservation,
} from './task-strategy-provider-store.ts';
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
      return renderStatus(runtime, created);
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

function renderStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskStrategyImplementationReservation,
): TaskStrategyImplementationStatus {
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  const state =
    invocation.state === 'succeeded'
      ? 'provider-succeeded-awaiting-import'
      : invocation.state === 'failed'
        ? 'provider-failed'
        : 'waiting-for-provider';
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
  if (
    transaction.changeId !== context.session.changeId ||
    transaction.taskId !== context.session.taskId ||
    transaction.baseline.head !== context.session.baseline.head ||
    transaction.baseline.tree !== context.session.baseline.tree ||
    transaction.red.candidateTree !== preview.tree ||
    canonicalJson(transaction.red.changedPaths) !==
      canonicalJson(inspection.changedPaths)
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_STALE',
      'The sealed RED transaction no longer matches the exact task candidate.',
      ExitCode.staleState,
    );
  }
  return transaction;
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
