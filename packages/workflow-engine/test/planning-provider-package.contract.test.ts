import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  assertPlanningProviderV1Migration,
  parsePlanningProviderBinding,
  planningProviderBindingDigest,
  renderPlanningProviderBinding,
  type PlanningProviderBindingV1,
} from '../src/modules/planning-provider/planning-provider-binding.ts';
import {
  evaluatePlanningProvider,
  type PlanningProviderChangeResult,
  type PlanningProviderPort,
} from '../src/modules/planning-provider/planning-provider-port.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const binding: PlanningProviderBindingV1 = {
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

test('workflow compatibility facades preserve landed provider bytes and errors', () => {
  const change: PlanningProviderChangeResult = {
    readiness: 'ready',
    blockers: [],
    valid: true,
    diagnostics: [],
    validationDigest: 'b'.repeat(64),
  };
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
  const bytes = `${JSON.stringify(binding, null, 2)}\n`;
  assert.equal(renderPlanningProviderBinding(binding), bytes);
  assert.deepEqual(parsePlanningProviderBinding(bytes, 'demo-change'), binding);
  assert.equal(
    planningProviderBindingDigest(binding),
    'c154dbbb019ac77bae1fec0215599655d4a617ead3d015644c45ff2400abee95',
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
      error instanceof WorkflowError &&
      error.code === 'PLANNING_PROVIDER_CONTRACT_INVALID' &&
      error.exitCode === 13,
  );
  assert.throws(
    () =>
      assertPlanningProviderV1Migration(binding, {
        ...binding,
        providerId: 'other-provider',
      }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'PROVIDER_MIGRATION_UNSUPPORTED' &&
      error.exitCode === 10,
  );
});

test('production facades consume public core and OpenSpec package subpaths', () => {
  const read = (relativePath: string) =>
    fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  const corePortFacade = read(
    'packages/workflow-engine/src/modules/planning-provider/planning-provider-port.ts',
  );
  const coreBindingFacade = read(
    'packages/workflow-engine/src/modules/planning-provider/planning-provider-binding.ts',
  );
  const openspecPortFacade = read(
    'packages/workflow-engine/src/adapters/planning/openspec/documents/openspec-planning-provider.ts',
  );
  const openspecBindingFacade = read(
    'packages/workflow-engine/src/adapters/planning/openspec/documents/openspec-provider-binding.ts',
  );

  assert.match(
    corePortFacade,
    /from '@jigwright\/core\/planning-provider-port'/u,
  );
  assert.doesNotMatch(corePortFacade, /createHash|normalizeDiagnostic/u);
  assert.match(
    coreBindingFacade,
    /from '@jigwright\/core\/planning-provider-binding'/u,
  );
  assert.doesNotMatch(coreBindingFacade, /JSON\.parse|createHash/u);
  assert.match(
    openspecPortFacade,
    /from '@jigwright\/openspec-adapter\/planning-provider'/u,
  );
  assert.doesNotMatch(
    openspecPortFacade,
    /stableDiagnostics|freezeChangeResult/u,
  );
  assert.match(
    openspecBindingFacade,
    /from '@jigwright\/openspec-adapter\/provider-binding'/u,
  );
  assert.doesNotMatch(
    openspecBindingFacade,
    /LEGACY_OPENSPEC_METADATA|isCanonicalDate/u,
  );

  const manifest = JSON.parse(
    read('packages/workflow-engine/package.json'),
  ) as { dependencies?: Record<string, string> };
  assert.equal(
    manifest.dependencies?.['@jigwright/openspec-adapter'],
    'workspace:*',
  );
});
