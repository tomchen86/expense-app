import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES,
  RECOVERY_AUTHORITY_KNOWN_DOMAINS,
  assertRecoveryAuthorityDomain,
  importRecoveryAuthorityDescriptor,
  parseRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
  recoveryAuthorityDescriptorDigest,
  recoveryAuthorityRepositoryIdentityDigest,
  verifyRecoveryAuthorityDescriptor,
  type RecoveryAuthorityDescriptorPayloadV1,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
  type RecoveryAuthorityImportBoundary,
} from '../src/recovery-authority.ts';

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns';
const FINGERPRINT = 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U';
const REPOSITORY_IDENTITY = {
  repositoryId: 'github:fixture-expense-app',
  origin: 'https://github.com/example/expense-app.git',
  gitObjectFormat: 'sha1' as const,
};
const SEALED_RUNTIME = {
  artifactId: sha256('recovery-runtime-artifact'),
  executableDigest: sha256('recovery-runtime-executable'),
  closureDigest: sha256('recovery-runtime-closure'),
  protocolVersion: 1,
};
const AUDIT_LEDGER = {
  ledgerId: 'expense-app-recovery-audit',
  rootBindingDigest: sha256('external-recovery-audit-root'),
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function descriptor(
  mutate: (
    value: RecoveryAuthorityDescriptorPayloadV1,
  ) => RecoveryAuthorityDescriptorPayloadV1 = (value) => value,
): RecoveryAuthorityDescriptorV1 {
  const repositoryIdentityDigest =
    recoveryAuthorityRepositoryIdentityDigest(REPOSITORY_IDENTITY);
  const payload = mutate({
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity: REPOSITORY_IDENTITY,
    repositoryIdentityDigest,
    generation: 1,
    signer: {
      identity: 'fixture-recovery-maintainer',
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    },
    allowedDomains: [
      RECOVERY_AUTHORITY_KNOWN_DOMAINS[0],
      RECOVERY_AUTHORITY_KNOWN_DOMAINS[1],
    ],
    sealedRuntime: SEALED_RUNTIME,
    auditLedger: AUDIT_LEDGER,
    createdAt: '2026-08-10T01:00:00.000Z',
  });
  return {
    ...payload,
    descriptorDigest: recoveryAuthorityDescriptorDigest(payload),
  };
}

function expectations(
  value: RecoveryAuthorityDescriptorV1,
  overrides: Partial<RecoveryAuthorityExpectations> = {},
): RecoveryAuthorityExpectations {
  return {
    repositoryIdentity: REPOSITORY_IDENTITY,
    generation: value.generation,
    signerFingerprint: FINGERPRINT,
    sealedRuntime: SEALED_RUNTIME,
    auditLedger: AUDIT_LEDGER,
    descriptorDigest: value.descriptorDigest,
    ...overrides,
  };
}

function privateDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function importBoundary(): RecoveryAuthorityImportBoundary {
  const root = privateDirectory('recovery-authority-boundary-');
  const repositoryWorktreeRoot = path.join(root, 'worktree');
  const gitCommonDirectory = path.join(root, 'git-common');
  fs.mkdirSync(repositoryWorktreeRoot, { mode: 0o700 });
  fs.mkdirSync(gitCommonDirectory, { mode: 0o700 });
  return {
    repositoryWorktreeRoot: fs.realpathSync(repositoryWorktreeRoot),
    gitCommonDirectory: fs.realpathSync(gitCommonDirectory),
  };
}

function privateStoreRoot(
  boundary: RecoveryAuthorityImportBoundary,
  prefix: string,
): string {
  const directory = fs.mkdtempSync(
    path.join(boundary.gitCommonDirectory, `${prefix}-`),
  );
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function writeExternalDescriptor(
  directory: string,
  value: unknown,
  name = 'recovery-authority.json',
): string {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `${canonicalJson(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(target, 0o600);
  return target;
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}

test('external RecoveryAuthorityDescriptor imports without Git or current-HEAD inputs and reopens idempotently', () => {
  const externalRoot = privateDirectory('recovery-authority-external-');
  const boundary = importBoundary();
  const storeRoot = privateStoreRoot(boundary, 'authority-store');
  const value = descriptor();
  const source = writeExternalDescriptor(externalRoot, value);

  const imported = importRecoveryAuthorityDescriptor(
    source,
    storeRoot,
    expectations(value),
    boundary,
  );
  const replay = importRecoveryAuthorityDescriptor(
    source,
    storeRoot,
    expectations(value),
    boundary,
  );
  const reopened = readRecoveryAuthorityDescriptor(
    storeRoot,
    expectations(value),
    boundary,
  );

  assert.deepEqual(imported, value);
  assert.deepEqual(replay, value);
  assert.deepEqual(reopened, value);
  assert.ok(Object.isFrozen(imported));
  assert.equal(
    fs.statSync(path.join(storeRoot, 'recovery-authority')).mode & 0o777,
    0o700,
  );
  assert.equal(
    fs.statSync(path.join(storeRoot, 'recovery-authority', 'descriptor.json'))
      .mode & 0o777,
    0o600,
  );
});

test('descriptor verification requires exact out-of-band repository, digest, generation, runtime, audit, and fingerprint bindings', () => {
  const value = descriptor();
  assert.deepEqual(
    verifyRecoveryAuthorityDescriptor(value, expectations(value)),
    value,
  );

  for (const missing of ['descriptorDigest', 'signerFingerprint'] as const) {
    const incomplete: Partial<RecoveryAuthorityExpectations> = {
      ...expectations(value),
    };
    delete incomplete[missing];
    assert.throws(
      () =>
        verifyRecoveryAuthorityDescriptor(
          value,
          incomplete as RecoveryAuthorityExpectations,
        ),
      hasCode('RECOVERY_AUTHORITY_EXPECTATION_INVALID'),
    );
  }
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(value, {
        ...expectations(value),
        source: 'current-head',
      } as RecoveryAuthorityExpectations),
    hasCode('RECOVERY_AUTHORITY_EXPECTATION_INVALID'),
  );

  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(
        value,
        expectations(value, {
          repositoryIdentity: {
            ...REPOSITORY_IDENTITY,
            repositoryId: 'github:another-repository',
          },
        }),
      ),
    hasCode('RECOVERY_AUTHORITY_REPOSITORY_MISMATCH'),
  );
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(
        value,
        expectations(value, { descriptorDigest: sha256('wrong-descriptor') }),
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_DIGEST_MISMATCH'),
  );
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(
        value,
        expectations(value, {
          signerFingerprint:
            'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      ),
    hasCode('RECOVERY_AUTHORITY_SIGNER_FINGERPRINT_MISMATCH'),
  );
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(
        value,
        expectations(value, { generation: value.generation + 1 }),
      ),
    hasCode('RECOVERY_AUTHORITY_GENERATION_MISMATCH'),
  );
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(
        value,
        expectations(value, {
          sealedRuntime: {
            ...SEALED_RUNTIME,
            closureDigest: sha256('wrong-runtime'),
          },
        }),
      ),
    hasCode('RECOVERY_AUTHORITY_RUNTIME_MISMATCH'),
  );
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(
        value,
        expectations(value, {
          auditLedger: {
            ...AUDIT_LEDGER,
            rootBindingDigest: sha256('wrong-audit'),
          },
        }),
      ),
    hasCode('RECOVERY_AUTHORITY_AUDIT_BINDING_MISMATCH'),
  );

  const narrowerAuthority = descriptor((payload) => ({
    ...payload,
    allowedDomains: [RECOVERY_AUTHORITY_KNOWN_DOMAINS[1]],
  }));
  assert.throws(
    () =>
      verifyRecoveryAuthorityDescriptor(narrowerAuthority, expectations(value)),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_DIGEST_MISMATCH'),
  );
});

test('descriptor schema is exact, validates its own digests and public-key fingerprint, and fixes the domain allowlist', () => {
  const value = descriptor();
  assert.ok(Object.isFrozen(RECOVERY_AUTHORITY_KNOWN_DOMAINS));
  assert.throws(
    () => parseRecoveryAuthorityDescriptor({ ...value, signature: 'self' }),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_INVALID'),
  );
  assert.throws(
    () =>
      parseRecoveryAuthorityDescriptor({
        ...value,
        repositoryIdentityDigest: sha256('wrong-repository-binding'),
      }),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_INVALID'),
  );
  assert.throws(
    () =>
      parseRecoveryAuthorityDescriptor({
        ...value,
        descriptorDigest: sha256('wrong-self-digest'),
      }),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_INVALID'),
  );
  const wrongFingerprintPayload = {
    ...value,
    signer: {
      ...value.signer,
      fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };
  const { descriptorDigest: _ignored, ...wrongFingerprintWithoutDigest } =
    wrongFingerprintPayload;
  assert.throws(
    () =>
      parseRecoveryAuthorityDescriptor({
        ...wrongFingerprintWithoutDigest,
        descriptorDigest: recoveryAuthorityDescriptorDigest(
          wrongFingerprintWithoutDigest,
        ),
      }),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_INVALID'),
  );
  for (const allowedDomains of [
    [],
    [...value.allowedDomains].reverse(),
    [value.allowedDomains[0], value.allowedDomains[0]],
    ['HARNESS_TASK_MANDATE_V1'],
  ]) {
    assert.throws(
      () =>
        parseRecoveryAuthorityDescriptor({
          ...value,
          allowedDomains,
        }),
      hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_INVALID'),
    );
  }
});

test('private import rejects missing, symlinked, hard-linked, non-private, and oversized descriptor files', () => {
  const externalRoot = privateDirectory('recovery-authority-files-');
  const value = descriptor();
  const expected = expectations(value);
  const boundary = importBoundary();

  const emptyStore = privateStoreRoot(boundary, 'empty-store');
  assert.throws(
    () => readRecoveryAuthorityDescriptor(emptyStore, expected, boundary),
    hasCode('RECOVERY_AUTHORITY_NOT_PROVISIONED'),
  );
  assert.equal(
    fs.lstatSync(path.join(emptyStore, 'recovery-authority'), {
      throwIfNoEntry: false,
    }),
    undefined,
  );

  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        path.join(externalRoot, 'missing.json'),
        privateStoreRoot(boundary, 'missing-store'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_MISSING'),
  );

  const regular = writeExternalDescriptor(externalRoot, value, 'regular.json');
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        regular,
        privateDirectory('recovery-authority-unbound-store-'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_STORE_BOUNDARY_MISMATCH'),
  );
  const symlink = path.join(externalRoot, 'symlink.json');
  fs.symlinkSync(regular, symlink);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        symlink,
        privateStoreRoot(boundary, 'symlink-store'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_FILE_UNSAFE'),
  );

  const hardlink = path.join(externalRoot, 'hardlink.json');
  fs.linkSync(regular, hardlink);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        hardlink,
        privateStoreRoot(boundary, 'hardlink-store'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_FILE_UNSAFE'),
  );
  fs.unlinkSync(hardlink);

  for (const repositoryRoot of [
    boundary.repositoryWorktreeRoot,
    boundary.gitCommonDirectory,
  ]) {
    const repositorySource = writeExternalDescriptor(
      repositoryRoot,
      value,
      `inside-${path.basename(repositoryRoot)}.json`,
    );
    assert.throws(
      () =>
        importRecoveryAuthorityDescriptor(
          repositorySource,
          privateStoreRoot(boundary, 'repo-source-store'),
          expected,
          boundary,
        ),
      hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_SOURCE_FORBIDDEN'),
    );
  }

  const symlinkParentRoot = privateDirectory(
    'recovery-authority-symlink-parent-',
  );
  const symlinkParent = path.join(symlinkParentRoot, 'external');
  fs.symlinkSync(externalRoot, symlinkParent);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        path.join(symlinkParent, path.basename(regular)),
        privateStoreRoot(boundary, 'symlink-parent-store'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_FILE_UNSAFE'),
  );

  const boundaryAlias = path.join(symlinkParentRoot, 'worktree');
  fs.symlinkSync(boundary.repositoryWorktreeRoot, boundaryAlias);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        regular,
        privateStoreRoot(boundary, 'boundary-alias-store'),
        expected,
        { ...boundary, repositoryWorktreeRoot: boundaryAlias },
      ),
    hasCode('RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID'),
  );
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        regular,
        privateStoreRoot(boundary, 'boundary-extra-store'),
        expected,
        {
          ...boundary,
          source: 'caller-asserted-external',
        } as RecoveryAuthorityImportBoundary,
      ),
    hasCode('RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID'),
  );

  fs.chmodSync(regular, 0o644);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        regular,
        privateStoreRoot(boundary, 'mode-store'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_FILE_UNSAFE'),
  );

  const oversized = path.join(externalRoot, 'oversized.json');
  fs.writeFileSync(
    oversized,
    Buffer.alloc(MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES + 1, 0x20),
    { flag: 'wx', mode: 0o600 },
  );
  fs.chmodSync(oversized, 0o600);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        oversized,
        privateStoreRoot(boundary, 'oversize-store'),
        expected,
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_DESCRIPTOR_TOO_LARGE'),
  );
});

test('recovery authority rejects cross-domain use and signer substitution', () => {
  const value = verifyRecoveryAuthorityDescriptor(
    descriptor(),
    expectations(descriptor()),
  );
  assert.doesNotThrow(() =>
    assertRecoveryAuthorityDomain(
      value,
      expectations(value),
      RECOVERY_AUTHORITY_KNOWN_DOMAINS[0],
      FINGERPRINT,
    ),
  );
  assert.throws(
    () =>
      assertRecoveryAuthorityDomain(
        value,
        expectations(value),
        RECOVERY_AUTHORITY_KNOWN_DOMAINS[2],
        FINGERPRINT,
      ),
    hasCode('RECOVERY_AUTHORITY_DOMAIN_FORBIDDEN'),
  );
  assert.throws(
    () =>
      assertRecoveryAuthorityDomain(
        value,
        expectations(value),
        'HARNESS_TASK_MANDATE_V1',
        FINGERPRINT,
      ),
    hasCode('RECOVERY_AUTHORITY_DOMAIN_FORBIDDEN'),
  );
  assert.throws(
    () =>
      assertRecoveryAuthorityDomain(
        value,
        expectations(value),
        RECOVERY_AUTHORITY_KNOWN_DOMAINS[0],
        'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    hasCode('RECOVERY_AUTHORITY_SIGNER_FINGERPRINT_MISMATCH'),
  );
});

test('an imported authority cannot self-sign or overwrite its own replacement', () => {
  const externalRoot = privateDirectory('recovery-authority-replace-');
  const boundary = importBoundary();
  const storeRoot = privateStoreRoot(boundary, 'replace-store');
  const first = descriptor();
  importRecoveryAuthorityDescriptor(
    writeExternalDescriptor(externalRoot, first, 'first.json'),
    storeRoot,
    expectations(first),
    boundary,
  );

  const replacement = descriptor((value) => ({
    ...value,
    generation: 2,
    createdAt: '2026-08-10T02:00:00.000Z',
  }));
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        writeExternalDescriptor(externalRoot, replacement, 'replacement.json'),
        storeRoot,
        expectations(replacement, { generation: 2 }),
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_REPLACEMENT_FORBIDDEN'),
  );
  assert.deepEqual(
    readRecoveryAuthorityDescriptor(storeRoot, expectations(first), boundary),
    first,
  );
});

test('an exact replay reconciles every durable import crash phase without deleting an incomplete preparation', () => {
  for (const phase of [
    'prepare-prefix-written',
    'prepare-fsynced',
    'prepared',
    'published',
  ] as const) {
    const externalRoot = privateDirectory(`recovery-authority-${phase}-`);
    const boundary = importBoundary();
    const storeRoot = privateStoreRoot(boundary, `${phase}-store`);
    const value = descriptor();
    const source = writeExternalDescriptor(externalRoot, value);
    const simulatedCrash = new Error(`simulated crash at ${phase}`);

    assert.throws(
      () =>
        importRecoveryAuthorityDescriptor(
          source,
          storeRoot,
          expectations(value),
          boundary,
          {
            afterPhase(observed) {
              if (observed === phase) throw simulatedCrash;
            },
          },
        ),
      (error) => error === simulatedCrash,
    );

    const directory = path.join(storeRoot, 'recovery-authority');
    const preparationNames = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith('descriptor.prepare.'));
    assert.equal(preparationNames.length, phase === 'prepared' ? 2 : 1);
    const preparationPaths = preparationNames.map((name) =>
      path.join(directory, name),
    );
    const preparationPath = preparationPaths[0]!;
    const target = path.join(directory, 'descriptor.json');

    if (phase === 'published') {
      const prepared = fs.lstatSync(preparationPath);
      const published = fs.lstatSync(target);
      assert.equal(prepared.dev, published.dev);
      assert.equal(prepared.ino, published.ino);
      assert.equal(published.nlink, 2);
    } else if (phase === 'prepared') {
      const [left, right] = preparationPaths.map((candidate) =>
        fs.lstatSync(candidate),
      );
      assert.equal(left!.dev, right!.dev);
      assert.equal(left!.ino, right!.ino);
      assert.equal(left!.nlink, 2);
      assert.equal(right!.nlink, 2);
      assert.equal(fs.existsSync(target), false);
    } else {
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.lstatSync(preparationPath).nlink, 1);
    }

    assert.deepEqual(
      importRecoveryAuthorityDescriptor(
        source,
        storeRoot,
        expectations(value),
        boundary,
      ),
      value,
    );
    assert.deepEqual(
      readRecoveryAuthorityDescriptor(storeRoot, expectations(value), boundary),
      value,
    );
    assert.equal(fs.lstatSync(target).nlink, 1);
    for (const crashedPreparation of preparationPaths) {
      assert.equal(
        fs.existsSync(crashedPreparation),
        phase === 'prepare-prefix-written',
        'only an incomplete/unknown preparation must be preserved',
      );
    }
  }
});

test('a different descriptor cannot take over an incomplete or durable preparation', () => {
  for (const crashPhase of [
    'prepare-prefix-written',
    'prepare-fsynced',
    'prepared',
  ] as const) {
    const externalRoot = privateDirectory(
      `recovery-authority-${crashPhase}-takeover-`,
    );
    const boundary = importBoundary();
    const storeRoot = privateStoreRoot(
      boundary,
      `${crashPhase}-takeover-store`,
    );
    const first = descriptor();
    const firstSource = writeExternalDescriptor(
      externalRoot,
      first,
      'first.json',
    );
    const simulatedCrash = new Error(`simulated crash at ${crashPhase}`);

    assert.throws(
      () =>
        importRecoveryAuthorityDescriptor(
          firstSource,
          storeRoot,
          expectations(first),
          boundary,
          {
            afterPhase(phase) {
              if (phase === crashPhase) throw simulatedCrash;
            },
          },
        ),
      (error) => error === simulatedCrash,
    );

    const directory = path.join(storeRoot, 'recovery-authority');
    const residueBefore = new Map(
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('descriptor.prepare.'))
        .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
    );
    assert.ok(residueBefore.size > 0);

    const replacement = descriptor((value) => ({
      ...value,
      generation: 2,
      createdAt: '2026-08-10T02:00:00.000Z',
    }));
    const replacementSource = writeExternalDescriptor(
      externalRoot,
      replacement,
      'replacement.json',
    );
    assert.throws(
      () =>
        importRecoveryAuthorityDescriptor(
          replacementSource,
          storeRoot,
          expectations(replacement, { generation: 2 }),
          boundary,
        ),
      hasCode('RECOVERY_AUTHORITY_REPLACEMENT_FORBIDDEN'),
    );
    assert.equal(fs.existsSync(path.join(directory, 'descriptor.json')), false);
    for (const [name, bytes] of residueBefore) {
      assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
    }

    assert.deepEqual(
      importRecoveryAuthorityDescriptor(
        firstSource,
        storeRoot,
        expectations(first),
        boundary,
      ),
      first,
    );
  }
});

test('unsafe or unrelated preparation residue is preserved rather than deleted or trusted', () => {
  const externalRoot = privateDirectory('recovery-authority-residue-');
  const boundary = importBoundary();
  const value = descriptor();
  const source = writeExternalDescriptor(externalRoot, value);

  const unsafeStore = privateStoreRoot(boundary, 'unsafe-residue-store');
  const unsafeDirectory = path.join(unsafeStore, 'recovery-authority');
  fs.mkdirSync(unsafeDirectory, { mode: 0o700 });
  const unsafeResidue = path.join(
    unsafeDirectory,
    `descriptor.prepare.${value.descriptorDigest.slice('sha256:'.length)}.${process.pid}.${crypto.randomUUID()}.json`,
  );
  fs.symlinkSync(source, unsafeResidue);
  assert.throws(
    () =>
      importRecoveryAuthorityDescriptor(
        source,
        unsafeStore,
        expectations(value),
        boundary,
      ),
    hasCode('RECOVERY_AUTHORITY_STORE_CORRUPT'),
  );
  assert.equal(fs.lstatSync(unsafeResidue).isSymbolicLink(), true);
  assert.equal(
    fs.existsSync(path.join(unsafeDirectory, 'descriptor.json')),
    false,
  );

  const unrelatedStore = privateStoreRoot(boundary, 'unrelated-residue-store');
  const unrelatedDirectory = path.join(unrelatedStore, 'recovery-authority');
  fs.mkdirSync(unrelatedDirectory, { mode: 0o700 });
  const unrelatedResidue = path.join(unrelatedDirectory, 'operator-residue');
  fs.writeFileSync(unrelatedResidue, 'do not delete\n', {
    flag: 'wx',
    mode: 0o600,
  });
  assert.deepEqual(
    importRecoveryAuthorityDescriptor(
      source,
      unrelatedStore,
      expectations(value),
      boundary,
    ),
    value,
  );
  assert.equal(fs.readFileSync(unrelatedResidue, 'utf8'), 'do not delete\n');
});
