import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import {
  assertMaintainerGrantId,
  canonicalGrantEnvelope,
  parseMaintainerGrantEnvelope,
  type MaintainerGrantEnvelope,
} from './maintainer-grant.ts';
import {
  listActiveWorkflowSessionIds,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';

export type MaintainerReservationRecord = {
  schemaVersion: 1;
  state: 'reserved';
  grantId: string;
  sessionId: string;
  repositoryRoot: string;
  reservedAt: string;
  envelope: MaintainerGrantEnvelope;
};

export type MaintainerTerminalRecord = {
  schemaVersion: 1;
  state: 'revoked' | 'consumed';
  grantId: string;
  sessionId: string | null;
  commitHash: string | null;
  reason: string;
  recordedAt: string;
  envelope: MaintainerGrantEnvelope;
};

export type MaintainerGrantInspection = {
  grantId: string;
  state: 'available' | 'reserved' | 'revoked' | 'consumed';
  changeId: string;
  baseCommit: string;
  allowedPaths: string[];
  issuedAt: string;
  expiresAt: string;
  signer: string;
  reservationSessionId?: string;
  terminalReason?: string;
  commitHash?: string;
};

type ReservationRequest = {
  sessionId: string;
  repositoryRoot: string;
  now?: Date;
};

export function maintainerGrantStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'maintainer-grants');
  return {
    runtime,
    root,
    available: path.join(root, 'available'),
    reserved: path.join(root, 'reserved'),
    terminal: path.join(root, 'terminal'),
    journals: path.join(root, 'journals'),
    sessions: path.join(root, 'sessions'),
  };
}

export function storeAvailableMaintainerGrant(
  gitCommonDirectory: string,
  envelope: MaintainerGrantEnvelope,
): string {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const grantId = assertMaintainerGrantId(envelope.payload.grantId);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureStoreDirectories(paths);
    assertOwned();
    assertNoGrantState(paths, grantId);
    const target = grantPath(paths.available, grantId);
    createPrivateFileAtomic(target, canonicalGrantEnvelope(envelope));
    return target;
  });
}

export function reserveMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
  request: ReservationRequest,
): MaintainerReservationRecord {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureStoreDirectories(paths);
    const activeSessions = listActiveWorkflowSessionIds(paths.runtime);
    if (activeSessions.length > 0) {
      throw workflowError(
        'ACTIVE_SESSION_CONFLICT',
        'Maintainer authority requires no active ordinary workflow session.',
        ExitCode.conflict,
        { details: { activeSessionIds: activeSessions } },
      );
    }
    assertOwned();
    const availablePath = grantPath(paths.available, grantId);
    const reservedPath = grantPath(paths.reserved, grantId);
    if (
      fs.existsSync(reservedPath) ||
      fs.existsSync(grantPath(paths.terminal, grantId))
    ) {
      throw unavailableGrant(grantId);
    }
    const envelope = readAvailableGrant(availablePath, grantId);
    const now = exactDate(request.now ?? new Date());
    const record: MaintainerReservationRecord = {
      schemaVersion: 1,
      state: 'reserved',
      grantId,
      sessionId: nonEmpty(request.sessionId, 'reservation session ID'),
      repositoryRoot: canonicalRoot(request.repositoryRoot),
      reservedAt: now.toISOString(),
      envelope,
    };
    fs.renameSync(availablePath, reservedPath);
    fsyncDirectory(paths.available);
    fsyncDirectory(paths.reserved);
    replacePrivateFileAtomic(reservedPath, serializeRecord(record));
    return record;
  });
}

export function readReservedMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
): MaintainerReservationRecord {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return readReservation(grantPath(paths.reserved, grantId), grantId);
}

export function inspectMaintainerGrants(
  gitCommonDirectory: string,
  requestedGrantId?: string,
): MaintainerGrantInspection[] {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const grantId = requestedGrantId
    ? assertMaintainerGrantId(requestedGrantId)
    : undefined;
  const states = existingStateDirectories(paths);
  const grantIds = grantId
    ? [grantId]
    : [
        ...new Set(states.flatMap(({ directory }) => listGrantIds(directory))),
      ].sort();
  const inspected = grantIds.map((id) => inspectOne(paths, id));
  if (grantId && inspected[0] === undefined) {
    throw grantNotFound(grantId);
  }
  return inspected.filter(
    (value): value is MaintainerGrantInspection => value !== undefined,
  );
}

export function revokeMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      ensureStoreDirectories(paths);
      assertOwned();
      const terminalPath = grantPath(paths.terminal, grantId);
      if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        cleanupNonterminalCopies(paths, grantId, terminal.envelope);
        return inspectTerminal(terminal);
      }

      const availablePath = grantPath(paths.available, grantId);
      const reservedPath = grantPath(paths.reserved, grantId);
      const available = fs.existsSync(availablePath)
        ? readAvailableGrant(availablePath, grantId)
        : undefined;
      const reservation = fs.existsSync(reservedPath)
        ? readReservationOrInterrupted(reservedPath, grantId)
        : undefined;
      if (!available && !reservation) {
        throw grantNotFound(grantId);
      }
      const envelope = available ?? reservation?.envelope;
      if (
        !envelope ||
        (available &&
          reservation &&
          canonicalGrantEnvelope(available) !==
            canonicalGrantEnvelope(reservation.envelope))
      ) {
        throw ambiguousGrant(grantId);
      }
      const terminal: MaintainerTerminalRecord = {
        schemaVersion: 1,
        state: 'revoked',
        grantId,
        sessionId: reservation?.sessionId ?? null,
        commitHash: null,
        reason: 'Explicit maintainer revocation',
        recordedAt: exactDate(now).toISOString(),
        envelope,
      };
      createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
      cleanupNonterminalCopies(paths, grantId, envelope);
      return inspectTerminal(terminal);
    },
    { allowMaintainerGrantId: grantId },
  );
}

export function terminallyRevokeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const terminalReason = nonEmpty(reason, 'terminal reason');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      ensureStoreDirectories(paths);
      assertOwned();
      const terminalPath = grantPath(paths.terminal, grantId);
      if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        if (terminal.sessionId !== sessionId) {
          throw unavailableGrant(grantId);
        }
        cleanupNonterminalCopies(paths, grantId, terminal.envelope);
        return inspectTerminal(terminal);
      }
      const reservedPath = grantPath(paths.reserved, grantId);
      const reservation = readReservation(reservedPath, grantId);
      if (reservation.sessionId !== sessionId) {
        throw unavailableGrant(grantId);
      }
      const terminal: MaintainerTerminalRecord = {
        schemaVersion: 1,
        state: 'revoked',
        grantId,
        sessionId,
        commitHash: null,
        reason: terminalReason,
        recordedAt: exactDate(now).toISOString(),
        envelope: reservation.envelope,
      };
      createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
      cleanupNonterminalCopies(paths, grantId, reservation.envelope);
      return inspectTerminal(terminal);
    },
    { allowMaintainerGrantId: grantId },
  );
}

function inspectOne(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
): MaintainerGrantInspection | undefined {
  const existing = [
    fs.existsSync(grantPath(paths.available, grantId)) && 'available',
    fs.existsSync(grantPath(paths.reserved, grantId)) && 'reserved',
    fs.existsSync(grantPath(paths.terminal, grantId)) && 'terminal',
  ].filter(Boolean);
  if (existing.length === 0) {
    return undefined;
  }
  if (existing.length !== 1) {
    throw ambiguousGrant(grantId);
  }
  if (existing[0] === 'available') {
    return inspectEnvelope(
      readAvailableGrant(grantPath(paths.available, grantId), grantId),
      'available',
    );
  }
  if (existing[0] === 'reserved') {
    const reservation = readReservation(
      grantPath(paths.reserved, grantId),
      grantId,
    );
    return {
      ...inspectEnvelope(reservation.envelope, 'reserved'),
      reservationSessionId: reservation.sessionId,
    };
  }
  return inspectTerminal(
    readTerminal(grantPath(paths.terminal, grantId), grantId),
  );
}

function inspectEnvelope(
  envelope: MaintainerGrantEnvelope,
  state: 'available' | 'reserved',
): MaintainerGrantInspection {
  const { payload } = envelope;
  return {
    grantId: payload.grantId,
    state,
    changeId: payload.changeId,
    baseCommit: payload.baseCommit,
    allowedPaths: [...payload.allowedPaths],
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    signer: payload.signer,
  };
}

function inspectTerminal(
  terminal: MaintainerTerminalRecord,
): MaintainerGrantInspection {
  return {
    ...inspectEnvelope(terminal.envelope, 'available'),
    state: terminal.state,
    ...(terminal.sessionId ? { reservationSessionId: terminal.sessionId } : {}),
    terminalReason: terminal.reason,
    ...(terminal.commitHash ? { commitHash: terminal.commitHash } : {}),
  };
}

function readAvailableGrant(
  filePath: string,
  grantId: string,
): MaintainerGrantEnvelope {
  const envelope = parseMaintainerGrantEnvelope(readPrivateFile(filePath));
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return envelope;
}

function readReservation(
  filePath: string,
  grantId: string,
): MaintainerReservationRecord {
  const value = parseRecord(readPrivateFile(filePath));
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'sessionId',
      'repositoryRoot',
      'reservedAt',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    value.state !== 'reserved' ||
    value.grantId !== grantId ||
    typeof value.sessionId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.reservedAt !== 'string'
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseMaintainerGrantEnvelope(
    `${JSON.stringify(value.envelope)}\n`,
  );
  if (
    envelope.payload.grantId !== grantId ||
    !path.isAbsolute(value.repositoryRoot) ||
    !isExactTimestamp(value.reservedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  return { ...value, envelope } as MaintainerReservationRecord;
}

function readReservationOrInterrupted(
  filePath: string,
  grantId: string,
): { envelope: MaintainerGrantEnvelope; sessionId?: string } {
  try {
    return readReservation(filePath, grantId);
  } catch {
    return { envelope: readAvailableGrant(filePath, grantId) };
  }
}

function readTerminal(
  filePath: string,
  grantId: string,
): MaintainerTerminalRecord {
  const value = parseRecord(readPrivateFile(filePath));
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'sessionId',
      'commitHash',
      'reason',
      'recordedAt',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    !['revoked', 'consumed'].includes(String(value.state)) ||
    value.grantId !== grantId ||
    (value.sessionId !== null && typeof value.sessionId !== 'string') ||
    (value.commitHash !== null && typeof value.commitHash !== 'string') ||
    typeof value.reason !== 'string' ||
    typeof value.recordedAt !== 'string' ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseMaintainerGrantEnvelope(
    `${JSON.stringify(value.envelope)}\n`,
  );
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return { ...value, envelope } as MaintainerTerminalRecord;
}

function cleanupNonterminalCopies(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
  expected: MaintainerGrantEnvelope,
): void {
  for (const directory of [paths.available, paths.reserved]) {
    const target = grantPath(directory, grantId);
    if (!fs.existsSync(target)) {
      continue;
    }
    const observed =
      directory === paths.available
        ? readAvailableGrant(target, grantId)
        : readReservationOrInterrupted(target, grantId).envelope;
    if (canonicalGrantEnvelope(observed) !== canonicalGrantEnvelope(expected)) {
      throw ambiguousGrant(grantId);
    }
    fs.unlinkSync(target);
    fsyncDirectory(directory);
  }
}

function ensureStoreDirectories(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
): void {
  for (const directory of [
    paths.root,
    paths.available,
    paths.reserved,
    paths.terminal,
    paths.journals,
    paths.sessions,
  ]) {
    const existed = fs.existsSync(directory);
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw unsafeStore();
    }
    if (!existed) {
      fsyncDirectory(path.dirname(directory));
    }
  }
}

function existingStateDirectories(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
): Array<{ directory: string }> {
  const directories = [paths.available, paths.reserved, paths.terminal];
  return directories.flatMap((directory) => {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats) {
      return [];
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw unsafeStore();
    }
    return [{ directory }];
  });
}

function assertNoGrantState(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
): void {
  if (
    [paths.available, paths.reserved, paths.terminal].some((directory) =>
      fs.existsSync(grantPath(directory, grantId)),
    )
  ) {
    throw unavailableGrant(grantId);
  }
}

function listGrantIds(directory: string): string[] {
  return fs.readdirSync(directory).map((entry) => {
    if (!entry.endsWith('.json')) {
      throw unsafeStore();
    }
    return assertMaintainerGrantId(entry.slice(0, -'.json'.length));
  });
}

function grantPath(directory: string, grantId: string): string {
  return path.join(directory, `${assertMaintainerGrantId(grantId)}.json`);
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw unavailableGrant(path.basename(filePath, '.json'));
    }
    throw error;
  }
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readPrivateFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw unsafeStore();
  }
  return fs.readFileSync(filePath, 'utf8');
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function serializeRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      raw !== `${JSON.stringify(value)}\n`
    ) {
      throw new Error('not canonical');
    }
    return value as Record<string, unknown>;
  } catch {
    throw unsafeStore();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((entry, index) => entry === sorted[index])
  );
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw workflowError(
      'MAINTAINER_GRANT_TIME_INVALID',
      'Maintainer grant state requires an exact timestamp.',
      ExitCode.guard,
    );
  }
  return date;
}

function isExactTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function canonicalRoot(value: string): string {
  if (!path.isAbsolute(value) || fs.realpathSync(value) !== value) {
    throw unsafeStore();
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw workflowError(
      'MAINTAINER_RESERVATION_INVALID',
      `Maintainer ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function unavailableGrant(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_UNAVAILABLE',
    `Maintainer grant ${grantId} is not available for this transition.`,
    ExitCode.conflict,
  );
}

function grantNotFound(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_NOT_FOUND',
    `Maintainer grant ${grantId} does not exist in local state.`,
    ExitCode.guard,
  );
}

function ambiguousGrant(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_STATE_AMBIGUOUS',
    `Maintainer grant ${grantId} has ambiguous or malformed local state.`,
    ExitCode.staleState,
  );
}

function unsafeStore() {
  return workflowError(
    'MAINTAINER_GRANT_STORE_UNSAFE',
    'Maintainer grant storage is malformed or unsafe.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
