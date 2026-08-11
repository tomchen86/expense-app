import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError, type WorkflowError } from './errors.ts';
import {
  createPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
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
  recreateProviderInvocationRequest,
  type ProviderInvocationRequest,
} from './provider-contracts.ts';
import type { ProviderId } from './provider-registry.ts';
import type {
  AdmittedRoleResult,
  ProviderRoleAssignment,
  RecordedRoleParticipant,
} from './role-scheduler.ts';
import {
  assertTaskDiffReviewChallengeResponseCurrent,
  parseTaskDiffFinalAssuranceRecord,
  parseTaskDiffReviewChallengeResponseRecord,
  parseTaskDiffReviewContinuationSubmission,
  parseTaskDiffReviewRecord,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffReviewChallengeResponseRecord,
  type TaskDiffFinalAssuranceRecord,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewRecord,
} from './task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewScope,
  parseTaskDiffReviewSubject,
  type TaskDiffReviewScope,
  type TaskDiffReviewSubject,
} from './task-diff-review.ts';
import type { TaskMandateBinding } from './task-mandate.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type TaskDiffReviewManifestSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  reviewScope: TaskDiffReviewScope;
  capabilityProfile: 'repository-read-only';
}>;

export type TaskDiffReviewReservationRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-reservation.v1';
  reservationDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding | null;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  manifest: TaskDiffReviewManifestSnapshot;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  createdAt: string;
}>;

export type TaskDiffReviewResultBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-result-binding.v1';
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
  review: TaskDiffReviewRecord;
  createdAt: string;
}>;

export type TaskDiffReviewContinuationManifestSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  capabilityProfile: 'repository-read-only';
}>;

export type TaskDiffReviewContinuationReservationRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-reservation.v1';
  reservationDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding | null;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  manifest: TaskDiffReviewContinuationManifestSnapshot;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  createdAt: string;
}>;

export type TaskDiffReviewContinuationResultBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-result-binding.v1';
  bindingDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  runtimeObservationDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
  submission: TaskDiffReviewContinuationSubmission;
  createdAt: string;
}>;

export type TaskDiffFinalAssuranceBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-final-assurance-binding.v1';
  bindingDigest: string;
  subjectDigest: string;
  assuranceNodeId: string;
  assuranceResultDigest: string;
  assurance: TaskDiffFinalAssuranceRecord;
  createdAt: string;
}>;

export type TaskDiffReviewSupersessionRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-supersession.v1';
  supersessionDigest: string;
  sessionId: string;
  predecessorSubjectDigest: string;
  predecessorReviewRecordDigest: string;
  supersededBySubjectDigest: string;
  supersededByDigest: string;
  reviewScope: TaskDiffReviewScope;
  createdAt: string;
}>;

export function createTaskDiffReviewReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewReservationRecord,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskDiffReviewReservationRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskDiffReviewReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewReservationPath(
      paths,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    ),
    reservation,
    storeUnsafe,
    'TASK_DIFF_REVIEW_RESERVATION_CONFLICT',
  );
  return readTaskDiffReviewReservation(
    paths,
    reservation.sessionId,
    reservation.subject.subjectDigest,
  )!;
}

export function readTaskDiffReviewReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): TaskDiffReviewReservationRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffReviewReservationPath(paths, sessionId, subjectDigest);
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const reservation = parseTaskDiffReviewReservation(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    reservation.sessionId !== sessionId ||
    reservation.subject.subjectDigest !== subjectDigest
  ) {
    throw storeUnsafe();
  }
  return reservation;
}

export function createTaskDiffReviewResultBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewResultBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskDiffReviewResultBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-result-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskDiffReviewResultBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewResultPath(paths, binding.sessionId, binding.subjectDigest),
    binding,
    storeUnsafe,
    'TASK_DIFF_REVIEW_RESULT_CONFLICT',
  );
  return readTaskDiffReviewResultBinding(
    paths,
    binding.sessionId,
    binding.subjectDigest,
  )!;
}

export function readTaskDiffReviewResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): TaskDiffReviewResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffReviewResultPath(paths, sessionId, subjectDigest);
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const binding = parseTaskDiffReviewResultBinding(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    binding.sessionId !== sessionId ||
    binding.subjectDigest !== subjectDigest
  ) {
    throw storeUnsafe();
  }
  return binding;
}

export function taskDiffReviewReservationPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'reservations',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function taskDiffReviewResultPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'results',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function createTaskDiffReviewContinuationReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewContinuationReservationRecord,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskDiffReviewContinuationReservationRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-continuation-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskDiffReviewContinuationReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewContinuationReservationPath(
      paths,
      reservation.sessionId,
      reservation.review.recordDigest,
    ),
    reservation,
    storeUnsafe,
    'TASK_DIFF_REVIEW_CONTINUATION_RESERVATION_CONFLICT',
  );
  return readTaskDiffReviewContinuationReservation(
    paths,
    reservation.sessionId,
    reservation.review.recordDigest,
  )!;
}

export function readTaskDiffReviewContinuationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): TaskDiffReviewContinuationReservationRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const reviewRecordDigest = assertDigest(requestedReviewRecordDigest);
  const target = taskDiffReviewContinuationReservationPath(
    paths,
    sessionId,
    reviewRecordDigest,
  );
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const reservation = parseTaskDiffReviewContinuationReservation(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    reservation.sessionId !== sessionId ||
    reservation.review.recordDigest !== reviewRecordDigest
  ) {
    throw storeUnsafe();
  }
  return reservation;
}

export function createTaskDiffReviewContinuationResultBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewContinuationResultBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskDiffReviewContinuationResultBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-continuation-result-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskDiffReviewContinuationResultBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewContinuationResultPath(
      paths,
      binding.sessionId,
      binding.reviewRecordDigest,
    ),
    binding,
    storeUnsafe,
    'TASK_DIFF_REVIEW_CONTINUATION_RESULT_CONFLICT',
  );
  return readTaskDiffReviewContinuationResultBinding(
    paths,
    binding.sessionId,
    binding.reviewRecordDigest,
  )!;
}

export function readTaskDiffReviewContinuationResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): TaskDiffReviewContinuationResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const reviewRecordDigest = assertDigest(requestedReviewRecordDigest);
  const target = taskDiffReviewContinuationResultPath(
    paths,
    sessionId,
    reviewRecordDigest,
  );
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const binding = parseTaskDiffReviewContinuationResultBinding(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    binding.sessionId !== sessionId ||
    binding.reviewRecordDigest !== reviewRecordDigest
  ) {
    throw storeUnsafe();
  }
  return binding;
}

export function taskDiffReviewContinuationReservationPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'continuations',
    assertDigest(requestedReviewRecordDigest),
    'reservation.json',
  );
}

export function taskDiffReviewContinuationResultPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'continuation-results',
    `${assertDigest(requestedReviewRecordDigest)}.json`,
  );
}

export function createTaskDiffFinalAssuranceBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffFinalAssuranceBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskDiffFinalAssuranceBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-final-assurance-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskDiffFinalAssuranceBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffFinalAssurancePath(paths, binding.subjectDigest),
    binding,
    storeUnsafe,
    'TASK_DIFF_FINAL_ASSURANCE_CONFLICT',
  );
  return readTaskDiffFinalAssuranceBinding(paths, binding.subjectDigest)!;
}

export function readTaskDiffFinalAssuranceBinding(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): TaskDiffFinalAssuranceBinding | null {
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffFinalAssurancePath(paths, subjectDigest);
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const binding = parseTaskDiffFinalAssuranceBinding(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (binding.subjectDigest !== subjectDigest) throw storeUnsafe();
  return binding;
}

export function taskDiffFinalAssurancePath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    'final-assurance',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function listTaskDiffReviewResultBindings(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): readonly TaskDiffReviewResultBinding[] {
  const sessionId = assertSessionId(requestedSessionId);
  const directory = path.join(
    paths.refs,
    'task-diff-reviews',
    sessionId,
    'results',
  );
  return listPrivateDigestJson(paths, directory).map((subjectDigest) => {
    const binding = readTaskDiffReviewResultBinding(
      paths,
      sessionId,
      subjectDigest,
    );
    if (binding === null) throw storeUnsafe();
    return binding;
  });
}

export function createTaskDiffReviewSupersession(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewSupersessionRecord,
    'schemaVersion' | 'kind' | 'supersessionDigest'
  >,
): TaskDiffReviewSupersessionRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-supersession.v1' as const,
    ...input,
  };
  const record = parseTaskDiffReviewSupersession({
    ...body,
    supersessionDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewSupersessionPath(
      paths,
      record.sessionId,
      record.predecessorReviewRecordDigest,
    ),
    record,
    storeUnsafe,
    'TASK_DIFF_REVIEW_SUPERSESSION_CONFLICT',
  );
  return readTaskDiffReviewSupersession(
    paths,
    record.sessionId,
    record.predecessorReviewRecordDigest,
  )!;
}

export function readTaskDiffReviewSupersession(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedPredecessorReviewRecordDigest: string,
): TaskDiffReviewSupersessionRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const predecessorReviewRecordDigest = assertDigest(
    requestedPredecessorReviewRecordDigest,
  );
  const target = taskDiffReviewSupersessionPath(
    paths,
    sessionId,
    predecessorReviewRecordDigest,
  );
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const record = parseTaskDiffReviewSupersession(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    record.sessionId !== sessionId ||
    record.predecessorReviewRecordDigest !== predecessorReviewRecordDigest
  ) {
    throw storeUnsafe();
  }
  return record;
}

export function listTaskDiffReviewSupersessions(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): readonly TaskDiffReviewSupersessionRecord[] {
  const sessionId = assertSessionId(requestedSessionId);
  const directory = path.join(
    paths.refs,
    'task-diff-reviews',
    sessionId,
    'supersessions',
  );
  return listPrivateDigestJson(paths, directory).map(
    (predecessorReviewRecordDigest) => {
      const record = readTaskDiffReviewSupersession(
        paths,
        sessionId,
        predecessorReviewRecordDigest,
      );
      if (record === null) throw storeUnsafe();
      return record;
    },
  );
}

export function taskDiffReviewSupersessionPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedPredecessorReviewRecordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'supersessions',
    `${assertDigest(requestedPredecessorReviewRecordDigest)}.json`,
  );
}

function parseTaskDiffReviewReservation(
  value: unknown,
): TaskDiffReviewReservationRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
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
      'implementationActor',
      'manifest',
      'request',
      'authorizationNodeId',
      'reservationNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    !isAbsolutePath(value.repositoryRoot) ||
    !isAbsolutePath(value.gitCommonDirectory) ||
    !isIdentity(value.branch) ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId)
  ) {
    throw storeUnsafe();
  }
  const ownerInvestigationId = assertInvestigationId(
    value.ownerInvestigationId,
  );
  const sessionId = assertSessionId(value.sessionId);
  const subject = parseTaskDiffReviewSubject(value.subject);
  const request = recreateProviderInvocationRequest(value.request);
  const manifest = parseManifest(value.manifest);
  const implementationActor = parseParticipant(value.implementationActor);
  const mandateBinding = parseMandateBinding(
    value.mandateBinding,
    value.changeId,
  );
  const baseline = parseBaseline(value.baseline);
  const record: TaskDiffReviewReservationRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-reservation.v1',
    reservationDigest: value.reservationDigest,
    ownerInvestigationId,
    sessionId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    branch: value.branch,
    baseline,
    mandateBinding,
    subject,
    implementationActor,
    manifest,
    request,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
    createdAt: value.createdAt,
  };
  if (
    subject.changeId !== record.changeId ||
    subject.taskId !== record.taskId ||
    subject.baseCommit !== baseline.head ||
    subject.baseTree !== baseline.tree ||
    manifest.changeId !== record.changeId ||
    manifest.taskId !== record.taskId ||
    manifest.sessionId !== sessionId ||
    manifest.repositoryIdentity !== subject.repositoryId ||
    canonicalJson(manifest.subject) !== canonicalJson(subject) ||
    request.invocationId !== assertInvocationId(request.invocationId) ||
    request.authorizationNodeId !== record.authorizationNodeId ||
    request.targetDigest !== subject.subjectDigest ||
    request.inputManifestDigest !== sha256(canonicalJson(manifest)) ||
    !taskDiffRoleAssignmentMatchesReservation(
      request.roleAssignment,
      implementationActor,
      subject.subjectDigest,
      request.providerId,
    ) ||
    record.reservationDigest !==
      sha256(canonicalJson(withoutDigest(record, 'reservationDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(record);
}

function parseTaskDiffReviewResultBinding(
  value: unknown,
): TaskDiffReviewResultBinding {
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
      'review',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-result-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.runtimeObservationDigest) ||
    !isDigest(value.providerObservationNodeId) ||
    !isDigest(value.providerObservationDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest) ||
    !isAdmittedTaskDiffRoleResultShape(value.roleResult) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const review = parseTaskDiffReviewRecord(value.review);
  const binding: TaskDiffReviewResultBinding = {
    schemaVersion: 1,
    kind: 'task-diff-review-result-binding.v1',
    bindingDigest: value.bindingDigest,
    ownerInvestigationId: assertInvestigationId(value.ownerInvestigationId),
    sessionId: assertSessionId(value.sessionId),
    subjectDigest: value.subjectDigest,
    invocationId: assertInvocationId(value.invocationId),
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    runtimeObservationDigest: value.runtimeObservationDigest,
    providerObservationNodeId: value.providerObservationNodeId,
    providerObservationDigest: value.providerObservationDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
    roleResult: structuredClone(value.roleResult),
    review,
    createdAt: value.createdAt,
  };
  if (
    review.subjectDigest !== binding.subjectDigest ||
    binding.roleResult.targetDigest !== binding.subjectDigest ||
    binding.roleResult.role !== 'task-diff-reviewer' ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(binding);
}

function parseTaskDiffReviewContinuationReservation(
  value: unknown,
): TaskDiffReviewContinuationReservationRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
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
      'implementationActor',
      'review',
      'response',
      'manifest',
      'request',
      'authorizationNodeId',
      'reservationNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    !isAbsolutePath(value.repositoryRoot) ||
    !isAbsolutePath(value.gitCommonDirectory) ||
    !isIdentity(value.branch) ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId)
  ) {
    throw storeUnsafe();
  }
  const ownerInvestigationId = assertInvestigationId(
    value.ownerInvestigationId,
  );
  const sessionId = assertSessionId(value.sessionId);
  const subject = parseTaskDiffReviewSubject(value.subject);
  const review = parseTaskDiffReviewRecord(value.review);
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    review,
    parseTaskDiffReviewChallengeResponseRecord(value.response),
  );
  const manifest = parseContinuationManifest(value.manifest);
  const request = recreateProviderInvocationRequest(value.request);
  const implementationActor = parseParticipant(value.implementationActor);
  const mandateBinding = parseMandateBinding(
    value.mandateBinding,
    value.changeId,
  );
  const baseline = parseBaseline(value.baseline);
  const record: TaskDiffReviewContinuationReservationRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-reservation.v1',
    reservationDigest: value.reservationDigest,
    ownerInvestigationId,
    sessionId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    branch: value.branch,
    baseline,
    mandateBinding,
    subject,
    implementationActor,
    review,
    response,
    manifest,
    request,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
    createdAt: value.createdAt,
  };
  if (
    subject.changeId !== record.changeId ||
    subject.taskId !== record.taskId ||
    subject.baseCommit !== baseline.head ||
    subject.baseTree !== baseline.tree ||
    review.subjectDigest !== subject.subjectDigest ||
    response.subjectDigest !== subject.subjectDigest ||
    manifest.changeId !== record.changeId ||
    manifest.taskId !== record.taskId ||
    manifest.sessionId !== sessionId ||
    manifest.repositoryIdentity !== subject.repositoryId ||
    canonicalJson(manifest.subject) !== canonicalJson(subject) ||
    canonicalJson(manifest.review) !== canonicalJson(review) ||
    canonicalJson(manifest.response) !== canonicalJson(response) ||
    request.invocationId !== assertInvocationId(request.invocationId) ||
    request.authorizationNodeId !== record.authorizationNodeId ||
    request.targetDigest !== subject.subjectDigest ||
    request.inputManifestDigest !== sha256(canonicalJson(manifest)) ||
    request.providerId !== review.assignment.reviewerProviderId ||
    request.roleAssignment.role !== 'task-diff-reviewer' ||
    request.roleAssignment.providerId !==
      review.assignment.reviewerProviderId ||
    request.roleAssignment.sessionId === review.assignment.reviewerSessionId ||
    request.outputSchema.id !==
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id ||
    request.outputSchema.version !==
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version ||
    request.outputSchema.digest !==
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest ||
    record.reservationDigest !==
      sha256(canonicalJson(withoutDigest(record, 'reservationDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(record);
}

function parseTaskDiffReviewContinuationResultBinding(
  value: unknown,
): TaskDiffReviewContinuationResultBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'ownerInvestigationId',
      'sessionId',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'runtimeObservationDigest',
      'providerResultNodeId',
      'providerResultDigest',
      'submission',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-result-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.reviewRecordDigest) ||
    !isDigest(value.responseDigest) ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.runtimeObservationDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const submission = parseTaskDiffReviewContinuationSubmission(
    value.submission,
  );
  const binding: TaskDiffReviewContinuationResultBinding = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-result-binding.v1',
    bindingDigest: value.bindingDigest,
    ownerInvestigationId: assertInvestigationId(value.ownerInvestigationId),
    sessionId: assertSessionId(value.sessionId),
    subjectDigest: value.subjectDigest,
    reviewRecordDigest: value.reviewRecordDigest,
    responseDigest: value.responseDigest,
    invocationId: assertInvocationId(value.invocationId),
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    runtimeObservationDigest: value.runtimeObservationDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
    submission,
    createdAt: value.createdAt,
  };
  if (
    submission.reviewRecordDigest !== binding.reviewRecordDigest ||
    submission.responseDigest !== binding.responseDigest ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(binding);
}

function parseTaskDiffFinalAssuranceBinding(
  value: unknown,
): TaskDiffFinalAssuranceBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'subjectDigest',
      'assuranceNodeId',
      'assuranceResultDigest',
      'assurance',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-final-assurance-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.assuranceNodeId) ||
    !isDigest(value.assuranceResultDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const assurance = parseTaskDiffFinalAssuranceRecord(value.assurance);
  const binding: TaskDiffFinalAssuranceBinding = {
    schemaVersion: 1,
    kind: 'task-diff-final-assurance-binding.v1',
    bindingDigest: value.bindingDigest,
    subjectDigest: value.subjectDigest,
    assuranceNodeId: value.assuranceNodeId,
    assuranceResultDigest: value.assuranceResultDigest,
    assurance,
    createdAt: value.createdAt,
  };
  if (
    assurance.subjectDigest !== binding.subjectDigest ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(binding);
}

function parseTaskDiffReviewSupersession(
  value: unknown,
): TaskDiffReviewSupersessionRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'supersessionDigest',
      'sessionId',
      'predecessorSubjectDigest',
      'predecessorReviewRecordDigest',
      'supersededBySubjectDigest',
      'supersededByDigest',
      'reviewScope',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-supersession.v1' ||
    !isDigest(value.supersessionDigest) ||
    typeof value.sessionId !== 'string' ||
    !isDigest(value.predecessorSubjectDigest) ||
    !isDigest(value.predecessorReviewRecordDigest) ||
    !isDigest(value.supersededBySubjectDigest) ||
    !isDigest(value.supersededByDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const reviewScope = parseTaskDiffReviewScope(value.reviewScope);
  const predecessor = reviewScope.predecessor;
  const record: TaskDiffReviewSupersessionRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-supersession.v1',
    supersessionDigest: value.supersessionDigest,
    sessionId: assertSessionId(value.sessionId as string),
    predecessorSubjectDigest: value.predecessorSubjectDigest,
    predecessorReviewRecordDigest: value.predecessorReviewRecordDigest,
    supersededBySubjectDigest: value.supersededBySubjectDigest,
    supersededByDigest: value.supersededByDigest,
    reviewScope,
    createdAt: value.createdAt as string,
  };
  if (
    predecessor === null ||
    predecessor.subjectDigest !== record.predecessorSubjectDigest ||
    predecessor.reviewRecordDigest !== record.predecessorReviewRecordDigest ||
    reviewScope.currentSubjectDigest !== record.supersededBySubjectDigest ||
    record.supersessionDigest !==
      sha256(canonicalJson(withoutDigest(record, 'supersessionDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(record);
}

function parseManifest(value: unknown): TaskDiffReviewManifestSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'reviewScope',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-manifest' ||
    !isIdentity(value.changeId) ||
    !isIdentity(value.taskId) ||
    !isIdentity(value.sessionId) ||
    !isIdentity(value.repositoryId) ||
    !isIdentity(value.repositoryIdentity) ||
    !GIT_OBJECT_ID.test(String(value.baseCommit)) ||
    !GIT_OBJECT_ID.test(String(value.baseTree)) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw storeUnsafe();
  }
  const subject = parseTaskDiffReviewSubject(value.subject);
  const reviewScope = parseTaskDiffReviewScope(value.reviewScope);
  if (reviewScope.currentSubjectDigest !== subject.subjectDigest) {
    throw storeUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit as string,
    baseTree: value.baseTree as string,
    subject,
    reviewScope,
    capabilityProfile: 'repository-read-only',
  });
}

function parseContinuationManifest(
  value: unknown,
): TaskDiffReviewContinuationManifestSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'review',
      'response',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-manifest' ||
    !isIdentity(value.changeId) ||
    !isIdentity(value.taskId) ||
    !isIdentity(value.sessionId) ||
    !isIdentity(value.repositoryId) ||
    !isIdentity(value.repositoryIdentity) ||
    !GIT_OBJECT_ID.test(String(value.baseCommit)) ||
    !GIT_OBJECT_ID.test(String(value.baseTree)) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw storeUnsafe();
  }
  const subject = parseTaskDiffReviewSubject(value.subject);
  const review = parseTaskDiffReviewRecord(value.review);
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    review,
    parseTaskDiffReviewChallengeResponseRecord(value.response),
  );
  if (
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    subject.repositoryId !== value.repositoryIdentity ||
    subject.baseCommit !== value.baseCommit ||
    subject.baseTree !== value.baseTree ||
    review.subjectDigest !== subject.subjectDigest ||
    canonicalJson(review.subject) !== canonicalJson(subject)
  ) {
    throw storeUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit as string,
    baseTree: value.baseTree as string,
    subject,
    review,
    response,
    capabilityProfile: 'repository-read-only',
  });
}

function parseParticipant(value: unknown): RecordedRoleParticipant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    !isProviderIdOrNull(value.providerId) ||
    !isIdentityOrNull(value.sessionId) ||
    !isIdentityOrNull(value.principalId) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw storeUnsafe();
  }
  return deepFreeze({
    providerId: value.providerId,
    sessionId: value.sessionId,
    principalId: value.principalId,
    identityAssurance:
      value.identityAssurance as RecordedRoleParticipant['identityAssurance'],
    engineSpawned: value.engineSpawned,
  });
}

function taskDiffRoleAssignmentMatchesReservation(
  assignment: ProviderRoleAssignment,
  implementationActor: RecordedRoleParticipant,
  subjectDigest: string,
  providerId: ProviderId,
): boolean {
  if (
    assignment.role !== 'task-diff-reviewer' ||
    assignment.providerId !== providerId ||
    assignment.targetDigest !== subjectDigest ||
    assignment.requiredIndependence !== 'provider-independent'
  ) {
    return false;
  }
  if (!('grantId' in assignment)) {
    return assignment.achievedIndependence === 'provider-independent';
  }
  return (
    assignment.degradedForm === 'same-provider-fresh-session' &&
    assignment.achievedIndependence === 'session-independent' &&
    assignment.providerIndependent === false &&
    assignment.sessionIndependent === true &&
    assignment.engineSpawned === true &&
    assignment.orchestration === 'engine-spawned-provider' &&
    assignment.author.providerId === implementationActor.providerId &&
    assignment.author.sessionId === implementationActor.sessionId &&
    assignment.participant.providerId === providerId &&
    assignment.participant.sessionId === assignment.sessionId &&
    assignment.participant.engineSpawned === true
  );
}

function isAdmittedTaskDiffRoleResultShape(
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
    value.role === 'task-diff-reviewer' &&
    isDigest(value.targetDigest) &&
    isDigest(value.resultDigest) &&
    isRecord(value.assignment) &&
    isRecord(value.author) &&
    isRecord(value.participant) &&
    isRecord(value.content)
  );
}

function parseMandateBinding(
  value: unknown,
  expectedChangeId: unknown,
): TaskMandateBinding | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    !isIdentity(value.mandateTaskId) ||
    !isIdentity(value.mandateId) ||
    !isDigest(value.mandateDigest) ||
    value.changeId !== expectedChangeId ||
    !isIdentity(value.changeId) ||
    !isIdentity(value.externalAuditRoot)
  ) {
    throw storeUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    mandateTaskId: value.mandateTaskId,
    mandateId: value.mandateId,
    mandateDigest: value.mandateDigest,
    changeId: value.changeId,
    externalAuditRoot: value.externalAuditRoot,
  });
}

function parseBaseline(
  value: unknown,
): Readonly<{ head: string; tree: string }> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['head', 'tree']) ||
    !GIT_OBJECT_ID.test(String(value.head)) ||
    !GIT_OBJECT_ID.test(String(value.tree))
  ) {
    throw storeUnsafe();
  }
  return Object.freeze({
    head: value.head as string,
    tree: value.tree as string,
  });
}

function listPrivateDigestJson(
  paths: InvestigationRuntimePaths,
  directory: string,
): readonly string[] {
  const observed = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!observed) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeUnsafe);
  const names = fs.readdirSync(directory).sort();
  const digests = names.map((name) => {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    if (!match) throw storeUnsafe();
    return match[1]!;
  });
  if (
    new Set(digests).size !== digests.length ||
    canonicalJson(fs.readdirSync(directory).sort()) !== canonicalJson(names)
  ) {
    throw storeUnsafe();
  }
  return Object.freeze(digests);
}

function withoutDigest<T extends Record<string, unknown>>(
  value: T,
  digestKey: keyof T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== digestKey),
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function assertDigest(value: unknown): string {
  if (!isDigest(value)) throw storeUnsafe();
  return value;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY.test(value);
}

function isIdentityOrNull(value: unknown): value is string | null {
  return value === null || isIdentity(value);
}

function isProviderIdOrNull(value: unknown): value is ProviderId | null {
  return value === null || value === 'claude' || value === 'codex';
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function storeUnsafe(): WorkflowError {
  return workflowError(
    'TASK_DIFF_REVIEW_STORE_UNSAFE',
    'TaskDiffReview durable state is missing, malformed, or unsafe.',
    ExitCode.guard,
  );
}
