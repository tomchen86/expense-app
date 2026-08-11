import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { runGitWithEnvironment } from '../src/git.ts';
import { finalizeTask } from '../src/lifecycle.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { startSession } from '../src/session.ts';
import {
  importTaskStrategyPatch,
  inspectTaskStrategyPatchState,
  validateTaskStrategyPatch,
} from '../src/task-strategy-patch.ts';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/task-strategy-execution.ts';
import { checkSession } from '../src/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('cross-agent TDD cannot enter finalize checks without an engine-sealed RED', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const implementedWithoutRed = true;\n',
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_STRATEGY_RED_REQUIRED'),
    );
    assert.equal(fs.existsSync(counterPath), false);
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('seal RED runs the pinned check, freezes exact test bytes, and replays one immutable transaction state', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );

    const sealed = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(sealed.phase, 'red-sealed');
    assert.equal(sealed.strategy, 'cross-agent-tdd');
    assert.equal(sealed.red.checkId, 'red');
    assert.equal(sealed.red.failureCategory, 'assertion');
    assert.deepEqual(sealed.red.testPaths, ['test/feature.test.mjs']);
    assert.deepEqual(sealed.red.fixturePaths, []);
    assert.deepEqual(
      sealed.red.files.map(({ path: relativePath }) => relativePath),
      ['test/feature.test.mjs'],
    );
    assert.match(sealed.red.failureFingerprint, /^[0-9a-f]{64}$/);
    assert.match(sealed.red.evidenceNodeId, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    assert.deepEqual(
      sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      }),
      sealed,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    fs.writeFileSync(testPath, "throw new Error('silently weakened test');\n");
    assert.throws(
      () =>
        sealTaskStrategyRed(repository, session.sessionId, {
          explicitActor: 'codex',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_RED_STALE'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: { AGENT: 'claude' },
        }),
      hasCode('TASK_STRATEGY_RED_STALE'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('seal RED rejects an unrelated or structurally invalid failure category', () => {
  const { repository, counterPath } = createCrossAgentFixture('syntax');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n');

    assert.throws(
      () =>
        sealTaskStrategyRed(repository, session.sessionId, {
          explicitActor: 'codex',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_RED_FAILURE_INVALID'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sealed RED state is canonical and digest-bound before any gate trusts it', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const statePath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategies',
      `${session.sessionId}.json`,
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      red: { failureCategory: string };
    };
    state.red.failureCategory = 'behavior-mismatch';
    fs.writeFileSync(statePath, `${canonicalJson(state)}\n`);

    assert.throws(
      () => inspectTaskStrategyTransaction(repository, session.sessionId),
      hasCode('TASK_STRATEGY_STATE_CORRUPT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('cross-agent TDD rejects manual implementation bytes without an engine-imported patch receipt', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: { AGENT: 'claude' },
        }),
      hasCode('TASK_STRATEGY_PATCH_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent TDD keeps the RED gate and engine GREEN evidence without false role symmetry', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const transaction = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(transaction.strategy, 'tdd-single-agent');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    const patch = diffAgainstTree(repository, transaction.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(path.join(repository, 'src/feature.ts'));
    importTaskStrategyPatch(repository, session.sessionId, {
      patch,
      explicitActor: 'codex',
      environment: {},
    });

    const checked = checkSession(repository, session.sessionId, {
      environment: { AGENT: 'codex' },
    });
    assert.equal(checked.passed, true);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('cross-agent patch validation derives one bounded implementation tree without touching the task worktree', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        validateTaskStrategyPatch(repository, session.sessionId, {
          patch,
          explicitActor: 'codex',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_IMPLEMENTER_REQUIRED'),
    );
    const validation = validateTaskStrategyPatch(
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'claude',
        environment: {},
      },
    );
    assert.equal(validation.sourceTree, red.red.candidateTree);
    assert.notEqual(validation.candidateTree, validation.sourceTree);
    assert.deepEqual(validation.changedPaths, ['src/feature.ts']);
    assert.equal(validation.implementer.providerId, 'claude');
    assert.match(validation.patchDigest, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(implementationPath), false);
    assert.deepEqual(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      red,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch validation rejects frozen tests, path escape, and unsafe file modes from the derived tree', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    const originalTest =
      "throw new Error('feature behavior is not implemented');\n";
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, originalTest);
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });

    fs.writeFileSync(testPath, "throw new Error('weakened');\n");
    const frozenPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'test/feature.test.mjs',
    ]);
    fs.writeFileSync(testPath, originalTest);
    assert.throws(
      () =>
        validateTaskStrategyPatch(repository, session.sessionId, {
          patch: frozenPatch,
          explicitActor: 'claude',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_PATCH_FROZEN_PATH'),
    );

    const escapedPath = path.join(repository, 'docs/escape.md');
    fs.mkdirSync(path.dirname(escapedPath), { recursive: true });
    fs.writeFileSync(escapedPath, 'escape\n');
    const escapedPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'docs/escape.md',
    ]);
    fs.rmSync(escapedPath);
    assert.throws(
      () =>
        validateTaskStrategyPatch(repository, session.sessionId, {
          patch: escapedPatch,
          explicitActor: 'claude',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_PATCH_SCOPE_INVALID'),
    );

    const symlinkPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.symlinkSync('../test/feature.test.mjs', symlinkPath);
    const symlinkPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(symlinkPath);
    assert.throws(
      () =>
        validateTaskStrategyPatch(repository, session.sessionId, {
          patch: symlinkPatch,
          explicitActor: 'claude',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_PATCH_MODE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent patch validation permits the RED author without weakening patch boundaries', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    const validation = validateTaskStrategyPatch(
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'codex',
        environment: {},
      },
    );
    assert.equal(validation.implementer.providerId, 'codex');
    assert.deepEqual(validation.changedPaths, ['src/feature.ts']);
    assert.equal(fs.existsSync(implementationPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch import persists authority before mutation and exact replay reaches engine GREEN once', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const patchDigest = sha256Buffer(patch);

    assert.throws(
      () =>
        importTaskStrategyPatch(repository, session.sessionId, {
          patch,
          explicitActor: 'claude',
          environment: {},
          testCrashAfter: 'reservation-persisted',
        }),
      /reservation-persisted/,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    assert.throws(
      () =>
        inspectTaskStrategyPatchState(
          repository,
          session.sessionId,
          patchDigest,
        ),
      hasCode('TASK_STRATEGY_PATCH_NOT_FOUND'),
    );
    assert.throws(
      () =>
        importTaskStrategyPatch(repository, session.sessionId, {
          patch,
          explicitActor: 'claude',
          environment: {},
          testCrashAfter: 'record-persisted',
        }),
      /record-persisted/,
    );
    const prepared = inspectTaskStrategyPatchState(
      repository,
      session.sessionId,
      patchDigest,
    );
    assert.equal(prepared.record.patchDigest, patchDigest);
    assert.equal(prepared.receipt, null);

    const imported = importTaskStrategyPatch(repository, session.sessionId, {
      patch,
      explicitActor: 'claude',
      environment: {},
    });
    assert.equal(imported.receipt.candidateTree, imported.record.candidateTree);
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    assert.deepEqual(
      importTaskStrategyPatch(repository, session.sessionId, {
        patch,
        explicitActor: 'claude',
        environment: {},
      }),
      imported,
    );

    const checked = checkSession(repository, session.sessionId, {
      environment: {},
    });
    assert.equal(checked.passed, true);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch-applied crash reconciles the exact candidate and later drift stales the receipt', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        importTaskStrategyPatch(repository, session.sessionId, {
          patch,
          explicitActor: 'claude',
          environment: {},
          testCrashAfter: 'patch-applied',
        }),
      /patch-applied/,
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    const recovered = importTaskStrategyPatch(repository, session.sessionId, {
      patch,
      explicitActor: 'claude',
      environment: {},
    });
    assert.notEqual(recovered.receipt, null);

    fs.writeFileSync(implementationPath, 'export const feature = false;\n');
    assert.throws(
      () => checkSession(repository, session.sessionId, { environment: {} }),
      hasCode('TASK_STRATEGY_PATCH_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a durable prepared patch reservation rejects a different patch before either can mutate the worktree', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patchA = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.writeFileSync(implementationPath, 'export const feature = 2;\n');
    const patchB = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        importTaskStrategyPatch(repository, session.sessionId, {
          patch: patchA,
          explicitActor: 'claude',
          environment: {},
          testCrashAfter: 'reservation-persisted',
        }),
      /reservation-persisted/,
    );
    assert.throws(
      () =>
        importTaskStrategyPatch(repository, session.sessionId, {
          patch: patchB,
          explicitActor: 'claude',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_PATCH_RESERVATION_CONFLICT'),
    );
    assert.equal(fs.existsSync(implementationPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch inspection rejects independently redigested reservation metadata', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const imported = importTaskStrategyPatch(repository, session.sessionId, {
      patch,
      explicitActor: 'claude',
      environment: {},
    });
    const reservationPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-patches',
      session.sessionId,
      'reservation.json',
    );
    const reservation = JSON.parse(
      fs.readFileSync(reservationPath, 'utf8'),
    ) as Record<string, unknown>;
    reservation.createdAt = new Date(
      Date.parse(String(reservation.createdAt)) + 1_000,
    ).toISOString();
    const { reservationDigest: _oldDigest, ...body } = reservation;
    reservation.reservationDigest = createHash('sha256')
      .update(canonicalJson(body))
      .digest('hex');
    fs.writeFileSync(reservationPath, `${canonicalJson(reservation)}\n`);

    assert.throws(
      () =>
        inspectTaskStrategyPatchState(
          repository,
          session.sessionId,
          imported.record.patchDigest,
        ),
      hasCode('TASK_STRATEGY_PATCH_STATE_CORRUPT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createCrossAgentFixture(
  failureCategory: 'assertion' | 'syntax',
  strategy: 'cross-agent-tdd' | 'tdd-single-agent' = 'cross-agent-tdd',
): { repository: string; counterPath: string } {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'red-check-count');
  fs.writeFileSync(
    path.join(repository, 'scripts/red-runner.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      'const failureCategory = process.argv[3];',
      "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(count + 1));',
      "if (fs.existsSync('src/feature.ts')) process.exit(0);",
      'const result = {',
      '  schemaVersion: 1,',
      "  kind: 'workflow-red-check-result.v1',",
      "  outcome: 'expected-red',",
      '  failureCategory,',
      "  selector: 'feature behavior',",
      "  testPaths: ['test/feature.test.mjs'],",
      '};',
      'process.stdout.write(`WORKFLOW_RED_CHECK_RESULT ${JSON.stringify(result)}\\n`);',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      red: {
        command: [
          'node',
          'scripts/red-runner.mjs',
          counterPath,
          failureCategory,
        ],
        destructiveDatabase: false,
      },
    },
    ['red'],
  );
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = ['src/**', 'test/**'];
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository, 'demo-change', {
    executionTask({ policy }) {
      const common = {
        enforcement: 'planned' as const,
        allowedPaths: policy.allowedPaths,
        requiredChecks: policy.requiredChecks,
        diffReview: 'required' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['test/**'],
        fixturePathScopes: ['test/fixtures/**'],
        implementationPathScopes: ['src/**'],
        redCheck: 'red',
        greenChecks: ['red'],
      };
      return strategy === 'cross-agent-tdd'
        ? {
            ...common,
            strategy,
            requiredImplementerIndependence: 'provider-independent',
          }
        : {
            ...common,
            strategy,
            requiredImplementerIndependence: 'none',
          };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  return { repository, counterPath };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isWorkflowError(error, code);
}

function diffAgainstTree(
  repository: string,
  tree: string,
  paths: string[],
): Buffer {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-strategy-test-patch-'),
  );
  const environment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  const literals = paths.map((entry) => `:(literal)${entry}`);
  try {
    runGitWithEnvironment(repository, ['read-tree', tree], environment);
    runGitWithEnvironment(
      repository,
      ['add', '-A', '--', ...literals],
      environment,
    );
    return Buffer.from(
      runGitWithEnvironment(
        repository,
        [
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-renames',
          tree,
          '--',
          ...literals,
        ],
        environment,
      ),
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
