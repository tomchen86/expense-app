import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitFacts,
  createPlanningCommitObject,
  planningCommitMessage,
} from '../src/git-transitions.ts';
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

test('pre-commit rejects staged OpenSpec lifecycle diffs without mutating the index', async (t) => {
  const cases: Array<{
    name: string;
    stage(repository: string): void;
  }> = [
    {
      name: 'task projection read from the index',
      stage(repository) {
        const tasksPath = path.join(
          repository,
          'openspec/changes/demo-change/tasks.md',
        );
        const original = fs.readFileSync(tasksPath, 'utf8');
        fs.writeFileSync(tasksPath, original.replace('- [ ] 1.1', '- [x] 1.1'));
        git(repository, ['add', '--', 'openspec/changes/demo-change/tasks.md']);
        fs.writeFileSync(tasksPath, original);
      },
    },
    {
      name: 'planning artifact',
      stage(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/design.md'),
          '\nRevision.\n',
        );
        git(repository, [
          'add',
          '--',
          'openspec/changes/demo-change/design.md',
        ]);
      },
    },
    {
      name: 'archive artifact',
      stage(repository) {
        const archivePath = path.join(
          repository,
          'openspec/changes/archive/2026-07-15-demo-change/proposal.md',
        );
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.writeFileSync(archivePath, '# Archived proposal\n');
        git(repository, ['add', '--', path.relative(repository, archivePath)]);
      },
    },
    {
      name: 'base spec promotion',
      stage(repository) {
        const specPath = path.join(repository, 'openspec/specs/demo/spec.md');
        fs.mkdirSync(path.dirname(specPath), { recursive: true });
        fs.writeFileSync(specPath, '# Promoted spec\n');
        git(repository, ['add', '--', path.relative(repository, specPath)]);
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const repository = createFixtureRepository();
      try {
        testCase.stage(repository);
        const before = hookState(repository);
        assert.throws(
          () => runRepositoryHook(repository, 'pre-commit', []),
          (error) =>
            isWorkflowError(error, 'MANAGED_DIFF_REQUIRES_WORKFLOW_COMMIT'),
        );
        assert.deepEqual(hookState(repository), before);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('pre-commit permits an ordinary unrelated staged change without mutation', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(repository, 'src/unrelated.ts'), 'export {};\n');
    git(repository, ['add', '--', 'src/unrelated.ts']);
    const before = hookState(repository);

    const result = runRepositoryHook(repository, 'pre-commit', []);

    assert.equal(result.hook, 'pre-commit');
    assert.deepEqual(hookState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('hooks reject reviewed planning asset drift and forbidden lifecycle authority', () => {
  const repository = createFixtureRepository();
  try {
    fs.cpSync(
      path.join(sourceRepositoryRoot, '.codex'),
      path.join(repository, '.codex'),
      { recursive: true },
    );
    fs.cpSync(
      path.join(sourceRepositoryRoot, 'workflow/codex-assets'),
      path.join(repository, 'workflow/codex-assets'),
      { recursive: true },
    );
    runRepositoryHook(repository, 'pre-push', []);

    fs.appendFileSync(
      path.join(repository, '.codex/skills/openspec-explore/SKILL.md'),
      '\nopenspec archive demo-change\n',
    );
    assert.throws(
      () => runRepositoryHook(repository, 'pre-push', []),
      (error) => isWorkflowError(error, 'CODEX_ASSET_FORBIDDEN_AUTHORITY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('commit-msg validates format and rejects every forged managed kind', () => {
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

    for (const message of [
      'Forge task\n\nChange: demo-change\nTask: 1.1\n',
      'Forge plan\n\nChange: demo-change\nTransition: plan\n',
      'Forge archive\n\nChange: demo-change\nTransition: archive\n',
      'Forge malformed plan\n\nchange : demo-change\ntransition : plan\n',
      'Forge unknown transition\n\nTransition: deploy\n',
    ]) {
      fs.writeFileSync(messagePath, message);
      assert.throws(
        () => runRepositoryHook(repository, 'commit-msg', [messagePath]),
        (error) =>
          isWorkflowError(error, 'MANAGED_TRAILERS_REQUIRE_WORKFLOW_COMMIT'),
        message,
      );
      assert.equal(fs.readFileSync(messagePath, 'utf8'), message);
      assert.equal(git(repository, ['status', '--porcelain=v1']), '');
    }

    fs.writeFileSync(messagePath, 'wip unfinished.\n');
    assert.throws(
      () => runRepositoryHook(repository, 'commit-msg', [messagePath]),
      (error) => isWorkflowError(error, 'COMMIT_MESSAGE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('commit-tree remains the hook-free path for managed commits', () => {
  const repository = createFixtureRepository();
  const hooksDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-hostile-hooks-'),
  );
  try {
    const hookPath = path.join(hooksDirectory, 'commit-msg');
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 99\n');
    fs.chmodSync(hookPath, 0o755);
    git(repository, ['config', 'core.hooksPath', hooksDirectory]);

    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    const tree = git(repository, ['write-tree']).trim();
    const commit = createPlanningCommitObject(
      repository,
      tree,
      parent,
      'demo-change',
    );

    assert.equal(
      commitFacts(repository, commit).message,
      `${planningCommitMessage('demo-change')}\n`,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(git(repository, ['status', '--porcelain=v1']), '');
  } finally {
    fs.rmSync(hooksDirectory, { recursive: true, force: true });
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

function hookState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    indexTree: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    stagedDiff: git(repository, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--',
    ]),
    worktreeDiff: git(repository, ['diff', '--binary', '--full-index', '--']),
    runtimeExists: fs.existsSync(path.join(repository, '.git/workflow-engine')),
  };
}
