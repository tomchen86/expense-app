import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverRepository } from '../src/git.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test(
  'Git facts ignore caller PATH, repository redirects, and fsmonitor injection',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const decoy = createFixtureRepository();
    const attackDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-git-attack-'),
    );
    const markerPath = path.join(attackDirectory, 'executed');
    const hookPath = path.join(attackDirectory, 'fsmonitor.sh');
    const fakeGitPath = path.join(attackDirectory, 'git');
    const keys = [
      'PATH',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
    ] as const;
    const original = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );

    try {
      fs.writeFileSync(
        hookPath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nprintf '0\\n/\\n'\n`,
      );
      fs.writeFileSync(
        fakeGitPath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 1\n`,
      );
      fs.chmodSync(hookPath, 0o755);
      fs.chmodSync(fakeGitPath, 0o755);
      git(repository, ['config', 'core.fsmonitor', hookPath]);
      const expectedHead = git(repository, ['rev-parse', 'HEAD']).trim();

      process.env.PATH = attackDirectory;
      process.env.GIT_DIR = path.join(decoy, '.git');
      process.env.GIT_WORK_TREE = decoy;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
      process.env.GIT_CONFIG_VALUE_0 = hookPath;

      const state = discoverRepository(repository);

      assert.equal(state.repositoryRealPath, fs.realpathSync(repository));
      assert.equal(state.head, expectedHead);
      assert.equal(fs.existsSync(markerPath), false);
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(decoy, { recursive: true, force: true });
      fs.rmSync(attackDirectory, { recursive: true, force: true });
    }
  },
);

test('Git facts reject index flags that hide tracked changes', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['update-index', flag, 'package.json']);
      fs.appendFileSync(path.join(repository, 'package.json'), '\n');

      assert.throws(
        () => discoverRepository(repository),
        (error) => isWorkflowError(error, 'UNSAFE_INDEX_FLAGS'),
        flag,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});
