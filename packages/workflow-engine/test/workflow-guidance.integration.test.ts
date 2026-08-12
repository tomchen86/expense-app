import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  WORKFLOW_GUIDANCE_CATALOG,
  workflowCommandGuidance,
} from '../src/workflow-guidance.ts';
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
