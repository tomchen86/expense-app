import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  canonicalAuthorityApplicationReceiptEnvelope,
  canonicalAuthorityApplicationReceiptPayload,
  parseAuthorityApplicationReceiptEnvelope,
  type AuthorityApplicationReceiptEnvelope,
} from '../src/authority-application-receipt.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Payload,
  issueMaintainerGrantV2,
  parseMaintainerGrantV2Envelope,
  preflightMaintainerGrantV2,
  validateMaintainerGrantV2AuthorityBinding,
  type MaintainerGrantV2Envelope,
  type MaintainerGrantV2Payload,
} from '../src/maintainer-grant-v2.ts';
import {
  approveAndApplyMaintainerGrantV2,
  prepareMaintainerGrantV2Checks,
  reissueAndApplyMaintainerGrantV2,
  revokeMaintainerGrantV2,
} from '../src/maintainer-approve.ts';
import { validateCiAuthorityCommit } from '../src/ci-authority.ts';
import { verifyBaseAuthorityAttestations } from '../src/ci-attestation.ts';
import { listRangeCommits } from '../src/ci-git.ts';
import { replayCommitSequence } from '../src/ci-sequence.ts';
import {
  commitAuthoritySession,
  SimulatedAuthorityCrash,
} from '../src/maintainer-commit.ts';
import {
  readAuthorityCommitJournal,
  recoverAuthorityCommit,
} from '../src/maintainer-recovery.ts';
import {
  authorityAuditLedgerPaths,
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
} from '../src/authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/authority-audit-service.ts';
import {
  buildImmutableCandidateBundle,
  readDurableRefGenerationLedger,
  readStoredImmutableCandidateBundle,
  storeImmutableCandidateBundle,
} from '../src/maintainer-candidate.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { parseMaintainerPolicy } from '../src/maintainer-policy.ts';
import {
  abortAuthoritySession,
  checkAuthoritySession,
  readAuthoritySession,
  startAuthoritySession,
} from '../src/maintainer-session.ts';
import { inspectMaintainerGrants } from '../src/maintainer-store.ts';
import {
  authorizeTaskMandate,
  inspectActiveTaskMandateBinding,
  revokeTaskMandate,
} from '../src/task-mandate.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  computeProtectedCapabilityEntryDigests,
} from '../src/protected-capabilities.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const PROFILE_ID = 'workflow-engine-bootstrap';
const ROOT_PROFILE_ID = 'workflow-engine-root-one-shot';
const TASK_ID = 'demo-task';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const FAKE_SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'ZmFrZQ==',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n');
const temporaryAuditRoots = new Set<string>();

function externalAuditRoot(repository: string): string {
  const root = `${fs.realpathSync(repository)}.external-authority-audit`;
  temporaryAuditRoots.add(root);
  return root;
}

test.after(() => {
  for (const root of temporaryAuditRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function installV2TrustBase(repository: string): void {
  const signingKey = path.join(repository, '.git/workflow-test-signing-key');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${signingKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${signingKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  git(repository, ['config', 'gpg.format', 'ssh']);
  git(repository, ['config', 'user.signingkey', signingKey]);

  const policy = {
    schemaVersion: 1,
    repository: {
      id: 'github:R_fixture',
      origin: 'https://github.com/example/fixture.git',
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/workflow-grant/',
    signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: [
      'packages/workflow-engine/src/**',
      'workflow/checks.json',
    ],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [
      {
        identity: 'fixture-maintainer',
        publicKey,
        fingerprint,
      },
    ],
  };
  const profiles = {
    schemaVersion: 1,
    profiles: {
      [PROFILE_ID]: {
        id: PROFILE_ID,
        version: 1,
        authorityClass: 'ordinary',
        implementationPaths: ['packages/workflow-engine/src/**'],
        evidencePaths: ['packages/workflow-engine/test/**'],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['.github/workflows/**'],
        forbiddenPaths: ['packages/workflow-engine/src/maintainer-grant.ts'],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 12,
        },
        requiredChecks: ['fixture'],
        checkDependencies: {
          fixture: ['harness-engine', 'runner', 'source-tree'],
        },
      },
      [ROOT_PROFILE_ID]: {
        id: ROOT_PROFILE_ID,
        version: 1,
        authorityClass: 'root-one-shot',
        implementationPaths: ['packages/workflow-engine/src/**'],
        evidencePaths: ['packages/workflow-engine/test/**'],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['.github/workflows/**'],
        forbiddenPaths: ['packages/workflow-engine/src/maintainer-grant.ts'],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 12,
        },
        requiredChecks: ['fixture'],
        checkDependencies: {
          fixture: ['harness-engine', 'runner', 'source-tree'],
        },
      },
    },
  };
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/src'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/test'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/execution-governance.ts',
    ),
    'export const GRANT_LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/protected-capabilities.ts',
    ),
    'export const PROTECTED_CAPABILITY_LOADER = true;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 1;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-profiles.json'),
    `${JSON.stringify(profiles, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'scripts/pass.mjs'),
    [
      "import fs from 'node:fs';",
      "if (fs.existsSync('.git/v2-force-check-failure')) process.exit(1);",
      "fs.writeFileSync('.git/v2-check-passed', 'passed');",
      '',
    ].join('\n'),
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install maintainer v2 trust base files']);

  const contentBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const entrypoints = ['packages/workflow-engine/src/execution-governance.ts'];
  const dependencies = [
    'packages/workflow-engine/src/protected-capabilities.ts',
    'workflow/protected-capabilities.json',
  ];
  const closure = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  const protectedCapabilities = {
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
      capability,
      entrypoints,
      dependencies,
      ...closure,
    })),
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(protectedCapabilities, null, 2)}\n`,
  );
  git(repository, ['add', 'workflow/protected-capabilities.json']);
  git(repository, ['commit', '-m', 'Install typed capability closure']);
}

function prepareCandidate(): string {
  const repository = createFixtureRepository();
  installV2TrustBase(repository);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  authorizeTaskMandate(
    repository,
    {
      changeId: 'demo-change',
      taskId: TASK_ID,
      intent: 'Prepare and apply the exact demo change candidate safely.',
      providerCalls: {},
    },
    {
      now: new Date('2026-08-03T08:55:00.000Z'),
      signer: fixtureV2SshSigner(repository),
      externalAuditRoot: externalAuditRoot(repository),
    },
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 2;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 2;\n',
  );
  return repository;
}

function prepareTwoCheckCandidate(): string {
  const repository = createFixtureRepository();
  installV2TrustBase(repository);
  git(repository, ['checkout', '-b', 'work/demo-change']);

  const checksPath = path.join(repository, 'workflow/checks.json');
  const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>;
  };
  checks.checks = {
    fixture: {
      command: ['node', 'scripts/check-one.mjs'],
      destructiveDatabase: false,
    },
    'fixture-two': {
      command: ['node', 'scripts/check-two.mjs'],
      destructiveDatabase: false,
    },
  };
  fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
  for (const [name, marker] of [
    ['check-one.mjs', 'check-one-count'],
    ['check-two.mjs', 'check-two-count'],
  ] as const) {
    fs.writeFileSync(
      path.join(repository, 'scripts', name),
      [
        "import fs from 'node:fs';",
        `const marker = new URL('../.git/${marker}', import.meta.url);`,
        "const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;",
        'fs.writeFileSync(marker, String(count + 1));',
        '',
      ].join('\n'),
    );
  }
  const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    requiredChecks: string[];
  };
  policy.requiredChecks = ['fixture', 'fixture-two'];
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
    profiles: Record<
      string,
      {
        requiredChecks: string[];
        checkDependencies: Record<string, string[]>;
      }
    >;
  };
  for (const profile of Object.values(profiles.profiles)) {
    profile.requiredChecks = ['fixture', 'fixture-two'];
    profile.checkDependencies['fixture-two'] = [
      'harness-engine',
      'runner',
      'source-tree',
    ];
  }
  fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install two exact base checks']);
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 2;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 2;\n',
  );
  return repository;
}

function checkRunCount(repository: string, marker: string): number {
  return Number(fs.readFileSync(path.join(repository, '.git', marker), 'utf8'));
}

function withTwoCheckCandidate<T>(operation: (repository: string) => T): T {
  const repository = prepareTwoCheckCandidate();
  try {
    return operation(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

test('preapproval checks durably resume after interruption without rerunning completed evidence', () => {
  withTwoCheckCandidate((repository) => {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    let interrupted = false;

    assert.throws(
      () =>
        prepareMaintainerGrantV2Checks(repository, preflight, process.env, {
          testAfterCheckPersisted(checkId) {
            if (checkId === 'fixture' && !interrupted) {
              interrupted = true;
              throw new Error('simulated check process crash');
            }
          },
        }),
      /simulated check process crash/,
    );
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(
      fs.existsSync(path.join(repository, '.git', 'check-two-count')),
      false,
    );

    const resumed = prepareMaintainerGrantV2Checks(
      repository,
      preflight,
      process.env,
    );
    assert.deepEqual(
      resumed.checks.map(({ evidence }) => evidence.checkId),
      ['fixture', 'fixture-two'],
    );
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(checkRunCount(repository, 'check-two-count'), 1);

    const replayed = prepareMaintainerGrantV2Checks(
      repository,
      preflight,
      process.env,
    );
    assert.deepEqual(replayed, resumed);
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(checkRunCount(repository, 'check-two-count'), 1);

    const journalDirectory = path.join(
      repository,
      '.git/workflow-engine/maintainer-checks',
    );
    const journals = fs
      .readdirSync(journalDirectory)
      .filter((entry) => entry.endsWith('.json'));
    assert.equal(journals.length, 1);
    const journal = JSON.parse(
      fs.readFileSync(path.join(journalDirectory, journals[0]!), 'utf8'),
    ) as { state: string; finalAttestation: unknown; checks: unknown[] };
    assert.equal(journal.state, 'completed');
    assert.equal(journal.checks.length, 2);
    assert.deepEqual(journal.finalAttestation, resumed);
  });
});

test('preapproval check resume never reuses evidence after candidate drift', () => {
  withTwoCheckCandidate((repository) => {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });

    assert.throws(
      () =>
        prepareMaintainerGrantV2Checks(repository, preflight, process.env, {
          testAfterCheckPersisted(checkId) {
            if (checkId === 'fixture') {
              throw new Error('interrupt before drift');
            }
          },
        }),
      /interrupt before drift/,
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 3;\n',
    );
    assert.throws(
      () => prepareMaintainerGrantV2Checks(repository, preflight),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_PREFLIGHT_STALE'),
    );

    const current = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    const result = prepareMaintainerGrantV2Checks(repository, current);
    assert.equal(result.patchDigest, current.patchDigest);
    assert.notEqual(result.patchDigest, preflight.patchDigest);
    assert.equal(checkRunCount(repository, 'check-one-count'), 2);
    assert.equal(checkRunCount(repository, 'check-two-count'), 1);
    assert.equal(
      fs
        .readdirSync(
          path.join(repository, '.git/workflow-engine/maintainer-checks'),
        )
        .filter((entry) => entry.endsWith('.json')).length,
      2,
    );
  });
});

test('preapproval check resume rejects tampered or unsafe journal files', () => {
  withTwoCheckCandidate((repository) => {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    assert.throws(
      () =>
        prepareMaintainerGrantV2Checks(repository, preflight, process.env, {
          testAfterCheckPersisted() {
            throw new Error('interrupt for journal tamper');
          },
        }),
      /interrupt for journal tamper/,
    );
    const journalDirectory = path.join(
      repository,
      '.git/workflow-engine/maintainer-checks',
    );
    const journalPath = path.join(
      journalDirectory,
      fs
        .readdirSync(journalDirectory)
        .find((entry) => entry.endsWith('.json'))!,
    );
    assert.equal(fs.lstatSync(journalPath).mode & 0o777, 0o600);
    const tampered = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      checks: Array<{ evidence: { runner: string } }>;
    };
    tampered.checks[0]!.evidence.runner = 'forged-runner';
    fs.writeFileSync(journalPath, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(
      () => prepareMaintainerGrantV2Checks(repository, preflight),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_JOURNAL_INVALID'),
    );
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(
      fs.existsSync(path.join(repository, '.git', 'check-two-count')),
      false,
    );

    const target = path.join(journalDirectory, 'attacker-controlled');
    fs.writeFileSync(target, fs.readFileSync(journalPath), { mode: 0o600 });
    fs.unlinkSync(journalPath);
    fs.symlinkSync(target, journalPath);
    assert.throws(
      () => prepareMaintainerGrantV2Checks(repository, preflight),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_JOURNAL_INVALID'),
    );
  });
});

function fixtureV2SshSigner(repository: string): MaintainerSignerProvider {
  const policy = parseMaintainerPolicy(
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/maintainer-policy.json'),
        'utf8',
      ),
    ),
  );
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  const privateKey = path.join(repository, '.git/workflow-test-signing-key');
  return {
    assertHumanPresent() {},
    identity: () => trusted.identity,
    sign(payload, namespace) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'workflow-v2-receipt-sign-'),
      );
      const payloadPath = path.join(directory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const result = spawnSync(
          '/usr/bin/ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            privateKey,
            '-n',
            namespace ?? policy.signatureNamespace,
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verify() {},
  };
}

function annotatedTagBody(repository: string, ref: string): string {
  const raw = git(repository, ['cat-file', 'tag', ref]);
  const separator = raw.indexOf('\n\n');
  assert.notEqual(separator, -1);
  return raw.slice(separator + 2);
}

function writeAnnotatedTag(
  repository: string,
  ref: string,
  target: string,
  body: string,
): void {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-v2-receipt-tag-'),
  );
  const messagePath = path.join(directory, 'message');
  try {
    fs.writeFileSync(messagePath, body, { mode: 0o600 });
    git(repository, [
      'tag',
      '--force',
      '--annotate',
      '--cleanup=verbatim',
      '--file',
      messagePath,
      ref.slice('refs/tags/'.length),
      target,
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fakeSigner(
  signed: string[],
  beforeSign: () => void = () => {},
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      beforeSign();
      assert.equal(
        [
          'expense-app.workflow.maintainer-grant.v2',
          'expense-app.workflow.authority-application-receipt.v1',
          'HARNESS_TASK_MANDATE_V2',
        ].includes(namespace ?? ''),
        true,
      );
      signed.push(payload);
      return FAKE_SIGNATURE;
    },
    verify(payload, _signature, identity, namespace) {
      if (namespace !== 'HARNESS_TASK_MANDATE_V2') {
        assert.equal(signed.includes(payload), true);
      }
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(
        [
          'expense-app.workflow.maintainer-grant.v2',
          'expense-app.workflow.authority-application-receipt.v1',
          'HARNESS_TASK_MANDATE_V2',
        ].includes(namespace ?? ''),
        true,
      );
    },
  };
}

function verifyingReissueSigner(
  priorVerifier: MaintainerSignerProvider,
  signed: string[],
): MaintainerSignerProvider {
  const current = fakeSigner(signed);
  return {
    ...current,
    verify(payload, signature, identity, namespace) {
      try {
        current.verify(payload, signature, identity, namespace);
      } catch {
        priorVerifier.verify(payload, signature, identity, namespace);
      }
    },
  };
}

function freezeIssuableCandidate(
  repository: string,
  signed: string[],
): MaintainerGrantV2Payload {
  assert.throws(
    () =>
      approveAndApplyMaintainerGrantV2(
        repository,
        {
          changeId: 'demo-change',
          taskId: TASK_ID,
          externalEffects: [],
          profileId: PROFILE_ID,
          reason: 'Freeze an exact candidate for deterministic issue admission',
          message: 'Apply frozen workflow candidate',
        },
        {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer: fakeSigner(signed),
          commitCrashAfter: 'commit-created',
        },
      ),
    (error) =>
      error instanceof Error && error.name === 'SimulatedAuthorityCrash',
  );
  const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
  assert.ok(payload.candidateBundle);
  assert.ok(payload.checksAttestation);
  const inspection = inspectMaintainerGrants(
    fs.realpathSync(path.join(repository, '.git')),
    payload.grantId,
  )[0];
  assert.ok(inspection?.reservationSessionId);
  abortAuthoritySession(
    repository,
    inspection.reservationSessionId,
    'Retain the frozen candidate for issue admission tests',
    new Date('2026-08-03T09:00:01.000Z'),
  );
  git(repository, ['reset', '--mixed', 'HEAD']);
  return payload;
}

test('repository publishes the trust-base capability profile used by v2', () => {
  const raw = fs.readFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-profiles.json'),
    'utf8',
  );
  const value = JSON.parse(raw) as {
    schemaVersion: number;
    profiles: Record<
      string,
      {
        requiredChecks: string[];
        authorityClass: string;
        checkDependencies: Record<string, string[]>;
        forbiddenPaths: string[];
      }
    >;
  };
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profiles[PROFILE_ID]?.authorityClass, 'ordinary');
  assert.equal(
    value.profiles[ROOT_PROFILE_ID]?.authorityClass,
    'root-one-shot',
  );
  assert.deepEqual(value.profiles[PROFILE_ID]?.requiredChecks, [
    'managed-documents',
    'workflow-format',
    'workflow-lint',
    'workflow-tests',
    'workflow-typecheck',
  ]);
  assert.deepEqual(
    value.profiles[PROFILE_ID]?.checkDependencies['workflow-typecheck'],
    ['runner', 'source-tree'],
  );
  assert.equal(
    value.profiles[PROFILE_ID]?.forbiddenPaths.includes(
      'packages/workflow-engine/src/maintainer-approve.ts',
    ),
    true,
  );
  assert.equal(
    value.profiles[PROFILE_ID]?.forbiddenPaths.includes(
      'packages/workflow-engine/src/task-mandate.ts',
    ),
    true,
  );
});

test('repository publishes a protected capability dependency closure', () => {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/protected-capabilities.json'),
      'utf8',
    ),
  ) as {
    kind: unknown;
    schemaVersion: unknown;
    entries: Array<{
      entrypoints: string[];
      dependencies: string[];
    }>;
  };
  assert.equal(value.kind, 'protected-capability-manifest.v1');
  assert.equal(value.schemaVersion, 1);
  const protectedPaths = value.entries.flatMap(
    ({ entrypoints, dependencies }) => [...entrypoints, ...dependencies],
  );
  assert.equal(
    protectedPaths.includes(
      'packages/workflow-engine/src/execution-governance.ts',
    ),
    true,
  );
  assert.equal(
    protectedPaths.includes(
      'packages/workflow-engine/src/maintainer-candidate.ts',
    ),
    true,
  );
});

test('v2 preflight is read-only and derives exact overlay and checks from the trust base', () => {
  const repository = prepareCandidate();
  try {
    const before = git(repository, ['status', '--porcelain=v1', '-z']);
    const result = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    const after = git(repository, ['status', '--porcelain=v1', '-z']);

    assert.equal(result.classification, 'ordinary');
    assert.equal(result.grantable, true);
    assert.equal(result.manifest.profile, PROFILE_ID);
    assert.equal(result.manifest.trustBaseCommit, result.trustBaseCommit);
    assert.deepEqual(result.evidenceOverlay, [
      {
        path: 'packages/workflow-engine/test/limits.test.ts',
        role: 'evidence',
      },
    ]);
    assert.deepEqual(result.requiredChecks, ['fixture']);
    assert.deepEqual(result.checkDependencies, {
      fixture: ['harness-engine', 'runner', 'source-tree'],
    });
    assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.patchDigest, result.manifest.patchDigest);
    assert.equal(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected dependency closure cannot pass as ordinary implementation', () => {
  const repository = prepareCandidate();
  try {
    git(repository, [
      'checkout',
      '--',
      'packages/workflow-engine/src/limits.ts',
      'packages/workflow-engine/test/limits.test.ts',
    ]);
    fs.writeFileSync(
      path.join(
        repository,
        'packages/workflow-engine/src/execution-governance.ts',
      ),
      'export const GRANT_LIMIT = 2;\n',
    );
    const result = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    assert.equal(
      result.manifest.files[0]?.role,
      'implementation',
      'the dependency closure, not a broad source role, must force escalation',
    );
    assert.equal(result.classification, 'control-plane');
    assert.equal(result.grantable, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('root one-shot profile remains exact-candidate bounded without policy mutation', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: ROOT_PROFILE_ID,
    });
    assert.equal(preflight.classification, 'root-one-shot');
    assert.equal(preflight.grantable, true);

    const result = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: ROOT_PROFILE_ID,
        reason: 'Root approves this exact nonpersistent candidate override',
        message: 'Apply root one-shot candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
      },
    );
    const payload = JSON.parse(signed[0]!) as {
      classification: string;
      candidateBundle: { classification: string };
    };
    assert.equal(payload.classification, 'root-one-shot');
    assert.equal(payload.candidateBundle.classification, 'root-one-shot');
    assert.equal(result.applied, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply requires an explicit empty effects declaration and rejects unverified effects before signing', () => {
  for (const declaration of ['missing', 'non-empty'] as const) {
    const repository = prepareCandidate();
    const signed: string[] = [];
    try {
      const request = {
        changeId: 'demo-change',
        taskId: TASK_ID,
        profileId: PROFILE_ID,
        reason:
          'Require exact external effect evidence before candidate signing',
        message: 'Reject undeclared candidate effects',
        ...(declaration === 'non-empty'
          ? {
              externalEffects: [
                {
                  effectType: 'publish-git-ref',
                  targetDigest: 'a'.repeat(64),
                  authorizationDigest: null,
                  resultDigest: null,
                },
              ],
            }
          : {}),
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(
          () =>
            approveAndApplyMaintainerGrantV2(repository, request as never, {
              now: new Date('2026-08-03T09:00:00.000Z'),
              signer: fakeSigner(signed),
            }),
          (error) =>
            isWorkflowError(
              error,
              declaration === 'missing'
                ? 'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED'
                : 'APPLY_CANDIDATE_EXTERNAL_EFFECT_UNSUPPORTED',
            ),
        );
      }
      assert.deepEqual(signed, []);
      const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer: fakeSigner(signed),
      });
      const errors = showAuthorityAuditTask(
        {
          externalAuditRoot: binding.externalAuditRoot,
          repositoryRoot: fs.realpathSync(repository),
          repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
        },
        TASK_ID,
      ).events.filter(
        ({ event }) =>
          event.eventType === 'error' &&
          event.command?.name === 'maintainer.approve-and-apply',
      );
      assert.equal(errors.length, 1);
      assert.equal(
        errors[0]?.event.errorCode,
        declaration === 'missing'
          ? 'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED'
          : 'APPLY_CANDIDATE_EXTERNAL_EFFECT_UNSUPPORTED',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('approve-and-apply preflight refusal is task-bound, durable, and retry-idempotent', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    git(repository, [
      'checkout',
      '--',
      'packages/workflow-engine/src/limits.ts',
      'packages/workflow-engine/test/limits.test.ts',
    ]);
    fs.writeFileSync(
      path.join(
        repository,
        'packages/workflow-engine/src/execution-governance.ts',
      ),
      'export const GRANT_LIMIT = 2;\n',
    );
    const request = {
      changeId: 'demo-change',
      taskId: TASK_ID,
      externalEffects: [],
      profileId: PROFILE_ID,
      reason: 'Reject a protected control-plane candidate before signing',
      message: 'Reject protected candidate',
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          approveAndApplyMaintainerGrantV2(repository, request, {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
          }),
        (error) =>
          isWorkflowError(error, 'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED'),
      );
    }
    assert.deepEqual(signed, []);
    const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
    });
    const errors = showAuthorityAuditTask(
      {
        externalAuditRoot: binding.externalAuditRoot,
        repositoryRoot: fs.realpathSync(repository),
        repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
      },
      TASK_ID,
    ).events.filter(
      ({ event }) =>
        event.eventType === 'error' &&
        event.command?.name === 'maintainer.approve-and-apply',
    );
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.event.errorCode,
      'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply refusal recovers a ledger-first crash with no grant or signature', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const request = {
    changeId: 'demo-change',
    taskId: TASK_ID,
    profileId: PROFILE_ID,
    reason: 'Reject a missing effects declaration before candidate signing',
    message: 'Reject undeclared effects',
  };
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request as never, {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testRefusalAuditServiceHooks: {
            testAfterLedgerAppend() {
              throw new Error('simulated-apply-refusal-audit-crash');
            },
          },
        }),
      /simulated-apply-refusal-audit-crash/,
    );
    const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
    });
    const scope = {
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
    };
    assert.equal(verifyAuthorityAuditEvents(scope).ok, false);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request as never, {
          now: new Date('2026-08-03T09:00:01.000Z'),
          signer,
        }),
      (error) =>
        isWorkflowError(error, 'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED'),
    );
    assert.equal(verifyAuthorityAuditEvents(scope).ok, true);
    assert.equal(
      showAuthorityAuditTask(scope, TASK_ID).events.filter(
        ({ event }) =>
          event.eventType === 'error' &&
          event.command?.name === 'maintainer.approve-and-apply',
      ).length,
      1,
    );
    assert.deepEqual(signed, []);
    assert.equal(
      fs.existsSync(
        path.join(
          repository,
          '.git/workflow-engine/maintainer-grants/available',
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply binds the active task mandate and projects every authority event by task', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
    });
    const result = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Bind this exact apply transaction to its active task mandate',
        message: 'Apply task-bound workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
      },
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.equal(payload.taskId, TASK_ID);
    assert.deepEqual(payload.mandateBinding, binding);
    assert.deepEqual(payload.candidateBundle?.mandateBinding, binding);
    assert.equal(
      payload.effectsManifestDigest,
      payload.candidateBundle?.effectsManifestDigest,
    );

    const scope = {
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    const byTask = showAuthorityAuditTask(scope, TASK_ID);
    assert.equal(byTask.ok, true);
    assert.deepEqual(
      byTask.events.map(({ event }) => event.eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'poststate',
        'grant-consume',
      ],
    );
    assert.equal(
      byTask.events.every(
        ({ event }) =>
          event.taskId === TASK_ID && event.changeId === 'demo-change',
      ),
      true,
    );
    assert.equal(result.applied, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply rejects cross-change and revoked Task Mandates before signing', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'different-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Reject a Task Mandate that belongs to another change',
            message: 'Reject cross-change candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_TASK_MANDATE_CHANGE_MISMATCH'),
    );
    revokeTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:01.000Z'),
      reason: 'Stop all preparation and exact apply authority for this task',
      signer,
    });
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Reject an apply after its Task Mandate was revoked',
            message: 'Reject revoked task candidate',
          },
          {
            now: new Date('2026-08-03T09:00:02.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate and supporting artifacts cannot be reused under another audit root', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const original = prepared.candidateBundle!;
    const { candidateBundleDigest: _digest, ...candidateInput } = original;
    const rebound = buildImmutableCandidateBundle({
      ...candidateInput,
      mandateBinding: {
        ...original.mandateBinding,
        externalAuditRoot: `${original.mandateBinding.externalAuditRoot}-other`,
      },
    });
    storeImmutableCandidateBundle(
      fs.realpathSync(path.join(repository, '.git')),
      rebound,
    );
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject cross-root reuse of retained candidate evidence',
            manifest: prepared.manifest,
            checksAttestation: prepared.checksAttestation!,
            candidateBundle: rebound,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: GRANT_ID,
            signer: fakeSigner(signed),
          },
        ),
      (error) =>
        isWorkflowError(error, 'APPLY_CANDIDATE_ARTIFACT_BINDING_INVALID'),
    );
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate audit failure exposes no Apply Grant or available capability', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
    now: new Date('2026-08-03T09:00:00.000Z'),
    signer,
  });
  const records = authorityAuditLedgerPaths({
    externalAuditRoot: binding.externalAuditRoot,
    repositoryRoot: fs.realpathSync(repository),
    repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
  }).records;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason:
              'Fail closed when the external candidate audit is unavailable',
            message: 'Reject unaudited workflow candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testBeforeCandidateCommitSigning: () => {
              fs.chmodSync(records, 0o500);
            },
          },
        ),
      (error) => error instanceof Error,
    );
    assert.deepEqual(signed, []);
    assert.equal(
      fs.existsSync(
        path.join(
          repository,
          '.git/workflow-engine/maintainer-grants/available',
        ),
      ),
      false,
    );
  } finally {
    fs.chmodSync(records, 0o700);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue signs every binding and stores a canonical one-shot grant', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const result = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer: fakeSigner(signed),
      },
    );

    assert.equal(result.envelope.payload.version, 2);
    assert.equal(result.envelope.payload.profile, PROFILE_ID);
    assert.equal(
      result.envelope.payload.patchDigest,
      prepared.manifest.patchDigest,
    );
    assert.equal(
      result.envelope.payload.manifestDigest,
      prepared.manifestDigest,
    );
    assert.deepEqual(
      result.envelope.payload.allowedPaths,
      prepared.manifest.files.map((file) => file.path),
    );
    assert.deepEqual(
      result.envelope.payload.evidenceOverlay,
      prepared.evidenceOverlay,
    );
    assert.deepEqual(result.envelope.payload.requiredChecks, ['fixture']);
    assert.equal(result.envelope.payload.maxUses, 1);
    assert.equal(
      signed[0],
      canonicalMaintainerGrantV2Payload(result.envelope.payload),
    );

    const canonical = canonicalMaintainerGrantV2Envelope(result.envelope);
    assert.deepEqual(
      parseMaintainerGrantV2Envelope(canonical),
      result.envelope,
    );
    assert.equal(fs.readFileSync(result.availableTokenPath, 'utf8'), canonical);
    assert.equal(
      git(repository, ['rev-parse', '--verify', result.tagRef]).trim().length,
      40,
    );

    const tampered = JSON.parse(canonical) as MaintainerGrantV2Envelope;
    tampered.payload.patchDigest = 'f'.repeat(64);
    assert.throws(
      () => parseMaintainerGrantV2Envelope(`${JSON.stringify(tampered)}\n`),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 revoke is human-trusted, audit-first, task-bound, and replay-safe', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const issued = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Issue an unused exact candidate for audited revocation',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const reason = 'Withdraw this unused exact apply authority before use';
    assert.throws(
      () =>
        revokeMaintainerGrantV2(
          repository,
          { grantId: issued.grantId, reason },
          {
            now: new Date('2026-08-03T09:02:00.000Z'),
            signer,
            testAfterAudit: () => {
              throw new Error('simulated crash after durable revoke audit');
            },
          },
        ),
      /simulated crash/,
    );
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, issued.grantId)[0]?.state,
      'available',
    );

    const revoked = revokeMaintainerGrantV2(
      repository,
      { grantId: issued.grantId, reason },
      {
        now: new Date('2026-08-03T09:02:30.000Z'),
        signer,
      },
    );
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.replayed, false);
    assert.equal(revoked.taskId, TASK_ID);
    const replay = revokeMaintainerGrantV2(
      repository,
      { grantId: issued.grantId, reason },
      {
        now: new Date('2026-08-03T09:03:00.000Z'),
        signer,
      },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.audit.eventDigest, revoked.audit.eventDigest);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          revokeMaintainerGrantV2(
            repository,
            {
              grantId: issued.grantId,
              reason: 'Conflicting revocation reason must not rewrite history',
            },
            {
              now: new Date('2026-08-03T09:03:30.000Z'),
              signer,
            },
          ),
        (error) =>
          isWorkflowError(error, 'MAINTAINER_GRANT_REVOCATION_STATE_INVALID'),
      );
    }

    const binding = prepared.mandateBinding;
    const events = showAuthorityAuditTask(
      {
        externalAuditRoot: binding.externalAuditRoot,
        repositoryRoot: fs.realpathSync(repository),
        repositoryId: deriveAuthorityAuditRepositoryId(prepared.repositoryId),
      },
      TASK_ID,
    ).events.map(({ event }) => event);
    const revoke = events.findLast((event) => event.eventType === 'revoke');
    assert.equal(revoke?.result, 'revoked');
    assert.equal(revoke?.taskId, TASK_ID);
    assert.equal(revoke?.changeId, 'demo-change');
    const refusal = events.filter(
      (event) =>
        event.eventType === 'error' &&
        event.command?.name === 'maintainer.grant-v2.revoke',
    );
    assert.equal(refusal.length, 1);
    assert.equal(
      refusal[0]?.errorCode,
      'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects a candidate-less request before touching the signer', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return FAKE_SIGNATURE;
    },
    verify() {
      signerTouched = true;
    },
  };
  try {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject candidate-less ordinary v2 grant issuance',
            manifest: preflight.manifest,
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            grantId: GRANT_ID,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_REQUIRED'),
    );
    assert.equal(signerTouched, false);
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects a frozen candidate without its exact checks before touching the signer', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return FAKE_SIGNATURE;
    },
    verify() {
      signerTouched = true;
    },
  };
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject a candidate without its exact checks attestation',
            manifest: prepared.manifest,
            candidateBundle: prepared.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: GRANT_ID,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_REQUIRED'),
    );
    assert.equal(signerTouched, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects checks that are not the candidate exact attestation before touching the signer', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return FAKE_SIGNATURE;
    },
    verify() {
      signerTouched = true;
    },
  };
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const mismatchedChecks = structuredClone(prepared.checksAttestation!);
    mismatchedChecks.checks[0]!.evidence.runnerDigest = 'f'.repeat(64);
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject checks that differ from the frozen candidate',
            manifest: prepared.manifest,
            checksAttestation: mismatchedChecks,
            candidateBundle: prepared.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: GRANT_ID,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(signerTouched, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('persisted candidate-less v2 fails closed in parsing and authority start', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  let signerTouched = false;
  const candidateLessGrantId = '66666666-6666-4666-8666-666666666666';
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const candidateLessEnvelope: MaintainerGrantV2Envelope = {
      payload: {
        ...structuredClone(prepared),
        grantId: candidateLessGrantId,
        candidateBundle: null,
        candidateBundleDigest: null,
      },
      signature: FAKE_SIGNATURE,
    };
    const canonical = canonicalMaintainerGrantV2Envelope(candidateLessEnvelope);
    assert.throws(
      () => parseMaintainerGrantV2Envelope(canonical),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );

    const availablePath = path.join(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine/maintainer-grants/available',
      `${candidateLessGrantId}.json`,
    );
    fs.writeFileSync(availablePath, canonical, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const signer: MaintainerSignerProvider = {
      assertHumanPresent() {
        signerTouched = true;
      },
      identity() {
        signerTouched = true;
        return 'fixture-maintainer';
      },
      sign() {
        signerTouched = true;
        return FAKE_SIGNATURE;
      },
      verify() {
        signerTouched = true;
      },
    };
    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', candidateLessGrantId, {
          now: new Date('2026-08-03T09:01:00.000Z'),
          signer,
          allowSignedV2Candidate: true,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(signerTouched, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority start rejects a candidate whose frozen supporting artifacts were deleted', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Bind admission to every frozen candidate supporting object',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    fs.unlinkSync(
      path.join(
        fs.realpathSync(path.join(repository, '.git')),
        'workflow-engine/candidate-artifacts',
        `${prepared.candidateBundle!.effectsManifestDigest}.json`,
      ),
    );

    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', grant.grantId, {
          now: new Date('2026-08-03T09:02:00.000Z'),
          signer,
          allowSignedV2Candidate: true,
        }),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_STORE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects candidate drift after preflight before requesting a signature', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 3;\n',
    );
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Apply the exact workflow-engine candidate',
            manifest: prepared.manifest,
            checksAttestation: prepared.checksAttestation!,
            candidateBundle: prepared.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            grantId: GRANT_ID,
            signer: fakeSigner(signed),
          },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 admission verifies signature before evaluating expiry', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  let verified = false;
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Bind validation order to signature before time admission',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
        ttlMinutes: 1,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer: fakeSigner(signed),
      },
    );
    const policy = parseMaintainerPolicy(
      JSON.parse(
        fs.readFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          'utf8',
        ),
      ),
    );
    const rejectingSigner: MaintainerSignerProvider = {
      assertHumanPresent() {},
      identity: () => 'fixture-maintainer',
      sign: () => {
        throw new Error('not used');
      },
      verify: () => {
        verified = true;
        throw new Error('invalid signature');
      },
    };
    assert.throws(
      () =>
        validateMaintainerGrantV2AuthorityBinding(
          repository,
          grant.envelope,
          policy,
          {
            now: new Date('2026-08-03T09:02:00.000Z'),
            expectedBase: grant.envelope.payload.baseCommit,
            expectedPolicyBlob: git(repository, [
              'rev-parse',
              `${grant.envelope.payload.baseCommit}:workflow/maintainer-policy.json`,
            ]).trim(),
            signer: rejectingSigner,
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_SIGNATURE_INVALID'),
    );
    assert.equal(verified, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 preflight CLI exposes the manifest without signing or writing grant state', () => {
  const repository = prepareCandidate();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'preflight',
        '--profile',
        PROFILE_ID,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      action: string;
      result: { grantable: boolean; manifest: { profile: string } };
    };
    assert.equal(output.ok, true);
    assert.equal(output.action, 'grant-preflight');
    assert.equal(output.result.grantable, true);
    assert.equal(output.result.manifest.profile, PROFILE_ID);
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/maintainer-grants'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CLI disables manual v2 issue and new v1 signing paths', () => {
  const repository = prepareCandidate();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  try {
    const manualV2 = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'issue',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(manualV2.status, 10);
    assert.equal(
      (JSON.parse(manualV2.stderr) as { error: { code: string } }).error.code,
      'MAINTAINER_V2_MANUAL_ISSUE_DISABLED',
    );

    const legacyV1 = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        '--change',
        'demo-change',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(legacyV1.status, 10);
    assert.equal(
      (JSON.parse(legacyV1.stderr) as { error: { code: string } }).error.code,
      'LEGACY_GRANT_V1_NEW_SIGNING_DISABLED',
    );

    const missingTaskBinding = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'approve-and-apply',
        '--change',
        'demo-change',
        '--profile',
        PROFILE_ID,
        '--reason',
        'Require a dedicated external authority audit root',
        '--message',
        'Apply exact workflow candidate',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(missingTaskBinding.status, 2);
    assert.equal(
      (
        JSON.parse(missingTaskBinding.stderr) as {
          error: { code: string; message: string };
        }
      ).error.code,
      'INVALID_USAGE',
    );
    assert.match(missingTaskBinding.stderr, /--task/);

    const missingEffectsDeclaration = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'approve-and-apply',
        '--change',
        'demo-change',
        '--task',
        TASK_ID,
        '--profile',
        PROFILE_ID,
        '--reason',
        'Require an explicit candidate external-effects declaration',
        '--message',
        'Apply exact workflow candidate',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(missingEffectsDeclaration.status, 2);
    assert.equal(
      (
        JSON.parse(missingEffectsDeclaration.stderr) as {
          error: { code: string; message: string };
        }
      ).error.code,
      'INVALID_USAGE',
    );
    assert.match(missingEffectsDeclaration.stderr, /--effects-file/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority session admits only a frozen candidate-backed v2 patch', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    assert.equal(session.grantVersion, 2);
    assert.deepEqual(session.allowedPaths, [
      'packages/workflow-engine/src/limits.ts',
      'packages/workflow-engine/test/limits.test.ts',
    ]);
    assert.deepEqual(session.requiredChecks, ['fixture']);

    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 2;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 2;\n',
    );
    const checked = checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-08-03T09:02:00.000Z'),
      signer,
    });
    assert.equal(checked.passed, true);
    assert.deepEqual(checked.changedPaths, session.allowedPaths);
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('direct v2 authority lifecycle refusals are verified-bound and retry-idempotent', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Exercise verified direct authority lifecycle refusals',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    git(repository, ['branch', '--move', 'work/wrong-branch']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          startAuthoritySession(repository, 'demo-change', grant.grantId, {
            now: new Date('2026-08-03T09:02:00.000Z'),
            signer,
            allowSignedV2Candidate: true,
          }),
        (error) =>
          isWorkflowError(error, 'AUTHORITY_CANDIDATE_BINDING_INVALID'),
      );
    }
    git(repository, ['branch', '--move', 'work/demo-change']);
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:03:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );

    const forcedCheckFailure = path.join(
      repository,
      '.git/v2-force-check-failure',
    );
    fs.writeFileSync(forcedCheckFailure, 'fail\n');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          checkAuthoritySession(repository, session.sessionId, {
            now: new Date('2026-08-03T09:04:00.000Z'),
            signer,
          }),
        (error) => isWorkflowError(error, 'CHECK_FAILED'),
      );
    }
    fs.unlinkSync(forcedCheckFailure);
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );
    checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-08-03T09:05:00.000Z'),
      signer,
    });

    git(repository, ['config', '--unset', 'gpg.format']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          commitAuthoritySession(
            repository,
            session.sessionId,
            'Apply exact workflow candidate',
            {
              now: new Date('2026-08-03T09:06:00.000Z'),
              signer,
            },
          ),
        (error) => isWorkflowError(error, 'AUTHORITY_GIT_SIGNING_REQUIRED'),
      );
    }
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );

    const scope = {
      externalAuditRoot: prepared.mandateBinding.externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(prepared.repositoryId),
    };
    const errors = showAuthorityAuditTask(scope, TASK_ID)
      .events.map(({ event }) => event)
      .filter((event) => event.eventType === 'error');
    assert.deepEqual(
      errors.map((event) => [event.command?.name, event.errorCode]),
      [
        ['authority.start', 'AUTHORITY_CANDIDATE_BINDING_INVALID'],
        ['authority.check', 'CHECK_FAILED'],
        ['authority.commit', 'AUTHORITY_GIT_SIGNING_REQUIRED'],
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expired v2 admission terminalizes the grant and releases its reservation', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
        ttlMinutes: 1,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', grant.grantId, {
          now: new Date('2026-08-03T09:02:00.000Z'),
          signer,
          allowSignedV2Candidate: true,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(
      inspectMaintainerGrants(
        fs.realpathSync(path.join(repository, '.git')),
        grant.grantId,
      )[0]?.state,
      'expired',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority check rejects same paths with bytes different from the v2 manifest', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 999;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 2;\n',
    );

    assert.throws(
      () =>
        checkAuthoritySession(repository, session.sessionId, {
          now: new Date('2026-08-03T09:02:00.000Z'),
          signer,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'failed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('base drift terminally invalidates a reserved v2 grant', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signer = fakeSigner([]);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply only on the exact signed branch generation',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 2;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 2;\n',
    );
    checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-08-03T09:02:00.000Z'),
      signer,
    });
    git(repository, ['commit', '--allow-empty', '-m', 'Move protected base']);

    assert.throws(
      () =>
        commitAuthoritySession(
          repository,
          session.sessionId,
          'Apply exact workflow candidate',
          {
            now: new Date('2026-08-03T09:03:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_BASE_DRIFT'),
    );
    assert.equal(
      inspectMaintainerGrants(
        fs.realpathSync(path.join(repository, '.git')),
        grant.grantId,
      )[0]?.state,
      'invalidated',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply checks before signing and atomically consumes the exact grant', () => {
  const repository = prepareCandidate();
  const marker = path.join(repository, '.git/v2-check-passed');
  const signed: string[] = [];
  let candidateSigningObserved = false;
  let humanPresenceChecks = 0;
  const baseSigner = fakeSigner(signed, () => {
    assert.equal(fs.readFileSync(marker, 'utf8'), 'passed');
  });
  const signer: MaintainerSignerProvider = {
    ...baseSigner,
    assertHumanPresent() {
      humanPresenceChecks += 1;
    },
  };
  try {
    const result = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Approve and apply the exact checked candidate',
        message: 'Apply exact workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
        testBeforeCandidateCommitSigning: () => {
          assert.equal(fs.readFileSync(marker, 'utf8'), 'passed');
          candidateSigningObserved = true;
        },
      },
    );

    assert.equal(candidateSigningObserved, true);
    assert.equal(humanPresenceChecks, 1);
    assert.equal(result.applied, true);
    assert.equal(result.commitHash, result.candidateCommit);
    assert.match(result.candidateBundleDigest, /^[0-9a-f]{64}$/);
    assert.equal(
      readStoredImmutableCandidateBundle(
        fs.realpathSync(path.join(repository, '.git')),
        result.candidateBundleDigest,
      ).candidateCommit,
      result.candidateCommit,
    );
    assert.equal(
      git(repository, [
        'show',
        '-s',
        '--format=%T',
        result.candidateCommit,
      ]).trim(),
      result.resultTree,
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      result.commitHash,
    );
    assert.equal(
      fs.readFileSync(
        path.join(repository, 'packages/workflow-engine/src/limits.ts'),
        'utf8',
      ),
      'export const LIMIT = 2;\n',
    );
    assert.match(result.checksAttestationDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal(signed.length, 2);
    assert.equal(
      (JSON.parse(signed[1]!) as { kind?: string }).kind,
      'authority-application-receipt.v1',
    );
    assert.equal(
      result.applicationReceiptTagRef,
      `refs/tags/workflow-grant/application-${result.grantId}`,
    );
    assert.equal(
      (
        JSON.parse(signed[0]!) as {
          candidateBundleDigest: string | null;
        }
      ).candidateBundleDigest,
      result.candidateBundleDigest,
    );
    assert.equal(git(repository, ['status', '--porcelain=v1']), '');
    assert.equal(
      inspectMaintainerGrants(
        fs.realpathSync(path.join(repository, '.git')),
        result.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.deepEqual(
      readDurableRefGenerationLedger(
        fs.realpathSync(path.join(repository, '.git')),
        'refs/heads/work/demo-change',
        true,
      ),
      {
        schemaVersion: 1,
        ref: 'refs/heads/work/demo-change',
        currentOid: result.commitHash,
        generation: 1,
        transitions: [
          {
            fromOid: git(repository, [
              'rev-parse',
              `${result.commitHash}^`,
            ]).trim(),
            toOid: result.commitHash,
            fromGeneration: 0,
            toGeneration: 1,
            reason: 'apply',
            at: '2026-08-03T09:00:00.000Z',
          },
        ],
      },
    );
    assert.equal(
      git(repository, ['rev-parse', '--verify', result.tagRef]).trim().length,
      40,
    );
    assert.equal('publishCommand' in result, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply terminalizes expiry between admission and ref CAS', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let clock = new Date('2026-08-03T09:00:00.000Z');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Exercise the exact pre-CAS grant expiry boundary',
            message: 'Apply expiring workflow candidate',
          },
          {
            now: clock,
            signer,
            commitClock: () => clock,
            testBeforeRefUpdate: () => {
              clock = new Date('2026-08-10T09:00:00.001Z');
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(signed.length, 1);
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      candidateBundleDigest: string;
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const inspection = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(inspection?.state, 'expired');
    assert.equal(
      fs.existsSync(
        path.join(
          gitCommonDirectory,
          'workflow-engine/maintainer-grants/reserved',
          `${payload.grantId}.json`,
        ),
      ),
      false,
    );
    const terminal = JSON.parse(
      fs.readFileSync(
        path.join(
          gitCommonDirectory,
          'workflow-engine/maintainer-grants/terminal',
          `${payload.grantId}.json`,
        ),
        'utf8',
      ),
    ) as { envelope: { payload: { candidateBundleDigest: string } } };
    assert.equal(
      terminal.envelope.payload.candidateBundleDigest,
      payload.candidateBundleDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a fresh G2 applies the exact retained candidate after G1 expires before CAS', () => {
  const repository = prepareCandidate();
  const firstSigned: string[] = [];
  const secondSigned: string[] = [];
  const firstSigner = fakeSigner(firstSigned);
  const secondSigner = verifyingReissueSigner(firstSigner, secondSigned);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const auditRoot = externalAuditRoot(repository);
  let clock = new Date('2026-08-03T09:00:00.000Z');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Expire G1 while retaining its exact immutable candidate',
            message: 'Apply retained workflow candidate',
            ttlMinutes: 1,
          },
          {
            now: clock,
            signer: firstSigner,
            commitClock: () => clock,
            testBeforeRefUpdate: () => {
              clock = new Date('2026-08-03T09:01:00.001Z');
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);

    const firstPayload = JSON.parse(
      firstSigned[0]!,
    ) as MaintainerGrantV2Payload;
    assert.ok(firstPayload.candidateBundle);
    assert.ok(firstPayload.checksAttestation);
    const candidate = firstPayload.candidateBundle;
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, firstPayload.grantId)[0]
        ?.state,
      'expired',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          gitCommonDirectory,
          'workflow-engine/maintainer-grants/reserved',
          `${firstPayload.grantId}.json`,
        ),
      ),
      false,
    );

    const candidateStorePath = path.join(
      gitCommonDirectory,
      'workflow-engine/candidates',
      `${candidate.candidateBundleDigest}.json`,
    );
    const originalCandidateBytes = fs.readFileSync(candidateStorePath, 'utf8');
    const originalCompletedAt = candidate.checksAttestation.checks.map(
      ({ completedAt }) => completedAt,
    );
    const checkMarker = path.join(repository, '.git/v2-check-passed');
    fs.writeFileSync(checkMarker, 'sentinel-after-g1');

    const reapplied = reissueAndApplyMaintainerGrantV2(
      repository,
      {
        priorGrantId: firstPayload.grantId,
        reason: 'Re-sign the still-fresh exact candidate after G1 expiry',
      },
      {
        now: new Date('2026-08-03T09:01:01.000Z'),
        grantId: '44444444-4444-4444-8444-444444444444',
        signer: secondSigner,
      },
    );
    const secondPayload = JSON.parse(
      secondSigned[0]!,
    ) as MaintainerGrantV2Payload;
    assert.notEqual(reapplied.grantId, firstPayload.grantId);
    assert.equal(reapplied.reissuedFromGrantId, firstPayload.grantId);
    assert.equal(
      secondPayload.candidateBundleDigest,
      firstPayload.candidateBundleDigest,
    );
    assert.deepEqual(secondPayload.mandateBinding, firstPayload.mandateBinding);
    assert.deepEqual(
      secondPayload.candidateBundle?.mandateBinding,
      firstPayload.mandateBinding,
    );
    assert.equal(
      secondPayload.candidateBundle?.candidateCommit,
      candidate.candidateCommit,
    );

    assert.equal(reapplied.commitHash, candidate.candidateCommit);
    assert.equal(reapplied.grantId, secondPayload.grantId);
    assert.equal(reapplied.journalState, 'audited');
    assert.equal(fs.readFileSync(checkMarker, 'utf8'), 'sentinel-after-g1');
    assert.equal(
      fs.readFileSync(candidateStorePath, 'utf8'),
      originalCandidateBytes,
    );
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(candidateStorePath))
        .filter((entry) => entry.endsWith('.json')),
      [`${candidate.candidateBundleDigest}.json`],
    );
    assert.deepEqual(
      readStoredImmutableCandidateBundle(
        gitCommonDirectory,
        candidate.candidateBundleDigest,
      ).checksAttestation.checks.map(({ completedAt }) => completedAt),
      originalCompletedAt,
    );
    assert.match(
      git(repository, ['show', '-s', '--format=%B', reapplied.commitHash]),
      /Transition: authority-candidate/,
    );
    assert.doesNotMatch(
      git(repository, ['show', '-s', '--format=%B', reapplied.commitHash]),
      new RegExp(`${firstPayload.grantId}|${reapplied.grantId}`),
    );

    const committedSession = readAuthoritySession(
      repository,
      reapplied.sessionId,
    );
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(firstPayload.repositoryId),
    };
    const auditRecords = scanAuthorityAuditLedger(scope).records.map(
      ({ record }) => record,
    );
    const auditVerification = verifyAuthorityAuditEvents(scope);
    assert.equal(auditVerification.ok, true);
    assert.deepEqual(
      auditRecords.map(({ eventType }) => eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'error',
        'error',
        'apply-grant',
        'cas',
        'poststate',
        'grant-consume',
      ],
    );
    assert.deepEqual(
      auditVerification.events
        .map(({ event }) => event)
        .filter(({ eventType }) => eventType === 'error')
        .map(({ command, errorCode }) => [command?.name, errorCode]),
      [
        ['authority.commit', 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'],
        ['maintainer.approve-and-apply', 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'],
      ],
    );
    const transactionRecords = auditRecords.filter(({ eventType }) =>
      ['cas', 'poststate', 'grant-consume'].includes(eventType),
    );
    assert.deepEqual(
      transactionRecords.map(({ grantDigest }) => grantDigest),
      Array(3).fill(`sha256:${committedSession.grantDigest}`),
    );
    assert.deepEqual(
      transactionRecords.map(
        ({ candidateBundleDigest }) => candidateBundleDigest,
      ),
      Array(3).fill(`sha256:${committedSession.candidateBundleDigest}`),
    );
    assert.equal(
      transactionRecords.every(
        ({ prestateDigest, poststateDigest, resultDigest }) =>
          /^sha256:[0-9a-f]{64}$/.test(prestateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(poststateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(resultDigest),
      ),
      true,
    );
    assert.equal(
      auditRecords.every(
        (record) => Buffer.byteLength(JSON.stringify(record)) < 4_096,
      ),
      true,
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, reapplied.grantId)[0]?.state,
      'consumed',
    );
    assert.throws(
      () =>
        startAuthoritySession(
          repository,
          firstPayload.changeId,
          reapplied.grantId,
          {
            now: new Date('2026-08-03T09:01:04.000Z'),
            signer: secondSigner,
            allowSignedV2Candidate: true,
          },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_UNAVAILABLE'),
    );
    const replaySigned: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          reissueAndApplyMaintainerGrantV2(
            repository,
            {
              priorGrantId: firstPayload.grantId,
              reason: 'Reject a second apply of the retained candidate',
            },
            {
              now: new Date('2026-08-03T09:01:05.000Z'),
              grantId: '55555555-5555-4555-8555-555555555555',
              signer: verifyingReissueSigner(firstSigner, replaySigned),
            },
          ),
        (error) => isWorkflowError(error, 'MAINTAINER_PATCH_STALE_BASE'),
      );
    }
    assert.deepEqual(replaySigned, []);
    const refusal = showAuthorityAuditTask(scope, TASK_ID)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.eventType === 'error' &&
          event.command?.name === 'maintainer.reissue-and-apply',
      );
    assert.equal(refusal.length, 1);
    assert.equal(refusal[0]?.errorCode, 'MAINTAINER_PATCH_STALE_BASE');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reissue rejects a retained candidate after its Task Mandate is revoked', () => {
  const repository = prepareCandidate();
  const firstSigned: string[] = [];
  const secondSigned: string[] = [];
  const signer = fakeSigner(firstSigned);
  let clock = new Date('2026-08-03T09:00:00.000Z');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Retain an expired candidate for revoked mandate admission',
            message: 'Retain revoked mandate candidate',
            ttlMinutes: 1,
          },
          {
            now: clock,
            signer,
            commitClock: () => clock,
            testBeforeRefUpdate: () => {
              clock = new Date('2026-08-03T09:01:00.001Z');
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    const firstPayload = JSON.parse(
      firstSigned[0]!,
    ) as MaintainerGrantV2Payload;
    revokeTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T09:01:01.000Z'),
      reason: 'Revoke the task before any retained candidate can be reissued',
      signer,
    });
    assert.throws(
      () =>
        reissueAndApplyMaintainerGrantV2(
          repository,
          {
            priorGrantId: firstPayload.grantId,
            reason: 'Reject reissue after the retained mandate was revoked',
          },
          {
            now: new Date('2026-08-03T09:01:02.000Z'),
            grantId: '44444444-4444-4444-8444-444444444444',
            signer: verifyingReissueSigner(signer, secondSigned),
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(secondSigned, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('remote CI verifies an applied v2 candidate from portable Git authority receipts', () => {
  const repository = prepareCandidate();
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const cloneParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-v2-receipt-clone-'),
  );
  const clone = path.join(cloneParent, 'repository');
  try {
    const applied = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Publish a portable exact authority application receipt',
        message: 'Apply retained workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer: fixtureV2SshSigner(repository),
      },
    );
    const cloned = spawnSync(
      '/usr/bin/git',
      ['clone', '--no-local', repository, clone],
      { encoding: 'utf8' },
    );
    assert.equal(cloned.status, 0, cloned.stderr);
    git(clone, ['config', 'user.name', 'Fixture Maintainer']);
    git(clone, ['config', 'user.email', 'fixture-maintainer@example.test']);
    assert.match(
      git(repository, ['tag', '--list']),
      new RegExp(`workflow-grant/application-${applied.grantId}`),
    );
    assert.match(
      git(clone, ['tag', '--list']),
      new RegExp(`workflow-grant/application-${applied.grantId}`),
    );
    const head = git(clone, ['rev-parse', 'HEAD']).trim();
    assert.equal(head, applied.commitHash);
    const [commit] = listRangeCommits(clone, base, head);
    assert.ok(commit);
    assert.equal(commit.trailers?.kind, 'authority-candidate');

    const verified = validateCiAuthorityCommit(
      clone,
      commit,
      new Date('2026-08-10T09:00:00.000Z'),
    );
    assert.equal(verified.grantId, applied.grantId);
    assert.equal(verified.changeId, 'demo-change');
    assert.deepEqual(
      replayCommitSequence(clone, [commit], new Map(), [], []).authorityGrants,
      [applied.grantId],
    );
    assert.deepEqual(
      verifyBaseAuthorityAttestations(
        clone,
        head,
        new Date('2026-08-10T09:00:00.000Z'),
      ).directAuthorities,
      [
        {
          grantId: applied.grantId,
          changeId: 'demo-change',
          commit: applied.commitHash,
        },
      ],
    );

    const receiptRef = `refs/tags/workflow-grant/application-${applied.grantId}`;
    const originalReceiptTag = git(clone, [
      'rev-parse',
      `${receiptRef}^{tag}`,
    ]).trim();
    const originalReceiptBody = annotatedTagBody(clone, receiptRef);
    const originalReceipt =
      parseAuthorityApplicationReceiptEnvelope(originalReceiptBody);
    const storedCandidate = readStoredImmutableCandidateBundle(
      fs.realpathSync(path.join(repository, '.git')),
      applied.candidateBundleDigest,
    );
    assert.equal(
      originalReceipt.payload.effectsManifestDigest,
      storedCandidate.effectsManifestDigest,
    );
    const validateReceipt = () => validateCiAuthorityCommit(clone, commit);
    const restoreReceipt = () =>
      git(clone, ['update-ref', receiptRef, originalReceiptTag]);

    git(clone, ['update-ref', '-d', receiptRef, originalReceiptTag]);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REQUIRED'),
    );
    assert.throws(
      () => verifyBaseAuthorityAttestations(clone, head),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REQUIRED'),
    );
    restoreReceipt();

    const tamperedEnvelope: AuthorityApplicationReceiptEnvelope = {
      ...originalReceipt,
      payload: {
        ...originalReceipt.payload,
        grantEnvelopeDigest: `sha256:${'f'.repeat(64)}`,
      },
    };
    writeAnnotatedTag(
      clone,
      receiptRef,
      head,
      canonicalAuthorityApplicationReceiptEnvelope(tamperedEnvelope),
    );
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_TAMPERED'),
    );
    restoreReceipt();

    const replayRef = `${receiptRef}-replay`;
    writeAnnotatedTag(clone, replayRef, head, originalReceiptBody);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REPLAYED'),
    );
    git(clone, ['update-ref', '-d', replayRef]);

    const wrongRef = `${receiptRef}-wrong`;
    git(clone, ['update-ref', '-d', receiptRef]);
    writeAnnotatedTag(clone, wrongRef, head, originalReceiptBody);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REF_MISMATCH'),
    );
    git(clone, ['update-ref', '-d', wrongRef]);
    restoreReceipt();

    const wrongGenerationPayload = {
      ...originalReceipt.payload,
      oldRefGeneration: originalReceipt.payload.oldRefGeneration + 1,
      newRefGeneration: originalReceipt.payload.newRefGeneration + 1,
    };
    const receiptSigner = fixtureV2SshSigner(repository);
    const wrongEffectsPayload = {
      ...originalReceipt.payload,
      effectsManifestDigest: 'f'.repeat(64),
    };
    const wrongEffectsEnvelope: AuthorityApplicationReceiptEnvelope = {
      payload: wrongEffectsPayload,
      signature: receiptSigner.sign(
        canonicalAuthorityApplicationReceiptPayload(wrongEffectsPayload),
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      ),
    };
    writeAnnotatedTag(
      clone,
      receiptRef,
      head,
      canonicalAuthorityApplicationReceiptEnvelope(wrongEffectsEnvelope),
    );
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_TAMPERED'),
    );
    restoreReceipt();

    const wrongGenerationEnvelope: AuthorityApplicationReceiptEnvelope = {
      payload: wrongGenerationPayload,
      signature: receiptSigner.sign(
        canonicalAuthorityApplicationReceiptPayload(wrongGenerationPayload),
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      ),
    };
    writeAnnotatedTag(
      clone,
      receiptRef,
      head,
      canonicalAuthorityApplicationReceiptEnvelope(wrongGenerationEnvelope),
    );
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_GENERATION_MISMATCH'),
    );
    restoreReceipt();

    writeAnnotatedTag(clone, receiptRef, base, originalReceiptBody);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_COMMIT_MISMATCH'),
    );
    restoreReceipt();
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(cloneParent, { recursive: true, force: true });
  }
});

test('reissuing a stored candidate rejects stale evidence before signing', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  try {
    const applied = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Create a retained candidate with expiring evidence',
        message: 'Apply retained workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer: fakeSigner(signed),
      },
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    git(repository, [
      'update-ref',
      payload.candidateBundle!.targetRef,
      base,
      applied.commitHash,
    ]);
    git(repository, ['reset', '--mixed', base]);
    const secondSigned: string[] = [];

    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject an ABA transition before asking for a signature',
            manifest: payload.manifest,
            checksAttestation: payload.checksAttestation!,
            candidateBundle: payload.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: '44444444-4444-4444-8444-444444444444',
            signer: fakeSigner(secondSigned),
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_REF_GENERATION_MISMATCH'),
    );
    assert.deepEqual(secondSigned, []);

    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reissue only while original evidence remains fresh',
            manifest: payload.manifest,
            checksAttestation: payload.checksAttestation!,
            candidateBundle: payload.candidateBundle!,
          },
          {
            now: new Date('2026-08-10T09:00:00.000Z'),
            grantId: '55555555-5555-4555-8555-555555555555',
            signer: fakeSigner(secondSigned),
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
    );
    assert.deepEqual(secondSigned, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('poststate verification failure rolls back and advances ref generation', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Verify the prebuilt rollback transition after CAS',
            message: 'Apply rollback workflow candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testPoststateVerification: () => {
              throw new Error('simulated poststate mismatch');
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POSTSTATE_VERIFICATION_FAILED'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      repositoryId: string;
      candidateBundleDigest: string;
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const terminal = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(terminal?.state, 'failed');
    assert.ok(terminal?.reservationSessionId);
    const failedSession = readAuthoritySession(
      repository,
      terminal.reservationSessionId,
    );
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    const records = scanAuthorityAuditLedger(scope).records.map(
      ({ record }) => record,
    );
    const auditVerification = verifyAuthorityAuditEvents(scope);
    assert.equal(auditVerification.ok, true);
    assert.deepEqual(
      records.map(({ eventType }) => eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'error',
        'rollback',
        'error',
        'error',
      ],
    );
    assert.deepEqual(
      records.map(({ result }) => result),
      [
        'recorded',
        'recorded',
        'recorded',
        'succeeded',
        'failed',
        'rolled-back',
        'failed',
        'failed',
      ],
    );
    assert.deepEqual(
      auditVerification.events
        .map(({ event }) => event)
        .slice(-2)
        .map(({ command, errorCode }) => [command?.name, errorCode]),
      [
        ['authority.commit', 'AUTHORITY_POSTSTATE_VERIFICATION_FAILED'],
        [
          'maintainer.approve-and-apply',
          'AUTHORITY_POSTSTATE_VERIFICATION_FAILED',
        ],
      ],
    );
    const transactionRecords = records.slice(3, 6);
    assert.equal(
      transactionRecords.every(
        ({
          grantDigest,
          candidateBundleDigest,
          prestateDigest,
          poststateDigest,
          resultDigest,
        }) =>
          grantDigest === `sha256:${failedSession.grantDigest}` &&
          candidateBundleDigest === `sha256:${payload.candidateBundleDigest}` &&
          /^sha256:[0-9a-f]{64}$/.test(prestateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(poststateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(resultDigest),
      ),
      true,
    );
    assert.notEqual(
      transactionRecords[1]?.poststateDigest,
      transactionRecords[2]?.poststateDigest,
    );
    assert.equal(
      records.every(
        (record) => Buffer.byteLength(JSON.stringify(record)) < 4_096,
      ),
      true,
    );
    const ledger = readDurableRefGenerationLedger(
      gitCommonDirectory,
      'refs/heads/work/demo-change',
      true,
    );
    assert.equal(ledger.currentOid, base);
    assert.equal(ledger.generation, 2);
    assert.deepEqual(
      ledger.transitions.map(({ reason }) => reason),
      ['apply', 'rollback'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('poststate audit outage leaves the applied ref recovery-only and rollback resumes once', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let recordsDirectory: string | undefined;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Hold rollback until its external audit is writable',
            message: 'Apply audited rollback candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testPoststateVerification: () => {
              const payload = JSON.parse(
                signed[0]!,
              ) as MaintainerGrantV2Payload;
              const scope = {
                externalAuditRoot: auditRoot,
                repositoryRoot: fs.realpathSync(repository),
                repositoryId: deriveAuthorityAuditRepositoryId(
                  payload.repositoryId,
                ),
              };
              recordsDirectory = authorityAuditLedgerPaths(scope).records;
              fs.chmodSync(recordsDirectory, 0o500);
              throw new Error('simulated audited poststate failure');
            },
          },
        ),
      (error) => error instanceof Error,
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const pending = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(pending?.state, 'reserved');
    assert.ok(pending?.reservationSessionId);
    const pendingSessionId = pending.reservationSessionId;
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommonDirectory, pendingSessionId).state,
      'rollback-prepared',
    );

    assert.ok(recordsDirectory);
    fs.chmodSync(recordsDirectory, 0o700);
    recordsDirectory = undefined;
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          pendingSessionId,
          new Date('2026-08-03T09:01:00.000Z'),
          {},
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_ROLLED_BACK'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    const firstRecovery = scanAuthorityAuditLedger(scope);
    assert.deepEqual(
      firstRecovery.records.map(({ record }) => record.eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'error',
        'rollback',
      ],
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      2,
    );

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          pendingSessionId,
          new Date('2026-08-03T09:02:00.000Z'),
          {},
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_ROLLED_BACK'),
    );
    const secondRecovery = scanAuthorityAuditLedger(scope);
    assert.equal(secondRecovery.recordCount, firstRecovery.recordCount);
    assert.equal(
      secondRecovery.headRecordDigest,
      firstRecovery.headRecordDigest,
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      2,
    );
  } finally {
    if (recordsDirectory !== undefined) {
      fs.chmodSync(recordsDirectory, 0o700);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('external ref ABA during an uncertain CAS cannot replay the candidate', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason:
              'Exercise rollback replay protection after an uncertain CAS',
            message: 'Apply uncertain CAS candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-cas',
          },
        ),
      (error) =>
        error instanceof Error && error.name === 'SimulatedAuthorityCrash',
    );
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      baseCommit: string;
      candidateBundle: {
        candidateCommit: string;
        targetRef: string;
      };
    };
    git(repository, [
      'update-ref',
      payload.candidateBundle.targetRef,
      payload.baseCommit,
      payload.candidateBundle.candidateCommit,
    ]);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(reservation?.state, 'reserved');
    assert.ok(reservation?.reservationSessionId);

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          reservation.reservationSessionId!,
          new Date('2026-08-03T09:01:00.000Z'),
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_CAS_OUTCOME_AMBIGUOUS'),
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.baseCommit,
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'invalidated',
    );
    const ledger = readDurableRefGenerationLedger(
      gitCommonDirectory,
      payload.candidateBundle.targetRef,
      true,
    );
    assert.equal(ledger.currentOid, payload.baseCommit);
    assert.equal(ledger.generation, 1);
    assert.equal(ledger.transitions[0]?.reason, 'uncertain-cas');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expired grant cannot hide an uncertain CAS replay boundary', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Keep uncertain CAS recovery dominant after grant expiry',
            message: 'Apply expiring uncertain CAS candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-cas',
          },
        ),
      (error) =>
        error instanceof Error && error.name === 'SimulatedAuthorityCrash',
    );
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      baseCommit: string;
      candidateBundle: {
        candidateCommit: string;
        targetRef: string;
      };
    };
    git(repository, [
      'update-ref',
      payload.candidateBundle.targetRef,
      payload.baseCommit,
      payload.candidateBundle.candidateCommit,
    ]);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.ok(reservation?.reservationSessionId);

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          reservation.reservationSessionId!,
          new Date('2026-08-10T09:00:00.001Z'),
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_CAS_OUTCOME_AMBIGUOUS'),
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'invalidated',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('transient consume failure resumes completion without applying twice', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Resume completion after a transient consume write failure',
            message: 'Apply consume recovery candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testBeforeConsume: () => {
              throw new Error('simulated transient consume failure');
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED'),
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const pending = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(pending?.state, 'reserved');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.ok(pending?.reservationSessionId);
    const pendingJournal = readAuthorityCommitJournal(
      gitCommonDirectory,
      pending.reservationSessionId!,
    );
    assert.deepEqual(pendingJournal.mandateBinding, payload.mandateBinding);
    assert.equal(
      pendingJournal.externalAuditRoot,
      payload.mandateBinding.externalAuditRoot,
    );

    const recovered = recoverAuthorityCommit(
      repository,
      pending.reservationSessionId!,
      new Date('2026-08-03T09:01:00.000Z'),
      { receiptSigner: signer },
    );
    assert.equal(recovered.commitHash, payload.candidateBundle.candidateCommit);
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'consumed',
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      1,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current incomplete v2 recovery journal fails closed without moving the ref', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Crash after the exact candidate ref update',
            message: 'Apply journal corruption candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-updated',
          },
        ),
      SimulatedAuthorityCrash,
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(reservation?.state, 'reserved');
    assert.ok(reservation?.reservationSessionId);
    const sessionId = reservation.reservationSessionId;
    const journalPath = path.join(
      gitCommonDirectory,
      'workflow-engine/maintainer-grants/journals',
      `${sessionId}.json`,
    );
    const appliedHead = payload.candidateBundle.candidateCommit;
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), appliedHead);
    assert.equal(
      readAuthorityCommitJournal(gitCommonDirectory, sessionId).state,
      'ref-updated',
    );

    const incomplete = JSON.parse(
      fs.readFileSync(journalPath, 'utf8'),
    ) as Record<string, unknown>;
    delete incomplete.commitHash;
    fs.writeFileSync(journalPath, `${JSON.stringify(incomplete)}\n`, {
      mode: 0o600,
    });

    assert.throws(
      () => readAuthorityCommitJournal(gitCommonDirectory, sessionId),
      (error: unknown) => isWorkflowError(error, 'AUTHORITY_JOURNAL_INVALID'),
    );
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:01:00.000Z'),
          { receiptSigner: signer },
        ),
      (error: unknown) => isWorkflowError(error, 'AUTHORITY_JOURNAL_INVALID'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), appliedHead);
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'reserved',
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]
        ?.reservationSessionId,
      sessionId,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy unbound v2 recovery journal parses read-only but cannot resume authority', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Recover a durable legacy v2 journal after ref update',
            message: 'Apply migrated audit candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-updated',
          },
        ),
      SimulatedAuthorityCrash,
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(reservation?.state, 'reserved');
    assert.ok(reservation?.reservationSessionId);
    const journalPath = path.join(
      gitCommonDirectory,
      'workflow-engine/maintainer-grants/journals',
      `${reservation.reservationSessionId}.json`,
    );
    const legacy = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<
      string,
      unknown
    >;
    legacy.schemaVersion = 3;
    delete legacy.mandateBinding;
    fs.writeFileSync(journalPath, `${JSON.stringify(legacy)}\n`, {
      mode: 0o600,
    });

    const normalized = readAuthorityCommitJournal(
      gitCommonDirectory,
      reservation.reservationSessionId,
    );
    assert.equal(Number(normalized.schemaVersion), 4);
    assert.equal(normalized.mandateBinding, null);
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          reservation.reservationSessionId!,
          new Date('2026-08-03T09:01:00.000Z'),
          { receiptSigner: signer },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_JOURNAL_SESSION_MISMATCH'),
    );
    const scan = scanAuthorityAuditLedger({
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    });
    assert.deepEqual(
      scan.records.map(({ record }) => record.eventType),
      ['task-mandate', 'candidate-bundle', 'apply-grant'],
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      1,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 audit failure after consume remains recovery-only until both receipts are durable', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  let rejectConsumeAudit = true;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Require external audit completion after grant consumption',
            message: 'Apply externally audited candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testBeforeAudit: (eventType) => {
              if (eventType === 'grant-consume' && rejectConsumeAudit) {
                throw new Error('simulated external audit outage');
              }
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED'),
    );
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      repositoryId: string;
      candidateBundle: { candidateCommit: string; targetRef: string };
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const terminal = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(terminal?.state, 'consumed');
    assert.ok(terminal?.reservationSessionId);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(
      readAuthoritySession(repository, terminal.reservationSessionId!).state,
      'active',
    );
    assert.equal(
      readAuthorityCommitJournal(
        gitCommonDirectory,
        terminal.reservationSessionId!,
      ).state,
      'consumed',
    );
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    assert.deepEqual(
      scanAuthorityAuditLedger(scope).records.map(
        ({ record }) => record.eventType,
      ),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'poststate',
        'error',
        'error',
      ],
    );
    assert.deepEqual(
      verifyAuthorityAuditEvents(scope)
        .events.map(({ event }) => event)
        .slice(-2)
        .map(({ command, errorCode }) => [command?.name, errorCode]),
      [
        ['authority.commit', 'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED'],
        [
          'maintainer.approve-and-apply',
          'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        ],
      ],
    );

    rejectConsumeAudit = false;
    const recovered = recoverAuthorityCommit(
      repository,
      terminal.reservationSessionId!,
      new Date('2026-08-03T09:01:00.000Z'),
      { receiptSigner: signer },
    );
    assert.equal(recovered.journalState, 'audited');
    assert.equal(
      readAuthoritySession(repository, terminal.reservationSessionId!).state,
      'committed',
    );
    const receiptRef = `refs/tags/workflow-grant/application-${payload.grantId}`;
    const receiptTagObject = git(repository, [
      'rev-parse',
      `${receiptRef}^{tag}`,
    ]).trim();
    assert.equal(
      git(repository, ['rev-parse', `${receiptRef}^{commit}`]).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(signed.length, 2);
    assert.deepEqual(
      scanAuthorityAuditLedger(scope).records.map(
        ({ record }) => record.eventType,
      ),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'poststate',
        'error',
        'error',
        'grant-consume',
      ],
    );
    const completedAudit = scanAuthorityAuditLedger(scope);
    assert.equal(
      recoverAuthorityCommit(
        repository,
        terminal.reservationSessionId!,
        new Date('2026-08-03T09:02:00.000Z'),
        { receiptSigner: signer },
      ).commitHash,
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(signed.length, 2);
    assert.equal(
      git(repository, ['rev-parse', `${receiptRef}^{tag}`]).trim(),
      receiptTagObject,
    );
    const replayedRecoveryAudit = scanAuthorityAuditLedger(scope);
    assert.equal(replayedRecoveryAudit.recordCount, completedAudit.recordCount);
    assert.equal(
      replayedRecoveryAudit.headRecordDigest,
      completedAudit.headRecordDigest,
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      1,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply rejects commit preconditions before checks or grant signing', () => {
  const repository = prepareCandidate();
  const marker = path.join(repository, '.git/v2-check-passed');
  const signed: string[] = [];
  try {
    git(repository, ['config', '--unset', 'gpg.format']);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Approve and apply the exact checked candidate',
            message: 'Apply exact workflow candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer: fakeSigner(signed),
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GIT_SIGNING_REQUIRED'),
    );
    assert.deepEqual(signed, []);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/maintainer-grants'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
