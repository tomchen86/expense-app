import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { ActorAssurance } from './actor-identity.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  canonicalCollaborationGrantEnvelope,
  directHumanReviewAttestationDigest,
  parseCollaborationGrantEnvelope,
  validateDirectHumanReviewAttestation,
  type CollaborationDegradedForm,
  type DirectHumanReviewAttestation,
} from './collaboration-grant.ts';
import {
  validateCollaborationGrantUseProjection,
  type CollaborationGrantUseProjection,
  type CollaborationGrantUseValidationOptions,
  type CollaborationReservationRecord,
} from './collaboration-grant-store.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';
import type { MaintainerSignerProvider } from './maintainer-signer.ts';
import {
  isProviderId,
  requireProviderCapability,
  type CapabilityPurpose,
  type ProviderId,
} from './provider-registry.ts';

/**
 * Role independence is always expressed at an explicit dimension. Provider
 * inequality, principal inequality, and session inequality are never
 * interchangeable, and the ordinary blind-survey and plan-review roles require
 * provider independence relative to the author being challenged. Repository or
 * caller policy cannot lower either ordinary requirement; only an eligible
 * collaboration grant produces a precisely labeled degraded contribution.
 */
export type IndependenceDimension =
  | 'provider-independent'
  | 'principal-independent'
  | 'session-independent'
  | 'none';

export type OrdinaryRole = 'blind-surveyor' | 'plan-reviewer';

/**
 * A role participant. Provider and session are optional so the type can also
 * represent caller-supplied or direct-human degraded work that has no engine
 * provider session at all.
 */
export type RoleParticipant = {
  providerId: ProviderId | undefined;
  sessionId: string | undefined;
  principalId: string | undefined;
  identityAssurance: ActorAssurance;
  engineSpawned: boolean;
};

export type RecordedRoleParticipant = {
  providerId: ProviderId | null;
  sessionId: string | null;
  principalId: string | null;
  identityAssurance: ActorAssurance | 'maintainer-signed';
  engineSpawned: boolean;
};

export type RoleIndependence = {
  principalIndependent: boolean | null;
  providerIndependent: boolean;
  sessionIndependent: boolean;
  achievedIndependence: IndependenceDimension;
};

export type RoleCandidate = {
  providerId: ProviderId;
  sessionId: string;
  enabled: boolean;
  available: boolean;
};

export type RoleAssignment = {
  role: OrdinaryRole;
  providerId: ProviderId;
  sessionId: string;
  targetDigest: string;
  requiredIndependence: IndependenceDimension;
  achievedIndependence: IndependenceDimension;
};

export type ScheduleOrdinaryRoleInput = {
  role: OrdinaryRole;
  author: RoleParticipant;
  targetDigest: string;
  candidates: RoleCandidate[];
  requestedIndependence?: IndependenceDimension;
};

export type ScheduleOrdinaryRoleResult =
  | {
      outcome: 'assigned';
      assignment: RoleAssignment;
    }
  | {
      outcome: 'collaboration-grant-required';
      role: OrdinaryRole;
      requiredIndependence: IndependenceDimension;
      reason: 'NO_PROVIDER_INDEPENDENT_CANDIDATE';
    };

export type GrantedRoleAssignment = {
  role: OrdinaryRole;
  providerId: ProviderId | null;
  sessionId: string | null;
  targetDigest: string;
  requiredIndependence: 'provider-independent';
  achievedIndependence: 'session-independent' | 'none';
  providerIndependent: false;
  sessionIndependent: boolean;
  engineSpawned: boolean;
  orchestration:
    'engine-spawned-provider' | 'caller-supplied' | 'direct-human-review';
  grantId: string;
  degradedForm: CollaborationDegradedForm;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  author: RecordedRoleParticipant;
  participant: RecordedRoleParticipant;
  callableProviderIds: readonly ProviderId[];
  directHumanReviewAttestationDigest: string | null;
};

export type GrantedSameProviderRoleAssignment = GrantedRoleAssignment & {
  providerId: ProviderId;
  sessionId: string;
  achievedIndependence: 'session-independent';
  sessionIndependent: true;
  engineSpawned: true;
  orchestration: 'engine-spawned-provider';
  degradedForm: 'same-provider-fresh-session';
  directHumanReviewAttestationDigest: null;
};

export type ProviderRoleAssignment =
  RoleAssignment | GrantedSameProviderRoleAssignment;

export type RoleContentAdmission = {
  kind: 'blind-survey' | 'plan-review';
  nodeId: string;
  resultDigest: string;
  outputSchema: { id: string; version: number; digest: string };
  evaluator: string;
  policyDigest: string;
  contentDigest: string;
  current: true;
};

export type RoleProviderInvocationEvidence = {
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  providerId: ProviderId;
  sessionId: string;
  targetDigest: string;
  engineSpawned: true;
};

export type AdmittedRoleResult = {
  schemaVersion: 1;
  form:
    | 'ordinary-provider'
    | 'granted-same-provider'
    | 'granted-caller-supplied'
    | 'direct-human-attestation';
  role: OrdinaryRole;
  targetDigest: string;
  assignment: RoleAssignment | GrantedRoleAssignment;
  author: RecordedRoleParticipant;
  participant: RecordedRoleParticipant;
  orchestration:
    'engine-spawned-provider' | 'caller-supplied' | 'direct-human-review';
  requiredIndependence: 'provider-independent';
  achievedIndependence: IndependenceDimension;
  content: RoleContentAdmission;
  providerInvocation: RoleProviderInvocationEvidence | null;
  grantUse: CollaborationGrantUseProjection | null;
  directHumanReviewAttestation: DirectHumanReviewAttestation | null;
  resultDigest: string;
};

export type AdmitRoleResultInput = {
  assignment: RoleAssignment | GrantedRoleAssignment;
  author: RoleParticipant | RecordedRoleParticipant;
  participant: RoleParticipant | RecordedRoleParticipant;
  content: RoleContentAdmission;
  providerInvocation: RoleProviderInvocationEvidence | null;
  grantUse: unknown | null;
  grantValidation: Omit<
    CollaborationGrantUseValidationOptions,
    'expectedAssignment' | 'contentAdmission'
  > | null;
};

const ORDINARY_ASSIGNMENT_KEYS = [
  'role',
  'providerId',
  'sessionId',
  'targetDigest',
  'requiredIndependence',
  'achievedIndependence',
] as const;
const ROLE_CONTENT_KEYS = [
  'kind',
  'nodeId',
  'resultDigest',
  'outputSchema',
  'evaluator',
  'policyDigest',
  'contentDigest',
  'current',
] as const;
const OUTPUT_SCHEMA_KEYS = ['id', 'version', 'digest'] as const;
const PROVIDER_INVOCATION_KEYS = [
  'invocationId',
  'requestDigest',
  'outputDigest',
  'providerId',
  'sessionId',
  'targetDigest',
  'engineSpawned',
] as const;
const RECORDED_PARTICIPANT_KEYS = [
  'providerId',
  'sessionId',
  'principalId',
  'identityAssurance',
  'engineSpawned',
] as const;

export type DirectHumanReviewProof = {
  attestation: DirectHumanReviewAttestation;
  policy: MaintainerPolicy;
  verifier: MaintainerSignerProvider;
  now: Date;
  reviewNodeId: string;
  reviewResultDigest: string;
};

export type AuthorizeGrantedOrdinaryRoleInput = {
  role: OrdinaryRole;
  author: RoleParticipant;
  targetDigest: string;
  reservation: CollaborationReservationRecord;
  actualParticipant: RoleParticipant;
  callableProviderIds: ProviderId[];
  directHumanReview?: DirectHumanReviewProof;
};

const ROLE_CAPABILITY: Record<OrdinaryRole, CapabilityPurpose> = {
  'blind-surveyor': 'survey',
  'plan-reviewer': 'plan-review',
};

/**
 * Assess independence of a candidate relative to the author being challenged.
 * Provider independence requires the candidate to have a provider distinct from
 * the author's. Session independence requires both author and candidate to have
 * defined session IDs, the candidate to be engine-spawned, and the IDs to
 * differ; it is never manufactured relative to an author with no session.
 * Principal independence is unknown (`null`) whenever either principal is
 * unidentified. When principal independence is positively established and
 * provider independence is not, the achieved summary is `principal-independent`
 * before session independence is considered.
 */
export function assessRoleIndependence(
  author: RoleParticipant,
  candidate: RoleParticipant,
): RoleIndependence {
  const providerIndependent =
    candidate.providerId !== undefined &&
    author.providerId !== undefined &&
    candidate.providerId !== author.providerId;
  const sessionIndependent =
    candidate.engineSpawned &&
    candidate.sessionId !== undefined &&
    author.sessionId !== undefined &&
    candidate.sessionId !== author.sessionId;
  const principalIndependent =
    author.principalId === undefined || candidate.principalId === undefined
      ? null
      : candidate.principalId !== author.principalId;

  let achievedIndependence: IndependenceDimension = 'none';
  if (providerIndependent) {
    achievedIndependence = 'provider-independent';
  } else if (principalIndependent === true) {
    achievedIndependence = 'principal-independent';
  } else if (sessionIndependent) {
    achievedIndependence = 'session-independent';
  }

  return {
    principalIndependent,
    providerIndependent,
    sessionIndependent,
    achievedIndependence,
  };
}

/**
 * Schedule an ordinary blind-survey or plan-review role. The requirement is
 * fixed at provider independence; requesting a weaker dimension fails closed.
 * Every runtime candidate ID is checked against the code-owned registry and the
 * required role capability, so an unknown candidate fails closed rather than
 * being launched. The first enabled, available, provider-independent candidate
 * is assigned; otherwise the transition pauses for an eligible collaboration
 * grant.
 */
export function scheduleOrdinaryRole(
  input: ScheduleOrdinaryRoleInput,
): ScheduleOrdinaryRoleResult {
  const requiredIndependence: IndependenceDimension = 'provider-independent';

  if (
    input.requestedIndependence !== undefined &&
    input.requestedIndependence !== requiredIndependence
  ) {
    throw workflowError(
      'ROLE_INDEPENDENCE_DOWNGRADE',
      `Ordinary role "${input.role}" requires ${requiredIndependence}; ` +
        `it cannot be lowered to ${input.requestedIndependence}.`,
      ExitCode.guard,
    );
  }

  // Every candidate ID must be a reviewed provider that supports the required
  // capability; an unknown candidate fails closed before any selection.
  const capability = ROLE_CAPABILITY[input.role];
  for (const candidate of input.candidates) {
    requireProviderCapability(
      candidate.providerId,
      capability,
      'repository-read-only',
    );
  }

  const selected = input.candidates.find((candidate) => {
    if (!candidate.enabled || !candidate.available) {
      return false;
    }
    return assessRoleIndependence(input.author, {
      providerId: candidate.providerId,
      sessionId: candidate.sessionId,
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    }).providerIndependent;
  });

  if (!selected) {
    return {
      outcome: 'collaboration-grant-required',
      role: input.role,
      requiredIndependence,
      reason: 'NO_PROVIDER_INDEPENDENT_CANDIDATE',
    };
  }

  const assignment: RoleAssignment = Object.freeze({
    role: input.role,
    providerId: selected.providerId,
    sessionId: selected.sessionId,
    targetDigest: input.targetDigest,
    requiredIndependence,
    achievedIndependence: 'provider-independent',
  });

  return { outcome: 'assigned', assignment };
}

/**
 * Apply an already validated and atomically reserved collaboration grant to
 * one exact ordinary-role conflict. This is intentionally additive to
 * `scheduleOrdinaryRole`: an ordinary `RoleAssignment` remains provider
 * independent, while degraded assignments have a distinct type that cannot be
 * accepted by provider-independent request contracts.
 *
 * The function derives achieved independence and orchestration from the actual
 * participant and callable-provider set. Callers cannot supply either claim.
 * A same-provider grant requires the only callable provider, a real
 * engine-spawned fresh session, and is labeled session-independent. A
 * caller-supplied or direct-human contribution is permitted only when no
 * provider is callable and always records no provider/session independence.
 */
export function authorizeGrantedOrdinaryRole(
  input: AuthorizeGrantedOrdinaryRoleInput,
): GrantedRoleAssignment {
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray(input.callableProviderIds) ||
    !/^[0-9a-f]{64}$/.test(input.targetDigest)
  ) {
    throw grantedRoleInvalid();
  }
  const callableProviderIds = [...input.callableProviderIds];
  if (
    callableProviderIds.some((providerId) => !isProviderId(providerId)) ||
    callableProviderIds.length !== new Set(callableProviderIds).size
  ) {
    throw grantedRoleInvalid();
  }

  const reservation = input.reservation;
  if (
    !reservation ||
    reservation.state !== 'reserved' ||
    !/^[0-9a-f]{64}$/.test(reservation.transitionDigest)
  ) {
    throw grantedRoleInvalid();
  }
  const envelope = parseCollaborationGrantEnvelope(
    canonicalCollaborationGrantEnvelope(reservation.envelope),
  );
  const payload = envelope.payload;
  if (
    payload.targetDigest !== input.targetDigest ||
    payload.rolePair.conflictingRole !== input.role ||
    (input.role === 'blind-surveyor' &&
      payload.lifecyclePhase !== 'blind-survey') ||
    (input.role === 'plan-reviewer' && payload.lifecyclePhase !== 'plan-review')
  ) {
    throw grantedRoleInvalid();
  }

  const base = {
    role: input.role,
    targetDigest: payload.targetDigest,
    requiredIndependence: 'provider-independent' as const,
    providerIndependent: false as const,
    grantId: payload.grantId,
    degradedForm: payload.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    author: recordParticipant(input.author),
    callableProviderIds: Object.freeze([...callableProviderIds].sort()),
  };
  const participant = input.actualParticipant;

  if (
    payload.degradedForm === 'same-provider-fresh-session' &&
    payload.availableActor.kind === 'provider'
  ) {
    const providerId = payload.availableActor.providerId;
    if (
      input.author.providerId !== providerId ||
      callableProviderIds.length !== 1 ||
      callableProviderIds[0] !== providerId ||
      participant.providerId !== providerId ||
      participant.identityAssurance !== payload.availableActor.assurance ||
      !participant.engineSpawned ||
      typeof input.author.sessionId !== 'string' ||
      typeof participant.sessionId !== 'string' ||
      participant.sessionId.length === 0 ||
      participant.sessionId === input.author.sessionId
    ) {
      throw grantedRoleInvalid();
    }
    return Object.freeze({
      ...base,
      providerId,
      sessionId: participant.sessionId,
      achievedIndependence: 'session-independent' as const,
      sessionIndependent: true,
      engineSpawned: true,
      orchestration: 'engine-spawned-provider' as const,
      participant: recordParticipant(participant),
      directHumanReviewAttestationDigest: null,
    });
  }

  if (
    callableProviderIds.length !== 0 ||
    participant.providerId !== undefined ||
    participant.sessionId !== undefined ||
    participant.engineSpawned
  ) {
    throw grantedRoleInvalid();
  }

  if (
    payload.degradedForm === 'caller-supplied' &&
    payload.availableActor.kind === 'caller' &&
    participant.principalId === payload.availableActor.callerId &&
    participant.identityAssurance === payload.availableActor.assurance
  ) {
    return Object.freeze({
      ...base,
      providerId: null,
      sessionId: null,
      achievedIndependence: 'none' as const,
      sessionIndependent: false,
      engineSpawned: false,
      orchestration: 'caller-supplied' as const,
      participant: recordParticipant(participant),
      directHumanReviewAttestationDigest: null,
    });
  }

  if (
    payload.degradedForm === 'direct-human-review' &&
    payload.availableActor.kind === 'direct-human' &&
    input.role === 'plan-reviewer' &&
    participant.principalId === payload.availableActor.identity &&
    input.directHumanReview
  ) {
    const attestation = validateDirectHumanReviewAttestation(
      input.directHumanReview.attestation,
      {
        now: input.directHumanReview.now,
        grantEnvelope: envelope,
        policy: input.directHumanReview.policy,
        verifier: input.directHumanReview.verifier,
        transitionDigest: reservation.transitionDigest,
        reviewNodeId: input.directHumanReview.reviewNodeId,
        reviewResultDigest: input.directHumanReview.reviewResultDigest,
      },
    );
    return Object.freeze({
      ...base,
      providerId: null,
      sessionId: null,
      achievedIndependence: 'none' as const,
      sessionIndependent: false,
      engineSpawned: false,
      orchestration: 'direct-human-review' as const,
      participant: {
        ...recordParticipant(participant),
        identityAssurance: 'maintainer-signed' as const,
      },
      directHumanReviewAttestationDigest:
        directHumanReviewAttestationDigest(attestation),
    });
  }

  throw grantedRoleInvalid();
}

/**
 * Admit one exact role result without conflating provider execution with
 * caller-supplied or direct-human content. The result form is derived from the
 * assignment and observed orchestration; callers cannot select a stronger
 * label. Grant-backed forms replay the same signed-use validator used by live
 * grant consumption and CI.
 */
export function admitRoleResult(
  input: AdmitRoleResultInput,
): AdmittedRoleResult {
  if (!input || typeof input !== 'object') {
    throw roleResultInvalid();
  }
  const assignment = input.assignment;
  const content = assertRoleContentAdmission(input.content);
  const author = normalizeRecordedParticipant(input.author);
  const participant = normalizeRecordedParticipant(input.participant);
  if (
    (assignment.role !== 'blind-surveyor' &&
      assignment.role !== 'plan-reviewer') ||
    !/^[0-9a-f]{64}$/.test(assignment.targetDigest)
  ) {
    throw roleResultInvalid();
  }
  const expectedContentKind =
    assignment.role === 'blind-surveyor' ? 'blind-survey' : 'plan-review';
  if (content.kind !== expectedContentKind) {
    throw roleResultInvalid();
  }

  let form: AdmittedRoleResult['form'];
  let providerInvocation: RoleProviderInvocationEvidence | null = null;
  let grantUse: CollaborationGrantUseProjection | null = null;
  let directHumanReviewAttestation: DirectHumanReviewAttestation | null = null;
  let orchestration: AdmittedRoleResult['orchestration'];
  let achievedIndependence: IndependenceDimension;

  if (isOrdinaryRoleAssignment(assignment)) {
    if (input.grantUse !== null || input.grantValidation !== null) {
      throw roleResultInvalid();
    }
    if (
      participant.providerId !== assignment.providerId ||
      participant.sessionId !== assignment.sessionId ||
      participant.engineSpawned !== true
    ) {
      throw roleResultInvalid();
    }
    providerInvocation = assertProviderInvocation(
      input.providerInvocation,
      assignment,
    );
    form = 'ordinary-provider';
    orchestration = 'engine-spawned-provider';
    achievedIndependence = 'provider-independent';
  } else {
    if (
      canonicalJson(author) !== canonicalJson(assignment.author) ||
      canonicalJson(participant) !== canonicalJson(assignment.participant) ||
      input.grantUse === null ||
      input.grantValidation === null
    ) {
      throw roleResultInvalid();
    }
    grantUse = validateCollaborationGrantUseProjection(input.grantUse, {
      ...input.grantValidation,
      expectedAssignment: assignment,
      contentAdmission: {
        kind: content.kind,
        nodeId: content.nodeId,
        resultDigest: content.resultDigest,
        current: true,
      },
    });
    orchestration = assignment.orchestration;
    achievedIndependence = assignment.achievedIndependence;

    if (isGrantedSameProviderRoleAssignment(assignment)) {
      providerInvocation = assertProviderInvocation(
        input.providerInvocation,
        assignment,
      );
      form = 'granted-same-provider';
    } else {
      if (input.providerInvocation !== null) {
        throw roleResultInvalid();
      }
      if (assignment.degradedForm === 'caller-supplied') {
        form = 'granted-caller-supplied';
      } else if (assignment.degradedForm === 'direct-human-review') {
        if (
          assignment.orchestration !== 'direct-human-review' ||
          !grantUse.directHumanReviewAttestation ||
          assignment.directHumanReviewAttestationDigest !==
            directHumanReviewAttestationDigest(
              grantUse.directHumanReviewAttestation,
            )
        ) {
          throw roleResultInvalid();
        }
        form = 'direct-human-attestation';
        directHumanReviewAttestation = grantUse.directHumanReviewAttestation;
      } else {
        throw roleResultInvalid();
      }
    }
  }

  const semantic = {
    schemaVersion: 1 as const,
    form,
    role: assignment.role,
    targetDigest: assignment.targetDigest,
    assignment: structuredClone(assignment),
    author,
    participant,
    orchestration,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence,
    content,
    providerInvocation,
    grantUse,
    directHumanReviewAttestation,
  };
  return deepFreeze({
    ...semantic,
    resultDigest: crypto
      .createHash('sha256')
      .update(canonicalJson({ schema: 'admitted-role-result.v1', ...semantic }))
      .digest('hex'),
  });
}

export function isGrantedSameProviderRoleAssignment(
  value: GrantedRoleAssignment,
): value is GrantedSameProviderRoleAssignment {
  return (
    value.degradedForm === 'same-provider-fresh-session' &&
    value.orchestration === 'engine-spawned-provider' &&
    value.providerId !== null &&
    value.sessionId !== null &&
    value.achievedIndependence === 'session-independent' &&
    value.sessionIndependent === true &&
    value.engineSpawned === true &&
    value.directHumanReviewAttestationDigest === null
  );
}

function isOrdinaryRoleAssignment(
  value: RoleAssignment | GrantedRoleAssignment,
): value is RoleAssignment {
  return (
    !('grantId' in value) &&
    hasExactKeys(value, ORDINARY_ASSIGNMENT_KEYS) &&
    (value.role === 'blind-surveyor' || value.role === 'plan-reviewer') &&
    isProviderId(value.providerId) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    /^[0-9a-f]{64}$/.test(value.targetDigest) &&
    value.requiredIndependence === 'provider-independent' &&
    value.achievedIndependence === 'provider-independent'
  );
}

function assertRoleContentAdmission(
  value: RoleContentAdmission,
): RoleContentAdmission {
  if (
    !value ||
    typeof value !== 'object' ||
    !hasExactKeys(value, ROLE_CONTENT_KEYS) ||
    !['blind-survey', 'plan-review'].includes(value.kind) ||
    !/^[0-9a-f]{64}$/.test(value.nodeId) ||
    !/^[0-9a-f]{64}$/.test(value.resultDigest) ||
    !value.outputSchema ||
    typeof value.outputSchema !== 'object' ||
    !hasExactKeys(value.outputSchema, OUTPUT_SCHEMA_KEYS) ||
    typeof value.outputSchema.id !== 'string' ||
    value.outputSchema.id.length === 0 ||
    !Number.isInteger(value.outputSchema.version) ||
    value.outputSchema.version < 1 ||
    !/^[0-9a-f]{64}$/.test(value.outputSchema.digest) ||
    typeof value.evaluator !== 'string' ||
    value.evaluator.length === 0 ||
    !/^[0-9a-f]{64}$/.test(value.policyDigest) ||
    value.contentDigest !== value.resultDigest ||
    value.current !== true
  ) {
    throw roleResultInvalid();
  }
  return deepFreeze(structuredClone(value));
}

function assertProviderInvocation(
  value: RoleProviderInvocationEvidence | null,
  assignment: ProviderRoleAssignment,
): RoleProviderInvocationEvidence {
  if (
    !value ||
    typeof value !== 'object' ||
    !hasExactKeys(value, PROVIDER_INVOCATION_KEYS) ||
    typeof value.invocationId !== 'string' ||
    value.invocationId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
    !/^[0-9a-f]{64}$/.test(value.outputDigest) ||
    value.providerId !== assignment.providerId ||
    value.sessionId !== assignment.sessionId ||
    value.targetDigest !== assignment.targetDigest ||
    value.engineSpawned !== true
  ) {
    throw roleResultInvalid();
  }
  return deepFreeze(structuredClone(value));
}

function normalizeRecordedParticipant(
  value: RoleParticipant | RecordedRoleParticipant,
): RecordedRoleParticipant {
  if (!value || typeof value !== 'object') {
    throw roleResultInvalid();
  }
  if (!hasExactKeys(value, RECORDED_PARTICIPANT_KEYS)) {
    throw roleResultInvalid();
  }
  const providerId = value.providerId ?? null;
  const sessionId = value.sessionId ?? null;
  const principalId = value.principalId ?? null;
  if (
    (providerId !== null && !isProviderId(providerId)) ||
    (sessionId !== null &&
      (typeof sessionId !== 'string' || sessionId.length === 0)) ||
    (principalId !== null &&
      (typeof principalId !== 'string' || principalId.length === 0)) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(value.identityAssurance) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw roleResultInvalid();
  }
  return deepFreeze({
    providerId,
    sessionId,
    principalId,
    identityAssurance: value.identityAssurance,
    engineSpawned: value.engineSpawned,
  });
}

function recordParticipant(
  participant: RoleParticipant,
): RecordedRoleParticipant {
  if (
    !participant ||
    typeof participant !== 'object' ||
    (participant.providerId !== undefined &&
      !isProviderId(participant.providerId)) ||
    (participant.sessionId !== undefined &&
      (typeof participant.sessionId !== 'string' ||
        participant.sessionId.length === 0)) ||
    (participant.principalId !== undefined &&
      (typeof participant.principalId !== 'string' ||
        participant.principalId.length === 0)) ||
    !['self-declared', 'runtime-hint', 'adapter-assigned'].includes(
      participant.identityAssurance,
    ) ||
    typeof participant.engineSpawned !== 'boolean'
  ) {
    throw grantedRoleInvalid();
  }
  return Object.freeze({
    providerId: participant.providerId ?? null,
    sessionId: participant.sessionId ?? null,
    principalId: participant.principalId ?? null,
    identityAssurance: participant.identityAssurance,
    engineSpawned: participant.engineSpawned,
  });
}

function grantedRoleInvalid() {
  return workflowError(
    'COLLABORATION_GRANT_ROLE_INVALID',
    'Collaboration grant does not authorize this exact degraded role assignment.',
    ExitCode.guard,
  );
}

function roleResultInvalid() {
  return workflowError(
    'ROLE_RESULT_INVALID',
    'Role result does not match its exact assignment, orchestration, content, and grant facts.',
    ExitCode.guard,
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string') &&
    expected.every((key) =>
      Object.prototype.propertyIsEnumerable.call(value, key),
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
