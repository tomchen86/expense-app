import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertPlainDirectory,
  ensurePlainDirectory,
} from './filesystem-safety.ts';
import {
  parseFinalizeTransaction,
  type FinalizeTransaction,
} from './finalize-transaction.ts';
import { writeJsonAtomic } from './session-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_FINALIZE_CANCELLATION_REASON_BYTES = 1024;

export type FinalizeCancellationPhase =
  'requested' | 'projection-restored' | 'completed';

export type FinalizeCancellation = Readonly<{
  schemaVersion: 1;
  kind: 'projected-finalize-cancellation.v1';
  recordDigest: string;
  phase: FinalizeCancellationPhase;
  sessionId: string;
  transactionId: string;
  transaction: FinalizeTransaction;
  reason: string;
  requestedAt: string;
  cancelledAt: string | null;
}>;

export function createFinalizeCancellation(
  transaction: FinalizeTransaction,
  reason: string,
  requestedAt: string,
): FinalizeCancellation {
  if (transaction.phase !== 'checks-running') {
    throw invalidCancellation(
      'Only an ambiguous checks-running transaction can be cancelled.',
    );
  }
  return sealCancellation({
    schemaVersion: 1,
    kind: 'projected-finalize-cancellation.v1',
    phase: 'requested',
    sessionId: transaction.sessionId,
    transactionId: transaction.transactionId,
    transaction,
    reason,
    requestedAt,
    cancelledAt: null,
  });
}

export function publishFinalizeCancellation(
  runtimeRoot: string,
  cancellation: FinalizeCancellation,
): FinalizeCancellation {
  const normalized = parseFinalizeCancellation(cancellation);
  const existing = readFinalizeCancellation(
    runtimeRoot,
    normalized.transactionId,
  );
  if (existing !== null) return assertSameCancellation(existing, normalized);
  const directory = cancellationDirectory(runtimeRoot);
  try {
    ensurePlainDirectory(directory);
  } catch {
    throw invalidCancellation('Finalize cancellation directory is unsafe.');
  }
  const prepared = publishCancellationPreparation(runtimeRoot, normalized);
  const filePath = cancellationPath(runtimeRoot, normalized.transactionId);
  const preparedPath = cancellationPreparationPath(
    runtimeRoot,
    normalized.transactionId,
  );
  try {
    fs.linkSync(preparedPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  const published = readFinalizeCancellation(
    runtimeRoot,
    normalized.transactionId,
  );
  if (published === null) {
    throw invalidCancellation('Finalize cancellation was not persisted.');
  }
  return assertSameCancellation(published, prepared);
}

export function markFinalizeProjectionRestored(
  runtimeRoot: string,
  current: FinalizeCancellation,
): FinalizeCancellation {
  if (current.phase !== 'requested') {
    throw invalidCancellation(
      'Finalize cancellation projection is not awaiting restoration.',
    );
  }
  return advanceCancellation(runtimeRoot, current, {
    ...current,
    phase: 'projection-restored',
  });
}

export function completeFinalizeCancellation(
  runtimeRoot: string,
  current: FinalizeCancellation,
  cancelledAt: string,
): FinalizeCancellation {
  if (current.phase !== 'projection-restored') {
    throw invalidCancellation(
      'Finalize cancellation projection has not been restored.',
    );
  }
  return advanceCancellation(runtimeRoot, current, {
    ...current,
    phase: 'completed',
    cancelledAt,
  });
}

export function readFinalizeCancellation(
  runtimeRoot: string,
  transactionId: string,
): FinalizeCancellation | null {
  const normalizedId = assertTransactionId(transactionId);
  const directory = cancellationDirectory(runtimeRoot);
  const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStats) return null;
  try {
    assertPlainDirectory(directory);
  } catch {
    throw invalidCancellation('Finalize cancellation directory is unsafe.');
  }
  const filePath = cancellationPath(runtimeRoot, normalizedId);
  return readCancellationFile(filePath, normalizedId, () =>
    cancellationPreparationPath(runtimeRoot, normalizedId),
  );
}

function readCancellationFile(
  filePath: string,
  normalizedId: string,
  publicationAlias?: (stats: fs.Stats) => string | null,
): FinalizeCancellation | null {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) return null;
  if (
    !isPrivateFile(before, publicationAlias ? [1, 2] : [1]) ||
    before.size > MAX_RECORD_BYTES
  ) {
    throw invalidCancellation('Finalize cancellation file is unsafe.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !isPrivateFile(opened, publicationAlias ? [1, 2] : [1]) ||
      opened.size > MAX_RECORD_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw invalidCancellation('Finalize cancellation file changed.');
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isPrivateFile(afterDescriptor, publicationAlias ? [1, 2] : [1]) ||
      !afterPath ||
      !isPrivateFile(afterPath, publicationAlias ? [1, 2] : [1]) ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw invalidCancellation('Finalize cancellation file changed.');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw invalidCancellation('Finalize cancellation is not JSON.');
    }
    const cancellation = parseFinalizeCancellation(value);
    if (
      cancellation.transactionId !== normalizedId ||
      content !== `${JSON.stringify(cancellation, null, 2)}\n`
    ) {
      throw invalidCancellation(
        'Finalize cancellation bytes are not canonical.',
      );
    }
    if (afterDescriptor.nlink === 2) {
      const publicationAliasPath = publicationAlias?.(afterDescriptor) ?? null;
      if (
        publicationAliasPath === null ||
        !isExactAlias(publicationAliasPath, afterDescriptor)
      ) {
        throw invalidCancellation(
          'Finalize cancellation has an unsafe hard-link alias.',
        );
      }
      fs.unlinkSync(publicationAliasPath);
      fsyncDirectory(path.dirname(filePath));
      const reconciled = fs.fstatSync(descriptor);
      const reconciledPath = fs.lstatSync(filePath, {
        throwIfNoEntry: false,
      });
      if (
        !isPrivateFile(reconciled, [1]) ||
        !reconciledPath ||
        !isPrivateFile(reconciledPath, [1]) ||
        reconciled.dev !== opened.dev ||
        reconciled.ino !== opened.ino ||
        reconciledPath.dev !== opened.dev ||
        reconciledPath.ino !== opened.ino
      ) {
        throw invalidCancellation(
          'Finalize cancellation publication did not reconcile.',
        );
      }
    }
    return cancellation;
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw invalidCancellation('Finalize cancellation is unreadable.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishCancellationPreparation(
  runtimeRoot: string,
  requested: FinalizeCancellation,
): FinalizeCancellation {
  const existing = readCancellationPreparation(
    runtimeRoot,
    requested.transactionId,
  );
  if (existing !== null) {
    return assertSameCancellationRequest(existing, requested);
  }
  const directory = cancellationDirectory(runtimeRoot);
  const preparationPath = cancellationPreparationPath(
    runtimeRoot,
    requested.transactionId,
  );
  const scratchPath = `${preparationPath}.${crypto.randomUUID()}.scratch`;
  const content = `${JSON.stringify(requested, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      scratchPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    const owned = fs.fstatSync(descriptor);
    const scratch = fs.lstatSync(scratchPath, { throwIfNoEntry: false });
    if (
      !isPrivateFile(owned, [1]) ||
      !scratch ||
      !isPrivateFile(scratch, [1]) ||
      owned.dev !== scratch.dev ||
      owned.ino !== scratch.ino ||
      owned.size !== Buffer.byteLength(content)
    ) {
      throw invalidCancellation(
        'Finalize cancellation preparation changed before publication.',
      );
    }
    try {
      fs.linkSync(scratchPath, preparationPath);
      fsyncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      const owned = fs.fstatSync(descriptor);
      const scratch = fs.lstatSync(scratchPath, { throwIfNoEntry: false });
      if (scratch && scratch.dev === owned.dev && scratch.ino === owned.ino) {
        fs.unlinkSync(scratchPath);
        fsyncDirectory(directory);
      }
      fs.closeSync(descriptor);
    }
  }
  const prepared = readCancellationPreparation(
    runtimeRoot,
    requested.transactionId,
  );
  if (prepared === null) {
    throw invalidCancellation(
      'Finalize cancellation preparation was not persisted.',
    );
  }
  return assertSameCancellationRequest(prepared, requested);
}

function readCancellationPreparation(
  runtimeRoot: string,
  transactionId: string,
): FinalizeCancellation | null {
  const normalizedId = assertTransactionId(transactionId);
  return readCancellationFile(
    cancellationPreparationPath(runtimeRoot, normalizedId),
    normalizedId,
    (stats) => preparationScratchAlias(runtimeRoot, normalizedId, stats),
  );
}

function preparationScratchAlias(
  runtimeRoot: string,
  transactionId: string,
  stats: fs.Stats,
): string | null {
  const directory = cancellationDirectory(runtimeRoot);
  const prefix = `${transactionId}.prepare.json.`;
  const aliases = fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.scratch'))
    .map((entry) => path.join(directory, entry))
    .filter((entryPath) => isExactAlias(entryPath, stats));
  return aliases.length === 1 ? aliases[0]! : null;
}

function assertSameCancellationRequest(
  observed: FinalizeCancellation,
  requested: FinalizeCancellation,
): FinalizeCancellation {
  if (
    observed.phase !== 'requested' ||
    observed.cancelledAt !== null ||
    observed.sessionId !== requested.sessionId ||
    observed.transactionId !== requested.transactionId ||
    observed.reason !== requested.reason ||
    JSON.stringify(observed.transaction) !==
      JSON.stringify(requested.transaction)
  ) {
    throw invalidCancellation(
      'A different finalize cancellation preparation already exists.',
    );
  }
  return observed;
}

function advanceCancellation(
  runtimeRoot: string,
  current: FinalizeCancellation,
  next: Omit<FinalizeCancellation, 'recordDigest'> | FinalizeCancellation,
): FinalizeCancellation {
  const observed = readFinalizeCancellation(runtimeRoot, current.transactionId);
  if (
    observed === null ||
    JSON.stringify(observed) !== JSON.stringify(current)
  ) {
    throw invalidCancellation(
      'Finalize cancellation changed before phase advancement.',
    );
  }
  const normalized = sealCancellation(next);
  writeJsonAtomic(
    cancellationPath(runtimeRoot, current.transactionId),
    normalized,
  );
  const advanced = readFinalizeCancellation(runtimeRoot, current.transactionId);
  if (
    advanced === null ||
    JSON.stringify(advanced) !== JSON.stringify(normalized)
  ) {
    throw invalidCancellation(
      'Finalize cancellation phase did not persist exact bytes.',
    );
  }
  return advanced;
}

function parseFinalizeCancellation(value: unknown): FinalizeCancellation {
  if (!isRecord(value)) throw malformed();
  const keys = [
    'cancelledAt',
    'kind',
    'phase',
    'reason',
    'recordDigest',
    'requestedAt',
    'schemaVersion',
    'sessionId',
    'transaction',
    'transactionId',
  ].sort();
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'projected-finalize-cancellation.v1' ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest) ||
    !['requested', 'projection-restored', 'completed'].includes(
      String(value.phase),
    ) ||
    typeof value.sessionId !== 'string' ||
    typeof value.transactionId !== 'string' ||
    !DIGEST.test(value.transactionId) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    Buffer.byteLength(value.reason) > MAX_FINALIZE_CANCELLATION_REASON_BYTES ||
    /\p{Cc}/u.test(value.reason) ||
    typeof value.requestedAt !== 'string' ||
    Number.isNaN(Date.parse(value.requestedAt)) ||
    (value.cancelledAt !== null && typeof value.cancelledAt !== 'string')
  ) {
    throw malformed();
  }
  const transaction = parseFinalizeTransaction(value.transaction);
  if (
    transaction.phase !== 'checks-running' ||
    transaction.sessionId !== value.sessionId ||
    transaction.transactionId !== value.transactionId ||
    (value.phase === 'completed'
      ? value.cancelledAt === null ||
        Number.isNaN(Date.parse(value.cancelledAt))
      : value.cancelledAt !== null)
  ) {
    throw malformed();
  }
  const cancellation: FinalizeCancellation = {
    schemaVersion: 1,
    kind: 'projected-finalize-cancellation.v1',
    recordDigest: value.recordDigest,
    phase: value.phase as FinalizeCancellationPhase,
    sessionId: value.sessionId,
    transactionId: value.transactionId,
    transaction,
    reason: value.reason,
    requestedAt: value.requestedAt,
    cancelledAt: value.cancelledAt as string | null,
  };
  if (
    digestCancellation(recordWithoutDigest(cancellation)) !==
    cancellation.recordDigest
  ) {
    throw malformed();
  }
  return cancellation;
}

function sealCancellation(
  value: Omit<FinalizeCancellation, 'recordDigest'> | FinalizeCancellation,
): FinalizeCancellation {
  const record = recordWithoutDigest(value);
  return parseFinalizeCancellation({
    ...record,
    recordDigest: digestCancellation(record),
  });
}

function recordWithoutDigest(
  value: Omit<FinalizeCancellation, 'recordDigest'> | FinalizeCancellation,
): Omit<FinalizeCancellation, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...record } =
    value as FinalizeCancellation;
  return record;
}

function digestCancellation(
  value: Omit<FinalizeCancellation, 'recordDigest'>,
): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertSameCancellation(
  observed: FinalizeCancellation,
  expected: FinalizeCancellation,
): FinalizeCancellation {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw invalidCancellation(
      'A different finalize cancellation already owns this transaction.',
    );
  }
  return observed;
}

function cancellationDirectory(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'finalize-transaction-history');
}

function cancellationPath(runtimeRoot: string, transactionId: string): string {
  return path.join(
    cancellationDirectory(runtimeRoot),
    `${assertTransactionId(transactionId)}.json`,
  );
}

function cancellationPreparationPath(
  runtimeRoot: string,
  transactionId: string,
): string {
  return path.join(
    cancellationDirectory(runtimeRoot),
    `${assertTransactionId(transactionId)}.prepare.json`,
  );
}

function assertTransactionId(value: string): string {
  if (!DIGEST.test(value)) {
    throw invalidCancellation('Finalize transaction ID is invalid.');
  }
  return value;
}

function isPrivateFile(
  stats: fs.Stats,
  allowedLinks: readonly number[],
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    allowedLinks.includes(stats.nlink) &&
    (stats.mode & 0o777) === 0o600
  );
}

function isExactAlias(aliasPath: string, stats: fs.Stats): boolean {
  const alias = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
  return (
    !!alias &&
    isPrivateFile(alias, [2]) &&
    alias.dev === stats.dev &&
    alias.ino === stats.ino
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function malformed(): never {
  throw invalidCancellation('Finalize cancellation is malformed.');
}

function invalidCancellation(message: string) {
  return workflowError(
    'FINALIZE_CANCELLATION_INVALID',
    message,
    ExitCode.staleState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
