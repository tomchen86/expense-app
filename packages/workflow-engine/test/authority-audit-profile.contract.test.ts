import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTHORITY_AUDIT_PROFILE_POLICIES,
  appendAuthorityAuditRecord,
  anchorProtectedAuthorityAuditLedger,
  authorityAuditLedgerPaths,
  canonicalAuditDestructionGrantPayload,
  compactDevelopmentAuthorityAuditLedger,
  deriveAuthorityAuditRepositoryId,
  destroyProtectedAuthorityAuditLedger,
  scanAuthorityAuditLedger,
  verifyProtectedAuthorityAuditAnchors,
  type AuditDestructionGrantEnvelope,
  type AuditDestructionGrantPayload,
  type AuthorityAuditAnchorBackend,
  type AuthorityAuditAppendInput,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from '../src/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../src/authority-audit-service.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { isWorkflowError } from './fixture.ts';

function digest(seed: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

function fixture(profile: 'development' | 'protected') {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'authority-audit-profile-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'repository');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  const scope: AuthorityAuditLedgerScope = {
    externalAuditRoot: path.join(root, 'audit'),
    repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(
      `github:example/audit-${profile}`,
    ),
    profile,
  };
  return {
    root,
    scope,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function appendInput(
  sequence: number,
  occurredAt: string,
): AuthorityAuditAppendInput {
  return {
    eventType: 'command',
    occurredAt,
    idempotencyKey: digest(`idempotency:${sequence}`),
    grantDigest: null,
    candidateBundleDigest: null,
    prestateDigest: digest(`pre:${sequence}`),
    poststateDigest: digest(`post:${sequence}`),
    result: 'succeeded',
    resultDigest: digest(`result:${sequence}`),
  };
}

function appendEvent(
  scope: AuthorityAuditLedgerScope,
  sequence: number,
  occurredAt: string,
  trustedNow?: string,
) {
  return recordAuthorityAuditEvent(
    scope,
    {
      eventType: 'command',
      occurredAt,
      idempotencyKey: digest(`event-idempotency:${sequence}`),
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: 'audit-profile',
      changeId: 'engine-v2',
      workflowId: 'audit-profile-workflow',
      grantDigest: null,
      candidateBundleDigest: null,
      prestateDigest: digest(`event-pre:${sequence}`),
      poststateDigest: digest(`event-post:${sequence}`),
      command: {
        name: 'audit.test',
        argvDigest: digest(`event-argv:${sequence}`),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'succeeded',
      outcomeDigest: digest(`event-outcome:${sequence}`),
      errorCode: null,
    },
    trustedNow === undefined ? {} : { now: () => new Date(trustedNow) },
  );
}

test('audit profile is code-owned, persisted, and cannot be downgraded or mixed', () => {
  const development = fixture('development');
  const protectedValue = fixture('protected');
  try {
    appendAuthorityAuditRecord(
      development.scope,
      appendInput(1, '2026-01-01T00:00:00.000Z'),
    );
    assert.equal(
      scanAuthorityAuditLedger(development.scope).profile,
      'development',
    );
    assert.throws(
      () =>
        scanAuthorityAuditLedger({
          ...development.scope,
          profile: 'protected',
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_PROFILE_MISMATCH'),
    );

    appendAuthorityAuditRecord(
      protectedValue.scope,
      appendInput(1, '2026-01-01T00:00:00.000Z'),
    );
    assert.equal(
      scanAuthorityAuditLedger(protectedValue.scope).profile,
      'protected',
    );
    const implicitDevelopment = { ...protectedValue.scope } as {
      profile?: 'development' | 'protected';
    } & Omit<AuthorityAuditLedgerScope, 'profile'>;
    delete implicitDevelopment.profile;
    assert.equal(
      scanAuthorityAuditLedger(implicitDevelopment).profile,
      'protected',
      'ordinary production callers inherit the durably opted-in profile',
    );
    assert.throws(
      () =>
        scanAuthorityAuditLedger({
          ...implicitDevelopment,
          profile: 'development',
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_PROFILE_MISMATCH'),
    );

    fs.unlinkSync(authorityAuditLedgerPaths(protectedValue.scope).profileState);
    assert.throws(
      () => scanAuthorityAuditLedger(protectedValue.scope),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_PROFILE_INVALID'),
    );

    assert.deepEqual(AUTHORITY_AUDIT_PROFILE_POLICIES.development, {
      schemaVersion: 1,
      profile: 'development',
      maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
      minimumRecentRecords: 20,
      anchorMode: 'none',
      destructionMode: 'automatic-retention-only',
    });
    assert.deepEqual(AUTHORITY_AUDIT_PROFILE_POLICIES.protected, {
      schemaVersion: 1,
      profile: 'protected',
      maxAgeMs: null,
      minimumRecentRecords: null,
      anchorMode: 'backend-receipt',
      destructionMode: 'exact-human-grant-with-tombstone',
    });
  } finally {
    development.cleanup();
    protectedValue.cleanup();
  }
});

test('development retention runs automatically on authoritative append', () => {
  const value = fixture('development');
  try {
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      appendEvent(value.scope, sequence, '2026-01-01T00:00:00.000Z');
    }
    appendEvent(value.scope, 21, '2026-08-01T00:00:00.000Z');

    const scan = scanAuthorityAuditLedger(value.scope);
    const paths = authorityAuditLedgerPaths(value.scope);
    assert.equal(scan.prunedRecordCount, 1);
    assert.equal(scan.recordCount, 20);
    assert.equal(scan.records[0]?.record.sequence, 2);
    assert.equal(fs.readdirSync(paths.records).length, 20);
    assert.equal(fs.readdirSync(paths.events).length, 20);
  } finally {
    value.cleanup();
  }
});

test('development maintenance bounds expired receipts on disk and crash recovery completes the same prefix compaction', () => {
  const value = fixture('development');
  try {
    for (let sequence = 1; sequence <= 25; sequence += 1) {
      appendEvent(
        value.scope,
        sequence,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      );
    }
    assert.throws(
      () =>
        compactDevelopmentAuthorityAuditLedger(
          value.scope,
          { now: '2026-08-01T00:00:00.000Z' },
          {
            testAfterEntryRemoval() {
              throw new Error('simulated-retention-crash');
            },
          },
        ),
      /simulated-retention-crash/,
    );

    const recovered = scanAuthorityAuditLedger(value.scope);
    assert.equal(recovered.profile, 'development');
    assert.equal(recovered.recordCount, 20);
    assert.equal(recovered.prunedRecordCount, 5);
    assert.equal(recovered.headSequence, 25);
    assert.equal(recovered.records[0]?.record.sequence, 6);
    const paths = authorityAuditLedgerPaths(value.scope);
    assert.equal(fs.readdirSync(paths.records).length, 20);
    assert.equal(fs.readdirSync(paths.events).length, 20);

    for (let sequence = 26; sequence <= 30; sequence += 1) {
      appendEvent(
        value.scope,
        sequence,
        '2026-01-02T00:00:00.000Z',
        '2026-01-03T00:00:00.000Z',
      );
    }
    const second = compactDevelopmentAuthorityAuditLedger(value.scope, {
      now: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(second.pruned, 5);
    assert.equal(second.retained, 20);
    assert.equal(scanAuthorityAuditLedger(value.scope).prunedRecordCount, 10);
    assert.equal(fs.readdirSync(paths.records).length, 20);
    assert.equal(fs.readdirSync(paths.events).length, 20);
  } finally {
    value.cleanup();
  }
});

function signingFixture() {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const untrusted = crypto.generateKeyPairSync('ed25519');
  const signerIdentity = 'maintainer@example';
  const verifyHumanSignature = (input: {
    domain: string;
    payload: string;
    signerIdentity: string;
    signature: string;
  }) =>
    input.domain === 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1' &&
    input.signerIdentity === signerIdentity &&
    crypto.verify(
      null,
      Buffer.from(input.payload),
      trusted.publicKey,
      Buffer.from(input.signature, 'base64'),
    );
  return { trusted, untrusted, signerIdentity, verifyHumanSignature };
}

function anchorBackend(): AuthorityAuditAnchorBackend & {
  published: string[];
} {
  const keys = crypto.generateKeyPairSync('ed25519');
  const published: string[] = [];
  return {
    backendId: 'test-worm',
    published,
    publish(payload) {
      published.push(payload);
      return crypto
        .sign(null, Buffer.from(payload), keys.privateKey)
        .toString('base64');
    },
    verify(payload, receipt) {
      return crypto.verify(
        null,
        Buffer.from(payload),
        keys.publicKey,
        Buffer.from(receipt, 'base64'),
      );
    },
  };
}

test('protected audit publishes independently verifiable backend anchor receipts and rejects retention pruning', () => {
  const value = fixture('protected');
  const backend = anchorBackend();
  try {
    appendAuthorityAuditRecord(
      value.scope,
      appendInput(1, '2026-01-01T00:00:00.000Z'),
    );
    appendAuthorityAuditRecord(
      value.scope,
      appendInput(2, '2026-01-02T00:00:00.000Z'),
    );
    assert.throws(
      () =>
        compactDevelopmentAuthorityAuditLedger(value.scope, {
          now: '2027-01-01T00:00:00.000Z',
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_PROFILE_PROTECTED'),
    );

    const anchored = anchorProtectedAuthorityAuditLedger(value.scope, {
      anchoredAt: '2026-01-03T00:00:00.000Z',
      backend,
    });
    assert.equal(backend.published.length, 1);
    assert.equal(anchored.receipt.headSequence, 2);
    assert.equal(
      anchored.receipt.headRecordDigest,
      scanAuthorityAuditLedger(value.scope).headRecordDigest,
    );
    const verified = verifyProtectedAuthorityAuditAnchors(value.scope, [
      backend,
    ]);
    assert.equal(verified.ok, true);
    assert.equal(verified.receipts.length, 1);
    assert.equal(verified.currentHeadAnchored, true);

    const bytes = fs.readFileSync(anchored.receiptPath, 'utf8');
    fs.writeFileSync(anchored.receiptPath, `${bytes.trimEnd()} `, {
      mode: 0o600,
    });
    assert.throws(
      () => verifyProtectedAuthorityAuditAnchors(value.scope, [backend]),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_ANCHOR_INVALID'),
    );
  } finally {
    value.cleanup();
  }
});

function destructionEnvelope(input: {
  scope: AuthorityAuditLedgerScope;
  throughSequence: number;
  throughRecordDigest: Sha256Digest;
  expectedHeadSequence: number;
  expectedHeadRecordDigest: Sha256Digest;
  signerIdentity: string;
  privateKey: crypto.KeyObject;
  grantId?: string;
  reasonDigest?: Sha256Digest;
  remoteAnchorDisposition?: 'retain' | 'deletion-authorized';
}): AuditDestructionGrantEnvelope {
  const payload: AuditDestructionGrantPayload = {
    schemaVersion: 1,
    kind: 'audit-destruction-grant.v1',
    domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
    grantId: input.grantId ?? crypto.randomUUID(),
    repositoryId: input.scope.repositoryId,
    profile: 'protected',
    expectedHeadSequence: input.expectedHeadSequence,
    expectedHeadRecordDigest: input.expectedHeadRecordDigest,
    throughSequence: input.throughSequence,
    throughRecordDigest: input.throughRecordDigest,
    issuedAt: '2026-01-03T00:00:00.000Z',
    expiresAt: '2026-01-03T00:10:00.000Z',
    uses: 1,
    signerIdentity: input.signerIdentity,
    reasonDigest:
      input.reasonDigest ?? digest('human-audit-destruction-reason'),
    remoteAnchorDisposition: input.remoteAnchorDisposition ?? 'retain',
  };
  return {
    schemaVersion: 1,
    kind: 'audit-destruction-grant-envelope.v1',
    payload,
    signature: crypto
      .sign(
        null,
        Buffer.from(canonicalAuditDestructionGrantPayload(payload)),
        input.privateKey,
      )
      .toString('base64'),
  };
}

test('protected destruction requires an exact one-use human grant, writes a tombstone first, and recovers without replay', () => {
  const value = fixture('protected');
  const signer = signingFixture();
  try {
    const first = appendAuthorityAuditRecord(
      value.scope,
      appendInput(1, '2026-01-01T00:00:00.000Z'),
    );
    const second = appendAuthorityAuditRecord(
      value.scope,
      appendInput(2, '2026-01-02T00:00:00.000Z'),
    );
    const exact = destructionEnvelope({
      scope: value.scope,
      throughSequence: first.record.sequence,
      throughRecordDigest: first.recordDigest,
      expectedHeadSequence: second.record.sequence,
      expectedHeadRecordDigest: second.recordDigest,
      signerIdentity: signer.signerIdentity,
      privateKey: signer.trusted.privateKey,
    });
    const wrongSigner = destructionEnvelope({
      scope: value.scope,
      throughSequence: first.record.sequence,
      throughRecordDigest: first.recordDigest,
      expectedHeadSequence: second.record.sequence,
      expectedHeadRecordDigest: second.recordDigest,
      signerIdentity: signer.signerIdentity,
      privateKey: signer.untrusted.privateKey,
    });
    const staleBinding = destructionEnvelope({
      scope: value.scope,
      throughSequence: first.record.sequence,
      throughRecordDigest: first.recordDigest,
      expectedHeadSequence: first.record.sequence,
      expectedHeadRecordDigest: first.recordDigest,
      signerIdentity: signer.signerIdentity,
      privateKey: signer.trusted.privateKey,
    });

    assert.throws(
      () =>
        destroyProtectedAuthorityAuditLedger(value.scope, wrongSigner, {
          now: '2026-01-03T00:05:00.000Z',
          verifyHumanSignature: signer.verifyHumanSignature,
        }),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_AUDIT_DESTRUCTION_GRANT_INVALID'),
    );
    assert.equal(scanAuthorityAuditLedger(value.scope).recordCount, 2);
    assert.throws(
      () =>
        destroyProtectedAuthorityAuditLedger(value.scope, staleBinding, {
          now: '2026-01-03T00:05:00.000Z',
          verifyHumanSignature: signer.verifyHumanSignature,
        }),
      (error) =>
        isWorkflowError(
          error,
          'AUTHORITY_AUDIT_DESTRUCTION_GRANT_BINDING_INVALID',
        ),
    );
    assert.equal(
      fs.readdirSync(authorityAuditLedgerPaths(value.scope).tombstones).length,
      0,
    );

    assert.throws(
      () =>
        destroyProtectedAuthorityAuditLedger(
          value.scope,
          exact,
          {
            now: '2026-01-03T00:05:00.000Z',
            verifyHumanSignature: signer.verifyHumanSignature,
          },
          {
            testAfterTombstonePublication() {
              throw new Error('simulated-destruction-crash');
            },
          },
        ),
      /simulated-destruction-crash/,
    );

    const recovered = scanAuthorityAuditLedger(value.scope);
    assert.equal(recovered.profile, 'protected');
    assert.equal(recovered.prunedRecordCount, 1);
    assert.equal(recovered.recordCount, 1);
    assert.equal(recovered.records[0]?.record.sequence, 2);
    const paths = authorityAuditLedgerPaths(value.scope);
    assert.equal(fs.readdirSync(paths.tombstones).length, 1);
    assert.equal(fs.readdirSync(paths.records).length, 1);
    const tombstone = JSON.parse(
      fs.readFileSync(
        path.join(paths.tombstones, fs.readdirSync(paths.tombstones)[0]!),
        'utf8',
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(tombstone.grantEnvelope, exact);
    assert.equal(tombstone.grantDigest, digestCanonicalEnvelope(exact));

    assert.throws(
      () =>
        destroyProtectedAuthorityAuditLedger(value.scope, exact, {
          now: '2026-01-03T00:05:00.000Z',
          verifyHumanSignature: signer.verifyHumanSignature,
        }),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_AUDIT_DESTRUCTION_GRANT_CONSUMED'),
    );
  } finally {
    value.cleanup();
  }
});

for (const missing of ['tombstone', 'checkpoint'] as const) {
  test(`protected destruction fails closed when its ${missing} disappears`, () => {
    const value = fixture('protected');
    const signer = signingFixture();
    try {
      appendAuthorityAuditRecord(
        value.scope,
        appendInput(1, '2026-01-01T00:00:00.000Z'),
      );
      const head = appendAuthorityAuditRecord(
        value.scope,
        appendInput(2, '2026-01-02T00:00:00.000Z'),
      );
      const envelope = destructionEnvelope({
        scope: value.scope,
        throughSequence: head.record.sequence,
        throughRecordDigest: head.recordDigest,
        expectedHeadSequence: head.record.sequence,
        expectedHeadRecordDigest: head.recordDigest,
        signerIdentity: signer.signerIdentity,
        privateKey: signer.trusted.privateKey,
      });
      destroyProtectedAuthorityAuditLedger(value.scope, envelope, {
        now: '2026-01-03T00:05:00.000Z',
        verifyHumanSignature: signer.verifyHumanSignature,
      });

      const paths = authorityAuditLedgerPaths(value.scope);
      if (missing === 'tombstone') {
        const [name] = fs.readdirSync(paths.tombstones);
        assert.ok(name);
        fs.unlinkSync(path.join(paths.tombstones, name));
      } else {
        fs.unlinkSync(paths.retentionCheckpoint);
      }

      assert.throws(
        () => scanAuthorityAuditLedger(value.scope),
        (error) =>
          isWorkflowError(
            error,
            missing === 'tombstone'
              ? 'AUTHORITY_AUDIT_DESTRUCTION_TOMBSTONE_INVALID'
              : 'AUTHORITY_AUDIT_MAINTENANCE_INVALID',
          ),
        `missing protected ${missing} must invalidate the durable destruction history`,
      );
    } finally {
      value.cleanup();
    }
  });
}

test('full-prefix protected destruction recovers an append crash from the checkpoint head', () => {
  const value = fixture('protected');
  const signer = signingFixture();
  try {
    appendAuthorityAuditRecord(
      value.scope,
      appendInput(1, '2026-01-01T00:00:00.000Z'),
    );
    const destroyedHead = appendAuthorityAuditRecord(
      value.scope,
      appendInput(2, '2026-01-02T00:00:00.000Z'),
    );
    const envelope = destructionEnvelope({
      scope: value.scope,
      throughSequence: destroyedHead.record.sequence,
      throughRecordDigest: destroyedHead.recordDigest,
      expectedHeadSequence: destroyedHead.record.sequence,
      expectedHeadRecordDigest: destroyedHead.recordDigest,
      signerIdentity: signer.signerIdentity,
      privateKey: signer.trusted.privateKey,
    });
    destroyProtectedAuthorityAuditLedger(value.scope, envelope, {
      now: '2026-01-03T00:05:00.000Z',
      verifyHumanSignature: signer.verifyHumanSignature,
    });

    assert.throws(
      () =>
        appendAuthorityAuditRecord(
          value.scope,
          appendInput(3, '2026-01-04T00:00:00.000Z'),
          {
            testAfterRecordPreparation() {
              throw new Error('simulated-post-destruction-append-crash');
            },
          },
        ),
      /simulated-post-destruction-append-crash/,
    );

    const recovered = scanAuthorityAuditLedger(value.scope);
    assert.equal(recovered.prunedRecordCount, 2);
    assert.equal(recovered.recordCount, 1);
    assert.equal(recovered.headSequence, 3);
    assert.equal(
      recovered.records[0]?.record.previousRecordDigest,
      destroyedHead.recordDigest,
    );
  } finally {
    value.cleanup();
  }
});

test('protected destruction consumes grantId across differently signed envelopes', () => {
  const value = fixture('protected');
  const signer = signingFixture();
  try {
    const first = appendAuthorityAuditRecord(
      value.scope,
      appendInput(1, '2026-01-01T00:00:00.000Z'),
    );
    const second = appendAuthorityAuditRecord(
      value.scope,
      appendInput(2, '2026-01-02T00:00:00.000Z'),
    );
    const head = appendAuthorityAuditRecord(
      value.scope,
      appendInput(3, '2026-01-03T00:00:00.000Z'),
    );
    const grantId = crypto.randomUUID();
    const firstEnvelope = destructionEnvelope({
      scope: value.scope,
      throughSequence: first.record.sequence,
      throughRecordDigest: first.recordDigest,
      expectedHeadSequence: head.record.sequence,
      expectedHeadRecordDigest: head.recordDigest,
      signerIdentity: signer.signerIdentity,
      privateKey: signer.trusted.privateKey,
      grantId,
    });
    destroyProtectedAuthorityAuditLedger(value.scope, firstEnvelope, {
      now: '2026-01-03T00:05:00.000Z',
      verifyHumanSignature: signer.verifyHumanSignature,
    });

    const differentlySignedEnvelope = destructionEnvelope({
      scope: value.scope,
      throughSequence: second.record.sequence,
      throughRecordDigest: second.recordDigest,
      expectedHeadSequence: head.record.sequence,
      expectedHeadRecordDigest: head.recordDigest,
      signerIdentity: signer.signerIdentity,
      privateKey: signer.trusted.privateKey,
      grantId,
      reasonDigest: digest('different-human-audit-destruction-reason'),
    });
    assert.notEqual(
      digestCanonicalEnvelope(differentlySignedEnvelope),
      digestCanonicalEnvelope(firstEnvelope),
    );
    assert.throws(
      () =>
        destroyProtectedAuthorityAuditLedger(
          value.scope,
          differentlySignedEnvelope,
          {
            now: '2026-01-03T00:05:00.000Z',
            verifyHumanSignature: signer.verifyHumanSignature,
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_AUDIT_DESTRUCTION_GRANT_CONSUMED'),
    );

    const unchanged = scanAuthorityAuditLedger(value.scope);
    assert.equal(unchanged.prunedRecordCount, 1);
    assert.deepEqual(
      unchanged.records.map(({ record }) => record.sequence),
      [2, 3],
    );
  } finally {
    value.cleanup();
  }
});

type AppendOptionsWithTrustedClock = NonNullable<
  Parameters<typeof appendAuthorityAuditRecord>[2]
> &
  Readonly<{ now: () => Date }>;

function appendWithTrustedClock(
  scope: AuthorityAuditLedgerScope,
  sequence: number,
  occurredAt: string,
  now: string,
) {
  const options: AppendOptionsWithTrustedClock = {
    now: () => new Date(now),
  };
  return appendAuthorityAuditRecord(
    scope,
    appendInput(sequence, occurredAt),
    options,
  );
}

test('development automatic retention rejects a far-future occurredAt without pruning', () => {
  const value = fixture('development');
  try {
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      appendWithTrustedClock(
        value.scope,
        sequence,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      );
    }
    assert.throws(
      () =>
        appendWithTrustedClock(
          value.scope,
          21,
          '2099-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_RECORD_INVALID'),
    );

    const scan = scanAuthorityAuditLedger(value.scope);
    assert.equal(scan.prunedRecordCount, 0);
    assert.equal(scan.recordCount, 20);
  } finally {
    value.cleanup();
  }
});

test('development automatic retention cannot be rewound by a backdated occurredAt', () => {
  const value = fixture('development');
  try {
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      appendWithTrustedClock(
        value.scope,
        sequence,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      );
    }
    appendWithTrustedClock(
      value.scope,
      21,
      '2020-01-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    );

    const scan = scanAuthorityAuditLedger(value.scope);
    assert.equal(scan.prunedRecordCount, 1);
    assert.equal(scan.recordCount, 20);
    assert.equal(scan.records[0]?.record.sequence, 2);
  } finally {
    value.cleanup();
  }
});

type MaintenanceHooksWithPreparationSeams = NonNullable<
  Parameters<typeof destroyProtectedAuthorityAuditLedger>[3]
> &
  Readonly<{
    testAfterTombstonePreparation?: () => void;
    testAfterCheckpointPreparation?: () => void;
  }>;

for (const crashWindow of [
  'testAfterTombstonePreparation',
  'testAfterCheckpointPreparation',
] as const) {
  test(`protected ${crashWindow} crash converges before exposing destruction`, () => {
    const value = fixture('protected');
    const signer = signingFixture();
    try {
      appendAuthorityAuditRecord(
        value.scope,
        appendInput(1, '2026-01-01T00:00:00.000Z'),
      );
      const head = appendAuthorityAuditRecord(
        value.scope,
        appendInput(2, '2026-01-02T00:00:00.000Z'),
      );
      const envelope = destructionEnvelope({
        scope: value.scope,
        throughSequence: head.record.sequence,
        throughRecordDigest: head.recordDigest,
        expectedHeadSequence: head.record.sequence,
        expectedHeadRecordDigest: head.recordDigest,
        signerIdentity: signer.signerIdentity,
        privateKey: signer.trusted.privateKey,
      });
      const hooks: MaintenanceHooksWithPreparationSeams = {
        [crashWindow]() {
          throw new Error(`simulated-${crashWindow}`);
        },
      };
      assert.throws(
        () =>
          destroyProtectedAuthorityAuditLedger(
            value.scope,
            envelope,
            {
              now: '2026-01-03T00:05:00.000Z',
              verifyHumanSignature: signer.verifyHumanSignature,
            },
            hooks,
          ),
        new RegExp(`simulated-${crashWindow}`),
      );

      const recovered = scanAuthorityAuditLedger(value.scope);
      assert.equal(recovered.prunedRecordCount, 2);
      assert.equal(recovered.recordCount, 0);
      assert.equal(recovered.headRecordDigest, head.recordDigest);
    } finally {
      value.cleanup();
    }
  });
}

function digestCanonicalEnvelope(
  envelope: AuditDestructionGrantEnvelope,
): Sha256Digest {
  return digest(`${canonicalJson(envelope)}\n`);
}
