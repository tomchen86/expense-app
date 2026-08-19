import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from '../../modules/authority/collaboration-grant.ts';
import {
  readEvidenceNode,
  resolveTaskStrategyImplementationInvocationOwner,
} from './evidence-object-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import {
  assertInvestigationId,
  assertInvocationId,
  assertSessionId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';
import {
  isProviderRoleAssignment,
  recreateProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  providerInvocationManifestDigest,
  providerInvocationExists,
  readProviderInvocation,
  readProviderInvocationEvidence,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  type ProviderInvocationRecord,
  type ProviderRetryDecisionBinding,
  type ProviderRetryReservationV2,
  type ProviderRetryReservationV3,
} from './provider-invocation-store.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  assertTaskStrategyImplementationManifest,
  assertTaskStrategyImplementationOutput,
  assertTaskStrategyImplementationSubject,
  type TaskStrategyImplementationManifest,
  type TaskStrategyImplementationOutput,
  type TaskStrategyImplementationSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  type AdmittedRoleResult,
  type GrantedRoleAssignment,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import type { TaskStrategyTransaction } from './task-strategy-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;

export type TaskStrategyImplementationReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-reservation.v1';
  recordDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding | null;
  subject: TaskStrategyImplementationSubject;
  redAuthor: RecordedRoleParticipant;
  assignment: ProviderRoleAssignment;
  manifest: TaskStrategyImplementationManifest;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  createdAt: string;
}>;

export type TaskStrategyImplementationProviderAttempt = Readonly<{
  root: TaskStrategyImplementationReservation;
  attempt: number;
  previousInvocationId: string | null;
  assignment: ProviderRoleAssignment;
  manifestDigest: string;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  retryDecision: ProviderRetryDecisionBinding | null;
  retryReservation:
    ProviderRetryReservationV2 | ProviderRetryReservationV3 | null;
  createdAt: string;
}>;

export type TaskStrategyImplementationResultBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-result-binding.v1';
  bindingDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  subjectDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  runtimeObservationDigest: string;
  providerObservationNodeId: string;
  providerObservationDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
  roleResult: AdmittedRoleResult;
  output: TaskStrategyImplementationOutput;
  createdAt: string;
}>;

export type TaskStrategyCallerImplementationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-caller-implementation-binding.v1';
  bindingDigest: string;
  sessionId: string;
  subjectDigest: string;
  transitionDigest: string;
  submissionNodeId: string;
  submissionResultDigest: string;
  resultNodeId: string;
  resultDigest: string;
  roleResult: AdmittedRoleResult;
  output: TaskStrategyImplementationOutput;
  createdAt: string;
}>;

export type TaskStrategyCallerImplementationReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-caller-implementation-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  subjectDigest: string;
  grantId: string;
  transitionDigest: string;
  assignment: GrantedRoleAssignment;
  submissionNodeId: string;
  submissionResultDigest: string;
  output: TaskStrategyImplementationOutput;
  createdAt: string;
}>;

/**
 * Replay the complete durable provider-result authority chain. Both the live
 * implementation lifecycle and correction projection use this one predicate
 * so a persisted binding cannot become authoritative merely by being copied
 * into a later round record.
 */
export function assertTaskStrategyImplementationProviderAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  reservation: TaskStrategyImplementationReservation,
  invocation: ProviderInvocationRecord,
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
    paths,
    reservation.authorizationNodeId,
  );
  const requestReservation = readEvidenceNode(
    paths,
    reservation.reservationNodeId,
  );
  const observationNode = readEvidenceNode(
    paths,
    binding.providerObservationNodeId,
  );
  const resultNode = readEvidenceNode(paths, binding.providerResultNodeId);
  const { resultDigest, ...roleResultBody } = binding.roleResult;
  if (
    invocation.investigationId !== reservation.ownerInvestigationId ||
    invocation.changeId !== reservation.changeId ||
    invocation.invocationId !== reservation.request.invocationId ||
    invocation.requestDigest !== reservation.request.requestDigest ||
    invocation.manifestDigest !== reservation.request.inputManifestDigest ||
    invocation.providerId !== reservation.request.providerId ||
    invocation.purpose !== reservation.request.purpose ||
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

export function assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  transaction: TaskStrategyTransaction,
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyCallerImplementationReservation,
): void {
  const submissionNode = readEvidenceNode(paths, reservation.submissionNodeId);
  const caller = {
    callerId: reservation.assignment.participant.principalId,
    assurance: reservation.assignment.participant.identityAssurance,
  };
  if (
    reservation.sessionId !== transaction.sessionId ||
    reservation.subjectDigest !== subject.subjectDigest ||
    reservation.assignment.role !== 'task-implementer' ||
    reservation.assignment.targetDigest !== subject.subjectDigest ||
    reservation.assignment.providerId !== null ||
    reservation.assignment.sessionId !== null ||
    reservation.assignment.degradedForm !== 'caller-supplied' ||
    reservation.assignment.orchestration !== 'caller-supplied' ||
    reservation.assignment.participant.providerId !== null ||
    reservation.assignment.participant.sessionId !== null ||
    reservation.assignment.participant.principalId === null ||
    reservation.assignment.participant.identityAssurance ===
      'maintainer-signed' ||
    reservation.assignment.participant.engineSpawned !== false ||
    canonicalJson(reservation.assignment.author) !==
      canonicalJson(taskStrategyRecordedRedAuthor(transaction)) ||
    reservation.output.sessionId !== transaction.sessionId ||
    reservation.output.sourceTree !== subject.sourceTree ||
    submissionNode.resultDigest !== reservation.submissionResultDigest ||
    submissionNode.type !== 'task-strategy-implementation-caller-submission' ||
    submissionNode.nodeSchema !==
      'workflow.task-strategy-implementation-caller-submission.v1' ||
    submissionNode.evaluator !== 'workflow-task-strategy.v1' ||
    submissionNode.policyDigest !==
      TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    submissionNode.outputSchema !==
      'workflow.task-strategy-implementation-caller-submission-output.v1' ||
    submissionNode.exactInputDigests.assignment !==
      sha256(canonicalJson(reservation.assignment)) ||
    submissionNode.exactInputDigests.caller !== sha256(canonicalJson(caller)) ||
    submissionNode.exactInputDigests.output !==
      sha256(canonicalJson(reservation.output)) ||
    submissionNode.exactInputDigests.subject !== subject.subjectDigest ||
    submissionNode.exactInputDigests.transition !==
      reservation.transitionDigest ||
    submissionNode.semanticParentResultDigests.red !==
      transaction.red.evidenceResultDigest ||
    submissionNode.provenanceParentNodeIds.red !==
      transaction.red.evidenceNodeId ||
    canonicalJson(submissionNode.output) !==
      canonicalJson({
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subjectDigest,
        transitionDigest: reservation.transitionDigest,
        caller,
        assignment: reservation.assignment,
        output: reservation.output,
      }) ||
    canonicalJson(submissionNode.runtimeMetadata) !== canonicalJson({})
  ) {
    throw implementationResultStale();
  }
}

export function assertTaskStrategyCallerImplementationAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  transaction: TaskStrategyTransaction,
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyCallerImplementationReservation,
  binding: TaskStrategyCallerImplementationBinding,
): void {
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
    paths,
    transaction,
    subject,
    reservation,
  );
  const submissionNode = readEvidenceNode(paths, reservation.submissionNodeId);
  const resultNode = readEvidenceNode(paths, binding.resultNodeId);
  if (
    binding.sessionId !== reservation.sessionId ||
    binding.subjectDigest !== reservation.subjectDigest ||
    binding.transitionDigest !== reservation.transitionDigest ||
    binding.submissionNodeId !== reservation.submissionNodeId ||
    binding.submissionResultDigest !== reservation.submissionResultDigest ||
    canonicalJson(binding.output) !== canonicalJson(reservation.output) ||
    canonicalJson(binding.roleResult.assignment) !==
      canonicalJson(reservation.assignment) ||
    canonicalJson(binding.roleResult.author) !==
      canonicalJson(reservation.assignment.author) ||
    canonicalJson(binding.roleResult.participant) !==
      canonicalJson(reservation.assignment.participant) ||
    binding.roleResult.content.nodeId !== submissionNode.nodeId ||
    binding.roleResult.content.resultDigest !== submissionNode.resultDigest ||
    resultNode.resultDigest !== binding.resultDigest ||
    resultNode.type !== 'task-strategy-implementation-caller-result' ||
    resultNode.nodeSchema !==
      'workflow.task-strategy-implementation-caller-result.v1' ||
    resultNode.evaluator !== 'workflow-task-strategy.v1' ||
    resultNode.policyDigest !== TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    resultNode.outputSchema !==
      'workflow.task-strategy-implementation-caller-result-output.v1' ||
    resultNode.exactInputDigests.admission !==
      binding.roleResult.resultDigest ||
    resultNode.exactInputDigests.submission !==
      reservation.submissionResultDigest ||
    resultNode.exactInputDigests.subject !== subject.subjectDigest ||
    resultNode.exactInputDigests.transition !== reservation.transitionDigest ||
    resultNode.semanticParentResultDigests.submission !==
      reservation.submissionResultDigest ||
    resultNode.provenanceParentNodeIds.submission !==
      reservation.submissionNodeId ||
    canonicalJson(resultNode.output) !==
      canonicalJson({
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subjectDigest,
        roleResult: binding.roleResult,
        output: reservation.output,
      }) ||
    canonicalJson(resultNode.runtimeMetadata) !== canonicalJson({})
  ) {
    throw implementationResultStale();
  }
}

export function createTaskStrategyImplementationReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyImplementationReservation,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): TaskStrategyImplementationReservation {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-implementation-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskStrategyImplementationReservation({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    reservationPath(paths, reservation.sessionId),
    subjectReservationPath(
      paths,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    ),
    reservation,
    parseTaskStrategyImplementationReservation,
    (value) => value.subject.subjectDigest,
    reservation.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_IMPLEMENTATION_RESERVATION_CONFLICT',
  );
}

export function readTaskStrategyImplementationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest?: string,
): TaskStrategyImplementationReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    reservationPath(paths, sessionId),
    expectedSubjectDigest,
    (subjectDigest) => subjectReservationPath(paths, sessionId, subjectDigest),
    parseTaskStrategyImplementationReservation,
    (value) => value.subject.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

export function readTaskStrategyImplementationProviderAttempt(
  paths: InvestigationRuntimePaths,
  root: TaskStrategyImplementationReservation,
  requestedInvocationId: string,
): TaskStrategyImplementationProviderAttempt {
  const invocationId = assertInvocationId(requestedInvocationId);
  if (invocationId === root.request.invocationId) {
    return rootProviderAttempt(root);
  }
  const invocation = readProviderInvocation(paths, invocationId);
  const retry = readProviderRetryReservation(
    paths,
    root.ownerInvestigationId,
    invocation.attempt,
  );
  if (
    retry === null ||
    (retry.schemaVersion !== 2 && retry.schemaVersion !== 3)
  ) {
    throw stateCorrupt();
  }
  return retryProviderAttempt(paths, root, retry);
}

export function readCurrentTaskStrategyImplementationProviderAttempt(
  paths: InvestigationRuntimePaths,
  root: TaskStrategyImplementationReservation,
): TaskStrategyImplementationProviderAttempt {
  let current = rootProviderAttempt(root);
  if (!providerInvocationExists(paths, current.request.invocationId)) {
    return current;
  }
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current.request.invocationId)) throw stateCorrupt();
    visited.add(current.request.invocationId);
    const evidence = readProviderInvocationEvidence(
      paths,
      current.request.invocationId,
    );
    const successor = evidence.supersededBy?.invocation.invocationId ?? null;
    if (successor === null) {
      const reserved = readProviderRetryReservation(
        paths,
        root.ownerInvestigationId,
        current.attempt + 1,
      );
      return reserved === null
        ? current
        : retryProviderAttempt(
            paths,
            root,
            requireRetryReservationV2(reserved),
          );
    }
    current = readTaskStrategyImplementationProviderAttempt(
      paths,
      root,
      successor,
    );
  }
}

export function taskStrategyImplementationReservationForAttempt(
  attempt: TaskStrategyImplementationProviderAttempt,
): TaskStrategyImplementationReservation {
  return deepFreeze({
    ...attempt.root,
    assignment: attempt.assignment,
    request: attempt.request,
    authorizationNodeId: attempt.authorizationNodeId,
    reservationNodeId: attempt.reservationNodeId,
    createdAt: attempt.createdAt,
  });
}

export function taskStrategyImplementationProviderAttemptReservationDigest(
  attempt: TaskStrategyImplementationProviderAttempt,
): string {
  return attempt.retryReservation === null
    ? attempt.root.recordDigest
    : sha256(canonicalJson(attempt.retryReservation));
}

function rootProviderAttempt(
  root: TaskStrategyImplementationReservation,
): TaskStrategyImplementationProviderAttempt {
  return deepFreeze({
    root,
    attempt: 1,
    previousInvocationId: null,
    assignment: root.assignment,
    manifestDigest: providerInvocationManifestDigest(root.manifest),
    request: root.request,
    authorizationNodeId: root.authorizationNodeId,
    reservationNodeId: root.reservationNodeId,
    retryDecision: null,
    retryReservation: null,
    createdAt: root.createdAt,
  });
}

function retryProviderAttempt(
  paths: InvestigationRuntimePaths,
  root: TaskStrategyImplementationReservation,
  retry: ProviderRetryReservationV2 | ProviderRetryReservationV3,
): TaskStrategyImplementationProviderAttempt {
  const previous = readProviderInvocation(paths, retry.previousInvocationId);
  const previousRequest = readProviderInvocationRequest(
    paths,
    previous.invocationId,
  );
  const retryAuthority =
    retry.schemaVersion === 3
      ? resolveTaskStrategyImplementationInvocationOwner(paths, {
          changeId: root.changeId,
          sessionId: root.sessionId,
          subject: root.subject,
          assignment: retry.request.roleAssignment,
          authorizationNodeId: retry.replacement.authorizationNodeId,
        })
      : null;
  const replacement = retry.schemaVersion === 3 ? retry.replacement : null;
  const requestReservation =
    replacement !== null
      ? readEvidenceNode(paths, replacement.reservationNodeId)
      : null;
  if (
    retry.investigationId !== root.ownerInvestigationId ||
    retry.changeId !== root.changeId ||
    canonicalJson(retry.mandateBinding ?? null) !==
      canonicalJson(root.mandateBinding) ||
    retry.manifestDigest !== providerInvocationManifestDigest(root.manifest) ||
    retry.request.inputManifestDigest !== retry.manifestDigest ||
    retry.request.targetDigest !== root.subject.subjectDigest ||
    retry.request.authorizationNodeId !==
      (retry.schemaVersion === 3
        ? retry.replacement.authorizationNodeId
        : root.authorizationNodeId) ||
    retry.request.invocationId !== retry.invocationId ||
    retry.request.requestDigest !== retry.requestDigest ||
    (retry.schemaVersion === 2 &&
      canonicalJson(retry.request.roleAssignment) !==
        canonicalJson(root.assignment)) ||
    (retryAuthority !== null &&
      (retryAuthority.ownerInvestigationId !== root.ownerInvestigationId ||
        retryAuthority.sessionId !== root.sessionId ||
        canonicalJson(retryAuthority.mandateBinding) !==
          canonicalJson(root.mandateBinding))) ||
    (requestReservation !== null &&
      (requestReservation.type !==
        'task-strategy-implementation-request-reservation' ||
        requestReservation.nodeSchema !==
          'workflow.task-strategy-implementation-reservation.v1' ||
        requestReservation.evaluator !== 'workflow-task-strategy.v1' ||
        requestReservation.policyDigest !==
          TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
        requestReservation.exactInputDigests.request !==
          retry.request.requestDigest ||
        requestReservation.exactInputDigests.manifest !==
          retry.manifestDigest ||
        requestReservation.exactInputDigests.subject !==
          root.subject.subjectDigest ||
        requestReservation.provenanceParentNodeIds.authorization !==
          replacement?.authorizationNodeId ||
        canonicalJson(
          (requestReservation.output as { request?: unknown }).request,
        ) !== canonicalJson(retry.request))) ||
    previous.investigationId !== root.ownerInvestigationId ||
    previous.changeId !== root.changeId ||
    previous.attempt !== retry.attempt - 1 ||
    previous.state !== 'failed' ||
    previous.failure === null ||
    previousRequest.invocationId === retry.request.invocationId ||
    previousRequest.nonce === retry.request.nonce
  ) {
    throw stateCorrupt();
  }
  return deepFreeze({
    root,
    attempt: retry.attempt,
    previousInvocationId: retry.previousInvocationId,
    assignment: retry.request.roleAssignment,
    manifestDigest: retry.manifestDigest,
    request: retry.request,
    authorizationNodeId: retry.request.authorizationNodeId,
    reservationNodeId:
      replacement !== null
        ? replacement.reservationNodeId
        : root.reservationNodeId,
    retryDecision: retry.retryDecision,
    retryReservation: retry,
    createdAt: retry.createdAt,
  });
}

function requireRetryReservationV2(
  value: ReturnType<typeof readProviderRetryReservation>,
): ProviderRetryReservationV2 | ProviderRetryReservationV3 {
  if (
    value === null ||
    (value.schemaVersion !== 2 && value.schemaVersion !== 3)
  ) {
    throw stateCorrupt();
  }
  return value;
}

export function createTaskStrategyImplementationResultBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyImplementationResultBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskStrategyImplementationResultBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-implementation-result-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskStrategyImplementationResultBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    resultPath(paths, binding.sessionId),
    subjectResultPath(paths, binding.sessionId, binding.subjectDigest),
    binding,
    parseTaskStrategyImplementationResultBinding,
    (value) => value.subjectDigest,
    binding.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_CONFLICT',
  );
}

export function readTaskStrategyImplementationResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest?: string,
): TaskStrategyImplementationResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    resultPath(paths, sessionId),
    expectedSubjectDigest,
    (subjectDigest) => subjectResultPath(paths, sessionId, subjectDigest),
    parseTaskStrategyImplementationResultBinding,
    (value) => value.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

export function createTaskStrategyCallerImplementationBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyCallerImplementationBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskStrategyCallerImplementationBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-caller-implementation-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskStrategyCallerImplementationBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    callerResultPath(paths, binding.sessionId),
    subjectCallerResultPath(paths, binding.sessionId, binding.subjectDigest),
    binding,
    parseTaskStrategyCallerImplementationBinding,
    (value) => value.subjectDigest,
    binding.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_CALLER_IMPLEMENTATION_CONFLICT',
  );
}

export function readTaskStrategyCallerImplementationBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest?: string,
): TaskStrategyCallerImplementationBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    callerResultPath(paths, sessionId),
    expectedSubjectDigest,
    (subjectDigest) => subjectCallerResultPath(paths, sessionId, subjectDigest),
    parseTaskStrategyCallerImplementationBinding,
    (value) => value.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

export function createTaskStrategyCallerImplementationReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyCallerImplementationReservation,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskStrategyCallerImplementationReservation {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-caller-implementation-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskStrategyCallerImplementationReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    callerReservationPath(paths, reservation.sessionId),
    subjectCallerReservationPath(
      paths,
      reservation.sessionId,
      reservation.subjectDigest,
    ),
    reservation,
    parseTaskStrategyCallerImplementationReservation,
    (value) => value.subjectDigest,
    reservation.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_CALLER_IMPLEMENTATION_RESERVATION_CONFLICT',
  );
}

export function readTaskStrategyCallerImplementationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest?: string,
): TaskStrategyCallerImplementationReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    callerReservationPath(paths, sessionId),
    expectedSubjectDigest,
    (subjectDigest) =>
      subjectCallerReservationPath(paths, sessionId, subjectDigest),
    parseTaskStrategyCallerImplementationReservation,
    (value) => value.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

function reservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-implementations',
    sessionId,
    'reservation.json',
  );
}

function resultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-implementations',
    sessionId,
    'result.json',
  );
}

function callerResultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-implementations',
    sessionId,
    'caller-result.json',
  );
}

function callerReservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-implementations',
    sessionId,
    'caller-reservation.json',
  );
}

function subjectReservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(paths, sessionId, subjectDigest, 'reservation.json');
}

function subjectResultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(paths, sessionId, subjectDigest, 'result.json');
}

function subjectCallerResultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(
    paths,
    sessionId,
    subjectDigest,
    'caller-result.json',
  );
}

function subjectCallerReservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(
    paths,
    sessionId,
    subjectDigest,
    'caller-reservation.json',
  );
}

function subjectScopedPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
  filename: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-implementations',
    sessionId,
    'subjects',
    assertDigest(subjectDigest),
    filename,
  );
}

function createSubjectScopedRecord<T>(
  paths: InvestigationRuntimePaths,
  legacyPath: string,
  scopedPath: string,
  value: T,
  parse: (value: unknown) => T,
  subjectDigestOf: (value: T) => string,
  expectedSessionId: string,
  sessionIdOf: (value: T) => string,
  collisionCode: string,
): T {
  const legacy = readRecordAt(paths, legacyPath, parse);
  if (legacy !== null && sessionIdOf(legacy) !== expectedSessionId) {
    throw stateCorrupt();
  }
  const expectedSubjectDigest = assertDigest(subjectDigestOf(value));
  const target =
    legacy === null || subjectDigestOf(legacy) === expectedSubjectDigest
      ? legacyPath
      : scopedPath;
  createPrivateCanonicalJson(paths, target, value, stateCorrupt, collisionCode);
  const stored = readRecordAt(paths, target, parse);
  if (
    stored === null ||
    sessionIdOf(stored) !== expectedSessionId ||
    subjectDigestOf(stored) !== expectedSubjectDigest
  ) {
    throw stateCorrupt();
  }
  return stored;
}

function readSubjectScopedRecord<T>(
  paths: InvestigationRuntimePaths,
  legacyPath: string,
  requestedSubjectDigest: string | undefined,
  scopedPath: (subjectDigest: string) => string,
  parse: (value: unknown) => T,
  subjectDigestOf: (value: T) => string,
  expectedSessionId: string,
  sessionIdOf: (value: T) => string,
): T | null {
  const legacy = readRecordAt(paths, legacyPath, parse);
  if (legacy !== null && sessionIdOf(legacy) !== expectedSessionId) {
    throw stateCorrupt();
  }
  if (requestedSubjectDigest === undefined) return legacy;
  const expectedSubjectDigest = assertDigest(requestedSubjectDigest);
  if (legacy !== null && subjectDigestOf(legacy) === expectedSubjectDigest) {
    return legacy;
  }
  const scoped = readRecordAt(paths, scopedPath(expectedSubjectDigest), parse);
  if (
    scoped !== null &&
    (sessionIdOf(scoped) !== expectedSessionId ||
      subjectDigestOf(scoped) !== expectedSubjectDigest)
  ) {
    throw stateCorrupt();
  }
  return scoped;
}

function readRecordAt<T>(
  paths: InvestigationRuntimePaths,
  target: string,
  parse: (value: unknown) => T,
): T | null {
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  return parse(readPrivateCanonicalJson(paths, target, stateCorrupt));
}

function parseTaskStrategyImplementationReservation(
  value: unknown,
): TaskStrategyImplementationReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'ownerInvestigationId',
      'sessionId',
      'changeId',
      'taskId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'mandateBinding',
      'subject',
      'redAuthor',
      'assignment',
      'manifest',
      'request',
      'authorizationNodeId',
      'reservationNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-implementation-reservation.v1' ||
    !isDigest(value.recordDigest) ||
    !isInvestigationId(value.ownerInvestigationId) ||
    !isSessionId(value.sessionId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    typeof value.gitCommonDirectory !== 'string' ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    typeof value.branch !== 'string' ||
    value.branch.length === 0 ||
    !isBaseline(value.baseline) ||
    !isMandateBinding(value.mandateBinding, value.changeId) ||
    !isRecordedParticipant(value.redAuthor) ||
    !isProviderRoleAssignment(value.assignment) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let subject: TaskStrategyImplementationSubject;
  let manifest: TaskStrategyImplementationManifest;
  let request: ProviderInvocationRequest;
  try {
    subject = assertTaskStrategyImplementationSubject(value.subject);
    manifest = assertTaskStrategyImplementationManifest(value.manifest);
    request = recreateProviderInvocationRequest(value.request);
  } catch {
    throw stateCorrupt();
  }
  if (
    subject.sessionId !== value.sessionId ||
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    manifest.subject.subjectDigest !== subject.subjectDigest ||
    manifest.baseCommit !== value.baseline.head ||
    manifest.baseTree !== value.baseline.tree ||
    request.authorizationNodeId !== value.authorizationNodeId ||
    request.targetDigest !== subject.subjectDigest ||
    canonicalJson(request.roleAssignment) !== canonicalJson(value.assignment)
  ) {
    throw stateCorrupt();
  }
  const { recordDigest, ...body } = value;
  if (recordDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return deepFreeze(
    structuredClone(value),
  ) as TaskStrategyImplementationReservation;
}

function parseTaskStrategyImplementationResultBinding(
  value: unknown,
): TaskStrategyImplementationResultBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'ownerInvestigationId',
      'sessionId',
      'subjectDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'runtimeObservationDigest',
      'providerObservationNodeId',
      'providerObservationDigest',
      'providerResultNodeId',
      'providerResultDigest',
      'roleResult',
      'output',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-implementation-result-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    !isInvestigationId(value.ownerInvestigationId) ||
    !isSessionId(value.sessionId) ||
    !isDigest(value.subjectDigest) ||
    !isInvocationId(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.runtimeObservationDigest) ||
    !isDigest(value.providerObservationNodeId) ||
    !isDigest(value.providerObservationDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest) ||
    !isAdmittedImplementationRoleResult(value.roleResult) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let output: TaskStrategyImplementationOutput;
  try {
    output = assertTaskStrategyImplementationOutput(value.output);
  } catch {
    throw stateCorrupt();
  }
  const binding: TaskStrategyImplementationResultBinding = {
    schemaVersion: 1,
    kind: 'task-strategy-implementation-result-binding.v1',
    bindingDigest: value.bindingDigest,
    ownerInvestigationId: value.ownerInvestigationId,
    sessionId: value.sessionId,
    subjectDigest: value.subjectDigest,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    runtimeObservationDigest: value.runtimeObservationDigest,
    providerObservationNodeId: value.providerObservationNodeId,
    providerObservationDigest: value.providerObservationDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
    roleResult: structuredClone(value.roleResult),
    output,
    createdAt: value.createdAt,
  };
  if (
    output.sessionId !== binding.sessionId ||
    binding.roleResult.targetDigest !== binding.subjectDigest ||
    binding.roleResult.role !== 'task-implementer' ||
    !isCurrentImplementationRoleResult(binding.roleResult) ||
    binding.roleResult.content.nodeId !== binding.providerObservationNodeId ||
    binding.roleResult.content.resultDigest !==
      binding.providerObservationDigest ||
    binding.roleResult.providerInvocation?.invocationId !==
      binding.invocationId ||
    binding.roleResult.providerInvocation.requestDigest !==
      binding.requestDigest ||
    binding.roleResult.providerInvocation.outputDigest !==
      binding.outputDigest ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw stateCorrupt();
  }
  return deepFreeze(binding);
}

function isCurrentImplementationRoleResult(value: AdmittedRoleResult): boolean {
  const { resultDigest, ...body } = value;
  if (
    resultDigest !==
      sha256(canonicalJson({ schema: 'admitted-role-result.v1', ...body })) ||
    value.role !== 'task-implementer' ||
    value.orchestration !== 'engine-spawned-provider' ||
    value.requiredIndependence !== 'provider-independent' ||
    value.content.kind !== 'task-implementation' ||
    value.content.contentDigest !== value.content.resultDigest ||
    value.content.current !== true ||
    canonicalJson(value.content.outputSchema) !==
      canonicalJson(TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA) ||
    value.providerInvocation === null ||
    value.providerInvocation.providerId !== value.assignment.providerId ||
    value.providerInvocation.sessionId !== value.assignment.sessionId ||
    value.providerInvocation.targetDigest !== value.targetDigest ||
    value.participant.providerId !== value.assignment.providerId ||
    value.participant.sessionId !== value.assignment.sessionId ||
    value.participant.engineSpawned !== true ||
    value.directHumanReviewAttestation !== null
  ) {
    return false;
  }
  if (!('grantId' in value.assignment)) {
    return (
      value.form === 'ordinary-provider' &&
      value.achievedIndependence === 'provider-independent' &&
      value.grantUse === null
    );
  }
  return (
    value.form === 'granted-same-provider' &&
    value.achievedIndependence === 'session-independent' &&
    value.assignment.degradedForm === 'same-provider-fresh-session' &&
    value.grantUse !== null &&
    value.grantUse.grantId === value.assignment.grantId &&
    value.grantUse.degradedForm === 'same-provider-fresh-session' &&
    value.grantUse.targetDigest === value.targetDigest &&
    value.grantUse.structuredContent.kind === 'task-implementation' &&
    value.grantUse.structuredContent.nodeId === value.content.nodeId &&
    value.grantUse.structuredContent.resultDigest === value.content.resultDigest
  );
}

function parseTaskStrategyCallerImplementationReservation(
  value: unknown,
): TaskStrategyCallerImplementationReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'sessionId',
      'subjectDigest',
      'grantId',
      'transitionDigest',
      'assignment',
      'submissionNodeId',
      'submissionResultDigest',
      'output',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-caller-implementation-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    !isSessionId(value.sessionId) ||
    !isDigest(value.subjectDigest) ||
    !isGrantId(value.grantId) ||
    !isDigest(value.transitionDigest) ||
    !isCallerGrantedAssignment(value.assignment) ||
    !isDigest(value.submissionNodeId) ||
    !isDigest(value.submissionResultDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let output: TaskStrategyImplementationOutput;
  try {
    output = assertTaskStrategyImplementationOutput(value.output);
  } catch {
    throw stateCorrupt();
  }
  const reservation: TaskStrategyCallerImplementationReservation = {
    schemaVersion: 1,
    kind: 'task-strategy-caller-implementation-reservation.v1',
    reservationDigest: value.reservationDigest,
    sessionId: value.sessionId,
    subjectDigest: value.subjectDigest,
    grantId: value.grantId,
    transitionDigest: value.transitionDigest,
    assignment: structuredClone(value.assignment),
    submissionNodeId: value.submissionNodeId,
    submissionResultDigest: value.submissionResultDigest,
    output,
    createdAt: value.createdAt,
  };
  if (
    output.sessionId !== reservation.sessionId ||
    reservation.assignment.grantId !== reservation.grantId ||
    reservation.assignment.targetDigest !== reservation.subjectDigest ||
    reservation.reservationDigest !==
      sha256(canonicalJson(withoutDigest(reservation, 'reservationDigest')))
  ) {
    throw stateCorrupt();
  }
  return deepFreeze(reservation);
}

function parseTaskStrategyCallerImplementationBinding(
  value: unknown,
): TaskStrategyCallerImplementationBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'sessionId',
      'subjectDigest',
      'transitionDigest',
      'submissionNodeId',
      'submissionResultDigest',
      'resultNodeId',
      'resultDigest',
      'roleResult',
      'output',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-caller-implementation-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    !isSessionId(value.sessionId) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.transitionDigest) ||
    !isDigest(value.submissionNodeId) ||
    !isDigest(value.submissionResultDigest) ||
    !isDigest(value.resultNodeId) ||
    !isDigest(value.resultDigest) ||
    !isAdmittedImplementationRoleResult(value.roleResult) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let output: TaskStrategyImplementationOutput;
  try {
    output = assertTaskStrategyImplementationOutput(value.output);
  } catch {
    throw stateCorrupt();
  }
  const binding: TaskStrategyCallerImplementationBinding = {
    schemaVersion: 1,
    kind: 'task-strategy-caller-implementation-binding.v1',
    bindingDigest: value.bindingDigest,
    sessionId: value.sessionId,
    subjectDigest: value.subjectDigest,
    transitionDigest: value.transitionDigest,
    submissionNodeId: value.submissionNodeId,
    submissionResultDigest: value.submissionResultDigest,
    resultNodeId: value.resultNodeId,
    resultDigest: value.resultDigest,
    roleResult: structuredClone(value.roleResult),
    output,
    createdAt: value.createdAt,
  };
  const { resultDigest, ...roleResultBody } = binding.roleResult;
  if (
    output.sessionId !== binding.sessionId ||
    !isCallerGrantedAssignment(binding.roleResult.assignment) ||
    binding.roleResult.role !== 'task-implementer' ||
    binding.roleResult.targetDigest !== binding.subjectDigest ||
    binding.roleResult.form !== 'granted-caller-supplied' ||
    binding.roleResult.orchestration !== 'caller-supplied' ||
    binding.roleResult.achievedIndependence !== 'none' ||
    binding.roleResult.providerInvocation !== null ||
    binding.roleResult.directHumanReviewAttestation !== null ||
    canonicalJson(binding.roleResult.author) !==
      canonicalJson(binding.roleResult.assignment.author) ||
    canonicalJson(binding.roleResult.participant) !==
      canonicalJson(binding.roleResult.assignment.participant) ||
    binding.roleResult.grantUse?.degradedForm !== 'caller-supplied' ||
    binding.roleResult.grantUse.grantId !==
      binding.roleResult.assignment.grantId ||
    binding.roleResult.grantUse.targetDigest !== binding.subjectDigest ||
    binding.roleResult.grantUse.transitionDigest !== binding.transitionDigest ||
    binding.roleResult.grantUse.authorizedEffect !==
      COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
    canonicalJson(binding.roleResult.grantUse.assignment) !==
      canonicalJson(binding.roleResult.assignment) ||
    binding.roleResult.grantUse.structuredContent.kind !==
      'task-implementation' ||
    binding.roleResult.grantUse.structuredContent.nodeId !==
      binding.submissionNodeId ||
    binding.roleResult.grantUse.structuredContent.resultDigest !==
      binding.submissionResultDigest ||
    binding.roleResult.content.kind !== 'task-implementation' ||
    binding.roleResult.content.nodeId !== binding.submissionNodeId ||
    binding.roleResult.content.resultDigest !==
      binding.submissionResultDigest ||
    binding.roleResult.content.contentDigest !==
      binding.submissionResultDigest ||
    canonicalJson(binding.roleResult.content.outputSchema) !==
      canonicalJson(TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA) ||
    binding.roleResult.content.evaluator !==
      'task-strategy-implementation.v1' ||
    binding.roleResult.content.policyDigest !==
      TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    binding.roleResult.content.current !== true ||
    resultDigest !==
      sha256(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...roleResultBody,
        }),
      ) ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw stateCorrupt();
  }
  return deepFreeze(binding);
}

function isCallerGrantedAssignment(
  value: unknown,
): value is GrantedRoleAssignment {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'role',
      'providerId',
      'sessionId',
      'targetDigest',
      'requiredIndependence',
      'achievedIndependence',
      'providerIndependent',
      'sessionIndependent',
      'engineSpawned',
      'orchestration',
      'grantId',
      'degradedForm',
      'authorizedEffect',
      'author',
      'participant',
      'callableProviderIds',
      'directHumanReviewAttestationDigest',
    ]) &&
    value.role === 'task-implementer' &&
    value.providerId === null &&
    value.sessionId === null &&
    isDigest(value.targetDigest) &&
    value.requiredIndependence === 'provider-independent' &&
    value.achievedIndependence === 'none' &&
    value.providerIndependent === false &&
    value.sessionIndependent === false &&
    value.engineSpawned === false &&
    value.orchestration === 'caller-supplied' &&
    isGrantId(value.grantId) &&
    value.degradedForm === 'caller-supplied' &&
    value.authorizedEffect === COLLABORATION_GRANT_AUTHORIZED_EFFECT &&
    isRecordedParticipant(value.author) &&
    isCallerParticipant(value.participant) &&
    Array.isArray(value.callableProviderIds) &&
    value.callableProviderIds.length === 0 &&
    value.directHumanReviewAttestationDigest === null
  );
}

function isCallerParticipant(value: unknown): value is RecordedRoleParticipant {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) &&
    value.providerId === null &&
    value.sessionId === null &&
    typeof value.principalId === 'string' &&
    value.principalId.length > 0 &&
    (value.identityAssurance === 'self-declared' ||
      value.identityAssurance === 'runtime-hint' ||
      value.identityAssurance === 'adapter-assigned') &&
    value.engineSpawned === false
  );
}

function isBaseline(value: unknown): value is { head: string; tree: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

function isRecordedParticipant(
  value: unknown,
): value is RecordedRoleParticipant {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) &&
    (value.providerId === 'codex' || value.providerId === 'claude') &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    typeof value.principalId === 'string' &&
    value.principalId.length > 0 &&
    (value.identityAssurance === 'self-declared' ||
      value.identityAssurance === 'runtime-hint' ||
      value.identityAssurance === 'adapter-assigned') &&
    value.engineSpawned === false
  );
}

function isMandateBinding(
  value: unknown,
  changeId: string,
): value is TaskMandateBinding | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'schemaVersion',
        'mandateTaskId',
        'mandateId',
        'mandateDigest',
        'changeId',
        'externalAuditRoot',
      ]) &&
      value.schemaVersion === 1 &&
      typeof value.mandateTaskId === 'string' &&
      value.mandateTaskId.length > 0 &&
      typeof value.mandateId === 'string' &&
      value.mandateId.length > 0 &&
      isDigest(value.mandateDigest) &&
      value.changeId === changeId &&
      typeof value.externalAuditRoot === 'string' &&
      value.externalAuditRoot.length > 0)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

function isInvestigationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertInvestigationId(value) === value;
  } catch {
    return false;
  }
}

function isInvocationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertInvocationId(value) === value;
  } catch {
    return false;
  }
}

function isAdmittedImplementationRoleResult(
  value: unknown,
): value is AdmittedRoleResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'form',
      'role',
      'targetDigest',
      'assignment',
      'author',
      'participant',
      'orchestration',
      'requiredIndependence',
      'achievedIndependence',
      'content',
      'providerInvocation',
      'grantUse',
      'directHumanReviewAttestation',
      'resultDigest',
    ]) &&
    value.schemaVersion === 1 &&
    value.role === 'task-implementer' &&
    isDigest(value.targetDigest) &&
    isDigest(value.resultDigest) &&
    isRecord(value.assignment) &&
    isRecord(value.author) &&
    isRecord(value.participant) &&
    isRecord(value.content) &&
    (value.providerInvocation === null || isRecord(value.providerInvocation))
  );
}

function withoutDigest<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw stateCorrupt();
  return value;
}

function isGrantId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function taskStrategyRecordedRedAuthor(
  transaction: TaskStrategyTransaction,
): RecordedRoleParticipant {
  return Object.freeze({
    providerId: transaction.author.providerId,
    sessionId: transaction.sessionId,
    principalId: `provider:${transaction.author.providerId}`,
    identityAssurance: transaction.author.assurance,
    engineSpawned: false,
  });
}

function implementationResultStale() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
    'The provider result no longer matches its exact sealed RED subject, assignment, observation, or patch bytes.',
    ExitCode.staleState,
  );
}

function stateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT',
    'Task strategy implementation reservation is malformed or unsafe.',
    ExitCode.staleState,
  );
}
