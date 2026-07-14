import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
