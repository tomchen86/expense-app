import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertDisposableDatabase } from '../src/database-policy.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  assertPolicyPathInsideRepository,
  matchesAllowedPath,
  normalizePolicyPath,
} from '../src/paths.ts';
import { parseTasks } from '../src/contracts.ts';

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
    DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/expense_dev',
  });

  assert.deepEqual(evidence, {
    identity: 'postgresql://127.0.0.1:5433/expense_ci',
  });
  assert.equal(JSON.stringify(evidence).includes('super-secret'), false);
  assert.equal(JSON.stringify(evidence).includes('sslmode'), false);
});

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
