/**
 * Stable state vocabulary shared by lifecycle owners and read-only guidance.
 *
 * This module owns names only. State transitions and durable authority remain
 * in their application lifecycles; consumers must not infer transitions from
 * these unions.
 */
export type ManagedTaskStrategyState =
  | 'not-required'
  | 'session-terminal'
  | 'transformation-required'
  | 'transformation-produced'
  | 'red-authoring'
  | 'implementation-required'
  | 'ready'
  | 'reservation-persisted'
  | 'collaboration-grant-required'
  | 'waiting-for-provider'
  | 'provider-succeeded-awaiting-import'
  | 'provider-failed'
  | 'correction-required'
  | 'correction-exhausted'
  | 'caller-supplied-awaiting-import'
  | 'patch-imported';

export type ManagedTaskDiffReviewState =
  | 'not-required'
  | 'ready'
  | 'collaboration-grant-required'
  | 'external-grant-resume-required'
  | 'direct-human-attestation-required'
  | 'external-reconciliation-required'
  | 'satisfied'
  | 'challenge-response-required'
  | 'challenge-closure-required'
  | 'changes-required'
  | 'waiting-for-provider'
  | 'provider-succeeded-awaiting-reconciliation'
  | 'provider-failed';

export const MANAGED_AUTHORITY_PLAN_STATES = Object.freeze([
  'prepared',
  'applying-local',
  'local-applied',
  'awaiting-attestation',
  'attestation-issued',
  'completed',
] as const);

export type ManagedAuthorityPlanState =
  (typeof MANAGED_AUTHORITY_PLAN_STATES)[number];

const MANAGED_AUTHORITY_PLAN_STATE_SET: ReadonlySet<string> = new Set(
  MANAGED_AUTHORITY_PLAN_STATES,
);

export function isManagedAuthorityPlanState(
  value: unknown,
): value is ManagedAuthorityPlanState {
  return (
    typeof value === 'string' && MANAGED_AUTHORITY_PLAN_STATE_SET.has(value)
  );
}

export type ExactStateSet<Left, Right> = [
  Exclude<Left, Right>,
  Exclude<Right, Left>,
] extends [never, never]
  ? true
  : false;

export type AssertExactStateSet<Result extends true> = Result;
