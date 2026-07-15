import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowError } from '../src/errors.ts';

export const sourceRepositoryRoot = path.resolve(
  import.meta.dirname,
  '../../..',
);

export function createFixtureRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-session-repo-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);

  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName: 'fixture',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
  });
  writeJson(path.join(repository, 'package.json'), {
    name: 'workflow-fixture',
    private: true,
    devDependencies: {
      'fixture-tool': '1.0.0',
    },
  });
  fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n');
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks: {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
    },
  });
  writeJson(path.join(repository, 'workflow/document-policy.json'), {
    schemaVersion: 1,
    enforcementMode: 'enforced',
    documents: {
      'docs/architecture/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
      'docs/features/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
    },
  });

  const changeDirectory = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  addFixtureScripts(repository);
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    'schema: expense-app\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n',
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n',
  );
  writeJson(path.join(changeDirectory, 'guard.json'), {
    schemaVersion: 1,
    changeId: 'demo-change',
    tasks: {
      '1.1': {
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
      },
    },
  });
  fs.writeFileSync(path.join(repository, 'src/.gitkeep'), '');
  installFakeOpenSpec(repository);

  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create fixture']);
  return repository;
}

export function addFixtureScripts(repository: string): void {
  const scriptsDirectory = path.join(repository, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDirectory, 'capture-args.mjs'),
    [
      "import fs from 'node:fs';",
      'const [outputPath, ...arguments_] = process.argv.slice(2);',
      'fs.writeFileSync(',
      '  outputPath,',
      '  JSON.stringify({ cwd: process.cwd(), arguments: arguments_ }),',
      ');',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'write-file.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.argv[2], 'ran');",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'pass.mjs'),
    'process.exit(0);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'fail.mjs'),
    'process.exit(7);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'remove-file.mjs'),
    ["import fs from 'node:fs';", 'fs.rmSync(process.argv[2]);', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'mutate-self.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(import.meta.filename, "\\n");',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'overflow.mjs'),
    "process.stdout.write('x'.repeat(11 * 1024 * 1024));\n",
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.writeFileSync(process.argv[2], process.argv[3]);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'chmod-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.chmodSync(process.argv[2], 0o755);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-preserve-times.mjs'),
    [
      "import fs from 'node:fs';",
      'const targetPath = process.argv[2];',
      'const before = fs.statSync(targetPath);',
      'fs.writeFileSync(targetPath, process.argv[3]);',
      'fs.utimesSync(targetPath, before.atime, before.mtime);',
      '',
    ].join('\n'),
  );
}

export function addFixturePackage(
  repository: string,
  source = 'process.exit(0);\n',
): void {
  const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: 'fixture-tool',
    version: '1.0.0',
    exports: { '.': './index.mjs' },
    bin: './bin/run.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'bin/run.mjs'), source);
}

export function configureChecks(
  repository: string,
  checks: Record<string, { command: string[]; destructiveDatabase: boolean }>,
  requiredChecks: string[],
): void {
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks,
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
  guard.tasks['1.1'].requiredChecks = requiredChecks;
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure fixture checks']);
}

export function installFakeOpenSpec(repository: string): void {
  fs.mkdirSync(path.join(repository, 'openspec'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'openspec/config.yaml'),
    path.join(repository, 'openspec/config.yaml'),
  );
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/expense-app'),
    path.join(repository, 'openspec/schemas/expense-app'),
    { recursive: true },
  );

  const manifestPath = path.join(repository, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.devDependencies['@fission-ai/openspec'] = '1.6.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.cpSync(
    path.join(
      sourceRepositoryRoot,
      'node_modules/@fission-ai/openspec/schemas/spec-driven',
    ),
    path.join(packageDirectory, 'schemas/spec-driven'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@fission-ai/openspec',
        version: '1.6.0',
        type: 'module',
        bin: { openspec: './bin/openspec.js' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    `import './runtime-helper.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[2] === '--version') {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'schema') {
  const operation = process.argv[3];
  const schemaName = process.argv[4];
  const root = process.cwd();
  const packageRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const schemaPath = schemaName === 'spec-driven'
    ? path.join(packageRoot, 'schemas/spec-driven')
    : path.join(root, 'openspec/schemas/expense-app');
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify(operation === 'which'
    ? {
        name: schemaName,
        source: schemaName === 'spec-driven' ? 'package' : 'project',
        path: schemaPath,
        shadows: []
      }
    : { name: schemaName, path: schemaPath, valid: true, issues: [] }
  ));
  process.exit(0);
}
if (process.argv[2] === 'status') {
  const changeId = process.argv[4];
  const schemaName = process.argv[6];
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const gitDirectory = path.join(root, '.git');
  const lifecycleMutation = path.join(gitDirectory, 'mutate-on-lifecycle-start');
  const operationLock = path.join(
    gitDirectory,
    'workflow-engine/operations/repository-lifecycle.lock'
  );
  const checkMutation = path.join(gitDirectory, 'mutate-on-next-status');
  const statusCountdown = path.join(gitDirectory, 'mutate-status-countdown');
  if (fs.existsSync(lifecycleMutation) && fs.existsSync(operationLock)) {
    fs.rmSync(lifecycleMutation);
    fs.writeFileSync(path.join(root, 'src/injected.ts'), 'export const injected = true;\\n');
  } else if (fs.existsSync(checkMutation)) {
    fs.rmSync(checkMutation);
    fs.writeFileSync(path.join(root, 'src/feature.ts'), 'export const injected = true;\\n');
  } else if (fs.existsSync(statusCountdown)) {
    const remaining = Number(fs.readFileSync(statusCountdown, 'utf8'));
    if (remaining <= 1) {
      fs.rmSync(statusCountdown);
      fs.appendFileSync(path.join(changeRoot, 'proposal.md'), '\\nPost-stage mutation.\\n');
    } else {
      fs.writeFileSync(statusCountdown, String(remaining - 1));
    }
  }
  const artifacts = [
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')]],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')]],
    ['specs', 'specs/**/*.md', [path.join(changeRoot, 'specs/demo/spec.md')]],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')]],
    ['guard', 'guard.json', [path.join(changeRoot, 'guard.json')]]
  ];
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    schemaName,
    changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'spec-driven'
    },
    artifactPaths: Object.fromEntries(artifacts.map(([id, outputPath, existingOutputPaths]) => [
      id,
      {
        outputPath,
        resolvedOutputPath: path.join(changeRoot, outputPath),
        existingOutputPaths
      }
    ])),
    artifacts: artifacts.map(([id, outputPath]) => ({
      id, outputPath, status: 'done'
    })),
    applyRequires: ['tasks', 'guard'],
    isComplete: true,
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'archive') {
  const changeId = process.argv[3];
  const expected = ['archive', changeId, '--yes', '--json'];
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
    process.stderr.write('unexpected archive argv');
    process.exit(2);
  }
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const deltaRoot = path.join(changeRoot, 'specs');
  const marker = fs.readFileSync(
    path.join(deltaRoot, 'demo/spec.md'),
    'utf8'
  );
  const baseSpec = path.join(root, 'openspec/specs/demo/spec.md');
  fs.mkdirSync(path.dirname(baseSpec), { recursive: true });
  fs.writeFileSync(
    baseSpec,
    '# Demo Specification\\n\\n## Requirements\\n\\n### Requirement: Demo\\nThe system SHALL provide a demo.\\n'
  );
  if (marker.includes('PARTIAL_FAILURE')) {
    process.stdout.write(JSON.stringify({
      archive: null,
      root: { path: root, source: 'nearest' },
      status: [{ code: 'archive_spec_update_failed' }]
    }));
    process.exit(1);
  }
  const archiveName = new Date().toISOString().slice(0, 10) + '-' + changeId;
  const archivePath = path.join(root, 'openspec/changes/archive', archiveName);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.renameSync(changeRoot, archivePath);
  if (marker.includes('ARCHIVE_UNEXPECTED')) {
    fs.writeFileSync(path.join(root, 'unexpected.txt'), 'unexpected\\n');
  }
  process.stdout.write(JSON.stringify({
    archive: {
      change: changeId,
      archivedAs: archiveName,
      path: marker.includes('ARCHIVE_ESCAPE')
        ? path.join(root, '..', 'escape')
        : archivePath,
      specsUpdated: true,
      totals: { added: 1, modified: 0, removed: 0, renamed: 0 }
    },
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'validate' && process.argv.includes('--specs')) {
  process.stdout.write(JSON.stringify({
    items: [{ id: 'demo', type: 'spec', valid: true, issues: [], durationMs: 1 }],
    summary: {
      totals: { items: 1, passed: 1, failed: 0 },
      byType: { spec: { items: 1, passed: 1, failed: 0 } }
    },
    version: '1.0',
    root: { path: process.cwd(), source: 'nearest' }
  }));
  process.exit(0);
}
const changeId = process.argv[3];
const changeRoot = path.join(process.cwd(), 'openspec/changes', changeId);
const invalid = fs.readFileSync(path.join(changeRoot, 'proposal.md'), 'utf8')
  .includes('INVALID');
const passed = invalid ? 0 : 1;
const failed = invalid ? 1 : 0;
process.stdout.write(JSON.stringify({
  items: [{
    id: changeId,
    type: 'change',
    valid: !invalid,
    issues: invalid
      ? [{ level: 'ERROR', path: 'proposal.md', message: 'invalid fixture' }]
      : [],
    durationMs: 1
  }],
  summary: {
    totals: { items: 1, passed, failed },
    byType: { change: { items: 1, passed, failed } }
  },
  version: '1.0',
  root: { path: process.cwd(), source: 'nearest' }
}));
process.exitCode = invalid ? 1 : 0;
`,
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/runtime-helper.js'),
    'export const fixtureRuntime = true;\n',
  );
}

export function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runtimeRoot(repository: string): string {
  return path.join(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
  );
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
