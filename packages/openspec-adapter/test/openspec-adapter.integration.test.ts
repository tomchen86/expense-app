import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  evaluatePlanningProvider,
  planningProviderResultDigest,
} from '@jigwright/core/planning-provider-port';
import type {
  PlanningProviderBindingReaderPort,
  PlanningProviderBindingV1,
} from '@jigwright/core/planning-provider-binding';
import {
  createOpenSpecPlanningProviderPortV1,
  OpenSpecAdapterError,
  type OpenSpecPlanningNativeV1,
} from '../src/planning-provider.ts';
import { createOpenSpecProviderBindingResolverV1 } from '../src/provider-binding.ts';

const REPOSITORY = '/fixture/repository';
const CHANGE_ID = 'demo-change';
const PROVIDER_REQUIREMENT = Object.freeze({
  package: '@fission-ai/openspec',
  version: '1.6.0',
});
const BINDING: PlanningProviderBindingV1 = Object.freeze({
  schemaVersion: 1,
  changeId: CHANGE_ID,
  providerId: 'openspec',
  adapterContractVersion: 1,
  providerRequirement: PROVIDER_REQUIREMENT,
  planningRoot: `openspec/changes/${CHANGE_ID}`,
});

test('OpenSpec adapter maps injected native read-only evidence to the public core port', () => {
  const schemaCalls: string[] = [];
  const native: OpenSpecPlanningNativeV1 = {
    whichSchema(name) {
      schemaCalls.push(`which:${name}`);
    },
    validateSchema(name) {
      schemaCalls.push(`validate:${name}`);
    },
    status() {
      return {
        isComplete: false,
        artifacts: [
          { id: 'tasks', status: 'blocked', missingDependencies: ['design'] },
          { id: 'proposal', status: 'done', missingDependencies: [] },
        ],
      };
    },
    validateChange() {
      return {
        valid: false,
        items: [
          {
            issues: [
              { level: 'WARNING', path: 'tasks.md', message: 'later' },
              { level: 'ERROR', path: 'proposal.md', message: 'invalid' },
            ],
          },
        ],
      };
    },
  };
  const installation = Object.freeze({
    providerVersion: '1.6.0',
    lockfileVersion: '9.0',
    lockedVersion: '1.6.0',
    integrity: 'sha512-fixture',
    buildScriptsAllowed: false as const,
  });
  const port = createOpenSpecPlanningProviderPortV1({
    repositoryRoot: REPOSITORY,
    providerRequirement: PROVIDER_REQUIREMENT,
    installation,
    requiredSchemaNames: ['spec-driven', 'expense-app'],
    supportedContractNames: ['spec-driven', 'expense-app', 'expense-app-v2'],
    native,
  });
  const context = {
    repositoryRoot: REPOSITORY,
    planningRoot: `openspec/changes/${CHANGE_ID}`,
    changeId: CHANGE_ID,
    contractName: 'expense-app',
    revision: { kind: 'worktree' as const },
    readOnly: true as const,
  };

  const evaluation = evaluatePlanningProvider(port, context);
  assert.equal(evaluation.change.readiness, 'blocked');
  assert.deepEqual(evaluation.change.blockers, [
    {
      artifactId: 'tasks',
      status: 'blocked',
      missingDependencies: ['design'],
    },
  ]);
  assert.deepEqual(
    evaluation.change.diagnostics.map(
      ({ path: diagnosticPath }) => diagnosticPath,
    ),
    ['proposal.md', 'tasks.md'],
  );
  assert.equal(
    evaluation.installation.installationDigest,
    planningProviderResultDigest('installation', {
      providerId: 'openspec',
      adapterContractVersion: 1,
      package: '@fission-ai/openspec',
      version: '1.6.0',
      lockfileVersion: '9.0',
      lockedVersion: '1.6.0',
      integrity: 'sha512-fixture',
      buildScriptsAllowed: false,
    }),
  );
  assert.deepEqual(schemaCalls, [
    'which:spec-driven',
    'validate:spec-driven',
    'which:expense-app',
    'validate:expense-app',
    'which:spec-driven',
    'validate:spec-driven',
    'which:expense-app',
    'validate:expense-app',
  ]);

  assert.throws(
    () => port.inspectChange({ ...context, planningRoot: 'other/change' }),
    (error) =>
      error instanceof OpenSpecAdapterError &&
      error.code === 'PLANNING_PROVIDER_CONTEXT_INVALID',
  );
});

test('OpenSpec binding resolver preserves explicit and legacy evidence and refuses migration', () => {
  const resolver = createOpenSpecProviderBindingResolverV1({
    providerRequirement: PROVIDER_REQUIREMENT,
    bindingSchemaPath: 'workflow/schemas/planning-provider-binding.schema.json',
    bindingArtifactPath: (changeId) =>
      `workflow/change-providers/${changeId}.json`,
    legacySchemaNames: ['expense-app', 'expense-app-v2'],
  });
  const state: {
    current: PlanningProviderBindingV1 | null;
    pinned: Map<string, PlanningProviderBindingV1 | null>;
    evidence: Map<string, Uint8Array | null>;
    activated: Set<string>;
  } = {
    current: BINDING,
    pinned: new Map(),
    evidence: new Map(),
    activated: new Set(),
  };
  const reader: PlanningProviderBindingReaderPort = {
    readCurrent: () => state.current,
    readPinnedBinding: (_root, commit) => state.pinned.get(commit) ?? null,
    readPinnedEvidenceFile: (_root, commit) =>
      state.evidence.get(commit) ?? null,
    pinnedHistoryContainsPath: (_root, commit) => state.activated.has(commit),
  };

  assert.deepEqual(
    resolver.resolveCurrent(reader, REPOSITORY, 'openspec/changes', CHANGE_ID),
    {
      binding: BINDING,
      source: 'explicit',
      artifactPath: 'workflow/change-providers/demo-change.json',
      bindingDigest:
        'c154dbbb019ac77bae1fec0215599655d4a617ead3d015644c45ff2400abee95',
    },
  );

  state.current = null;
  state.evidence.set(
    'legacy',
    new TextEncoder().encode('schema: spec-driven\n'),
  );
  assert.equal(
    resolver.resolveHistorical(
      reader,
      REPOSITORY,
      'legacy',
      'openspec/changes',
      CHANGE_ID,
    ).source,
    'legacy-inferred',
  );
  state.activated.add('cutover');
  assert.throws(
    () =>
      resolver.resolveHistorical(
        reader,
        REPOSITORY,
        'cutover',
        'openspec/changes',
        CHANGE_ID,
      ),
    (error) =>
      error instanceof OpenSpecAdapterError &&
      error.code === 'PROVIDER_BINDING_MISSING',
  );

  state.current = Object.freeze({ ...BINDING, providerId: 'other-provider' });
  assert.throws(
    () =>
      resolver.resolveCurrent(
        reader,
        REPOSITORY,
        'openspec/changes',
        CHANGE_ID,
      ),
    (error) =>
      error instanceof OpenSpecAdapterError &&
      error.code === 'PROVIDER_BINDING_MISMATCH',
  );

  state.current = Object.freeze({
    ...BINDING,
    providerRequirement: Object.freeze({
      ...PROVIDER_REQUIREMENT,
      version: '2.0.0',
    }),
  });
  state.pinned.set('parent', BINDING);
  assert.throws(
    () =>
      resolver.resolveCurrentTransition(
        reader,
        REPOSITORY,
        'parent',
        'openspec/changes',
        CHANGE_ID,
        'revision',
      ),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'PROVIDER_MIGRATION_UNSUPPORTED',
  );
});

test('@jigwright/openspec-adapter has one-way public package dependencies', () => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    name: string;
    dependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };
  assert.equal(manifest.name, '@jigwright/openspec-adapter');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
    '@jigwright/core',
  ]);
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [
    '.',
    './planning-provider',
    './provider-binding',
  ]);

  for (const file of fs.readdirSync(path.join(packageRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(packageRoot, 'src', file), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
      const specifier = match[1]!;
      assert.equal(
        /workflow-engine|expense-app/iu.test(specifier),
        false,
        `${file} imports forbidden consumer authority ${specifier}`,
      );
      assert.equal(
        specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@jigwright/core/'),
        true,
        `${file} imports undeclared package ${specifier}`,
      );
    }
  }
});
