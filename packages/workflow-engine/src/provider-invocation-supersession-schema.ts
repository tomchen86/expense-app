import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import { assertInvocationId, type InvestigationRuntimePaths } from './paths.ts';

const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/;
const FILE_DIGEST = /^[0-9a-f]{64}$/;

export type ProviderInvocationEvidenceSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-evidence-snapshot';
  invocationId: string;
  attempt: number;
  requestDigest: string;
  manifestDigest: string;
  subjectDigest: string;
  promptDigest: string | null;
  rawOutputDigest: string | null;
  semanticOutputDigest: string | null;
  terminalStatus: 'succeeded' | 'failed' | null;
  terminalAt: string | null;
  failureCode: string | null;
  legacyRevision: number;
  createdAt: string;
  evidenceDigest: string;
}>;

export type ProviderInvocationSupersessionEdge = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-supersession-edge';
  workflowId: string;
  jobId: string;
  epoch: number;
  contextDigest: string;
  replacementMode: 'retry' | 'repair';
  previousEdgeDigest: string | null;
  replacementOf: ProviderInvocationEvidenceSnapshot;
  supersededBy: ProviderInvocationEvidenceSnapshot;
  createdAt: string;
  edgeDigest: string;
}>;

export type ProviderInvocationSupersessionTransaction = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-supersession-transaction';
  predecessorInvocationId: string;
  successorInvocationId: string;
  edge: ProviderInvocationSupersessionEdge;
  preparedAt: string;
  transactionDigest: string;
}>;

export type ProviderInvocationSupersessionTransactionPointer = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-supersession-transaction-pointer';
  predecessorInvocationId: string;
  successorInvocationId: string;
  transactionDigest: string;
  pointerDigest: string;
}>;

export type ProviderInvocationSupersessionIndex = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-supersession-index';
  role: 'replacement-of' | 'superseded-by';
  invocationId: string;
  peerInvocationId: string;
  edgeDigest: string;
  transactionDigest: string;
  indexDigest: string;
}>;

export type ProviderInvocationSupersessionReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-supersession-receipt';
  predecessorInvocationId: string;
  successorInvocationId: string;
  edgeDigest: string;
  transactionDigest: string;
  publishedAt: string;
  receiptDigest: string;
}>;

export type ProviderInvocationSupersessionRelations = Readonly<{
  replacementOf: ProviderInvocationSupersessionEdge | null;
  supersededBy: ProviderInvocationSupersessionEdge | null;
}>;

export type ProviderInvocationSupersessionAccess = Readonly<{
  exists(filePath: string): boolean;
  read(filePath: string): unknown;
}>;

export function providerInvocationSupersessionPaths(
  paths: InvestigationRuntimePaths,
) {
  const root = path.join(paths.root, 'provider-invocation-supersessions');
  return {
    root,
    edges: path.join(root, 'edges'),
    byPredecessor: path.join(root, 'by-predecessor'),
    bySuccessor: path.join(root, 'by-successor'),
    transactionsByPredecessor: path.join(
      root,
      'transactions',
      'by-predecessor',
    ),
    transactionsBySuccessor: path.join(root, 'transactions', 'by-successor'),
    receipts: path.join(root, 'receipts'),
  };
}

export function providerInvocationSupersessionTransactionPath(
  paths: InvestigationRuntimePaths,
  predecessorInvocationId: string,
): string {
  return path.join(
    providerInvocationSupersessionPaths(paths).transactionsByPredecessor,
    `${identityFileName(predecessorInvocationId)}.json`,
  );
}

export function providerInvocationSupersessionTransactionPointerPath(
  paths: InvestigationRuntimePaths,
  successorInvocationId: string,
): string {
  return path.join(
    providerInvocationSupersessionPaths(paths).transactionsBySuccessor,
    `${identityFileName(successorInvocationId)}.json`,
  );
}

export function providerInvocationSupersessionEdgePath(
  paths: InvestigationRuntimePaths,
  edgeDigest: string,
): string {
  return path.join(
    providerInvocationSupersessionPaths(paths).edges,
    `${assertDigest(edgeDigest)}.json`,
  );
}

export function providerInvocationSupersessionPredecessorIndexPath(
  paths: InvestigationRuntimePaths,
  predecessorInvocationId: string,
): string {
  return path.join(
    providerInvocationSupersessionPaths(paths).byPredecessor,
    `${identityFileName(predecessorInvocationId)}.json`,
  );
}

export function providerInvocationSupersessionSuccessorIndexPath(
  paths: InvestigationRuntimePaths,
  successorInvocationId: string,
): string {
  return path.join(
    providerInvocationSupersessionPaths(paths).bySuccessor,
    `${identityFileName(successorInvocationId)}.json`,
  );
}

export function providerInvocationSupersessionReceiptPath(
  paths: InvestigationRuntimePaths,
  transactionDigest: string,
): string {
  return path.join(
    providerInvocationSupersessionPaths(paths).receipts,
    `${assertDigest(transactionDigest)}.json`,
  );
}

export function createProviderInvocationEvidenceSnapshot(
  input: Omit<ProviderInvocationEvidenceSnapshot, 'evidenceDigest'>,
): ProviderInvocationEvidenceSnapshot {
  return assertProviderInvocationEvidenceSnapshot({
    ...input,
    evidenceDigest: digestCanonical(input),
  });
}

export function createProviderInvocationSupersessionEdge(
  input: Omit<ProviderInvocationSupersessionEdge, 'edgeDigest'>,
): ProviderInvocationSupersessionEdge {
  return assertProviderInvocationSupersessionEdge({
    ...input,
    edgeDigest: digestCanonical(input),
  });
}

export function createProviderInvocationSupersessionTransaction(
  input: Omit<ProviderInvocationSupersessionTransaction, 'transactionDigest'>,
): ProviderInvocationSupersessionTransaction {
  return assertProviderInvocationSupersessionTransaction({
    ...input,
    transactionDigest: digestCanonical(input),
  });
}

export function createProviderInvocationSupersessionTransactionPointer(
  input: Omit<
    ProviderInvocationSupersessionTransactionPointer,
    'pointerDigest'
  >,
): ProviderInvocationSupersessionTransactionPointer {
  return assertProviderInvocationSupersessionTransactionPointer({
    ...input,
    pointerDigest: digestCanonical(input),
  });
}

export function createProviderInvocationSupersessionIndex(
  input: Omit<ProviderInvocationSupersessionIndex, 'indexDigest'>,
): ProviderInvocationSupersessionIndex {
  return assertProviderInvocationSupersessionIndex({
    ...input,
    indexDigest: digestCanonical(input),
  });
}

export function createProviderInvocationSupersessionReceipt(
  input: Omit<ProviderInvocationSupersessionReceipt, 'receiptDigest'>,
): ProviderInvocationSupersessionReceipt {
  return assertProviderInvocationSupersessionReceipt({
    ...input,
    receiptDigest: digestCanonical(input),
  });
}

export function inspectProviderInvocationSupersessionRelations(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  access: ProviderInvocationSupersessionAccess,
): ProviderInvocationSupersessionRelations {
  const invocationId = assertInvocationId(requestedInvocationId);
  const predecessorTransactionPath =
    providerInvocationSupersessionTransactionPath(paths, invocationId);
  const predecessorIndexPath =
    providerInvocationSupersessionPredecessorIndexPath(paths, invocationId);
  const successorPointerPath =
    providerInvocationSupersessionTransactionPointerPath(paths, invocationId);
  const successorIndexPath = providerInvocationSupersessionSuccessorIndexPath(
    paths,
    invocationId,
  );

  const predecessorTransaction = access.exists(predecessorTransactionPath)
    ? assertProviderInvocationSupersessionTransaction(
        access.read(predecessorTransactionPath),
      )
    : null;
  if (predecessorTransaction === null && access.exists(predecessorIndexPath)) {
    throw providerInvocationSupersessionUnsafe();
  }
  if (
    predecessorTransaction !== null &&
    predecessorTransaction.predecessorInvocationId !== invocationId
  ) {
    throw providerInvocationSupersessionUnsafe();
  }

  const successorPointer = access.exists(successorPointerPath)
    ? assertProviderInvocationSupersessionTransactionPointer(
        access.read(successorPointerPath),
      )
    : null;
  if (successorPointer === null && access.exists(successorIndexPath)) {
    throw providerInvocationSupersessionUnsafe();
  }
  if (
    successorPointer !== null &&
    successorPointer.successorInvocationId !== invocationId
  ) {
    throw providerInvocationSupersessionUnsafe();
  }

  const outgoing =
    predecessorTransaction === null
      ? null
      : readCompleteProviderInvocationSupersession(
          paths,
          predecessorTransaction,
          access,
        );
  let incoming: ProviderInvocationSupersessionEdge | null = null;
  if (successorPointer !== null) {
    const transactionPath = providerInvocationSupersessionTransactionPath(
      paths,
      successorPointer.predecessorInvocationId,
    );
    if (!access.exists(transactionPath)) {
      throw providerInvocationSupersessionUnsafe();
    }
    const transaction = assertProviderInvocationSupersessionTransaction(
      access.read(transactionPath),
    );
    if (
      transaction.transactionDigest !== successorPointer.transactionDigest ||
      transaction.successorInvocationId !== invocationId ||
      transaction.predecessorInvocationId !==
        successorPointer.predecessorInvocationId
    ) {
      throw providerInvocationSupersessionUnsafe();
    }
    incoming = readCompleteProviderInvocationSupersession(
      paths,
      transaction,
      access,
    );
  }
  return deepFreeze({ replacementOf: incoming, supersededBy: outgoing });
}

function readCompleteProviderInvocationSupersession(
  paths: InvestigationRuntimePaths,
  transaction: ProviderInvocationSupersessionTransaction,
  access: ProviderInvocationSupersessionAccess,
): ProviderInvocationSupersessionEdge {
  const receiptPath = providerInvocationSupersessionReceiptPath(
    paths,
    transaction.transactionDigest,
  );
  if (!access.exists(receiptPath)) {
    throw providerInvocationSupersessionRecoveryRequired();
  }
  const receipt = assertProviderInvocationSupersessionReceipt(
    access.read(receiptPath),
  );
  const edgePath = providerInvocationSupersessionEdgePath(
    paths,
    transaction.edge.edgeDigest,
  );
  const predecessorIndexPath =
    providerInvocationSupersessionPredecessorIndexPath(
      paths,
      transaction.predecessorInvocationId,
    );
  const successorIndexPath = providerInvocationSupersessionSuccessorIndexPath(
    paths,
    transaction.successorInvocationId,
  );
  const successorPointerPath =
    providerInvocationSupersessionTransactionPointerPath(
      paths,
      transaction.successorInvocationId,
    );
  if (
    !access.exists(edgePath) ||
    !access.exists(predecessorIndexPath) ||
    !access.exists(successorIndexPath) ||
    !access.exists(successorPointerPath)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  const edge = assertProviderInvocationSupersessionEdge(access.read(edgePath));
  const predecessorIndex = assertProviderInvocationSupersessionIndex(
    access.read(predecessorIndexPath),
  );
  const successorIndex = assertProviderInvocationSupersessionIndex(
    access.read(successorIndexPath),
  );
  const successorPointer =
    assertProviderInvocationSupersessionTransactionPointer(
      access.read(successorPointerPath),
    );
  if (
    canonicalJson(edge) !== canonicalJson(transaction.edge) ||
    receipt.predecessorInvocationId !== transaction.predecessorInvocationId ||
    receipt.successorInvocationId !== transaction.successorInvocationId ||
    receipt.edgeDigest !== edge.edgeDigest ||
    receipt.transactionDigest !== transaction.transactionDigest ||
    predecessorIndex.role !== 'superseded-by' ||
    predecessorIndex.invocationId !== transaction.predecessorInvocationId ||
    predecessorIndex.peerInvocationId !== transaction.successorInvocationId ||
    successorIndex.role !== 'replacement-of' ||
    successorIndex.invocationId !== transaction.successorInvocationId ||
    successorIndex.peerInvocationId !== transaction.predecessorInvocationId ||
    predecessorIndex.edgeDigest !== edge.edgeDigest ||
    successorIndex.edgeDigest !== edge.edgeDigest ||
    predecessorIndex.transactionDigest !== transaction.transactionDigest ||
    successorIndex.transactionDigest !== transaction.transactionDigest ||
    successorPointer.transactionDigest !== transaction.transactionDigest ||
    successorPointer.predecessorInvocationId !==
      transaction.predecessorInvocationId ||
    successorPointer.successorInvocationId !== transaction.successorInvocationId
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  return edge;
}

export function assertProviderInvocationEvidenceSnapshot(
  value: unknown,
): ProviderInvocationEvidenceSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempt',
      'createdAt',
      'evidenceDigest',
      'failureCode',
      'invocationId',
      'kind',
      'legacyRevision',
      'manifestDigest',
      'promptDigest',
      'rawOutputDigest',
      'requestDigest',
      'schemaVersion',
      'semanticOutputDigest',
      'subjectDigest',
      'terminalAt',
      'terminalStatus',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-evidence-snapshot' ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !Number.isSafeInteger(value.legacyRevision) ||
    (value.legacyRevision as number) < 0 ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.subjectDigest) ||
    !isNullableDigest(value.promptDigest) ||
    !isNullableDigest(value.rawOutputDigest) ||
    !isNullableDigest(value.semanticOutputDigest) ||
    ![null, 'succeeded', 'failed'].includes(
      value.terminalStatus as null | string,
    ) ||
    !isNullableTimestamp(value.terminalAt) ||
    (value.failureCode !== null &&
      (typeof value.failureCode !== 'string' ||
        value.failureCode.length < 1)) ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.evidenceDigest)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertInvocationId(String(value.invocationId));
  if (
    (value.terminalStatus === null &&
      (value.terminalAt !== null || value.failureCode !== null)) ||
    (value.terminalStatus !== null && value.terminalAt === null) ||
    (value.terminalStatus === 'succeeded' && value.failureCode !== null) ||
    (value.terminalStatus === 'failed' && value.failureCode === null)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertOwnDigest(value, 'evidenceDigest');
  return deepFreeze(
    structuredClone(value),
  ) as ProviderInvocationEvidenceSnapshot;
}

export function assertProviderInvocationSupersessionEdge(
  value: unknown,
): ProviderInvocationSupersessionEdge {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'contextDigest',
      'createdAt',
      'edgeDigest',
      'epoch',
      'jobId',
      'kind',
      'previousEdgeDigest',
      'replacementMode',
      'replacementOf',
      'schemaVersion',
      'supersededBy',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-supersession-edge' ||
    !isBoundedIdentity(value.workflowId) ||
    !isBoundedIdentity(value.jobId) ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !isDigest(value.contextDigest) ||
    (value.replacementMode !== 'retry' && value.replacementMode !== 'repair') ||
    !isNullableDigest(value.previousEdgeDigest) ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.edgeDigest)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  const replacementOf = assertProviderInvocationEvidenceSnapshot(
    value.replacementOf,
  );
  const supersededBy = assertProviderInvocationEvidenceSnapshot(
    value.supersededBy,
  );
  if (
    replacementOf.terminalStatus !== 'failed' ||
    supersededBy.terminalStatus !== null ||
    replacementOf.invocationId === supersededBy.invocationId ||
    supersededBy.attempt !== replacementOf.attempt + 1 ||
    supersededBy.createdAt !== value.createdAt ||
    Date.parse(supersededBy.createdAt) < Date.parse(replacementOf.createdAt) ||
    Date.parse(supersededBy.createdAt) < Date.parse(replacementOf.terminalAt!)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertOwnDigest(value, 'edgeDigest');
  return deepFreeze({
    ...(structuredClone(value) as ProviderInvocationSupersessionEdge),
    replacementOf,
    supersededBy,
  });
}

export function assertProviderInvocationSupersessionTransaction(
  value: unknown,
): ProviderInvocationSupersessionTransaction {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'edge',
      'kind',
      'predecessorInvocationId',
      'preparedAt',
      'schemaVersion',
      'successorInvocationId',
      'transactionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-supersession-transaction' ||
    !isTimestamp(value.preparedAt) ||
    !isDigest(value.transactionDigest)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  const predecessorInvocationId = assertInvocationId(
    String(value.predecessorInvocationId),
  );
  const successorInvocationId = assertInvocationId(
    String(value.successorInvocationId),
  );
  const edge = assertProviderInvocationSupersessionEdge(value.edge);
  if (
    edge.replacementOf.invocationId !== predecessorInvocationId ||
    edge.supersededBy.invocationId !== successorInvocationId
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertOwnDigest(value, 'transactionDigest');
  return deepFreeze({
    ...(structuredClone(value) as ProviderInvocationSupersessionTransaction),
    edge,
  });
}

export function assertProviderInvocationSupersessionTransactionPointer(
  value: unknown,
): ProviderInvocationSupersessionTransactionPointer {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'pointerDigest',
      'predecessorInvocationId',
      'schemaVersion',
      'successorInvocationId',
      'transactionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-supersession-transaction-pointer' ||
    !isDigest(value.transactionDigest) ||
    !isDigest(value.pointerDigest)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertInvocationId(String(value.predecessorInvocationId));
  assertInvocationId(String(value.successorInvocationId));
  assertOwnDigest(value, 'pointerDigest');
  return deepFreeze(
    structuredClone(value),
  ) as ProviderInvocationSupersessionTransactionPointer;
}

export function assertProviderInvocationSupersessionIndex(
  value: unknown,
): ProviderInvocationSupersessionIndex {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'edgeDigest',
      'indexDigest',
      'invocationId',
      'kind',
      'peerInvocationId',
      'role',
      'schemaVersion',
      'transactionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-supersession-index' ||
    (value.role !== 'replacement-of' && value.role !== 'superseded-by') ||
    !isDigest(value.edgeDigest) ||
    !isDigest(value.transactionDigest) ||
    !isDigest(value.indexDigest)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertInvocationId(String(value.invocationId));
  assertInvocationId(String(value.peerInvocationId));
  if (value.invocationId === value.peerInvocationId) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertOwnDigest(value, 'indexDigest');
  return deepFreeze(
    structuredClone(value),
  ) as ProviderInvocationSupersessionIndex;
}

export function assertProviderInvocationSupersessionReceipt(
  value: unknown,
): ProviderInvocationSupersessionReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'edgeDigest',
      'kind',
      'predecessorInvocationId',
      'publishedAt',
      'receiptDigest',
      'schemaVersion',
      'successorInvocationId',
      'transactionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-supersession-receipt' ||
    !isDigest(value.edgeDigest) ||
    !isDigest(value.transactionDigest) ||
    !isTimestamp(value.publishedAt) ||
    !isDigest(value.receiptDigest)
  ) {
    throw providerInvocationSupersessionUnsafe();
  }
  assertInvocationId(String(value.predecessorInvocationId));
  assertInvocationId(String(value.successorInvocationId));
  assertOwnDigest(value, 'receiptDigest');
  return deepFreeze(
    structuredClone(value),
  ) as ProviderInvocationSupersessionReceipt;
}

export function providerInvocationSupersessionConflict() {
  return workflowError(
    'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT',
    'The predecessor already has a different durable successor.',
    ExitCode.conflict,
  );
}

export function providerInvocationSupersessionRecoveryRequired() {
  return workflowError(
    'PROVIDER_INVOCATION_SUPERSESSION_RECOVERY_REQUIRED',
    'A prepared provider invocation supersession requires deterministic recovery.',
    ExitCode.staleState,
  );
}

export function providerInvocationSupersessionUnsafe() {
  return workflowError(
    'PROVIDER_INVOCATION_SUPERSESSION_UNSAFE',
    'Provider invocation supersession evidence is missing, malformed, or inconsistent.',
    ExitCode.guard,
  );
}

function identityFileName(value: string): string {
  return digestText(assertInvocationId(value));
}

function assertOwnDigest(value: Record<string, unknown>, key: string): void {
  const payload = { ...value };
  const expected = payload[key];
  delete payload[key];
  if (expected !== digestCanonical(payload)) {
    throw providerInvocationSupersessionUnsafe();
  }
}

function assertDigest(value: string): string {
  if (!FILE_DIGEST.test(value)) throw providerInvocationSupersessionUnsafe();
  return value;
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isBoundedIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
