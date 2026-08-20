import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluatePlanningProvider,
  PlanningProviderContractError,
  type PlanningProviderChangeResult,
  type PlanningProviderPort,
} from '../src/planning-provider-port.ts';
import {
  assertPlanningProviderV1Migration,
  parsePlanningProviderBinding,
  PlanningProviderBindingError,
  planningProviderBindingDigest,
  renderPlanningProviderBinding,
  type PlanningProviderBindingV1,
} from '../src/planning-provider-binding.ts';

const BINDING: PlanningProviderBindingV1 = {
  schemaVersion: 1,
  changeId: 'demo-change',
  providerId: 'openspec',
  adapterContractVersion: 1,
  providerRequirement: {
    package: '@fission-ai/openspec',
    version: '1.6.0',
  },
  planningRoot: 'openspec/changes/demo-change',
};

test('planning-provider port preserves the landed v1 evaluation bytes and digest', () => {
  const change: PlanningProviderChangeResult = Object.freeze({
    readiness: 'ready',
    blockers: [],
    valid: true,
    diagnostics: [],
    validationDigest: 'b'.repeat(64),
  });
  const provider: PlanningProviderPort = {
    id: 'fixture-provider',
    contractVersion: 7,
    inspectInstallation: () => ({
      providerId: 'fixture-provider',
      adapterContractVersion: 7,
      providerVersion: '1.0.0',
      installationDigest: 'a'.repeat(64),
    }),
    validateChange: () => change,
    inspectChange: () => change,
  };
  const context = {
    repositoryRoot: '/fixture/repository',
    planningRoot: 'fixture/changes/demo-change',
    changeId: 'demo-change',
    contractName: 'fixture-contract',
    revision: { kind: 'worktree' as const },
    readOnly: true as const,
  };

  assert.equal(
    evaluatePlanningProvider(provider, context).evaluationDigest,
    '72182e551454c147d258727919b8a590cd05f5b1d19f049ebe371315357a5553',
  );
  assert.throws(
    () =>
      evaluatePlanningProvider(
        {
          ...provider,
          inspectInstallation: () => ({
            providerId: 'wrong-provider',
            adapterContractVersion: 7,
            providerVersion: '1.0.0',
            installationDigest: 'a'.repeat(64),
          }),
        },
        context,
      ),
    (error) =>
      error instanceof PlanningProviderContractError &&
      error.code === 'PLANNING_PROVIDER_CONTRACT_INVALID' &&
      error.message ===
        'Planning-provider installation evidence contradicts the compiled port.',
  );
});

test('planning-provider binding preserves canonical bytes, digest, and fail-closed migration', () => {
  const bytes = `${JSON.stringify(BINDING, null, 2)}\n`;
  assert.equal(renderPlanningProviderBinding(BINDING), bytes);
  assert.deepEqual(parsePlanningProviderBinding(bytes, 'demo-change'), BINDING);
  assert.equal(
    planningProviderBindingDigest(BINDING),
    'c154dbbb019ac77bae1fec0215599655d4a617ead3d015644c45ff2400abee95',
  );

  assert.throws(
    () =>
      parsePlanningProviderBinding(
        bytes.replace('"schemaVersion": 1', '"schemaVersion": 2'),
        'demo-change',
      ),
    (error) =>
      error instanceof PlanningProviderBindingError &&
      error.code === 'PROVIDER_BINDING_VERSION_UNSUPPORTED',
  );
  assert.throws(
    () =>
      assertPlanningProviderV1Migration(BINDING, {
        ...BINDING,
        providerId: 'other-provider',
      }),
    (error) =>
      error instanceof PlanningProviderBindingError &&
      error.code === 'PROVIDER_MIGRATION_UNSUPPORTED',
  );
});
