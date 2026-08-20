import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadChangeContract } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { createEvidenceNode } from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import { writeEvidenceNode } from '../src/runtime/storage-journal/evidence-object-store.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import type { AgentRuntimePort } from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import type { ProviderInvocationAcceptanceBinding } from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import {
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
  type ProviderWrapperProtocolReceipt,
} from '../src/modules/provider-orchestration/agent-runtime-protocol.ts';
import {
  buildContextManifest,
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
} from '../src/modules/authority/execution-governance.ts';
import {
  executionJobStatePath,
  readExecutionJobState,
} from '../src/runtime/storage-journal/execution-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  createProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocationForWorker,
  completeProviderInvocationFromRunner,
  createProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  providerInvocationManifestDigest,
  releaseProviderInvocationWorkerFence,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  type PlanReviewManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  ensureProviderPromptContext,
  providerPromptContextStoreRoot,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { createAsyncCliDispatcherForTesting } from '../src/cli.ts';
import {
  createProviderWorkerDispatcherForTesting,
  runProviderWorker,
  runProviderWorkerAsync,
} from '../src/entrypoints/worker/provider-worker.ts';
import {
  createFixtureRepository,
  git,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('hidden provider-worker CLI command dispatches the async worker entry', async () => {
  const calls: Array<{ cwd: string; invocationId: string }> = [];
  const dispatch = createAsyncCliDispatcherForTesting(
    async (cwd, invocationId) => {
      calls.push({ cwd, invocationId });
      return {
        schemaVersion: 1,
        kind: 'provider-worker-result',
        invocationId,
        state: 'leased',
        revision: 3,
        launched: false,
        failure: null,
        completionReceipt: null,
      };
    },
  );

  const result = await dispatch(
    ['provider-worker', 'invocation-async-cli'],
    '/repository',
  );
  assert.deepEqual(calls, [
    { cwd: '/repository', invocationId: 'invocation-async-cli' },
  ]);
  assert.equal(result.command, 'provider-worker');
  assert.equal(
    (result.result as { invocationId: string }).invocationId,
    'invocation-async-cli',
  );
});

for (const objectFormat of ['sha1', 'sha256'] as const) {
  test(`async provider worker completes the exact durable invocation through AgentRuntimePort on ${objectFormat}`, async () => {
    const repository = createFixtureRepository({ objectFormat });
    const changeId = `worker-${objectFormat}`;
    try {
      lowerAdapterLimits(repository);
      git(repository, ['add', 'workflow/ai-adapter-policy.json']);
      git(repository, ['commit', '-m', 'Lower provider limits']);
      git(repository, ['checkout', '-b', `work/${changeId}`]);

      const started = startPropose(repository, changeId, intent(), {
        explicitActor: 'codex',
        environment: {},
      });
      const invocationId = started.investigation!.providerInvocationId;
      const locator = discoverRepository(repository);
      const runtime = investigationRuntimePaths(
        locator.gitCommonDirectory,
        'workflow-engine',
      );
      const request = readProviderInvocationRequest(runtime, invocationId);
      const loadedPolicy = loadAiAdapterPolicy(repository);
      assert.equal(request.policyDigest, loadedPolicy.digest);
      assert.deepEqual(request.limits, {
        timeoutMs: 12_345,
        aggregateOutputBytes: 54_321,
      });
      assert.equal(
        request.baseCommit.length,
        objectFormat === 'sha1' ? 40 : 64,
      );
      assert.equal(request.baseTree.length, objectFormat === 'sha1' ? 40 : 64);

      let launches = 0;
      let launchBinding:
        | Parameters<
            NonNullable<AgentRuntimePort['runSingleShotAsync']>
          >[0]['acceptanceBinding']
        | null = null;
      const controller = new AbortController();
      const agentRuntime: AgentRuntimePort = {
        runSingleShot() {
          assert.fail('production async worker must not use runSingleShot');
        },
        async runSingleShotAsync(input, options) {
          launches += 1;
          launchBinding = input.acceptanceBinding;
          assert.equal(options.signal, controller.signal);
          assert.equal(
            sha256(canonicalJson(input.semanticOutputSchema)),
            request.outputSchema.digest,
          );
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          options.onActivity?.({ type: 'stdout', elapsedMs: 2, bytes: 10 });
          options.onActivity?.({ type: 'stderr', elapsedMs: 3, bytes: 4 });
          options.onActivity?.({ type: 'exited', elapsedMs: 7 });
          const semanticOutput = {
            reference: invocationId,
            terms: [{ kind: 'symbol', value: 'ProviderWorker' }],
          };
          return {
            invocationId,
            providerId: request.providerId,
            purpose: request.purpose,
            requestDigest: request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: 'a'.repeat(64),
              afterDigest: 'a'.repeat(64),
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      };
      const completed = await runProviderWorkerAsync(repository, invocationId, {
        workerId: `fake-worker-${objectFormat}`,
        platform: 'aix',
        signal: controller.signal,
        agentRuntime,
        runner() {
          throw new Error('agentRuntime must take precedence over runner');
        },
      });

      assert.equal(completed.state, 'succeeded');
      assert.equal(completed.launched, true);
      const durable = readProviderInvocation(runtime, invocationId);
      assert.equal(durable.state, 'succeeded');
      const acceptedBinding =
        launchBinding as ProviderInvocationAcceptanceBinding | null;
      assert.ok(acceptedBinding);
      assert.ok(durable.runtimeReceipt);
      assert.deepEqual(completed.completionReceipt, durable.runtimeReceipt);
      const receiptPayload = { ...durable.runtimeReceipt };
      delete (receiptPayload as { receiptDigest?: string }).receiptDigest;
      assert.equal(
        durable.runtimeReceipt.receiptDigest,
        sha256(canonicalJson(receiptPayload)),
      );
      assert.deepEqual(receiptPayload, {
        schemaVersion: 1,
        kind: 'agent-runtime-completion-receipt',
        invocationId,
        requestDigest: request.requestDigest,
        leasedRevision: durable.revision - 1,
        terminalRevision: durable.revision,
        leaseGeneration: durable.leaseGeneration,
        executionJobId: acceptedBinding.executionJobId,
        executionAttemptId: acceptedBinding.executionAttemptId,
        executionRevision: acceptedBinding.executionRevision,
        executionStateDigest: acceptedBinding.executionStateDigest,
        acceptanceBindingDigest: acceptedBinding.bindingDigest,
        terminalState: 'succeeded',
        launched: true,
        progress: {
          schemaVersion: 1,
          kind: 'agent-runtime-process-progress',
          processState: 'exited',
          eventCount: 4,
          stdoutBytes: 10,
          stderrBytes: 4,
          lastProcessActivityElapsedMs: 7,
          lastProviderActivityElapsedMs: 3,
        },
      });
      assert.equal(
        durable.result?.runtimeObservation?.assurance,
        'unchanged-governed-projection',
      );
      assert.equal(
        durable.result?.runtimeObservation?.sameUserProcessConfined,
        false,
      );
      assert.deepEqual(
        durable.result?.runtimeObservation?.residuals,
        PROVIDER_RUNNER_RESIDUALS,
      );

      const replayed = await runProviderWorkerAsync(repository, invocationId, {
        agentRuntime,
      });
      assert.equal(replayed.state, 'succeeded');
      assert.equal(replayed.launched, false);
      assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
      assert.equal(replayed.completionReceipt?.launched, true);
      assert.equal(launches, 1);

      const statePath = path.join(
        runtime.invocations,
        invocationId,
        'state.json',
      );
      const tampered = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        runtimeReceipt: Record<string, unknown>;
      };
      tampered.runtimeReceipt.executionAttemptId =
        'attempt-legacy-invocation-mismatched';
      const tamperedReceiptPayload = { ...tampered.runtimeReceipt };
      delete tamperedReceiptPayload.receiptDigest;
      tampered.runtimeReceipt.receiptDigest = sha256(
        canonicalJson(tamperedReceiptPayload),
      );
      fs.writeFileSync(statePath, `${canonicalJson(tampered)}\n`);
      await assert.rejects(
        () =>
          runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_INVOCATION_INVALID',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('async provider worker durably binds a wrapper protocol receipt to its accepted Attempt', async () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-wrapper-protocol-receipt';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    let launches = 0;
    let protocolReceipt: ProviderWrapperProtocolReceipt | null = null;
    const agentRuntime: AgentRuntimePort = {
      runSingleShot() {
        assert.fail('async worker must not call the sync runtime');
      },
      async runSingleShotAsync(input, options) {
        launches += 1;
        const parser = createProviderWrapperProtocolParser({
          binding: {
            invocationId,
            requestDigest: request.requestDigest,
            attemptId: input.acceptanceBinding.executionAttemptId,
          },
        });
        const stream = Buffer.from(
          [
            {
              schemaVersion: 1 as const,
              type: 'hello' as const,
              sequence: 1,
              protocol: 'harness-jsonl-v1' as const,
            },
            {
              schemaVersion: 1 as const,
              type: 'progress' as const,
              sequence: 2,
              phase: 'tool' as const,
            },
            {
              schemaVersion: 1 as const,
              type: 'result' as const,
              sequence: 3,
              outputSlot: 'primary' as const,
            },
          ]
            .map(renderProviderWrapperFrame)
            .join(''),
          'utf8',
        );
        parser.push(stream);
        protocolReceipt = parser.finish({ cancellationForced: false });
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({
          type: 'stdout',
          elapsedMs: 1,
          bytes: stream.length,
        });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        return {
          ...successfulWorkerReport(request, invocationId),
          elapsedMs: 2,
          wrapperProtocolReceipt: protocolReceipt,
        };
      },
    };

    const completed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime,
    });
    assert.ok(completed.completionReceipt);
    assert.equal(completed.completionReceipt.schemaVersion, 2);
    assert.ok('protocolReceipt' in completed.completionReceipt);
    assert.deepEqual(
      (
        completed.completionReceipt as unknown as {
          protocolReceipt: unknown;
        }
      ).protocolReceipt,
      protocolReceipt,
    );
    const durable = readProviderInvocation(runtime, invocationId);
    assert.deepEqual(durable.runtimeReceipt, completed.completionReceipt);

    const replayed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime,
    });
    assert.equal(replayed.launched, false);
    assert.deepEqual(replayed.completionReceipt, completed.completionReceipt);
    assert.equal(launches, 1);

    const statePath = path.join(
      runtime.invocations,
      invocationId,
      'state.json',
    );
    const originalState = fs.readFileSync(statePath, 'utf8');
    const unknownVersion = JSON.parse(originalState) as {
      runtimeReceipt: Record<string, unknown>;
    };
    unknownVersion.runtimeReceipt.schemaVersion = 3;
    const unknownVersionPayload = { ...unknownVersion.runtimeReceipt };
    delete unknownVersionPayload.receiptDigest;
    unknownVersion.runtimeReceipt.receiptDigest = sha256(
      canonicalJson(unknownVersionPayload),
    );
    fs.writeFileSync(statePath, `${canonicalJson(unknownVersion)}\n`);
    await assert.rejects(
      () => runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_INVOCATION_INVALID',
    );
    assert.equal(launches, 1, 'unknown receipt versions must not relaunch');

    fs.writeFileSync(statePath, originalState);
    const tampered = JSON.parse(originalState) as {
      runtimeReceipt: Record<string, unknown> & {
        protocolReceipt: Record<string, unknown>;
      };
    };
    const mismatchedAttemptId = 'attempt-mismatched-wrapper-receipt';
    tampered.runtimeReceipt.executionAttemptId = mismatchedAttemptId;
    tampered.runtimeReceipt.protocolReceipt.attemptId = mismatchedAttemptId;
    const protocolPayload = { ...tampered.runtimeReceipt.protocolReceipt };
    delete protocolPayload.receiptDigest;
    tampered.runtimeReceipt.protocolReceipt.receiptDigest = sha256(
      canonicalJson(protocolPayload),
    );
    const runtimePayload = { ...tampered.runtimeReceipt };
    delete runtimePayload.receiptDigest;
    tampered.runtimeReceipt.receiptDigest = sha256(
      canonicalJson(runtimePayload),
    );
    fs.writeFileSync(statePath, `${canonicalJson(tampered)}\n`);

    await assert.rejects(
      () => runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_INVOCATION_INVALID',
    );
    assert.equal(launches, 1, 'tampered terminal replay must not relaunch');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker records launch and admission failure durably', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-failure';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    let launches = 0;
    const failed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        throw workflowError(
          'PROVIDER_UNAVAILABLE',
          'The selected provider is unavailable.',
          ExitCode.verification,
        );
      },
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_UNAVAILABLE');

    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    assert.equal(
      readProviderInvocation(runtime, invocationId).runtimeReceipt,
      undefined,
      'the optional projection must not rewrite synchronous legacy records',
    );

    const replayed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        throw new Error('failed invocations must not relaunch');
      },
    });
    assert.equal(replayed.state, 'failed');
    assert.equal(replayed.launched, false);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async provider worker records a rejected launch and partial progress receipt', async () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-async-failure';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const failed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime: {
        runSingleShot() {
          assert.fail('async worker must not call the sync runtime');
        },
        async runSingleShotAsync(_input, options) {
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          throw workflowError(
            'PROVIDER_UNAVAILABLE',
            'The selected provider is unavailable.',
            ExitCode.verification,
          );
        },
      },
    });

    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(failed.completionReceipt?.terminalState, 'failed');
    assert.deepEqual(failed.completionReceipt?.progress, {
      schemaVersion: 1,
      kind: 'agent-runtime-process-progress',
      processState: 'running',
      eventCount: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      lastProcessActivityElapsedMs: 0,
      lastProviderActivityElapsedMs: null,
    });
    const durable = readProviderInvocation(runtime, invocationId);
    assert.deepEqual(failed.completionReceipt, durable.runtimeReceipt);
    assert.equal(durable.runtimeReceipt?.terminalState, 'failed');
    const replayed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime: {
        runSingleShot() {
          assert.fail('terminal replay must not call the sync runtime');
        },
        async runSingleShotAsync() {
          assert.fail('terminal replay must not relaunch async work');
        },
      },
    });
    assert.equal(replayed.launched, false);
    assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker rejects output when current context rolls during execution', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-context-rollover';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const owner = readProviderInvocation(runtime, invocationId).investigationId;
    const manifest = readProviderInvocationManifest(runtime, invocationId);

    const result = runProviderWorker(repository, invocationId, {
      workerId: 'worker-context-rollover',
      runner() {
        const storeRoot = providerPromptContextStoreRoot(
          path.join(runtime.invocations, invocationId),
        );
        const binding = ensureProviderPromptContext(
          storeRoot,
          request,
          manifest,
          owner,
        );
        const nextContent = canonicalJson({
          kind: 'rolled-provider-context',
          owner,
        });
        const next = buildContextManifest({
          workflowId: binding.workflowId,
          epoch: binding.epoch + 1,
          contractVersion: binding.manifest.contractVersion,
          baselineDigest: binding.manifest.baselineDigest,
          intentDigest: binding.manifest.intentDigest,
          termSetDigest: binding.manifest.termSetDigest,
          planningSnapshotDigest: binding.manifest.planningSnapshotDigest,
          items: [
            { identity: 'provider-input-manifest', content: nextContent },
          ],
        });
        const current = inspectDurableEpochContextStore(
          storeRoot,
          binding.workflowId,
        );
        rolloverDurableEpochContextStore(storeRoot, {
          workflowId: binding.workflowId,
          expectedGeneration: binding.generation,
          expectedEpoch: binding.epoch,
          expectedContextDigest: binding.contextDigest,
          nextManifest: next,
          items: [
            { identity: 'provider-input-manifest', content: nextContent },
          ],
          reason: 'Exercise provider completion freshness.',
          restartFrom: request.purpose,
          carriedForward: [],
          invalidated: ['provider-input-manifest'],
          verification: null,
          createdAt: new Date(Date.parse(current.updatedAt) + 1),
        });
        return successfulWorkerReport(request, invocationId);
      },
    });

    assert.equal(result.state, 'failed');
    assert.equal(result.failure?.kind, 'repository-reconciliation-required');
    assert.equal(result.failure?.code, 'PROVIDER_CONTEXT_STALE_OR_WRONG');
    assert.equal(readProviderInvocation(runtime, invocationId).result, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker rejects execution Job authority drift after launch', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-execution-authority-drift';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);

    const result = runProviderWorker(repository, invocationId, {
      workerId: 'worker-execution-authority-drift',
      runner() {
        const record = readProviderInvocation(runtime, invocationId);
        const projection = projectProviderInvocationExecution({
          record,
          request,
        });
        const execution = readExecutionJobState(runtime, projection.job.jobId);
        assert.ok(execution);
        fs.writeFileSync(
          executionJobStatePath(runtime, projection.job.jobId),
          `${canonicalJson({ ...execution, revision: execution.revision + 1 })}\n`,
          { mode: 0o600 },
        );
        return successfulWorkerReport(request, invocationId);
      },
    });

    assert.equal(result.state, 'failed');
    assert.equal(result.failure?.kind, 'repository-reconciliation-required');
    assert.equal(result.failure?.code, 'PROVIDER_ACCEPTANCE_BINDING_STALE');
    assert.equal(readProviderInvocation(runtime, invocationId).result, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion guard rejects rollover after runner return and before acceptance', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-completion-context-race';
  let fence: { invocationId: string; token: string } | null = null;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const claim = claimProviderInvocationForWorker(runtime, invocationId, {
      workerId: 'worker-completion-context-race',
      leaseDurationMs: request.limits.timeoutMs,
    });
    fence = { invocationId, token: claim.workerFenceToken };
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      runtime,
      invocationId,
    );
    const nextContent = canonicalJson({
      kind: 'rolled-between-runner-and-completion',
      invocationId,
    });
    const next = buildContextManifest({
      workflowId: acceptanceBinding.context.workflowId,
      epoch: acceptanceBinding.context.epoch + 1,
      contractVersion: acceptanceBinding.context.manifest.contractVersion,
      baselineDigest: acceptanceBinding.context.manifest.baselineDigest,
      intentDigest: acceptanceBinding.context.manifest.intentDigest,
      termSetDigest: acceptanceBinding.context.manifest.termSetDigest,
      planningSnapshotDigest:
        acceptanceBinding.context.manifest.planningSnapshotDigest,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
    });
    const current = inspectDurableEpochContextStore(
      runtime.root,
      acceptanceBinding.context.workflowId,
    );
    rolloverDurableEpochContextStore(runtime.root, {
      workflowId: acceptanceBinding.context.workflowId,
      expectedGeneration: acceptanceBinding.context.generation,
      expectedEpoch: acceptanceBinding.context.epoch,
      expectedContextDigest: acceptanceBinding.context.contextDigest,
      nextManifest: next,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
      reason: 'Exercise completion-time freshness.',
      restartFrom: request.purpose,
      carriedForward: [],
      invalidated: ['provider-input-manifest'],
      verification: null,
      createdAt: new Date(Date.parse(current.updatedAt) + 1),
    });

    assert.throws(
      () =>
        completeProviderInvocationFromRunner(runtime, invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          report: successfulWorkerReport(request, invocationId),
          acceptanceBinding,
        }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_CONTEXT_STALE_OR_WRONG',
    );
    assert.equal(readProviderInvocation(runtime, invocationId).state, 'leased');
    const projection = projectProviderInvocationExecution({
      record: claim.record,
      request,
    });
    assert.equal(
      readExecutionJobState(runtime, projection.job.jobId)?.job
        .acceptedAttemptId,
      null,
    );
  } finally {
    if (fence !== null) {
      const locator = discoverRepository(repository);
      releaseProviderInvocationWorkerFence(
        investigationRuntimePaths(
          locator.gitCommonDirectory,
          'workflow-engine',
        ),
        fence.invocationId,
        fence.token,
      );
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider dispatch is detached and replay targets the stored prepared request', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-dispatch';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    let replayedInvocationId: string | null = null;
    startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
      providerDriver({ request }) {
        replayedInvocationId = request.invocationId;
      },
    });
    assert.equal(replayedInvocationId, invocationId);

    const launches: Array<{
      executable: string;
      args: string[];
      cwd: string;
      detached: boolean;
    }> = [];
    let unrefCount = 0;
    const dispatch = createProviderWorkerDispatcherForTesting({
      spawn(executable, args, options) {
        launches.push({
          executable,
          args,
          cwd: options.cwd,
          detached: options.detached,
        });
        return {
          pid: 1234,
          unref() {
            unrefCount += 1;
          },
        };
      },
    });
    const dispatched = dispatch(repository, invocationId);
    assert.equal(dispatched.invocationId, invocationId);
    assert.equal(dispatched.pid, 1234);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.executable, process.execPath);
    assert.equal(launches[0]!.cwd, fs.realpathSync(repository));
    assert.equal(launches[0]!.detached, true);
    assert.deepEqual(launches[0]!.args.slice(-3), [
      'provider-worker',
      invocationId,
      '--json',
    ]);
    assert.equal(unrefCount, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker selects the code-owned exact PlanReview contract', () => {
  const repository = createFixtureRepository();
  try {
    const ready = writeReadyV2ExemptChange(repository);
    const context = deriveInvestigationFirstPlanningSubject(
      repository,
      loadChangeContract(repository, 'demo-change'),
    );
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const invocationId = 'invocation-plan-review-worker';
    const investigationId = 'investigation-plan-review-worker';
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-worker',
      targetDigest: context.subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const artifacts = {};
    const sealNodeId = sha256('plan-review-worker-seal-node');
    const sealResultDigest = sha256('plan-review-worker-seal-result');
    const materialization = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'workflow.propose-planning-materialization.v1',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        artifacts: sha256(canonicalJson(artifacts)),
        baseline: sha256(canonicalJson(context.subject.investigationBaseline)),
        seal: sealNodeId,
      },
      semanticParentResultDigests: { seal: sealResultDigest },
      provenanceParentNodeIds: { seal: sealNodeId },
      outputSchema: 'workflow.propose-planning-materialization-output.v1',
      output: {
        investigationId,
        changeId: 'demo-change',
        revision: 0,
        baseline: context.subject.investigationBaseline,
        artifacts,
        sealNodeId,
        sealResultDigest,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, materialization);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v1',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: context.subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        subject: context.subject.subjectDigest,
      },
      semanticParentResultDigests: {
        materialization: materialization.resultDigest,
      },
      provenanceParentNodeIds: {
        materialization: materialization.nodeId,
      },
      outputSchema: 'workflow.plan-review-authorization-output.v1',
      output: {
        subject: context.subject,
        assignment,
        author: { id: 'fixture-author' },
        grantAuthorization: null,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    const manifest: PlanReviewManifest = {
      schemaVersion: 1,
      kind: 'plan-review-manifest',
      changeId: 'demo-change',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject: context.subject,
      capabilityProfile: 'repository-read-only',
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-worker-nonce-000000',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: context.subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'plan-review.v2',
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: {
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
      },
    });
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId: 'demo-change',
      attempt: 1,
      manifest,
      request,
    });
    const submission = {
      schemaVersion: 2 as const,
      verdict: 'advisory-approve' as const,
      coverage: [...PLAN_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge' as const,
        evidence: [
          {
            kind: 'investigation-node' as const,
            nodeId: ready.applicabilityNode.nodeId,
            resultDigest: ready.applicabilityNode.resultDigest,
          },
        ],
      },
      findings: [],
      proposedTerms: [],
      suggestions: [],
      residualRisk: 'The review cannot prove semantic completeness.',
      uncertainty: 'The provider operates under observed soft containment.',
    };
    const result = runProviderWorker(repository, invocationId, {
      runner(input) {
        assert.equal(
          sha256(canonicalJson(input.semanticOutputSchema)),
          PLAN_REVIEW_OUTPUT_SCHEMA.digest,
        );
        return {
          invocationId,
          providerId: 'claude',
          purpose: 'plan-review',
          requestDigest: request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: 'd'.repeat(64),
            afterDigest: 'd'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
        };
      },
    });
    assert.equal(result.state, 'succeeded');
    assert.equal(
      readProviderInvocation(runtime, invocationId).result?.outputDigest,
      sha256(
        canonicalJson({
          id: PLAN_REVIEW_OUTPUT_SCHEMA.id,
          version: PLAN_REVIEW_OUTPUT_SCHEMA.version,
          output: submission,
        }),
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Exercise lifecycle-owned provider work.',
    explicitPaths: ['src/.gitkeep'],
    explicitSymbols: [],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}

function lowerAdapterLimits(repository: string): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.limits.timeoutMs = 12_345;
  policy.limits.aggregateOutputBytes = 54_321;
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

function successfulWorkerReport(
  request: ProviderInvocationRequest,
  invocationId: string,
) {
  const semanticOutput = {
    reference: invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderWorker' }],
  };
  return {
    invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false as const,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: executableIdentity(),
    elapsedMs: 7,
  };
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
