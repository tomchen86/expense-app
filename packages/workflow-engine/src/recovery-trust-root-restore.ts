import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import type { PersistenceHumanSignatureVerifier } from './intervention-control-persistence.ts';
import {
  assertRecoveryAuthorityDomain,
  verifyRecoveryAuthorityDescriptor,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
  type RecoveryAuthorityImportBoundary,
  type RecoveryAuthoritySha256Digest,
} from './recovery-authority.ts';

/**
 * Recovery substrate only. This module does not inspect HEAD, load the tracked
 * maintainer policy, replace repository files, or wire the operational root
 * into a launcher. A future sealed bootstrap may consume the verified active
 * root returned by readRecoveryOperationalTrustRootActive().
 */
export const RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE =
  'HARNESS_RECOVERY_RESTORE_OPERATIONAL_TRUST_ROOT_V1';
export const RECOVERY_TRUST_ROOT_RESTORE_TTL_MS = 5 * 60 * 1000;
export const MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES = 1024 * 1024;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GRANT_ID = /^trust-root-restore-[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@+:/-]{0,511}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SSH_PUBLIC_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
const POINTER_FILE = /^[0-9]{20}\.json$/;
const ROOT_FILE = /^[0-9a-f]{64}\.json$/;
const OPERATION_DIRECTORY = /^[0-9a-f]{64}$/;
const PREPARATION =
  /^\.([a-z0-9][a-z0-9.-]*\.json)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.prepare$/;

const ROOT_PAYLOAD_KEYS = [
  'createdAt',
  'generation',
  'kind',
  'purpose',
  'repositoryId',
  'signatureNamespace',
  'trustedSigners',
] as const;
const ROOT_KEYS = [...ROOT_PAYLOAD_KEYS, 'rootDigest'] as const;
const SIGNER_KEYS = ['fingerprint', 'identity', 'publicKey'] as const;
const UNSIGNED_GRANT_KEYS = [
  'authorityDescriptorDigest',
  'authorityGeneration',
  'expectedActivePointerDigest',
  'expectedGeneration',
  'expiresAt',
  'externalAuditRoot',
  'humanSigner',
  'issuedAt',
  'kind',
  'oneShot',
  'operation',
  'recoveryRuntimeDigest',
  'replacementGeneration',
  'replacementRootDigest',
  'repositoryId',
  'signerFingerprint',
  'uses',
] as const;
const GRANT_KEYS = [...UNSIGNED_GRANT_KEYS, 'grantId'] as const;
const ENVELOPE_KEYS = ['payload', 'replacement', 'signature'] as const;
const POINTER_KEYS = [
  'activatedAt',
  'authorityDescriptorDigest',
  'authorityGeneration',
  'envelopeDigest',
  'generation',
  'grantId',
  'kind',
  'pointerDigest',
  'previousPointerDigest',
  'repositoryId',
  'rootDigest',
] as const;
const RESERVATION_KEYS = [
  'envelope',
  'envelopeDigest',
  'grantId',
  'kind',
  'reservationDigest',
  'reservedAt',
] as const;
const RECEIPT_KEYS = [
  'completedAt',
  'generation',
  'grantId',
  'kind',
  'newPointerDigest',
  'previousPointerDigest',
  'receiptDigest',
  'repositoryId',
  'rootDigest',
] as const;
const TERMINAL_KEYS = [
  'consumedAt',
  'envelopeDigest',
  'grantId',
  'kind',
  'receiptDigest',
  'state',
  'terminalDigest',
] as const;
const AUDIT_KEYS = [
  'authorityDescriptorDigest',
  'authorityGeneration',
  'envelopeDigest',
  'externalAuditRoot',
  'generation',
  'grantId',
  'humanSigner',
  'kind',
  'newPointerDigest',
  'previousPointerDigest',
  'recordDigest',
  'recordId',
  'recordedAt',
  'recoveryRuntimeDigest',
  'repositoryId',
  'rootDigest',
  'signerFingerprint',
  'terminalDigest',
] as const;
const AUDIT_ACK_KEYS = [
  'acknowledgedAt',
  'acknowledgementDigest',
  'grantId',
  'kind',
  'recordDigest',
  'recordId',
] as const;

export interface RecoveryOperationalTrustSigner {
  identity: string;
  publicKey: string;
  fingerprint: string;
}

export interface RecoveryOperationalTrustRootPayload {
  kind: 'recovery-operational-trust-root.v1';
  repositoryId: string;
  generation: number;
  purpose: 'workflow-maintainer-signatures';
  signatureNamespace: 'expense-app.workflow.maintainer-grant.v1';
  trustedSigners: RecoveryOperationalTrustSigner[];
  createdAt: string;
}

export interface RecoveryOperationalTrustRoot extends RecoveryOperationalTrustRootPayload {
  rootDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreGrantUnsignedPayload {
  kind: 'recovery-operational-trust-root-restore-grant.v1';
  operation: 'restore-operational-trust-root';
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  humanSigner: string;
  signerFingerprint: string;
  expectedGeneration: number;
  expectedActivePointerDigest: RecoveryAuthoritySha256Digest | null;
  replacementRootDigest: RecoveryAuthoritySha256Digest;
  replacementGeneration: number;
  issuedAt: string;
  expiresAt: string;
  uses: 1;
  oneShot: true;
}

export interface RecoveryOperationalTrustRootRestoreGrantPayload extends RecoveryOperationalTrustRootRestoreGrantUnsignedPayload {
  grantId: string;
}

export interface RecoveryOperationalTrustRootRestoreEnvelope {
  payload: RecoveryOperationalTrustRootRestoreGrantPayload;
  replacement: RecoveryOperationalTrustRoot;
  signature: string;
}

export interface RecoveryOperationalTrustRootPointer {
  kind: 'recovery-operational-trust-root-pointer.v1';
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  generation: number;
  rootDigest: RecoveryAuthoritySha256Digest;
  previousPointerDigest: RecoveryAuthoritySha256Digest | null;
  grantId: string;
  envelopeDigest: RecoveryAuthoritySha256Digest;
  activatedAt: string;
  pointerDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreReservation {
  kind: 'recovery-operational-trust-root-restore-reservation.v1';
  grantId: string;
  envelope: RecoveryOperationalTrustRootRestoreEnvelope;
  envelopeDigest: RecoveryAuthoritySha256Digest;
  reservedAt: string;
  reservationDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreReceipt {
  kind: 'recovery-operational-trust-root-restore-receipt.v1';
  grantId: string;
  repositoryId: string;
  generation: number;
  rootDigest: RecoveryAuthoritySha256Digest;
  previousPointerDigest: RecoveryAuthoritySha256Digest | null;
  newPointerDigest: RecoveryAuthoritySha256Digest;
  completedAt: string;
  receiptDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreTerminal {
  kind: 'recovery-operational-trust-root-restore-terminal.v1';
  state: 'consumed';
  grantId: string;
  envelopeDigest: RecoveryAuthoritySha256Digest;
  receiptDigest: RecoveryAuthoritySha256Digest;
  consumedAt: string;
  terminalDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreAuditRecord {
  kind: 'recovery-operational-trust-root-restore-audit.v1';
  recordId: RecoveryAuthoritySha256Digest;
  grantId: string;
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  humanSigner: string;
  signerFingerprint: string;
  generation: number;
  rootDigest: RecoveryAuthoritySha256Digest;
  previousPointerDigest: RecoveryAuthoritySha256Digest | null;
  newPointerDigest: RecoveryAuthoritySha256Digest;
  envelopeDigest: RecoveryAuthoritySha256Digest;
  terminalDigest: RecoveryAuthoritySha256Digest;
  recordedAt: string;
  recordDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreAuditAcknowledgement {
  kind: 'recovery-operational-trust-root-restore-audit-ack.v1';
  grantId: string;
  recordId: RecoveryAuthoritySha256Digest;
  recordDigest: RecoveryAuthoritySha256Digest;
  acknowledgedAt: string;
  acknowledgementDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryOperationalTrustRootRestoreRecord {
  state: 'reserved' | 'receipt-durable' | 'consumed' | 'audited';
  reservation: RecoveryOperationalTrustRootRestoreReservation;
  receipt: RecoveryOperationalTrustRootRestoreReceipt | null;
  terminal: RecoveryOperationalTrustRootRestoreTerminal | null;
  audit: RecoveryOperationalTrustRootRestoreAuditRecord | null;
  auditAcknowledgement: RecoveryOperationalTrustRootRestoreAuditAcknowledgement | null;
}

export type RecoveryOperationalTrustRootRestoreFaultPhase =
  | 'prepare-prefix-written'
  | 'prepare-fsynced'
  | 'reservation-published'
  | 'root-published'
  | 'pointer-published'
  | 'receipt-published'
  | 'terminal-published'
  | 'audit-published'
  | 'audit-appended'
  | 'audit-ack-published';

export interface RecoveryOperationalTrustRootRestoreDependencies {
  authorityDescriptor: RecoveryAuthorityDescriptorV1;
  authorityExpectations: RecoveryAuthorityExpectations;
  externalAuditRoot: string;
  now: Date;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
  appendAudit(record: RecoveryOperationalTrustRootRestoreAuditRecord): void;
  hooks?: {
    afterPhase(
      phase: RecoveryOperationalTrustRootRestoreFaultPhase,
      targetName: string | null,
    ): void;
  };
}

export interface RecoveryOperationalTrustRootReadDependencies {
  boundary: RecoveryAuthorityImportBoundary;
  externalAuditRoot: string;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
}

export interface RecoveryOperationalTrustRootRestoreResult {
  pointer: RecoveryOperationalTrustRootPointer;
  root: RecoveryOperationalTrustRoot;
  receipt: RecoveryOperationalTrustRootRestoreReceipt;
  record: RecoveryOperationalTrustRootRestoreRecord;
}

interface StatePaths {
  state: string;
  roots: string;
  pointers: string;
  operations: string;
}

interface OperationPaths extends StatePaths {
  operationDirectory: string;
  reservation: string;
  receipt: string;
  terminal: string;
  audit: string;
  auditAcknowledgement: string;
}

export function recoveryOperationalTrustRootDigest(
  value: RecoveryOperationalTrustRootPayload,
): RecoveryAuthoritySha256Digest {
  return canonicalDigest(normalizeRootPayload(value));
}

export function recoveryOperationalTrustRootRestoreGrantId(
  value: RecoveryOperationalTrustRootRestoreGrantUnsignedPayload,
): string {
  return `trust-root-restore-${digestHex(
    canonicalJson(normalizeUnsignedGrant(value)),
  )}`;
}

export function canonicalRecoveryOperationalTrustRootRestoreStatement(
  payloadValue: RecoveryOperationalTrustRootRestoreGrantPayload,
  replacementValue: RecoveryOperationalTrustRoot,
): string {
  const payload = normalizeGrant(payloadValue);
  const replacement = normalizeRoot(replacementValue);
  assertReplacementBinding(payload, replacement);
  return canonicalJson({
    kind: 'recovery-operational-trust-root-restore-statement.v1',
    payload,
    replacement,
  });
}

export function executeRecoveryOperationalTrustRootRestore(
  externalEnvelopePath: string,
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): RecoveryOperationalTrustRootRestoreResult {
  assertDependencies(dependencies);
  assertBoundaries(externalEnvelopePath, privateStoreRoot, boundary);
  assertExternalAuditBoundary(dependencies.externalAuditRoot, boundary);
  const envelope = verifyEnvelope(
    readExternalEnvelope(externalEnvelopePath),
    dependencies,
  );
  const payload = envelope.payload;
  const envelopeDigest = canonicalDigest(envelope);
  const expectedReservation = createReservation(envelope, envelopeDigest);

  const observedPaths = operationPaths(
    privateStoreRoot,
    payload.grantId,
    false,
  );
  const hasAdmissionEvidence =
    observedPaths !== null &&
    hasExactPublicationEvidence(
      observedPaths.operationDirectory,
      'reservation.json',
      expectedReservation,
    );
  if (!hasAdmissionEvidence) {
    assertGrantWindow(payload, dependencies.now);
    assertPointerCas(
      readActiveTrustRootChain(
        privateStoreRoot,
        dependencies.authorityDescriptor,
        dependencies.authorityExpectations,
        dependencies.verifyHumanSignature,
        dependencies.externalAuditRoot,
        payload.grantId,
      ),
      payload,
    );
  }

  const paths = operationPaths(privateStoreRoot, payload.grantId, true);
  if (paths === null) throw stateCorrupt();
  ensureImmutable(
    paths.reservation,
    expectedReservation,
    dependencies,
    'reservation-published',
  );
  let record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (canonicalJson(record.reservation.envelope) !== canonicalJson(envelope)) {
    throw stateCorrupt();
  }
  if (record.auditAcknowledgement !== null) throw alreadyConsumed();

  const rootPath = path.join(
    paths.roots,
    `${payload.replacementRootDigest.slice('sha256:'.length)}.json`,
  );
  ensureImmutable(
    rootPath,
    envelope.replacement,
    dependencies,
    'root-published',
  );

  const pointer = createPointer(payload, envelopeDigest, record.reservation);
  const activeBefore = readActiveTrustRootChain(
    privateStoreRoot,
    dependencies.authorityDescriptor,
    dependencies.authorityExpectations,
    dependencies.verifyHumanSignature,
    dependencies.externalAuditRoot,
    payload.grantId,
  );
  if (activeBefore?.pointer.pointerDigest !== pointer.pointerDigest) {
    assertPointerCas(activeBefore, payload);
    const pointerPath = path.join(
      paths.pointers,
      pointerFileName(pointer.generation),
    );
    ensureImmutable(pointerPath, pointer, dependencies, 'pointer-published');
  }
  const active = readActiveTrustRootChain(
    privateStoreRoot,
    dependencies.authorityDescriptor,
    dependencies.authorityExpectations,
    dependencies.verifyHumanSignature,
    dependencies.externalAuditRoot,
    payload.grantId,
  );
  if (
    active === null ||
    active.pointer.pointerDigest !== pointer.pointerDigest ||
    active.root.rootDigest !== envelope.replacement.rootDigest
  ) {
    throw stateCorrupt();
  }

  record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.receipt === null) {
    ensureImmutable(
      paths.receipt,
      createReceipt(payload, pointer, record.reservation.reservedAt),
      dependencies,
      'receipt-published',
    );
  }
  record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.receipt === null) throw stateCorrupt();
  if (record.terminal === null) {
    ensureImmutable(
      paths.terminal,
      createTerminal(
        payload,
        envelopeDigest,
        record.receipt,
        record.reservation.reservedAt,
      ),
      dependencies,
      'terminal-published',
    );
  }

  record = finishAudit(privateStoreRoot, paths, payload, dependencies);
  if (record.receipt === null) throw stateCorrupt();
  return deepFreeze({
    pointer,
    root: envelope.replacement,
    receipt: record.receipt,
    record,
  });
}

export function readRecoveryOperationalTrustRootActive(
  privateStoreRoot: string,
  descriptorValue: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  dependencies: RecoveryOperationalTrustRootReadDependencies,
): {
  pointer: RecoveryOperationalTrustRootPointer;
  root: RecoveryOperationalTrustRoot;
} | null {
  if (
    !isRecord(dependencies) ||
    !hasExactKeys(dependencies, [
      'boundary',
      'externalAuditRoot',
      'verifyHumanSignature',
    ]) ||
    !isExactAbsolutePath(dependencies.externalAuditRoot) ||
    typeof dependencies.verifyHumanSignature !== 'function'
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_VERIFIER_REQUIRED',
      'Active operational trust-root reads require the pinned Recovery Authority signature verifier.',
      ExitCode.unsafeEnvironment,
    );
  }
  assertPrivateStoreBoundary(privateStoreRoot, dependencies.boundary);
  assertPrivateDirectory(dependencies.externalAuditRoot, auditRootUnsafe);
  assertExternalAuditBoundary(
    dependencies.externalAuditRoot,
    dependencies.boundary,
  );
  return readActiveTrustRootChain(
    privateStoreRoot,
    descriptorValue,
    expectations,
    dependencies.verifyHumanSignature,
    dependencies.externalAuditRoot,
    null,
  );
}

function readActiveTrustRootChain(
  privateStoreRoot: string,
  descriptorValue: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  verifyHumanSignature: PersistenceHumanSignatureVerifier,
  externalAuditRoot: string,
  allowedPendingGrantId: string | null,
): {
  pointer: RecoveryOperationalTrustRootPointer;
  root: RecoveryOperationalTrustRoot;
} | null {
  const descriptor = verifyRecoveryAuthorityDescriptor(
    descriptorValue,
    expectations,
  );
  const paths = statePaths(privateStoreRoot, false);
  if (paths === null) return null;
  assertStateClosure(paths);
  assertNoForeignPendingRestore(paths, privateStoreRoot, allowedPendingGrantId);
  assertNoForeignUnpublishedPreparation(
    paths,
    privateStoreRoot,
    allowedPendingGrantId,
  );
  const names = fs
    .readdirSync(paths.pointers)
    .filter((name) => POINTER_FILE.test(name))
    .sort();
  if (names.length === 0) return null;
  let previous: RecoveryOperationalTrustRootPointer | null = null;
  let activeRoot: RecoveryOperationalTrustRoot | null = null;
  for (const [index, name] of names.entries()) {
    const generation = index + 1;
    if (name !== pointerFileName(generation)) throw stateCorrupt();
    const pointer = normalizePointer(
      readPublished(path.join(paths.pointers, name)),
    );
    if (
      pointer.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
      pointer.authorityDescriptorDigest !== descriptor.descriptorDigest ||
      pointer.authorityGeneration !== descriptor.generation ||
      pointer.generation !== generation ||
      pointer.previousPointerDigest !==
        (previous === null ? null : previous.pointerDigest)
    ) {
      throw stateCorrupt();
    }
    const rootPath = path.join(
      paths.roots,
      `${pointer.rootDigest.slice('sha256:'.length)}.json`,
    );
    const root = normalizeRoot(readPublished(rootPath));
    if (
      root.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
      root.generation !== pointer.generation ||
      root.rootDigest !== pointer.rootDigest
    ) {
      throw stateCorrupt();
    }
    assertPersistedPointerAuthority(
      privateStoreRoot,
      descriptor,
      expectations,
      verifyHumanSignature,
      externalAuditRoot,
      pointer,
      root,
      allowedPendingGrantId,
    );
    previous = pointer;
    activeRoot = root;
  }
  if (previous === null || activeRoot === null) throw stateCorrupt();
  return deepFreeze({ pointer: previous, root: activeRoot });
}

function assertNoForeignUnpublishedPreparation(
  paths: StatePaths,
  privateStoreRoot: string,
  allowedPendingGrantId: string | null,
): void {
  const allowedTargets = new Set<string>();
  if (allowedPendingGrantId !== null) {
    const operation = operationPaths(
      privateStoreRoot,
      allowedPendingGrantId,
      false,
    );
    if (
      operation !== null &&
      fs.lstatSync(operation.reservation, { throwIfNoEntry: false }) !==
        undefined
    ) {
      const reservation = normalizeReservation(
        readPublished(operation.reservation),
      );
      const payload = reservation.envelope.payload;
      allowedTargets.add(
        `${payload.replacementRootDigest.slice('sha256:'.length)}.json`,
      );
      allowedTargets.add(pointerFileName(payload.replacementGeneration));
    }
  }
  for (const directory of [paths.roots, paths.pointers]) {
    for (const name of fs.readdirSync(directory).sort()) {
      const match = PREPARATION.exec(name);
      if (match === null) continue;
      const targetName = match[1]!;
      const target = path.join(directory, targetName);
      if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        continue;
      }
      const preparation = readPreparation(path.join(directory, name));
      if (preparation.stats.nlink !== 1 || !allowedTargets.has(targetName)) {
        throw transitionIncomplete();
      }
    }
  }
}

function assertNoForeignPendingRestore(
  paths: StatePaths,
  privateStoreRoot: string,
  allowedPendingGrantId: string | null,
): void {
  const allowedDirectory =
    allowedPendingGrantId === null ? null : digestHex(allowedPendingGrantId);
  for (const name of fs.readdirSync(paths.operations).sort()) {
    const directory = path.join(paths.operations, name);
    assertPrivateDirectory(directory, stateCorrupt);
    const reservationPath = path.join(directory, 'reservation.json');
    if (
      fs.lstatSync(reservationPath, { throwIfNoEntry: false }) === undefined
    ) {
      if (name !== allowedDirectory) throw transitionIncomplete();
      continue;
    }
    const reservation = normalizeReservation(readPublished(reservationPath));
    if (digestHex(reservation.grantId) !== name) throw stateCorrupt();
    const record = readRecoveryOperationalTrustRootRestoreRecord(
      privateStoreRoot,
      reservation.grantId,
    );
    if (
      record.auditAcknowledgement === null &&
      reservation.grantId !== allowedPendingGrantId
    ) {
      throw transitionIncomplete();
    }
  }
}

function assertPersistedPointerAuthority(
  privateStoreRoot: string,
  descriptor: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  verifyHumanSignature: PersistenceHumanSignatureVerifier,
  externalAuditRoot: string,
  pointer: RecoveryOperationalTrustRootPointer,
  root: RecoveryOperationalTrustRoot,
  allowedPendingGrantId: string | null,
): void {
  const record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    pointer.grantId,
  );
  const envelope = record.reservation.envelope;
  const payload = envelope.payload;
  if (
    payload.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
    payload.authorityDescriptorDigest !== descriptor.descriptorDigest ||
    payload.authorityGeneration !== descriptor.generation ||
    payload.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
    payload.externalAuditRoot !== externalAuditRoot ||
    payload.humanSigner !== descriptor.signer.identity ||
    payload.signerFingerprint !== descriptor.signer.fingerprint ||
    payload.replacementGeneration !== pointer.generation ||
    payload.replacementRootDigest !== pointer.rootDigest ||
    payload.expectedActivePointerDigest !== pointer.previousPointerDigest ||
    record.reservation.envelopeDigest !== pointer.envelopeDigest ||
    canonicalJson(envelope.replacement) !== canonicalJson(root) ||
    (record.receipt !== null &&
      record.receipt.newPointerDigest !== pointer.pointerDigest)
  ) {
    throw stateCorrupt();
  }
  assertRecoveryAuthorityDomain(
    descriptor,
    expectations,
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    payload.signerFingerprint,
  );
  let verified = false;
  try {
    verified = verifyHumanSignature(
      canonicalRecoveryOperationalTrustRootRestoreStatement(payload, root),
      envelope.signature,
      payload.humanSigner,
      RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_PERSISTED_SIGNATURE_INVALID',
      'Active operational trust-root lineage does not retain a valid Recovery Authority signature.',
      ExitCode.verification,
    );
  }
  if (
    record.auditAcknowledgement === null &&
    pointer.grantId !== allowedPendingGrantId
  ) {
    throw transitionIncomplete();
  }
}

export function readRecoveryOperationalTrustRootRestoreRecord(
  privateStoreRoot: string,
  grantIdValue: string,
): RecoveryOperationalTrustRootRestoreRecord {
  if (!GRANT_ID.test(grantIdValue)) throw grantInvalid();
  const paths = operationPaths(privateStoreRoot, grantIdValue, false);
  if (paths === null) throw stateCorrupt();
  assertOperationClosure(paths);
  const reservation = normalizeReservation(readPublished(paths.reservation));
  if (reservation.grantId !== grantIdValue) throw stateCorrupt();
  const receipt = readOptionalPublished(paths.receipt, normalizeReceipt);
  const terminal = readOptionalPublished(paths.terminal, normalizeTerminal);
  const audit = readOptionalPublished(paths.audit, normalizeAudit);
  const auditAcknowledgement = readOptionalPublished(
    paths.auditAcknowledgement,
    normalizeAuditAcknowledgement,
  );
  assertRecordChain(
    reservation,
    receipt,
    terminal,
    audit,
    auditAcknowledgement,
  );
  return deepFreeze({
    state:
      auditAcknowledgement !== null
        ? 'audited'
        : terminal !== null
          ? 'consumed'
          : receipt !== null
            ? 'receipt-durable'
            : 'reserved',
    reservation,
    receipt,
    terminal,
    audit,
    auditAcknowledgement,
  });
}

function verifyEnvelope(
  value: unknown,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): RecoveryOperationalTrustRootRestoreEnvelope {
  const envelope = normalizeEnvelope(value);
  const payload = envelope.payload;
  const replacement = envelope.replacement;
  const descriptor = dependencies.authorityDescriptor;
  if (
    payload.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
    payload.authorityDescriptorDigest !== descriptor.descriptorDigest ||
    payload.authorityGeneration !== descriptor.generation ||
    payload.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
    payload.externalAuditRoot !== dependencies.externalAuditRoot ||
    payload.humanSigner !== descriptor.signer.identity ||
    payload.signerFingerprint !== descriptor.signer.fingerprint
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_AUTHORITY_BINDING_MISMATCH',
      'Trust-root restore does not bind the exact loaded Recovery Authority, runtime, and audit root.',
      ExitCode.verification,
    );
  }
  assertRecoveryAuthorityDomain(
    descriptor,
    dependencies.authorityExpectations,
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    payload.signerFingerprint,
  );
  let verified = false;
  try {
    verified = dependencies.verifyHumanSignature(
      canonicalRecoveryOperationalTrustRootRestoreStatement(
        payload,
        replacement,
      ),
      envelope.signature,
      payload.humanSigner,
      RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_SIGNATURE_INVALID',
      'Trust-root restore signature is invalid for its independent Recovery Authority domain.',
      ExitCode.verification,
    );
  }
  return envelope;
}

function finishAudit(
  privateStoreRoot: string,
  paths: OperationPaths,
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): RecoveryOperationalTrustRootRestoreRecord {
  let record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.receipt === null || record.terminal === null) throw stateCorrupt();
  if (record.auditAcknowledgement !== null) return record;
  const audit =
    record.audit ??
    createAuditRecord(
      payload,
      record.reservation.envelopeDigest,
      record.receipt,
      record.terminal,
      record.reservation.reservedAt,
    );
  if (record.audit === null) {
    ensureImmutable(paths.audit, audit, dependencies, 'audit-published');
  }
  dependencies.appendAudit(audit);
  dependencies.hooks?.afterPhase('audit-appended', null);
  ensureImmutable(
    paths.auditAcknowledgement,
    createAuditAcknowledgement(audit, record.reservation.reservedAt),
    dependencies,
    'audit-ack-published',
  );
  record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.auditAcknowledgement === null) throw stateCorrupt();
  return record;
}

function createReservation(
  envelope: RecoveryOperationalTrustRootRestoreEnvelope,
  envelopeDigest: RecoveryAuthoritySha256Digest,
): RecoveryOperationalTrustRootRestoreReservation {
  const payload = {
    kind: 'recovery-operational-trust-root-restore-reservation.v1' as const,
    grantId: envelope.payload.grantId,
    envelope,
    envelopeDigest,
    reservedAt: envelope.payload.issuedAt,
  };
  return normalizeReservation({
    ...payload,
    reservationDigest: canonicalDigest(payload),
  });
}

function createPointer(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
  reservation: RecoveryOperationalTrustRootRestoreReservation,
): RecoveryOperationalTrustRootPointer {
  const value = {
    kind: 'recovery-operational-trust-root-pointer.v1' as const,
    repositoryId: payload.repositoryId,
    authorityDescriptorDigest: payload.authorityDescriptorDigest,
    authorityGeneration: payload.authorityGeneration,
    generation: payload.replacementGeneration,
    rootDigest: payload.replacementRootDigest,
    previousPointerDigest: payload.expectedActivePointerDigest,
    grantId: payload.grantId,
    envelopeDigest,
    activatedAt: reservation.reservedAt,
  };
  return normalizePointer({ ...value, pointerDigest: canonicalDigest(value) });
}

function createReceipt(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  pointer: RecoveryOperationalTrustRootPointer,
  completedAt: string,
): RecoveryOperationalTrustRootRestoreReceipt {
  const value = {
    kind: 'recovery-operational-trust-root-restore-receipt.v1' as const,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    generation: payload.replacementGeneration,
    rootDigest: payload.replacementRootDigest,
    previousPointerDigest: payload.expectedActivePointerDigest,
    newPointerDigest: pointer.pointerDigest,
    completedAt,
  };
  return normalizeReceipt({ ...value, receiptDigest: canonicalDigest(value) });
}

function createTerminal(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
  receipt: RecoveryOperationalTrustRootRestoreReceipt,
  consumedAt: string,
): RecoveryOperationalTrustRootRestoreTerminal {
  const value = {
    kind: 'recovery-operational-trust-root-restore-terminal.v1' as const,
    state: 'consumed' as const,
    grantId: payload.grantId,
    envelopeDigest,
    receiptDigest: receipt.receiptDigest,
    consumedAt,
  };
  return normalizeTerminal({
    ...value,
    terminalDigest: canonicalDigest(value),
  });
}

function createAuditRecord(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
  receipt: RecoveryOperationalTrustRootRestoreReceipt,
  terminal: RecoveryOperationalTrustRootRestoreTerminal,
  recordedAt: string,
): RecoveryOperationalTrustRootRestoreAuditRecord {
  const recordId = canonicalDigest({
    kind: 'recovery-operational-trust-root-restore-audit-identity.v1',
    grantId: payload.grantId,
    envelopeDigest,
    receiptDigest: receipt.receiptDigest,
    terminalDigest: terminal.terminalDigest,
  });
  const value = {
    kind: 'recovery-operational-trust-root-restore-audit.v1' as const,
    recordId,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    authorityDescriptorDigest: payload.authorityDescriptorDigest,
    authorityGeneration: payload.authorityGeneration,
    recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
    externalAuditRoot: payload.externalAuditRoot,
    humanSigner: payload.humanSigner,
    signerFingerprint: payload.signerFingerprint,
    generation: payload.replacementGeneration,
    rootDigest: payload.replacementRootDigest,
    previousPointerDigest: payload.expectedActivePointerDigest,
    newPointerDigest: receipt.newPointerDigest,
    envelopeDigest,
    terminalDigest: terminal.terminalDigest,
    recordedAt,
  };
  return normalizeAudit({ ...value, recordDigest: canonicalDigest(value) });
}

function createAuditAcknowledgement(
  audit: RecoveryOperationalTrustRootRestoreAuditRecord,
  acknowledgedAt: string,
): RecoveryOperationalTrustRootRestoreAuditAcknowledgement {
  const value = {
    kind: 'recovery-operational-trust-root-restore-audit-ack.v1' as const,
    grantId: audit.grantId,
    recordId: audit.recordId,
    recordDigest: audit.recordDigest,
    acknowledgedAt,
  };
  return normalizeAuditAcknowledgement({
    ...value,
    acknowledgementDigest: canonicalDigest(value),
  });
}

function normalizeEnvelope(
  value: unknown,
): RecoveryOperationalTrustRootRestoreEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ENVELOPE_KEYS) ||
    typeof value.signature !== 'string' ||
    value.signature.length === 0 ||
    value.signature.length > 64 * 1024
  ) {
    throw grantInvalid();
  }
  const payload = normalizeGrant(value.payload);
  const replacement = normalizeRoot(value.replacement);
  assertReplacementBinding(payload, replacement);
  return deepFreeze({ payload, replacement, signature: value.signature });
}

function normalizeRoot(value: unknown): RecoveryOperationalTrustRoot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_KEYS) ||
    !isDigest(value.rootDigest)
  ) {
    throw rootInvalid();
  }
  const { rootDigest, ...rawPayload } = value;
  const payload = normalizeRootPayload(rawPayload);
  const expected = canonicalDigest(payload);
  if (rootDigest !== expected) throw rootInvalid();
  return deepFreeze({ ...payload, rootDigest: expected });
}

function normalizeRootPayload(
  value: unknown,
): RecoveryOperationalTrustRootPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_PAYLOAD_KEYS) ||
    value.kind !== 'recovery-operational-trust-root.v1' ||
    !isIdentifier(value.repositoryId) ||
    !isPositiveInteger(value.generation) ||
    value.purpose !== 'workflow-maintainer-signatures' ||
    value.signatureNamespace !== 'expense-app.workflow.maintainer-grant.v1' ||
    !Array.isArray(value.trustedSigners) ||
    value.trustedSigners.length === 0 ||
    value.trustedSigners.length > 64
  ) {
    throw rootInvalid();
  }
  const trustedSigners = value.trustedSigners.map(normalizeSigner);
  const sorted = [...trustedSigners].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
  if (
    trustedSigners.some(
      (signer, index) => signer.identity !== sorted[index]?.identity,
    ) ||
    new Set(trustedSigners.map(({ identity }) => identity)).size !==
      trustedSigners.length ||
    new Set(trustedSigners.map(({ publicKey }) => publicKey)).size !==
      trustedSigners.length ||
    new Set(trustedSigners.map(({ fingerprint }) => fingerprint)).size !==
      trustedSigners.length
  ) {
    throw rootInvalid();
  }
  return deepFreeze({
    kind: 'recovery-operational-trust-root.v1',
    repositoryId: value.repositoryId,
    generation: value.generation,
    purpose: 'workflow-maintainer-signatures',
    signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
    trustedSigners,
    createdAt: exactIso(value.createdAt),
  });
}

function normalizeSigner(value: unknown): RecoveryOperationalTrustSigner {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SIGNER_KEYS) ||
    !isIdentifier(value.identity) ||
    typeof value.publicKey !== 'string' ||
    !SSH_PUBLIC_KEY.test(value.publicKey) ||
    typeof value.fingerprint !== 'string' ||
    !FINGERPRINT.test(value.fingerprint) ||
    publicKeyFingerprint(value.publicKey) !== value.fingerprint
  ) {
    throw rootInvalid();
  }
  return deepFreeze({
    identity: value.identity,
    publicKey: value.publicKey,
    fingerprint: value.fingerprint,
  });
}

function normalizeGrant(
  value: unknown,
): RecoveryOperationalTrustRootRestoreGrantPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, GRANT_KEYS) ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId)
  ) {
    throw grantInvalid();
  }
  const { grantId, ...rawUnsigned } = value;
  const unsigned = normalizeUnsignedGrant(rawUnsigned);
  const expectedId = recoveryOperationalTrustRootRestoreGrantId(unsigned);
  if (grantId !== expectedId) throw grantInvalid();
  return deepFreeze({ ...unsigned, grantId: expectedId });
}

function normalizeUnsignedGrant(
  value: unknown,
): RecoveryOperationalTrustRootRestoreGrantUnsignedPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, UNSIGNED_GRANT_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-restore-grant.v1' ||
    value.operation !== 'restore-operational-trust-root' ||
    !isIdentifier(value.repositoryId) ||
    !isDigest(value.authorityDescriptorDigest) ||
    !isPositiveInteger(value.authorityGeneration) ||
    !isDigest(value.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(value.externalAuditRoot) ||
    !isIdentifier(value.humanSigner) ||
    typeof value.signerFingerprint !== 'string' ||
    !FINGERPRINT.test(value.signerFingerprint) ||
    !isNonNegativeInteger(value.expectedGeneration) ||
    (value.expectedActivePointerDigest !== null &&
      !isDigest(value.expectedActivePointerDigest)) ||
    !isDigest(value.replacementRootDigest) ||
    !isPositiveInteger(value.replacementGeneration) ||
    value.replacementGeneration !== value.expectedGeneration + 1 ||
    (value.expectedGeneration === 0) !==
      (value.expectedActivePointerDigest === null) ||
    value.uses !== 1 ||
    value.oneShot !== true
  ) {
    throw grantInvalid();
  }
  const issuedAt = exactIso(value.issuedAt);
  const expiresAt = exactIso(value.expiresAt);
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > RECOVERY_TRUST_ROOT_RESTORE_TTL_MS) {
    throw grantInvalid();
  }
  return deepFreeze({
    kind: 'recovery-operational-trust-root-restore-grant.v1',
    operation: 'restore-operational-trust-root',
    repositoryId: value.repositoryId,
    authorityDescriptorDigest: value.authorityDescriptorDigest,
    authorityGeneration: value.authorityGeneration,
    recoveryRuntimeDigest: value.recoveryRuntimeDigest,
    externalAuditRoot: value.externalAuditRoot,
    humanSigner: value.humanSigner,
    signerFingerprint: value.signerFingerprint,
    expectedGeneration: value.expectedGeneration,
    expectedActivePointerDigest: value.expectedActivePointerDigest,
    replacementRootDigest: value.replacementRootDigest,
    replacementGeneration: value.replacementGeneration,
    issuedAt,
    expiresAt,
    uses: 1,
    oneShot: true,
  });
}

function normalizePointer(value: unknown): RecoveryOperationalTrustRootPointer {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, POINTER_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-pointer.v1' ||
    !isIdentifier(value.repositoryId) ||
    !isDigest(value.authorityDescriptorDigest) ||
    !isPositiveInteger(value.authorityGeneration) ||
    !isPositiveInteger(value.generation) ||
    !isDigest(value.rootDigest) ||
    (value.previousPointerDigest !== null &&
      !isDigest(value.previousPointerDigest)) ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.pointerDigest)
  ) {
    throw stateCorrupt();
  }
  const payload = {
    kind: 'recovery-operational-trust-root-pointer.v1' as const,
    repositoryId: value.repositoryId,
    authorityDescriptorDigest: value.authorityDescriptorDigest,
    authorityGeneration: value.authorityGeneration,
    generation: value.generation,
    rootDigest: value.rootDigest,
    previousPointerDigest: value.previousPointerDigest,
    grantId: value.grantId,
    envelopeDigest: value.envelopeDigest,
    activatedAt: exactIso(value.activatedAt),
  };
  const pointerDigest = canonicalDigest(payload);
  if (value.pointerDigest !== pointerDigest) throw stateCorrupt();
  return deepFreeze({ ...payload, pointerDigest });
}

function normalizeReservation(
  value: unknown,
): RecoveryOperationalTrustRootRestoreReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RESERVATION_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-restore-reservation.v1' ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.reservationDigest)
  ) {
    throw stateCorrupt();
  }
  const envelope = normalizeEnvelope(value.envelope);
  const payload = {
    kind: 'recovery-operational-trust-root-restore-reservation.v1' as const,
    grantId: value.grantId,
    envelope,
    envelopeDigest: value.envelopeDigest,
    reservedAt: exactIso(value.reservedAt),
  };
  if (
    envelope.payload.grantId !== value.grantId ||
    canonicalDigest(envelope) !== value.envelopeDigest ||
    payload.reservedAt !== envelope.payload.issuedAt ||
    value.reservationDigest !== canonicalDigest(payload)
  ) {
    throw stateCorrupt();
  }
  return deepFreeze({
    ...payload,
    reservationDigest: value.reservationDigest,
  });
}

function normalizeReceipt(
  value: unknown,
): RecoveryOperationalTrustRootRestoreReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RECEIPT_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-restore-receipt.v1' ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId) ||
    !isIdentifier(value.repositoryId) ||
    !isPositiveInteger(value.generation) ||
    !isDigest(value.rootDigest) ||
    (value.previousPointerDigest !== null &&
      !isDigest(value.previousPointerDigest)) ||
    !isDigest(value.newPointerDigest) ||
    !isDigest(value.receiptDigest)
  ) {
    throw stateCorrupt();
  }
  const payload = {
    kind: 'recovery-operational-trust-root-restore-receipt.v1' as const,
    grantId: value.grantId,
    repositoryId: value.repositoryId,
    generation: value.generation,
    rootDigest: value.rootDigest,
    previousPointerDigest: value.previousPointerDigest,
    newPointerDigest: value.newPointerDigest,
    completedAt: exactIso(value.completedAt),
  };
  if (value.receiptDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return deepFreeze({ ...payload, receiptDigest: value.receiptDigest });
}

function normalizeTerminal(
  value: unknown,
): RecoveryOperationalTrustRootRestoreTerminal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, TERMINAL_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-restore-terminal.v1' ||
    value.state !== 'consumed' ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.receiptDigest) ||
    !isDigest(value.terminalDigest)
  ) {
    throw stateCorrupt();
  }
  const payload = {
    kind: 'recovery-operational-trust-root-restore-terminal.v1' as const,
    state: 'consumed' as const,
    grantId: value.grantId,
    envelopeDigest: value.envelopeDigest,
    receiptDigest: value.receiptDigest,
    consumedAt: exactIso(value.consumedAt),
  };
  if (value.terminalDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return deepFreeze({ ...payload, terminalDigest: value.terminalDigest });
}

function normalizeAudit(
  value: unknown,
): RecoveryOperationalTrustRootRestoreAuditRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, AUDIT_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-restore-audit.v1' ||
    !isDigest(value.recordId) ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId) ||
    !isIdentifier(value.repositoryId) ||
    !isDigest(value.authorityDescriptorDigest) ||
    !isPositiveInteger(value.authorityGeneration) ||
    !isDigest(value.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(value.externalAuditRoot) ||
    !isIdentifier(value.humanSigner) ||
    typeof value.signerFingerprint !== 'string' ||
    !FINGERPRINT.test(value.signerFingerprint) ||
    !isPositiveInteger(value.generation) ||
    !isDigest(value.rootDigest) ||
    (value.previousPointerDigest !== null &&
      !isDigest(value.previousPointerDigest)) ||
    !isDigest(value.newPointerDigest) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.terminalDigest) ||
    !isDigest(value.recordDigest)
  ) {
    throw stateCorrupt();
  }
  const payload = {
    kind: 'recovery-operational-trust-root-restore-audit.v1' as const,
    recordId: value.recordId,
    grantId: value.grantId,
    repositoryId: value.repositoryId,
    authorityDescriptorDigest: value.authorityDescriptorDigest,
    authorityGeneration: value.authorityGeneration,
    recoveryRuntimeDigest: value.recoveryRuntimeDigest,
    externalAuditRoot: value.externalAuditRoot,
    humanSigner: value.humanSigner,
    signerFingerprint: value.signerFingerprint,
    generation: value.generation,
    rootDigest: value.rootDigest,
    previousPointerDigest: value.previousPointerDigest,
    newPointerDigest: value.newPointerDigest,
    envelopeDigest: value.envelopeDigest,
    terminalDigest: value.terminalDigest,
    recordedAt: exactIso(value.recordedAt),
  };
  // recordId also binds the receipt digest and is therefore checked once the
  // complete durable record chain is available in assertRecordChain().
  if (value.recordDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return deepFreeze({ ...payload, recordDigest: value.recordDigest });
}

function normalizeAuditAcknowledgement(
  value: unknown,
): RecoveryOperationalTrustRootRestoreAuditAcknowledgement {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, AUDIT_ACK_KEYS) ||
    value.kind !== 'recovery-operational-trust-root-restore-audit-ack.v1' ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId) ||
    !isDigest(value.recordId) ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.acknowledgementDigest)
  ) {
    throw stateCorrupt();
  }
  const payload = {
    kind: 'recovery-operational-trust-root-restore-audit-ack.v1' as const,
    grantId: value.grantId,
    recordId: value.recordId,
    recordDigest: value.recordDigest,
    acknowledgedAt: exactIso(value.acknowledgedAt),
  };
  if (value.acknowledgementDigest !== canonicalDigest(payload)) {
    throw stateCorrupt();
  }
  return deepFreeze({
    ...payload,
    acknowledgementDigest: value.acknowledgementDigest,
  });
}

function assertReplacementBinding(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  replacement: RecoveryOperationalTrustRoot,
): void {
  if (
    replacement.repositoryId !== payload.repositoryId ||
    replacement.generation !== payload.replacementGeneration ||
    replacement.rootDigest !== payload.replacementRootDigest ||
    replacement.createdAt !== payload.issuedAt
  ) {
    throw grantInvalid();
  }
}

function assertRecordChain(
  reservation: RecoveryOperationalTrustRootRestoreReservation,
  receipt: RecoveryOperationalTrustRootRestoreReceipt | null,
  terminal: RecoveryOperationalTrustRootRestoreTerminal | null,
  audit: RecoveryOperationalTrustRootRestoreAuditRecord | null,
  acknowledgement: RecoveryOperationalTrustRootRestoreAuditAcknowledgement | null,
): void {
  const payload = reservation.envelope.payload;
  if (receipt !== null) {
    if (
      receipt.grantId !== payload.grantId ||
      receipt.repositoryId !== payload.repositoryId ||
      receipt.generation !== payload.replacementGeneration ||
      receipt.rootDigest !== payload.replacementRootDigest ||
      receipt.previousPointerDigest !== payload.expectedActivePointerDigest ||
      receipt.completedAt !== reservation.reservedAt
    ) {
      throw stateCorrupt();
    }
  }
  if (terminal !== null) {
    if (
      receipt === null ||
      terminal.grantId !== payload.grantId ||
      terminal.envelopeDigest !== reservation.envelopeDigest ||
      terminal.receiptDigest !== receipt.receiptDigest ||
      terminal.consumedAt !== reservation.reservedAt
    ) {
      throw stateCorrupt();
    }
  }
  if (audit !== null) {
    if (
      receipt === null ||
      terminal === null ||
      audit.grantId !== payload.grantId ||
      audit.repositoryId !== payload.repositoryId ||
      audit.authorityDescriptorDigest !== payload.authorityDescriptorDigest ||
      audit.authorityGeneration !== payload.authorityGeneration ||
      audit.recoveryRuntimeDigest !== payload.recoveryRuntimeDigest ||
      audit.externalAuditRoot !== payload.externalAuditRoot ||
      audit.humanSigner !== payload.humanSigner ||
      audit.signerFingerprint !== payload.signerFingerprint ||
      audit.generation !== payload.replacementGeneration ||
      audit.rootDigest !== payload.replacementRootDigest ||
      audit.previousPointerDigest !== payload.expectedActivePointerDigest ||
      audit.newPointerDigest !== receipt.newPointerDigest ||
      audit.envelopeDigest !== reservation.envelopeDigest ||
      audit.terminalDigest !== terminal.terminalDigest ||
      audit.recordedAt !== reservation.reservedAt ||
      audit.recordId !==
        canonicalDigest({
          kind: 'recovery-operational-trust-root-restore-audit-identity.v1',
          grantId: payload.grantId,
          envelopeDigest: reservation.envelopeDigest,
          receiptDigest: receipt.receiptDigest,
          terminalDigest: terminal.terminalDigest,
        })
    ) {
      throw stateCorrupt();
    }
  }
  if (
    acknowledgement !== null &&
    (audit === null ||
      acknowledgement.grantId !== payload.grantId ||
      acknowledgement.recordId !== audit.recordId ||
      acknowledgement.recordDigest !== audit.recordDigest ||
      acknowledgement.acknowledgedAt !== reservation.reservedAt)
  ) {
    throw stateCorrupt();
  }
}

function assertPointerCas(
  active: {
    pointer: RecoveryOperationalTrustRootPointer;
    root: RecoveryOperationalTrustRoot;
  } | null,
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
): void {
  const generation = active?.pointer.generation ?? 0;
  const digest = active?.pointer.pointerDigest ?? null;
  if (
    generation !== payload.expectedGeneration ||
    digest !== payload.expectedActivePointerDigest
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_POINTER_CAS_MISMATCH',
      'Trust-root restore does not match the exact active generation and pointer digest.',
      ExitCode.staleState,
    );
  }
}

function assertGrantWindow(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  nowValue: Date,
): void {
  const now = exactDate(nowValue).getTime();
  if (now < Date.parse(payload.issuedAt)) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_GRANT_NOT_YET_VALID',
      'Trust-root restore Grant is not yet valid.',
      ExitCode.staleState,
    );
  }
  if (now >= Date.parse(payload.expiresAt)) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_GRANT_EXPIRED',
      'Trust-root restore Grant has expired.',
      ExitCode.staleState,
    );
  }
}

function statePaths(
  privateStoreRoot: string,
  create: boolean,
): StatePaths | null {
  assertPrivateDirectory(privateStoreRoot, storeUnsafe);
  const state = path.join(privateStoreRoot, 'recovery-operational-trust-root');
  if (create) {
    ensurePrivateDirectory(privateStoreRoot, state);
  } else if (fs.lstatSync(state, { throwIfNoEntry: false }) === undefined) {
    return null;
  } else {
    assertPrivateDirectory(state, storeUnsafe);
  }
  const roots = path.join(state, 'roots');
  const pointers = path.join(state, 'pointers');
  const operations = path.join(state, 'operations');
  if (create) {
    ensurePrivateDirectory(state, roots);
    ensurePrivateDirectory(state, pointers);
    ensurePrivateDirectory(state, operations);
  } else {
    assertPrivateDirectory(roots, storeUnsafe);
    assertPrivateDirectory(pointers, storeUnsafe);
    assertPrivateDirectory(operations, storeUnsafe);
  }
  return { state, roots, pointers, operations };
}

function operationPaths(
  privateStoreRoot: string,
  grantIdValue: string,
  create: boolean,
): OperationPaths | null {
  if (!GRANT_ID.test(grantIdValue)) throw grantInvalid();
  const paths = statePaths(privateStoreRoot, create);
  if (paths === null) return null;
  const operationDirectory = path.join(
    paths.operations,
    digestHex(grantIdValue),
  );
  if (create) {
    ensurePrivateDirectory(paths.operations, operationDirectory);
  } else if (
    fs.lstatSync(operationDirectory, { throwIfNoEntry: false }) === undefined
  ) {
    return null;
  } else {
    assertPrivateDirectory(operationDirectory, storeUnsafe);
  }
  return {
    ...paths,
    operationDirectory,
    reservation: path.join(operationDirectory, 'reservation.json'),
    receipt: path.join(operationDirectory, 'receipt.json'),
    terminal: path.join(operationDirectory, 'terminal.json'),
    audit: path.join(operationDirectory, 'audit.json'),
    auditAcknowledgement: path.join(operationDirectory, 'audit-ack.json'),
  };
}

function assertStateClosure(paths: StatePaths): void {
  assertExactDirectoryEntries(paths.state, ['operations', 'pointers', 'roots']);
  assertPreparedDirectoryClosure(paths.roots, (name) => ROOT_FILE.test(name));
  assertPreparedDirectoryClosure(paths.pointers, (name) =>
    POINTER_FILE.test(name),
  );
  for (const entry of fs.readdirSync(paths.operations, {
    withFileTypes: true,
  })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !OPERATION_DIRECTORY.test(entry.name)
    ) {
      throw stateCorrupt();
    }
    assertPrivateDirectory(
      path.join(paths.operations, entry.name),
      stateCorrupt,
    );
  }
}

function assertOperationClosure(paths: OperationPaths): void {
  assertStateClosure(paths);
  assertPreparedDirectoryClosure(paths.operationDirectory, (name) =>
    [
      'audit-ack.json',
      'audit.json',
      'receipt.json',
      'reservation.json',
      'terminal.json',
    ].includes(name),
  );
}

function assertPreparedDirectoryClosure(
  directory: string,
  allowedTarget: (name: string) => boolean,
): void {
  assertPrivateDirectory(directory, stateCorrupt);
  for (const name of fs.readdirSync(directory).sort()) {
    if (allowedTarget(name)) {
      const value = readPublished(path.join(directory, name));
      void value;
      continue;
    }
    const match = PREPARATION.exec(name);
    if (match === null || !allowedTarget(match[1]!)) throw stateCorrupt();
    const preparation = path.join(directory, name);
    const inspected = readPreparation(preparation);
    if (inspected.stats.nlink === 2) {
      const target = path.join(directory, match[1]!);
      const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
      if (
        targetStats === undefined ||
        !sameInode(inspected.stats, targetStats)
      ) {
        throw stateCorrupt();
      }
    } else if (
      fs.lstatSync(path.join(directory, match[1]!), {
        throwIfNoEntry: false,
      }) !== undefined
    ) {
      throw stateCorrupt();
    }
  }
}

function hasExactPublicationEvidence(
  directory: string,
  targetName: string,
  value: unknown,
): boolean {
  assertPrivateDirectory(directory, stateCorrupt);
  const target = path.join(directory, targetName);
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    assertCanonicalEqual(readPublished(target), value);
    return true;
  }
  const expected = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  const preparations = matchingPreparations(directory, targetName);
  if (preparations.length === 0) return false;
  if (preparations.length !== 1) throw stateCorrupt();
  const match = PREPARATION.exec(path.basename(preparations[0]!));
  if (match?.[2] !== digestHex(expected)) throw stateCorrupt();
  const observed = readPreparation(preparations[0]!);
  if (observed.stats.nlink !== 1 || !isBufferPrefix(observed.bytes, expected)) {
    throw stateCorrupt();
  }
  return true;
}

function ensureImmutable(
  filePath: string,
  value: unknown,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
  publishedPhase: RecoveryOperationalTrustRootRestoreFaultPhase,
): void {
  const directory = path.dirname(filePath);
  const targetName = path.basename(filePath);
  assertPrivateDirectory(directory, storeUnsafe);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    assertCanonicalEqual(readPublished(filePath), value);
    return;
  }
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (bytes.length > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES) {
    throw stateCorrupt();
  }
  const digest = digestHex(bytes);
  const existing = matchingPreparations(directory, targetName);
  if (existing.length > 1) throw stateCorrupt();
  let preparation: string;
  if (existing.length === 1) {
    preparation = existing[0]!;
    const match = PREPARATION.exec(path.basename(preparation));
    if (match?.[2] !== digest) throw stateCorrupt();
  } else {
    preparation = path.join(
      directory,
      `.${targetName}.${digest}.${crypto.randomUUID()}.prepare`,
    );
  }
  completePreparation(preparation, bytes, dependencies, targetName);
  assertExactPreparation(preparation, bytes, [1]);
  try {
    fs.linkSync(preparation, filePath);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    throw stateCorrupt();
  }
  assertExactHardLinkPair(preparation, filePath);
  assertCanonicalEqual(readPublished(filePath), value);
  fsyncDirectory(directory);
  dependencies.hooks?.afterPhase(publishedPhase, targetName);
  assertCanonicalEqual(readPublished(filePath), value);
}

function completePreparation(
  preparation: string,
  expected: Buffer,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
  targetName: string,
): void {
  const observed = fs.lstatSync(preparation, { throwIfNoEntry: false });
  let descriptor: number | undefined;
  try {
    if (observed === undefined) {
      descriptor = fs.openSync(
        preparation,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    } else {
      descriptor = fs.openSync(
        preparation,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const opened = fs.fstatSync(descriptor);
      if (!sameFileSnapshot(observed, opened, [1])) throw stateCorrupt();
    }
    const openedBefore = fs.fstatSync(descriptor);
    if (
      !openedBefore.isFile() ||
      openedBefore.isSymbolicLink() ||
      openedBefore.nlink !== 1 ||
      (openedBefore.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !ownedByCurrentUser(openedBefore) ||
      openedBefore.size > expected.length
    ) {
      throw stateCorrupt();
    }
    const existing = Buffer.alloc(openedBefore.size);
    if (existing.length > 0) {
      const read = fs.readSync(descriptor, existing, 0, existing.length, 0);
      if (read !== existing.length) throw stateCorrupt();
    }
    if (!isBufferPrefix(existing, expected)) throw stateCorrupt();
    let offset = existing.length;
    if (offset === 0) {
      const written = fs.writeSync(descriptor, expected, 0, 1, 0);
      if (written !== 1) throw storeUnsafe();
      offset = 1;
      dependencies.hooks?.afterPhase('prepare-prefix-written', targetName);
    }
    while (offset < expected.length) {
      const written = fs.writeSync(
        descriptor,
        expected,
        offset,
        expected.length - offset,
        offset,
      );
      if (written < 1) throw storeUnsafe();
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (
      !sameInode(openedBefore, openedAfter) ||
      openedAfter.nlink !== 1 ||
      openedAfter.size !== expected.length ||
      (openedAfter.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !ownedByCurrentUser(openedAfter)
    ) {
      throw stateCorrupt();
    }
    fsyncDirectory(path.dirname(preparation));
    dependencies.hooks?.afterPhase('prepare-fsynced', targetName);
    const pathAfterHook = fs.lstatSync(preparation, {
      throwIfNoEntry: false,
    });
    if (
      pathAfterHook === undefined ||
      !sameFileSnapshot(openedAfter, pathAfterHook, [1])
    ) {
      throw stateCorrupt();
    }
  } catch (error) {
    if (hasWorkflowCode(error) || error instanceof Error) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readPublished(filePath: string): unknown {
  const bytes = readPrivateFile(filePath, [2]);
  const value = parseCanonicalBytes(bytes);
  const directory = path.dirname(filePath);
  const targetName = path.basename(filePath);
  const digest = digestHex(bytes);
  const targetStats = fs.lstatSync(filePath);
  const anchors = matchingPreparations(directory, targetName).filter(
    (candidate) => {
      const match = PREPARATION.exec(path.basename(candidate));
      const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
      return (
        match?.[2] === digest &&
        stats !== undefined &&
        sameInode(stats, targetStats)
      );
    },
  );
  if (anchors.length !== 1) throw stateCorrupt();
  assertExactHardLinkPair(anchors[0]!, filePath);
  assertExactPreparation(anchors[0]!, bytes, [2]);
  return value;
}

function readOptionalPublished<T>(
  filePath: string,
  normalize: (value: unknown) => T,
): T | null {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  return normalize(readPublished(filePath));
}

function matchingPreparations(directory: string, targetName: string): string[] {
  const matches: string[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const match = PREPARATION.exec(name);
    if (match?.[1] === targetName) matches.push(path.join(directory, name));
  }
  return matches;
}

function readPreparation(filePath: string): {
  bytes: Buffer;
  stats: fs.Stats;
} {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    ![1, 2].includes(before.nlink) ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES
  ) {
    throw stateCorrupt();
  }
  const bytes = readPrivateFile(filePath, [1, 2]);
  return { bytes, stats: fs.lstatSync(filePath) };
}

function assertExactPreparation(
  filePath: string,
  expected: Buffer,
  allowedLinkCounts: readonly number[],
): void {
  const observed = readPrivateFile(filePath, allowedLinkCounts);
  if (!observed.equals(expected)) throw stateCorrupt();
}

function readPrivateFile(
  filePath: string,
  allowedLinkCounts: readonly number[],
): Buffer {
  if (!isExactAbsolutePath(filePath)) throw stateCorrupt();
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinkCounts.includes(before.nlink) ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES
  ) {
    throw stateCorrupt();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
      throw stateCorrupt();
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
      throw stateCorrupt();
    }
    return bytes;
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw stateCorrupt();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readExternalEnvelope(filePath: string): unknown {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES
  ) {
    throw externalFileUnsafe();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(before, openedBefore, [1])) {
      throw externalFileUnsafe();
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, [1])) {
      throw externalFileUnsafe();
    }
    return parseCanonicalBytes(bytes, grantInvalid);
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw grantInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseCanonicalBytes(
  bytes: Buffer,
  malformed: () => Error = stateCorrupt,
): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw malformed();
    const value = JSON.parse(text) as unknown;
    if (`${canonicalJson(value)}\n` !== text) throw malformed();
    return value;
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw malformed();
  }
}

function assertBoundaries(
  externalEnvelopePath: string,
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (
    !isRecord(boundary) ||
    !hasExactKeys(boundary, ['gitCommonDirectory', 'repositoryWorktreeRoot'])
  ) {
    throw boundaryInvalid();
  }
  const worktree = exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommon = exactDirectoryPath(boundary.gitCommonDirectory);
  assertPrivateStoreBoundary(privateStoreRoot, boundary);
  if (
    !isExactAbsolutePath(externalEnvelopePath) ||
    pathIsWithin(worktree, externalEnvelopePath) ||
    pathIsWithin(gitCommon, externalEnvelopePath)
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_EXTERNAL_SOURCE_FORBIDDEN',
      'Pre-signed trust-root replacement must come from outside the repository worktree and Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function assertPrivateStoreBoundary(
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (
    !isRecord(boundary) ||
    !hasExactKeys(boundary, ['gitCommonDirectory', 'repositoryWorktreeRoot'])
  ) {
    throw boundaryInvalid();
  }
  exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommon = exactDirectoryPath(boundary.gitCommonDirectory);
  assertPrivateDirectory(privateStoreRoot, storeUnsafe);
  if (
    privateStoreRoot === gitCommon ||
    !pathIsWithin(gitCommon, privateStoreRoot)
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_STORE_BOUNDARY_MISMATCH',
      'Trust-root restore store must be an exact private descendant of the Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function assertExternalAuditBoundary(
  externalAuditRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  const worktree = exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommon = exactDirectoryPath(boundary.gitCommonDirectory);
  if (
    pathIsWithin(worktree, externalAuditRoot) ||
    pathIsWithin(gitCommon, externalAuditRoot)
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_AUDIT_ROOT_UNSAFE',
      'Trust-root restore audit root must remain outside the repository worktree and Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function assertDependencies(
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): void {
  if (
    !isRecord(dependencies) ||
    !isExactAbsolutePath(dependencies.externalAuditRoot) ||
    !(dependencies.now instanceof Date) ||
    !Number.isFinite(dependencies.now.getTime()) ||
    typeof dependencies.verifyHumanSignature !== 'function' ||
    typeof dependencies.appendAudit !== 'function' ||
    (dependencies.hooks !== undefined &&
      (!isRecord(dependencies.hooks) ||
        !hasExactKeys(dependencies.hooks, ['afterPhase']) ||
        typeof dependencies.hooks.afterPhase !== 'function'))
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_DEPENDENCIES_INVALID',
      'Trust-root restore requires exact out-of-band authority, time, signature, and audit dependencies.',
      ExitCode.unsafeEnvironment,
    );
  }
  assertPrivateDirectory(dependencies.externalAuditRoot, auditRootUnsafe);
}

function exactDirectoryPath(value: unknown): string {
  if (!isExactAbsolutePath(value)) throw boundaryInvalid();
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    safeRealpath(value) !== value
  ) {
    throw boundaryInvalid();
  }
  return value;
}

function assertExactDirectoryEntries(
  directory: string,
  expected: readonly string[],
): void {
  const actual = fs.readdirSync(directory).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((value, index) => value !== sorted[index])
  ) {
    throw stateCorrupt();
  }
}

function ensurePrivateDirectory(parent: string, directory: string): void {
  assertPrivateDirectory(parent, storeUnsafe);
  if (path.dirname(directory) !== parent) throw storeUnsafe();
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      fsyncDirectory(parent);
    } catch (error) {
      if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    }
  }
  assertPrivateDirectory(directory, storeUnsafe);
}

function assertPrivateDirectory(
  directory: unknown,
  errorFactory: () => Error,
): asserts directory is string {
  if (!isExactAbsolutePath(directory)) throw errorFactory();
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(directory) !== directory
  ) {
    throw errorFactory();
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertExactHardLinkPair(leftPath: string, rightPath: string): void {
  const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
  const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
  if (
    left === undefined ||
    right === undefined ||
    !sameInode(left, right) ||
    left.nlink !== 2 ||
    right.nlink !== 2
  ) {
    throw stateCorrupt();
  }
}

function assertCanonicalEqual(observed: unknown, expected: unknown): void {
  if (canonicalJson(observed) !== canonicalJson(expected)) throw stateCorrupt();
}

function pointerFileName(generation: number): string {
  if (
    !isPositiveInteger(generation) ||
    generation > 99_999_999_999_999_999_999
  ) {
    throw stateCorrupt();
  }
  return `${String(generation).padStart(20, '0')}.json`;
}

function publicKeyFingerprint(publicKey: string): string {
  const [algorithm, encoded, ...rest] = publicKey.split(' ');
  if (algorithm === undefined || encoded === undefined || rest.length !== 0) {
    throw rootInvalid();
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, 'base64');
  } catch {
    throw rootInvalid();
  }
  if (
    blob.length < 5 ||
    blob.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    throw rootInvalid();
  }
  const algorithmLength = blob.readUInt32BE(0);
  if (
    algorithmLength === 0 ||
    algorithmLength > blob.length - 4 ||
    blob.subarray(4, 4 + algorithmLength).toString('ascii') !== algorithm
  ) {
    throw rootInvalid();
  }
  return `SHA256:${crypto
    .createHash('sha256')
    .update(blob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function canonicalDigest(value: unknown): RecoveryAuthoritySha256Digest {
  return `sha256:${digestHex(canonicalJson(value))}`;
}

function digestHex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactIso(value: unknown): string {
  if (typeof value !== 'string') throw grantInvalid();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw grantInvalid();
  }
  return value;
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_TIME_INVALID',
      'Trust-root restore requires a valid injected time.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(value.getTime());
}

function isBufferPrefix(prefix: Buffer, value: Buffer): boolean {
  return (
    prefix.length <= value.length &&
    value.subarray(0, prefix.length).equals(prefix)
  );
}

function isDigest(value: unknown): value is RecoveryAuthoritySha256Digest {
  return typeof value === 'string' && DIGEST.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isExactAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function pathIsWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(
  left: fs.Stats,
  right: fs.Stats,
  allowedLinkCounts: readonly number[],
): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    allowedLinkCounts.includes(right.nlink) &&
    (right.mode & 0o777) === PRIVATE_FILE_MODE &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    ownedByCurrentUser(right)
  );
}

function ownedByCurrentUser(stats: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

function safeRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function restoreError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

function grantInvalid() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_GRANT_INVALID',
    'Trust-root restore Grant or canonical replacement bundle is malformed.',
    ExitCode.guard,
  );
}

function rootInvalid() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_REPLACEMENT_INVALID',
    'Operational trust-root replacement does not match its exact schema or digest.',
    ExitCode.guard,
  );
}

function stateCorrupt() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_STATE_CORRUPT',
    'Trust-root restore durable state failed integrity verification.',
    ExitCode.verification,
  );
}

function storeUnsafe() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_STORE_UNSAFE',
    'Trust-root restore durable store is unavailable or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}

function externalFileUnsafe() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_EXTERNAL_FILE_UNSAFE',
    'Pre-signed trust-root replacement must be one exact private regular file.',
    ExitCode.unsafeEnvironment,
  );
}

function boundaryInvalid() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_BOUNDARY_INVALID',
    'Trust-root restore requires exact repository and Git common boundaries.',
    ExitCode.unsafeEnvironment,
  );
}

function auditRootUnsafe() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_AUDIT_ROOT_UNSAFE',
    'Trust-root restore external audit root must be an exact private directory.',
    ExitCode.unsafeEnvironment,
  );
}

function alreadyConsumed() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_GRANT_ALREADY_CONSUMED',
    'Trust-root restore Grant is one-shot and has already been consumed.',
    ExitCode.conflict,
  );
}

function transitionIncomplete() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_TRANSITION_INCOMPLETE',
    'Operational trust-root transition is not durably consumed and audited.',
    ExitCode.conflict,
  );
}

function hasWorkflowCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

function isNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
