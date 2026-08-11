import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from './collaboration-grant.ts';
import { ExitCode, workflowError } from './errors.ts';
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
} from './paths.ts';
import {
  isProviderRoleAssignment,
  recreateProviderInvocationRequest,
  type ProviderInvocationRequest,
} from './provider-contracts.ts';
import type { TaskMandateBinding } from './task-mandate.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  assertTaskStrategyImplementationManifest,
  assertTaskStrategyImplementationOutput,
  assertTaskStrategyImplementationSubject,
  type TaskStrategyImplementationManifest,
  type TaskStrategyImplementationOutput,
  type TaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
  type AdmittedRoleResult,
  type GrantedRoleAssignment,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
} from './role-scheduler.ts';

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
  createPrivateCanonicalJson(
    paths,
    reservationPath(paths, reservation.sessionId),
    reservation,
    stateCorrupt,
    'TASK_STRATEGY_IMPLEMENTATION_RESERVATION_CONFLICT',
  );
  return readTaskStrategyImplementationReservation(
    paths,
    reservation.sessionId,
  )!;
}

export function readTaskStrategyImplementationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyImplementationReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = reservationPath(paths, sessionId);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const reservation = parseTaskStrategyImplementationReservation(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (reservation.sessionId !== sessionId) throw stateCorrupt();
  return reservation;
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
  createPrivateCanonicalJson(
    paths,
    resultPath(paths, binding.sessionId),
    binding,
    stateCorrupt,
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_CONFLICT',
  );
  return readTaskStrategyImplementationResultBinding(paths, binding.sessionId)!;
}

export function readTaskStrategyImplementationResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyImplementationResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = resultPath(paths, sessionId);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const binding = parseTaskStrategyImplementationResultBinding(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (binding.sessionId !== sessionId) throw stateCorrupt();
  return binding;
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
  createPrivateCanonicalJson(
    paths,
    callerResultPath(paths, binding.sessionId),
    binding,
    stateCorrupt,
    'TASK_STRATEGY_CALLER_IMPLEMENTATION_CONFLICT',
  );
  return readTaskStrategyCallerImplementationBinding(paths, binding.sessionId)!;
}

export function readTaskStrategyCallerImplementationBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyCallerImplementationBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = callerResultPath(paths, sessionId);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const binding = parseTaskStrategyCallerImplementationBinding(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (binding.sessionId !== sessionId) throw stateCorrupt();
  return binding;
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
  createPrivateCanonicalJson(
    paths,
    callerReservationPath(paths, reservation.sessionId),
    reservation,
    stateCorrupt,
    'TASK_STRATEGY_CALLER_IMPLEMENTATION_RESERVATION_CONFLICT',
  );
  return readTaskStrategyCallerImplementationReservation(
    paths,
    reservation.sessionId,
  )!;
}

export function readTaskStrategyCallerImplementationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyCallerImplementationReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = callerReservationPath(paths, sessionId);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const reservation = parseTaskStrategyCallerImplementationReservation(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (reservation.sessionId !== sessionId) throw stateCorrupt();
  return reservation;
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

function stateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT',
    'Task strategy implementation reservation is malformed or unsafe.',
    ExitCode.staleState,
  );
}
