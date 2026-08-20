import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  generateBuiltInEngineClosure,
  renderBuiltInEngineClosure,
} from '../bootstrap/generate-built-in-engine-closure.ts';
import { renderHarnessBootstrapRuntime } from '../bootstrap/generate-harness-bootstrap-runtime.ts';

test('built-in closure v2 includes exact workspace runtime dependency sources', (t) => {
  const repository = createWorkspaceClosureFixture(t);
  const rendered = renderBuiltInEngineClosure(repository);
  const manifest = rendered.manifest as unknown as {
    kind: string;
    scope: string;
    packages: Array<{
      name: string;
      sourceRoot: string;
      closureRoot: string;
    }>;
    files: Array<{ path: string }>;
  };

  assert.equal(manifest.kind, 'built-in-engine-closure-manifest.v2');
  assert.equal(manifest.scope, 'workspace-runtime-source-closure');
  assert.deepEqual(manifest.packages, [
    {
      name: '@expense/workflow-engine',
      sourceRoot: 'packages/workflow-engine',
      closureRoot: '.',
    },
    {
      name: '@jigwright/core',
      sourceRoot: 'packages/core',
      closureRoot: 'node_modules/@jigwright/core',
    },
  ]);
  assert.ok(
    manifest.files.some(
      ({ path: filePath }) =>
        filePath === 'node_modules/@jigwright/core/src/fixture-runtime.ts',
    ),
  );
  assert.ok(
    manifest.files.some(
      ({ path: filePath }) =>
        filePath === 'node_modules/@jigwright/core/package.json',
    ),
  );
  assert.ok(
    manifest.files.every(
      ({ path: filePath }) => !filePath.includes('fixture-adapter'),
    ),
  );
});

test('recovery closure keeps stable paths and executes a workspace runtime import', (t) => {
  const repository = createWorkspaceClosureFixture(t);
  generateBuiltInEngineClosure(repository, '--write');
  const rendered = renderHarnessBootstrapRuntime(repository);
  const paths = rendered.runtimeFiles.map(({ path: filePath }) => filePath);

  assert.ok(
    paths.includes('bootstrap/recovery-runtime/src/harness-bootstrap.js'),
  );
  assert.ok(
    paths.includes(
      'bootstrap/recovery-runtime/node_modules/@jigwright/core/src/fixture-runtime.js',
    ),
  );
  assert.ok(
    paths.includes(
      'bootstrap/recovery-runtime/node_modules/@jigwright/core/package.json',
    ),
  );
  assert.ok(
    paths.every((filePath) => !filePath.includes('packages/workflow-engine/')),
  );

  const runtimeRoot = path.join(repository, 'rendered-recovery-runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  for (const file of rendered.runtimeFiles) {
    const relative = file.path.slice('bootstrap/recovery-runtime/'.length);
    const target = path.join(runtimeRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'), {
      mode: file.mode === '100755' ? 0o755 : 0o644,
    });
  }
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(runtimeRoot, 'src/harness-bootstrap.js')],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
      env: { PATH: path.dirname(process.execPath) },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'workspace-core-v1\n');
});

function createWorkspaceClosureFixture(t: test.TestContext): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-closure-v2-')),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  writeJson(path.join(repository, 'packages/workflow-engine/package.json'), {
    name: '@expense/workflow-engine',
    private: true,
    type: 'module',
    dependencies: { '@jigwright/core': 'workspace:*' },
  });
  writeText(
    path.join(repository, 'packages/workflow-engine/src/cli.ts'),
    "export const cli = 'fixture';\n",
  );
  writeText(
    path.join(repository, 'packages/workflow-engine/src/harness-bootstrap.ts'),
    [
      "import { fixtureRuntimeValue } from '@jigwright/core/fixture-runtime';",
      'process.stdout.write(`${fixtureRuntimeValue}\\n`);',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/bootstrap'), {
    recursive: true,
  });
  writeJson(path.join(repository, 'packages/core/package.json'), {
    name: '@jigwright/core',
    private: true,
    type: 'module',
    exports: { './fixture-runtime': './src/fixture-runtime.ts' },
  });
  writeText(
    path.join(repository, 'packages/core/src/fixture-runtime.ts'),
    "export const fixtureRuntimeValue = 'workspace-core-v1';\n",
  );
  writeJson(path.join(repository, 'packages/fixture-adapter/package.json'), {
    name: '@jigwright/fixture-adapter',
    private: true,
    type: 'module',
    dependencies: { '@jigwright/core': 'workspace:*' },
  });
  writeText(
    path.join(repository, 'packages/fixture-adapter/src/unrelated.ts'),
    'export const unrelated = true;\n',
  );
  return repository;
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, { mode: 0o644 });
}
