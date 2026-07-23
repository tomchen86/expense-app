import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverRepository,
  fingerprintRepositoryProjection,
  fingerprintWorkingState,
} from '../src/git.ts';
import { checkSession, startSession } from '../src/session.ts';
import { loadStableValidatedChangeContract } from '../src/validated-contract-context.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
} from './fixture.ts';

test(
  'working-state fingerprints ignore Git-invisible macOS provenance metadata',
  { skip: process.platform !== 'darwin' },
  () => {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const targetPath = path.join(repository, 'src/.gitkeep');
      const before = discoverRepository(repository);
      const strictFingerprint = fingerprintWorkingState(
        repository,
        before.head,
        before.statusEntries,
      );
      const projectionFingerprint = fingerprintRepositoryProjection(
        repository,
        before.head,
        before.statusEntries,
      );

      execFileSync('/usr/bin/xattr', [
        '-wx',
        'com.apple.provenance',
        '0102',
        targetPath,
      ]);

      const after = discoverRepository(repository);
      assert.notEqual(
        fingerprintWorkingState(repository, after.head, after.statusEntries),
        strictFingerprint,
      );
      assert.equal(
        fingerprintRepositoryProjection(
          repository,
          after.head,
          after.statusEntries,
        ),
        projectionFingerprint,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test(
  'required checks cannot hide a macOS provenance metadata mutation',
  { skip: process.platform !== 'darwin' },
  () => {
    const repository = createFixtureRepository();
    const targetPath = path.join(repository, 'src/.gitkeep');
    try {
      fs.writeFileSync(
        path.join(repository, 'scripts/set-provenance.mjs'),
        [
          "import { execFileSync } from 'node:child_process';",
          "execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.provenance', '0102', process.argv[2]]);",
          '',
        ].join('\n'),
      );
      configureChecks(
        repository,
        {
          mutating: {
            command: ['node', 'scripts/set-provenance.mjs', targetPath],
            destructiveDatabase: false,
          },
        },
        ['mutating'],
      );
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      assert.throws(
        () => checkSession(repository, session.sessionId),
        (error) => isWorkflowError(error, 'CHECK_MUTATED_WORKTREE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('passing checks cannot mutate repository-ignored files', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ignored-state-'),
  );
  const ignoredPath = path.join(repository, 'ignored-state.txt');
  const laterMarker = path.join(outputDirectory, 'later-ran');
  try {
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      'ignored-state.txt\n',
    );
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', ignoredPath],
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
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('working-state fingerprints accept literal Git path metacharacters', () => {
  const repository = createFixtureRepository();
  const ignoredPath = path.join(
    repository,
    'node_modules/fixture/[...rsc]+api.ts',
  );
  try {
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.writeFileSync(ignoredPath, 'export {};\n');
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.doesNotThrow(() => checkSession(repository, session.sessionId));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ignored nested repositories use canonical directory records in fingerprints', () => {
  const repository = createFixtureRepository();
  const ignoredRepository = path.join(repository, 'memo');
  const renamedRepository = path.join(repository, 'memo2');
  try {
    fs.appendFileSync(path.join(repository, '.gitignore'), '/memo/\n/memo2/\n');
    git(repository, ['add', '.gitignore']);
    git(repository, ['commit', '-m', 'Ignore nested repositories']);
    fs.mkdirSync(ignoredRepository);
    git(ignoredRepository, ['init', '-b', 'main']);

    const ignoredRecords = git(repository, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-per-directory=.gitignore',
      '-z',
      '--',
    ]);
    assert.match(ignoredRecords, /memo\/\0/);

    const before = discoverRepository(repository);
    assert.doesNotThrow(() =>
      loadStableValidatedChangeContract(before, 'demo-change'),
    );
    const beforeFingerprint = fingerprintWorkingState(
      repository,
      before.head,
      before.statusEntries,
    );

    fs.renameSync(ignoredRepository, renamedRepository);
    const after = discoverRepository(repository);
    assert.doesNotThrow(() =>
      loadStableValidatedChangeContract(after, 'demo-change'),
    );
    assert.notEqual(
      fingerprintWorkingState(repository, after.head, after.statusEntries),
      beforeFingerprint,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('local Git excludes cannot hide out-of-scope paths', () => {
  const repository = createFixtureRepository();
  const outsidePath = path.join(repository, 'outside.txt');
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.appendFileSync(
      path.join(repository, '.git/info/exclude'),
      'outside.txt\n',
    );
    fs.writeFileSync(outsidePath, 'must remain visible\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'local core.fileMode cannot hide tracked executable-mode mutations',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const targetPath = path.join(repository, 'src/.gitkeep');
    try {
      configureChecks(
        repository,
        {
          mutating: {
            command: ['node', 'scripts/chmod-file.mjs', targetPath],
            destructiveDatabase: false,
          },
        },
        ['mutating'],
      );
      git(repository, ['config', 'core.fileMode', 'false']);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      assert.throws(
        () => checkSession(repository, session.sessionId),
        (error) => isWorkflowError(error, 'CHECK_MUTATED_WORKTREE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('local stat settings cannot hide tracked content mutations', () => {
  const repository = createFixtureRepository();
  const targetPath = path.join(repository, 'src/state.txt');
  try {
    fs.writeFileSync(targetPath, 'before');
    const stableTime = new Date(1_700_000_000_000);
    fs.utimesSync(targetPath, stableTime, stableTime);
    configureChecks(
      repository,
      {
        mutating: {
          command: [
            'node',
            'scripts/replace-preserve-times.mjs',
            targetPath,
            'after!',
          ],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    git(repository, ['config', 'core.trustctime', 'false']);
    git(repository, ['config', 'core.checkStat', 'minimal']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_MUTATED_WORKTREE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
