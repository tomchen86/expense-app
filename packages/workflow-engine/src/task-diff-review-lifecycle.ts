import crypto from 'node:crypto';

import { resolveActorIdentity } from './actor-identity.ts';
import { parseAiAdapterPolicyDocument } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  bindingFromPayload,
  canonicalCollaborationGrantEnvelope,
  collaborationPolicyDigestForPhase,
  parseCollaborationGrantEnvelope,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
} from './collaboration-grant.ts';
import {
  consumeCollaborationGrantUnderLifecycleLock,
  readExactConsumedCollaborationGrantUse,
  reserveCollaborationGrantUnderLifecycleLock,
  type CollaborationGrantUseProjection,
} from './collaboration-grant-store.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from './evidence-object-store.ts';
import { createEvidenceNode } from './evidence-node.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { readFinalizeTransaction } from './finalize-transaction.ts';
import { listStagedPaths, previewExactStaging } from './git-transitions.ts';
import { fingerprintUnstagedRepositoryProjection, runGit } from './git.ts';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
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
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
} from './report-validation.ts';
import {
  admitRoleResult,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type AdmittedRoleResult,
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
  createTaskDiffReviewRecord,
  parseTaskDiffReviewContinuationSubmission,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffFinalAssuranceRecord,
  type TaskDiffReviewChallengeResponseRecord,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewRecord,
} from './task-diff-review-artifact.ts';
import {
  createTaskDiffFinalAssuranceBinding,
  createTaskDiffReviewSupersession,
  createTaskDiffReviewContinuationReservation,
  createTaskDiffReviewContinuationResultBinding,
  createTaskDiffReviewReservation,
  createTaskDiffReviewResultBinding,
  listTaskDiffReviewResultBindings,
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
  createTaskDiffReviewSubject,
  deriveTaskDiffReviewCandidatePlan,
  TASK_DIFF_REVIEW_POLICY_DIGEST,
  taskDiffReviewRequirement,
  type TaskDiffReviewCandidatePlan,
  type TaskDiffPathTransition,
  type TaskDiffReviewSubject,
  type TaskDiffTreeEntry,
} from './task-diff-review.ts';
import {
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
  type TaskMandateBinding,
} from './task-mandate.ts';
import { inspectSession, type SessionInspection } from './verification.ts';

export type BeginTaskDiffReviewOptions = Readonly<{
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
  }>;
}>;

export type ReconcileTaskDiffReviewOptions = Readonly<{
  collaborationGrantValidation?: Readonly<{
    now?: Date;
    verifier?: MaintainerSignerProvider;
  }>;
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

/**
 * Reserve one exact, provider-independent TaskDiffReview. The reservation is
 * immutable and replay-safe; it does not launch the provider or advance the
 * finalize transaction.
 */
export function beginTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  options: BeginTaskDiffReviewOptions = {},
): TaskDiffReviewLifecycleStatus {
  const initialSubject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
  if (!initialSubject.reviewRequirement.required) {
    return Object.freeze({
      state: 'not-required',
      sessionId: requestedSessionId,
      subject: initialSubject,
    });
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
        const implementationActor = recordImplementationActor(
          context.session.sessionId,
          actorResolution.actor,
        );
        const existing = readTaskDiffReviewReservation(
          runtime,
          context.session.sessionId,
          subject.subjectDigest,
        );
        const candidatePlan =
          existing === null
            ? resolveTaskDiffReviewCandidatePlan(context, runtime, subject)
            : null;
        if (candidatePlan?.action === 'reuse') {
          return renderReusedTaskDiffReviewStatus(
            runtime,
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

/** Inspect the current subject and its durable lifecycle without creating work. */
export function inspectTaskDiffReviewStatus(
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewLifecycleStatus {
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
  if (reservation === null) {
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      context,
      runtime,
      subject,
    );
    if (candidatePlan.action === 'reuse') {
      return renderReusedTaskDiffReviewStatus(
        runtime,
        subject,
        loadReusedTaskDiffReview(runtime, context, subject, candidatePlan),
      );
    }
    return Object.freeze({
      state: 'ready' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  assertReservationCurrent(
    context,
    subject,
    reservation.implementationActor,
    reservation,
  );
  return renderTaskDiffReviewStatus(runtime, reservation);
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
            current.reservation,
            current.review,
            response,
          );
        assertContinuationReservationCurrent(
          context,
          current.reservation,
          current.review,
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
        return renderTaskDiffReviewContinuationStatus(runtime, reservation);
      }),
  );
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
          current.reservation,
          current.review,
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
            return renderTaskDiffReviewContinuationStatus(runtime, reservation);
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
        return renderTaskDiffReviewContinuationStatus(runtime, reservation);
      }),
  );
}

/** Adopt only a durable fixed-runner result for the still-current subject. */
export function reconcileTaskDiffReview(
  cwd: string,
  requestedSessionId: string,
  options: ReconcileTaskDiffReviewOptions = {},
): TaskDiffReviewLifecycleStatus {
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
          ensureTaskDiffReviewSupersession(runtime, existing);
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
        ensureTaskDiffReviewSupersession(runtime, resultBinding);
        assertOwned();
        return renderTaskDiffReviewStatus(runtime, reservation);
      }),
  );
}

export function assertCurrentTaskDiffReviewSatisfied(
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewRecord | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
  if (!subject.reviewRequirement.required) return null;
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const current = loadCurrentTaskDiffReview(context, runtime);
  if (current.review.challenges.length === 0) {
    return assertTaskDiffReviewContentSatisfied(subject, current.review, null);
  }
  const continuationReservation = readTaskDiffReviewContinuationReservation(
    runtime,
    context.session.sessionId,
    current.review.recordDigest,
  );
  const continuationBinding = readTaskDiffReviewContinuationResultBinding(
    runtime,
    context.session.sessionId,
    current.review.recordDigest,
  );
  if (continuationReservation === null || continuationBinding === null) {
    return assertTaskDiffReviewContentSatisfied(subject, current.review, null);
  }
  const assurance = assertCurrentTaskDiffFinalAssuranceBinding(
    runtime,
    current.reservation,
    current.review,
    continuationReservation,
    continuationBinding,
  );
  if (assurance === null) {
    return assertTaskDiffReviewContentSatisfied(subject, current.review, null);
  }
  if (assurance.verdict === 'changes-required') {
    throw workflowError(
      'TASK_DIFF_REVIEW_CHANGES_REQUIRED',
      'Authenticated TaskDiff Final Assurance accepted at least one challenge; change the candidate and obtain review for the new subject.',
      ExitCode.verification,
    );
  }
  return current.review;
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
      current.reservation,
      current.review,
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
  assertInspectionReport(
    checkReport,
    inspection,
    'check',
    'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
  );
  assertReportChecks(
    checkReport,
    inspection,
    inspection.session.requiredChecks,
    'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
  );
  if (
    checkReport.candidateTree !== checkedTransaction.candidateTree ||
    checkReport.finalizeProfile !== 'projected-single-pass-ordinary-failure'
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
    inspection.session.requiredChecks,
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
    reviewRequirement: requirement,
  });
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
): TaskDiffReviewCandidatePlan {
  const bindings = listTaskDiffReviewResultBindings(
    runtime,
    context.session.sessionId,
  );
  if (bindings.length === 0) {
    return deriveTaskDiffReviewCandidatePlan({ current: subject });
  }
  const byReviewDigest = new Map<string, TaskDiffReviewResultBinding>();
  for (const binding of bindings) {
    const reservation = readTaskDiffReviewReservation(
      runtime,
      context.session.sessionId,
      binding.subjectDigest,
    );
    if (reservation === null) throw taskDiffReviewLineageConflict();
    assertCurrentTaskDiffReviewBinding(runtime, reservation, binding.review);
    if (byReviewDigest.has(binding.review.recordDigest)) {
      throw taskDiffReviewLineageConflict();
    }
    byReviewDigest.set(binding.review.recordDigest, binding);
  }
  const supersessions = listTaskDiffReviewSupersessions(
    runtime,
    context.session.sessionId,
  );
  const superseded = new Set<string>();
  for (const relation of supersessions) {
    const predecessor = byReviewDigest.get(
      relation.predecessorReviewRecordDigest,
    );
    const successor = byReviewDigest.get(relation.supersededByDigest);
    if (
      predecessor === undefined ||
      successor === undefined ||
      predecessor.subjectDigest !== relation.predecessorSubjectDigest ||
      successor.subjectDigest !== relation.supersededBySubjectDigest ||
      canonicalJson(successor.review.reviewScope) !==
        canonicalJson(relation.reviewScope) ||
      superseded.has(relation.predecessorReviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
    superseded.add(relation.predecessorReviewRecordDigest);
  }
  const leaves = bindings.filter(
    ({ review }) => !superseded.has(review.recordDigest),
  );
  if (leaves.length !== 1) throw taskDiffReviewLineageConflict();
  const predecessorBinding = leaves[0]!;
  const predecessorReservation = readTaskDiffReviewReservation(
    runtime,
    context.session.sessionId,
    predecessorBinding.subjectDigest,
  );
  if (predecessorReservation === null) throw taskDiffReviewLineageConflict();
  const finalAssuranceCommitmentDigest = taskDiffReviewTerminalCommitmentDigest(
    runtime,
    predecessorReservation,
    predecessorBinding.review,
  );
  return deriveTaskDiffReviewCandidatePlan({
    current: subject,
    predecessor: {
      subject: predecessorBinding.review.subject,
      reviewRecordDigest: predecessorBinding.review.recordDigest,
      finalAssuranceCommitmentDigest,
    },
  });
}

function ensureTaskDiffReviewSupersession(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffReviewResultBinding,
): void {
  const scope = binding.review.reviewScope;
  const predecessor = scope.predecessor;
  if (predecessor === null) return;
  const predecessorBinding = readTaskDiffReviewResultBinding(
    runtime,
    binding.sessionId,
    predecessor.subjectDigest,
  );
  const predecessorReservation = readTaskDiffReviewReservation(
    runtime,
    binding.sessionId,
    predecessor.subjectDigest,
  );
  if (
    predecessorBinding === null ||
    predecessorReservation === null ||
    predecessorBinding.review.recordDigest !== predecessor.reviewRecordDigest
  ) {
    throw taskDiffReviewLineageConflict();
  }
  assertCurrentTaskDiffReviewBinding(
    runtime,
    predecessorReservation,
    predecessorBinding.review,
  );
  if (
    taskDiffReviewTerminalCommitmentDigest(
      runtime,
      predecessorReservation,
      predecessorBinding.review,
    ) !== predecessor.finalAssuranceCommitmentDigest
  ) {
    throw taskDiffReviewLineageConflict();
  }
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
): Readonly<{
  subject: TaskDiffReviewSubject;
  reservation: TaskDiffReviewReservationRecord;
  review: TaskDiffReviewRecord;
}> {
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    context.session.sessionId,
    plan.predecessor.subjectDigest,
  );
  const reservation = readTaskDiffReviewReservation(
    runtime,
    context.session.sessionId,
    plan.predecessor.subjectDigest,
  );
  if (
    binding === null ||
    reservation === null ||
    binding.review.recordDigest !== plan.predecessor.reviewRecordDigest
  ) {
    throw taskDiffReviewLineageConflict();
  }
  assertCurrentTaskDiffReviewBinding(runtime, reservation, binding.review);
  if (
    taskDiffReviewTerminalCommitmentDigest(
      runtime,
      reservation,
      binding.review,
    ) !== plan.predecessor.finalAssuranceCommitmentDigest
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const replay = deriveTaskDiffReviewCandidatePlan({
    current: currentSubject,
    predecessor: {
      subject: binding.review.subject,
      reviewRecordDigest: binding.review.recordDigest,
      finalAssuranceCommitmentDigest:
        plan.predecessor.finalAssuranceCommitmentDigest,
    },
  });
  if (canonicalJson(replay) !== canonicalJson(plan)) {
    throw taskDiffReviewLineageConflict();
  }
  return Object.freeze({
    subject: currentSubject,
    reservation,
    review: binding.review,
  });
}

function renderReusedTaskDiffReviewStatus(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  currentSubject: TaskDiffReviewSubject,
  current: ReturnType<typeof loadReusedTaskDiffReview>,
): TaskDiffReviewLifecycleStatus {
  const finalAssurance = taskDiffReviewTerminalAssurance(
    runtime,
    current.reservation,
    current.review,
  );
  return Object.freeze({
    state: finalAssurance?.verdict ?? 'satisfied',
    sessionId: current.reservation.sessionId,
    subject: currentSubject,
    implementationActor: current.reservation.implementationActor,
    assignment: current.reservation.request
      .roleAssignment as ProviderRoleAssignment,
    ownerInvestigationId: current.reservation.ownerInvestigationId,
    invocationId: current.reservation.request.invocationId,
    review: current.review,
    finalAssurance,
  });
}

function taskDiffReviewTerminalCommitmentDigest(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewReservationRecord,
  review: TaskDiffReviewRecord,
): string | null {
  return (
    taskDiffReviewTerminalAssurance(runtime, reservation, review)
      ?.commitmentDigest ?? null
  );
}

function taskDiffReviewTerminalAssurance(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewReservationRecord,
  review: TaskDiffReviewRecord,
): TaskDiffFinalAssuranceRecord | null {
  if (review.challenges.length === 0) {
    assertTaskDiffReviewContentSatisfied(review.subject, review, null);
    return null;
  }
  const continuationReservation = readTaskDiffReviewContinuationReservation(
    runtime,
    reservation.sessionId,
    review.recordDigest,
  );
  const continuationBinding = readTaskDiffReviewContinuationResultBinding(
    runtime,
    reservation.sessionId,
    review.recordDigest,
  );
  if (continuationReservation === null || continuationBinding === null) {
    throw taskDiffReviewPriorChallengeOpen();
  }
  const assurance = assertCurrentTaskDiffFinalAssuranceBinding(
    runtime,
    reservation,
    review,
    continuationReservation,
    continuationBinding,
  );
  if (assurance === null) throw taskDiffReviewPriorChallengeOpen();
  return assurance;
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
  if (
    implementationActor.identityAssurance !== 'self-declared' &&
    implementationActor.identityAssurance !== 'runtime-hint'
  ) {
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
    engineSpawned: false,
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
  reviewReservation: TaskDiffReviewReservationRecord,
  review: TaskDiffReviewRecord,
  response: TaskDiffReviewChallengeResponseRecord,
): TaskDiffReviewContinuationReservationRecord {
  const implementationActorAssurance =
    reviewReservation.implementationActor.identityAssurance;
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
  const reviewerProviderId = reviewReservation.request.providerId;
  const scheduled = scheduleOrdinaryRole({
    role: 'task-diff-reviewer',
    author: {
      providerId: reviewReservation.implementationActor.providerId ?? undefined,
      sessionId: reviewReservation.implementationActor.sessionId ?? undefined,
      principalId:
        reviewReservation.implementationActor.principalId ?? undefined,
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
  const mandateBinding = reviewReservation.mandateBinding;
  const authorization = createEvidenceNode({
    type: 'task-diff-review-authorization',
    nodeSchema: 'workflow.task-diff-review-authorization.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      actor: sha256(canonicalJson(reviewReservation.implementationActor)),
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
      implementationActor: reviewReservation.implementationActor,
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
      implementationActor: reviewReservation.implementationActor,
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
    implementationActor: reviewReservation.implementationActor,
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
): TaskDiffReviewLifecycleStatus {
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
    const continuationBinding = readTaskDiffReviewContinuationResultBinding(
      runtime,
      reservation.sessionId,
      binding.review.recordDigest,
    );
    if (continuationBinding === null) {
      return Object.freeze({
        state: 'challenge-response-required',
        ...common,
        review: binding.review,
        finalAssurance: null,
      });
    }
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      continuationReservation,
      continuationBinding.submission,
    );
    const finalAssurance = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      reservation,
      binding.review,
      continuationReservation,
      continuationBinding,
    );
    return Object.freeze({
      state:
        finalAssurance === null
          ? 'challenge-closure-required'
          : finalAssurance.verdict,
      ...common,
      review: binding.review,
      finalAssurance,
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
    const reviewReservation = readTaskDiffReviewReservation(
      runtime,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    );
    if (reviewReservation === null) throw reviewNotSatisfied();
    const finalAssurance = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      reviewReservation,
      reservation.review,
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

function loadCurrentTaskDiffReview(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
): Readonly<{
  subject: TaskDiffReviewSubject;
  reservation: TaskDiffReviewReservationRecord;
  review: TaskDiffReviewRecord;
}> {
  const subject = inspectTaskDiffReviewSubject(
    context.git.repositoryRoot,
    context.session.sessionId,
  );
  if (!subject.reviewRequirement.required) throw reviewNotSatisfied();
  const reservation = readTaskDiffReviewReservation(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  if (reservation === null) {
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      context,
      runtime,
      subject,
    );
    if (candidatePlan.action !== 'reuse') throw reviewNotSatisfied();
    return loadReusedTaskDiffReview(runtime, context, subject, candidatePlan);
  }
  assertReservationCurrent(
    context,
    subject,
    reservation.implementationActor,
    reservation,
  );
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  if (binding === null) throw reviewNotSatisfied();
  assertCurrentTaskDiffReviewBinding(runtime, reservation, binding.review);
  return Object.freeze({ subject, reservation, review: binding.review });
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
  reviewReservation: TaskDiffReviewReservationRecord,
  review: TaskDiffReviewRecord,
  response: TaskDiffReviewChallengeResponseRecord,
  reservation: TaskDiffReviewContinuationReservationRecord,
): void {
  assertReservationCurrent(
    context,
    reviewReservation.subject,
    reviewReservation.implementationActor,
    reviewReservation,
  );
  assertContinuationReservationBound(
    reviewReservation,
    review,
    response,
    reservation,
  );
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
    const consumedUse = readExactConsumedCollaborationGrantUse(
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
  } else if (binding.roleResult.grantUse !== null) {
    throw reviewNotSatisfied();
  }
  const replayedRoleResult = admitRoleResult({
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
    current.reservation,
    current.review,
    continuationReservation,
    continuationBinding,
  );
  if (existing !== null) return existing;
  assertCurrentTaskDiffReviewContinuationBinding(
    runtime,
    continuationReservation,
    continuationBinding.submission,
  );
  const reviewBinding = readTaskDiffReviewResultBinding(
    runtime,
    current.reservation.sessionId,
    current.subject.subjectDigest,
  );
  if (reviewBinding === null) throw reviewNotSatisfied();
  assertCurrentTaskDiffReviewBinding(
    runtime,
    current.reservation,
    reviewBinding.review,
  );
  const reviewerAuthority = {
    kind: 'engine-attributed-provider-reviewer' as const,
    principalId: current.review.assignment.reviewerPrincipalId,
    providerId: current.review.assignment.reviewerProviderId,
    policyDigest: current.subject.reviewPolicyDigest,
  };
  const exceptions =
    current.review.assignment.degradedForm === null ||
    current.review.assignment.grantUseDigest === null
      ? []
      : [
          {
            kind: 'collaboration-grant-degradation' as const,
            grantUseDigest: current.review.assignment.grantUseDigest,
            degradedForm: current.review.assignment.degradedForm,
          },
        ];
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject: current.subject,
    review: current.review,
    response: continuationReservation.response,
    submission: continuationBinding.submission,
    reviewerAuthority,
    exceptions,
  });
  const reviewResultNode = readEvidenceNode(
    runtime,
    reviewBinding.providerResultNodeId,
  );
  const continuationResultNode = readEvidenceNode(
    runtime,
    continuationBinding.providerResultNodeId,
  );
  const assuranceNode = createEvidenceNode({
    type: 'task-diff-final-assurance',
    nodeSchema: 'workflow.task-diff-final-assurance.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    exactInputDigests: {
      authority: sha256(canonicalJson(reviewerAuthority)),
      response: continuationReservation.response.responseDigest,
      review: current.review.recordDigest,
      subject: current.subject.subjectDigest,
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
    subjectDigest: current.subject.subjectDigest,
    assuranceNodeId: assuranceNode.nodeId,
    assuranceResultDigest: assuranceNode.resultDigest,
    assurance,
    createdAt: continuationBinding.createdAt,
  });
  return (
    assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current.reservation,
      current.review,
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
  reviewReservation: TaskDiffReviewReservationRecord,
  review: TaskDiffReviewRecord,
  continuationReservation: TaskDiffReviewContinuationReservationRecord,
  continuationBinding: TaskDiffReviewContinuationResultBinding,
): TaskDiffFinalAssuranceRecord | null {
  const binding = readTaskDiffFinalAssuranceBinding(
    runtime,
    review.subjectDigest,
  );
  if (binding === null) return null;
  assertCurrentTaskDiffReviewBinding(runtime, reviewReservation, review);
  assertCurrentTaskDiffReviewContinuationBinding(
    runtime,
    continuationReservation,
    continuationBinding.submission,
  );
  const assurance = assertTaskDiffFinalAssuranceCurrent({
    subject: review.subject,
    review,
    response: continuationReservation.response,
    assurance: binding.assurance,
  });
  const reviewBinding = readTaskDiffReviewResultBinding(
    runtime,
    reviewReservation.sessionId,
    review.subjectDigest,
  );
  if (reviewBinding === null) throw reviewNotSatisfied();
  const reviewResultNode = readEvidenceNode(
    runtime,
    reviewBinding.providerResultNodeId,
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
    assuranceNode.exactInputDigests.response !==
      continuationReservation.response.responseDigest ||
    assuranceNode.exactInputDigests.review !== review.recordDigest ||
    assuranceNode.exactInputDigests.subject !== review.subjectDigest ||
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

function taskDiffReviewPriorChallengeOpen() {
  return workflowError(
    'TASK_DIFF_REVIEW_PRIOR_CHALLENGE_OPEN',
    'The prior TaskDiffReview challenge set lacks authenticated Final Assurance and cannot authorize candidate re-review.',
    ExitCode.verification,
  );
}
