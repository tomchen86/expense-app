import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dispatchAuthorityAuditCommand } from '../src/authority-audit-cli.ts';
import {
  canonicalAuditDestructionGrantPayload,
  type AuditDestructionGrantEnvelope,
  type AuditDestructionGrantPayload,
} from '../src/authority-audit-ledger.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { recordAuthorityAuditEvent } from '../src/authority-audit-service.ts';
import { git, isWorkflowError, sourceRepositoryRoot } from './fixture.ts';

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'authority-audit-cli-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = path.join(root, 'repository');
  const auditRoot = path.join(root, 'audit');
  const backendRoot = path.join(root, 'remote-worm');
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(auditRoot, { mode: 0o700 });
  fs.mkdirSync(backendRoot, { mode: 0o700 });
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.mkdirSync(path.join(repository, 'workflow'));
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow', 'maintainer-policy.json'),
    path.join(repository, 'workflow', 'maintainer-policy.json'),
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install audit trust base']);
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow', 'maintainer-policy.json'),
      'utf8',
    ),
  ) as { repository: { id: string } };
  const destructionKeys = crypto.generateKeyPairSync('ed25519');
  const destructionPublicKeyPath = path.join(root, 'destruction-public.pem');
  fs.writeFileSync(
    destructionPublicKeyPath,
    destructionKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  const resolved = dispatchAuthorityAuditCommand;
  return {
    root,
    repository,
    auditRoot,
    backendRoot,
    destructionKeys,
    destructionPublicKeyPath,
    repositoryIdentity: policy.repository.id,
    resolved,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

test('audit show and verify expose task-correlated external events', () => {
  const value = fixture();
  try {
    const empty = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    );
    const scope = empty.result.repositoryId;
    assert.equal(empty.verified, true);
    assert.equal(empty.result.recordCount, 0);
    const resolvedScope = {
      repositoryRoot: value.repository,
      externalAuditRoot: value.auditRoot,
      repositoryId: scope,
    };
    recordAuthorityAuditEvent(resolvedScope, {
      eventType: 'task-mandate',
      occurredAt: '2026-08-03T12:00:00.000Z',
      idempotencyKey: digest('1'),
      actor: { kind: 'human', identity: 'fixture-maintainer' },
      taskId: 'unified-plan',
      changeId: 'engine-v2',
      workflowId: null,
      grantDigest: digest('2'),
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: digest('3'),
      command: null,
      providerInvocation: null,
      externalEffect: null,
      result: 'succeeded',
      outcomeDigest: digest('4'),
      errorCode: null,
    });

    const shown = dispatchAuthorityAuditCommand(
      ['show', 'unified-plan', '--audit-root', value.auditRoot],
      value.repository,
    );
    assert.equal(shown.action, 'show');
    assert.equal(shown.verified, true);
    assert.equal(shown.result.events.length, 1);
    assert.equal(shown.result.events[0]!.event.eventType, 'task-mandate');
    const verified = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    );
    assert.equal(verified.action, 'verify');
    assert.equal(verified.verified, true);
    assert.equal(verified.result.projectedEventCount, 1);
  } finally {
    value.cleanup();
  }
});

test('audit profile command makes protected assurance durable for production callers', () => {
  const value = fixture();
  try {
    const configured = dispatchAuthorityAuditCommand(
      [
        'profile',
        'protected',
        '--audit-root',
        value.auditRoot,
        '--backend-root',
        value.backendRoot,
        '--destruction-public-key',
        value.destructionPublicKeyPath,
      ],
      value.repository,
      { stdinIsTTY: true, stdoutIsTTY: true },
    );
    assert.equal(configured.action, 'profile');
    assert.equal(configured.verified, true);
    assert.equal(configured.result.profile, 'protected');
    assert.equal(
      configured.assurance,
      'bootstrap-only-local-filesystem-worm-not-remote-sealed',
    );

    const verified = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    );
    assert.equal(verified.action, 'verify');
    assert.equal(verified.result.profile, 'protected');
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          ['profile', 'development', '--audit-root', value.auditRoot],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_PROFILE_MISMATCH'),
    );
  } finally {
    value.cleanup();
  }
});

test('protected audit CLI uses only the pinned backend and public key for anchor verification and destruction', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          [
            'profile',
            'protected',
            '--audit-root',
            value.auditRoot,
            '--backend-root',
            value.backendRoot,
            '--destruction-public-key',
            value.destructionPublicKeyPath,
          ],
          value.repository,
          { stdinIsTTY: false, stdoutIsTTY: true },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_AUDIT_CONTROLLING_TERMINAL_REQUIRED'),
    );
    dispatchAuthorityAuditCommand(
      [
        'profile',
        'protected',
        '--audit-root',
        value.auditRoot,
        '--backend-root',
        value.backendRoot,
        '--destruction-public-key',
        value.destructionPublicKeyPath,
      ],
      value.repository,
      { stdinIsTTY: true, stdoutIsTTY: true },
    );
    const verified = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    );
    const scope = {
      repositoryRoot: value.repository,
      externalAuditRoot: value.auditRoot,
      repositoryId: verified.result.repositoryId,
    };
    recordAuthorityAuditEvent(scope, {
      eventType: 'command',
      occurredAt: '2026-08-04T01:00:00.000Z',
      idempotencyKey: digest('a'),
      actor: { kind: 'human', identity: 'fixture-maintainer' },
      taskId: 'protected-audit',
      changeId: 'engine-v2',
      workflowId: null,
      grantDigest: null,
      candidateBundleDigest: null,
      prestateDigest: digest('b'),
      poststateDigest: digest('c'),
      command: { name: 'audit.fixture', argvDigest: digest('d') },
      providerInvocation: null,
      externalEffect: null,
      result: 'succeeded',
      outcomeDigest: digest('e'),
      errorCode: null,
    });

    const anchored = dispatchAuthorityAuditCommand(
      ['anchor', '--audit-root', value.auditRoot],
      value.repository,
      {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        now: new Date('2026-08-04T01:01:00.000Z'),
      },
    );
    assert.equal(anchored.action, 'anchor');
    assert.equal(anchored.verified, true);
    assert.equal(
      anchored.assurance,
      'bootstrap-only-local-filesystem-worm-not-remote-sealed',
    );
    const anchors = dispatchAuthorityAuditCommand(
      ['verify-anchors', '--audit-root', value.auditRoot],
      value.repository,
    );
    assert.equal(anchors.action, 'verify-anchors');
    assert.equal(anchors.verified, true);
    assert.equal(anchors.result.currentHeadAnchored, true);

    const head = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    ).result;
    assert.notEqual(head.headRecordDigest, null);
    const payload: AuditDestructionGrantPayload = {
      schemaVersion: 1,
      kind: 'audit-destruction-grant.v1',
      domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
      grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repositoryId: head.repositoryId,
      profile: 'protected',
      expectedHeadSequence: head.headSequence,
      expectedHeadRecordDigest: head.headRecordDigest!,
      throughSequence: head.headSequence,
      throughRecordDigest: head.headRecordDigest!,
      issuedAt: '2026-08-04T01:01:00.000Z',
      expiresAt: '2026-08-04T01:10:00.000Z',
      uses: 1,
      signerIdentity: 'fixture-maintainer',
      reasonDigest: digest('f'),
      remoteAnchorDisposition: 'retain',
    };
    const envelope: AuditDestructionGrantEnvelope = {
      schemaVersion: 1,
      kind: 'audit-destruction-grant-envelope.v1',
      payload,
      signature: crypto
        .sign(
          null,
          Buffer.from(canonicalAuditDestructionGrantPayload(payload)),
          value.destructionKeys.privateKey,
        )
        .toString('base64'),
    };
    const grantFile = path.join(value.root, 'destruction-grant.json');
    fs.writeFileSync(grantFile, `${canonicalJson(envelope)}\n`, {
      mode: 0o600,
    });
    const destroyed = dispatchAuthorityAuditCommand(
      ['destroy', '--grant-file', grantFile, '--audit-root', value.auditRoot],
      value.repository,
      {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        now: new Date('2026-08-04T01:05:00.000Z'),
      },
    );
    assert.equal(destroyed.action, 'destroy');
    assert.equal(destroyed.verified, true);
    assert.equal(destroyed.result.pruned, 1);
  } finally {
    value.cleanup();
  }
});

test('audit CLI rejects implicit roots, repository mismatch, and unsafe arguments', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          ['verify', value.repositoryIdentity],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_USAGE'),
    );
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          [
            'verify',
            'github:wrong/repository',
            '--audit-root',
            value.auditRoot,
          ],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_REPOSITORY_MISMATCH'),
    );
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          ['show', 'unified-plan', '--audit-root', 'relative-audit'],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_USAGE'),
    );
  } finally {
    value.cleanup();
  }
});
