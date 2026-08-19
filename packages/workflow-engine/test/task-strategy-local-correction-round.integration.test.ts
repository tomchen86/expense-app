import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { resolveCurrentTaskStrategyCorrection } from '../src/application/execute-task/task-strategy-correction.ts';
import { listTaskStrategyCorrectionRounds } from '../src/runtime/storage-journal/task-strategy-correction-round-store.ts';
import { adoptCurrentTaskStrategyImplementation } from '../src/application/execute-task/task-strategy-patch.ts';
import { sealTaskStrategyRed } from '../src/application/execute-task/task-strategy-execution.ts';
import { resumeTaskStrategy } from '../src/application/execute-task/task-strategy-lifecycle.ts';
import {
  checkSession,
  inspectSession,
} from '../src/application/finalize/verification.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('single-agent correction reserves and authenticates one local round before exposing its patch head', () => {
  const repository = createLocalCorrectionFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const initial = adoptCurrentTaskStrategyImplementation(
      repository,
      session.sessionId,
    )!;

    assert.throws(
      () => checkSession(repository, session.sessionId, { environment: {} }),
      hasCode('CHECK_FAILED'),
    );
    fs.writeFileSync(implementationPath, 'export const corrected = true;\n');

    const resumed = resumeTaskStrategy(repository, session.sessionId);
    assert.equal(resumed.state, 'patch-imported');

    const inspection = inspectSession(repository, session.sessionId);
    const projection = resolveCurrentTaskStrategyCorrection(inspection);
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const rounds = listTaskStrategyCorrectionRounds(
      runtime,
      session.sessionId,
      red.recordDigest,
    );
    assert.equal(rounds.length, 1);
    const round = rounds[0]!;
    assert.equal(round.reservation.authority.kind, 'sealed-local');
    assert.deepEqual(round.reservation.authority, {
      kind: 'sealed-local',
      author: red.author,
    });
    assert.deepEqual(round.result?.authority, round.reservation.authority);
    assert.deepEqual(round.importRecord?.authority, round.result?.authority);
    assert.equal(
      round.result?.patchResult.sourceTree,
      initial.record.candidateTree,
    );
    assert.equal(
      round.result?.patchResult.targetCandidateTree,
      projection.head?.record.candidateTree,
    );
    assert.equal(
      round.importRecord?.currentPatchHead.recordDigest,
      projection.head?.record.recordDigest,
    );
    assert.equal(projection.completedCorrectionRounds, rounds.length);
    assert.equal(projection.failure, null);
    assert.equal(projection.exhausted, false);
    assert.equal(JSON.stringify(round).includes('invocationId'), false);
    assert.equal(JSON.stringify(round).includes('providerRequest'), false);
    assert.equal(
      checkSession(repository, session.sessionId, { environment: {} }).passed,
      true,
    );
    fs.rmSync(
      path.join(
        runtime.refs,
        'task-strategy-correction-rounds',
        session.sessionId,
        red.recordDigest,
      ),
      { recursive: true },
    );
    assert.throws(
      () =>
        resolveCurrentTaskStrategyCorrection(
          inspectSession(repository, session.sessionId),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createLocalCorrectionFixture(): string {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'red-check-count');
  fs.writeFileSync(
    path.join(repository, 'scripts/red-runner.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(count + 1));',
      "if (fs.existsSync('src/feature.ts')) process.exit(0);",
      'const result = {',
      '  schemaVersion: 1,',
      "  kind: 'workflow-red-check-result.v1',",
      "  outcome: 'expected-red',",
      "  failureCategory: 'assertion',",
      "  selector: 'feature behavior',",
      "  testPaths: ['test/feature.test.mjs'],",
      '};',
      'process.stdout.write(`WORKFLOW_RED_CHECK_RESULT ${JSON.stringify(result)}\\n`);',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'scripts/green-fail.mjs'),
    [
      "import fs from 'node:fs';",
      "const source = fs.existsSync('src/feature.ts') ? fs.readFileSync('src/feature.ts', 'utf8') : '';",
      "if (!source.includes('corrected = true')) {",
      "  process.stderr.write('implementation remains incorrect\\n');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      'green-fail': {
        command: ['node', 'scripts/green-fail.mjs'],
        destructiveDatabase: false,
      },
      red: {
        command: ['node', 'scripts/red-runner.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['green-fail', 'red'],
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
      return {
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
        strategy: 'tdd-single-agent' as const,
        requiredImplementerIndependence: 'none' as const,
        testPathScopes: ['test/**'],
        fixturePathScopes: ['test/fixtures/**'],
        implementationPathScopes: ['src/**'],
        redCheck: 'red',
        greenChecks: ['green-fail', 'red'],
      };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  return repository;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isWorkflowError(error, code);
}
