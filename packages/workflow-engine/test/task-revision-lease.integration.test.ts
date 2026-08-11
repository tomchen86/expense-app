import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import { listChangedPaths } from '../src/git.ts';
import {
  inspectTaskRevisionStatus,
  resumeTask,
  reviseTask,
} from '../src/task-revision.ts';
import { commitChangedPaths } from '../src/git-transitions.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
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
  writeReadyV2ExemptChange,
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

test('resume refuses unreviewed planning edits without consuming the revision lease', () => {
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
      (error) => workflowCode(error) === 'REVISION_PLAN_REVIEW_REQUIRED',
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

test('resume-task commits only a freshly reviewed plan and rebinds the same session', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    const implementationPath = path.join(repository, 'src/feature.ts');
    const implementation = 'export const value = 1;\n';
    fs.writeFileSync(implementationPath, implementation);
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();

    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nThe implementation remains valid under this clarified plan.\n',
    );
    const reviewed = writeReadyV2ExemptChange(repository);
    const resumed = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:05:00.000Z'),
    });

    const planCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(planCommit, parent);
    assert.equal(resumed.session.sessionId, session.sessionId);
    assert.equal(resumed.session.state, 'active');
    assert.equal(resumed.session.baseline.head, planCommit);
    assert.equal(
      resumed.session.planningAssurance?.planningGenerationId,
      reviewed.planningAssurance.planningGenerationId,
    );
    assert.equal(resumed.lease.phase, 'completed');
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), implementation);
    assert.deepEqual(listChangedPaths(repository, planCommit), [
      'src/feature.ts',
    ]);
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only']).trim(),
      '',
    );
    assert.equal(
      commitChangedPaths(repository, planCommit).some((candidate) =>
        candidate.startsWith('src/'),
      ),
      false,
    );
    assert.equal(checkSession(repository, session.sessionId).passed, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resume-task recovers the exact plan commit after a ref-CAS crash', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    const implementationPath = path.join(repository, 'src/feature.ts');
    const implementation = 'export const value = 1;\n';
    fs.writeFileSync(implementationPath, implementation);
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nThe implementation remains valid after review.\n',
    );
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          testCrashAfter: 'plan-ref-updated',
        }),
      /simulated task revision crash/,
    );
    const committed = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(committed, parent);
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), implementation);

    const recovered = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:06:00.000Z'),
    });
    assert.equal(recovered.session.state, 'active');
    assert.equal(recovered.session.baseline.head, committed);
    assert.equal(recovered.lease.phase, 'completed');
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), committed);
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), implementation);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resume-task applies one exact prepared plan commit after a pre-CAS crash', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    const implementationPath = path.join(repository, 'src/feature.ts');
    const implementation = 'export const value = 1;\n';
    fs.writeFileSync(implementationPath, implementation);
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nThe prepared revision retains the implementation.\n',
    );
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          testCrashAfter: 'plan-commit-prepared',
        }),
      /simulated task revision crash/,
    );
    const prepared = inspectTaskRevisionStatus(repository, session.sessionId);
    assert.equal(prepared?.phase, 'plan-commit-prepared');
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only']).trim(),
      '',
    );
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), implementation);

    const recovered = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:06:00.000Z'),
    });
    assert.equal(recovered.session.state, 'active');
    assert.notEqual(recovered.session.baseline.head, parent);
    assert.equal(recovered.lease.phase, 'completed');
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only']).trim(),
      '',
    );
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), implementation);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resume-task rebinds the same session after a post-commit pre-session crash', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    const implementationPath = path.join(repository, 'src/feature.ts');
    const implementation = 'export const value = 1;\n';
    fs.writeFileSync(implementationPath, implementation);
    reviseTask(repository, session.sessionId, 'correct-plan', {
      now: () => STARTED_AT,
    });
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nThe reviewed session remains the same.\n',
    );
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          testCrashAfter: 'resume-prepared',
        }),
      /simulated task revision crash/,
    );
    const committed = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.phase,
      'resume-prepared',
    );

    const recovered = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:06:00.000Z'),
    });
    assert.equal(recovered.session.sessionId, session.sessionId);
    assert.equal(recovered.session.state, 'active');
    assert.equal(recovered.session.baseline.head, committed);
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), implementation);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a reviewed path narrowing resumes without external widening authority', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const value = 1;\n',
    );
    reviseTask(repository, session.sessionId, 'narrow-task-scope', {
      now: () => STARTED_AT,
    });
    writeTaskAllowedPaths(repository, ['src/feature.ts']);
    writeReadyV2ExemptChange(repository);

    const resumed = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:05:00.000Z'),
    });
    assert.equal(resumed.session.state, 'active');
    assert.deepEqual(resumed.session.allowedPaths, ['src/feature.ts']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a reviewed authority widening is refused before the plan ref changes', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const value = 1;\n',
    );
    reviseTask(repository, session.sessionId, 'widen-task-scope', {
      now: () => STARTED_AT,
    });
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    writeTaskAllowedPaths(repository, ['docs/**', 'src/**']);
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
        }),
      (error) => workflowCode(error) === 'REVISION_WIDENING_APPROVAL_REQUIRED',
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resume-task persists exact staging intent before mutating the index', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const value = 1;\n',
    );
    reviseTask(repository, session.sessionId, 'prepare-plan-staging', {
      now: () => STARTED_AT,
    });
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nThe partial index requires durable intent.\n',
    );
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          testCrashAfter: 'planning-staging-prepared',
        }),
      /simulated task revision crash/,
    );
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.phase,
      'planning-staging-prepared',
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    const planningPaths = listChangedPaths(repository, parent).filter(
      (candidate) => candidate.startsWith('openspec/changes/demo-change/'),
    );
    git(repository, ['add', '-A', '--', ...planningPaths]);
    assert.notEqual(
      git(repository, ['diff', '--cached', '--name-only']).trim(),
      '',
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

function writeTaskAllowedPaths(repository: string, allowedPaths: string[]) {
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = allowedPaths;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
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
