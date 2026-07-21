import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  syncOriginMain,
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
    assert.equal(result.baseRef, 'refs/remotes/origin/main');
    assert.equal(
      result.base,
      git(repository, ['rev-parse', 'refs/remotes/origin/main']).trim(),
    );
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

test('archive eligibility exempts pre-epoch task completions', () => {
  const unevidenced = configuredFixture();
  const ambiguous = configuredFixture();
  try {
    completeTasks(unevidenced);
    git(unevidenced, ['add', '.']);
    git(unevidenced, ['commit', '-m', 'Bootstrap completion']);
    commitPlanRevision(unevidenced);
    git(unevidenced, ['checkout', '-b', 'work/archive-demo']);
    const result = withArchiveEligibility(
      unevidenced,
      'demo-change',
      (eligibility) => eligibility,
    );
    assert.equal(result.taskCommits.length, 0);

    completeTasks(ambiguous);
    commitTask(ambiguous);
    fs.writeFileSync(path.join(ambiguous, 'second.txt'), 'second\n');
    commitTask(ambiguous);
    commitPlanRevision(ambiguous);
    git(ambiguous, ['checkout', '-b', 'work/archive-demo']);
    const ambiguousResult = withArchiveEligibility(
      ambiguous,
      'demo-change',
      (eligibility) => eligibility,
    );
    assert.equal(ambiguousResult.taskCommits.length, 0);
  } finally {
    fs.rmSync(unevidenced, { recursive: true, force: true });
    fs.rmSync(ambiguous, { recursive: true, force: true });
  }
});

test('archive eligibility ignores a backdated parallel plan commit as epoch', () => {
  const repository = configuredFixture();
  try {
    commitPlanRevision(repository);
    completeTasks(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Forge completion after epoch']);
    git(repository, ['checkout', '-b', 'side/backdated-plan']);
    commitPlanRevision(repository, '2020-01-01T00:00:00Z');
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--no-ff', '--no-edit', 'side/backdated-plan']);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility keeps canonical-era completions enforced', () => {
  const repository = configuredFixture();
  try {
    commitPlanRevision(repository);
    completeTasks(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Forge completion after epoch']);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility resolves the base from the protected remote-tracking ref', () => {
  const repository = configuredFixture();
  try {
    completeTasks(repository);
    commitTask(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    const integrationTip = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['update-ref', 'refs/remotes/origin/main', integrationTip]);
    // The local protected branch falls behind the remote-tracking ref.
    git(repository, ['branch', '-f', 'main', `${integrationTip}~1`]);

    const result = withArchiveEligibility(
      repository,
      'demo-change',
      (eligibility) => eligibility,
    );

    assert.equal(result.base, integrationTip);
    assert.equal(result.taskCommits.length, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility fails closed when the remote-tracking base is unresolvable', () => {
  const repository = completedFixture();
  try {
    git(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_BASE_UNRESOLVED'),
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
  syncOriginMain(repository);
}

function commitPlanRevision(repository: string, committerDate?: string): void {
  fs.appendFileSync(
    path.join(repository, 'openspec/changes/demo-change/design.md'),
    '\nEpoch revision.\n',
  );
  git(repository, ['add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repository,
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: committerDate
        ? {
            ...process.env,
            GIT_AUTHOR_DATE: committerDate,
            GIT_COMMITTER_DATE: committerDate,
          }
        : process.env,
    },
  );
}
