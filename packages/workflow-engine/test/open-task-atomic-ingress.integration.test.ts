import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { validateCiPlanningCommit } from '../src/entrypoints/ci/ci-planning.ts';
import { commitFacts } from '../src/runtime/repository-transaction/git-transitions.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import {
  openTask,
  readOpenTaskJournal,
} from '../src/application/execute-task/open-task.ts';
import { readPlanningTransitionReport } from '../src/runtime/storage-journal/planning-report.ts';
import { preparePlanningDraftWorkspace } from '../src/runtime/session-workspace/planning-workspace.ts';
import { abortSession } from '../src/application/execute-task/session.ts';
import { readSessionFile } from '../src/runtime/session-workspace/session-store.ts';
import { revokeTaskMandate } from '../src/modules/authority/task-mandate.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';

test('ordinary open-task crash recovery preserves explicit no-mandate authority', () => {
  const fixture = prepareOrdinaryOpenTaskFixture('ordinary-open-recovery');
  try {
    assert.throws(
      () =>
        openTask(fixture.repository, fixture.changeId, '1.1', undefined, {
          testCrashAfter: 'journal-prepared',
        }),
      /Simulated open-task interruption/,
    );
    const prepared = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.equal(prepared?.schemaVersion, 2);
    assert.equal(prepared?.kind, 'open-task-transaction.v2');
    assert.equal(prepared?.mandateTaskId, null);
    assert.equal(prepared?.mandateBinding, null);
    assert.match(
      prepared?.authorizationPolicyDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );

    const status = runWorkflowCli(fixture.repository, [
      'status',
      fixture.changeId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout) as {
      openTask: { recoveryCommand: string };
    };
    assert.doesNotMatch(statusPayload.openTask.recoveryCommand, /--mandate/u);

    const result = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      undefined,
    );
    assert.equal(result.recovered, true);
    assert.equal(result.mandateTaskId, null);
    const session = readSessionFile(
      path.join(
        runtimeRoot(fixture.repository),
        'sessions',
        `${result.sessionId}.json`,
      ),
    );
    assert.equal(session.mandateBinding, undefined);
  } finally {
    fixture.dispose();
  }
});

test('open-task atomically commits the owned draft and activates its exact session', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-success');
  try {
    const result = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      fixture.mandate.taskId,
      { mandate: { signer: fixture.mandate.signer } },
    );

    assert.equal(result.recovered, false);
    assert.equal(result.changeId, fixture.changeId);
    assert.equal(result.taskId, '1.1');
    assert.equal(result.mandateTaskId, fixture.mandate.taskId);
    assert.equal(result.worktree, fs.realpathSync(fixture.repository));
    assert.equal(result.branch, `work/${fixture.changeId}`);
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      result.planningCommit,
    );
    assert.equal(git(fixture.repository, ['status', '--porcelain=v1']), '');
    assert.deepEqual(commitFacts(fixture.repository, result.planningCommit), {
      hash: result.planningCommit,
      parents: [fixture.baselineHead],
      tree: result.baselineTree,
      message: `Plan ${fixture.changeId}\n\nChange: ${fixture.changeId}\nTransition: plan\n`,
    });

    const session = readSessionFile(
      path.join(
        runtimeRoot(fixture.repository),
        'sessions',
        `${result.sessionId}.json`,
      ),
    );
    assert.equal(session.state, 'active');
    assert.equal(session.sessionId, result.sessionId);
    assert.equal(session.baseline.head, result.planningCommit);
    assert.equal(session.baseline.tree, result.baselineTree);
    assert.deepEqual(session.allowedPaths, ['src/**']);
    assert.deepEqual(session.requiredChecks, ['fixture']);
    assert.deepEqual(session.mandateBinding, fixture.mandate.binding);

    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.equal(journal?.phase, 'completed');
    assert.equal(journal?.sessionId, result.sessionId);
    assert.equal(journal?.planningCommit, result.planningCommit);
    assert.ok(journal);
    const status = runWorkflowCli(fixture.repository, [
      'status',
      result.sessionId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout) as {
      openTask: Record<string, unknown>;
      session: { sessionId: string };
    };
    assert.equal(statusPayload.openTask.state, 'active');
    assert.equal(statusPayload.openTask.lastDurablePhase, 'completed');
    assert.equal(statusPayload.openTask.retrySafe, true);
    assert.equal(statusPayload.openTask.recoveryCommand, null);
    assert.equal(statusPayload.session.sessionId, result.sessionId);
  } finally {
    fixture.dispose();
  }
});

test('open-task commits its engine-owned opening projection and CI replays the exact union', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-projection', {
    handoff: true,
  });
  try {
    const before = fs.readFileSync(
      path.join(fixture.repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.match(before, /`demo-change`/u);

    const result = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      fixture.mandate.taskId,
      { mandate: { signer: fixture.mandate.signer } },
    );
    const after = fs.readFileSync(
      path.join(fixture.repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.notEqual(after, before);
    assert.match(after, /`atomic-open-projection`/u);
    assert.match(after, /`1\.1` — Atomic ingress/u);
    assert.ok(commitFacts(fixture.repository, result.planningCommit));

    const changedPaths = git(fixture.repository, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      result.planningCommit,
    ])
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.ok(changedPaths.includes('docs/CURRENT_AND_NEXT_STEPS.md'));
    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.ok(journal);
    assert.deepEqual(journal.changedPaths, changedPaths);
    const commonDirectoryValue = git(fixture.repository, [
      'rev-parse',
      '--git-common-dir',
    ]).trim();
    const commonDirectory = fs.realpathSync(
      path.isAbsolute(commonDirectoryValue)
        ? commonDirectoryValue
        : path.resolve(fixture.repository, commonDirectoryValue),
    );
    const report = readPlanningTransitionReport(
      path.join(commonDirectory, 'workflow-engine/planning-reports'),
      journal.reportId,
    );
    assert.deepEqual(report.engineProjectionPaths, [
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ]);
    assert.deepEqual(
      report.planningPaths,
      changedPaths.filter(
        (changedPath) => changedPath !== 'docs/CURRENT_AND_NEXT_STEPS.md',
      ),
    );
    assert.deepEqual(
      validateCiPlanningCommit(
        fixture.repository,
        result.planningCommit,
        fixture.changeId,
      ).changedPaths,
      changedPaths,
    );
  } finally {
    fixture.dispose();
  }
});

test('status preserves the terminal session state after open-task ingress completes', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-terminal-status');
  try {
    const result = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      fixture.mandate.taskId,
      { mandate: { signer: fixture.mandate.signer } },
    );
    abortSession(
      fixture.repository,
      result.sessionId,
      'terminal status fixture',
    );

    const status = runWorkflowCli(fixture.repository, [
      'status',
      result.sessionId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout) as {
      openTask: Record<string, unknown>;
      session: { sessionId: string; state: string };
    };
    assert.equal(payload.openTask.state, 'aborted');
    assert.equal(payload.openTask.lastDurablePhase, 'completed');
    assert.equal(payload.openTask.retrySafe, false);
    assert.equal(payload.openTask.recoveryCommand, null);
    assert.equal(payload.openTask.errorCode, null);
    assert.equal(payload.session.sessionId, result.sessionId);
    assert.equal(payload.session.state, 'aborted');
  } finally {
    fixture.dispose();
  }
});

test('open-task restores its opening projection before CAS and regenerates it on exact retry', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-projection-retry', {
    handoff: true,
  });
  try {
    const handoffPath = path.join(
      fixture.repository,
      'docs/CURRENT_AND_NEXT_STEPS.md',
    );
    const before = fs.readFileSync(handoffPath, 'utf8');
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/u,
    );
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), before);
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baselineHead,
    );

    const recovered = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      fixture.mandate.taskId,
      { mandate: { signer: fixture.mandate.signer } },
    );
    assert.equal(recovered.recovered, true);
    assert.match(
      fs.readFileSync(handoffPath, 'utf8'),
      /`atomic-open-projection-retry`/u,
    );
    assert.equal(git(fixture.repository, ['status', '--porcelain=v1']), '');
  } finally {
    fixture.dispose();
  }
});

test('open-task recovery accepts only the parent or prepared projection bytes', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-projection-authority', {
    handoff: true,
  });
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/u,
    );
    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.ok(journal);
    const handoffPath = path.join(
      fixture.repository,
      'docs/CURRENT_AND_NEXT_STEPS.md',
    );
    fs.writeFileSync(handoffPath, '# Foreign projection\n');

    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          { mandate: { signer: fixture.mandate.signer } },
        ),
      (error) => isWorkflowError(error, 'OPEN_TASK_PROJECTION_DIVERGED'),
    );
    assert.equal(
      fs.readFileSync(handoffPath, 'utf8'),
      '# Foreign projection\n',
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baselineHead,
    );
  } finally {
    fixture.dispose();
  }
});

test('open-task recovery reconciles a durable prepared projection crash window', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-projection-crash', {
    handoff: true,
  });
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/u,
    );
    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.ok(journal);
    fs.writeFileSync(
      path.join(fixture.repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      git(fixture.repository, [
        'show',
        `${journal.planningCommit}:docs/CURRENT_AND_NEXT_STEPS.md`,
      ]),
    );

    const recovered = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      fixture.mandate.taskId,
      { mandate: { signer: fixture.mandate.signer } },
    );
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.planningCommit, journal.planningCommit);
    assert.equal(git(fixture.repository, ['status', '--porcelain=v1']), '');
  } finally {
    fixture.dispose();
  }
});

for (const crashAfter of [
  'journal-prepared',
  'plan-committed',
  'session-active',
] as const) {
  test(`open-task recovers the exact ${crashAfter} interruption without a second plan commit`, () => {
    const fixture = prepareOpenTaskFixture(`atomic-open-${crashAfter}`);
    try {
      assert.throws(
        () =>
          openTask(
            fixture.repository,
            fixture.changeId,
            '1.1',
            fixture.mandate.taskId,
            {
              mandate: { signer: fixture.mandate.signer },
              testCrashAfter: crashAfter,
            },
          ),
        /Simulated open-task interruption/,
      );

      const interrupted = readOpenTaskJournal(
        fixture.repository,
        fixture.changeId,
        '1.1',
      );
      assert.equal(
        interrupted?.phase,
        {
          'journal-prepared': 'prepared',
          'plan-committed': 'plan-committed',
          'session-active': 'session-active',
        }[crashAfter],
      );
      const interruptedHead = git(fixture.repository, [
        'rev-parse',
        'HEAD',
      ]).trim();
      assert.equal(
        interruptedHead,
        crashAfter === 'journal-prepared'
          ? fixture.baselineHead
          : interrupted?.planningCommit,
      );

      const recovered = openTask(
        fixture.repository,
        fixture.changeId,
        '1.1',
        fixture.mandate.taskId,
        { mandate: { signer: fixture.mandate.signer } },
      );
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.planningCommit, interrupted?.planningCommit);
      assert.equal(recovered.sessionId, interrupted?.sessionId);
      assert.equal(
        git(fixture.repository, [
          'rev-list',
          '--count',
          `${fixture.baselineHead}..HEAD`,
        ]).trim(),
        '1',
      );
      assert.equal(git(fixture.repository, ['status', '--porcelain=v1']), '');

      const completed = readOpenTaskJournal(
        fixture.repository,
        fixture.changeId,
        '1.1',
      );
      assert.equal(completed?.phase, 'completed');
      assert.equal(completed?.planningCommit, interrupted?.planningCommit);
      assert.equal(completed?.sessionId, interrupted?.sessionId);
      const session = readSessionFile(
        path.join(
          runtimeRoot(fixture.repository),
          'sessions',
          `${recovered.sessionId}.json`,
        ),
      );
      assert.equal(session.state, 'active');
      assert.equal(session.baseline.head, recovered.planningCommit);
    } finally {
      fixture.dispose();
    }
  });
}

test('status exposes the exact durable open-task phase and retry authority', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-status');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'plan-committed',
          },
        ),
      /Simulated open-task interruption/u,
    );
    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.ok(journal);
    const journalBytes = fs.readFileSync(openTaskJournalPath(fixture), 'utf8');
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    const status = runWorkflowCli(fixture.repository, [
      'status',
      journal.transactionId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout) as {
      openTask: Record<string, unknown>;
    };
    assert.deepEqual(payload.openTask, {
      kind: 'open-task-lifecycle-status.v1',
      state: 'opening',
      lastDurablePhase: 'plan-committed',
      transactionId: journal.transactionId,
      changeId: fixture.changeId,
      taskId: '1.1',
      mandateTaskId: fixture.mandate.taskId,
      sessionId: journal.sessionId,
      parentCommit: journal.parentCommit,
      planningCommit: journal.planningCommit,
      baselineTree: journal.baselineTree,
      reportId: journal.reportId,
      retrySafe: true,
      recoveryCommand: `pnpm workflow open-task ${fixture.changeId} --task 1.1 --mandate ${fixture.mandate.taskId} --json`,
      errorCode: null,
    });
    assert.equal(
      fs.readFileSync(openTaskJournalPath(fixture), 'utf8'),
      journalBytes,
    );
    assert.equal(git(fixture.repository, ['rev-parse', 'HEAD']).trim(), head);
  } finally {
    fixture.dispose();
  }
});

test('status classifies a durable phase ahead of its exact session as recovery-required', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-status-diverged');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'plan-committed',
          },
        ),
      /Simulated open-task interruption/u,
    );
    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.ok(journal);
    fs.writeFileSync(
      openTaskJournalPath(fixture),
      `${canonicalJson({ ...journal, phase: 'session-active' })}\n`,
      { mode: 0o600 },
    );

    const status = runWorkflowCli(fixture.repository, [
      'status',
      journal.transactionId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout) as {
      openTask: Record<string, unknown>;
    };
    assert.equal(payload.openTask.state, 'recovery-required');
    assert.equal(payload.openTask.lastDurablePhase, 'session-active');
    assert.equal(payload.openTask.retrySafe, false);
    assert.equal(payload.openTask.recoveryCommand, null);
    assert.equal(payload.openTask.errorCode, 'OPEN_TASK_PHASE_DIVERGED');
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          { mandate: { signer: fixture.mandate.signer } },
        ),
      (error) => isWorkflowError(error, 'OPEN_TASK_PHASE_DIVERGED'),
    );
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(fixture.repository),
          'sessions',
          `${journal.sessionId}.json`,
        ),
      ),
      false,
    );
  } finally {
    fixture.dispose();
  }
});

test('open-task preserves a granular recovery error and adds durable phase context', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-error-context');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/u,
    );
    const journal = readOpenTaskJournal(
      fixture.repository,
      fixture.changeId,
      '1.1',
    );
    assert.ok(journal);
    const competingCommit = git(fixture.repository, [
      'commit-tree',
      journal.parentTree,
      '-p',
      journal.parentCommit,
      '-m',
      'Competing commit',
    ]).trim();
    git(fixture.repository, [
      'update-ref',
      `refs/heads/${journal.branch}`,
      competingCommit,
      journal.parentCommit,
    ]);

    const result = runWorkflowCli(fixture.repository, [
      'open-task',
      fixture.changeId,
      '--task',
      '1.1',
      '--mandate',
      fixture.mandate.taskId,
      '--json',
    ]);
    assert.equal(result.status, 14);
    const payload = JSON.parse(result.stderr) as {
      error: {
        code: string;
        details: Record<string, unknown>;
        recovery: string;
      };
    };
    assert.equal(payload.error.code, 'OPEN_TASK_HEAD_DIVERGED');
    assert.equal(payload.error.details.transactionId, journal.transactionId);
    assert.equal(payload.error.details.phase, 'prepared');
    assert.equal(
      payload.error.recovery,
      `pnpm workflow status ${journal.transactionId} --json`,
    );
  } finally {
    fixture.dispose();
  }
});

test('open-task refuses a different mandate from taking over a prepared transaction', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-mandate-takeover');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/,
    );
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          'different-mandate-task',
        ),
      (error) => isWorkflowError(error, 'OPEN_TASK_TRANSACTION_MISMATCH'),
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baselineHead,
    );
  } finally {
    fixture.dispose();
  }
});

test('open-task revalidates an active mandate before recovering a pre-CAS journal', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-revoked-pre-cas');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/,
    );
    revokeTaskMandate(fixture.repository, fixture.mandate.taskId, {
      reason: 'Refuse the prepared transaction before its Git effect.',
      signer: fixture.mandate.signer,
    });
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          { mandate: { signer: fixture.mandate.signer } },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.equal(
      git(fixture.repository, ['rev-parse', 'HEAD']).trim(),
      fixture.baselineHead,
    );
  } finally {
    fixture.dispose();
  }
});

test('open-task completes the exact post-CAS transaction even if its mandate is later revoked', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-revoked-post-cas');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'plan-committed',
          },
        ),
      /Simulated open-task interruption/,
    );
    revokeTaskMandate(fixture.repository, fixture.mandate.taskId, {
      reason: 'Revoke after the exact planning ref effect is durable.',
      signer: fixture.mandate.signer,
    });
    const recovered = openTask(
      fixture.repository,
      fixture.changeId,
      '1.1',
      fixture.mandate.taskId,
    );
    assert.equal(recovered.recovered, true);
    assert.equal(
      readSessionFile(
        path.join(
          runtimeRoot(fixture.repository),
          'sessions',
          `${recovered.sessionId}.json`,
        ),
      ).state,
      'active',
    );
  } finally {
    fixture.dispose();
  }
});

test('open-task reconciles only its exact hard-link publication residue', () => {
  const fixture = prepareOpenTaskFixture('atomic-open-publication-residue');
  try {
    assert.throws(
      () =>
        openTask(
          fixture.repository,
          fixture.changeId,
          '1.1',
          fixture.mandate.taskId,
          {
            mandate: { signer: fixture.mandate.signer },
            testCrashAfter: 'journal-prepared',
          },
        ),
      /Simulated open-task interruption/,
    );
    const journalPath = openTaskJournalPath(fixture);
    const alias = `${journalPath}.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`;
    fs.linkSync(journalPath, alias);
    assert.equal(fs.lstatSync(journalPath).nlink, 2);

    assert.equal(
      readOpenTaskJournal(fixture.repository, fixture.changeId, '1.1')?.phase,
      'prepared',
    );
    assert.equal(fs.lstatSync(journalPath).nlink, 1);
    assert.equal(fs.existsSync(alias), false);

    const foreignAlias = `${journalPath}.foreign`;
    fs.linkSync(journalPath, foreignAlias);
    assert.throws(
      () => readOpenTaskJournal(fixture.repository, fixture.changeId, '1.1'),
      (error) => isWorkflowError(error, 'OPEN_TASK_JOURNAL_CORRUPT'),
    );
    assert.equal(fs.existsSync(foreignAlias), true);
  } finally {
    fixture.dispose();
  }
});

function prepareOpenTaskFixture(
  changeId: string,
  options: Readonly<{ handoff?: boolean }> = {},
): {
  repository: string;
  changeId: string;
  baselineHead: string;
  mandate: ReturnType<typeof prepareExecutionMandate>;
  dispose(): void;
} {
  const repository = createFixtureRepository();
  if (options.handoff === true) enableOpeningProjection(repository);
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();
  writeChange(repository, changeId);
  preparePlanningDraftWorkspace(repository, changeId, {
    adoptCurrentWorktree: true,
    now: new Date('2026-08-11T03:00:00.000Z'),
  });
  return {
    repository,
    changeId,
    baselineHead,
    mandate,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function prepareOrdinaryOpenTaskFixture(changeId: string): {
  repository: string;
  changeId: string;
  dispose(): void;
} {
  const repository = createFixtureRepository();
  const configPath = path.join(repository, 'workflow/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  config.taskAuthorization = {
    pathRoleRegistry: 'workflow/path-roles.json',
    mandateRequiredRoles: ['lifecycle'],
  };
  fs.writeFileSync(configPath, `${canonicalJson(config)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(repository, 'workflow/path-roles.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'path-role-registry',
      roles: {
        lifecycle: ['packages/workflow-engine/src/**'],
        ordinary: ['src/**'],
      },
    })}\n`,
    'utf8',
  );
  git(repository, ['add', 'workflow/config.json', 'workflow/path-roles.json']);
  git(repository, ['commit', '-m', 'Enable conditional task authorization']);
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  writeChange(repository, changeId);
  preparePlanningDraftWorkspace(repository, changeId, {
    adoptCurrentWorktree: true,
    now: new Date('2026-08-11T03:00:00.000Z'),
  });
  return {
    repository,
    changeId,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function enableOpeningProjection(repository: string): void {
  const policyPath = path.join(repository, 'workflow/document-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    documents: Record<string, unknown>;
  };
  policy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    source: 'openspec/changes/*/tasks.md',
    validator: 'managed-documents',
    transition: 'completion',
  };
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  renderHandoff(repository);
  git(repository, [
    'add',
    'workflow/document-policy.json',
    'docs/CURRENT_AND_NEXT_STEPS.md',
  ]);
  git(repository, ['commit', '-m', 'Enable opening projection']);
}

function writeChange(repository: string, changeId: string): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(directory, 'specs/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.openspec.yaml'),
    'schema: expense-app\ncreated: 2026-08-11\n',
  );
  fs.writeFileSync(path.join(directory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(directory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Atomic ingress\n',
  );
  fs.writeFileSync(
    path.join(directory, 'specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Atomic ingress',
      '',
      'The workflow SHALL bind its plan and task session atomically.',
      '',
      '#### Scenario: Opening succeeds',
      '',
      '- **WHEN** open-task accepts the planning draft',
      '- **THEN** one plan commit and one active session are durable',
      '',
    ].join('\n'),
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
}

function openTaskJournalPath(
  fixture: ReturnType<typeof prepareOpenTaskFixture>,
): string {
  return path.join(
    runtimeRoot(fixture.repository),
    'open-task',
    'transactions',
    `${fixture.changeId}.1.1.json`,
  );
}

function runWorkflowCli(repository: string, args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../src/cli.ts'),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env },
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
