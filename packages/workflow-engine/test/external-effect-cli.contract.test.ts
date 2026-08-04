import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import {
  publishArtifactDigest,
  publishPrestateDigest,
} from '../src/publish-executor.ts';
import {
  authorizeTaskMandate,
  TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
} from '../src/task-mandate.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const TASK_ID = 'publish-cli-demo';
const GRANT_ID = '77777777-7777-4777-8777-777777777777';
const ORIGIN = 'https://github.com/example/fixture.git';

test('external-effect issue CLI resolves the active mandate before refusing unattended signing', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'external-effect-cli-key-'),
  );
  const repository = createFixtureRepository();
  const externalAuditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'external-effect-cli-audit-')),
  );
  fs.chmodSync(externalAuditRoot, 0o700);
  try {
    const signing = installTrustBase(repository, keyDirectory);
    authorizeTaskMandate(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        intent: 'Publish the exact reviewed demo artifact.',
        providerCalls: {},
      },
      {
        mandateId: '88888888-8888-4888-8888-888888888888',
        externalAuditRoot,
        signer: realSigningProvider(signing.privateKey),
      },
    );
    const sourceOid = git(repository, ['rev-parse', 'HEAD']).trim();
    const targetPath = path.join(repository, 'publish-target.json');
    const rollbackPath = path.join(repository, 'publish-rollback.json');
    fs.writeFileSync(
      targetPath,
      `${JSON.stringify({
        kind: 'git-ref',
        remoteName: 'origin',
        remoteUrl: ORIGIN,
        refName: 'refs/heads/main',
        sourceOid,
        expectedRemoteOid: sourceOid,
      })}\n`,
    );
    fs.writeFileSync(
      rollbackPath,
      `${JSON.stringify({
        kind: 'restore-git-ref',
        planDigest: digest('restore the exact prior main ref'),
      })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'external-effect',
        'issue',
        '--grant',
        GRANT_ID,
        '--task',
        TASK_ID,
        '--kind',
        'publish-git-ref',
        '--target-file',
        targetPath,
        '--artifact-digest',
        publishArtifactDigest(sourceOid),
        '--prestate-digest',
        publishPrestateDigest(sourceOid),
        '--rollback-plan-file',
        rollbackPath,
        '--idempotency-key',
        `publish:${sourceOid}:refs/heads/main`,
        '--ttl-seconds',
        '300',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 12, result.stderr);
    assert.equal(
      (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/external-effect-grants'),
      ),
      false,
    );
    const audited = verifyAuthorityAuditEvents({
      externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
    });
    assert.equal(audited.ok, true);
    assert.equal(audited.events.at(-1)?.event.eventType, 'error');
    assert.equal(audited.events.at(-1)?.event.result, 'failed');
    assert.equal(
      audited.events.at(-1)?.event.errorCode,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(externalAuditRoot, { recursive: true, force: true });
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});

test('publish CLI routes only an exact grant execution request', () => {
  const repository = createFixtureRepository();
  try {
    const cli = path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/cli.ts',
    );
    const malformed = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cli, 'publish', 'execute', '--json'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(malformed.status, 2, malformed.stderr);
    assert.equal(
      (JSON.parse(malformed.stderr) as { error: { code: string } }).error.code,
      'INVALID_USAGE',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('external-effect reconciliation CLI accepts only an explicit evidence document', () => {
  const repository = createFixtureRepository();
  try {
    const cli = path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/cli.ts',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'external-effect',
        'reconcile',
        GRANT_ID,
        '--evidence-file',
        'missing-reconciliation.json',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 10, result.stderr);
    assert.equal(
      (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
      'EXTERNAL_EFFECT_GRANT_INVALID',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function installTrustBase(
  repository: string,
  keyDirectory: string,
): { privateKey: string } {
  const privateKey = path.join(keyDirectory, 'id_ed25519');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${privateKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: 'github:R_fixture', origin: ORIGIN },
        phase: 'bootstrap',
        auditTagPrefix: 'refs/tags/workflow-grant/',
        signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
        maxTtlMinutes: 30,
        maxUses: 1,
        bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
        sealedImmutablePaths: [],
        requiredChecks: ['fixture'],
        trustedSigners: [
          {
            identity: 'fixture-maintainer',
            publicKey,
            fingerprint,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  git(repository, ['remote', 'add', 'origin', ORIGIN]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install external effect CLI trust base']);
  return { privateKey };
}

function realSigningProvider(privateKey: string): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => 'fixture-maintainer',
    sign(payload, namespace) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'external-effect-cli-sign-'),
      );
      const payloadPath = path.join(directory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const signed = spawnSync(
          '/usr/bin/ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            privateKey,
            '-n',
            namespace ?? TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(signed.status, 0, signed.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verify() {},
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
