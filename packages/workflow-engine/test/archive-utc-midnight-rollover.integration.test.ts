import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/application/archive/archive-transition.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  syncOriginMain,
} from './fixture.ts';

const START_DATE = '2026-08-09T23:59:59.999Z';
const ROLLOVER_DATE = '2026-08-10T00:00:00.001Z';
const SECOND_ROLLOVER_DATE = '2026-08-11T00:00:00.001Z';
const ARCHIVE_DATE = '2026-08-10';

test('archive retries once under the same operation when exact output crosses to the adjacent UTC day', () => {
  const repository = completedFixture();
  const clock = fixedClock(START_DATE, ROLLOVER_DATE);
  try {
    const worktrees = worktreeTopology(repository);
    const committed = commitArchiveTransition(
      repository,
      'demo-change',
      process.env,
      { now: clock.now },
    );

    assert.equal(committed.status, 'committed');
    assert.equal(clock.calls(), 2);
    assert.equal(
      committed.archivePath,
      `openspec/changes/archive/${ARCHIVE_DATE}-demo-change`,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(worktreeTopology(repository), worktrees);

    const replay = commitArchiveTransition(repository, 'demo-change');
    assert.equal(replay.status, 'already-archived');
    assert.equal(replay.commitHash, committed.commitHash);
    assert.equal(replay.reportId, committed.reportId);
    assert.equal(replay.archivePath, committed.archivePath);
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive rollover refresh refuses to adopt a concurrent clean commit', () => {
  const repository = completedFixture();
  const before = git(repository, ['rev-parse', 'HEAD']).trim();
  let competingCommit = '';
  let calls = 0;
  const now = (): Date => {
    calls += 1;
    if (calls === 2) {
      competingCommit = git(repository, [
        'commit-tree',
        `${before}^{tree}`,
        '-p',
        before,
        '-m',
        'Concurrent clean commit',
      ]).trim();
      git(repository, [
        'update-ref',
        'refs/heads/work/archive-demo',
        competingCommit,
        before,
      ]);
      return new Date(ROLLOVER_DATE);
    }
    return new Date(START_DATE);
  };
  try {
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now,
        }),
      (error) =>
        isWorkflowError(error, 'ARCHIVE_HEAD_CHANGED') ||
        isWorkflowError(error, 'ARCHIVE_ELIGIBILITY_CHANGED'),
    );

    assert.equal(calls, 2);
    assert.notEqual(competingCommit, '');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      competingCommit,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/archive')),
      false,
    );
    assert.deepEqual(
      entriesIfPresent(path.join(runtimeRoot(repository), 'archive-reports')),
      [],
    );
    assert.deepEqual(
      entriesIfPresent(path.join(runtimeRoot(repository), 'archive-patches')),
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive rejects an adjacent output date when the operation clock did not cross UTC midnight', () => {
  const repository = completedFixture();
  const clock = fixedClock(START_DATE, START_DATE);
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );

    assert.equal(clock.calls(), 2);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive does not retry a non-adjacent payload date', () => {
  const repository = completedFixture();
  const clock = fixedClock('2026-08-08T23:59:59.999Z');
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );

    assert.equal(clock.calls(), 1);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive does not reinterpret an escaped payload as a UTC rollover', () => {
  const repository = completedFixture('ARCHIVE_ESCAPE');
  const clock = fixedClock(START_DATE, ROLLOVER_DATE);
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );

    assert.equal(clock.calls(), 1);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive requires exact payload identity and shape before recognizing a UTC rollover', () => {
  const repository = completedFixture();
  const binPath = fixtureOpenSpecBin(repository);
  const exactSource = fs.readFileSync(binPath, 'utf8');
  const malformedSources = [
    replaceExactlyOnce(
      exactSource,
      '    archive: {\n      change: changeId,\n      archivedAs: archiveName,',
      "    archive: {\n      change: 'other-change',\n      archivedAs: archiveName,",
    ),
    replaceExactlyOnce(
      exactSource,
      '      totals: applied.totals\n    },',
      '      totals: applied.totals,\n      unexpected: true\n    },',
    ),
  ];
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    for (const malformedSource of malformedSources) {
      fs.writeFileSync(binPath, malformedSource);
      const clock = fixedClock(START_DATE, ROLLOVER_DATE);
      assert.throws(
        () =>
          commitArchiveTransition(repository, 'demo-change', process.env, {
            now: clock.now,
          }),
        (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
      );
      assert.equal(clock.calls(), 1);
      assert.deepEqual(repositoryState(repository), before);
      assert.equal(worktreeTopology(repository), worktrees);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive bounds a second adjacent UTC rollover without a third attempt', () => {
  const repository = completedFixture();
  const counterPath = configureFixtureArchiveDateSequence(repository);
  const clock = fixedClock(START_DATE, ROLLOVER_DATE, SECOND_ROLLOVER_DATE);
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_UTC_DATE_ROLLOVER'),
    );

    assert.equal(clock.calls(), 3);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function fixedClock(...timestamps: string[]) {
  let calls = 0;
  return {
    now(): Date {
      const timestamp = timestamps[Math.min(calls, timestamps.length - 1)];
      calls += 1;
      assert.ok(timestamp);
      return new Date(timestamp);
    },
    calls: () => calls,
  };
}

function completedFixture(marker = ''): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    `${addedDelta()}${marker ? `\n${marker}\n` : ''}`,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure archive delta']);
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  git(repository, ['add', '.']);
  git(repository, [
    'commit',
    '-m',
    'Complete demo task',
    '-m',
    'Change: demo-change\nTask: 1.1',
  ]);
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  pinFixtureArchiveDate(repository, ARCHIVE_DATE);
  return repository;
}

function pinFixtureArchiveDate(repository: string, date: string): void {
  const binPath = fixtureOpenSpecBin(repository);
  const source = fs.readFileSync(binPath, 'utf8');
  const expression = "new Date().toISOString().slice(0, 10) + '-' + changeId";
  const replacement = `'${date}' + '-' + changeId`;
  const updated = source.replace(expression, replacement);
  assert.notEqual(updated, source);
  assert.equal(updated.includes(expression), false);
  fs.writeFileSync(binPath, updated);
}

function fixtureOpenSpecBin(repository: string): string {
  return path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
}

function configureFixtureArchiveDateSequence(repository: string): string {
  const binPath = fixtureOpenSpecBin(repository);
  const counterPath = path.join(repository, '.git', 'archive-date-count');
  const source = fs.readFileSync(binPath, 'utf8');
  const expression = `'${ARCHIVE_DATE}' + '-' + changeId`;
  const sequence = [
    '(() => {',
    `  const counterPath = ${JSON.stringify(counterPath)};`,
    "  const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
    '  fs.writeFileSync(counterPath, String(count + 1));',
    "  return count === 0 ? '2026-08-10' : '2026-08-11';",
    `})() + '-' + changeId`,
  ].join('\n');
  fs.writeFileSync(binPath, replaceExactlyOnce(source, expression, sequence));
  return counterPath;
}

function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
): string {
  const index = source.indexOf(expected);
  assert.notEqual(index, -1);
  assert.equal(source.indexOf(expected, index + expected.length), -1);
  return `${source.slice(0, index)}${replacement}${source.slice(
    index + expected.length,
  )}`;
}

function addedDelta(): string {
  return [
    '# Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    'The system SHALL provide a demo.',
    '',
    '#### Scenario: Demo works',
    '',
    '- **WHEN** the demo runs',
    '- **THEN** it succeeds',
    '',
  ].join('\n');
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}

function worktreeTopology(repository: string): string {
  return git(repository, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => !line.startsWith('HEAD '))
    .join('\n');
}

function entriesIfPresent(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}
