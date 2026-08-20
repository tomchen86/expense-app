import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { runGitWithEnvironment } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { readProviderInvocationManifest } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  readCurrentTaskStrategyGreenFailure,
  resolveCurrentTaskStrategyCorrection,
} from '../src/application/execute-task/task-strategy-correction.ts';
import { readTaskStrategyCorrectionRound } from '../src/runtime/storage-journal/task-strategy-correction-round-store.ts';
import {
  assertTaskStrategyImplementationProviderOwnerCurrent,
  beginTaskStrategyImplementation,
  inspectTaskStrategyImplementation,
} from '../src/application/execute-task/task-strategy-implementation-lifecycle.ts';
import {
  inspectTaskStrategyLifecycle,
  resumeTaskStrategy,
} from '../src/application/execute-task/task-strategy-lifecycle.ts';
import { readTaskStrategyImplementationResultBinding } from '../src/runtime/storage-journal/task-strategy-provider-store.ts';
import { sealTaskStrategyRed } from '../src/application/execute-task/task-strategy-execution.ts';
import {
  checkSession,
  inspectSession,
} from '../src/application/finalize/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV2ExemptChange,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';

for (const crashCut of [
  null,
  'patch-applied',
  'receipt-persisted',
  'provider-patch-imported',
] as const) {
  test(`cross-agent GREEN correction schedules and imports against the exact failed candidate${crashCut === null ? '' : ` after ${crashCut} recovery`}`, () => {
    const repository = createCorrectionFixture();
    try {
      const session = startSession(repository, 'demo-change', '1.1');
      const testPath = path.join(repository, 'test/feature.test.mjs');
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
      const red = sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });

      const initialWaiting = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.equal(initialWaiting.state, 'waiting-for-provider');
      if (initialWaiting.state !== 'waiting-for-provider') return;
      assert.equal(initialWaiting.subject.correction, undefined);
      const initialInspection = inspectSession(repository, session.sessionId);
      const runtime = investigationRuntimePaths(
        initialInspection.git.gitCommonDirectory,
        initialInspection.contract.config.runtimeDirectory,
      );
      assert.equal(
        readTaskStrategyCorrectionRound(
          runtime,
          session.sessionId,
          red.recordDigest,
          1,
        ),
        null,
      );

      const implementationPath = path.join(repository, 'src/feature.ts');
      fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
      fs.writeFileSync(implementationPath, 'export const feature = true;\n');
      const initialPatch = diffAgainstTree(repository, red.red.candidateTree, [
        'src/feature.ts',
      ]);
      fs.rmSync(implementationPath);
      completeProvider(
        repository,
        initialWaiting.invocationId,
        initialWaiting.assignment.providerId,
        taskImplementationOutput(
          session.sessionId,
          red.red.candidateTree,
          initialPatch,
        ),
      );
      assert.equal(
        beginTaskStrategyImplementation(repository, session.sessionId).state,
        'patch-imported',
      );
      if (crashCut === null) {
        const initialResultPath = path.join(
          runtime.refs,
          'task-strategy-implementations',
          session.sessionId,
          'result.json',
        );
        assertProjectionRejectsMissingAuthorityArtifact(
          repository,
          session.sessionId,
          initialResultPath,
        );
        assertProjectionRejectsTamperedAuthorityBinding(
          repository,
          session.sessionId,
          initialResultPath,
        );
      }

      assert.throws(
        () => checkSession(repository, session.sessionId, { environment: {} }),
        hasCode('CHECK_FAILED'),
      );
      const failure = readCurrentTaskStrategyGreenFailure(
        inspectSession(repository, session.sessionId),
      );
      assert.notEqual(failure, null);
      if (failure === null) return;

      const correctionWaiting = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.equal(correctionWaiting.state, 'waiting-for-provider');
      if (correctionWaiting.state !== 'waiting-for-provider') return;
      assert.equal(correctionWaiting.subject.sourceTree, failure.candidateTree);
      assert.equal(correctionWaiting.subject.correction?.round, 1);
      assert.equal(
        correctionWaiting.subject.correction?.greenFailureRecordDigest,
        failure.recordDigest,
      );
      assert.notEqual(
        correctionWaiting.subject.subjectDigest,
        initialWaiting.subject.subjectDigest,
      );
      assert.throws(
        () =>
          assertTaskStrategyImplementationProviderOwnerCurrent(
            repository,
            initialWaiting.invocationId,
          ),
        hasCode('TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT'),
      );
      const correctionProviderReservation =
        assertTaskStrategyImplementationProviderOwnerCurrent(
          repository,
          correctionWaiting.invocationId,
        );
      assert.equal(
        correctionProviderReservation.subject.subjectDigest,
        correctionWaiting.subject.subjectDigest,
      );
      const inspected = inspectSession(repository, session.sessionId);
      const manifest = readProviderInvocationManifest(
        investigationRuntimePaths(
          inspected.git.gitCommonDirectory,
          inspected.contract.config.runtimeDirectory,
        ),
        correctionWaiting.invocationId,
      );
      assert.equal(manifest.kind, 'task-strategy-implementation-manifest');
      if (manifest.kind !== 'task-strategy-implementation-manifest') return;
      assert.deepEqual(manifest.greenFailureRecord, failure);
      assert.equal(
        manifest.subject.subjectDigest,
        correctionWaiting.subject.subjectDigest,
      );
      const reservedRound = readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        1,
      );
      assert.notEqual(reservedRound, null);
      if (reservedRound === null) return;
      assert.equal(reservedRound.result, null);
      assert.equal(reservedRound.importRecord, null);
      assert.equal(
        reservedRound.reservation.correctionSubjectDigest,
        correctionWaiting.subject.subjectDigest,
      );
      assert.equal(
        reservedRound.reservation.redSourceTree,
        red.red.candidateTree,
      );
      assert.equal(reservedRound.reservation.authority.kind, 'provider');
      if (reservedRound.reservation.authority.kind !== 'provider') return;
      assert.deepEqual(reservedRound.reservation.authority, {
        kind: 'provider',
        providerRequest: {
          ownerInvestigationId: correctionWaiting.ownerInvestigationId,
          invocationId: correctionWaiting.invocationId,
          requestDigest: correctionProviderReservation.request.requestDigest,
        },
        providerReservation: {
          reservationDigest: correctionProviderReservation.recordDigest,
          authorizationNodeId:
            correctionProviderReservation.authorizationNodeId,
          reservationNodeId: correctionProviderReservation.reservationNodeId,
        },
      });

      fs.writeFileSync(implementationPath, 'export const corrected = true;\n');
      const correctionPatch = diffAgainstTree(
        repository,
        failure.candidateTree,
        ['src/feature.ts'],
      );
      fs.writeFileSync(implementationPath, 'export const feature = true;\n');
      completeProvider(
        repository,
        correctionWaiting.invocationId,
        correctionWaiting.assignment.providerId,
        taskImplementationOutput(
          session.sessionId,
          failure.candidateTree,
          correctionPatch,
        ),
      );

      assert.throws(
        () =>
          beginTaskStrategyImplementation(repository, session.sessionId, {
            testCrashAfter: 'provider-result-persisted',
          }),
        /provider result persistence/,
      );
      const interruptedRound = readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        1,
      );
      assert.equal(
        interruptedRound?.reservation.reservationDigest,
        reservedRound.reservation.reservationDigest,
      );
      assert.equal(interruptedRound?.result, null);
      assert.equal(interruptedRound?.importRecord, null);

      if (crashCut !== null) {
        assert.throws(
          () =>
            beginTaskStrategyImplementation(repository, session.sessionId, {
              testCrashAfter: crashCut,
            }),
          /Simulated task implementation interruption|Simulated task strategy patch interruption/,
        );
      }
      const imported = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.equal(imported.state, 'patch-imported');
      assert.equal(
        imported.subject.subjectDigest,
        correctionWaiting.subject.subjectDigest,
      );
      assert.equal(
        fs.readFileSync(implementationPath, 'utf8'),
        'export const corrected = true;\n',
      );
      assert.equal(
        inspectTaskStrategyImplementation(repository, session.sessionId).state,
        'patch-imported',
      );
      assert.equal(
        inspectTaskStrategyLifecycle(repository, session.sessionId).state,
        'patch-imported',
      );
      assert.equal(
        resumeTaskStrategy(repository, session.sessionId).state,
        'patch-imported',
      );
      const completedRound = readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        1,
      );
      assert.notEqual(completedRound, null);
      if (completedRound === null) return;
      assert.notEqual(completedRound.result, null);
      assert.notEqual(completedRound.importRecord, null);
      if (
        completedRound.result === null ||
        completedRound.importRecord === null
      ) {
        return;
      }
      const correctionResultBinding =
        readTaskStrategyImplementationResultBinding(
          runtime,
          session.sessionId,
          correctionWaiting.subject.subjectDigest,
        );
      assert.notEqual(correctionResultBinding, null);
      if (correctionResultBinding === null) return;
      assert.deepEqual(completedRound.result.authority, {
        kind: 'provider',
        providerRequest: reservedRound.reservation.authority.providerRequest,
        providerReservation:
          reservedRound.reservation.authority.providerReservation,
        providerAttempt: {
          attempt: 1,
          attemptReservationDigest: correctionProviderReservation.recordDigest,
          invocationId: correctionWaiting.invocationId,
          requestDigest: correctionProviderReservation.request.requestDigest,
        },
        providerResult: {
          bindingDigest: correctionResultBinding.bindingDigest,
          invocationId: correctionResultBinding.invocationId,
          requestDigest: correctionResultBinding.requestDigest,
          outputDigest: correctionResultBinding.outputDigest,
          providerResultNodeId: correctionResultBinding.providerResultNodeId,
          providerResultDigest: correctionResultBinding.providerResultDigest,
        },
      });
      assert.deepEqual(
        completedRound.importRecord.authority,
        completedRound.result.authority,
      );
      assert.equal(
        completedRound.result.patchResult.sourceTree,
        failure.candidateTree,
      );
      assert.equal(
        completedRound.importRecord.currentPatchHead.recordDigest,
        completedRound.result.patchResult.patchRecordDigest,
      );
      const completedDigests = {
        reservation: completedRound.reservation.reservationDigest,
        result: completedRound.result.resultDigest,
        import: completedRound.importRecord.importDigest,
      };

      assert.equal(
        beginTaskStrategyImplementation(repository, session.sessionId).state,
        'patch-imported',
      );
      const replayedRound = readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        1,
      );
      assert.deepEqual(
        {
          reservation: replayedRound?.reservation.reservationDigest,
          result: replayedRound?.result?.resultDigest,
          import: replayedRound?.importRecord?.importDigest,
        },
        completedDigests,
      );
      if (crashCut === null) {
        const subjectDirectory = path.join(
          runtime.refs,
          'task-strategy-implementations',
          session.sessionId,
          'subjects',
          correctionWaiting.subject.subjectDigest,
        );
        for (const artifactPath of [
          path.join(subjectDirectory, 'reservation.json'),
          path.join(subjectDirectory, 'result.json'),
          evidenceObjectPath(
            runtime.objects,
            correctionProviderReservation.authorizationNodeId,
          ),
          evidenceObjectPath(
            runtime.objects,
            correctionResultBinding.providerResultNodeId,
          ),
        ]) {
          assertProjectionRejectsMissingAuthorityArtifact(
            repository,
            session.sessionId,
            artifactPath,
          );
        }
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function createCorrectionFixture(): string {
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
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = ['src/**', 'test/**'];
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository, 'demo-change', {
    executionTask({ policy }) {
      return {
        strategy: 'cross-agent-tdd' as const,
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
        greenChecks: ['green-fail', 'red'],
        requiredImplementerIndependence: 'provider-independent' as const,
      };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  return repository;
}

function diffAgainstTree(
  repository: string,
  tree: string,
  paths: readonly string[],
): Buffer {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-correction-provider-patch-'),
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

function taskImplementationOutput(
  sessionId: string,
  sourceTree: string,
  patch: Buffer,
) {
  return {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-output.v1' as const,
    sessionId,
    sourceTree,
    patchBase64: patch.toString('base64'),
    patchDigest: sha256(patch),
  };
}

function completeProvider(
  repository: string,
  invocationId: string,
  providerId: 'codex' | 'claude',
  output: ReturnType<typeof taskImplementationOutput>,
): void {
  const completed = runProviderWorker(repository, invocationId, {
    runner(input) {
      const runtimeDirectory = path.join(input.invocationDirectory, 'runtime');
      fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
      for (const [name, content] of [
        ['prompt.json', canonicalJson({ kind: 'fixture-provider-prompt' })],
        ['schema.json', canonicalJson(input.semanticOutputSchema)],
        ['semantic-output.json', canonicalJson(output)],
      ] as const) {
        fs.writeFileSync(path.join(runtimeDirectory, name), content, {
          flag: 'wx',
          mode: 0o600,
        });
      }
      return {
        invocationId,
        providerId,
        purpose: 'task-implementation',
        requestDigest: input.request.requestDigest,
        semanticOutput: output,
        semanticOutputDigest: sha256(Buffer.from(canonicalJson(output))),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: '7'.repeat(64),
          afterDigest: '7'.repeat(64),
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: builtInProviderExecutableIdentityForTest(input.providerId),
        elapsedMs: 8,
        providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
          input.providerId,
        ),
      };
    },
  });
  assert.equal(completed.state, 'succeeded');
}

function executableIdentity() {
  return {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/bin/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isWorkflowError(error, code);
}

function evidenceObjectPath(objects: string, nodeId: string): string {
  return path.join(objects, nodeId.slice(0, 2), `${nodeId}.json`);
}

function assertProjectionRejectsMissingAuthorityArtifact(
  repository: string,
  sessionId: string,
  artifactPath: string,
): void {
  const heldPath = `${artifactPath}.authority-replay-test`;
  fs.renameSync(artifactPath, heldPath);
  try {
    assert.throws(
      () =>
        resolveCurrentTaskStrategyCorrection(
          inspectSession(repository, sessionId),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
  } finally {
    fs.renameSync(heldPath, artifactPath);
  }
}

function assertProjectionRejectsTamperedAuthorityBinding(
  repository: string,
  sessionId: string,
  artifactPath: string,
): void {
  const exact = fs.readFileSync(artifactPath, 'utf8');
  const tampered = JSON.parse(exact) as {
    bindingDigest: string;
    createdAt: string;
    [key: string]: unknown;
  };
  tampered.createdAt = new Date(
    Date.parse(tampered.createdAt) + 1,
  ).toISOString();
  const { bindingDigest: _bindingDigest, ...body } = tampered;
  tampered.bindingDigest = sha256(canonicalJson(body));
  fs.writeFileSync(artifactPath, canonicalJson(tampered));
  try {
    assert.throws(
      () =>
        resolveCurrentTaskStrategyCorrection(
          inspectSession(repository, sessionId),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
  } finally {
    fs.writeFileSync(artifactPath, exact);
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
