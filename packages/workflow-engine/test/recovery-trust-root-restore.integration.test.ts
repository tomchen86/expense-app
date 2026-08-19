import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  recoveryAuthorityDescriptorDigest,
  recoveryAuthorityRepositoryIdentityDigest,
  type RecoveryAuthorityDescriptorPayloadV1,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
  type RecoveryAuthorityImportBoundary,
} from '../src/recovery-authority.ts';
import {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  RECOVERY_TRUST_ROOT_RESTORE_TTL_MS,
  canonicalRecoveryOperationalTrustRootRestoreStatement,
  executeRecoveryOperationalTrustRootRestore,
  readRecoveryOperationalTrustRootActive,
  readRecoveryOperationalTrustRootRestoreRecord,
  recoveryOperationalTrustRootDigest,
  recoveryOperationalTrustRootRestoreGrantId,
  type RecoveryOperationalTrustRoot,
  type RecoveryOperationalTrustRootPayload,
  type RecoveryOperationalTrustRootRestoreAuditRecord,
  type RecoveryOperationalTrustRootRestoreDependencies,
  type RecoveryOperationalTrustRootRestoreEnvelope,
  type RecoveryOperationalTrustRootRestoreFaultPhase,
  type RecoveryOperationalTrustRootRestoreGrantPayload,
} from '../src/recovery-trust-root-restore.ts';

const RECOVERY_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns';
const RECOVERY_FINGERPRINT =
  'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U';

interface Fixture {
  root: string;
  external: string;
  externalAuditRoot: string;
  privateStoreRoot: string;
  boundary: RecoveryAuthorityImportBoundary;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function privateDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function fixture(): Fixture {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-trust-root-')),
  );
  fs.chmodSync(root, 0o700);
  const worktree = privateDirectory(root, 'worktree');
  const gitCommon = privateDirectory(root, 'git-common');
  const privateStoreRoot = privateDirectory(gitCommon, 'workflow-state');
  return {
    root,
    external: privateDirectory(root, 'offline-media'),
    externalAuditRoot: privateDirectory(root, 'external-audit'),
    privateStoreRoot,
    boundary: {
      repositoryWorktreeRoot: worktree,
      gitCommonDirectory: gitCommon,
    },
  };
}

function authority(
  allowedDomains: RecoveryAuthorityDescriptorPayloadV1['allowedDomains'] = [
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  ],
): {
  descriptor: RecoveryAuthorityDescriptorV1;
  expectations: RecoveryAuthorityExpectations;
} {
  const repositoryIdentity = {
    repositoryId: 'github:fixture-expense-app',
    origin: 'https://github.com/example/expense-app.git',
    gitObjectFormat: 'sha1' as const,
  };
  const sealedRuntime = {
    artifactId: sha256('recovery-runtime-artifact'),
    executableDigest: sha256('recovery-runtime-executable'),
    closureDigest: sha256('recovery-runtime-closure'),
    protocolVersion: 1,
  };
  const auditLedger = {
    ledgerId: 'expense-app-recovery-audit',
    rootBindingDigest: sha256('external-recovery-audit-root'),
  };
  const payload: RecoveryAuthorityDescriptorPayloadV1 = {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity,
    repositoryIdentityDigest:
      recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity),
    generation: 4,
    signer: {
      identity: 'fixture-recovery-maintainer',
      publicKey: RECOVERY_PUBLIC_KEY,
      fingerprint: RECOVERY_FINGERPRINT,
    },
    allowedDomains,
    sealedRuntime,
    auditLedger,
    createdAt: '2026-08-10T01:00:00.000Z',
  };
  const descriptor = {
    ...payload,
    descriptorDigest: recoveryAuthorityDescriptorDigest(payload),
  };
  return {
    descriptor,
    expectations: {
      repositoryIdentity,
      generation: descriptor.generation,
      signerFingerprint: descriptor.signer.fingerprint,
      sealedRuntime,
      auditLedger,
      descriptorDigest: descriptor.descriptorDigest,
    },
  };
}

function sshSigner(identity: string, seed: string) {
  const algorithm = Buffer.from('ssh-ed25519', 'ascii');
  const key = crypto.createHash('sha256').update(seed).digest();
  const blob = Buffer.alloc(4 + algorithm.length + 4 + key.length);
  blob.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(blob, 4);
  blob.writeUInt32BE(key.length, 4 + algorithm.length);
  key.copy(blob, 8 + algorithm.length);
  return {
    identity,
    publicKey: `ssh-ed25519 ${blob.toString('base64')}`,
    fingerprint: `SHA256:${crypto
      .createHash('sha256')
      .update(blob)
      .digest('base64')
      .replace(/=+$/u, '')}`,
  };
}

function trustRoot(
  descriptor: RecoveryAuthorityDescriptorV1,
  generation: number,
  createdAt: string,
  seed = `root-${generation}`,
): RecoveryOperationalTrustRoot {
  const payload: RecoveryOperationalTrustRootPayload = {
    kind: 'recovery-operational-trust-root.v1',
    repositoryId: descriptor.repositoryIdentity.repositoryId,
    generation,
    purpose: 'workflow-maintainer-signatures',
    signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
    trustedSigners: [sshSigner(`replacement-maintainer-${generation}`, seed)],
    createdAt,
  };
  return {
    ...payload,
    rootDigest: recoveryOperationalTrustRootDigest(payload),
  };
}

function unsignedGrant(
  descriptor: RecoveryAuthorityDescriptorV1,
  externalAuditRoot: string,
  replacement: RecoveryOperationalTrustRoot,
  issuedAt: string,
  expectedGeneration = replacement.generation - 1,
  expectedActivePointerDigest: `sha256:${string}` | null = null,
) {
  return {
    kind: 'recovery-operational-trust-root-restore-grant.v1' as const,
    operation: 'restore-operational-trust-root' as const,
    repositoryId: descriptor.repositoryIdentity.repositoryId,
    authorityDescriptorDigest: descriptor.descriptorDigest,
    authorityGeneration: descriptor.generation,
    recoveryRuntimeDigest: descriptor.sealedRuntime.closureDigest,
    externalAuditRoot,
    humanSigner: descriptor.signer.identity,
    signerFingerprint: descriptor.signer.fingerprint,
    expectedGeneration,
    expectedActivePointerDigest,
    replacementRootDigest: replacement.rootDigest,
    replacementGeneration: replacement.generation,
    issuedAt,
    expiresAt: new Date(
      Date.parse(issuedAt) + RECOVERY_TRUST_ROOT_RESTORE_TTL_MS,
    ).toISOString(),
    uses: 1 as const,
    oneShot: true as const,
  };
}

function grant(
  descriptor: RecoveryAuthorityDescriptorV1,
  externalAuditRoot: string,
  replacement: RecoveryOperationalTrustRoot,
  issuedAt: string,
  expectedGeneration = replacement.generation - 1,
  expectedActivePointerDigest: `sha256:${string}` | null = null,
): RecoveryOperationalTrustRootRestoreGrantPayload {
  const unsigned = unsignedGrant(
    descriptor,
    externalAuditRoot,
    replacement,
    issuedAt,
    expectedGeneration,
    expectedActivePointerDigest,
  );
  return {
    ...unsigned,
    grantId: recoveryOperationalTrustRootRestoreGrantId(unsigned),
  };
}

function signatureFor(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  replacement: RecoveryOperationalTrustRoot,
  namespace = RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
): string {
  return crypto
    .createHash('sha256')
    .update(
      `${namespace}\0${canonicalRecoveryOperationalTrustRootRestoreStatement(
        payload,
        replacement,
      )}`,
    )
    .digest('base64');
}

function envelope(
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  replacement: RecoveryOperationalTrustRoot,
  signature = signatureFor(payload, replacement),
): RecoveryOperationalTrustRootRestoreEnvelope {
  return { payload, replacement, signature };
}

function writeEnvelope(
  directory: string,
  value: RecoveryOperationalTrustRootRestoreEnvelope,
  name = `${value.payload.grantId}.json`,
): string {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `${canonicalJson(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(target, 0o600);
  return fs.realpathSync(target);
}

function verifier() {
  return (
    payload: string,
    signature: string,
    _identity: string,
    namespace: string,
  ): boolean =>
    signature ===
    crypto
      .createHash('sha256')
      .update(`${namespace}\0${payload}`)
      .digest('base64');
}

function activeReadDependencies(
  externalAuditRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
) {
  return {
    boundary,
    externalAuditRoot,
    verifyHumanSignature: verifier(),
  };
}

function dependencies(
  descriptor: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  externalAuditRoot: string,
  now: string,
  audits: RecoveryOperationalTrustRootRestoreAuditRecord[] = [],
  hook?: (
    phase: RecoveryOperationalTrustRootRestoreFaultPhase,
    targetName: string | null,
  ) => void,
): RecoveryOperationalTrustRootRestoreDependencies {
  return {
    authorityDescriptor: descriptor,
    authorityExpectations: expectations,
    externalAuditRoot,
    now: new Date(now),
    verifyHumanSignature: verifier(),
    appendAudit(record) {
      audits.push(record);
    },
    ...(hook === undefined ? {} : { hooks: { afterPhase: hook } }),
  };
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}

test('offline Recovery Authority restores an exact operational trust root and audits only after a durable terminal', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  const audits: RecoveryOperationalTrustRootRestoreAuditRecord[] = [];
  const result = executeRecoveryOperationalTrustRootRestore(
    source,
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T02:01:00.000Z',
      audits,
    ),
  );

  assert.equal(result.pointer.generation, 1);
  assert.equal(result.pointer.previousPointerDigest, null);
  assert.equal(result.pointer.rootDigest, replacement.rootDigest);
  assert.deepEqual(result.root, replacement);
  assert.equal(result.record.state, 'audited');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.newPointerDigest, result.pointer.pointerDigest);
  assert.ok(result.record.terminal);
  assert.ok(result.record.auditAcknowledgement);

  const active = readRecoveryOperationalTrustRootActive(
    files.privateStoreRoot,
    descriptor,
    expectations,
    activeReadDependencies(files.externalAuditRoot, files.boundary),
  );
  assert.deepEqual(active, { pointer: result.pointer, root: replacement });
  assert.deepEqual(
    readRecoveryOperationalTrustRootRestoreRecord(
      files.privateStoreRoot,
      payload.grantId,
    ),
    result.record,
  );

  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        source,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:02:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_GRANT_ALREADY_CONSUMED'),
  );
});

test('restore requires its independent descriptor domain, exact signature, and external canonical source', () => {
  const files = fixture();
  const denied = authority(['HARNESS_RECOVERY_GRANT_V1']);
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(denied.descriptor, 1, issuedAt);
  const payload = grant(
    denied.descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        source,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          denied.descriptor,
          denied.expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_AUTHORITY_DOMAIN_FORBIDDEN'),
  );

  const allowed = authority();
  const allowedRoot = trustRoot(allowed.descriptor, 1, issuedAt);
  const allowedPayload = grant(
    allowed.descriptor,
    files.externalAuditRoot,
    allowedRoot,
    issuedAt,
  );
  const inside = writeEnvelope(
    files.boundary.repositoryWorktreeRoot,
    envelope(allowedPayload, allowedRoot),
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        inside,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          allowed.descriptor,
          allowed.expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_EXTERNAL_SOURCE_FORBIDDEN'),
  );

  const wrongSignature = writeEnvelope(
    files.external,
    envelope(allowedPayload, allowedRoot, 'wrong-signature'),
    'wrong-signature.json',
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        wrongSignature,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          allowed.descriptor,
          allowed.expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_SIGNATURE_INVALID'),
  );
});

test('successive restore performs generation and active-pointer CAS', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const firstAt = '2026-08-10T02:00:00.000Z';
  const firstRoot = trustRoot(descriptor, 1, firstAt);
  const firstPayload = grant(
    descriptor,
    files.externalAuditRoot,
    firstRoot,
    firstAt,
  );
  const first = executeRecoveryOperationalTrustRootRestore(
    writeEnvelope(files.external, envelope(firstPayload, firstRoot)),
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T02:01:00.000Z',
    ),
  );

  const secondAt = '2026-08-10T03:00:00.000Z';
  const secondRoot = trustRoot(descriptor, 2, secondAt);
  const stalePayload = grant(
    descriptor,
    files.externalAuditRoot,
    secondRoot,
    secondAt,
    1,
    sha256('wrong-active-pointer'),
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        writeEnvelope(
          files.external,
          envelope(stalePayload, secondRoot),
          'stale.json',
        ),
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T03:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_POINTER_CAS_MISMATCH'),
  );

  const secondPayload = grant(
    descriptor,
    files.externalAuditRoot,
    secondRoot,
    secondAt,
    1,
    first.pointer.pointerDigest,
  );
  const second = executeRecoveryOperationalTrustRootRestore(
    writeEnvelope(
      files.external,
      envelope(secondPayload, secondRoot),
      'second.json',
    ),
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T03:01:00.000Z',
    ),
  );
  assert.equal(second.pointer.generation, 2);
  assert.equal(
    second.pointer.previousPointerDigest,
    first.pointer.pointerDigest,
  );
});

test('restore repairs exact crash windows on later replay without repeating the pointer effect', () => {
  const crashPhases: Array<{
    phase: RecoveryOperationalTrustRootRestoreFaultPhase;
    targetName?: string;
    targetPattern?: RegExp;
  }> = [
    { phase: 'prepare-prefix-written', targetName: 'reservation.json' },
    { phase: 'prepare-fsynced', targetName: 'reservation.json' },
    { phase: 'reservation-published' },
    { phase: 'prepare-prefix-written', targetPattern: /^[0-9a-f]{64}\.json$/ },
    { phase: 'root-published' },
    {
      phase: 'prepare-prefix-written',
      targetName: '00000000000000000001.json',
    },
    {
      phase: 'prepare-fsynced',
      targetName: '00000000000000000001.json',
    },
    { phase: 'pointer-published' },
    { phase: 'prepare-prefix-written', targetName: 'receipt.json' },
    { phase: 'receipt-published' },
    { phase: 'prepare-prefix-written', targetName: 'terminal.json' },
    { phase: 'terminal-published' },
    { phase: 'prepare-prefix-written', targetName: 'audit.json' },
    { phase: 'audit-published' },
    { phase: 'audit-appended' },
    { phase: 'prepare-prefix-written', targetName: 'audit-ack.json' },
  ];

  for (const crash of crashPhases) {
    const files = fixture();
    const { descriptor, expectations } = authority();
    const issuedAt = '2026-08-10T02:00:00.000Z';
    const replacement = trustRoot(descriptor, 1, issuedAt);
    const payload = grant(
      descriptor,
      files.externalAuditRoot,
      replacement,
      issuedAt,
    );
    const source = writeEnvelope(
      files.external,
      envelope(payload, replacement),
    );
    let crashed = false;
    assert.throws(
      () =>
        executeRecoveryOperationalTrustRootRestore(
          source,
          files.privateStoreRoot,
          files.boundary,
          dependencies(
            descriptor,
            expectations,
            files.externalAuditRoot,
            '2026-08-10T02:01:00.000Z',
            [],
            (phase, targetName) => {
              if (
                !crashed &&
                phase === crash.phase &&
                (crash.targetName === undefined ||
                  crash.targetName === targetName) &&
                (crash.targetPattern === undefined ||
                  (targetName !== null && crash.targetPattern.test(targetName)))
              ) {
                crashed = true;
                throw new Error(`crash:${phase}:${targetName ?? ''}`);
              }
            },
          ),
        ),
      /crash:/,
      `${crash.phase}:${crash.targetName ?? ''}`,
    );
    assert.equal(crashed, true);

    const audits: RecoveryOperationalTrustRootRestoreAuditRecord[] = [];
    const recovered = executeRecoveryOperationalTrustRootRestore(
      source,
      files.privateStoreRoot,
      files.boundary,
      dependencies(
        descriptor,
        expectations,
        files.externalAuditRoot,
        '2026-08-10T03:00:00.000Z',
        audits,
      ),
    );
    assert.equal(recovered.pointer.generation, 1);
    assert.equal(recovered.record.state, 'audited');
    assert.equal(audits.length, 1);
  }
});

test('exclusive expiry and malformed replacement fail before any durable effect', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        source,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          payload.expiresAt,
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_GRANT_EXPIRED'),
  );
  assert.equal(
    fs.existsSync(
      path.join(files.privateStoreRoot, 'recovery-operational-trust-root'),
    ),
    false,
  );

  const malformed = structuredClone(
    envelope(payload, replacement),
  ) as unknown as Record<string, unknown>;
  (malformed.replacement as Record<string, unknown>).unexpected = true;
  const malformedPath = path.join(files.external, 'malformed.json');
  fs.writeFileSync(malformedPath, `${canonicalJson(malformed)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(malformedPath, 0o600);
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        fs.realpathSync(malformedPath),
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_REPLACEMENT_INVALID'),
  );
});

test('external bundle and audit roots reject repository paths, symlinks, and hard links', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  const hardLink = path.join(files.external, 'hard-link.json');
  fs.linkSync(source, hardLink);
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        source,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_EXTERNAL_FILE_UNSAFE'),
  );
  fs.unlinkSync(hardLink);

  const symlink = path.join(files.external, 'symlink.json');
  fs.symlinkSync(source, symlink);
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        symlink,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_EXTERNAL_FILE_UNSAFE'),
  );

  const repositoryAuditRoot = privateDirectory(
    files.boundary.repositoryWorktreeRoot,
    'audit',
  );
  const repositoryAuditPayload = grant(
    descriptor,
    repositoryAuditRoot,
    replacement,
    issuedAt,
  );
  const repositoryAuditSource = writeEnvelope(
    files.external,
    envelope(repositoryAuditPayload, replacement),
    'repository-audit.json',
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        repositoryAuditSource,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          repositoryAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_AUDIT_ROOT_UNSAFE'),
  );
});

test('same Grant payload with another valid signature cannot take over a reserved operation', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const firstEnvelope = envelope(payload, replacement);
  const secondEnvelope = envelope(payload, replacement, 'alternate-valid');
  const firstSource = writeEnvelope(
    files.external,
    firstEnvelope,
    'first.json',
  );
  const secondSource = writeEnvelope(
    files.external,
    secondEnvelope,
    'second.json',
  );
  let crash = true;
  const acceptingVerifier = (
    statement: string,
    signature: string,
    _identity: string,
    namespace: string,
  ): boolean =>
    signature ===
      crypto
        .createHash('sha256')
        .update(`${namespace}\0${statement}`)
        .digest('base64') || signature === 'alternate-valid';
  const base = dependencies(
    descriptor,
    expectations,
    files.externalAuditRoot,
    '2026-08-10T02:01:00.000Z',
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        firstSource,
        files.privateStoreRoot,
        files.boundary,
        {
          ...base,
          verifyHumanSignature: acceptingVerifier,
          hooks: {
            afterPhase(phase) {
              if (phase === 'reservation-published' && crash) {
                crash = false;
                throw new Error('crash:reservation');
              }
            },
          },
        },
      ),
    /crash:reservation/,
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        secondSource,
        files.privateStoreRoot,
        files.boundary,
        { ...base, verifyHumanSignature: acceptingVerifier },
      ),
    hasCode('RECOVERY_TRUST_ROOT_STATE_CORRUPT'),
  );
  assert.throws(
    () =>
      readRecoveryOperationalTrustRootActive(
        files.privateStoreRoot,
        descriptor,
        expectations,
        activeReadDependencies(files.externalAuditRoot, files.boundary),
      ),
    hasCode('RECOVERY_TRUST_ROOT_TRANSITION_INCOMPLETE'),
  );
  const recovered = executeRecoveryOperationalTrustRootRestore(
    firstSource,
    files.privateStoreRoot,
    files.boundary,
    { ...base, verifyHumanSignature: acceptingVerifier },
  );
  assert.equal(recovered.pointer.rootDigest, replacement.rootDigest);
});

test('durable store rejects and preserves symlink, hard-link, and preparation substitution residue', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  let substitutedPath: string | null = null;
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        source,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
          [],
          (phase, targetName) => {
            if (
              phase !== 'prepare-fsynced' ||
              targetName !== 'reservation.json' ||
              substitutedPath !== null
            ) {
              return;
            }
            const operationRoot = path.join(
              files.privateStoreRoot,
              'recovery-operational-trust-root',
              'operations',
            );
            const operation = fs.readdirSync(operationRoot)[0]!;
            const directory = path.join(operationRoot, operation);
            const preparation = fs
              .readdirSync(directory)
              .find((name) => name.includes('.reservation.json.'))!;
            substitutedPath = path.join(directory, preparation);
            fs.unlinkSync(substitutedPath);
            fs.symlinkSync(source, substitutedPath);
          },
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_STATE_CORRUPT'),
  );
  assert.ok(substitutedPath);
  assert.equal(fs.lstatSync(substitutedPath).isSymbolicLink(), true);

  const clean = fixture();
  const cleanSource = writeEnvelope(
    clean.external,
    envelope(
      grant(descriptor, clean.externalAuditRoot, replacement, issuedAt),
      replacement,
    ),
  );
  const restored = executeRecoveryOperationalTrustRootRestore(
    cleanSource,
    clean.privateStoreRoot,
    clean.boundary,
    dependencies(
      descriptor,
      expectations,
      clean.externalAuditRoot,
      '2026-08-10T02:01:00.000Z',
    ),
  );
  const pointerPath = path.join(
    clean.privateStoreRoot,
    'recovery-operational-trust-root',
    'pointers',
    '00000000000000000001.json',
  );
  const extraLink = path.join(clean.root, 'pointer-hard-link.json');
  fs.linkSync(pointerPath, extraLink);
  assert.throws(
    () =>
      readRecoveryOperationalTrustRootActive(
        clean.privateStoreRoot,
        descriptor,
        expectations,
        activeReadDependencies(clean.externalAuditRoot, clean.boundary),
      ),
    hasCode('RECOVERY_TRUST_ROOT_STATE_CORRUPT'),
  );
  assert.equal(fs.existsSync(extraLink), true);
  assert.equal(restored.pointer.generation, 1);
});

test('restore never writes tracked trust policy, supervisor, launcher, or workflow state paths', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const sentinels = [
    path.join(files.boundary.repositoryWorktreeRoot, 'workflow-policy.json'),
    path.join(files.privateStoreRoot, 'supervisor.json'),
    path.join(files.privateStoreRoot, 'workflow-state.json'),
    path.join(files.privateStoreRoot, 'launcher.json'),
  ];
  for (const sentinel of sentinels) {
    fs.writeFileSync(sentinel, 'immutable sentinel\n', { mode: 0o600 });
    fs.chmodSync(sentinel, 0o600);
  }
  const before = sentinels.map((sentinel) => fs.readFileSync(sentinel, 'utf8'));
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  executeRecoveryOperationalTrustRootRestore(
    writeEnvelope(files.external, envelope(payload, replacement)),
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T02:01:00.000Z',
    ),
  );
  assert.deepEqual(
    sentinels.map((sentinel) => fs.readFileSync(sentinel, 'utf8')),
    before,
  );
});

test('append-only audit callback observes a durable terminal and exact immutable audit record', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  let callbackCount = 0;
  const base = dependencies(
    descriptor,
    expectations,
    files.externalAuditRoot,
    '2026-08-10T02:01:00.000Z',
  );
  const result = executeRecoveryOperationalTrustRootRestore(
    source,
    files.privateStoreRoot,
    files.boundary,
    {
      ...base,
      appendAudit(record) {
        callbackCount += 1;
        const durable = readRecoveryOperationalTrustRootRestoreRecord(
          files.privateStoreRoot,
          payload.grantId,
        );
        assert.equal(durable.state, 'consumed');
        assert.ok(durable.receipt);
        assert.ok(durable.terminal);
        assert.deepEqual(durable.audit, record);
        assert.equal(durable.auditAcknowledgement, null);
      },
    },
  );
  assert.equal(callbackCount, 1);
  assert.equal(result.record.state, 'audited');
});

test('competing signed restores cannot fork or replace the same next generation slot', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const firstRoot = trustRoot(descriptor, 1, issuedAt, 'first-root');
  const secondRoot = trustRoot(descriptor, 1, issuedAt, 'second-root');
  const firstPayload = grant(
    descriptor,
    files.externalAuditRoot,
    firstRoot,
    issuedAt,
  );
  const secondPayload = grant(
    descriptor,
    files.externalAuditRoot,
    secondRoot,
    issuedAt,
  );
  const firstSource = writeEnvelope(
    files.external,
    envelope(firstPayload, firstRoot),
    'first-competing.json',
  );
  const secondSource = writeEnvelope(
    files.external,
    envelope(secondPayload, secondRoot),
    'second-competing.json',
  );
  let crash = true;
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        firstSource,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
          [],
          (phase) => {
            if (phase === 'root-published' && crash) {
              crash = false;
              throw new Error('crash:first-root-durable');
            }
          },
        ),
      ),
    /crash:first-root-durable/,
  );
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        secondSource,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
        ),
      ),
    hasCode('RECOVERY_TRUST_ROOT_TRANSITION_INCOMPLETE'),
  );
  const first = executeRecoveryOperationalTrustRootRestore(
    firstSource,
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T03:00:00.000Z',
    ),
  );
  assert.equal(first.root.rootDigest, firstRoot.rootDigest);
  assert.equal(
    readRecoveryOperationalTrustRootActive(
      files.privateStoreRoot,
      descriptor,
      expectations,
      activeReadDependencies(files.externalAuditRoot, files.boundary),
    )?.root.rootDigest,
    firstRoot.rootDigest,
  );
});

test('unknown durable residue fails closed and is never deleted', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  executeRecoveryOperationalTrustRootRestore(
    writeEnvelope(files.external, envelope(payload, replacement)),
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T02:01:00.000Z',
    ),
  );
  const residue = path.join(
    files.privateStoreRoot,
    'recovery-operational-trust-root',
    'pointers',
    'unknown-residue',
  );
  fs.writeFileSync(residue, 'unknown\n', { mode: 0o600 });
  fs.chmodSync(residue, 0o600);
  assert.throws(
    () =>
      readRecoveryOperationalTrustRootActive(
        files.privateStoreRoot,
        descriptor,
        expectations,
        activeReadDependencies(files.externalAuditRoot, files.boundary),
      ),
    hasCode('RECOVERY_TRUST_ROOT_STATE_CORRUPT'),
  );
  assert.equal(fs.readFileSync(residue, 'utf8'), 'unknown\n');
});

test('active-root consumer re-verifies signed lineage and rejects an incomplete transition', () => {
  const files = fixture();
  const { descriptor, expectations } = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const replacement = trustRoot(descriptor, 1, issuedAt);
  const payload = grant(
    descriptor,
    files.externalAuditRoot,
    replacement,
    issuedAt,
  );
  const source = writeEnvelope(files.external, envelope(payload, replacement));
  let crash = true;
  assert.throws(
    () =>
      executeRecoveryOperationalTrustRootRestore(
        source,
        files.privateStoreRoot,
        files.boundary,
        dependencies(
          descriptor,
          expectations,
          files.externalAuditRoot,
          '2026-08-10T02:01:00.000Z',
          [],
          (phase) => {
            if (phase === 'pointer-published' && crash) {
              crash = false;
              throw new Error('crash:pointer-only');
            }
          },
        ),
      ),
    /crash:pointer-only/,
  );
  assert.throws(
    () =>
      readRecoveryOperationalTrustRootActive(
        files.privateStoreRoot,
        descriptor,
        expectations,
        activeReadDependencies(files.externalAuditRoot, files.boundary),
      ),
    hasCode('RECOVERY_TRUST_ROOT_TRANSITION_INCOMPLETE'),
  );

  executeRecoveryOperationalTrustRootRestore(
    source,
    files.privateStoreRoot,
    files.boundary,
    dependencies(
      descriptor,
      expectations,
      files.externalAuditRoot,
      '2026-08-10T03:00:00.000Z',
    ),
  );
  assert.throws(
    () =>
      readRecoveryOperationalTrustRootActive(
        files.privateStoreRoot,
        descriptor,
        expectations,
        {
          boundary: files.boundary,
          externalAuditRoot: files.externalAuditRoot,
          verifyHumanSignature: () => false,
        },
      ),
    hasCode('RECOVERY_TRUST_ROOT_PERSISTED_SIGNATURE_INVALID'),
  );
  assert.equal(
    readRecoveryOperationalTrustRootActive(
      files.privateStoreRoot,
      descriptor,
      expectations,
      activeReadDependencies(files.externalAuditRoot, files.boundary),
    )?.root.rootDigest,
    replacement.rootDigest,
  );
});
