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

test('CI accepts an ordinary planning introduction as a distinct transition', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/planned-change']);
    writePlanningChange(repository, 'planned-change');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan planned-change',
      '-m',
      'Change: planned-change\nTransition: plan',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    const result = verifyPullRequest(repository, base, head);

    assert.deepEqual(result.completedTasks, []);
    assert.deepEqual(result.commits, [head]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a plan that targets the reserved OpenSpec archive container', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/archive']);
    writePlanningChange(repository, 'archive');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan archive',
      '-m',
      'Change: archive\nTransition: plan',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI authorizes a task from the planning revision in its parent', () => {
  const repository = createFixtureRepository();
  try {
    installPlanningMetadata(repository, 'demo-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Complete planning fixture']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths = ['feature/**'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.mkdirSync(path.join(repository, 'feature'));
    fs.writeFileSync(path.join(repository, 'feature/ok.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Complete revised task',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.doesNotThrow(() => verifyPullRequest(repository, base, head));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a later plan revision cannot retroactively widen an earlier task', () => {
  const repository = createFixtureRepository();
  try {
    installPlanningMetadata(repository, 'demo-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Complete planning fixture']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Complete task outside its parent scope',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);

    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths.push('outside.txt');
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_OUT_OF_SCOPE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an invalid broad parent contract cannot be laundered by a later narrow plan', () => {
  const repository = createFixtureRepository();
  try {
    installPlanningMetadata(repository, 'demo-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Complete planning fixture']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths = ['outside.txt'];
    guard.tasks['9.9'] = {
      allowedPaths: ['outside.txt'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Use invalid historical authority',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);

    delete guard.tasks['9.9'];
    guard.tasks['1.1'].allowedPaths = ['src/**'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_PARENT_GUARD_INVALID'),
    );
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
  assert.match(workflow, /on:\n {2}pull_request_target:/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n {10}path: trusted-base/,
  );
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /path: candidate/);
  assert.match(workflow, /fetch-tags: true/);
  assert.match(
    workflow,
    /for-each-ref --format='delete %\(refname\)' refs\/tags\/workflow-grant\//,
  );
  assert.match(
    workflow,
    /refs\/tags\/workflow-grant\/\*:refs\/tags\/workflow-grant\/\*/,
  );
  assert.equal(
    workflow.match(/pnpm install --frozen-lockfile --ignore-scripts/g)?.length,
    2,
  );
  assert.match(
    workflow,
    /\.\.\/trusted-base\/packages\/workflow-engine\/src\/cli\.ts ci/,
  );
  assert.doesNotMatch(workflow, /secrets\.|pnpm workflow ci/);
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

function installPlanningMetadata(repository: string, changeId: string): void {
  fs.writeFileSync(
    path.join(repository, 'openspec/changes', changeId, '.openspec.yaml'),
    'schema: spec-driven\ncreated: 2026-07-15\n',
  );
}

function writePlanningChange(repository: string, changeId: string): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(directory, 'specs/demo'), { recursive: true });
  installPlanningMetadata(repository, changeId);
  fs.writeFileSync(path.join(directory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(directory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Planned task\n',
  );
  fs.writeFileSync(
    path.join(directory, 'guard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n',
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
