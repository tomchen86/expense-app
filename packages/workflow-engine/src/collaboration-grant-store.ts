import fs from 'node:fs';
import path from 'node:path';

import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  assertCollaborationGrantId,
  canonicalCollaborationGrantEnvelope,
  collaborationGrantEnvelopeDigest,
  directHumanReviewAttestationDigest,
  bindingFromPayload,
  parseCollaborationGrantEnvelope,
  parseDirectHumanReviewAttestation,
  validateCollaborationGrantEnvelope,
  validateDirectHumanReviewAttestation,
  type CollaborationDegradedForm,
  type CollaborationGrantEnvelope,
  type CollaborationGrantExpectedBinding,
  type CollaborationLifecyclePhase,
  type DirectHumanReviewAttestation,
} from './collaboration-grant.ts';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
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
import { inspectTaskMandate } from './task-mandate.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const STATE_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export type CollaborationGrantedAssignmentRecord = {
  role: 'blind-surveyor' | 'plan-reviewer';
  providerId: 'codex' | 'claude' | null;
  sessionId: string | null;
  targetDigest: string;
  requiredIndependence: 'provider-independent';
  achievedIndependence: 'session-independent' | 'none';
  providerIndependent: false;
  sessionIndependent: boolean;
  engineSpawned: boolean;
  orchestration:
    'engine-spawned-provider' | 'caller-supplied' | 'direct-human-review';
  grantId: string;
  degradedForm: CollaborationDegradedForm;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  author: CollaborationParticipantRecord;
  participant: CollaborationParticipantRecord;
  callableProviderIds: readonly ('codex' | 'claude')[];
  directHumanReviewAttestationDigest: string | null;
};

export type CollaborationParticipantRecord = {
  providerId: 'codex' | 'claude' | null;
  sessionId: string | null;
  principalId: string | null;
  identityAssurance:
    'self-declared' | 'runtime-hint' | 'adapter-assigned' | 'maintainer-signed';
  engineSpawned: boolean;
};

export type CollaborationStructuredContent = {
  kind: 'blind-survey' | 'plan-review';
  nodeId: string;
  resultDigest: string;
};

export type CollaborationGrantUseProjection = {
  schemaVersion: 1;
  grantId: string;
  signedEnvelopeDigest: string;
  transitionDigest: string;
  reservedAt: string;
  lifecyclePhase: CollaborationLifecyclePhase;
  targetDigest: string;
  degradedForm: CollaborationDegradedForm;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  assignment: CollaborationGrantedAssignmentRecord;
  structuredContent: CollaborationStructuredContent;
  contentAuthority: 'reference-only-requires-governing-validator';
  directHumanReviewAttestation: DirectHumanReviewAttestation | null;
  retainedObligations: typeof COLLABORATION_GRANT_RETAINED_OBLIGATIONS;
  replayScope: typeof COLLABORATION_GRANT_REPLAY_SCOPE;
  residuals: typeof COLLABORATION_GRANT_RESIDUALS;
  envelope: CollaborationGrantEnvelope;
};

export type CollaborationReservationRecord = {
  schemaVersion: 1;
  state: 'reserved';
  grantId: string;
  transitionDigest: string;
  repositoryRoot: string;
  reservedAt: string;
  envelope: CollaborationGrantEnvelope;
};

export type CollaborationTerminalRecord = {
  schemaVersion: 1;
  state: 'revoked' | 'consumed' | 'failed' | 'expired';
  grantId: string;
  transitionDigest: string | null;
  reason: string;
  recordedAt: string;
  envelope: CollaborationGrantEnvelope;
  use: CollaborationGrantUseProjection | null;
  revocationAuthorization?: HumanRevocationAuthorization;
};

export type CollaborationGrantInspection = {
  grantId: string;
  state:
    'available' | 'reserved' | 'revoked' | 'consumed' | 'failed' | 'expired';
  changeId: string;
  taskId: string | null;
  lifecyclePhase: CollaborationLifecyclePhase;
  targetDigest: string;
  degradedForm: CollaborationDegradedForm;
  issuedAt: string;
  expiresAt: string;
  signer: string;
  transitionDigest?: string;
  terminalReason?: string;
  use?: CollaborationGrantUseProjection;
};

export type CollaborationReservationRequest = {
  transitionDigest: string;
  expected: CollaborationGrantExpectedBinding;
  now?: Date;
  verifier?: MaintainerSignerProvider;
};

export type CollaborationConsumptionRequest = {
  transitionDigest: string;
  assignment: unknown;
  contentAdmission: CollaborationContentAdmission;
  directHumanReviewAttestation?: DirectHumanReviewAttestation | null;
  now?: Date;
};

export type CollaborationContentAdmission = CollaborationStructuredContent & {
  current: true;
};

export type CollaborationGrantUseValidationOptions = {
  now: Date;
  expectedBinding: CollaborationGrantExpectedBinding;
  policy: MaintainerPolicy;
  verifier: MaintainerSignerProvider;
  transitionDigest: string;
  expectedAssignment: unknown;
  contentAdmission: CollaborationContentAdmission;
};

export type CollaborationGrantUseValidationEntry = {
  value: unknown;
  options: CollaborationGrantUseValidationOptions;
};

export function collaborationGrantStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'collaboration-grants');
  return {
    runtime,
    root,
    available: path.join(root, 'available'),
    reserved: path.join(root, 'reserved'),
    terminal: path.join(root, 'terminal'),
    revocationAuthorizations: path.join(root, 'revocation-authorizations'),
  };
}

export function storeAvailableCollaborationGrant(
  gitCommonDirectory: string,
  envelope: CollaborationGrantEnvelope,
): string {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  const parsed = parseCollaborationGrantEnvelope(
    canonicalCollaborationGrantEnvelope(envelope),
  );
  const grantId = assertCollaborationGrantId(parsed.payload.grantId);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureStoreDirectories(paths);
    assertOwned();
    assertNoState(paths, grantId);
    const target = statePath(paths.available, grantId);
    createPrivateFileAtomic(
      target,
      canonicalCollaborationGrantEnvelope(parsed),
    );
    return target;
  });
}

/**
 * Verify and atomically reserve one exact grant against repository facts.
 * Validation and `reservedAt` share the same engine-owned clock value; callers
 * cannot substitute a no-op validation callback or a second timestamp.
 */
export function reserveCollaborationGrant(
  cwd: string,
  requestedGrantId: string,
  request: CollaborationReservationRequest,
): CollaborationReservationRecord {
  const repository = discoverRepository(cwd);
  const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    reserveCollaborationGrantUnderLifecycleLock(
      cwd,
      requestedGrantId,
      request,
      assertOwned,
    ),
  );
}

export function reserveCollaborationGrantUnderLifecycleLock(
  cwd: string,
  requestedGrantId: string,
  request: CollaborationReservationRequest,
  assertOwned: () => void,
): CollaborationReservationRecord {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const transitionDigest = exactDigest(
    request.transitionDigest,
    'transition digest',
  );
  const repository = discoverRepository(cwd);
  const baselineCommit = exactRepositoryCommit(
    repository.repositoryRoot,
    request.expected.baselineCommit,
  );
  const baselineTree = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}^{tree}`,
  ]).trim();
  const mergeBase = runGit(repository.repositoryRoot, [
    'merge-base',
    baselineCommit,
    repository.head,
  ]).trim();
  if (mergeBase !== baselineCommit) {
    throw bindingMismatch();
  }
  const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (
    request.expected.baselineTree !== baselineTree ||
    request.expected.policyBlob !== policyBlob ||
    request.expected.repositoryId !== policy.repository.id ||
    request.expected.repositoryOrigin !== policy.repository.origin ||
    origin !== policy.repository.origin
  ) {
    throw bindingMismatch();
  }
  const now = exactDate(request.now ?? new Date());
  const verifier =
    request.verifier ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
  ensureStoreDirectories(paths);
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    throw unavailableGrant(grantId);
  }
  assertNonterminalUnambiguous(paths, grantId);
  if (fs.existsSync(statePath(paths.reserved, grantId))) {
    throw unavailableGrant(grantId);
  }
  const availablePath = statePath(paths.available, grantId);
  if (!fs.existsSync(availablePath)) {
    throw unavailableGrant(grantId);
  }
  const envelope = readAvailable(availablePath, grantId);
  try {
    validateCollaborationGrantEnvelope(envelope, policy, {
      now,
      expected: request.expected,
      verifier,
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'COLLABORATION_GRANT_EXPIRED'
    ) {
      const terminal: CollaborationTerminalRecord = {
        schemaVersion: 1,
        state: 'expired',
        grantId,
        transitionDigest,
        reason: 'Grant expired before reservation',
        recordedAt: now.toISOString(),
        envelope,
        use: null,
      };
      assertOwned();
      createPrivateFileAtomic(terminalPath, serialize(terminal));
      cleanupNonterminal(paths, grantId, envelope, transitionDigest);
    }
    throw error;
  }
  assertOwned();
  const record: CollaborationReservationRecord = {
    schemaVersion: 1,
    state: 'reserved',
    grantId,
    transitionDigest,
    repositoryRoot: repository.repositoryRoot,
    reservedAt: now.toISOString(),
    envelope,
  };
  const reservedPath = statePath(paths.reserved, grantId);
  fs.renameSync(availablePath, reservedPath);
  fsyncDirectory(paths.available);
  fsyncDirectory(paths.reserved);
  replacePrivateFileAtomic(reservedPath, serialize(record));
  assertOwned();
  return deepFreeze(record);
}

export function readReservedCollaborationGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
): CollaborationReservationRecord {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    readReservedCollaborationGrantUnderLifecycleLock(
      gitCommonDirectory,
      requestedGrantId,
      assertOwned,
    ),
  );
}

export function readReservedCollaborationGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  assertOwned: () => void,
): CollaborationReservationRecord {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    throw unavailableGrant(grantId);
  }
  assertNonterminalUnambiguous(paths, grantId);
  const reservation = readReservation(
    statePath(paths.reserved, grantId),
    grantId,
  );
  assertOwned();
  return reservation;
}

export function consumeCollaborationGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
  request: CollaborationConsumptionRequest,
): CollaborationGrantInspection {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    consumeCollaborationGrantUnderLifecycleLock(
      gitCommonDirectory,
      requestedGrantId,
      request,
      assertOwned,
    ),
  );
}

export function consumeCollaborationGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  request: CollaborationConsumptionRequest,
  assertOwned: () => void,
): CollaborationGrantInspection {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const transitionDigest = exactDigest(
    request.transitionDigest,
    'transition digest',
  );
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    if (
      terminal.state !== 'consumed' ||
      !terminal.use ||
      !consumptionMatches(terminal.use, request, transitionDigest)
    ) {
      throw unavailableGrant(grantId);
    }
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    return inspectTerminal(terminal);
  }
  assertNonterminalUnambiguous(paths, grantId);

  const reservation = readReservation(
    statePath(paths.reserved, grantId),
    grantId,
  );
  if (reservation.transitionDigest !== transitionDigest) {
    throw unavailableGrant(grantId);
  }
  let assignment: CollaborationGrantedAssignmentRecord;
  let structuredContent: CollaborationStructuredContent;
  let directHumanReviewAttestation: DirectHumanReviewAttestation | null;
  try {
    assignment = assertGrantedAssignment(
      request.assignment,
      reservation.envelope,
    );
    const contentAdmission = assertContentAdmission(
      request.contentAdmission,
      reservation.envelope.payload.lifecyclePhase,
    );
    structuredContent = {
      kind: contentAdmission.kind,
      nodeId: contentAdmission.nodeId,
      resultDigest: contentAdmission.resultDigest,
    };
    directHumanReviewAttestation = assertDirectHumanAttestationReference(
      request.directHumanReviewAttestation ?? null,
      assignment,
      reservation.envelope,
      transitionDigest,
      structuredContent,
    );
  } catch (error) {
    const failed: CollaborationTerminalRecord = {
      schemaVersion: 1,
      state: 'failed',
      grantId,
      transitionDigest,
      reason: 'Exact role-result content admission failed',
      recordedAt: exactDate(request.now ?? new Date()).toISOString(),
      envelope: reservation.envelope,
      use: null,
    };
    assertOwned();
    createPrivateFileAtomic(terminalPath, serialize(failed));
    cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
    assertOwned();
    throw error;
  }
  const use: CollaborationGrantUseProjection = {
    schemaVersion: 1,
    grantId,
    signedEnvelopeDigest: collaborationGrantEnvelopeDigest(
      reservation.envelope,
    ),
    transitionDigest,
    reservedAt: reservation.reservedAt,
    lifecyclePhase: reservation.envelope.payload.lifecyclePhase,
    targetDigest: reservation.envelope.payload.targetDigest,
    degradedForm: reservation.envelope.payload.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    assignment,
    structuredContent,
    contentAuthority: 'reference-only-requires-governing-validator',
    directHumanReviewAttestation,
    retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
    residuals: COLLABORATION_GRANT_RESIDUALS,
    envelope: reservation.envelope,
  };
  const terminal: CollaborationTerminalRecord = {
    schemaVersion: 1,
    state: 'consumed',
    grantId,
    transitionDigest,
    reason:
      'Exact structured collaboration reference bound; governing validation remains required',
    recordedAt: exactDate(request.now ?? new Date()).toISOString(),
    envelope: reservation.envelope,
    use,
  };
  assertOwned();
  createPrivateFileAtomic(terminalPath, serialize(terminal));
  cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
  assertOwned();
  return inspectTerminal(terminal);
}

export function readExactConsumedCollaborationGrantUse(
  gitCommonDirectory: string,
  requestedGrantId: string,
  request: CollaborationConsumptionRequest,
): CollaborationGrantUseProjection | null {
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const transitionDigest = exactDigest(
    request.transitionDigest,
    'transition digest',
  );
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  existingStateDirectories(paths);
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    assertResidualCopiesMatch(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    if (
      terminal.state !== 'consumed' ||
      terminal.use === null ||
      !consumptionMatches(terminal.use, request, transitionDigest)
    ) {
      throw unavailableGrant(grantId);
    }
    return terminal.use;
  }
  assertNonterminalUnambiguous(paths, grantId);
  const reservedPath = statePath(paths.reserved, grantId);
  if (fs.existsSync(reservedPath)) {
    const reservation = readReservation(reservedPath, grantId);
    if (reservation.transitionDigest !== transitionDigest) {
      throw unavailableGrant(grantId);
    }
    const assignment = assertGrantedAssignment(
      request.assignment,
      reservation.envelope,
    );
    const contentAdmission = assertContentAdmission(
      request.contentAdmission,
      reservation.envelope.payload.lifecyclePhase,
    );
    assertDirectHumanAttestationReference(
      request.directHumanReviewAttestation ?? null,
      assignment,
      reservation.envelope,
      transitionDigest,
      {
        kind: contentAdmission.kind,
        nodeId: contentAdmission.nodeId,
        resultDigest: contentAdmission.resultDigest,
      },
    );
    return null;
  }
  const availablePath = statePath(paths.available, grantId);
  if (fs.existsSync(availablePath)) {
    readAvailable(availablePath, grantId);
  }
  return null;
}

/**
 * Recompute the portable, trust-relevant meaning of a consumed collaboration
 * grant without reading Git-common-dir bearer state. Local and CI callers must
 * supply independently derived assignment and current content admission facts;
 * references stored in the use projection never validate themselves.
 */
export function validateCollaborationGrantUseProjection(
  value: unknown,
  options: CollaborationGrantUseValidationOptions,
): CollaborationGrantUseProjection {
  if (!isRecord(value)) {
    throw invalidUse();
  }
  let envelope: CollaborationGrantEnvelope;
  let use: CollaborationGrantUseProjection;
  try {
    envelope = parseCollaborationGrantEnvelope(
      `${JSON.stringify(value.envelope)}\n`,
    );
    use = assertStoredUse(value, envelope);
    validateCollaborationGrantEnvelope(envelope, options.policy, {
      now: exactDate(options.now),
      expected: options.expectedBinding,
      verifier: options.verifier,
      allowExpired: true,
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      String(error.code).startsWith('COLLABORATION_SIGNATURE')
    ) {
      throw error;
    }
    throw invalidUse();
  }
  const transitionDigest = exactDigest(
    options.transitionDigest,
    'transition digest',
  );
  const expectedAssignment = assertGrantedAssignment(
    options.expectedAssignment,
    envelope,
  );
  const contentAdmission = assertContentAdmission(
    options.contentAdmission,
    envelope.payload.lifecyclePhase,
  );
  if (
    use.transitionDigest !== transitionDigest ||
    JSON.stringify(use.assignment) !== JSON.stringify(expectedAssignment) ||
    JSON.stringify(use.structuredContent) !==
      JSON.stringify({
        kind: contentAdmission.kind,
        nodeId: contentAdmission.nodeId,
        resultDigest: contentAdmission.resultDigest,
      })
  ) {
    throw invalidUse();
  }
  if (envelope.payload.degradedForm === 'direct-human-review') {
    if (!use.directHumanReviewAttestation) {
      throw invalidUse();
    }
    try {
      validateDirectHumanReviewAttestation(use.directHumanReviewAttestation, {
        now: exactDate(options.now),
        grantEnvelope: envelope,
        policy: options.policy,
        verifier: options.verifier,
        transitionDigest,
        reviewNodeId: contentAdmission.nodeId,
        reviewResultDigest: contentAdmission.resultDigest,
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        String(error.code).startsWith('COLLABORATION_SIGNATURE')
      ) {
        throw error;
      }
      throw invalidUse();
    }
  }
  return use;
}

/**
 * Validate the complete tracked closure, not merely one projection. A locally
 * consumed grant is still cooperative common-dir state; history-wide one-use
 * follows only when the governing transition passes every projected use
 * through this aggregate validator.
 */
export function validateCollaborationGrantUseSet(
  entries: readonly CollaborationGrantUseValidationEntry[],
): readonly CollaborationGrantUseProjection[] {
  if (!Array.isArray(entries)) {
    throw invalidUse();
  }
  const uses = entries.map(({ value, options }) =>
    validateCollaborationGrantUseProjection(value, options),
  );
  const grantIds = new Set<string>();
  const envelopeDigests = new Set<string>();
  for (const use of uses) {
    if (
      grantIds.has(use.grantId) ||
      envelopeDigests.has(use.signedEnvelopeDigest)
    ) {
      throw invalidUse();
    }
    grantIds.add(use.grantId);
    envelopeDigests.add(use.signedEnvelopeDigest);
  }
  return Object.freeze(uses);
}

export function failCollaborationReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedTransitionDigest: string,
  reason: string,
  now: Date = new Date(),
): CollaborationGrantInspection {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    failCollaborationReservationUnderLifecycleLock(
      gitCommonDirectory,
      requestedGrantId,
      requestedTransitionDigest,
      reason,
      now,
      assertOwned,
    ),
  );
}

export function failCollaborationReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedTransitionDigest: string,
  reason: string,
  now: Date,
  assertOwned: () => void,
): CollaborationGrantInspection {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const transitionDigest = exactDigest(
    requestedTransitionDigest,
    'transition digest',
  );
  const terminalReason = nonEmpty(reason, 'failure reason');
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    if (
      terminal.state !== 'failed' ||
      terminal.transitionDigest !== transitionDigest ||
      terminal.reason !== terminalReason
    ) {
      throw unavailableGrant(grantId);
    }
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    return inspectTerminal(terminal);
  }
  assertNonterminalUnambiguous(paths, grantId);
  const reservation = readReservation(
    statePath(paths.reserved, grantId),
    grantId,
  );
  if (reservation.transitionDigest !== transitionDigest) {
    throw unavailableGrant(grantId);
  }
  const terminal: CollaborationTerminalRecord = {
    schemaVersion: 1,
    state: 'failed',
    grantId,
    transitionDigest,
    reason: terminalReason,
    recordedAt: exactDate(now).toISOString(),
    envelope: reservation.envelope,
    use: null,
  };
  assertOwned();
  createPrivateFileAtomic(terminalPath, serialize(terminal));
  cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
  assertOwned();
  return inspectTerminal(terminal);
}

export function revokeCollaborationGrant(
  cwd: string,
  requestedGrantId: string,
  options: HumanRevocationOptions,
): CollaborationGrantInspection {
  const repository = discoverRepository(cwd);
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    assertOwned();
    const target = readCollaborationRevocationTarget(
      paths,
      grantId,
      assertOwned,
    );
    const payload = target.envelope.payload;
    const historicalPolicy = loadPolicyAtCommit(
      repository.repositoryRoot,
      payload.baselineCommit,
    );
    const historicalVerifier =
      options.verifier ??
      createInteractiveSshSigner(repository.repositoryRoot, historicalPolicy);
    validateCollaborationGrantEnvelope(target.envelope, historicalPolicy, {
      now: exactDate(options.now ?? new Date()),
      expected: bindingFromPayload(payload),
      verifier: historicalVerifier,
      allowExpired: true,
    });
    let audit: {
      externalAuditRoot: string;
      repositoryId: ReturnType<typeof deriveAuthorityAuditRepositoryId>;
    } | null = null;
    if (payload.taskId !== null) {
      const mandate = inspectTaskMandate(
        repository.repositoryRoot,
        payload.taskId,
        {
          now: options.now,
          signer: options.verifier ?? options.signer,
        },
      );
      if (
        mandate.legacyReadOnly ||
        mandate.changeId !== payload.changeId ||
        mandate.externalAuditRoot === undefined
      ) {
        throw workflowError(
          'HUMAN_REVOCATION_BINDING_INVALID',
          'Collaboration revocation task mandate binding is unavailable or different.',
          ExitCode.guard,
        );
      }
      audit = {
        externalAuditRoot: mandate.externalAuditRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
      };
    }
    const authorization = authorizeHumanRevocation(
      repository.repositoryRoot,
      {
        subjectKind: 'collaboration-grant',
        grantId,
        grantDigest: digestHumanRevocationSubject(
          canonicalCollaborationGrantEnvelope(target.envelope),
        ),
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        changeId: payload.changeId,
        taskId: payload.taskId,
        workflowId: null,
        audit,
      },
      options,
      path.join(paths.revocationAuthorizations, `${grantId}.json`),
      target.authorization,
    );
    return terminallyRevokeCollaborationGrant(
      paths,
      target,
      authorization,
      assertOwned,
    );
  });
}

function readCollaborationRevocationTarget(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
  assertOwned: () => void,
): {
  state: CollaborationGrantInspection['state'];
  envelope: CollaborationGrantEnvelope;
  transitionDigest: string | null;
  reason: string | null;
  authorization: HumanRevocationAuthorization | null;
} {
  ensureStoreDirectories(paths);
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    return {
      state: terminal.state,
      envelope: terminal.envelope,
      transitionDigest: terminal.transitionDigest,
      reason: terminal.reason,
      authorization: terminal.revocationAuthorization ?? null,
    };
  }
  assertNonterminalUnambiguous(paths, grantId);
  const availablePath = statePath(paths.available, grantId);
  const reservedPath = statePath(paths.reserved, grantId);
  const available = fs.existsSync(availablePath)
    ? readAvailable(availablePath, grantId)
    : undefined;
  const reservation = fs.existsSync(reservedPath)
    ? readReservationOrInterrupted(reservedPath, grantId)
    : undefined;
  if (!available && !reservation) throw grantNotFound(grantId);
  const envelope = available ?? reservation?.envelope;
  if (
    !envelope ||
    (available &&
      reservation &&
      canonicalCollaborationGrantEnvelope(available) !==
        canonicalCollaborationGrantEnvelope(reservation.envelope))
  ) {
    throw ambiguousGrant(grantId);
  }
  return {
    state: reservation ? 'reserved' : 'available',
    envelope,
    transitionDigest: reservation?.transitionDigest ?? null,
    reason: null,
    authorization: null,
  };
}

function terminallyRevokeCollaborationGrant(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  target: ReturnType<typeof readCollaborationRevocationTarget>,
  rawAuthorization: HumanRevocationAuthorization,
  assertOwned: () => void,
): CollaborationGrantInspection {
  const authorization = assertHumanRevocationAuthorization(rawAuthorization);
  const grantId = target.envelope.payload.grantId;
  if (
    authorization.payload.subjectKind !== 'collaboration-grant' ||
    authorization.payload.grantId !== grantId
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_CONFLICT',
      'Collaboration revocation authorization is bound elsewhere.',
      ExitCode.conflict,
    );
  }
  if (target.state === 'revoked') {
    if (
      target.reason !== authorization.payload.reason ||
      target.authorization === null ||
      canonicalHumanRevocationAuthorization(target.authorization) !==
        canonicalHumanRevocationAuthorization(authorization)
    ) {
      throw workflowError(
        'HUMAN_REVOCATION_CONFLICT',
        'Collaboration grant already has a different revocation tombstone.',
        ExitCode.conflict,
      );
    }
    return inspectTerminal(
      readTerminal(statePath(paths.terminal, grantId), grantId),
    );
  }
  if (target.state !== 'available' && target.state !== 'reserved') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Only active collaboration authority can be revoked.',
      ExitCode.guard,
    );
  }
  const terminal: CollaborationTerminalRecord = {
    schemaVersion: 1,
    state: 'revoked',
    grantId,
    transitionDigest: target.transitionDigest,
    reason: authorization.payload.reason,
    recordedAt: authorization.payload.revokedAt,
    envelope: target.envelope,
    use: null,
    revocationAuthorization: authorization,
  };
  assertOwned();
  createPrivateFileAtomic(
    statePath(paths.terminal, grantId),
    serialize(terminal),
  );
  cleanupNonterminal(paths, grantId, target.envelope, target.transitionDigest);
  assertOwned();
  return inspectTerminal(terminal);
}

export function inspectCollaborationGrants(
  gitCommonDirectory: string,
  requestedGrantId?: string,
): CollaborationGrantInspection[] {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    inspectCollaborationGrantsUnderLifecycleLock(
      gitCommonDirectory,
      requestedGrantId,
      assertOwned,
    ),
  );
}

export function inspectCollaborationGrantsUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string | undefined,
  assertOwned: () => void,
): CollaborationGrantInspection[] {
  assertOwned();
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  assertOwned();
  const grantId = requestedGrantId
    ? assertCollaborationGrantId(requestedGrantId)
    : undefined;
  const directories = existingStateDirectories(paths);
  const grantIds = grantId
    ? [grantId]
    : [
        ...new Set(
          directories.flatMap(({ directory }) => listGrantIds(directory)),
        ),
      ].sort();
  const inspected = grantIds.map((id) => inspectOne(paths, id));
  if (grantId && inspected[0] === undefined) {
    throw grantNotFound(grantId);
  }
  const results = inspected.filter(
    (entry): entry is CollaborationGrantInspection => entry !== undefined,
  );
  assertOwned();
  return results;
}

function inspectOne(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
): CollaborationGrantInspection | undefined {
  const availablePath = statePath(paths.available, grantId);
  const reservedPath = statePath(paths.reserved, grantId);
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    assertResidualCopiesMatch(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    return inspectTerminal(terminal);
  }
  assertNonterminalUnambiguous(paths, grantId);
  if (fs.existsSync(availablePath)) {
    return inspectEnvelope(readAvailable(availablePath, grantId), 'available');
  }
  if (fs.existsSync(reservedPath)) {
    const reservation = readReservation(reservedPath, grantId);
    return {
      ...inspectEnvelope(reservation.envelope, 'reserved'),
      transitionDigest: reservation.transitionDigest,
    };
  }
  return undefined;
}

function inspectEnvelope(
  envelope: CollaborationGrantEnvelope,
  state: 'available' | 'reserved',
): CollaborationGrantInspection {
  return deepFreeze({
    grantId: envelope.payload.grantId,
    state,
    changeId: envelope.payload.changeId,
    taskId: envelope.payload.taskId,
    lifecyclePhase: envelope.payload.lifecyclePhase,
    targetDigest: envelope.payload.targetDigest,
    degradedForm: envelope.payload.degradedForm,
    issuedAt: envelope.payload.issuedAt,
    expiresAt: envelope.payload.expiresAt,
    signer: envelope.payload.signer,
  });
}

function inspectTerminal(
  terminal: CollaborationTerminalRecord,
): CollaborationGrantInspection {
  return deepFreeze({
    ...inspectEnvelope(terminal.envelope, 'available'),
    state: terminal.state,
    ...(terminal.transitionDigest
      ? { transitionDigest: terminal.transitionDigest }
      : {}),
    terminalReason: terminal.reason,
    ...(terminal.use ? { use: terminal.use } : {}),
  });
}

function readAvailable(
  filePath: string,
  grantId: string,
): CollaborationGrantEnvelope {
  const envelope = parseCollaborationGrantEnvelope(readPrivateFile(filePath));
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return envelope;
}

function readReservation(
  filePath: string,
  grantId: string,
): CollaborationReservationRecord {
  const value = parseRecord(readPrivateFile(filePath));
  const envelope = parseCollaborationGrantEnvelope(
    `${JSON.stringify(value.envelope)}\n`,
  );
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'transitionDigest',
      'repositoryRoot',
      'reservedAt',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    value.state !== 'reserved' ||
    value.grantId !== grantId ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    typeof value.reservedAt !== 'string' ||
    !isExactTimestamp(value.reservedAt) ||
    Date.parse(value.reservedAt) < Date.parse(envelope.payload.issuedAt) ||
    Date.parse(value.reservedAt) > Date.parse(envelope.payload.expiresAt) ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot)
  ) {
    throw ambiguousGrant(grantId);
  }
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return deepFreeze({
    ...value,
    envelope,
  } as CollaborationReservationRecord);
}

function readReservationOrInterrupted(
  filePath: string,
  grantId: string,
): {
  envelope: CollaborationGrantEnvelope;
  transitionDigest?: string;
} {
  try {
    return readReservation(filePath, grantId);
  } catch {
    try {
      return { envelope: readAvailable(filePath, grantId) };
    } catch {
      throw ambiguousGrant(grantId);
    }
  }
}

function readTerminal(
  filePath: string,
  grantId: string,
): CollaborationTerminalRecord {
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
      'transitionDigest',
      'reason',
      'recordedAt',
      'envelope',
      'use',
      ...(hasAuthorization ? ['revocationAuthorization'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    !['revoked', 'consumed', 'failed', 'expired'].includes(
      String(value.state),
    ) ||
    value.grantId !== grantId ||
    (value.transitionDigest !== null &&
      (typeof value.transitionDigest !== 'string' ||
        !DIGEST.test(value.transitionDigest))) ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length === 0 ||
    typeof value.recordedAt !== 'string' ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseCollaborationGrantEnvelope(
    `${JSON.stringify(value.envelope)}\n`,
  );
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  let use: CollaborationGrantUseProjection | null = null;
  if (value.state === 'consumed') {
    use = assertStoredUse(value.use, envelope);
  } else if (value.use !== null) {
    throw ambiguousGrant(grantId);
  }
  let revocationAuthorization: HumanRevocationAuthorization | undefined;
  if (hasAuthorization) {
    revocationAuthorization = assertHumanRevocationAuthorization(
      value.revocationAuthorization,
    );
    if (
      value.state !== 'revoked' ||
      revocationAuthorization.payload.subjectKind !== 'collaboration-grant' ||
      revocationAuthorization.payload.grantId !== grantId ||
      revocationAuthorization.payload.reason !== value.reason ||
      revocationAuthorization.payload.revokedAt !== value.recordedAt
    ) {
      throw ambiguousGrant(grantId);
    }
  }
  return deepFreeze({
    ...value,
    envelope,
    use,
    ...(revocationAuthorization ? { revocationAuthorization } : {}),
  } as CollaborationTerminalRecord);
}

function assertStoredUse(
  value: unknown,
  envelope: CollaborationGrantEnvelope,
): CollaborationGrantUseProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'grantId',
      'signedEnvelopeDigest',
      'transitionDigest',
      'reservedAt',
      'lifecyclePhase',
      'targetDigest',
      'degradedForm',
      'authorizedEffect',
      'assignment',
      'structuredContent',
      'contentAuthority',
      'directHumanReviewAttestation',
      'retainedObligations',
      'replayScope',
      'residuals',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    value.grantId !== envelope.payload.grantId ||
    value.signedEnvelopeDigest !== collaborationGrantEnvelopeDigest(envelope) ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    typeof value.reservedAt !== 'string' ||
    !isExactTimestamp(value.reservedAt) ||
    Date.parse(value.reservedAt) < Date.parse(envelope.payload.issuedAt) ||
    Date.parse(value.reservedAt) > Date.parse(envelope.payload.expiresAt) ||
    value.lifecyclePhase !== envelope.payload.lifecyclePhase ||
    value.targetDigest !== envelope.payload.targetDigest ||
    value.degradedForm !== envelope.payload.degradedForm ||
    value.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
    value.contentAuthority !== 'reference-only-requires-governing-validator' ||
    !Array.isArray(value.retainedObligations) ||
    JSON.stringify(value.retainedObligations) !==
      JSON.stringify(COLLABORATION_GRANT_RETAINED_OBLIGATIONS) ||
    value.replayScope !== COLLABORATION_GRANT_REPLAY_SCOPE ||
    !Array.isArray(value.residuals) ||
    JSON.stringify(value.residuals) !==
      JSON.stringify(COLLABORATION_GRANT_RESIDUALS) ||
    canonicalCollaborationGrantEnvelope(
      parseCollaborationGrantEnvelope(`${JSON.stringify(value.envelope)}\n`),
    ) !== canonicalCollaborationGrantEnvelope(envelope)
  ) {
    throw ambiguousGrant(envelope.payload.grantId);
  }
  const assignment = assertGrantedAssignment(value.assignment, envelope);
  const structuredContent = assertStructuredContent(
    value.structuredContent,
    envelope.payload.lifecyclePhase,
  );
  const directHumanReviewAttestation = assertDirectHumanAttestationReference(
    value.directHumanReviewAttestation,
    assignment,
    envelope,
    value.transitionDigest,
    structuredContent,
  );
  return deepFreeze({
    schemaVersion: 1,
    grantId: envelope.payload.grantId,
    signedEnvelopeDigest: collaborationGrantEnvelopeDigest(envelope),
    transitionDigest: value.transitionDigest,
    reservedAt: value.reservedAt,
    lifecyclePhase: envelope.payload.lifecyclePhase,
    targetDigest: envelope.payload.targetDigest,
    degradedForm: envelope.payload.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    assignment,
    structuredContent,
    contentAuthority: 'reference-only-requires-governing-validator',
    directHumanReviewAttestation,
    retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
    residuals: COLLABORATION_GRANT_RESIDUALS,
    envelope,
  });
}

function assertGrantedAssignment(
  value: unknown,
  envelope: CollaborationGrantEnvelope,
): CollaborationGrantedAssignmentRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'role',
      'providerId',
      'sessionId',
      'targetDigest',
      'requiredIndependence',
      'achievedIndependence',
      'providerIndependent',
      'sessionIndependent',
      'engineSpawned',
      'orchestration',
      'grantId',
      'degradedForm',
      'authorizedEffect',
      'author',
      'participant',
      'callableProviderIds',
      'directHumanReviewAttestationDigest',
    ]) ||
    value.role !== envelope.payload.rolePair.conflictingRole ||
    value.targetDigest !== envelope.payload.targetDigest ||
    value.requiredIndependence !== 'provider-independent' ||
    value.providerIndependent !== false ||
    value.grantId !== envelope.payload.grantId ||
    value.degradedForm !== envelope.payload.degradedForm ||
    value.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT
  ) {
    throw invalidUse();
  }
  const common = {
    role: envelope.payload.rolePair.conflictingRole,
    targetDigest: value.targetDigest,
    requiredIndependence: 'provider-independent' as const,
    providerIndependent: false as const,
    grantId: value.grantId,
    degradedForm: envelope.payload.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    author: assertRecordedParticipant(value.author),
    participant: assertRecordedParticipant(value.participant),
    callableProviderIds: assertCallableProviderIds(value.callableProviderIds),
  };
  if (
    envelope.payload.degradedForm === 'same-provider-fresh-session' &&
    envelope.payload.availableActor.kind === 'provider' &&
    value.providerId === envelope.payload.availableActor.providerId &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.achievedIndependence === 'session-independent' &&
    value.sessionIndependent === true &&
    value.engineSpawned === true &&
    value.orchestration === 'engine-spawned-provider'
  ) {
    if (
      common.author.providerId !== envelope.payload.availableActor.providerId ||
      common.participant.providerId !==
        envelope.payload.availableActor.providerId ||
      common.participant.sessionId !== value.sessionId ||
      common.participant.engineSpawned !== true ||
      common.participant.identityAssurance !==
        envelope.payload.availableActor.assurance ||
      typeof common.author.sessionId !== 'string' ||
      common.author.sessionId === common.participant.sessionId ||
      JSON.stringify(common.callableProviderIds) !==
        JSON.stringify([envelope.payload.availableActor.providerId]) ||
      value.directHumanReviewAttestationDigest !== null
    ) {
      throw invalidUse();
    }
    return deepFreeze({
      ...common,
      providerId: envelope.payload.availableActor.providerId,
      sessionId: value.sessionId,
      achievedIndependence: 'session-independent',
      sessionIndependent: true,
      engineSpawned: true,
      orchestration: 'engine-spawned-provider',
      directHumanReviewAttestationDigest: null,
    });
  }
  const expectedOrchestration =
    envelope.payload.degradedForm === 'caller-supplied'
      ? 'caller-supplied'
      : 'direct-human-review';
  if (
    envelope.payload.degradedForm !== 'same-provider-fresh-session' &&
    value.providerId === null &&
    value.sessionId === null &&
    value.achievedIndependence === 'none' &&
    value.sessionIndependent === false &&
    value.engineSpawned === false &&
    value.orchestration === expectedOrchestration
  ) {
    const expectedPrincipal =
      envelope.payload.availableActor.kind === 'caller'
        ? envelope.payload.availableActor.callerId
        : envelope.payload.availableActor.kind === 'direct-human'
          ? envelope.payload.availableActor.identity
          : undefined;
    if (
      common.participant.providerId !== null ||
      common.participant.sessionId !== null ||
      common.participant.engineSpawned !== false ||
      common.participant.principalId !== expectedPrincipal ||
      common.callableProviderIds.length !== 0 ||
      (envelope.payload.degradedForm === 'caller-supplied'
        ? value.directHumanReviewAttestationDigest !== null ||
          common.participant.identityAssurance !==
            envelope.payload.availableActor.assurance
        : typeof value.directHumanReviewAttestationDigest !== 'string' ||
          !DIGEST.test(value.directHumanReviewAttestationDigest) ||
          common.participant.identityAssurance !== 'maintainer-signed')
    ) {
      throw invalidUse();
    }
    return deepFreeze({
      ...common,
      providerId: null,
      sessionId: null,
      achievedIndependence: 'none',
      sessionIndependent: false,
      engineSpawned: false,
      orchestration: expectedOrchestration,
      directHumanReviewAttestationDigest:
        value.directHumanReviewAttestationDigest as string | null,
    });
  }
  throw invalidUse();
}

function assertRecordedParticipant(
  value: unknown,
): CollaborationParticipantRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    ![null, 'codex', 'claude'].includes(value.providerId as null | string) ||
    (value.sessionId !== null &&
      (typeof value.sessionId !== 'string' || value.sessionId.length === 0)) ||
    (value.principalId !== null &&
      (typeof value.principalId !== 'string' ||
        value.principalId.length === 0)) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw invalidUse();
  }
  return deepFreeze({
    providerId: value.providerId as 'codex' | 'claude' | null,
    sessionId: value.sessionId as string | null,
    principalId: value.principalId as string | null,
    identityAssurance: value.identityAssurance as
      | 'self-declared'
      | 'runtime-hint'
      | 'adapter-assigned'
      | 'maintainer-signed',
    engineSpawned: value.engineSpawned,
  });
}

function assertCallableProviderIds(
  value: unknown,
): readonly ('codex' | 'claude')[] {
  if (
    !Array.isArray(value) ||
    value.some((providerId) => !['codex', 'claude'].includes(providerId)) ||
    value.length !== new Set(value).size ||
    JSON.stringify(value) !== JSON.stringify([...value].sort())
  ) {
    throw invalidUse();
  }
  return Object.freeze([...value] as ('codex' | 'claude')[]);
}

function assertDirectHumanAttestationReference(
  value: unknown,
  assignment: CollaborationGrantedAssignmentRecord,
  envelope: CollaborationGrantEnvelope,
  transitionDigest: unknown,
  structuredContent: CollaborationStructuredContent,
): DirectHumanReviewAttestation | null {
  if (envelope.payload.degradedForm !== 'direct-human-review') {
    if (
      value !== null ||
      assignment.directHumanReviewAttestationDigest !== null
    ) {
      throw invalidUse();
    }
    return null;
  }
  if (
    value === null ||
    assignment.directHumanReviewAttestationDigest === null
  ) {
    throw invalidUse();
  }
  const parsed = parseDirectHumanReviewAttestation(
    `${JSON.stringify(value)}\n`,
  );
  if (
    parsed.payload.grantId !== envelope.payload.grantId ||
    parsed.payload.signedEnvelopeDigest !==
      collaborationGrantEnvelopeDigest(envelope) ||
    parsed.payload.transitionDigest !== transitionDigest ||
    parsed.payload.targetDigest !== envelope.payload.targetDigest ||
    parsed.payload.reviewNodeId !== structuredContent.nodeId ||
    parsed.payload.reviewResultDigest !== structuredContent.resultDigest ||
    directHumanReviewAttestationDigest(parsed) !==
      assignment.directHumanReviewAttestationDigest
  ) {
    throw invalidUse();
  }
  return parsed;
}

function assertStructuredContent(
  value: unknown,
  phase: CollaborationLifecyclePhase,
): CollaborationStructuredContent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'nodeId', 'resultDigest']) ||
    value.kind !== phase ||
    typeof value.nodeId !== 'string' ||
    !DIGEST.test(value.nodeId) ||
    typeof value.resultDigest !== 'string' ||
    !DIGEST.test(value.resultDigest)
  ) {
    throw invalidUse();
  }
  return deepFreeze({
    kind: value.kind,
    nodeId: value.nodeId,
    resultDigest: value.resultDigest,
  } as CollaborationStructuredContent);
}

function assertContentAdmission(
  value: unknown,
  phase: CollaborationLifecyclePhase,
): CollaborationContentAdmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'nodeId', 'resultDigest', 'current']) ||
    value.current !== true
  ) {
    throw invalidUse();
  }
  const structured = assertStructuredContent(
    {
      kind: value.kind,
      nodeId: value.nodeId,
      resultDigest: value.resultDigest,
    },
    phase,
  );
  return deepFreeze({ ...structured, current: true });
}

function consumptionMatches(
  use: CollaborationGrantUseProjection,
  request: CollaborationConsumptionRequest,
  transitionDigest: string,
): boolean {
  try {
    const assignment = assertGrantedAssignment(
      request.assignment,
      use.envelope,
    );
    const contentAdmission = assertContentAdmission(
      request.contentAdmission,
      use.lifecyclePhase,
    );
    const structuredContent: CollaborationStructuredContent = {
      kind: contentAdmission.kind,
      nodeId: contentAdmission.nodeId,
      resultDigest: contentAdmission.resultDigest,
    };
    const directHumanReviewAttestation = assertDirectHumanAttestationReference(
      request.directHumanReviewAttestation ?? null,
      assignment,
      use.envelope,
      transitionDigest,
      structuredContent,
    );
    return (
      use.transitionDigest === transitionDigest &&
      JSON.stringify(use.assignment) === JSON.stringify(assignment) &&
      JSON.stringify(use.structuredContent) ===
        JSON.stringify(structuredContent) &&
      JSON.stringify(use.directHumanReviewAttestation) ===
        JSON.stringify(directHumanReviewAttestation)
    );
  } catch {
    return false;
  }
}

function cleanupNonterminal(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
  expected: CollaborationGrantEnvelope,
  expectedTransitionDigest: string | null,
): void {
  for (const directory of [paths.available, paths.reserved]) {
    const target = statePath(directory, grantId);
    if (!fs.existsSync(target)) {
      continue;
    }
    const residual =
      directory === paths.available
        ? { envelope: readAvailable(target, grantId) }
        : readReservationOrInterrupted(target, grantId);
    const observed = residual.envelope;
    if (
      canonicalCollaborationGrantEnvelope(observed) !==
        canonicalCollaborationGrantEnvelope(expected) ||
      (directory === paths.reserved &&
        (residual.transitionDigest === undefined
          ? expectedTransitionDigest !== null
          : residual.transitionDigest !== expectedTransitionDigest))
    ) {
      throw ambiguousGrant(grantId);
    }
    fs.unlinkSync(target);
    fsyncDirectory(directory);
  }
}

function assertResidualCopiesMatch(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
  expected: CollaborationGrantEnvelope,
  expectedTransitionDigest: string | null,
): void {
  for (const directory of [paths.available, paths.reserved]) {
    const target = statePath(directory, grantId);
    if (!fs.existsSync(target)) {
      continue;
    }
    const residual =
      directory === paths.available
        ? { envelope: readAvailable(target, grantId) }
        : readReservationOrInterrupted(target, grantId);
    const observed = residual.envelope;
    if (
      canonicalCollaborationGrantEnvelope(observed) !==
        canonicalCollaborationGrantEnvelope(expected) ||
      (directory === paths.reserved &&
        (residual.transitionDigest === undefined
          ? expectedTransitionDigest !== null
          : residual.transitionDigest !== expectedTransitionDigest))
    ) {
      throw ambiguousGrant(grantId);
    }
  }
}

function ensureStoreDirectories(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
): void {
  for (const directory of [
    paths.root,
    paths.available,
    paths.reserved,
    paths.terminal,
    paths.revocationAuthorizations,
  ]) {
    const existed = fs.existsSync(directory);
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
    const stats = fs.lstatSync(directory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw unsafeStore();
    }
    if (!existed) {
      fsyncDirectory(path.dirname(directory));
    }
    if (directory !== paths.root) {
      for (const entry of fs.readdirSync(directory)) {
        if (!STATE_FILE.test(entry)) {
          throw unsafeStore();
        }
      }
    }
  }
}

function existingStateDirectories(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
): Array<{ directory: string }> {
  return [paths.available, paths.reserved, paths.terminal].flatMap(
    (directory) => {
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
    },
  );
}

function assertNoState(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
): void {
  if (
    [paths.available, paths.reserved, paths.terminal].some((directory) =>
      fs.existsSync(statePath(directory, grantId)),
    )
  ) {
    throw unavailableGrant(grantId);
  }
}

function assertNonterminalUnambiguous(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
): void {
  const states = [paths.available, paths.reserved].filter((directory) =>
    fs.existsSync(statePath(directory, grantId)),
  );
  if (states.length > 1) {
    throw ambiguousGrant(grantId);
  }
}

function listGrantIds(directory: string): string[] {
  return fs.readdirSync(directory).map((entry) => {
    if (!STATE_FILE.test(entry)) {
      throw unsafeStore();
    }
    return assertCollaborationGrantId(entry.slice(0, -'.json'.length));
  });
}

function statePath(directory: string, grantId: string): string {
  return path.join(directory, `${assertCollaborationGrantId(grantId)}.json`);
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    assertPrivateDescriptor(descriptor);
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
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    assertPrivateDescriptor(descriptor);
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
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
    assertPrivateDescriptor(descriptor);
    return fs.readFileSync(descriptor, 'utf8');
  } catch {
    throw unsafeStore();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function assertPrivateDescriptor(descriptor: number): void {
  const stats = fs.fstatSync(descriptor);
  if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) {
    throw unsafeStore();
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || raw !== `${JSON.stringify(value)}\n`) {
      throw new Error('not canonical');
    }
    return value;
  } catch {
    throw unsafeStore();
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((entry, index) => entry === sorted[index])
  );
}

function exactDigest(value: string, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw workflowError(
      'COLLABORATION_GRANT_USE_INVALID',
      `Collaboration grant ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw invalidUse();
  }
  return date;
}

function isExactTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'COLLABORATION_GRANT_INVALID',
      'The exact baseline does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

function exactRepositoryCommit(
  repositoryRoot: string,
  requested: string,
): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(requested)) {
    throw bindingMismatch();
  }
  const resolved = runGit(repositoryRoot, [
    'rev-parse',
    `${requested}^{commit}`,
  ]).trim();
  if (resolved !== requested) {
    throw bindingMismatch();
  }
  return resolved;
}

function nonEmpty(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 500
  ) {
    throw workflowError(
      'COLLABORATION_GRANT_USE_INVALID',
      `Collaboration grant ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidUse() {
  return workflowError(
    'COLLABORATION_GRANT_USE_INVALID',
    'Collaboration grant use requires exact role assignment and structured content.',
    ExitCode.guard,
  );
}

function bindingMismatch() {
  return workflowError(
    'COLLABORATION_GRANT_BINDING_MISMATCH',
    'Collaboration reservation facts do not match the exact repository baseline.',
    ExitCode.guard,
  );
}

function unavailableGrant(grantId: string) {
  return workflowError(
    'COLLABORATION_GRANT_UNAVAILABLE',
    `Collaboration grant ${grantId} is unavailable for this transition.`,
    ExitCode.conflict,
  );
}

function grantNotFound(grantId: string) {
  return workflowError(
    'COLLABORATION_GRANT_NOT_FOUND',
    `Collaboration grant ${grantId} does not exist in local state.`,
    ExitCode.guard,
  );
}

function ambiguousGrant(grantId: string) {
  return workflowError(
    'COLLABORATION_GRANT_STATE_AMBIGUOUS',
    `Collaboration grant ${grantId} has ambiguous or malformed local state.`,
    ExitCode.staleState,
  );
}

function unsafeStore() {
  return workflowError(
    'COLLABORATION_GRANT_STORE_UNSAFE',
    'Collaboration grant storage is malformed or unsafe.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
