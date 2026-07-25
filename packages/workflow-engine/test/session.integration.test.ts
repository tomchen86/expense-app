import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import './archive-eligibility.integration.test.ts';
import './archive-transformation.integration.test.ts';
import './archive-transition.integration.test.ts';
import './ci-archive.integration.test.ts';

import { validateCiPlanningCommit } from '../src/ci-planning.ts';
import { verifyPullRequest } from '../src/ci.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  commitSession,
  completeTask,
  finalizeTask,
  finishSession,
} from '../src/lifecycle.ts';
import { INVESTIGATION_PLANNING_ACTIVATION_MARKER } from '../src/openspec-schema-contract.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { runRegisteredCheck } from '../src/registered-check.ts';
import {
  readImmutableReport,
  writeImmutableReport,
} from '../src/report-store.ts';
import {
  abortSession,
  checkSession,
  getSession,
  startSession,
} from '../src/session.ts';
import './atomic-text.test.ts';
import './completion.integration.test.ts';
import './collaboration-grant.integration.test.ts';
import './contract-artifact-digests.test.ts';
import './issues.integration.test.ts';
import './handoff.integration.test.ts';
import './document-refresh.integration.test.ts';
import './guard-contract.integration.test.ts';
import './hooks.integration.test.ts';
import './managed-trailers.contract.test.ts';
import './maintainer-mode.integration.test.ts';
import './ci.integration.test.ts';
import './ci-bootstrap.integration.test.ts';
import './ai-adapter-evaluation.integration.test.ts';
import './provider-adapters.integration.test.ts';
import './provider-worker.integration.test.ts';
import './ignored-state.integration.test.ts';
import './investigation-scanner.integration.test.ts';
import './investigation-session.integration.test.ts';
import './investigation-why.integration.test.ts';
import './legacy-plan-migration.integration.test.ts';
import './plan-review.integration.test.ts';
import './planning-transition.integration.test.ts';
import './workflow-rehearsal.integration.test.ts';
import './managed-change-contract.integration.test.ts';
import './managed-change-lifecycle.integration.test.ts';
import './runner.integration.test.ts';
import {
  activateInvestigationPlanning,
  addFixtureScripts,
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('the activation task finishes under its own pinned legacy session', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    widenTaskScope(repository, ['src/**', 'workflow/schemas/**']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    const session = startSession(repository, 'demo-change', '1.1');

    // The task that introduces the anchor is pinned to a baseline that
    // predates it, so its own session must remain executable.
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, INVESTIGATION_PLANNING_ACTIVATION_MARKER),
      path.join(repository, INVESTIGATION_PLANNING_ACTIVATION_MARKER),
    );
    assert.equal(checkSession(repository, session.sessionId).passed, true);
    completeTask(repository, session.sessionId);
    assert.deepEqual(finishSession(repository, session.sessionId).stagedPaths, [
      'openspec/changes/demo-change/tasks.md',
      INVESTIGATION_PLANNING_ACTIVATION_MARKER,
    ]);
    const committed = commitSession(
      repository,
      session.sessionId,
      'Activate investigation-first planning',
    );

    assert.equal(committed.session.state, 'committed');
    // The change keeps the legacy grammar its governing generation was
    // reviewed under; activation governs later planning, not this task.
    assert.equal(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
        'utf8',
      ),
      'schema: expense-app\ncreated: 2026-07-15\n',
    );
    assert.deepEqual(
      verifyPullRequest(repository, base, committed.commitHash).completedTasks,
      [{ changeId: 'demo-change', taskId: '1.1' }],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a legacy task session survives activation but fails closed without the marker', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    activateInvestigationPlanning(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.equal(checkSession(repository, session.sessionId).passed, true);

    fs.rmSync(path.join(repository, INVESTIGATION_PLANNING_ACTIVATION_MARKER));
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_ACTIVATION_MARKER_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function widenTaskScope(repository: string, allowedPaths: string[]): void {
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = allowedPaths;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  git(repository, ['add', '--', 'openspec/changes/demo-change/guard.json']);
  git(repository, ['commit', '-m', 'Widen the fixture task scope']);
}

test('v2 sessions and every task report pin the exact planning assurance', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const ready = writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const expectedBinding = {
      ...ready.planningAssurance,
      reviewGrantId: null,
      reviewGrantEnvelopeDigest: null,
      reviewGrantUseDigest: null,
      reviewGrantTransitionDigest: null,
      directHumanReviewAttestationDigest: null,
    };

    const started = startSession(repository, 'demo-change', '1.1');
    assert.deepEqual(
      (started as typeof started & { planningAssurance: unknown })
        .planningAssurance,
      expectedBinding,
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    finalizeTask(repository, started.sessionId);
    commitSession(repository, started.sessionId, 'Bind planning assurance');

    const committed = getSession(repository, started.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    for (const reportId of [
      committed.latestCheckReportId,
      committed.completionReportId,
      committed.finishReportId,
      committed.commitReportId,
    ]) {
      assert.match(reportId ?? '', /^[0-9a-f]{64}$/);
      const report = readImmutableReport(
        reportsRoot,
        started.sessionId,
        reportId!,
      );
      assert.deepEqual(report.planningAssurance, expectedBinding);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays v2 planning assurance from Git with the live validator', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const ready = writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const planCommit = git(repository, ['rev-parse', 'HEAD']).trim();

    const validation = validateCiPlanningCommit(
      repository,
      planCommit,
      'demo-change',
    );

    // The CI loader reads only immutable Git objects, but must reach the exact
    // semantic result the live transition recorded.
    assert.equal(validation.schemaName, 'expense-app-v2');
    assert.deepEqual(validation.planningAssurance, ready.planningAssurance);
    // An exempt plan consumes no collaboration grant, so its aggregate use set
    // is empty rather than absent.
    assert.deepEqual(validation.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI fails closed when a v2 plan omits tracked semantic evidence', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');

    // The managed transition refuses to drop a required v2 artifact, so the
    // only way this tree reaches history is a hand-authored commit that never
    // passed the engine. CI must reject it from Git facts alone.
    git(repository, [
      'rm',
      '--quiet',
      'openspec/changes/demo-change/plan-review.json',
    ]);
    git(repository, [
      'commit',
      '--quiet',
      '-m',
      ['Plan demo-change', '', 'Change: demo-change', 'Transition: plan'].join(
        '\n',
      ),
    ]);
    const tampered = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, tampered, 'demo-change'),
      (error) => error instanceof WorkflowError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task transitions reject a session whose planning assurance is stale', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const started = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      planningAssurance: { planningGenerationId: string };
    };
    stored.planningAssurance.planningGenerationId = 'f'.repeat(64);
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'SESSION_PLANNING_ASSURANCE_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion rejects a check report with mismatched planning assurance', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const started = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const checked = checkSession(repository, started.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const forged = structuredClone(
      readImmutableReport(reportsRoot, started.sessionId, checked.reportId),
    );
    (
      forged.planningAssurance as { planningGenerationId: string }
    ).planningGenerationId = 'f'.repeat(64);
    const forgedId = writeImmutableReport(reportsRoot, forged);
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      latestCheckReportId: string;
    };
    stored.latestCheckReportId = forgedId;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => completeTask(repository, started.sessionId),
      (error) => isWorkflowError(error, 'CHECK_REPORT_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution returns pinned non-destructive evidence', () => {
  const repository = createFixtureRepository();
  try {
    const result = runRegisteredCheck(repository, 'fixture', process.env);

    assert.equal(result.head, git(repository, ['rev-parse', 'HEAD']).trim());
    assert.deepEqual(
      {
        checkId: result.check.checkId,
        outcome: result.check.outcome,
        exitCode: result.check.exitCode,
        destructiveDatabase: result.check.destructiveDatabase,
      },
      {
        checkId: 'fixture',
        outcome: 'passed',
        exitCode: 0,
        destructiveDatabase: false,
      },
    );
    assert.match(result.check.runnerDigest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution rejects unknown and destructive checks', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => runRegisteredCheck(repository, 'unknown', process.env),
      (error) => isWorkflowError(error, 'CI_CHECK_UNKNOWN'),
    );

    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );

    assert.throws(
      () => runRegisteredCheck(repository, 'destructive', process.env),
      (error) => isWorkflowError(error, 'STANDALONE_DESTRUCTIVE_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution rejects dirty and mutated checkouts', () => {
  const dirtyRepository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(dirtyRepository, 'dirty.txt'), 'dirty\n');
    assert.throws(
      () => runRegisteredCheck(dirtyRepository, 'fixture', process.env),
      (error) => isWorkflowError(error, 'STANDALONE_CHECK_DIRTY_WORKTREE'),
    );
  } finally {
    fs.rmSync(dirtyRepository, { recursive: true, force: true });
  }

  const mutatingRepository = createFixtureRepository();
  try {
    configureChecks(
      mutatingRepository,
      {
        mutating: {
          command: [
            'node',
            'scripts/write-file.mjs',
            path.join(mutatingRepository, 'mutated.txt'),
          ],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    assert.throws(
      () => runRegisteredCheck(mutatingRepository, 'mutating', process.env),
      (error) => isWorkflowError(error, 'CI_CHECK_MUTATED_WORKTREE'),
    );
  } finally {
    fs.rmSync(mutatingRepository, { recursive: true, force: true });
  }
});

test('start rejects protected and dirty repositories without leaving runtime state', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'PROTECTED_BRANCH'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'dirty.txt'), 'existing work\n');

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'DIRTY_WORKTREE'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('active session pins a clean baseline, enforces scope, and releases its lock', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.equal(session.state, 'active');
    assert.equal(checkSession(repository, session.sessionId).passed, true);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const allowedCheck = checkSession(repository, session.sessionId);
    assert.deepEqual(allowedCheck.changedPaths, ['src/feature.ts']);

    fs.writeFileSync(path.join(repository, 'outside.txt'), 'not allowed\n');
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );

    const aborted = abortSession(
      repository,
      session.sessionId,
      'integration test',
    );
    assert.equal(aborted.state, 'aborted');
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects workflow artifacts changed after session start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    fs.appendFileSync(guardPath, '\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects a session whose task policy was broadened', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    tampered.allowedPaths = ['outside.txt'];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_POLICY_TAMPERED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check executes required argv literally from the repository root', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-output-'),
  );
  const outputPath = path.join(outputDirectory, 'arguments.json');
  const sentinelPath = path.join(outputDirectory, 'shell-injection');
  const literalArgument = `; touch ${sentinelPath}`;

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        literal: {
          command: [
            'node',
            'scripts/capture-args.mjs',
            outputPath,
            literalArgument,
            '$(echo not-evaluated)',
          ],
          destructiveDatabase: false,
        },
      },
      ['literal'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId);
    const captured = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    assert.deepEqual(captured, {
      cwd: fs.realpathSync(repository),
      arguments: [literalArgument, '$(echo not-evaluated)'],
    });
    assert.equal(fs.existsSync(sentinelPath), false);
    assert.deepEqual(
      result.checks.map((check) => ({
        checkId: check.checkId,
        outcome: check.outcome,
        exitCode: check.exitCode,
      })),
      [{ checkId: 'literal', outcome: 'passed', exitCode: 0 }],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check fails on the first non-zero check and does not run later checks', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-failure-'),
  );
  const markerPath = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        failing: {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
      },
      ['failing', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_FAILED'), true);
        assert.deepEqual((error as WorkflowError).details, {
          checkId: 'failing',
          exitCode: 7,
          signal: null,
        });
        return true;
      },
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive database preflight runs before any required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-database-preflight-'),
  );
  const markerPath = path.join(outputDirectory, 'first-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        first: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['first', 'destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: { ...process.env },
        }),
      (error) =>
        isWorkflowError(error, 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED'),
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive check evidence includes only the redacted database identity', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId, {
      environment: {
        ...process.env,
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@127.0.0.1:5433/expense_test?ssl=false',
        DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/expense_dev',
      },
    });

    assert.equal(
      result.checks[0].databaseIdentity,
      'postgresql://127.0.0.1:5433/expense_test',
    );
    assert.equal(JSON.stringify(result).includes('marker-secret'), false);
    assert.equal(JSON.stringify(result).includes('ssl=false'), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check revalidates scope before running the next required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-post-check-scope-'),
  );
  const outsidePath = path.join(repository, 'outside.txt');
  const laterMarker = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', outsidePath],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', laterMarker],
          destructiveDatabase: false,
        },
      },
      ['mutating', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check rejects a lock removed by a passing required check', () => {
  const repository = createFixtureRepository();
  const lockPath = path.join(
    runtimeRoot(repository),
    'locks',
    'demo-change.lock',
  );

  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/remove-file.mjs', lockPath],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check converts spawn errors without leaking environment values', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        overflowing: {
          command: ['node', 'scripts/overflow.mjs'],
          destructiveDatabase: false,
        },
      },
      ['overflowing'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: {
            ...process.env,
            WORKFLOW_TEST_SECRET: 'marker-secret',
          },
        }),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_EXECUTION_FAILED'), true);
        assert.equal((error as Error).message.includes('marker-secret'), false);
        assert.equal(JSON.stringify(error).includes('marker-secret'), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('change validation rejects inherited object properties as check IDs', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        fixture: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        },
      },
      ['constructor'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'UNKNOWN_REQUIRED_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'node runner ignores caller-controlled PATH substitutes',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const fakeBin = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-bin-'),
    );
    const markerPath = path.join(fakeBin, 'fake-node-ran');
    const fakeNodePath = path.join(fakeBin, 'node');

    try {
      fs.writeFileSync(
        fakeNodePath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 0\n`,
      );
      fs.chmodSync(fakeNodePath, 0o755);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');

      const result = checkSession(repository, session.sessionId, {
        environment: { ...process.env, PATH: fakeBin },
      });

      assert.equal(result.passed, true);
      assert.equal(fs.existsSync(markerPath), false);
      assert.equal(result.checks[0].runner, 'node');
      assert.match(result.checks[0].runnerDigest, /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  },
);

test('change validation rejects bare executable check runners', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        unsafe: {
          command: ['pnpm', '--version'],
          destructiveDatabase: false,
        },
      },
      ['unsafe'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'INVALID_CHECK_DEFINITION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
