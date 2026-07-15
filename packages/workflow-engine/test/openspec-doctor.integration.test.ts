import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diagnoseOpenSpec } from '../src/openspec-doctor.ts';
import { parseDoctor } from '../src/openspec-doctor-payload.ts';
import { isWorkflowError, sourceRepositoryRoot } from './fixture.ts';

test('OpenSpec doctor validates payload health instead of trusting exit zero', () => {
  const unhealthy = parseDoctor(
    {
      root: {
        path: sourceRepositoryRoot,
        source: 'nearest',
        healthy: false,
        status: [
          {
            severity: 'error',
            code: 'openspec_config_missing',
            message: 'Missing openspec/config.yaml or openspec/config.yml.',
            target: 'openspec.config',
          },
        ],
      },
      store: null,
      references: [],
      status: [],
    },
    sourceRepositoryRoot,
    0,
  );

  assert.equal(unhealthy.resolved, true);
  assert.equal(unhealthy.healthy, false);
  assert.deepEqual(
    unhealthy.diagnostics.map(({ code }) => code),
    ['openspec_config_missing'],
  );
});

test('OpenSpec doctor rejects stores, external roots, and exit/payload drift', () => {
  const healthyRoot = {
    path: sourceRepositoryRoot,
    source: 'nearest',
    healthy: true,
    status: [],
  };
  const cases: Array<{ value: unknown; status: number }> = [
    {
      value: {
        root: { ...healthyRoot, path: path.dirname(sourceRepositoryRoot) },
        store: null,
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: { ...healthyRoot, store_id: 'shadow-store' },
        store: {
          id: 'shadow-store',
          metadata: { present: true, valid: true },
          status: [],
        },
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: null,
        store: null,
        references: [],
        status: [
          {
            severity: 'error',
            code: 'no_openspec_root',
            message: 'No OpenSpec root found.',
          },
        ],
      },
      status: 0,
    },
    {
      value: {
        root: healthyRoot,
        store: null,
        references: [],
        status: [],
      },
      status: 1,
    },
    {
      value: {
        root: {
          ...healthyRoot,
          status: [
            {
              severity: 'error',
              code: 'openspec_config_missing',
              message: 'Missing openspec/config.yaml or openspec/config.yml.',
              target: 'openspec.config',
            },
          ],
        },
        store: null,
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: { ...healthyRoot, healthy: false },
        store: null,
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: healthyRoot,
        store: null,
        references: [],
        status: [
          {
            severity: 'warning',
            code: 'unknown_relationship_warning',
            message: 'Unknown warning.',
            target: 'relationships',
          },
        ],
      },
      status: 0,
    },
    {
      value: {
        root: healthyRoot,
        store: null,
        references: [
          {
            store_id: 'external-store',
            root: 'relative-external-store',
            status: [],
          },
        ],
        status: [],
      },
      status: 0,
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => parseDoctor(fixture.value, sourceRepositoryRoot, fixture.status),
      (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
    );
  }
});

test('OpenSpec doctor accepts the pinned exit-one diagnostic envelope', () => {
  const result = parseDoctor(
    {
      root: null,
      store: null,
      references: [],
      status: [
        {
          severity: 'error',
          code: 'no_openspec_root',
          message: 'No OpenSpec root found.',
          target: 'openspec.root',
          fix: 'Run openspec init.',
        },
      ],
    },
    sourceRepositoryRoot,
    1,
  );

  assert.equal(result.resolved, false);
  assert.equal(result.healthy, false);
  assert.equal(result.root, null);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ['no_openspec_root'],
  );
});

test('OpenSpec doctor reports a canonical resolved reference as outside policy', () => {
  const referenceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-reference-')),
  );
  try {
    const result = parseDoctor(
      {
        root: {
          path: sourceRepositoryRoot,
          source: 'nearest',
          healthy: true,
          status: [],
        },
        store: null,
        references: [
          { store_id: 'shared-specs', root: referenceRoot, status: [] },
        ],
        status: [],
      },
      sourceRepositoryRoot,
      0,
    );

    assert.equal(result.root?.healthy, true);
    assert.equal(result.healthy, false);
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['OPENSPEC_REFERENCE_STORE_REJECTED'],
    );
  } finally {
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics report package provenance and semantic failures', () => {
  const repository = createDoctorFixture();
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.expectedVersion, '1.6.0');
    assert.equal(report.healthy, false);
    assert.deepEqual(report.installation, {
      ok: true,
      packageName: '@fission-ai/openspec',
      declaredVersion: '1.6.0',
      lockfileVersion: '9.0',
      lockedVersion: '1.6.0',
      integrity:
        'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==',
      buildScriptsAllowed: false,
      installedVersion: '1.6.0',
      packageDirectory: path.join(
        repository,
        'node_modules/@fission-ai/openspec',
      ),
      binPath: path.join(
        repository,
        'node_modules/@fission-ai/openspec/bin/openspec.js',
      ),
    });
    assert.deepEqual(report.runtime, { ok: true, version: '1.6.0' });
    assert.deepEqual(report.root, {
      ok: false,
      path: repository,
      source: 'nearest',
      healthy: false,
      storeActive: false,
    });
    assert.deepEqual(report.schemas, [
      {
        name: 'spec-driven',
        expectedSource: 'package',
        ok: false,
        resolution: {
          source: 'package',
          path: path.join(
            repository,
            'node_modules/@fission-ai/openspec/schemas/spec-driven',
          ),
        },
        validation: { valid: false, issueCount: 1 },
      },
    ]);
    assert.deepEqual(
      report.diagnostics.map(({ code }) => code),
      ['openspec_config_missing', 'OPENSPEC_SCHEMA_INVALID'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics preserve an observed runtime version mismatch', () => {
  const repository = createDoctorFixture('1.7.0');
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.healthy, false);
    assert.deepEqual(report.runtime, { ok: false, version: '1.7.0' });
    assert.deepEqual(
      report.diagnostics.map(({ code }) => code),
      ['OPENSPEC_RUNTIME_DIAGNOSTIC_FAILED'],
    );
    assert.equal(report.diagnostics[0]?.causeCode, 'OPENSPEC_VERSION_MISMATCH');
    assert.equal(report.root.path, null);
    assert.equal(report.schemas[0]?.resolution, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics reject a symlinked package schema', () => {
  const repository = createDoctorFixture();
  const externalSchema = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-schema-')),
  );
  const schemaPath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/schemas/spec-driven',
  );
  fs.rmSync(schemaPath, { recursive: true, force: true });
  fs.symlinkSync(externalSchema, schemaPath, 'dir');
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.healthy, false);
    assert.equal(report.schemas[0]?.resolution, null);
    assert.equal(report.schemas[0]?.validation, null);
    assert.deepEqual(
      report.diagnostics.slice(-2).map(({ code, causeCode }) => ({
        code,
        causeCode,
      })),
      [
        {
          code: 'OPENSPEC_SCHEMA_RESOLUTION_DIAGNOSTIC_FAILED',
          causeCode: 'OPENSPEC_PATH_UNSAFE',
        },
        {
          code: 'OPENSPEC_SCHEMA_VALIDATION_DIAGNOSTIC_FAILED',
          causeCode: 'OPENSPEC_PATH_UNSAFE',
        },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(externalSchema, { recursive: true, force: true });
  }
});

test('real workflow doctor reports the pinned local OpenSpec installation', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'packages/workflow-engine/src/cli.ts',
      'doctor',
      '--json',
    ],
    {
      cwd: sourceRepositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const result = JSON.parse(output) as Record<string, unknown>;
  const openspec = result.openspec as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(openspec.expectedVersion, '1.6.0');
  assert.equal(openspec.healthy, true);
  assert.deepEqual(openspec.runtime, { ok: true, version: '1.6.0' });
  assert.deepEqual(openspec.diagnostics, []);
});

function createDoctorFixture(runtimeVersion = '1.6.0'): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-doctor-')),
  );
  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageDirectory, 'schemas/spec-driven'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repository, 'openspec/changes'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'openspec/specs'), { recursive: true });
  writeJson(path.join(repository, 'package.json'), {
    name: 'doctor-fixture',
    private: true,
    devDependencies: { '@fission-ai/openspec': '1.6.0' },
  });
  fs.writeFileSync(
    path.join(repository, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - 'packages/*'",
      '',
      'allowBuilds:',
      "  '@fission-ai/openspec': false",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@fission-ai/openspec':",
      '        specifier: 1.6.0',
      '        version: 1.6.0',
      '',
      'packages:',
      '',
      "  '@fission-ai/openspec@1.6.0':",
      '    resolution: {integrity: sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      "  '@fission-ai/openspec@1.6.0': {}",
      '',
    ].join('\n'),
  );
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: '@fission-ai/openspec',
    version: '1.6.0',
    type: 'module',
    bin: { openspec: './bin/openspec.js' },
  });
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    `const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`${runtimeVersion}\n`)});
} else if (args[0] === 'doctor') {
  process.stdout.write(JSON.stringify({
    root: {
      path: process.cwd(), source: 'nearest', healthy: false,
      status: [{
        severity: 'error', code: 'openspec_config_missing',
        message: 'Missing openspec/config.yaml or openspec/config.yml.',
        target: 'openspec.config'
      }]
    },
    store: null, references: [], status: []
  }));
} else if (args[0] === 'schema' && args[1] === 'which') {
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify({
    name: args[2], source: 'package',
    path: new URL('../schemas/spec-driven', import.meta.url).pathname,
    shadows: []
  }));
} else if (args[0] === 'schema' && args[1] === 'validate') {
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify({
    name: args[2],
    path: new URL('../schemas/spec-driven', import.meta.url).pathname,
    valid: false,
    issues: [{
      level: 'error', path: 'schema.yaml', message: 'invalid fixture schema'
    }]
  }));
}
`,
  );
  return repository;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
