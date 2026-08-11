import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import {
  inspectTaskRevisionStatus,
  resumeTask,
  reviseTask,
} from '../src/task-revision.ts';
import {
  abortSession,
  checkSession,
  getSession,
  listSessions,
  startSession,
} from '../src/session.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const STARTED_AT = new Date('2026-08-11T01:00:00.000Z');

test('revise-task durably suspends execution and no-op resume restores the same session', () => {
  const repository = revisionFixture();
  try {
    const implementationPath = path.join(repository, 'src/feature.ts');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(implementationPath, 'export const value = 1;\n');
    const checked = checkSession(repository, session.sessionId);
    assert.match(checked.reportId, /^[0-9a-f]{64}$/);
    const before = fs.readFileSync(implementationPath);

    const revising = reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });

    assert.equal(revising.session.sessionId, session.sessionId);
    assert.equal(revising.session.state, 'revising');
    assert.match(revising.lease.leaseId, /^revision-[0-9a-f-]{36}$/);
    assert.equal(revising.lease.phase, 'revising');
    assert.deepEqual(revising.lease.implementationPaths, ['src/feature.ts']);
    assert.equal(revising.session.latestCheckReportId, undefined);
    assert.deepEqual(fs.readFileSync(implementationPath), before);
    assert.deepEqual(
      listSessions(repository).map(({ sessionId }) => sessionId),
      [session.sessionId],
    );
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => workflowCode(error) === 'SESSION_NOT_ACTIVE',
    );

    const resumed = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:05:00.000Z'),
    });
    assert.equal(resumed.session.sessionId, session.sessionId);
    assert.equal(resumed.session.state, 'active');
    assert.equal(resumed.session.revisionLeaseId, undefined);
    assert.equal(resumed.lease.phase, 'completed');
    assert.deepEqual(fs.readFileSync(implementationPath), before);
    assert.equal(checkSession(repository, session.sessionId).passed, true);

    const status = inspectTaskRevisionStatus(repository, session.sessionId);
    assert.equal(status?.phase, 'completed');
    assert.equal(status?.retrySafe, false);
    assert.equal(status?.sessionId, session.sessionId);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resume-task detects implementation drift and abort preserves every byte', () => {
  const repository = revisionFixture();
  try {
    const implementationPath = path.join(repository, 'src/feature.ts');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(implementationPath, 'export const value = 1;\n');
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });

    const drifted = 'export const value = 2;\n';
    fs.writeFileSync(implementationPath, drifted);
    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
        }),
      (error) => workflowCode(error) === 'REVISION_WORKTREE_DRIFT',
    );
    assert.equal(getSession(repository, session.sessionId).state, 'revising');

    const aborted = abortSession(
      repository,
      session.sessionId,
      'Revision cannot continue safely.',
    );
    assert.equal(aborted.state, 'aborted');
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), drifted);
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.phase,
      'revoked',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('no-op resume refuses planning edits without consuming the revision lease', () => {
  const repository = revisionFixture();
  try {
    const implementationPath = path.join(repository, 'src/feature.ts');
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(implementationPath, 'export const value = 1;\n');
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });

    fs.appendFileSync(proposalPath, '\nA reviewed correction is required.\n');
    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
        }),
      (error) => workflowCode(error) === 'REVISION_PLAN_COMMIT_REQUIRED',
    );
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.phase,
      'revising',
    );
    assert.equal(
      fs
        .readFileSync(proposalPath, 'utf8')
        .endsWith('\nA reviewed correction is required.\n'),
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('revise-task crash windows replay one exact durable lease', () => {
  for (const crashPoint of ['lease-prepared', 'session-revising'] as const) {
    const repository = revisionFixture();
    try {
      const session = startSession(repository, 'demo-change', '1.1');
      fs.writeFileSync(
        path.join(repository, 'src/feature.ts'),
        'export const value = 1;\n',
      );
      assert.throws(
        () =>
          reviseTask(repository, session.sessionId, 'correct-plan', {
            now: () => STARTED_AT,
            testCrashAfter: crashPoint,
          }),
        /simulated task revision crash/,
      );
      const interrupted = inspectTaskRevisionStatus(
        repository,
        session.sessionId,
      );
      assert.equal(
        interrupted?.phase,
        crashPoint === 'lease-prepared' ? 'prepared' : 'session-revising',
      );

      const recovered = reviseTask(
        repository,
        session.sessionId,
        'correct-plan',
        { now: () => new Date('2026-08-11T01:01:00.000Z') },
      );
      assert.equal(recovered.lease.leaseId, interrupted?.leaseId);
      assert.equal(recovered.lease.phase, 'revising');
      assert.equal(recovered.session.state, 'revising');
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('resume-task crash after session activation completes idempotently', () => {
  const repository = revisionFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const value = 1;\n',
    );
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          testCrashAfter: 'session-active',
        }),
      /simulated task revision crash/,
    );
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.phase,
      'resume-prepared',
    );

    const recovered = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:06:00.000Z'),
    });
    assert.equal(recovered.session.state, 'active');
    assert.equal(recovered.lease.phase, 'completed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an expired revision lease stays fail closed but remains abortable', () => {
  const repository = revisionFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });
    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-12T01:00:00.000Z'),
        }),
      (error) => workflowCode(error) === 'REVISION_LEASE_EXPIRED',
    );
    assert.equal(
      abortSession(repository, session.sessionId, 'Lease expired.').state,
      'aborted',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('revision commands and status expose the exact durable lease', () => {
  const repository = revisionFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const value = 1;\n',
    );
    const revise = runWorkflowCli(repository, [
      'revise-task',
      session.sessionId,
      '--reason',
      'Correct the reviewed plan.',
    ]);
    assert.equal(revise.command, 'revise-task');
    assert.equal(
      (revise.result as { session: { state: string } }).session.state,
      'revising',
    );

    const status = runWorkflowCli(repository, ['status', session.sessionId]);
    assert.equal((status.taskRevision as { phase: string }).phase, 'revising');
    assert.equal(
      (status.taskRevision as { retryCommand: string }).retryCommand,
      `pnpm workflow resume-task ${session.sessionId} --json`,
    );

    const resume = runWorkflowCli(repository, [
      'resume-task',
      session.sessionId,
    ]);
    assert.equal(
      (resume.result as { session: { state: string } }).session.state,
      'active',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function revisionFixture(): string {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', 'work/demo-change']);
  return repository;
}

function workflowCode(error: unknown): string | null {
  return error instanceof WorkflowError ? error.code : null;
}

function runWorkflowCli(
  repository: string,
  args: string[],
): Record<string, unknown> {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        ...args,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    ),
  ) as Record<string, unknown>;
}
