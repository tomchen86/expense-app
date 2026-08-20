import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';

/**
 * Partial mechanical extraction from workflow-engine execution-core.
 *
 * This module owns only the exact landed Job/Attempt state vocabulary and the
 * exact AttemptResult acceptance-binding codec. Aggregate transition adoption
 * is NOT implemented here: workflow-engine execution-store remains the unique
 * Job/Attempt aggregate and transition authority. A future move must delete
 * that old implementation in the same slice; it must never dual-run a second
 * reducer beside execution-store.
 */
export const JOB_ATTEMPT_RUNTIME_CONTRACT_VERSION =
  'jigwright.job-attempt-runtime.v1' as const;

export const JOB_STATUSES_V2 = [
  'queued',
  'running',
  'waiting-retry',
  'waiting-grant',
  'waiting-human-input',
  'succeeded',
  'failed-terminal',
  'stale',
  'cancelled',
] as const;

export const ATTEMPT_STATUSES_V2 = [
  'created',
  'leased',
  'running',
  'succeeded',
  'failed-retryable',
  'failed-terminal',
  'timed-out',
  'stale',
  'late-duplicate',
  'cancelled',
] as const;

export const ATTEMPT_ACCEPTANCES_V1 = [
  'accepted',
  'stale',
  'late-duplicate',
] as const;

export type JobStatusV2 = (typeof JOB_STATUSES_V2)[number];
export type AttemptStatusV2 = (typeof ATTEMPT_STATUSES_V2)[number];
export type AttemptAcceptanceV1 = (typeof ATTEMPT_ACCEPTANCES_V1)[number];

export type AttemptResultIdentityV1 = Readonly<{
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  attemptId: string;
  outputDigest: string;
  acceptance: AttemptAcceptanceV1;
  completedAt: string;
}>;

export type AttemptAcceptanceBindingV1 = Readonly<{
  schemaVersion: 1;
  resultId: string;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  attemptId: string;
  outputDigest: string;
  acceptance: AttemptAcceptanceV1;
  completedAt: string;
}>;

export class AttemptResultCodecError extends TypeError {
  readonly code = 'ATTEMPT_RESULT_INVALID';

  constructor() {
    super('Attempt result is invalid.');
    this.name = 'AttemptResultCodecError';
  }
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ACCEPTANCE_SET = new Set<AttemptAcceptanceV1>(ATTEMPT_ACCEPTANCES_V1);

export function assertAttemptAcceptanceBindingV1(
  value: unknown,
): AttemptAcceptanceBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'acceptance',
      'attemptId',
      'completedAt',
      'contextDigest',
      'epoch',
      'jobId',
      'outputDigest',
      'resultId',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    !isDigest(value.resultId) ||
    !isIdentifier(value.workflowId) ||
    !isPositiveInteger(value.epoch) ||
    !isDigest(value.contextDigest) ||
    !isIdentifier(value.jobId) ||
    !isIdentifier(value.attemptId) ||
    !isDigest(value.outputDigest) ||
    !ACCEPTANCE_SET.has(value.acceptance as AttemptAcceptanceV1) ||
    !isExactTimestamp(value.completedAt)
  ) {
    throw new AttemptResultCodecError();
  }
  const identity: AttemptResultIdentityV1 = {
    workflowId: value.workflowId,
    epoch: value.epoch,
    contextDigest: value.contextDigest,
    jobId: value.jobId,
    attemptId: value.attemptId,
    outputDigest: value.outputDigest,
    acceptance: value.acceptance as AttemptAcceptanceV1,
    completedAt: value.completedAt,
  };
  if (value.resultId !== attemptResultDigestV1(identity)) {
    throw new AttemptResultCodecError();
  }
  return deepFreeze(structuredClone(value) as AttemptAcceptanceBindingV1);
}

export function createAttemptAcceptanceBindingV1(
  input: AttemptResultIdentityV1,
): AttemptAcceptanceBindingV1 {
  const identity = assertAttemptResultIdentity(input);
  return assertAttemptAcceptanceBindingV1({
    schemaVersion: 1,
    resultId: attemptResultDigestV1(identity),
    ...identity,
  });
}

export function attemptResultDigestV1(input: AttemptResultIdentityV1): string {
  const identity = assertAttemptResultIdentity(input);
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(identity))
    .digest('hex')}`;
}

function assertAttemptResultIdentity(value: unknown): AttemptResultIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'acceptance',
      'attemptId',
      'completedAt',
      'contextDigest',
      'epoch',
      'jobId',
      'outputDigest',
      'workflowId',
    ]) ||
    !isIdentifier(value.workflowId) ||
    !isPositiveInteger(value.epoch) ||
    !isDigest(value.contextDigest) ||
    !isIdentifier(value.jobId) ||
    !isIdentifier(value.attemptId) ||
    !isDigest(value.outputDigest) ||
    !ACCEPTANCE_SET.has(value.acceptance as AttemptAcceptanceV1) ||
    !isExactTimestamp(value.completedAt)
  ) {
    throw new AttemptResultCodecError();
  }
  return deepFreeze(structuredClone(value) as AttemptResultIdentityV1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    IDENTIFIER.test(value) &&
    value === value.normalize('NFC')
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isExactTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
