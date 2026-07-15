import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/archive-transition.ts';
import { runCli } from '../src/cli.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

test('archive transition persists evidence, applies exact staging, commits, and is idempotent', () => {
  const repository = completedFixture(addedDelta());
  try {
    const before = git(repository, ['rev-parse', 'HEAD']).trim();
    const committed = commitArchiveTransition(repository, 'demo-change');

    assert.equal(committed.status, 'committed');
    assert.notEqual(committed.commitHash, before);
    assert.match(committed.reportId, /^[0-9a-f]{64}$/);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(repository, committed.archivePath)),
      true,
    );
    assert.equal(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']).trim(),
      'Archive demo-change\n\nChange: demo-change\nTransition: archive',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(repository),
          'archive-reports',
          `${committed.reportId}.json`,
        ),
      ),
      true,
    );

    const replay = commitArchiveTransition(repository, 'demo-change');
    assert.equal(replay.status, 'already-archived');
    assert.equal(replay.commitHash, committed.commitHash);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      committed.commitHash,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive CLI exposes the exact public transition command', () => {
  const repository = completedFixture(addedDelta());
  try {
    assert.equal(runCli(['archive', 'demo-change', '--json'], repository), 0);
    assert.match(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']),
      /Transition: archive/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rejects silently ignored delta outcomes', () => {
  const repository = completedFixture(
    '# Delta\n\n## REMOVED Requirements\n\n### Requirement: Missing\n',
  );
  try {
    const before = repositoryState(repository);
    assert.throws(
      () => commitArchiveTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ARCHIVE_DELTA_OUTCOME_INVALID'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rejects real-worktree drift before patch application', () => {
  const repository = completedFixture(addedDelta());
  const driftPath = path.join(repository, 'drift.txt');
  try {
    const before = repositoryState(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          beforeApply: () => fs.writeFileSync(driftPath, 'drift\n'),
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_ELIGIBILITY_CHANGED'),
    );
    fs.rmSync(driftPath);
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rolls back its patch when the branch loses the compare-and-swap race', () => {
  const repository = completedFixture(addedDelta());
  const before = git(repository, ['rev-parse', 'HEAD']).trim();
  let competingCommit = '';
  try {
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          beforeRefUpdate: ({ headRef }) => {
            competingCommit = git(repository, [
              'commit-tree',
              `${before}^{tree}`,
              '-p',
              before,
              '-m',
              'Competing commit',
            ]).trim();
            git(repository, ['update-ref', headRef, competingCommit, before]);
          },
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_HEAD_CHANGED'),
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      competingCommit,
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/archive')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rolls back its patch when persisted evidence is tampered', () => {
  const repository = completedFixture(addedDelta());
  const before = repositoryState(repository);
  try {
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          beforeRefUpdate: ({ reportId }) => {
            fs.appendFileSync(
              path.join(
                runtimeRoot(repository),
                'archive-reports',
                `${reportId}.json`,
              ),
              'tamper',
            );
          },
        }),
      (error) => isWorkflowError(error, 'CONTENT_RECORD_DIGEST_MISMATCH'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function completedFixture(delta: string): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    delta,
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
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  return repository;
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
