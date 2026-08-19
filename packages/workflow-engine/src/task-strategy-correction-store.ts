import crypto from 'node:crypto';
import path from 'node:path';

import { DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING } from './ai-adapter-policy.ts';
import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import {
  parseObservedCheckFailure,
  type CheckEvidence,
  type ObservedCheckFailure,
} from './check-runner.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
} from './investigation-session-store.ts';
import { assertSessionId, type InvestigationRuntimePaths } from './paths.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type TaskStrategyCorrectionPolicy = Readonly<{
  maxRepairAttempts: number;
  maxSameFailureFingerprint: number;
}>;

export const DEFAULT_TASK_STRATEGY_CORRECTION_POLICY: TaskStrategyCorrectionPolicy =
  Object.freeze({
    maxRepairAttempts: DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxRepairAttempts,
    maxSameFailureFingerprint:
      DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxSameFailureFingerprint,
  });

export type TaskStrategyGreenCheckDefinition = Readonly<{
  checkId: string;
  definition: Readonly<{
    command: readonly string[];
    destructiveDatabase: boolean;
  }>;
  runner: string;
  runnerDigest: string;
}>;

export type TaskStrategyPatchHead = Readonly<{
  bindingDigest: string;
  recordDigest: string;
  patchDigest: string;
  receiptDigest: string;
}>;

export type TaskStrategyGreenFailureRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-green-failure-record.v1';
  recordDigest: string;
  subjectDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  currentPatchHead: TaskStrategyPatchHead;
  candidateTree: string;
  checkDefinitions: readonly TaskStrategyGreenCheckDefinition[];
  passedChecks: readonly CheckEvidence[];
  failingCheck: ObservedCheckFailure;
  createdAt: string;
}>;

export type TaskStrategyGreenFailureInput = Omit<
  TaskStrategyGreenFailureRecord,
  'schemaVersion' | 'kind' | 'recordDigest' | 'subjectDigest'
>;

export function parseTaskStrategyCorrectionPolicy(
  value: unknown,
): TaskStrategyCorrectionPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['maxRepairAttempts', 'maxSameFailureFingerprint']) ||
    !isBoundedPositiveInteger(
      value.maxRepairAttempts,
      DEFAULT_TASK_STRATEGY_CORRECTION_POLICY.maxRepairAttempts,
    ) ||
    !isBoundedPositiveInteger(
      value.maxSameFailureFingerprint,
      DEFAULT_TASK_STRATEGY_CORRECTION_POLICY.maxSameFailureFingerprint,
    )
  ) {
    throw workflowError(
      'TASK_STRATEGY_CORRECTION_POLICY_INVALID',
      'Task-strategy correction policy is invalid or exceeds code-owned bounds.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    maxRepairAttempts: value.maxRepairAttempts as number,
    maxSameFailureFingerprint: value.maxSameFailureFingerprint as number,
  });
}

export function prepareTaskStrategyGreenFailureRecord(
  input: TaskStrategyGreenFailureInput,
): TaskStrategyGreenFailureRecord {
  const subject = {
    sessionId: input.sessionId,
    currentRedTransactionDigest: input.currentRedTransactionDigest,
    currentPatchHead: input.currentPatchHead,
    candidateTree: input.candidateTree,
    checkDefinitions: input.checkDefinitions,
    passedChecks: input.passedChecks,
    failingCheck: input.failingCheck,
  };
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-green-failure-record.v1' as const,
    subjectDigest: sha256(canonicalJson(subject)),
    ...subject,
    createdAt: input.createdAt,
  };
  return parseTaskStrategyGreenFailureRecord({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
}

export function createTaskStrategyGreenFailureRecord(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyGreenFailureInput,
): TaskStrategyGreenFailureRecord {
  const prepared = prepareTaskStrategyGreenFailureRecord(input);
  return withPrivateRuntimeLock(
    paths,
    greenFailureLockPath(paths, prepared.sessionId, prepared.candidateTree),
    () => {
      const existing = readTaskStrategyGreenFailureRecord(
        paths,
        prepared.sessionId,
        prepared.candidateTree,
      );
      if (existing !== null) {
        if (
          existing.subjectDigest === prepared.subjectDigest &&
          existing.failingCheck.failureFingerprint ===
            prepared.failingCheck.failureFingerprint
        ) {
          return existing;
        }
        throw greenFailureConflict();
      }
      createPrivateCanonicalJson(
        paths,
        greenFailurePath(paths, prepared.sessionId, prepared.candidateTree),
        prepared,
        greenFailureStateInvalid,
        'TASK_STRATEGY_GREEN_FAILURE_CONFLICT',
      );
      const stored = readTaskStrategyGreenFailureRecord(
        paths,
        prepared.sessionId,
        prepared.candidateTree,
      );
      if (stored === null || stored.recordDigest !== prepared.recordDigest) {
        throw greenFailureStateInvalid();
      }
      return stored;
    },
    'TASK_STRATEGY_GREEN_FAILURE_BUSY',
    greenFailureStateInvalid,
  );
}

export function readTaskStrategyGreenFailureRecord(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedCandidateTree: string,
): TaskStrategyGreenFailureRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const candidateTree = assertGitObjectId(requestedCandidateTree);
  const target = greenFailurePath(paths, sessionId, candidateTree);
  if (!privatePathExists(paths, target, greenFailureStateInvalid)) return null;
  const record = parseTaskStrategyGreenFailureRecord(
    readPrivateCanonicalJson(paths, target, greenFailureStateInvalid),
  );
  if (
    record.sessionId !== sessionId ||
    record.candidateTree !== candidateTree
  ) {
    throw greenFailureStateInvalid();
  }
  return record;
}

export function parseTaskStrategyGreenFailureRecord(
  value: unknown,
): TaskStrategyGreenFailureRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'subjectDigest',
      'sessionId',
      'currentRedTransactionDigest',
      'currentPatchHead',
      'candidateTree',
      'checkDefinitions',
      'passedChecks',
      'failingCheck',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-green-failure-record.v1' ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.subjectDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isDigest(value.currentRedTransactionDigest) ||
    !isPatchHead(value.currentPatchHead) ||
    !isGitObjectId(value.candidateTree) ||
    !Array.isArray(value.checkDefinitions) ||
    value.checkDefinitions.length === 0 ||
    value.checkDefinitions.length > 512 ||
    !Array.isArray(value.passedChecks) ||
    value.passedChecks.length > 512 ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw greenFailureStateInvalid();
  }

  const checkDefinitions = value.checkDefinitions.map(parseCheckDefinition);
  const definitionIds = checkDefinitions.map(({ checkId }) => checkId);
  if (new Set(definitionIds).size !== definitionIds.length) {
    throw greenFailureStateInvalid();
  }
  const passedChecks = value.passedChecks.map(parsePassedCheck);
  const passedIds = passedChecks.map(({ checkId }) => checkId);
  if (new Set(passedIds).size !== passedIds.length) {
    throw greenFailureStateInvalid();
  }
  let failingCheck: ObservedCheckFailure;
  try {
    failingCheck = parseObservedCheckFailure(value.failingCheck);
  } catch {
    throw greenFailureStateInvalid();
  }
  if (
    passedIds.includes(failingCheck.checkId) ||
    canonicalJson([...passedIds, failingCheck.checkId]) !==
      canonicalJson(definitionIds.slice(0, passedIds.length + 1)) ||
    passedChecks.some(
      (evidence) => !evidenceMatchesDefinition(evidence, checkDefinitions),
    ) ||
    !evidenceMatchesDefinition(failingCheck, checkDefinitions)
  ) {
    throw greenFailureStateInvalid();
  }

  const subject = {
    sessionId: value.sessionId,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    currentPatchHead: value.currentPatchHead,
    candidateTree: value.candidateTree,
    checkDefinitions,
    passedChecks,
    failingCheck,
  };
  if (value.subjectDigest !== sha256(canonicalJson(subject))) {
    throw greenFailureStateInvalid();
  }
  const body = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    subjectDigest: value.subjectDigest,
    ...subject,
    createdAt: value.createdAt,
  };
  if (value.recordDigest !== sha256(canonicalJson(body))) {
    throw greenFailureStateInvalid();
  }
  return Object.freeze({
    ...body,
    recordDigest: value.recordDigest,
  }) as TaskStrategyGreenFailureRecord;
}

function parseCheckDefinition(
  value: unknown,
): TaskStrategyGreenCheckDefinition {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['checkId', 'definition', 'runner', 'runnerDigest']) ||
    typeof value.checkId !== 'string' ||
    !CHECK_ID.test(value.checkId) ||
    !isCheckDefinition(value.definition) ||
    typeof value.runner !== 'string' ||
    value.runner.trim() !== value.runner ||
    Buffer.byteLength(value.runner, 'utf8') < 1 ||
    Buffer.byteLength(value.runner, 'utf8') > 1024 ||
    !isDigest(value.runnerDigest)
  ) {
    throw greenFailureStateInvalid();
  }
  return Object.freeze({
    checkId: value.checkId,
    definition: Object.freeze({
      command: Object.freeze([...value.definition.command]),
      destructiveDatabase: value.definition.destructiveDatabase,
    }),
    runner: value.runner,
    runnerDigest: value.runnerDigest,
  });
}

function parsePassedCheck(value: unknown): CheckEvidence {
  if (!isRecord(value)) throw greenFailureStateInvalid();
  const optionalKeys = [
    ...(Object.hasOwn(value, 'databaseIdentity') ? ['databaseIdentity'] : []),
    ...(Object.hasOwn(value, 'completedAt') ? ['completedAt'] : []),
    ...(Object.hasOwn(value, 'externalSnapshotDigest')
      ? ['externalSnapshotDigest']
      : []),
    ...(Object.hasOwn(value, 'maxAgeMs') ? ['maxAgeMs'] : []),
  ];
  if (
    !hasExactKeys(value, [
      'checkId',
      'outcome',
      'exitCode',
      'runner',
      'runnerDigest',
      'destructiveDatabase',
      ...optionalKeys,
    ]) ||
    typeof value.checkId !== 'string' ||
    !CHECK_ID.test(value.checkId) ||
    value.outcome !== 'passed' ||
    value.exitCode !== 0 ||
    typeof value.runner !== 'string' ||
    value.runner.trim() !== value.runner ||
    Buffer.byteLength(value.runner, 'utf8') < 1 ||
    Buffer.byteLength(value.runner, 'utf8') > 1024 ||
    !isDigest(value.runnerDigest) ||
    typeof value.destructiveDatabase !== 'boolean' ||
    (value.databaseIdentity !== undefined &&
      (typeof value.databaseIdentity !== 'string' ||
        value.databaseIdentity.length === 0)) ||
    (value.completedAt !== undefined &&
      !isCanonicalTimestamp(value.completedAt)) ||
    (value.externalSnapshotDigest !== undefined &&
      !isDigest(value.externalSnapshotDigest)) ||
    (value.maxAgeMs !== undefined &&
      (!Number.isSafeInteger(value.maxAgeMs) ||
        (value.maxAgeMs as number) < 1)) ||
    (value.externalSnapshotDigest === undefined) !==
      (value.maxAgeMs === undefined)
  ) {
    throw greenFailureStateInvalid();
  }
  return Object.freeze({ ...value }) as CheckEvidence;
}

function evidenceMatchesDefinition(
  evidence: Pick<CheckEvidence, 'checkId' | 'runner' | 'runnerDigest'> &
    Partial<Pick<CheckEvidence, 'destructiveDatabase'>>,
  definitions: readonly TaskStrategyGreenCheckDefinition[],
): boolean {
  const definition = definitions.find(
    ({ checkId }) => checkId === evidence.checkId,
  );
  return (
    definition !== undefined &&
    definition.runner === evidence.runner &&
    definition.runnerDigest === evidence.runnerDigest &&
    (evidence.destructiveDatabase === undefined ||
      definition.definition.destructiveDatabase ===
        evidence.destructiveDatabase)
  );
}

function isCheckDefinition(
  value: unknown,
): value is TaskStrategyGreenCheckDefinition['definition'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['command', 'destructiveDatabase']) &&
    Array.isArray(value.command) &&
    value.command.length > 0 &&
    value.command.length <= 256 &&
    value.command.every(
      (entry) =>
        typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') <= 8192,
    ) &&
    typeof value.destructiveDatabase === 'boolean'
  );
}

function isPatchHead(value: unknown): value is TaskStrategyPatchHead {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'bindingDigest',
      'recordDigest',
      'patchDigest',
      'receiptDigest',
    ]) &&
    isDigest(value.bindingDigest) &&
    isDigest(value.recordDigest) &&
    isDigest(value.patchDigest) &&
    isDigest(value.receiptDigest)
  );
}

function greenFailurePath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  candidateTree: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-green-failures',
    sessionId,
    `${candidateTree}.json`,
  );
}

function greenFailureLockPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  candidateTree: string,
): string {
  return path.join(
    paths.locks,
    'task-strategy-green-failures',
    `${sessionId}-${candidateTree}.lock`,
  );
}

function greenFailureConflict() {
  return workflowError(
    'TASK_STRATEGY_GREEN_FAILURE_CONFLICT',
    'A different GREEN failure is already bound to this candidate tree.',
    ExitCode.conflict,
  );
}

function greenFailureStateInvalid() {
  return workflowError(
    'TASK_STRATEGY_GREEN_FAILURE_STATE_INVALID',
    'Task-strategy GREEN failure state is invalid or unsafe.',
    ExitCode.staleState,
  );
}

function assertGitObjectId(value: string): string {
  if (!GIT_OBJECT_ID.test(value)) throw greenFailureStateInvalid();
  return value;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
