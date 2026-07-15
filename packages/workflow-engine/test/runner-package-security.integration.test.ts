import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveCheckRunner } from '../src/runner-resolution.ts';
import {
  addFixturePackage,
  createFixtureRepository,
  isWorkflowError,
} from './fixture.ts';

test('package runner rejects a non-string workspace dependency value', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(repository);
    const manifestPath = path.join(repository, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.devDependencies['fixture-plugin'] = { version: '1.0.0' };
    writeJson(manifestPath, manifest);

    assert.throws(
      () => resolveCheckRunner(repository, 'package', packageCheck()),
      (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner digest pins workspace peer dependency packages', () => {
  const repository = createFixtureRepository();
  const pluginPath = path.join(
    repository,
    'node_modules/fixture-plugin/index.mjs',
  );
  try {
    addFixturePackage(repository);
    addPackage(repository, 'fixture-plugin', 'export default "before";\n');
    declareWorkspacePeerDependency(repository, 'fixture-plugin', '1.0.0');
    const definition = packageCheck();
    const before = resolveCheckRunner(repository, 'package', definition).digest;
    fs.writeFileSync(pluginPath, 'export default "after";\n');
    const after = resolveCheckRunner(repository, 'package', definition).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner permits a missing optional workspace peer', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(repository);
    const manifestPath = path.join(repository, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.peerDependencies = { 'fixture-optional': '1.0.0' };
    manifest.peerDependenciesMeta = {
      'fixture-optional': { optional: true },
    };
    writeJson(manifestPath, manifest);

    assert.doesNotThrow(() =>
      resolveCheckRunner(repository, 'package', packageCheck()),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package resolution rejects a nearer manifestless package directory', () => {
  const repository = createFixtureRepository();
  try {
    configureRuntimeDependency(repository);
    const shadowDirectory = path.join(
      repository,
      'node_modules/fixture-tool/node_modules/fixture-runtime',
    );
    fs.mkdirSync(shadowDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(shadowDirectory, 'index.js'),
      'module.exports = {};\n',
    );

    assert.throws(
      () => resolveCheckRunner(repository, 'package', packageCheck()),
      (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package resolution rejects nearer LOAD_AS_FILE shadows', () => {
  for (const suffix of ['', '.js', '.json', '.node']) {
    const repository = createFixtureRepository();
    try {
      configureRuntimeDependency(repository);
      const nestedModules = path.join(
        repository,
        'node_modules/fixture-tool/node_modules',
      );
      fs.mkdirSync(nestedModules, { recursive: true });
      fs.writeFileSync(
        path.join(nestedModules, `fixture-runtime${suffix}`),
        suffix === '.json' ? '{}\n' : 'module.exports = {};\n',
      );

      assert.throws(
        () => resolveCheckRunner(repository, 'package', packageCheck()),
        (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
        suffix || '<exact>',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test(
  'runner digest uses Node binary content instead of its install path',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const executableDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-alternate-node-'),
    );
    try {
      addFixturePackage(repository);
      const expected = resolveCheckRunner(
        repository,
        'package',
        packageCheck(),
      ).digest;
      const alternateExecutable = path.join(executableDirectory, 'node');
      fs.copyFileSync(process.execPath, alternateExecutable);
      fs.chmodSync(alternateExecutable, 0o755);

      const moduleUrl = pathToFileURL(
        path.join(import.meta.dirname, '../src/runner-resolution.ts'),
      ).href;
      const script = [
        `import { resolveCheckRunner } from ${JSON.stringify(moduleUrl)};`,
        `const result = resolveCheckRunner(${JSON.stringify(repository)}, 'package', ${JSON.stringify(packageCheck())});`,
        'process.stdout.write(result.digest);',
      ].join('\n');
      const runtimeLibraryPath = path.join(
        path.dirname(path.dirname(process.execPath)),
        'lib',
      );
      const actual = execFileSync(
        alternateExecutable,
        ['--experimental-strip-types', '--input-type=module', '--eval', script],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DYLD_LIBRARY_PATH: libraryPath(
              runtimeLibraryPath,
              process.env.DYLD_LIBRARY_PATH,
            ),
            LD_LIBRARY_PATH: libraryPath(
              runtimeLibraryPath,
              process.env.LD_LIBRARY_PATH,
            ),
          },
        },
      );

      assert.equal(actual, expected);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(executableDirectory, { recursive: true, force: true });
    }
  },
);

test('runner digest frames file identities and content unambiguously', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(repository);
    const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
    const firstPath = path.join(packageDirectory, 'z-a.txt');
    const secondPath = path.join(packageDirectory, 'z-b.txt');
    const firstContent = Buffer.from('left');
    const secondContent = Buffer.from('right');
    fs.writeFileSync(firstPath, firstContent);
    fs.writeFileSync(secondPath, secondContent);
    const before = resolveCheckRunner(
      repository,
      'package',
      packageCheck(),
    ).digest;

    const secondIdentity = 'repository:node_modules/fixture-tool/z-b.txt';
    fs.writeFileSync(
      firstPath,
      Buffer.concat([
        firstContent,
        Buffer.from([0]),
        Buffer.from(secondIdentity),
        Buffer.from([0]),
        secondContent,
      ]),
    );
    fs.rmSync(secondPath);
    const after = resolveCheckRunner(
      repository,
      'package',
      packageCheck(),
    ).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'runner digest includes package symlink paths and targets',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    try {
      addFixturePackage(repository, "import '../current.mjs';\n");
      const packageDirectory = path.join(
        repository,
        'node_modules/fixture-tool',
      );
      fs.writeFileSync(path.join(packageDirectory, 'bad.mjs'), 'export {};\n');
      fs.writeFileSync(path.join(packageDirectory, 'good.mjs'), 'export {};\n');
      const linkPath = path.join(packageDirectory, 'current.mjs');
      fs.symlinkSync('bad.mjs', linkPath);
      const before = resolveCheckRunner(
        repository,
        'package',
        packageCheck(),
      ).digest;

      fs.rmSync(linkPath);
      fs.symlinkSync('good.mjs', linkPath);
      const after = resolveCheckRunner(
        repository,
        'package',
        packageCheck(),
      ).digest;

      assert.notEqual(after, before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

function configureRuntimeDependency(repository: string): void {
  addFixturePackage(repository, `import 'fixture-runtime';\n`);
  addPackage(repository, 'fixture-runtime', 'export {};\n');
  const manifestPath = path.join(
    repository,
    'node_modules/fixture-tool/package.json',
  );
  const manifest = readJson(manifestPath);
  manifest.dependencies = { 'fixture-runtime': '1.0.0' };
  writeJson(manifestPath, manifest);
}

function addPackage(
  repository: string,
  packageName: string,
  source: string,
): void {
  const packageDirectory = path.join(repository, 'node_modules', packageName);
  fs.mkdirSync(packageDirectory, { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    exports: './index.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'index.mjs'), source);
}

function declareWorkspacePeerDependency(
  repository: string,
  packageName: string,
  spec: string,
): void {
  const manifestPath = path.join(repository, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.peerDependencies = { [packageName]: spec };
  writeJson(manifestPath, manifest);
}

function packageCheck(): { command: string[]; destructiveDatabase: boolean } {
  return {
    command: ['node-package-bin', '.', 'fixture-tool', 'fixture-tool'],
    destructiveDatabase: false,
  };
}

function libraryPath(primary: string, existing?: string): string {
  return existing ? `${primary}${path.delimiter}${existing}` : primary;
}

function readJson(filePath: string): {
  dependencies?: Record<string, unknown>;
  devDependencies: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
} {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
