import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import { abortSession, checkSession, startSession } from '../src/session.ts';
import './completion.integration.test.ts';
import './issues.integration.test.ts';
import './handoff.integration.test.ts';
import './document-refresh.integration.test.ts';
import './hooks.integration.test.ts';
import './ci.integration.test.ts';
import './ci-bootstrap.integration.test.ts';
import './ignored-state.integration.test.ts';
import './runner.integration.test.ts';
import {
  addFixtureScripts,
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

test('start rejects protected and dirty repositories without leaving runtime state', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'PROTECTED_BRANCH'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'dirty.txt'), 'existing work\n');

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'DIRTY_WORKTREE'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('active session pins a clean baseline, enforces scope, and releases its lock', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.equal(session.state, 'active');
    assert.equal(checkSession(repository, session.sessionId).passed, true);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const allowedCheck = checkSession(repository, session.sessionId);
    assert.deepEqual(allowedCheck.changedPaths, ['src/feature.ts']);

    fs.writeFileSync(path.join(repository, 'outside.txt'), 'not allowed\n');
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );

    const aborted = abortSession(
      repository,
      session.sessionId,
      'integration test',
    );
    assert.equal(aborted.state, 'aborted');
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects workflow artifacts changed after session start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    fs.appendFileSync(guardPath, '\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects a session whose task policy was broadened', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    tampered.allowedPaths = ['outside.txt'];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_POLICY_TAMPERED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check executes required argv literally from the repository root', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-output-'),
  );
  const outputPath = path.join(outputDirectory, 'arguments.json');
  const sentinelPath = path.join(outputDirectory, 'shell-injection');
  const literalArgument = `; touch ${sentinelPath}`;

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        literal: {
          command: [
            'node',
            'scripts/capture-args.mjs',
            outputPath,
            literalArgument,
            '$(echo not-evaluated)',
          ],
          destructiveDatabase: false,
        },
      },
      ['literal'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId);
    const captured = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    assert.deepEqual(captured, {
      cwd: fs.realpathSync(repository),
      arguments: [literalArgument, '$(echo not-evaluated)'],
    });
    assert.equal(fs.existsSync(sentinelPath), false);
    assert.deepEqual(
      result.checks.map((check) => ({
        checkId: check.checkId,
        outcome: check.outcome,
        exitCode: check.exitCode,
      })),
      [{ checkId: 'literal', outcome: 'passed', exitCode: 0 }],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check fails on the first non-zero check and does not run later checks', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-failure-'),
  );
  const markerPath = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        failing: {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
      },
      ['failing', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_FAILED'), true);
        assert.deepEqual((error as WorkflowError).details, {
          checkId: 'failing',
          exitCode: 7,
          signal: null,
        });
        return true;
      },
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive database preflight runs before any required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-database-preflight-'),
  );
  const markerPath = path.join(outputDirectory, 'first-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        first: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['first', 'destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: { ...process.env },
        }),
      (error) =>
        isWorkflowError(error, 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED'),
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive check evidence includes only the redacted database identity', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId, {
      environment: {
        ...process.env,
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@127.0.0.1:5433/expense_test?ssl=false',
        DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/expense_dev',
      },
    });

    assert.equal(
      result.checks[0].databaseIdentity,
      'postgresql://127.0.0.1:5433/expense_test',
    );
    assert.equal(JSON.stringify(result).includes('marker-secret'), false);
    assert.equal(JSON.stringify(result).includes('ssl=false'), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check revalidates scope before running the next required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-post-check-scope-'),
  );
  const outsidePath = path.join(repository, 'outside.txt');
  const laterMarker = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', outsidePath],
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
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check rejects a lock removed by a passing required check', () => {
  const repository = createFixtureRepository();
  const lockPath = path.join(
    runtimeRoot(repository),
    'locks',
    'demo-change.lock',
  );

  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/remove-file.mjs', lockPath],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check converts spawn errors without leaking environment values', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        overflowing: {
          command: ['node', 'scripts/overflow.mjs'],
          destructiveDatabase: false,
        },
      },
      ['overflowing'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: {
            ...process.env,
            WORKFLOW_TEST_SECRET: 'marker-secret',
          },
        }),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_EXECUTION_FAILED'), true);
        assert.equal((error as Error).message.includes('marker-secret'), false);
        assert.equal(JSON.stringify(error).includes('marker-secret'), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('change validation rejects inherited object properties as check IDs', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        fixture: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        },
      },
      ['constructor'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'UNKNOWN_REQUIRED_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'node runner ignores caller-controlled PATH substitutes',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const fakeBin = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-bin-'),
    );
    const markerPath = path.join(fakeBin, 'fake-node-ran');
    const fakeNodePath = path.join(fakeBin, 'node');

    try {
      fs.writeFileSync(
        fakeNodePath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 0\n`,
      );
      fs.chmodSync(fakeNodePath, 0o755);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      const result = checkSession(repository, session.sessionId, {
        environment: { ...process.env, PATH: fakeBin },
      });

      assert.equal(result.passed, true);
      assert.equal(fs.existsSync(markerPath), false);
      assert.equal(result.checks[0].runner, 'node');
      assert.match(result.checks[0].runnerDigest, /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  },
);

test('change validation rejects bare executable check runners', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        unsafe: {
          command: ['pnpm', '--version'],
          destructiveDatabase: false,
        },
      },
      ['unsafe'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'INVALID_CHECK_DEFINITION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
