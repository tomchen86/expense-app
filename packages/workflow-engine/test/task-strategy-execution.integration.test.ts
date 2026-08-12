import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { dispatchPreparedTaskStrategyProvider } from '../src/cli.ts';
import {
  issueCollaborationGrant,
  type CollaborationGrantRequest,
} from '../src/collaboration-grant.ts';
import { inspectCollaborationGrants } from '../src/collaboration-grant-store.ts';
import { runGitWithEnvironment } from '../src/git.ts';
import { finalizeTask } from '../src/lifecycle.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import { startSession } from '../src/session.ts';
import { beginTaskDiffReview } from '../src/task-diff-review-lifecycle.ts';
import {
  adoptCurrentTaskStrategyImplementation,
  importTaskStrategyPatch,
  inspectTaskStrategyPatchState,
  validateTaskStrategyPatch,
} from '../src/task-strategy-patch.ts';
import { readTaskStrategyPatchCurrentBinding } from '../src/task-strategy-patch-store.ts';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/task-strategy-execution.ts';
import {
  beginTaskStrategyImplementation,
  inspectTaskStrategyImplementation,
} from '../src/task-strategy-implementation-lifecycle.ts';
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA } from '../src/task-strategy-provider-contract.ts';
import { checkSession } from '../src/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
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
    { codex: true, claude: true },
    true,
  );
  try {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
      path.join(repository, 'workflow/path-roles.json'),
    );
    git(repository, ['add', 'workflow/path-roles.json']);
    git(repository, ['commit', '-m', 'Configure fixture path roles']);
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

    assert.throws(
      () =>
        finalizeTask(
          repository,
          session.sessionId,
          { AGENT: 'codex' },
          {
            testCrashAfter: 'checked',
          },
        ),
      /Simulated finalize interruption/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
    const review = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'claude',
      environment: {},
    });
    assert.equal(review.state, 'waiting-for-provider');
    if (review.state !== 'waiting-for-provider') return;
    assert.equal(review.implementationActor.providerId, 'codex');
    assert.equal(review.assignment.providerId, 'claude');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('cross-agent RED schedules one provider-independent implementation reservation before launch', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });

    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    assert.equal(waiting.assignment.role, 'task-implementer');
    assert.equal(waiting.assignment.providerId, 'claude');
    assert.equal(waiting.subject.transactionDigest, red.recordDigest);
    assert.equal(waiting.subject.sourceTree, red.red.candidateTree);
    assert.deepEqual(
      beginTaskStrategyImplementation(repository, session.sessionId),
      waiting,
    );
    const beforeInspection = snapshotTree(runtimeRoot(repository));
    assert.deepEqual(
      inspectTaskStrategyImplementation(repository, session.sessionId),
      waiting,
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), beforeInspection);

    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const output = {
      schemaVersion: 1 as const,
      kind: 'task-strategy-patch-output.v1' as const,
      sessionId: session.sessionId,
      sourceTree: red.red.candidateTree,
      patchBase64: patch.toString('base64'),
      patchDigest: sha256Buffer(patch),
    };
    const completed = runProviderWorker(repository, waiting.invocationId, {
      runner(input) {
        assert.equal(
          sha256Buffer(Buffer.from(canonicalJson(input.semanticOutputSchema))),
          TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.digest,
        );
        assert.equal(input.request.writeAllowedPaths.length, 0);
        return {
          invocationId: waiting.invocationId,
          providerId: 'claude',
          purpose: 'task-implementation',
          requestDigest: input.request.requestDigest,
          semanticOutput: output,
          semanticOutputDigest: sha256Buffer(
            Buffer.from(canonicalJson(output)),
          ),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '9'.repeat(64),
            afterDigest: '9'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
        };
      },
    });
    assert.equal(completed.state, 'succeeded');
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'provider-succeeded-awaiting-import',
    );
    assert.equal(fs.existsSync(implementationPath), false);

    const imported = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(imported.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    const afterImport = snapshotTree(runtimeRoot(repository));
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'patch-imported',
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), afterImport);

    const resultPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-implementations',
      session.sessionId,
      'result.json',
    );
    const resultBinding = JSON.parse(
      fs.readFileSync(resultPath, 'utf8'),
    ) as Record<string, unknown> & {
      roleResult: Record<string, unknown>;
    };
    resultBinding.roleResult.form = 'granted-same-provider';
    const { resultDigest: _oldResultDigest, ...roleResultBody } =
      resultBinding.roleResult;
    resultBinding.roleResult.resultDigest = createHash('sha256')
      .update(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...roleResultBody,
        }),
      )
      .digest('hex');
    const { bindingDigest: _oldBindingDigest, ...bindingBody } = resultBinding;
    resultBinding.bindingDigest = createHash('sha256')
      .update(canonicalJson(bindingBody))
      .digest('hex');
    fs.writeFileSync(resultPath, `${canonicalJson(resultBinding)}\n`);
    assert.throws(
      () => inspectTaskStrategyImplementation(repository, session.sessionId),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routine status and resume drive one durable cross-agent TDD transaction to engine GREEN', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );

    const beforeStatus = snapshotTree(runtimeRoot(repository));
    const authored = runWorkflowCli(
      repository,
      ['status', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(authored.status, 0, authored.stderr);
    const authoredOutput = JSON.parse(authored.stdout) as {
      taskStrategy: { state: string; strategy: string };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(authoredOutput.taskStrategy.state, 'red-authoring');
    assert.equal(authoredOutput.taskStrategy.strategy, 'cross-agent-tdd');
    assert.equal(
      authoredOutput.nextSteps[0]?.command,
      `pnpm workflow resume ${session.sessionId} --json`,
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), beforeStatus);

    const first = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(first.status, 0, first.stderr);
    const firstOutput = JSON.parse(first.stdout) as {
      result: {
        state: 'waiting-for-provider';
        invocationId: string;
        transactionDigest: string;
      };
    };
    assert.equal(firstOutput.result.state, 'waiting-for-provider');
    assert.match(firstOutput.result.transactionDigest, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    let dispatchedInvocationId: string | null = null;
    const dispatched = dispatchPreparedTaskStrategyProvider(
      repository,
      firstOutput.result,
      (_cwd, invocationId) => {
        dispatchedInvocationId = invocationId;
        return {
          schemaVersion: 1,
          kind: 'provider-worker-dispatch',
          invocationId,
          pid: 12345,
        };
      },
    );
    assert.equal(dispatched?.invocationId, firstOutput.result.invocationId);
    assert.equal(dispatchedInvocationId, firstOutput.result.invocationId);

    const replay = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(replay.status, 0, replay.stderr);
    const replayOutput = JSON.parse(replay.stdout) as {
      result: {
        state: string;
        invocationId: string;
        transactionDigest: string;
      };
    };
    assert.deepEqual(replayOutput.result, firstOutput.result);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const beforeWaitingStatus = snapshotTree(runtimeRoot(repository));
    const waitingStatus = runWorkflowCli(
      repository,
      ['status', session.sessionId, '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(waitingStatus.status, 0, waitingStatus.stderr);
    const waitingOutput = JSON.parse(waitingStatus.stdout) as {
      taskStrategy: { state: string; invocationId: string };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(waitingOutput.taskStrategy.state, 'waiting-for-provider');
    assert.equal(
      waitingOutput.taskStrategy.invocationId,
      firstOutput.result.invocationId,
    );
    assert.equal(
      waitingOutput.nextSteps[0]?.command,
      `pnpm workflow status ${session.sessionId} --json`,
    );
    assert.deepEqual(
      snapshotTree(runtimeRoot(repository)),
      beforeWaitingStatus,
    );

    const red = inspectTaskStrategyTransaction(repository, session.sessionId)!;
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    completeTaskImplementationProvider(
      repository,
      firstOutput.result.invocationId,
      'claude',
      taskImplementationOutput(session.sessionId, red.red.candidateTree, patch),
    );
    assert.equal(
      dispatchPreparedTaskStrategyProvider(
        repository,
        firstOutput.result,
        () => {
          throw new Error('terminal provider work must not be redispatched');
        },
      ),
      null,
    );

    const imported = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(imported.status, 0, imported.stderr);
    const importedOutput = JSON.parse(imported.stdout) as {
      result: { state: string; invocationId: string };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(importedOutput.result.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    assert.equal(
      importedOutput.nextSteps[0]?.command,
      `pnpm workflow check ${session.sessionId} --json`,
    );

    const checked = runWorkflowCli(
      repository,
      ['check', session.sessionId, '--json'],
      { AGENT: 'codex' },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(
      (JSON.parse(checked.stdout) as { result: { passed: boolean } }).result
        .passed,
      true,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routine resume adopts exact single-agent implementation bytes without provider ceremony', () => {
  const { repository, counterPath } = createCrossAgentFixture(
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

    const sealed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(sealed.status, 0, sealed.stderr);
    const sealedOutput = JSON.parse(sealed.stdout) as {
      result: { state: string; invocationId: null };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(sealedOutput.result.state, 'implementation-required');
    assert.equal(sealedOutput.result.invocationId, null);
    assert.equal(
      sealedOutput.nextSteps[0]?.command,
      `pnpm workflow resume ${session.sessionId} --json`,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    const implementationBytes = 'export const feature = true;\n';
    fs.writeFileSync(implementationPath, implementationBytes);
    const beforeResume = fs.readFileSync(implementationPath);

    const adopted = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(adopted.status, 0, adopted.stderr);
    const adoptedOutput = JSON.parse(adopted.stdout) as {
      result: { state: string; invocationId: null };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(adoptedOutput.result.state, 'patch-imported');
    assert.equal(adoptedOutput.result.invocationId, null);
    assert.deepEqual(fs.readFileSync(implementationPath), beforeResume);
    assert.equal(
      adoptedOutput.nextSteps[0]?.command,
      `pnpm workflow check ${session.sessionId} --json`,
    );

    const replay = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(adopted.stdout));
    assert.deepEqual(fs.readFileSync(implementationPath), beforeResume);

    const checked = runWorkflowCli(
      repository,
      ['check', session.sessionId, '--json'],
      { AGENT: 'claude' },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(
      (JSON.parse(checked.stdout) as { result: { passed: boolean } }).result
        .passed,
      true,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent resume refuses frozen RED drift before minting a patch receipt', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    const originalTest =
      "throw new Error('feature behavior is not implemented');\n";
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, originalTest);
    const sealed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(sealed.status, 0, sealed.stderr);

    fs.writeFileSync(testPath, "throw new Error('weakened');\n");
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    const refused = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /TASK_STRATEGY_PATCH_FROZEN_PATH/);
    assert.equal(
      readTaskStrategyPatchCurrentBinding(
        loadInvestigationRuntimeContext(repository).runtime,
        session.sessionId,
      ),
      null,
    );
    assert.equal(
      fs.readFileSync(testPath, 'utf8'),
      "throw new Error('weakened');\n",
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent local adoption replays every durable publication cut without rewriting bytes', () => {
  for (const phase of [
    'reservation-persisted',
    'record-persisted',
    'receipt-persisted',
  ] as const) {
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
      sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });
      const implementationPath = path.join(repository, 'src/feature.ts');
      fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
      const implementationBytes = Buffer.from('export const feature = true;\n');
      fs.writeFileSync(implementationPath, implementationBytes);

      assert.throws(
        () =>
          adoptCurrentTaskStrategyImplementation(
            repository,
            session.sessionId,
            { testCrashAfter: phase },
          ),
        new RegExp(phase),
      );
      assert.deepEqual(
        fs.readFileSync(implementationPath),
        implementationBytes,
      );

      const replayed = adoptCurrentTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.ok(replayed);
      assert.deepEqual(
        fs.readFileSync(implementationPath),
        implementationBytes,
      );
      assert.equal(
        readTaskStrategyPatchCurrentBinding(
          loadInvestigationRuntimeContext(repository).runtime,
          session.sessionId,
        )?.candidateTree,
        replayed.record.candidateTree,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('single-agent reservation replay never resurrects implementation bytes reverted by the caller', () => {
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
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    assert.throws(
      () =>
        adoptCurrentTaskStrategyImplementation(repository, session.sessionId, {
          testCrashAfter: 'record-persisted',
        }),
      /record-persisted/,
    );
    fs.rmSync(implementationPath);

    assert.equal(
      adoptCurrentTaskStrategyImplementation(repository, session.sessionId),
      null,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      readTaskStrategyPatchCurrentBinding(
        loadInvestigationRuntimeContext(repository).runtime,
        session.sessionId,
      ),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routine strategy resume leaves ordinary tasks outside Mode A ceremony', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const before = snapshotTree(runtimeRoot(repository));

    const resumed = runWorkflowCli(repository, [
      'resume',
      session.sessionId,
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const output = JSON.parse(resumed.stdout) as {
      result: { state: string; transactionDigest: null };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(output.result.state, 'not-required');
    assert.equal(output.result.transactionDigest, null);
    assert.equal(
      output.nextSteps[0]?.command,
      `pnpm workflow check ${session.sessionId} --json`,
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routine strategy resume exposes the existing collaboration-grant pause without partial provider state', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
  );
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const paused = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(paused.status, 0, paused.stderr);
    const output = JSON.parse(paused.stdout) as {
      result: {
        state: string;
        invocationId: null;
        inputSchema: {
          kind: string;
          allowedDegradedForms: string[];
          resumeOption: string;
        };
      };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(output.result.state, 'collaboration-grant-required');
    assert.equal(output.result.invocationId, null);
    assert.equal(
      output.result.inputSchema.kind,
      'collaboration-grant-selection',
    );
    assert.deepEqual(output.result.inputSchema.allowedDegradedForms, [
      'same-provider-fresh-session',
    ]);
    assert.equal(output.result.inputSchema.resumeOption, '--grant <grant-id>');
    assert.deepEqual(
      output.nextSteps.map(({ command }) => command),
      [
        `pnpm workflow status ${session.sessionId} --json`,
        'pnpm workflow guide --json',
      ],
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'ready',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('cross-agent implementation shortage pauses on the existing typed collaboration grant boundary', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
  );
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

    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    assert.equal(
      paused.inputSchema.grantRequest?.degradedForm,
      'same-provider-fresh-session',
    );
    assert.deepEqual(paused.inputSchema.allowedDegradedForms, [
      'same-provider-fresh-session',
    ]);
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(repository),
          'investigations/refs/task-strategy-implementations',
          session.sessionId,
          'reservation.json',
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker rejects a task implementation whose sealed RED owner has drifted', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;

    fs.writeFileSync(
      testPath,
      "throw new Error('changed after reservation');\n",
    );
    assert.throws(
      () =>
        runProviderWorker(repository, waiting.invocationId, {
          runner() {
            assert.fail('stale task implementation must not launch');
          },
        }),
      hasCode('TASK_STRATEGY_RED_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task implementation reservation rejects independently redigested replay metadata', () => {
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
    beginTaskStrategyImplementation(repository, session.sessionId);
    const reservationPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-implementations',
      session.sessionId,
      'reservation.json',
    );
    const reservation = JSON.parse(
      fs.readFileSync(reservationPath, 'utf8'),
    ) as Record<string, unknown>;
    reservation.createdAt = new Date(
      Date.parse(String(reservation.createdAt)) + 1_000,
    ).toISOString();
    const { recordDigest: _oldDigest, ...body } = reservation;
    reservation.recordDigest = createHash('sha256')
      .update(canonicalJson(body))
      .digest('hex');
    fs.writeFileSync(reservationPath, `${canonicalJson(reservation)}\n`);

    assert.throws(
      () => inspectTaskStrategyImplementation(repository, session.sessionId),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('zero callable implementers expose only caller-supplied collaboration recovery', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
  );
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

    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    assert.equal(paused.inputSchema.grantRequest, null);
    assert.deepEqual(paused.inputSchema.allowedDegradedForms, [
      'caller-supplied',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('zero-provider caller patch imports only through an exact consumed collaboration grant', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const callerId = 'external-implementation-caller';
    const request: CollaborationGrantRequest = {
      changeId: 'demo-change',
      taskId: '1.1',
      baselineCommit: session.baseline.head,
      baselineTree: session.baseline.tree,
      targetDigest: paused.subject.subjectDigest,
      lifecyclePhase: 'task-implementation',
      rolePair: {
        authorRole: 'red-author',
        conflictingRole: 'task-implementer',
      },
      availableActor: {
        kind: 'caller',
        callerId,
        assurance: 'self-declared',
      },
      degradedForm: 'caller-supplied',
      reason:
        'No callable task implementation provider is enabled for this exact sealed RED subject.',
      ttlMinutes: 30,
      maxUses: 1,
    };
    const issued = issueCollaborationGrant(repository, request, { signer });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    const imported = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      {
        collaborationGrant: {
          grantId: issued.grantId,
          verifier: signer,
          callerSupplied: {
            callerId,
            assurance: 'self-declared',
            patch,
          },
        },
      },
    );
    assert.equal(imported.state, 'patch-imported');
    const patchState = inspectTaskStrategyPatchState(
      repository,
      session.sessionId,
      sha256Buffer(patch),
    );
    assert.equal(patchState.record.implementer.providerId, null);
    assert.equal(patchState.record.implementer.principalId, callerId);
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    const callerResultPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-implementations',
      session.sessionId,
      'caller-result.json',
    );
    const heldCallerResultPath = `${callerResultPath}.held`;
    fs.renameSync(callerResultPath, heldCallerResultPath);
    assert.throws(
      () => checkSession(repository, session.sessionId, { environment: {} }),
      hasCode('TASK_STRATEGY_PATCH_STALE'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    fs.renameSync(heldCallerResultPath, callerResultPath);
    assert.equal(
      checkSession(repository, session.sessionId, { environment: {} }).passed,
      true,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('zero-provider caller patch validates frozen RED bytes before reserving its grant', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
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
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const callerId = 'external-implementation-caller';
    const issued = issueCollaborationGrant(
      repository,
      callerImplementationGrantRequest(
        session,
        paused.subject.subjectDigest,
        callerId,
      ),
      { signer },
    );
    fs.writeFileSync(testPath, "throw new Error('weakened RED');\n");
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'test/feature.test.mjs',
    ]);
    fs.writeFileSync(testPath, originalTest);

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, session.sessionId, {
          collaborationGrant: {
            grantId: issued.grantId,
            verifier: signer,
            callerSupplied: {
              callerId,
              assurance: 'self-declared',
              patch,
            },
          },
        }),
      hasCode('TASK_STRATEGY_PATCH_FROZEN_PATH'),
    );
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'available',
    );
    assert.equal(fs.readFileSync(testPath, 'utf8'), originalTest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable consumed caller grant resumes the exact patch after interruption', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const callerId = 'external-implementation-caller';
    const issued = issueCollaborationGrant(
      repository,
      callerImplementationGrantRequest(
        session,
        paused.subject.subjectDigest,
        callerId,
      ),
      { signer },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const exactInput = {
      collaborationGrant: {
        grantId: issued.grantId,
        verifier: signer,
        callerSupplied: {
          callerId,
          assurance: 'self-declared' as const,
          patch,
        },
      },
    };

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, session.sessionId, {
          ...exactInput,
          testCrashAfter: 'provider-result-persisted',
        }),
      /caller result persistence/,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'caller-supplied-awaiting-import',
    );

    const resumed = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      exactInput,
    );
    assert.equal(resumed.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('same-provider shortage resumes only through the existing signed collaboration grant', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
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
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const request = paused.inputSchema
      .grantRequest as CollaborationGrantRequest;
    const issued = issueCollaborationGrant(repository, request, { signer });

    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      { collaborationGrant: { grantId: issued.grantId, verifier: signer } },
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    assert.equal(waiting.assignment.providerId, 'codex');
    assert.equal(
      waiting.assignment.achievedIndependence,
      'session-independent',
    );
    assert.equal('grantId' in waiting.assignment, true);

    const red = inspectTaskStrategyTransaction(repository, session.sessionId)!;
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const output = {
      schemaVersion: 1 as const,
      kind: 'task-strategy-patch-output.v1' as const,
      sessionId: session.sessionId,
      sourceTree: red.red.candidateTree,
      patchBase64: patch.toString('base64'),
      patchDigest: sha256Buffer(patch),
    };
    const completed = runProviderWorker(repository, waiting.invocationId, {
      runner(input) {
        return {
          invocationId: waiting.invocationId,
          providerId: 'codex',
          purpose: 'task-implementation',
          requestDigest: input.request.requestDigest,
          semanticOutput: output,
          semanticOutputDigest: sha256Buffer(
            Buffer.from(canonicalJson(output)),
          ),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '8'.repeat(64),
            afterDigest: '8'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
        };
      },
    });
    assert.equal(completed.state, 'succeeded');

    const imported = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      { collaborationGrant: { grantId: issued.grantId, verifier: signer } },
    );
    assert.equal(imported.state, 'patch-imported');
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
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

test('grant-backed implementation validates frozen tests before consuming the grant', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
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
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const issued = issueCollaborationGrant(
      repository,
      paused.inputSchema.grantRequest as CollaborationGrantRequest,
      { signer },
    );
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      { collaborationGrant: { grantId: issued.grantId, verifier: signer } },
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;

    fs.writeFileSync(testPath, "throw new Error('weakened');\n");
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'test/feature.test.mjs',
    ]);
    fs.writeFileSync(testPath, originalTest);
    const output = taskImplementationOutput(
      session.sessionId,
      red.red.candidateTree,
      patch,
    );
    completeTaskImplementationProvider(
      repository,
      waiting.invocationId,
      'codex',
      output,
    );

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, session.sessionId, {
          collaborationGrant: {
            grantId: issued.grantId,
            verifier: signer,
          },
        }),
      hasCode('TASK_STRATEGY_PATCH_FROZEN_PATH'),
    );
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'reserved',
    );
    assert.equal(fs.readFileSync(testPath, 'utf8'), originalTest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable consumed implementation grant resumes exact patch import after interruption', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const issued = issueCollaborationGrant(
      repository,
      paused.inputSchema.grantRequest as CollaborationGrantRequest,
      { signer },
    );
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      { collaborationGrant: { grantId: issued.grantId, verifier: signer } },
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    completeTaskImplementationProvider(
      repository,
      waiting.invocationId,
      'codex',
      taskImplementationOutput(session.sessionId, red.red.candidateTree, patch),
    );

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, session.sessionId, {
          collaborationGrant: {
            grantId: issued.grantId,
            verifier: signer,
          },
          testCrashAfter: 'provider-result-persisted',
        }),
      /provider result persistence/,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'provider-succeeded-awaiting-import',
    );

    const resumed = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(resumed.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
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

test('single-agent patch validation rejects an actor other than the sealed RED author', () => {
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

    assert.throws(
      () =>
        validateTaskStrategyPatch(repository, session.sessionId, {
          patch,
          explicitActor: 'claude',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_IMPLEMENTER_REQUIRED'),
    );
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
  providers: Readonly<{ codex: boolean; claude: boolean }> = {
    codex: true,
    claude: true,
  },
  includeMaintainerPolicy = false,
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
  if (includeMaintainerPolicy) {
    const maintainerPolicyPath = path.join(
      repository,
      'workflow/maintainer-policy.json',
    );
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      maintainerPolicyPath,
    );
    const maintainerPolicy = JSON.parse(
      fs.readFileSync(maintainerPolicyPath, 'utf8'),
    ) as { repository: { origin: string } };
    git(repository, [
      'config',
      'remote.origin.url',
      maintainerPolicy.repository.origin,
    ]);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Configure fixture maintainer policy']);
  }
  if (!providers.codex || !providers.claude) {
    const providerPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const providerPolicy = JSON.parse(
      fs.readFileSync(providerPolicyPath, 'utf8'),
    ) as {
      providers: Record<'codex' | 'claude', { enabled: boolean }>;
    };
    providerPolicy.providers.codex.enabled = providers.codex;
    providerPolicy.providers.claude.enabled = providers.claude;
    fs.writeFileSync(
      providerPolicyPath,
      `${JSON.stringify(providerPolicy, null, 2)}\n`,
    );
    git(repository, ['add', 'workflow/ai-adapter-policy.json']);
    git(repository, [
      'commit',
      '-m',
      'Configure fixture provider availability',
    ]);
  }
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
    patchDigest: sha256Buffer(patch),
  };
}

function completeTaskImplementationProvider(
  repository: string,
  invocationId: string,
  providerId: 'codex' | 'claude',
  output: ReturnType<typeof taskImplementationOutput>,
) {
  return runProviderWorker(repository, invocationId, {
    runner(input) {
      return {
        invocationId,
        providerId,
        purpose: 'task-implementation',
        requestDigest: input.request.requestDigest,
        semanticOutput: output,
        semanticOutputDigest: sha256Buffer(Buffer.from(canonicalJson(output))),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: '7'.repeat(64),
          afterDigest: '7'.repeat(64),
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: executableIdentity(),
        elapsedMs: 8,
      };
    },
  });
}

function runWorkflowCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
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

function collaborationSigner(identity: string): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return identity;
    },
    sign(payload, namespace) {
      assert.ok(namespace);
      return collaborationSignature(payload, namespace);
    },
    verify(payload, signature, observedIdentity, namespace) {
      assert.ok(namespace);
      if (
        observedIdentity !== identity ||
        signature !== collaborationSignature(payload, namespace)
      ) {
        const error = new Error('invalid collaboration signature') as Error & {
          code: string;
        };
        error.code = 'MAINTAINER_SIGNATURE_INVALID';
        throw error;
      }
    },
  };
}

function callerImplementationGrantRequest(
  session: Readonly<{ baseline: Readonly<{ head: string; tree: string }> }>,
  subjectDigest: string,
  callerId: string,
): CollaborationGrantRequest {
  return {
    changeId: 'demo-change',
    taskId: '1.1',
    baselineCommit: session.baseline.head,
    baselineTree: session.baseline.tree,
    targetDigest: subjectDigest,
    lifecyclePhase: 'task-implementation',
    rolePair: {
      authorRole: 'red-author',
      conflictingRole: 'task-implementer',
    },
    availableActor: {
      kind: 'caller',
      callerId,
      assurance: 'self-declared',
    },
    degradedForm: 'caller-supplied',
    reason:
      'No callable task implementation provider is enabled for this exact sealed RED subject.',
    ttlMinutes: 30,
    maxUses: 1,
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

function snapshotTree(root: string): Array<{
  path: string;
  kind: 'directory' | 'file';
  ino: number;
  mode: number;
  mtimeMs: number;
  content: string | null;
}> {
  const entries: Array<{
    path: string;
    kind: 'directory' | 'file';
    ino: number;
    mode: number;
    mtimeMs: number;
    content: string | null;
  }> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute);
      if (stats.isDirectory()) {
        entries.push({
          path: relative,
          kind: 'directory',
          ino: stats.ino,
          mode: stats.mode,
          mtimeMs: stats.mtimeMs,
          content: null,
        });
        visit(absolute);
      } else if (stats.isFile()) {
        entries.push({
          path: relative,
          kind: 'file',
          ino: stats.ino,
          mode: stats.mode,
          mtimeMs: stats.mtimeMs,
          content: fs.readFileSync(absolute, 'utf8'),
        });
      }
    }
  };
  visit(root);
  return entries;
}
