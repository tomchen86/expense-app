import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  projectWorkflowNextSteps,
  WORKFLOW_GUIDANCE_CATALOG,
  workflowCommandGuidance,
  workflowFailureRecoveryCommand,
} from '../src/workflow-guidance.ts';
import { ExitCode, workflowError } from '../src/errors.ts';
import { reviseTask } from '../src/task-revision.ts';
import { getSession, startSession } from '../src/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const cliPath = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/src/cli.ts',
);

test('workflow guide exposes one versioned advisory catalog with finalize as the preferred surface', () => {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, 'guide', '--json'],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    command: 'guide',
    ok: true,
    guide: WORKFLOW_GUIDANCE_CATALOG,
    nextSteps: [],
  });
  assert.equal(WORKFLOW_GUIDANCE_CATALOG.authority, 'advisory');
  assert.equal(WORKFLOW_GUIDANCE_CATALOG.schemaVersion, 1);
  assert.equal(WORKFLOW_GUIDANCE_CATALOG.kind, 'workflow-command-guide.v1');
  assert.equal(workflowCommandGuidance('finalize').status, 'preferred');
  assert.deepEqual(workflowCommandGuidance('finalize-task').deprecation, {
    phase: 1,
    replacementCommandId: 'finalize',
    replacement:
      'pnpm workflow finalize <session-id> --message <subject> [--json]',
    reason:
      'New callers use one durable finalization and commit transaction; finalize-task remains a compatibility surface.',
  });
  assert.equal(
    new Set(WORKFLOW_GUIDANCE_CATALOG.commands.map(({ id }) => id)).size,
    WORKFLOW_GUIDANCE_CATALOG.commands.length,
  );
});

test('JSON status stays read-only and same-digest resume emits at most three catalog-backed next steps', () => {
  const repository = createFixtureRepository();
  try {
    const statusBefore = snapshotRepositoryObservation(repository);
    const emptyStatus = runCli(repository, ['status', '--json']);
    assert.equal(emptyStatus.status, 0, emptyStatus.stderr);
    assert.deepEqual(
      (JSON.parse(emptyStatus.stdout) as { nextSteps: unknown }).nextSteps,
      [
        {
          command: 'pnpm workflow guide --json',
          why: workflowCommandGuidance('guide').purpose,
        },
      ],
    );
    assert.deepEqual(snapshotRepositoryObservation(repository), statusBefore);

    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.writeFileSync(implementationPath, 'export const value = 1;\n');
    reviseTask(repository, session.sessionId, 'Keep the reviewed plan.');
    const headBeforeResume = git(repository, ['rev-parse', 'HEAD']).trim();

    const resumed = runCli(repository, [
      'resume-task',
      session.sessionId,
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const output = JSON.parse(resumed.stdout) as {
      result: { session: { sessionId: string; state: string } };
      nextSteps: Array<{ command: string; why: string }>;
    };
    assert.equal(output.result.session.sessionId, session.sessionId);
    assert.equal(output.result.session.state, 'active');
    assert.deepEqual(
      output.nextSteps.map(({ command }) => command),
      [
        `pnpm workflow status ${session.sessionId} --json`,
        `pnpm workflow check ${session.sessionId} --json`,
        `pnpm workflow finalize ${session.sessionId} --message <subject> --json`,
      ],
    );
    assert.equal(output.nextSteps.length <= 3, true);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      headBeforeResume,
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const value = 1;\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('next-step projection keeps two likely transitions and sends overflow to the explicit guide', () => {
  const sessionId =
    'session-20260812000000000-00000000-0000-4000-8000-000000000000';
  assert.deepEqual(
    projectWorkflowNextSteps(['status', 'check', 'finalize', 'abort'], {
      sessionId,
    }),
    [
      {
        command: `pnpm workflow status ${sessionId} --json`,
        why: workflowCommandGuidance('status').purpose,
      },
      {
        command: `pnpm workflow check ${sessionId} --json`,
        why: workflowCommandGuidance('check').purpose,
      },
      {
        command: 'pnpm workflow guide --json',
        why: workflowCommandGuidance('guide').purpose,
      },
    ],
  );
});

test('error recovery emits one exact executable command and never treats advisory prose as authority', () => {
  const sessionId =
    'session-20260812000000000-00000000-0000-4000-8000-000000000000';
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'TASK_DIFF_REVIEW_CHALLENGE_OPEN',
        'Advisory dispositions are not Final Assurance.',
        ExitCode.verification,
      ),
      ['finalize', sessionId, '--message', 'Complete exact task'],
    ),
    `pnpm workflow review-diff ${sessionId} --json`,
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'FINALIZE_RECOVERY_REQUIRED',
        'A durable finalize transaction requires recovery.',
        ExitCode.staleState,
        { recovery: 'Inspect it, then decide what to do.' },
      ),
      ['finalize-task', sessionId],
    ),
    `pnpm workflow finalize-recover ${sessionId} --json`,
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'OPEN_TASK_RECOVERY_REQUIRED',
        'The durable opening transaction requires recovery.',
        ExitCode.staleState,
        { recovery: 'pnpm workflow status opening-123 --json' },
      ),
      ['open-task', 'demo-change'],
    ),
    'pnpm workflow status opening-123 --json',
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'MAINTAINER_INTERACTIVE_REQUIRED',
        'Run from a controlling terminal.',
        ExitCode.unsafeEnvironment,
      ),
      [
        'maintainer',
        'revision-approval',
        sessionId,
        '--reason',
        "literal $(touch /tmp/no) and 'quote'",
      ],
    ),
    `pnpm workflow maintainer revision-approval ${sessionId} --reason 'literal $(touch /tmp/no) and '"'"'quote'"'"'' --json`,
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'MAINTAINER_INTERACTIVE_REQUIRED',
        'Run from a controlling terminal.',
        ExitCode.unsafeEnvironment,
      ),
      ['maintainer', 'revoke', 'grant-id', '--reason', 'line one\nline two'],
    ),
    'pnpm workflow guide --json',
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'DIRTY_WORKTREE',
        'The checkout is dirty.',
        ExitCode.guard,
        { recovery: 'Delete or stash whatever seems appropriate.' },
      ),
      ['start', 'demo-change'],
    ),
    'pnpm workflow guide --json',
  );
});

test('JSON errors default to a literal read-only guide command', () => {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, 'status', 'bad', 'extra', '--json'],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, ExitCode.usage);
  const output = JSON.parse(run.stderr) as {
    ok: boolean;
    error: { code: string; message: string; recovery: string };
  };
  assert.equal(output.ok, false);
  assert.equal(output.error.code, 'INVALID_USAGE');
  assert.match(output.error.message, /Invalid arguments for workflow status/);
  assert.equal(output.error.recovery, 'pnpm workflow guide --json');
});

test('deprecated finalize-task and preferred finalize resume one durable transaction without rerunning checks', () => {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'guidance-finalize-count');
  try {
    fs.writeFileSync(
      path.join(repository, 'scripts/count-finalize.mjs'),
      [
        "import fs from 'node:fs';",
        'const counterPath = process.argv[2];',
        "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
        'fs.writeFileSync(counterPath, String(count + 1));',
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        finalization: {
          command: ['node', 'scripts/count-finalize.mjs', counterPath],
          destructiveDatabase: false,
        },
      },
      ['finalization'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    const compatibility = runCli(repository, [
      'finalize-task',
      session.sessionId,
      '--json',
    ]);
    assert.equal(compatibility.status, 0, compatibility.stderr);
    const compatibilityResult = JSON.parse(compatibility.stdout) as {
      deprecation: unknown;
      result: { transactionId: string; tree: string };
    };
    assert.deepEqual(
      compatibilityResult.deprecation,
      workflowCommandGuidance('finalize-task').deprecation,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(getSession(repository, session.sessionId).state, 'active');

    const preferred = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete through preferred finalize',
      '--json',
    ]);
    assert.equal(preferred.status, 0, preferred.stderr);
    const preferredResult = JSON.parse(preferred.stdout).result as {
      transactionId: string;
      tree: string;
      commitHash: string;
    };
    assert.equal(
      preferredResult.transactionId,
      compatibilityResult.result.transactionId,
    );
    assert.equal(preferredResult.tree, compatibilityResult.result.tree);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(getSession(repository, session.sessionId).state, 'committed');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      preferredResult.commitHash,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function runCli(repository: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...args],
    { cwd: repository, encoding: 'utf8' },
  );
}

function snapshotRepositoryObservation(repository: string): {
  head: string;
  status: string;
  runtime: Array<readonly [string, string]>;
} {
  const runtimeRoot = path.join(repository, '.git', 'workflow-engine');
  const runtime = fs.existsSync(runtimeRoot)
    ? fs
        .readdirSync(runtimeRoot, { recursive: true, encoding: 'utf8' })
        .map(String)
        .sort()
        .filter((relativePath) =>
          fs.lstatSync(path.join(runtimeRoot, relativePath)).isFile(),
        )
        .map(
          (relativePath) =>
            [
              relativePath,
              fs.readFileSync(path.join(runtimeRoot, relativePath), 'hex'),
            ] as const,
        )
    : [];
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    runtime,
  };
}
