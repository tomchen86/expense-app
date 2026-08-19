import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { BehaviorContractRef } from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertSessionId,
  normalizeChangedPath,
  normalizePolicyPath,
} from '../../runtime/session-workspace/paths.ts';
import type { ProviderOutputValidator } from './provider-contracts.ts';
import {
  parseTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
  type TaskStrategyPatchHead,
} from '../../runtime/storage-journal/task-strategy-correction-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const REPOSITORY_ID = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export const TASK_STRATEGY_IMPLEMENTATION_POLICY = deepFreeze({
  schemaVersion: 1,
  kind: 'task-strategy-implementation-policy.v1',
  capabilityProfile: 'repository-read-only',
  crossAgentIndependence: 'provider-independent',
  frozenTestsImmutable: true,
  engineGreenRequired: true,
  providerOutputAuthority: 'advisory-patch-only',
});
export const TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST = sha256(
  canonicalJson(TASK_STRATEGY_IMPLEMENTATION_POLICY),
);

export type TaskStrategyImplementationFrozenFile = Readonly<{
  path: string;
  mode: '100644' | '100755';
  objectId: string;
}>;

export type TaskStrategyImplementationCorrection = Readonly<{
  round: number;
  greenFailureRecordDigest: string;
  greenFailureSubjectDigest: string;
  candidateTree: string;
  failingCheckFingerprint: string;
  currentPatchHead: TaskStrategyPatchHead;
}>;

export type TaskStrategyImplementationSubject = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-subject.v1';
  subjectDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  transactionDigest: string;
  taskContractDigest: string;
  sourceTree: string;
  failureFingerprint: string;
  redEvidenceNodeId: string;
  redEvidenceResultDigest: string;
  testPaths: readonly string[];
  fixturePaths: readonly string[];
  frozenFiles: readonly TaskStrategyImplementationFrozenFile[];
  correction?: TaskStrategyImplementationCorrection;
}>;

export type TaskStrategyImplementationManifest = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-manifest';
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskStrategyImplementationSubject;
  behaviorContractRefs: readonly BehaviorContractRef[];
  implementationPathScopes: readonly string[];
  capabilityProfile: 'repository-read-only';
  greenFailureRecord?: TaskStrategyGreenFailureRecord;
}>;

export type TaskStrategyImplementationOutput = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-output.v1';
  sessionId: string;
  sourceTree: string;
  patchBase64: string;
  patchDigest: string;
}>;

export const TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA =
  Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'kind',
      'sessionId',
      'sourceTree',
      'patchBase64',
      'patchDigest',
    ],
    properties: {
      schemaVersion: { const: 1 },
      kind: { const: 'task-strategy-patch-output.v1' },
      sessionId: { type: 'string', minLength: 1 },
      sourceTree: {
        type: 'string',
        pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
      },
      patchBase64: {
        type: 'string',
        minLength: 1,
        maxLength: Math.ceil(MAX_PATCH_BYTES / 3) * 4,
      },
      patchDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    },
  });

export const TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA = Object.freeze({
  id: 'expense-app.workflow.task-strategy-implementation-output',
  version: 1,
  digest: sha256(
    canonicalJson(TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA),
  ),
});

export const TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR: ProviderOutputValidator =
  Object.freeze({
    ...TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      try {
        assertTaskStrategyImplementationOutput(value);
        return true;
      } catch {
        return false;
      }
    },
  });

export function createTaskStrategyImplementationSubject(
  input: Omit<
    TaskStrategyImplementationSubject,
    'schemaVersion' | 'kind' | 'subjectDigest'
  >,
): TaskStrategyImplementationSubject {
  const normalized = {
    ...input,
    testPaths: [...input.testPaths].sort(),
    fixturePaths: [...input.fixturePaths].sort(),
    frozenFiles: [...input.frozenFiles].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-implementation-subject.v1' as const,
    ...normalized,
  };
  return assertTaskStrategyImplementationSubject({
    ...body,
    subjectDigest: sha256(canonicalJson(body)),
  });
}

export function createTaskStrategyCorrectionSubject(
  input: Readonly<{
    subject: TaskStrategyImplementationSubject;
    round: number;
    greenFailureRecord: TaskStrategyGreenFailureRecord;
  }>,
): TaskStrategyImplementationSubject {
  const subject = assertTaskStrategyImplementationSubject(input.subject);
  let greenFailureRecord: TaskStrategyGreenFailureRecord;
  try {
    greenFailureRecord = parseTaskStrategyGreenFailureRecord(
      input.greenFailureRecord,
    );
  } catch {
    throw manifestInvalid();
  }
  if (
    greenFailureRecord.sessionId !== subject.sessionId ||
    greenFailureRecord.currentRedTransactionDigest !== subject.transactionDigest
  ) {
    throw manifestInvalid();
  }
  const {
    subjectDigest: _subjectDigest,
    correction: _priorCorrection,
    ...base
  } = subject;
  return createTaskStrategyImplementationSubject({
    ...base,
    sourceTree: greenFailureRecord.candidateTree,
    correction: {
      round: input.round,
      greenFailureRecordDigest: greenFailureRecord.recordDigest,
      greenFailureSubjectDigest: greenFailureRecord.subjectDigest,
      candidateTree: greenFailureRecord.candidateTree,
      failingCheckFingerprint:
        greenFailureRecord.failingCheck.failureFingerprint,
      currentPatchHead: greenFailureRecord.currentPatchHead,
    },
  });
}

export function createTaskStrategyImplementationManifest(
  input: Omit<
    TaskStrategyImplementationManifest,
    'schemaVersion' | 'kind' | 'capabilityProfile'
  >,
): TaskStrategyImplementationManifest {
  return assertTaskStrategyImplementationManifest({
    schemaVersion: 1,
    kind: 'task-strategy-implementation-manifest',
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    subject: input.subject,
    behaviorContractRefs: [...input.behaviorContractRefs].sort(
      compareCanonical,
    ),
    implementationPathScopes: [...input.implementationPathScopes].sort(),
    capabilityProfile: 'repository-read-only',
    ...(input.greenFailureRecord === undefined
      ? {}
      : { greenFailureRecord: input.greenFailureRecord }),
  });
}

export function assertTaskStrategyImplementationManifest(
  value: unknown,
): TaskStrategyImplementationManifest {
  const hasGreenFailureRecord =
    isRecord(value) && Object.hasOwn(value, 'greenFailureRecord');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'subject',
      'behaviorContractRefs',
      'implementationPathScopes',
      'capabilityProfile',
      ...(hasGreenFailureRecord ? ['greenFailureRecord'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-implementation-manifest' ||
    typeof value.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(value.repositoryId) ||
    !isObjectId(value.baseCommit) ||
    !isObjectId(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only' ||
    !isBehaviorContractRefs(value.behaviorContractRefs) ||
    !isImplementationScopes(value.implementationPathScopes)
  ) {
    throw manifestInvalid();
  }
  const subject = assertTaskStrategyImplementationSubject(value.subject);
  if (hasGreenFailureRecord !== (subject.correction !== undefined)) {
    throw manifestInvalid();
  }
  if (hasGreenFailureRecord) {
    let greenFailureRecord: TaskStrategyGreenFailureRecord;
    try {
      greenFailureRecord = parseTaskStrategyGreenFailureRecord(
        value.greenFailureRecord,
      );
    } catch {
      throw manifestInvalid();
    }
    if (!correctionMatchesGreenFailure(subject, greenFailureRecord)) {
      throw manifestInvalid();
    }
  }
  return deepFreeze(
    structuredClone(value),
  ) as TaskStrategyImplementationManifest;
}

export function assertTaskStrategyImplementationSubject(
  value: unknown,
): TaskStrategyImplementationSubject {
  const hasCorrection = isRecord(value) && Object.hasOwn(value, 'correction');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'subjectDigest',
      'sessionId',
      'changeId',
      'taskId',
      'strategy',
      'transactionDigest',
      'taskContractDigest',
      'sourceTree',
      'failureFingerprint',
      'redEvidenceNodeId',
      'redEvidenceResultDigest',
      'testPaths',
      'fixturePaths',
      'frozenFiles',
      ...(hasCorrection ? ['correction'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-implementation-subject.v1' ||
    !isDigest(value.subjectDigest) ||
    !isSessionId(value.sessionId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    (value.strategy !== 'cross-agent-tdd' &&
      value.strategy !== 'tdd-single-agent') ||
    !isDigest(value.transactionDigest) ||
    !isDigest(value.taskContractDigest) ||
    !isObjectId(value.sourceTree) ||
    !isDigest(value.failureFingerprint) ||
    !isDigest(value.redEvidenceNodeId) ||
    !isDigest(value.redEvidenceResultDigest) ||
    !isSortedPaths(value.testPaths, true) ||
    !isSortedPaths(value.fixturePaths, false) ||
    !isFrozenFiles(value.frozenFiles, value.testPaths, value.fixturePaths) ||
    (hasCorrection &&
      (!isCorrection(value.correction) ||
        value.sourceTree !== value.correction.candidateTree))
  ) {
    throw manifestInvalid();
  }
  const { subjectDigest, ...body } = value;
  if (subjectDigest !== sha256(canonicalJson(body))) throw manifestInvalid();
  return deepFreeze(
    structuredClone(value),
  ) as TaskStrategyImplementationSubject;
}

function correctionMatchesGreenFailure(
  subject: TaskStrategyImplementationSubject,
  greenFailureRecord: TaskStrategyGreenFailureRecord,
): boolean {
  const correction = subject.correction;
  return (
    correction !== undefined &&
    greenFailureRecord.sessionId === subject.sessionId &&
    greenFailureRecord.currentRedTransactionDigest ===
      subject.transactionDigest &&
    subject.sourceTree === greenFailureRecord.candidateTree &&
    correction.greenFailureRecordDigest === greenFailureRecord.recordDigest &&
    correction.greenFailureSubjectDigest === greenFailureRecord.subjectDigest &&
    correction.candidateTree === greenFailureRecord.candidateTree &&
    correction.failingCheckFingerprint ===
      greenFailureRecord.failingCheck.failureFingerprint &&
    canonicalJson(correction.currentPatchHead) ===
      canonicalJson(greenFailureRecord.currentPatchHead)
  );
}

function isCorrection(
  value: unknown,
): value is TaskStrategyImplementationCorrection {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'round',
      'greenFailureRecordDigest',
      'greenFailureSubjectDigest',
      'candidateTree',
      'failingCheckFingerprint',
      'currentPatchHead',
    ]) &&
    typeof value.round === 'number' &&
    Number.isSafeInteger(value.round) &&
    value.round > 0 &&
    isDigest(value.greenFailureRecordDigest) &&
    isDigest(value.greenFailureSubjectDigest) &&
    isObjectId(value.candidateTree) &&
    isDigest(value.failingCheckFingerprint) &&
    isPatchHead(value.currentPatchHead)
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

export function assertTaskStrategyImplementationOutput(
  value: unknown,
): TaskStrategyImplementationOutput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sessionId',
      'sourceTree',
      'patchBase64',
      'patchDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-patch-output.v1' ||
    !isSessionId(value.sessionId) ||
    !isObjectId(value.sourceTree) ||
    !isDigest(value.patchDigest) ||
    typeof value.patchBase64 !== 'string'
  ) {
    throw outputInvalid();
  }
  const patch = Buffer.from(value.patchBase64, 'base64');
  if (
    patch.length === 0 ||
    patch.length > MAX_PATCH_BYTES ||
    patch.toString('base64') !== value.patchBase64 ||
    sha256(patch) !== value.patchDigest
  ) {
    throw outputInvalid();
  }
  return deepFreeze(structuredClone(value)) as TaskStrategyImplementationOutput;
}

function isFrozenFiles(
  value: unknown,
  testPaths: unknown,
  fixturePaths: unknown,
): value is TaskStrategyImplementationFrozenFile[] {
  if (
    !Array.isArray(value) ||
    !Array.isArray(testPaths) ||
    !Array.isArray(fixturePaths)
  ) {
    return false;
  }
  const expectedPaths = [...testPaths, ...fixturePaths].sort();
  return (
    value.length === expectedPaths.length &&
    value.every(
      (entry, index) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['path', 'mode', 'objectId']) &&
        entry.path === expectedPaths[index] &&
        (entry.mode === '100644' || entry.mode === '100755') &&
        isObjectId(entry.objectId),
    )
  );
}

function isBehaviorContractRefs(
  value: unknown,
): value is BehaviorContractRef[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['specPath', 'requirement', 'scenario']) &&
        typeof entry.specPath === 'string' &&
        entry.specPath.startsWith('specs/') &&
        entry.specPath.endsWith('/spec.md') &&
        typeof entry.requirement === 'string' &&
        entry.requirement.trim() === entry.requirement &&
        entry.requirement.length > 0 &&
        (entry.scenario === null ||
          (typeof entry.scenario === 'string' &&
            entry.scenario.trim() === entry.scenario &&
            entry.scenario.length > 0)),
    ) &&
    isCanonicalSet(value)
  );
}

function isImplementationScopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === 'string' && normalizePolicyPath(entry) === entry,
    ) &&
    isCanonicalSet(value)
  );
}

function isSortedPaths(value: unknown, nonEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every(
      (entry) =>
        typeof entry === 'string' && normalizeChangedPath(entry) === entry,
    ) &&
    isCanonicalSet(value)
  );
}

function isCanonicalSet(value: unknown[]): boolean {
  return value.every(
    (entry, index) =>
      index === 0 || compareCanonical(value[index - 1]!, entry) < 0,
  );
}

function compareCanonical(left: unknown, right: unknown): number {
  return Buffer.from(canonicalJson(left)).compare(
    Buffer.from(canonicalJson(right)),
  );
}

function isSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function manifestInvalid() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_MANIFEST_INVALID',
    'Task strategy implementation manifest is malformed or not canonically bound.',
    ExitCode.verification,
  );
}

function outputInvalid() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_OUTPUT_INVALID',
    'Task strategy implementation output is malformed or not bound to one exact patch.',
    ExitCode.verification,
  );
}
