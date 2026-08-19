import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { TransformationTerm } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { finalizeTask } from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { beginTaskDiffReview } from '../src/application/finalize/task-diff-review-lifecycle.ts';
import {
  inspectTaskMechanicalTransformLifecycle,
  resumeTaskMechanicalTransformation,
} from '../src/application/execute-task/task-mechanical-transform-lifecycle.ts';
import {
  inspectTaskStrategyLifecycle,
  resumeTaskStrategy,
} from '../src/application/execute-task/task-strategy-lifecycle.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('routine resume produces and replays an exact deterministic mechanical transformation without a provider', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.equal(
      inspectTaskStrategyLifecycle(fixture.repository, fixture.sessionId).state,
      'transformation-required',
    );

    const resumed = runCli(fixture.repository, [
      'resume',
      fixture.sessionId,
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.body.result.state, 'transformation-produced');
    assert.equal(
      fs.readFileSync(
        path.join(fixture.repository, 'src/features/NEW_NAME.ts'),
        'utf8',
      ),
      "export const NEW_NAME = 'NEW_NAME';\n",
    );
    assert.equal(
      fs.statSync(path.join(fixture.repository, 'src/features/NEW_NAME.ts'))
        .mode & 0o111,
      0o111,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.repository, 'src/features/OLD_NAME.ts')),
      false,
    );
    assert.equal(providerInvocationCount(fixture.repository), 0);

    const replay = runCli(fixture.repository, [
      'resume',
      fixture.sessionId,
      '--json',
    ]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(replay.body.result.state, 'transformation-produced');
    assert.equal(providerInvocationCount(fixture.repository), 0);
    const finalized = finalizeTask(fixture.repository, fixture.sessionId);
    assert.ok(finalized.checkReportId);
    assert.equal(
      finalized.stagedPaths.includes('src/features/NEW_NAME.ts'),
      true,
    );
    assert.equal(
      finalized.stagedPaths.includes('src/features/OLD_NAME.ts'),
      true,
    );
    assert.equal(
      inspectTaskStrategyLifecycle(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('mechanical resume never overwrites foreign target bytes introduced after preflight', () => {
  const fixture = createMechanicalLifecycleFixture({
    oldTerms: [{ kind: 'symbol', value: 'OLD_NAME' }],
    replacementTerms: [{ kind: 'symbol', value: 'NEW_NAME' }],
  });
  const target = path.join(fixture.repository, 'src/features/OLD_NAME.ts');
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testBeforeFirstTargetPublish() {
              fs.writeFileSync(target, 'foreign same-path bytes\n');
            },
          },
        ),
      hasCode('TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT'),
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'foreign same-path bytes\n');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('mechanical target replacement preserves a foreign inode introduced after final CAS', () => {
  const fixture = createMechanicalLifecycleFixture({
    oldTerms: [{ kind: 'symbol', value: 'OLD_NAME' }],
    replacementTerms: [{ kind: 'symbol', value: 'NEW_NAME' }],
  });
  const target = path.join(fixture.repository, 'src/features/OLD_NAME.ts');
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterTargetCasBeforePathMutation() {
              replacePathAtomically(target, 'foreign target replacement\n');
            },
          },
        ),
      hasCode('TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT'),
    );
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      'foreign target replacement\n',
    );
    assert.deepEqual(mechanicalResidues(fixture.repository), []);
    assert.throws(
      () => resumeTaskStrategy(fixture.repository, fixture.sessionId),
      hasCode('TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT'),
    );
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      'foreign target replacement\n',
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('mechanical target creation never overwrites a foreign pathname claimed after final CAS', () => {
  const fixture = createMechanicalLifecycleFixture();
  const target = path.join(fixture.repository, 'src/features/NEW_NAME.ts');
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterTargetCasBeforePathMutation() {
              fs.writeFileSync(target, 'foreign target creation\n');
            },
          },
        ),
      hasCode('TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT'),
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'foreign target creation\n');
    assert.deepEqual(mechanicalResidues(fixture.repository), []);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('mechanical source removal preserves a foreign inode introduced after final CAS', () => {
  const fixture = createMechanicalLifecycleFixture();
  const source = path.join(fixture.repository, 'src/features/OLD_NAME.ts');
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterSourceCasBeforePathMutation() {
              replacePathAtomically(source, 'foreign source replacement\n');
            },
          },
        ),
      hasCode('TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT'),
    );
    assert.equal(
      fs.readFileSync(source, 'utf8'),
      'foreign source replacement\n',
    );
    assert.deepEqual(mechanicalResidues(fixture.repository), []);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('ordinary resume recovers a target quarantined before no-replace publication', () => {
  const fixture = createMechanicalLifecycleFixture({
    oldTerms: [{ kind: 'symbol', value: 'OLD_NAME' }],
    replacementTerms: [{ kind: 'symbol', value: 'NEW_NAME' }],
  });
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterTargetQuarantine() {
              throw new Error('simulated target-quarantine crash');
            },
          },
        ),
      /simulated target-quarantine crash/,
    );
    assert.equal(
      resumeTaskStrategy(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
    assert.deepEqual(mechanicalResidues(fixture.repository), []);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('ordinary resume recovers a source quarantined before exact removal', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterSourceQuarantine() {
              throw new Error('simulated source-quarantine crash');
            },
          },
        ),
      /simulated source-quarantine crash/,
    );
    assert.equal(
      resumeTaskStrategy(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
    assert.deepEqual(mechanicalResidues(fixture.repository), []);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('ordinary resume recovers a published target hard link before temporary cleanup', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterTargetHardLink() {
              throw new Error('simulated target-hard-link crash');
            },
          },
        ),
      /simulated target-hard-link crash/,
    );
    assert.equal(
      resumeTaskStrategy(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
    assert.deepEqual(mechanicalResidues(fixture.repository), []);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'explicit', diffReview: 'required' as const, basis: 'explicit' },
  {
    name: 'risk-role',
    diffReview: 'policy-required' as const,
    basis: 'risk-role',
  },
] as const) {
  test(`checked Mode C ${scenario.name} review resolves its projection-aware implementation actor`, () => {
    const fixture = createMechanicalLifecycleFixture({
      diffReview: scenario.diffReview,
    });
    try {
      assert.equal(
        resumeTaskStrategy(fixture.repository, fixture.sessionId).state,
        'transformation-produced',
      );
      assert.throws(
        () => finalizeTask(fixture.repository, fixture.sessionId),
        hasCode('TASK_DIFF_REVIEW_REQUIRED'),
      );
      const prepared = beginTaskDiffReview(
        fixture.repository,
        fixture.sessionId,
        { explicitActor: 'codex', environment: {} },
      );
      assert.equal(prepared.state, 'waiting-for-provider');
      assert.equal(prepared.subject.reviewRequirement.required, true);
      assert.equal(prepared.subject.reviewRequirement.basis, scenario.basis);
      if (scenario.basis === 'risk-role') {
        assert.equal(
          prepared.subject.reviewRequirement.riskPaths.some(
            ({ path: reviewedPath }) =>
              reviewedPath === 'src/features/NEW_NAME.ts',
          ),
          true,
        );
      }
    } finally {
      fs.rmSync(fixture.repository, { recursive: true, force: true });
    }
  });
}

test('ordinary resume recovers an interrupted journal-bound mechanical projection', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterFirstTargetPublish() {
              throw new Error('simulated target-publication crash');
            },
          },
        ),
      /simulated target-publication crash/,
    );
    assert.equal(
      inspectTaskStrategyLifecycle(fixture.repository, fixture.sessionId).state,
      'transformation-required',
    );
    assert.equal(
      resumeTaskStrategy(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
    assert.equal(providerInvocationCount(fixture.repository), 0);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('ordinary resume completes the journal when a crash leaves exact projected bytes', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterProjectionPublish() {
              throw new Error('simulated pre-terminal-CAS crash');
            },
          },
        ),
      /simulated pre-terminal-CAS crash/,
    );
    assert.equal(
      inspectTaskStrategyLifecycle(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
    assert.equal(projectionJournalState(fixture), 'prepared');
    assert.equal(
      resumeTaskStrategy(fixture.repository, fixture.sessionId).state,
      'transformation-produced',
    );
    assert.equal(projectionJournalState(fixture), 'completed');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status fails closed when a crashed projection path drifts from journal-bound bytes', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterProjectionPublish() {
              throw new Error('simulated pre-terminal-CAS crash');
            },
          },
        ),
      /simulated pre-terminal-CAS crash/,
    );
    fs.writeFileSync(
      path.join(fixture.repository, 'src/features/NEW_NAME.ts'),
      'foreign same-path bytes\n',
    );
    assert.throws(
      () => inspectTaskStrategyLifecycle(fixture.repository, fixture.sessionId),
      hasCode('TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('mechanical recovery failure returns one literal resume command', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    assert.throws(
      () =>
        resumeTaskMechanicalTransformation(
          fixture.repository,
          fixture.sessionId,
          {
            testAfterProjectionPublish() {
              fs.writeFileSync(
                path.join(fixture.repository, 'src/features/NEW_NAME.ts'),
                'foreign same-path bytes\n',
              );
            },
          },
        ),
      hasCodeAndRecovery(
        'TASK_MECHANICAL_TRANSFORMATION_RECOVERY_REQUIRED',
        `pnpm workflow resume ${fixture.sessionId} --json`,
      ),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('mechanical resume refuses symlink and binary inputs before mutation', () => {
  const fixtures = [
    createMechanicalLifecycleFixture({
      files: {},
      symlinks: { 'src/features/OLD_NAME.ts': '../../outside-target' },
    }),
    createMechanicalLifecycleFixture({
      files: {
        'src/features/OLD_NAME.ts': Buffer.from('OLD_NAME\0binary'),
      },
    }),
  ];
  try {
    for (const fixture of fixtures) {
      assert.throws(
        () => resumeTaskStrategy(fixture.repository, fixture.sessionId),
        hasCode('TASK_MECHANICAL_TRANSFORMATION_INPUT_UNSCANNABLE'),
      );
      assert.equal(providerInvocationCount(fixture.repository), 0);
    }
  } finally {
    for (const fixture of fixtures) {
      fs.rmSync(fixture.repository, { recursive: true, force: true });
    }
  }
});

test('mechanical resume refuses deterministic path collision and scope escape', () => {
  const collision = createMechanicalLifecycleFixture({
    files: {
      'src/features/OLD_NAME.ts': 'export const oldName = true;\n',
      'src/features/NEW_NAME.ts': 'export const newName = true;\n',
    },
    oldTerms: [{ kind: 'path', value: 'OLD_NAME' }],
    replacementTerms: [{ kind: 'path', value: 'NEW_NAME' }],
  });
  const escape = createMechanicalLifecycleFixture({
    files: { 'src/OLD/feature.ts': 'export const feature = true;\n' },
    fileScopes: ['src/OLD/**'],
    oldTerms: [{ kind: 'path', value: 'src/OLD' }],
    replacementTerms: [{ kind: 'path', value: 'outside' }],
  });
  try {
    for (const fixture of [collision, escape]) {
      assert.throws(
        () => resumeTaskStrategy(fixture.repository, fixture.sessionId),
        hasCode('TASK_MECHANICAL_TRANSFORMATION_PROJECTION_INVALID'),
      );
      assert.equal(providerInvocationCount(fixture.repository), 0);
    }
  } finally {
    fs.rmSync(collision.repository, { recursive: true, force: true });
    fs.rmSync(escape.repository, { recursive: true, force: true });
  }
});

test('mechanical status inspection remains strictly read-only', () => {
  const fixture = createMechanicalLifecycleFixture();
  try {
    const before = runtimeFiles(fixture.repository);
    assert.equal(
      inspectTaskMechanicalTransformLifecycle(
        fixture.repository,
        fixture.sessionId,
      )?.state,
      'transformation-required',
    );
    assert.deepEqual(runtimeFiles(fixture.repository), before);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

type MechanicalLifecycleFixtureOptions = Readonly<{
  files?: Readonly<Record<string, string | Buffer>>;
  symlinks?: Readonly<Record<string, string>>;
  executablePaths?: readonly string[];
  fileScopes?: string[];
  oldTerms?: TransformationTerm[];
  replacementTerms?: TransformationTerm[];
  diffReview?: 'required' | 'policy-required';
}>;

function createMechanicalLifecycleFixture(
  options: MechanicalLifecycleFixtureOptions = {},
): {
  repository: string;
  sessionId: string;
} {
  const repository = createFixtureRepository();
  const files = options.files ?? {
    'src/features/OLD_NAME.ts': "export const OLD_NAME = 'OLD_NAME';\n",
  };
  const executablePaths = new Set(
    options.executablePaths ?? ['src/features/OLD_NAME.ts'],
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, {
      mode: executablePaths.has(relativePath) ? 0o755 : 0o644,
    });
  }
  for (const [relativePath, target] of Object.entries(options.symlinks ?? {})) {
    const link = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
  }
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['openspec/changes/**'] = {
    mode: 'change-artifact',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  if (options.diffReview !== undefined) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
      path.join(repository, 'workflow/path-roles.json'),
    );
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      path.join(repository, 'workflow/maintainer-policy.json'),
    );
  }
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Add mechanical transform baseline']);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  const oldTerms = options.oldTerms ?? [
    { kind: 'path' as const, value: 'OLD_NAME' },
    { kind: 'symbol' as const, value: 'OLD_NAME' },
  ];
  const replacementTerms = options.replacementTerms ?? [
    { kind: 'path' as const, value: 'NEW_NAME' },
    { kind: 'symbol' as const, value: 'NEW_NAME' },
  ];
  writeReadyV2ExemptChange(repository, 'demo-change', {
    executionTask({ policy }) {
      return {
        strategy: 'mechanical-transform',
        enforcement: 'planned',
        allowedPaths: policy.allowedPaths,
        requiredChecks: policy.requiredChecks,
        diffReview: options.diffReview ?? 'policy-required',
        transformationContract: {
          rule: 'Rename OLD_NAME to NEW_NAME exactly.',
          examples: [
            {
              before: oldTerms[0]!.value,
              after: replacementTerms[0]!.value,
            },
          ],
          fileScopes: options.fileScopes ?? ['src/features/**'],
          oldTerms,
          replacementTerms,
          retainedDispositions: oldTerms
            .filter((term) => term.kind !== 'path')
            .map((term) => ({
              term,
              path: 'openspec/changes/demo-change/execution.json',
              mutationClass: 'immutable',
              reason:
                'The reviewed contract preserves its exact transformation input.',
            })),
          redInapplicableReason:
            'The reviewed literal codemod and exact-byte closure specify this task.',
        },
      };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  return { repository, sessionId: session.sessionId };
}

function providerInvocationCount(repository: string): number {
  const directory = path.join(
    repository,
    '.git/workflow-engine/investigations/invocations',
  );
  return fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
}

function replacePathAtomically(target: string, content: string): void {
  const foreign = `${target}.foreign`;
  fs.writeFileSync(foreign, content);
  fs.renameSync(foreign, target);
}

function mechanicalResidues(repository: string): string[] {
  return git(repository, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((entry) => entry.includes('.workflow-mechanical-'))
    .sort();
}

function projectionJournalState(fixture: {
  repository: string;
  sessionId: string;
}): string {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(
        fixture.repository,
        '.git/workflow-engine/investigations/sessions',
        fixture.sessionId,
        'mechanical-transform/projection-journal.json',
      ),
      'utf8',
    ),
  ) as { state: string };
  return value.state;
}

function runtimeFiles(repository: string): string[] {
  const root = path.join(repository, '.git/workflow-engine');
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map(String)
    .sort()
    .filter((entry) => fs.lstatSync(path.join(root, entry)).isFile());
}

function runCli(
  repository: string,
  args: string[],
): {
  status: number | null;
  stderr: string;
  body: { result: { state: string } };
} {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../src/cli.ts'),
      ...args,
    ],
    { cwd: repository, encoding: 'utf8', env: { ...process.env } },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    body: JSON.parse(result.stdout) as { result: { state: string } },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WorkflowError && error.code === code;
}

function hasCodeAndRecovery(
  code: string,
  recovery: string,
): (error: unknown) => boolean {
  return (error) =>
    hasCode(code)(error) &&
    typeof error === 'object' &&
    error !== null &&
    'recovery' in error &&
    error.recovery === recovery;
}
