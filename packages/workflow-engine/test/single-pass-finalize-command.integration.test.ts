import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitFacts } from '../src/git-transitions.ts';
import { renderHandoff } from '../src/handoff.ts';
import { finalizeSession } from '../src/application/finalize/lifecycle.ts';
import {
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
} from './fixture.ts';

test('workflow finalize checks, commits, and replays one exact candidate tree', () => {
  const repository = createFinalizeFixture();
  const counterPath = path.join(repository, '.git', 'single-pass-count');
  try {
    configureCountingCheck(repository, counterPath);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    const first = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete demo task',
      '--json',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const firstResult = parseResult(first.stdout);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      firstResult.assurance,
      'projected-single-pass-ordinary-failure',
    );
    assert.match(firstResult.transactionId, /^[0-9a-f]{64}$/);
    assert.match(firstResult.commitHash, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      firstResult.commitHash,
    );
    assert.equal(
      git(repository, ['rev-parse', `${firstResult.commitHash}^{tree}`]).trim(),
      firstResult.tree,
    );
    assert.equal(
      commitFacts(repository, firstResult.commitHash).tree,
      firstResult.tree,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(getSession(repository, session.sessionId).state, 'committed');

    const replay = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete demo task',
      '--json',
    ]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(parseResult(replay.stdout), firstResult);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');

    const mismatchedReplay = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Different subject',
      '--json',
    ]);
    assert.notEqual(mismatchedReplay.status, 0);
    assert.equal(
      parseErrorCode(mismatchedReplay.stderr),
      'COMMIT_POSTCONDITION_FAILED',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      firstResult.commitHash,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize resumes after durable finalization without rerunning checks', () => {
  const repository = createFinalizeFixture();
  const counterPath = path.join(repository, '.git', 'single-pass-resume-count');
  try {
    configureCountingCheck(repository, counterPath);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const baseline = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () =>
        finalizeSession(
          repository,
          session.sessionId,
          'Complete after interruption',
          process.env,
          { testCrashAfter: 'finalized' },
        ),
      /Simulated finalize interruption after finalized/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baseline);
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    const transactionBefore = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { phase: string; transactionId: string };
    assert.equal(transactionBefore.phase, 'completed');

    const recovered = finalizeSession(
      repository,
      session.sessionId,
      'Complete after interruption',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(recovered.transactionId, transactionBefore.transactionId);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      recovered.commitHash,
    );
    assert.equal(getSession(repository, session.sessionId).state, 'committed');
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize validates the commit subject before projection or checks', () => {
  const repository = createFinalizeFixture();
  const counterPath = path.join(
    repository,
    '.git',
    'single-pass-invalid-count',
  );
  try {
    configureCountingCheck(repository, counterPath);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    const tasksBefore = fs.readFileSync(tasksPath, 'utf8');
    const handoffBefore = fs.readFileSync(handoffPath, 'utf8');

    const rejected = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Change: forged',
      '--json',
    ]);
    assert.notEqual(rejected.status, 0);
    assert.equal(parseErrorCode(rejected.stderr), 'INVALID_COMMIT_SUBJECT');
    assert.equal(fs.existsSync(counterPath), false);
    assert.equal(fs.readFileSync(tasksPath, 'utf8'), tasksBefore);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), handoffBefore);
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createFinalizeFixture(): string {
  const repository = createFixtureRepository();
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
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
  return repository;
}

function configureCountingCheck(repository: string, counterPath: string): void {
  fs.writeFileSync(
    path.join(repository, 'scripts/count-single-pass.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      "if (!fs.readFileSync('openspec/changes/demo-change/tasks.md', 'utf8').includes('- [x] 1.1')) process.exit(17);",
      "if (!fs.readFileSync('docs/CURRENT_AND_NEXT_STEPS.md', 'utf8').includes('None — no active change.')) process.exit(18);",
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-single-pass.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
}

function runCli(
  repository: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../src/cli.ts'),
      ...args,
    ],
    { cwd: repository, encoding: 'utf8' },
  );
}

function parseResult(stdout: string): {
  assurance: string;
  transactionId: string;
  commitHash: string;
  tree: string;
  [key: string]: unknown;
} {
  return (JSON.parse(stdout) as { result: ReturnType<typeof parseResult> })
    .result;
}

function parseErrorCode(stdout: string): string {
  return (JSON.parse(stdout) as { error: { code: string } }).error.code;
}
