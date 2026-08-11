import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitFacts } from '../src/git-transitions.ts';
import { openTask, readOpenTaskJournal } from '../src/open-task.ts';
import { preparePlanningDraftWorkspace } from '../src/planning-workspace.ts';
import { readSessionFile } from '../src/session-store.ts';
import { revokeTaskMandate } from '../src/task-mandate.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';

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
      assert.equal(interrupted?.phase, 'prepared');
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

function prepareOpenTaskFixture(changeId: string): {
  repository: string;
  changeId: string;
  baselineHead: string;
  mandate: ReturnType<typeof prepareExecutionMandate>;
  dispose(): void;
} {
  const repository = createFixtureRepository();
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
