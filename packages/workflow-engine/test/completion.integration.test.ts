import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  commitSession,
  completeTask,
  findTaskCommits,
  finishSession,
  rollbackCompletion,
} from '../src/lifecycle.ts';
import { hasExactTrailers } from '../src/git-transitions.ts';
import { renderHandoff } from '../src/handoff.ts';
import {
  writeImmutableReport,
  type WorkflowReport,
} from '../src/report-store.ts';
import { checkSession, getSession, startSession } from '../src/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

test('current report authorizes completion, exact staging, and commit', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CURRENT_CHECK_REPORT_REQUIRED'),
    );

    const checked = checkSession(repository, session.sessionId);
    assert.match(checked.reportId, /^[0-9a-f]{64}$/);
    assert.equal(getSession(repository, session.sessionId).state, 'active');

    const completed = completeTask(repository, session.sessionId);
    assert.deepEqual(completed.completedTaskIds, ['1.1']);
    assert.equal(completed.session.state, 'active');
    assert.equal(completed.session.completionReportId, completed.reportId);
    assert.match(completed.reportId, /^[0-9a-f]{64}$/);
    assert.match(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[x\] 1\.1 Demo task/,
    );

    const finished = finishSession(repository, session.sessionId);
    assert.equal(finished.session.state, 'active');
    assert.equal(finished.session.finishReportId, finished.reportId);
    assert.deepEqual(finished.stagedPaths, [
      'openspec/changes/demo-change/tasks.md',
      'src/feature.ts',
    ]);
    assert.match(finished.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(git(repository, ['diff', '--name-only']).trim(), '');

    const committed = commitSession(
      repository,
      session.sessionId,
      'Complete demo task',
    );
    assert.equal(committed.session.state, 'committed');
    assert.equal(
      committed.commitHash,
      git(repository, ['rev-parse', 'HEAD']).trim(),
    );
    assert.equal(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']).trim(),
      ['Complete demo task', '', 'Change: demo-change', 'Task: 1.1'].join('\n'),
    );
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
    assert.deepEqual(
      findTaskCommits(repository, 'demo-change', '1.1').map(
        (entry) => entry.hash,
      ),
      [committed.commitHash],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion rollback restores controlled projections and permits fresh evidence', () => {
  const repository = createFixtureRepository();
  try {
    const documentPolicyPath = path.join(
      repository,
      'workflow/document-policy.json',
    );
    const documentPolicy = JSON.parse(
      fs.readFileSync(documentPolicyPath, 'utf8'),
    );
    documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
      mode: 'generated',
      enforcement: 'active',
      transition: 'completion',
    };
    fs.writeFileSync(
      documentPolicyPath,
      `${JSON.stringify(documentPolicy, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(repository, 'docs'));
    renderHandoff(repository);
    git(repository, ['add', 'workflow/document-policy.json', 'docs']);
    git(repository, ['commit', '-m', 'Enable completion handoff']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    const baselineTasks = fs.readFileSync(tasksPath, 'utf8');
    const baselineHandoff = fs.readFileSync(handoffPath, 'utf8');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    const completed = completeTask(repository, session.sessionId);

    const rolledBack = rollbackCompletion(
      repository,
      session.sessionId,
      'A verification subprocess changed ignored filesystem metadata.',
    );

    assert.equal(fs.readFileSync(tasksPath, 'utf8'), baselineTasks);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), baselineHandoff);
    assert.equal(
      fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
      'export {};\n',
    );
    assert.equal(rolledBack.completionReportId, completed.reportId);
    assert.deepEqual(rolledBack.restoredPaths, [
      'docs/CURRENT_AND_NEXT_STEPS.md',
      'openspec/changes/demo-change/tasks.md',
    ]);
    const reset = getSession(repository, session.sessionId);
    assert.equal(reset.state, 'active');
    assert.equal(reset.latestCheckReportId, undefined);
    assert.equal(reset.completionReportId, undefined);
    assert.doesNotThrow(() => checkSession(repository, session.sessionId));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion rollback rejects empty reasons and finished sessions', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);

    assert.throws(
      () => rollbackCompletion(repository, session.sessionId, '   '),
      (error) => isWorkflowError(error, 'ROLLBACK_REASON_REQUIRED'),
    );

    finishSession(repository, session.sessionId);
    assert.throws(
      () => rollbackCompletion(repository, session.sessionId, 'Too late'),
      (error) => isWorkflowError(error, 'ROLLBACK_REQUIRES_PROJECTED_SESSION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion rejects stale and tampered check reports', () => {
  for (const tamper of ['worktree', 'report'] as const) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');
      fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'before\n');
      const checked = checkSession(repository, session.sessionId);

      if (tamper === 'worktree') {
        fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'after\n');
      } else {
        fs.appendFileSync(
          path.join(
            runtimeRoot(repository),
            'reports',
            session.sessionId,
            `${checked.reportId}.json`,
          ),
          '\n',
        );
      }

      assert.throws(
        () => completeTask(repository, session.sessionId),
        (error) =>
          isWorkflowError(
            error,
            tamper === 'worktree'
              ? 'CHECK_REPORT_STALE'
              : 'REPORT_DIGEST_MISMATCH',
          ),
        tamper,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('completion rejects a content-addressed report without check evidence', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'before\n');
    const checked = checkSession(repository, session.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const reportPath = path.join(
      reportsRoot,
      session.sessionId,
      `${checked.reportId}.json`,
    );
    const forged = JSON.parse(
      fs.readFileSync(reportPath, 'utf8'),
    ) as WorkflowReport;
    forged.checks = [];
    const forgedId = writeImmutableReport(reportsRoot, forged);
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    persisted.latestCheckReportId = forgedId;
    fs.writeFileSync(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`);

    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_REPORT_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('commit rejects a worktree changed after finish', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'before\n');
    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);
    finishSession(repository, session.sessionId);
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'after\n');

    assert.throws(
      () => commitSession(repository, session.sessionId, 'Complete demo task'),
      (error) => isWorkflowError(error, 'FINISH_REPORT_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion reconciles the immediate committed predecessor from Git', () => {
  const repository = createFixtureRepository();
  try {
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    const tasksPath = path.join(changeDirectory, 'tasks.md');
    fs.writeFileSync(
      tasksPath,
      [
        '# Tasks',
        '',
        '- [ ] 1.1 Prior task',
        '- [ ] 1.2 Current task',
        '',
      ].join('\n'),
    );
    const guardPath = path.join(changeDirectory, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.2'] = {
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', tasksPath, guardPath]);
    git(repository, ['commit', '-m', 'Add current task']);

    fs.writeFileSync(path.join(repository, 'src/prior.ts'), 'export {};\n');
    git(repository, ['add', 'src/prior.ts']);
    git(repository, [
      'commit',
      '-m',
      'Implement prior task',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const session = startSession(repository, 'demo-change', '1.2');
    fs.writeFileSync(path.join(repository, 'src/current.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    const result = completeTask(repository, session.sessionId);

    assert.deepEqual(result.completedTaskIds, ['1.1', '1.2']);
    const tasks = fs.readFileSync(tasksPath, 'utf8');
    assert.match(tasks, /- \[x\] 1\.1 Prior task/);
    assert.match(tasks, /- \[x\] 1\.2 Current task/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('predecessor reconciliation fails when its independent check fails', () => {
  const repository = createFixtureRepository();
  try {
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    const tasksPath = path.join(changeDirectory, 'tasks.md');
    fs.writeFileSync(
      tasksPath,
      '# Tasks\n\n- [ ] 1.1 Prior task\n- [ ] 1.2 Current task\n',
    );
    const checksPath = path.join(repository, 'workflow/checks.json');
    const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
    checks.checks['prior-fail'] = {
      command: ['node', 'scripts/fail.mjs'],
      destructiveDatabase: false,
    };
    fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
    const guardPath = path.join(changeDirectory, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].requiredChecks = ['prior-fail'];
    guard.tasks['1.2'] = {
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Configure two tasks']);
    fs.writeFileSync(path.join(repository, 'src/prior.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Implement prior task',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.2');
    fs.writeFileSync(path.join(repository, 'src/current.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);

    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_FAILED'),
    );
    assert.doesNotMatch(fs.readFileSync(tasksPath, 'utf8'), /\[x\]/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed commit bypasses hooks and accepts explicit workflow identity', () => {
  const repository = createFixtureRepository();
  try {
    const hooks = path.join(repository, '.managed-hooks');
    fs.mkdirSync(hooks);
    const hook = path.join(hooks, 'commit-msg');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 99\n');
    fs.chmodSync(hook, 0o755);
    git(repository, ['add', '.managed-hooks']);
    git(repository, ['commit', '-m', 'Add hostile hook']);
    git(repository, ['config', 'core.hooksPath', '.managed-hooks']);
    git(repository, ['config', '--unset', 'user.name']);
    git(repository, ['config', '--unset', 'user.email']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);
    finishSession(repository, session.sessionId);

    const committed = commitSession(
      repository,
      session.sessionId,
      'Complete without hooks',
      {
        WORKFLOW_GIT_AUTHOR_NAME: 'Workflow Test',
        WORKFLOW_GIT_AUTHOR_EMAIL: 'workflow@example.test',
      },
    );
    assert.equal(committed.session.state, 'committed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Git lookup returns multiple exact trailer matches without whitespace drift', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, [
      'commit',
      '--allow-empty',
      '-m',
      'First match',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    git(repository, [
      'commit',
      '--allow-empty',
      '-m',
      'Second match',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const matches = findTaskCommits(repository, 'demo-change', '1.1');
    assert.deepEqual(
      matches.map(({ subject }) => subject),
      ['Second match', 'First match'],
    );
    assert.equal(
      matches.every(({ hash }) => /^[0-9a-f]{40}$/.test(hash)),
      true,
    );
    assert.equal(
      hasExactTrailers(
        'Lookalike\n\nChange: demo-change\nTask: 1.1   \n',
        'demo-change',
        '1.1',
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
