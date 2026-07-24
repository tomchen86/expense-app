import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertInvestigationCheckpointEnvelope,
  checkpointContributionDigest,
  checkpointEnvelopeDigest,
  compareAndSwapInvestigationSession,
  createCurrentInvestigationRef,
  createInvestigationId,
  createInvestigationSessionRecord,
  deriveInvestigationSessionState,
  investigationCheckpointId,
  investigationSessionExists,
  readCurrentInvestigationRef,
  readInvestigationSession,
  type GroupDispositionsPayload,
  type InvestigationCheckpointEnvelope,
  type InvestigationCheckpointKind,
  type InvestigationSession,
  type InvestigationSessionState,
  type MainTermsPayload,
  type StoredInvestigationCheckpoint,
  type WhyAnswersPayload,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { assertChangeId, assertInvestigationId } from './paths.ts';
import { withInvestigationTransitionAuthority } from './planning-lock.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import {
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  createInvestigationStartReservation,
  createProviderInvocation,
  createProviderRetryReservation,
  expireProviderInvocationLease,
  providerInvocationExists,
  readBlindSurveyManifest,
  readInvestigationStartReservation,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  type BlindSurveyManifest,
  type InvestigationStartReservation,
  type ProviderInvocationFailure,
  type ProviderInvocationRecord,
} from './provider-invocation-store.ts';

export type InvestigationStatus = {
  kind: 'investigation';
  investigationId: string;
  changeId: string;
  revision: number;
  state: InvestigationSessionState;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  providerInvocationId: string;
  provider: {
    state: ProviderInvocationRecord['state'];
    providerId: ProviderInvocationRecord['providerId'];
    attempt: number;
    revision: number;
    leaseGeneration: number;
    leaseExpiresAt: string | null;
    failure: ProviderInvocationFailure | null;
    resultDigest: string | null;
  };
  checkpoint: {
    schemaVersion: 1;
    kind: InvestigationCheckpointKind;
    checkpointId: string;
  } | null;
  nextAction:
    | 'submit-main-terms'
    | 'wait-for-provider'
    | 'resume-provider-result'
    | 'expire-provider-lease'
    | 'retry-provider'
    | 'reconcile-repository'
    | 'submit-group-dispositions'
    | 'submit-why-answers'
    | 'resolve-actor'
    | 'human-action'
    | 'investigation-complete';
};

export type StartInvestigationSessionInput = {
  changeId: string;
  blindManifest: BlindSurveyManifest;
  blindRequest: ProviderInvocationRequest;
};

export type RetryInvestigationProviderInput = {
  expectedRevision: number;
  replacementRequest: ProviderInvocationRequest;
};

export function startInvestigationSession(
  cwd: string,
  input: StartInvestigationSessionInput,
): InvestigationStatus {
  assertExactStartInput(input);
  const changeId = assertChangeId(input.changeId);
  const context = loadInvestigationRuntimeContext(cwd);
  const manifestDigest = blindSurveyManifestDigest(input.blindManifest);
  const intentDigest = blindSurveyIntentDigest(input.blindManifest);
  assertStartBinding(context, changeId, input, manifestDigest, intentDigest);

  return withInvestigationTransitionAuthority(
    context.lifecycleRuntime,
    changeId,
    (assertOwned) => {
      const lockedContext = loadInvestigationRuntimeContext(cwd);
      assertStableStartContext(context, lockedContext);
      assertStartBinding(
        lockedContext,
        changeId,
        input,
        manifestDigest,
        intentDigest,
      );
      const currentRef = readCurrentInvestigationRef(
        lockedContext.runtime,
        changeId,
      );
      if (currentRef !== null) {
        const current = readInvestigationSession(
          lockedContext.runtime,
          currentRef.investigationId,
        );
        if (current.blindManifestDigest === manifestDigest) {
          assertCurrentInvestigationContext(lockedContext, current);
          const reservation = readInvestigationStartReservation(
            lockedContext.runtime,
            changeId,
          );
          if (reservation === null) {
            throw workflowError(
              'INVESTIGATION_START_RESERVATION_MISSING',
              'Current investigation has no durable start reservation.',
              ExitCode.staleState,
            );
          }
          assertStartReservationSessionBinding(
            lockedContext,
            reservation,
            current,
          );
          return statusFromSession(lockedContext, current);
        }
        throw workflowError(
          'CURRENT_INVESTIGATION_CONFLICT',
          `Change ${changeId} already has a different current investigation.`,
          ExitCode.conflict,
        );
      }

      const existingReservation = readInvestigationStartReservation(
        lockedContext.runtime,
        changeId,
      );
      if (
        existingReservation !== null &&
        existingReservation.manifestDigest !== manifestDigest
      ) {
        throw workflowError(
          'INVESTIGATION_START_RESERVATION_CONFLICT',
          'Change already has a durable start reservation for different intent.',
          ExitCode.conflict,
        );
      }
      const reservation =
        existingReservation ??
        createInvestigationStartReservation(lockedContext.runtime, {
          changeId,
          investigationId: createInvestigationId(),
          repositoryRoot: lockedContext.git.repositoryRealPath,
          gitCommonDirectory: lockedContext.git.gitCommonDirectory,
          branch: lockedContext.git.branch,
          baseline: {
            head: lockedContext.git.head,
            tree: lockedContext.git.tree,
          },
          manifest: input.blindManifest,
          request: input.blindRequest,
        });
      assertStartReservationContext(lockedContext, reservation);
      const reservedInput: StartInvestigationSessionInput = {
        changeId,
        blindManifest: reservation.manifest,
        blindRequest: reservation.request,
      };
      const reservedIntentDigest = blindSurveyIntentDigest(
        reservation.manifest,
      );
      assertStartBinding(
        lockedContext,
        changeId,
        reservedInput,
        reservation.manifestDigest,
        reservedIntentDigest,
      );
      const existingPrepared = providerInvocationExists(
        lockedContext.runtime,
        reservation.invocationId,
      )
        ? readProviderInvocation(
            lockedContext.runtime,
            reservation.invocationId,
          )
        : null;
      if (
        existingPrepared !== null &&
        (existingPrepared.changeId !== changeId ||
          existingPrepared.investigationId !== reservation.investigationId ||
          existingPrepared.attempt !== 1 ||
          existingPrepared.requestDigest !== reservation.requestDigest ||
          existingPrepared.manifestDigest !== reservation.manifestDigest)
      ) {
        throw workflowError(
          'PROVIDER_INVOCATION_COLLISION',
          'The requested blind invocation ID belongs to different durable work.',
          ExitCode.conflict,
        );
      }
      const investigationId = reservation.investigationId;
      if (existingPrepared === null) {
        createProviderInvocation(lockedContext.runtime, {
          investigationId,
          changeId,
          attempt: 1,
          manifest: reservation.manifest,
          request: reservation.request,
        });
      }
      assertOwned();
      const now = new Date().toISOString();
      const session: InvestigationSession = {
        schemaVersion: 1,
        investigationId,
        revision: 0,
        state: 'awaiting-main-terms',
        changeId,
        repositoryRoot: lockedContext.git.repositoryRealPath,
        gitCommonDirectory: lockedContext.git.gitCommonDirectory,
        branch: lockedContext.git.branch,
        baseline: {
          head: lockedContext.git.head,
          tree: lockedContext.git.tree,
        },
        intentDigest: reservedIntentDigest,
        blindManifestDigest: reservation.manifestDigest,
        blindRequestDigest: reservation.requestDigest,
        blindInvocationIds: [reservation.invocationId],
        currentBlindInvocationId: reservation.invocationId,
        milestones: {
          mainTerms: null,
          blindResult: null,
          reviewerTermSourceNodeId: null,
          groupDispositions: null,
          whyAnswers: null,
        },
        blocker: null,
        createdAt: now,
        updatedAt: now,
      };
      const persistedSession = investigationSessionExists(
        lockedContext.runtime,
        investigationId,
      )
        ? readInvestigationSession(lockedContext.runtime, investigationId)
        : createInvestigationSessionRecord(lockedContext.runtime, session);
      if (
        persistedSession.changeId !== changeId ||
        persistedSession.investigationId !== reservation.investigationId ||
        persistedSession.repositoryRoot !== reservation.repositoryRoot ||
        persistedSession.gitCommonDirectory !==
          reservation.gitCommonDirectory ||
        persistedSession.branch !== reservation.branch ||
        canonicalJson(persistedSession.baseline) !==
          canonicalJson(reservation.baseline) ||
        persistedSession.intentDigest !== reservedIntentDigest ||
        persistedSession.blindManifestDigest !== reservation.manifestDigest ||
        persistedSession.blindRequestDigest !== reservation.requestDigest ||
        persistedSession.currentBlindInvocationId !==
          reservation.invocationId ||
        canonicalJson(persistedSession.blindInvocationIds) !==
          canonicalJson([reservation.invocationId])
      ) {
        throw workflowError(
          'INVESTIGATION_SESSION_COLLISION',
          'Recovered investigation state belongs to different blind work.',
          ExitCode.conflict,
        );
      }
      assertOwned();
      const finalContext = loadInvestigationRuntimeContext(cwd);
      assertStableStartContext(lockedContext, finalContext);
      assertStartBinding(
        finalContext,
        changeId,
        reservedInput,
        reservation.manifestDigest,
        reservedIntentDigest,
      );
      createCurrentInvestigationRef(
        finalContext.runtime,
        changeId,
        investigationId,
      );
      assertOwned();
      return statusFromSession(finalContext, persistedSession);
    },
  );
}

export function getInvestigationStatus(
  cwd: string,
  requestedInvestigationId: string,
): InvestigationStatus {
  const context = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(context.runtime, investigationId);
  assertCurrentInvestigationContext(context, session);
  return statusFromSession(context, session);
}

export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: MainTermsPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'main-terms' }>;
export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: GroupDispositionsPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'group-dispositions' }>;
export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: WhyAnswersPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }>;
export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: MainTermsPayload | GroupDispositionsPayload | WhyAnswersPayload,
): InvestigationCheckpointEnvelope {
  if (status.checkpoint === null) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_NOT_AVAILABLE',
      'The investigation is not waiting for caller input.',
      ExitCode.guard,
    );
  }
  const envelope = {
    schemaVersion: 1 as const,
    kind: status.checkpoint.kind,
    checkpointId: status.checkpoint.checkpointId,
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: status.baseline,
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    payload,
  };
  return assertInvestigationCheckpointEnvelope(envelope);
}

export function resumeInvestigationSession(
  cwd: string,
  requestedInvestigationId: string,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      resumeInvestigationSessionUnlocked(context, current, checkpoint),
  );
}

function resumeInvestigationSessionUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  if (checkpoint === undefined) {
    const invocation = readProviderInvocation(
      context.runtime,
      current.currentBlindInvocationId,
    );
    if (invocation.state === 'succeeded') {
      return publishProviderResultUnlocked(context, current, {
        expectedRevision: current.revision,
        invocationId: invocation.invocationId,
      });
    }
    return statusFromSession(context, current);
  }

  const envelope = assertInvestigationCheckpointEnvelope(checkpoint);
  assertCheckpointBinding(current, envelope);
  const stored = storedCheckpointFor(current, envelope.kind);
  const digest = checkpointEnvelopeDigest(envelope);
  const contributionDigest = checkpointContributionDigest(envelope);
  if (stored !== null) {
    if (
      stored.envelope.contributionDigest === contributionDigest &&
      stored.envelope.envelope.checkpointId === envelope.checkpointId
    ) {
      return statusFromSession(context, current);
    }
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_CONFLICT',
      'This investigation checkpoint was already satisfied by different input.',
      ExitCode.conflict,
    );
  }

  const expectedKind = expectedCheckpointKind(current);
  if (
    expectedKind !== envelope.kind ||
    envelope.checkpointId !== investigationCheckpointId(current, envelope.kind)
  ) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_UNEXPECTED',
      'Caller input does not satisfy the investigation checkpoint now pending.',
      ExitCode.guard,
    );
  }
  const orthogonalMainJoin =
    envelope.kind === 'main-terms' &&
    current.milestones.mainTerms === null &&
    envelope.expectedRevision <= current.revision &&
    envelope.checkpointId === investigationCheckpointId(current, 'main-terms');
  if (envelope.expectedRevision !== current.revision && !orthogonalMainJoin) {
    throw investigationCasMismatch(envelope.expectedRevision, current.revision);
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    current.investigationId,
    current.revision,
    (session) => {
      const milestone: StoredInvestigationCheckpoint = {
        envelopeDigest: digest,
        contributionDigest,
        envelope,
      };
      const milestones = { ...session.milestones };
      if (envelope.kind === 'main-terms') {
        milestones.mainTerms = milestone;
      } else if (envelope.kind === 'group-dispositions') {
        milestones.groupDispositions = milestone;
      } else {
        milestones.whyAnswers = milestone;
      }
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        milestones,
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

export function publishProviderResultToInvestigation(
  cwd: string,
  requestedInvestigationId: string,
  input: {
    expectedRevision: number;
    invocationId: string;
  },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      publishProviderResultUnlocked(context, current, input),
  );
}

export function reopenInvestigationForReviewerTerms(
  cwd: string,
  requestedInvestigationId: string,
  input: { expectedRevision: number; sourceNodeId: string },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !/^[0-9a-f]{64}$/.test(input.sourceNodeId)
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term reopening is not bound to the current investigation revision.',
          ExitCode.staleState,
        );
      }
      if (
        current.state !== 'investigation-sealed' ||
        current.milestones.groupDispositions === null ||
        current.milestones.whyAnswers === null ||
        current.milestones.reviewerTermSourceNodeId !== null
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'Reviewer terms may reopen exactly one currently sealed investigation revision.',
          ExitCode.guard,
        );
      }
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => {
          const candidate: InvestigationSession = {
            ...session,
            revision: session.revision + 1,
            milestones: {
              ...session.milestones,
              reviewerTermSourceNodeId: input.sourceNodeId,
              groupDispositions: null,
              whyAnswers: null,
            },
            updatedAt: new Date().toISOString(),
          };
          candidate.state = deriveInvestigationSessionState(candidate);
          return candidate;
        },
      );
      return statusFromSession(context, next);
    },
  );
}

function publishProviderResultUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  input: {
    expectedRevision: number;
    invocationId: string;
  },
): InvestigationStatus {
  const invocation = readProviderInvocation(
    context.runtime,
    input.invocationId,
  );
  assertProviderPublicationBinding(current, invocation);
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    throw workflowError(
      'PROVIDER_RESULT_NOT_AVAILABLE',
      'Provider invocation has no durable successful result to publish.',
      ExitCode.guard,
    );
  }
  const reference = {
    invocationId: invocation.invocationId,
    requestDigest: invocation.requestDigest,
    outputDigest: invocation.result.outputDigest,
  };
  if (current.milestones.blindResult !== null) {
    if (
      canonicalJson(current.milestones.blindResult) === canonicalJson(reference)
    ) {
      return statusFromSession(context, current);
    }
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_CONFLICT',
      'A different provider result is already current.',
      ExitCode.conflict,
    );
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    current.investigationId,
    input.expectedRevision,
    (session) => {
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        milestones: {
          ...session.milestones,
          blindResult: reference,
        },
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

export function retryInvestigationProvider(
  cwd: string,
  requestedInvestigationId: string,
  input: RetryInvestigationProviderInput,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      retryInvestigationProviderUnlocked(context, current, input),
  );
}

export function expireInvestigationProviderLease(
  cwd: string,
  requestedInvestigationId: string,
  input: {
    expectedSessionRevision: number;
    expectedInvocationRevision: number;
    now?: string;
  },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (current.revision !== input.expectedSessionRevision) {
        throw investigationCasMismatch(
          input.expectedSessionRevision,
          current.revision,
        );
      }
      expireProviderInvocationLease(
        context.runtime,
        current.currentBlindInvocationId,
        {
          expectedRevision: input.expectedInvocationRevision,
          now: input.now,
        },
      );
      return statusFromSession(context, current);
    },
  );
}

function retryInvestigationProviderUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  input: RetryInvestigationProviderInput,
): InvestigationStatus {
  const investigationId = current.investigationId;
  if (current.revision !== input.expectedRevision) {
    throw workflowError(
      'INVESTIGATION_CAS_MISMATCH',
      'Investigation session changed before provider retry.',
      ExitCode.conflict,
    );
  }
  const previous = readProviderInvocation(
    context.runtime,
    current.currentBlindInvocationId,
  );
  if (
    previous.state !== 'failed' ||
    previous.failure === null ||
    previous.failure.kind !== 'retryable'
  ) {
    throw workflowError(
      previous.failure?.kind === 'repository-reconciliation-required'
        ? 'PROVIDER_REPOSITORY_RECONCILIATION_REQUIRED'
        : 'PROVIDER_INVOCATION_NOT_RETRYABLE',
      'Provider retry requires an explicit retryable terminal failure.',
      ExitCode.guard,
    );
  }
  const priorRequests = current.blindInvocationIds.map((invocationId) =>
    readProviderInvocationRequest(context.runtime, invocationId),
  );
  const manifest = readBlindSurveyManifest(
    context.runtime,
    previous.invocationId,
  );
  const attempt = previous.attempt + 1;
  const existingReservation = readProviderRetryReservation(
    context.runtime,
    investigationId,
    attempt,
  );
  if (existingReservation === null) {
    assertFreshProviderRetry(current, priorRequests, input.replacementRequest);
    assertReplacementRequestBinding(
      current,
      input.replacementRequest,
      manifest,
    );
  }
  const reservation =
    existingReservation ??
    createProviderRetryReservation(context.runtime, {
      investigationId,
      changeId: current.changeId,
      attempt,
      previousInvocationId: previous.invocationId,
      manifest,
      request: input.replacementRequest,
    });
  if (
    reservation.changeId !== current.changeId ||
    reservation.previousInvocationId !== previous.invocationId ||
    reservation.manifestDigest !== current.blindManifestDigest
  ) {
    throw workflowError(
      'PROVIDER_RETRY_RESERVATION_CONFLICT',
      'Durable provider retry reservation belongs to another attempt.',
      ExitCode.conflict,
    );
  }
  assertFreshProviderRetry(current, priorRequests, reservation.request);
  assertReplacementRequestBinding(current, reservation.request, manifest);
  const replacement = providerInvocationExists(
    context.runtime,
    reservation.invocationId,
  )
    ? readProviderInvocation(context.runtime, reservation.invocationId)
    : createProviderInvocation(context.runtime, {
        investigationId,
        changeId: current.changeId,
        attempt,
        manifest,
        request: reservation.request,
      });
  if (
    replacement.investigationId !== investigationId ||
    replacement.changeId !== current.changeId ||
    replacement.attempt !== attempt ||
    replacement.requestDigest !== reservation.requestDigest ||
    replacement.manifestDigest !== current.blindManifestDigest
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_COLLISION',
      'Replacement invocation ID belongs to different durable work.',
      ExitCode.conflict,
    );
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    investigationId,
    input.expectedRevision,
    (session) => {
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        blindRequestDigest: replacement.requestDigest,
        blindInvocationIds: [
          ...session.blindInvocationIds,
          replacement.invocationId,
        ],
        currentBlindInvocationId: replacement.invocationId,
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

function assertFreshProviderRetry(
  current: InvestigationSession,
  priorRequests: ProviderInvocationRequest[],
  replacementRequest: ProviderInvocationRequest,
): void {
  if (
    current.blindInvocationIds.includes(replacementRequest.invocationId) ||
    priorRequests.some((request) => request.nonce === replacementRequest.nonce)
  ) {
    throw workflowError(
      'PROVIDER_RETRY_NOT_FRESH',
      'Provider retry requires a new invocation ID and nonce.',
      ExitCode.guard,
    );
  }
}

function withInvestigationMutation(
  cwd: string,
  requestedInvestigationId: string,
  operation: (
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    current: InvestigationSession,
  ) => InvestigationStatus,
): InvestigationStatus {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const initial = readInvestigationSession(
    initialContext.runtime,
    investigationId,
  );
  return withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    initial.changeId,
    (assertOwned) => {
      assertOwned();
      const context = loadInvestigationRuntimeContext(cwd);
      const current = readInvestigationSession(
        context.runtime,
        investigationId,
      );
      assertCurrentInvestigationContext(context, current);
      assertInvestigationProviderHistory(context, current);
      const result = operation(context, current);
      assertOwned();
      return result;
    },
  );
}

function statusFromSession(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): InvestigationStatus {
  const invocation = readProviderInvocation(
    context.runtime,
    session.currentBlindInvocationId,
  );
  assertProviderPublicationBinding(session, invocation, false);
  assertInvestigationProviderHistory(context, session);
  const checkpointKind = expectedCheckpointKind(session);
  const checkpoint =
    checkpointKind === null
      ? null
      : {
          schemaVersion: 1 as const,
          kind: checkpointKind,
          checkpointId: investigationCheckpointId(session, checkpointKind),
        };
  return deepFreeze({
    kind: 'investigation' as const,
    investigationId: session.investigationId,
    changeId: session.changeId,
    revision: session.revision,
    state: session.state,
    baseline: { ...session.baseline },
    intentDigest: session.intentDigest,
    blindManifestDigest: session.blindManifestDigest,
    providerInvocationId: session.currentBlindInvocationId,
    provider: {
      state: invocation.state,
      providerId: invocation.providerId,
      attempt: invocation.attempt,
      revision: invocation.revision,
      leaseGeneration: invocation.leaseGeneration,
      leaseExpiresAt: invocation.lease?.expiresAt ?? null,
      failure: invocation.failure,
      resultDigest: invocation.result?.outputDigest ?? null,
    },
    checkpoint,
    nextAction: deriveNextAction(session, invocation),
  });
}

function deriveNextAction(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
): InvestigationStatus['nextAction'] {
  if (session.state === 'actor-resolution-required') {
    return 'resolve-actor';
  }
  if (session.state === 'human-action-required') {
    return 'human-action';
  }
  if (session.state === 'awaiting-main-terms') {
    return 'submit-main-terms';
  }
  if (session.state === 'waiting-for-provider') {
    if (invocation.failure?.kind === 'repository-reconciliation-required') {
      return 'reconcile-repository';
    }
    if (invocation.state === 'failed') {
      return 'retry-provider';
    }
    if (
      invocation.state === 'leased' &&
      invocation.lease !== null &&
      Date.now() >= Date.parse(invocation.lease.expiresAt)
    ) {
      return 'expire-provider-lease';
    }
    return invocation.state === 'succeeded'
      ? 'resume-provider-result'
      : 'wait-for-provider';
  }
  if (session.state === 'awaiting-group-dispositions') {
    return 'submit-group-dispositions';
  }
  if (session.state === 'awaiting-ledger-answers') {
    return 'submit-why-answers';
  }
  return 'investigation-complete';
}

function expectedCheckpointKind(
  session: InvestigationSession,
): InvestigationCheckpointKind | null {
  if (session.state === 'awaiting-main-terms') {
    return 'main-terms';
  }
  if (session.state === 'awaiting-group-dispositions') {
    return 'group-dispositions';
  }
  if (session.state === 'awaiting-ledger-answers') {
    return 'why-answers';
  }
  return null;
}

function storedCheckpointFor(
  session: InvestigationSession,
  kind: InvestigationCheckpointKind,
): { envelope: StoredInvestigationCheckpoint } | null {
  const checkpoint =
    kind === 'main-terms'
      ? session.milestones.mainTerms
      : kind === 'group-dispositions'
        ? session.milestones.groupDispositions
        : session.milestones.whyAnswers;
  return checkpoint === null ? null : { envelope: checkpoint };
}

function assertCheckpointBinding(
  session: InvestigationSession,
  envelope: InvestigationCheckpointEnvelope,
): void {
  if (
    envelope.investigationId !== session.investigationId ||
    envelope.changeId !== session.changeId ||
    canonicalJson(envelope.baseline) !== canonicalJson(session.baseline) ||
    envelope.intentDigest !== session.intentDigest ||
    envelope.blindManifestDigest !== session.blindManifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_STALE',
      'Investigation checkpoint is bound to a different session or baseline.',
      ExitCode.staleState,
    );
  }
}

function assertCurrentInvestigationContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): void {
  const current = readCurrentInvestigationRef(
    context.runtime,
    session.changeId,
  );
  if (
    current?.investigationId !== session.investigationId ||
    context.git.repositoryRealPath !== session.repositoryRoot ||
    context.git.gitCommonDirectory !== session.gitCommonDirectory ||
    context.git.branch !== session.branch ||
    context.git.head !== session.baseline.head ||
    context.git.tree !== session.baseline.tree
  ) {
    throw workflowError(
      'INVESTIGATION_CONTEXT_STALE',
      'Investigation repository, branch, baseline, or current ref changed.',
      ExitCode.staleState,
    );
  }
}

function assertProviderPublicationBinding(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
  requireCurrent = true,
): void {
  if (
    invocation.investigationId !== session.investigationId ||
    invocation.changeId !== session.changeId ||
    (requireCurrent &&
      invocation.invocationId !== session.currentBlindInvocationId) ||
    invocation.requestDigest !== session.blindRequestDigest ||
    invocation.manifestDigest !== session.blindManifestDigest ||
    invocation.purpose !== 'survey'
  ) {
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_STALE',
      'Provider result is not bound to the current blind investigation attempt.',
      ExitCode.staleState,
    );
  }
}

function assertPublishedProviderMilestone(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
): void {
  const published = session.milestones.blindResult;
  if (published === null) {
    return;
  }
  if (
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    published.invocationId !== invocation.invocationId ||
    published.requestDigest !== invocation.requestDigest ||
    published.outputDigest !== invocation.result.outputDigest
  ) {
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_STALE',
      'Published provider milestone is not an exact durable successful result.',
      ExitCode.staleState,
    );
  }
}

function assertInvestigationProviderHistory(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): void {
  const startReservation = readInvestigationStartReservation(
    context.runtime,
    session.changeId,
  );
  if (startReservation === null) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_MISSING',
      'Investigation provider history has no durable start reservation.',
      ExitCode.staleState,
    );
  }
  assertStartReservationSessionBinding(context, startReservation, session);
  if (session.currentBlindInvocationId !== session.blindInvocationIds.at(-1)) {
    throw providerHistoryInvalid();
  }

  const invocations = session.blindInvocationIds.map((invocationId) =>
    readProviderInvocation(context.runtime, invocationId),
  );
  const requests = session.blindInvocationIds.map((invocationId) =>
    readProviderInvocationRequest(context.runtime, invocationId),
  );
  if (
    new Set(requests.map((request) => request.nonce)).size !== requests.length
  ) {
    throw providerHistoryInvalid();
  }
  for (const [index, invocation] of invocations.entries()) {
    const attempt = index + 1;
    if (
      invocation.investigationId !== session.investigationId ||
      invocation.changeId !== session.changeId ||
      invocation.attempt !== attempt ||
      invocation.manifestDigest !== session.blindManifestDigest
    ) {
      throw providerHistoryInvalid();
    }
    if (attempt === 1) {
      if (
        invocation.invocationId !== startReservation.invocationId ||
        invocation.requestDigest !== startReservation.requestDigest
      ) {
        throw providerHistoryInvalid();
      }
      continue;
    }
    const retryReservation = readProviderRetryReservation(
      context.runtime,
      session.investigationId,
      attempt,
    );
    const previous = invocations[index - 1];
    if (
      retryReservation === null ||
      previous === undefined ||
      retryReservation.changeId !== session.changeId ||
      retryReservation.previousInvocationId !== previous.invocationId ||
      retryReservation.invocationId !== invocation.invocationId ||
      retryReservation.requestDigest !== invocation.requestDigest ||
      retryReservation.requestDigest !== requests[index]?.requestDigest ||
      retryReservation.manifestDigest !== invocation.manifestDigest ||
      previous.state !== 'failed' ||
      previous.failure?.kind !== 'retryable'
    ) {
      throw providerHistoryInvalid();
    }
  }
  const current = invocations.at(-1);
  if (
    current === undefined ||
    current.requestDigest !== session.blindRequestDigest
  ) {
    throw providerHistoryInvalid();
  }
  assertPublishedProviderMilestone(session, current);
}

function providerHistoryInvalid() {
  return workflowError(
    'INVESTIGATION_PROVIDER_HISTORY_INVALID',
    'Investigation provider attempts do not form the reserved monotonic history.',
    ExitCode.staleState,
  );
}

function assertStartBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  changeId: string,
  input: StartInvestigationSessionInput,
  manifestDigest: string,
  intentDigest: string,
): void {
  const request = input.blindRequest;
  const manifest = input.blindManifest;
  if (
    manifest.changeId !== changeId ||
    manifest.baseCommit !== context.git.head ||
    manifest.baseTree !== context.git.tree ||
    manifest.repositoryId !== context.config.repositoryName ||
    request.repositoryId !== manifest.repositoryId ||
    request.baseCommit !== manifest.baseCommit ||
    request.baseTree !== manifest.baseTree ||
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'blind-surveyor' ||
    request.targetDigest !== intentDigest ||
    request.roleAssignment.targetDigest !== intentDigest ||
    request.inputManifestDigest !== manifestDigest ||
    request.capabilityProfile !== 'repository-read-only'
  ) {
    throw workflowError(
      'INVESTIGATION_BLIND_REQUEST_UNBOUND',
      'Blind provider request is not bound to the sealed manifest and baseline.',
      ExitCode.guard,
    );
  }
}

function assertStableStartContext(
  before: ReturnType<typeof loadInvestigationRuntimeContext>,
  after: ReturnType<typeof loadInvestigationRuntimeContext>,
): void {
  if (
    before.git.repositoryRealPath !== after.git.repositoryRealPath ||
    before.git.gitCommonDirectory !== after.git.gitCommonDirectory ||
    before.config.runtimeDirectory !== after.config.runtimeDirectory ||
    before.git.branch !== after.git.branch ||
    before.git.head !== after.git.head ||
    before.git.tree !== after.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Repository identity, branch, or pinned baseline changed during start.',
      ExitCode.staleState,
    );
  }
}

function assertStartReservationContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  reservation: {
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string | null;
    baseline: {
      head: string;
      tree: string;
    };
  },
): void {
  if (
    reservation.repositoryRoot !== context.git.repositoryRealPath ||
    reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
    reservation.branch !== context.git.branch ||
    reservation.baseline.head !== context.git.head ||
    reservation.baseline.tree !== context.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Durable investigation start belongs to another worktree, branch, or baseline.',
      ExitCode.staleState,
    );
  }
}

function assertStartReservationSessionBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  reservation: InvestigationStartReservation,
  session: InvestigationSession,
): void {
  assertStartReservationContext(context, reservation);
  const initialInvocation = readProviderInvocation(
    context.runtime,
    reservation.invocationId,
  );
  if (
    session.investigationId !== reservation.investigationId ||
    session.changeId !== reservation.changeId ||
    session.repositoryRoot !== reservation.repositoryRoot ||
    session.gitCommonDirectory !== reservation.gitCommonDirectory ||
    session.branch !== reservation.branch ||
    canonicalJson(session.baseline) !== canonicalJson(reservation.baseline) ||
    session.intentDigest !== blindSurveyIntentDigest(reservation.manifest) ||
    session.blindManifestDigest !== reservation.manifestDigest ||
    session.blindInvocationIds[0] !== reservation.invocationId ||
    initialInvocation.investigationId !== reservation.investigationId ||
    initialInvocation.changeId !== reservation.changeId ||
    initialInvocation.attempt !== 1 ||
    initialInvocation.requestDigest !== reservation.requestDigest ||
    initialInvocation.manifestDigest !== reservation.manifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_CONFLICT',
      'Durable investigation start artifacts disagree.',
      ExitCode.staleState,
    );
  }
}

function assertReplacementRequestBinding(
  session: InvestigationSession,
  request: ProviderInvocationRequest,
  manifest: BlindSurveyManifest,
): void {
  if (
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'blind-surveyor' ||
    request.baseCommit !== session.baseline.head ||
    request.baseTree !== session.baseline.tree ||
    request.targetDigest !== session.intentDigest ||
    request.roleAssignment.targetDigest !== session.intentDigest ||
    request.inputManifestDigest !== session.blindManifestDigest ||
    request.repositoryId !== manifest.repositoryId
  ) {
    throw workflowError(
      'PROVIDER_RETRY_REQUEST_UNBOUND',
      'Replacement provider request is not bound to the current investigation.',
      ExitCode.guard,
    );
  }
}

function assertExactStartInput(
  value: unknown,
): asserts value is StartInvestigationSessionInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(value, 'changeId') ||
    !Object.prototype.hasOwnProperty.call(value, 'blindManifest') ||
    !Object.prototype.hasOwnProperty.call(value, 'blindRequest')
  ) {
    throw workflowError(
      'INVESTIGATION_START_INPUT_INVALID',
      'Investigation start accepts only changeId and sealed blind inputs.',
      ExitCode.usage,
    );
  }
}

function investigationCasMismatch(expected: number, observed: number) {
  return workflowError(
    'INVESTIGATION_CAS_MISMATCH',
    'Investigation session changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
