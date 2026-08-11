import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import {
  assertSessionId,
  normalizeChangedPath,
  type InvestigationRuntimePaths,
} from './paths.ts';
import { isProviderId, type ProviderId } from './provider-registry.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export type TaskStrategyPatchEntry = Readonly<{
  mode: '100644' | '100755';
  objectId: string;
}>;

export type TaskStrategyPatchChange = Readonly<{
  path: string;
  before: TaskStrategyPatchEntry | null;
  after: TaskStrategyPatchEntry | null;
}>;

export type TaskStrategyPatchImplementer =
  | Readonly<{
      providerId: ProviderId;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
    }>
  | Readonly<{
      providerId: null;
      principalId: string;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
      degradedForm: 'caller-supplied';
      grantId: string;
    }>;

export type TaskStrategyPatchRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-record.v1';
  recordDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  sourceTree: string;
  candidateTree: string;
  taskContractDigest: string;
  patchDigest: string;
  patchBase64: string;
  changedPaths: readonly string[];
  changes: readonly TaskStrategyPatchChange[];
  implementer: TaskStrategyPatchImplementer;
  createdAt: string;
}>;

export type TaskStrategyPatchImportReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-import-receipt.v1';
  receiptDigest: string;
  recordDigest: string;
  sessionId: string;
  patchDigest: string;
  candidateTree: string;
  importedAt: string;
}>;

export type TaskStrategyPatchReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  patchDigest: string;
  recordDigest: string;
  sourceTree: string;
  candidateTree: string;
  createdAt: string;
}>;

export type TaskStrategyPatchCurrentBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-current.v1';
  bindingDigest: string;
  sessionId: string;
  patchDigest: string;
  recordDigest: string;
  receiptDigest: string;
  candidateTree: string;
  createdAt: string;
}>;

export function createTaskStrategyPatchRecord(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchRecord,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): TaskStrategyPatchRecord {
  return persistTaskStrategyPatchRecord(
    paths,
    prepareTaskStrategyPatchRecord(input),
  );
}

export function prepareTaskStrategyPatchRecord(
  input: Omit<
    TaskStrategyPatchRecord,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): TaskStrategyPatchRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-record.v1' as const,
    ...input,
  };
  return parsePatchRecord({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
}

export function persistTaskStrategyPatchRecord(
  paths: InvestigationRuntimePaths,
  value: TaskStrategyPatchRecord,
): TaskStrategyPatchRecord {
  const record = parsePatchRecord(value);
  createPrivateCanonicalJson(
    paths,
    patchRecordPath(paths, record.sessionId, record.patchDigest),
    record,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_RECORD_CONFLICT',
  );
  return readTaskStrategyPatchRecord(
    paths,
    record.sessionId,
    record.patchDigest,
  )!;
}

export function readTaskStrategyPatchRecord(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedPatchDigest: string,
): TaskStrategyPatchRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const patchDigest = assertDigest(requestedPatchDigest);
  const target = patchRecordPath(paths, sessionId, patchDigest);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const record = parsePatchRecord(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (record.sessionId !== sessionId || record.patchDigest !== patchDigest) {
    throw stateCorrupt();
  }
  return record;
}

export function createTaskStrategyPatchImportReceipt(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchImportReceipt,
    'schemaVersion' | 'kind' | 'receiptDigest'
  >,
): TaskStrategyPatchImportReceipt {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-import-receipt.v1' as const,
    ...input,
  };
  const receipt = parseImportReceipt({
    ...body,
    receiptDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    patchReceiptPath(paths, receipt.sessionId, receipt.patchDigest),
    receipt,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_RECEIPT_CONFLICT',
  );
  return readTaskStrategyPatchImportReceipt(
    paths,
    receipt.sessionId,
    receipt.patchDigest,
  )!;
}

export function readTaskStrategyPatchImportReceipt(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedPatchDigest: string,
): TaskStrategyPatchImportReceipt | null {
  const sessionId = assertSessionId(requestedSessionId);
  const patchDigest = assertDigest(requestedPatchDigest);
  const target = patchReceiptPath(paths, sessionId, patchDigest);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const receipt = parseImportReceipt(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (receipt.sessionId !== sessionId || receipt.patchDigest !== patchDigest) {
    throw stateCorrupt();
  }
  return receipt;
}

export function createTaskStrategyPatchReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchReservation,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskStrategyPatchReservation {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-reservation.v1' as const,
    ...input,
  };
  const reservation = parseReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    reservationPath(paths, reservation.sessionId),
    reservation,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_RESERVATION_CONFLICT',
  );
  return readTaskStrategyPatchReservation(paths, reservation.sessionId)!;
}

export function readTaskStrategyPatchReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyPatchReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = reservationPath(paths, sessionId);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const reservation = parseReservation(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (reservation.sessionId !== sessionId) throw stateCorrupt();
  return reservation;
}

export function createTaskStrategyPatchCurrentBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchCurrentBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskStrategyPatchCurrentBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-current.v1' as const,
    ...input,
  };
  const binding = parseCurrentBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    currentBindingPath(paths, binding.sessionId),
    binding,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_CURRENT_CONFLICT',
  );
  return readTaskStrategyPatchCurrentBinding(paths, binding.sessionId)!;
}

export function readTaskStrategyPatchCurrentBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyPatchCurrentBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = currentBindingPath(paths, sessionId);
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const binding = parseCurrentBinding(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (binding.sessionId !== sessionId) throw stateCorrupt();
  return binding;
}

function patchRecordPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  patchDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-patches',
    sessionId,
    `${patchDigest}.json`,
  );
}

function patchReceiptPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  patchDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-patches',
    sessionId,
    `${patchDigest}.imported.json`,
  );
}

function currentBindingPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-patches',
    sessionId,
    'current.json',
  );
}

function reservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-patches',
    sessionId,
    'reservation.json',
  );
}

function parsePatchRecord(value: unknown): TaskStrategyPatchRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'sessionId',
      'changeId',
      'taskId',
      'strategy',
      'sourceTree',
      'candidateTree',
      'taskContractDigest',
      'patchDigest',
      'patchBase64',
      'changedPaths',
      'changes',
      'implementer',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-patch-record.v1' ||
    !isDigest(value.recordDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    (value.strategy !== 'cross-agent-tdd' &&
      value.strategy !== 'tdd-single-agent') ||
    !isObjectId(value.sourceTree) ||
    !isObjectId(value.candidateTree) ||
    value.sourceTree === value.candidateTree ||
    !isDigest(value.taskContractDigest) ||
    !isDigest(value.patchDigest) ||
    !isCanonicalPatch(value.patchBase64, value.patchDigest) ||
    !isSortedPaths(value.changedPaths) ||
    !isChanges(value.changes, value.changedPaths) ||
    !isImplementer(value.implementer) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  const { recordDigest, ...body } = value;
  if (recordDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return Object.freeze(value as TaskStrategyPatchRecord);
}

function parseImportReceipt(value: unknown): TaskStrategyPatchImportReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'receiptDigest',
      'recordDigest',
      'sessionId',
      'patchDigest',
      'candidateTree',
      'importedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-patch-import-receipt.v1' ||
    !isDigest(value.receiptDigest) ||
    !isDigest(value.recordDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.patchDigest) ||
    !isObjectId(value.candidateTree) ||
    !isTimestamp(value.importedAt)
  ) {
    throw stateCorrupt();
  }
  const { receiptDigest, ...body } = value;
  if (receiptDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return Object.freeze(value as TaskStrategyPatchImportReceipt);
}

function parseCurrentBinding(value: unknown): TaskStrategyPatchCurrentBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'sessionId',
      'patchDigest',
      'recordDigest',
      'receiptDigest',
      'candidateTree',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-patch-current.v1' ||
    !isDigest(value.bindingDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.patchDigest) ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.receiptDigest) ||
    !isObjectId(value.candidateTree) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  const { bindingDigest, ...body } = value;
  if (bindingDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return Object.freeze(value as TaskStrategyPatchCurrentBinding);
}

function parseReservation(value: unknown): TaskStrategyPatchReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'sessionId',
      'patchDigest',
      'recordDigest',
      'sourceTree',
      'candidateTree',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-patch-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.patchDigest) ||
    !isDigest(value.recordDigest) ||
    !isObjectId(value.sourceTree) ||
    !isObjectId(value.candidateTree) ||
    value.sourceTree === value.candidateTree ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  const { reservationDigest, ...body } = value;
  if (reservationDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return Object.freeze(value as TaskStrategyPatchReservation);
}

function isCanonicalPatch(value: unknown, expectedDigest: unknown): boolean {
  if (typeof value !== 'string' || !isDigest(expectedDigest)) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    return false;
  }
  return (
    bytes.length > 0 &&
    bytes.length <= MAX_PATCH_BYTES &&
    bytes.toString('base64') === value &&
    sha256(bytes) === expectedDigest
  );
}

function isChanges(
  value: unknown,
  paths: unknown,
): value is TaskStrategyPatchChange[] {
  if (!Array.isArray(value) || !Array.isArray(paths)) return false;
  return (
    value.length === paths.length &&
    value.every(
      (entry, index) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['path', 'before', 'after']) &&
        entry.path === paths[index] &&
        isEntryOrNull(entry.before) &&
        isEntryOrNull(entry.after) &&
        !(entry.before === null && entry.after === null),
    )
  );
}

function isEntryOrNull(value: unknown): value is TaskStrategyPatchEntry | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['mode', 'objectId']) &&
      (value.mode === '100644' || value.mode === '100755') &&
      isObjectId(value.objectId))
  );
}

function isImplementer(
  value: unknown,
): value is TaskStrategyPatchRecord['implementer'] {
  if (!isRecord(value)) return false;
  if (
    hasExactKeys(value, ['providerId', 'assurance']) &&
    typeof value.providerId === 'string' &&
    isProviderId(value.providerId)
  ) {
    return isActorAssurance(value.assurance);
  }
  return (
    hasExactKeys(value, [
      'providerId',
      'principalId',
      'assurance',
      'degradedForm',
      'grantId',
    ]) &&
    value.providerId === null &&
    typeof value.principalId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value.principalId) &&
    isActorAssurance(value.assurance) &&
    value.degradedForm === 'caller-supplied' &&
    typeof value.grantId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.grantId,
    )
  );
}

function isActorAssurance(
  value: unknown,
): value is 'self-declared' | 'runtime-hint' | 'adapter-assigned' {
  return (
    value === 'self-declared' ||
    value === 'runtime-hint' ||
    value === 'adapter-assigned'
  );
}

function isSortedPaths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.every(isCanonicalPath) &&
    value.every((entry, index) => index === 0 || value[index - 1]! < entry)
  );
}

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

function isCanonicalPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return normalizeChangedPath(value) === value;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw stateCorrupt();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_PATCH_STATE_CORRUPT',
    'Task strategy patch state is malformed or unsafe.',
    ExitCode.staleState,
  );
}
