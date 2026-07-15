import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { withArchiveEligibility } from '../src/archive-eligibility.ts';
import { startSession } from '../src/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

test('archive eligibility binds completed task evidence to the configured base', () => {
  const repository = completedFixture();
  try {
    const result = withArchiveEligibility(
      repository,
      'demo-change',
      (eligibility) => eligibility,
    );

    assert.equal(result.changeId, 'demo-change');
    assert.equal(result.baseRef, 'main');
    assert.equal(result.base, git(repository, ['rev-parse', 'main']).trim());
    assert.equal(result.taskCommits.length, 1);
    assert.match(result.contractDigest, /^[0-9a-f]{64}$/);
    assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects incomplete and unevidenced task state', () => {
  const incomplete = configuredFixture();
  const unevidenced = configuredFixture();
  try {
    git(incomplete, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(incomplete, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASKS_INCOMPLETE'),
    );

    completeTasks(unevidenced);
    git(unevidenced, ['add', '.']);
    git(unevidenced, ['commit', '-m', 'Forge completion']);
    git(unevidenced, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(unevidenced, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(incomplete, { recursive: true, force: true });
    fs.rmSync(unevidenced, { recursive: true, force: true });
  }
});

test('archive eligibility rejects task evidence not reachable from configured base', () => {
  const repository = configuredFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    completeTasks(repository);
    commitTask(repository);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_COMMIT_UNREACHABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects dirty state, active sessions, and lock collisions', () => {
  const dirty = completedFixture();
  const active = configuredFixture();
  const locked = completedFixture();
  try {
    fs.writeFileSync(path.join(dirty, 'dirty.txt'), 'dirty\n');
    assert.throws(
      () => withArchiveEligibility(dirty, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_WORKTREE_DIRTY'),
    );

    git(active, ['checkout', '-b', 'work/demo-change']);
    startSession(active, 'demo-change', '1.1');
    assert.throws(
      () => withArchiveEligibility(active, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );

    const lockDirectory = path.join(runtimeRoot(locked), 'locks');
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(lockDirectory, 'demo-change.lock'),
      '{"transition":"archive"}\n',
    );
    assert.throws(
      () => withArchiveEligibility(locked, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TRANSITION_CONFLICT'),
    );
  } finally {
    fs.rmSync(dirty, { recursive: true, force: true });
    fs.rmSync(active, { recursive: true, force: true });
    fs.rmSync(locked, { recursive: true, force: true });
  }
});

test('archive eligibility rejects strict-validation failures and unsafe targets', () => {
  const invalid = configuredFixture();
  const unsafeTarget = configuredFixture();
  try {
    fs.appendFileSync(
      path.join(invalid, 'openspec/changes/demo-change/proposal.md'),
      'INVALID\n',
    );
    completeTasks(invalid);
    commitTask(invalid);
    git(invalid, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(invalid, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'),
    );

    const baseSpec = path.join(unsafeTarget, 'openspec/specs/demo/spec.md');
    fs.mkdirSync(path.dirname(baseSpec), { recursive: true });
    fs.writeFileSync(baseSpec, '# Base spec\n');
    fs.chmodSync(baseSpec, 0o755);
    git(unsafeTarget, ['add', '.']);
    git(unsafeTarget, ['commit', '-m', 'Add unsafe archive target']);
    completeTasks(unsafeTarget);
    commitTask(unsafeTarget);
    git(unsafeTarget, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () =>
        withArchiveEligibility(unsafeTarget, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TARGET_UNSAFE'),
    );
  } finally {
    fs.rmSync(invalid, { recursive: true, force: true });
    fs.rmSync(unsafeTarget, { recursive: true, force: true });
  }
});

test('archive eligibility rejects an exact dated destination collision', () => {
  const repository = configuredFixture();
  try {
    fs.mkdirSync(
      path.join(repository, 'openspec/changes/archive/2026-07-15-demo-change'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        repository,
        'openspec/changes/archive/2026-07-15-demo-change/proposal.md',
      ),
      '# Archived\n',
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add colliding archive']);
    completeTasks(repository);
    commitTask(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () =>
        withArchiveEligibility(
          repository,
          'demo-change',
          () => undefined,
          new Date('2026-07-15T12:00:00.000Z'),
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_DESTINATION_COLLISION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function configuredFixture(): string {
  return createFixtureRepository();
}

function completedFixture(): string {
  const repository = configuredFixture();
  completeTasks(repository);
  commitTask(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  return repository;
}

function completeTasks(repository: string): void {
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
}

function commitTask(repository: string): void {
  git(repository, ['add', '.']);
  git(repository, [
    'commit',
    '-m',
    'Complete demo task',
    '-m',
    'Change: demo-change\nTask: 1.1',
  ]);
}
