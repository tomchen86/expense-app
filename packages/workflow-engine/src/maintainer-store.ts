import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  assertMaintainerGrantId,
  canonicalGrantEnvelope,
  canonicalGrantPayload,
  parseMaintainerGrantEnvelope,
  validateGrantPayload,
  type MaintainerGrantEnvelope,
} from './maintainer-grant.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import { createInteractiveSshSigner } from './maintainer-signer.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  isMaintainerGrantV2Envelope,
  parseMaintainerGrantV2Envelope,
  type MaintainerGrantV2Envelope,
} from './maintainer-grant-v2.ts';
import {
  listActiveWorkflowSessionIds,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';
import {
  assertHumanRevocationAuthorization,
  authorizeHumanRevocation,
  canonicalHumanRevocationAuthorization,
  digestHumanRevocationSubject,
  type HumanRevocationAuthorization,
  type HumanRevocationOptions,
} from './human-revocation.ts';

export type AnyMaintainerGrantEnvelope =
  MaintainerGrantEnvelope | MaintainerGrantV2Envelope;

export type MaintainerReservationRecord = {
  schemaVersion: 1;
  state: 'reserved';
  grantId: string;
  sessionId: string;
  repositoryRoot: string;
  reservedAt: string;
  envelope: AnyMaintainerGrantEnvelope;
};

export type MaintainerTerminalRecord = {
  schemaVersion: 1;
  state: 'revoked' | 'consumed' | 'expired' | 'invalidated' | 'failed';
  grantId: string;
  sessionId: string | null;
  commitHash: string | null;
  reason: string;
  recordedAt: string;
  envelope: AnyMaintainerGrantEnvelope;
  revocationAuthorization?: HumanRevocationAuthorization;
};

export type LegacyMaintainerGrantRevocationTarget = {
  state: 'available' | 'reserved' | MaintainerTerminalRecord['state'];
  envelope: MaintainerGrantEnvelope;
  sessionId: string | null;
  terminalReason: string | null;
  terminalAuthorization: HumanRevocationAuthorization | null;
};

export type MaintainerGrantInspection = {
  grantId: string;
  state:
    | 'available'
    | 'reserved'
    | 'revoked'
    | 'consumed'
    | 'expired'
    | 'invalidated'
    | 'failed';
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

export type MaintainerGrantV2RevocationTarget = {
  state: 'available' | 'reserved' | MaintainerTerminalRecord['state'];
  envelope: MaintainerGrantV2Envelope;
  sessionId: string | null;
  terminalReason: string | null;
  terminalRecordedAt: string | null;
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
    revocationAuthorizations: path.join(root, 'revocation-authorizations'),
  };
}

export function storeAvailableMaintainerGrant(
  gitCommonDirectory: string,
  envelope: MaintainerGrantEnvelope,
): string {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    storeAvailableMaintainerGrantUnderLifecycleLock(
      gitCommonDirectory,
      envelope,
      assertOwned,
    ),
  );
}

export function storeAvailableMaintainerGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  envelope: MaintainerGrantEnvelope,
  assertOwned: () => void,
): string {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const grantId = assertMaintainerGrantId(envelope.payload.grantId);
  assertOwned();
  ensureStoreDirectories(paths);
  assertOwned();
  assertNoGrantState(paths, grantId);
  const target = grantPath(paths.available, grantId);
  createPrivateFileAtomic(target, canonicalGrantEnvelope(envelope));
  assertOwned();
  return target;
}

/**
 * Stores a canonical envelope that has already been fully parsed, verified,
 * and signed by its version-specific grant service. Keeping the byte-oriented
 * primitive here lets new envelope versions share the same exclusive local
 * grant state without teaching the store how to interpret authority.
 */
export function storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  canonicalEnvelope: string,
  assertOwned: () => void,
): string {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const grantId = assertMaintainerGrantId(requestedGrantId);
  if (
    typeof canonicalEnvelope !== 'string' ||
    canonicalEnvelope.length === 0 ||
    canonicalEnvelope.length > 1_048_576 ||
    !canonicalEnvelope.endsWith('\n')
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_INVALID',
      'Canonical maintainer grant envelope bytes are invalid.',
      ExitCode.guard,
    );
  }
  assertOwned();
  ensureStoreDirectories(paths);
  assertOwned();
  assertNoGrantState(paths, grantId);
  const target = grantPath(paths.available, grantId);
  createPrivateFileAtomic(target, canonicalEnvelope);
  assertOwned();
  return target;
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
    assertOwned();
    const availablePath = grantPath(paths.available, grantId);
    const reservedPath = grantPath(paths.reserved, grantId);
    const terminalPath = grantPath(paths.terminal, grantId);
    if (fs.existsSync(reservedPath)) {
      assertExecutableGrantVersion(
        readReservationOrInterrupted(reservedPath, grantId).envelope,
      );
      throw unavailableGrant(grantId);
    }
    if (fs.existsSync(terminalPath)) {
      assertExecutableGrantVersion(
        readTerminal(terminalPath, grantId).envelope,
      );
      throw unavailableGrant(grantId);
    }
    const envelope = readAvailableGrant(availablePath, grantId);
    assertExecutableGrantVersion(envelope);
    const activeSessions = listActiveWorkflowSessionIds(paths.runtime);
    if (activeSessions.length > 0) {
      throw workflowError(
        'ACTIVE_SESSION_CONFLICT',
        'Maintainer authority requires no active ordinary workflow session.',
        ExitCode.conflict,
        { details: { activeSessionIds: activeSessions } },
      );
    }
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

function assertExecutableGrantVersion(
  envelope: AnyMaintainerGrantEnvelope,
): asserts envelope is MaintainerGrantV2Envelope {
  if (!isMaintainerGrantV2Envelope(envelope)) {
    throw workflowError(
      'LEGACY_GRANT_V1_READ_ONLY',
      'Legacy V1 grants are historical read-only evidence and cannot be reserved or executed.',
      ExitCode.guard,
    );
  }
}

function assertLegacyGrantVersion(
  envelope: AnyMaintainerGrantEnvelope,
): asserts envelope is MaintainerGrantEnvelope {
  if (isMaintainerGrantV2Envelope(envelope)) {
    throw workflowError(
      'LEGACY_GRANT_V1_REQUIRED',
      'The legacy revocation path cannot terminalize an Apply Grant v2 envelope.',
      ExitCode.guard,
    );
  }
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

export function readTerminalMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
): MaintainerTerminalRecord {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return readTerminal(grantPath(paths.terminal, grantId), grantId);
}

export function revokeMaintainerGrant(
  _gitCommonDirectory: string,
  _requestedGrantId: string,
  _now: Date = new Date(),
): never {
  throw workflowError(
    'HUMAN_REVOCATION_API_REQUIRED',
    'Legacy maintainer grant revocation requires the current-human audited API.',
    ExitCode.guard,
  );
}

export function revokeLegacyMaintainerGrant(
  cwd: string,
  requestedGrantId: string,
  options: HumanRevocationOptions,
): MaintainerGrantInspection {
  const repository = discoverRepository(cwd);
  const paths = maintainerGrantStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      const target =
        readLegacyMaintainerGrantRevocationTargetUnderLifecycleLock(
          repository.gitCommonDirectory,
          requestedGrantId,
          assertOwned,
        );
      const payload = target.envelope.payload;
      const historicalPolicy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repository.repositoryRoot, [
            'show',
            `${payload.baseCommit}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      const historicalPolicyBlob = runGit(repository.repositoryRoot, [
        'rev-parse',
        `${payload.baseCommit}:workflow/maintainer-policy.json`,
      ]).trim();
      validateGrantPayload(payload, historicalPolicy, {
        now: options.now ?? new Date(),
        expectedBase: payload.baseCommit,
        expectedPolicyBlob: historicalPolicyBlob,
        allowExpired: true,
      });
      const historicalVerifier =
        options.verifier ??
        createInteractiveSshSigner(repository.repositoryRoot, historicalPolicy);
      historicalVerifier.verify(
        canonicalGrantPayload(payload),
        target.envelope.signature,
        payload.signer,
        historicalPolicy.signatureNamespace,
      );
      const authorization = authorizeHumanRevocation(
        repository.repositoryRoot,
        {
          subjectKind: 'legacy-maintainer-grant',
          grantId: payload.grantId,
          grantDigest: digestHumanRevocationSubject(
            canonicalGrantEnvelope(target.envelope),
          ),
          repositoryId: payload.repositoryId,
          repositoryOrigin: payload.repositoryOrigin,
          changeId: payload.changeId,
          taskId: null,
          workflowId: null,
          audit: null,
        },
        options,
        path.join(paths.revocationAuthorizations, `${payload.grantId}.json`),
        target.terminalAuthorization,
      );
      assertOwned();
      return terminallyRevokeLegacyMaintainerGrantUnderLifecycleLock(
        repository.gitCommonDirectory,
        payload.grantId,
        authorization,
        assertOwned,
      );
    },
    { allowMaintainerGrantId: requestedGrantId },
  );
}

function readLegacyMaintainerGrantRevocationTargetUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  assertOwned: () => void,
): LegacyMaintainerGrantRevocationTarget {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  assertOwned();
  ensureStoreDirectories(paths);
  const availablePath = grantPath(paths.available, grantId);
  const reservedPath = grantPath(paths.reserved, grantId);
  const terminalPath = grantPath(paths.terminal, grantId);
  const present = [availablePath, reservedPath, terminalPath].filter((entry) =>
    fs.existsSync(entry),
  );
  if (present.length === 0) throw grantNotFound(grantId);
  if (present.length !== 1) throw ambiguousGrant(grantId);
  if (present[0] === availablePath) {
    const envelope = readAvailableGrant(availablePath, grantId);
    assertLegacyGrantVersion(envelope);
    return {
      state: 'available',
      envelope,
      sessionId: null,
      terminalReason: null,
      terminalAuthorization: null,
    };
  }
  if (present[0] === reservedPath) {
    const reservation = readReservationOrInterrupted(reservedPath, grantId);
    assertLegacyGrantVersion(reservation.envelope);
    return {
      state: 'reserved',
      envelope: reservation.envelope,
      sessionId: reservation.sessionId ?? null,
      terminalReason: null,
      terminalAuthorization: null,
    };
  }
  const terminal = readTerminal(terminalPath, grantId);
  assertLegacyGrantVersion(terminal.envelope);
  return {
    state: terminal.state,
    envelope: terminal.envelope,
    sessionId: terminal.sessionId,
    terminalReason: terminal.reason,
    terminalAuthorization: terminal.revocationAuthorization ?? null,
  };
}

function terminallyRevokeLegacyMaintainerGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  authorization: HumanRevocationAuthorization,
  assertOwned: () => void,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const checked = assertHumanRevocationAuthorization(authorization);
  if (
    checked.payload.subjectKind !== 'legacy-maintainer-grant' ||
    checked.payload.grantId !== grantId
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_CONFLICT',
      'Legacy maintainer grant revocation authorization is bound elsewhere.',
      ExitCode.conflict,
    );
  }
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const target = readLegacyMaintainerGrantRevocationTargetUnderLifecycleLock(
    gitCommonDirectory,
    grantId,
    assertOwned,
  );
  if (target.state === 'revoked') {
    if (
      target.terminalReason !== checked.payload.reason ||
      target.terminalAuthorization === null ||
      canonicalHumanRevocationAuthorization(target.terminalAuthorization) !==
        canonicalHumanRevocationAuthorization(checked)
    ) {
      throw workflowError(
        'HUMAN_REVOCATION_CONFLICT',
        'Legacy maintainer grant already has a different revocation tombstone.',
        ExitCode.conflict,
      );
    }
    return inspectTerminal(
      readTerminal(grantPath(paths.terminal, grantId), grantId),
    );
  }
  if (target.state !== 'available' && target.state !== 'reserved') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Only active legacy maintainer grant authority can be revoked.',
      ExitCode.guard,
    );
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: 'revoked',
    grantId,
    sessionId: target.sessionId,
    commitHash: null,
    reason: checked.payload.reason,
    recordedAt: checked.payload.revokedAt,
    envelope: target.envelope,
    revocationAuthorization: checked,
  };
  assertOwned();
  createPrivateFileAtomic(
    grantPath(paths.terminal, grantId),
    serializeRecord(terminal),
  );
  cleanupNonterminalCopies(paths, grantId, target.envelope);
  assertOwned();
  return inspectTerminal(terminal);
}

export function readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  assertOwned: () => void,
): MaintainerGrantV2RevocationTarget {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  assertOwned();
  ensureStoreDirectories(paths);
  assertOwned();
  const availablePath = grantPath(paths.available, grantId);
  const reservedPath = grantPath(paths.reserved, grantId);
  const terminalPath = grantPath(paths.terminal, grantId);
  const present = [availablePath, reservedPath, terminalPath].filter((entry) =>
    fs.existsSync(entry),
  );
  if (present.length === 0) throw grantNotFound(grantId);
  if (present.length !== 1) throw ambiguousGrant(grantId);
  if (present[0] === availablePath) {
    const envelope = readAvailableGrant(availablePath, grantId);
    assertExecutableGrantVersion(envelope);
    return {
      state: 'available',
      envelope,
      sessionId: null,
      terminalReason: null,
      terminalRecordedAt: null,
    };
  }
  if (present[0] === reservedPath) {
    const reservation = readReservation(reservedPath, grantId);
    assertExecutableGrantVersion(reservation.envelope);
    return {
      state: 'reserved',
      envelope: reservation.envelope,
      sessionId: reservation.sessionId,
      terminalReason: null,
      terminalRecordedAt: null,
    };
  }
  const terminal = readTerminal(terminalPath, grantId);
  assertExecutableGrantVersion(terminal.envelope);
  return {
    state: terminal.state,
    envelope: terminal.envelope,
    sessionId: terminal.sessionId,
    terminalReason: terminal.reason,
    terminalRecordedAt: terminal.recordedAt,
  };
}

export function terminallyRevokeAvailableMaintainerGrantV2UnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  reason: string,
  now: Date,
  assertOwned: () => void,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const target = readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
    gitCommonDirectory,
    grantId,
    assertOwned,
  );
  if (target.state === 'revoked') {
    if (target.terminalReason !== reason) {
      throw workflowError(
        'MAINTAINER_GRANT_REVOCATION_CONFLICT',
        'Apply Grant v2 was already revoked with a different exact reason.',
        ExitCode.conflict,
      );
    }
    return inspectTerminal(
      readTerminal(grantPath(paths.terminal, grantId), grantId),
    );
  }
  if (target.state !== 'available') {
    throw workflowError(
      'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
      'Apply Grant v2 revocation only terminalizes an available unused grant.',
      ExitCode.guard,
    );
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: 'revoked',
    grantId,
    sessionId: null,
    commitHash: null,
    reason,
    recordedAt: exactDate(now).toISOString(),
    envelope: target.envelope,
  };
  const terminalPath = grantPath(paths.terminal, grantId);
  createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
  cleanupNonterminalCopies(paths, grantId, target.envelope);
  assertOwned();
  return inspectTerminal(terminal);
}

export function terminallyRevokeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'revoked',
    reason,
    now,
  );
}

export function terminallyExpireMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'expired',
    reason,
    now,
  );
}

export function terminallyInvalidateMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'invalidated',
    reason,
    now,
  );
}

export function terminallyInvalidateMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservationState(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'invalidated',
    reason,
    now,
  );
}

export function terminallyExpireMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservationState(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'expired',
    reason,
    now,
  );
}

export function terminallyFailMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservationState(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'failed',
    reason,
    now,
  );
}

function terminalizeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  terminalState: 'revoked' | 'expired' | 'invalidated' | 'failed',
  reason: string,
  now: Date,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const terminalReason = nonEmpty(reason, 'terminal reason');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      assertOwned();
      return terminalizeMaintainerReservationState(
        gitCommonDirectory,
        grantId,
        sessionId,
        terminalState,
        terminalReason,
        now,
      );
    },
    { allowMaintainerGrantId: grantId },
  );
}

function terminalizeMaintainerReservationState(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  terminalState: 'revoked' | 'expired' | 'invalidated' | 'failed',
  reason: string,
  now: Date,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const terminalReason = nonEmpty(reason, 'terminal reason');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
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
    state: terminalState,
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
}

/**
 * Returns a reserved grant to the available store. Used when a session fails
 * on a recoverable precondition before any durable session or repository
 * mutation exists; the grant keeps its original envelope, signature, and
 * expiry, so the maintainer does not need to re-sign it.
 */
export function releaseMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
): void {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      ensureStoreDirectories(paths);
      assertOwned();
      if (fs.existsSync(grantPath(paths.terminal, grantId))) {
        throw unavailableGrant(grantId);
      }
      const reservedPath = grantPath(paths.reserved, grantId);
      const reservation = readReservation(reservedPath, grantId);
      if (reservation.sessionId !== sessionId) {
        throw unavailableGrant(grantId);
      }
      createPrivateFileAtomic(
        grantPath(paths.available, grantId),
        canonicalAnyMaintainerGrantEnvelope(reservation.envelope),
      );
      fs.rmSync(reservedPath, { force: true });
      fsyncDirectory(paths.available);
      fsyncDirectory(paths.reserved);
    },
    { allowMaintainerGrantId: grantId },
  );
}

export function consumeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  requestedCommitHash: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const commitHash = requestedCommitHash.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commitHash)) {
    throw workflowError(
      'MAINTAINER_COMMIT_INVALID',
      'Maintainer consumption requires a full commit object ID.',
      ExitCode.guard,
    );
  }
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      assertOwned();
      return consumeMaintainerReservationUnderLifecycleLock(
        gitCommonDirectory,
        grantId,
        sessionId,
        commitHash,
        now,
      );
    },
    { allowMaintainerGrantId: grantId },
  );
}

export function consumeMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  requestedCommitHash: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const commitHash = requestedCommitHash.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commitHash)) {
    throw workflowError(
      'MAINTAINER_COMMIT_INVALID',
      'Maintainer consumption requires a full commit object ID.',
      ExitCode.guard,
    );
  }
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  const terminalPath = grantPath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    if (
      terminal.state !== 'consumed' ||
      terminal.sessionId !== sessionId ||
      terminal.commitHash !== commitHash
    ) {
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
    state: 'consumed',
    grantId,
    sessionId,
    commitHash,
    reason: 'Signed authority commit accepted',
    recordedAt: exactDate(now).toISOString(),
    envelope: reservation.envelope,
  };
  createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
  cleanupNonterminalCopies(paths, grantId, reservation.envelope);
  return inspectTerminal(terminal);
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
  envelope: AnyMaintainerGrantEnvelope,
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
): AnyMaintainerGrantEnvelope {
  const envelope = parseAnyMaintainerGrantEnvelope(readPrivateFile(filePath));
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
  const envelope = parseAnyMaintainerGrantEnvelope(
    serializeEmbeddedEnvelope(value.envelope),
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
): { envelope: AnyMaintainerGrantEnvelope; sessionId?: string } {
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
  const hasAuthorization = Object.prototype.hasOwnProperty.call(
    value,
    'revocationAuthorization',
  );
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
      ...(hasAuthorization ? ['revocationAuthorization'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    !['revoked', 'consumed', 'expired', 'invalidated', 'failed'].includes(
      String(value.state),
    ) ||
    value.grantId !== grantId ||
    (value.sessionId !== null && typeof value.sessionId !== 'string') ||
    (value.commitHash !== null && typeof value.commitHash !== 'string') ||
    typeof value.reason !== 'string' ||
    typeof value.recordedAt !== 'string' ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseAnyMaintainerGrantEnvelope(
    serializeEmbeddedEnvelope(value.envelope),
  );
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  let revocationAuthorization: HumanRevocationAuthorization | undefined;
  if (hasAuthorization) {
    revocationAuthorization = assertHumanRevocationAuthorization(
      value.revocationAuthorization,
    );
    if (
      value.state !== 'revoked' ||
      revocationAuthorization.payload.grantId !== grantId ||
      revocationAuthorization.payload.reason !== value.reason ||
      revocationAuthorization.payload.revokedAt !== value.recordedAt
    ) {
      throw ambiguousGrant(grantId);
    }
  }
  return {
    ...value,
    envelope,
    ...(revocationAuthorization ? { revocationAuthorization } : {}),
  } as MaintainerTerminalRecord;
}

function cleanupNonterminalCopies(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
  expected: AnyMaintainerGrantEnvelope,
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
    if (
      canonicalAnyMaintainerGrantEnvelope(observed) !==
      canonicalAnyMaintainerGrantEnvelope(expected)
    ) {
      throw ambiguousGrant(grantId);
    }
    fs.unlinkSync(target);
    fsyncDirectory(directory);
  }
}

export function canonicalAnyMaintainerGrantEnvelope(
  envelope: AnyMaintainerGrantEnvelope,
): string {
  return isMaintainerGrantV2Envelope(envelope)
    ? canonicalMaintainerGrantV2Envelope(envelope)
    : canonicalGrantEnvelope(envelope);
}

export function parseAnyMaintainerGrantEnvelope(
  raw: string,
): AnyMaintainerGrantEnvelope {
  try {
    const value = JSON.parse(raw) as {
      payload?: { version?: unknown };
    };
    return value.payload?.version === 2
      ? parseMaintainerGrantV2Envelope(raw)
      : parseMaintainerGrantEnvelope(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw unsafeStore();
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
    paths.revocationAuthorizations,
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

function serializeEmbeddedEnvelope(value: unknown): string {
  const version =
    value &&
    typeof value === 'object' &&
    'payload' in value &&
    value.payload &&
    typeof value.payload === 'object' &&
    'version' in value.payload
      ? value.payload.version
      : undefined;
  return `${version === 2 ? canonicalJson(value) : JSON.stringify(value)}\n`;
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
