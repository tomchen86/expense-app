import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { assertPlanTarget, type PlanTarget } from './plan-target.ts';

const GENERATION_SCHEMA = 'planning-generation.v1';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const POLICY_KEYS = [
  'planningPolicyDigest',
  'canonicalizerPolicyDigest',
  'rendererPolicyDigest',
  'reviewPolicyDigest',
] as const;

export type InvestigationBaseline = {
  head: string;
  tree: string;
};

export type PlanningInvestigationDependency = {
  role: string;
  nodeId: string;
  resultDigest: string;
};

export type PlanningPolicyDigests = {
  planningPolicyDigest: string;
  canonicalizerPolicyDigest: string;
  rendererPolicyDigest: string;
  reviewPolicyDigest: string;
};

export type PlanningGenerationInput = {
  schemaVersion: 1;
  target: PlanTarget;
  investigationBaseline: InvestigationBaseline;
  investigationDependencies: PlanningInvestigationDependency[];
  policies: PlanningPolicyDigests;
};

export type PlanningGeneration = {
  schemaVersion: 1;
  planningGenerationId: string;
  targetDigest: string;
  investigationBaseline: InvestigationBaseline;
  investigationDependencies: PlanningInvestigationDependency[];
  policies: PlanningPolicyDigests;
};

/**
 * Assign an immutable planning generation to a reviewed planning set. The
 * identity binds the exact plan target digest, investigation baseline commit and
 * tree, canonically ordered investigation result dependencies, and the applicable
 * planning/canonicalizer/renderer/review policy digests. Dependency input order
 * is irrelevant, every dependency is snapshotted so later caller mutation cannot
 * alter it, and the result is deeply frozen.
 */
export function createPlanningGeneration(
  input: PlanningGenerationInput,
): PlanningGeneration {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'schemaVersion',
      'target',
      'investigationBaseline',
      'investigationDependencies',
      'policies',
    ])
  ) {
    throw generationInvalid('Planning generation input shape is malformed.');
  }
  if (input.schemaVersion !== 1) {
    throw generationInvalid('Planning generation schema version must be 1.');
  }

  let target: PlanTarget;
  try {
    target = assertPlanTarget(input.target);
  } catch {
    throw generationInvalid(
      'Planning generation target is not a valid canonical plan target.',
    );
  }
  const targetDigest = target.targetDigest;
  const baseline = assertBaseline(input.investigationBaseline);
  const dependencies = normalizeDependencies(input.investigationDependencies);
  const policies = assertPolicies(input.policies);

  const planningGenerationId = planningGenerationDigest({
    schemaVersion: input.schemaVersion,
    targetDigest,
    investigationBaseline: baseline,
    investigationDependencies: dependencies,
    policies,
  });

  return assertPlanningGeneration({
    schemaVersion: 1,
    planningGenerationId,
    targetDigest,
    investigationBaseline: baseline,
    investigationDependencies: dependencies,
    policies,
  });
}

/**
 * Validate and detach a serialized planning generation. Replay must recompute
 * the generation ID from the exact target digest, baseline, canonical
 * dependency order, and policy set instead of accepting a caller's digest
 * claim.
 */
export function assertPlanningGeneration(value: unknown): PlanningGeneration {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'planningGenerationId',
      'targetDigest',
      'investigationBaseline',
      'investigationDependencies',
      'policies',
    ])
  ) {
    throw generationInvalid('Serialized planning generation is malformed.');
  }
  if (
    value.schemaVersion !== 1 ||
    !isDigest(value.planningGenerationId) ||
    !isDigest(value.targetDigest)
  ) {
    throw generationInvalid(
      'Serialized planning generation identity is malformed.',
    );
  }
  const baseline = assertBaseline(value.investigationBaseline);
  const dependencies = assertCanonicalDependencies(
    value.investigationDependencies,
  );
  const policies = assertPolicies(value.policies);
  const generation: PlanningGeneration = {
    schemaVersion: 1,
    planningGenerationId: value.planningGenerationId,
    targetDigest: value.targetDigest,
    investigationBaseline: baseline,
    investigationDependencies: dependencies,
    policies,
  };
  if (
    planningGenerationDigest(generation) !== generation.planningGenerationId
  ) {
    throw generationInvalid(
      'Serialized planning generation ID does not match its content.',
    );
  }
  return deepFreeze(generation);
}

function assertBaseline(value: unknown): InvestigationBaseline {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['head', 'tree'])) {
    throw generationInvalid('Investigation baseline shape is malformed.');
  }
  const head = value.head;
  const tree = value.tree;
  if (
    typeof head !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(head) ||
    typeof tree !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(tree)
  ) {
    throw generationInvalid('Investigation baseline object IDs are malformed.');
  }
  return { head, tree };
}

function normalizeDependencies(
  value: unknown,
): PlanningInvestigationDependency[] {
  const dependencies = parseDependencies(value);
  return dependencies.sort(compareDependencies);
}

function assertCanonicalDependencies(
  value: unknown,
): PlanningInvestigationDependency[] {
  const dependencies = parseDependencies(value);
  for (let index = 1; index < dependencies.length; index += 1) {
    if (
      compareDependencies(dependencies[index - 1]!, dependencies[index]!) >= 0
    ) {
      throw generationInvalid(
        'Investigation dependencies are not canonically ordered.',
      );
    }
  }
  return dependencies;
}

function parseDependencies(value: unknown): PlanningInvestigationDependency[] {
  if (!isDenseArray(value) || value.length === 0) {
    throw generationInvalid('Investigation dependencies must be an array.');
  }
  const dependencies = value.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ['role', 'nodeId', 'resultDigest'])
    ) {
      throw generationInvalid('Investigation dependency shape is malformed.');
    }
    const role = entry.role;
    const nodeId = entry.nodeId;
    const resultDigest = entry.resultDigest;
    if (
      typeof role !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role) ||
      typeof nodeId !== 'string' ||
      !DIGEST_PATTERN.test(nodeId) ||
      typeof resultDigest !== 'string' ||
      !DIGEST_PATTERN.test(resultDigest)
    ) {
      throw generationInvalid(
        'Investigation dependency identity is malformed.',
      );
    }
    return { role, nodeId, resultDigest };
  });

  const seen = new Set<string>();
  for (const dependency of dependencies) {
    const key = `${dependency.role}\0${dependency.nodeId}`;
    if (seen.has(key)) {
      throw generationInvalid(
        'Investigation dependencies contain a duplicate.',
      );
    }
    seen.add(key);
  }

  return dependencies;
}

function compareDependencies(
  left: PlanningInvestigationDependency,
  right: PlanningInvestigationDependency,
): number {
  return compareUtf8(
    canonicalJson([left.role, left.nodeId, left.resultDigest]),
    canonicalJson([right.role, right.nodeId, right.resultDigest]),
  );
}

function assertPolicies(value: unknown): PlanningPolicyDigests {
  if (!isPlainRecord(value) || !hasExactKeys(value, POLICY_KEYS)) {
    throw generationInvalid('Planning generation policies are malformed.');
  }
  for (const key of POLICY_KEYS) {
    const digest = value[key];
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      throw generationInvalid(`Planning policy digest ${key} is malformed.`);
    }
  }
  return {
    planningPolicyDigest: value.planningPolicyDigest as string,
    canonicalizerPolicyDigest: value.canonicalizerPolicyDigest as string,
    rendererPolicyDigest: value.rendererPolicyDigest as string,
    reviewPolicyDigest: value.reviewPolicyDigest as string,
  };
}

function planningGenerationDigest(
  value: Pick<
    PlanningGeneration,
    | 'schemaVersion'
    | 'targetDigest'
    | 'investigationBaseline'
    | 'investigationDependencies'
    | 'policies'
  >,
): string {
  return sha256(
    canonicalJson({
      schema: GENERATION_SCHEMA,
      schemaVersion: value.schemaVersion,
      targetDigest: value.targetDigest,
      investigationBaseline: value.investigationBaseline,
      investigationDependencies: value.investigationDependencies,
      policies: value.policies,
    }),
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return false;
    }
  }
  return true;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string') &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor && descriptor.enumerable && 'value' in descriptor,
      );
    })
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generationInvalid(message: string) {
  return workflowError('PLANNING_GENERATION_INVALID', message, ExitCode.usage);
}
