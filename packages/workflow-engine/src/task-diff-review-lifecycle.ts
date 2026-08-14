import crypto from 'node:crypto';

import { resolveActorIdentity } from './actor-identity.ts';
import { parseAiAdapterPolicyDocument } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  collaborationGrantEnvelopeDigest,
  bindingFromPayload,
  canonicalCollaborationGrantEnvelope,
  collaborationPolicyDigestForPhase,
  createDirectHumanReviewAttestation,
  parseCollaborationGrantEnvelope,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
  type DirectHumanReviewAttestation,
} from './collaboration-grant.ts';
import {
  consumeCollaborationGrantUnderLifecycleLock,
  failCollaborationReservationUnderLifecycleLock,
  listCollaborationGrantInspections,
  readCollaborationGrantInspection,
  readExactConsumedCollaborationGrantUse,
  readReservedCollaborationGrant,
  reserveCollaborationGrantUnderLifecycleLock,
  selectAndReserveCollaborationGrantUnderLifecycleLock,
  validateCollaborationGrantUseProjection,
  type CollaborationGrantUseProjection,
  type CollaborationGrantSelectionCoreBinding,
} from './collaboration-grant-store.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from './evidence-object-store.ts';
import { createEvidenceNode } from './evidence-node.ts';
import type { DocumentationReviewCapture } from './documentation-closure.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { readFinalizeTransaction } from './finalize-transaction.ts';
import {
  assertDocumentationClosureActivation,
  documentationClosureActivationAtCommit,
  readDocumentationClosureActivationMarkerFile,
} from './documentation-closure-activation.ts';
import {
  findExactTaskCommits,
  listStagedPaths,
  previewExactStaging,
} from './git-transitions.ts';
import { fingerprintUnstagedRepositoryProjection, runGit } from './git.ts';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import { completionDocumentPaths } from './managed-documents.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
  verifySshSignatureWithPublicKey,
} from './maintainer-signer.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
} from './path-role-registry.ts';
import { createProviderInvocationRequest } from './provider-contracts.ts';
import {
  createProviderInvocation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  type TaskDiffReviewContinuationManifest,
  type TaskDiffReviewManifest,
} from './provider-invocation-store.ts';
import type { ProviderId } from './provider-registry.ts';
import {
  assertAuthorizedReviewChallengeClosure,
  type Challenge,
  type ChallengeClosure,
} from './review-challenge.ts';
import {
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
} from './report-validation.ts';
import {
  admitRoleResult,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type AdmittedRoleResult,
  type GrantedRoleAssignment,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
  type RoleParticipant,
} from './role-scheduler.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from './session-store.ts';
import {
  assertTaskDiffReviewChallengeResponseCurrent,
  assertTaskDiffFinalAssuranceCurrent,
  assertTaskDiffReviewContinuationSubmissionCurrent,
  assertTaskDiffReviewContentSatisfied,
  createTaskDiffFinalAssuranceRecord,
  createTaskDiffReviewChallengeResponse,
  createTaskDiffReviewRecord,
  parseTaskDiffReviewRecord,
  parseTaskDiffReviewContinuationSubmission,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffFinalAssuranceRecord,
  type TaskDiffReviewChallengeResponseRecord,
  type TaskDiffAuthenticatedReviewerAuthority,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewRecord,
} from './task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewExternalClosureInput,
  parseTaskDiffReviewExternalClosureRequestInput,
  parseTaskDiffReviewExternalSubmissionInput,
  type TaskDiffReviewChallengeResponseInput,
  type TaskDiffReviewExternalClosureInput,
  type TaskDiffReviewExternalClosureRequestInput,
  type TaskDiffReviewExternalSubmissionInput,
} from './task-diff-review-input.ts';
import {
  createTaskDiffExternalChallengeResponse,
  createTaskDiffExternalClosureSubmission,
  createTaskDiffExternalContinuationBinding,
  createTaskDiffExternalContinuationReservation,
  createTaskDiffExternalReviewBinding,
  createTaskDiffExternalReviewReservation,
  createTaskDiffExternalReviewSubmission,
  listAllTaskDiffExternalContinuationBindings,
  listAllTaskDiffExternalContinuationReservations,
  listTaskDiffExternalContinuationReservations,
  listTaskDiffExternalReviewBindings,
  listTaskDiffExternalReviewReservations,
  readTaskDiffExternalChallengeResponse,
  readTaskDiffExternalContinuationBinding,
  readTaskDiffExternalContinuationReservation,
  readTaskDiffExternalClosureSubmission,
  readTaskDiffExternalReviewBinding,
  readTaskDiffExternalReviewReservation,
  readTaskDiffExternalReviewSubmission,
  taskDiffExternalContinuationTargetDigest,
  type TaskDiffExternalContinuationBinding,
  type TaskDiffExternalContinuationReservation,
  type TaskDiffExternalReviewBinding,
  type TaskDiffExternalReviewReservation,
} from './task-diff-review-external-store.ts';
import {
  createTaskDiffFinalAssuranceBinding,
  createTaskDiffReviewLineageSupersession,
  createTaskDiffReviewSupersession,
  createTaskDiffReviewContinuationReservation,
  createTaskDiffReviewContinuationResultBinding,
  createTaskDiffReviewReservation,
  createTaskDiffReviewResultBinding,
  listAllTaskDiffReviewResultBindings,
  listAllTaskDiffReviewReservations,
  listAllTaskDiffReviewContinuationReservations,
  listAllTaskDiffReviewContinuationResultBindings,
  listTaskDiffReviewResultBindings,
  listTaskDiffReviewLineageSupersessions,
  listTaskDiffReviewSupersessions,
  readTaskDiffFinalAssuranceBinding,
  readTaskDiffReviewContinuationReservation,
  readTaskDiffReviewContinuationResultBinding,
  readTaskDiffReviewReservation,
  readTaskDiffReviewResultBinding,
  type TaskDiffReviewContinuationReservationRecord,
  type TaskDiffReviewContinuationResultBinding,
  type TaskDiffReviewReservationRecord,
  type TaskDiffReviewResultBinding,
} from './task-diff-review-store.ts';
import {
  resolveTaskDiffReviewLineage,
  type TaskDiffReviewLineageEntry,
} from './task-diff-review-lineage.ts';
import {
  createTaskDiffReviewSubject,
  createTaskDiffDocumentationClosureRequirement,
  deriveTaskDiffReviewCandidatePlan,
  TASK_DIFF_REVIEW_POLICY_DIGEST,
  taskDiffReviewRequirement,
  type TaskDiffReviewCandidatePlan,
  type TaskDiffPathTransition,
  type TaskDiffReviewSubject,
  type TaskDiffDocumentationHint,
  type TaskDiffTreeEntry,
} from './task-diff-review.ts';
import { resolveCurrentTaskStrategyCorrection } from './task-strategy-correction.ts';
import { readTaskStrategyGreenFailureRecord } from './task-strategy-correction-store.ts';
import {
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationSubject,
} from './task-strategy-provider-contract.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationResultBinding,
} from './task-strategy-provider-store.ts';
import { readTaskStrategyTransaction } from './task-strategy-store.ts';
import {
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
  type TaskMandateBinding,
} from './task-mandate.ts';
import {
  inspectSession,
  persistSession,
  type SessionInspection,
} from './verification.ts';

export type BeginTaskDiffReviewOptions = Readonly<{
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
    directHumanReviewAttestation?: DirectHumanReviewAttestation;
  }>;
}>;

export type ReconcileTaskDiffReviewOptions = Readonly<{
  collaborationGrantValidation?: Readonly<{
    now?: Date;
    verifier?: MaintainerSignerProvider;
  }>;
  testCrashAfter?: 'result-binding-persisted';
}>;

export type SubmitExternalTaskDiffReviewOptions = Readonly<{
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
    directHumanReviewAttestation?: DirectHumanReviewAttestation;
  }>;
  testCrashAfter?: 'grant-reserved' | 'grant-consumed';
}>;

export type SubmitExternalTaskDiffReviewContinuationOptions = Readonly<{
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
    directHumanReviewAttestation?: DirectHumanReviewAttestation;
  }>;
  testCrashAfter?: 'grant-reserved' | 'grant-consumed';
}>;

export type ReconcileTaskDiffReviewContinuationOptions = Readonly<{
  testCrashAfter?: 'advisory-result-persisted';
}>;

export type TaskDiffReviewCompletionGateOptions = Readonly<{
  projectedTaskIds?: readonly string[];
  projectionSourceDigest?: string;
  authorizedTransitionPaths?: readonly string[];
  transactionId?: string;
  candidateTree?: string;
}>;

export type TaskDiffReviewLifecycleStatus =
  | Readonly<{
      state: 'not-required';
      sessionId: string;
      subject: TaskDiffReviewSubject;
    }>
  | Readonly<{
      state: 'ready';
      sessionId: string;
      subject: TaskDiffReviewSubject;
    }>
  | TaskDiffReviewCollaborationGrantRequiredStatus
  | Readonly<{
      state: 'external-grant-resume-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
    }>
  | Readonly<{
      state: 'direct-human-attestation-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      reviewScopeDigest: string;
      submissionRecordDigest: string;
      reviewNodeId: string;
      reviewResultDigest: string;
    }>
  | Readonly<{
      state: 'external-reconciliation-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      reviewScopeDigest: string;
      submissionRecordDigest: string;
      reviewNodeId: string;
      reviewResultDigest: string;
    }>
  | Readonly<{
      state:
        | 'satisfied'
        | 'challenge-response-required'
        | 'challenge-closure-required'
        | 'changes-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: GrantedRoleAssignment;
      review: TaskDiffReviewRecord;
      finalAssurance: TaskDiffFinalAssuranceRecord | null;
    }>
  | Readonly<{
      state:
        'waiting-for-provider' | 'provider-succeeded-awaiting-reconciliation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
    }>
  | Readonly<{
      state: 'provider-failed';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      failure: NonNullable<
        ReturnType<typeof readProviderInvocation>['failure']
      >;
    }>
  | Readonly<{
      state:
        | 'satisfied'
        | 'challenge-response-required'
        | 'challenge-closure-required'
        | 'changes-required';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      review: TaskDiffReviewRecord;
      finalAssurance: TaskDiffFinalAssuranceRecord | null;
    }>;

export type TaskDiffReviewCollaborationGrantRequiredStatus = Readonly<{
  state: 'collaboration-grant-required';
  sessionId: string;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  inputSchema: Readonly<{
    schemaVersion: 1;
    kind: 'collaboration-grant-selection';
    lifecyclePhase: 'task-diff-review';
    conflictingRole: 'task-diff-reviewer';
    grantRequest: CollaborationGrantRequest | null;
    allowedDegradedForms: readonly (
      'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review'
    )[];
    resumeOption: '--grant <grant-id>';
  }>;
}>;

export type TaskDiffReviewContinuationLifecycleStatus = Readonly<{
  state:
    | 'waiting-for-provider'
    | 'provider-succeeded-awaiting-reconciliation'
    | 'provider-failed'
    | 'challenge-closure-required'
    | 'satisfied'
    | 'changes-required';
  sessionId: string;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  assignment: ProviderRoleAssignment;
  ownerInvestigationId: string;
  invocationId: string;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  finalAssurance: TaskDiffFinalAssuranceRecord | null;
  failure: NonNullable<
    ReturnType<typeof readProviderInvocation>['failure']
  > | null;
}>;

export type TaskDiffReviewExternalContinuationLifecycleStatus =
  | Readonly<{
      state: 'collaboration-grant-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      targetDigest: string;
      inputSchema: Readonly<{
        schemaVersion: 1;
        kind: 'collaboration-grant-selection';
        lifecyclePhase: 'task-diff-review';
        conflictingRole: 'task-diff-reviewer';
        grantRequest: null;
        targetDigest: string;
        subjectDigest: string;
        reviewRecordDigest: string;
        responseDigest: string;
        allowedDegradedForms: readonly (
          'caller-supplied' | 'direct-human-review'
        )[];
        resumeOption: '--grant <grant-id>';
      }>;
    }>
  | Readonly<{
      state: 'direct-human-attestation-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      contentNodeId: string;
      contentResultDigest: string;
      reviewNodeId: string;
      reviewResultDigest: string;
    }>
  | Readonly<{
      state: 'external-reconciliation-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      contentNodeId: string;
      contentResultDigest: string;
    }>
  | Readonly<{
      state: 'satisfied' | 'changes-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      finalAssurance: TaskDiffFinalAssuranceRecord;
    }>;

export type TaskDiffReviewInspectionStatus =
  | TaskDiffReviewLifecycleStatus
  | TaskDiffReviewContinuationLifecycleStatus
  | TaskDiffReviewExternalContinuationLifecycleStatus;

export type CurrentAuthenticatedTaskDiffReview = Readonly<{
  source: 'provider' | 'external';
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  implementationActor: RecordedRoleParticipant;
  authenticatedReviewAuthority: TaskDiffAuthenticatedReviewerAuthority;
  reviewResultNodeId: string;
  reviewResultDigest: string;
}>;

type ReplayedTaskDiffReviewTerminal = Readonly<{
  state: 'satisfied' | 'challenge-open' | 'changes-required';
  finalAssurance: TaskDiffFinalAssuranceRecord | null;
  commitmentDigest: string | null;
  closureSource: 'provider' | 'external' | null;
}>;

type TaskDiffReviewReplayMode = 'inspect' | 'governing';

/**
 * Reserve one exact, provider-independent TaskDiffReview. The reservation is
 * immutable and replay-safe; it does not launch the provider or advance the
 * finalize transaction.
 */
export function beginTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  options: BeginTaskDiffReviewOptions = {},
): TaskDiffReviewInspectionStatus {
  const initialSubject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
  if (!initialSubject.reviewRequirement.required) {
    return Object.freeze({
      state: 'not-required',
      sessionId: requestedSessionId,
      subject: initialSubject,
    });
  }
  const initialImplementationActor = resolveTaskDiffImplementationActor(
    cwd,
    requestedSessionId,
    initialSubject,
    options,
  );

  const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(
    initialContext.runtime,
    (assertOwned) =>
      withSessionOperation(initialContext.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
        if (canonicalJson(subject) !== canonicalJson(initialSubject)) {
          throw candidateDiverged();
        }
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const implementationActor = resolveTaskDiffImplementationActor(
          cwd,
          requestedSessionId,
          subject,
          options,
        );
        if (
          canonicalJson(implementationActor) !==
          canonicalJson(initialImplementationActor)
        ) {
          throw candidateDiverged();
        }
        const externalBinding = readTaskDiffExternalReviewBinding(
          runtime,
          subject.subjectDigest,
        );
        const providerSource = readExactProviderTaskDiffReviewSource(
          runtime,
          context.session.sessionId,
          subject.subjectDigest,
        );
        const existing = providerSource.reservation;
        if (externalBinding !== null) {
          assertNoAllSessionProviderSourceCollision(
            runtime,
            subject.subjectDigest,
          );
          if (existing !== null || providerSource.binding !== null)
            throw taskDiffReviewLineageConflict();
          assertCurrentExternalTaskDiffReviewBinding(
            context,
            runtime,
            subject,
            externalBinding,
            assertOwned,
          );
          const candidatePlan = resolveTaskDiffReviewCandidatePlan(
            context,
            runtime,
            subject,
          );
          if (candidatePlan.action !== 'reuse') {
            throw taskDiffReviewLineageConflict();
          }
          return renderReusedTaskDiffReviewStatus(
            context.session.sessionId,
            subject,
            loadReusedTaskDiffReview(runtime, context, subject, candidatePlan),
          );
        }
        const externalPending = inspectExternalTaskDiffPendingStatus(
          context,
          runtime,
          subject,
        );
        if (externalPending !== null) {
          assertNoAllSessionProviderSourceCollision(
            runtime,
            subject.subjectDigest,
          );
          if (existing !== null || providerSource.binding !== null)
            throw taskDiffReviewLineageConflict();
          return externalPending;
        }
        if (providerSource.binding !== null) {
          const candidatePlan = resolveTaskDiffReviewCandidatePlan(
            context,
            runtime,
            subject,
          );
          if (candidatePlan.action !== 'reuse') {
            throw taskDiffReviewLineageConflict();
          }
          return renderReusedTaskDiffReviewStatus(
            context.session.sessionId,
            subject,
            loadReusedTaskDiffReview(runtime, context, subject, candidatePlan),
          );
        }
        const candidatePlan =
          existing === null
            ? resolveTaskDiffReviewCandidatePlan(context, runtime, subject)
            : null;
        if (candidatePlan?.action === 'reuse') {
          return renderReusedTaskDiffReviewStatus(
            context.session.sessionId,
            subject,
            loadReusedTaskDiffReview(runtime, context, subject, candidatePlan),
          );
        }
        const created =
          existing ??
          createNewTaskDiffReviewReservation(
            context,
            runtime,
            subject,
            candidatePlan!,
            implementationActor,
            options.collaborationGrant,
            assertOwned,
          );
        if (created.kind === 'task-diff-review-collaboration-grant-required') {
          return created.status;
        }
        const reservation = created;
        assertReservationCurrent(
          context,
          subject,
          implementationActor,
          reservation,
        );
        ensureTaskDiffReviewInvocation(
          context,
          runtime,
          reservation,
          assertOwned,
        );
        assertOwned();
        return renderTaskDiffReviewStatus(runtime, reservation);
      }),
  );
}

/**
 * Admit one authority-free external review submission through a signed
 * caller-supplied or direct-human collaboration grant. Review bytes are stored
 * before authority is selected; a grant attempt is immutable and keyed by its
 * signed envelope, while the canonical subject binding is published only
 * after consumption and role-result admission succeed.
 */
export function submitExternalTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  inputCandidate: TaskDiffReviewExternalSubmissionInput,
  options: SubmitExternalTaskDiffReviewOptions = {},
): TaskDiffReviewInspectionStatus {
  const input = parseTaskDiffReviewExternalSubmissionInput(inputCandidate);
  const initialSubject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
  if (
    !initialSubject.reviewRequirement.required ||
    input.subjectDigest !== initialSubject.subjectDigest
  ) {
    throw externalTaskDiffInputStale();
  }
  const initialImplementationActor = resolveTaskDiffImplementationActor(
    cwd,
    requestedSessionId,
    initialSubject,
    options,
  );
  const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(
    initialContext.runtime,
    (assertOwned) =>
      withSessionOperation(initialContext.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
        const implementationActor = resolveTaskDiffImplementationActor(
          cwd,
          requestedSessionId,
          subject,
          options,
        );
        if (
          canonicalJson(subject) !== canonicalJson(initialSubject) ||
          canonicalJson(implementationActor) !==
            canonicalJson(initialImplementationActor) ||
          input.subjectDigest !== subject.subjectDigest
        ) {
          throw externalTaskDiffInputStale();
        }

        const inputDigest = sha256(canonicalJson(input));
        const existingBinding = readTaskDiffExternalReviewBinding(
          runtime,
          subject.subjectDigest,
        );
        const providerSource = readExactProviderTaskDiffReviewSource(
          runtime,
          context.session.sessionId,
          subject.subjectDigest,
        );
        if (existingBinding !== null) {
          assertNoAllSessionProviderSourceCollision(
            runtime,
            subject.subjectDigest,
          );
          if (
            providerSource.reservation !== null ||
            providerSource.binding !== null
          )
            throw taskDiffReviewLineageConflict();
          if (existingBinding.inputDigest !== inputDigest) {
            throw externalTaskDiffInputStale();
          }
          const current = assertCurrentExternalTaskDiffReviewBinding(
            context,
            runtime,
            subject,
            existingBinding,
            assertOwned,
          );
          bindDocumentationRemediation(cwd, requestedSessionId, current.review);
          return renderExternalTaskDiffReviewStatus(
            context,
            runtime,
            subject,
            current,
          );
        }
        if (
          providerSource.reservation !== null ||
          providerSource.binding !== null
        )
          throw taskDiffReviewLineageConflict();
        assertNoAllSessionProviderSourceCollision(
          runtime,
          subject.subjectDigest,
        );

        const candidatePlan = resolveTaskDiffReviewCandidatePlan(
          context,
          runtime,
          subject,
        );
        if (candidatePlan.action !== 'review') {
          throw externalTaskDiffLineageDeferred();
        }
        assertExternalTaskDiffProvidersUnavailable(context, subject);
        preflightExternalTaskDiffReviewSubmission(
          context.session.sessionId,
          implementationActor,
          subject,
          candidatePlan.scope,
          input.submission,
          inputDigest,
        );
        if (options.collaborationGrant === undefined) {
          return externalTaskDiffGrantRequiredStatus(
            context.session.sessionId,
            subject,
            implementationActor,
          );
        }
        const grant = options.collaborationGrant;
        const policy = parseBaselineJson(
          context.git.repositoryRoot,
          context.session.baseline.head,
          'workflow/maintainer-policy.json',
          parseMaintainerPolicy,
        );
        const verifier = grant.verifier ?? createVerifyOnlyMaintainer(policy);
        const now = grant.now ?? new Date();
        const expectedCore = externalTaskDiffGrantCore(
          context,
          subject,
          policy,
        );
        const inspectedGrant = readCollaborationGrantInspection(
          context.git.gitCommonDirectory,
          grant.grantId,
        );
        assertExternalTaskDiffAttemptMayProceed(
          context,
          runtime,
          subject.subjectDigest,
          grant.grantId,
          implementationActor,
        );
        assertExternalTaskDiffOrphanGrantMayProceed(
          context,
          runtime,
          subject,
          grant.grantId,
        );

        let reservation: TaskDiffExternalReviewReservation;
        let assignment: GrantedRoleAssignment;
        let grantUse: CollaborationGrantUseProjection;
        let expectedBinding: CollaborationGrantExpectedBinding;
        let submission: ReturnType<
          typeof createTaskDiffExternalReviewSubmission
        >;
        let contentNode: ReturnType<typeof createEvidenceNode>;
        if (inspectedGrant?.state === 'consumed' && inspectedGrant.use) {
          grantUse = inspectedGrant.use;
          expectedBinding = bindingFromPayload(grantUse.envelope.payload);
          assertExternalTaskDiffGrantBinding(
            expectedCore,
            expectedBinding,
            grantUse,
          );
          reservation = requireExternalTaskDiffReviewReservation(
            runtime,
            subject.subjectDigest,
            grantUse.signedEnvelopeDigest,
          );
          submission = createTaskDiffExternalReviewSubmission(runtime, {
            subject,
            reviewScope: candidatePlan.scope,
            submission: input.submission,
            inputDigest,
          });
          contentNode = createExternalTaskDiffReviewContentNode(
            submission,
            implementationActor,
          );
          writeEvidenceNode(runtime, contentNode);
          assertExternalTaskDiffReservationContent(
            reservation,
            submission,
            contentNode,
            implementationActor,
          );
          assignment = grantUse.assignment as GrantedRoleAssignment;
        } else {
          const selection =
            selectAndReserveCollaborationGrantUnderLifecycleLock(
              context.git.repositoryRoot,
              grant.grantId,
              {
                expectedCore,
                allowedDegradedForms: [
                  'caller-supplied',
                  'direct-human-review',
                ],
                now,
                verifier,
              },
              assertOwned,
            );
          expectedBinding = selection.expectedBinding;
          if (options.testCrashAfter === 'grant-reserved') {
            throw new Error(
              'Simulated external TaskDiffReview interruption after grant reservation.',
            );
          }
          try {
            preflightExternalTaskDiffReviewerIdentity(
              context.session.sessionId,
              implementationActor,
              expectedBinding,
              subject,
              candidatePlan.scope,
              input.submission,
            );
          } catch (error) {
            if (
              error instanceof WorkflowError &&
              error.code === 'TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'
            ) {
              failCollaborationReservationUnderLifecycleLock(
                context.git.gitCommonDirectory,
                selection.reservation.grantId,
                selection.reservation.transitionDigest,
                'External TaskDiffReview reviewer is not independent from the implementation actor.',
                now,
                assertOwned,
              );
            }
            throw error;
          }
          submission = createTaskDiffExternalReviewSubmission(runtime, {
            subject,
            reviewScope: candidatePlan.scope,
            submission: input.submission,
            inputDigest,
          });
          contentNode = createExternalTaskDiffReviewContentNode(
            submission,
            implementationActor,
          );
          writeEvidenceNode(runtime, contentNode);
          const grantReference = {
            degradedForm: expectedBinding.degradedForm as
              'caller-supplied' | 'direct-human-review',
            grantId: selection.reservation.grantId,
            grantEnvelopeDigest: collaborationGrantEnvelopeDigest(
              selection.reservation.envelope,
            ),
            grantTransitionDigest: selection.reservation.transitionDigest,
            grantTargetDigest: expectedBinding.targetDigest,
          } as const;
          reservation = createTaskDiffExternalReviewReservation(runtime, {
            subject,
            policyDigest: subject.reviewPolicyDigest,
            inputDigest,
            reviewScopeDigest: submission.reviewScopeDigest,
            submissionRecordDigest: submission.recordDigest,
            contentNodeId: contentNode.nodeId,
            contentResultDigest: contentNode.resultDigest,
            implementationActor,
            grant: grantReference,
          });
          if (
            expectedBinding.degradedForm === 'direct-human-review' &&
            grant.directHumanReviewAttestation === undefined
          ) {
            return renderExternalDirectHumanPause(
              context.session.sessionId,
              subject,
              reservation,
            );
          }
          try {
            assignment = authorizeGrantedOrdinaryRole({
              role: 'task-diff-reviewer',
              author: roleParticipantFromRecorded(implementationActor),
              targetDigest: subject.subjectDigest,
              reservation: selection.reservation,
              actualParticipant: externalParticipantFromGrant(expectedBinding),
              callableProviderIds: [],
              ...(expectedBinding.degradedForm === 'direct-human-review'
                ? {
                    directHumanReview: {
                      attestation: grant.directHumanReviewAttestation!,
                      policy,
                      verifier,
                      now,
                      reviewNodeId: contentNode.nodeId,
                      reviewResultDigest: contentNode.resultDigest,
                    },
                  }
                : {}),
            });
            createTaskDiffReviewRecord({
              subject,
              reviewScope: submission.reviewScope,
              assignment: externalTaskDiffReviewAssignment(
                context.session.sessionId,
                implementationActor,
                assignment,
                '0'.repeat(64),
              ),
              submission: submission.submission,
            });
          } catch (error) {
            if (
              error instanceof WorkflowError &&
              error.code === 'TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'
            ) {
              failCollaborationReservationUnderLifecycleLock(
                context.git.gitCommonDirectory,
                selection.reservation.grantId,
                selection.reservation.transitionDigest,
                'External TaskDiffReview reviewer is not independent from the implementation actor.',
                now,
                assertOwned,
              );
            }
            throw error;
          }
          const consumed = consumeCollaborationGrantUnderLifecycleLock(
            context.git.gitCommonDirectory,
            grant.grantId,
            {
              transitionDigest: selection.reservation.transitionDigest,
              assignment,
              contentAdmission: {
                kind: 'task-diff-review',
                nodeId: contentNode.nodeId,
                resultDigest: contentNode.resultDigest,
                current: true,
              },
              directHumanReviewAttestation:
                grant.directHumanReviewAttestation ?? null,
              now,
            },
            assertOwned,
          );
          if (consumed.use === undefined) throw reviewNotSatisfied();
          grantUse = consumed.use;
          if (options.testCrashAfter === 'grant-consumed') {
            throw new Error(
              'Simulated external TaskDiffReview interruption after grant consumption.',
            );
          }
        }

        const content = externalTaskDiffContentAdmission(contentNode, subject);
        const roleResult = admitRoleResult({
          assignment,
          author: implementationActor,
          participant: assignment.participant,
          content,
          providerInvocation: null,
          grantUse,
          grantValidation: {
            now: new Date(grantUse.envelope.payload.expiresAt),
            expectedBinding,
            policy,
            verifier,
            transitionDigest: grantUse.transitionDigest,
          },
        });
        const grantUseDigest = sha256(canonicalJson(grantUse));
        const review = createTaskDiffReviewRecord({
          subject,
          reviewScope: submission.reviewScope,
          assignment: externalTaskDiffReviewAssignment(
            context.session.sessionId,
            implementationActor,
            assignment,
            grantUseDigest,
          ),
          submission: submission.submission,
        });
        const authorityNode = createExternalTaskDiffReviewAuthorityNode({
          sessionId: context.session.sessionId,
          implementationActor,
          submission,
          contentNode,
          roleResult,
          review,
        });
        writeEvidenceNode(runtime, authorityNode);
        createTaskDiffExternalReviewBinding(runtime, {
          reservation,
          grantUseDigest,
          admittedRoleResultDigest: roleResult.resultDigest,
          directHumanReviewAttestationDigest:
            assignment.directHumanReviewAttestationDigest,
          contentNodeId: contentNode.nodeId,
          contentResultDigest: contentNode.resultDigest,
          authorityNodeId: authorityNode.nodeId,
          authorityResultDigest: authorityNode.resultDigest,
          reviewRecordDigest: review.recordDigest,
        });
        bindDocumentationRemediation(cwd, requestedSessionId, review);
        assertOwned();
        const binding = readTaskDiffExternalReviewBinding(
          runtime,
          subject.subjectDigest,
        );
        if (binding === null) throw reviewNotSatisfied();
        return renderExternalTaskDiffReviewStatus(
          context,
          runtime,
          subject,
          assertCurrentExternalTaskDiffReviewBinding(
            context,
            runtime,
            subject,
            binding,
            assertOwned,
          ),
        );
      }),
  );
}

/**
 * Admit an authority-free challenge disposition through one exact signed
 * collaboration grant. The external bytes remain advisory until the admitted
 * role result is replayed and the shared challenge-closure validator mints
 * Final Assurance.
 */
export function submitExternalTaskDiffReviewContinuation(
  cwd: string,
  requestedSessionId: string,
  responseCandidate: TaskDiffReviewChallengeResponseRecord,
  inputCandidate: TaskDiffReviewExternalClosureInput,
  options: SubmitExternalTaskDiffReviewContinuationOptions = {},
): TaskDiffReviewExternalContinuationLifecycleStatus {
  const input = parseTaskDiffReviewExternalClosureInput(inputCandidate);
  const initial = loadCurrentAuthenticatedTaskDiffReview(
    cwd,
    requestedSessionId,
  );
  const initialResponse = assertExternalTaskDiffContinuationInputCurrent(
    initial,
    responseCandidate,
    input,
  );
  const initialContext = loadActiveSessionContext(cwd, requestedSessionId);

  return withRepositoryLifecycleOperation(
    initialContext.runtime,
    (assertOwned) =>
      withSessionOperation(initialContext.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const current = loadCurrentAuthenticatedTaskDiffReview(
          cwd,
          requestedSessionId,
        );
        if (
          canonicalJson(current) !== canonicalJson(initial) ||
          canonicalJson(
            assertExternalTaskDiffContinuationInputCurrent(
              current,
              responseCandidate,
              input,
            ),
          ) !== canonicalJson(initialResponse)
        ) {
          throw externalTaskDiffInputStale();
        }
        const response = initialResponse;
        const submission = assertTaskDiffReviewContinuationSubmissionCurrent(
          current.review,
          response,
          parseTaskDiffReviewContinuationSubmission({
            schemaVersion: 1,
            reviewRecordDigest: input.reviewRecordDigest,
            responseDigest: input.responseDigest,
            proposedDispositions: input.proposedDispositions,
          }),
        );
        const inputDigest = sha256(canonicalJson(input));
        const targetDigest = taskDiffExternalContinuationTargetDigest({
          subjectDigest: current.review.subjectDigest,
          reviewRecordDigest: current.review.recordDigest,
          responseDigest: response.responseDigest,
        });
        const callableProviderIds =
          assertExternalTaskDiffContinuationProviderShortage(
            context,
            runtime,
            context.session.sessionId,
            current.review,
          );

        const existingBinding = readTaskDiffExternalContinuationBinding(
          runtime,
          targetDigest,
        );
        if (existingBinding !== null) {
          if (existingBinding.inputDigest !== inputDigest) {
            throw externalTaskDiffInputStale();
          }
          const authenticatedClosure =
            assertCurrentExternalTaskDiffContinuationBinding({
              context,
              runtime,
              current,
              response,
              binding: existingBinding,
            });
          const finalAssurance = ensureExternalTaskDiffFinalAssurance({
            runtime,
            current,
            response,
            binding: existingBinding,
            authenticatedClosure,
          });
          return renderExternalTaskDiffContinuationSatisfied(
            context.session.sessionId,
            current,
            response,
            finalAssurance,
          );
        }

        if (options.collaborationGrant === undefined) {
          return externalTaskDiffContinuationGrantRequiredStatus(
            context.session.sessionId,
            current,
            response,
            targetDigest,
          );
        }
        const requestedGrant = options.collaborationGrant;
        const policy = parseBaselineJson(
          context.git.repositoryRoot,
          current.review.subject.baseCommit,
          'workflow/maintainer-policy.json',
          parseMaintainerPolicy,
        );
        const verifier =
          requestedGrant.verifier ?? createVerifyOnlyMaintainer(policy);
        const now = requestedGrant.now ?? new Date();
        const expectedCore = externalTaskDiffContinuationGrantCore(
          context,
          current.review.subject,
          targetDigest,
          policy,
        );
        assertExternalTaskDiffContinuationAttemptMayProceed(
          context,
          runtime,
          current.review.recordDigest,
          targetDigest,
          requestedGrant.grantId,
        );
        assertExternalTaskDiffContinuationOrphanGrantMayProceed(
          context,
          runtime,
          targetDigest,
          requestedGrant.grantId,
        );
        const inspectedGrant = readCollaborationGrantInspection(
          context.git.gitCommonDirectory,
          requestedGrant.grantId,
        );

        let reservation: TaskDiffExternalContinuationReservation;
        let assignment: GrantedRoleAssignment;
        let grantUse: CollaborationGrantUseProjection;
        let expectedBinding: CollaborationGrantExpectedBinding;
        let closureSubmission: ReturnType<
          typeof createTaskDiffExternalClosureSubmission
        >;
        let contentNode: ReturnType<typeof createEvidenceNode>;

        if (inspectedGrant?.state === 'consumed' && inspectedGrant.use) {
          grantUse = inspectedGrant.use;
          expectedBinding = bindingFromPayload(grantUse.envelope.payload);
          assertExternalTaskDiffGrantBinding(
            expectedCore,
            expectedBinding,
            grantUse,
          );
          reservation = requireExternalTaskDiffContinuationReservation(
            runtime,
            targetDigest,
            grantUse.signedEnvelopeDigest,
          );
          createTaskDiffExternalChallengeResponse(runtime, {
            subject: current.review.subject,
            response,
          });
          closureSubmission = createTaskDiffExternalClosureSubmission(runtime, {
            subject: current.review.subject,
            submission,
            inputDigest,
          });
          contentNode =
            createExternalTaskDiffContinuationContentNode(closureSubmission);
          writeEvidenceNode(runtime, contentNode);
          assertExternalTaskDiffContinuationReservationContent(
            reservation,
            closureSubmission,
            contentNode,
          );
          assignment = grantUse.assignment as GrantedRoleAssignment;
        } else {
          const selection =
            selectAndReserveCollaborationGrantUnderLifecycleLock(
              context.git.repositoryRoot,
              requestedGrant.grantId,
              {
                expectedCore,
                allowedDegradedForms: [
                  'caller-supplied',
                  'direct-human-review',
                ],
                now,
                verifier,
              },
              assertOwned,
            );
          expectedBinding = selection.expectedBinding;
          if (options.testCrashAfter === 'grant-reserved') {
            throw new Error(
              'Simulated external TaskDiffReview continuation interruption after grant reservation.',
            );
          }
          try {
            preflightExternalTaskDiffChallengeClosure(
              current.review,
              submission,
              expectedBinding,
            );
          } catch (error) {
            if (
              error instanceof WorkflowError &&
              error.code === 'REVIEW_CHALLENGE_INVALID'
            ) {
              failCollaborationReservationUnderLifecycleLock(
                context.git.gitCommonDirectory,
                selection.reservation.grantId,
                selection.reservation.transitionDigest,
                'External TaskDiffReview challenge closer is not authorized for the exact review.',
                now,
                assertOwned,
              );
            }
            throw error;
          }
          createTaskDiffExternalChallengeResponse(runtime, {
            subject: current.review.subject,
            response,
          });
          closureSubmission = createTaskDiffExternalClosureSubmission(runtime, {
            subject: current.review.subject,
            submission,
            inputDigest,
          });
          contentNode =
            createExternalTaskDiffContinuationContentNode(closureSubmission);
          writeEvidenceNode(runtime, contentNode);
          const grantReference = {
            degradedForm: expectedBinding.degradedForm as
              'caller-supplied' | 'direct-human-review',
            grantId: selection.reservation.grantId,
            grantEnvelopeDigest: collaborationGrantEnvelopeDigest(
              selection.reservation.envelope,
            ),
            grantTransitionDigest: selection.reservation.transitionDigest,
            grantTargetDigest: expectedBinding.targetDigest,
          } as const;
          reservation = createTaskDiffExternalContinuationReservation(runtime, {
            subject: current.review.subject,
            policyDigest: current.review.subject.reviewPolicyDigest,
            reviewRecordDigest: current.review.recordDigest,
            responseDigest: response.responseDigest,
            inputDigest,
            contentNodeId: contentNode.nodeId,
            contentResultDigest: contentNode.resultDigest,
            grant: grantReference,
          });
          if (
            expectedBinding.degradedForm === 'direct-human-review' &&
            requestedGrant.directHumanReviewAttestation === undefined
          ) {
            return renderExternalTaskDiffContinuationDirectHumanPause(
              context.session.sessionId,
              current,
              response,
              reservation,
            );
          }
          assignment = authorizeGrantedOrdinaryRole({
            role: 'task-diff-reviewer',
            author: roleParticipantFromRecorded(current.implementationActor),
            targetDigest,
            reservation: selection.reservation,
            actualParticipant: externalParticipantFromGrant(expectedBinding),
            callableProviderIds,
            degradedAuthorityOverride: {
              kind: 'task-diff-challenge-closure',
              targetDigest,
              subjectDigest: current.review.subjectDigest,
              reviewRecordDigest: current.review.recordDigest,
              responseDigest: response.responseDigest,
            },
            ...(expectedBinding.degradedForm === 'direct-human-review'
              ? {
                  directHumanReview: {
                    attestation: requestedGrant.directHumanReviewAttestation!,
                    policy,
                    verifier,
                    now,
                    reviewNodeId: contentNode.nodeId,
                    reviewResultDigest: contentNode.resultDigest,
                  },
                }
              : {}),
          });
          const consumed = consumeCollaborationGrantUnderLifecycleLock(
            context.git.gitCommonDirectory,
            requestedGrant.grantId,
            {
              transitionDigest: selection.reservation.transitionDigest,
              assignment,
              contentAdmission: {
                kind: 'task-diff-review',
                nodeId: contentNode.nodeId,
                resultDigest: contentNode.resultDigest,
                current: true,
              },
              directHumanReviewAttestation:
                requestedGrant.directHumanReviewAttestation ?? null,
              now,
            },
            assertOwned,
          );
          if (consumed.use === undefined) throw reviewNotSatisfied();
          grantUse = consumed.use;
          if (options.testCrashAfter === 'grant-consumed') {
            throw new Error(
              'Simulated external TaskDiffReview continuation interruption after grant consumption.',
            );
          }
        }

        const content = externalTaskDiffContinuationContentAdmission(
          contentNode,
          current.review.subject,
        );
        const roleResult = admitRoleResult({
          assignment,
          author: current.implementationActor,
          participant: assignment.participant,
          content,
          providerInvocation: null,
          grantUse,
          grantValidation: {
            now: new Date(grantUse.envelope.payload.expiresAt),
            expectedBinding,
            policy,
            verifier,
            transitionDigest: grantUse.transitionDigest,
          },
        });
        const authorityNode = createExternalTaskDiffContinuationAuthorityNode({
          submission: closureSubmission,
          contentNode,
          roleResult,
        });
        writeEvidenceNode(runtime, authorityNode);
        const binding = createTaskDiffExternalContinuationBinding(runtime, {
          reservation,
          grantUseDigest: sha256(canonicalJson(grantUse)),
          admittedRoleResultDigest: roleResult.resultDigest,
          directHumanReviewAttestationDigest:
            assignment.directHumanReviewAttestationDigest,
          contentNodeId: contentNode.nodeId,
          contentResultDigest: contentNode.resultDigest,
          authorityNodeId: authorityNode.nodeId,
          authorityResultDigest: authorityNode.resultDigest,
        });
        const authenticatedClosure =
          assertCurrentExternalTaskDiffContinuationBinding({
            context,
            runtime,
            current,
            response,
            binding,
          });
        const finalAssurance = ensureExternalTaskDiffFinalAssurance({
          runtime,
          current,
          response,
          binding,
          authenticatedClosure,
        });
        assertOwned();
        return renderExternalTaskDiffContinuationSatisfied(
          context.session.sessionId,
          current,
          response,
          finalAssurance,
        );
      }),
  );
}

/**
 * Human-only continuation for an already durable direct-human TaskDiffReview
 * pause. The caller supplies only the exact authority-free input and grant ID;
 * the engine replays the reserved envelope and content reference before asking
 * the controlling maintainer to sign those exact bytes. Attestation bytes are
 * never accepted through this API.
 */
export function resumeDirectHumanTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  inputCandidate:
    | TaskDiffReviewExternalSubmissionInput
    | TaskDiffReviewExternalClosureRequestInput,
  requestedGrantId: string,
  options: Readonly<{
    now?: Date;
    signer?: MaintainerSignerProvider;
  }> = {},
):
  | TaskDiffReviewInspectionStatus
  | TaskDiffReviewExternalContinuationLifecycleStatus {
  if (inputCandidate.kind === 'task-diff-review-submission-input.v1') {
    const input = parseTaskDiffReviewExternalSubmissionInput(inputCandidate);
    return resumeDirectHumanInitialTaskDiffReview(
      cwd,
      requestedSessionId,
      input,
      requestedGrantId,
      options,
    );
  }
  const input = parseTaskDiffReviewExternalClosureRequestInput(inputCandidate);
  return resumeDirectHumanTaskDiffReviewClosure(
    cwd,
    requestedSessionId,
    input,
    requestedGrantId,
    options,
  );
}

function resumeDirectHumanInitialTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  input: TaskDiffReviewExternalSubmissionInput,
  requestedGrantId: string,
  options: Readonly<{ now?: Date; signer?: MaintainerSignerProvider }>,
): TaskDiffReviewInspectionStatus {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const inputDigest = sha256(canonicalJson(input));
  const binding = readTaskDiffExternalReviewBinding(
    runtime,
    input.subjectDigest,
  );
  if (binding !== null) {
    if (
      binding.grant.degradedForm !== 'direct-human-review' ||
      binding.grant.grantId !== requestedGrantId ||
      binding.inputDigest !== inputDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    const reservation = requireExternalTaskDiffReviewReservation(
      runtime,
      input.subjectDigest,
      binding.grant.grantEnvelopeDigest,
    );
    return submitExternalTaskDiffReview(cwd, requestedSessionId, input, {
      ...externalTaskDiffActorReplayOptions(reservation.implementationActor),
    });
  }

  const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
  if (
    status.state !== 'direct-human-attestation-required' ||
    status.source !== 'external' ||
    status.grantId !== requestedGrantId ||
    status.inputDigest !== inputDigest ||
    status.subject.subjectDigest !== input.subjectDigest
  ) {
    throw directHumanTaskDiffResumeInvalid();
  }
  const reservation = requireExternalTaskDiffReviewReservation(
    runtime,
    input.subjectDigest,
    status.grantEnvelopeDigest,
  );
  assertDirectHumanTaskDiffPause(
    context,
    reservation.grant,
    requestedGrantId,
    status.transitionDigest,
    status.reviewNodeId,
    status.reviewResultDigest,
  );
  const grant = readReservedCollaborationGrant(
    context.git.gitCommonDirectory,
    requestedGrantId,
  );
  if (
    collaborationGrantEnvelopeDigest(grant.envelope) !==
      status.grantEnvelopeDigest ||
    grant.transitionDigest !== status.transitionDigest
  ) {
    throw directHumanTaskDiffResumeInvalid();
  }
  const attestation = createDirectHumanReviewAttestation(
    cwd,
    {
      grantEnvelope: grant.envelope,
      transitionDigest: status.transitionDigest,
      reviewNodeId: status.reviewNodeId,
      reviewResultDigest: status.reviewResultDigest,
    },
    options,
  );
  return submitExternalTaskDiffReview(cwd, requestedSessionId, input, {
    ...externalTaskDiffActorReplayOptions(reservation.implementationActor),
    collaborationGrant: {
      grantId: requestedGrantId,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.signer === undefined ? {} : { verifier: options.signer }),
      directHumanReviewAttestation: attestation,
    },
  });
}

function resumeDirectHumanTaskDiffReviewClosure(
  cwd: string,
  requestedSessionId: string,
  input: TaskDiffReviewExternalClosureRequestInput,
  requestedGrantId: string,
  options: Readonly<{ now?: Date; signer?: MaintainerSignerProvider }>,
): TaskDiffReviewExternalContinuationLifecycleStatus {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const current = loadCurrentAuthenticatedTaskDiffReview(
    cwd,
    requestedSessionId,
  );
  if (
    input.subjectDigest !== current.review.subjectDigest ||
    input.reviewRecordDigest !== current.review.recordDigest
  ) {
    throw directHumanTaskDiffResumeInvalid();
  }
  const response = createTaskDiffReviewChallengeResponse({
    review: current.review,
    responses: input.responses,
  });
  const closureInput = parseTaskDiffReviewExternalClosureInput({
    schemaVersion: 1,
    kind: 'task-diff-review-closure-input.v1',
    subjectDigest: input.subjectDigest,
    reviewRecordDigest: input.reviewRecordDigest,
    responseDigest: response.responseDigest,
    proposedDispositions: input.proposedDispositions,
  });
  const inputDigest = sha256(canonicalJson(closureInput));
  const targetDigest = taskDiffExternalContinuationTargetDigest({
    subjectDigest: current.review.subjectDigest,
    reviewRecordDigest: current.review.recordDigest,
    responseDigest: response.responseDigest,
  });
  const binding = readTaskDiffExternalContinuationBinding(
    runtime,
    targetDigest,
  );
  if (binding !== null) {
    if (
      binding.grant.degradedForm !== 'direct-human-review' ||
      binding.grant.grantId !== requestedGrantId ||
      binding.inputDigest !== inputDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    return submitExternalTaskDiffReviewContinuation(
      cwd,
      requestedSessionId,
      response,
      closureInput,
    );
  }

  const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
  if (
    (status.state !== 'direct-human-attestation-required' &&
      status.state !== 'external-reconciliation-required') ||
    status.source !== 'external-continuation' ||
    status.grantId !== requestedGrantId ||
    status.inputDigest !== inputDigest ||
    status.review.recordDigest !== input.reviewRecordDigest ||
    status.response.responseDigest !== response.responseDigest
  ) {
    throw directHumanTaskDiffResumeInvalid();
  }
  const reservation = requireExternalTaskDiffContinuationReservation(
    runtime,
    targetDigest,
    status.grantEnvelopeDigest,
  );
  assertDirectHumanTaskDiffPause(
    context,
    reservation.grant,
    requestedGrantId,
    status.transitionDigest,
    status.contentNodeId,
    status.contentResultDigest,
  );

  let attestation: DirectHumanReviewAttestation;
  const grantInspection = readCollaborationGrantInspection(
    context.git.gitCommonDirectory,
    requestedGrantId,
  );
  if (status.state === 'direct-human-attestation-required') {
    if (grantInspection?.state !== 'reserved') {
      throw directHumanTaskDiffResumeInvalid();
    }
    const grant = readReservedCollaborationGrant(
      context.git.gitCommonDirectory,
      requestedGrantId,
    );
    if (
      collaborationGrantEnvelopeDigest(grant.envelope) !==
        status.grantEnvelopeDigest ||
      grant.transitionDigest !== status.transitionDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    attestation = createDirectHumanReviewAttestation(
      cwd,
      {
        grantEnvelope: grant.envelope,
        transitionDigest: status.transitionDigest,
        reviewNodeId: status.contentNodeId,
        reviewResultDigest: status.contentResultDigest,
      },
      options,
    );
  } else {
    if (
      status.degradedForm !== 'direct-human-review' ||
      grantInspection?.state !== 'consumed' ||
      grantInspection.use?.directHumanReviewAttestation === null ||
      grantInspection.use?.directHumanReviewAttestation === undefined
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    attestation = grantInspection.use.directHumanReviewAttestation;
  }
  return submitExternalTaskDiffReviewContinuation(
    cwd,
    requestedSessionId,
    response,
    closureInput,
    {
      collaborationGrant: {
        grantId: requestedGrantId,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.signer === undefined ? {} : { verifier: options.signer }),
        directHumanReviewAttestation: attestation,
      },
    },
  );
}

function assertDirectHumanTaskDiffPause(
  context: ReturnType<typeof loadActiveSessionContext>,
  grant: TaskDiffExternalReviewReservation['grant'],
  requestedGrantId: string,
  transitionDigest: string,
  contentNodeId: string,
  contentResultDigest: string,
): void {
  const inspection = readCollaborationGrantInspection(
    context.git.gitCommonDirectory,
    requestedGrantId,
  );
  if (
    grant.degradedForm !== 'direct-human-review' ||
    grant.grantId !== requestedGrantId ||
    grant.grantTransitionDigest !== transitionDigest ||
    inspection === null ||
    (inspection.state !== 'reserved' && inspection.state !== 'consumed') ||
    inspection.degradedForm !== 'direct-human-review' ||
    inspection.signedEnvelopeDigest !== grant.grantEnvelopeDigest ||
    inspection.transitionDigest !== transitionDigest ||
    !/^[0-9a-f]{64}$/u.test(contentNodeId) ||
    !/^[0-9a-f]{64}$/u.test(contentResultDigest)
  ) {
    throw directHumanTaskDiffResumeInvalid();
  }
}

type AuthenticatedExternalTaskDiffContinuation = Readonly<{
  reservation: TaskDiffExternalContinuationReservation;
  binding: TaskDiffExternalContinuationBinding;
  roleResult: AdmittedRoleResult;
  authority: TaskDiffAuthenticatedReviewerAuthority;
  createdAt: string;
}>;

export type CurrentExternalTaskDiffTerminalAssurance = Readonly<{
  source: 'external-continuation';
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  finalAssurance: TaskDiffFinalAssuranceRecord;
  continuationAuthorityNodeId: string;
  continuationAuthorityResultDigest: string;
}>;

/**
 * Replay a canonical external challenge continuation without writing any
 * lifecycle state. The current candidate is authenticated by the common
 * provider/external review loader, while closure and Final Assurance stay
 * bound to the historical reviewed subject so a same-candidate resume does
 * not invalidate review merely because check evidence was refreshed.
 */
export function loadCurrentExternalTaskDiffTerminalAssurance(
  cwd: string,
  requestedSessionId: string,
): CurrentExternalTaskDiffTerminalAssurance | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const current = loadCurrentAuthenticatedTaskDiffReview(
    cwd,
    requestedSessionId,
  );
  return loadAuthenticatedExternalTaskDiffTerminalAssurance({
    context,
    runtime,
    current,
  });
}

/**
 * Lower-level replay for lineage consumers that already authenticated the
 * historical initial review. It deliberately does not resolve lineage again.
 */
export function loadAuthenticatedExternalTaskDiffTerminalAssurance(input: {
  context: ReturnType<typeof loadActiveSessionContext>;
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
  current: CurrentAuthenticatedTaskDiffReview;
  replayMode?: TaskDiffReviewReplayMode;
}): CurrentExternalTaskDiffTerminalAssurance | null {
  const { context, runtime, current, replayMode = 'governing' } = input;
  const bindings = listAllTaskDiffExternalContinuationBindings(runtime).filter(
    (binding) => binding.reviewRecordDigest === current.review.recordDigest,
  );
  if (bindings.length === 0) return null;
  if (bindings.length !== 1) throw taskDiffReviewLineageConflict();
  const binding = bindings[0]!;
  assertExternalTaskDiffContinuationProviderShortage(
    context,
    runtime,
    context.session.sessionId,
    current.review,
  );
  const storedResponse = readTaskDiffExternalChallengeResponse(
    runtime,
    current.review.subjectDigest,
    current.review.recordDigest,
    binding.responseDigest,
  );
  if (storedResponse === null) throw externalTaskDiffAuthorityInvalid();
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    current.review,
    storedResponse.response,
  );
  const authenticatedClosure = assertCurrentExternalTaskDiffContinuationBinding(
    {
      context,
      runtime,
      current,
      response,
      binding,
      replayMode,
    },
  );
  const finalAssurance = assertCurrentExternalTaskDiffFinalAssuranceBinding({
    runtime,
    current,
    response,
    binding,
    authenticatedClosure,
  });
  if (finalAssurance === null) return null;
  return Object.freeze({
    source: 'external-continuation' as const,
    subject: current.subject,
    review: current.review,
    response,
    finalAssurance,
    continuationAuthorityNodeId: binding.authorityNodeId,
    continuationAuthorityResultDigest: binding.authorityResultDigest,
  });
}

function assertExternalTaskDiffContinuationInputCurrent(
  current: CurrentAuthenticatedTaskDiffReview,
  responseCandidate: TaskDiffReviewChallengeResponseRecord,
  input: TaskDiffReviewExternalClosureInput,
): TaskDiffReviewChallengeResponseRecord {
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    current.review,
    responseCandidate,
  );
  const rebuilt = createTaskDiffReviewChallengeResponse({
    review: current.review,
    responses: response.responses,
  });
  if (
    current.review.challenges.length === 0 ||
    canonicalJson(rebuilt) !== canonicalJson(response) ||
    input.subjectDigest !== current.review.subjectDigest ||
    input.reviewRecordDigest !== current.review.recordDigest ||
    input.responseDigest !== response.responseDigest
  ) {
    throw externalTaskDiffInputStale();
  }
  return response;
}

const TASK_DIFF_EXTERNAL_CONTINUATION_SHORTAGE_FAILURE_CODES = new Set([
  'PROVIDER_CAPACITY',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TOOL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
]);

function assertExternalTaskDiffContinuationProviderShortage(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  sessionId: string,
  review: TaskDiffReviewRecord,
): ProviderId[] {
  const reservations = listAllTaskDiffReviewContinuationReservations(
    runtime,
  ).filter(
    ({ review: candidate }) => candidate.recordDigest === review.recordDigest,
  );
  const results = listAllTaskDiffReviewContinuationResultBindings(
    runtime,
  ).filter(
    ({ reviewRecordDigest }) => reviewRecordDigest === review.recordDigest,
  );
  const exactReservation = readTaskDiffReviewContinuationReservation(
    runtime,
    sessionId,
    review.recordDigest,
  );
  const exactResult = readTaskDiffReviewContinuationResultBinding(
    runtime,
    sessionId,
    review.recordDigest,
  );
  if (
    results.length > 0 ||
    exactResult !== null ||
    reservations.length > 1 ||
    (exactReservation !== null &&
      !reservations.some(
        (reservation) =>
          reservation.reservationDigest === exactReservation.reservationDigest,
      ))
  ) {
    throw taskDiffReviewLineageConflict();
  }
  if (reservations.length === 1) {
    const reservation = reservations[0]!;
    if (
      canonicalJson(reservation.review) !== canonicalJson(review) ||
      reservation.subject.subjectDigest !== review.subjectDigest
    ) {
      throw taskDiffReviewLineageConflict();
    }
    const invocation = readProviderInvocation(
      runtime,
      reservation.request.invocationId,
    );
    if (
      invocation.requestDigest !== reservation.request.requestDigest ||
      invocation.investigationId !== reservation.ownerInvestigationId ||
      invocation.changeId !== reservation.changeId
    ) {
      throw taskDiffReviewLineageConflict();
    }
    if (
      invocation.state === 'failed' &&
      invocation.failure !== null &&
      TASK_DIFF_EXTERNAL_CONTINUATION_SHORTAGE_FAILURE_CODES.has(
        invocation.failure.code,
      )
    ) {
      return [];
    }
    if (invocation.state !== 'failed') {
      throw taskDiffReviewLineageConflict();
    }
    throw externalTaskDiffContinuationProviderShortageRequired();
  }

  const callableProviderIds = (['codex', 'claude'] as const).filter(
    (providerId) =>
      baselineAdapterPolicy(
        context.git.repositoryRoot,
        review.subject.baseCommit,
      ).policy.providers[providerId].enabled,
  );
  if (callableProviderIds.length !== 0) {
    throw externalTaskDiffContinuationProviderShortageRequired();
  }
  return [];
}

function externalTaskDiffContinuationProviderShortageRequired(): WorkflowError {
  return workflowError(
    'TASK_DIFF_EXTERNAL_CONTINUATION_PROVIDER_SHORTAGE_REQUIRED',
    'External TaskDiffReview challenge closure requires either no callable review provider or one exact provider continuation that failed with an availability shortage.',
    ExitCode.guard,
  );
}

function externalTaskDiffContinuationGrantCore(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
  targetDigest: string,
  policy: ReturnType<typeof parseMaintainerPolicy>,
): CollaborationGrantSelectionCoreBinding {
  return {
    ...externalTaskDiffGrantCore(context, subject, policy),
    targetDigest,
  };
}

function assertExternalTaskDiffContinuationAttemptMayProceed(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reviewRecordDigest: string,
  targetDigest: string,
  requestedGrantId: string,
): void {
  const completed = listAllTaskDiffExternalContinuationBindings(runtime).filter(
    (binding) => binding.reviewRecordDigest === reviewRecordDigest,
  );
  if (completed.some((binding) => binding.targetDigest !== targetDigest)) {
    throw taskDiffReviewLineageConflict();
  }
  for (const attempt of listAllTaskDiffExternalContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.reviewRecordDigest === reviewRecordDigest,
  )) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (
      (attempt.targetDigest !== targetDigest ||
        attempt.grant.grantId !== requestedGrantId) &&
      (inspection.state === 'reserved' || inspection.state === 'consumed')
    ) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_CONTINUATION_ATTEMPT_ACTIVE',
        'Another exact external TaskDiffReview continuation grant attempt is active; resume that signed envelope before selecting a replacement.',
        ExitCode.conflict,
      );
    }
  }
}

function assertExternalTaskDiffContinuationOrphanGrantMayProceed(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  targetDigest: string,
  requestedGrantId: string,
): void {
  const recordedGrantIds = new Set(
    listTaskDiffExternalContinuationReservations(runtime, targetDigest).map(
      ({ grant }) => grant.grantId,
    ),
  );
  const orphans = listCollaborationGrantInspections(
    context.git.gitCommonDirectory,
  ).filter(
    (grant) =>
      grant.state === 'reserved' &&
      grant.changeId === context.session.changeId &&
      grant.taskId === context.session.taskId &&
      grant.lifecyclePhase === 'task-diff-review' &&
      grant.targetDigest === targetDigest &&
      (grant.degradedForm === 'caller-supplied' ||
        grant.degradedForm === 'direct-human-review') &&
      !recordedGrantIds.has(grant.grantId),
  );
  if (orphans.length > 1) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_CONTINUATION_COMPETING_AUTHORITY',
      'Multiple orphaned external continuation grant reservations cover the exact challenge target.',
      ExitCode.guard,
    );
  }
  if (orphans[0] !== undefined && orphans[0].grantId !== requestedGrantId) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_CONTINUATION_ATTEMPT_ACTIVE',
      'An exact external continuation grant was reserved before its attempt record was published; resume that grant first.',
      ExitCode.conflict,
    );
  }
}

function requireExternalTaskDiffContinuationReservation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  targetDigest: string,
  grantEnvelopeDigest: string,
): TaskDiffExternalContinuationReservation {
  const reservation = readTaskDiffExternalContinuationReservation(
    runtime,
    targetDigest,
    grantEnvelopeDigest,
  );
  if (reservation === null) throw externalTaskDiffAuthorityInvalid();
  return reservation;
}

function preflightExternalTaskDiffChallengeClosure(
  review: TaskDiffReviewRecord,
  submission: TaskDiffReviewContinuationSubmission,
  expectedBinding: CollaborationGrantExpectedBinding,
): void {
  const participant = externalParticipantFromGrant(expectedBinding);
  if (participant.principalId === undefined) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const challenges: readonly Challenge[] = review.challenges.map(
    (challenge) => ({
      challengeId: challenge.challengeId,
      raisedBy: challenge.raisedBy,
      severity:
        challenge.severity === 'critical' ? 'forbidden-floor' : 'ordinary',
      targetId: challenge.challengeId,
    }),
  );
  const closures: readonly ChallengeClosure[] =
    submission.proposedDispositions.map((entry) => ({
      challengeId: entry.challengeId,
      disposition: entry.decision,
      closedBy: participant.principalId!,
      ...(entry.supersededBy === null
        ? {}
        : { supersededBy: entry.supersededBy }),
    }));
  assertAuthorizedReviewChallengeClosure({
    expectedSubjectDigest: review.subjectDigest,
    authoritySubjectDigest: review.subjectDigest,
    authenticatedCloserId: participant.principalId,
    challenges,
    closures,
    context: {
      authorId: review.assignment.implementerPrincipalId,
      reviewerIds: [participant.principalId],
      domainOwnerIds: [],
    },
  });
}

function createExternalTaskDiffContinuationContentNode(
  submission: ReturnType<typeof createTaskDiffExternalClosureSubmission>,
) {
  return createEvidenceNode({
    type: 'task-diff-review-external-continuation-submission',
    nodeSchema: 'workflow.task-diff-review-external-continuation-submission.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: submission.subject.reviewPolicyDigest,
    exactInputDigests: {
      input: submission.inputDigest,
      response: submission.responseDigest,
      review: submission.reviewRecordDigest,
      submission: submission.recordDigest,
      subject: submission.subjectDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema:
      'workflow.task-diff-review-external-continuation-submission-output.v1',
    output: { submission },
    runtimeMetadata: {},
  });
}

function externalTaskDiffContinuationContentAdmission(
  contentNode: ReturnType<typeof createEvidenceNode>,
  subject: TaskDiffReviewSubject,
) {
  return {
    kind: 'task-diff-review' as const,
    nodeId: contentNode.nodeId,
    resultDigest: contentNode.resultDigest,
    outputSchema: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    evaluator: 'task-diff-review-continuation.v1',
    policyDigest: subject.reviewPolicyDigest,
    contentDigest: contentNode.resultDigest,
    current: true as const,
  };
}

function createExternalTaskDiffContinuationAuthorityNode(input: {
  submission: ReturnType<typeof createTaskDiffExternalClosureSubmission>;
  contentNode: ReturnType<typeof createEvidenceNode>;
  roleResult: AdmittedRoleResult;
}) {
  return createEvidenceNode({
    type: 'task-diff-review-external-continuation-authority-result',
    nodeSchema:
      'workflow.task-diff-review-external-continuation-authority-result.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: input.submission.subject.reviewPolicyDigest,
    exactInputDigests: {
      admission: input.roleResult.resultDigest,
      content: input.contentNode.resultDigest,
      input: input.submission.inputDigest,
      response: input.submission.responseDigest,
      review: input.submission.reviewRecordDigest,
      subject: input.submission.subjectDigest,
    },
    semanticParentResultDigests: { content: input.contentNode.resultDigest },
    provenanceParentNodeIds: { content: input.contentNode.nodeId },
    outputSchema:
      'workflow.task-diff-review-external-continuation-authority-result-output.v1',
    output: { roleResult: input.roleResult },
    runtimeMetadata: {},
  });
}

function assertExternalTaskDiffContinuationReservationContent(
  reservation: TaskDiffExternalContinuationReservation,
  submission: ReturnType<typeof createTaskDiffExternalClosureSubmission>,
  contentNode: ReturnType<typeof createEvidenceNode>,
): void {
  if (
    reservation.targetDigest !== submission.targetDigest ||
    reservation.subjectDigest !== submission.subjectDigest ||
    reservation.reviewRecordDigest !== submission.reviewRecordDigest ||
    reservation.responseDigest !== submission.responseDigest ||
    reservation.inputDigest !== submission.inputDigest ||
    reservation.contentNodeId !== contentNode.nodeId ||
    reservation.contentResultDigest !== contentNode.resultDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

function renderExternalTaskDiffContinuationDirectHumanPause(
  sessionId: string,
  current: CurrentAuthenticatedTaskDiffReview,
  response: TaskDiffReviewChallengeResponseRecord,
  reservation: TaskDiffExternalContinuationReservation,
): TaskDiffReviewExternalContinuationLifecycleStatus {
  return Object.freeze({
    state: 'direct-human-attestation-required' as const,
    source: 'external-continuation' as const,
    sessionId,
    subject: current.subject,
    implementationActor: current.implementationActor,
    review: current.review,
    response,
    grantId: reservation.grant.grantId,
    grantEnvelopeDigest: reservation.grant.grantEnvelopeDigest,
    transitionDigest: reservation.grant.grantTransitionDigest,
    reservationDigest: reservation.reservationDigest,
    inputDigest: reservation.inputDigest,
    contentNodeId: reservation.contentNodeId,
    contentResultDigest: reservation.contentResultDigest,
    reviewNodeId: reservation.contentNodeId,
    reviewResultDigest: reservation.contentResultDigest,
  });
}

function externalTaskDiffContinuationGrantRequiredStatus(
  sessionId: string,
  current: CurrentAuthenticatedTaskDiffReview,
  response: TaskDiffReviewChallengeResponseRecord,
  targetDigest: string,
): TaskDiffReviewExternalContinuationLifecycleStatus {
  return Object.freeze({
    state: 'collaboration-grant-required' as const,
    source: 'external-continuation' as const,
    sessionId,
    subject: current.subject,
    implementationActor: current.implementationActor,
    review: current.review,
    response,
    targetDigest,
    inputSchema: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'collaboration-grant-selection' as const,
      lifecyclePhase: 'task-diff-review' as const,
      conflictingRole: 'task-diff-reviewer' as const,
      grantRequest: null,
      targetDigest,
      subjectDigest: current.review.subjectDigest,
      reviewRecordDigest: current.review.recordDigest,
      responseDigest: response.responseDigest,
      allowedDegradedForms: Object.freeze([
        'caller-supplied' as const,
        'direct-human-review' as const,
      ]),
      resumeOption: '--grant <grant-id>' as const,
    }),
  });
}

function renderExternalTaskDiffContinuationSatisfied(
  sessionId: string,
  current: CurrentAuthenticatedTaskDiffReview,
  response: TaskDiffReviewChallengeResponseRecord,
  finalAssurance: TaskDiffFinalAssuranceRecord,
): TaskDiffReviewExternalContinuationLifecycleStatus {
  return Object.freeze({
    state: finalAssurance.verdict,
    source: 'external-continuation' as const,
    sessionId,
    subject: current.subject,
    implementationActor: current.implementationActor,
    review: current.review,
    response,
    finalAssurance,
  });
}

function assertCurrentExternalTaskDiffContinuationBinding(input: {
  context: ReturnType<typeof loadActiveSessionContext>;
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
  current: CurrentAuthenticatedTaskDiffReview;
  response: TaskDiffReviewChallengeResponseRecord;
  binding: TaskDiffExternalContinuationBinding;
  replayMode?: TaskDiffReviewReplayMode;
}): AuthenticatedExternalTaskDiffContinuation {
  const targetDigest = taskDiffExternalContinuationTargetDigest({
    subjectDigest: input.current.review.subjectDigest,
    reviewRecordDigest: input.current.review.recordDigest,
    responseDigest: input.response.responseDigest,
  });
  if (
    input.binding.targetDigest !== targetDigest ||
    input.binding.subjectDigest !== input.current.review.subjectDigest ||
    input.binding.policyDigest !==
      input.current.review.subject.reviewPolicyDigest ||
    input.binding.reviewRecordDigest !== input.current.review.recordDigest ||
    input.binding.responseDigest !== input.response.responseDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const reservation = requireExternalTaskDiffContinuationReservation(
    input.runtime,
    targetDigest,
    input.binding.grant.grantEnvelopeDigest,
  );
  if (reservation.reservationDigest !== input.binding.reservationDigest) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const storedResponse = readTaskDiffExternalChallengeResponse(
    input.runtime,
    input.current.review.subjectDigest,
    input.current.review.recordDigest,
    input.response.responseDigest,
  );
  const submission = readTaskDiffExternalClosureSubmission(
    input.runtime,
    targetDigest,
    input.binding.inputDigest,
  );
  if (
    storedResponse === null ||
    submission === null ||
    canonicalJson(storedResponse.response) !== canonicalJson(input.response) ||
    submission.subjectDigest !== input.current.review.subjectDigest ||
    submission.reviewRecordDigest !== input.current.review.recordDigest ||
    submission.responseDigest !== input.response.responseDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const contentNode = readEvidenceNode(
    input.runtime,
    input.binding.contentNodeId,
  );
  assertExternalTaskDiffContinuationReservationContent(
    reservation,
    submission,
    contentNode,
  );
  const expectedContentNode =
    createExternalTaskDiffContinuationContentNode(submission);
  if (
    contentNode.resultDigest !== input.binding.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expectedContentNode)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const authorityNode = readEvidenceNode(
    input.runtime,
    input.binding.authorityNodeId,
  );
  if (
    !isExternalRecord(authorityNode.output) ||
    Object.keys(authorityNode.output).sort().join('\0') !== 'roleResult' ||
    !isExternalRecord(authorityNode.output.roleResult)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const storedRoleResult = authorityNode.output
    .roleResult as AdmittedRoleResult;
  if (storedRoleResult.grantUse === null) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const grantUse = storedRoleResult.grantUse;
  const expectedBinding = bindingFromPayload(grantUse.envelope.payload);
  const policy = parseBaselineJson(
    input.context.git.repositoryRoot,
    input.current.review.subject.baseCommit,
    'workflow/maintainer-policy.json',
    parseMaintainerPolicy,
  );
  const expectedCore = externalTaskDiffContinuationGrantCore(
    input.context,
    input.current.review.subject,
    targetDigest,
    policy,
  );
  assertExternalTaskDiffGrantBinding(expectedCore, expectedBinding, grantUse);
  const assignment = grantUse.assignment as GrantedRoleAssignment;
  const consumedInspection = readCollaborationGrantInspection(
    input.context.git.gitCommonDirectory,
    input.binding.grant.grantId,
  );
  if (
    consumedInspection?.state !== 'consumed' ||
    consumedInspection.use === undefined ||
    canonicalJson(consumedInspection.use) !== canonicalJson(grantUse)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const consumedUse = consumedInspection.use;
  const roleResult =
    input.replayMode === 'inspect'
      ? storedRoleResult
      : admitRoleResult({
          assignment,
          author: input.current.implementationActor,
          participant: assignment.participant,
          content: externalTaskDiffContinuationContentAdmission(
            contentNode,
            input.current.review.subject,
          ),
          providerInvocation: null,
          grantUse: consumedUse,
          grantValidation: {
            now: new Date(grantUse.envelope.payload.expiresAt),
            expectedBinding,
            policy,
            verifier: createVerifyOnlyMaintainer(policy),
            transitionDigest: grantUse.transitionDigest,
          },
        });
  if (input.replayMode === 'inspect') {
    assertStoredAdmittedRoleResultDigest(roleResult);
  }
  const expectedAuthorityNode = createExternalTaskDiffContinuationAuthorityNode(
    {
      submission,
      contentNode,
      roleResult,
    },
  );
  if (
    canonicalJson(roleResult) !== canonicalJson(storedRoleResult) ||
    input.binding.grantUseDigest !== sha256(canonicalJson(consumedUse)) ||
    input.binding.admittedRoleResultDigest !== roleResult.resultDigest ||
    input.binding.directHumanReviewAttestationDigest !==
      assignment.directHumanReviewAttestationDigest ||
    input.binding.grant.grantId !== consumedUse.grantId ||
    input.binding.grant.grantEnvelopeDigest !==
      consumedUse.signedEnvelopeDigest ||
    input.binding.grant.grantTransitionDigest !==
      consumedUse.transitionDigest ||
    input.binding.grant.grantTargetDigest !== consumedUse.targetDigest ||
    input.binding.grant.degradedForm !== consumedUse.degradedForm ||
    authorityNode.nodeId !== input.binding.authorityNodeId ||
    authorityNode.resultDigest !== input.binding.authorityResultDigest ||
    canonicalJson(authorityNode) !== canonicalJson(expectedAuthorityNode)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  assertNoCompetingConsumedExternalTaskDiffContinuationAttempt(
    input.context,
    input.runtime,
    input.current.review.recordDigest,
    input.binding,
  );
  const authority = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'challenge-closure' as const,
    subjectDigest: input.current.review.subjectDigest,
    reviewRecordDigest: input.current.review.recordDigest,
    responseDigest: input.response.responseDigest,
    authorityNodeId: authorityNode.nodeId,
    authorityResultDigest: authorityNode.resultDigest,
    authority: Object.freeze({
      kind: 'grant-attributed-external-reviewer' as const,
      principalId: requiredPrincipalId(roleResult.participant),
      degradedForm: input.binding.grant.degradedForm,
      grantUseDigest: input.binding.grantUseDigest,
      policyDigest: input.current.review.subject.reviewPolicyDigest,
    }),
  });
  return Object.freeze({
    reservation,
    binding: input.binding,
    roleResult,
    authority,
    createdAt:
      grantUse.directHumanReviewAttestation?.payload.signedAt ??
      new Date(grantUse.envelope.payload.expiresAt).toISOString(),
  });
}

function assertNoCompetingConsumedExternalTaskDiffContinuationAttempt(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reviewRecordDigest: string,
  binding: TaskDiffExternalContinuationBinding,
): void {
  for (const attempt of listAllTaskDiffExternalContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.reviewRecordDigest === reviewRecordDigest,
  )) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (
      inspection.state === 'consumed' &&
      attempt.grant.grantEnvelopeDigest !== binding.grant.grantEnvelopeDigest
    ) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_CONTINUATION_COMPETING_AUTHORITY',
        'More than one external continuation grant was consumed for the exact challenge target.',
        ExitCode.guard,
      );
    }
  }
}

function ensureExternalTaskDiffFinalAssurance(input: {
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
  current: CurrentAuthenticatedTaskDiffReview;
  response: TaskDiffReviewChallengeResponseRecord;
  binding: TaskDiffExternalContinuationBinding;
  authenticatedClosure: AuthenticatedExternalTaskDiffContinuation;
}): TaskDiffFinalAssuranceRecord {
  const existing = assertCurrentExternalTaskDiffFinalAssuranceBinding(input);
  if (existing !== null) return existing;
  const submission = readTaskDiffExternalClosureSubmission(
    input.runtime,
    input.binding.targetDigest,
    input.binding.inputDigest,
  );
  if (submission === null) throw externalTaskDiffAuthorityInvalid();
  const reviewerAuthority = input.authenticatedClosure.authority.authority;
  if (reviewerAuthority.kind !== 'grant-attributed-external-reviewer') {
    throw externalTaskDiffAuthorityInvalid();
  }
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: input.current.review.subject,
    review: input.current.review,
    response: input.response,
    submission: submission.submission,
    reviewerAuthority,
    exceptions: expectedExternalTaskDiffFinalAssuranceExceptions(
      input.current.review,
      reviewerAuthority,
    ),
    authenticatedReviewAuthority: input.current.authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority:
      input.authenticatedClosure.authority,
  });
  const reviewResultNode = readEvidenceNode(
    input.runtime,
    input.current.reviewResultNodeId,
  );
  const continuationResultNode = readEvidenceNode(
    input.runtime,
    input.binding.authorityNodeId,
  );
  if (
    reviewResultNode.resultDigest !== input.current.reviewResultDigest ||
    continuationResultNode.resultDigest !== input.binding.authorityResultDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const assuranceNode = createEvidenceNode({
    type: 'task-diff-final-assurance',
    nodeSchema: 'workflow.task-diff-final-assurance.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      authority: sha256(canonicalJson(reviewerAuthority)),
      closureAuthority: sha256(
        canonicalJson(input.authenticatedClosure.authority),
      ),
      response: input.response.responseDigest,
      review: input.current.review.recordDigest,
      reviewAuthority: sha256(
        canonicalJson(input.current.authenticatedReviewAuthority),
      ),
      subject: input.current.review.subjectDigest,
      submission: sha256(canonicalJson(submission.submission)),
    },
    semanticParentResultDigests: {
      continuation: continuationResultNode.resultDigest,
      review: reviewResultNode.resultDigest,
    },
    provenanceParentNodeIds: {
      continuation: continuationResultNode.nodeId,
      review: reviewResultNode.nodeId,
    },
    outputSchema: 'workflow.task-diff-final-assurance-output.v1',
    output: assurance,
    runtimeMetadata: {},
  });
  writeEvidenceNode(input.runtime, assuranceNode);
  createTaskDiffFinalAssuranceBinding(input.runtime, {
    subjectDigest: input.current.review.subjectDigest,
    assuranceNodeId: assuranceNode.nodeId,
    assuranceResultDigest: assuranceNode.resultDigest,
    assurance,
    createdAt: input.authenticatedClosure.createdAt,
  });
  return (
    assertCurrentExternalTaskDiffFinalAssuranceBinding(input) ??
    (() => {
      throw reviewNotSatisfied();
    })()
  );
}

function assertCurrentExternalTaskDiffFinalAssuranceBinding(input: {
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
  current: CurrentAuthenticatedTaskDiffReview;
  response: TaskDiffReviewChallengeResponseRecord;
  binding: TaskDiffExternalContinuationBinding;
  authenticatedClosure: AuthenticatedExternalTaskDiffContinuation;
}): TaskDiffFinalAssuranceRecord | null {
  const binding = readTaskDiffFinalAssuranceBinding(
    input.runtime,
    input.current.review.subjectDigest,
  );
  if (binding === null) return null;
  const submission = readTaskDiffExternalClosureSubmission(
    input.runtime,
    input.binding.targetDigest,
    input.binding.inputDigest,
  );
  if (submission === null) throw externalTaskDiffAuthorityInvalid();
  const assurance = assertTaskDiffFinalAssuranceCurrent({
    subject: input.current.review.subject,
    review: input.current.review,
    response: input.response,
    assurance: binding.assurance,
    authenticatedReviewAuthority: input.current.authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority:
      input.authenticatedClosure.authority,
  });
  const assuranceNode = readEvidenceNode(
    input.runtime,
    binding.assuranceNodeId,
  );
  const reviewResultNode = readEvidenceNode(
    input.runtime,
    input.current.reviewResultNodeId,
  );
  const continuationResultNode = readEvidenceNode(
    input.runtime,
    input.binding.authorityNodeId,
  );
  if (
    binding.assuranceResultDigest !== assuranceNode.resultDigest ||
    canonicalJson(binding.assurance) !== canonicalJson(assurance) ||
    assuranceNode.type !== 'task-diff-final-assurance' ||
    assuranceNode.nodeSchema !== 'workflow.task-diff-final-assurance.v1' ||
    assuranceNode.evaluator !== 'workflow-task-diff-review.v1' ||
    assuranceNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    assuranceNode.outputSchema !==
      'workflow.task-diff-final-assurance-output.v1' ||
    canonicalJson(assuranceNode.output) !== canonicalJson(assurance) ||
    assuranceNode.exactInputDigests.authority !==
      sha256(canonicalJson(assurance.reviewerAuthority)) ||
    assuranceNode.exactInputDigests.closureAuthority !==
      sha256(canonicalJson(input.authenticatedClosure.authority)) ||
    assuranceNode.exactInputDigests.reviewAuthority !==
      sha256(canonicalJson(input.current.authenticatedReviewAuthority)) ||
    assuranceNode.exactInputDigests.response !==
      input.response.responseDigest ||
    assuranceNode.exactInputDigests.review !==
      input.current.review.recordDigest ||
    assuranceNode.exactInputDigests.subject !==
      input.current.review.subjectDigest ||
    assuranceNode.exactInputDigests.submission !==
      sha256(canonicalJson(submission.submission)) ||
    assuranceNode.semanticParentResultDigests.continuation !==
      continuationResultNode.resultDigest ||
    assuranceNode.semanticParentResultDigests.review !==
      reviewResultNode.resultDigest ||
    assuranceNode.provenanceParentNodeIds.continuation !==
      continuationResultNode.nodeId ||
    assuranceNode.provenanceParentNodeIds.review !== reviewResultNode.nodeId
  ) {
    throw reviewNotSatisfied();
  }
  return assurance;
}

function expectedExternalTaskDiffFinalAssuranceExceptions(
  review: TaskDiffReviewRecord,
  reviewerAuthority: Extract<
    TaskDiffFinalAssuranceRecord['reviewerAuthority'],
    { kind: 'grant-attributed-external-reviewer' }
  >,
) {
  return [
    ...(review.assignment.degradedForm === null ||
    review.assignment.grantUseDigest === null
      ? []
      : [
          {
            kind: 'collaboration-grant-degradation' as const,
            stage: 'review' as const,
            grantUseDigest: review.assignment.grantUseDigest,
            degradedForm: review.assignment.degradedForm,
          },
        ]),
    {
      kind: 'collaboration-grant-degradation' as const,
      stage: 'challenge-closure' as const,
      grantUseDigest: reviewerAuthority.grantUseDigest,
      degradedForm: reviewerAuthority.degradedForm,
    },
  ];
}

type CurrentExternalTaskDiffReview = Readonly<{
  binding: TaskDiffExternalReviewBinding;
  reservation: TaskDiffExternalReviewReservation;
  implementationActor: RecordedRoleParticipant;
  assignment: GrantedRoleAssignment;
  roleResult: AdmittedRoleResult;
  review: TaskDiffReviewRecord;
}>;

function createExternalTaskDiffReviewContentNode(
  submission: ReturnType<typeof createTaskDiffExternalReviewSubmission>,
  implementationActor: RecordedRoleParticipant,
) {
  return createEvidenceNode({
    type: 'task-diff-review-external-submission',
    nodeSchema: 'workflow.task-diff-review-external-submission.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: submission.subject.reviewPolicyDigest,
    exactInputDigests: {
      actor: sha256(canonicalJson(implementationActor)),
      input: submission.inputDigest,
      scope: submission.reviewScopeDigest,
      submission: submission.recordDigest,
      subject: submission.subjectDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.task-diff-review-external-submission-output.v1',
    output: { implementationActor, submission },
    runtimeMetadata: {},
  });
}

function preflightExternalTaskDiffReviewSubmission(
  sessionId: string,
  implementationActor: RecordedRoleParticipant,
  subject: TaskDiffReviewSubject,
  reviewScope: Extract<
    TaskDiffReviewCandidatePlan,
    { action: 'review' }
  >['scope'],
  submission: TaskDiffReviewExternalSubmissionInput['submission'],
  inputDigest: string,
): void {
  createTaskDiffReviewRecord({
    subject,
    reviewScope,
    assignment: {
      implementerPrincipalId: requiredPrincipalId(implementationActor),
      implementerProviderId: implementationActor.providerId,
      implementationSessionId: sessionId,
      reviewerPrincipalId: `external-preflight:${inputDigest}`,
      reviewerProviderId: null,
      reviewerSessionId: null,
      achievedIndependence: 'none',
      degradedForm: 'caller-supplied',
      grantUseDigest: '0'.repeat(64),
    },
    submission,
  });
}

function preflightExternalTaskDiffReviewerIdentity(
  sessionId: string,
  implementationActor: RecordedRoleParticipant,
  expectedBinding: CollaborationGrantExpectedBinding,
  subject: TaskDiffReviewSubject,
  reviewScope: Extract<
    TaskDiffReviewCandidatePlan,
    { action: 'review' }
  >['scope'],
  submission: TaskDiffReviewExternalSubmissionInput['submission'],
): void {
  const participant = externalParticipantFromGrant(expectedBinding);
  if (participant.principalId === undefined) {
    throw externalTaskDiffAuthorityInvalid();
  }
  createTaskDiffReviewRecord({
    subject,
    reviewScope,
    assignment: {
      implementerPrincipalId: requiredPrincipalId(implementationActor),
      implementerProviderId: implementationActor.providerId,
      implementationSessionId: sessionId,
      reviewerPrincipalId: participant.principalId,
      reviewerProviderId: null,
      reviewerSessionId: null,
      achievedIndependence: 'none',
      degradedForm: expectedBinding.degradedForm as
        'caller-supplied' | 'direct-human-review',
      grantUseDigest: '0'.repeat(64),
    },
    submission,
  });
}

function createExternalTaskDiffReviewAuthorityNode(input: {
  sessionId: string;
  implementationActor: RecordedRoleParticipant;
  submission: ReturnType<typeof createTaskDiffExternalReviewSubmission>;
  contentNode: ReturnType<typeof createEvidenceNode>;
  roleResult: AdmittedRoleResult;
  review: TaskDiffReviewRecord;
}) {
  return createEvidenceNode({
    type: 'task-diff-review-external-authority-result',
    nodeSchema: 'workflow.task-diff-review-external-authority-result.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: input.submission.subject.reviewPolicyDigest,
    exactInputDigests: {
      admission: input.roleResult.resultDigest,
      content: input.contentNode.resultDigest,
      review: input.review.recordDigest,
      scope: input.submission.reviewScopeDigest,
      subject: input.submission.subjectDigest,
    },
    semanticParentResultDigests: {
      content: input.contentNode.resultDigest,
    },
    provenanceParentNodeIds: { content: input.contentNode.nodeId },
    outputSchema:
      'workflow.task-diff-review-external-authority-result-output.v1',
    output: {
      sessionId: input.sessionId,
      implementationActor: input.implementationActor,
      roleResult: input.roleResult,
      review: input.review,
    },
    runtimeMetadata: {},
  });
}

function externalTaskDiffContentAdmission(
  contentNode: ReturnType<typeof createEvidenceNode>,
  subject: TaskDiffReviewSubject,
) {
  return {
    kind: 'task-diff-review' as const,
    nodeId: contentNode.nodeId,
    resultDigest: contentNode.resultDigest,
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluator: 'task-diff-review.v1',
    policyDigest: subject.reviewPolicyDigest,
    contentDigest: contentNode.resultDigest,
    current: true as const,
  };
}

function externalTaskDiffGrantCore(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
  policy: ReturnType<typeof parseMaintainerPolicy>,
): CollaborationGrantSelectionCoreBinding {
  return externalTaskDiffGrantCoreForSubject(
    context.git.repositoryRoot,
    subject,
    policy,
  );
}

function externalTaskDiffGrantCoreForSubject(
  repositoryRoot: string,
  subject: TaskDiffReviewSubject,
  policy: ReturnType<typeof parseMaintainerPolicy>,
): CollaborationGrantSelectionCoreBinding {
  return {
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${subject.baseCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
    collaborationPolicyDigest:
      collaborationPolicyDigestForPhase('task-diff-review'),
    changeId: subject.changeId,
    taskId: subject.taskId,
    baselineCommit: subject.baseCommit,
    baselineTree: subject.baseTree,
    targetDigest: subject.subjectDigest,
    lifecyclePhase: 'task-diff-review',
    rolePair: {
      authorRole: 'task-implementer',
      conflictingRole: 'task-diff-reviewer',
    },
  };
}

function assertExternalTaskDiffGrantBinding(
  expectedCore: CollaborationGrantSelectionCoreBinding,
  expectedBinding: CollaborationGrantExpectedBinding,
  use: CollaborationGrantUseProjection,
): void {
  const actualCore: CollaborationGrantSelectionCoreBinding = {
    repositoryId: expectedBinding.repositoryId,
    repositoryOrigin: expectedBinding.repositoryOrigin,
    policyBlob: expectedBinding.policyBlob,
    collaborationPolicyDigest: expectedBinding.collaborationPolicyDigest,
    changeId: expectedBinding.changeId,
    taskId: expectedBinding.taskId,
    baselineCommit: expectedBinding.baselineCommit,
    baselineTree: expectedBinding.baselineTree,
    targetDigest: expectedBinding.targetDigest,
    lifecyclePhase: expectedBinding.lifecyclePhase,
    rolePair: expectedBinding.rolePair,
  };
  if (
    canonicalJson(actualCore) !== canonicalJson(expectedCore) ||
    (expectedBinding.degradedForm !== 'caller-supplied' &&
      expectedBinding.degradedForm !== 'direct-human-review') ||
    use.targetDigest !== expectedCore.targetDigest ||
    use.transitionDigest !== collaborationTransitionDigest(expectedBinding) ||
    use.signedEnvelopeDigest !== collaborationGrantEnvelopeDigest(use.envelope)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

function externalParticipantFromGrant(
  expectedBinding: CollaborationGrantExpectedBinding,
): RoleParticipant {
  const actor = expectedBinding.availableActor;
  if (
    expectedBinding.degradedForm === 'caller-supplied' &&
    actor.kind === 'caller'
  ) {
    return {
      providerId: undefined,
      sessionId: undefined,
      principalId: actor.callerId,
      identityAssurance: actor.assurance,
      engineSpawned: false,
    };
  }
  if (
    expectedBinding.degradedForm === 'direct-human-review' &&
    actor.kind === 'direct-human'
  ) {
    return {
      providerId: undefined,
      sessionId: undefined,
      principalId: actor.identity,
      identityAssurance: 'adapter-assigned',
      engineSpawned: false,
    };
  }
  throw externalTaskDiffAuthorityInvalid();
}

function roleParticipantFromRecorded(
  participant: RecordedRoleParticipant,
): RoleParticipant {
  if (participant.identityAssurance === 'maintainer-signed') {
    throw externalTaskDiffAuthorityInvalid();
  }
  return {
    providerId: participant.providerId ?? undefined,
    sessionId: participant.sessionId ?? undefined,
    principalId: participant.principalId ?? undefined,
    identityAssurance: participant.identityAssurance,
    engineSpawned: participant.engineSpawned,
  };
}

function externalTaskDiffActorReplayOptions(
  actor: RecordedRoleParticipant,
): BeginTaskDiffReviewOptions {
  if (actor.providerId === null) {
    if (actor.identityAssurance === 'maintainer-signed') {
      throw externalTaskDiffAuthorityInvalid();
    }
    return { environment: {} };
  }
  if (actor.identityAssurance === 'self-declared') {
    return { explicitActor: actor.providerId, environment: {} };
  }
  if (actor.identityAssurance === 'runtime-hint') {
    return { environment: { AGENT: actor.providerId } };
  }
  if (actor.identityAssurance === 'adapter-assigned') {
    return { environment: {} };
  }
  throw externalTaskDiffAuthorityInvalid();
}

function requiredPrincipalId(participant: RecordedRoleParticipant): string {
  if (participant.principalId === null)
    throw externalTaskDiffAuthorityInvalid();
  return participant.principalId;
}

function externalTaskDiffReviewAssignment(
  sessionId: string,
  implementationActor: RecordedRoleParticipant,
  assignment: GrantedRoleAssignment,
  grantUseDigest: string,
) {
  if (
    assignment.degradedForm !== 'caller-supplied' &&
    assignment.degradedForm !== 'direct-human-review'
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return {
    implementerPrincipalId: requiredPrincipalId(implementationActor),
    implementerProviderId: implementationActor.providerId,
    implementationSessionId: sessionId,
    reviewerPrincipalId: requiredPrincipalId(assignment.participant),
    reviewerProviderId: null,
    reviewerSessionId: null,
    achievedIndependence: 'none' as const,
    degradedForm: assignment.degradedForm,
    grantUseDigest,
  };
}

function createVerifyOnlyMaintainer(
  policy: ReturnType<typeof parseMaintainerPolicy>,
): MaintainerSignerProvider {
  const unavailable = () => {
    throw workflowError(
      'MAINTAINER_SIGNING_NOT_AVAILABLE',
      'This lifecycle path verifies existing maintainer signatures and cannot sign new authority.',
      ExitCode.guard,
    );
  };
  return {
    assertHumanPresent: unavailable,
    identity: unavailable,
    sign: unavailable,
    verify(payload, signature, identity, namespace) {
      const signer = policy.trustedSigners.find(
        (candidate) => candidate.identity === identity,
      );
      if (signer === undefined) throw externalTaskDiffAuthorityInvalid();
      verifySshSignatureWithPublicKey(
        payload,
        signature,
        identity,
        signer.publicKey,
        namespace ?? policy.signatureNamespace,
      );
    },
  };
}

function assertExternalTaskDiffAttemptMayProceed(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
  requestedGrantId: string,
  implementationActor: RecordedRoleParticipant,
): void {
  for (const attempt of listTaskDiffExternalReviewReservations(
    runtime,
    subjectDigest,
  )) {
    if (
      canonicalJson(attempt.implementationActor) !==
      canonicalJson(implementationActor)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (
      attempt.grant.grantId !== requestedGrantId &&
      (inspection.state === 'reserved' || inspection.state === 'consumed')
    ) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_REVIEW_ATTEMPT_ACTIVE',
        'Another exact external TaskDiffReview grant attempt is reserved or consumed without a canonical binding; resume that signed envelope before selecting a replacement.',
        ExitCode.conflict,
      );
    }
  }
}

function assertExternalTaskDiffOrphanGrantMayProceed(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  requestedGrantId: string,
): void {
  const orphan = inspectExternalTaskDiffOrphanGrant(context, runtime, subject);
  if (orphan !== null && orphan.grantId !== requestedGrantId) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_ATTEMPT_ACTIVE',
      'An exact external TaskDiffReview grant was reserved before its attempt record was published; resume that grant before selecting a replacement.',
      ExitCode.conflict,
    );
  }
}

function inspectExternalTaskDiffOrphanGrant(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
) {
  const attemptGrantIds = new Set(
    listTaskDiffExternalReviewReservations(runtime, subject.subjectDigest).map(
      (reservation) => reservation.grant.grantId,
    ),
  );
  const matches = listCollaborationGrantInspections(
    context.git.gitCommonDirectory,
  ).filter(
    (grant) =>
      grant.state === 'reserved' &&
      grant.changeId === context.session.changeId &&
      grant.taskId === context.session.taskId &&
      grant.lifecyclePhase === 'task-diff-review' &&
      grant.targetDigest === subject.subjectDigest &&
      (grant.degradedForm === 'caller-supplied' ||
        grant.degradedForm === 'direct-human-review') &&
      !attemptGrantIds.has(grant.grantId),
  );
  if (matches.length > 1) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_COMPETING_AUTHORITY',
      'Multiple orphaned external TaskDiffReview grant reservations cover the exact subject; status cannot select one.',
      ExitCode.guard,
    );
  }
  return matches[0] ?? null;
}

function renderExternalTaskDiffOrphanGrantStatus(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
  grant: NonNullable<ReturnType<typeof inspectExternalTaskDiffOrphanGrant>>,
): TaskDiffReviewLifecycleStatus {
  if (
    grant.transitionDigest === undefined ||
    (grant.degradedForm !== 'caller-supplied' &&
      grant.degradedForm !== 'direct-human-review')
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return Object.freeze({
    state: 'external-grant-resume-required' as const,
    source: 'external' as const,
    sessionId: context.session.sessionId,
    subject,
    degradedForm: grant.degradedForm,
    grantId: grant.grantId,
    grantEnvelopeDigest: grant.signedEnvelopeDigest,
    transitionDigest: grant.transitionDigest,
  });
}

function requireExternalTaskDiffReviewReservation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
  grantEnvelopeDigest: string,
): TaskDiffExternalReviewReservation {
  const reservation = readTaskDiffExternalReviewReservation(
    runtime,
    subjectDigest,
    grantEnvelopeDigest,
  );
  if (reservation === null) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return reservation;
}

function assertExternalTaskDiffReservationContent(
  reservation: TaskDiffExternalReviewReservation,
  submission: ReturnType<typeof createTaskDiffExternalReviewSubmission>,
  contentNode: ReturnType<typeof createEvidenceNode>,
  implementationActor: RecordedRoleParticipant,
): void {
  if (
    reservation.inputDigest !== submission.inputDigest ||
    reservation.reviewScopeDigest !== submission.reviewScopeDigest ||
    reservation.submissionRecordDigest !== submission.recordDigest ||
    reservation.contentNodeId !== contentNode.nodeId ||
    reservation.contentResultDigest !== contentNode.resultDigest ||
    canonicalJson(reservation.implementationActor) !==
      canonicalJson(implementationActor)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

function renderExternalDirectHumanPause(
  sessionId: string,
  subject: TaskDiffReviewSubject,
  reservation: TaskDiffExternalReviewReservation,
): TaskDiffReviewLifecycleStatus {
  return Object.freeze({
    state: 'direct-human-attestation-required' as const,
    source: 'external' as const,
    sessionId,
    subject,
    grantId: reservation.grant.grantId,
    grantEnvelopeDigest: reservation.grant.grantEnvelopeDigest,
    transitionDigest: reservation.grant.grantTransitionDigest,
    reservationDigest: reservation.reservationDigest,
    inputDigest: reservation.inputDigest,
    reviewScopeDigest: reservation.reviewScopeDigest,
    submissionRecordDigest: reservation.submissionRecordDigest,
    reviewNodeId: reservation.contentNodeId,
    reviewResultDigest: reservation.contentResultDigest,
  });
}

function externalTaskDiffGrantRequiredStatus(
  sessionId: string,
  subject: TaskDiffReviewSubject,
  implementationActor: RecordedRoleParticipant,
): TaskDiffReviewCollaborationGrantRequiredStatus {
  return Object.freeze({
    state: 'collaboration-grant-required' as const,
    sessionId,
    subject,
    implementationActor,
    inputSchema: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'collaboration-grant-selection' as const,
      lifecyclePhase: 'task-diff-review' as const,
      conflictingRole: 'task-diff-reviewer' as const,
      grantRequest: null,
      allowedDegradedForms: Object.freeze([
        'caller-supplied' as const,
        'direct-human-review' as const,
      ]),
      resumeOption: '--grant <grant-id>' as const,
    }),
  });
}

function assertExternalTaskDiffProvidersUnavailable(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
): void {
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  if (
    policy.policy.providers.codex.enabled ||
    policy.policy.providers.claude.enabled ||
    !subject.reviewRequirement.required
  ) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_NOT_ALLOWED',
      'External TaskDiffReview is available only when no review provider is callable for the exact required subject.',
      ExitCode.guard,
    );
  }
}

function assertHistoricalExternalTaskDiffProvidersUnavailable(
  repositoryRoot: string,
  subject: TaskDiffReviewSubject,
): void {
  const policy = baselineAdapterPolicy(repositoryRoot, subject.baseCommit);
  if (
    policy.policy.providers.codex.enabled ||
    policy.policy.providers.claude.enabled ||
    !subject.reviewRequirement.required
  ) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_NOT_ALLOWED',
      'Historical external TaskDiffReview authority is invalid when a review provider was callable for its exact baseline subject.',
      ExitCode.guard,
    );
  }
}

function assertCurrentExternalTaskDiffReviewBinding(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  binding: TaskDiffExternalReviewBinding,
  assertOwned?: () => void,
  replayMode: 'inspect' | 'governing' = 'governing',
): CurrentExternalTaskDiffReview {
  const current = assertHistoricalExternalTaskDiffReviewBinding(
    context,
    runtime,
    binding,
    assertOwned,
    replayMode,
  );
  const implementationActor =
    replayMode === 'inspect'
      ? current.reservation.implementationActor
      : resolveTaskDiffImplementationActor(
          context.git.repositoryRoot,
          context.session.sessionId,
          subject,
          externalTaskDiffActorReplayOptions(
            current.reservation.implementationActor,
          ),
        );
  if (
    binding.subjectDigest !== subject.subjectDigest ||
    binding.targetDigest !== subject.subjectDigest ||
    binding.policyDigest !== subject.reviewPolicyDigest ||
    !sameRecordedTaskDiffActorAuthority(
      current.reservation.implementationActor,
      implementationActor,
    )
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  assertExternalTaskDiffProvidersUnavailable(context, subject);
  return current;
}

function sameRecordedTaskDiffActorAuthority(
  left: RecordedRoleParticipant,
  right: RecordedRoleParticipant,
): boolean {
  return (
    canonicalJson({ ...left, sessionId: null }) ===
    canonicalJson({ ...right, sessionId: null })
  );
}

function bindingSubject(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
): TaskDiffReviewSubject {
  return requireExternalTaskDiffSubmission(runtime, binding).subject;
}

function assertHistoricalExternalTaskDiffReviewBinding(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
  assertOwned?: () => void,
  replayMode: 'inspect' | 'governing' = 'governing',
): CurrentExternalTaskDiffReview {
  const subject = bindingSubject(runtime, binding);
  assertHistoricalExternalTaskDiffProvidersUnavailable(
    context.git.repositoryRoot,
    subject,
  );
  if (
    binding.subjectDigest !== subject.subjectDigest ||
    binding.targetDigest !== subject.subjectDigest ||
    binding.policyDigest !== subject.reviewPolicyDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const reservation = requireExternalTaskDiffReviewReservation(
    runtime,
    subject.subjectDigest,
    binding.grant.grantEnvelopeDigest,
  );
  if (reservation.reservationDigest !== binding.reservationDigest) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const submission = requireExternalTaskDiffSubmission(runtime, binding);
  const contentNode = readAndValidateExternalTaskDiffContentNode(
    runtime,
    binding,
    reservation.implementationActor,
  );
  const authorityNode = readEvidenceNode(runtime, binding.authorityNodeId);
  const output = exactExternalAuthorityOutput(authorityNode.output);
  const implementationActor = reservation.implementationActor;
  if (
    output.sessionId !== implementationActor.sessionId ||
    canonicalJson(output.implementationActor) !==
      canonicalJson(implementationActor)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const storedRoleResult = output.roleResult;
  const storedReview = parseTaskDiffReviewRecord(output.review);
  const grantUse = storedRoleResult.grantUse;
  if (grantUse === null) throw externalTaskDiffAuthorityInvalid();
  const expectedBinding = bindingFromPayload(grantUse.envelope.payload);
  const policy = parseBaselineJson(
    context.git.repositoryRoot,
    subject.baseCommit,
    'workflow/maintainer-policy.json',
    parseMaintainerPolicy,
  );
  const expectedCore = externalTaskDiffGrantCoreForSubject(
    context.git.repositoryRoot,
    subject,
    policy,
  );
  assertExternalTaskDiffGrantBinding(expectedCore, expectedBinding, grantUse);
  if (
    grantUse.grantId !== binding.grant.grantId ||
    grantUse.signedEnvelopeDigest !== binding.grant.grantEnvelopeDigest ||
    grantUse.transitionDigest !== binding.grant.grantTransitionDigest ||
    grantUse.targetDigest !== binding.grant.grantTargetDigest ||
    grantUse.degradedForm !== binding.grant.degradedForm ||
    sha256(canonicalJson(grantUse)) !== binding.grantUseDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  assertNoCompetingConsumedExternalTaskDiffAttempt(
    context,
    runtime,
    subject.subjectDigest,
    binding,
  );
  const grantInspection = readCollaborationGrantInspection(
    context.git.gitCommonDirectory,
    binding.grant.grantId,
  );
  if (
    grantInspection?.state !== 'consumed' ||
    grantInspection.use === undefined ||
    canonicalJson(grantInspection.use) !== canonicalJson(grantUse)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const consumedUse = grantInspection.use;
  const replayedRoleResult =
    replayMode === 'inspect'
      ? storedRoleResult
      : admitRoleResult({
          assignment: storedRoleResult.assignment,
          author: implementationActor,
          participant: storedRoleResult.participant,
          content: externalTaskDiffContentAdmission(contentNode, subject),
          providerInvocation: null,
          grantUse: consumedUse,
          grantValidation: {
            now: new Date(grantUse.envelope.payload.expiresAt),
            expectedBinding,
            policy,
            verifier: createVerifyOnlyMaintainer(policy),
            transitionDigest: grantUse.transitionDigest,
          },
        });
  if (replayMode === 'inspect') {
    assertStoredAdmittedRoleResultDigest(replayedRoleResult);
  }
  if (
    canonicalJson(replayedRoleResult) !== canonicalJson(storedRoleResult) ||
    replayedRoleResult.resultDigest !== binding.admittedRoleResultDigest ||
    replayedRoleResult.providerInvocation !== null
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const replayedReview = createTaskDiffReviewRecord({
    subject,
    reviewScope: submission.reviewScope,
    assignment: externalTaskDiffReviewAssignment(
      output.sessionId,
      implementationActor,
      replayedRoleResult.assignment as GrantedRoleAssignment,
      binding.grantUseDigest,
    ),
    submission: submission.submission,
  });
  if (
    canonicalJson(replayedReview) !== canonicalJson(storedReview) ||
    storedReview.recordDigest !== binding.reviewRecordDigest ||
    (binding.grant.degradedForm === 'direct-human-review'
      ? (replayedRoleResult.assignment as GrantedRoleAssignment)
          .directHumanReviewAttestationDigest !==
        binding.directHumanReviewAttestationDigest
      : binding.directHumanReviewAttestationDigest !== null)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const expectedAuthorityNode = createExternalTaskDiffReviewAuthorityNode({
    sessionId: output.sessionId,
    implementationActor,
    submission,
    contentNode,
    roleResult: replayedRoleResult,
    review: replayedReview,
  });
  if (
    authorityNode.nodeId !== binding.authorityNodeId ||
    authorityNode.resultDigest !== binding.authorityResultDigest ||
    canonicalJson(authorityNode) !== canonicalJson(expectedAuthorityNode)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return Object.freeze({
    binding,
    reservation,
    implementationActor,
    assignment: replayedRoleResult.assignment as GrantedRoleAssignment,
    roleResult: replayedRoleResult,
    review: replayedReview,
  });
}

function requireExternalTaskDiffSubmission(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
) {
  const submission = readTaskDiffExternalReviewSubmission(
    runtime,
    binding.subjectDigest,
    binding.reviewScopeDigest,
    binding.inputDigest,
  );
  if (
    submission === null ||
    submission.recordDigest !== binding.submissionRecordDigest ||
    submission.inputDigest !== binding.inputDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return submission;
}

function readAndValidateExternalTaskDiffContentNode(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
  implementationActor: RecordedRoleParticipant,
) {
  const submission = requireExternalTaskDiffSubmission(runtime, binding);
  const contentNode = readEvidenceNode(runtime, binding.contentNodeId);
  const expected = createExternalTaskDiffReviewContentNode(
    submission,
    implementationActor,
  );
  if (
    contentNode.nodeId !== binding.contentNodeId ||
    contentNode.resultDigest !== binding.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expected)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return contentNode;
}

function exactExternalAuthorityOutput(value: unknown): Readonly<{
  sessionId: string;
  implementationActor: RecordedRoleParticipant;
  roleResult: AdmittedRoleResult;
  review: unknown;
}> {
  if (
    !isExternalRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      ['implementationActor', 'review', 'roleResult', 'sessionId']
        .sort()
        .join('\0') ||
    typeof value.sessionId !== 'string' ||
    !isExternalRecord(value.implementationActor) ||
    !isExternalRecord(value.roleResult)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return value as {
    sessionId: string;
    implementationActor: RecordedRoleParticipant;
    roleResult: AdmittedRoleResult;
    review: unknown;
  };
}

function assertNoCompetingConsumedExternalTaskDiffAttempt(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
  binding: TaskDiffExternalReviewBinding,
): void {
  const attempts = listTaskDiffExternalReviewReservations(
    runtime,
    subjectDigest,
  );
  for (const attempt of attempts) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (
      inspection.state === 'consumed' &&
      attempt.grant.grantEnvelopeDigest !== binding.grant.grantEnvelopeDigest
    ) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_REVIEW_COMPETING_AUTHORITY',
        'More than one external TaskDiffReview grant was consumed for the exact subject; no canonical authority may be selected by filename order.',
        ExitCode.guard,
      );
    }
  }
}

function inspectExternalGrant(gitCommonDirectory: string, grantId: string) {
  const entry = readCollaborationGrantInspection(gitCommonDirectory, grantId);
  if (entry === null) throw externalTaskDiffAuthorityInvalid();
  return entry;
}

function renderExternalTaskDiffReviewStatus(
  context: ReturnType<typeof loadActiveSessionContext>,
  _runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  current: CurrentExternalTaskDiffReview,
): TaskDiffReviewLifecycleStatus {
  return Object.freeze({
    state:
      current.review.challenges.length === 0
        ? ('satisfied' as const)
        : ('challenge-response-required' as const),
    source: 'external' as const,
    sessionId: context.session.sessionId,
    subject,
    implementationActor: current.implementationActor,
    assignment: current.assignment,
    review: current.review,
    finalAssurance: null,
  });
}

function inspectExternalTaskDiffPendingStatus(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
): TaskDiffReviewLifecycleStatus | null {
  const active = listTaskDiffExternalReviewReservations(
    runtime,
    subject.subjectDigest,
  ).flatMap((reservation) => {
    const grant = readCollaborationGrantInspection(
      context.git.gitCommonDirectory,
      reservation.grant.grantId,
    );
    if (grant === null || grant.state === 'available') {
      throw externalTaskDiffAuthorityInvalid();
    }
    if (
      grant.state === 'failed' ||
      grant.state === 'expired' ||
      grant.state === 'revoked'
    ) {
      return [];
    }
    validateExternalTaskDiffPendingAttempt(runtime, reservation, grant);
    return [{ reservation, grant }];
  });
  if (active.length === 0) return null;
  if (active.length !== 1) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_COMPETING_AUTHORITY',
      'Multiple active external TaskDiffReview grant attempts exist for the exact subject; status cannot select one by filename order.',
      ExitCode.guard,
    );
  }
  const { reservation, grant } = active[0]!;
  const currentActor = resolveTaskDiffImplementationActor(
    context.git.repositoryRoot,
    context.session.sessionId,
    subject,
    externalTaskDiffActorReplayOptions(reservation.implementationActor),
  );
  if (
    canonicalJson(currentActor) !==
    canonicalJson(reservation.implementationActor)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  if (
    grant.state === 'reserved' &&
    reservation.grant.degradedForm === 'direct-human-review'
  ) {
    return renderExternalDirectHumanPause(
      context.session.sessionId,
      subject,
      reservation,
    );
  }
  return Object.freeze({
    state: 'external-reconciliation-required' as const,
    source: 'external' as const,
    sessionId: context.session.sessionId,
    subject,
    implementationActor: currentActor,
    degradedForm: reservation.grant.degradedForm,
    grantId: reservation.grant.grantId,
    grantEnvelopeDigest: reservation.grant.grantEnvelopeDigest,
    transitionDigest: reservation.grant.grantTransitionDigest,
    reservationDigest: reservation.reservationDigest,
    inputDigest: reservation.inputDigest,
    reviewScopeDigest: reservation.reviewScopeDigest,
    submissionRecordDigest: reservation.submissionRecordDigest,
    reviewNodeId: reservation.contentNodeId,
    reviewResultDigest: reservation.contentResultDigest,
  });
}

function validateExternalTaskDiffPendingAttempt(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffExternalReviewReservation,
  grant: NonNullable<ReturnType<typeof readCollaborationGrantInspection>>,
): void {
  const submission = readTaskDiffExternalReviewSubmission(
    runtime,
    reservation.subjectDigest,
    reservation.reviewScopeDigest,
    reservation.inputDigest,
  );
  if (
    submission === null ||
    submission.recordDigest !== reservation.submissionRecordDigest ||
    submission.inputDigest !== reservation.inputDigest ||
    grant.grantId !== reservation.grant.grantId ||
    grant.signedEnvelopeDigest !== reservation.grant.grantEnvelopeDigest ||
    grant.targetDigest !== reservation.grant.grantTargetDigest ||
    grant.degradedForm !== reservation.grant.degradedForm ||
    grant.transitionDigest !== reservation.grant.grantTransitionDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const contentNode = readEvidenceNode(runtime, reservation.contentNodeId);
  const expectedNode = createExternalTaskDiffReviewContentNode(
    submission,
    reservation.implementationActor,
  );
  if (
    contentNode.resultDigest !== reservation.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expectedNode) ||
    (grant.state === 'consumed' &&
      (grant.use === undefined ||
        grant.use.signedEnvelopeDigest !==
          reservation.grant.grantEnvelopeDigest ||
        grant.use.transitionDigest !==
          reservation.grant.grantTransitionDigest ||
        grant.use.targetDigest !== reservation.grant.grantTargetDigest ||
        grant.use.degradedForm !== reservation.grant.degradedForm))
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

function inspectExternalTaskDiffContinuationPendingStatus(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  currentSubject: TaskDiffReviewSubject,
): TaskDiffReviewExternalContinuationLifecycleStatus | null {
  const active = listAllTaskDiffExternalContinuationReservations(runtime)
    .filter(
      (reservation) =>
        readTaskDiffExternalContinuationBinding(
          runtime,
          reservation.targetDigest,
        ) === null,
    )
    .flatMap((reservation) => {
      const grant = readCollaborationGrantInspection(
        context.git.gitCommonDirectory,
        reservation.grant.grantId,
      );
      if (grant === null || grant.state === 'available') {
        throw externalTaskDiffAuthorityInvalid();
      }
      if (
        grant.state === 'failed' ||
        grant.state === 'expired' ||
        grant.state === 'revoked'
      ) {
        return [];
      }
      return [{ reservation, grant }];
    });
  if (active.length === 0) return null;
  if (active.length !== 1) throw taskDiffReviewLineageConflict();
  const { reservation, grant } = active[0]!;
  const current = loadStructuralTaskDiffReviewForContinuation(
    context,
    runtime,
    currentSubject,
    reservation,
  );
  const storedResponse = readTaskDiffExternalChallengeResponse(
    runtime,
    reservation.subjectDigest,
    reservation.reviewRecordDigest,
    reservation.responseDigest,
  );
  if (storedResponse === null) throw externalTaskDiffAuthorityInvalid();
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    current.review,
    storedResponse.response,
  );
  const submission = readTaskDiffExternalClosureSubmission(
    runtime,
    reservation.targetDigest,
    reservation.inputDigest,
  );
  if (
    submission === null ||
    submission.subjectDigest !== reservation.subjectDigest ||
    submission.reviewRecordDigest !== reservation.reviewRecordDigest ||
    submission.responseDigest !== reservation.responseDigest ||
    submission.targetDigest !== reservation.targetDigest ||
    grant.grantId !== reservation.grant.grantId ||
    grant.signedEnvelopeDigest !== reservation.grant.grantEnvelopeDigest ||
    grant.targetDigest !== reservation.grant.grantTargetDigest ||
    grant.degradedForm !== reservation.grant.degradedForm ||
    grant.transitionDigest !== reservation.grant.grantTransitionDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const contentNode = readEvidenceNode(runtime, reservation.contentNodeId);
  const expectedContentNode =
    createExternalTaskDiffContinuationContentNode(submission);
  if (
    contentNode.resultDigest !== reservation.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expectedContentNode) ||
    (grant.state === 'consumed' &&
      (grant.use === undefined ||
        grant.use.signedEnvelopeDigest !==
          reservation.grant.grantEnvelopeDigest ||
        grant.use.transitionDigest !==
          reservation.grant.grantTransitionDigest ||
        grant.use.targetDigest !== reservation.grant.grantTargetDigest ||
        grant.use.degradedForm !== reservation.grant.degradedForm ||
        grant.use.structuredContent.nodeId !== reservation.contentNodeId ||
        grant.use.structuredContent.resultDigest !==
          reservation.contentResultDigest))
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  if (
    grant.state === 'reserved' &&
    reservation.grant.degradedForm === 'direct-human-review'
  ) {
    return renderExternalTaskDiffContinuationDirectHumanPause(
      context.session.sessionId,
      current,
      response,
      reservation,
    );
  }
  return Object.freeze({
    state: 'external-reconciliation-required' as const,
    source: 'external-continuation' as const,
    sessionId: context.session.sessionId,
    subject: current.subject,
    implementationActor: current.implementationActor,
    review: current.review,
    response,
    degradedForm: reservation.grant.degradedForm,
    grantId: reservation.grant.grantId,
    grantEnvelopeDigest: reservation.grant.grantEnvelopeDigest,
    transitionDigest: reservation.grant.grantTransitionDigest,
    reservationDigest: reservation.reservationDigest,
    inputDigest: reservation.inputDigest,
    contentNodeId: reservation.contentNodeId,
    contentResultDigest: reservation.contentResultDigest,
    reviewNodeId: reservation.contentNodeId,
    reviewResultDigest: reservation.contentResultDigest,
  });
}

function loadStructuralTaskDiffReviewForContinuation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  currentSubject: TaskDiffReviewSubject,
  continuation: TaskDiffExternalContinuationReservation,
): CurrentAuthenticatedTaskDiffReview {
  const externalBindings = listTaskDiffExternalReviewBindings(runtime).filter(
    (binding) => binding.reviewRecordDigest === continuation.reviewRecordDigest,
  );
  const providerBindings = listAllTaskDiffReviewResultBindings(runtime).filter(
    (binding) =>
      binding.review.recordDigest === continuation.reviewRecordDigest,
  );
  if (externalBindings.length + providerBindings.length !== 1) {
    throw taskDiffReviewLineageConflict();
  }
  if (externalBindings[0] !== undefined) {
    const historical = assertHistoricalExternalTaskDiffReviewBinding(
      context,
      runtime,
      externalBindings[0],
      undefined,
      'inspect',
    );
    assertTaskDiffReviewCandidateCurrent(currentSubject, historical.review);
    if (
      continuation.subjectDigest !== historical.review.subjectDigest ||
      canonicalJson(continuation.subject) !==
        canonicalJson(historical.review.subject)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    return Object.freeze({
      source: 'external' as const,
      subject: currentSubject,
      review: historical.review,
      implementationActor: historical.implementationActor,
      authenticatedReviewAuthority:
        authenticatedExternalReviewAuthority(historical),
      reviewResultNodeId: historical.binding.authorityNodeId,
      reviewResultDigest: historical.binding.authorityResultDigest,
    });
  }
  const providerBinding = providerBindings[0]!;
  const reservations = listAllTaskDiffReviewReservations(runtime).filter(
    (reservation) =>
      reservation.sessionId === providerBinding.sessionId &&
      reservation.subject.subjectDigest === providerBinding.subjectDigest,
  );
  if (reservations.length !== 1) throw taskDiffReviewLineageConflict();
  const reservation = reservations[0]!;
  assertCurrentTaskDiffReviewBinding(
    runtime,
    reservation,
    providerBinding.review,
  );
  assertTaskDiffReviewCandidateCurrent(currentSubject, providerBinding.review);
  if (
    continuation.subjectDigest !== providerBinding.review.subjectDigest ||
    canonicalJson(continuation.subject) !==
      canonicalJson(providerBinding.review.subject)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const providerId = providerBinding.review.assignment.reviewerProviderId;
  if (providerId === null) throw externalTaskDiffAuthorityInvalid();
  return Object.freeze({
    source: 'provider' as const,
    subject: currentSubject,
    review: providerBinding.review,
    implementationActor: reservation.implementationActor,
    authenticatedReviewAuthority: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'review' as const,
      subjectDigest: providerBinding.review.subjectDigest,
      reviewRecordDigest: providerBinding.review.recordDigest,
      responseDigest: null,
      authorityNodeId: providerBinding.providerResultNodeId,
      authorityResultDigest: providerBinding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId: providerBinding.review.assignment.reviewerPrincipalId,
        providerId,
        policyDigest: providerBinding.review.subject.reviewPolicyDigest,
      }),
    }),
    reviewResultNodeId: providerBinding.providerResultNodeId,
    reviewResultDigest: providerBinding.providerResultDigest,
  });
}

function isExternalRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStoredAdmittedRoleResultDigest(
  roleResult: AdmittedRoleResult,
): void {
  const { resultDigest, ...semantic } = roleResult;
  if (
    resultDigest !==
    sha256(canonicalJson({ schema: 'admitted-role-result.v1', ...semantic }))
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

/** Inspect the current subject and its durable lifecycle without creating work. */
export function inspectTaskDiffReviewStatus(
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewInspectionStatus {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
  if (!subject.reviewRequirement.required) {
    return Object.freeze({
      state: 'not-required' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const externalContinuationPending =
    inspectExternalTaskDiffContinuationPendingStatus(context, runtime, subject);
  if (externalContinuationPending !== null) {
    return externalContinuationPending;
  }
  const providerSource = readExactProviderTaskDiffReviewSource(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  const reservation = providerSource.reservation;
  const externalBinding = readTaskDiffExternalReviewBinding(
    runtime,
    subject.subjectDigest,
  );
  if (externalBinding !== null) {
    assertNoAllSessionProviderSourceCollision(runtime, subject.subjectDigest);
    if (reservation !== null || providerSource.binding !== null)
      throw taskDiffReviewLineageConflict();
    assertCurrentExternalTaskDiffReviewBinding(
      context,
      runtime,
      subject,
      externalBinding,
      undefined,
      'inspect',
    );
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      context,
      runtime,
      subject,
      'inspect',
    );
    if (candidatePlan.action !== 'reuse') {
      throw taskDiffReviewLineageConflict();
    }
    return renderReusedTaskDiffReviewStatus(
      context.session.sessionId,
      subject,
      loadReusedTaskDiffReview(
        runtime,
        context,
        subject,
        candidatePlan,
        'inspect',
      ),
    );
  }
  const externalPending = inspectExternalTaskDiffPendingStatus(
    context,
    runtime,
    subject,
  );
  if (externalPending !== null) {
    assertNoAllSessionProviderSourceCollision(runtime, subject.subjectDigest);
    if (reservation !== null || providerSource.binding !== null)
      throw taskDiffReviewLineageConflict();
    return externalPending;
  }
  const orphanExternalGrant = inspectExternalTaskDiffOrphanGrant(
    context,
    runtime,
    subject,
  );
  if (orphanExternalGrant !== null) {
    assertNoAllSessionProviderSourceCollision(runtime, subject.subjectDigest);
    if (reservation !== null || providerSource.binding !== null)
      throw taskDiffReviewLineageConflict();
    return renderExternalTaskDiffOrphanGrantStatus(
      context,
      subject,
      orphanExternalGrant,
    );
  }
  if (reservation === null) {
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      context,
      runtime,
      subject,
      'inspect',
    );
    if (candidatePlan.action === 'reuse') {
      return renderReusedTaskDiffReviewStatus(
        context.session.sessionId,
        subject,
        loadReusedTaskDiffReview(
          runtime,
          context,
          subject,
          candidatePlan,
          'inspect',
        ),
      );
    }
    return Object.freeze({
      state: 'ready' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  if (providerSource.binding !== null) {
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      context,
      runtime,
      subject,
      'inspect',
    );
    if (candidatePlan.action !== 'reuse') {
      throw taskDiffReviewLineageConflict();
    }
    const current = loadReusedTaskDiffReview(
      runtime,
      context,
      subject,
      candidatePlan,
      'inspect',
    );
    const continuationReservation = readTaskDiffReviewContinuationReservation(
      runtime,
      context.session.sessionId,
      providerSource.binding.review.recordDigest,
    );
    if (
      continuationReservation !== null &&
      readTaskDiffReviewContinuationResultBinding(
        runtime,
        context.session.sessionId,
        providerSource.binding.review.recordDigest,
      ) === null
    ) {
      assertContinuationReservationBound(
        reservation,
        providerSource.binding.review,
        continuationReservation.response,
        continuationReservation,
      );
      return renderTaskDiffReviewContinuationStatus(
        runtime,
        continuationReservation,
      );
    }
    return renderReusedTaskDiffReviewStatus(
      context.session.sessionId,
      subject,
      current,
    );
  }
  assertReservationCurrent(
    context,
    subject,
    reservation.implementationActor,
    reservation,
  );
  return renderTaskDiffReviewStatus(runtime, reservation);
}

/**
 * Replay the exact current initial review through the common provider/external
 * lineage and return only lifecycle-authenticated authority facts. Consumers
 * must not reconstruct authority from the returned review assignment alone.
 */
export function loadCurrentAuthenticatedTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
): CurrentAuthenticatedTaskDiffReview {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  return loadCurrentTaskDiffReview(context, runtime);
}

type CurrentTaskDiffReviewForProviderContinuation =
  CurrentAuthenticatedTaskDiffReview;

function loadCurrentTaskDiffReview(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
): CurrentTaskDiffReviewForProviderContinuation {
  const subject = inspectTaskDiffReviewSubject(
    context.git.repositoryRoot,
    context.session.sessionId,
  );
  if (!subject.reviewRequirement.required) throw reviewNotSatisfied();
  const exactProvider = readExactProviderTaskDiffReviewSource(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  const exactExternal = readTaskDiffExternalReviewBinding(
    runtime,
    subject.subjectDigest,
  );
  if (
    exactExternal !== null &&
    (exactProvider.reservation !== null || exactProvider.binding !== null)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const plan = resolveTaskDiffReviewCandidatePlan(context, runtime, subject);
  if (plan.action === 'review' || plan.action === 'not-required') {
    throw reviewNotSatisfied();
  }
  const reused = loadReusedTaskDiffReview(runtime, context, subject, plan);
  if (reused.source === 'external') {
    assertTaskDiffReviewCandidateCurrent(subject, reused.review);
    return Object.freeze({
      source: 'external' as const,
      subject,
      review: reused.review,
      implementationActor: reused.current.implementationActor,
      authenticatedReviewAuthority: authenticatedExternalReviewAuthority(
        reused.current,
      ),
      reviewResultNodeId: reused.current.binding.authorityNodeId,
      reviewResultDigest: reused.current.binding.authorityResultDigest,
    });
  }
  assertTaskDiffReviewCandidateCurrent(subject, reused.review);
  const providerId = reused.review.assignment.reviewerProviderId;
  if (providerId === null) throw reviewNotSatisfied();
  return Object.freeze({
    source: 'provider' as const,
    subject,
    review: reused.review,
    implementationActor: reused.reservation.implementationActor,
    authenticatedReviewAuthority: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'review' as const,
      subjectDigest: reused.review.subjectDigest,
      reviewRecordDigest: reused.review.recordDigest,
      responseDigest: null,
      authorityNodeId: reused.binding.providerResultNodeId,
      authorityResultDigest: reused.binding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId: reused.review.assignment.reviewerPrincipalId,
        providerId,
        policyDigest: reused.review.subject.reviewPolicyDigest,
      }),
    }),
    reviewResultNodeId: reused.binding.providerResultNodeId,
    reviewResultDigest: reused.binding.providerResultDigest,
  });
}

function assertTaskDiffReviewCandidateCurrent(
  subject: TaskDiffReviewSubject,
  review: TaskDiffReviewRecord,
): void {
  const plan = deriveTaskDiffReviewCandidatePlan({
    current: subject,
    predecessor: {
      subject: review.subject,
      reviewRecordDigest: review.recordDigest,
      finalAssuranceCommitmentDigest: null,
    },
  });
  if (plan.action !== 'reuse') throw reviewNotSatisfied();
}

function authenticatedExternalReviewAuthority(
  current: CurrentExternalTaskDiffReview,
): TaskDiffAuthenticatedReviewerAuthority {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'review' as const,
    subjectDigest: current.review.subjectDigest,
    reviewRecordDigest: current.review.recordDigest,
    responseDigest: null,
    authorityNodeId: current.binding.authorityNodeId,
    authorityResultDigest: current.binding.authorityResultDigest,
    authority: Object.freeze({
      kind: 'grant-attributed-external-reviewer' as const,
      principalId: current.review.assignment.reviewerPrincipalId,
      degradedForm: current.binding.grant.degradedForm,
      grantUseDigest: current.binding.grantUseDigest,
      policyDigest: current.review.subject.reviewPolicyDigest,
    }),
  });
}

/**
 * Convert caller-authored response evidence into the engine-owned response
 * record, then enter the existing authenticated continuation transaction. The
 * input cannot name a closer or disposition and therefore cannot mint closure
 * authority by itself.
 */
export function beginTaskDiffReviewContinuationFromInput(
  cwd: string,
  requestedSessionId: string,
  input: TaskDiffReviewChallengeResponseInput,
): TaskDiffReviewContinuationLifecycleStatus {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const current = loadCurrentTaskDiffReview(context, runtime);
  if (input.reviewRecordDigest !== current.review.recordDigest) {
    throw workflowError(
      'TASK_DIFF_REVIEW_RESPONSE_INPUT_STALE',
      'TaskDiffReview challenge response input does not name the current exact review record.',
      ExitCode.staleState,
    );
  }
  const response = createTaskDiffReviewChallengeResponse({
    review: current.review,
    responses: input.responses,
  });
  return beginTaskDiffReviewContinuation(
    cwd,
    context.session.sessionId,
    response,
  );
}

export function beginTaskDiffReviewContinuation(
  cwd: string,
  requestedSessionId: string,
  responseCandidate: TaskDiffReviewChallengeResponseRecord,
): TaskDiffReviewContinuationLifecycleStatus {
  const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(
    initialContext.runtime,
    (assertOwned) =>
      withSessionOperation(initialContext.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const current = loadCurrentTaskDiffReview(context, runtime);
        const response = assertTaskDiffReviewChallengeResponseCurrent(
          current.review,
          responseCandidate,
        );
        assertNoExternalTaskDiffContinuationCollision(
          context,
          runtime,
          current.review,
        );
        const existing = readTaskDiffReviewContinuationReservation(
          runtime,
          context.session.sessionId,
          current.review.recordDigest,
        );
        const reservation =
          existing ??
          createNewTaskDiffReviewContinuationReservation(
            context,
            runtime,
            current,
            response,
          );
        assertContinuationReservationCurrent(
          context,
          current,
          response,
          reservation,
        );
        ensureTaskDiffReviewContinuationInvocation(
          context,
          runtime,
          reservation,
          assertOwned,
        );
        assertOwned();
        return renderTaskDiffReviewContinuationStatus(
          runtime,
          reservation,
          current,
        );
      }),
  );
}

function assertNoExternalTaskDiffContinuationCollision(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  review: TaskDiffReviewRecord,
): void {
  if (
    listAllTaskDiffExternalContinuationBindings(runtime).some(
      (binding) => binding.reviewRecordDigest === review.recordDigest,
    )
  ) {
    throw taskDiffReviewLineageConflict();
  }
  for (const attempt of listAllTaskDiffExternalContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.reviewRecordDigest === review.recordDigest,
  )) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (inspection.state === 'reserved' || inspection.state === 'consumed') {
      throw taskDiffReviewLineageConflict();
    }
  }
}

export function reconcileTaskDiffReviewContinuation(
  cwd: string,
  requestedSessionId: string,
  requestedResponseDigest: string,
  options: ReconcileTaskDiffReviewContinuationOptions = {},
): TaskDiffReviewContinuationLifecycleStatus {
  const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(
    initialContext.runtime,
    (assertOwned) =>
      withSessionOperation(initialContext.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const current = loadCurrentTaskDiffReview(context, runtime);
        const reservation = readTaskDiffReviewContinuationReservation(
          runtime,
          context.session.sessionId,
          current.review.recordDigest,
        );
        if (reservation === null) throw continuationNotStarted();
        if (reservation.response.responseDigest !== requestedResponseDigest) {
          throw continuationNotStarted();
        }
        assertContinuationReservationCurrent(
          context,
          current,
          reservation.response,
          reservation,
        );
        let binding = readTaskDiffReviewContinuationResultBinding(
          runtime,
          context.session.sessionId,
          current.review.recordDigest,
        );
        if (binding !== null) {
          assertCurrentTaskDiffReviewContinuationBinding(
            runtime,
            reservation,
            binding.submission,
          );
        } else {
          const invocation = readProviderInvocation(
            runtime,
            reservation.request.invocationId,
          );
          if (invocation.state !== 'succeeded' || invocation.result === null) {
            return renderTaskDiffReviewContinuationStatus(
              runtime,
              reservation,
              current,
            );
          }
          if (invocation.result.runtimeObservation === null) {
            throw workflowError(
              'TASK_DIFF_REVIEW_PROVIDER_OBSERVATION_REQUIRED',
              'TaskDiffReview continuation authority requires a fixed-runner repository observation.',
              ExitCode.verification,
            );
          }
          const submission = assertTaskDiffReviewContinuationSubmissionCurrent(
            current.review,
            reservation.response,
            parseTaskDiffReviewContinuationSubmission(invocation.result.output),
          );
          const authorization = readEvidenceNode(
            runtime,
            reservation.authorizationNodeId,
          );
          const requestReservation = readEvidenceNode(
            runtime,
            reservation.reservationNodeId,
          );
          const resultNode = createEvidenceNode({
            type: 'task-diff-review-continuation-provider-result',
            nodeSchema:
              'workflow.task-diff-review-continuation-provider-result.v1',
            evaluator: 'workflow-task-diff-review.v1',
            policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
            exactInputDigests: {
              output: invocation.result.outputDigest,
              request: reservation.request.requestDigest,
              response: reservation.response.responseDigest,
              review: reservation.review.recordDigest,
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
              'workflow.task-diff-review-continuation-provider-result-output.v1',
            output: {
              ownerInvestigationId: reservation.ownerInvestigationId,
              sessionId: reservation.sessionId,
              invocationId: invocation.invocationId,
              requestDigest: reservation.request.requestDigest,
              outputDigest: invocation.result.outputDigest,
              responseDigest: reservation.response.responseDigest,
              submission,
            },
            runtimeMetadata: {
              runtimeObservation: invocation.result.runtimeObservation,
            },
          });
          writeEvidenceNode(runtime, resultNode);
          binding = createTaskDiffReviewContinuationResultBinding(runtime, {
            ownerInvestigationId: reservation.ownerInvestigationId,
            sessionId: reservation.sessionId,
            subjectDigest: reservation.subject.subjectDigest,
            reviewRecordDigest: reservation.review.recordDigest,
            responseDigest: reservation.response.responseDigest,
            invocationId: invocation.invocationId,
            requestDigest: reservation.request.requestDigest,
            outputDigest: invocation.result.outputDigest,
            runtimeObservationDigest: sha256(
              canonicalJson(invocation.result.runtimeObservation),
            ),
            providerResultNodeId: resultNode.nodeId,
            providerResultDigest: resultNode.resultDigest,
            submission,
            createdAt: invocation.updatedAt,
          });
          if (options.testCrashAfter === 'advisory-result-persisted') {
            throw new Error(
              'Simulated TaskDiffReview continuation interruption after advisory result persistence.',
            );
          }
        }
        ensureTaskDiffFinalAssurance(runtime, current, reservation, binding);
        assertOwned();
        return renderTaskDiffReviewContinuationStatus(
          runtime,
          reservation,
          current,
        );
      }),
  );
}

/** Adopt only a durable fixed-runner result for the still-current subject. */
export function reconcileTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  options: ReconcileTaskDiffReviewOptions = {},
): TaskDiffReviewInspectionStatus {
  const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(
    initialContext.runtime,
    (assertOwned) =>
      withSessionOperation(initialContext.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
        if (!subject.reviewRequirement.required) {
          return Object.freeze({
            state: 'not-required' as const,
            sessionId: context.session.sessionId,
            subject,
          });
        }
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const reservation = readTaskDiffReviewReservation(
          runtime,
          context.session.sessionId,
          subject.subjectDigest,
        );
        if (reservation === null) throw reviewNotStarted();
        assertReservationCurrent(
          context,
          subject,
          reservation.implementationActor,
          reservation,
        );
        const existing = readTaskDiffReviewResultBinding(
          runtime,
          context.session.sessionId,
          subject.subjectDigest,
        );
        if (existing !== null) {
          assertCurrentTaskDiffReviewBinding(
            runtime,
            reservation,
            existing.review,
          );
          ensureTaskDiffReviewSupersession(context, runtime, existing);
          bindDocumentationRemediation(
            cwd,
            requestedSessionId,
            existing.review,
          );
          return renderTaskDiffReviewStatus(runtime, reservation);
        }
        const invocation = readProviderInvocation(
          runtime,
          reservation.request.invocationId,
        );
        if (invocation.state !== 'succeeded' || invocation.result === null) {
          return renderTaskDiffReviewStatus(runtime, reservation);
        }
        if (invocation.result.runtimeObservation === null) {
          throw workflowError(
            'TASK_DIFF_REVIEW_PROVIDER_OBSERVATION_REQUIRED',
            'TaskDiffReview authority requires a fixed-runner repository observation.',
            ExitCode.verification,
          );
        }
        const authorization = readEvidenceNode(
          runtime,
          reservation.authorizationNodeId,
        );
        const requestReservation = readEvidenceNode(
          runtime,
          reservation.reservationNodeId,
        );
        const observationNode = createEvidenceNode({
          type: 'task-diff-review-provider-observation',
          nodeSchema: 'workflow.task-diff-review-provider-observation.v1',
          evaluator: 'workflow-task-diff-review.v1',
          policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
          exactInputDigests: {
            output: invocation.result.outputDigest,
            request: reservation.request.requestDigest,
            runtimeObservation: sha256(
              canonicalJson(invocation.result.runtimeObservation),
            ),
            subject: subject.subjectDigest,
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
            'workflow.task-diff-review-provider-observation-output.v1',
          output: {
            ownerInvestigationId: reservation.ownerInvestigationId,
            sessionId: reservation.sessionId,
            invocationId: invocation.invocationId,
            requestDigest: reservation.request.requestDigest,
            outputDigest: invocation.result.outputDigest,
            submission: invocation.result.output,
          },
          runtimeMetadata: {
            runtimeObservation: invocation.result.runtimeObservation,
          },
        });
        writeEvidenceNode(runtime, observationNode);
        const roleResult = admitTaskDiffReviewProviderResult({
          context,
          reservation,
          invocation: { ...invocation, result: invocation.result },
          observationNode,
          validation: options.collaborationGrantValidation,
          assertOwned,
        });
        if (
          roleResult.assignment.providerId === null ||
          roleResult.assignment.sessionId === null ||
          (roleResult.achievedIndependence !== 'provider-independent' &&
            roleResult.achievedIndependence !== 'session-independent')
        ) {
          throw reviewNotSatisfied();
        }
        const grantUseDigest =
          roleResult.grantUse === null
            ? null
            : sha256(canonicalJson(roleResult.grantUse));
        const degradedForm = roleResult.grantUse?.degradedForm ?? null;
        if (
          degradedForm !== null &&
          degradedForm !== 'same-provider-fresh-session'
        ) {
          throw reviewNotSatisfied();
        }
        const review = createTaskDiffReviewRecord({
          subject,
          reviewScope: reservation.manifest.reviewScope,
          assignment: {
            implementerPrincipalId:
              reservation.implementationActor.principalId!,
            implementerProviderId: reservation.implementationActor.providerId!,
            implementationSessionId: reservation.sessionId,
            reviewerPrincipalId:
              roleResult.participant.principalId ??
              `provider:${roleResult.assignment.providerId}`,
            reviewerProviderId: roleResult.assignment.providerId,
            reviewerSessionId: roleResult.assignment.sessionId,
            achievedIndependence: roleResult.achievedIndependence,
            degradedForm,
            grantUseDigest,
          },
          submission: invocation.result.output as never,
        });
        const resultNode = createEvidenceNode({
          type: 'task-diff-review-provider-result',
          nodeSchema: 'workflow.task-diff-review-provider-result.v1',
          evaluator: 'workflow-task-diff-review.v1',
          policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
          exactInputDigests: {
            admission: roleResult.resultDigest,
            observation: observationNode.resultDigest,
            subject: subject.subjectDigest,
          },
          semanticParentResultDigests: {
            observation: observationNode.resultDigest,
          },
          provenanceParentNodeIds: { observation: observationNode.nodeId },
          outputSchema: 'workflow.task-diff-review-provider-result-output.v1',
          output: {
            ownerInvestigationId: reservation.ownerInvestigationId,
            sessionId: reservation.sessionId,
            invocationId: invocation.invocationId,
            roleResult,
            review,
          },
          runtimeMetadata: {},
        });
        writeEvidenceNode(runtime, resultNode);
        const resultBinding = createTaskDiffReviewResultBinding(runtime, {
          ownerInvestigationId: reservation.ownerInvestigationId,
          sessionId: reservation.sessionId,
          subjectDigest: subject.subjectDigest,
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
          review,
          createdAt: invocation.updatedAt,
        });
        bindDocumentationRemediation(cwd, requestedSessionId, review);
        if (options.testCrashAfter === 'result-binding-persisted') {
          throw new Error(
            'Simulated TaskDiffReview interruption after result binding persistence.',
          );
        }
        ensureTaskDiffReviewSupersession(context, runtime, resultBinding);
        assertOwned();
        return renderTaskDiffReviewStatus(runtime, reservation);
      }),
  );
}

function bindDocumentationRemediation(
  cwd: string,
  requestedSessionId: string,
  review: TaskDiffReviewRecord,
): void {
  const assessment = review.documentationAssessment;
  if (assessment?.decision !== 'needs-changes') return;
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const transaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  if (
    transaction === null ||
    !['checked', 'staged', 'reports-persisted', 'completed'].includes(
      transaction.phase,
    )
  ) {
    throw reviewNotReady();
  }
  const inspection = inspectSession(cwd, requestedSessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    authorizedTransitionPaths: [...transaction.transitionPaths],
  });
  const current = inspection.session.documentationRemediation;
  const reviewRecordDigests = [
    ...(current?.reviewRecordDigests ?? []),
    review.recordDigest,
  ]
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .sort();
  const paths = [...(current?.paths ?? []), ...assessment.requiredPaths]
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .sort();
  if (
    canonicalJson(current ?? null) ===
    canonicalJson({ reviewRecordDigests, paths })
  ) {
    return;
  }
  persistSession(inspection, {
    ...inspection.session,
    documentationRemediation: { reviewRecordDigests, paths },
  });
}

export function assertCurrentTaskDiffReviewSatisfied(
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewRecord | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
  if (!subject.reviewRequirement.required) return null;
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const plan = resolveTaskDiffReviewCandidatePlan(context, runtime, subject);
  if (plan.action !== 'reuse') throw reviewNotSatisfied();
  const current = loadReusedTaskDiffReview(runtime, context, subject, plan);
  if (current.terminal.state === 'challenge-open') {
    return assertTaskDiffReviewContentSatisfied(subject, current.review, null);
  }
  if (current.terminal.state === 'changes-required') {
    throw workflowError(
      'TASK_DIFF_REVIEW_CHANGES_REQUIRED',
      'Authenticated TaskDiff Final Assurance accepted at least one challenge; change the candidate and obtain review for the new subject.',
      ExitCode.verification,
    );
  }
  return current.terminal.finalAssurance === null
    ? assertTaskDiffReviewContentSatisfied(subject, current.review, null)
    : current.review;
}

/**
 * One completion predicate for projected finalize and both legacy completion
 * entries. Legacy entries may continue only when the same policy calculation
 * says review is not required; they cannot manufacture review authority.
 */
export function assertTaskDiffReviewCompletionGateSatisfied(
  cwd: string,
  requestedSessionId: string,
  options: TaskDiffReviewCompletionGateOptions = {},
): TaskDiffReviewRecord | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  if (
    !taskDiffReviewIsActive(
      context.git.repositoryRoot,
      context.session.baseline.head,
    )
  ) {
    return null;
  }
  const inspection = inspectSession(cwd, requestedSessionId, {
    expectedSession: context.session,
    ...(options.projectedTaskIds === undefined
      ? {}
      : { projectedTaskIds: [...options.projectedTaskIds] }),
    ...(options.projectionSourceDigest === undefined
      ? {}
      : { projectionSourceDigest: options.projectionSourceDigest }),
    ...(options.authorizedTransitionPaths === undefined
      ? {}
      : { authorizedTransitionPaths: [...options.authorizedTransitionPaths] }),
  });
  const requirement = resolveTaskDiffReviewContract(inspection).requirement;
  if (!requirement.required) return null;
  try {
    return assertCurrentTaskDiffReviewSatisfied(cwd, requestedSessionId);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      [
        'TASK_DIFF_REVIEW_NOT_READY',
        'TASK_DIFF_REVIEW_NOT_STARTED',
        'TASK_DIFF_REVIEW_NOT_SATISFIED',
      ].includes(error.code)
    ) {
      const projected = (options.projectedTaskIds?.length ?? 0) > 0;
      throw workflowError(
        'TASK_DIFF_REVIEW_REQUIRED',
        'Completion requires current engine-minted TaskDiff Final Assurance for the exact checked candidate.',
        ExitCode.verification,
        {
          details: {
            sessionId: context.session.sessionId,
            reviewRequirement: requirement,
            ...(options.transactionId === undefined
              ? {}
              : { transactionId: options.transactionId }),
            ...(options.candidateTree === undefined
              ? {}
              : { candidateTree: options.candidateTree }),
          },
          recovery: projected
            ? `Run pnpm workflow rollback-completion ${context.session.sessionId} --reason "TaskDiffReview required" --json, then run pnpm workflow finalize-task ${context.session.sessionId} --json.`
            : `Run pnpm workflow finalize-task ${context.session.sessionId} --json, complete the returned review-diff recovery, then retry the same command.`,
        },
      );
    }
    throw error;
  }
}

export function loadTaskDiffDocumentationReviewCapture(
  cwd: string,
  requestedSessionId: string,
): DocumentationReviewCapture | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  if (
    !documentationClosureActivationAtCommit(
      context.git.repositoryRoot,
      context.session.baseline.head,
    ).activated
  ) {
    return null;
  }
  const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
  if (status.subject.documentationRequirement?.required !== true) return null;
  if (status.state !== 'satisfied' || !('review' in status)) {
    throw workflowError(
      'DOCUMENTATION_CLOSURE_REQUIRED',
      'The final task completion requires a satisfied documentation closure review.',
      ExitCode.verification,
    );
  }
  return Object.freeze({
    review: status.review,
    finalAssurance: status.finalAssurance,
  });
}

export function assertTaskDiffReviewProviderOwnerCurrent(
  cwd: string,
  requestedInvocationId: string,
):
  | TaskDiffReviewReservationRecord
  | TaskDiffReviewContinuationReservationRecord {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const invocation = readProviderInvocation(runtime, requestedInvocationId);
  const manifest = readProviderInvocationManifest(
    runtime,
    requestedInvocationId,
  );
  const request = readProviderInvocationRequest(runtime, requestedInvocationId);
  if (manifest.kind === 'task-diff-review-continuation-manifest') {
    const context = loadActiveSessionContext(cwd, manifest.sessionId);
    const current = loadCurrentTaskDiffReview(context, runtime);
    const reservation = readTaskDiffReviewContinuationReservation(
      runtime,
      manifest.sessionId,
      manifest.review.recordDigest,
    );
    if (reservation === null) throw continuationNotStarted();
    assertContinuationReservationCurrent(
      context,
      current,
      manifest.response,
      reservation,
    );
    if (
      invocation.investigationId !== reservation.ownerInvestigationId ||
      canonicalJson(invocation.mandateBinding ?? null) !==
        canonicalJson(reservation.mandateBinding) ||
      canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
      canonicalJson(request) !== canonicalJson(reservation.request)
    ) {
      throw workflowError(
        'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
        'Provider invocation no longer matches its current TaskDiffReview continuation owner.',
        ExitCode.staleState,
      );
    }
    return reservation;
  }
  if (manifest.kind !== 'task-diff-review-manifest') {
    throw workflowError(
      'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
      'Provider invocation is not owned by TaskDiffReview.',
      ExitCode.guard,
    );
  }
  const context = loadActiveSessionContext(cwd, manifest.sessionId);
  const subject = inspectTaskDiffReviewSubject(cwd, manifest.sessionId);
  const reservation = readTaskDiffReviewReservation(
    runtime,
    manifest.sessionId,
    manifest.subject.subjectDigest,
  );
  if (reservation === null) throw reviewNotStarted();
  assertReservationCurrent(
    context,
    subject,
    reservation.implementationActor,
    reservation,
  );
  if (
    invocation.investigationId !== reservation.ownerInvestigationId ||
    canonicalJson(invocation.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding) ||
    canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
    canonicalJson(request) !== canonicalJson(reservation.request)
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
      'Provider invocation no longer matches its current TaskDiffReview owner.',
      ExitCode.staleState,
    );
  }
  return reservation;
}

/**
 * Derive the immutable exact-diff review subject from a checked projected
 * finalize transaction. This is read-only: it neither accepts a review nor
 * advances the finalize journal.
 */
export function inspectTaskDiffReviewSubject(
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewSubject {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const transaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  if (
    transaction === null ||
    !['checked', 'staged', 'reports-persisted', 'completed'].includes(
      transaction.phase,
    ) ||
    transaction.candidateTree === null ||
    transaction.candidateFingerprint === null ||
    transaction.checkReportId === null
  ) {
    throw reviewNotReady();
  }
  const checkedTransaction = transaction as typeof transaction & {
    candidateTree: string;
    candidateFingerprint: string;
    checkReportId: string;
  };
  if (
    transaction.sessionId !== context.session.sessionId ||
    transaction.changeId !== context.session.changeId ||
    transaction.taskId !== context.session.taskId ||
    transaction.repositoryRoot !== context.git.repositoryRealPath ||
    transaction.gitCommonDirectory !== context.git.gitCommonDirectory ||
    transaction.branch !== context.session.branch ||
    canonicalJson(transaction.baseline) !==
      canonicalJson(context.session.baseline)
  ) {
    throw candidateDiverged();
  }

  const inspection = inspectSession(cwd, context.session.sessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    authorizedTransitionPaths: [...transaction.transitionPaths],
  });
  if (
    canonicalJson(inspection.changedPaths) !==
      canonicalJson(transaction.changedPaths) ||
    inspection.fingerprint !== transaction.candidateFingerprint ||
    canonicalJson(inspection.git.statusEntries) !==
      canonicalJson(transaction.candidateStatusEntries)
  ) {
    throw candidateDiverged();
  }
  assertCandidateIndex(inspection, checkedTransaction);

  const checkReport = readSessionReport(
    inspection,
    checkedTransaction.checkReportId,
  );
  const requiredChecks =
    transaction.schemaVersion === 2 && transaction.requiredChecks
      ? [...transaction.requiredChecks]
      : [...inspection.session.requiredChecks];
  assertInspectionReport(
    checkReport,
    inspection,
    'check',
    'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
    requiredChecks,
  );
  assertReportChecks(
    checkReport,
    inspection,
    requiredChecks,
    'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
  );
  if (
    checkReport.candidateTree !== checkedTransaction.candidateTree ||
    checkReport.finalizeProfile !== 'projected-single-pass-ordinary-failure' ||
    checkReport.checkEscalation !==
      (transaction.schemaVersion === 2
        ? (transaction.checkEscalation ?? null)
        : undefined)
  ) {
    throw candidateDiverged();
  }

  const planningAssurance = inspection.session.planningAssurance ?? null;
  if (planningAssurance === null) {
    throw workflowError(
      'TASK_DIFF_REVIEW_PLANNING_ASSURANCE_REQUIRED',
      'TaskDiffReview requires the exact planning assurance binding for this task.',
      ExitCode.staleState,
    );
  }
  const { executionTask, requirement } =
    resolveTaskDiffReviewContract(inspection);
  const maintainerPolicy = parseBaselineJson(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    'workflow/maintainer-policy.json',
    parseMaintainerPolicy,
  );
  const requiredCheckDigests = digestRequiredCheckDefinitions(
    inspection.contract.checks,
    requiredChecks,
  );

  const documentationRequirement = taskDiffDocumentationRequirement(
    inspection,
    checkedTransaction.candidateTree,
  );
  return createTaskDiffReviewSubject({
    repositoryId: maintainerPolicy.repository.id,
    changeId: inspection.session.changeId,
    taskId: inspection.session.taskId,
    baseCommit: inspection.session.baseline.head,
    baseTree: inspection.session.baseline.tree,
    candidateTree: checkedTransaction.candidateTree,
    transitions: deriveTransitions(
      inspection.git.repositoryRoot,
      inspection.session.baseline.tree,
      checkedTransaction.candidateTree,
      transaction.changedPaths,
    ),
    taskContractDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-task-contract.v1',
        guardTask: inspection.policy,
        executionTask,
      }),
    ),
    requiredCheckPolicyDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-check-policy.v1',
        requiredCheckDigests,
      }),
    ),
    checkEvidenceDigest: checkedTransaction.checkReportId,
    planningGenerationId: planningAssurance.planningGenerationId,
    planTargetDigest: planningAssurance.planTargetDigest,
    planReviewNodeId: planningAssurance.reviewNodeId,
    planningAssuranceDigest: sha256(canonicalJson(planningAssurance)),
    reviewRequirement:
      documentationRequirement.required && !requirement.required
        ? { required: true, basis: 'explicit', riskPaths: [] }
        : requirement,
    documentationRequirement,
  });
}

function taskDiffDocumentationRequirement(
  inspection: SessionInspection,
  candidateTree: string,
) {
  const activation = assertDocumentationClosureActivation({
    repositoryRoot: inspection.git.repositoryRoot,
    baseline: inspection.session.baseline.head,
    readMarker: () =>
      readDocumentationClosureActivationMarkerFile(
        inspection.git.repositoryRoot,
      ),
  });
  if (!activation.activated) {
    return createTaskDiffDocumentationClosureRequirement({ required: false });
  }
  const remainingTasks = inspection.contract.tasks.filter(
    ({ completed, id }) => !completed && id !== inspection.session.taskId,
  );
  if (remainingTasks.length > 0) {
    return createTaskDiffDocumentationClosureRequirement({ required: false });
  }
  const completedTasks = inspection.contract.tasks.filter(
    ({ completed, id }) => completed && id !== inspection.session.taskId,
  );
  let changeBaseCommit = inspection.session.baseline.head;
  if (completedTasks.length > 0) {
    const firstTask = completedTasks[0]!;
    const commits = findExactTaskCommits(
      inspection.git.repositoryRoot,
      inspection.session.changeId,
      firstTask.id,
      inspection.session.baseline.head,
    );
    if (commits.length !== 1) {
      throw workflowError(
        'TASK_DIFF_DOCUMENTATION_BASE_INVALID',
        'Final documentation review requires one canonical first-task commit.',
        ExitCode.staleState,
        { details: { taskId: firstTask.id, commitCount: commits.length } },
      );
    }
    changeBaseCommit = runGit(inspection.git.repositoryRoot, [
      'rev-parse',
      `${commits[0]!.hash}^`,
    ]).trim();
  }
  const changeBaseTree = runGit(inspection.git.repositoryRoot, [
    'rev-parse',
    `${changeBaseCommit}^{tree}`,
  ]).trim();
  const ignoredPaths = new Set([
    `${inspection.contract.config.changeRoot}/${inspection.session.changeId}/tasks.md`,
    ...completionDocumentPaths(inspection.git.repositoryRoot),
  ]);
  const changedPaths = runGit(inspection.git.repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    changeBaseTree,
    candidateTree,
    '--',
  ])
    .split('\0')
    .filter((candidate) => candidate !== '' && !ignoredPaths.has(candidate))
    .sort();
  if (changedPaths.length === 0) {
    throw workflowError(
      'TASK_DIFF_DOCUMENTATION_CHANGE_EMPTY',
      'Final documentation review requires at least one non-projection change path.',
      ExitCode.verification,
    );
  }
  const transitions = deriveTransitions(
    inspection.git.repositoryRoot,
    changeBaseTree,
    candidateTree,
    changedPaths,
  );
  return createTaskDiffDocumentationClosureRequirement({
    required: true,
    changeBaseCommit,
    changeBaseTree,
    candidateTree,
    changedPaths,
    patchDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-documentation-change-patch.v1',
        transitions,
      }),
    ),
    hints: documentationHints(changedPaths),
  });
}

function documentationHints(
  changedPaths: readonly string[],
): readonly TaskDiffDocumentationHint[] {
  const hints = new Map<TaskDiffDocumentationHint['reason'], Set<string>>();
  const add = (
    reason: TaskDiffDocumentationHint['reason'],
    paths: readonly string[],
  ) => {
    const existing = hints.get(reason) ?? new Set<string>();
    for (const candidate of paths) existing.add(candidate);
    hints.set(reason, existing);
  };
  for (const changedPath of changedPaths) {
    if (
      changedPath.startsWith('packages/workflow-engine/src/cli') ||
      changedPath.startsWith('packages/workflow-engine/src/lifecycle') ||
      changedPath.includes('workflow')
    ) {
      add('workflow-lifecycle-changed', ['docs/WORKFLOW.md']);
    }
    if (
      changedPath.includes('/controller') ||
      changedPath.includes('/dto/') ||
      changedPath.endsWith('package.json')
    ) {
      add('public-interface-changed', ['docs/features']);
    }
    if (
      changedPath.includes('config') ||
      changedPath.startsWith('workflow/schemas/')
    ) {
      add('configuration-changed', ['docs/WORKFLOW.md']);
    }
    if (changedPath.includes('migration')) {
      add('migration-changed', ['docs/architecture', 'docs/features']);
    }
    if (
      changedPath.startsWith('apps/mobile/') ||
      changedPath.startsWith('apps/api/')
    ) {
      add('user-visible-behavior-changed', ['docs/features']);
    }
    if (
      changedPath === 'docs/issues/issues.yaml' ||
      changedPath === 'docs/ISSUE_LOG.md' ||
      changedPath === 'docs/ROADMAP.md'
    ) {
      add('issue-or-roadmap-state-changed', [
        'docs/ISSUE_LOG.md',
        'docs/ROADMAP.md',
      ]);
    }
    if (
      changedPath.includes('authority') ||
      changedPath.includes('grant') ||
      changedPath.includes('security')
    ) {
      add('authority-boundary-changed', [
        'docs/WORKFLOW.md',
        'docs/architecture',
      ]);
    }
  }
  return [...hints.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, suggestedPaths]) => ({
      reason,
      suggestedPaths: [...suggestedPaths].sort(),
    }));
}

function resolveTaskDiffReviewContract(inspection: SessionInspection) {
  const executionTask =
    inspection.contract.execution?.tasks[inspection.session.taskId];
  if (executionTask === undefined) {
    throw workflowError(
      'TASK_DIFF_REVIEW_TASK_CONTRACT_REQUIRED',
      'TaskDiffReview requires an exact execution task contract.',
      ExitCode.staleState,
    );
  }
  const pathRoles = parseBaselineJson(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    'workflow/path-roles.json',
    parsePathRoleRegistry,
  );
  const pathRoleFacts = inspection.changedPaths.map((changedPath) => {
    const resolution = resolvePathRole(pathRoles, changedPath);
    return {
      path: changedPath,
      role: resolution.registered ? resolution.role : ('unregistered' as const),
    };
  });
  return {
    executionTask,
    requirement: taskDiffReviewRequirement({
      diffReview: executionTask.diffReview,
      strategy: executionTask.strategy,
      paths: pathRoleFacts,
    }),
  };
}

function taskDiffReviewIsActive(
  repositoryRoot: string,
  baselineHead: string,
): boolean {
  return ['workflow/maintainer-policy.json', 'workflow/path-roles.json'].every(
    (activationPath) =>
      runGit(repositoryRoot, [
        'ls-tree',
        '--name-only',
        baselineHead,
        '--',
        activationPath,
      ]).trim() === activationPath,
  );
}

function resolveTaskDiffReviewCandidatePlan(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  replayMode: TaskDiffReviewReplayMode = 'governing',
): TaskDiffReviewCandidatePlan {
  return loadTaskDiffReviewLineage(context, runtime, subject, replayMode)
    .candidatePlan;
}

type LoadedTaskDiffReviewLineageSource = TaskDiffReviewLineageEntry &
  Readonly<
    | {
        source: 'provider';
        provider: Readonly<{
          reservation: TaskDiffReviewReservationRecord;
          binding: TaskDiffReviewResultBinding;
        }>;
      }
    | {
        source: 'external';
        external: CurrentExternalTaskDiffReview;
      }
  >;

type LoadedTaskDiffReviewLineageEntry = LoadedTaskDiffReviewLineageSource &
  Readonly<{ terminal: ReplayedTaskDiffReviewTerminal }>;

type TaskDiffReviewSupersessionRecoveryTarget = Readonly<{
  predecessorReviewRecordDigest: string;
  successorReviewRecordDigest: string;
}>;

function readExactProviderTaskDiffReviewSource(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  sessionId: string,
  subjectDigest: string,
) {
  const reservation = readTaskDiffReviewReservation(
    runtime,
    sessionId,
    subjectDigest,
  );
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    sessionId,
    subjectDigest,
  );
  if (binding !== null && reservation === null) {
    throw taskDiffReviewLineageConflict();
  }
  return Object.freeze({ reservation, binding });
}

function assertNoAllSessionProviderSourceCollision(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
): void {
  if (
    listAllTaskDiffReviewReservations(runtime).some(
      (reservation) => reservation.subject.subjectDigest === subjectDigest,
    ) ||
    listAllTaskDiffReviewResultBindings(runtime).some(
      (binding) => binding.subjectDigest === subjectDigest,
    )
  ) {
    throw taskDiffReviewLineageConflict();
  }
}

function loadTaskDiffReviewLineage(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  replayMode: TaskDiffReviewReplayMode = 'governing',
  allowedMissingSupersession: TaskDiffReviewSupersessionRecoveryTarget | null = null,
): Readonly<{
  candidatePlan: TaskDiffReviewCandidatePlan;
  predecessor: LoadedTaskDiffReviewLineageEntry | null;
  entries: readonly LoadedTaskDiffReviewLineageEntry[];
}> {
  const entries: LoadedTaskDiffReviewLineageEntry[] = [];
  const providerBindings = listAllTaskDiffReviewResultBindings(runtime);
  for (const binding of providerBindings) {
    const reservation = readTaskDiffReviewReservation(
      runtime,
      binding.sessionId,
      binding.subjectDigest,
    );
    if (reservation === null) throw taskDiffReviewLineageConflict();
    assertCurrentTaskDiffReviewBinding(
      runtime,
      reservation,
      binding.review,
      replayMode,
    );
    if (
      binding.review.subject.repositoryId !== subject.repositoryId ||
      binding.review.subject.changeId !== subject.changeId ||
      binding.review.subject.taskId !== subject.taskId ||
      binding.review.subject.baseCommit !== subject.baseCommit ||
      binding.review.subject.baseTree !== subject.baseTree
    ) {
      continue;
    }
    const source = {
      source: 'provider',
      subject: binding.review.subject,
      reviewRecordDigest: binding.review.recordDigest,
      reviewScope: binding.review.reviewScope,
      finalAssuranceCommitmentDigest: null,
      provider: Object.freeze({ reservation, binding }),
    } satisfies LoadedTaskDiffReviewLineageSource;
    const terminal = replayTaskDiffReviewTerminal(
      context,
      runtime,
      source,
      replayMode,
    );
    entries.push({
      ...source,
      finalAssuranceCommitmentDigest: terminal.commitmentDigest,
      terminal,
    });
  }
  for (const binding of listTaskDiffExternalReviewBindings(runtime)) {
    const reviewedSubject = bindingSubject(runtime, binding);
    if (
      reviewedSubject.repositoryId !== subject.repositoryId ||
      reviewedSubject.changeId !== subject.changeId ||
      reviewedSubject.taskId !== subject.taskId ||
      reviewedSubject.baseCommit !== subject.baseCommit ||
      reviewedSubject.baseTree !== subject.baseTree
    ) {
      continue;
    }
    const current = assertHistoricalExternalTaskDiffReviewBinding(
      context,
      runtime,
      binding,
      undefined,
      replayMode,
    );
    const source = {
      source: 'external',
      subject: current.review.subject,
      reviewRecordDigest: current.review.recordDigest,
      reviewScope: current.review.reviewScope,
      finalAssuranceCommitmentDigest: null,
      external: current,
    } satisfies LoadedTaskDiffReviewLineageSource;
    const terminal = replayTaskDiffReviewTerminal(
      context,
      runtime,
      source,
      replayMode,
    );
    entries.push({
      ...source,
      finalAssuranceCommitmentDigest: terminal.commitmentDigest,
      terminal,
    });
  }
  assertNoOrphanTaskDiffReviewContinuations(context, runtime, entries);
  assertTaskDiffReviewTerminalLineageEdges(entries);
  const resolved = resolveTaskDiffReviewLineage({ current: subject, entries });
  const predecessor =
    resolved.predecessor === null
      ? null
      : (entries.find(
          (entry) =>
            entry.reviewRecordDigest ===
            resolved.predecessor!.reviewRecordDigest,
        ) ?? null);
  if ((resolved.predecessor === null) !== (predecessor === null)) {
    throw taskDiffReviewLineageConflict();
  }
  if (
    predecessor?.terminal.state === 'challenge-open' &&
    resolved.candidatePlan.action !== 'reuse'
  ) {
    throw taskDiffReviewPriorChallengeOpen();
  }
  assertLegacyProviderSupersessionProjection(
    runtime,
    context,
    entries,
    allowedMissingSupersession,
  );
  return Object.freeze({
    candidatePlan: resolved.candidatePlan,
    predecessor,
    entries: Object.freeze(entries),
  });
}

function assertTaskDiffReviewTerminalLineageEdges(
  entries: readonly LoadedTaskDiffReviewLineageEntry[],
): void {
  const byReview = new Map(
    entries.map((entry) => [entry.reviewRecordDigest, entry]),
  );
  for (const entry of entries) {
    const predecessor = entry.reviewScope.predecessor;
    if (predecessor === null) continue;
    const parent = byReview.get(predecessor.reviewRecordDigest);
    if (parent === undefined) continue;
    if (parent.terminal.state === 'challenge-open') {
      throw taskDiffReviewPriorChallengeOpen();
    }
    if (
      parent.terminal.commitmentDigest !==
      predecessor.finalAssuranceCommitmentDigest
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
}

function replayTaskDiffReviewTerminal(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  source: LoadedTaskDiffReviewLineageSource,
  replayMode: TaskDiffReviewReplayMode,
): ReplayedTaskDiffReviewTerminal {
  const current = authenticatedTaskDiffReviewFromLineageSource(source);
  const review = current.review;
  const providerReservations = listAllTaskDiffReviewContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.review.recordDigest === review.recordDigest,
  );
  const providerBindings = listAllTaskDiffReviewContinuationResultBindings(
    runtime,
  ).filter((binding) => binding.reviewRecordDigest === review.recordDigest);
  const externalReservations = listAllTaskDiffExternalContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.reviewRecordDigest === review.recordDigest,
  );
  const externalBindings = listAllTaskDiffExternalContinuationBindings(
    runtime,
  ).filter((binding) => binding.reviewRecordDigest === review.recordDigest);
  const activeExternalReservations = externalReservations.filter(
    (reservation) => {
      const inspection = inspectExternalGrant(
        context.git.gitCommonDirectory,
        reservation.grant.grantId,
      );
      return inspection.state === 'reserved' || inspection.state === 'consumed';
    },
  );
  if (
    providerReservations.length > 1 ||
    providerBindings.length > 1 ||
    activeExternalReservations.length > 1 ||
    externalBindings.length > 1 ||
    (providerBindings.length === 1 && providerReservations.length !== 1)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const providerReservation = providerReservations[0] ?? null;
  const providerBinding = providerBindings[0] ?? null;
  if (
    providerReservation !== null &&
    (canonicalJson(providerReservation.review) !== canonicalJson(review) ||
      providerReservation.subject.subjectDigest !== review.subjectDigest)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  if (
    providerBinding !== null &&
    (providerReservation === null ||
      providerBinding.sessionId !== providerReservation.sessionId ||
      providerBinding.subjectDigest !== review.subjectDigest ||
      providerBinding.responseDigest !==
        providerReservation.response.responseDigest)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const hasExternalContinuation =
    activeExternalReservations.length > 0 || externalBindings.length > 0;
  let providerReservationIsShortageProvenance = false;
  if (hasExternalContinuation && providerBinding === null) {
    assertExternalTaskDiffContinuationProviderShortage(
      context,
      runtime,
      context.session.sessionId,
      review,
    );
    providerReservationIsShortageProvenance = providerReservation !== null;
  }
  const hasProviderContinuation =
    !providerReservationIsShortageProvenance &&
    (providerReservation !== null || providerBinding !== null);
  if (hasProviderContinuation && hasExternalContinuation) {
    throw taskDiffReviewLineageConflict();
  }
  const storedAssurance = readTaskDiffFinalAssuranceBinding(
    runtime,
    review.subjectDigest,
  );
  if (review.challenges.length === 0) {
    if (
      hasProviderContinuation ||
      hasExternalContinuation ||
      storedAssurance !== null
    ) {
      throw taskDiffReviewLineageConflict();
    }
    assertTaskDiffReviewContentSatisfied(review.subject, review, null);
    return Object.freeze({
      state: 'satisfied' as const,
      finalAssurance: null,
      commitmentDigest: null,
      closureSource: null,
    });
  }
  if (hasProviderContinuation && providerReservation !== null) {
    if (providerBinding === null) {
      if (storedAssurance !== null) throw taskDiffReviewLineageConflict();
      return openTaskDiffReviewTerminal(null);
    }
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      providerReservation,
      providerBinding.submission,
    );
    const assurance = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current,
      providerReservation,
      providerBinding,
    );
    return assurance === null
      ? openTaskDiffReviewTerminal('provider')
      : closedTaskDiffReviewTerminal(assurance, 'provider');
  }
  if (externalBindings.length === 1) {
    const assurance = loadAuthenticatedExternalTaskDiffTerminalAssurance({
      context,
      runtime,
      current,
      replayMode,
    });
    return assurance === null
      ? openTaskDiffReviewTerminal('external')
      : closedTaskDiffReviewTerminal(assurance.finalAssurance, 'external');
  }
  if (storedAssurance !== null) throw taskDiffReviewLineageConflict();
  return openTaskDiffReviewTerminal(null);
}

function authenticatedTaskDiffReviewFromLineageSource(
  source: LoadedTaskDiffReviewLineageSource,
): CurrentAuthenticatedTaskDiffReview {
  if (source.source === 'external') {
    return Object.freeze({
      source: 'external' as const,
      subject: source.subject,
      review: source.external.review,
      implementationActor: source.external.implementationActor,
      authenticatedReviewAuthority: authenticatedExternalReviewAuthority(
        source.external,
      ),
      reviewResultNodeId: source.external.binding.authorityNodeId,
      reviewResultDigest: source.external.binding.authorityResultDigest,
    });
  }
  const providerId =
    source.provider.binding.review.assignment.reviewerProviderId;
  if (providerId === null) throw reviewNotSatisfied();
  return Object.freeze({
    source: 'provider' as const,
    subject: source.subject,
    review: source.provider.binding.review,
    implementationActor: source.provider.reservation.implementationActor,
    authenticatedReviewAuthority: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'review' as const,
      subjectDigest:
        source.reviewRecordDigest ===
        source.provider.binding.review.recordDigest
          ? source.subject.subjectDigest
          : (() => {
              throw taskDiffReviewLineageConflict();
            })(),
      reviewRecordDigest: source.reviewRecordDigest,
      responseDigest: null,
      authorityNodeId: source.provider.binding.providerResultNodeId,
      authorityResultDigest: source.provider.binding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId:
          source.provider.binding.review.assignment.reviewerPrincipalId,
        providerId,
        policyDigest: source.subject.reviewPolicyDigest,
      }),
    }),
    reviewResultNodeId: source.provider.binding.providerResultNodeId,
    reviewResultDigest: source.provider.binding.providerResultDigest,
  });
}

function openTaskDiffReviewTerminal(
  closureSource: ReplayedTaskDiffReviewTerminal['closureSource'],
): ReplayedTaskDiffReviewTerminal {
  return Object.freeze({
    state: 'challenge-open' as const,
    finalAssurance: null,
    commitmentDigest: null,
    closureSource,
  });
}

function closedTaskDiffReviewTerminal(
  finalAssurance: TaskDiffFinalAssuranceRecord,
  closureSource: Exclude<ReplayedTaskDiffReviewTerminal['closureSource'], null>,
): ReplayedTaskDiffReviewTerminal {
  return Object.freeze({
    state: finalAssurance.verdict,
    finalAssurance,
    commitmentDigest: finalAssurance.commitmentDigest,
    closureSource,
  });
}

function assertNoOrphanTaskDiffReviewContinuations(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  entries: readonly LoadedTaskDiffReviewLineageEntry[],
): void {
  const reviewDigests = new Set(
    entries.map(({ reviewRecordDigest }) => reviewRecordDigest),
  );
  const subjectDigests = new Set(
    entries.map(({ subject }) => subject.subjectDigest),
  );
  const currentSubject = inspectTaskDiffReviewSubject(
    context.git.repositoryRoot,
    context.session.sessionId,
  );
  for (const reservation of listAllTaskDiffReviewContinuationReservations(
    runtime,
  )) {
    if (
      sameTaskDiffReviewLineage(reservation.subject, currentSubject) &&
      !reviewDigests.has(reservation.review.recordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const binding of listAllTaskDiffReviewContinuationResultBindings(
    runtime,
  )) {
    if (
      (reviewDigests.has(binding.reviewRecordDigest) ||
        subjectDigests.has(binding.subjectDigest)) &&
      !reviewDigests.has(binding.reviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const reservation of listAllTaskDiffExternalContinuationReservations(
    runtime,
  )) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      reservation.grant.grantId,
    );
    if (
      (inspection.state === 'reserved' || inspection.state === 'consumed') &&
      sameTaskDiffReviewLineage(reservation.subject, currentSubject) &&
      !reviewDigests.has(reservation.reviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const binding of listAllTaskDiffExternalContinuationBindings(runtime)) {
    if (
      (reviewDigests.has(binding.reviewRecordDigest) ||
        subjectDigests.has(binding.subjectDigest)) &&
      !reviewDigests.has(binding.reviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
}

function sameTaskDiffReviewLineage(
  left: TaskDiffReviewSubject,
  right: TaskDiffReviewSubject,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.changeId === right.changeId &&
    left.taskId === right.taskId &&
    left.baseCommit === right.baseCommit &&
    left.baseTree === right.baseTree
  );
}

function assertLegacyProviderSupersessionProjection(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  context: ReturnType<typeof loadActiveSessionContext>,
  entries: readonly LoadedTaskDiffReviewLineageEntry[],
  allowedMissingSupersession: TaskDiffReviewSupersessionRecoveryTarget | null,
): void {
  const byReview = new Map(
    entries.map((entry) => [entry.reviewRecordDigest, entry]),
  );
  const commonRelations = listTaskDiffReviewLineageSupersessions(runtime);
  for (const relation of commonRelations) {
    const predecessor = byReview.get(relation.predecessorReviewRecordDigest);
    const successor = byReview.get(relation.successorReviewRecordDigest);
    if (predecessor === undefined && successor === undefined) continue;
    if (
      predecessor === undefined ||
      successor === undefined ||
      canonicalJson(predecessor.subject) !==
        canonicalJson(relation.predecessorSubject) ||
      canonicalJson(
        predecessor.source === 'provider'
          ? predecessor.provider.binding.review
          : predecessor.external.review,
      ) !== canonicalJson(relation.predecessorReview) ||
      canonicalJson(successor.subject) !==
        canonicalJson(relation.successorSubject) ||
      canonicalJson(
        successor.source === 'provider'
          ? successor.provider.binding.review
          : successor.external.review,
      ) !== canonicalJson(relation.successorReview) ||
      canonicalJson(successor.reviewScope) !==
        canonicalJson(relation.successorReviewScope)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const successor of entries) {
    const predecessor = successor.reviewScope.predecessor;
    if (predecessor === null) continue;
    const relation = commonRelations.find(
      (candidate) =>
        candidate.predecessorReviewRecordDigest ===
        predecessor.reviewRecordDigest,
    );
    if (relation !== undefined) continue;
    if (
      allowedMissingSupersession?.predecessorReviewRecordDigest ===
        predecessor.reviewRecordDigest &&
      allowedMissingSupersession.successorReviewRecordDigest ===
        successor.reviewRecordDigest
    ) {
      continue;
    }
    throw taskDiffReviewSupersessionReconciliationRequired();
  }
  for (const relation of listTaskDiffReviewSupersessions(
    runtime,
    context.session.sessionId,
  )) {
    const predecessor = byReview.get(relation.predecessorReviewRecordDigest);
    const successor = byReview.get(relation.supersededByDigest);
    if (
      predecessor === undefined ||
      successor === undefined ||
      predecessor.subject.subjectDigest !== relation.predecessorSubjectDigest ||
      successor.subject.subjectDigest !== relation.supersededBySubjectDigest ||
      canonicalJson(successor.reviewScope) !==
        canonicalJson(relation.reviewScope)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
}

function ensureTaskDiffReviewSupersession(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffReviewResultBinding,
): void {
  const scope = binding.review.reviewScope;
  const predecessor = scope.predecessor;
  if (predecessor === null) return;
  const lineage = loadTaskDiffReviewLineage(
    context,
    runtime,
    binding.review.subject,
    'governing',
    {
      predecessorReviewRecordDigest: predecessor.reviewRecordDigest,
      successorReviewRecordDigest: binding.review.recordDigest,
    },
  );
  const predecessorEntry = lineage.entries.find(
    (entry) => entry.reviewRecordDigest === predecessor.reviewRecordDigest,
  );
  const successorEntry = lineage.entries.find(
    (entry) => entry.reviewRecordDigest === binding.review.recordDigest,
  );
  if (
    predecessorEntry === undefined ||
    successorEntry === undefined ||
    predecessorEntry.subject.subjectDigest !== predecessor.subjectDigest ||
    predecessorEntry.terminal.state === 'challenge-open' ||
    predecessorEntry.terminal.commitmentDigest !==
      predecessor.finalAssuranceCommitmentDigest ||
    successorEntry.source !== 'provider' ||
    canonicalJson(successorEntry.provider.binding) !== canonicalJson(binding)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const predecessorReview =
    predecessorEntry.source === 'provider'
      ? predecessorEntry.provider.binding.review
      : predecessorEntry.external.review;
  createTaskDiffReviewLineageSupersession(runtime, {
    predecessorSubject: predecessorEntry.subject,
    predecessorReview,
    successorSubject: binding.review.subject,
    successorReview: binding.review,
    successorReviewScope: binding.review.reviewScope,
    successorReviewScopeDigest: binding.review.reviewScope.scopeDigest,
  });
  createTaskDiffReviewSupersession(runtime, {
    sessionId: binding.sessionId,
    predecessorSubjectDigest: predecessor.subjectDigest,
    predecessorReviewRecordDigest: predecessor.reviewRecordDigest,
    supersededBySubjectDigest: binding.subjectDigest,
    supersededByDigest: binding.review.recordDigest,
    reviewScope: scope,
    createdAt: binding.createdAt,
  });
}

function loadReusedTaskDiffReview(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  context: ReturnType<typeof loadActiveSessionContext>,
  currentSubject: TaskDiffReviewSubject,
  plan: Extract<TaskDiffReviewCandidatePlan, { action: 'reuse' }>,
  replayMode: TaskDiffReviewReplayMode = 'governing',
): Readonly<
  | {
      source: 'provider';
      subject: TaskDiffReviewSubject;
      reservation: TaskDiffReviewReservationRecord;
      binding: TaskDiffReviewResultBinding;
      review: TaskDiffReviewRecord;
      terminal: ReplayedTaskDiffReviewTerminal;
    }
  | {
      source: 'external';
      subject: TaskDiffReviewSubject;
      current: CurrentExternalTaskDiffReview;
      review: TaskDiffReviewRecord;
      terminal: ReplayedTaskDiffReviewTerminal;
    }
> {
  const lineage = loadTaskDiffReviewLineage(
    context,
    runtime,
    currentSubject,
    replayMode,
  );
  const predecessor = lineage.predecessor;
  if (
    predecessor === null ||
    predecessor.subject.subjectDigest !== plan.predecessor.subjectDigest ||
    predecessor.reviewRecordDigest !== plan.predecessor.reviewRecordDigest ||
    predecessor.finalAssuranceCommitmentDigest !==
      plan.predecessor.finalAssuranceCommitmentDigest
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const replay = deriveTaskDiffReviewCandidatePlan({
    current: currentSubject,
    predecessor: {
      subject: predecessor.subject,
      reviewRecordDigest: predecessor.reviewRecordDigest,
      finalAssuranceCommitmentDigest:
        plan.predecessor.finalAssuranceCommitmentDigest,
    },
  });
  if (canonicalJson(replay) !== canonicalJson(plan)) {
    throw taskDiffReviewLineageConflict();
  }
  if (predecessor.source === 'external') {
    return Object.freeze({
      source: 'external' as const,
      subject: currentSubject,
      current: predecessor.external,
      review: predecessor.external.review,
      terminal: predecessor.terminal,
    });
  }
  return Object.freeze({
    source: 'provider' as const,
    subject: currentSubject,
    reservation: predecessor.provider.reservation,
    binding: predecessor.provider.binding,
    review: predecessor.provider.binding.review,
    terminal: predecessor.terminal,
  });
}

function renderReusedTaskDiffReviewStatus(
  currentSessionId: string,
  currentSubject: TaskDiffReviewSubject,
  current: ReturnType<typeof loadReusedTaskDiffReview>,
): TaskDiffReviewLifecycleStatus {
  const state =
    current.terminal.state === 'challenge-open'
      ? current.terminal.closureSource === null
        ? ('challenge-response-required' as const)
        : ('challenge-closure-required' as const)
      : current.terminal.state;
  if (current.source === 'external') {
    return Object.freeze({
      state,
      source: 'external' as const,
      sessionId: currentSessionId,
      subject: currentSubject,
      implementationActor: current.current.implementationActor,
      assignment: current.current.assignment,
      review: current.review,
      finalAssurance: current.terminal.finalAssurance,
    });
  }
  return Object.freeze({
    state,
    sessionId: currentSessionId,
    subject: currentSubject,
    implementationActor: current.reservation.implementationActor,
    assignment: current.reservation.request
      .roleAssignment as ProviderRoleAssignment,
    ownerInvestigationId: current.reservation.ownerInvestigationId,
    invocationId: current.reservation.request.invocationId,
    review: current.review,
    finalAssurance: current.terminal.finalAssurance,
  });
}

function createNewTaskDiffReviewReservation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  candidatePlan: TaskDiffReviewCandidatePlan,
  implementationActor: RecordedRoleParticipant,
  collaborationGrant: BeginTaskDiffReviewOptions['collaborationGrant'],
  assertOwned: () => void,
):
  | TaskDiffReviewReservationRecord
  | Readonly<{
      kind: 'task-diff-review-collaboration-grant-required';
      status: TaskDiffReviewCollaborationGrantRequiredStatus;
    }> {
  if (implementationActor.identityAssurance === 'maintainer-signed') {
    throw workflowError(
      'TASK_DIFF_REVIEW_ACTOR_INVALID',
      'TaskDiffReview implementation actor has unsupported assurance.',
      ExitCode.guard,
    );
  }
  const callerAttributed =
    !implementationActor.engineSpawned &&
    (implementationActor.identityAssurance === 'self-declared' ||
      implementationActor.identityAssurance === 'runtime-hint');
  const engineAttributedProvider =
    implementationActor.engineSpawned &&
    implementationActor.identityAssurance === 'adapter-assigned' &&
    implementationActor.providerId !== null &&
    implementationActor.sessionId !== null;
  if (!callerAttributed && !engineAttributedProvider) {
    throw workflowError(
      'TASK_DIFF_REVIEW_ACTOR_INVALID',
      'TaskDiffReview implementation actor has unsupported assurance.',
      ExitCode.guard,
    );
  }
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  const seed = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-diff-review-owner.v1',
      sessionId: context.session.sessionId,
      subjectDigest: subject.subjectDigest,
    }),
  );
  const providerSessionId = `provider-session-task-diff-${seed}`;
  const author: RoleParticipant = {
    providerId: implementationActor.providerId ?? undefined,
    sessionId: implementationActor.sessionId ?? undefined,
    principalId: implementationActor.principalId ?? undefined,
    identityAssurance: implementationActor.identityAssurance,
    engineSpawned: implementationActor.engineSpawned,
  };
  const scheduled = scheduleOrdinaryRole({
    role: 'task-diff-reviewer',
    author,
    targetDigest: subject.subjectDigest,
    candidates: (['codex', 'claude'] as const).map((providerId) => ({
      providerId,
      sessionId: providerSessionId,
      enabled: policy.policy.providers[providerId].enabled,
      available: policy.policy.providers[providerId].enabled,
    })),
  });
  let assignment: ProviderRoleAssignment;
  if (scheduled.outcome !== 'assigned') {
    const callableProviderIds = (['codex', 'claude'] as const).filter(
      (providerId) => policy.policy.providers[providerId].enabled,
    );
    const grantRequest = taskDiffReviewGrantRequest({
      context,
      subject,
      implementationActor,
      callableProviderIds,
    });
    if (collaborationGrant === undefined) {
      return Object.freeze({
        kind: 'task-diff-review-collaboration-grant-required' as const,
        status: Object.freeze({
          state: 'collaboration-grant-required' as const,
          sessionId: context.session.sessionId,
          subject,
          implementationActor,
          inputSchema: Object.freeze({
            schemaVersion: 1 as const,
            kind: 'collaboration-grant-selection' as const,
            lifecyclePhase: 'task-diff-review' as const,
            conflictingRole: 'task-diff-reviewer' as const,
            grantRequest,
            allowedDegradedForms: Object.freeze(
              grantRequest === null
                ? (['caller-supplied', 'direct-human-review'] as const)
                : (['same-provider-fresh-session'] as const),
            ),
            resumeOption: '--grant <grant-id>' as const,
          }),
        }),
      });
    }
    if (grantRequest === null) {
      throw workflowError(
        'COLLABORATION_GRANT_FORM_REQUIRED',
        'TaskDiffReview requires an explicitly typed caller-supplied or direct-human review grant when no provider is callable.',
        ExitCode.guard,
      );
    }
    const expectedBinding = deriveTaskDiffCollaborationGrantBinding(
      context.git.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = collaborationTransitionDigest(expectedBinding);
    const grantReservation = reserveCollaborationGrantUnderLifecycleLock(
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
    );
    assignment = authorizeGrantedOrdinaryRole({
      role: 'task-diff-reviewer',
      author,
      targetDigest: subject.subjectDigest,
      reservation: grantReservation,
      actualParticipant: {
        providerId: implementationActor.providerId ?? undefined,
        sessionId: providerSessionId,
        principalId: `collaboration-grant:${grantReservation.grantId}:task-diff-reviewer`,
        identityAssurance: implementationActor.identityAssurance,
        engineSpawned: true,
      },
      callableProviderIds,
    }) as GrantedSameProviderRoleAssignment;
  } else {
    assignment = scheduled.assignment;
  }
  const ownerInvestigationId = `investigation-task-diff-${seed}`;
  if (candidatePlan.action !== 'review') throw reviewNotSatisfied();
  const mandateBinding = (context.session.mandateBinding ??
    null) as TaskMandateBinding | null;
  const authorization = createEvidenceNode({
    type: 'task-diff-review-authorization',
    nodeSchema: 'workflow.task-diff-review-authorization.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      actor: sha256(canonicalJson(implementationActor)),
      assignment: sha256(canonicalJson(assignment)),
      mandate: sha256(canonicalJson(mandateBinding)),
      session: sha256(
        canonicalJson({
          sessionId: context.session.sessionId,
          changeId: context.session.changeId,
          taskId: context.session.taskId,
        }),
      ),
      subject: subject.subjectDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.task-diff-review-authorization-output.v1',
    output: {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      subject,
      implementationActor,
      assignment,
      mandateBinding,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorization);
  const manifest: TaskDiffReviewManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: context.session.changeId,
    taskId: context.session.taskId,
    sessionId: context.session.sessionId,
    repositoryId: context.config.repositoryName,
    repositoryIdentity: subject.repositoryId,
    baseCommit: context.session.baseline.head,
    baseTree: context.session.baseline.tree,
    subject,
    reviewScope: candidatePlan.scope,
    capabilityProfile: 'repository-read-only',
  };
  const request = createProviderInvocationRequest({
    invocationId: `invocation-task-diff-${seed}`,
    nonce: `task-diff-review-${seed}`,
    purpose: 'task-diff-review',
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
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-diff-review.v1',
    policyDigest: policy.digest,
    limits: {
      timeoutMs: policy.policy.limits.timeoutMs,
      aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
    },
  });
  const requestReservation = createEvidenceNode({
    type: 'task-diff-review-request-reservation',
    nodeSchema: 'workflow.task-diff-review-request-reservation.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      manifest: request.inputManifestDigest,
      request: request.requestDigest,
      subject: subject.subjectDigest,
    },
    semanticParentResultDigests: {
      authorization: authorization.resultDigest,
    },
    provenanceParentNodeIds: { authorization: authorization.nodeId },
    outputSchema: 'workflow.task-diff-review-request-reservation-output.v1',
    output: {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      subject,
      implementationActor,
      assignment,
      manifest,
      request,
      mandateBinding,
    },
    runtimeMetadata: {},
  });
  storeProviderExecutionPolicySnapshot(runtime, request, policy);
  writeEvidenceNode(runtime, requestReservation);
  return createTaskDiffReviewReservation(runtime, {
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
    implementationActor,
    manifest,
    request,
    authorizationNodeId: authorization.nodeId,
    reservationNodeId: requestReservation.nodeId,
    createdAt: new Date().toISOString(),
  });
}

function taskDiffReviewGrantRequest(input: {
  context: ReturnType<typeof loadActiveSessionContext>;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  callableProviderIds: readonly ProviderId[];
}): CollaborationGrantRequest | null {
  const providerId = input.implementationActor.providerId;
  if (
    providerId === null ||
    (input.implementationActor.identityAssurance !== 'self-declared' &&
      input.implementationActor.identityAssurance !== 'runtime-hint') ||
    input.callableProviderIds.length !== 1 ||
    input.callableProviderIds[0] !== providerId
  ) {
    return null;
  }
  return {
    changeId: input.context.session.changeId,
    taskId: input.context.session.taskId,
    baselineCommit: input.context.session.baseline.head,
    baselineTree: input.context.session.baseline.tree,
    targetDigest: input.subject.subjectDigest,
    lifecyclePhase: 'task-diff-review',
    rolePair: {
      authorRole: 'task-implementer',
      conflictingRole: 'task-diff-reviewer',
    },
    availableActor: {
      kind: 'provider',
      providerId,
      assurance: input.implementationActor.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason:
      'No provider-independent TaskDiffReview reviewer is enabled for this exact candidate.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function deriveTaskDiffCollaborationGrantBinding(
  repositoryRoot: string,
  request: CollaborationGrantRequest,
): CollaborationGrantExpectedBinding {
  const policy = parseBaselineJson(
    repositoryRoot,
    request.baselineCommit,
    'workflow/maintainer-policy.json',
    parseMaintainerPolicy,
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

function admitTaskDiffReviewProviderResult(input: {
  context: ReturnType<typeof loadActiveSessionContext>;
  reservation: TaskDiffReviewReservationRecord;
  invocation: ReturnType<typeof readProviderInvocation> & {
    result: NonNullable<ReturnType<typeof readProviderInvocation>['result']>;
  };
  observationNode: ReturnType<typeof createEvidenceNode>;
  validation: ReconcileTaskDiffReviewOptions['collaborationGrantValidation'];
  assertOwned: () => void;
}): AdmittedRoleResult {
  const assignment = input.reservation.request.roleAssignment;
  const content = {
    kind: 'task-diff-review' as const,
    nodeId: input.observationNode.nodeId,
    resultDigest: input.observationNode.resultDigest,
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
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
    const policy = baselineAdapterPolicy(
      input.context.git.repositoryRoot,
      input.context.session.baseline.head,
    );
    const callableProviderIds = (['codex', 'claude'] as const).filter(
      (providerId) => policy.policy.providers[providerId].enabled,
    );
    const grantRequest = taskDiffReviewGrantRequest({
      context: input.context,
      subject: input.reservation.subject,
      implementationActor: input.reservation.implementationActor,
      callableProviderIds,
    });
    if (grantRequest === null) throw reviewNotSatisfied();
    const expectedBinding = deriveTaskDiffCollaborationGrantBinding(
      input.context.git.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = collaborationTransitionDigest(expectedBinding);
    const maintainerPolicy = parseBaselineJson(
      input.context.git.repositoryRoot,
      expectedBinding.baselineCommit,
      'workflow/maintainer-policy.json',
      parseMaintainerPolicy,
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
    if (consumed.use === undefined) throw reviewNotSatisfied();
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
    author: input.reservation.implementationActor,
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
      sessionId: assignment.sessionId!,
      targetDigest: input.reservation.subject.subjectDigest,
      engineSpawned: true,
    },
    grantUse,
    grantValidation,
  });
}

function createNewTaskDiffReviewContinuationReservation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  current: CurrentTaskDiffReviewForProviderContinuation,
  response: TaskDiffReviewChallengeResponseRecord,
): TaskDiffReviewContinuationReservationRecord {
  const review = current.review;
  const implementationActor = current.implementationActor;
  const implementationActorAssurance = implementationActor.identityAssurance;
  if (implementationActorAssurance === 'maintainer-signed') {
    throw workflowError(
      'TASK_DIFF_REVIEW_ACTOR_INVALID',
      'TaskDiffReview continuation cannot derive provider scheduling from a maintainer-signed implementation actor.',
      ExitCode.guard,
    );
  }
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  const seed = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-diff-review-continuation-owner.v1',
      sessionId: context.session.sessionId,
      subjectDigest: review.subjectDigest,
      reviewRecordDigest: review.recordDigest,
      responseDigest: response.responseDigest,
    }),
  );
  const providerSessionId = `provider-session-task-diff-continuation-${seed}`;
  const preferredProviderId = review.assignment.reviewerProviderId;
  if (
    preferredProviderId !== null &&
    preferredProviderId !== 'codex' &&
    preferredProviderId !== 'claude'
  ) {
    throw reviewNotSatisfied();
  }
  const reviewerProviderId =
    preferredProviderId ??
    (['codex', 'claude'] as const).find(
      (providerId) =>
        policy.policy.providers[providerId].enabled &&
        providerId !== implementationActor.providerId,
    );
  if (reviewerProviderId === undefined) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CONTINUATION_REVIEWER_REQUIRED',
      'Challenge continuation requires a provider-independent reviewer in a fresh session.',
      ExitCode.guard,
    );
  }
  const scheduled = scheduleOrdinaryRole({
    role: 'task-diff-reviewer',
    author: {
      providerId: implementationActor.providerId ?? undefined,
      sessionId: implementationActor.sessionId ?? undefined,
      principalId: implementationActor.principalId ?? undefined,
      identityAssurance: implementationActorAssurance,
      engineSpawned: false,
    },
    targetDigest: review.subjectDigest,
    candidates: [
      {
        providerId: reviewerProviderId,
        sessionId: providerSessionId,
        enabled: policy.policy.providers[reviewerProviderId].enabled,
        available: policy.policy.providers[reviewerProviderId].enabled,
      },
    ],
  });
  if (
    scheduled.outcome !== 'assigned' ||
    scheduled.assignment.providerId !== reviewerProviderId ||
    scheduled.assignment.sessionId === review.assignment.reviewerSessionId
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CONTINUATION_REVIEWER_REQUIRED',
      'Challenge continuation requires the original provider-independent reviewer in a fresh session.',
      ExitCode.guard,
    );
  }
  const assignment = scheduled.assignment;
  const ownerInvestigationId = `investigation-task-diff-continuation-${seed}`;
  const mandateBinding = context.session.mandateBinding ?? null;
  const authorization = createEvidenceNode({
    type: 'task-diff-review-authorization',
    nodeSchema: 'workflow.task-diff-review-authorization.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      actor: sha256(canonicalJson(implementationActor)),
      assignment: sha256(canonicalJson(assignment)),
      mandate: sha256(canonicalJson(mandateBinding)),
      session: sha256(
        canonicalJson({
          sessionId: context.session.sessionId,
          changeId: context.session.changeId,
          taskId: context.session.taskId,
        }),
      ),
      subject: review.subjectDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.task-diff-review-authorization-output.v1',
    output: {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      subject: review.subject,
      implementationActor,
      assignment,
      mandateBinding,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorization);
  const manifest: TaskDiffReviewContinuationManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-manifest',
    changeId: context.session.changeId,
    taskId: context.session.taskId,
    sessionId: context.session.sessionId,
    repositoryId: context.config.repositoryName,
    repositoryIdentity: review.subject.repositoryId,
    baseCommit: context.session.baseline.head,
    baseTree: context.session.baseline.tree,
    subject: review.subject,
    review,
    response,
    capabilityProfile: 'repository-read-only',
  };
  const request = createProviderInvocationRequest({
    invocationId: `invocation-task-diff-continuation-${seed}`,
    nonce: `task-diff-review-continuation-${seed}`,
    purpose: 'task-diff-review',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: context.config.repositoryName,
    baseCommit: context.session.baseline.head,
    baseTree: context.session.baseline.tree,
    targetDigest: review.subjectDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: authorization.nodeId,
    writeAllowedPaths: [],
    outputSchema: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-diff-review-continuation.v1',
    policyDigest: policy.digest,
    limits: {
      timeoutMs: policy.policy.limits.timeoutMs,
      aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
    },
  });
  const requestReservation = createEvidenceNode({
    type: 'task-diff-review-continuation-request-reservation',
    nodeSchema: 'workflow.task-diff-review-continuation-reservation.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      manifest: request.inputManifestDigest,
      request: request.requestDigest,
      response: response.responseDigest,
      review: review.recordDigest,
      subject: review.subjectDigest,
    },
    semanticParentResultDigests: {
      authorization: authorization.resultDigest,
    },
    provenanceParentNodeIds: { authorization: authorization.nodeId },
    outputSchema:
      'workflow.task-diff-review-continuation-reservation-output.v1',
    output: {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      subject: review.subject,
      implementationActor,
      assignment,
      review,
      response,
      manifest,
      request,
      mandateBinding,
    },
    runtimeMetadata: {},
  });
  storeProviderExecutionPolicySnapshot(runtime, request, policy);
  writeEvidenceNode(runtime, requestReservation);
  return createTaskDiffReviewContinuationReservation(runtime, {
    ownerInvestigationId,
    sessionId: context.session.sessionId,
    changeId: context.session.changeId,
    taskId: context.session.taskId,
    repositoryRoot: context.git.repositoryRealPath,
    gitCommonDirectory: context.git.gitCommonDirectory,
    branch: context.session.branch,
    baseline: context.session.baseline,
    mandateBinding,
    subject: review.subject,
    implementationActor,
    review,
    response,
    manifest,
    request,
    authorizationNodeId: authorization.nodeId,
    reservationNodeId: requestReservation.nodeId,
    createdAt: new Date().toISOString(),
  });
}

function ensureTaskDiffReviewInvocation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewReservationRecord,
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
      throw workflowError(
        'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
        'Durable TaskDiffReview provider work differs from its exact reservation.',
        ExitCode.conflict,
      );
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

function ensureTaskDiffReviewContinuationInvocation(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewContinuationReservationRecord,
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
      throw workflowError(
        'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
        'Durable TaskDiffReview continuation work differs from its exact reservation.',
        ExitCode.conflict,
      );
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

function renderTaskDiffReviewStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewReservationRecord,
): TaskDiffReviewInspectionStatus {
  const assignment = reservation.request
    .roleAssignment as ProviderRoleAssignment;
  const common = {
    sessionId: reservation.sessionId,
    subject: reservation.subject,
    implementationActor: reservation.implementationActor,
    assignment,
    ownerInvestigationId: reservation.ownerInvestigationId,
    invocationId: reservation.request.invocationId,
  };
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    reservation.sessionId,
    reservation.subject.subjectDigest,
  );
  if (binding !== null) {
    assertCurrentTaskDiffReviewBinding(runtime, reservation, binding.review);
    if (binding.review.challenges.length === 0) {
      return Object.freeze({
        state: 'satisfied',
        ...common,
        review: binding.review,
        finalAssurance: null,
      });
    }
    const continuationReservation = readTaskDiffReviewContinuationReservation(
      runtime,
      reservation.sessionId,
      binding.review.recordDigest,
    );
    if (continuationReservation === null) {
      return Object.freeze({
        state: 'challenge-response-required',
        ...common,
        review: binding.review,
        finalAssurance: null,
      });
    }
    assertContinuationReservationBound(
      reservation,
      binding.review,
      continuationReservation.response,
      continuationReservation,
    );
    return renderTaskDiffReviewContinuationStatus(
      runtime,
      continuationReservation,
    );
  }
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'failed') {
    if (invocation.failure === null) throw reviewNotSatisfied();
    return Object.freeze({
      state: 'provider-failed',
      ...common,
      failure: invocation.failure,
    });
  }
  return Object.freeze({
    state:
      invocation.state === 'succeeded'
        ? 'provider-succeeded-awaiting-reconciliation'
        : 'waiting-for-provider',
    ...common,
  });
}

function renderTaskDiffReviewContinuationStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewContinuationReservationRecord,
  authenticatedCurrent?: CurrentAuthenticatedTaskDiffReview,
): TaskDiffReviewContinuationLifecycleStatus {
  const assignment = reservation.request
    .roleAssignment as ProviderRoleAssignment;
  const common = {
    sessionId: reservation.sessionId,
    subject: reservation.subject,
    implementationActor: reservation.implementationActor,
    assignment,
    ownerInvestigationId: reservation.ownerInvestigationId,
    invocationId: reservation.request.invocationId,
    review: reservation.review,
    response: reservation.response,
  };
  const binding = readTaskDiffReviewContinuationResultBinding(
    runtime,
    reservation.sessionId,
    reservation.review.recordDigest,
  );
  if (binding !== null) {
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      reservation,
      binding.submission,
    );
    const current =
      authenticatedCurrent ??
      authenticatedProviderTaskDiffReviewForContinuationStatus(
        runtime,
        reservation,
      );
    const finalAssurance = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current,
      reservation,
      binding,
    );
    return Object.freeze({
      state:
        finalAssurance === null
          ? 'challenge-closure-required'
          : finalAssurance.verdict,
      ...common,
      finalAssurance,
      failure: null,
    });
  }
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'failed') {
    if (invocation.failure === null) throw reviewNotSatisfied();
    return Object.freeze({
      state: 'provider-failed',
      ...common,
      finalAssurance: null,
      failure: invocation.failure,
    });
  }
  return Object.freeze({
    state:
      invocation.state === 'succeeded'
        ? 'provider-succeeded-awaiting-reconciliation'
        : 'waiting-for-provider',
    ...common,
    finalAssurance: null,
    failure: null,
  });
}

function authenticatedProviderTaskDiffReviewForContinuationStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  continuation: TaskDiffReviewContinuationReservationRecord,
): CurrentAuthenticatedTaskDiffReview {
  const matches = listAllTaskDiffReviewResultBindings(runtime).filter(
    (binding) =>
      binding.review.recordDigest === continuation.review.recordDigest,
  );
  if (matches.length !== 1) throw reviewNotSatisfied();
  const binding = matches[0]!;
  const reservation = readTaskDiffReviewReservation(
    runtime,
    binding.sessionId,
    binding.subjectDigest,
  );
  if (reservation === null) throw reviewNotSatisfied();
  assertCurrentTaskDiffReviewBinding(runtime, reservation, binding.review);
  return authenticatedTaskDiffReviewFromLineageSource({
    source: 'provider',
    subject: binding.review.subject,
    reviewRecordDigest: binding.review.recordDigest,
    reviewScope: binding.review.reviewScope,
    finalAssuranceCommitmentDigest: null,
    provider: Object.freeze({ reservation, binding }),
  });
}

function assertReservationCurrent(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
  expectedActor: RecordedRoleParticipant,
  reservation: TaskDiffReviewReservationRecord,
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
    canonicalJson(reservation.implementationActor) !==
      canonicalJson(expectedActor)
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_RESERVATION_STALE',
      'TaskDiffReview reservation no longer matches its WorkflowSession or candidate.',
      ExitCode.staleState,
    );
  }
}

function assertContinuationReservationCurrent(
  context: ReturnType<typeof loadActiveSessionContext>,
  current: CurrentTaskDiffReviewForProviderContinuation,
  response: TaskDiffReviewChallengeResponseRecord,
  reservation: TaskDiffReviewContinuationReservationRecord,
): void {
  assertTaskDiffReviewCandidateCurrent(current.subject, current.review);
  const exactResponse = assertTaskDiffReviewChallengeResponseCurrent(
    current.review,
    response,
  );
  const providerId = reservation.request.providerId;
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
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
    canonicalJson(reservation.subject) !==
      canonicalJson(current.review.subject) ||
    canonicalJson(reservation.implementationActor) !==
      canonicalJson(current.implementationActor) ||
    canonicalJson(reservation.review) !== canonicalJson(current.review) ||
    canonicalJson(reservation.response) !== canonicalJson(exactResponse) ||
    reservation.request.roleAssignment.providerId !== providerId ||
    reservation.request.roleAssignment.sessionId ===
      current.review.assignment.reviewerSessionId ||
    !policy.policy.providers[providerId].enabled ||
    providerId === current.implementationActor.providerId ||
    (current.review.assignment.reviewerProviderId !== null &&
      providerId !== current.review.assignment.reviewerProviderId) ||
    canonicalJson(reservation.manifest.review) !==
      canonicalJson(current.review) ||
    canonicalJson(reservation.manifest.response) !==
      canonicalJson(exactResponse)
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CONTINUATION_RESERVATION_STALE',
      'TaskDiffReview continuation reservation no longer matches its current review, response, or WorkflowSession.',
      ExitCode.staleState,
    );
  }
}

function assertContinuationReservationBound(
  reviewReservation: TaskDiffReviewReservationRecord,
  review: TaskDiffReviewRecord,
  responseCandidate: TaskDiffReviewChallengeResponseRecord,
  reservation: TaskDiffReviewContinuationReservationRecord,
): void {
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    review,
    responseCandidate,
  );
  if (
    reservation.sessionId !== reviewReservation.sessionId ||
    reservation.changeId !== reviewReservation.changeId ||
    reservation.taskId !== reviewReservation.taskId ||
    reservation.repositoryRoot !== reviewReservation.repositoryRoot ||
    reservation.gitCommonDirectory !== reviewReservation.gitCommonDirectory ||
    reservation.branch !== reviewReservation.branch ||
    canonicalJson(reservation.baseline) !==
      canonicalJson(reviewReservation.baseline) ||
    canonicalJson(reservation.mandateBinding) !==
      canonicalJson(reviewReservation.mandateBinding) ||
    canonicalJson(reservation.subject) !==
      canonicalJson(reviewReservation.subject) ||
    canonicalJson(reservation.implementationActor) !==
      canonicalJson(reviewReservation.implementationActor) ||
    canonicalJson(reservation.review) !== canonicalJson(review) ||
    canonicalJson(reservation.response) !== canonicalJson(response) ||
    reservation.request.providerId !== review.assignment.reviewerProviderId ||
    reservation.request.roleAssignment.providerId !==
      review.assignment.reviewerProviderId ||
    reservation.request.roleAssignment.sessionId ===
      review.assignment.reviewerSessionId ||
    canonicalJson(reservation.manifest.review) !== canonicalJson(review) ||
    canonicalJson(reservation.manifest.response) !== canonicalJson(response)
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CONTINUATION_RESERVATION_STALE',
      'TaskDiffReview continuation reservation no longer matches its current review, response, or WorkflowSession.',
      ExitCode.staleState,
    );
  }
}

function assertCurrentTaskDiffReviewBinding(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewReservationRecord,
  expectedReview: TaskDiffReviewRecord,
  replayMode: TaskDiffReviewReplayMode = 'governing',
): void {
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    reservation.sessionId,
    reservation.subject.subjectDigest,
  );
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (
    binding === null ||
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    invocation.result.runtimeObservation === null ||
    binding.ownerInvestigationId !== reservation.ownerInvestigationId ||
    binding.subjectDigest !== reservation.subject.subjectDigest ||
    binding.invocationId !== invocation.invocationId ||
    binding.requestDigest !== reservation.request.requestDigest ||
    binding.outputDigest !== invocation.result.outputDigest ||
    binding.runtimeObservationDigest !==
      sha256(canonicalJson(invocation.result.runtimeObservation)) ||
    canonicalJson(binding.review) !== canonicalJson(expectedReview)
  ) {
    throw reviewNotSatisfied();
  }
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
  if (
    observationNode.resultDigest !== binding.providerObservationDigest ||
    observationNode.type !== 'task-diff-review-provider-observation' ||
    observationNode.nodeSchema !==
      'workflow.task-diff-review-provider-observation.v1' ||
    observationNode.evaluator !== 'workflow-task-diff-review.v1' ||
    observationNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    observationNode.outputSchema !==
      'workflow.task-diff-review-provider-observation-output.v1' ||
    canonicalJson(observationNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        requestDigest: reservation.request.requestDigest,
        outputDigest: invocation.result.outputDigest,
        submission: invocation.result.output,
      }) ||
    canonicalJson(observationNode.runtimeMetadata) !==
      canonicalJson({
        runtimeObservation: invocation.result.runtimeObservation,
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
      reservation.reservationNodeId
  ) {
    throw reviewNotSatisfied();
  }
  const content = {
    kind: 'task-diff-review' as const,
    nodeId: observationNode.nodeId,
    resultDigest: observationNode.resultDigest,
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluator: reservation.request.evaluatorVersion,
    policyDigest: reservation.request.policyDigest,
    contentDigest: observationNode.resultDigest,
    current: true as const,
  };
  const assignment = reservation.request.roleAssignment;
  let grantUseForReplay = binding.roleResult.grantUse;
  let grantValidation: NonNullable<
    Parameters<typeof admitRoleResult>[0]['grantValidation']
  > | null = null;
  if ('grantId' in assignment) {
    const grantUse = binding.roleResult.grantUse;
    if (grantUse === null) throw reviewNotSatisfied();
    const envelope = parseCollaborationGrantEnvelope(
      canonicalCollaborationGrantEnvelope(grantUse.envelope),
    );
    const providerId = reservation.implementationActor.providerId;
    const authorAssurance = reservation.implementationActor.identityAssurance;
    if (
      providerId === null ||
      (authorAssurance !== 'self-declared' &&
        authorAssurance !== 'runtime-hint') ||
      assignment.grantId !== envelope.payload.grantId ||
      envelope.payload.availableActor.kind !== 'provider' ||
      authorAssurance !== envelope.payload.availableActor.assurance ||
      envelope.payload.availableActor.providerId !== providerId
    ) {
      throw reviewNotSatisfied();
    }
    const grantRequest: CollaborationGrantRequest = {
      changeId: reservation.changeId,
      taskId: reservation.taskId,
      baselineCommit: reservation.baseline.head,
      baselineTree: reservation.baseline.tree,
      targetDigest: reservation.subject.subjectDigest,
      lifecyclePhase: 'task-diff-review',
      rolePair: {
        authorRole: 'task-implementer',
        conflictingRole: 'task-diff-reviewer',
      },
      availableActor: {
        kind: 'provider',
        providerId,
        assurance: authorAssurance,
      },
      degradedForm: 'same-provider-fresh-session',
      reason:
        'No provider-independent TaskDiffReview reviewer is enabled for this exact candidate.',
      ttlMinutes: 30,
      maxUses: 1,
    };
    const expectedBinding = deriveTaskDiffCollaborationGrantBinding(
      reservation.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = collaborationTransitionDigest(expectedBinding);
    if (
      canonicalJson(bindingFromPayload(envelope.payload)) !==
        canonicalJson(expectedBinding) ||
      grantUse.transitionDigest !== transitionDigest
    ) {
      throw reviewNotSatisfied();
    }
    const policy = parseBaselineJson(
      reservation.repositoryRoot,
      expectedBinding.baselineCommit,
      'workflow/maintainer-policy.json',
      parseMaintainerPolicy,
    );
    const consumedUse =
      replayMode === 'inspect'
        ? (() => {
            const inspection = readCollaborationGrantInspection(
              reservation.gitCommonDirectory,
              assignment.grantId,
            );
            return inspection?.state === 'consumed' &&
              inspection.use !== undefined
              ? inspection.use
              : null;
          })()
        : readExactConsumedCollaborationGrantUse(
            reservation.gitCommonDirectory,
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
              now: new Date(envelope.payload.expiresAt),
            },
          );
    if (
      consumedUse === null ||
      canonicalJson(consumedUse) !== canonicalJson(grantUse)
    ) {
      throw reviewNotSatisfied();
    }
    grantUseForReplay = consumedUse;
    if (replayMode === 'governing') {
      const verifier = createInteractiveSshSigner(
        reservation.repositoryRoot,
        policy,
      );
      grantValidation = {
        now: new Date(envelope.payload.expiresAt),
        expectedBinding,
        policy,
        verifier,
        transitionDigest,
      };
    }
  } else if (binding.roleResult.grantUse !== null) {
    throw reviewNotSatisfied();
  }
  const replayedRoleResult =
    replayMode === 'inspect' && 'grantId' in assignment
      ? binding.roleResult
      : admitRoleResult({
          assignment,
          author: reservation.implementationActor,
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
            invocationId: invocation.invocationId,
            requestDigest: reservation.request.requestDigest,
            outputDigest: invocation.result.outputDigest,
            providerId: reservation.request.providerId,
            sessionId: assignment.sessionId!,
            targetDigest: reservation.subject.subjectDigest,
            engineSpawned: true,
          },
          grantUse: grantUseForReplay,
          grantValidation,
        });
  if (replayMode === 'inspect') {
    assertStoredAdmittedRoleResultDigest(replayedRoleResult);
  }
  const grantUseDigest =
    replayedRoleResult.grantUse === null
      ? null
      : sha256(canonicalJson(replayedRoleResult.grantUse));
  if (
    canonicalJson(replayedRoleResult) !== canonicalJson(binding.roleResult) ||
    canonicalJson(expectedReview.assignment) !==
      canonicalJson({
        implementerPrincipalId: reservation.implementationActor.principalId!,
        implementerProviderId: reservation.implementationActor.providerId!,
        implementationSessionId: reservation.sessionId,
        reviewerPrincipalId:
          replayedRoleResult.participant.principalId ??
          `provider:${replayedRoleResult.assignment.providerId}`,
        reviewerProviderId: replayedRoleResult.assignment.providerId,
        reviewerSessionId: replayedRoleResult.assignment.sessionId,
        achievedIndependence: replayedRoleResult.achievedIndependence,
        degradedForm: replayedRoleResult.grantUse?.degradedForm ?? null,
        grantUseDigest,
      })
  ) {
    throw reviewNotSatisfied();
  }
  const resultNode = readEvidenceNode(runtime, binding.providerResultNodeId);
  if (
    resultNode.resultDigest !== binding.providerResultDigest ||
    resultNode.type !== 'task-diff-review-provider-result' ||
    resultNode.nodeSchema !== 'workflow.task-diff-review-provider-result.v1' ||
    resultNode.evaluator !== 'workflow-task-diff-review.v1' ||
    resultNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    resultNode.outputSchema !==
      'workflow.task-diff-review-provider-result-output.v1' ||
    canonicalJson(resultNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        roleResult: replayedRoleResult,
        review: expectedReview,
      }) ||
    resultNode.exactInputDigests.admission !==
      replayedRoleResult.resultDigest ||
    resultNode.exactInputDigests.observation !== observationNode.resultDigest ||
    resultNode.exactInputDigests.subject !==
      reservation.subject.subjectDigest ||
    resultNode.semanticParentResultDigests.observation !==
      observationNode.resultDigest ||
    resultNode.provenanceParentNodeIds.observation !== observationNode.nodeId
  ) {
    throw reviewNotSatisfied();
  }
}

function assertCurrentTaskDiffReviewContinuationBinding(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewContinuationReservationRecord,
  expectedSubmission: TaskDiffReviewContinuationSubmission,
): void {
  const currentSubmission = assertTaskDiffReviewContinuationSubmissionCurrent(
    reservation.review,
    reservation.response,
    expectedSubmission,
  );
  const binding = readTaskDiffReviewContinuationResultBinding(
    runtime,
    reservation.sessionId,
    reservation.review.recordDigest,
  );
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (
    binding === null ||
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    invocation.result.runtimeObservation === null ||
    binding.ownerInvestigationId !== reservation.ownerInvestigationId ||
    binding.sessionId !== reservation.sessionId ||
    binding.subjectDigest !== reservation.subject.subjectDigest ||
    binding.reviewRecordDigest !== reservation.review.recordDigest ||
    binding.responseDigest !== reservation.response.responseDigest ||
    binding.invocationId !== invocation.invocationId ||
    binding.requestDigest !== reservation.request.requestDigest ||
    binding.outputDigest !== invocation.result.outputDigest ||
    binding.runtimeObservationDigest !==
      sha256(canonicalJson(invocation.result.runtimeObservation)) ||
    canonicalJson(binding.submission) !== canonicalJson(currentSubmission)
  ) {
    throw reviewNotSatisfied();
  }
  const authorization = readEvidenceNode(
    runtime,
    reservation.authorizationNodeId,
  );
  const requestReservation = readEvidenceNode(
    runtime,
    reservation.reservationNodeId,
  );
  const resultNode = readEvidenceNode(runtime, binding.providerResultNodeId);
  if (
    resultNode.resultDigest !== binding.providerResultDigest ||
    resultNode.type !== 'task-diff-review-continuation-provider-result' ||
    resultNode.nodeSchema !==
      'workflow.task-diff-review-continuation-provider-result.v1' ||
    resultNode.evaluator !== 'workflow-task-diff-review.v1' ||
    resultNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    resultNode.outputSchema !==
      'workflow.task-diff-review-continuation-provider-result-output.v1' ||
    canonicalJson(resultNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        requestDigest: reservation.request.requestDigest,
        outputDigest: invocation.result.outputDigest,
        responseDigest: reservation.response.responseDigest,
        submission: currentSubmission,
      }) ||
    resultNode.exactInputDigests.output !== invocation.result.outputDigest ||
    resultNode.exactInputDigests.request !==
      reservation.request.requestDigest ||
    resultNode.exactInputDigests.response !==
      reservation.response.responseDigest ||
    resultNode.exactInputDigests.review !== reservation.review.recordDigest ||
    resultNode.exactInputDigests.runtimeObservation !==
      binding.runtimeObservationDigest ||
    resultNode.exactInputDigests.subject !==
      reservation.subject.subjectDigest ||
    resultNode.semanticParentResultDigests.authorization !==
      authorization.resultDigest ||
    resultNode.semanticParentResultDigests.reservation !==
      requestReservation.resultDigest ||
    resultNode.provenanceParentNodeIds.authorization !==
      reservation.authorizationNodeId ||
    resultNode.provenanceParentNodeIds.reservation !==
      reservation.reservationNodeId
  ) {
    throw reviewNotSatisfied();
  }
}

function ensureTaskDiffFinalAssurance(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  current: ReturnType<typeof loadCurrentTaskDiffReview>,
  continuationReservation: TaskDiffReviewContinuationReservationRecord,
  continuationBinding: TaskDiffReviewContinuationResultBinding,
): TaskDiffFinalAssuranceRecord {
  const existing = assertCurrentTaskDiffFinalAssuranceBinding(
    runtime,
    current,
    continuationReservation,
    continuationBinding,
  );
  if (existing !== null) return existing;
  assertCurrentTaskDiffReviewContinuationBinding(
    runtime,
    continuationReservation,
    continuationBinding.submission,
  );
  const authenticatedClosure = authenticatedProviderChallengeClosureAuthority(
    current,
    continuationReservation,
    continuationBinding,
  );
  const reviewerAuthority = authenticatedClosure.authority;
  const exceptions =
    current.review.assignment.degradedForm === null ||
    current.review.assignment.grantUseDigest === null
      ? []
      : [
          {
            kind: 'collaboration-grant-degradation' as const,
            stage: 'review' as const,
            grantUseDigest: current.review.assignment.grantUseDigest,
            degradedForm: current.review.assignment.degradedForm,
          },
        ];
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: current.review.subject,
    review: current.review,
    response: continuationReservation.response,
    submission: continuationBinding.submission,
    reviewerAuthority,
    exceptions,
    authenticatedReviewAuthority: current.authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority: authenticatedClosure,
  });
  const reviewResultNode = readEvidenceNode(
    runtime,
    current.reviewResultNodeId,
  );
  const continuationResultNode = readEvidenceNode(
    runtime,
    continuationBinding.providerResultNodeId,
  );
  if (
    reviewResultNode.resultDigest !== current.reviewResultDigest ||
    continuationResultNode.resultDigest !==
      continuationBinding.providerResultDigest
  ) {
    throw reviewNotSatisfied();
  }
  const assuranceNode = createEvidenceNode({
    type: 'task-diff-final-assurance',
    nodeSchema: 'workflow.task-diff-final-assurance.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      authority: sha256(canonicalJson(reviewerAuthority)),
      closureAuthority: sha256(canonicalJson(authenticatedClosure)),
      response: continuationReservation.response.responseDigest,
      review: current.review.recordDigest,
      reviewAuthority: sha256(
        canonicalJson(current.authenticatedReviewAuthority),
      ),
      subject: current.review.subjectDigest,
      submission: sha256(canonicalJson(continuationBinding.submission)),
    },
    semanticParentResultDigests: {
      continuation: continuationResultNode.resultDigest,
      review: reviewResultNode.resultDigest,
    },
    provenanceParentNodeIds: {
      continuation: continuationResultNode.nodeId,
      review: reviewResultNode.nodeId,
    },
    outputSchema: 'workflow.task-diff-final-assurance-output.v1',
    output: assurance,
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, assuranceNode);
  createTaskDiffFinalAssuranceBinding(runtime, {
    subjectDigest: current.review.subjectDigest,
    assuranceNodeId: assuranceNode.nodeId,
    assuranceResultDigest: assuranceNode.resultDigest,
    assurance,
    createdAt: continuationBinding.createdAt,
  });
  return (
    assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current,
      continuationReservation,
      continuationBinding,
    ) ??
    (() => {
      throw reviewNotSatisfied();
    })()
  );
}

function assertCurrentTaskDiffFinalAssuranceBinding(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  current: CurrentAuthenticatedTaskDiffReview,
  continuationReservation: TaskDiffReviewContinuationReservationRecord,
  continuationBinding: TaskDiffReviewContinuationResultBinding,
): TaskDiffFinalAssuranceRecord | null {
  const binding = readTaskDiffFinalAssuranceBinding(
    runtime,
    current.review.subjectDigest,
  );
  if (binding === null) return null;
  assertCurrentTaskDiffReviewContinuationBinding(
    runtime,
    continuationReservation,
    continuationBinding.submission,
  );
  const authenticatedClosure = authenticatedProviderChallengeClosureAuthority(
    current,
    continuationReservation,
    continuationBinding,
  );
  const assurance = assertTaskDiffFinalAssuranceCurrent({
    subject: current.review.subject,
    review: current.review,
    response: continuationReservation.response,
    assurance: binding.assurance,
    authenticatedReviewAuthority: current.authenticatedReviewAuthority,
    authenticatedChallengeClosureAuthority: authenticatedClosure,
  });
  const reviewResultNode = readEvidenceNode(
    runtime,
    current.reviewResultNodeId,
  );
  const continuationResultNode = readEvidenceNode(
    runtime,
    continuationBinding.providerResultNodeId,
  );
  const assuranceNode = readEvidenceNode(runtime, binding.assuranceNodeId);
  const reviewerAuthority = assurance.reviewerAuthority;
  if (
    binding.assuranceResultDigest !== assuranceNode.resultDigest ||
    canonicalJson(binding.assurance) !== canonicalJson(assurance) ||
    assuranceNode.type !== 'task-diff-final-assurance' ||
    assuranceNode.nodeSchema !== 'workflow.task-diff-final-assurance.v1' ||
    assuranceNode.evaluator !== 'workflow-task-diff-review.v1' ||
    assuranceNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    assuranceNode.outputSchema !==
      'workflow.task-diff-final-assurance-output.v1' ||
    canonicalJson(assuranceNode.output) !== canonicalJson(assurance) ||
    assuranceNode.exactInputDigests.authority !==
      sha256(canonicalJson(reviewerAuthority)) ||
    assuranceNode.exactInputDigests.closureAuthority !==
      sha256(canonicalJson(authenticatedClosure)) ||
    assuranceNode.exactInputDigests.response !==
      continuationReservation.response.responseDigest ||
    assuranceNode.exactInputDigests.review !== current.review.recordDigest ||
    assuranceNode.exactInputDigests.reviewAuthority !==
      sha256(canonicalJson(current.authenticatedReviewAuthority)) ||
    assuranceNode.exactInputDigests.subject !== current.review.subjectDigest ||
    assuranceNode.exactInputDigests.submission !==
      sha256(canonicalJson(continuationBinding.submission)) ||
    assuranceNode.semanticParentResultDigests.continuation !==
      continuationResultNode.resultDigest ||
    assuranceNode.semanticParentResultDigests.review !==
      reviewResultNode.resultDigest ||
    assuranceNode.provenanceParentNodeIds.continuation !==
      continuationResultNode.nodeId ||
    assuranceNode.provenanceParentNodeIds.review !== reviewResultNode.nodeId
  ) {
    throw reviewNotSatisfied();
  }
  return assurance;
}

function authenticatedProviderChallengeClosureAuthority(
  current: CurrentAuthenticatedTaskDiffReview,
  reservation: TaskDiffReviewContinuationReservationRecord,
  binding: TaskDiffReviewContinuationResultBinding,
): TaskDiffAuthenticatedReviewerAuthority {
  const providerId = reservation.request.providerId;
  const principalId =
    current.review.assignment.reviewerProviderId === providerId
      ? current.review.assignment.reviewerPrincipalId
      : `provider:${providerId}`;
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'challenge-closure' as const,
    subjectDigest: current.review.subjectDigest,
    reviewRecordDigest: current.review.recordDigest,
    responseDigest: reservation.response.responseDigest,
    authorityNodeId: binding.providerResultNodeId,
    authorityResultDigest: binding.providerResultDigest,
    authority: Object.freeze({
      kind: 'engine-attributed-provider-reviewer' as const,
      principalId,
      providerId,
      policyDigest: current.review.subject.reviewPolicyDigest,
    }),
  });
}

function recordImplementationActor(
  sessionId: string,
  actor: Readonly<{
    providerId: ProviderId;
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  }>,
): RecordedRoleParticipant {
  return Object.freeze({
    providerId: actor.providerId,
    sessionId,
    principalId: `provider:${actor.providerId}`,
    identityAssurance: actor.assurance,
    engineSpawned: false,
  });
}

function resolveTaskDiffImplementationActor(
  cwd: string,
  requestedSessionId: string,
  subject: TaskDiffReviewSubject,
  options: BeginTaskDiffReviewOptions,
): RecordedRoleParticipant {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const transaction = readTaskStrategyTransaction(
    runtime,
    context.session.sessionId,
  );
  const finalizeTransaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  if (
    finalizeTransaction === null ||
    finalizeTransaction.candidateTree !== subject.candidateTree
  ) {
    throw reviewNotSatisfied();
  }
  if (transaction !== null) {
    const inspection = inspectSession(cwd, context.session.sessionId, {
      expectedSession: context.session,
      projectedTaskIds: [...finalizeTransaction.completedTaskIds],
      projectionSourceDigest: finalizeTransaction.projectionSourceDigest,
      authorizedTransitionPaths: [...finalizeTransaction.transitionPaths],
    });
    const correction = resolveCurrentTaskStrategyCorrection(inspection);
    const initialImplementationSubject =
      createTaskStrategyImplementationSubject({
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
    const head = correction.head;
    const current = head?.binding ?? null;
    const record = head?.record ?? null;
    const receipt = head?.receipt ?? null;
    if (
      correction.transaction.recordDigest !== transaction.recordDigest ||
      correction.failure !== null ||
      correction.exhausted ||
      current === null ||
      record === null ||
      receipt === null ||
      transaction.sessionId !== context.session.sessionId ||
      transaction.changeId !== context.session.changeId ||
      transaction.taskId !== context.session.taskId ||
      record.sessionId !== context.session.sessionId ||
      record.changeId !== context.session.changeId ||
      record.taskId !== context.session.taskId ||
      record.strategy !== transaction.strategy ||
      record.taskContractDigest !== transaction.taskContractDigest ||
      record.candidateTree === record.sourceTree ||
      current.sessionId !== context.session.sessionId ||
      current.patchDigest !== record.patchDigest ||
      record.candidateTree !== current.candidateTree ||
      record.recordDigest !== current.recordDigest ||
      receipt.sessionId !== context.session.sessionId ||
      receipt.recordDigest !== record.recordDigest ||
      receipt.patchDigest !== record.patchDigest ||
      receipt.candidateTree !== record.candidateTree ||
      receipt.receiptDigest !== current.receiptDigest ||
      receipt.importedAt !== current.createdAt ||
      finalizeTransaction.candidateTree !== subject.candidateTree ||
      !taskDiffSubjectExtendsPatchTree(
        context.git.repositoryRoot,
        record.candidateTree,
        subject.candidateTree,
        finalizeTransaction.projectionMutations.map(({ path }) => path),
      )
    ) {
      throw reviewNotSatisfied();
    }
    let implementationSubject = initialImplementationSubject;
    if (correction.completedCorrectionRounds === 0) {
      if (record.sourceTree !== transaction.red.candidateTree) {
        throw reviewNotSatisfied();
      }
    } else {
      const originatingFailure = readTaskStrategyGreenFailureRecord(
        runtime,
        context.session.sessionId,
        record.sourceTree,
      );
      if (
        originatingFailure === null ||
        originatingFailure.candidateTree !== record.sourceTree ||
        originatingFailure.currentRedTransactionDigest !==
          transaction.recordDigest
      ) {
        throw reviewNotSatisfied();
      }
      implementationSubject = createTaskStrategyCorrectionSubject({
        subject: initialImplementationSubject,
        round: correction.completedCorrectionRounds,
        greenFailureRecord: originatingFailure,
      });
      if (implementationSubject.sourceTree !== record.sourceTree) {
        throw reviewNotSatisfied();
      }
    }
    if (transaction.strategy === 'tdd-single-agent') {
      if (
        canonicalJson(record.implementer) !== canonicalJson(transaction.author)
      ) {
        throw reviewNotSatisfied();
      }
      return recordImplementationActor(
        context.session.sessionId,
        transaction.author,
      );
    }
    if (record.implementer.providerId === null) {
      const caller = readTaskStrategyCallerImplementationBinding(
        runtime,
        context.session.sessionId,
        implementationSubject.subjectDigest,
      );
      if (
        caller === null ||
        caller.subjectDigest !== implementationSubject.subjectDigest ||
        caller.output.sessionId !== context.session.sessionId ||
        caller.output.patchDigest !== record.patchDigest ||
        caller.output.sourceTree !== record.sourceTree ||
        caller.roleResult.targetDigest !==
          implementationSubject.subjectDigest ||
        caller.roleResult.participant.providerId !== null ||
        caller.roleResult.participant.principalId !==
          record.implementer.principalId ||
        caller.roleResult.participant.identityAssurance !==
          record.implementer.assurance
      ) {
        throw reviewNotSatisfied();
      }
      return Object.freeze(structuredClone(caller.roleResult.participant));
    }
    const provider = readTaskStrategyImplementationResultBinding(
      runtime,
      context.session.sessionId,
      implementationSubject.subjectDigest,
    );
    if (provider !== null) {
      if (
        provider.subjectDigest !== implementationSubject.subjectDigest ||
        provider.output.sessionId !== context.session.sessionId ||
        provider.output.patchDigest !== record.patchDigest ||
        provider.output.sourceTree !== record.sourceTree ||
        provider.roleResult.targetDigest !==
          implementationSubject.subjectDigest ||
        provider.roleResult.participant.providerId !==
          record.implementer.providerId ||
        provider.roleResult.participant.identityAssurance !==
          record.implementer.assurance
      ) {
        throw reviewNotSatisfied();
      }
      return Object.freeze(structuredClone(provider.roleResult.participant));
    }
    throw reviewNotSatisfied();
  }

  const task = inspectSession(cwd, context.session.sessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...finalizeTransaction.completedTaskIds],
    projectionSourceDigest: finalizeTransaction.projectionSourceDigest,
    authorizedTransitionPaths: [...finalizeTransaction.transitionPaths],
  }).contract.execution?.tasks[context.session.taskId];
  if (
    task?.strategy === 'cross-agent-tdd' ||
    task?.strategy === 'tdd-single-agent'
  ) {
    throw reviewNotSatisfied();
  }

  const actorResolution = resolveActorIdentity({
    ...(options.explicitActor === undefined
      ? {}
      : { explicitActor: options.explicitActor }),
    environment: options.environment ?? process.env,
  });
  if (actorResolution.outcome === 'actor-resolution-required') {
    throw workflowError(
      actorResolution.code,
      'TaskDiffReview requires an unambiguous implementation actor.',
      ExitCode.guard,
      { details: { signals: actorResolution.signals } },
    );
  }
  return recordImplementationActor(
    context.session.sessionId,
    actorResolution.actor,
  );
}

function taskDiffSubjectExtendsPatchTree(
  repositoryRoot: string,
  patchTree: string,
  subjectTree: string,
  transitionPaths: readonly string[],
): boolean {
  const changedPaths = runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    patchTree,
    subjectTree,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  return (
    canonicalJson(changedPaths) === canonicalJson([...transitionPaths].sort())
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
      'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
      'TaskDiffReview could not verify its baseline adapter policy.',
      ExitCode.staleState,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function assertCandidateIndex(
  inspection: ReturnType<typeof inspectSession>,
  transaction: NonNullable<ReturnType<typeof readFinalizeTransaction>> & {
    candidateTree: string;
    candidateFingerprint: string;
    checkReportId: string;
  },
): void {
  const indexTree = runGit(inspection.git.repositoryRoot, [
    'write-tree',
  ]).trim();
  if (indexTree === transaction.previousIndexTree) {
    const preview = previewExactStaging(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...transaction.changedPaths],
    );
    if (
      preview.tree !== transaction.candidateTree ||
      preview.previousIndexTree !== transaction.previousIndexTree
    ) {
      throw candidateDiverged();
    }
    return;
  }
  if (
    indexTree !== transaction.candidateTree ||
    canonicalJson(
      listStagedPaths(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
      ),
    ) !== canonicalJson(transaction.changedPaths) ||
    runGit(inspection.git.repositoryRoot, [
      'diff',
      '--name-only',
      '-z',
      '--',
    ]) !== '' ||
    fingerprintUnstagedRepositoryProjection(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...transaction.candidateStatusEntries],
    ) !== transaction.candidateFingerprint
  ) {
    throw candidateDiverged();
  }
}

function deriveTransitions(
  repositoryRoot: string,
  baseTree: string,
  candidateTree: string,
  changedPaths: readonly string[],
): readonly TaskDiffPathTransition[] {
  return changedPaths.map((changedPath) => {
    const before = readTreeEntry(repositoryRoot, baseTree, changedPath);
    const after = readTreeEntry(repositoryRoot, candidateTree, changedPath);
    if (
      (before === null && after === null) ||
      canonicalJson(before) === canonicalJson(after)
    ) {
      throw candidateDiverged();
    }
    return { path: changedPath, before, after };
  });
}

function readTreeEntry(
  repositoryRoot: string,
  tree: string,
  candidatePath: string,
): TaskDiffTreeEntry | null {
  const output = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${candidatePath}`,
  ]);
  if (output === '') return null;
  const match =
    /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) throw candidateDiverged();
  return {
    mode: match[1] as TaskDiffTreeEntry['mode'],
    objectId: match[2]!,
  };
}

function parseBaselineJson<T>(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
  parse: (value: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(
      runGit(repositoryRoot, ['show', `${commit}:${relativePath}`]),
    );
  } catch (error) {
    throw workflowError(
      'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
      `TaskDiffReview could not verify baseline ${relativePath}.`,
      ExitCode.staleState,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  try {
    return parse(value);
  } catch (error) {
    throw workflowError(
      'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
      `TaskDiffReview baseline ${relativePath} is invalid.`,
      ExitCode.staleState,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reviewNotReady() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_READY',
    'TaskDiffReview is unavailable until finalize freezes a checked candidate tree.',
    ExitCode.staleState,
  );
}

function reviewNotStarted() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_STARTED',
    'TaskDiffReview has no durable provider reservation for this session.',
    ExitCode.staleState,
  );
}

function reviewNotSatisfied() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_SATISFIED',
    'TaskDiffReview has no current, provider-bound result for this candidate.',
    ExitCode.verification,
  );
}

function continuationNotStarted() {
  return workflowError(
    'TASK_DIFF_REVIEW_CONTINUATION_NOT_STARTED',
    'TaskDiffReview challenge continuation has no durable provider reservation for this response.',
    ExitCode.staleState,
  );
}

function continuationResultInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_CONTINUATION_RESULT_INVALID',
    'TaskDiffReview challenge continuation output does not cover the exact current review and response.',
    ExitCode.verification,
  );
}

function candidateDiverged() {
  return workflowError(
    'TASK_DIFF_REVIEW_CANDIDATE_DIVERGED',
    'TaskDiffReview candidate state no longer matches the durable finalize transaction.',
    ExitCode.staleState,
  );
}

function taskDiffReviewLineageConflict() {
  return workflowError(
    'TASK_DIFF_REVIEW_LINEAGE_CONFLICT',
    'TaskDiffReview predecessor and supersession records do not form one exact append-only chain.',
    ExitCode.guard,
  );
}

function taskDiffReviewSupersessionReconciliationRequired() {
  return workflowError(
    'TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED',
    'A durable successor TaskDiffReview result requires deterministic supersession reconciliation.',
    ExitCode.staleState,
  );
}

function taskDiffReviewPriorChallengeOpen() {
  return workflowError(
    'TASK_DIFF_REVIEW_PRIOR_CHALLENGE_OPEN',
    'The prior TaskDiffReview challenge set lacks authenticated Final Assurance and cannot authorize candidate re-review.',
    ExitCode.verification,
  );
}

function externalTaskDiffInputStale() {
  return workflowError(
    'TASK_DIFF_REVIEW_EXTERNAL_INPUT_STALE',
    'External TaskDiffReview input does not bind the exact current subject.',
    ExitCode.staleState,
  );
}

function directHumanTaskDiffResumeInvalid() {
  return workflowError(
    'TASK_DIFF_DIRECT_HUMAN_RESUME_INVALID',
    'Direct-human TaskDiffReview resume requires the exact durable pause, authority-free input, and reserved or consumed signed grant.',
    ExitCode.guard,
  );
}

function externalTaskDiffLineageDeferred() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_REVIEW_LINEAGE_DEFERRED',
    'External TaskDiffReview currently requires an initial full-scope review; mixed-source delta lineage is a separate lifecycle transition.',
    ExitCode.guard,
  );
}

function externalTaskDiffAuthorityInvalid() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_REVIEW_AUTHORITY_INVALID',
    'External TaskDiffReview authority does not replay from the exact submission, consumed grant, admitted role result, and evidence node.',
    ExitCode.verification,
  );
}
