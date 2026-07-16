import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertGrantPathsEligible,
  canonicalGrantPayload,
  validateGrantPayload,
  type MaintainerGrantPayload,
} from '../src/maintainer-grant.ts';
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
