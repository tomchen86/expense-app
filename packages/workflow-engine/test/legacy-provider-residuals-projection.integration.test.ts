import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { listExecutionJobs } from '../src/execution-runtime.ts';
import { discoverRepository } from '../src/git.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  claimProviderInvocationForWorker,
  completeProviderInvocation,
  completeProviderInvocationFromRunner,
  createProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  providerInvocationManifestDigest,
  providerResidualsGeneration,
  readProviderInvocation,
  readProviderInvocationRequest,
  releaseProviderInvocationWorkerFence,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';
const COMPLETED_AT = '2026-07-25T16:00:07.514Z';

/**
 * The residual `cee2162` added on 2026-07-28, in the position it added it. The
 * seven records this repository wrote on 2026-07-25/26 carry every other code,
 * in order, which is why the historical list is an order-preserving subsequence
 * of the current one rather than a prefix of it.
 */
const RESIDUAL_ADDED_AFTER_THE_LEGACY_RECORDS =
  'PROVIDER_INPUT_CONSUMPTION_NOT_OBSERVABLE';

const LEGACY_RESIDUALS = PROVIDER_RUNNER_RESIDUALS.filter(
  (code) => code !== RESIDUAL_ADDED_AFTER_THE_LEGACY_RECORDS,
);

test('a record carrying the residuals list of its own day still projects', () => {
  // The seven records written before the eighth residual existed do not fail
  // one read: the legacy scan is fail-closed for the whole store, so they make
  // `job list` and `job status` unusable for every Job in the repository.
  assert.equal(LEGACY_RESIDUALS.length, PROVIDER_RUNNER_RESIDUALS.length - 1);
  const fixture = prepareInvocation('residuals-legacy-projects', {
    residuals: LEGACY_RESIDUALS,
  });
  try {
    const jobs = listExecutionJobs(fixture.repository);
    assert.equal(jobs.length, 1);
    const [result] = jobs[0]!.results;
    assert.equal(result?.invocationId, fixture.invocationId);
    assert.deepEqual(result?.residuals, {
      generation: 'legacy-subset',
      missing: [RESIDUAL_ADDED_AFTER_THE_LEGACY_RECORDS],
    });
  } finally {
    fixture.dispose();
  }
});

test('the projection reports the residuals the record stored', () => {
  // Tolerating the shorter list must not widen it. Residuals are the honest
  // caveats an observation carries, and an aged record claiming today's caveats
  // would assert containment nobody observed. The record keeps its own list and
  // the projection names the gap instead.
  const fixture = prepareInvocation('residuals-legacy-faithful', {
    residuals: LEGACY_RESIDUALS,
  });
  try {
    const record = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.deepEqual(record.result?.runtimeObservation?.residuals, [
      ...LEGACY_RESIDUALS,
    ]);
    assert.deepEqual(providerResidualsGeneration(record), {
      generation: 'legacy-subset',
      missing: [RESIDUAL_ADDED_AFTER_THE_LEGACY_RECORDS],
    });
  } finally {
    fixture.dispose();
  }
});

test('the current residuals list is still the unremarkable case', () => {
  // The tolerance must not turn the strict path into a special case: a record
  // written today classifies as current and names no gap at all.
  const fixture = prepareInvocation('residuals-current', {
    residuals: PROVIDER_RUNNER_RESIDUALS,
  });
  try {
    const [job] = listExecutionJobs(fixture.repository);
    assert.deepEqual(job?.results[0]?.residuals, {
      generation: 'current',
      missing: [],
    });
  } finally {
    fixture.dispose();
  }
});

test('a residual the engine does not own stays invalid', () => {
  // The tolerance keys on a list the current writer could not have produced,
  // never on one no writer of this engine ever produced. An unknown code is not
  // evidence of age.
  const fixture = prepareInvocation('residuals-unknown-code', {
    residuals: [...LEGACY_RESIDUALS, 'PROVIDER_NETWORK_EGRESS_NOT_CONFINED'],
  });
  try {
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error: unknown) =>
        isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a residuals list longer than the current one stays invalid', () => {
  // A superset claims the runner observed caveats it never named. Only a
  // shorter list is reachable by age; a longer one is reachable by nothing.
  const fixture = prepareInvocation('residuals-superset', {
    residuals: [...PROVIDER_RUNNER_RESIDUALS, ...PROVIDER_RUNNER_RESIDUALS],
  });
  try {
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error: unknown) =>
        isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a reordered residuals list stays invalid', () => {
  // Every list this engine ever wrote spread one frozen constant, so order is
  // part of the shape. A permutation is not an older generation of it.
  const reordered = [...PROVIDER_RUNNER_RESIDUALS].reverse();
  const fixture = prepareInvocation('residuals-reordered', {
    residuals: reordered,
  });
  try {
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error: unknown) =>
        isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a duplicated residual stays invalid', () => {
  // A repeated code is the same length as a real subsequence but is not one.
  const duplicated = [
    ...LEGACY_RESIDUALS.slice(0, -1),
    LEGACY_RESIDUALS.at(-1)!,
    LEGACY_RESIDUALS.at(-1)!,
  ];
  const fixture = prepareInvocation('residuals-duplicated', {
    residuals: duplicated,
  });
  try {
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error: unknown) =>
        isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('an empty residuals list is legacy, and every missing caveat is named', () => {
  // An empty list is still a shape the current writer cannot produce, so it is
  // read rather than refused -- and because the projection names all eight
  // missing codes, the record that claims the least is the one that discloses
  // the most.
  const fixture = prepareInvocation('residuals-empty', { residuals: [] });
  try {
    const [job] = listExecutionJobs(fixture.repository);
    assert.deepEqual(job?.results[0]?.residuals, {
      generation: 'legacy-subset',
      missing: [...PROVIDER_RUNNER_RESIDUALS],
    });
  } finally {
    fixture.dispose();
  }
});

test('a residuals value that is not a list is refused, not read as legacy', () => {
  // The classifier is exported, so it must not infer age from a value that
  // merely has a length. An empty string matches no code at all, which is the
  // shape an order-preserving match would otherwise call the shortest legacy
  // list rather than the wrong type.
  for (const residuals of ['', 'SAME_USER_PROCESS_NOT_CONFINED', {}, null]) {
    assert.throws(
      () =>
        providerResidualsGeneration({
          result: { runtimeObservation: { residuals } },
        } as never),
      (error: unknown) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
      `residuals ${JSON.stringify(residuals)} must not classify`,
    );
  }
});

test('a runner returning a short list right now is still refused', () => {
  // The tolerance is for state this engine already made durable. A runner
  // reporting today spreads the frozen constant, so it cannot return a short
  // list -- one that does is a defect, and a defect must not become history.
  const repository = createFixtureRepository();
  const changeId = 'residuals-live-strict';
  let fence: { invocationId: string; token: string } | null = null;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise a live runner report carrying aged residuals.',
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      { explicitActor: 'codex', environment: {} },
    );
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const claim = claimProviderInvocationForWorker(runtime, invocationId, {
      workerId: `worker-${changeId}`,
      leaseDurationMs: request.limits.timeoutMs,
    });
    fence = { invocationId, token: claim.workerFenceToken };
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      runtime,
      invocationId,
    );

    assert.throws(
      () =>
        completeProviderInvocationFromRunner(runtime, invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          report: workerReport(request, invocationId, LEGACY_RESIDUALS),
          acceptanceBinding,
        }),
      (error: unknown) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
    );
    assert.equal(readProviderInvocation(runtime, invocationId).result, null);
  } finally {
    if (fence !== null) {
      releaseProviderInvocationWorkerFence(
        investigationRuntimePaths(
          discoverRepository(repository).gitCommonDirectory,
          'workflow-engine',
        ),
        fence.invocationId,
        fence.token,
      );
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function workerReport(
  request: ProviderInvocationRequest,
  invocationId: string,
  residuals: readonly unknown[],
) {
  const semanticOutput = {
    reference: invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderRunnerResiduals' }],
  };
  return {
    invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(semanticOutput))
      .digest('hex'),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false as const,
    // Deliberately widened: several cases build residuals the runner's own type
    // forbids, precisely to prove the runtime check rejects them rather than
    // relying on the compiler to have stopped them.
    residuals: [...residuals] as string[],
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
    elapsedMs: 7,
  };
}

function prepareInvocation(
  name: string,
  options: { residuals: readonly unknown[] },
) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const invocationId = `invocation-${name}-1`;
  const manifest = createManifest(repository, investigationId);
  const request = createRequest(
    repository,
    manifest,
    invocationId,
    investigationId,
  );
  try {
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: new Date(Date.parse(COMPLETED_AT) - 60_000).toISOString(),
    });
    completeInvocation(runtime, request);
    writeRawRuntime(runtime, request, options.residuals);
    return {
      repository,
      runtime,
      request,
      invocationId,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createManifest(
  repository: string,
  investigationId: string,
): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: CHANGE_ID,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: `Read provider residuals for ${investigationId}.`,
      explicitPaths: ['packages/workflow-engine/src/provider-runner.ts'],
      explicitSymbols: ['PROVIDER_RUNNER_RESIDUALS'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'Which residual caveats did this observation carry?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
  investigationId: string,
): ProviderInvocationRequest {
  const targetDigest = blindSurveyIntentDigest(manifest);
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: `provider-session-${investigationId}`,
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: loadAiAdapterPolicy(repository).digest,
    limits: { timeoutMs: 600_000, aggregateOutputBytes: 1_048_576 },
  });
}

function completeInvocation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(COMPLETED_AT) - 30_000).toISOString(),
  });
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
    now: COMPLETED_AT,
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
        terms: [{ kind: 'symbol', value: 'ProviderRunnerResiduals' }],
      },
    }),
    stderr: '',
  };
}

/**
 * Rewrite the durable observation with a chosen residuals list. The store is
 * the only writer of this field, so reproducing an aged record means editing
 * the state it already wrote rather than asking a runner to emit a list the
 * frozen constant makes unreachable.
 */
function writeRawRuntime(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
  residuals: readonly unknown[],
): void {
  const statePath = path.join(
    runtime.invocations,
    request.invocationId,
    'state.json',
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    result: { runtimeObservation: Record<string, unknown> } | null;
  };
  assert.ok(state.result, 'the completion must have written a result');
  state.result.runtimeObservation = {
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...residuals],
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
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
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
