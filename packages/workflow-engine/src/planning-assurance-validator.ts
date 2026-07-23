import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';

/**
 * One deterministic, content-pure planning-assurance interface over a canonical
 * subject, policy, and immutable evidence artifacts. The evaluator receives a
 * deep-frozen canonical snapshot in which object insertion order is normalized
 * and every artifact's runtime-only metadata is erased to `{}`, so live and CI
 * loaders that construct the same content observe byte/digest-identical results.
 * The evaluator's result is detached, canonicalized, and frozen before it is
 * digested or returned. Both identities are bound to the validator version and
 * observe no timestamps, process state, provider calls, filesystem, or Git.
 */
export type PlanningAssuranceInput = {
  subject: unknown;
  policy: unknown;
  artifacts: Record<string, EvidenceNode>;
};

export type PlanningAssuranceValidator = {
  version: string;
  evaluate(input: PlanningAssuranceInput): unknown;
};

export type PlanningAssuranceResult = {
  result: unknown;
  inputDigest: string;
  resultDigest: string;
  validatorVersion: string;
};

export function evaluatePlanningAssurance(
  input: PlanningAssuranceInput,
  validator: PlanningAssuranceValidator,
): PlanningAssuranceResult {
  // Read identity exactly once before evaluator code runs. A mutable validator
  // object or accessor must not split input, result, and reported identities.
  const validatorVersion = validator.version;
  if (typeof validatorVersion !== 'string' || validatorVersion.length === 0) {
    throw planningValidatorInvalid();
  }

  // Re-validate every consumed envelope with the recomputation contract, then
  // erase runtime-only metadata so it never influences semantics or the digest.
  const artifacts: Record<string, unknown> = {};
  for (const key of Object.keys(input.artifacts)) {
    const node = assertStoredEvidenceNode(
      input.artifacts[key],
      planningInvalid,
    );
    artifacts[key] = { ...node, runtimeMetadata: {} };
  }

  const evaluatorInput = deepFreeze(
    canonicalClone({
      subject: input.subject,
      policy: input.policy,
      artifacts,
    }),
  ) as PlanningAssuranceInput;

  const inputDigest = sha256(
    canonicalJson({
      validatorVersion,
      input: evaluatorInput,
    }),
  );

  const result = deepFreeze(canonicalClone(validator.evaluate(evaluatorInput)));
  const resultDigest = sha256(canonicalJson({ validatorVersion, result }));

  return {
    result,
    inputDigest,
    resultDigest,
    validatorVersion,
  };
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function planningInvalid() {
  return workflowError(
    'PLANNING_ASSURANCE_ARTIFACT_INVALID',
    'Planning assurance artifact is not a valid evidence node.',
    ExitCode.usage,
  );
}

function planningValidatorInvalid() {
  return workflowError(
    'PLANNING_ASSURANCE_VALIDATOR_INVALID',
    'Planning assurance validator identity is malformed.',
    ExitCode.usage,
  );
}
