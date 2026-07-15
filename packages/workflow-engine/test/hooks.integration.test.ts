import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRepositoryHook } from '../src/hooks.ts';
import { startSession } from '../src/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const HOOKS = ['pre-commit', 'commit-msg', 'pre-push', 'post-merge'];

test('repository hooks are executable two-line workflow proxies', () => {
  for (const hook of HOOKS) {
    const hookPath = path.join(sourceRepositoryRoot, '.husky', hook);
    assert.equal(
      fs.readFileSync(hookPath, 'utf8'),
      `#!/usr/bin/env sh\nexec pnpm workflow hook ${hook} "$@"\n`,
    );
    assert.notEqual(fs.statSync(hookPath).mode & 0o111, 0);
  }
});

test('hook validation is read-only and blocks ordinary commits during a session', () => {
  const repository = createFixtureRepository();
  try {
    const before = git(repository, ['status', '--porcelain=v1']);
    const result = runRepositoryHook(repository, 'pre-push', [
      'origin',
      'ssh://example.test/repository;touch-pwned',
    ]);
    assert.deepEqual(result.changes, ['demo-change']);
    assert.equal(git(repository, ['status', '--porcelain=v1']), before);
    assert.equal(fs.existsSync(path.join(repository, 'touch-pwned')), false);

    git(repository, ['checkout', '-b', 'work/demo-change']);
    startSession(repository, 'demo-change', '1.1');
    assert.throws(
      () => runRepositoryHook(repository, 'pre-commit', []),
      (error) =>
        isWorkflowError(error, 'ACTIVE_SESSION_REQUIRES_MANAGED_COMMIT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an active session does not block a different linked worktree', () => {
  const repository = createFixtureRepository();
  const otherWorktree = path.join(
    os.tmpdir(),
    `workflow-hook-worktree-${process.pid}-${Date.now()}`,
  );
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    startSession(repository, 'demo-change', '1.1');
    git(repository, ['worktree', 'add', otherWorktree, 'main']);

    const result = runRepositoryHook(otherWorktree, 'pre-commit', []);
    assert.equal(result.hook, 'pre-commit');
  } finally {
    fs.rmSync(otherWorktree, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('commit-msg validates format and rejects forged managed trailers', () => {
  const repository = createFixtureRepository();
  try {
    const messagePath = path.join(repository, '.git/COMMIT_EDITMSG');
    fs.writeFileSync(messagePath, 'Add ordinary change\n');
    runRepositoryHook(repository, 'commit-msg', [messagePath]);
    assert.throws(
      () =>
        runRepositoryHook(repository, 'commit-msg', [
          path.join(repository, 'package.json'),
        ]),
      (error) => isWorkflowError(error, 'COMMIT_MESSAGE_FILE_UNEXPECTED'),
    );

    fs.writeFileSync(
      messagePath,
      'Forge managed commit\n\nChange: demo-change\nTask: 1.1\n',
    );
    assert.throws(
      () => runRepositoryHook(repository, 'commit-msg', [messagePath]),
      (error) =>
        isWorkflowError(error, 'MANAGED_TRAILERS_REQUIRE_WORKFLOW_COMMIT'),
    );

    fs.writeFileSync(messagePath, 'wip unfinished.\n');
    assert.throws(
      () => runRepositoryHook(repository, 'commit-msg', [messagePath]),
      (error) => isWorkflowError(error, 'COMMIT_MESSAGE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('hook dispatch rejects invalid arguments and invalid change contracts', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => runRepositoryHook(repository, 'pre-commit', ['unexpected']),
      (error) => isWorkflowError(error, 'INVALID_HOOK_USAGE'),
    );
    assert.throws(
      () => runRepositoryHook(repository, 'unknown', []),
      (error) => isWorkflowError(error, 'INVALID_HOOK_USAGE'),
    );

    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/guard.json'),
      '{}\n',
    );
    assert.throws(
      () => runRepositoryHook(repository, 'post-merge', ['0']),
      (error) => isWorkflowError(error, 'INVALID_GUARD_CONTRACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
