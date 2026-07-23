import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError, type WorkflowError } from './errors.ts';
import {
  isProviderId,
  requireProviderCapability,
  type CapabilityProfile,
  type CapabilityPurpose,
  type ProviderId,
} from './provider-registry.ts';
import type { OrdinaryRole, RoleAssignment } from './role-scheduler.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const REQUEST_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;

/**
 * The code-owned positive maxima for a single provider invocation. Repository
 * policy may lower these but never raise them, and a request may only bind
 * limits within these bounds.
 */
export const MAX_PROVIDER_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  aggregateOutputBytes: 1_048_576,
});

const ROLE_PURPOSE: Record<OrdinaryRole, CapabilityPurpose> = {
  'blind-surveyor': 'survey',
  'plan-reviewer': 'plan-review',
};

export type ProviderLimits = {
  timeoutMs: number;
  aggregateOutputBytes: number;
};

/**
 * A fully constructed, code-owned provider launch plan. Every field is derived
 * from fixed engine argv and canonical private runtime paths; no repository,
 * caller, prompt, or model value contributes an executable, flag, or shell
 * fragment. `shell` is always `false` and `stdinSource` is the canonical prompt
 * file the engine writes.
 */
export type ProviderInvocationPlan = {
  executable: string;
  shell: false;
  cwd: string;
  args: string[];
  stdinSource: string;
};

export type ProviderOutputSchema = {
  id: string;
  version: number;
  digest: string;
};

/**
 * A strict, deeply immutable, canonically digested provider invocation request.
 * It binds every identity, assignment, repository, tree, target, manifest,
 * schema, evaluator, policy, and limit field. Read-only requests always carry
 * an empty `writeAllowedPaths` array.
 */
export type ProviderInvocationRequest = {
  schemaVersion: 1;
  invocationId: string;
  nonce: string;
  purpose: CapabilityPurpose;
  providerId: ProviderId;
  roleAssignment: RoleAssignment;
  roleAssignmentDigest: string;
  capabilityProfile: CapabilityProfile;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  targetDigest: string;
  inputManifestDigest: string;
  authorizationNodeId: string;
  writeAllowedPaths: string[];
  outputSchema: ProviderOutputSchema;
  evaluatorVersion: string;
  policyDigest: string;
  limits: ProviderLimits;
  requestDigest: string;
};

export type ProviderInvocationRequestInput = {
  invocationId: string;
  nonce: string;
  purpose: CapabilityPurpose;
  providerId: ProviderId;
  roleAssignment: RoleAssignment;
  capabilityProfile: CapabilityProfile;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  targetDigest: string;
  inputManifestDigest: string;
  authorizationNodeId: string;
  writeAllowedPaths: string[];
  outputSchema: ProviderOutputSchema;
  evaluatorVersion: string;
  policyDigest: string;
  limits: ProviderLimits;
};

/**
 * The observable outcome of a bounded fake provider process. Real provider
 * launch is not part of this slice; the evaluator consumes this deterministic
 * description.
 */
export type ProviderProcessOutcome = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnErrorCode: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
};

export type ProviderOutputValidator = {
  id: string;
  version: number;
  digest: string;
  validate(value: unknown): boolean;
};

/**
 * The immutable successful result of a bounded provider process. It is only
 * produced when the process succeeded, the emitted result was fully bound to
 * the request, no repository mutation was observed, and the typed output passed
 * its schema validator.
 */
export type ProviderProcessResult = {
  requestDigest: string;
  invocationId: string;
  purpose: CapabilityPurpose;
  providerId: ProviderId;
  output: unknown;
  outputDigest: string;
};

const REQUEST_INPUT_KEYS = [
  'invocationId',
  'nonce',
  'purpose',
  'providerId',
  'roleAssignment',
  'capabilityProfile',
  'repositoryId',
  'baseCommit',
  'baseTree',
  'targetDigest',
  'inputManifestDigest',
  'authorizationNodeId',
  'writeAllowedPaths',
  'outputSchema',
  'evaluatorVersion',
  'policyDigest',
  'limits',
] as const;

const ROLE_ASSIGNMENT_KEYS = [
  'role',
  'providerId',
  'sessionId',
  'targetDigest',
  'requiredIndependence',
  'achievedIndependence',
] as const;

const OUTPUT_SCHEMA_KEYS = ['id', 'version', 'digest'] as const;
const LIMITS_KEYS = ['timeoutMs', 'aggregateOutputBytes'] as const;

const REQUEST_BINDING_KEYS = [
  'requestDigest',
  'invocationId',
  'nonce',
  'purpose',
  'providerId',
  'roleAssignmentDigest',
  'capabilityProfile',
  'repositoryId',
  'baseCommit',
  'baseTree',
  'targetDigest',
  'inputManifestDigest',
  'authorizationNodeId',
  'outputSchema',
  'evaluatorVersion',
  'policyDigest',
  'limits',
] as const;

const RESULT_KEYS = [
  'schemaVersion',
  ...REQUEST_BINDING_KEYS,
  'observedTouchedPaths',
  'output',
] as const;

export function createProviderInvocationRequest(
  input: ProviderInvocationRequestInput,
): ProviderInvocationRequest {
  // Reject unknown or missing input keys before any field is trusted.
  if (!isRecord(input) || !hasExactKeys(input, REQUEST_INPUT_KEYS)) {
    throw requestInvalid();
  }

  if (
    !isNonEmptyString(input.invocationId) ||
    !isNonce(input.nonce) ||
    !isPurpose(input.purpose) ||
    !isProviderId(input.providerId) ||
    input.capabilityProfile !== 'repository-read-only' ||
    !isNonEmptyString(input.repositoryId) ||
    !GIT_OBJECT_ID.test(input.baseCommit) ||
    !GIT_OBJECT_ID.test(input.baseTree) ||
    !HEX64.test(input.targetDigest) ||
    !HEX64.test(input.inputManifestDigest) ||
    !HEX64.test(input.authorizationNodeId) ||
    !HEX64.test(input.policyDigest) ||
    !isNonEmptyString(input.evaluatorVersion) ||
    !isOutputSchema(input.outputSchema) ||
    !isFullRoleAssignment(input.roleAssignment) ||
    !isWriteAllowedPaths(input.writeAllowedPaths) ||
    !isBoundedLimits(input.limits)
  ) {
    throw requestInvalid();
  }

  // Read-only requests must have no writable paths.
  if (input.writeAllowedPaths.length !== 0) {
    throw requestInvalid();
  }

  // The assignment must select the same provider, target, and role the request
  // binds. A blind-surveyor assignment maps only to `survey`; a plan-reviewer
  // assignment maps only to `plan-review`.
  if (
    input.providerId !== input.roleAssignment.providerId ||
    input.targetDigest !== input.roleAssignment.targetDigest ||
    ROLE_PURPOSE[input.roleAssignment.role] !== input.purpose
  ) {
    throw requestInvalid();
  }

  // The provider must be registered and declare the requested capability.
  try {
    requireProviderCapability(
      input.providerId,
      input.purpose,
      input.capabilityProfile,
    );
  } catch {
    throw requestInvalid();
  }

  const roleAssignment = deepFreeze(
    structuredClone(input.roleAssignment),
  ) as RoleAssignment;
  const outputSchema = deepFreeze(
    structuredClone(input.outputSchema),
  ) as ProviderOutputSchema;
  const limits = Object.freeze({
    timeoutMs: input.limits.timeoutMs,
    aggregateOutputBytes: input.limits.aggregateOutputBytes,
  }) as ProviderLimits;
  const roleAssignmentDigest = sha256(canonicalJson(roleAssignment));

  const binding = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    invocationId: input.invocationId,
    nonce: input.nonce,
    purpose: input.purpose,
    providerId: input.providerId,
    roleAssignmentDigest,
    capabilityProfile: input.capabilityProfile,
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    targetDigest: input.targetDigest,
    inputManifestDigest: input.inputManifestDigest,
    authorizationNodeId: input.authorizationNodeId,
    writeAllowedPaths: [] as string[],
    outputSchema,
    evaluatorVersion: input.evaluatorVersion,
    policyDigest: input.policyDigest,
    limits,
  };
  const requestDigest = sha256(canonicalJson(binding));

  const request: ProviderInvocationRequest = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    invocationId: input.invocationId,
    nonce: input.nonce,
    purpose: input.purpose,
    providerId: input.providerId,
    roleAssignment,
    roleAssignmentDigest,
    capabilityProfile: input.capabilityProfile,
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    targetDigest: input.targetDigest,
    inputManifestDigest: input.inputManifestDigest,
    authorizationNodeId: input.authorizationNodeId,
    writeAllowedPaths: [],
    outputSchema,
    evaluatorVersion: input.evaluatorVersion,
    policyDigest: input.policyDigest,
    limits,
    requestDigest,
  };
  return deepFreeze(request) as ProviderInvocationRequest;
}

/**
 * Evaluate a bounded provider process against its request. A process failure,
 * malformed or ambiguous result, unbound field, observed mutation, excess
 * output, or invalid output never produces successful evidence; each raises a
 * typed WorkflowError instead.
 */
export function evaluateProviderProcess(
  request: ProviderInvocationRequest,
  outcome: ProviderProcessOutcome,
  outputValidator: ProviderOutputValidator,
): ProviderProcessResult {
  // 1. Process-level failure — timeout (flag or elapsed), signal, spawn error,
  //    or non-zero exit — is never a success.
  if (
    outcome.timedOut ||
    outcome.elapsedMs > request.limits.timeoutMs ||
    outcome.signal !== null ||
    outcome.spawnErrorCode !== null ||
    outcome.exitCode !== 0
  ) {
    throw processFailed();
  }

  // 2. Exactly one JSON value on stdout.
  const parsed = parseSingleJson(outcome.stdout);
  if (parsed.ok === false) {
    throw resultInvalid();
  }
  const result = parsed.value;

  // 3. Exact result shape: every expected field present, no extra field, valid
  //    scalar/nested structure. This runs before drift/binding classification.
  if (
    !isRecord(result) ||
    !hasExactKeys(result, RESULT_KEYS) ||
    result.schemaVersion !== RESULT_SCHEMA_VERSION ||
    !isStringArray(result.observedTouchedPaths) ||
    !isOutputSchema(result.outputSchema) ||
    !isBoundedLimits(result.limits)
  ) {
    throw resultInvalid();
  }
  const observedTouchedPaths = result.observedTouchedPaths;

  // 4. Aggregate UTF-8 bytes across stdout + stderr + normalized semantic
  //    output.
  let normalizedOutput: string;
  try {
    normalizedOutput = canonicalJson(result.output);
  } catch {
    throw resultInvalid();
  }
  const aggregateBytes =
    Buffer.byteLength(outcome.stdout, 'utf8') +
    Buffer.byteLength(outcome.stderr, 'utf8') +
    Buffer.byteLength(normalizedOutput, 'utf8');
  if (aggregateBytes > request.limits.aggregateOutputBytes) {
    throw outputLimitExceeded();
  }

  // 5. Every request binding must match exactly.
  for (const key of REQUEST_BINDING_KEYS) {
    if (!bindingMatches(result[key], request[key])) {
      throw resultUnbound(key);
    }
  }

  // 6. Read-only results must observe no touched path.
  if (observedTouchedPaths.length !== 0) {
    throw readOnlyDrift();
  }

  // 7. The validator must be bound to the same output schema, and the typed
  //    output — canonically cloned and deeply frozen before the validator sees
  //    it — must satisfy it. A throwing validator is a rejection, not a crash.
  if (
    outputValidator.id !== request.outputSchema.id ||
    outputValidator.version !== request.outputSchema.version ||
    outputValidator.digest !== request.outputSchema.digest
  ) {
    throw outputInvalid();
  }
  const output = deepFreeze(structuredClone(result.output));
  let valid: boolean;
  try {
    valid = outputValidator.validate(output);
  } catch {
    throw outputInvalid();
  }
  // Only a literal `true` is acceptance; a truthy non-boolean is a rejection.
  if (valid !== true) {
    throw outputInvalid();
  }

  const outputDigest = sha256(
    canonicalJson({
      id: request.outputSchema.id,
      version: request.outputSchema.version,
      output,
    }),
  );

  return Object.freeze({
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    purpose: request.purpose,
    providerId: request.providerId,
    output,
    outputDigest,
  });
}

function bindingMatches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'object' && expected !== null) {
    let actualCanonical: string;
    let expectedCanonical: string;
    try {
      actualCanonical = canonicalJson(actual);
      expectedCanonical = canonicalJson(expected);
    } catch {
      return false;
    }
    return actualCanonical === expectedCanonical;
  }
  return actual === expected;
}

function parseSingleJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    // JSON.parse rejects trailing non-whitespace, so a second concatenated
    // value or truncated object fails here.
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16;
}

function isPurpose(value: unknown): value is CapabilityPurpose {
  return value === 'survey' || value === 'plan-review';
}

function isOutputSchema(value: unknown): value is ProviderOutputSchema {
  return (
    isRecord(value) &&
    hasExactKeys(value, OUTPUT_SCHEMA_KEYS) &&
    isNonEmptyString(value.id) &&
    isPositiveInteger(value.version) &&
    typeof value.digest === 'string' &&
    HEX64.test(value.digest)
  );
}

function isFullRoleAssignment(value: unknown): value is RoleAssignment {
  // An ordinary role assignment used by an invocation request is valid only
  // when both independence fields are provider-independent; a forged assignment
  // that weakens either field is rejected.
  return (
    isRecord(value) &&
    hasExactKeys(value, ROLE_ASSIGNMENT_KEYS) &&
    (value.role === 'blind-surveyor' || value.role === 'plan-reviewer') &&
    isProviderId(value.providerId) &&
    isNonEmptyString(value.sessionId) &&
    typeof value.targetDigest === 'string' &&
    HEX64.test(value.targetDigest) &&
    value.requiredIndependence === 'provider-independent' &&
    value.achievedIndependence === 'provider-independent'
  );
}

function isWriteAllowedPaths(value: unknown): value is string[] {
  return isStringArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isBoundedLimits(value: unknown): value is ProviderLimits {
  return (
    isRecord(value) &&
    hasExactKeys(value, LIMITS_KEYS) &&
    isPositiveInteger(value.timeoutMs) &&
    value.timeoutMs <= MAX_PROVIDER_LIMITS.timeoutMs &&
    isPositiveInteger(value.aggregateOutputBytes) &&
    value.aggregateOutputBytes <= MAX_PROVIDER_LIMITS.aggregateOutputBytes
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
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

function requestInvalid(): WorkflowError {
  return workflowError(
    'PROVIDER_REQUEST_INVALID',
    'Provider invocation request is malformed or exceeds bounded limits.',
    ExitCode.usage,
  );
}

function resultInvalid(): WorkflowError {
  return workflowError(
    'PROVIDER_RESULT_INVALID',
    'Provider result is malformed, ambiguous, or has an unexpected shape.',
    ExitCode.verification,
  );
}

function resultUnbound(field: string): WorkflowError {
  return workflowError(
    'PROVIDER_RESULT_UNBOUND',
    `Provider result field "${field}" is not bound to the invocation request.`,
    ExitCode.verification,
  );
}

function processFailed(): WorkflowError {
  return workflowError(
    'PROVIDER_PROCESS_FAILED',
    'Provider process timed out, was signaled, failed to spawn, or exited non-zero.',
    ExitCode.verification,
  );
}

function outputLimitExceeded(): WorkflowError {
  return workflowError(
    'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    'Provider aggregate output exceeded the bounded byte limit.',
    ExitCode.verification,
  );
}

function readOnlyDrift(): WorkflowError {
  return workflowError(
    'PROVIDER_READ_ONLY_DRIFT',
    'Read-only provider result observed a repository mutation.',
    ExitCode.verification,
  );
}

function outputInvalid(): WorkflowError {
  return workflowError(
    'PROVIDER_OUTPUT_INVALID',
    'Provider output failed its bound output schema validation.',
    ExitCode.verification,
  );
}
