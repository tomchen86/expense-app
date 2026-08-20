import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('session runtime layout is exposed through public core and fixture ports instead of a module-to-runtime edge', () => {
  const coreManifest = readJson('packages/core/package.json') as {
    exports?: Record<string, string>;
  };
  const fixtureManifest = readJson('packages/fixture-adapter/package.json') as {
    exports?: Record<string, string>;
  };
  const epochSource = fs.readFileSync(
    path.join(
      repositoryRoot,
      'packages/workflow-engine/src/modules/lifecycle/planning-execution-epoch.ts',
    ),
    'utf8',
  );

  assert.equal(
    coreManifest.exports?.['./session-runtime-layout-port'],
    './src/session-runtime-layout-port.ts',
  );
  assert.equal(
    fixtureManifest.exports?.['./session-runtime-layout'],
    './src/fixture-session-runtime-layout.ts',
  );
  assert.doesNotMatch(
    epochSource,
    /runtime\/session-workspace\/session-store\.ts/,
  );
  assert.match(epochSource, /defaultSessionRuntimeLayoutPort\.resolve\(/);
});

test('session-store compatibility export delegates exact core layout bytes', async () => {
  const [{ defaultSessionRuntimeLayoutPort }, { runtimePaths }] =
    await Promise.all([
      import('@jigwright/core/session-runtime-layout-port'),
      import('../src/runtime/session-workspace/session-store.ts'),
    ]);
  const input = {
    gitCommonDirectory: '/repository/.git',
    runtimeDirectory: 'workflow-engine',
  };
  assert.deepEqual(
    defaultSessionRuntimeLayoutPort.resolve(input),
    runtimePaths(input.gitCommonDirectory, input.runtimeDirectory),
  );
});

function readJson(filePath: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8'),
  ) as unknown;
}
