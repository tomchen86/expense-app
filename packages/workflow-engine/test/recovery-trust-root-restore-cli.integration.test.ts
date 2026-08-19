import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapRecoveryAuthorityStateRoot,
  resolveRecoveryOperationalTrustRootFence,
  resolveRecoveryQuarantineMarker,
} from '../bootstrap/control-plane-trust.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
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
import {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  RECOVERY_TRUST_ROOT_RESTORE_TTL_MS,
  canonicalRecoveryOperationalTrustRootRestoreStatement,
  readRecoveryOperationalTrustRootActive,
  recoveryOperationalTrustRootDigest,
  recoveryOperationalTrustRootRestoreGrantId,
  type RecoveryOperationalTrustRoot,
  type RecoveryOperationalTrustRootPayload,
  type RecoveryOperationalTrustRootRestoreAuditRecord,
  type RecoveryOperationalTrustRootRestoreGrantPayload,
} from '../src/recovery-trust-root-restore.ts';
import { verifySshSignatureWithPublicKey } from '../src/maintainer-signer.ts';
import { createFixtureRepository, git } from './fixture.ts';

const REPOSITORY_ID = 'github:R_recovery_trust_root_cli_fixture';
const REPOSITORY_ORIGIN =
  'https://github.com/example/recovery-trust-root-cli.git';
const ISSUED_AT = '2026-08-10T13:00:00.000Z';
const NOW = new Date('2026-08-10T13:00:01.000Z');

test('sealed restore-trust-root CLI requires active quarantine and persists an audited generation without releasing it', () => {
  const fixture = setupFixture();
  const restoreAudits: RecoveryOperationalTrustRootRestoreAuditRecord[] = [];
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
    recoveryTrustRootAuditSink: {
      append(record: RecoveryOperationalTrustRootRestoreAuditRecord) {
        restoreAudits.push(record);
      },
    },
  };
  try {
    fixture.importAuthority(overrides);
    const restorePath = fixture.writeRestoreEnvelope(
      'restore-operational-root.json',
      1,
      null,
    );
    const inactive = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          restorePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(inactive.status, 0);
    assert.match(inactive.stderr, /RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED/);
    assert.equal(
      resolveRecoveryOperationalTrustRootFence(fixture.gitCommon),
      false,
    );

    fixture.enterQuarantine(overrides);
    const restored = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          restorePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(restored.status, 0, restored.stderr);
    const result = JSON.parse(restored.stdout).result;
    assert.equal(result.pointer.generation, 1);
    assert.equal(result.record.state, 'audited');
    assert.equal(restoreAudits.length, 1);
    assert.ok(readRecoveryQuarantineMarker(fixture.stateRoot));
    assert.ok(resolveRecoveryQuarantineMarker(fixture.gitCommon));
    assert.equal(
      resolveRecoveryOperationalTrustRootFence(fixture.gitCommon),
      true,
    );

    const active = readRecoveryOperationalTrustRootActive(
      fixture.stateRoot,
      fixture.descriptor,
      fixture.expectations,
      {
        boundary: {
          repositoryWorktreeRoot: fixture.repository,
          gitCommonDirectory: fixture.gitCommon,
        },
        externalAuditRoot: fixture.externalAuditRoot,
        verifyHumanSignature(payload, signature, identity, namespace) {
          try {
            verifySshSignatureWithPublicKey(
              payload,
              signature,
              identity,
              fixture.descriptor.signer.publicKey,
              namespace,
            );
            return true;
          } catch {
            return false;
          }
        },
      },
    );
    assert.equal(active?.pointer.generation, 1);
    assert.equal(active?.root.rootDigest, result.root.rootDigest);

    const replay = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          restorePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /RECOVERY_TRUST_ROOT_GRANT_ALREADY_CONSUMED/);
  } finally {
    fixture.cleanup();
  }
});

test('restore routing rejects wrong quarantine binding and non-exact argv without writing a root', () => {
  const fixture = setupFixture();
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
    recoveryTrustRootAuditSink: {
      append(_record: RecoveryOperationalTrustRootRestoreAuditRecord) {},
    },
  };
  try {
    fixture.importAuthority(overrides);
    fixture.enterQuarantine(overrides);
    const otherAudit = privateDirectory('recovery-root-other-audit-');
    const mismatched = fixture.writeRestoreEnvelope(
      'mismatched-audit-root.json',
      1,
      null,
      otherAudit,
    );
    const mismatch = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          mismatched,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /RECOVERY_TRUST_ROOT_QUARANTINE_MISMATCH/);
    assert.equal(
      resolveRecoveryOperationalTrustRootFence(fixture.gitCommon),
      false,
    );

    const exact = fixture.writeRestoreEnvelope('exact.json', 1, null);
    const extraArg = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          exact,
          '--expectations',
          fixture.expectationsPath,
          '--unexpected',
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(extraArg.status, 0);
    assert.match(extraArg.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.equal(
      resolveRecoveryOperationalTrustRootFence(fixture.gitCommon),
      false,
    );
    fs.rmSync(otherAudit, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

test('restore rechecks the exact quarantine marker immediately before persistence', () => {
  const fixture = setupFixture();
  const baseOverrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
    recoveryTrustRootAuditSink: {
      append(_record: RecoveryOperationalTrustRootRestoreAuditRecord) {},
    },
  };
  try {
    fixture.importAuthority(baseOverrides);
    fixture.enterQuarantine(baseOverrides);
    const restorePath = fixture.writeRestoreEnvelope(
      'raced-root.json',
      1,
      null,
    );
    let released = false;
    const raced = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          restorePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        {
          ...baseOverrides,
          beforeRecoveryTrustRootExecute() {
            released = true;
            fixture.releaseQuarantine(baseOverrides);
          },
        },
      ),
    );
    assert.equal(released, true);
    assert.notEqual(raced.status, 0);
    assert.match(raced.stderr, /RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED/);
    assert.equal(
      resolveRecoveryOperationalTrustRootFence(fixture.gitCommon),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('bootstrap inventory treats an unsafe restored-root entry as a hard fence', () => {
  const fixture = setupFixture();
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
  };
  try {
    fixture.importAuthority(overrides);
    fs.linkSync(
      fixture.descriptorPath,
      path.join(fixture.stateRoot, 'recovery-operational-trust-root'),
    );
    assert.throws(
      () => resolveRecoveryOperationalTrustRootFence(fixture.gitCommon),
      (error: unknown) =>
        errorCode(error) === 'WORKFLOW_RECOVERY_QUARANTINE_STATE_CORRUPT',
    );
    const direct = captureHarness(() =>
      runHarnessBootstrapCli(['--help'], fixture.repository, overrides),
    );
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /RECOVERY_OPERATIONAL_TRUST_STATE_UNSAFE/);
  } finally {
    fixture.cleanup();
  }
});

test('active-quarantine harness refusals append one durable audit and preserve the refusal if audit writing fails', () => {
  const fixture = setupFixture();
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
  };
  try {
    fixture.importAuthority(overrides);
    fixture.enterQuarantine(overrides);
    const refused = captureHarness(() =>
      runHarnessBootstrapCli(['--help'], fixture.repository, overrides),
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);

    const scope = {
      externalAuditRoot: fixture.externalAuditRoot,
      repositoryRoot: fixture.repository,
      repositoryId: deriveAuthorityAuditRepositoryId(REPOSITORY_ID),
    };
    let verified = verifyAuthorityAuditEvents(scope);
    const refusals = verified.events.filter(
      ({ event }) =>
        event.errorCode === 'WORKFLOW_RECOVERY_QUARANTINED' &&
        event.command?.name === 'harness-bootstrap.rejection',
    );
    assert.equal(refusals.length, 1);
    assert.equal(
      refusals[0]?.event.prestateDigest,
      readRecoveryQuarantineMarker(fixture.stateRoot)?.markerDigest,
    );

    const replay = captureHarness(() =>
      runHarnessBootstrapCli(['--help'], fixture.repository, overrides),
    );
    assert.match(replay.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    verified = verifyAuthorityAuditEvents(scope);
    assert.equal(
      verified.events.filter(
        ({ event }) =>
          event.errorCode === 'WORKFLOW_RECOVERY_QUARANTINED' &&
          event.command?.name === 'harness-bootstrap.rejection',
      ).length,
      1,
    );

    fs.chmodSync(fixture.externalAuditRoot, 0o755);
    const auditFailure = captureHarness(() =>
      runHarnessBootstrapCli(
        ['recovery-authority', 'status'],
        fixture.repository,
        overrides,
      ),
    );
    fs.chmodSync(fixture.externalAuditRoot, 0o700);
    assert.notEqual(auditFailure.status, 0);
    assert.match(auditFailure.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(auditFailure.stderr, /AUTHORITY_AUDIT_/);
  } finally {
    fs.chmodSync(fixture.externalAuditRoot, 0o700);
    fixture.cleanup();
  }
});

test('launcher routes only exact quarantined restore and keeps ordinary workflow fenced after release', () => {
  const fixture = setupFixture();
  const overrides = {
    now: () => new Date(NOW),
    recoveryQuarantineAuditSink: {
      append(_record: RecoveryQuarantineAuditRecord) {},
    },
    recoveryTrustRootAuditSink: {
      append(_record: RecoveryOperationalTrustRootRestoreAuditRecord) {},
    },
  };
  try {
    fixture.importAuthority(overrides);
    fixture.enterQuarantine(overrides);
    const malformed = path.join(fixture.externalRoot, 'malformed-restore.json');
    writeCanonical(malformed, { invalid: true });
    const routed = fixture.launch([
      'recovery-authority',
      'restore-trust-root',
      malformed,
      '--expectations',
      fixture.expectationsPath,
      '--json',
    ]);
    assert.notEqual(routed.status, 0);
    assert.doesNotMatch(routed.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.match(routed.stderr, /RECOVERY_TRUST_ROOT_GRANT_INVALID/);

    const restorePath = fixture.writeRestoreEnvelope(
      'launcher-root.json',
      1,
      null,
    );
    const restored = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          restorePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.equal(restored.status, 0, restored.stderr);
    fixture.releaseQuarantine(overrides);
    assert.equal(readRecoveryQuarantineMarker(fixture.stateRoot), null);

    const ordinary = fixture.launch(['--help']);
    assert.notEqual(ordinary.status, 0);
    assert.match(ordinary.stderr, /RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED/);

    const inactiveRestore = captureHarness(() =>
      runHarnessBootstrapCli(
        [
          'recovery-authority',
          'restore-trust-root',
          restorePath,
          '--expectations',
          fixture.expectationsPath,
          '--json',
        ],
        fixture.repository,
        overrides,
      ),
    );
    assert.notEqual(inactiveRestore.status, 0);
    assert.match(
      inactiveRestore.stderr,
      /RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED|RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED/,
    );
  } finally {
    fixture.cleanup();
  }
});

function setupFixture() {
  const repository = fs.realpathSync(createFixtureRepository());
  git(repository, ['remote', 'add', 'origin', REPOSITORY_ORIGIN]);
  const gitCommon = fs.realpathSync(path.join(repository, '.git'));
  const stateRoot = bootstrapRecoveryAuthorityStateRoot(gitCommon);
  const externalRoot = privateDirectory('recovery-root-cli-external-');
  const externalAuditRoot = privateDirectory('recovery-root-cli-audit-');
  const signingRoot = privateDirectory('recovery-root-cli-signing-');
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
  const descriptorPayload: RecoveryAuthorityDescriptorPayloadV1 = {
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
      RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    ],
    sealedRuntime,
    auditLedger,
    createdAt: '2026-08-10T12:00:00.000Z',
  };
  const descriptor = {
    ...descriptorPayload,
    descriptorDigest: recoveryAuthorityDescriptorDigest(descriptorPayload),
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

  const sign = (payload: string, namespace: string, name: string): string => {
    const payloadPath = path.join(signingRoot, `${name}.payload`);
    fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
    const signed = spawnSync(
      '/usr/bin/ssh-keygen',
      ['-Y', 'sign', '-f', privateKey, '-n', namespace, payloadPath],
      { encoding: 'utf8' },
    );
    assert.equal(signed.status, 0, signed.stderr);
    return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
  };

  const writeQuarantineEnvelope = (
    name: string,
    payload: RecoveryQuarantineGrantPayload,
    namespace: string,
  ): string => {
    const target = path.join(externalRoot, name);
    writeCanonical(target, {
      payload,
      signature: sign(
        canonicalRecoveryQuarantineGrantPayload(payload),
        namespace,
        name,
      ),
    });
    return target;
  };

  const fixture = {
    repository,
    gitCommon,
    stateRoot,
    externalRoot,
    externalAuditRoot,
    descriptorPath,
    expectationsPath,
    descriptor,
    expectations,
    importAuthority(overrides: Parameters<typeof runHarnessBootstrapCli>[2]) {
      const imported = captureHarness(() =>
        runHarnessBootstrapCli(
          [
            'recovery-authority',
            'import',
            descriptorPath,
            '--expectations',
            expectationsPath,
            '--json',
          ],
          repository,
          overrides,
        ),
      );
      assert.equal(imported.status, 0, imported.stderr);
    },
    enterQuarantine(overrides: Parameters<typeof runHarnessBootstrapCli>[2]) {
      const payload = createRecoveryQuarantineEnterGrantPayload({
        repositoryId: REPOSITORY_ID,
        authorityDescriptorDigest: expectations.descriptorDigest,
        authorityGeneration: expectations.generation,
        recoveryRuntimeDigest: expectations.sealedRuntime.closureDigest,
        externalAuditRoot,
        humanSigner: signerIdentity,
        signerFingerprint,
        issuedAt: ISSUED_AT,
      });
      const source = writeQuarantineEnvelope(
        `enter-${payload.grantId}.json`,
        payload,
        RECOVERY_QUARANTINE_ENTER_NAMESPACE,
      );
      const entered = captureHarness(() =>
        runHarnessBootstrapCli(
          [
            'recovery-quarantine',
            'enter',
            source,
            '--expectations',
            expectationsPath,
            '--json',
          ],
          repository,
          overrides,
        ),
      );
      assert.equal(entered.status, 0, entered.stderr);
    },
    releaseQuarantine(overrides: Parameters<typeof runHarnessBootstrapCli>[2]) {
      const marker = readRecoveryQuarantineMarker(stateRoot);
      assert.ok(marker);
      const payload = createRecoveryQuarantineReleaseGrantPayload({
        repositoryId: REPOSITORY_ID,
        authorityDescriptorDigest: expectations.descriptorDigest,
        authorityGeneration: expectations.generation,
        recoveryRuntimeDigest: expectations.sealedRuntime.closureDigest,
        externalAuditRoot,
        humanSigner: signerIdentity,
        signerFingerprint,
        issuedAt: ISSUED_AT,
        activeMarkerDigest: marker.markerDigest,
      });
      const source = writeQuarantineEnvelope(
        `release-${payload.grantId}.json`,
        payload,
        RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
      );
      const released = captureHarness(() =>
        runHarnessBootstrapCli(
          [
            'recovery-quarantine',
            'release',
            source,
            '--expectations',
            expectationsPath,
            '--json',
          ],
          repository,
          overrides,
        ),
      );
      assert.equal(released.status, 0, released.stderr);
    },
    writeRestoreEnvelope(
      name: string,
      generation: number,
      expectedPointerDigest: `sha256:${string}` | null,
      auditRoot = externalAuditRoot,
    ): string {
      const rootPayload: RecoveryOperationalTrustRootPayload = {
        kind: 'recovery-operational-trust-root.v1',
        repositoryId: REPOSITORY_ID,
        generation,
        purpose: 'workflow-maintainer-signatures',
        signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
        trustedSigners: [
          {
            identity: 'restored-operational-maintainer',
            publicKey,
            fingerprint: signerFingerprint,
          },
        ],
        createdAt: ISSUED_AT,
      };
      const replacement: RecoveryOperationalTrustRoot = {
        ...rootPayload,
        rootDigest: recoveryOperationalTrustRootDigest(rootPayload),
      };
      const unsigned = {
        kind: 'recovery-operational-trust-root-restore-grant.v1' as const,
        operation: 'restore-operational-trust-root' as const,
        repositoryId: REPOSITORY_ID,
        authorityDescriptorDigest: descriptor.descriptorDigest,
        authorityGeneration: descriptor.generation,
        recoveryRuntimeDigest: descriptor.sealedRuntime.closureDigest,
        externalAuditRoot: auditRoot,
        humanSigner: signerIdentity,
        signerFingerprint,
        expectedGeneration: generation - 1,
        expectedActivePointerDigest: expectedPointerDigest,
        replacementRootDigest: replacement.rootDigest,
        replacementGeneration: generation,
        issuedAt: ISSUED_AT,
        expiresAt: new Date(
          Date.parse(ISSUED_AT) + RECOVERY_TRUST_ROOT_RESTORE_TTL_MS,
        ).toISOString(),
        uses: 1 as const,
        oneShot: true as const,
      };
      const payload: RecoveryOperationalTrustRootRestoreGrantPayload = {
        ...unsigned,
        grantId: recoveryOperationalTrustRootRestoreGrantId(unsigned),
      };
      const target = path.join(externalRoot, name);
      writeCanonical(target, {
        payload,
        replacement,
        signature: sign(
          canonicalRecoveryOperationalTrustRootRestoreStatement(
            payload,
            replacement,
          ),
          RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
          name,
        ),
      });
      return target;
    },
    launch(argv: string[]) {
      return spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.resolve(
            import.meta.dirname,
            '../bootstrap/workflow-launcher.ts',
          ),
          ...argv,
        ],
        { cwd: repository, encoding: 'utf8' },
      );
    },
    cleanup() {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
      fs.rmSync(externalAuditRoot, { recursive: true, force: true });
      fs.rmSync(signingRoot, { recursive: true, force: true });
    },
  };
  return fixture;
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

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
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
