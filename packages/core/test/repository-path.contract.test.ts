import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  RepositoryPathError,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../src/repository-path.ts';

test('core repository paths preserve exact and prefix matching semantics', () => {
  assert.equal(normalizePolicyPath('apps/api/**'), 'apps/api/**');
  assert.equal(
    normalizeExactRepositoryPath('apps/api/src/main.ts'),
    'apps/api/src/main.ts',
  );
  assert.equal(
    normalizeChangedPath('apps/api/src/[slug]/file?.ts'),
    'apps/api/src/[slug]/file?.ts',
  );
  assert.equal(matchesAllowedPath('apps/api/src/main.ts', 'apps/api/**'), true);
  assert.equal(matchesAllowedPath('apps/api', 'apps/api/**'), true);
  assert.equal(
    matchesAllowedPath('apps/api-copy/main.ts', 'apps/api/**'),
    false,
  );
});

test('core repository paths reject non-portable policy and exact paths with typed errors', () => {
  for (const value of [
    '',
    '/absolute.ts',
    '../escape.ts',
    './relative.ts',
    'src//file.ts',
    'src/.git/config',
    'src\\file.ts',
    'src/e\u0301.ts',
  ]) {
    assert.throws(
      () => normalizeExactRepositoryPath(value),
      isRepositoryPathError('INVALID_REPOSITORY_PATH'),
    );
  }
  for (const value of ['src/*.ts', 'src/**/file.ts', ' src/file.ts']) {
    assert.throws(
      () => normalizePolicyPath(value),
      isRepositoryPathError('INVALID_POLICY_PATH'),
    );
  }
});

test('core repository-path implementation stays consumer and authority neutral', () => {
  const source = fs.readFileSync(
    new URL('../src/repository-path.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /expense-app|openspec|authority|workflowError/i);
});

function isRepositoryPathError(code: string) {
  return (error: unknown): boolean =>
    error instanceof RepositoryPathError && error.code === code;
}
