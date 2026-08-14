import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitSession,
  completeTask,
  finalizeTask,
  findTaskCommits,
  finishSession,
  rollbackCompletion,
} from '../src/lifecycle.ts';
import {
  hasExactTrailers,
  previewExactStaging,
  stageExactPaths,
} from '../src/git-transitions.ts';
import { renderHandoff } from '../src/handoff.ts';
import { projectTasksCompleted } from '../src/task-projection.ts';
import {
  readImmutableReport,
  writeImmutableReport,
  type WorkflowReport,
} from '../src/report-store.ts';
import { readFinalizeTransaction } from '../src/finalize-transaction.ts';
import { resolveFinalizeCheckPolicy } from '../src/finalize-check-policy.ts';
import { writeJsonAtomic } from '../src/session-store.ts';
import { checkSession, getSession, startSession } from '../src/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

test('explicit full-gate escalation substitutes only reviewed covered checks and does not impersonate terminal state', () => {
  const tasks = [
    { id: '1.1', completed: true, title: 'First' },
    { id: '1.2', completed: false, title: 'Second' },
  ];
  assert.deepEqual(
    resolveFinalizeCheckPolicy(
      tasks,
      ['scoped', 'workflow-tests'],
      {
        allTasksTerminalChecks: [
          {
            checkId: 'workflow-full-gate',
            subsumes: ['workflow-tests'],
          },
        ],
      },
      true,
    ),
    {
      requiredChecks: ['scoped', 'workflow-full-gate'],
      checkEscalation: 'explicit',
    },
  );
});

test(
  'task projection preserves existing extended attributes on macOS',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-task-projection-xattr-'),
    );
    const tasksPath = path.join(directory, 'tasks.md');
    fs.writeFileSync(tasksPath, '- [ ] 1.1 Demo task\n');
    try {
      execFileSync('/usr/bin/xattr', [
        '-wx',
        'com.apple.provenance',
        '0102',
        tasksPath,
      ]);
      const provenance = execFileSync('/usr/bin/xattr', [
        '-px',
        'com.apple.provenance',
        tasksPath,
      ]);

      projectTasksCompleted(tasksPath, ['1.1']);

      assert.deepEqual(
        execFileSync('/usr/bin/xattr', [
          '-px',
          'com.apple.provenance',
          tasksPath,
        ]),
        provenance,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'completion evidence remains current after Git-invisible macOS provenance metadata changes',
  { skip: process.platform !== 'darwin' },
  () => {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');
      fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
      checkSession(repository, session.sessionId);

      execFileSync('/usr/bin/xattr', [
        '-wx',
        'com.apple.provenance',
        '0102',
        path.join(repository, 'src/.gitkeep'),
      ]);

      assert.doesNotThrow(() => completeTask(repository, session.sessionId));
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('completion evidence becomes stale after ignored content changes', () => {
  const repository = createFixtureRepository();
  const ignoredPath = path.join(repository, 'ignored-state.txt');
  try {
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      'ignored-state.txt\n',
    );
    fs.writeFileSync(ignoredPath, 'before');
    const stableTime = new Date(1_700_000_000_000);
    fs.utimesSync(ignoredPath, stableTime, stableTime);
    configureChecks(
      repository,
      {
        passing: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        },
      },
      ['passing'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);

    fs.writeFileSync(ignoredPath, 'after!');
    fs.utimesSync(ignoredPath, stableTime, stableTime);

    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_REPORT_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

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

test('projected single-pass finalize checks and stages one exact final tree', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'projected-finalize-success-'),
  );
  const counterPath = path.join(outputDirectory, 'count');
  try {
    enableCompletionHandoff(repository);
    fs.writeFileSync(
      path.join(repository, 'scripts/assert-final-projection.mjs'),
      [
        "import fs from 'node:fs';",
        'const counterPath = process.argv[2];',
        "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
        'fs.writeFileSync(counterPath, String(count + 1));',
        "const tasks = fs.readFileSync('openspec/changes/demo-change/tasks.md', 'utf8');",
        "const handoff = fs.readFileSync('docs/CURRENT_AND_NEXT_STEPS.md', 'utf8');",
        'if (!/- \\[x\\] 1\\.1 Demo task/.test(tasks)) process.exit(17);',
        "if (!handoff.includes('None — no active change.')) process.exit(18);",
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        projected: {
          command: ['node', 'scripts/assert-final-projection.mjs', counterPath],
          destructiveDatabase: false,
        },
      },
      ['projected'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    const cliPath = path.resolve(import.meta.dirname, '../src/cli.ts');
    const cliOutput = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        'finalize-task',
        session.sessionId,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    const finalized = JSON.parse(cliOutput).result;

    assert.equal(finalized.assurance, 'projected-single-pass-ordinary-failure');
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.deepEqual(finalized.stagedPaths, [
      'docs/CURRENT_AND_NEXT_STEPS.md',
      'openspec/changes/demo-change/tasks.md',
      'src/feature.ts',
    ]);
    assert.equal(git(repository, ['write-tree']).trim(), finalized.tree);
    assert.equal(git(repository, ['diff', '--name-only']).trim(), '');

    const finalizedSession = getSession(repository, session.sessionId);
    assert.match(finalizedSession.latestCheckReportId ?? '', /^[0-9a-f]{64}$/);
    assert.match(finalizedSession.completionReportId ?? '', /^[0-9a-f]{64}$/);
    assert.match(finalizedSession.finishReportId ?? '', /^[0-9a-f]{64}$/);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const checkReport = readImmutableReport(
      reportsRoot,
      session.sessionId,
      finalizedSession.latestCheckReportId!,
    );
    const completionReport = readImmutableReport(
      reportsRoot,
      session.sessionId,
      finalizedSession.completionReportId!,
    );
    const finishReport = readImmutableReport(
      reportsRoot,
      session.sessionId,
      finalizedSession.finishReportId!,
    );
    assert.equal(
      completionReport.parentReportId,
      finalizedSession.latestCheckReportId,
    );
    assert.equal(
      finishReport.parentReportId,
      finalizedSession.completionReportId,
    );
    assert.deepEqual(checkReport.checks, finishReport.checks);
    assert.equal(finishReport.tree, finalized.tree);
    for (const report of [checkReport, completionReport, finishReport]) {
      assert.equal(
        report.finalizeProfile,
        'projected-single-pass-ordinary-failure',
      );
      assert.equal(report.candidateTree, finalized.tree);
    }

    commitSession(repository, session.sessionId, 'Complete once');
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('finalize adds terminal policy checks only when its projection closes the task set', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'terminal-finalize-policy-'),
  );
  const scopedCounter = path.join(outputDirectory, 'scoped-count');
  const terminalCounter = path.join(outputDirectory, 'terminal-count');
  try {
    const incrementScript = path.join(repository, 'scripts/increment.mjs');
    fs.writeFileSync(
      incrementScript,
      [
        "import fs from 'node:fs';",
        'const target = process.argv[2];',
        "const count = fs.existsSync(target) ? Number(fs.readFileSync(target, 'utf8')) : 0;",
        'fs.writeFileSync(target, String(count + 1));',
        '',
      ].join('\n'),
    );
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'tasks.md'),
      '# Tasks\n\n- [ ] 1.1 First task\n- [ ] 1.2 Second task\n',
    );
    const guardPath = path.join(changeDirectory, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, unknown>;
    };
    guard.tasks = {
      '1.1': {
        allowedPaths: ['src/**'],
        requiredChecks: ['workflow-tests'],
      },
      '1.2': {
        allowedPaths: ['src/**'],
        requiredChecks: ['workflow-tests'],
      },
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    fs.writeFileSync(
      path.join(repository, 'workflow/checks.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          checks: {
            'workflow-tests': {
              command: ['node', 'scripts/increment.mjs', scopedCounter],
              destructiveDatabase: false,
            },
            'workflow-full-gate': {
              command: ['node', 'scripts/increment.mjs', terminalCounter],
              destructiveDatabase: false,
              liveStderr: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const configPath = path.join(repository, 'workflow/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.allTasksTerminalChecks = [
      {
        checkId: 'workflow-full-gate',
        subsumes: ['workflow-tests'],
      },
    ];
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Configure terminal finalize policy']);
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const first = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {}\n');
    const firstFinalized = finalizeTask(repository, first.sessionId);
    assert.equal(fs.readFileSync(scopedCounter, 'utf8'), '1');
    assert.equal(fs.existsSync(terminalCounter), false);
    const firstTransaction = readFinalizeTransaction(
      runtimeRoot(repository),
      first.sessionId,
    );
    assert.deepEqual(firstTransaction?.requiredChecks, ['workflow-tests']);
    assert.equal(firstTransaction?.checkEscalation, null);
    commitSession(repository, first.sessionId, 'Complete first task');

    const second = startSession(repository, 'demo-change', '1.2');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const complete = true;\n',
    );
    const secondRun = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(import.meta.dirname, '../src/cli.ts'),
        'finalize',
        second.sessionId,
        '--message',
        'Complete second task',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.match(
      secondRun.stderr,
      /This finalize completes the change → running full gate\./,
    );
    const secondFinalized = JSON.parse(secondRun.stdout).result as {
      checkReportId: string;
      commitHash: string;
      tree: string;
    };
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      secondFinalized.commitHash,
    );
    assert.equal(fs.readFileSync(scopedCounter, 'utf8'), '1');
    assert.equal(fs.readFileSync(terminalCounter, 'utf8'), '1');
    const secondTransaction = readFinalizeTransaction(
      runtimeRoot(repository),
      second.sessionId,
    );
    assert.deepEqual(secondTransaction?.requiredChecks, ['workflow-full-gate']);
    assert.equal(secondTransaction?.checkEscalation, 'all-tasks-terminal');
    const secondReport = readImmutableReport(
      path.join(runtimeRoot(repository), 'reports'),
      second.sessionId,
      secondFinalized.checkReportId,
    );
    assert.deepEqual(secondReport.requiredChecks, ['workflow-full-gate']);
    assert.equal(secondReport.checkEscalation, 'all-tasks-terminal');
    assert.notEqual(firstFinalized.tree, secondFinalized.tree);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('compatible finish cannot bypass checks required by the terminal transition', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'terminal-compatible-finish-'),
  );
  const scopedCounter = path.join(outputDirectory, 'scoped-count');
  const terminalCounter = path.join(outputDirectory, 'terminal-count');
  try {
    fs.writeFileSync(
      path.join(repository, 'scripts/increment.mjs'),
      [
        "import fs from 'node:fs';",
        'const target = process.argv[2];',
        "const count = fs.existsSync(target) ? Number(fs.readFileSync(target, 'utf8')) : 0;",
        'fs.writeFileSync(target, String(count + 1));',
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        'workflow-tests': {
          command: ['node', 'scripts/increment.mjs', scopedCounter],
          destructiveDatabase: false,
        },
        'workflow-full-gate': {
          command: ['node', 'scripts/increment.mjs', terminalCounter],
          destructiveDatabase: false,
          liveStderr: true,
        },
      },
      ['workflow-tests'],
    );
    const configPath = path.join(repository, 'workflow/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.allTasksTerminalChecks = [
      {
        checkId: 'workflow-full-gate',
        subsumes: ['workflow-tests'],
      },
    ];
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    git(repository, ['add', 'workflow/config.json']);
    git(repository, ['commit', '-m', 'Require terminal full gate']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {}\n');

    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);
    const finished = finishSession(repository, session.sessionId);
    assert.equal(fs.readFileSync(scopedCounter, 'utf8'), '1');
    assert.equal(fs.readFileSync(terminalCounter, 'utf8'), '1');
    const finishReport = readImmutableReport(
      path.join(runtimeRoot(repository), 'reports'),
      session.sessionId,
      finished.reportId,
    );
    assert.deepEqual(finishReport.requiredChecks, ['workflow-full-gate']);
    assert.equal(finishReport.checkEscalation, 'all-tasks-terminal');
    assert.doesNotThrow(() =>
      commitSession(repository, session.sessionId, 'Complete with full gate'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('projected single-pass commit rejects a mismatched frozen candidate tree', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    finalizeTask(repository, session.sessionId);
    const finalizedSession = getSession(repository, session.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const finishReport = readImmutableReport(
      reportsRoot,
      session.sessionId,
      finalizedSession.finishReportId!,
    );
    const mismatchedFinishReport: WorkflowReport = {
      ...finishReport,
      candidateTree: '0'.repeat(40),
    };
    const mismatchedFinishReportId = writeImmutableReport(
      reportsRoot,
      mismatchedFinishReport,
    );
    writeJsonAtomic(
      path.join(
        runtimeRoot(repository),
        'sessions',
        `${session.sessionId}.json`,
      ),
      { ...finalizedSession, finishReportId: mismatchedFinishReportId },
    );

    assert.throws(
      () => commitSession(repository, session.sessionId, 'Reject mismatch'),
      (error) => isWorkflowError(error, 'FINISH_REPORT_STALE'),
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      session.baseline.head,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('projected single-pass failure restores projections and leaves no evidence pointers', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'projected-finalize-failure-'),
  );
  const observationPath = path.join(outputDirectory, 'observation');
  try {
    enableCompletionHandoff(repository);
    fs.writeFileSync(
      path.join(repository, 'scripts/reject-final-projection.mjs'),
      [
        "import fs from 'node:fs';",
        'const observationPath = process.argv[2];',
        "const tasks = fs.readFileSync('openspec/changes/demo-change/tasks.md', 'utf8');",
        "const handoff = fs.readFileSync('docs/CURRENT_AND_NEXT_STEPS.md', 'utf8');",
        "const projected = /- \\[x\\] 1\\.1 Demo task/.test(tasks) && handoff.includes('None — no active change.');",
        "fs.writeFileSync(observationPath, projected ? 'projected' : 'missing');",
        'process.exit(projected ? 17 : 18);',
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        rejecting: {
          command: [
            'node',
            'scripts/reject-final-projection.mjs',
            observationPath,
          ],
          destructiveDatabase: false,
        },
      },
      ['rejecting'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    const beforeTasks = fs.readFileSync(tasksPath);
    const beforeHandoff = fs.readFileSync(handoffPath);
    const beforeTaskMode = fs.statSync(tasksPath).mode;
    const beforeHandoffMode = fs.statSync(handoffPath).mode;
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'CHECK_FAILED'),
    );

    assert.equal(fs.readFileSync(observationPath, 'utf8'), 'projected');
    assert.deepEqual(fs.readFileSync(tasksPath), beforeTasks);
    assert.deepEqual(fs.readFileSync(handoffPath), beforeHandoff);
    assert.equal(fs.statSync(tasksPath).mode, beforeTaskMode);
    assert.equal(fs.statSync(handoffPath).mode, beforeHandoffMode);
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(
      fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
      'export {};\n',
    );
    const restored = getSession(repository, session.sessionId);
    assert.equal(restored.state, 'active');
    assert.equal(restored.latestCheckReportId, undefined);
    assert.equal(restored.completionReportId, undefined);
    assert.equal(restored.finishReportId, undefined);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('projected single-pass rejects post-check worktree drift and rolls back staging', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    const beforeTasks = fs.readFileSync(tasksPath);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    fs.writeFileSync(
      path.join(repository, '.git/mutate-allowed-status-countdown'),
      '4',
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OPENSPEC_MUTATED_REPOSITORY'),
    );

    assert.deepEqual(fs.readFileSync(tasksPath), beforeTasks);
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.match(
      fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
      /postCheckDrift/,
    );
    const restored = getSession(repository, session.sessionId);
    assert.equal(restored.state, 'active');
    assert.equal(restored.latestCheckReportId, undefined);
    assert.equal(restored.completionReportId, undefined);
    assert.equal(restored.finishReportId, undefined);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('exact staging rejects allowed-path bytes that differ from the checked prospective tree', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const featurePath = path.join(repository, 'src/feature.ts');
    fs.writeFileSync(featurePath, 'export const checked = true;\n');
    const preview = previewExactStaging(repository, baselineHead, [
      'src/feature.ts',
    ]);

    fs.writeFileSync(featurePath, 'export const drifted = true;\n');

    assert.throws(
      () =>
        stageExactPaths(repository, baselineHead, ['src/feature.ts'], {
          expectedTree: preview.tree,
          expectedPreviousIndexTree: preview.previousIndexTree,
        }),
      (error) => isWorkflowError(error, 'FINALIZE_PROJECTION_CHANGED'),
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(
      fs.readFileSync(featurePath, 'utf8'),
      'export const drifted = true;\n',
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

function enableCompletionHandoff(repository: string): void {
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
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  renderHandoff(repository);
}
