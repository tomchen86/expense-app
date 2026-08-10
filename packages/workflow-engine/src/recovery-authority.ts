import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';

/**
 * Phase-one fail-closed substrate only. This module never discovers authority
 * from a checkout, provisions an authority automatically, rotates an existing
 * authority, or connects the descriptor to a production launcher.
 */
export const MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES = 64 * 1024;

/**
 * The legacy Recovery Grant namespace remains rollback-only. Every new
 * recovery effect has its own signature domain so that a signature cannot be
 * replayed merely by changing an operation discriminator.
 */
export const RECOVERY_AUTHORITY_KNOWN_DOMAINS = Object.freeze([
  'HARNESS_RECOVERY_ENTER_QUARANTINE_V1',
  'HARNESS_RECOVERY_GRANT_V1',
  'HARNESS_RECOVERY_RELEASE_QUARANTINE_V1',
  'HARNESS_RECOVERY_RESTORE_OPERATIONAL_TRUST_ROOT_V1',
  'HARNESS_RECOVERY_SUPERSEDE_WORKFLOW_V1',
] as const);

export type RecoveryAuthorityDomain =
  (typeof RECOVERY_AUTHORITY_KNOWN_DOMAINS)[number];
export type RecoveryAuthoritySha256Digest = `sha256:${string}`;

export interface RecoveryAuthorityRepositoryIdentityV1 {
  repositoryId: string;
  origin: string;
  gitObjectFormat: 'sha1' | 'sha256';
}

export interface RecoveryAuthoritySealedRuntimeBindingV1 {
  artifactId: RecoveryAuthoritySha256Digest;
  executableDigest: RecoveryAuthoritySha256Digest;
  closureDigest: RecoveryAuthoritySha256Digest;
  protocolVersion: number;
}

export interface RecoveryAuthorityAuditBindingV1 {
  ledgerId: string;
  rootBindingDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryAuthoritySignerV1 {
  identity: string;
  publicKey: string;
  fingerprint: string;
}

export interface RecoveryAuthorityDescriptorPayloadV1 {
  kind: 'harness-recovery-authority.v1';
  repositoryIdentity: RecoveryAuthorityRepositoryIdentityV1;
  repositoryIdentityDigest: RecoveryAuthoritySha256Digest;
  generation: number;
  signer: RecoveryAuthoritySignerV1;
  allowedDomains: RecoveryAuthorityDomain[];
  sealedRuntime: RecoveryAuthoritySealedRuntimeBindingV1;
  auditLedger: RecoveryAuthorityAuditBindingV1;
  createdAt: string;
}

export interface RecoveryAuthorityDescriptorV1 extends RecoveryAuthorityDescriptorPayloadV1 {
  descriptorDigest: RecoveryAuthoritySha256Digest;
}

/**
 * Every expectation is supplied by the sealed bootstrap/out-of-band ceremony.
 * No API in this module accepts a repository root or consults Git/HEAD.
 */
export interface RecoveryAuthorityExpectations {
  repositoryIdentity: RecoveryAuthorityRepositoryIdentityV1;
  generation: number;
  signerFingerprint: string;
  sealedRuntime: RecoveryAuthoritySealedRuntimeBindingV1;
  auditLedger: RecoveryAuthorityAuditBindingV1;
  descriptorDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryAuthorityImportBoundary {
  repositoryWorktreeRoot: string;
  gitCommonDirectory: string;
}

export type RecoveryAuthorityImportPhase =
  'prepare-prefix-written' | 'prepare-fsynced' | 'prepared' | 'published';

/** Deterministic crash injection for integration assurance only. */
export interface RecoveryAuthorityImportHooks {
  afterPhase(phase: RecoveryAuthorityImportPhase): void;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PREPARED_DESCRIPTOR_NAME = 'descriptor.prepare.json';
const PREPARATION_FILE =
  /^descriptor\.prepare\.([0-9a-f]{64})\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const DESCRIPTOR_KEYS = [
  'allowedDomains',
  'auditLedger',
  'createdAt',
  'descriptorDigest',
  'generation',
  'kind',
  'repositoryIdentity',
  'repositoryIdentityDigest',
  'sealedRuntime',
  'signer',
] as const;
const PAYLOAD_KEYS = DESCRIPTOR_KEYS.filter(
  (key) => key !== 'descriptorDigest',
);
const REPOSITORY_KEYS = ['gitObjectFormat', 'origin', 'repositoryId'] as const;
const SIGNER_KEYS = ['fingerprint', 'identity', 'publicKey'] as const;
const RUNTIME_KEYS = [
  'artifactId',
  'closureDigest',
  'executableDigest',
  'protocolVersion',
] as const;
const AUDIT_KEYS = ['ledgerId', 'rootBindingDigest'] as const;
const EXPECTATION_KEYS = [
  'auditLedger',
  'descriptorDigest',
  'generation',
  'repositoryIdentity',
  'sealedRuntime',
  'signerFingerprint',
] as const;
const IMPORT_BOUNDARY_KEYS = [
  'gitCommonDirectory',
  'repositoryWorktreeRoot',
] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_ID = /^github:[A-Za-z0-9_.:/-]{1,500}$/;
const REPOSITORY_ORIGIN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const SIGNER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SSH_PUBLIC_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
const LEDGER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function recoveryAuthorityRepositoryIdentityDigest(
  repositoryIdentity: RecoveryAuthorityRepositoryIdentityV1,
): RecoveryAuthoritySha256Digest {
  const normalized = normalizeRepositoryIdentity(repositoryIdentity);
  return canonicalDigest({
    kind: 'recovery-authority-repository-identity.v1',
    ...normalized,
  });
}

export function recoveryAuthorityDescriptorDigest(
  payload: RecoveryAuthorityDescriptorPayloadV1,
): RecoveryAuthoritySha256Digest {
  return canonicalDigest(normalizePayload(payload));
}

/** Parse schema and intrinsic digests. Parsing alone does not establish trust. */
export function parseRecoveryAuthorityDescriptor(
  value: unknown,
): RecoveryAuthorityDescriptorV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, DESCRIPTOR_KEYS) ||
    !isDigest(value.descriptorDigest)
  ) {
    throw descriptorInvalid();
  }
  const { descriptorDigest, ...rawPayload } = value;
  const payload = normalizePayload(rawPayload);
  const expectedDigest = canonicalDigest(payload);
  if (descriptorDigest !== expectedDigest) throw descriptorInvalid();
  return deepFreeze({
    ...payload,
    descriptorDigest: expectedDigest,
  });
}

/**
 * Verify a descriptor against independently supplied expectations. Callers
 * must not populate these expectations from the descriptor being verified.
 */
export function verifyRecoveryAuthorityDescriptor(
  value: unknown,
  expected: RecoveryAuthorityExpectations,
): RecoveryAuthorityDescriptorV1 {
  const descriptor = parseRecoveryAuthorityDescriptor(value);
  const pinned = normalizeExpectations(expected);
  const repositoryIdentity = pinned.repositoryIdentity;
  if (
    canonicalJson(descriptor.repositoryIdentity) !==
      canonicalJson(repositoryIdentity) ||
    descriptor.repositoryIdentityDigest !==
      recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_REPOSITORY_MISMATCH',
      'Recovery authority belongs to a different out-of-band repository identity.',
      ExitCode.staleState,
    );
  }
  if (descriptor.generation !== pinned.generation) {
    throw authorityError(
      'RECOVERY_AUTHORITY_GENERATION_MISMATCH',
      'Recovery authority generation differs from the out-of-band expectation.',
      ExitCode.staleState,
    );
  }
  if (descriptor.signer.fingerprint !== pinned.signerFingerprint) {
    throw authorityError(
      'RECOVERY_AUTHORITY_SIGNER_FINGERPRINT_MISMATCH',
      'Recovery authority signer fingerprint differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  if (
    canonicalJson(descriptor.sealedRuntime) !==
    canonicalJson(pinned.sealedRuntime)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_RUNTIME_MISMATCH',
      'Recovery authority sealed runtime binding differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  if (
    canonicalJson(descriptor.auditLedger) !== canonicalJson(pinned.auditLedger)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_AUDIT_BINDING_MISMATCH',
      'Recovery authority audit binding differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  if (descriptor.descriptorDigest !== pinned.descriptorDigest) {
    throw authorityError(
      'RECOVERY_AUTHORITY_DESCRIPTOR_DIGEST_MISMATCH',
      'Recovery authority descriptor digest differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  return descriptor;
}

/**
 * Check the exact signature-domain/fingerprint pair after descriptor
 * verification. This function does not verify a grant signature itself.
 */
export function assertRecoveryAuthorityDomain(
  descriptor: RecoveryAuthorityDescriptorV1,
  expected: RecoveryAuthorityExpectations,
  namespace: string,
  signerFingerprint: string,
): void {
  const exact = verifyRecoveryAuthorityDescriptor(descriptor, expected);
  if (exact.signer.fingerprint !== signerFingerprint) {
    throw authorityError(
      'RECOVERY_AUTHORITY_SIGNER_FINGERPRINT_MISMATCH',
      'Recovery signature signer differs from the pinned recovery authority.',
      ExitCode.verification,
    );
  }
  if (
    typeof namespace !== 'string' ||
    !(RECOVERY_AUTHORITY_KNOWN_DOMAINS as readonly string[]).includes(
      namespace,
    ) ||
    !exact.allowedDomains.includes(namespace as RecoveryAuthorityDomain)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_DOMAIN_FORBIDDEN',
      'Recovery authority cannot be replayed into this signature domain.',
      ExitCode.guard,
    );
  }
}

/**
 * Import one externally pinned descriptor into an empty private store. Exact
 * replay is idempotent. A different descriptor is never treated as a rotation,
 * even when it names the existing recovery signer; rotation needs a distinct
 * higher-order/out-of-band protocol that phase 1 deliberately does not expose.
 * The private store is only a repository-local durable copy beneath the Git
 * common directory; trust still comes from the separately supplied expected
 * descriptor digest and signer fingerprint, never from this stored copy.
 */
export function importRecoveryAuthorityDescriptor(
  externalDescriptorPath: string,
  privateStoreRoot: string,
  expected: RecoveryAuthorityExpectations,
  boundary: RecoveryAuthorityImportBoundary,
  hooks?: RecoveryAuthorityImportHooks,
): RecoveryAuthorityDescriptorV1 {
  assertImportHooks(hooks);
  assertExternalDescriptorSource(externalDescriptorPath, boundary);
  assertPrivateStoreBoundary(privateStoreRoot, boundary);
  const external = verifyRecoveryAuthorityDescriptor(
    readExternalDescriptor(externalDescriptorPath),
    expected,
  );
  const directory = recoveryAuthorityStoreDirectory(privateStoreRoot, true);
  const target = path.join(directory, 'descriptor.json');
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    return reconcilePublishedDescriptor(directory, target, external, expected);
  }

  const prepared = ensureDurablePreparation(directory, external, hooks);
  try {
    fs.linkSync(prepared, target);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    return reconcilePublishedDescriptor(directory, target, external, expected);
  }
  assertExactHardLinkPair(prepared, target);
  assertSameDescriptor(readPreparedDescriptor(target, [2]), external);
  fsyncDirectory(directory);
  hooks?.afterPhase('published');
  return reconcilePublishedDescriptor(directory, target, external, expected);
}

export function readRecoveryAuthorityDescriptor(
  privateStoreRoot: string,
  expected: RecoveryAuthorityExpectations,
  boundary: RecoveryAuthorityImportBoundary,
): RecoveryAuthorityDescriptorV1 {
  assertPrivateStoreBoundary(privateStoreRoot, boundary);
  const directory = recoveryAuthorityStoreDirectory(privateStoreRoot, false);
  const target = path.join(directory, 'descriptor.json');
  if (fs.lstatSync(target, { throwIfNoEntry: false }) === undefined) {
    throw authorityError(
      'RECOVERY_AUTHORITY_NOT_PROVISIONED',
      'No external Recovery Authority Descriptor has been provisioned.',
      ExitCode.unsafeEnvironment,
    );
  }
  return verifyRecoveryAuthorityDescriptor(
    readStoredDescriptor(target),
    expected,
  );
}

function ensureDurablePreparation(
  directory: string,
  external: RecoveryAuthorityDescriptorV1,
  hooks: RecoveryAuthorityImportHooks | undefined,
): string {
  const prepared = path.join(directory, PREPARED_DESCRIPTOR_NAME);
  if (fs.lstatSync(prepared, { throwIfNoEntry: false }) !== undefined) {
    return reconcilePreparedDescriptor(directory, prepared, external);
  }

  const reusable = selectExactPreparation(directory, external);
  const preparation =
    reusable ?? writePrivatePreparation(directory, external, hooks);
  assertSameDescriptor(readPreparedDescriptor(preparation, [1]), external);
  fsyncPrivateFile(preparation, [1]);
  assertSameDescriptor(readPreparedDescriptor(preparation, [1]), external);
  try {
    fs.linkSync(preparation, prepared);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    return reconcilePreparedDescriptor(directory, prepared, external);
  }
  assertExactHardLinkPair(preparation, prepared);
  assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
  fsyncDirectory(directory);
  hooks?.afterPhase('prepared');
  unlinkExactAlias(preparation, prepared);
  fsyncDirectory(directory);
  assertSameDescriptor(readPreparedDescriptor(prepared, [1]), external);
  return prepared;
}

function reconcilePreparedDescriptor(
  directory: string,
  prepared: string,
  external: RecoveryAuthorityDescriptorV1,
): string {
  const preparedStats = fs.lstatSync(prepared, { throwIfNoEntry: false });
  if (preparedStats === undefined) throw storeUnsafe();
  if (preparedStats.nlink === 1) {
    assertSameDescriptor(readPreparedDescriptor(prepared, [1]), external);
    return prepared;
  }
  if (preparedStats.nlink !== 2) throw storeCorrupt();

  const target = path.join(directory, 'descriptor.json');
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats && sameInode(preparedStats, targetStats)) {
    assertExactHardLinkPair(prepared, target);
    assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
    assertSameDescriptor(readPreparedDescriptor(target, [2]), external);
    return prepared;
  }

  const aliases = listPreparationPaths(directory).filter((candidate) => {
    const candidateStats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    return (
      candidateStats !== undefined && sameInode(preparedStats, candidateStats)
    );
  });
  if (aliases.length !== 1) throw storeCorrupt();
  const alias = aliases[0]!;
  assertPreparationNameMatches(alias, external);
  assertExactHardLinkPair(alias, prepared);
  assertSameDescriptor(readPreparedDescriptor(alias, [2]), external);
  assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
  unlinkExactAlias(alias, prepared);
  fsyncDirectory(directory);
  assertSameDescriptor(readPreparedDescriptor(prepared, [1]), external);
  return prepared;
}

function reconcilePublishedDescriptor(
  directory: string,
  target: string,
  external: RecoveryAuthorityDescriptorV1,
  expected: RecoveryAuthorityExpectations,
): RecoveryAuthorityDescriptorV1 {
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats === undefined) throw storeCorrupt();
  if (targetStats.nlink === 1) {
    const existing = readStoredDescriptor(target);
    assertSameDescriptor(existing, external);
    return verifyRecoveryAuthorityDescriptor(existing, expected);
  }
  if (targetStats.nlink !== 2) throw storeCorrupt();

  const prepared = path.join(directory, PREPARED_DESCRIPTOR_NAME);
  const preparedStats = fs.lstatSync(prepared, { throwIfNoEntry: false });
  if (!preparedStats || !sameInode(targetStats, preparedStats)) {
    throw storeCorrupt();
  }
  assertExactHardLinkPair(prepared, target);
  assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
  assertSameDescriptor(readPreparedDescriptor(target, [2]), external);
  unlinkExactAlias(prepared, target);
  fsyncDirectory(directory);
  const existing = readStoredDescriptor(target);
  assertSameDescriptor(existing, external);
  return verifyRecoveryAuthorityDescriptor(existing, expected);
}

function selectExactPreparation(
  directory: string,
  external: RecoveryAuthorityDescriptorV1,
): string | undefined {
  let selected: string | undefined;
  for (const candidate of listPreparationPaths(directory)) {
    assertPreparationNameMatches(candidate, external);
    const inspected = inspectPreparation(candidate);
    if (inspected === null) continue;
    if (canonicalJson(inspected) !== canonicalJson(external)) {
      throw replacementForbidden();
    }
    selected ??= candidate;
  }
  return selected;
}

function inspectPreparation(
  filePath: string,
): RecoveryAuthorityDescriptorV1 | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(filePath) !== filePath
  ) {
    throw storeCorrupt();
  }
  try {
    return parseRecoveryAuthorityDescriptor(
      readPrivateCanonicalFile(
        filePath,
        {
          missingCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          missingMessage: 'Recovery Authority preparation disappeared.',
          unsafeCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          unsafeMessage: 'Recovery Authority preparation is unsafe.',
          oversizedCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          oversizedMessage: 'Recovery Authority preparation is unsafe.',
          malformed: preparationIncomplete,
        },
        [1],
      ),
    );
  } catch (error) {
    if (
      hasWorkflowCode(error, 'RECOVERY_AUTHORITY_PREPARATION_INCOMPLETE') ||
      hasWorkflowCode(error, 'RECOVERY_AUTHORITY_DESCRIPTOR_INVALID')
    ) {
      return null;
    }
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_STORE_CORRUPT')) throw error;
    throw storeCorrupt();
  }
}

function listPreparationPaths(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((name) => PREPARATION_FILE.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function writePrivatePreparation(
  directory: string,
  external: RecoveryAuthorityDescriptorV1,
  hooks: RecoveryAuthorityImportHooks | undefined,
): string {
  const filePath = path.join(
    directory,
    `descriptor.prepare.${external.descriptorDigest.slice('sha256:'.length)}.${process.pid}.${crypto.randomUUID()}.json`,
  );
  const bytes = Buffer.from(`${canonicalJson(external)}\n`, 'utf8');
  let descriptor: number | undefined;
  let invokingHook = false;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const prefixLength = Math.max(1, Math.min(32, bytes.length));
    writeAll(descriptor, bytes.subarray(0, prefixLength));
    invokingHook = true;
    hooks?.afterPhase('prepare-prefix-written');
    invokingHook = false;
    writeAll(descriptor, bytes.subarray(prefixLength));
    fs.fsyncSync(descriptor);
    invokingHook = true;
    hooks?.afterPhase('prepare-fsynced');
    invokingHook = false;
  } catch (error) {
    if (invokingHook || hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return filePath;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
    );
    if (written < 1) throw storeUnsafe();
    offset += written;
  }
}

function readPreparedDescriptor(
  filePath: string,
  allowedLinkCounts: readonly number[],
): RecoveryAuthorityDescriptorV1 {
  try {
    return parseRecoveryAuthorityDescriptor(
      readPrivateCanonicalFile(
        filePath,
        {
          missingCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          missingMessage: 'Recovery Authority preparation is incomplete.',
          unsafeCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          unsafeMessage: 'Recovery Authority preparation is unsafe.',
          oversizedCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          oversizedMessage: 'Recovery Authority preparation is corrupt.',
          malformed: storeCorrupt,
        },
        allowedLinkCounts,
      ),
    );
  } catch (error) {
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_REPLACEMENT_FORBIDDEN')) {
      throw error;
    }
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_STORE_CORRUPT')) throw error;
    throw storeCorrupt();
  }
}

function assertSameDescriptor(
  observed: RecoveryAuthorityDescriptorV1,
  expected: RecoveryAuthorityDescriptorV1,
): void {
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw replacementForbidden();
  }
}

function assertExactHardLinkPair(leftPath: string, rightPath: string): void {
  const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
  const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
  if (
    !left ||
    !right ||
    !sameInode(left, right) ||
    left.nlink !== 2 ||
    right.nlink !== 2
  ) {
    throw storeCorrupt();
  }
}

function unlinkExactAlias(alias: string, anchor: string): void {
  assertExactHardLinkPair(alias, anchor);
  try {
    fs.unlinkSync(alias);
  } catch (error) {
    if (!isNodeCode(error, 'ENOENT')) throw storeUnsafe();
  }
  const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
  if (!anchorStats || anchorStats.nlink !== 1) throw storeCorrupt();
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPreparationNameMatches(
  filePath: string,
  external: RecoveryAuthorityDescriptorV1,
): void {
  const match = PREPARATION_FILE.exec(path.basename(filePath));
  if (`sha256:${match?.[1] ?? ''}` !== external.descriptorDigest) {
    throw replacementForbidden();
  }
}

function assertImportHooks(
  hooks: RecoveryAuthorityImportHooks | undefined,
): void {
  if (
    hooks !== undefined &&
    (!isRecord(hooks) ||
      !hasExactKeys(hooks, ['afterPhase']) ||
      typeof hooks.afterPhase !== 'function')
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_HOOK_INVALID',
      'Recovery Authority import hook is malformed.',
      ExitCode.usage,
    );
  }
}

function normalizePayload(
  value: unknown,
): RecoveryAuthorityDescriptorPayloadV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    value.kind !== 'harness-recovery-authority.v1' ||
    !isDigest(value.repositoryIdentityDigest) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !Array.isArray(value.allowedDomains) ||
    !isAllowedDomainSubset(value.allowedDomains) ||
    typeof value.createdAt !== 'string' ||
    !isExactIso(value.createdAt)
  ) {
    throw descriptorInvalid();
  }
  const repositoryIdentity = normalizeRepositoryIdentity(
    value.repositoryIdentity,
  );
  if (
    value.repositoryIdentityDigest !==
    recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity)
  ) {
    throw descriptorInvalid();
  }
  return {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity,
    repositoryIdentityDigest: value.repositoryIdentityDigest,
    generation: value.generation as number,
    signer: normalizeSigner(value.signer),
    allowedDomains: [...value.allowedDomains] as RecoveryAuthorityDomain[],
    sealedRuntime: normalizeSealedRuntime(value.sealedRuntime),
    auditLedger: normalizeAuditLedger(value.auditLedger),
    createdAt: value.createdAt,
  };
}

function normalizeRepositoryIdentity(
  value: unknown,
): RecoveryAuthorityRepositoryIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REPOSITORY_KEYS) ||
    typeof value.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(value.repositoryId) ||
    typeof value.origin !== 'string' ||
    !REPOSITORY_ORIGIN.test(value.origin) ||
    (value.gitObjectFormat !== 'sha1' && value.gitObjectFormat !== 'sha256')
  ) {
    throw descriptorInvalid();
  }
  return {
    repositoryId: value.repositoryId,
    origin: value.origin,
    gitObjectFormat: value.gitObjectFormat,
  };
}

function normalizeSigner(value: unknown): RecoveryAuthoritySignerV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SIGNER_KEYS) ||
    typeof value.identity !== 'string' ||
    !SIGNER_IDENTITY.test(value.identity) ||
    typeof value.publicKey !== 'string' ||
    !SSH_PUBLIC_KEY.test(value.publicKey) ||
    typeof value.fingerprint !== 'string' ||
    !SSH_FINGERPRINT.test(value.fingerprint) ||
    sshPublicKeyFingerprint(value.publicKey) !== value.fingerprint
  ) {
    throw descriptorInvalid();
  }
  return {
    identity: value.identity,
    publicKey: value.publicKey,
    fingerprint: value.fingerprint,
  };
}

function normalizeSealedRuntime(
  value: unknown,
): RecoveryAuthoritySealedRuntimeBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RUNTIME_KEYS) ||
    !isDigest(value.artifactId) ||
    !isDigest(value.executableDigest) ||
    !isDigest(value.closureDigest) ||
    !Number.isSafeInteger(value.protocolVersion) ||
    (value.protocolVersion as number) < 1
  ) {
    throw descriptorInvalid();
  }
  return {
    artifactId: value.artifactId,
    executableDigest: value.executableDigest,
    closureDigest: value.closureDigest,
    protocolVersion: value.protocolVersion as number,
  };
}

function normalizeAuditLedger(value: unknown): RecoveryAuthorityAuditBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, AUDIT_KEYS) ||
    typeof value.ledgerId !== 'string' ||
    !LEDGER_ID.test(value.ledgerId) ||
    !isDigest(value.rootBindingDigest)
  ) {
    throw descriptorInvalid();
  }
  return {
    ledgerId: value.ledgerId,
    rootBindingDigest: value.rootBindingDigest,
  };
}

function normalizeExpectations(value: unknown): RecoveryAuthorityExpectations {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, EXPECTATION_KEYS) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.signerFingerprint !== 'string' ||
    !SSH_FINGERPRINT.test(value.signerFingerprint) ||
    !isDigest(value.descriptorDigest)
  ) {
    throw expectationInvalid();
  }
  try {
    return {
      repositoryIdentity: normalizeRepositoryIdentity(value.repositoryIdentity),
      generation: value.generation as number,
      signerFingerprint: value.signerFingerprint,
      sealedRuntime: normalizeSealedRuntime(value.sealedRuntime),
      auditLedger: normalizeAuditLedger(value.auditLedger),
      descriptorDigest: value.descriptorDigest,
    };
  } catch (error) {
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_DESCRIPTOR_INVALID')) {
      throw expectationInvalid();
    }
    throw error;
  }
}

function isAllowedDomainSubset(value: unknown[]): boolean {
  const known = RECOVERY_AUTHORITY_KNOWN_DOMAINS as readonly string[];
  if (
    value.length === 0 ||
    value.some(
      (domain) => typeof domain !== 'string' || !known.includes(domain),
    )
  ) {
    return false;
  }
  const sortedUnique = [...new Set(value)].sort();
  return (
    value.length === sortedUnique.length &&
    value.every((domain, index) => domain === sortedUnique[index])
  );
}

function sshPublicKeyFingerprint(publicKey: string): string {
  const [algorithm, encoded, ...extra] = publicKey.split(' ');
  if (!algorithm || !encoded || extra.length !== 0) throw descriptorInvalid();
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, 'base64');
  } catch {
    throw descriptorInvalid();
  }
  if (
    blob.length < 5 ||
    blob.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    throw descriptorInvalid();
  }
  const algorithmLength = blob.readUInt32BE(0);
  if (
    algorithmLength === 0 ||
    algorithmLength > blob.length - 4 ||
    blob.subarray(4, 4 + algorithmLength).toString('ascii') !== algorithm
  ) {
    throw descriptorInvalid();
  }
  return `SHA256:${crypto
    .createHash('sha256')
    .update(blob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function readExternalDescriptor(filePath: string): unknown {
  return readPrivateCanonicalFile(filePath, {
    missingCode: 'RECOVERY_AUTHORITY_DESCRIPTOR_MISSING',
    missingMessage: 'External Recovery Authority Descriptor is missing.',
    unsafeCode: 'RECOVERY_AUTHORITY_DESCRIPTOR_FILE_UNSAFE',
    unsafeMessage:
      'External Recovery Authority Descriptor must be one exact private regular file.',
    oversizedCode: 'RECOVERY_AUTHORITY_DESCRIPTOR_TOO_LARGE',
    oversizedMessage: 'External Recovery Authority Descriptor is too large.',
    malformed: descriptorInvalid,
  });
}

function assertExternalDescriptorSource(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (!isRecord(boundary) || !hasExactKeys(boundary, IMPORT_BOUNDARY_KEYS)) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import requires exact repository source boundaries.',
      ExitCode.unsafeEnvironment,
    );
  }
  const roots = [
    exactDirectoryPath(boundary.repositoryWorktreeRoot),
    exactDirectoryPath(boundary.gitCommonDirectory),
  ];
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath ||
    roots.some((root) => pathIsWithin(root, filePath))
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_DESCRIPTOR_SOURCE_FORBIDDEN',
      'Recovery Authority Descriptor must come from outside the repository worktree and Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function assertPrivateStoreBoundary(
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (!isRecord(boundary) || !hasExactKeys(boundary, IMPORT_BOUNDARY_KEYS)) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import requires exact repository source boundaries.',
      ExitCode.unsafeEnvironment,
    );
  }
  exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommonDirectory = exactDirectoryPath(boundary.gitCommonDirectory);
  assertPrivateDirectory(privateStoreRoot, 'RECOVERY_AUTHORITY_STORE_UNSAFE');
  const relative = path.relative(gitCommonDirectory, privateStoreRoot);
  if (
    relative.length === 0 ||
    !pathIsWithin(gitCommonDirectory, privateStoreRoot)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_STORE_BOUNDARY_MISMATCH',
      'Recovery Authority private store must be an exact private descendant of the Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function exactDirectoryPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import boundary must be an exact absolute directory.',
      ExitCode.unsafeEnvironment,
    );
  }
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    safeRealpath(value) !== value
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import boundary must be an exact real directory.',
      ExitCode.unsafeEnvironment,
    );
  }
  return value;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function readStoredDescriptor(filePath: string): RecoveryAuthorityDescriptorV1 {
  try {
    return parseRecoveryAuthorityDescriptor(
      readPrivateCanonicalFile(filePath, {
        missingCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
        missingMessage: 'Recovery Authority private store is incomplete.',
        unsafeCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
        unsafeMessage: 'Recovery Authority private store is unsafe.',
        oversizedCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
        oversizedMessage: 'Recovery Authority private store is corrupt.',
        malformed: storeCorrupt,
      }),
    );
  } catch (error) {
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_STORE_CORRUPT')) throw error;
    throw storeCorrupt();
  }
}

function readPrivateCanonicalFile(
  filePath: string,
  errors: {
    missingCode: string;
    missingMessage: string;
    unsafeCode: string;
    unsafeMessage: string;
    oversizedCode: string;
    oversizedMessage: string;
    malformed: () => Error;
  },
  allowedLinkCounts: readonly number[] = [1],
): unknown {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath
  ) {
    throw authorityError(
      errors.unsafeCode,
      errors.unsafeMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw authorityError(
      errors.missingCode,
      errors.missingMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  if (stats.size > MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES) {
    throw authorityError(
      errors.oversizedCode,
      errors.oversizedMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    !allowedLinkCounts.includes(stats.nlink) ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(filePath) !== filePath
  ) {
    throw authorityError(
      errors.unsafeCode,
      errors.unsafeMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(stats, openedBefore, allowedLinkCounts)) {
      throw authorityError(
        errors.unsafeCode,
        errors.unsafeMessage,
        ExitCode.unsafeEnvironment,
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
      throw authorityError(
        errors.unsafeCode,
        errors.unsafeMessage,
        ExitCode.unsafeEnvironment,
      );
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw errors.malformed();
    const value = JSON.parse(text) as unknown;
    if (`${canonicalJson(value)}\n` !== text) throw errors.malformed();
    return value;
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw errors.malformed();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function recoveryAuthorityStoreDirectory(
  privateStoreRoot: string,
  create: boolean,
): string {
  assertPrivateDirectory(privateStoreRoot, 'RECOVERY_AUTHORITY_STORE_UNSAFE');
  const directory = path.join(privateStoreRoot, 'recovery-authority');
  if (
    create &&
    fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined
  ) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      fsyncDirectory(privateStoreRoot);
    } catch (error) {
      if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    }
  }
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    throw authorityError(
      'RECOVERY_AUTHORITY_NOT_PROVISIONED',
      'No external Recovery Authority Descriptor has been provisioned.',
      ExitCode.unsafeEnvironment,
    );
  }
  assertPrivateDirectory(directory, 'RECOVERY_AUTHORITY_STORE_UNSAFE');
  return directory;
}

function assertPrivateDirectory(directory: string, code: string): void {
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory
  ) {
    throw authorityError(
      code,
      'Recovery Authority private store must be one exact absolute directory.',
      ExitCode.unsafeEnvironment,
    );
  }
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(directory) !== directory
  ) {
    throw authorityError(
      code,
      'Recovery Authority private store must be one exact private directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncPrivateFile(
  filePath: string,
  allowedLinkCounts: readonly number[],
): void {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (before === undefined) throw storeCorrupt();
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
      throw storeCorrupt();
    }
    fs.fsyncSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
      throw storeCorrupt();
    }
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameFileSnapshot(
  left: fs.Stats,
  right: fs.Stats,
  allowedLinkCounts: readonly number[],
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
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

function isExactIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function canonicalDigest(value: unknown): RecoveryAuthoritySha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function isDigest(value: unknown): value is RecoveryAuthoritySha256Digest {
  return typeof value === 'string' && DIGEST.test(value);
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
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
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

function descriptorInvalid() {
  return authorityError(
    'RECOVERY_AUTHORITY_DESCRIPTOR_INVALID',
    'Recovery Authority Descriptor does not match its exact schema or intrinsic bindings.',
    ExitCode.verification,
  );
}

function expectationInvalid() {
  return authorityError(
    'RECOVERY_AUTHORITY_EXPECTATION_INVALID',
    'Recovery authority requires complete exact out-of-band expectations.',
    ExitCode.unsafeEnvironment,
  );
}

function replacementForbidden() {
  return authorityError(
    'RECOVERY_AUTHORITY_REPLACEMENT_FORBIDDEN',
    'An imported Recovery Authority cannot authorize or overwrite its own replacement.',
    ExitCode.guard,
  );
}

function preparationIncomplete() {
  return authorityError(
    'RECOVERY_AUTHORITY_PREPARATION_INCOMPLETE',
    'Recovery Authority preparation is incomplete.',
    ExitCode.unsafeEnvironment,
  );
}

function storeUnsafe() {
  return authorityError(
    'RECOVERY_AUTHORITY_STORE_UNSAFE',
    'Recovery Authority private store is unavailable or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}

function storeCorrupt() {
  return authorityError(
    'RECOVERY_AUTHORITY_STORE_CORRUPT',
    'Recovery Authority private store failed integrity verification.',
    ExitCode.verification,
  );
}

function authorityError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

function hasWorkflowCode(error: unknown, code?: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    (code === undefined || error.code === code)
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
