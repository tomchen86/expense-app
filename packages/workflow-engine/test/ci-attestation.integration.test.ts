import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyBaseAuthorityAttestations } from '../src/ci-attestation.ts';
import {
  canonicalGrantEnvelope,
  canonicalGrantPayload,
  type MaintainerGrantEnvelope,
  type MaintainerGrantPayload,
} from '../src/maintainer-grant.ts';
import { issueAuthorityAttestation } from '../src/maintainer-attestation.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import type { MaintainerPolicy } from '../src/maintainer-policy.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const PRIMARY_GRANT = '33333333-3333-4333-8333-333333333333';
const SECOND_GRANT = '44444444-4444-4444-8444-444444444444';
const GRANT_NAMESPACE = 'expense-app.workflow.maintainer-grant.v1';

const POLICY_TEMPLATE: Omit<MaintainerPolicy, 'trustedSigners'> = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_fixture',
    origin: 'https://github.com/example/fixture.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: GRANT_NAMESPACE,
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [
    'packages/workflow-engine/src/**',
    'workflow/checks.json',
    'workflow/maintainer-policy.json',
    'workflow/schemas/**',
  ],
  sealedImmutablePaths: [
    'packages/workflow-engine/src/maintainer-policy.ts',
    'workflow/maintainer-policy.json',
    'workflow/schemas/maintainer-policy.schema.json',
  ],
  requiredChecks: ['fixture'],
};

type ScannerFixture = {
  repository: string;
  signingDirectory: string;
  privateKey: string;
  policy: MaintainerPolicy;
  now: Date;
  baseCommit: string;
  originalBase: string;
  rebasedBase: string;
  originalCommit: string;
  mainCommit: string;
};

function sh(
  repository: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function rebaseCommitterEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_COMMITTER_NAME: 'GitHub',
    GIT_COMMITTER_EMAIL: 'noreply@github.com',
    GIT_COMMITTER_DATE: '2026-07-17T05:00:00Z',
  };
}

function commitMessage(repository: string, commit: string): string {
  const raw = sh(repository, ['cat-file', 'commit', commit]);
  const boundary = raw.indexOf('\n\n');
  assert.notEqual(boundary, -1);
  return raw.slice(boundary + 2);
}

function rewriteCommit(
  repository: string,
  source: string,
  parent: string,
  environment: NodeJS.ProcessEnv = rebaseCommitterEnvironment(),
): string {
  return sh(repository, ['commit-tree', `${source}^{tree}`, '-p', parent], {
    input: commitMessage(repository, source),
    env: environment,
  }).trim();
}

function generateKey(directory: string): {
  privateKey: string;
  trustedSigner: MaintainerPolicy['trustedSigners'][number];
} {
  const privateKey = path.join(directory, 'id_ed25519');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'fixture-maintainer',
      '-f',
      privateKey,
    ],
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
  return {
    privateKey,
    trustedSigner: {
      identity: 'fixture-maintainer',
      publicKey,
      fingerprint,
    },
  };
}

function signWithNamespace(
  privateKey: string,
  payload: string,
  namespace: string,
): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-attest-sign-'),
  );
  const payloadPath = path.join(directory, 'payload');
  try {
    fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
    const result = spawnSync(
      '/usr/bin/ssh-keygen',
      ['-Y', 'sign', '-f', privateKey, '-n', namespace, payloadPath],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixtureSshSigner(
  privateKey: string,
  policy: MaintainerPolicy,
): MaintainerSignerProvider {
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  return {
    assertHumanPresent() {},
    identity() {
      return trusted.identity;
    },
    sign(payload, namespace) {
      return signWithNamespace(
        privateKey,
        payload,
        namespace ?? policy.signatureNamespace,
      );
    },
    verify() {},
  };
}

function writeGrantTag(
  repository: string,
  privateKey: string,
  policy: MaintainerPolicy,
  grantId: string,
  baseCommit: string,
  now: Date,
): MaintainerGrantEnvelope {
  const policyBlob = sh(repository, [
    'rev-parse',
    `${baseCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const payload: MaintainerGrantPayload = {
    version: 1,
    grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    baseCommit,
    policyBlob,
    changeId: 'demo-change',
    allowedPaths: ['workflow/checks.json'],
    issuedAt: new Date(now.getTime() - 300_000).toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    maxUses: 1,
    reason: 'Repair exact workflow authority',
    signer: 'fixture-maintainer',
  };
  const envelope: MaintainerGrantEnvelope = {
    payload,
    signature: signWithNamespace(
      privateKey,
      canonicalGrantPayload(payload),
      GRANT_NAMESPACE,
    ),
  };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-attest-tag-'),
  );
  const messagePath = path.join(directory, 'message');
  try {
    fs.writeFileSync(messagePath, canonicalGrantEnvelope(envelope), {
      mode: 0o600,
    });
    git(repository, [
      'tag',
      '--annotate',
      '--cleanup=verbatim',
      '--file',
      messagePath,
      `workflow-grant/${grantId}`,
      baseCommit,
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return envelope;
}

function prepareScannerFixture(): ScannerFixture {
  const repository = createFixtureRepository();
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-attest-key-'),
  );
  const key = generateKey(signingDirectory);
  const policy: MaintainerPolicy = {
    ...POLICY_TEMPLATE,
    trustedSigners: [key.trustedSigner],
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', '--all']);
  git(repository, ['commit', '-m', 'Add maintainer fixture policy']);
  git(repository, ['config', 'gpg.format', 'ssh']);
  git(repository, ['config', 'user.signingkey', key.privateKey]);
  const baseCommit = sh(repository, ['rev-parse', 'HEAD']).trim();

  const checksPath = path.join(repository, 'workflow/checks.json');
  fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
  git(repository, ['add', '--all']);
  git(repository, [
    'commit',
    '-m',
    'Plan demo-change\n\nChange: demo-change\nTransition: plan',
  ]);
  const originalBase = sh(repository, ['rev-parse', 'HEAD']).trim();

  fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
  git(repository, ['add', '--all']);
  git(repository, [
    'commit',
    '-S',
    '-m',
    'Repair workflow authority\n\nChange: demo-change\nTransition: authority-maintenance\n' +
      `Grant: ${PRIMARY_GRANT}`,
  ]);
  const originalCommit = sh(repository, ['rev-parse', 'HEAD']).trim();

  const rebasedBase = rewriteCommit(repository, originalBase, baseCommit);
  const mainCommit = rewriteCommit(repository, originalCommit, rebasedBase);
  sh(repository, ['update-ref', 'refs/remotes/origin/main', mainCommit]);

  const now = new Date();
  writeGrantTag(
    repository,
    key.privateKey,
    policy,
    PRIMARY_GRANT,
    originalBase,
    now,
  );

  return {
    repository,
    signingDirectory,
    privateKey: key.privateKey,
    policy,
    now,
    baseCommit,
    originalBase,
    rebasedBase,
    originalCommit,
    mainCommit,
  };
}

function issueFixtureAttestation(fixture: ScannerFixture): void {
  issueAuthorityAttestation(
    fixture.repository,
    {
      originalCommit: fixture.originalCommit,
      mainCommit: fixture.mainCommit,
      grantBasePairs: [
        { originalBase: fixture.originalBase, mainBase: fixture.rebasedBase },
      ],
    },
    {
      now: fixture.now,
      signer: fixtureSshSigner(fixture.privateKey, fixture.policy),
    },
  );
}

function cleanup(fixture: ScannerFixture): void {
  fs.rmSync(fixture.repository, { recursive: true, force: true });
  fs.rmSync(fixture.signingDirectory, { recursive: true, force: true });
}

test('base replay accepts a fully attested authority lineage', () => {
  const fixture = prepareScannerFixture();
  try {
    issueFixtureAttestation(fixture);
    const result = verifyBaseAuthorityAttestations(
      fixture.repository,
      fixture.mainCommit,
      fixture.now,
    );
    assert.deepEqual(result.attestedAuthorities, [
      {
        grantId: PRIMARY_GRANT,
        changeId: 'demo-change',
        originalCommit: fixture.originalCommit,
        mainCommit: fixture.mainCommit,
      },
    ]);
  } finally {
    cleanup(fixture);
  }
});

test('base replay fails closed when the attestation tag is missing', () => {
  const fixture = prepareScannerFixture();
  try {
    assert.throws(
      () =>
        verifyBaseAuthorityAttestations(
          fixture.repository,
          fixture.mainCommit,
          fixture.now,
        ),
      (error) => isWorkflowError(error, 'CI_ATTESTATION_MISSING'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('base replay rejects an attestation bound to a different main commit', () => {
  const fixture = prepareScannerFixture();
  try {
    issueFixtureAttestation(fixture);
    const driftedMain = rewriteCommit(
      fixture.repository,
      fixture.originalCommit,
      fixture.rebasedBase,
      {
        GIT_COMMITTER_NAME: 'GitHub',
        GIT_COMMITTER_EMAIL: 'noreply@github.com',
        GIT_COMMITTER_DATE: '2026-07-17T06:00:00Z',
      },
    );
    assert.throws(
      () =>
        verifyBaseAuthorityAttestations(
          fixture.repository,
          driftedMain,
          fixture.now,
        ),
      (error) => isWorkflowError(error, 'CI_ATTESTATION_MAPPING_INVALID'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('base replay rejects an incomplete grant-base mapping', () => {
  const fixture = prepareScannerFixture();
  try {
    issueFixtureAttestation(fixture);
    writeGrantTag(
      fixture.repository,
      fixture.privateKey,
      fixture.policy,
      SECOND_GRANT,
      fixture.originalBase,
      fixture.now,
    );
    assert.throws(
      () =>
        verifyBaseAuthorityAttestations(
          fixture.repository,
          fixture.mainCommit,
          fixture.now,
        ),
      (error) =>
        isWorkflowError(error, 'CI_ATTESTATION_GRANT_BASES_INCOMPLETE'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('base replay ignores histories without authority transitions', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
    git(repository, ['add', '--all']);
    git(repository, ['commit', '-m', 'Add fixture readme']);
    const head = sh(repository, ['rev-parse', 'HEAD']).trim();
    const result = verifyBaseAuthorityAttestations(repository, head);
    assert.deepEqual(result.attestedAuthorities, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('base replay fails closed when authority history has no trusted policy', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
    git(repository, ['add', '--all']);
    git(repository, ['commit', '-m', 'Add fixture readme']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'changed\n');
    git(repository, ['add', '--all']);
    git(repository, [
      'commit',
      '-m',
      'Repair workflow authority\n\nChange: demo-change\nTransition: authority-maintenance\n' +
        `Grant: ${PRIMARY_GRANT}`,
    ]);
    const head = sh(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyBaseAuthorityAttestations(repository, head),
      (error) => isWorkflowError(error, 'CI_ATTESTATION_POLICY_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
