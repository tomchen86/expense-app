import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renderHandoff } from '../src/handoff.ts';
import { finalizeTask } from '../src/lifecycle.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { startSession } from '../src/session.ts';
import { inspectTaskDiffReviewSubject } from '../src/task-diff-review-lifecycle.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('review-diff inspect derives one exact checked candidate subject without rerunning checks', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    fs.chmodSync(path.join(repository, 'src/feature.ts'), 0o755);

    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const first = inspectTaskDiffReviewSubject(repository, session.sessionId);
    const replay = inspectTaskDiffReviewSubject(repository, session.sessionId);
    assert.deepEqual(replay, first);
    assert.equal(first.changeId, 'demo-change');
    assert.equal(first.taskId, '1.1');
    assert.equal(first.repositoryId, 'github:R_kgDOOotVag');
    assert.equal(first.reviewRequirement.required, true);
    assert.equal(first.reviewRequirement.basis, 'risk-role');
    assert.match(first.subjectDigest, /^[0-9a-f]{64}$/);
    assert.match(first.checkEvidenceDigest, /^[0-9a-f]{64}$/);
    assert.match(first.taskContractDigest, /^[0-9a-f]{64}$/);
    assert.match(first.requiredCheckPolicyDigest, /^[0-9a-f]{64}$/);
    const transaction = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { candidateTree: string };
    assert.equal(first.candidateTree, transaction.candidateTree);
    assert.deepEqual(
      first.transitions.find(
        ({ path: changedPath }) => changedPath === 'src/feature.ts',
      ),
      {
        path: 'src/feature.ts',
        before: null,
        after: {
          mode: '100755',
          objectId: git(repository, [
            'rev-parse',
            `${first.candidateTree}:src/feature.ts`,
          ]).trim(),
        },
      },
    );

    const inspected = runCli(repository, [
      'review-diff',
      'inspect',
      session.sessionId,
      '--json',
    ]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.deepEqual(
      (JSON.parse(inspected.stdout) as { result: unknown }).result,
      first,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    assert.throws(
      () => inspectTaskDiffReviewSubject(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CANDIDATE_DIVERGED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff inspect is unavailable before checks freeze a candidate', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    assert.throws(
      () => inspectTaskDiffReviewSubject(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_NOT_READY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createReviewFixture(): {
  repository: string;
  counterPath: string;
} {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'review-diff-count');
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
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
    path.join(repository, 'workflow/path-roles.json'),
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  configureCountingCheck(repository, counterPath);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  return { repository, counterPath };
}

function configureCountingCheck(repository: string, counterPath: string): void {
  fs.writeFileSync(
    path.join(repository, 'scripts/count-review-diff.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-review-diff.mjs', counterPath],
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
