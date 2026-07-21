import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/archive-transition.ts';
import { verifyPullRequest } from '../src/ci.ts';
import {
  commitSession,
  completeTask,
  finishSession,
} from '../src/lifecycle.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { checkSession, startSession } from '../src/session.ts';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  syncOriginMain,
} from './fixture.ts';

const changeId = 'rehearsal-change';

test('disposable repository rehearses plan, task, archive, idempotency, and cross-date CI replay', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    writeRehearsalChange(repository);

    const planned = commitPlanningTransition(repository, changeId);
    assert.equal(planned.kind, 'introduction');
    assert.equal(
      git(repository, ['show', '-s', '--format=%B', planned.commitHash]).trim(),
      `Plan ${changeId}\n\nChange: ${changeId}\nTransition: plan`,
    );

    const session = startSession(repository, changeId, '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/rehearsal.ts'),
      'export const rehearsed = true;\n',
    );
    assert.equal(checkSession(repository, session.sessionId).passed, true);
    completeTask(repository, session.sessionId);
    finishSession(repository, session.sessionId);
    const completed = commitSession(
      repository,
      session.sessionId,
      'Complete disposable rehearsal',
    );

    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', completed.commitHash]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-rehearsal']);

    const archived = commitArchiveTransition(repository, changeId);
    assert.equal(archived.status, 'committed');
    const replay = commitArchiveTransition(repository, changeId);
    assert.equal(replay.status, 'already-archived');
    assert.equal(replay.commitHash, archived.commitHash);

    const crossDatePath = `openspec/changes/archive/2099-12-31-${changeId}`;
    fs.renameSync(
      path.join(repository, archived.archivePath),
      path.join(repository, crossDatePath),
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '--amend', '--no-edit']);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    const result = verifyPullRequest(repository, base, head);
    assert.deepEqual(result.commits, [
      planned.commitHash,
      completed.commitHash,
      head,
    ]);
    assert.deepEqual(result.archivedChanges, [changeId]);
    assert.deepEqual(
      result.completedTasks.map(({ changeId: id, taskId }) => [id, taskId]),
      [[changeId, '1.1']],
    );
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ['fixture'],
    );
    assert.equal(result.runtimeReportsTrusted, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function writeRehearsalChange(repository: string): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(directory, 'specs/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.openspec.yaml'),
    'schema: expense-app\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(directory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(directory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Disposable rehearsal\n',
  );
  fs.writeFileSync(
    path.join(directory, 'specs/demo/spec.md'),
    [
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
