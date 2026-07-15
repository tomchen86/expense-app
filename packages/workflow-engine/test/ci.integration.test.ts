import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { verifyPullRequest } from '../src/ci.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

test('CI recomputes task, scope, trailers, and checks without runtime reports', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);
    const fakeReports = path.join(repository, '.git/workflow-engine/reports');
    fs.mkdirSync(fakeReports, { recursive: true });
    fs.writeFileSync(path.join(fakeReports, 'forged.json'), '{}\n');

    const result = verifyPullRequest(repository, base, head);
    assert.deepEqual(result.completedTasks, [
      { changeId: 'demo-change', taskId: '1.1' },
    ]);
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ['fixture'],
    );
    assert.deepEqual(result.changedPaths, [
      'openspec/changes/demo-change/tasks.md',
      'src/feature.ts',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a completed checkbox without an exact task trailer', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository, { trailers: false });
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_TRAILERS_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects aggregate paths outside newly completed task scope', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_OUT_OF_SCOPE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a later trailer commit cannot authorize an earlier checkbox transition', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    commitCompletedTask(repository, { trailers: false });
    fs.writeFileSync(path.join(repository, 'src/follow-up.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Add delayed task trailer',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_TRAILERS_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a managed trailer without its task transition', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Claim an incomplete task without completing it',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_TRANSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects replay of an already completed task trailer', () => {
  const repository = createFixtureRepository();
  try {
    commitCompletedTask(repository);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/replay']);
    fs.writeFileSync(path.join(repository, 'src/follow-up.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Replay completed task authority',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_TRANSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects completion that skips an earlier task', () => {
  const repository = createFixtureRepository();
  try {
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.appendFileSync(tasksPath, '- [ ] 1.2 Second task\n');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.2'] = {
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add second fixture task']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/skip-task']);
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.2', '- [x] 1.2'),
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Skip the first task',
      '-m',
      'Change: demo-change\nTask: 1.2',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_ORDER_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects reordering existing tasks to manufacture a valid prefix', () => {
  const repository = createFixtureRepository();
  try {
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      '# Tasks\n\n- [ ] 1.1 Demo task\n- [ ] 1.2 Second task\n',
    );
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.2'] = {
      allowedPaths: ['openspec/changes/demo-change/tasks.md', 'src/**'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add second reorderable fixture task']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/reorder-task']);
    fs.writeFileSync(
      tasksPath,
      '# Tasks\n\n- [x] 1.2 Second task\n- [ ] 1.1 Demo task\n',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Reorder tasks around the completion frontier',
      '-m',
      'Change: demo-change\nTask: 1.2',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_ORDER_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects head policy self-broadening for an existing change', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths.push('outside.txt');
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_GUARD_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI requires PR head to contain the exact current base', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);
    git(repository, ['checkout', 'main']);
    fs.writeFileSync(path.join(repository, 'base-update.txt'), 'base update\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Advance target branch']);
    const advancedBase = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', 'work/demo-change']);
    assert.throws(
      () => verifyPullRequest(repository, advancedBase, head),
      (error) => isWorkflowError(error, 'CI_BASE_NOT_ANCESTOR'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI only grants implicit tasks.md scope to exact checkbox projection', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('Demo task', 'Rewritten task'),
    );
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_PROJECTION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a required check that mutates the checkout', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', 'mutated.txt'],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_CHECK_MUTATED_WORKTREE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI requires exact commit IDs and the checked out head', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, 'HEAD~1', head),
      (error) => isWorkflowError(error, 'CI_COMMIT_ID_INVALID'),
    );
    assert.throws(
      () => verifyPullRequest(repository, base, base),
      (error) => isWorkflowError(error, 'CI_HEAD_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a semantic bootstrap exception applies only when its change is introduced', () => {
  const repository = createFixtureRepository();
  try {
    const sourceCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '--orphan', 'ci-base']);
    fs.rmSync(path.join(repository, 'openspec/changes/demo-change'), {
      recursive: true,
      force: true,
    });
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Create CI base without change']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/bootstrap']);
    const policyPath = path.join(repository, 'workflow/ci-policy.json');
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          bootstrapExceptions: [
            {
              changeId: 'demo-change',
              taskIds: ['1.1'],
              compatibilityCommits: [],
              introductionPaths: [
                'openspec/changes/demo-change/proposal.md',
                'openspec/changes/demo-change/design.md',
                'openspec/changes/demo-change/tasks.md',
                'openspec/changes/demo-change/guard.json',
                'openspec/changes/demo-change/specs/demo/spec.md',
              ],
              allowedPaths: [
                'openspec/changes/demo-change/**',
                'src/**',
                'workflow/ci-policy.json',
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    git(repository, [
      'checkout',
      sourceCommit,
      '--',
      'openspec/changes/demo-change',
    ]);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Bootstrap demo change']);
    const introducedHead = git(repository, ['rev-parse', 'HEAD']).trim();

    const introduced = verifyPullRequest(repository, base, introducedHead);
    assert.deepEqual(introduced.completedTasks, [
      { changeId: 'demo-change', taskId: '1.1' },
    ]);

    fs.writeFileSync(path.join(repository, 'src/later.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Attempt to reuse bootstrap exception']);
    const laterHead = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, introducedHead, laterHead),
      (error) => isWorkflowError(error, 'CI_COMMIT_TRAILERS_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow assurance CI is read-only and policy paths have owners', () => {
  const workflow = fs.readFileSync(
    path.join(sourceRepositoryRoot, '.github/workflows/workflow-assurance.yml'),
    'utf8',
  );
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /pnpm workflow ci/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\./);
  const actionRefs = [...workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(actionRefs.length > 0);
  assert.ok(actionRefs.every((reference) => /^[0-9a-f]{40}$/.test(reference)));

  const owners = fs.readFileSync(
    path.join(sourceRepositoryRoot, '.github/CODEOWNERS'),
    'utf8',
  );
  for (const protectedPath of [
    '/AGENTS.md',
    '/.husky/',
    '/.github/workflows/',
    '/.github/CODEOWNERS',
    '/openspec/',
    '/workflow/',
    '/packages/workflow-engine/',
    '/package.json',
    '/pnpm-lock.yaml',
    '/pnpm-workspace.yaml',
  ]) {
    assert.match(owners, new RegExp(`^${escapeRegex(protectedPath)} `, 'm'));
  }
});

function commitCompletedTask(
  repository: string,
  options: { trailers?: boolean } = {},
): string {
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  git(repository, ['add', '.']);
  const message =
    options.trailers === false
      ? ['commit', '-m', 'Complete task without trailers']
      : [
          'commit',
          '-m',
          'Complete demo task',
          '-m',
          'Change: demo-change\nTask: 1.1',
        ];
  git(repository, message);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
