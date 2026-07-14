import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCheckRunner } from '../src/runner-resolution.ts';
import { checkSession, startSession } from '../src/session.ts';
import './runner-closure.integration.test.ts';
import './runner-package-security.integration.test.ts';
import {
  addFixturePackage,
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
} from './fixture.ts';

test('change validation rejects eval, preload, external, and ambiguous runners', () => {
  const invalidCommands = [
    ['node', '-e', 'process.exit(0)'],
    ['node', '--eval', 'process.exit(0)'],
    ['node', '--require', '/tmp/inject.cjs'],
    ['node', '--test', '--import=./scripts/preload.mjs', 'scripts/pass.mjs'],
    ['node', '/tmp/check.mjs'],
    ['node', '../check.mjs'],
    ['node-package-bin', 'src/**', 'fixture-tool', 'fixture-tool'],
    ['node-package-bin', '.', '..', 'fixture-tool'],
    ['node-package-bin', '.', 'fixture-tool', '.'],
  ];

  for (const command of invalidCommands) {
    const repository = createFixtureRepository();
    try {
      configureChecks(
        repository,
        { unsafe: { command, destructiveDatabase: false } },
        ['unsafe'],
      );
      git(repository, ['checkout', '-b', 'work/demo-change']);
      assert.throws(
        () => startSession(repository, 'demo-change', '1.1'),
        (error) => isWorkflowError(error, 'INVALID_CHECK_DEFINITION'),
        command.join(' '),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('caller NODE_OPTIONS cannot turn a failing check into passing evidence', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-node-options-'),
  );
  const injectedMarker = path.join(outputDirectory, 'injected');
  const preloadPath = path.join(outputDirectory, 'preload.cjs');

  try {
    fs.writeFileSync(
      preloadPath,
      `require('node:fs').writeFileSync(${JSON.stringify(injectedMarker)}, 'ran'); process.exit(0);\n`,
    );
    configureChecks(
      repository,
      {
        failing: {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        },
      },
      ['failing'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: {
            ...process.env,
            NODE_OPTIONS: `--require=${preloadPath}`,
          },
        }),
      (error) => isWorkflowError(error, 'CHECK_FAILED'),
    );
    assert.equal(fs.existsSync(injectedMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('node runner detects an entrypoint changed during execution', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/mutate-self.mjs'],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_RUNNER_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner executes the declared string bin and records its digest', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-package-bin-'),
  );
  const outputPath = path.join(outputDirectory, 'ran');

  try {
    addFixturePackage(
      repository,
      `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'ran');\n`,
    );
    configureChecks(
      repository,
      {
        package: {
          command: [
            'node-package-bin',
            '.',
            'fixture-tool',
            'fixture-tool',
            outputPath,
          ],
          destructiveDatabase: false,
        },
      },
      ['package'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const result = checkSession(repository, session.sessionId);

    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'ran');
    assert.equal(
      result.checks[0].runner,
      'node-package-bin:.:fixture-tool/fixture-tool',
    );
    assert.match(result.checks[0].runnerDigest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result).includes(outputPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('package runner rejects the wrong name for a string bin', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(repository);
    configureChecks(
      repository,
      {
        package: {
          command: ['node-package-bin', '.', 'fixture-tool', 'other'],
          destructiveDatabase: false,
        },
      },
      ['package'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner detects a bin changed during execution', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(
      repository,
      `import fs from 'node:fs';\nfs.appendFileSync(import.meta.filename, '\\n');\n`,
    );
    configureChecks(
      repository,
      {
        package: {
          command: ['node-package-bin', '.', 'fixture-tool', 'fixture-tool'],
          destructiveDatabase: false,
        },
      },
      ['package'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_RUNNER_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('scope verification checks both endpoints of a tracked rename', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    git(repository, ['add', 'outside.txt']);
    git(repository, ['commit', '-m', 'Add outside fixture']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    git(repository, ['mv', 'outside.txt', 'src/inside.txt']);

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('all package runners are pinned before the first required check starts', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-runner-preflight-'),
  );
  const markerPath = path.join(outputDirectory, 'first-check-ran');
  try {
    addFixturePackage(repository);
    configureChecks(
      repository,
      {
        first: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
        package: {
          command: ['node-package-bin', '.', 'fixture-tool', 'missing-bin'],
          destructiveDatabase: false,
        },
      },
      ['first', 'package'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('package runner digest pins imported runtime dependency files', () => {
  const repository = createFixtureRepository();
  const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
  const importedPath = path.join(packageDirectory, 'lib/main.mjs');
  try {
    addFixturePackage(repository, `import '../lib/main.mjs';\n`);
    fs.mkdirSync(path.dirname(importedPath), { recursive: true });
    fs.writeFileSync(importedPath, 'process.exit(7);\n');
    const definition = {
      command: ['node-package-bin', '.', 'fixture-tool', 'fixture-tool'],
      destructiveDatabase: false,
    };
    const before = resolveCheckRunner(repository, 'package', definition).digest;
    fs.writeFileSync(importedPath, 'process.exit(0);\n');
    const after = resolveCheckRunner(repository, 'package', definition).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('passing checks cannot mutate allowed working-tree state', () => {
  const repository = createFixtureRepository();
  const changedPath = path.join(repository, 'src/changed.ts');
  const laterMarker = path.join(repository, 'later-ran');
  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', changedPath],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', laterMarker],
          destructiveDatabase: false,
        },
      },
      ['mutating', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_MUTATED_WORKTREE'),
    );
    assert.equal(fs.existsSync(changedPath), true);
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
