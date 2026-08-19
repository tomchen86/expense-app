import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { listExecutionJobStates } from '../src/execution-store.ts';
import { listProviderInvocationLifecycleProjections } from '../src/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { inspectProviderPromptContextRetentionBinding } from '../src/provider-execution-governance.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import {
  inspectProviderRetentionMetrics,
  providerRuntimeEvidenceId,
  pruneProviderRuntime,
  readProviderRetentionReceipt,
} from '../src/provider-retention.ts';
import { pinWorkflowEvidence } from '../src/retention-control.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

test('a human pin racing a physical sweep fails closed on the shared lifecycle lock', async () => {
  const fixture = preparePrunableProviderRuntime('retention-pin-sweep-race');
  const signals = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-retention-pin-race-'),
  );
  const promptedPath = path.join(signals, 'human-prompt-complete');
  const continuePath = path.join(signals, 'continue-pin');
  const resultPath = path.join(signals, 'pin-result.json');
  let child: ChildProcess | undefined;
  let sweepError: unknown;
  try {
    child = spawnPinAttempt({
      repository: fixture.repository,
      workflowId: fixture.workflowId,
      evidenceId: fixture.evidenceId,
      promptedPath,
      continuePath,
      resultPath,
    });
    waitForFile(promptedPath);
    try {
      pruneProviderRuntime(
        fixture.repository,
        { limit: 10, now: fixture.retentionNow },
        {
          afterArtifactStaged(count, invocationId) {
            if (count !== 1 || invocationId !== fixture.prunableInvocationId) {
              return;
            }
            fs.writeFileSync(continuePath, 'continue\n');
            waitForFile(resultPath);
            assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), {
              outcome: 'rejected',
              code: 'REPOSITORY_LIFECYCLE_CONFLICT',
            });
          },
        },
      );
    } catch (error) {
      sweepError = error;
    }

    assert.ok(child, 'the physical sweep must reach its staged-artifact hook');
    const exited = await waitForChild(child);
    assert.equal(exited.code, 0, exited.stderr);
    assert.ifError(sweepError);
    const outcome = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      outcome: 'pinned' | 'rejected';
      code?: string;
    };
    assert.deepEqual(outcome, {
      outcome: 'rejected',
      code: 'REPOSITORY_LIFECYCLE_CONFLICT',
    });
    assert.equal(
      readProviderRetentionReceipt(
        fixture.runtime,
        fixture.prunableInvocationId,
      )?.state,
      'complete',
    );
  } finally {
    if (child?.exitCode === null) child.kill();
    fs.rmSync(signals, { recursive: true, force: true });
    fixture.dispose();
  }
});

test('pinning provider-runtime evidence after its physical artifacts were pruned is rejected', () => {
  const fixture = preparePrunableProviderRuntime('retention-pin-after-prune');
  try {
    const sweep = pruneProviderRuntime(fixture.repository, {
      limit: 10,
      now: fixture.retentionNow,
    });
    assert.equal(
      sweep.pruned.some(
        ({ invocationId }) => invocationId === fixture.prunableInvocationId,
      ),
      true,
    );
    assert.equal(
      readProviderRetentionReceipt(
        fixture.runtime,
        fixture.prunableInvocationId,
      )?.state,
      'complete',
    );

    assert.throws(
      () =>
        pinWorkflowEvidence(
          fixture.repository,
          {
            workflowId: fixture.workflowId,
            evidenceId: fixture.evidenceId,
            reason: 'Preserve the exact provider runtime for incident review.',
          },
          { signer: fixture.mandate.signer },
        ),
      (error) => isWorkflowError(error, 'RETENTION_EVIDENCE_ALREADY_PRUNED'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a production human pin removes expired provider bytes from pending-deletion metrics', () => {
  const fixture = preparePrunableProviderRuntime('retention-human-pin-metrics');
  try {
    const before = inspectProviderRetentionMetrics(fixture.repository, {
      now: fixture.retentionNow,
    });
    assert.equal(before.expiredPendingDeletion.count, 1);
    assert.ok(before.expiredPendingDeletion.bytes > 0);

    pinWorkflowEvidence(
      fixture.repository,
      {
        workflowId: fixture.workflowId,
        evidenceId: fixture.evidenceId,
        reason: 'Preserve the exact provider runtime for incident review.',
      },
      { signer: fixture.mandate.signer },
    );

    const after = inspectProviderRetentionMetrics(fixture.repository, {
      now: fixture.retentionNow,
    });
    assert.equal(after.expiredPendingDeletion.count, 0);
    assert.equal(after.expiredPendingDeletion.bytes, 0);
    assert.ok(after.rawEvidenceBytesByRetentionClass.pinned > 0);
    assert.equal(after.pinnedCount, 1);
  } finally {
    fixture.dispose();
  }
});

function preparePrunableProviderRuntime(changeId: string) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  try {
    startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: `Create ${changeId} retention evidence.`,
        explicitPaths: ['packages/workflow-engine/src/provider-retention.ts'],
        explicitSymbols: ['pruneProviderRuntime'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: mandate.taskId,
        taskMandateValidation: { signer: mandate.signer },
        providerDriver() {},
      },
    );
    const runtimeContext = loadInvestigationRuntimeContext(repository);
    const [projection] = listProviderInvocationLifecycleProjections(
      runtimeContext.runtime,
    );
    assert.ok(projection);
    const firstRecord = readProviderInvocation(
      runtimeContext.runtime,
      projection.invocationId,
    );
    const firstRequest = readProviderInvocationRequest(
      runtimeContext.runtime,
      projection.invocationId,
    );
    const manifest = readProviderInvocationManifest(
      runtimeContext.runtime,
      projection.invocationId,
    );
    completeInvocation(runtimeContext.runtime, firstRequest);
    createRawRuntime(runtimeContext.runtime, firstRequest);

    const prunableInvocationId = `invocation-${changeId}-late-duplicate`;
    const replacement = createProviderInvocationRequest({
      invocationId: prunableInvocationId,
      nonce: `${prunableInvocationId}-nonce-000000`,
      purpose: firstRequest.purpose,
      providerId: firstRequest.providerId,
      roleAssignment: firstRequest.roleAssignment,
      capabilityProfile: firstRequest.capabilityProfile,
      repositoryId: firstRequest.repositoryId,
      baseCommit: firstRequest.baseCommit,
      baseTree: firstRequest.baseTree,
      targetDigest: firstRequest.targetDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: firstRequest.authorizationNodeId,
      writeAllowedPaths: [],
      outputSchema: firstRequest.outputSchema,
      evaluatorVersion: firstRequest.evaluatorVersion,
      policyDigest: firstRequest.policyDigest,
      limits: firstRequest.limits,
    });
    storeProviderExecutionPolicySnapshot(
      runtimeContext.runtime,
      replacement,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtimeContext.runtime, {
      investigationId: firstRecord.investigationId,
      changeId,
      attempt: 2,
      manifest,
      request: replacement,
      mandateBinding: mandate.binding,
    });
    completeInvocation(runtimeContext.runtime, replacement);
    createRawRuntime(runtimeContext.runtime, replacement);

    const attempt = listExecutionJobStates(runtimeContext.runtime)
      .flatMap(({ attempts }) => attempts)
      .find(
        ({ legacyInvocation }) =>
          legacyInvocation?.invocationId === prunableInvocationId,
      );
    assert.ok(attempt);
    const replacementRecord = readProviderInvocation(
      runtimeContext.runtime,
      prunableInvocationId,
    );
    const context = inspectProviderPromptContextRetentionBinding(
      runtimeContext.runtime.root,
      replacement,
      manifest,
      projection.ownerInvestigationId,
      replacementRecord.createdAt,
    );
    assert.ok(context);
    const evidenceId = providerRuntimeEvidenceId(attempt.attemptId);
    const retentionNow = new Date(
      Date.parse(replacementRecord.updatedAt) + 8 * 86_400_000,
    ).toISOString();
    return {
      repository,
      runtime: runtimeContext.runtime,
      mandate,
      workflowId: context.workflowId,
      prunableInvocationId,
      evidenceId,
      retentionNow,
      dispose() {
        mandate.dispose();
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    mandate.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function completeInvocation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
  });
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
  });
}

function providerOutcome(
  request: ProviderInvocationRequest,
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify({
      schemaVersion: 1,
      requestDigest: request.requestDigest,
      invocationId: request.invocationId,
      nonce: request.nonce,
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignmentDigest: request.roleAssignmentDigest,
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: request.policyDigest,
      limits: request.limits,
      observedTouchedPaths: [],
      output: {
        reference: request.invocationId,
        terms: [{ kind: 'symbol', value: 'ProviderRetention' }],
      },
    }),
    stderr: '',
  };
}

function createRawRuntime(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
): void {
  const statePath = path.join(
    runtime.invocations,
    request.invocationId,
    'state.json',
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    result: { runtimeObservation: unknown } | null;
  };
  assert.ok(state.result);
  state.result.runtimeObservation = {
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: {
      candidatePath: '/fixture/provider',
      realPath: '/fixture/provider',
      device: '1',
      inode: '2',
      mode: 0o100755,
      uid: 1,
      gid: 1,
      size: 1,
      mtimeNs: '1',
      sha256: 'b'.repeat(64),
    },
    elapsedMs: 10,
  };
  fs.writeFileSync(statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });
  const directory = path.join(
    runtime.invocations,
    request.invocationId,
    'runtime',
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', `${canonicalJson({ request: request.requestDigest })}\n`],
    ['schema.json', `${canonicalJson(request.outputSchema)}\n`],
    [
      'semantic-output.json',
      `${canonicalJson({ reference: request.invocationId })}\n`,
    ],
  ] as const) {
    fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  }
}

function spawnPinAttempt(input: {
  repository: string;
  workflowId: string;
  evidenceId: string;
  promptedPath: string;
  continuePath: string;
  resultPath: string;
}): ChildProcess {
  const retentionControlUrl = pathToFileURL(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/retention-control.ts',
    ),
  ).href;
  const script = `
    import fs from 'node:fs';
    const [repository, workflowId, evidenceId, promptedPath, continuePath, resultPath, moduleUrl] = process.argv.slice(1);
    const { pinWorkflowEvidence } = await import(moduleUrl);
    const signer = {
      assertHumanPresent() {
        fs.writeFileSync(promptedPath, 'present\\n');
        const deadline = Date.now() + 20_000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(continuePath)) {
          if (Date.now() >= deadline) throw new Error('pin continuation was not released');
          Atomics.wait(pause, 0, 0, 10);
        }
      },
      identity() { return 'execution-fixture-maintainer'; },
      sign() { throw new Error('pinning must not sign a new authority envelope'); },
      verify() {},
    };
    try {
      pinWorkflowEvidence(repository, {
        workflowId,
        evidenceId,
        reason: 'Preserve the exact provider runtime for incident review.',
      }, { signer });
      fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'pinned' }));
    } catch (error) {
      fs.writeFileSync(resultPath, JSON.stringify({
        outcome: 'rejected',
        code: error && typeof error === 'object' && 'code' in error ? error.code : null,
      }));
    }
  `;
  return spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      script,
      input.repository,
      input.workflowId,
      input.evidenceId,
      input.promptedPath,
      input.continuePath,
      input.resultPath,
      retentionControlUrl,
    ],
    { cwd: input.repository, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function waitForFile(filePath: string): void {
  const deadline = Date.now() + 20_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        'The human-presence prompt did not complete while the sweep held the lifecycle lock.',
      );
    }
    Atomics.wait(pause, 0, 0, 10);
  }
}

async function waitForChild(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, stdout, stderr };
}
