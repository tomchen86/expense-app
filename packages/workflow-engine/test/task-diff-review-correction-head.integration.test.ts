import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { runGitWithEnvironment } from '../src/runtime/repository-transaction/git.ts';
import { finalizeTask } from '../src/application/finalize/lifecycle.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { readCurrentTaskStrategyGreenFailure } from '../src/application/execute-task/task-strategy-correction.ts';
import { sealTaskStrategyRed } from '../src/application/execute-task/task-strategy-execution.ts';
import { beginTaskStrategyImplementation } from '../src/application/execute-task/task-strategy-implementation-lifecycle.ts';
import { readTaskStrategyImplementationResultBinding } from '../src/runtime/storage-journal/task-strategy-provider-store.ts';
import { beginTaskDiffReview } from '../src/application/finalize/task-diff-review-lifecycle.ts';
import {
  checkSession,
  inspectSession,
  persistSession,
} from '../src/application/finalize/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';

test('TaskDiff review attributes the latest authenticated correction head instead of the initial implementation', () => {
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

    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const initialBinding = readTaskStrategyImplementationResultBinding(
      runtime,
      session.sessionId,
      initialWaiting.subject.subjectDigest,
    );
    assert.notEqual(initialBinding, null);
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
    fs.writeFileSync(implementationPath, 'export const corrected = true;\n');
    const correctionPatch = diffAgainstTree(repository, failure.candidateTree, [
      'src/feature.ts',
    ]);
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
    assert.equal(
      beginTaskStrategyImplementation(repository, session.sessionId).state,
      'patch-imported',
    );
    const correctionBinding = readTaskStrategyImplementationResultBinding(
      runtime,
      session.sessionId,
      correctionWaiting.subject.subjectDigest,
    );
    assert.notEqual(correctionBinding, null);
    if (initialBinding === null || correctionBinding === null) return;
    assert.notEqual(
      correctionBinding.roleResult.participant.sessionId,
      initialBinding.roleResult.participant.sessionId,
    );
    assert.equal(
      checkSession(repository, session.sessionId, { environment: {} }).passed,
      true,
    );
    const checkedInspection = inspectSession(repository, session.sessionId);
    assert.notEqual(checkedInspection.session.latestCheckReportId, undefined);
    const {
      latestCheckReportId: _latestCheckReportId,
      checkEvidenceEngineDigest: _checkEvidenceEngineDigest,
      ...freshSession
    } = checkedInspection.session;
    persistSession(checkedInspection, freshSession);
    assert.throws(
      () =>
        finalizeTask(
          repository,
          session.sessionId,
          {},
          {
            testCrashAfter: 'checked',
          },
        ),
      /Simulated finalize interruption/,
    );

    const review = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(review.state, 'waiting-for-provider');
    if (review.state !== 'waiting-for-provider') return;
    assert.deepEqual(
      review.implementationActor,
      correctionBinding.roleResult.participant,
    );
    assert.notDeepEqual(
      review.implementationActor,
      initialBinding.roleResult.participant,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

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
  const pathRoles = path.join(repository, 'workflow/path-roles.json');
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
    pathRoles,
  );
  const maintainerPolicy = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    maintainerPolicy,
  );
  const maintainerPolicyDocument = JSON.parse(
    fs.readFileSync(maintainerPolicy, 'utf8'),
  ) as { repository: { origin: string } };
  git(repository, [
    'config',
    'remote.origin.url',
    maintainerPolicyDocument.repository.origin,
  ]);
  git(repository, [
    'add',
    'workflow/path-roles.json',
    'workflow/maintainer-policy.json',
  ]);
  git(repository, ['commit', '-m', 'Configure fixture review policies']);
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
    path.join(os.tmpdir(), 'task-diff-review-correction-patch-'),
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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
