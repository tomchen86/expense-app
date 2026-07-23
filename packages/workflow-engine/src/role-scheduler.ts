import { ExitCode, workflowError } from './errors.ts';
import type { ActorAssurance } from './actor-identity.ts';
import {
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

  const selected = input.candidates.find(
    (candidate) =>
      candidate.enabled &&
      candidate.available &&
      candidate.providerId !== input.author.providerId,
  );

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
