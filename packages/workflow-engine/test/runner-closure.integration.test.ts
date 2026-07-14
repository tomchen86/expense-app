import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCheckRunner } from '../src/runner-resolution.ts';
import { checkSession, startSession } from '../src/session.ts';
import {
  addFixturePackage,
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
} from './fixture.ts';

test('package runner digest pins declared runtime dependency packages', () => {
  const repository = createFixtureRepository();
  const runtimePath = path.join(
    repository,
    'node_modules/fixture-runtime/index.mjs',
  );
  try {
    addFixturePackage(repository, `import 'fixture-runtime';\n`);
    addFixtureRuntime(repository, 'process.exit(7);\n');
    declareFixtureRuntimeDependency(repository);
    const definition = packageCheck();
    const before = resolveCheckRunner(repository, 'package', definition).digest;
    fs.writeFileSync(runtimePath, 'process.exit(0);\n');
    const after = resolveCheckRunner(repository, 'package', definition).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner digest pins workspace-declared plugin packages', () => {
  const repository = createFixtureRepository();
  const pluginPath = path.join(
    repository,
    'node_modules/fixture-plugin/index.mjs',
  );
  try {
    addFixturePackage(repository);
    addWorkspacePlugin(repository, 'export default "before";\n');
    const definition = packageCheck();
    const before = resolveCheckRunner(repository, 'package', definition).digest;
    fs.writeFileSync(pluginPath, 'export default "after";\n');
    const after = resolveCheckRunner(repository, 'package', definition).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner digest pins undeclared nested packages', () => {
  const repository = createFixtureRepository();
  const nestedPackage = path.join(
    repository,
    'node_modules/fixture-tool/node_modules/fixture-undocumented',
  );
  const nestedEntrypoint = path.join(nestedPackage, 'index.mjs');
  try {
    addFixturePackage(repository, `import 'fixture-undocumented';\n`);
    addPackageAt(nestedPackage, 'fixture-undocumented', 'export default 1;\n');
    const definition = packageCheck();
    const before = resolveCheckRunner(repository, 'package', definition).digest;
    fs.writeFileSync(nestedEntrypoint, 'export default 2;\n');
    const after = resolveCheckRunner(repository, 'package', definition).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'package runner rejects an undeclared nested package symlink outside the repository',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const externalPackage = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-external-undeclared-package-'),
    );
    const nestedModules = path.join(
      repository,
      'node_modules/fixture-tool/node_modules',
    );
    try {
      addFixturePackage(repository, `import 'fixture-undocumented';\n`);
      addPackageAt(
        externalPackage,
        'fixture-undocumented',
        'export default 1;\n',
      );
      fs.mkdirSync(nestedModules, { recursive: true });
      fs.symlinkSync(
        externalPackage,
        path.join(nestedModules, 'fixture-undocumented'),
      );

      assert.throws(
        () => resolveCheckRunner(repository, 'package', packageCheck()),
        (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(externalPackage, { recursive: true, force: true });
    }
  },
);

test('package runner digest is independent of the checkout path', () => {
  const firstRepository = createFixtureRepository();
  const secondRepository = createFixtureRepository();
  try {
    addFixturePackage(firstRepository);
    addFixturePackage(secondRepository);

    const definition = packageCheck();
    const first = resolveCheckRunner(firstRepository, 'package', definition);
    const second = resolveCheckRunner(secondRepository, 'package', definition);

    assert.equal(first.digest, second.digest);
  } finally {
    fs.rmSync(firstRepository, { recursive: true, force: true });
    fs.rmSync(secondRepository, { recursive: true, force: true });
  }
});

test('workspace alias can explicitly satisfy a transitive package slot', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(repository, `import 'fixture-runtime';\n`);
    addFixtureRuntime(repository, 'export {};\n', 'other-runtime');
    declareFixtureRuntimeDependency(repository);
    declareWorkspaceDependency(
      repository,
      'fixture-runtime',
      'npm:other-runtime@1.0.0',
    );

    assert.doesNotThrow(() =>
      resolveCheckRunner(repository, 'package', packageCheck()),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'package resolution rejects a nearer dependency symlink outside the repository',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const externalPackage = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-external-package-'),
    );
    try {
      addFixturePackage(repository, `import 'fixture-runtime';\n`);
      addFixtureRuntime(repository, 'process.exit(0);\n');
      declareFixtureRuntimeDependency(repository);
      writeJson(path.join(externalPackage, 'package.json'), {
        name: 'fixture-runtime',
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
      });
      fs.writeFileSync(
        path.join(externalPackage, 'index.mjs'),
        'process.exit(0);\n',
      );
      const nestedModules = path.join(
        repository,
        'node_modules/fixture-tool/node_modules',
      );
      fs.mkdirSync(nestedModules, { recursive: true });
      fs.symlinkSync(
        externalPackage,
        path.join(nestedModules, 'fixture-runtime'),
      );
      configureChecks(repository, { package: packageCheck() }, ['package']);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      assert.throws(
        () => checkSession(repository, session.sessionId),
        (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(externalPackage, { recursive: true, force: true });
    }
  },
);

test(
  'package runner rejects a workspace dependency symlink outside the repository',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const externalPackage = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-external-plugin-'),
    );
    try {
      addFixturePackage(repository);
      declareWorkspaceDependency(repository, 'fixture-plugin', '1.0.0');
      writeJson(path.join(externalPackage, 'package.json'), {
        name: 'fixture-plugin',
        version: '1.0.0',
        exports: './index.mjs',
      });
      fs.writeFileSync(path.join(externalPackage, 'index.mjs'), 'export {};\n');
      fs.symlinkSync(
        externalPackage,
        path.join(repository, 'node_modules/fixture-plugin'),
      );
      configureChecks(repository, { package: packageCheck() }, ['package']);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      assert.throws(
        () => checkSession(repository, session.sessionId),
        (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(externalPackage, { recursive: true, force: true });
    }
  },
);

test('package runner rejects identities contradicting npm/workspace aliases', () => {
  for (const spec of ['npm:other-tool@1.0.0', 'workspace:other-tool@*']) {
    const repository = createFixtureRepository();
    try {
      addFixturePackage(repository);
      declareWorkspaceDependency(repository, 'fixture-tool', spec);
      configureChecks(repository, { package: packageCheck() }, ['package']);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      assert.throws(
        () => checkSession(repository, session.sessionId),
        (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
        spec,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

function packageCheck(): { command: string[]; destructiveDatabase: boolean } {
  return {
    command: ['node-package-bin', '.', 'fixture-tool', 'fixture-tool'],
    destructiveDatabase: false,
  };
}

function addFixtureRuntime(
  repository: string,
  source: string,
  installedName = 'fixture-runtime',
): void {
  const packageDirectory = path.join(
    repository,
    'node_modules/fixture-runtime',
  );
  fs.mkdirSync(packageDirectory, { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: installedName,
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'index.mjs'), source);
}

function addPackageAt(
  packageDirectory: string,
  packageName: string,
  source: string,
): void {
  fs.mkdirSync(packageDirectory, { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'index.mjs'), source);
}

function declareFixtureRuntimeDependency(repository: string): void {
  const manifestPath = path.join(
    repository,
    'node_modules/fixture-tool/package.json',
  );
  const manifest = readJson(manifestPath);
  manifest.dependencies = { 'fixture-runtime': '1.0.0' };
  writeJson(manifestPath, manifest);
}

function addWorkspacePlugin(repository: string, source: string): void {
  const packageDirectory = path.join(repository, 'node_modules/fixture-plugin');
  fs.mkdirSync(packageDirectory, { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: 'fixture-plugin',
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'index.mjs'), source);

  declareWorkspaceDependency(repository, 'fixture-plugin', '1.0.0');
}

function declareWorkspaceDependency(
  repository: string,
  packageName: string,
  spec: string,
): void {
  const workspaceManifestPath = path.join(repository, 'package.json');
  const workspaceManifest = readJson(workspaceManifestPath);
  workspaceManifest.devDependencies[packageName] = spec;
  writeJson(workspaceManifestPath, workspaceManifest);
}

function readJson(filePath: string): {
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
