import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertGrantPathsEligible,
  canonicalGrantEnvelope,
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
import {
  commitAuthoritySession,
  SimulatedAuthorityCrash,
} from '../src/maintainer-commit.ts';
import {
  readAuthorityCommitJournal,
  recoverAuthorityCommit,
} from '../src/maintainer-recovery.ts';
import { commitFacts } from '../src/git-transitions.ts';
import { validateCiAuthorityCommit } from '../src/ci-authority.ts';
import { listRangeCommits } from '../src/ci-git.ts';
import { replayCommitSequence } from '../src/ci-sequence.ts';
import { canonicalCheckDefinition } from '../src/ci-historical-contract.ts';

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
    'workflow/maintainer-policy.json',
    'workflow/schemas/**',
  ],
  sealedImmutablePaths: [
    'packages/workflow-engine/src/maintainer-policy.ts',
    'workflow/maintainer-policy.json',
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

test('authority commit signs the exact checked diff and consumes one grant', () => {
  const fixture = prepareAuthorityCommitFixture(
    '88888888-8888-4888-8888-888888888888',
  );
  try {
    const result = commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Repair exact authority',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const facts = commitFacts(fixture.repository, result.commitHash);
    assert.deepEqual(facts.parents, [fixture.baseCommit]);
    assert.equal(
      facts.message,
      [
        'Repair exact authority',
        '',
        'Change: demo-change',
        'Transition: authority-maintenance',
        `Grant: ${fixture.grantId}`,
        '',
      ].join('\n'),
    );
    assert.equal(git(fixture.repository, ['status', '--porcelain']).trim(), '');
    assert.equal(
      readAuthoritySession(fixture.repository, fixture.sessionId).state,
      'committed',
    );
    assert.equal(
      inspectMaintainerGrants(fixture.commonDirectory, fixture.grantId)[0]
        ?.state,
      'consumed',
    );
    assert.equal(
      readAuthorityCommitJournal(fixture.commonDirectory, fixture.sessionId)
        .state,
      'consumed',
    );
    assert.match(
      fs.readFileSync(
        path.join(fixture.repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[ \] 1\.1/,
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('authority recovery completes a crash after signed commit creation', () => {
  const fixture = prepareAuthorityCommitFixture(
    '99999999-9999-4999-8999-999999999999',
  );
  try {
    assert.throws(
      () =>
        commitAuthoritySession(
          fixture.repository,
          fixture.sessionId,
          'Repair exact authority',
          {
            now: fixtureTime(fixture, 30),
            signer: fixtureSigner(),
            testCrashAfter: 'commit-created',
          },
        ),
      SimulatedAuthorityCrash,
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baseCommit,
    );
    assert.equal(
      readAuthorityCommitJournal(fixture.commonDirectory, fixture.sessionId)
        .state,
      'commit-created',
    );

    const recovered = recoverAuthorityCommit(
      fixture.repository,
      fixture.sessionId,
      fixtureTime(fixture, 40),
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      recovered.commitHash,
    );
    assert.equal(recovered.journalState, 'consumed');
    assert.equal(
      recoverAuthorityCommit(
        fixture.repository,
        fixture.sessionId,
        fixtureTime(fixture, 50),
      ).commitHash,
      recovered.commitHash,
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('authority recovery finalizes a crash after the ref update', () => {
  const fixture = prepareAuthorityCommitFixture(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  try {
    assert.throws(
      () =>
        commitAuthoritySession(
          fixture.repository,
          fixture.sessionId,
          'Repair exact authority',
          {
            now: fixtureTime(fixture, 30),
            signer: fixtureSigner(),
            testCrashAfter: 'ref-updated',
          },
        ),
      SimulatedAuthorityCrash,
    );
    const journal = readAuthorityCommitJournal(
      fixture.commonDirectory,
      fixture.sessionId,
    );
    assert.equal(journal.state, 'ref-updated');
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      journal.commitHash,
    );

    const recovered = recoverAuthorityCommit(
      fixture.repository,
      fixture.sessionId,
      fixtureTime(fixture, 40),
    );
    assert.equal(recovered.commitHash, journal.commitHash);
    assert.equal(
      inspectMaintainerGrants(fixture.commonDirectory, fixture.grantId)[0]
        ?.state,
      'consumed',
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('ambiguous authority recovery revokes the use without a second commit', () => {
  const fixture = prepareAuthorityCommitFixture(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  try {
    assert.throws(
      () =>
        commitAuthoritySession(
          fixture.repository,
          fixture.sessionId,
          'Repair exact authority',
          {
            now: fixtureTime(fixture, 30),
            signer: fixtureSigner(),
            testCrashAfter: 'commit-created',
          },
        ),
      SimulatedAuthorityCrash,
    );
    const journalPath = path.join(
      fixture.commonDirectory,
      'workflow-engine/maintainer-grants/journals',
      `${fixture.sessionId}.json`,
    );
    const altered = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    altered.commitHash = 'c'.repeat(40);
    fs.writeFileSync(journalPath, `${JSON.stringify(altered)}\n`, {
      mode: 0o600,
    });

    assert.throws(() =>
      recoverAuthorityCommit(
        fixture.repository,
        fixture.sessionId,
        fixtureTime(fixture, 40),
      ),
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baseCommit,
    );
    assert.equal(
      inspectMaintainerGrants(fixture.commonDirectory, fixture.grantId)[0]
        ?.state,
      'revoked',
    );
    assert.equal(
      readAuthoritySession(fixture.repository, fixture.sessionId).state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(fixture.commonDirectory, fixture.sessionId)
        .state,
      'revoked',
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('untrusted commit signing key is rejected before the branch ref advances', () => {
  const fixture = prepareAuthorityCommitFixture(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  try {
    const untrustedKey = path.join(fixture.signingDirectory, 'untrusted');
    const generated = spawnSync(
      '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'untrusted', '-f', untrustedKey],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    git(fixture.repository, ['config', 'user.signingkey', untrustedKey]);

    assert.throws(() =>
      commitAuthoritySession(
        fixture.repository,
        fixture.sessionId,
        'Repair exact authority',
        {
          now: fixtureTime(fixture, 30),
          signer: fixtureSigner(),
        },
      ),
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baseCommit,
    );
    assert.equal(
      inspectMaintainerGrants(fixture.commonDirectory, fixture.grantId)[0]
        ?.state,
      'revoked',
    );
    assert.equal(
      readAuthorityCommitJournal(fixture.commonDirectory, fixture.sessionId)
        .state,
      'revoked',
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('CI independently accepts one parent-policy authority claim', () => {
  const fixture = prepareAuthorityCommitFixture(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  );
  try {
    const committed = commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Repair exact authority',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const [commit] = listRangeCommits(
      fixture.repository,
      fixture.baseCommit,
      committed.commitHash,
    );
    assert.ok(commit);

    const verified = validateCiAuthorityCommit(
      fixture.repository,
      commit,
      fixtureTime(fixture, 40),
    );
    assert.equal(verified.grantId, fixture.grantId);
    assert.equal(verified.changeId, 'demo-change');
    assert.deepEqual(verified.allowedPaths, ['workflow/checks.json']);
    assert.deepEqual(Object.keys(verified.requiredCheckDefinitions), [
      'fixture',
    ]);
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('CI rejects an authority claim without its exact protected audit tag', () => {
  const fixture = prepareAuthorityCommitFixture(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  );
  try {
    const committed = commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Repair exact authority',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const tagRef = `${fixture.policy.auditTagPrefix}${fixture.grantId}`;
    git(fixture.repository, ['update-ref', '-d', tagRef]);
    const [commit] = listRangeCommits(
      fixture.repository,
      fixture.baseCommit,
      committed.commitHash,
    );
    assert.ok(commit);

    assert.throws(
      () =>
        validateCiAuthorityCommit(
          fixture.repository,
          commit,
          fixtureTime(fixture, 40),
        ),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_AUDIT_TAG_INVALID'),
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('CI rejects a duplicate authority grant claim in one pull-request range', () => {
  const fixture = prepareAuthorityCommitFixture(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  );
  try {
    commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Repair exact authority',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const checksPath = path.join(fixture.repository, 'workflow/checks.json');
    fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
    git(fixture.repository, ['add', 'workflow/checks.json']);
    git(fixture.repository, [
      'commit',
      '-S',
      '-m',
      'Replay exact authority',
      '-m',
      [
        'Change: demo-change',
        'Transition: authority-maintenance',
        `Grant: ${fixture.grantId}`,
      ].join('\n'),
    ]);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () =>
        replayCommitSequence(
          fixture.repository,
          listRangeCommits(fixture.repository, fixture.baseCommit, head),
          new Map(),
          [],
          [],
          fixtureTime(fixture, 40),
        ),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_GRANT_DUPLICATE'),
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('CI accepts an old-key-authorized trusted signer rotation', () => {
  const fixture = prepareAuthorityCommitFixture(
    '12121212-1212-4212-8212-121212121212',
    {
      allowedPath: 'workflow/maintainer-policy.json',
      mutate(repository, policy) {
        const rotated: MaintainerPolicy = {
          ...policy,
          trustedSigners: POLICY.trustedSigners,
        };
        fs.writeFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          `${JSON.stringify(rotated, null, 2)}\n`,
        );
      },
    },
  );
  try {
    const committed = commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Rotate trusted maintainer key',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const [commit] = listRangeCommits(
      fixture.repository,
      fixture.baseCommit,
      committed.commitHash,
    );
    assert.ok(commit);

    assert.doesNotThrow(() =>
      validateCiAuthorityCommit(
        fixture.repository,
        commit,
        fixtureTime(fixture, 40),
      ),
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('CI rejects a candidate key that attempts to trust its own grant', () => {
  const repository = createFixtureRepository();
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-candidate-key-'),
  );
  try {
    const oldKey = generateFixtureSshKey(
      signingDirectory,
      'old',
      'fixture-maintainer',
    );
    const candidateKey = generateFixtureSshKey(
      signingDirectory,
      'candidate',
      'fixture-maintainer',
    );
    const parentPolicy: MaintainerPolicy = {
      ...POLICY,
      trustedSigners: [oldKey.trustedSigner],
    };
    installFixtureMaintainerPolicy(repository, parentPolicy);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    const grantId = '13131313-1313-4313-8313-131313131313';
    const now = new Date(Date.now() - 60_000);
    const payload: MaintainerGrantPayload = {
      version: 1,
      grantId,
      repositoryId: parentPolicy.repository.id,
      repositoryOrigin: parentPolicy.repository.origin,
      baseCommit: base,
      policyBlob: git(repository, [
        'rev-parse',
        `${base}:workflow/maintainer-policy.json`,
      ]).trim(),
      changeId: 'demo-change',
      allowedPaths: ['workflow/maintainer-policy.json'],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      maxUses: 1,
      reason: 'Attempt candidate-controlled signer rotation',
      signer: candidateKey.trustedSigner.identity,
    };
    const signature = fixtureSshSigner(candidateKey.privateKey, {
      ...parentPolicy,
      trustedSigners: [candidateKey.trustedSigner],
    }).sign(canonicalGrantPayload(payload));
    writeFixtureAuditTag(repository, base, grantId, {
      payload,
      signature,
    });

    git(repository, ['switch', '-c', 'work/demo-change']);
    fs.writeFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      `${JSON.stringify(
        { ...parentPolicy, trustedSigners: [candidateKey.trustedSigner] },
        null,
        2,
      )}\n`,
    );
    git(repository, ['config', 'gpg.format', 'ssh']);
    git(repository, ['config', 'user.signingkey', candidateKey.privateKey]);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, [
      'commit',
      '-S',
      '-m',
      'Attempt candidate signer rotation',
      '-m',
      [
        'Change: demo-change',
        'Transition: authority-maintenance',
        `Grant: ${grantId}`,
      ].join('\n'),
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    const [commit] = listRangeCommits(repository, base, head);
    assert.ok(commit);

    assert.throws(
      () => validateCiAuthorityCommit(repository, commit, new Date()),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_GRANT_SIGNATURE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(signingDirectory, { recursive: true, force: true });
  }
});

test('CI rejects an authority grant that expires while the PR is evaluated', () => {
  const fixture = prepareAuthorityCommitFixture(
    '14141414-1414-4414-8414-141414141414',
  );
  try {
    const committed = commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Repair exact authority',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const [commit] = listRangeCommits(
      fixture.repository,
      fixture.baseCommit,
      committed.commitHash,
    );
    assert.ok(commit);

    assert.throws(
      () =>
        validateCiAuthorityCommit(
          fixture.repository,
          commit,
          fixtureTime(fixture, 30 * 60 + 1),
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_EXPIRED'),
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});

test('CI rejects a sealed-to-bootstrap phase rollback from parent policy', () => {
  const repository = createFixtureRepository();
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-sealed-rollback-'),
  );
  try {
    const key = generateFixtureSshKey(
      signingDirectory,
      'sealed',
      'fixture-maintainer',
    );
    const parentPolicy: MaintainerPolicy = {
      ...POLICY,
      phase: 'sealed',
      trustedSigners: [key.trustedSigner],
    };
    installFixtureMaintainerPolicy(repository, parentPolicy);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    const grantId = '15151515-1515-4515-8515-151515151515';
    const now = new Date(Date.now() - 60_000);
    const payload: MaintainerGrantPayload = {
      version: 1,
      grantId,
      repositoryId: parentPolicy.repository.id,
      repositoryOrigin: parentPolicy.repository.origin,
      baseCommit: base,
      policyBlob: git(repository, [
        'rev-parse',
        `${base}:workflow/maintainer-policy.json`,
      ]).trim(),
      changeId: 'demo-change',
      allowedPaths: ['workflow/maintainer-policy.json'],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      maxUses: 1,
      reason: 'Attempt sealed maintainer policy rollback',
      signer: key.trustedSigner.identity,
    };
    const signature = fixtureSshSigner(key.privateKey, parentPolicy).sign(
      canonicalGrantPayload(payload),
    );
    writeFixtureAuditTag(repository, base, grantId, { payload, signature });

    git(repository, ['switch', '-c', 'work/demo-change']);
    fs.writeFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      `${JSON.stringify({ ...parentPolicy, phase: 'bootstrap' }, null, 2)}\n`,
    );
    git(repository, ['config', 'gpg.format', 'ssh']);
    git(repository, ['config', 'user.signingkey', key.privateKey]);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, [
      'commit',
      '-S',
      '-m',
      'Attempt sealed policy rollback',
      '-m',
      [
        'Change: demo-change',
        'Transition: authority-maintenance',
        `Grant: ${grantId}`,
      ].join('\n'),
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    const [commit] = listRangeCommits(repository, base, head);
    assert.ok(commit);

    assert.throws(
      () => validateCiAuthorityCommit(repository, commit, new Date()),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(signingDirectory, { recursive: true, force: true });
  }
});

function installFixtureMaintainerPolicy(
  repository: string,
  policy: MaintainerPolicy = POLICY,
): void {
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
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add maintainer fixture policy']);
}

type AuthorityCommitFixture = {
  repository: string;
  signingDirectory: string;
  privateKey: string;
  commonDirectory: string;
  grantId: string;
  sessionId: string;
  baseCommit: string;
  now: Date;
  policy: MaintainerPolicy;
};

type AuthorityCommitFixtureOptions = {
  allowedPath?: string;
  mutate?: (
    repository: string,
    policy: MaintainerPolicy,
    signingDirectory: string,
  ) => void;
};

function prepareAuthorityCommitFixture(
  grantId: string,
  options: AuthorityCommitFixtureOptions = {},
): AuthorityCommitFixture {
  const repository = createFixtureRepository();
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-authority-key-'),
  );
  const privateKey = path.join(signingDirectory, 'id_ed25519');
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
  const fingerprintOutput = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintOutput.status, 0, fingerprintOutput.stderr);
  const fingerprint = fingerprintOutput.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  const policy: MaintainerPolicy = {
    ...POLICY,
    trustedSigners: [
      { identity: 'fixture-maintainer', publicKey, fingerprint },
    ],
  };
  installFixtureMaintainerPolicy(repository, policy);
  git(repository, ['config', 'gpg.format', 'ssh']);
  git(repository, ['config', 'user.signingkey', privateKey]);
  const now = new Date(Date.now() - 60_000);
  const allowedPath = options.allowedPath ?? 'workflow/checks.json';
  issueMaintainerGrant(
    repository,
    {
      changeId: 'demo-change',
      paths: [allowedPath],
      reason: 'Repair exact workflow authority',
    },
    {
      now,
      grantId,
      signer: fixtureSshSigner(privateKey, policy),
    },
  );
  git(repository, ['switch', '-c', 'work/demo-change']);
  const session = startAuthoritySession(repository, 'demo-change', grantId, {
    now: new Date(now.getTime() + 10_000),
    signer: fixtureSigner(),
  });
  if (options.mutate) {
    options.mutate(repository, policy, signingDirectory);
  } else {
    const targetPath = path.join(repository, allowedPath);
    fs.writeFileSync(targetPath, ` ${fs.readFileSync(targetPath, 'utf8')}`);
  }
  checkAuthoritySession(repository, session.sessionId, {
    now: new Date(now.getTime() + 20_000),
    signer: fixtureSigner(),
  });
  return {
    repository,
    signingDirectory,
    privateKey,
    commonDirectory: fs.realpathSync(path.join(repository, '.git')),
    grantId,
    sessionId: session.sessionId,
    baseCommit: session.baseCommit,
    now,
    policy,
  };
}

function fixtureTime(fixture: AuthorityCommitFixture, seconds: number): Date {
  return new Date(fixture.now.getTime() + seconds * 1_000);
}

function cleanupAuthorityCommitFixture(fixture: AuthorityCommitFixture): void {
  fs.rmSync(fixture.repository, { recursive: true, force: true });
  fs.rmSync(fixture.signingDirectory, { recursive: true, force: true });
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

function generateFixtureSshKey(
  directory: string,
  basename: string,
  identity: string,
): {
  privateKey: string;
  trustedSigner: MaintainerPolicy['trustedSigners'][number];
} {
  const privateKey = path.join(directory, basename);
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', identity, '-f', privateKey],
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
    trustedSigner: { identity, publicKey, fingerprint },
  };
}

function writeFixtureAuditTag(
  repository: string,
  base: string,
  grantId: string,
  envelope: MaintainerGrantEnvelope,
): void {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-fixture-tag-'),
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
      base,
    ]);
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
    sign(payload) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'workflow-fixture-sign-'),
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
            policy.signatureNamespace,
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
    verify(payload, signature, identity) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'workflow-fixture-verify-'),
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
            identity,
            '-n',
            policy.signatureNamespace,
            '-s',
            signaturePath,
          ],
          { encoding: 'utf8', input: payload },
        );
        assert.equal(result.status, 0, result.stderr);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

test('CI adopts a check definition changed by a validated authority commit', () => {
  const fixture = prepareAuthorityCommitFixture(
    '21212121-2121-4121-8121-212121212121',
    {
      mutate(repository) {
        const checksPath = path.join(repository, 'workflow/checks.json');
        const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
          checks: Record<string, { command: string[] }>;
        };
        checks.checks.fixture.command = [
          'node',
          'scripts/pass.mjs',
          '--transitioned',
        ];
        fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
      },
    },
  );
  try {
    const committed = commitAuthoritySession(
      fixture.repository,
      fixture.sessionId,
      'Transition fixture check definition',
      {
        now: fixtureTime(fixture, 30),
        signer: fixtureSigner(),
      },
    );
    const result = replayCommitSequence(
      fixture.repository,
      listRangeCommits(
        fixture.repository,
        fixture.baseCommit,
        committed.commitHash,
      ),
      new Map(),
      [],
      [],
      fixtureTime(fixture, 40),
    );
    assert.equal(
      result.requiredCheckDefinitions.fixture,
      canonicalCheckDefinition({
        command: ['node', 'scripts/pass.mjs', '--transitioned'],
        destructiveDatabase: false,
      }),
    );
  } finally {
    cleanupAuthorityCommitFixture(fixture);
  }
});
