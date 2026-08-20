import crypto from 'node:crypto';

import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_LOGICAL_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
const ROLE_ORDER = ['author', 'builder', 'reviewer'] as const;
const ROLE_PAIR_ORDER = [
  'author-builder',
  'author-reviewer',
  'builder-reviewer',
] as const;

export type AgentRole = (typeof ROLE_ORDER)[number];
export type AgentRolePair = (typeof ROLE_PAIR_ORDER)[number];
export type AgentRoleScopeRule = 'planning-generation' | 'task' | 'candidate';
export type AgentRoleIndependenceRequirement =
  'provider-independent' | 'session-independent' | 'none';
export type AgentCustomWrapperPolicy =
  'forbidden' | 'allowed-non-protected' | 'allowed';

export type AgentRoleLaneV1 = Readonly<{
  role: AgentRole;
  scopeRule: AgentRoleScopeRule;
  allowedProviderFamilies: readonly string[];
  preferredLogicalProviderIds: readonly string[];
}>;

export type AgentPairwiseRequirementV1 = Readonly<{
  pair: AgentRolePair;
  required: AgentRoleIndependenceRequirement;
}>;

export type AgentRolePlanBodyV1 = Readonly<{
  schemaVersion: 1;
  changeId: string;
  planningGeneration: string;
  roleLanes: readonly AgentRoleLaneV1[];
  pairwiseRequirements: readonly AgentPairwiseRequirementV1[];
  customWrapperPolicy: AgentCustomWrapperPolicy;
  grantReferences: readonly string[];
}>;

export type AgentRolePlanV1 = AgentRolePlanBodyV1 &
  Readonly<{
    planDigest: string;
  }>;

export type AgentRolePlanReaderPort = Readonly<{
  readCurrent(
    repositoryRoot: string,
    changeId: string,
    planningGeneration: string,
  ): AgentRolePlanV1 | null;
  readPinned(
    repositoryRoot: string,
    commit: string,
    changeId: string,
    planningGeneration: string,
  ): AgentRolePlanV1 | null;
}>;

export function agentRolePlanDigest(value: AgentRolePlanBodyV1): string {
  const body = assertAgentRolePlanBody(
    value,
    value.changeId,
    value.planningGeneration,
  );
  return digestBody(body);
}

export function renderAgentRolePlan(value: AgentRolePlanV1): string {
  const plan = assertAgentRolePlan(
    value,
    value.changeId,
    value.planningGeneration,
  );
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function parseAgentRolePlan(
  source: string,
  expectedChangeId: string,
  expectedPlanningGeneration: string,
): AgentRolePlanV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw planInvalid('Agent-role plan must be valid JSON.');
  }
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'schemaVersion') &&
    value.schemaVersion !== 1
  ) {
    throw workflowError(
      'AGENT_ROLE_PLAN_VERSION_UNSUPPORTED',
      'Agent-role plan schema version is not supported.',
      ExitCode.verification,
    );
  }
  const plan = assertAgentRolePlan(
    value,
    expectedChangeId,
    expectedPlanningGeneration,
  );
  if (source !== renderAgentRolePlan(plan)) {
    throw planInvalid('Agent-role plan must use the canonical JSON encoding.');
  }
  return plan;
}

function assertAgentRolePlan(
  value: unknown,
  expectedChangeId: string,
  expectedPlanningGeneration: string,
): AgentRolePlanV1 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role plan must be one object.');
  }
  assertExactKeys(value, [
    'changeId',
    'customWrapperPolicy',
    'grantReferences',
    'pairwiseRequirements',
    'planDigest',
    'planningGeneration',
    'roleLanes',
    'schemaVersion',
  ]);
  const body = assertAgentRolePlanBody(
    {
      schemaVersion: value.schemaVersion,
      changeId: value.changeId,
      planningGeneration: value.planningGeneration,
      roleLanes: value.roleLanes,
      pairwiseRequirements: value.pairwiseRequirements,
      customWrapperPolicy: value.customWrapperPolicy,
      grantReferences: value.grantReferences,
    },
    expectedChangeId,
    expectedPlanningGeneration,
  );
  if (
    typeof value.planDigest !== 'string' ||
    !DIGEST.test(value.planDigest) ||
    value.planDigest !== digestBody(body)
  ) {
    throw planInvalid('Agent-role plan digest does not match its exact body.');
  }
  return Object.freeze({ ...body, planDigest: value.planDigest });
}

function assertAgentRolePlanBody(
  value: unknown,
  expectedChangeId: string,
  expectedPlanningGeneration: string,
): AgentRolePlanBodyV1 {
  if (
    !CHANGE_ID.test(expectedChangeId) ||
    expectedChangeId === 'archive' ||
    !DIGEST.test(expectedPlanningGeneration) ||
    !isRecord(value)
  ) {
    throw planInvalid('Agent-role plan identity is invalid.');
  }
  assertExactKeys(value, [
    'changeId',
    'customWrapperPolicy',
    'grantReferences',
    'pairwiseRequirements',
    'planningGeneration',
    'roleLanes',
    'schemaVersion',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.changeId !== expectedChangeId ||
    value.planningGeneration !== expectedPlanningGeneration ||
    !Array.isArray(value.roleLanes) ||
    value.roleLanes.length > ROLE_ORDER.length ||
    !Array.isArray(value.pairwiseRequirements) ||
    value.pairwiseRequirements.length > ROLE_PAIR_ORDER.length ||
    !isCustomWrapperPolicy(value.customWrapperPolicy)
  ) {
    throw planInvalid('Agent-role plan fields are invalid.');
  }

  const roleLanes = value.roleLanes.map(assertRoleLane);
  assertCanonicalEnumOrder(
    roleLanes.map(({ role }) => role),
    ROLE_ORDER,
  );
  const pairwiseRequirements = value.pairwiseRequirements.map(
    assertPairwiseRequirement,
  );
  assertCanonicalEnumOrder(
    pairwiseRequirements.map(({ pair }) => pair),
    ROLE_PAIR_ORDER,
  );
  const grantReferences = assertCanonicalLogicalIds(value.grantReferences);

  return Object.freeze({
    schemaVersion: 1,
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
    roleLanes: Object.freeze(roleLanes),
    pairwiseRequirements: Object.freeze(pairwiseRequirements),
    customWrapperPolicy: value.customWrapperPolicy,
    grantReferences,
  });
}

function assertRoleLane(value: unknown): AgentRoleLaneV1 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role lane must be one object.');
  }
  assertExactKeys(value, [
    'allowedProviderFamilies',
    'preferredLogicalProviderIds',
    'role',
    'scopeRule',
  ]);
  if (!isAgentRole(value.role) || !isScopeRule(value.scopeRule)) {
    throw planInvalid('Agent-role lane fields are invalid.');
  }
  return Object.freeze({
    role: value.role,
    scopeRule: value.scopeRule,
    allowedProviderFamilies: assertCanonicalLogicalIds(
      value.allowedProviderFamilies,
    ),
    preferredLogicalProviderIds: assertCanonicalLogicalIds(
      value.preferredLogicalProviderIds,
    ),
  });
}

function assertPairwiseRequirement(value: unknown): AgentPairwiseRequirementV1 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role pairwise requirement must be one object.');
  }
  assertExactKeys(value, ['pair', 'required']);
  if (!isAgentRolePair(value.pair) || !isRequirement(value.required)) {
    throw planInvalid('Agent-role pairwise requirement fields are invalid.');
  }
  return Object.freeze({ pair: value.pair, required: value.required });
}

function assertCanonicalLogicalIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw planInvalid('Agent-role logical identifiers must be one array.');
  }
  const identifiers = value.map((candidate) => {
    if (
      typeof candidate !== 'string' ||
      !SAFE_LOGICAL_ID.test(candidate) ||
      candidate.includes('..')
    ) {
      throw planInvalid('Agent-role logical identifier is unsafe.');
    }
    return candidate;
  });
  for (let index = 1; index < identifiers.length; index += 1) {
    if (
      compareCanonicalStrings(identifiers[index - 1]!, identifiers[index]!) >= 0
    ) {
      throw planInvalid(
        'Agent-role logical identifiers must be unique and canonically sorted.',
      );
    }
  }
  return Object.freeze(identifiers);
}

function assertCanonicalEnumOrder<T extends string>(
  values: readonly T[],
  canonicalOrder: readonly T[],
): void {
  let previous = -1;
  for (const value of values) {
    const current = canonicalOrder.indexOf(value);
    if (current <= previous) {
      throw planInvalid(
        'Agent-role entries must be unique and in canonical order.',
      );
    }
    previous = current;
  }
}

function digestBody(value: AgentRolePlanBodyV1): string {
  return crypto
    .createHash('sha256')
    .update('agent-role-plan-v1\0')
    .update(canonicalJson(value))
    .digest('hex');
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const required = [...expected].sort(compareCanonicalStrings);
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw planInvalid('Agent-role plan fields are not exact.');
  }
}

function isAgentRole(value: unknown): value is AgentRole {
  return ROLE_ORDER.some((role) => role === value);
}

function isAgentRolePair(value: unknown): value is AgentRolePair {
  return ROLE_PAIR_ORDER.some((pair) => pair === value);
}

function isScopeRule(value: unknown): value is AgentRoleScopeRule {
  return (
    value === 'planning-generation' || value === 'task' || value === 'candidate'
  );
}

function isRequirement(
  value: unknown,
): value is AgentRoleIndependenceRequirement {
  return (
    value === 'provider-independent' ||
    value === 'session-independent' ||
    value === 'none'
  );
}

function isCustomWrapperPolicy(
  value: unknown,
): value is AgentCustomWrapperPolicy {
  return (
    value === 'forbidden' ||
    value === 'allowed-non-protected' ||
    value === 'allowed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planInvalid(message: string): ReturnType<typeof workflowError> {
  return workflowError(
    'AGENT_ROLE_PLAN_INVALID',
    message,
    ExitCode.verification,
  );
}
