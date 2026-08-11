import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import {
  assertInvestigationId,
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
  assertTaskStrategyImplementationManifest,
  assertTaskStrategyImplementationSubject,
  type TaskStrategyImplementationManifest,
  type TaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
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

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
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
