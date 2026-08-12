import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import { listChangedPaths } from '../src/git.ts';
import {
  inspectTaskRevisionStatus,
  prepareTaskRevisionApprovalBinding,
  resumeTask,
  reviseTask,
} from '../src/task-revision.ts';
import {
  issueTaskRevisionApproval,
  taskRevisionApprovalTargetDigest,
} from '../src/task-revision-approval.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
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

test('weakening required checks needs one exact external widening approval', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    installRevisionApprovalPolicy(repository);
    const checksPath = path.join(repository, 'workflow/checks.json');
    const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
      checks: Record<string, unknown>;
    };
    checks.checks.security = {
      command: ['node', 'scripts/pass.mjs'],
      destructiveDatabase: false,
    };
    fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
    writeTaskRequiredChecks(repository, ['fixture', 'security']);
    git(repository, [
      'add',
      'workflow/maintainer-policy.json',
      'workflow/checks.json',
      'openspec/changes/demo-change/guard.json',
    ]);
    git(repository, ['commit', '-m', 'Add task revision approval policy']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const value = 1;\n',
    );
    reviseTask(repository, session.sessionId, 'weaken-required-checks', {
      now: () => STARTED_AT,
    });
    writeTaskRequiredChecks(repository, ['fixture']);
    writeReadyV2ExemptChange(repository);

    const binding = prepareTaskRevisionApprovalBinding(
      repository,
      session.sessionId,
      { now: () => new Date('2026-08-11T01:03:00.000Z') },
    );
    assert.deepEqual(binding.previousRequiredChecks, ['fixture', 'security']);
    assert.deepEqual(binding.nextRequiredChecks, ['fixture']);
    const signer = revisionApprovalSigner();
    const approval = issueTaskRevisionApproval(
      repository,
      {
        binding,
        expectedTargetDigest: taskRevisionApprovalTargetDigest(binding),
        rationale: 'Approve this exact reduction in required check authority.',
      },
      {
        now: new Date('2026-08-11T01:04:00.000Z'),
        signer,
      },
    );
    const resumed = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:05:00.000Z'),
      approvalId: approval.approvalId,
      approvalVerifier: signer,
    });
    assert.equal(resumed.session.state, 'active');
    assert.deepEqual(resumed.session.requiredChecks, ['fixture']);
    assert.equal(resumed.lease.approvalId, approval.approvalId);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a revision cannot complete the task that owns its preserved implementation', () => {
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
    reviseTask(repository, session.sessionId, 'complete-revising-task', {
      now: () => STARTED_AT,
    });
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    writeReadyV2ExemptChange(repository);
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
        }),
      (error) => workflowCode(error) === 'REVISION_TASK_CONTRACT_INVALID',
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a reviewed authority widening requires an external decision before the plan ref changes', () => {
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
      (error) => workflowCode(error) === 'REVISION_REQUIRES_APPROVAL',
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a widening approval cannot launder implementation bytes outside the original task authority', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(repository, 'demo-change', '1.1');
    const unauthorizedPath = path.join(repository, 'test/unauthorized.ts');
    fs.mkdirSync(path.dirname(unauthorizedPath), { recursive: true });
    fs.writeFileSync(unauthorizedPath, 'export const unauthorized = true;\n');

    assert.throws(
      () =>
        reviseTask(repository, session.sessionId, 'retroactive-widening', {
          now: () => STARTED_AT,
        }),
      (error) => workflowCode(error) === 'OUT_OF_SCOPE_PATHS',
    );
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId),
      null,
    );
    assert.equal(
      fs.readFileSync(unauthorizedPath, 'utf8'),
      'export const unauthorized = true;\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an unverified approval reference cannot authorize a reviewed widening', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    installRevisionApprovalPolicy(repository);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Add task revision approval policy']);
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
    writeTaskAllowedPaths(repository, ['docs/**', 'src/**']);
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          approvalId: 'a'.repeat(64),
        } as Parameters<typeof resumeTask>[2]),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_NOT_FOUND',
    );
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an exact external approval authorizes one reviewed widening for the same session', () => {
  const fixture = approvedWideningFixture();
  const { repository, session, signer, approval } = fixture;
  try {
    const resumed = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:05:00.000Z'),
      approvalId: approval.approvalId,
      approvalVerifier: signer,
    });
    assert.equal(resumed.session.state, 'active');
    assert.deepEqual(resumed.session.allowedPaths, ['docs/**', 'src/**']);
    assert.equal(resumed.lease.approvalId, approval.approvalId);
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.approvalId,
      approval.approvalId,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a signed approval becomes stale when the reviewed widening target changes', () => {
  const fixture = approvedWideningFixture();
  const { repository, session, signer, approval } = fixture;
  try {
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    writeTaskAllowedPaths(repository, ['docs/**', 'src/**', 'test/**']);
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          approvalId: approval.approvalId,
          approvalVerifier: signer,
        }),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_STALE',
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a signed approval cannot cross live repository-origin identity drift', () => {
  const fixture = approvedWideningFixture();
  const { repository, session, signer, approval } = fixture;
  try {
    git(repository, [
      'remote',
      'set-url',
      'origin',
      'https://github.com/attacker/other-repository.git',
    ]);
    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          approvalId: approval.approvalId,
          approvalVerifier: signer,
        }),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_STALE',
    );
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a fresh widening cannot begin at the exact approval expiry boundary', () => {
  const fixture = approvedWideningFixture();
  const { repository, session, signer, approval } = fixture;
  try {
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:09:00.000Z'),
          approvalId: approval.approvalId,
          approvalVerifier: signer,
        }),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_STALE',
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), parent);
    assert.equal(getSession(repository, session.sessionId).state, 'revising');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an effect-ahead widening recovery completes the exact journaled approval after expiry', () => {
  const fixture = approvedWideningFixture();
  const { repository, session, signer, approval } = fixture;
  try {
    assert.throws(
      () =>
        resumeTask(repository, session.sessionId, {
          now: () => new Date('2026-08-11T01:05:00.000Z'),
          approvalId: approval.approvalId,
          approvalVerifier: signer,
          testCrashAfter: 'plan-ref-updated',
        }),
      /simulated task revision crash/,
    );
    assert.equal(
      inspectTaskRevisionStatus(repository, session.sessionId)?.phase,
      'plan-committed',
    );

    const recovered = resumeTask(repository, session.sessionId, {
      now: () => new Date('2026-08-11T01:20:00.000Z'),
      approvalVerifier: signer,
    });
    assert.equal(recovered.session.state, 'active');
    assert.equal(recovered.lease.approvalId, approval.approvalId);
    assert.deepEqual(recovered.session.allowedPaths, ['docs/**', 'src/**']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approval issuance rejects a mismatched target and an untrusted signer', () => {
  const fixture = approvedWideningFixture();
  const { repository, binding } = fixture;
  try {
    assert.throws(
      () =>
        issueTaskRevisionApproval(
          repository,
          {
            binding,
            expectedTargetDigest: 'b'.repeat(64),
            rationale: 'Reject a caller-selected widening target.',
          },
          {
            now: new Date('2026-08-11T01:04:00.000Z'),
            signer: revisionApprovalSigner(),
          },
        ),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_INVALID',
    );
    assert.throws(
      () =>
        issueTaskRevisionApproval(
          repository,
          {
            binding,
            expectedTargetDigest: taskRevisionApprovalTargetDigest(binding),
            rationale: 'Reject an untrusted widening decision author.',
          },
          {
            now: new Date('2026-08-11T01:04:00.000Z'),
            signer: revisionApprovalSigner('untrusted-agent'),
          },
        ),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_INVALID',
    );
    const selfAuthoredBinding = {
      ...binding,
      actorAuthorityId: 'fixture-maintainer',
    };
    assert.throws(
      () =>
        issueTaskRevisionApproval(
          repository,
          {
            binding: selfAuthoredBinding,
            expectedTargetDigest:
              taskRevisionApprovalTargetDigest(selfAuthoredBinding),
            rationale: 'Reject a decision authored by its beneficiary.',
          },
          {
            now: new Date('2026-08-11T01:04:00.000Z'),
            signer: revisionApprovalSigner(),
          },
        ),
      (error) => workflowCode(error) === 'TASK_REVISION_APPROVAL_INVALID',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resume rejects approval signature failure and unsafe record publication', () => {
  for (const failure of ['signature', 'mode', 'noncanonical-record'] as const) {
    const fixture = approvedWideningFixture();
    const { repository, session, approval } = fixture;
    try {
      let approvalId = approval.approvalId;
      if (failure === 'mode') {
        fs.chmodSync(approval.recordPath, 0o644);
      } else if (failure === 'noncanonical-record') {
        const record = JSON.parse(
          fs.readFileSync(approval.recordPath, 'utf8'),
        ) as Record<string, unknown>;
        const noncanonical = `${JSON.stringify({
          envelope: record.envelope,
          createdAt: record.createdAt,
          kind: record.kind,
          schemaVersion: record.schemaVersion,
        })}\n`;
        approvalId = crypto
          .createHash('sha256')
          .update(noncanonical)
          .digest('hex');
        fs.writeFileSync(
          path.join(path.dirname(approval.recordPath), `${approvalId}.json`),
          noncanonical,
          { mode: 0o600 },
        );
      }
      assert.throws(
        () =>
          resumeTask(repository, session.sessionId, {
            now: () => new Date('2026-08-11T01:05:00.000Z'),
            approvalId,
            approvalVerifier:
              failure === 'signature'
                ? revisionApprovalSigner('fixture-maintainer', true)
                : revisionApprovalSigner(),
          }),
        (error) =>
          workflowCode(error) ===
          (failure === 'signature'
            ? 'TASK_REVISION_APPROVAL_SIGNATURE_INVALID'
            : failure === 'mode'
              ? 'TASK_REVISION_APPROVAL_NOT_FOUND'
              : 'TASK_REVISION_APPROVAL_INVALID'),
      );
      assert.equal(getSession(repository, session.sessionId).state, 'revising');
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('task-revision approval CLI reaches the controlling-terminal boundary without publishing authority', () => {
  const fixture = approvedWideningFixture(new Date());
  const { repository, session, binding, approval } = fixture;
  try {
    const approvalDirectory = path.dirname(approval.recordPath);
    const recordsBefore = fs.readdirSync(approvalDirectory).sort();
    const invoked = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'maintainer',
        'revision-approval',
        session.sessionId,
        '--target',
        taskRevisionApprovalTargetDigest(binding),
        '--reason',
        'Approve this exact reviewed widening at the controlling terminal.',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(invoked.status, 12, invoked.stderr);
    const error = (
      JSON.parse(invoked.stderr) as {
        error: { code: string; recovery: string };
      }
    ).error;
    assert.equal(error.code, 'MAINTAINER_INTERACTIVE_REQUIRED');
    assert.equal(
      error.recovery,
      `pnpm workflow maintainer revision-approval ${session.sessionId} --target ${taskRevisionApprovalTargetDigest(binding)} --reason 'Approve this exact reviewed widening at the controlling terminal.' --json`,
    );
    assert.deepEqual(fs.readdirSync(approvalDirectory).sort(), recordsBefore);
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

function writeTaskRequiredChecks(
  repository: string,
  requiredChecks: string[],
): void {
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.requiredChecks = requiredChecks;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
}

function installRevisionApprovalPolicy(repository: string): void {
  const origin = 'https://github.com/fixture/task-revision.git';
  git(repository, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: 'github:R_fixture', origin },
        phase: 'bootstrap',
        auditTagPrefix: 'refs/tags/workflow-grant/',
        signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
        maxTtlMinutes: 30,
        maxUses: 1,
        bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
        sealedImmutablePaths: [],
        requiredChecks: ['fixture'],
        trustedSigners: [
          {
            identity: 'fixture-maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function approvedWideningFixture(startedAt = STARTED_AT) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', 'work/demo-change']);
  installRevisionApprovalPolicy(repository);
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add task revision approval policy']);
  writeReadyV2ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(
    path.join(repository, 'src/feature.ts'),
    'export const value = 1;\n',
  );
  reviseTask(repository, session.sessionId, 'widen-task-scope', {
    now: () => startedAt,
  });
  writeTaskAllowedPaths(repository, ['docs/**', 'src/**']);
  writeReadyV2ExemptChange(repository);
  const binding = prepareTaskRevisionApprovalBinding(
    repository,
    session.sessionId,
    { now: () => new Date(startedAt.getTime() + 3 * 60_000) },
  );
  const signer = revisionApprovalSigner();
  const approval = issueTaskRevisionApproval(
    repository,
    {
      binding,
      expectedTargetDigest: taskRevisionApprovalTargetDigest(binding),
      rationale: 'Approve this exact reviewed task-scope widening.',
    },
    {
      now: new Date(startedAt.getTime() + 4 * 60_000),
      signer,
    },
  );
  return { repository, session, signer, binding, approval };
}

function revisionApprovalSigner(
  identity = 'fixture-maintainer',
  rejectVerification = false,
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => identity,
    sign: () =>
      [
        '-----BEGIN SSH SIGNATURE-----',
        'AAAA',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n'),
    verify() {
      if (rejectVerification) throw new Error('fixture signature rejection');
    },
  };
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
