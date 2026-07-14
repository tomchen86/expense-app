import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from '../src/database-policy.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  assertPolicyPathInsideRepository,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizePolicyPath,
} from '../src/paths.ts';
import { parseTasks } from '../src/contracts.ts';
import './git-security.test.ts';

test('parseTasks reads ordered checkbox tasks', () => {
  const tasks = parseTasks(`
# Tasks

- [ ] 1.1 Add failing test
- [x] 1.2 Implement behavior
`);

  assert.deepEqual(tasks, [
    { id: '1.1', completed: false, title: 'Add failing test' },
    { id: '1.2', completed: true, title: 'Implement behavior' },
  ]);
});

test('parseTasks rejects duplicate task IDs', () => {
  assert.throws(
    () =>
      parseTasks(`
- [ ] 1.1 First
- [ ] 1.1 Duplicate
`),
    (error) => isWorkflowError(error, 'DUPLICATE_TASK_ID'),
  );
});

test('policy paths accept exact paths and segment-aware directory prefixes', () => {
  assert.equal(
    normalizePolicyPath('apps/api/src/file.ts'),
    'apps/api/src/file.ts',
  );
  assert.equal(normalizePolicyPath('apps/api/**'), 'apps/api/**');
  assert.equal(matchesAllowedPath('apps/api/src/file.ts', 'apps/api/**'), true);
  assert.equal(matchesAllowedPath('apps/api', 'apps/api/**'), true);
  assert.equal(
    matchesAllowedPath('apps/api-copy/file.ts', 'apps/api/**'),
    false,
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/file.ts', 'apps/api/src/file.ts'),
    true,
  );
  assert.equal(
    normalizeChangedPath('apps/api/src/[slug]/file?.ts'),
    'apps/api/src/[slug]/file?.ts',
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/[slug]/file?.ts', 'apps/api/**'),
    true,
  );
});

test('policy paths reject traversal, absolute paths, and unsupported globs', () => {
  for (const invalidPath of [
    '../secret',
    '/tmp/secret',
    'C:\\secret',
    './apps/api',
    'apps/*/src',
    'apps/api/',
  ]) {
    assert.throws(
      () => normalizePolicyPath(invalidPath),
      (error) => isWorkflowError(error, 'INVALID_POLICY_PATH'),
      invalidPath,
    );
  }
});

test('policy validation rejects an existing symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-path-root-'));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-path-outside-'),
  );
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.throws(
      () => assertPolicyPathInsideRepository(root, 'escape/**'),
      (error) => isWorkflowError(error, 'PATH_ESCAPES_REPOSITORY'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('disposable database policy accepts only explicit isolated test identities', () => {
  const evidence = assertDisposableDatabase({
    WORKFLOW_DISPOSABLE_DATABASE: '1',
    TEST_DATABASE_URL:
      'postgres://runner:super-secret@127.0.0.1:5433/expense_ci?sslmode=disable',
    DATABASE_URL: 'postgres://app:secret@127.0.0.1:5433/expense_dev',
  });

  assert.deepEqual(evidence, {
    identity: 'postgresql://127.0.0.1:5433/expense_ci',
  });
  assert.equal(JSON.stringify(evidence).includes('super-secret'), false);
  assert.equal(JSON.stringify(evidence).includes('sslmode'), false);
});

test('check environment exposes only deterministic runtime and validated database values', () => {
  const callerEnvironment = {
    ...process.env,
    PATH: '/tmp/fake-bin',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
    NODE_PATH: '/tmp/modules',
    LD_PRELOAD: '/tmp/inject.so',
    DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    GIT_DIR: '/tmp/decoy.git',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    PRIVATE_TOKEN: 'marker-secret',
    DATABASE_URL: 'postgres://app:secret@localhost/expense_dev',
    COMPOSE_TEST_DATABASE_URL:
      'postgres://compose:secret@localhost/expense_test',
  };

  const nonDestructive = createCheckEnvironment(callerEnvironment, false);

  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'GIT_DIR',
    'SSH_AUTH_SOCK',
    'PRIVATE_TOKEN',
    'DATABASE_URL',
    'COMPOSE_TEST_DATABASE_URL',
    'TEST_DATABASE_URL',
  ]) {
    assert.equal(Object.hasOwn(nonDestructive, key), false, key);
  }
  assert.equal(nonDestructive.PATH?.includes('/tmp/fake-bin'), false);
  assert.equal(nonDestructive.CI, '1');
  assert.equal(nonDestructive.WORKFLOW_CHECK_EXECUTION, '1');

  const destructive = createCheckEnvironment(
    {
      ...callerEnvironment,
      WORKFLOW_DISPOSABLE_DATABASE: '1',
      TEST_DATABASE_URL:
        'postgres://runner:marker-secret@localhost/expense_test',
    },
    true,
  );
  assert.equal(
    destructive.TEST_DATABASE_URL,
    'postgres://runner:marker-secret@localhost/expense_test',
  );
  assert.equal(destructive.WORKFLOW_DISPOSABLE_DATABASE, '1');
  assert.equal(JSON.stringify(nonDestructive).includes('marker-secret'), false);
});

test(
  'check environment ignores a caller-controlled temporary directory',
  { skip: process.platform === 'win32' },
  () => {
    const attackerDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-tmp-'),
    );
    const originalTemporaryDirectory = process.env.TMPDIR;
    try {
      process.env.TMPDIR = attackerDirectory;

      const environment = createCheckEnvironment({}, false);

      assert.equal(environment.TMPDIR, fs.realpathSync('/tmp'));
      assert.notEqual(environment.TMPDIR, fs.realpathSync(attackerDirectory));
    } finally {
      if (originalTemporaryDirectory === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTemporaryDirectory;
      }
      fs.rmSync(attackerDirectory, { recursive: true, force: true });
    }
  },
);

test('disposable database policy fails closed without leaking connection secrets', () => {
  const cases: Array<{
    name: string;
    environment: NodeJS.ProcessEnv;
    code: string;
  }> = [
    {
      name: 'confirmation missing',
      environment: {
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test',
      },
      code: 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED',
    },
    {
      name: 'test URL missing',
      environment: { WORKFLOW_DISPOSABLE_DATABASE: '1' },
      code: 'TEST_DATABASE_URL_REQUIRED',
    },
    {
      name: 'unsupported protocol',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'mysql://runner:marker-secret@localhost/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'no disposable name token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_sandbox',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'forbidden production token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_prod_test',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'same identity as development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@db.example.test:5432/expense_test?ssl=true',
        DATABASE_URL:
          'postgresql://app:other-secret@db.example.test/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'different DNS aliases cannot prove database isolation',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@ci-db.internal:6543/expense_test',
        DATABASE_URL:
          'postgres://app:other-secret@primary-db.internal:5432/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'trailing-dot hostname aliases development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@localhost./expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4 and localhost loopback aliases match',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@127.0.0.1/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4-mapped IPv6 loopback aliases localhost',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@[::ffff:127.0.0.1]/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'query overrides the PostgreSQL target',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@safe.example.test:6543/expense_test?host=prod.example.test&port=5432',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'percent-encoded hostname is ambiguous',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@%70rod.example.test/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'control character in URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test\0',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'driver-equivalent encoded database identity',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@db.example.test/expense_%74est%23x',
        DATABASE_URL:
          'postgres://app:other-secret@db.example.test/expense_test%2523x',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => assertDisposableDatabase(fixture.environment),
      (error) => {
        assert.equal(isWorkflowError(error, fixture.code), true, fixture.name);
        const rendered = JSON.stringify({
          error,
          message: error instanceof Error ? error.message : String(error),
        });
        assert.equal(rendered.includes('marker-secret'), false, fixture.name);
        assert.equal(rendered.includes('other-secret'), false, fixture.name);
        return true;
      },
    );
  }
});

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
