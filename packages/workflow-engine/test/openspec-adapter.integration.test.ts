import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createOpenSpecAdapter,
  resolveOpenSpecInstallation,
} from '../src/openspec-adapter.ts';
import { parseInstructions } from '../src/openspec-payloads.ts';
import { isWorkflowError, sourceRepositoryRoot } from './fixture.ts';

test('repository base specs satisfy pinned strict validation', () => {
  const validation =
    createOpenSpecAdapter(sourceRepositoryRoot).validateAllSpecs();

  assert.equal(validation.valid, true);
});

test('OpenSpec adapter pins argv, cwd, environment, and temporary homes', () => {
  const capturePath = path.join(
    os.tmpdir(),
    `openspec-adapter-capture-${process.pid}.json`,
  );
  const repository = createFakeOpenSpecRepository(`
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args,
  cwd: process.cwd(),
  environment: Object.fromEntries([
    'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME',
    'TMPDIR', 'TMP', 'TEMP', 'CI',
    'OPENSPEC_TELEMETRY', 'DO_NOT_TRACK', 'OPENSPEC_NO_COMPLETIONS',
    'NO_COLOR', 'PATH', 'NODE_OPTIONS', 'PRIVATE_TOKEN'
  ].map((key) => [key, process.env[key]])),
}));
if (args[0] === '--version') {
  process.stdout.write('1.6.0\\n');
} else if (args[0] === 'doctor') {
  process.stdout.write(JSON.stringify({
    root: {
      path: process.cwd(), source: 'nearest', healthy: true, status: []
    },
    store: null, references: [], status: []
  }));
} else {
  process.stdout.write(JSON.stringify({
    changes: [{
      name: 'demo-change', completedTasks: 0, totalTasks: 1,
      lastModified: '2026-01-01T00:00:00.000Z', status: 'in-progress'
    }],
    root: { path: process.cwd(), source: 'nearest' }
  }));
}
`);
  const attackerTemporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-openspec-attacker-tmp-'),
  );
  const previousTemporaryDirectory = process.env.TMPDIR;
  try {
    process.env.TMPDIR = attackerTemporaryDirectory;
    const adapter = createOpenSpecAdapter(repository, {
      environment: {
        ...process.env,
        PATH: '/tmp/attacker-bin',
        NODE_OPTIONS: '--require=/tmp/inject.cjs',
        PRIVATE_TOKEN: 'must-not-leak',
      },
    });
    assert.equal(adapter.version(), '1.6.0');
    assert.deepEqual(adapter.listChanges().changes, [
      {
        name: 'demo-change',
        completedTasks: 0,
        totalTasks: 1,
        status: 'in-progress',
      },
    ]);

    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(capture.args, [
      'list',
      '--changes',
      '--sort',
      'name',
      '--json',
    ]);
    assert.equal(capture.cwd, fs.realpathSync(repository));
    assert.equal(capture.environment.CI, 'true');
    assert.equal(capture.environment.OPENSPEC_TELEMETRY, '0');
    assert.equal(capture.environment.DO_NOT_TRACK, '1');
    assert.equal(capture.environment.OPENSPEC_NO_COMPLETIONS, '1');
    assert.equal(capture.environment.NO_COLOR, '1');
    assert.equal(capture.environment.NODE_OPTIONS, undefined);
    assert.equal(capture.environment.PRIVATE_TOKEN, undefined);
    assert.doesNotMatch(capture.environment.PATH, /attacker-bin/);
    assert.equal(
      isInside(attackerTemporaryDirectory, capture.environment.HOME),
      false,
    );
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'CODEX_HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
    ]) {
      assert.equal(fs.existsSync(capture.environment[key]), false, key);
    }

    const doctor = adapter.doctor();
    assert.equal(doctor.healthy, true);
    const doctorCapture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(doctorCapture.args, ['doctor', '--json']);
    assert.equal(doctorCapture.cwd, fs.realpathSync(repository));
    assert.equal(doctorCapture.environment.CI, 'true');
    assert.equal(doctorCapture.environment.OPENSPEC_TELEMETRY, '0');
    assert.equal(doctorCapture.environment.NODE_OPTIONS, undefined);
    assert.equal(doctorCapture.environment.PRIVATE_TOKEN, undefined);
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'CODEX_HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
    ]) {
      assert.equal(fs.existsSync(doctorCapture.environment[key]), false, key);
    }
  } finally {
    if (previousTemporaryDirectory === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTemporaryDirectory;
    }
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(capturePath, { force: true });
    fs.rmSync(attackerTemporaryDirectory, { recursive: true, force: true });
  }
});

test('OpenSpec adapter accepts only the exact installed 1.6.0 package', () => {
  for (const candidate of [
    { declared: '^1.6.0', installed: '1.6.0' },
    { declared: '1.6.0', installed: '1.7.0' },
  ]) {
    const repository = createFakeOpenSpecRepository(
      "process.stdout.write('1.6.0\\n');",
      candidate,
    );
    try {
      assert.throws(
        () => resolveOpenSpecInstallation(repository),
        (error) => isWorkflowError(error, 'OPENSPEC_INSTALLATION_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('OpenSpec adapter requires the exact lock provenance and denied build script', () => {
  const cases = [
    {
      file: 'pnpm-workspace.yaml',
      from: "  '@fission-ai/openspec': false",
      to: "  '@fission-ai/openspec': true",
    },
    {
      file: 'pnpm-lock.yaml',
      from: '        specifier: 1.6.0',
      to: '        specifier: ^1.6.0',
    },
    {
      file: 'pnpm-lock.yaml',
      from: '    resolution: {integrity: sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==}',
      to: '    resolution: {integrity: sha512-tampered}',
    },
    {
      file: 'pnpm-lock.yaml',
      from: "  '@fission-ai/openspec@1.6.0': {}",
      to: "  '@fission-ai/openspec@1.7.0': {}",
    },
  ];

  for (const fixture of cases) {
    const repository = createFakeOpenSpecRepository(
      "process.stdout.write('1.6.0\\n');",
    );
    const filePath = path.join(repository, fixture.file);
    try {
      const before = fs.readFileSync(filePath, 'utf8');
      assert.match(before, new RegExp(escapeRegExp(fixture.from)));
      fs.writeFileSync(filePath, before.replace(fixture.from, fixture.to));
      assert.throws(
        () => resolveOpenSpecInstallation(repository),
        (error) => isWorkflowError(error, 'OPENSPEC_INSTALLATION_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('OpenSpec adapter probes the runtime version before exposing operations', () => {
  const repository = createFakeOpenSpecRepository(
    "process.stdout.write('{}');",
    { declared: '1.6.0', installed: '1.6.0', runtime: '1.7.0' },
  );
  try {
    assert.throws(
      () => createOpenSpecAdapter(repository),
      (error) => isWorkflowError(error, 'OPENSPEC_VERSION_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('OpenSpec adapter rejects an exit-zero schema result with valid false', () => {
  const repository = createFakeOpenSpecRepository(`
const args = process.argv.slice(2);
if (args[0] === 'schema' && args[1] === 'validate') {
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify({
    name: args[2],
    path: new URL('../schemas/spec-driven', import.meta.url).pathname,
    valid: false,
    issues: [{
      level: 'error', path: 'schema.yaml', message: 'invalid fixture schema'
    }]
  }));
} else if (args[0] === 'schema' && args[1] === 'which') {
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify({
    name: args[2], source: 'package',
    path: new URL('../schemas/spec-driven', import.meta.url).pathname,
    shadows: []
  }));
}
`);
  try {
    const adapter = createOpenSpecAdapter(repository);
    assert.equal(adapter.whichSchema('spec-driven').source, 'package');
    assert.throws(
      () => adapter.validateSchema('spec-driven'),
      (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('OpenSpec adapter rejects schema payload extras and validity contradictions', () => {
  const cases = [
    {
      body: `
process.stderr.write('Note: Schema commands are experimental and may change.\\n');
process.stdout.write(JSON.stringify({
  name: process.argv[4], source: 'package',
  path: new URL('../schemas/spec-driven', import.meta.url).pathname,
  shadows: [], unexpected: true
}));
`,
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.whichSchema('spec-driven'),
    },
    {
      body: `
process.stderr.write('Note: Schema commands are experimental and may change.\\n');
process.stdout.write(JSON.stringify({
  name: process.argv[4], source: 'package',
  path: new URL('../schemas/spec-driven', import.meta.url).pathname,
  shadows: ['/tmp/shadowed-schema']
}));
`,
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.whichSchema('spec-driven'),
    },
    {
      body: `
process.stderr.write('Note: Schema commands are experimental and may change.\\n');
process.stdout.write(JSON.stringify({
  name: process.argv[4],
  path: new URL('../schemas/spec-driven', import.meta.url).pathname,
  valid: true,
  issues: [{ level: 'error', path: 'schema.yaml', message: 'contradiction' }]
}));
`,
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.validateSchema('spec-driven'),
    },
  ];

  for (const fixture of cases) {
    const repository = createFakeOpenSpecRepository(fixture.body);
    try {
      assert.throws(
        () => fixture.invoke(createOpenSpecAdapter(repository)),
        (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('OpenSpec adapter rejects ambiguous output, stderr drift, and external roots', () => {
  const cases = [
    {
      body: 'process.stdout.write(\'prefix\\n{"changes":[]}\');',
      code: 'OPENSPEC_OUTPUT_INVALID',
    },
    {
      body: "process.stderr.write('warning\\n'); process.stdout.write('{}');",
      code: 'OPENSPEC_STDERR_REJECTED',
    },
    {
      body: `process.stdout.write(JSON.stringify({
        changes: [], root: { path: '/tmp/external', source: 'nearest' }
      }));`,
      code: 'OPENSPEC_PAYLOAD_INVALID',
    },
  ];
  for (const fixture of cases) {
    const repository = createFakeOpenSpecRepository(fixture.body);
    try {
      assert.throws(
        () => createOpenSpecAdapter(repository).listChanges(),
        (error) => isWorkflowError(error, fixture.code),
        fixture.code,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('OpenSpec adapter rejects symlinked validation targets', () => {
  const cases = [
    {
      target: 'openspec/changes/demo-change',
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.validateChange('demo-change'),
    },
    {
      target: 'openspec/specs',
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.validateAllSpecs(),
    },
  ];
  for (const fixture of cases) {
    const external = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-openspec-external-'),
    );
    const repository = createFakeOpenSpecRepository(`
const type = process.argv.includes('--specs') ? 'spec' : 'change';
const id = type === 'spec' ? 'demo-spec' : process.argv[3];
process.stdout.write(JSON.stringify({
  items: [{ id, type, valid: true, issues: [], durationMs: 1 }],
  summary: { totals: { items: 1, passed: 1, failed: 0 } },
  version: '1.6.0',
  root: { path: process.cwd(), source: 'nearest' }
    }));
`);
    const target = path.join(repository, fixture.target);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(external, target, 'dir');
    try {
      assert.throws(
        () => fixture.invoke(createOpenSpecAdapter(repository)),
        (error) => isWorkflowError(error, 'OPENSPEC_PATH_UNSAFE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  }
});

test('OpenSpec adapter rejects pinned payload cross-field drift', () => {
  const cases = [
    {
      body: `
const id = process.argv[3];
process.stdout.write(JSON.stringify({
  items: [{ id, type: 'change', valid: true, issues: [], durationMs: 1 }],
  summary: {
    totals: { items: 1, passed: 1, failed: 0 },
    byType: { change: { items: 1, passed: 1, failed: 0 } }
  },
  version: '2.0',
  root: { path: process.cwd(), source: 'nearest' }
}));
`,
      prepare: (repository: string) =>
        fs.mkdirSync(path.join(repository, 'openspec/changes/demo-change')),
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.validateChange('demo-change'),
    },
    {
      body: `
const root = process.cwd();
const changeRoot = root + '/openspec/changes/demo-change';
process.stdout.write(JSON.stringify({
  changeName: 'demo-change', schemaName: 'spec-driven', changeRoot,
  planningHome: {
    kind: 'repo', root, changesDir: root + '/openspec/changes',
    defaultSchema: 'shadowed-schema'
  },
  artifactPaths: {}, artifacts: [], applyRequires: [], isComplete: true,
  root: { path: root, source: 'nearest' }
}));
`,
      prepare: (repository: string) =>
        fs.mkdirSync(path.join(repository, 'openspec/changes/demo-change')),
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.status('demo-change', 'spec-driven'),
    },
    {
      body: `
const root = process.cwd();
const changeRoot = root + '/openspec/changes/demo-change';
process.stdout.write(JSON.stringify({
  changeName: 'demo-change', schemaName: 'spec-driven', changeRoot,
  planningHome: {
    kind: 'repo', root, changesDir: root + '/openspec/changes',
    defaultSchema: 'spec-driven'
  },
  artifactPaths: {}, artifacts: [], applyRequires: [], isComplete: true,
  root: { path: root, source: 'nearest' }
}));
`,
      prepare: (repository: string) =>
        fs.mkdirSync(path.join(repository, 'openspec/changes/demo-change')),
      invoke: (adapter: ReturnType<typeof createOpenSpecAdapter>) =>
        adapter.status('demo-change', 'spec-driven'),
    },
  ];
  for (const fixture of cases) {
    const repository = createFakeOpenSpecRepository(fixture.body);
    fixture.prepare(repository);
    try {
      assert.throws(
        () => fixture.invoke(createOpenSpecAdapter(repository)),
        (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('OpenSpec payloads reject artifact output path aliases', () => {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-payload-')),
  );
  const changeRoot = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeRoot, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(changeRoot, 'tasks.md'), '# Tasks\n');
  try {
    assert.throws(
      () =>
        parseInstructions(
          {
            changeName: 'demo-change',
            artifactId: 'specs',
            schemaName: 'spec-driven',
            changeDir: changeRoot,
            planningHome: {
              kind: 'repo',
              root: repository,
              changesDir: path.join(repository, 'openspec/changes'),
              defaultSchema: 'spec-driven',
            },
            outputPath: 'specs/**/*.md',
            resolvedOutputPath: path.join(changeRoot, 'specs/**/*.md'),
            existingOutputPaths: [
              path.join(changeRoot, 'specs', '..', 'tasks.md'),
            ],
            instruction: 'Create specifications.',
            template: '# Spec\n',
            dependencies: [],
            unlocks: [],
            root: { path: repository, source: 'nearest' },
          },
          {
            repositoryRoot: repository,
            changeId: 'demo-change',
            schemaName: 'spec-driven',
            artifactId: 'specs',
          },
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('OpenSpec adapter bounds execution time and output', () => {
  const cases = [
    {
      body: "setTimeout(() => process.stdout.write('{}'), 2000);",
      options: { timeoutMs: 20 },
      code: 'OPENSPEC_TIMEOUT',
    },
    {
      body: "process.stdout.write('x'.repeat(4096));",
      options: { maxOutputBytes: 128 },
      code: 'OPENSPEC_OUTPUT_LIMIT',
    },
  ];
  for (const fixture of cases) {
    const repository = createFakeOpenSpecRepository(fixture.body);
    try {
      assert.throws(
        () => createOpenSpecAdapter(repository, fixture.options).listChanges(),
        (error) => isWorkflowError(error, fixture.code),
        fixture.code,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('real pinned OpenSpec adapter validates package, schema, status, and change', () => {
  const adapter = createOpenSpecAdapter(sourceRepositoryRoot);
  assert.equal(adapter.version(), '1.6.0');
  const schema = adapter.whichSchema('spec-driven');
  assert.equal(schema.source, 'package');
  assert.equal(adapter.validateSchema('spec-driven').valid, true);
  const projectSchema = adapter.whichSchema('expense-app');
  assert.equal(projectSchema.source, 'project');
  assert.equal(adapter.validateSchema('expense-app').valid, true);
  assert.throws(
    () => adapter.whichSchema('unreviewed-schema'),
    (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_UNSUPPORTED'),
  );
  const fixture = createRealAdapterFixtureRepository();
  try {
    const fixtureAdapter = createOpenSpecAdapter(fixture);
    const status = fixtureAdapter.status(
      'fixture-adapter-change',
      'spec-driven',
    );
    assert.equal(status.changeName, 'fixture-adapter-change');
    assert.equal(status.schemaName, 'spec-driven');
    assert.equal(status.isComplete, true);
    const projectStatus = fixtureAdapter.status(
      'fixture-adapter-change',
      'expense-app',
    );
    assert.deepEqual(projectStatus.applyRequires, ['tasks', 'guard']);
    assert.deepEqual(projectStatus.artifactIds.sort(), [
      'design',
      'guard',
      'proposal',
      'specs',
      'tasks',
    ]);
    assert.equal(
      fixtureAdapter.instructions(
        'fixture-adapter-change',
        'expense-app',
        'guard',
      ).outputPath,
      'guard.json',
    );
    const validation = fixtureAdapter.validateChange('fixture-adapter-change');
    assert.equal(validation.valid, true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createRealAdapterFixtureRepository(): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-real-adapter-')),
  );
  for (const filePath of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'openspec/config.yaml',
  ]) {
    const target = path.join(repository, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRepositoryRoot, filePath), target);
  }
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/expense-app'),
    path.join(repository, 'openspec/schemas/expense-app'),
    { recursive: true },
  );
  const pinnedPackageEntry = path.dirname(
    path.dirname(
      fs.realpathSync(
        path.join(sourceRepositoryRoot, 'node_modules/@fission-ai/openspec'),
      ),
    ),
  );
  fs.cpSync(pinnedPackageEntry, path.join(repository, 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  const changeRoot = path.join(
    repository,
    'openspec/changes/fixture-adapter-change',
  );
  fs.mkdirSync(path.join(changeRoot, 'specs/fixture-adapter-capability'), {
    recursive: true,
  });
  const artifacts: Array<[string, string]> = [
    ['.openspec.yaml', 'schema: expense-app\ncreated: 2026-07-19\n'],
    [
      'proposal.md',
      [
        '## Why',
        '',
        'Synthetic fixture change so the real pinned adapter validates a change',
        'without depending on mutable repository planning state.',
        '',
        '## What Changes',
        '',
        '- Exercise pinned status, instructions, and validation end to end.',
        '',
        '## Capabilities',
        '',
        '### New Capabilities',
        '',
        '- `fixture-adapter-capability`: Synthetic capability used only by the',
        '  adapter integration fixture.',
        '',
        '### Modified Capabilities',
        '',
        'None.',
        '',
        '## Impact',
        '',
        '- Affected systems: none; this change exists only inside a temporary',
        '  test repository.',
        '',
      ].join('\n'),
    ],
    [
      'design.md',
      [
        '## Context',
        '',
        'The adapter integration test needs a schema-valid change fixture.',
        '',
        '## Goals / Non-Goals',
        '',
        '**Goals:**',
        '',
        '- Stay valid under the expense-app schema.',
        '',
        '**Non-Goals:**',
        '',
        '- Represent real product work.',
        '',
        '## Decisions',
        '',
        '### Keep the fixture minimal',
        '',
        'The fixture carries exactly the canonical artifact graph.',
        '',
      ].join('\n'),
    ],
    [
      'tasks.md',
      '## 1. Fixture\n\n- [ ] 1.1 Exercise the pinned adapter end to end.\n',
    ],
    [
      'guard.json',
      `${JSON.stringify(
        {
          schemaVersion: 1,
          changeId: 'fixture-adapter-change',
          tasks: {
            '1.1': {
              allowedPaths: ['package.json'],
              requiredChecks: ['workflow-tests'],
            },
          },
        },
        null,
        2,
      )}\n`,
    ],
    [
      'specs/fixture-adapter-capability/spec.md',
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Fixture capability exists',
        '',
        'The synthetic fixture MUST validate under the expense-app schema.',
        '',
        '#### Scenario: Adapter validates the fixture',
        '',
        '- **WHEN** the pinned adapter validates the fixture change',
        '- **THEN** validation succeeds with no diagnostics',
        '',
      ].join('\n'),
    ],
  ];
  for (const [relativePath, content] of artifacts) {
    fs.writeFileSync(path.join(changeRoot, relativePath), content);
  }
  return repository;
}

function createFakeOpenSpecRepository(
  cliSource: string,
  versions: { declared: string; installed: string; runtime?: string } = {
    declared: '1.6.0',
    installed: '1.6.0',
  },
): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-openspec-adapter-'),
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
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify(
      {
        name: 'adapter-fixture',
        private: true,
        devDependencies: { '@fission-ai/openspec': versions.declared },
      },
      null,
      2,
    )}\n`,
  );
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
      `        specifier: ${versions.declared}`,
      `        version: ${versions.installed}`,
      '',
      'packages:',
      '',
      "  '@fission-ai/openspec@1.6.0':",
      '    resolution: {integrity: sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      `  '@fission-ai/openspec@${versions.installed}': {}`,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@fission-ai/openspec',
        version: versions.installed,
        type: 'module',
        bin: { openspec: './bin/openspec.js' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    `if (process.argv[2] === '--version') {
  process.stdout.write(${JSON.stringify(`${versions.runtime ?? '1.6.0'}\n`)});
  process.exit(0);
}
${cliSource}\n`,
  );
  return repository;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
