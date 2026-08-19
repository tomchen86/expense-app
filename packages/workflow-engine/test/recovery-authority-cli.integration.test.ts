import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapRecoveryAuthorityStateRoot,
  resolveRecoveryQuarantineMarker,
} from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { runHarnessBootstrapCli } from '../src/harness-bootstrap.ts';
import {
  recoveryAuthorityDescriptorDigest,
  recoveryAuthorityRepositoryIdentityDigest,
  type RecoveryAuthorityDescriptorPayloadV1,
  type RecoveryAuthorityExpectations,
} from '../src/recovery-authority.ts';
import {
  RECOVERY_QUARANTINE_ENTER_NAMESPACE,
  RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
  canonicalRecoveryQuarantineGrantPayload,
  createRecoveryQuarantineEnterGrantPayload,
  createRecoveryQuarantineReleaseGrantPayload,
  readRecoveryQuarantineMarker,
  type RecoveryQuarantineAuditRecord,
  type RecoveryQuarantineGrantPayload,
} from '../src/recovery-quarantine.ts';
import { createFixtureRepository, git } from './fixture.ts';

const REPOSITORY_ID = 'github:R_recovery_authority_cli_fixture';
const REPOSITORY_ORIGIN = 'https://github.com/example/recovery-cli.git';
const NOW = new Date('2026-08-10T13:00:01.000Z');

test('sealed Recovery Authority CLI imports only external expectations and consumes domain-separated quarantine grants', () => {
  const fixture = setupFixture();
  const quarantineAudits: RecoveryQuarantineAuditRecord[] = [];
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(record: RecoveryQuarantineAuditRecord) {
        quarantineAudits.push(record);
      },
    },
  };

  try {
    const imported = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'import',
          fixture.descriptorPath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(
      JSON.parse(imported.stdout).result.descriptorDigest,
      fixture.expectations.descriptorDigest,
    );

    const status = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'status',
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      JSON.parse(status.stdout).result.descriptor.descriptorDigest,
      fixture.expectations.descriptorDigest,
    );
    assert.equal(JSON.parse(status.stdout).result.quarantine, null);

    const enterPayload = createRecoveryQuarantineEnterGrantPayload({
      repositoryId: REPOSITORY_ID,
      authorityDescriptorDigest: fixture.expectations.descriptorDigest,
      authorityGeneration: fixture.expectations.generation,
      recoveryRuntimeDigest: fixture.expectations.sealedRuntime.closureDigest,
      externalAuditRoot: fixture.externalAuditRoot,
      humanSigner: fixture.signerIdentity,
      signerFingerprint: fixture.expectations.signerFingerprint,
      issuedAt: '2026-08-10T13:00:00.000Z',
    });
    const enterPath = fixture.writeEnvelope(
      'enter.json',
      enterPayload,
      RECOVERY_QUARANTINE_ENTER_NAMESPACE,
    );
    const entered = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-quarantine',
          'enter',
          enterPath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(entered.status, 0, entered.stderr);
    const marker = readRecoveryQuarantineMarker(fixture.stateRoot);
    assert.ok(marker);
    assert.equal(marker.enterGrantId, enterPayload.grantId);
    assert.equal(
      resolveRecoveryQuarantineMarker(fixture.gitCommonDirectory)?.markerDigest,
      marker.markerDigest,
    );

    const statusWhileActive = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'status',
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(statusWhileActive.status, 0);
    assert.match(statusWhileActive.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);

    const releasePayload = createRecoveryQuarantineReleaseGrantPayload({
      repositoryId: REPOSITORY_ID,
      authorityDescriptorDigest: fixture.expectations.descriptorDigest,
      authorityGeneration: fixture.expectations.generation,
      recoveryRuntimeDigest: fixture.expectations.sealedRuntime.closureDigest,
      externalAuditRoot: fixture.externalAuditRoot,
      humanSigner: fixture.signerIdentity,
      signerFingerprint: fixture.expectations.signerFingerprint,
      issuedAt: '2026-08-10T13:00:00.000Z',
      activeMarkerDigest: marker.markerDigest,
    });
    const releasePath = fixture.writeEnvelope(
      'release.json',
      releasePayload,
      RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
    );
    const released = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-quarantine',
          'release',
          releasePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(released.status, 0, released.stderr);
    assert.equal(readRecoveryQuarantineMarker(fixture.stateRoot), null);
    assert.equal(
      resolveRecoveryQuarantineMarker(fixture.gitCommonDirectory),
      null,
    );
    assert.deepEqual(
      quarantineAudits.map(({ event }) => event),
      ['quarantine-entered', 'quarantine-released'],
    );

    const releaseReplay = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-quarantine',
          'release',
          releasePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(releaseReplay.status, 0);
    assert.match(
      releaseReplay.stderr,
      /RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('sealed Recovery Authority CLI rejects in-repository sources, incomplete expectations, and cross-domain signatures', () => {
  const fixture = setupFixture();
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
  };
  try {
    const incompletePath = path.join(fixture.externalRoot, 'incomplete.json');
    const { signerFingerprint: _signerFingerprint, ...incompleteExpectations } =
      fixture.expectations;
    writeCanonical(incompletePath, incompleteExpectations);
    const incomplete = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'import',
          fixture.descriptorPath,
          '--expectations',
          incompletePath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(incomplete.status, 0);

    const repositoryDescriptor = path.join(
      fixture.repository,
      'recovery-authority.json',
    );
    fs.copyFileSync(fixture.descriptorPath, repositoryDescriptor);
    fs.chmodSync(repositoryDescriptor, 0o600);
    const inside = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'import',
          repositoryDescriptor,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /RECOVERY_AUTHORITY_EXTERNAL_INPUT_UNSAFE/);

    const imported = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'import',
          fixture.descriptorPath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(imported.status, 0, imported.stderr);

    const enterPayload = createRecoveryQuarantineEnterGrantPayload({
      repositoryId: REPOSITORY_ID,
      authorityDescriptorDigest: fixture.expectations.descriptorDigest,
      authorityGeneration: fixture.expectations.generation,
      recoveryRuntimeDigest: fixture.expectations.sealedRuntime.closureDigest,
      externalAuditRoot: fixture.externalAuditRoot,
      humanSigner: fixture.signerIdentity,
      signerFingerprint: fixture.expectations.signerFingerprint,
      issuedAt: '2026-08-10T13:00:00.000Z',
    });
    const wrongDomain = fixture.writeEnvelope(
      'wrong-domain.json',
      enterPayload,
      RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
    );
    const rejected = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-quarantine',
          'enter',
          wrongDomain,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /RECOVERY_QUARANTINE_SIGNATURE_INVALID/);
    assert.equal(readRecoveryQuarantineMarker(fixture.stateRoot), null);

    const unsafeExpectations = [
      path.join(fixture.externalRoot, 'expectations-symlink.json'),
      path.join(fixture.externalRoot, 'expectations-mode.json'),
      path.join(fixture.externalRoot, 'expectations-hardlink.json'),
    ];
    fs.symlinkSync(fixture.expectationsPath, unsafeExpectations[0]!);
    fs.copyFileSync(fixture.expectationsPath, unsafeExpectations[1]!);
    fs.chmodSync(unsafeExpectations[1]!, 0o644);
    const hardlinkSource = path.join(
      fixture.externalRoot,
      'expectations-hardlink-source.json',
    );
    fs.copyFileSync(fixture.expectationsPath, hardlinkSource);
    fs.chmodSync(hardlinkSource, 0o600);
    fs.linkSync(hardlinkSource, unsafeExpectations[2]!);
    for (const expectationsPath of unsafeExpectations) {
      const unsafe = captureHarness(() =>
        runHarnessBootstrapCli(
          [
            'recovery-authority',
            'status',
            '--expectations',
            expectationsPath,
            '--json',
          ],
          fixture.repository,
          overrides,
        ),
      );
      assert.notEqual(unsafe.status, 0);
      assert.match(unsafe.stderr, /RECOVERY_AUTHORITY_EXTERNAL_INPUT_UNSAFE/);
    }
  } finally {
    fixture.cleanup();
  }
});

function setupFixture() {
  const repository = createFixtureRepository();
  git(repository, ['remote', 'add', 'origin', REPOSITORY_ORIGIN]);
  const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
  const stateRoot = bootstrapRecoveryAuthorityStateRoot(gitCommonDirectory);
  const externalRoot = privateDirectory('recovery-authority-cli-external-');
  const externalAuditRoot = privateDirectory('recovery-authority-cli-audit-');
  const signingRoot = privateDirectory('recovery-authority-cli-signing-');
  const privateKey = path.join(signingRoot, 'recovery-authority');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'recovery-authority',
      '-f',
      privateKey,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${privateKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .join(' ');
  const fingerprintOutput = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintOutput.status, 0, fingerprintOutput.stderr);
  const signerFingerprint = fingerprintOutput.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(signerFingerprint);
  const signerIdentity = 'offline-recovery-authority';
  const repositoryIdentity = {
    repositoryId: REPOSITORY_ID,
    origin: REPOSITORY_ORIGIN,
    gitObjectFormat: 'sha1' as const,
  };
  const sealedRuntime = {
    artifactId: digest('sealed-recovery-artifact'),
    executableDigest: digest('sealed-recovery-executable'),
    closureDigest: digest('sealed-recovery-closure'),
    protocolVersion: 1,
  };
  const auditLedger = {
    ledgerId: 'expense-app-recovery-authority',
    rootBindingDigest: digest('external-recovery-audit-root'),
  };
  const payload: RecoveryAuthorityDescriptorPayloadV1 = {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity,
    repositoryIdentityDigest:
      recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity),
    generation: 1,
    signer: {
      identity: signerIdentity,
      publicKey,
      fingerprint: signerFingerprint,
    },
    allowedDomains: [
      RECOVERY_QUARANTINE_ENTER_NAMESPACE,
      RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
    ],
    sealedRuntime,
    auditLedger,
    createdAt: '2026-08-10T12:00:00.000Z',
  };
  const descriptor = {
    ...payload,
    descriptorDigest: recoveryAuthorityDescriptorDigest(payload),
  };
  const expectations: RecoveryAuthorityExpectations = {
    repositoryIdentity,
    generation: descriptor.generation,
    signerFingerprint,
    sealedRuntime,
    auditLedger,
    descriptorDigest: descriptor.descriptorDigest,
  };
  const descriptorPath = path.join(externalRoot, 'descriptor.json');
  const expectationsPath = path.join(externalRoot, 'expectations.json');
  writeCanonical(descriptorPath, descriptor);
  writeCanonical(expectationsPath, expectations);

  return {
    repository,
    gitCommonDirectory,
    stateRoot,
    externalRoot,
    externalAuditRoot,
    descriptorPath,
    expectationsPath,
    expectations,
    signerIdentity,
    writeEnvelope(
      name: string,
      grantPayload: RecoveryQuarantineGrantPayload,
      namespace: string,
    ) {
      const payloadPath = path.join(signingRoot, `${name}.payload`);
      fs.writeFileSync(
        payloadPath,
        canonicalRecoveryQuarantineGrantPayload(grantPayload),
        { mode: 0o600 },
      );
      const signed = spawnSync(
        '/usr/bin/ssh-keygen',
        ['-Y', 'sign', '-f', privateKey, '-n', namespace, payloadPath],
        { encoding: 'utf8' },
      );
      assert.equal(signed.status, 0, signed.stderr);
      const envelopePath = path.join(externalRoot, name);
      writeCanonical(envelopePath, {
        payload: grantPayload,
        signature: fs.readFileSync(`${payloadPath}.sig`, 'utf8'),
      });
      return envelopePath;
    },
    cleanup() {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
      fs.rmSync(externalAuditRoot, { recursive: true, force: true });
      fs.rmSync(signingRoot, { recursive: true, force: true });
    },
  };
}

function privateDirectory(prefix: string): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writeCanonical(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function captureHarness(run: () => number): {
  status: number;
  stdout: string;
  stderr: string;
} {
  let stdout = '';
  let stderr = '';
  const previousStdout = process.stdout.write.bind(process.stdout);
  const previousStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { status: run(), stdout, stderr };
  } finally {
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
}
