import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseAuthorityAttestationEnvelope,
  canonicalAttestationEnvelope,
} from '../src/authority-attestation.ts';
import {
  canonicalGrantEnvelope,
  canonicalGrantPayload,
  type MaintainerGrantEnvelope,
  type MaintainerGrantPayload,
} from '../src/maintainer-grant.ts';
import {
  AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
  issueAuthorityAttestation,
} from '../src/maintainer-attestation.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import type { MaintainerPolicy } from '../src/maintainer-policy.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const PRIMARY_GRANT = '11111111-1111-4111-8111-111111111111';
const UNSIGNED_GRANT = '22222222-2222-4222-8222-222222222222';
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

type AttestationFixture = {
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
): string {
  return sh(repository, ['commit-tree', `${source}^{tree}`, '-p', parent], {
    input: commitMessage(repository, source),
    env: rebaseCommitterEnvironment(),
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
    path.join(os.tmpdir(), 'workflow-attest-sign-'),
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

function verifiesWithNamespace(
  policy: MaintainerPolicy,
  payload: string,
  signature: string,
  namespace: string,
): boolean {
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-attest-verify-'),
  );
  const allowedSigners = path.join(directory, 'allowed-signers');
  const signaturePath = path.join(directory, 'signature');
  try {
    fs.writeFileSync(
      allowedSigners,
      `${trusted.identity} ${trusted.publicKey}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(signaturePath, signature, { mode: 0o600 });
    const result = spawnSync(
      '/usr/bin/ssh-keygen',
      [
        '-Y',
        'verify',
        '-f',
        allowedSigners,
        '-I',
        trusted.identity,
        '-n',
        namespace,
        '-s',
        signaturePath,
      ],
      { encoding: 'utf8', input: payload },
    );
    return result.status === 0;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function recordingSigner(
  privateKey: string,
  policy: MaintainerPolicy,
  namespaces: string[],
): MaintainerSignerProvider {
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  return {
    assertHumanPresent() {},
    identity() {
      return trusted.identity;
    },
    sign(payload, namespace) {
      const selected = namespace ?? policy.signatureNamespace;
      namespaces.push(selected);
      return signWithNamespace(privateKey, payload, selected);
    },
    verify(payload, signature, identity, namespace) {
      assert.equal(identity, trusted.identity);
      assert.ok(
        verifiesWithNamespace(
          policy,
          payload,
          signature,
          namespace ?? policy.signatureNamespace,
        ),
      );
    },
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
    path.join(os.tmpdir(), 'workflow-attest-tag-'),
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

function prepareAttestationFixture(): AttestationFixture {
  const repository = createFixtureRepository();
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-attest-key-'),
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

function cleanup(fixture: AttestationFixture): void {
  fs.rmSync(fixture.repository, { recursive: true, force: true });
  fs.rmSync(fixture.signingDirectory, { recursive: true, force: true });
}

function issue(
  fixture: AttestationFixture,
  overrides: {
    originalCommit?: string;
    mainCommit?: string;
    grantBasePairs?: Array<{ originalBase: string; mainBase: string }>;
    namespaces?: string[];
  } = {},
) {
  return issueAuthorityAttestation(
    fixture.repository,
    {
      originalCommit: overrides.originalCommit ?? fixture.originalCommit,
      mainCommit: overrides.mainCommit ?? fixture.mainCommit,
      grantBasePairs: overrides.grantBasePairs ?? [
        {
          originalBase: fixture.originalBase,
          mainBase: fixture.rebasedBase,
        },
      ],
    },
    {
      now: fixture.now,
      signer: recordingSigner(
        fixture.privateKey,
        fixture.policy,
        overrides.namespaces ?? [],
      ),
    },
  );
}

test('maintainer attest creates one canonical protected attestation tag', () => {
  const fixture = prepareAttestationFixture();
  const namespaces: string[] = [];
  try {
    const result = issue(fixture, { namespaces });

    assert.equal(result.grantId, PRIMARY_GRANT);
    assert.equal(
      result.tagRef,
      `refs/tags/workflow-attestation/${PRIMARY_GRANT}`,
    );
    assert.equal(
      result.publishCommand,
      `git push origin ${result.tagRef}:${result.tagRef}`,
    );
    assert.deepEqual(namespaces, [AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE]);

    const target = sh(fixture.repository, [
      'rev-parse',
      `${result.tagRef}^{commit}`,
    ]).trim();
    assert.equal(target, fixture.originalCommit);
    const tagType = sh(fixture.repository, [
      'cat-file',
      '-t',
      result.tagRef,
    ]).trim();
    assert.equal(tagType, 'tag');

    const rawTag = sh(fixture.repository, ['cat-file', 'tag', result.tagRef]);
    const message = rawTag.slice(rawTag.indexOf('\n\n') + 2);
    assert.equal(message, canonicalAttestationEnvelope(result.envelope));

    const envelope = parseAuthorityAttestationEnvelope(message);
    assert.equal(envelope.payload.grantId, PRIMARY_GRANT);
    assert.equal(envelope.payload.originalCommit, fixture.originalCommit);
    assert.equal(envelope.payload.mainCommit, fixture.mainCommit);
    assert.equal(envelope.payload.protectedBranch, 'main');
    assert.equal(envelope.payload.repositoryId, fixture.policy.repository.id);
    assert.equal(
      envelope.payload.repositoryOrigin,
      fixture.policy.repository.origin,
    );
    assert.equal(envelope.payload.signer, 'fixture-maintainer');
    assert.deepEqual(envelope.payload.grantBases, [
      {
        originalBase: fixture.originalBase,
        mainBase: fixture.rebasedBase,
        grantIds: [PRIMARY_GRANT],
      },
    ]);

    const canonicalPayload = `${JSON.stringify(envelope.payload)}\n`;
    assert.ok(
      verifiesWithNamespace(
        fixture.policy,
        canonicalPayload,
        envelope.signature,
        AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
      ),
    );
    assert.equal(
      verifiesWithNamespace(
        fixture.policy,
        canonicalPayload,
        envelope.signature,
        GRANT_NAMESPACE,
      ),
      false,
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest requires a clean worktree', () => {
  const fixture = prepareAttestationFixture();
  try {
    fs.writeFileSync(path.join(fixture.repository, 'dirty.txt'), 'dirty\n');
    assert.throws(
      () => issue(fixture),
      (error) => isWorkflowError(error, 'AUTHORITY_ATTESTATION_DIRTY_WORKTREE'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest rejects a mapping whose trees differ', () => {
  const fixture = prepareAttestationFixture();
  try {
    const drifted = sh(
      fixture.repository,
      [
        'commit-tree',
        `${fixture.originalBase}^{tree}`,
        '-p',
        fixture.rebasedBase,
      ],
      {
        input: commitMessage(fixture.repository, fixture.originalCommit),
        env: rebaseCommitterEnvironment(),
      },
    ).trim();
    sh(fixture.repository, ['update-ref', 'refs/remotes/origin/main', drifted]);
    assert.throws(
      () => issue(fixture, { mainCommit: drifted }),
      (error) => isWorkflowError(error, 'AUTHORITY_TRANSITION_MISMATCH'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest rejects main commits outside the protected ref', () => {
  const fixture = prepareAttestationFixture();
  try {
    sh(fixture.repository, [
      'update-ref',
      'refs/remotes/origin/main',
      fixture.rebasedBase,
    ]);
    assert.throws(
      () => issue(fixture),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_ATTESTATION_MAIN_UNREACHABLE'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest rejects a primary authority without its grant tag', () => {
  const fixture = prepareAttestationFixture();
  try {
    git(fixture.repository, ['tag', '-d', `workflow-grant/${PRIMARY_GRANT}`]);
    assert.throws(
      () => issue(fixture),
      (error) => isWorkflowError(error, 'AUTHORITY_ATTESTATION_GRANT_MISSING'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest rejects an unsigned original authority commit', () => {
  const fixture = prepareAttestationFixture();
  try {
    const checksPath = path.join(fixture.repository, 'workflow/checks.json');
    fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
    git(fixture.repository, ['add', '--all']);
    git(fixture.repository, [
      'commit',
      '--no-gpg-sign',
      '-m',
      'Repair workflow authority\n\nChange: demo-change\nTransition: authority-maintenance\n' +
        `Grant: ${UNSIGNED_GRANT}`,
    ]);
    const unsignedOriginal = sh(fixture.repository, [
      'rev-parse',
      'HEAD',
    ]).trim();
    writeGrantTag(
      fixture.repository,
      fixture.privateKey,
      fixture.policy,
      UNSIGNED_GRANT,
      fixture.originalCommit,
      fixture.now,
    );
    const rebased = rewriteCommit(
      fixture.repository,
      unsignedOriginal,
      fixture.mainCommit,
    );
    sh(fixture.repository, ['update-ref', 'refs/remotes/origin/main', rebased]);
    assert.throws(
      () =>
        issue(fixture, {
          originalCommit: unsignedOriginal,
          mainCommit: rebased,
          grantBasePairs: [
            {
              originalBase: fixture.originalCommit,
              mainBase: fixture.mainCommit,
            },
          ],
        }),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_ATTESTATION_SIGNATURE_INVALID'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest rejects grant-base pairs without bound grants', () => {
  const fixture = prepareAttestationFixture();
  try {
    assert.throws(
      () =>
        issue(fixture, {
          grantBasePairs: [
            {
              originalBase: fixture.originalCommit,
              mainBase: fixture.mainCommit,
            },
          ],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_ATTESTATION_GRANT_MISSING'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest refuses to replace an existing attestation tag', () => {
  const fixture = prepareAttestationFixture();
  try {
    issue(fixture);
    assert.throws(
      () => issue(fixture),
      (error) => isWorkflowError(error, 'AUTHORITY_ATTESTATION_EXISTS'),
    );
  } finally {
    cleanup(fixture);
  }
});

test('maintainer attest requires an interactive terminal for the real signer', () => {
  const fixture = prepareAttestationFixture();
  try {
    assert.throws(
      () =>
        issueAuthorityAttestation(
          fixture.repository,
          {
            originalCommit: fixture.originalCommit,
            mainCommit: fixture.mainCommit,
            grantBasePairs: [
              {
                originalBase: fixture.originalBase,
                mainBase: fixture.rebasedBase,
              },
            ],
          },
          { now: fixture.now },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );
  } finally {
    cleanup(fixture);
  }
});
