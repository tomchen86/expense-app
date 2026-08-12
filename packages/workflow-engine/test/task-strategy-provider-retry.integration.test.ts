import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { issueCollaborationGrant } from '../src/collaboration-grant.ts';
import { ExitCode, workflowError } from '../src/errors.ts';
import { readExecutionJobState } from '../src/execution-store.ts';
import { runGitWithEnvironment } from '../src/git.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  readProviderRetryReservation,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import { startSession } from '../src/session.ts';
import {
  assertTaskStrategyImplementationProviderOwnerCurrent,
  beginTaskStrategyImplementation,
  inspectTaskStrategyImplementation,
  type TaskStrategyImplementationStatus,
} from '../src/task-strategy-implementation-lifecycle.ts';
import {
  inspectTaskStrategyLifecycle,
  resumeTaskStrategy,
} from '../src/task-strategy-lifecycle.ts';
import { sealTaskStrategyRed } from '../src/task-strategy-execution.ts';
import {
  readCurrentTaskStrategyGreenFailure,
  resolveCurrentTaskStrategyCorrection,
} from '../src/task-strategy-correction.ts';
import { readTaskStrategyCorrectionRound } from '../src/task-strategy-correction-round-store.ts';
import { checkSession, inspectSession } from '../src/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  syncOriginMain,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('routine resume replaces a failed implementation transport without changing its semantic subject', () => {
  const repository = createRetryFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const initial = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(initial.state, 'waiting-for-provider');
    if (initial.state !== 'waiting-for-provider') return;

    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const initialManifest = readProviderInvocationManifest(
      runtime,
      initial.invocationId,
    );
    const initialRequest = readProviderInvocationRequest(
      runtime,
      initial.invocationId,
    );
    failProviderTransport(repository, initial.invocationId);
    assert.equal(
      inspectTaskStrategyLifecycle(repository, session.sessionId).state,
      'provider-failed',
    );

    const resumed = resumeTaskStrategy(repository, session.sessionId);
    assert.equal(resumed.state, 'waiting-for-provider');
    assert.notEqual(resumed.invocationId, initial.invocationId);
    assert.notEqual(resumed.invocationId, null);
    if (resumed.invocationId === null) return;

    const replacement = readProviderInvocation(runtime, resumed.invocationId);
    const replacementManifest = readProviderInvocationManifest(
      runtime,
      resumed.invocationId,
    );
    const replacementRequest = readProviderInvocationRequest(
      runtime,
      resumed.invocationId,
    );
    assert.equal(replacement.attempt, 2);
    assert.equal(replacement.investigationId, initial.ownerInvestigationId);
    assert.deepEqual(replacementManifest, initialManifest);
    assert.equal(
      replacementRequest.inputManifestDigest,
      initialRequest.inputManifestDigest,
    );
    assert.equal(replacementRequest.targetDigest, initialRequest.targetDigest);
    assert.notEqual(
      replacementRequest.invocationId,
      initialRequest.invocationId,
    );
    assert.notEqual(replacementRequest.nonce, initialRequest.nonce);
    assert.equal(
      readProviderInvocation(runtime, initial.invocationId).state,
      'failed',
    );

    assert.equal(
      resumeTaskStrategy(repository, session.sessionId).invocationId,
      replacement.invocationId,
    );
    assert.throws(
      () =>
        assertTaskStrategyImplementationProviderOwnerCurrent(
          repository,
          initial.invocationId,
        ),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT'),
    );

    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    completeProvider(
      repository,
      replacement.invocationId,
      replacement.providerId,
      taskImplementationOutput(session.sessionId, red.red.candidateTree, patch),
    );
    assert.equal(
      resumeTaskStrategy(repository, session.sessionId).state,
      'patch-imported',
    );
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'patch-imported',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('retry reservation crash replays one exact invocation without duplicating transport attempts', () => {
  const repository = createRetryFixture();
  try {
    const { sessionId } = openFailedImplementation(repository);
    const failedStatus = inspectTaskStrategyImplementation(
      repository,
      sessionId,
    );
    assert.equal(failedStatus.state, 'provider-failed');
    if (failedStatus.state !== 'provider-failed') return;

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, sessionId, {
          retryProviderFailure: true,
          testCrashAfter: 'provider-retry-reservation-persisted',
        }),
      /retry reservation persistence/,
    );
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const retry = readProviderRetryReservation(
      runtime,
      failedStatus.ownerInvestigationId,
      2,
    );
    assert.notEqual(retry, null);
    assert.equal(retry?.schemaVersion, 3);
    if (retry === null) return;
    assert.equal(
      inspectTaskStrategyLifecycle(repository, sessionId).state,
      'reservation-persisted',
    );

    const recovered = resumeTaskStrategy(repository, sessionId);
    assert.equal(recovered.state, 'waiting-for-provider');
    assert.equal(recovered.invocationId, retry.invocationId);
    assert.equal(
      resumeTaskStrategy(repository, sessionId).invocationId,
      retry.invocationId,
    );
    assert.equal(
      readProviderRetryReservation(
        runtime,
        failedStatus.ownerInvestigationId,
        3,
      ),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('retry budget exhaustion and unrelated collaboration grant refuse without reserving work', () => {
  for (const mode of ['budget', 'wrong-grant'] as const) {
    const repository = createRetryFixture({
      maxAttempts: mode === 'budget' ? 1 : 4,
    });
    try {
      const { sessionId, waiting } = openFailedImplementation(repository);
      assert.throws(
        () =>
          resumeTaskStrategy(repository, sessionId, {
            ...(mode === 'wrong-grant'
              ? {
                  collaborationGrant: {
                    grantId: 'grant-not-owned-by-this-task',
                  },
                }
              : {}),
          }),
        hasRetryDenialRecovery(sessionId),
      );
      const runtime = loadInvestigationRuntimeContext(repository).runtime;
      assert.equal(
        readProviderRetryReservation(runtime, waiting.ownerInvestigationId, 2),
        null,
      );
      assert.equal(
        inspectTaskStrategyLifecycle(repository, sessionId).state,
        'provider-failed',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('correction provider transport retry keeps one correction round and binds the winning attempt', () => {
  const repository = createRetryFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const initial = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(initial.state, 'waiting-for-provider');
    if (initial.state !== 'waiting-for-provider') return;
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const initialPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    completeProvider(
      repository,
      initial.invocationId,
      initial.assignment.providerId,
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
    assert.throws(
      () => checkSession(repository, session.sessionId, { environment: {} }),
      hasCode('CHECK_FAILED'),
    );
    const failure = readCurrentTaskStrategyGreenFailure(
      inspectSession(repository, session.sessionId),
    );
    assert.notEqual(failure, null);
    if (failure === null) return;

    const correction = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(correction.state, 'waiting-for-provider');
    if (correction.state !== 'waiting-for-provider') return;
    assert.equal(correction.subject.correction?.round, 1);
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const before = readTaskStrategyCorrectionRound(
      runtime,
      session.sessionId,
      red.recordDigest,
      1,
    );
    assert.notEqual(before, null);
    failProviderTransport(repository, correction.invocationId);

    const retried = resumeTaskStrategy(repository, session.sessionId);
    assert.equal(retried.state, 'waiting-for-provider');
    assert.notEqual(retried.invocationId, correction.invocationId);
    assert.equal(
      readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        1,
      )?.reservation.reservationDigest,
      before?.reservation.reservationDigest,
    );
    assert.equal(
      readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        2,
      ),
      null,
    );
    if (retried.invocationId === null) return;
    fs.writeFileSync(implementationPath, 'export const corrected = true;\n');
    const correctionPatch = diffAgainstTree(repository, failure.candidateTree, [
      'src/feature.ts',
    ]);
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    completeProvider(
      repository,
      retried.invocationId,
      retried.invocationId === null
        ? correction.assignment.providerId
        : readProviderInvocation(runtime, retried.invocationId).providerId,
      taskImplementationOutput(
        session.sessionId,
        failure.candidateTree,
        correctionPatch,
      ),
    );
    assert.equal(
      resumeTaskStrategy(repository, session.sessionId).state,
      'patch-imported',
    );
    assert.equal(
      resolveCurrentTaskStrategyCorrection(
        inspectSession(repository, session.sessionId),
      ).completedCorrectionRounds,
      1,
    );
    const completed = readTaskStrategyCorrectionRound(
      runtime,
      session.sessionId,
      red.recordDigest,
      1,
    );
    assert.equal(completed?.result?.authority.kind, 'provider');
    if (completed?.result?.authority.kind !== 'provider') return;
    assert.equal(completed.result.authority.providerAttempt.attempt, 2);
    assert.equal(
      completed.result.authority.providerAttempt.invocationId,
      retried.invocationId,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repeated failure requires an authenticated strategy change and replays that exact retry mode', () => {
  const repository = createRetryFixture();
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const { sessionId, waiting } = openFailedImplementation(repository);
    const second = resumeTaskStrategy(repository, sessionId);
    assert.equal(second.state, 'waiting-for-provider');
    assert.notEqual(second.invocationId, null);
    if (second.invocationId === null) return;
    failProviderTransport(repository, second.invocationId);

    const paused = resumeTaskStrategy(repository, sessionId);
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const inputSchema = paused.inputSchema as Extract<
      TaskStrategyImplementationStatus,
      { state: 'collaboration-grant-required' }
    >['inputSchema'];
    const request = inputSchema.grantRequest;
    assert.notEqual(request, null);
    if (request === null) return;
    assert.equal(request.degradedForm, 'same-provider-fresh-session');
    assert.equal(request.availableActor.kind, 'provider');
    if (request.availableActor.kind !== 'provider') return;
    assert.equal(request.availableActor.providerId, 'codex');
    const issued = issueCollaborationGrant(repository, request, { signer });

    const third = resumeTaskStrategy(repository, sessionId, {
      collaborationGrant: { grantId: issued.grantId, verifier: signer },
    });
    assert.equal(third.state, 'waiting-for-provider');
    assert.notEqual(third.invocationId, null);
    if (third.invocationId === null) return;
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const retry = readProviderRetryReservation(
      runtime,
      waiting.ownerInvestigationId,
      3,
    );
    assert.equal(retry?.schemaVersion, 3);
    if (retry?.schemaVersion !== 3) return;
    assert.equal(retry.replacement.retryMode, 'strategy-change');
    assert.ok(retry.replacement.strategyChanges.length > 0);
    assert.equal(retry.request.providerId, 'codex');
    assert.notEqual(
      retry.request.roleAssignment.sessionId,
      waiting.assignment.sessionId,
    );
    const job = readExecutionJobState(
      runtime,
      retry.retryDecision.executionJobId,
    );
    assert.equal(job?.attempts.length, 3);
    assert.equal(job?.attempts[2]?.retryMode, 'strategy-change');
    assert.deepEqual(
      job?.attempts[2]?.strategyChanges,
      retry.replacement.strategyChanges,
    );

    const red = sealTaskStrategyRed(repository, sessionId, {
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
    completeProvider(
      repository,
      third.invocationId,
      'codex',
      taskImplementationOutput(sessionId, red.red.candidateTree, patch),
    );
    assert.equal(
      resumeTaskStrategy(repository, sessionId, {
        collaborationGrant: { grantId: issued.grantId, verifier: signer },
      }).state,
      'patch-imported',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createRetryFixture(
  options: Readonly<{ maxAttempts?: number }> = {},
): string {
  const repository = createFixtureRepository();
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  const maintainerPolicy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { repository: { origin: string } };
  git(repository, [
    'config',
    'remote.origin.url',
    maintainerPolicy.repository.origin,
  ]);
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
      "if (!source.includes('corrected = true')) process.exit(1);",
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
  if (options.maxAttempts !== undefined) {
    const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      retryAccounting: {
        maxAttempts: number;
        maxRepairAttempts: number;
        providerLimits: Record<string, number>;
      };
    };
    policy.retryAccounting.maxAttempts = options.maxAttempts;
    policy.retryAccounting.maxRepairAttempts = Math.min(
      policy.retryAccounting.maxRepairAttempts,
      options.maxAttempts,
    );
    for (const providerId of Object.keys(
      policy.retryAccounting.providerLimits,
    )) {
      policy.retryAccounting.providerLimits[providerId] = options.maxAttempts;
    }
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    git(repository, ['add', 'workflow/ai-adapter-policy.json']);
    git(repository, ['commit', '-m', 'Configure retry budget']);
  }
  syncOriginMain(repository);
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

function openFailedImplementation(repository: string) {
  const session = startSession(repository, 'demo-change', '1.1');
  const testPath = path.join(repository, 'test/feature.test.mjs');
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
  sealTaskStrategyRed(repository, session.sessionId, {
    explicitActor: 'codex',
    environment: {},
  });
  const waiting = beginTaskStrategyImplementation(
    repository,
    session.sessionId,
  );
  assert.equal(waiting.state, 'waiting-for-provider');
  if (waiting.state !== 'waiting-for-provider') {
    throw new Error('provider fixture did not reserve implementation work');
  }
  failProviderTransport(repository, waiting.invocationId);
  return { sessionId: session.sessionId, waiting };
}

function failProviderTransport(repository: string, invocationId: string): void {
  const failed = runProviderWorker(repository, invocationId, {
    runner() {
      throw workflowError(
        'PROVIDER_TIMEOUT',
        'The provider transport timed out.',
        ExitCode.verification,
      );
    },
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure?.kind, 'retryable');
}

function diffAgainstTree(
  repository: string,
  tree: string,
  paths: readonly string[],
): Buffer {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-provider-retry-patch-'),
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
        executable: {
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
        },
        elapsedMs: 8,
      };
    },
  });
  assert.equal(completed.state, 'succeeded');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === code;
}

function hasRetryDenialRecovery(
  sessionId: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code ===
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_DENIED' &&
    'recovery' in error &&
    typeof (error as Error & { recovery: unknown }).recovery === 'string' &&
    (error as Error & { recovery: string }).recovery ===
      `pnpm workflow resume ${sessionId} --json`;
}

function collaborationSigner(identity: string): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return identity;
    },
    sign(payload, namespace) {
      return collaborationSignature(payload, namespace ?? '');
    },
    verify(payload, signature, observedIdentity, namespace) {
      if (
        observedIdentity !== identity ||
        signature !== collaborationSignature(payload, namespace ?? '')
      ) {
        throw workflowError(
          'MAINTAINER_SIGNATURE_INVALID',
          'Fixture collaboration signature is invalid.',
          ExitCode.verification,
        );
      }
    },
  };
}

function collaborationSignature(payload: string, namespace: string): string {
  const encoded = createHash('sha256')
    .update(`${namespace}\0${payload}`)
    .digest('base64');
  return [
    '-----BEGIN SSH SIGNATURE-----',
    encoded,
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n');
}
