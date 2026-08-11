import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { finalizeTask } from '../src/lifecycle.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { startSession } from '../src/session.ts';
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

test('cross-agent TDD rejects the RED author and admits an independent engine-checked implementer', () => {
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
          environment: { AGENT: 'codex' },
        }),
      hasCode('TASK_STRATEGY_IMPLEMENTER_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const checked = checkSession(repository, session.sessionId, {
      environment: { AGENT: 'claude' },
    });
    assert.equal(checked.passed, true);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
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

    const checked = checkSession(repository, session.sessionId, {
      environment: { AGENT: 'codex' },
    });
    assert.equal(checked.passed, true);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
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
