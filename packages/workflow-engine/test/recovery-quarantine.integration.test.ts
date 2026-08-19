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
} from '../src/recovery-authority.ts';
import {
  RECOVERY_QUARANTINE_ENTER_NAMESPACE,
  RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
  createRecoveryQuarantineEnterGrantPayload,
  createRecoveryQuarantineReleaseGrantPayload,
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  readRecoveryQuarantineGrantRecord,
  readRecoveryQuarantineMarker,
  type RecoveryQuarantineAuditRecord,
  type RecoveryQuarantineCommonBinding,
  type RecoveryQuarantineEnvelope,
  type RecoveryQuarantineFaultPhase,
  type RecoveryQuarantineGrantPayload,
} from '../src/recovery-quarantine.ts';

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns';
const FINGERPRINT = 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U';

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function privateDirectory(prefix: string): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  fs.chmodSync(directory, 0o700);
  return directory;
}

function authority(
  allowedDomains: RecoveryAuthorityDescriptorPayloadV1['allowedDomains'] = [
    RECOVERY_QUARANTINE_ENTER_NAMESPACE,
    RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
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
    generation: 1,
    signer: {
      identity: 'fixture-recovery-maintainer',
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
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

function binding(
  descriptor: RecoveryAuthorityDescriptorV1,
  externalAuditRoot: string,
  issuedAt: string,
  overrides: Partial<RecoveryQuarantineCommonBinding> = {},
): RecoveryQuarantineCommonBinding {
  return {
    repositoryId: descriptor.repositoryIdentity.repositoryId,
    authorityDescriptorDigest: descriptor.descriptorDigest,
    authorityGeneration: descriptor.generation,
    recoveryRuntimeDigest: descriptor.sealedRuntime.closureDigest,
    externalAuditRoot,
    humanSigner: descriptor.signer.identity,
    signerFingerprint: descriptor.signer.fingerprint,
    issuedAt,
    ...overrides,
  };
}

function namespaceFor(payload: RecoveryQuarantineGrantPayload): string {
  return payload.operation === 'enter-quarantine'
    ? RECOVERY_QUARANTINE_ENTER_NAMESPACE
    : RECOVERY_QUARANTINE_RELEASE_NAMESPACE;
}

function signatureFor(
  payload: RecoveryQuarantineGrantPayload,
  namespace = namespaceFor(payload),
): string {
  return crypto
    .createHash('sha256')
    .update(`${namespace}\0${canonicalJson(payload)}`)
    .digest('base64');
}

function envelope(
  payload: RecoveryQuarantineGrantPayload,
  namespace = namespaceFor(payload),
): RecoveryQuarantineEnvelope {
  return { payload, signature: signatureFor(payload, namespace) };
}

function verifier(calls: Array<{ namespace: string; payload: string }> = []) {
  return (
    payload: string,
    signature: string,
    _signer: string,
    namespace: string,
  ): boolean => {
    calls.push({ namespace, payload });
    return (
      signature ===
      crypto
        .createHash('sha256')
        .update(`${namespace}\0${payload}`)
        .digest('base64')
    );
  };
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}

function assertNoPublishWindow(directory: string): void {
  for (const entry of fs.readdirSync(directory, {
    recursive: true,
    encoding: 'utf8',
  })) {
    const filePath = path.join(directory, String(entry));
    const stats = fs.lstatSync(filePath);
    if (stats.isFile()) {
      assert.equal(stats.nlink, 1, `${filePath} retained a hard-link window`);
      assert.equal(filePath.endsWith('.tmp'), false, `${filePath} is residue`);
    }
  }
}

function context(input: {
  authority: ReturnType<typeof authority>;
  storageRoot?: string;
  externalAuditRoot: string;
  now: string;
  audits?: RecoveryQuarantineAuditRecord[];
  signatureCalls?: Array<{ namespace: string; payload: string }>;
  crashAt?: RecoveryQuarantineFaultPhase;
}) {
  const audits = input.audits ?? [];
  const signatureCalls = input.signatureCalls ?? [];
  const crash = new Error(`simulated crash at ${input.crashAt}`);
  return {
    crash,
    dependencies: {
      authorityDescriptor: input.authority.descriptor,
      authorityExpectations: input.authority.expectations,
      externalAuditRoot: input.externalAuditRoot,
      now: new Date(input.now),
      verifyHumanSignature: verifier(signatureCalls),
      appendAudit(record: RecoveryQuarantineAuditRecord) {
        if (input.storageRoot !== undefined) {
          const persisted = readRecoveryQuarantineGrantRecord(
            input.storageRoot,
            record.grantId,
          );
          assert.ok(persisted.terminal);
          assert.equal(persisted.terminal.receiptDigest, record.receiptDigest);
        }
        audits.push(record);
      },
      hooks:
        input.crashAt === undefined
          ? undefined
          : {
              afterPhase(phase: RecoveryQuarantineFaultPhase) {
                if (phase === input.crashAt) throw crash;
              },
            },
    },
  };
}

test('enter and release use distinct signed domains, durable receipts, and one-shot tombstones', () => {
  const storageRoot = privateDirectory('recovery-quarantine-state-');
  const externalAuditRoot = privateDirectory('recovery-quarantine-audit-');
  const loaded = authority();
  const audits: RecoveryQuarantineAuditRecord[] = [];
  const signatureCalls: Array<{ namespace: string; payload: string }> = [];
  const enterPayload = createRecoveryQuarantineEnterGrantPayload(
    binding(loaded.descriptor, externalAuditRoot, '2026-08-10T01:01:00.000Z'),
  );
  const enterContext = context({
    authority: loaded,
    storageRoot,
    externalAuditRoot,
    now: '2026-08-10T01:01:01.000Z',
    audits,
    signatureCalls,
  }).dependencies;

  const entered = executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(enterPayload),
    enterContext,
  );
  assert.equal(entered.receipt.result, 'quarantine-entered');
  assert.equal(entered.record.state, 'audited');
  assert.deepEqual(readRecoveryQuarantineMarker(storageRoot), entered.marker);
  assert.equal(audits.length, 1);

  const releasePayload = createRecoveryQuarantineReleaseGrantPayload({
    ...binding(
      loaded.descriptor,
      externalAuditRoot,
      '2026-08-10T01:02:00.000Z',
    ),
    activeMarkerDigest: entered.marker.markerDigest,
  });
  const releaseContext = context({
    authority: loaded,
    storageRoot,
    externalAuditRoot,
    now: '2026-08-10T01:02:01.000Z',
    audits,
    signatureCalls,
  }).dependencies;
  const released = executeRecoveryQuarantineRelease(
    storageRoot,
    envelope(releasePayload),
    releaseContext,
  );
  assert.equal(released.receipt.result, 'quarantine-released');
  assert.equal(released.record.state, 'audited');
  assert.equal(readRecoveryQuarantineMarker(storageRoot), null);
  assert.equal(audits.length, 2);
  assert.notEqual(enterPayload.grantId, releasePayload.grantId);
  assert.notEqual(signatureFor(enterPayload), signatureFor(releasePayload));
  assert.deepEqual(
    signatureCalls.map(({ namespace }) => namespace),
    [
      RECOVERY_QUARANTINE_ENTER_NAMESPACE,
      RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
    ],
  );
  assert.equal(signatureCalls[0]!.payload, canonicalJson(enterPayload));
  assert.equal(signatureCalls[1]!.payload, canonicalJson(releasePayload));

  assert.throws(
    () =>
      executeRecoveryQuarantineEnter(
        storageRoot,
        envelope(enterPayload),
        enterContext,
      ),
    hasCode('RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED'),
  );
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(releasePayload),
        releaseContext,
      ),
    hasCode('RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED'),
  );

  const writtenPaths = fs
    .readdirSync(path.join(storageRoot, 'recovery-quarantine'), {
      recursive: true,
      encoding: 'utf8',
    })
    .map(String);
  assert.equal(
    writtenPaths.some((entry) =>
      /(?:supervisor|trust-root|workflow-state)/u.test(entry),
    ),
    false,
  );
});

test('authority domains, exact bindings, signature namespace, and [issuedAt, expiresAt) fail closed', () => {
  const externalAuditRoot = privateDirectory(
    'recovery-quarantine-policy-audit-',
  );
  const loaded = authority();
  const issuedAt = '2026-08-10T02:00:00.000Z';
  const validBinding = binding(loaded.descriptor, externalAuditRoot, issuedAt);

  const atBoundaryPayload =
    createRecoveryQuarantineEnterGrantPayload(validBinding);
  assert.doesNotThrow(() =>
    executeRecoveryQuarantineEnter(
      privateDirectory('recovery-quarantine-issued-boundary-'),
      envelope(atBoundaryPayload),
      context({
        authority: loaded,
        externalAuditRoot,
        now: issuedAt,
      }).dependencies,
    ),
  );
  assert.throws(
    () =>
      executeRecoveryQuarantineEnter(
        privateDirectory('recovery-quarantine-expiry-boundary-'),
        envelope(atBoundaryPayload),
        context({
          authority: loaded,
          externalAuditRoot,
          now: atBoundaryPayload.expiresAt,
        }).dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_GRANT_EXPIRED'),
  );

  for (const overrides of [
    { repositoryId: 'github:different-repository' },
    { authorityDescriptorDigest: sha256('different-authority') },
    { authorityGeneration: loaded.descriptor.generation + 1 },
    { recoveryRuntimeDigest: sha256('different-runtime') },
    { externalAuditRoot: privateDirectory('different-audit-root-') },
    {
      signerFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    { humanSigner: 'different-maintainer' },
  ] satisfies Array<Partial<RecoveryQuarantineCommonBinding>>) {
    const payload = createRecoveryQuarantineEnterGrantPayload(
      binding(loaded.descriptor, externalAuditRoot, issuedAt, overrides),
    );
    assert.throws(
      () =>
        executeRecoveryQuarantineEnter(
          privateDirectory('recovery-quarantine-binding-'),
          envelope(payload),
          context({
            authority: loaded,
            externalAuditRoot,
            now: '2026-08-10T02:00:01.000Z',
          }).dependencies,
        ),
      hasCode('RECOVERY_QUARANTINE_AUTHORITY_BINDING_MISMATCH'),
    );
  }

  const enterOnly = authority([RECOVERY_QUARANTINE_ENTER_NAMESPACE]);
  const forbiddenRelease = createRecoveryQuarantineReleaseGrantPayload({
    ...binding(enterOnly.descriptor, externalAuditRoot, issuedAt),
    activeMarkerDigest: sha256('marker'),
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        privateDirectory('recovery-quarantine-domain-'),
        envelope(forbiddenRelease),
        context({
          authority: enterOnly,
          externalAuditRoot,
          now: '2026-08-10T02:00:01.000Z',
        }).dependencies,
      ),
    hasCode('RECOVERY_AUTHORITY_DOMAIN_FORBIDDEN'),
  );

  const release = createRecoveryQuarantineReleaseGrantPayload({
    ...validBinding,
    activeMarkerDigest: sha256('marker'),
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        privateDirectory('recovery-quarantine-cross-domain-signature-'),
        envelope(release, RECOVERY_QUARANTINE_ENTER_NAMESPACE),
        context({
          authority: loaded,
          externalAuditRoot,
          now: '2026-08-10T02:00:01.000Z',
        }).dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_SIGNATURE_INVALID'),
  );
});

test('only an exact reserved replay may reconcile after grant expiry', () => {
  const storageRoot = privateDirectory(
    'recovery-quarantine-expired-replay-state-',
  );
  const externalAuditRoot = privateDirectory(
    'recovery-quarantine-expired-replay-audit-',
  );
  const loaded = authority();
  const payload = createRecoveryQuarantineEnterGrantPayload(
    binding(loaded.descriptor, externalAuditRoot, '2026-08-10T02:10:00.000Z'),
  );
  const crashed = context({
    authority: loaded,
    storageRoot,
    externalAuditRoot,
    now: '2026-08-10T02:10:01.000Z',
    crashAt: 'reservation-durable',
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineEnter(
        storageRoot,
        envelope(payload),
        crashed.dependencies,
      ),
    (error) => error === crashed.crash,
  );
  const completed = executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(payload),
    context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: payload.expiresAt,
    }).dependencies,
  );
  assert.equal(completed.record.state, 'audited');
  assert.equal(
    readRecoveryQuarantineMarker(storageRoot)?.markerDigest,
    completed.marker.markerDigest,
  );
});

test('release is bound to the exact active marker and never accepts an enter envelope', () => {
  const storageRoot = privateDirectory('recovery-quarantine-marker-state-');
  const externalAuditRoot = privateDirectory(
    'recovery-quarantine-marker-audit-',
  );
  const loaded = authority();
  const enterPayload = createRecoveryQuarantineEnterGrantPayload(
    binding(loaded.descriptor, externalAuditRoot, '2026-08-10T03:00:00.000Z'),
  );
  const dependencies = context({
    authority: loaded,
    externalAuditRoot,
    now: '2026-08-10T03:00:01.000Z',
  }).dependencies;
  executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(enterPayload),
    dependencies,
  );

  const wrongMarkerRelease = createRecoveryQuarantineReleaseGrantPayload({
    ...binding(
      loaded.descriptor,
      externalAuditRoot,
      '2026-08-10T03:01:00.000Z',
    ),
    activeMarkerDigest: sha256('wrong-marker'),
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(wrongMarkerRelease),
        {
          ...dependencies,
          now: new Date('2026-08-10T03:01:01.000Z'),
        },
      ),
    hasCode('RECOVERY_QUARANTINE_MARKER_MISMATCH'),
  );
  assert.ok(readRecoveryQuarantineMarker(storageRoot));

  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(enterPayload) as RecoveryQuarantineEnvelope,
        dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_OPERATION_MISMATCH'),
  );
});

test('enter crash windows reconcile immutable records and never lose the fail-closed marker', () => {
  for (const crashAt of [
    'reservation-published',
    'reservation-durable',
    'marker-published',
    'marker-durable',
    'receipt-published',
    'receipt-durable',
    'terminal-published',
    'terminal-durable',
    'audit-published',
    'audit-appended',
  ] as const satisfies readonly RecoveryQuarantineFaultPhase[]) {
    const storageRoot = privateDirectory(
      `recovery-quarantine-enter-${crashAt}-`,
    );
    const externalAuditRoot = privateDirectory(
      `recovery-quarantine-enter-audit-${crashAt}-`,
    );
    const loaded = authority();
    const audits: RecoveryQuarantineAuditRecord[] = [];
    const payload = createRecoveryQuarantineEnterGrantPayload(
      binding(loaded.descriptor, externalAuditRoot, '2026-08-10T04:00:00.000Z'),
    );
    const crashed = context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T04:00:01.000Z',
      audits,
      crashAt,
    });
    assert.throws(
      () =>
        executeRecoveryQuarantineEnter(
          storageRoot,
          envelope(payload),
          crashed.dependencies,
        ),
      (error) => error === crashed.crash,
    );

    if (!['reservation-published', 'reservation-durable'].includes(crashAt)) {
      assert.ok(readRecoveryQuarantineMarker(storageRoot));
    }
    const completed = executeRecoveryQuarantineEnter(
      storageRoot,
      envelope(payload),
      context({
        authority: loaded,
        storageRoot,
        externalAuditRoot,
        now: '2026-08-10T04:00:02.000Z',
        audits,
      }).dependencies,
    );
    assert.equal(completed.record.state, 'audited');
    assert.equal(fs.lstatSync(completed.markerPath).nlink, 1);
    const record = readRecoveryQuarantineGrantRecord(
      storageRoot,
      payload.grantId,
    );
    assert.equal(record.state, 'audited');
    assert.ok(record.receipt);
    assert.ok(record.terminal);
    assert.ok(record.auditAcknowledgement);
    assertNoPublishWindow(path.join(storageRoot, 'recovery-quarantine'));
    assert.equal(
      audits.every((recorded) => recorded.recordId === audits[0]!.recordId),
      true,
    );
  }
});

test('release crash windows keep quarantine fail closed until the consumed release removes the exact marker', () => {
  for (const crashAt of [
    'reservation-published',
    'reservation-durable',
    'release-claim-published',
    'release-claim-durable',
    'receipt-published',
    'receipt-durable',
    'terminal-published',
    'terminal-durable',
    'release-durable',
    'audit-published',
    'audit-appended',
  ] as const satisfies readonly RecoveryQuarantineFaultPhase[]) {
    const storageRoot = privateDirectory(
      `recovery-quarantine-release-${crashAt}-`,
    );
    const externalAuditRoot = privateDirectory(
      `recovery-quarantine-release-audit-${crashAt}-`,
    );
    const loaded = authority();
    const enterPayload = createRecoveryQuarantineEnterGrantPayload(
      binding(loaded.descriptor, externalAuditRoot, '2026-08-10T05:00:00.000Z'),
    );
    const entered = executeRecoveryQuarantineEnter(
      storageRoot,
      envelope(enterPayload),
      context({
        authority: loaded,
        storageRoot,
        externalAuditRoot,
        now: '2026-08-10T05:00:01.000Z',
      }).dependencies,
    );
    const releasePayload = createRecoveryQuarantineReleaseGrantPayload({
      ...binding(
        loaded.descriptor,
        externalAuditRoot,
        '2026-08-10T05:01:00.000Z',
      ),
      activeMarkerDigest: entered.marker.markerDigest,
    });
    const audits: RecoveryQuarantineAuditRecord[] = [];
    const crashed = context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T05:01:01.000Z',
      audits,
      crashAt,
    });
    assert.throws(
      () =>
        executeRecoveryQuarantineRelease(
          storageRoot,
          envelope(releasePayload),
          crashed.dependencies,
        ),
      (error) => error === crashed.crash,
    );

    const shouldStillBeActive = ![
      'release-durable',
      'audit-published',
      'audit-appended',
    ].includes(crashAt);
    assert.equal(
      readRecoveryQuarantineMarker(storageRoot) !== null,
      shouldStillBeActive,
    );
    const completed = executeRecoveryQuarantineRelease(
      storageRoot,
      envelope(releasePayload),
      context({
        authority: loaded,
        storageRoot,
        externalAuditRoot,
        now: '2026-08-10T05:01:02.000Z',
        audits,
      }).dependencies,
    );
    assert.equal(completed.record.state, 'audited');
    assert.equal(readRecoveryQuarantineMarker(storageRoot), null);
    assertNoPublishWindow(path.join(storageRoot, 'recovery-quarantine'));
    assert.equal(
      audits.every((recorded) => recorded.recordId === audits[0]!.recordId),
      true,
    );
  }
});

test('an audit-ack publish crash leaves a consumed exact grant, not an ambiguous replay', () => {
  const storageRoot = privateDirectory('recovery-quarantine-ack-state-');
  const externalAuditRoot = privateDirectory('recovery-quarantine-ack-audit-');
  const loaded = authority();
  const audits: RecoveryQuarantineAuditRecord[] = [];
  const payload = createRecoveryQuarantineEnterGrantPayload(
    binding(loaded.descriptor, externalAuditRoot, '2026-08-10T06:00:00.000Z'),
  );
  const crashed = context({
    authority: loaded,
    storageRoot,
    externalAuditRoot,
    now: '2026-08-10T06:00:01.000Z',
    audits,
    crashAt: 'audit-ack-published',
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineEnter(
        storageRoot,
        envelope(payload),
        crashed.dependencies,
      ),
    (error) => error === crashed.crash,
  );

  const record = readRecoveryQuarantineGrantRecord(
    storageRoot,
    payload.grantId,
  );
  assert.equal(record.state, 'audited');
  assert.equal(audits.length, 1);
  assert.throws(
    () =>
      executeRecoveryQuarantineEnter(
        storageRoot,
        envelope(payload),
        context({
          authority: loaded,
          storageRoot,
          externalAuditRoot,
          now: '2026-08-10T06:00:02.000Z',
        }).dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED'),
  );
  assertNoPublishWindow(path.join(storageRoot, 'recovery-quarantine'));
});

test('a release audit-ack crash leaves the exact marker durably released', () => {
  const storageRoot = privateDirectory(
    'recovery-quarantine-release-ack-state-',
  );
  const externalAuditRoot = privateDirectory(
    'recovery-quarantine-release-ack-audit-',
  );
  const loaded = authority();
  const entered = executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(
      createRecoveryQuarantineEnterGrantPayload(
        binding(
          loaded.descriptor,
          externalAuditRoot,
          '2026-08-10T06:10:00.000Z',
        ),
      ),
    ),
    context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T06:10:01.000Z',
    }).dependencies,
  );
  const payload = createRecoveryQuarantineReleaseGrantPayload({
    ...binding(
      loaded.descriptor,
      externalAuditRoot,
      '2026-08-10T06:11:00.000Z',
    ),
    activeMarkerDigest: entered.marker.markerDigest,
  });
  const audits: RecoveryQuarantineAuditRecord[] = [];
  const crashed = context({
    authority: loaded,
    storageRoot,
    externalAuditRoot,
    now: '2026-08-10T06:11:01.000Z',
    audits,
    crashAt: 'audit-ack-published',
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(payload),
        crashed.dependencies,
      ),
    (error) => error === crashed.crash,
  );
  assert.equal(readRecoveryQuarantineMarker(storageRoot), null);
  assert.equal(
    readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId).state,
    'audited',
  );
  assert.equal(audits.length, 1);
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(payload),
        context({
          authority: loaded,
          storageRoot,
          externalAuditRoot,
          now: '2026-08-10T06:11:02.000Z',
        }).dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED'),
  );
  assertNoPublishWindow(path.join(storageRoot, 'recovery-quarantine'));
});

test('a different release grant cannot take over an exact marker claim', () => {
  const storageRoot = privateDirectory('recovery-quarantine-claim-state-');
  const externalAuditRoot = privateDirectory(
    'recovery-quarantine-claim-audit-',
  );
  const loaded = authority();
  const entered = executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(
      createRecoveryQuarantineEnterGrantPayload(
        binding(
          loaded.descriptor,
          externalAuditRoot,
          '2026-08-10T07:00:00.000Z',
        ),
      ),
    ),
    context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T07:00:01.000Z',
    }).dependencies,
  );
  const first = createRecoveryQuarantineReleaseGrantPayload({
    ...binding(
      loaded.descriptor,
      externalAuditRoot,
      '2026-08-10T07:01:00.000Z',
    ),
    activeMarkerDigest: entered.marker.markerDigest,
  });
  const firstCrash = context({
    authority: loaded,
    storageRoot,
    externalAuditRoot,
    now: '2026-08-10T07:01:01.000Z',
    crashAt: 'release-claim-durable',
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(first),
        firstCrash.dependencies,
      ),
    (error) => error === firstCrash.crash,
  );

  const second = createRecoveryQuarantineReleaseGrantPayload({
    ...binding(
      loaded.descriptor,
      externalAuditRoot,
      '2026-08-10T07:01:02.000Z',
    ),
    activeMarkerDigest: entered.marker.markerDigest,
  });
  assert.throws(
    () =>
      executeRecoveryQuarantineRelease(
        storageRoot,
        envelope(second),
        context({
          authority: loaded,
          storageRoot,
          externalAuditRoot,
          now: '2026-08-10T07:01:03.000Z',
        }).dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_STATE_CORRUPT'),
  );
  assert.equal(
    readRecoveryQuarantineMarker(storageRoot)?.markerDigest,
    entered.marker.markerDigest,
  );

  executeRecoveryQuarantineRelease(
    storageRoot,
    envelope(first),
    context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T07:01:04.000Z',
    }).dependencies,
  );
  assert.equal(readRecoveryQuarantineMarker(storageRoot), null);
});

test('unknown and incomplete residue is preserved while unsafe aliases fail closed', () => {
  const storageRoot = privateDirectory('recovery-quarantine-residue-state-');
  const externalAuditRoot = privateDirectory(
    'recovery-quarantine-residue-audit-',
  );
  const loaded = authority();
  const payload = createRecoveryQuarantineEnterGrantPayload(
    binding(loaded.descriptor, externalAuditRoot, '2026-08-10T08:00:00.000Z'),
  );
  executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(payload),
    context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T08:00:01.000Z',
    }).dependencies,
  );
  const state = path.join(storageRoot, 'recovery-quarantine');
  const grantDirectory = path.join(
    state,
    'grants',
    fs.readdirSync(path.join(state, 'grants'))[0]!,
  );
  const unknown = path.join(state, 'operator-note');
  fs.writeFileSync(unknown, 'preserve', { mode: 0o600 });
  const incomplete = path.join(
    grantDirectory,
    `.receipt.json.${'0'.repeat(64)}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(incomplete, '{', { mode: 0o600 });
  assert.ok(readRecoveryQuarantineMarker(storageRoot));
  assert.equal(
    readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId).state,
    'audited',
  );
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(incomplete, 'utf8'), '{');

  const unsafe = path.join(
    grantDirectory,
    `.receipt.json.${'0'.repeat(64)}.${crypto.randomUUID()}.tmp`,
  );
  fs.symlinkSync(unknown, unsafe);
  assert.throws(
    () => readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId),
    hasCode('RECOVERY_QUARANTINE_STATE_CORRUPT'),
  );
  assert.equal(fs.lstatSync(unsafe).isSymbolicLink(), true);
});

test('symlinked stores and unexpected hard links fail closed without writing through them', () => {
  const externalAuditRoot = privateDirectory('recovery-quarantine-path-audit-');
  const loaded = authority();
  const payload = createRecoveryQuarantineEnterGrantPayload(
    binding(loaded.descriptor, externalAuditRoot, '2026-08-10T09:00:00.000Z'),
  );
  const target = privateDirectory('recovery-quarantine-symlink-target-');
  const container = privateDirectory('recovery-quarantine-symlink-container-');
  const alias = path.join(container, 'alias');
  fs.symlinkSync(target, alias);
  assert.throws(
    () =>
      executeRecoveryQuarantineEnter(
        alias,
        envelope(payload),
        context({
          authority: loaded,
          externalAuditRoot,
          now: '2026-08-10T09:00:01.000Z',
        }).dependencies,
      ),
    hasCode('RECOVERY_QUARANTINE_STORE_UNSAFE'),
  );
  assert.deepEqual(fs.readdirSync(target), []);

  const storageRoot = privateDirectory('recovery-quarantine-hardlink-state-');
  const entered = executeRecoveryQuarantineEnter(
    storageRoot,
    envelope(payload),
    context({
      authority: loaded,
      storageRoot,
      externalAuditRoot,
      now: '2026-08-10T09:00:01.000Z',
    }).dependencies,
  );
  const externalAlias = path.join(container, 'marker-alias.json');
  fs.linkSync(entered.markerPath, externalAlias);
  assert.throws(
    () => readRecoveryQuarantineMarker(storageRoot),
    hasCode('RECOVERY_QUARANTINE_STATE_CORRUPT'),
  );
  assert.equal(fs.lstatSync(externalAlias).nlink, 2);
});
