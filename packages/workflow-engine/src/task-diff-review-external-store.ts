import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import type { InvestigationRuntimePaths } from './paths.ts';
import {
  parseTaskDiffReviewContinuationSubmission,
  parseTaskDiffReviewSubmission,
  parseTaskDiffReviewChallengeResponseRecord,
  type TaskDiffReviewChallengeResponseRecord,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewSubmission,
} from './task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewScope,
  parseTaskDiffReviewSubject,
  type TaskDiffReviewScope,
  type TaskDiffReviewSubject,
} from './task-diff-review.ts';
import type { RecordedRoleParticipant } from './role-scheduler.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_FILE = /^([0-9a-f]{64})\.json$/u;
const ATTEMPT_FILE = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u;
const SCOPED_FILE = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u;
const STORE_DIRECTORIES = Object.freeze([
  'review-reservations',
  'review-bindings',
  'continuation-reservations',
  'continuation-bindings',
  'responses',
  'submissions',
  'closure-submissions',
] as const);

export type TaskDiffExternalDegradedForm =
  'caller-supplied' | 'direct-human-review';

export type TaskDiffExternalGrantReference = Readonly<{
  degradedForm: TaskDiffExternalDegradedForm;
  grantId: string;
  grantEnvelopeDigest: string;
  grantTransitionDigest: string;
  grantTargetDigest: string;
}>;

export type TaskDiffExternalReviewReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-review-reservation.v1';
  reservationDigest: string;
  targetDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  policyDigest: string;
  inputDigest: string;
  reviewScopeDigest: string;
  submissionRecordDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  implementationActor: RecordedRoleParticipant;
  grant: TaskDiffExternalGrantReference;
}>;

export type TaskDiffExternalReviewBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-review-binding.v1';
  bindingDigest: string;
  reservationDigest: string;
  targetDigest: string;
  subjectDigest: string;
  policyDigest: string;
  inputDigest: string;
  reviewScopeDigest: string;
  submissionRecordDigest: string;
  grant: TaskDiffExternalGrantReference;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
  reviewRecordDigest: string;
}>;

export type TaskDiffExternalContinuationReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-continuation-reservation.v1';
  reservationDigest: string;
  targetDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  policyDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  inputDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  grant: TaskDiffExternalGrantReference;
}>;

/**
 * This binding authenticates only the external continuation contribution.
 * It deliberately records no disposition, verdict, or closure state. The
 * governing TaskDiff validator remains the only place that may close a
 * challenge or mint Final Assurance.
 */
export type TaskDiffExternalContinuationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-continuation-binding.v1';
  bindingDigest: string;
  reservationDigest: string;
  targetDigest: string;
  subjectDigest: string;
  policyDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  inputDigest: string;
  grant: TaskDiffExternalGrantReference;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
}>;

/**
 * Immutable external response content only. This record binds the complete
 * TaskDiff challenge response to its exact review and subject, but carries no
 * admission, identity, grant, disposition, or closure authority.
 */
export type TaskDiffExternalChallengeResponse = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-challenge-response.v1';
  recordDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  response: TaskDiffReviewChallengeResponseRecord;
}>;

/** Authority-free review content awaiting a separately authenticated role. */
export type TaskDiffExternalReviewSubmission = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-review-submission.v1';
  recordDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewScope: TaskDiffReviewScope;
  reviewScopeDigest: string;
  submission: TaskDiffReviewSubmission;
  inputDigest: string;
}>;

/**
 * Immutable authority-free continuation content. `proposedDispositions` are
 * advisory reviewer output only; this record has no identity, grant, closure,
 * or Final Assurance authority.
 */
export type TaskDiffExternalClosureSubmission = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-closure-submission.v1';
  recordDigest: string;
  targetDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  submission: TaskDiffReviewContinuationSubmission;
  inputDigest: string;
}>;

export type PrepareTaskDiffExternalReviewReservationInput = Readonly<{
  subject: TaskDiffReviewSubject;
  policyDigest: string;
  inputDigest: string;
  reviewScopeDigest: string;
  submissionRecordDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  implementationActor: RecordedRoleParticipant;
  grant: TaskDiffExternalGrantReference;
}>;

export type PrepareTaskDiffExternalReviewBindingInput = Readonly<{
  reservation: TaskDiffExternalReviewReservation;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
  reviewRecordDigest: string;
}>;

export type PrepareTaskDiffExternalContinuationReservationInput = Readonly<{
  subject: TaskDiffReviewSubject;
  policyDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  inputDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  grant: TaskDiffExternalGrantReference;
}>;

export type PrepareTaskDiffExternalContinuationBindingInput = Readonly<{
  reservation: TaskDiffExternalContinuationReservation;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
}>;

export type PrepareTaskDiffExternalChallengeResponseInput = Readonly<{
  subject: TaskDiffReviewSubject;
  response: TaskDiffReviewChallengeResponseRecord;
}>;

export type PrepareTaskDiffExternalReviewSubmissionInput = Readonly<{
  subject: TaskDiffReviewSubject;
  reviewScope: TaskDiffReviewScope;
  submission: TaskDiffReviewSubmission;
  inputDigest: string;
}>;

export type PrepareTaskDiffExternalClosureSubmissionInput = Readonly<{
  subject: TaskDiffReviewSubject;
  submission: TaskDiffReviewContinuationSubmission;
  inputDigest: string;
}>;

export function taskDiffExternalContinuationTargetDigest(input: {
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
}): string {
  return sha256(
    canonicalJson({
      schema: 'workflow.task-diff-external-continuation-target.v1',
      subjectDigest: assertDigest(input.subjectDigest),
      reviewRecordDigest: assertDigest(input.reviewRecordDigest),
      responseDigest: assertDigest(input.responseDigest),
    }),
  );
}

export function prepareTaskDiffExternalReviewReservation(
  input: PrepareTaskDiffExternalReviewReservationInput,
): TaskDiffExternalReviewReservation {
  const subject = parseSubject(input.subject);
  const policyDigest = assertDigest(input.policyDigest);
  if (policyDigest !== subject.reviewPolicyDigest) throw storeInvalid();
  const grant = parseGrantReference(input.grant);
  if (grant.grantTargetDigest !== subject.subjectDigest) throw storeInvalid();
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-review-reservation.v1' as const,
    targetDigest: subject.subjectDigest,
    subject,
    subjectDigest: subject.subjectDigest,
    policyDigest,
    inputDigest: assertDigest(input.inputDigest),
    reviewScopeDigest: assertDigest(input.reviewScopeDigest),
    submissionRecordDigest: assertDigest(input.submissionRecordDigest),
    contentNodeId: assertDigest(input.contentNodeId),
    contentResultDigest: assertDigest(input.contentResultDigest),
    implementationActor: parseRecordedParticipant(input.implementationActor),
    grant,
  };
  return parseTaskDiffExternalReviewReservation({
    ...body,
    reservationDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalReviewBinding(
  input: PrepareTaskDiffExternalReviewBindingInput,
): TaskDiffExternalReviewBinding {
  const reservation = parseTaskDiffExternalReviewReservation(input.reservation);
  const directHumanReviewAttestationDigest = parseAttestationDigest(
    reservation.grant.degradedForm,
    input.directHumanReviewAttestationDigest,
  );
  if (
    assertDigest(input.contentNodeId) !== reservation.contentNodeId ||
    assertDigest(input.contentResultDigest) !== reservation.contentResultDigest
  ) {
    throw storeInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-review-binding.v1' as const,
    reservationDigest: reservation.reservationDigest,
    targetDigest: reservation.targetDigest,
    subjectDigest: reservation.subjectDigest,
    policyDigest: reservation.policyDigest,
    inputDigest: reservation.inputDigest,
    reviewScopeDigest: reservation.reviewScopeDigest,
    submissionRecordDigest: reservation.submissionRecordDigest,
    grant: reservation.grant,
    grantUseDigest: assertDigest(input.grantUseDigest),
    admittedRoleResultDigest: assertDigest(input.admittedRoleResultDigest),
    directHumanReviewAttestationDigest,
    contentNodeId: reservation.contentNodeId,
    contentResultDigest: reservation.contentResultDigest,
    authorityNodeId: assertDigest(input.authorityNodeId),
    authorityResultDigest: assertDigest(input.authorityResultDigest),
    reviewRecordDigest: assertDigest(input.reviewRecordDigest),
  };
  return parseTaskDiffExternalReviewBinding({
    ...body,
    bindingDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalContinuationReservation(
  input: PrepareTaskDiffExternalContinuationReservationInput,
): TaskDiffExternalContinuationReservation {
  const subject = parseSubject(input.subject);
  const policyDigest = assertDigest(input.policyDigest);
  const reviewRecordDigest = assertDigest(input.reviewRecordDigest);
  const responseDigest = assertDigest(input.responseDigest);
  if (policyDigest !== subject.reviewPolicyDigest) throw storeInvalid();
  const targetDigest = taskDiffExternalContinuationTargetDigest({
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest,
    responseDigest,
  });
  const grant = parseGrantReference(input.grant);
  if (grant.grantTargetDigest !== targetDigest) throw storeInvalid();
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-continuation-reservation.v1' as const,
    targetDigest,
    subject,
    subjectDigest: subject.subjectDigest,
    policyDigest,
    reviewRecordDigest,
    responseDigest,
    inputDigest: assertDigest(input.inputDigest),
    contentNodeId: assertDigest(input.contentNodeId),
    contentResultDigest: assertDigest(input.contentResultDigest),
    grant,
  };
  return parseTaskDiffExternalContinuationReservation({
    ...body,
    reservationDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalContinuationBinding(
  input: PrepareTaskDiffExternalContinuationBindingInput,
): TaskDiffExternalContinuationBinding {
  const reservation = parseTaskDiffExternalContinuationReservation(
    input.reservation,
  );
  const directHumanReviewAttestationDigest = parseAttestationDigest(
    reservation.grant.degradedForm,
    input.directHumanReviewAttestationDigest,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-continuation-binding.v1' as const,
    reservationDigest: reservation.reservationDigest,
    targetDigest: reservation.targetDigest,
    subjectDigest: reservation.subjectDigest,
    policyDigest: reservation.policyDigest,
    reviewRecordDigest: reservation.reviewRecordDigest,
    responseDigest: reservation.responseDigest,
    inputDigest: reservation.inputDigest,
    grant: reservation.grant,
    grantUseDigest: assertDigest(input.grantUseDigest),
    admittedRoleResultDigest: assertDigest(input.admittedRoleResultDigest),
    directHumanReviewAttestationDigest,
    contentNodeId: assertDigest(input.contentNodeId),
    contentResultDigest: assertDigest(input.contentResultDigest),
    authorityNodeId: assertDigest(input.authorityNodeId),
    authorityResultDigest: assertDigest(input.authorityResultDigest),
  };
  return parseTaskDiffExternalContinuationBinding({
    ...body,
    bindingDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalChallengeResponse(
  input: PrepareTaskDiffExternalChallengeResponseInput,
): TaskDiffExternalChallengeResponse {
  const subject = parseSubject(input.subject);
  const response = parseChallengeResponse(input.response);
  if (response.subjectDigest !== subject.subjectDigest) throw storeInvalid();
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-challenge-response.v1' as const,
    subject,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: response.reviewRecordDigest,
    responseDigest: response.responseDigest,
    response,
  };
  return parseTaskDiffExternalChallengeResponse({
    ...body,
    recordDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalReviewSubmission(
  input: PrepareTaskDiffExternalReviewSubmissionInput,
): TaskDiffExternalReviewSubmission {
  const subject = parseSubject(input.subject);
  const reviewScope = parseReviewScope(input.reviewScope);
  const submission = parseSubmission(input.submission);
  if (reviewScope.currentSubjectDigest !== subject.subjectDigest) {
    throw storeInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-review-submission.v1' as const,
    subject,
    subjectDigest: subject.subjectDigest,
    reviewScope,
    reviewScopeDigest: reviewScope.scopeDigest,
    submission,
    inputDigest: assertDigest(input.inputDigest),
  };
  return parseTaskDiffExternalReviewSubmission({
    ...body,
    recordDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalClosureSubmission(
  input: PrepareTaskDiffExternalClosureSubmissionInput,
): TaskDiffExternalClosureSubmission {
  const subject = parseSubject(input.subject);
  const submission = parseContinuationSubmission(input.submission);
  const targetDigest = taskDiffExternalContinuationTargetDigest({
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: submission.reviewRecordDigest,
    responseDigest: submission.responseDigest,
  });
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-closure-submission.v1' as const,
    targetDigest,
    subject,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: submission.reviewRecordDigest,
    responseDigest: submission.responseDigest,
    submission,
    inputDigest: assertDigest(input.inputDigest),
  };
  return parseTaskDiffExternalClosureSubmission({
    ...body,
    recordDigest: digestRecord(body),
  });
}

export function createTaskDiffExternalReviewReservation(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalReviewReservationInput,
): TaskDiffExternalReviewReservation {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalReviewReservation(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalReviewReservationPath(
      paths,
      prepared.subjectDigest,
      prepared.grant.grantEnvelopeDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_REVIEW_RESERVATION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewReservation(
    paths,
    prepared.subjectDigest,
    prepared.grant.grantEnvelopeDigest,
  )!;
}

export function createTaskDiffExternalReviewBinding(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalReviewBindingInput,
): TaskDiffExternalReviewBinding {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalReviewBinding(input);
  const reservation = readTaskDiffExternalReviewReservationInternal(
    paths,
    prepared.subjectDigest,
    prepared.grant.grantEnvelopeDigest,
  );
  if (
    reservation === null ||
    !reviewBindingMatchesReservation(prepared, reservation)
  ) {
    throw storeInvalid();
  }
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalReviewBindingPath(paths, prepared.subjectDigest),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_REVIEW_BINDING_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewBinding(paths, prepared.subjectDigest)!;
}

export function createTaskDiffExternalContinuationReservation(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalContinuationReservationInput,
): TaskDiffExternalContinuationReservation {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalContinuationReservation(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalContinuationReservationPath(
      paths,
      prepared.targetDigest,
      prepared.grant.grantEnvelopeDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CONTINUATION_RESERVATION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalContinuationReservation(
    paths,
    prepared.targetDigest,
    prepared.grant.grantEnvelopeDigest,
  )!;
}

export function createTaskDiffExternalContinuationBinding(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalContinuationBindingInput,
): TaskDiffExternalContinuationBinding {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalContinuationBinding(input);
  const reservation = readTaskDiffExternalContinuationReservationInternal(
    paths,
    prepared.targetDigest,
    prepared.grant.grantEnvelopeDigest,
  );
  if (
    reservation === null ||
    !continuationBindingMatchesReservation(prepared, reservation)
  ) {
    throw storeInvalid();
  }
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalContinuationBindingPath(paths, prepared.targetDigest),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CONTINUATION_BINDING_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalContinuationBinding(paths, prepared.targetDigest)!;
}

export function createTaskDiffExternalChallengeResponse(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalChallengeResponseInput,
): TaskDiffExternalChallengeResponse {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalChallengeResponse(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalChallengeResponsePath(
      paths,
      prepared.reviewRecordDigest,
      prepared.responseDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CHALLENGE_RESPONSE_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalChallengeResponse(
    paths,
    prepared.subjectDigest,
    prepared.reviewRecordDigest,
    prepared.responseDigest,
  )!;
}

export function createTaskDiffExternalReviewSubmission(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalReviewSubmissionInput,
): TaskDiffExternalReviewSubmission {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalReviewSubmission(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalReviewSubmissionPath(
      paths,
      prepared.subjectDigest,
      prepared.inputDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_REVIEW_SUBMISSION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewSubmission(
    paths,
    prepared.subjectDigest,
    prepared.reviewScopeDigest,
    prepared.inputDigest,
  )!;
}

export function createTaskDiffExternalClosureSubmission(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalClosureSubmissionInput,
): TaskDiffExternalClosureSubmission {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalClosureSubmission(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalClosureSubmissionPath(
      paths,
      prepared.targetDigest,
      prepared.inputDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CLOSURE_SUBMISSION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalClosureSubmission(
    paths,
    prepared.targetDigest,
    prepared.inputDigest,
  )!;
}

export function readTaskDiffExternalReviewReservation(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalReviewReservation | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewReservationInternal(
    paths,
    requestedSubjectDigest,
    requestedGrantEnvelopeDigest,
  );
}

export function listTaskDiffExternalReviewReservations(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): readonly TaskDiffExternalReviewReservation[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'review-reservations',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const records = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = ATTEMPT_FILE.exec(fileName);
      if (!match || match[1] !== subjectDigest) return [];
      return [
        parseTaskDiffExternalReviewReservation(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        ),
      ];
    });
  return Object.freeze(records);
}

export function readTaskDiffExternalReviewBinding(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): TaskDiffExternalReviewBinding | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffExternalReviewBindingPath(paths, subjectDigest);
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const binding = parseTaskDiffExternalReviewBinding(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  const reservation = readTaskDiffExternalReviewReservationInternal(
    paths,
    subjectDigest,
    binding.grant.grantEnvelopeDigest,
  );
  if (
    binding.subjectDigest !== subjectDigest ||
    reservation === null ||
    !reviewBindingMatchesReservation(binding, reservation)
  ) {
    throw storeInvalid();
  }
  return binding;
}

/** List only canonical successful review bindings, never grant attempts. */
export function listTaskDiffExternalReviewBindings(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffExternalReviewBinding[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'review-bindings',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  return Object.freeze(
    fs
      .readdirSync(directory)
      .sort()
      .map((fileName) => {
        const match = DIGEST_FILE.exec(fileName);
        if (!match) throw storeInvalid();
        const binding = parseTaskDiffExternalReviewBinding(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        );
        if (binding.subjectDigest !== match[1]) throw storeInvalid();
        return binding;
      }),
  );
}

export function readTaskDiffExternalContinuationReservation(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalContinuationReservation | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalContinuationReservationInternal(
    paths,
    requestedTargetDigest,
    requestedGrantEnvelopeDigest,
  );
}

export function listTaskDiffExternalContinuationReservations(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
): readonly TaskDiffExternalContinuationReservation[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const targetDigest = assertDigest(requestedTargetDigest);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-reservations',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const records = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = ATTEMPT_FILE.exec(fileName);
      if (!match || match[1] !== targetDigest) return [];
      return [
        parseTaskDiffExternalContinuationReservation(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        ),
      ];
    });
  return Object.freeze(records);
}

/** List every immutable external continuation attempt, sorted by store key. */
export function listAllTaskDiffExternalContinuationReservations(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffExternalContinuationReservation[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-reservations',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  return Object.freeze(
    fs
      .readdirSync(directory)
      .sort()
      .map((fileName) => {
        const match = ATTEMPT_FILE.exec(fileName);
        if (!match) throw storeInvalid();
        const reservation = parseTaskDiffExternalContinuationReservation(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        );
        if (
          reservation.targetDigest !== match[1] ||
          reservation.grant.grantEnvelopeDigest !== match[2]
        ) {
          throw storeInvalid();
        }
        return reservation;
      }),
  );
}

export function readTaskDiffExternalContinuationBinding(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
): TaskDiffExternalContinuationBinding | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const targetDigest = assertDigest(requestedTargetDigest);
  const target = taskDiffExternalContinuationBindingPath(paths, targetDigest);
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const binding = parseTaskDiffExternalContinuationBinding(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  const reservation = readTaskDiffExternalContinuationReservationInternal(
    paths,
    targetDigest,
    binding.grant.grantEnvelopeDigest,
  );
  if (
    binding.targetDigest !== targetDigest ||
    reservation === null ||
    !continuationBindingMatchesReservation(binding, reservation)
  ) {
    throw storeInvalid();
  }
  return binding;
}

/** List only canonical successful continuation bindings, never grant attempts. */
export function listAllTaskDiffExternalContinuationBindings(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffExternalContinuationBinding[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-bindings',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  return Object.freeze(
    fs
      .readdirSync(directory)
      .sort()
      .map((fileName) => {
        const match = DIGEST_FILE.exec(fileName);
        if (!match) throw storeInvalid();
        const binding = parseTaskDiffExternalContinuationBinding(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        );
        if (binding.targetDigest !== match[1]) throw storeInvalid();
        return binding;
      }),
  );
}

export function readTaskDiffExternalChallengeResponse(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedReviewRecordDigest: string,
  requestedResponseDigest?: string,
): TaskDiffExternalChallengeResponse | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const reviewRecordDigest = assertDigest(requestedReviewRecordDigest);
  if (requestedResponseDigest !== undefined) {
    const responseDigest = assertDigest(requestedResponseDigest);
    const target = taskDiffExternalChallengeResponsePath(
      paths,
      reviewRecordDigest,
      responseDigest,
    );
    if (!privatePathExists(paths, target, storeInvalid)) return null;
    const response = parseTaskDiffExternalChallengeResponse(
      readPrivateCanonicalJson(paths, target, storeInvalid),
    );
    if (
      response.subjectDigest !== subjectDigest ||
      response.reviewRecordDigest !== reviewRecordDigest ||
      response.responseDigest !== responseDigest
    ) {
      throw storeInvalid();
    }
    return response;
  }
  const directory = path.join(taskDiffExternalStoreRoot(paths), 'responses');
  if (!fs.existsSync(directory)) return null;
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const matches = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = SCOPED_FILE.exec(fileName);
      if (!match || match[1] !== reviewRecordDigest) return [];
      const response = parseTaskDiffExternalChallengeResponse(
        readPrivateCanonicalJson(
          paths,
          path.join(directory, fileName),
          storeInvalid,
        ),
      );
      return response.subjectDigest === subjectDigest ? [response] : [];
    });
  if (matches.length > 1) throw storeInvalid();
  return matches[0] ?? null;
}

export function readTaskDiffExternalReviewSubmission(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedReviewScopeDigest: string,
  requestedInputDigest?: string,
): TaskDiffExternalReviewSubmission | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const reviewScopeDigest = assertDigest(requestedReviewScopeDigest);
  if (requestedInputDigest !== undefined) {
    const inputDigest = assertDigest(requestedInputDigest);
    const target = taskDiffExternalReviewSubmissionPath(
      paths,
      subjectDigest,
      inputDigest,
    );
    if (!privatePathExists(paths, target, storeInvalid)) return null;
    const submission = parseTaskDiffExternalReviewSubmission(
      readPrivateCanonicalJson(paths, target, storeInvalid),
    );
    if (
      submission.subjectDigest !== subjectDigest ||
      submission.reviewScopeDigest !== reviewScopeDigest ||
      submission.inputDigest !== inputDigest
    ) {
      throw storeInvalid();
    }
    return submission;
  }
  const directory = path.join(taskDiffExternalStoreRoot(paths), 'submissions');
  if (!fs.existsSync(directory)) return null;
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const matches = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = SCOPED_FILE.exec(fileName);
      if (!match || match[1] !== subjectDigest) return [];
      const submission = parseTaskDiffExternalReviewSubmission(
        readPrivateCanonicalJson(
          paths,
          path.join(directory, fileName),
          storeInvalid,
        ),
      );
      return submission.reviewScopeDigest === reviewScopeDigest
        ? [submission]
        : [];
    });
  if (matches.length > 1) throw storeInvalid();
  return matches[0] ?? null;
}

export function readTaskDiffExternalClosureSubmission(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedInputDigest: string,
): TaskDiffExternalClosureSubmission | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const targetDigest = assertDigest(requestedTargetDigest);
  const inputDigest = assertDigest(requestedInputDigest);
  const target = taskDiffExternalClosureSubmissionPath(
    paths,
    targetDigest,
    inputDigest,
  );
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const submission = parseTaskDiffExternalClosureSubmission(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  if (
    submission.targetDigest !== targetDigest ||
    submission.inputDigest !== inputDigest
  ) {
    throw storeInvalid();
  }
  return submission;
}

export function parseTaskDiffExternalReviewReservation(
  value: unknown,
): TaskDiffExternalReviewReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'targetDigest',
      'subject',
      'subjectDigest',
      'policyDigest',
      'inputDigest',
      'reviewScopeDigest',
      'submissionRecordDigest',
      'contentNodeId',
      'contentResultDigest',
      'implementationActor',
      'grant',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-review-reservation.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const record: TaskDiffExternalReviewReservation = {
    schemaVersion: 1,
    kind: 'task-diff-external-review-reservation.v1',
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    inputDigest: assertDigest(value.inputDigest),
    reviewScopeDigest: assertDigest(value.reviewScopeDigest),
    submissionRecordDigest: assertDigest(value.submissionRecordDigest),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    implementationActor: parseRecordedParticipant(value.implementationActor),
    grant: parseGrantReference(value.grant),
  };
  if (
    record.targetDigest !== subject.subjectDigest ||
    record.subjectDigest !== subject.subjectDigest ||
    record.policyDigest !== subject.reviewPolicyDigest ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.reservationDigest !==
      digestRecord(withoutDigest(record, 'reservationDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalReviewBinding(
  value: unknown,
): TaskDiffExternalReviewBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'reservationDigest',
      'targetDigest',
      'subjectDigest',
      'policyDigest',
      'inputDigest',
      'reviewScopeDigest',
      'submissionRecordDigest',
      'grant',
      'grantUseDigest',
      'admittedRoleResultDigest',
      'directHumanReviewAttestationDigest',
      'contentNodeId',
      'contentResultDigest',
      'authorityNodeId',
      'authorityResultDigest',
      'reviewRecordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-review-binding.v1'
  ) {
    throw storeInvalid();
  }
  const grant = parseGrantReference(value.grant);
  const record: TaskDiffExternalReviewBinding = {
    schemaVersion: 1,
    kind: 'task-diff-external-review-binding.v1',
    bindingDigest: assertDigest(value.bindingDigest),
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    inputDigest: assertDigest(value.inputDigest),
    reviewScopeDigest: assertDigest(value.reviewScopeDigest),
    submissionRecordDigest: assertDigest(value.submissionRecordDigest),
    grant,
    grantUseDigest: assertDigest(value.grantUseDigest),
    admittedRoleResultDigest: assertDigest(value.admittedRoleResultDigest),
    directHumanReviewAttestationDigest: parseAttestationDigest(
      grant.degradedForm,
      value.directHumanReviewAttestationDigest,
    ),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    authorityNodeId: assertDigest(value.authorityNodeId),
    authorityResultDigest: assertDigest(value.authorityResultDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
  };
  if (
    record.targetDigest !== record.subjectDigest ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.bindingDigest !==
      digestRecord(withoutDigest(record, 'bindingDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalContinuationReservation(
  value: unknown,
): TaskDiffExternalContinuationReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'targetDigest',
      'subject',
      'subjectDigest',
      'policyDigest',
      'reviewRecordDigest',
      'responseDigest',
      'inputDigest',
      'contentNodeId',
      'contentResultDigest',
      'grant',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-continuation-reservation.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const record: TaskDiffExternalContinuationReservation = {
    schemaVersion: 1,
    kind: 'task-diff-external-continuation-reservation.v1',
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    inputDigest: assertDigest(value.inputDigest),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    grant: parseGrantReference(value.grant),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    record.policyDigest !== subject.reviewPolicyDigest ||
    record.targetDigest !== taskDiffExternalContinuationTargetDigest(record) ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.reservationDigest !==
      digestRecord(withoutDigest(record, 'reservationDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalContinuationBinding(
  value: unknown,
): TaskDiffExternalContinuationBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'reservationDigest',
      'targetDigest',
      'subjectDigest',
      'policyDigest',
      'reviewRecordDigest',
      'responseDigest',
      'inputDigest',
      'contentNodeId',
      'contentResultDigest',
      'grant',
      'grantUseDigest',
      'admittedRoleResultDigest',
      'directHumanReviewAttestationDigest',
      'authorityNodeId',
      'authorityResultDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-continuation-binding.v1'
  ) {
    throw storeInvalid();
  }
  const grant = parseGrantReference(value.grant);
  const record: TaskDiffExternalContinuationBinding = {
    schemaVersion: 1,
    kind: 'task-diff-external-continuation-binding.v1',
    bindingDigest: assertDigest(value.bindingDigest),
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    inputDigest: assertDigest(value.inputDigest),
    grant,
    grantUseDigest: assertDigest(value.grantUseDigest),
    admittedRoleResultDigest: assertDigest(value.admittedRoleResultDigest),
    directHumanReviewAttestationDigest: parseAttestationDigest(
      grant.degradedForm,
      value.directHumanReviewAttestationDigest,
    ),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    authorityNodeId: assertDigest(value.authorityNodeId),
    authorityResultDigest: assertDigest(value.authorityResultDigest),
  };
  if (
    record.targetDigest !== taskDiffExternalContinuationTargetDigest(record) ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.bindingDigest !==
      digestRecord(withoutDigest(record, 'bindingDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalChallengeResponse(
  value: unknown,
): TaskDiffExternalChallengeResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'subject',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'response',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-challenge-response.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const response = parseChallengeResponse(value.response);
  const record: TaskDiffExternalChallengeResponse = {
    schemaVersion: 1,
    kind: 'task-diff-external-challenge-response.v1',
    recordDigest: assertDigest(value.recordDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    response,
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    response.subjectDigest !== subject.subjectDigest ||
    record.reviewRecordDigest !== response.reviewRecordDigest ||
    record.responseDigest !== response.responseDigest ||
    record.recordDigest !== digestRecord(withoutDigest(record, 'recordDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalReviewSubmission(
  value: unknown,
): TaskDiffExternalReviewSubmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'subject',
      'subjectDigest',
      'reviewScope',
      'reviewScopeDigest',
      'submission',
      'inputDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-review-submission.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const reviewScope = parseReviewScope(value.reviewScope);
  const record: TaskDiffExternalReviewSubmission = {
    schemaVersion: 1,
    kind: 'task-diff-external-review-submission.v1',
    recordDigest: assertDigest(value.recordDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    reviewScope,
    reviewScopeDigest: assertDigest(value.reviewScopeDigest),
    submission: parseSubmission(value.submission),
    inputDigest: assertDigest(value.inputDigest),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    reviewScope.currentSubjectDigest !== subject.subjectDigest ||
    record.reviewScopeDigest !== reviewScope.scopeDigest ||
    record.recordDigest !== digestRecord(withoutDigest(record, 'recordDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalClosureSubmission(
  value: unknown,
): TaskDiffExternalClosureSubmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'targetDigest',
      'subject',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'submission',
      'inputDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-closure-submission.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const submission = parseContinuationSubmission(value.submission);
  const record: TaskDiffExternalClosureSubmission = {
    schemaVersion: 1,
    kind: 'task-diff-external-closure-submission.v1',
    recordDigest: assertDigest(value.recordDigest),
    targetDigest: assertDigest(value.targetDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    submission,
    inputDigest: assertDigest(value.inputDigest),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    record.reviewRecordDigest !== submission.reviewRecordDigest ||
    record.responseDigest !== submission.responseDigest ||
    record.targetDigest !== taskDiffExternalContinuationTargetDigest(record) ||
    record.recordDigest !== digestRecord(withoutDigest(record, 'recordDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

/**
 * Validate the whole external-authority namespace before trusting any entry.
 * Unknown directories/files, malformed keys, symlinks, non-private files,
 * non-canonical JSON, invalid digests, or orphaned bindings all fail closed.
 */
export function assertTaskDiffExternalReviewStoreInventory(
  paths: InvestigationRuntimePaths,
): void {
  const root = taskDiffExternalStoreRoot(paths);
  const observed = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!observed) return;
  assertPrivateInvestigationDirectory(paths, root, storeInvalid);
  const rootNames = fs.readdirSync(root).sort();
  if (
    rootNames.some(
      (name) =>
        !STORE_DIRECTORIES.includes(name as (typeof STORE_DIRECTORIES)[number]),
    )
  ) {
    throw storeInvalid();
  }

  const reviewReservations = new Map<
    string,
    TaskDiffExternalReviewReservation
  >();
  const reviewBindings = new Map<string, TaskDiffExternalReviewBinding>();
  const continuationReservations = new Map<
    string,
    TaskDiffExternalContinuationReservation
  >();
  const continuationBindings = new Map<
    string,
    TaskDiffExternalContinuationBinding
  >();
  const responses = new Map<string, TaskDiffExternalChallengeResponse>();
  const submissions = new Map<string, TaskDiffExternalReviewSubmission>();
  const closureSubmissions = new Map<
    string,
    TaskDiffExternalClosureSubmission
  >();

  for (const directoryName of rootNames) {
    const directory = path.join(root, directoryName);
    assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
    for (const fileName of fs.readdirSync(directory).sort()) {
      const match =
        directoryName === 'review-reservations' ||
        directoryName === 'continuation-reservations'
          ? ATTEMPT_FILE.exec(fileName)
          : directoryName === 'responses' ||
              directoryName === 'submissions' ||
              directoryName === 'closure-submissions'
            ? SCOPED_FILE.exec(fileName)
            : DIGEST_FILE.exec(fileName);
      if (!match) throw storeInvalid();
      const key = match[1]!;
      const value = readPrivateCanonicalJson(
        paths,
        path.join(directory, fileName),
        storeInvalid,
      );
      if (directoryName === 'review-reservations') {
        const record = parseTaskDiffExternalReviewReservation(value);
        const attemptKey = `${key}:${match[2]!}`;
        if (
          record.subjectDigest !== key ||
          record.grant.grantEnvelopeDigest !== match[2] ||
          reviewReservations.has(attemptKey)
        ) {
          throw storeInvalid();
        }
        reviewReservations.set(attemptKey, record);
      } else if (directoryName === 'review-bindings') {
        const record = parseTaskDiffExternalReviewBinding(value);
        if (record.subjectDigest !== key || reviewBindings.has(key)) {
          throw storeInvalid();
        }
        reviewBindings.set(key, record);
      } else if (directoryName === 'continuation-reservations') {
        const record = parseTaskDiffExternalContinuationReservation(value);
        const attemptKey = `${key}:${match[2]!}`;
        if (
          record.targetDigest !== key ||
          record.grant.grantEnvelopeDigest !== match[2] ||
          continuationReservations.has(attemptKey)
        ) {
          throw storeInvalid();
        }
        continuationReservations.set(attemptKey, record);
      } else if (directoryName === 'continuation-bindings') {
        const record = parseTaskDiffExternalContinuationBinding(value);
        if (record.targetDigest !== key || continuationBindings.has(key)) {
          throw storeInvalid();
        }
        continuationBindings.set(key, record);
      } else if (directoryName === 'responses') {
        const record = parseTaskDiffExternalChallengeResponse(value);
        const responseKey = `${key}:${match[2]!}`;
        if (
          record.reviewRecordDigest !== key ||
          record.responseDigest !== match[2] ||
          responses.has(responseKey)
        ) {
          throw storeInvalid();
        }
        responses.set(responseKey, record);
      } else if (directoryName === 'submissions') {
        const record = parseTaskDiffExternalReviewSubmission(value);
        const submissionKey = `${key}:${match[2]!}`;
        if (
          record.subjectDigest !== key ||
          record.inputDigest !== match[2] ||
          submissions.has(submissionKey)
        ) {
          throw storeInvalid();
        }
        submissions.set(submissionKey, record);
      } else if (directoryName === 'closure-submissions') {
        const record = parseTaskDiffExternalClosureSubmission(value);
        const submissionKey = `${key}:${match[2]!}`;
        if (
          record.targetDigest !== key ||
          record.inputDigest !== match[2] ||
          closureSubmissions.has(submissionKey)
        ) {
          throw storeInvalid();
        }
        closureSubmissions.set(submissionKey, record);
      } else {
        throw storeInvalid();
      }
    }
  }

  for (const [key, binding] of reviewBindings) {
    const reservation = reviewReservations.get(
      `${key}:${binding.grant.grantEnvelopeDigest}`,
    );
    if (
      reservation === undefined ||
      !reviewBindingMatchesReservation(binding, reservation)
    ) {
      throw storeInvalid();
    }
  }
  for (const reservation of reviewReservations.values()) {
    const submission = submissions.get(
      `${reservation.subjectDigest}:${reservation.inputDigest}`,
    );
    if (
      submission === undefined ||
      submission.recordDigest !== reservation.submissionRecordDigest ||
      submission.inputDigest !== reservation.inputDigest
    ) {
      throw storeInvalid();
    }
  }
  for (const [key, binding] of continuationBindings) {
    const reservation = continuationReservations.get(
      `${key}:${binding.grant.grantEnvelopeDigest}`,
    );
    if (
      reservation === undefined ||
      !continuationBindingMatchesReservation(binding, reservation)
    ) {
      throw storeInvalid();
    }
  }
  for (const reservation of continuationReservations.values()) {
    const submission = closureSubmissions.get(
      `${reservation.targetDigest}:${reservation.inputDigest}`,
    );
    if (
      submission === undefined ||
      submission.subjectDigest !== reservation.subjectDigest ||
      submission.reviewRecordDigest !== reservation.reviewRecordDigest ||
      submission.responseDigest !== reservation.responseDigest
    ) {
      throw storeInvalid();
    }
  }
  const grantIds = new Set<string>();
  const grantEnvelopeDigests = new Set<string>();
  for (const reservation of [
    ...reviewReservations.values(),
    ...continuationReservations.values(),
  ]) {
    if (
      grantIds.has(reservation.grant.grantId) ||
      grantEnvelopeDigests.has(reservation.grant.grantEnvelopeDigest)
    ) {
      throw storeInvalid();
    }
    grantIds.add(reservation.grant.grantId);
    grantEnvelopeDigests.add(reservation.grant.grantEnvelopeDigest);
  }
}

export function taskDiffExternalReviewReservationPath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedGrantEnvelopeDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'review-reservations',
    `${assertDigest(requestedSubjectDigest)}.${assertDigest(requestedGrantEnvelopeDigest)}.json`,
  );
}

export function taskDiffExternalReviewBindingPath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'review-bindings',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function taskDiffExternalContinuationReservationPath(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedGrantEnvelopeDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-reservations',
    `${assertDigest(requestedTargetDigest)}.${assertDigest(requestedGrantEnvelopeDigest)}.json`,
  );
}

export function taskDiffExternalContinuationBindingPath(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-bindings',
    `${assertDigest(requestedTargetDigest)}.json`,
  );
}

export function taskDiffExternalChallengeResponsePath(
  paths: InvestigationRuntimePaths,
  requestedReviewRecordDigest: string,
  requestedResponseDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'responses',
    `${assertDigest(requestedReviewRecordDigest)}.${assertDigest(requestedResponseDigest)}.json`,
  );
}

export function taskDiffExternalReviewSubmissionPath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedInputDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'submissions',
    `${assertDigest(requestedSubjectDigest)}.${assertDigest(requestedInputDigest)}.json`,
  );
}

export function taskDiffExternalClosureSubmissionPath(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedInputDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'closure-submissions',
    `${assertDigest(requestedTargetDigest)}.${assertDigest(requestedInputDigest)}.json`,
  );
}

function taskDiffExternalStoreRoot(paths: InvestigationRuntimePaths): string {
  return path.join(paths.refs, 'task-diff-reviews', 'external-authority');
}

function readTaskDiffExternalReviewReservationInternal(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalReviewReservation | null {
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const grantEnvelopeDigest = assertDigest(requestedGrantEnvelopeDigest);
  const target = taskDiffExternalReviewReservationPath(
    paths,
    subjectDigest,
    grantEnvelopeDigest,
  );
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const reservation = parseTaskDiffExternalReviewReservation(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  if (
    reservation.subjectDigest !== subjectDigest ||
    reservation.grant.grantEnvelopeDigest !== grantEnvelopeDigest
  ) {
    throw storeInvalid();
  }
  return reservation;
}

function readTaskDiffExternalContinuationReservationInternal(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalContinuationReservation | null {
  const targetDigest = assertDigest(requestedTargetDigest);
  const grantEnvelopeDigest = assertDigest(requestedGrantEnvelopeDigest);
  const target = taskDiffExternalContinuationReservationPath(
    paths,
    targetDigest,
    grantEnvelopeDigest,
  );
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const reservation = parseTaskDiffExternalContinuationReservation(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  if (
    reservation.targetDigest !== targetDigest ||
    reservation.grant.grantEnvelopeDigest !== grantEnvelopeDigest
  ) {
    throw storeInvalid();
  }
  return reservation;
}

function reviewBindingMatchesReservation(
  binding: TaskDiffExternalReviewBinding,
  reservation: TaskDiffExternalReviewReservation,
): boolean {
  return (
    binding.reservationDigest === reservation.reservationDigest &&
    binding.targetDigest === reservation.targetDigest &&
    binding.subjectDigest === reservation.subjectDigest &&
    binding.policyDigest === reservation.policyDigest &&
    binding.inputDigest === reservation.inputDigest &&
    binding.reviewScopeDigest === reservation.reviewScopeDigest &&
    binding.submissionRecordDigest === reservation.submissionRecordDigest &&
    binding.contentNodeId === reservation.contentNodeId &&
    binding.contentResultDigest === reservation.contentResultDigest &&
    canonicalJson(binding.grant) === canonicalJson(reservation.grant)
  );
}

function continuationBindingMatchesReservation(
  binding: TaskDiffExternalContinuationBinding,
  reservation: TaskDiffExternalContinuationReservation,
): boolean {
  return (
    binding.reservationDigest === reservation.reservationDigest &&
    binding.targetDigest === reservation.targetDigest &&
    binding.subjectDigest === reservation.subjectDigest &&
    binding.policyDigest === reservation.policyDigest &&
    binding.reviewRecordDigest === reservation.reviewRecordDigest &&
    binding.responseDigest === reservation.responseDigest &&
    binding.inputDigest === reservation.inputDigest &&
    binding.contentNodeId === reservation.contentNodeId &&
    binding.contentResultDigest === reservation.contentResultDigest &&
    canonicalJson(binding.grant) === canonicalJson(reservation.grant)
  );
}

function parseSubject(value: unknown): TaskDiffReviewSubject {
  try {
    return parseTaskDiffReviewSubject(value);
  } catch {
    throw storeInvalid();
  }
}

function parseChallengeResponse(
  value: unknown,
): TaskDiffReviewChallengeResponseRecord {
  try {
    return parseTaskDiffReviewChallengeResponseRecord(value);
  } catch {
    throw storeInvalid();
  }
}

function parseReviewScope(value: unknown): TaskDiffReviewScope {
  try {
    return parseTaskDiffReviewScope(value);
  } catch {
    throw storeInvalid();
  }
}

function parseRecordedParticipant(value: unknown): RecordedRoleParticipant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    (value.providerId !== null &&
      value.providerId !== 'codex' &&
      value.providerId !== 'claude') ||
    (value.sessionId !== null &&
      (typeof value.sessionId !== 'string' || value.sessionId.length === 0)) ||
    (value.principalId !== null &&
      (typeof value.principalId !== 'string' ||
        value.principalId.length === 0)) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw storeInvalid();
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

function parseSubmission(value: unknown): TaskDiffReviewSubmission {
  try {
    return parseTaskDiffReviewSubmission(value);
  } catch {
    throw storeInvalid();
  }
}

function parseContinuationSubmission(
  value: unknown,
): TaskDiffReviewContinuationSubmission {
  try {
    return parseTaskDiffReviewContinuationSubmission(value);
  } catch {
    throw storeInvalid();
  }
}

function parseGrantReference(value: unknown): TaskDiffExternalGrantReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'degradedForm',
      'grantId',
      'grantEnvelopeDigest',
      'grantTransitionDigest',
      'grantTargetDigest',
    ]) ||
    (value.degradedForm !== 'caller-supplied' &&
      value.degradedForm !== 'direct-human-review') ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    degradedForm: value.degradedForm,
    grantId: value.grantId,
    grantEnvelopeDigest: assertDigest(value.grantEnvelopeDigest),
    grantTransitionDigest: assertDigest(value.grantTransitionDigest),
    grantTargetDigest: assertDigest(value.grantTargetDigest),
  });
}

function parseAttestationDigest(
  degradedForm: TaskDiffExternalDegradedForm,
  value: unknown,
): string | null {
  if (degradedForm === 'caller-supplied') {
    if (value !== null) throw storeInvalid();
    return null;
  }
  return assertDigest(value);
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw storeInvalid();
  }
  return value;
}

function digestRecord(value: unknown): string {
  return sha256(canonicalJson(value));
}

function withoutDigest<T extends Record<string, unknown>>(
  value: T,
  key: keyof T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== key),
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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return canonicalJson(actual) === canonicalJson(expected);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function storeInvalid() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID',
    'TaskDiff external review authority state is invalid.',
    ExitCode.verification,
    {
      recovery:
        'Inspect the exact collaboration grant, external review reservation, and admitted role-result evidence; do not edit runtime records by hand.',
    },
  );
}
