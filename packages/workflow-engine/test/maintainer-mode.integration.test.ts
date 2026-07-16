import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertGrantPathsEligible,
  canonicalGrantPayload,
  issueMaintainerGrant,
  validateGrantPayload,
  type MaintainerGrantEnvelope,
  type MaintainerGrantPayload,
} from '../src/maintainer-grant.ts';
import {
  assertInteractiveSignerContext,
  type MaintainerSignerProvider,
} from '../src/maintainer-signer.ts';
import {
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
  reserveMaintainerGrant,
  revokeMaintainerGrant,
} from '../src/maintainer-store.ts';
import {
  loadMaintainerPolicy,
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../src/maintainer-policy.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';
import { abortSession, startSession } from '../src/session.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../src/session-store.ts';
import {
  checkAuthoritySession,
  readAuthoritySession,
  startAuthoritySession,
} from '../src/maintainer-session.ts';
import { readImmutableReport } from '../src/report-store.ts';

const POLICY: MaintainerPolicy = {
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
    'workflow/schemas/**',
  ],
  sealedImmutablePaths: [
    'packages/workflow-engine/src/maintainer-policy.ts',
    'workflow/schemas/maintainer-policy.schema.json',
  ],
  requiredChecks: ['fixture'],
  trustedSigners: [
    {
      identity: 'fixture-maintainer',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
      fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
    },
  ],
};

function grant(
  overrides: Partial<MaintainerGrantPayload> = {},
): MaintainerGrantPayload {
  return {
    version: 1,
    grantId: '11111111-1111-4111-8111-111111111111',
    repositoryId: POLICY.repository.id,
    repositoryOrigin: POLICY.repository.origin,
    baseCommit: 'a'.repeat(40),
    policyBlob: 'b'.repeat(40),
    changeId: 'demo-change',
    allowedPaths: ['workflow/checks.json'],
    issuedAt: '2026-07-16T12:00:00.000Z',
    expiresAt: '2026-07-16T12:30:00.000Z',
    maxUses: 1,
    reason: 'Repair exact workflow authority',
    signer: 'fixture-maintainer',
    ...overrides,
  };
}

test('repository maintainer policy is strict, stable, and bootstrap-scoped', () => {
  const policy = loadMaintainerPolicy(sourceRepositoryRoot);

  assert.equal(policy.repository.id, 'github:R_kgDOOotVag');
  assert.equal(
    policy.repository.origin,
    'https://github.com/tomchen86/expense-app.git',
  );
  assert.equal(policy.phase, 'bootstrap');
  assert.equal(policy.maxTtlMinutes, 30);
  assert.equal(policy.maxUses, 1);
  assert.deepEqual(
    policy.trustedSigners.map(({ identity }) => identity),
    ['tomchen86'],
  );
  assert.ok(
    policy.sealedImmutablePaths.includes(
      'packages/workflow-engine/src/maintainer-policy.ts',
    ),
  );
});

test('maintainer policy rejects unknown, unordered, and self-removable trust', () => {
  assert.throws(
    () => parseMaintainerPolicy({ ...POLICY, unexpected: true }),
    (error) => isWorkflowError(error, 'MAINTAINER_POLICY_INVALID'),
  );
  assert.throws(
    () =>
      parseMaintainerPolicy({
        ...POLICY,
        bootstrapEligiblePaths: [...POLICY.bootstrapEligiblePaths].reverse(),
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_POLICY_INVALID'),
  );
  assert.throws(
    () =>
      parseMaintainerPolicy({
        ...POLICY,
        sealedImmutablePaths: ['workflow/not-eligible.json'],
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_POLICY_INVALID'),
  );
});

test('grant payload serialization is canonical and validates every bound field', () => {
  const payload = grant();
  assert.equal(canonicalGrantPayload(payload), `${JSON.stringify(payload)}\n`);
  assert.doesNotThrow(() =>
    validateGrantPayload(payload, POLICY, {
      now: new Date('2026-07-16T12:10:00.000Z'),
      expectedBase: payload.baseCommit,
      expectedPolicyBlob: payload.policyBlob,
    }),
  );

  for (const invalid of [
    grant({ repositoryId: 'github:other' }),
    grant({ baseCommit: 'short' }),
    grant({ policyBlob: 'c'.repeat(40) }),
    grant({ allowedPaths: ['workflow/schemas/**'] }),
    grant({ allowedPaths: ['workflow/checks.json', 'workflow/checks.json'] }),
    grant({ expiresAt: '2026-07-16T12:31:00.000Z' }),
    grant({ maxUses: 2 as 1 }),
    grant({ reason: 'short' }),
    grant({ signer: 'candidate-key' }),
  ]) {
    assert.throws(
      () =>
        validateGrantPayload(invalid, POLICY, {
          now: new Date('2026-07-16T12:10:00.000Z'),
          expectedBase: 'a'.repeat(40),
          expectedPolicyBlob: 'b'.repeat(40),
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
  }
});

test('grant expiry is fail-closed unless historical validation is explicit', () => {
  const payload = grant();
  assert.throws(
    () =>
      validateGrantPayload(payload, POLICY, {
        now: new Date('2026-07-16T12:30:00.001Z'),
        expectedBase: payload.baseCommit,
        expectedPolicyBlob: payload.policyBlob,
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_GRANT_EXPIRED'),
  );
  assert.doesNotThrow(() =>
    validateGrantPayload(payload, POLICY, {
      now: new Date('2026-07-16T12:30:00.001Z'),
      expectedBase: payload.baseCommit,
      expectedPolicyBlob: payload.policyBlob,
      allowExpired: true,
    }),
  );
});

test('grant paths require exact-case tracked regular eligible files', () => {
  const repository = createFixtureRepository();
  try {
    assert.deepEqual(
      assertGrantPathsEligible(repository, ['workflow/checks.json'], POLICY),
      ['workflow/checks.json'],
    );

    fs.symlinkSync(
      path.join(repository, 'workflow/checks.json'),
      path.join(repository, 'workflow/checks-link.json'),
    );
    git(repository, ['add', 'workflow/checks-link.json']);
    git(repository, ['commit', '-m', 'Add unsafe authority symlink']);

    for (const paths of [
      ['workflow/*.json'],
      ['workflow'],
      ['Workflow/checks.json'],
      ['workflow/checks-link.json'],
      ['src/.gitkeep'],
      ['../workflow/checks.json'],
    ]) {
      assert.throws(
        () => assertGrantPathsEligible(repository, paths, POLICY),
        (error) => isWorkflowError(error, 'MAINTAINER_GRANT_PATH_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('grant signer requires controlling input and output terminals', () => {
  for (const context of [
    { stdinIsTty: false, stdoutIsTty: true, stderrIsTty: true },
    { stdinIsTty: true, stdoutIsTty: false, stderrIsTty: true },
    { stdinIsTty: true, stdoutIsTty: true, stderrIsTty: false },
  ]) {
    assert.throws(
      () => assertInteractiveSignerContext(context),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );
  }
  assert.doesNotThrow(() =>
    assertInteractiveSignerContext({
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
    }),
  );
});

test('maintainer grant CLI rejects non-interactive and unattended issuance', () => {
  const repository = createFixtureRepository();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  const validArguments = [
    '--experimental-strip-types',
    cli,
    'maintainer',
    'grant',
    '--change',
    'demo-change',
    '--paths',
    'workflow/checks.json',
    '--reason',
    'Repair exact workflow authority',
    '--json',
  ];
  try {
    installFixtureMaintainerPolicy(repository);
    const nonInteractive = spawnSync(process.execPath, validArguments, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(nonInteractive.status, 12);
    assert.equal(
      JSON.parse(nonInteractive.stderr).error.code,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );

    const unattended = spawnSync(
      process.execPath,
      [...validArguments.slice(0, -1), '--unattended', '--json'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(unattended.status, 2);
    assert.equal(JSON.parse(unattended.stderr).error.code, 'INVALID_USAGE');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('grant issuance signs canonical bytes and writes only common-dir state and an audit tag', () => {
  const repository = createFixtureRepository();
  const now = new Date('2026-07-16T12:00:00.000Z');
  const grantId = '22222222-2222-4222-8222-222222222222';
  const signedInputs: string[] = [];
  const verified: MaintainerGrantEnvelope[] = [];
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload) {
      signedInputs.push(payload);
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'ZmFrZQ==',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify(payload, signature, identity) {
      verified.push({ payload: JSON.parse(payload), signature });
      assert.equal(identity, 'fixture-maintainer');
    },
  };

  try {
    installFixtureMaintainerPolicy(repository);
    const result = issueMaintainerGrant(
      repository,
      {
        changeId: 'demo-change',
        paths: ['workflow/checks.json'],
        reason: 'Repair exact workflow authority',
      },
      { now, grantId, signer },
    );

    assert.equal(result.grantId, grantId);
    assert.equal(result.tagRef, `refs/tags/workflow-grant/${grantId}`);
    assert.equal(
      result.publishCommand,
      `git push origin ${result.tagRef}:${result.tagRef}`,
    );
    assert.equal(signedInputs.length, 1);
    assert.equal(verified.length, 1);
    assert.equal(
      signedInputs[0],
      canonicalGrantPayload(result.envelope.payload),
    );
    assert.equal(
      result.envelope.payload.baseCommit,
      git(repository, ['rev-parse', 'HEAD']).trim(),
    );
    assert.equal(
      result.envelope.payload.policyBlob,
      git(repository, [
        'rev-parse',
        'HEAD:workflow/maintainer-policy.json',
      ]).trim(),
    );
    assert.equal(result.envelope.payload.expiresAt, '2026-07-16T12:30:00.000Z');
    assert.equal(result.envelope.payload.maxUses, 1);

    const available = path.join(
      repository,
      '.git/workflow-engine/maintainer-grants/available',
      `${grantId}.json`,
    );
    assert.equal(fs.statSync(available).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(available, 'utf8')),
      result.envelope,
    );
    const rawTag = git(repository, ['cat-file', 'tag', result.tagRef]);
    assert.equal(
      rawTag.slice(rawTag.indexOf('\n\n') + 2),
      `${JSON.stringify(result.envelope)}\n`,
    );
    assert.equal(git(repository, ['status', '--porcelain']).trim(), '');

    assert.throws(
      () =>
        issueMaintainerGrant(
          repository,
          {
            changeId: 'demo-change',
            paths: ['workflow/checks.json'],
            reason: 'Repair exact workflow authority',
          },
          { now, grantId, signer },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_EXISTS'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('failed signature verification leaves no token or audit tag', () => {
  const repository = createFixtureRepository();
  const grantId = '33333333-3333-4333-8333-333333333333';
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign() {
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'YmFk',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify() {
      throw new Error('altered signature');
    },
  };

  try {
    installFixtureMaintainerPolicy(repository);
    assert.throws(() =>
      issueMaintainerGrant(
        repository,
        {
          changeId: 'demo-change',
          paths: ['workflow/checks.json'],
          reason: 'Repair exact workflow authority',
        },
        {
          now: new Date('2026-07-16T12:00:00.000Z'),
          grantId,
          signer,
        },
      ),
    );
    assert.equal(
      fs.existsSync(
        path.join(
          repository,
          '.git/workflow-engine/maintainer-grants/available',
          `${grantId}.json`,
        ),
      ),
      false,
    );
    assert.throws(() =>
      git(repository, ['rev-parse', `refs/tags/workflow-grant/${grantId}`]),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('common-dir reservation is exclusive across worktrees and revocation is idempotent', () => {
  const repository = createFixtureRepository();
  const grantId = '44444444-4444-4444-8444-444444444444';
  let linkedWorktree: string | undefined;
  try {
    installFixtureMaintainerPolicy(repository);
    issueMaintainerGrant(
      repository,
      {
        changeId: 'demo-change',
        paths: ['workflow/checks.json'],
        reason: 'Repair exact workflow authority',
      },
      {
        now: new Date('2026-07-16T12:00:00.000Z'),
        grantId,
        signer: fixtureSigner(),
      },
    );
    const commonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.deepEqual(inspectMaintainerGrants(commonDirectory, grantId), [
      {
        grantId,
        state: 'available',
        changeId: 'demo-change',
        baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
        allowedPaths: ['workflow/checks.json'],
        issuedAt: '2026-07-16T12:00:00.000Z',
        expiresAt: '2026-07-16T12:30:00.000Z',
        signer: 'fixture-maintainer',
      },
    ]);

    git(repository, ['switch', '-c', 'work/demo-change']);
    const ordinary = startSession(repository, 'demo-change', '1.1');
    assert.throws(
      () =>
        reserveMaintainerGrant(commonDirectory, grantId, {
          sessionId: 'authority-conflict',
          repositoryRoot: fs.realpathSync(repository),
        }),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );
    abortSession(repository, ordinary.sessionId, 'Fixture conflict complete');

    linkedWorktree = fs.mkdtempSync(
      path.join(path.dirname(repository), 'workflow-linked-'),
    );
    fs.rmdirSync(linkedWorktree);
    git(repository, [
      'worktree',
      'add',
      '-b',
      'work/linked-authority',
      linkedWorktree,
      'HEAD',
    ]);
    const linkedCommon = fs.realpathSync(
      git(linkedWorktree, ['rev-parse', '--git-common-dir']).trim(),
    );
    assert.equal(linkedCommon, commonDirectory);

    const reservation = reserveMaintainerGrant(linkedCommon, grantId, {
      sessionId: 'authority-session-fixture',
      repositoryRoot: fs.realpathSync(linkedWorktree),
      now: new Date('2026-07-16T12:05:00.000Z'),
    });
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.repositoryRoot, fs.realpathSync(linkedWorktree));
    assert.throws(
      () =>
        reserveMaintainerGrant(commonDirectory, grantId, {
          sessionId: 'authority-session-attacker',
          repositoryRoot: fs.realpathSync(repository),
        }),
      (error) => isWorkflowError(error, 'ACTIVE_AUTHORITY_CONFLICT'),
    );
    assert.throws(
      () =>
        withRepositoryLifecycleOperation(
          runtimePaths(commonDirectory, 'workflow-engine'),
          () => undefined,
        ),
      (error) => isWorkflowError(error, 'ACTIVE_AUTHORITY_CONFLICT'),
    );

    const inspection = inspectMaintainerGrants(commonDirectory, grantId)[0];
    assert.equal(inspection?.state, 'reserved');
    assert.equal(inspection?.reservationSessionId, 'authority-session-fixture');
    assert.equal(
      JSON.stringify(inspection).includes(fs.realpathSync(linkedWorktree)),
      false,
    );
    const store = maintainerGrantStorePaths(commonDirectory);
    for (const directory of [
      store.root,
      store.available,
      store.reserved,
      store.terminal,
      store.journals,
    ]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    assert.equal(
      fs.statSync(path.join(store.reserved, `${grantId}.json`)).mode & 0o777,
      0o600,
    );
    assert.equal(
      fs.existsSync(path.join(linkedWorktree, 'workflow-engine')),
      false,
    );

    const cli = path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/cli.ts',
    );
    const inspectedByCli = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'inspect',
        grantId,
        '--json',
      ],
      { cwd: linkedWorktree, encoding: 'utf8' },
    );
    assert.equal(inspectedByCli.status, 0);
    assert.equal(inspectedByCli.stdout.includes(linkedWorktree), false);
    assert.equal(JSON.parse(inspectedByCli.stdout).grants[0].state, 'reserved');

    const revokedByCli = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'revoke',
        grantId,
        '--json',
      ],
      { cwd: linkedWorktree, encoding: 'utf8' },
    );
    assert.equal(revokedByCli.status, 0);
    const revoked = JSON.parse(revokedByCli.stdout).grant;
    const repeated = revokeMaintainerGrant(
      linkedCommon,
      grantId,
      new Date('2026-07-16T12:07:00.000Z'),
    );
    assert.deepEqual(repeated, revoked);
    assert.equal(revoked.state, 'revoked');
    assert.equal(
      fs.existsSync(path.join(store.reserved, `${grantId}.json`)),
      false,
    );
    assert.equal(
      fs.statSync(path.join(store.terminal, `${grantId}.json`)).mode & 0o777,
      0o600,
    );

    const ambiguousReservation = path.join(store.reserved, 'attacker.tmp');
    fs.writeFileSync(ambiguousReservation, 'untrusted', { mode: 0o600 });
    assert.throws(
      () =>
        withRepositoryLifecycleOperation(
          runtimePaths(commonDirectory, 'workflow-engine'),
          () => undefined,
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_STORE_UNSAFE'),
    );
    fs.rmSync(ambiguousReservation);
  } finally {
    if (linkedWorktree && fs.existsSync(repository)) {
      try {
        git(repository, ['worktree', 'remove', '--force', linkedWorktree]);
      } catch {
        fs.rmSync(linkedWorktree, { recursive: true, force: true });
      }
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority session pins normal checks and terminally revokes failed scope', () => {
  const repository = createFixtureRepository();
  const grantId = '55555555-5555-4555-8555-555555555555';
  const now = new Date('2026-07-16T12:00:00.000Z');
  try {
    installFixtureMaintainerPolicy(repository);
    issueMaintainerGrant(
      repository,
      {
        changeId: 'demo-change',
        paths: ['workflow/checks.json'],
        reason: 'Repair exact workflow authority',
      },
      { now, grantId, signer: fixtureSigner() },
    );
    git(repository, ['switch', '-c', 'work/demo-change']);
    const session = startAuthoritySession(repository, 'demo-change', grantId, {
      now: new Date('2026-07-16T12:01:00.000Z'),
      signer: fixtureSigner(),
    });
    assert.deepEqual(session.requiredChecks, ['fixture']);
    assert.equal(session.pinnedChecks[0]?.runner.digest.length, 64);

    const checksPath = path.join(repository, 'workflow/checks.json');
    fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
    const checked = checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-07-16T12:02:00.000Z'),
      signer: fixtureSigner(),
    });
    assert.equal(checked.passed, true);
    assert.deepEqual(checked.changedPaths, ['workflow/checks.json']);
    const commonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const store = maintainerGrantStorePaths(commonDirectory);
    const report = readImmutableReport(
      store.runtime.reports,
      session.sessionId,
      checked.reportId,
    );
    assert.equal(report.kind, 'authority-check');
    assert.equal(report.grantId, grantId);
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );

    fs.writeFileSync(path.join(repository, 'src/unexpected.ts'), 'unsafe\n');
    assert.throws(
      () =>
        checkAuthoritySession(repository, session.sessionId, {
          now: new Date('2026-07-16T12:03:00.000Z'),
          signer: fixtureSigner(),
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_SCOPE_INVALID'),
    );
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'failed',
    );
    assert.equal(
      inspectMaintainerGrants(commonDirectory, grantId)[0]?.state,
      'revoked',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority start failure after reservation never returns the grant to available', () => {
  const repository = createFixtureRepository();
  const grantId = '66666666-6666-4666-8666-666666666666';
  try {
    installFixtureMaintainerPolicy(repository);
    const issued = issueMaintainerGrant(
      repository,
      {
        changeId: 'demo-change',
        paths: ['workflow/checks.json'],
        reason: 'Repair exact workflow authority',
      },
      {
        now: new Date('2026-07-16T12:00:00.000Z'),
        grantId,
        signer: fixtureSigner(),
      },
    );
    git(repository, ['update-ref', '-d', issued.tagRef]);
    git(repository, ['switch', '-c', 'work/demo-change']);
    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', grantId, {
          now: new Date('2026-07-16T12:01:00.000Z'),
          signer: fixtureSigner(),
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_TAG_INVALID'),
    );
    const commonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.equal(
      inspectMaintainerGrants(commonDirectory, grantId)[0]?.state,
      'revoked',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority session state cannot broaden signed paths or remove pinned checks', () => {
  const repository = createFixtureRepository();
  const grantId = '77777777-7777-4777-8777-777777777777';
  try {
    installFixtureMaintainerPolicy(repository);
    issueMaintainerGrant(
      repository,
      {
        changeId: 'demo-change',
        paths: ['workflow/checks.json'],
        reason: 'Repair exact workflow authority',
      },
      {
        now: new Date('2026-07-16T12:00:00.000Z'),
        grantId,
        signer: fixtureSigner(),
      },
    );
    git(repository, ['switch', '-c', 'work/demo-change']);
    const session = startAuthoritySession(repository, 'demo-change', grantId, {
      now: new Date('2026-07-16T12:01:00.000Z'),
      signer: fixtureSigner(),
    });
    const sessionPath = path.join(
      session.gitCommonDirectory,
      'workflow-engine/maintainer-grants/sessions',
      `${session.sessionId}.json`,
    );
    const altered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    altered.allowedPaths.push('src/unexpected.ts');
    altered.requiredChecks = [];
    altered.pinnedChecks = [];
    fs.writeFileSync(sessionPath, `${JSON.stringify(altered)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(repository, 'workflow/checks.json'),
      ` ${fs.readFileSync(path.join(repository, 'workflow/checks.json'), 'utf8')}`,
    );
    fs.writeFileSync(path.join(repository, 'src/unexpected.ts'), 'unsafe\n');

    assert.throws(
      () =>
        checkAuthoritySession(repository, session.sessionId, {
          now: new Date('2026-07-16T12:02:00.000Z'),
          signer: fixtureSigner(),
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_SESSION_MISMATCH'),
    );
    assert.equal(
      inspectMaintainerGrants(session.gitCommonDirectory, grantId)[0]?.state,
      'revoked',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function installFixtureMaintainerPolicy(repository: string): void {
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add maintainer fixture policy']);
}

function fixtureSigner(): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign() {
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'ZmFrZQ==',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify() {},
  };
}
