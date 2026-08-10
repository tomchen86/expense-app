import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { projectProviderInvocationExecution } from '../src/execution-core.ts';
import { inspectExecutionJob } from '../src/execution-runtime.ts';
import {
  acceptLegacyProviderAttemptResult,
  executionJobStatePath,
  executionStorePaths,
  listExecutionJobStates,
  materializeLegacyProviderExecutionJob,
  readExecutionJobState,
} from '../src/execution-store.ts';
import {
  materializeAllLegacyExecution,
  materializeLegacyExecutionInvestigation,
  reconcileLegacyProviderInvocation,
} from '../src/execution-recovery.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  assertProviderInvocationAcceptanceBindingCurrent,
  blindSurveyOutputValidator,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  prepareProviderInvocationAcceptanceBinding,
  readProviderInvocation,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type ProviderLeaseClaim,
} from '../src/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';

test('legacy creation materializes a private canonical execution aggregate with revision CAS', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-durable-store-1',
      1,
      'investigation-durable-store',
    );
    const record = createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-durable-store',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T08:00:00.000Z',
    });
    const projection = projectProviderInvocationExecution({ record, request });
    const stored = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(stored);
    assert.equal(stored.revision, 0);
    assert.deepEqual(stored.workflow, projection.workflow);
    assert.equal(stored.job.jobId, projection.job.jobId);
    assert.equal(stored.attempts[0]!.attemptId, projection.attempt.attemptId);
    assert.deepEqual(stored.results, []);
    assert.equal(stored.legacyProjection.completeHistory, true);
    assert.deepEqual(stored.legacyProjection.invocations, [
      {
        invocationId: request.invocationId,
        legacyRevision: 0,
        attemptId: projection.attempt.attemptId,
      },
    ]);

    const stores = executionStorePaths(runtime);
    const statePath = executionJobStatePath(runtime, projection.job.jobId);
    assert.equal(fs.statSync(stores.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(stores.jobs).mode & 0o777, 0o700);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.throws(
      () =>
        materializeLegacyProviderExecutionJob(runtime, [{ record, request }], {
          expectedRevision: 1,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_CAS_MISMATCH'),
    );

    const canonicalBytes = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, canonicalBytes.trimEnd(), 'utf8');
    assert.throws(
      () => readExecutionJobState(runtime, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );
    fs.writeFileSync(statePath, canonicalBytes, 'utf8');
    const withUnknownField = {
      ...(JSON.parse(canonicalBytes) as Record<string, unknown>),
      unknown: true,
    };
    fs.writeFileSync(statePath, `${canonicalJson(withUnknownField)}\n`, 'utf8');
    assert.throws(
      () => readExecutionJobState(runtime, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable result CAS keeps the first completion and records the loser as late-duplicate', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const requests = [1, 2].map((attempt) =>
      createRequest(
        repository,
        manifest,
        `invocation-durable-race-${attempt}`,
        attempt,
        'investigation-durable-race',
      ),
    );
    for (const [index, request] of requests.entries()) {
      createDirectProviderInvocation(repository, runtime, {
        investigationId: 'investigation-durable-race',
        changeId: CHANGE_ID,
        attempt: index + 1,
        manifest,
        request,
        createdAt: `2026-08-03T09:0${index}:00.000Z`,
      });
    }
    const claims = requests.map((request, index) =>
      claimProviderInvocation(runtime, request.invocationId, {
        workerId: `worker-race-${index + 1}`,
        leaseDurationMs: request.limits.timeoutMs,
        now: `2026-08-03T09:1${index + 8}:00.000Z`,
      }),
    );

    completeClaim(
      runtime,
      requests[1]!,
      claims[1]!,
      '2026-08-03T09:20:00.000Z',
    );
    completeClaim(
      runtime,
      requests[0]!,
      claims[0]!,
      '2026-08-03T09:21:00.000Z',
    );

    const projection = projectProviderInvocationExecution({
      record: readProviderInvocation(runtime, requests[0]!.invocationId),
      request: requests[0]!,
    });
    const stored = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(stored);
    const firstAttempt = stored.attempts.find(
      ({ legacyInvocation }) =>
        legacyInvocation?.invocationId === requests[0]!.invocationId,
    );
    const secondAttempt = stored.attempts.find(
      ({ legacyInvocation }) =>
        legacyInvocation?.invocationId === requests[1]!.invocationId,
    );
    assert.ok(firstAttempt);
    assert.ok(secondAttempt);
    assert.equal(stored.job.acceptedAttemptId, secondAttempt.attemptId);
    assert.equal(stored.job.status, 'succeeded');
    assert.equal(secondAttempt.status, 'succeeded');
    assert.equal(firstAttempt.status, 'late-duplicate');
    assert.equal(firstAttempt.retention, 'debug');
    assert.deepEqual(
      stored.results.map(({ attemptId, acceptance }) => ({
        attemptId,
        acceptance,
      })),
      [
        { attemptId: firstAttempt.attemptId, acceptance: 'late-duplicate' },
        { attemptId: secondAttempt.attemptId, acceptance: 'accepted' },
      ],
    );
    const inspection = inspectExecutionJob(repository, stored.job.jobId);
    assert.equal(inspection.acceptedAttemptId, secondAttempt.attemptId);
    assert.equal(inspection.attempts[0]!.status, 'late-duplicate');
    assert.equal(inspection.attempts[1]!.status, 'succeeded');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy provider history can be migrated after the durable aggregate is absent', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-durable-migration-1',
      1,
      'investigation-durable-migration',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-durable-migration',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T10:00:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-migration',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T10:01:00.000Z',
    });
    completeClaim(runtime, request, claim, '2026-08-03T10:02:00.000Z');
    const record = readProviderInvocation(runtime, request.invocationId);
    const jobId = projectProviderInvocationExecution({ record, request }).job
      .jobId;
    const storeRoot = executionStorePaths(runtime).root;
    fs.rmSync(storeRoot, { recursive: true, force: true });
    assert.equal(readExecutionJobState(runtime, jobId), null);

    const migrated = materializeLegacyProviderExecutionJob(runtime, [
      {
        record,
        request: readProviderInvocationRequest(runtime, request.invocationId),
      },
    ]);
    assert.equal(migrated.revision, 0);
    assert.equal(
      migrated.job.acceptedAttemptId,
      migrated.attempts[0]!.attemptId,
    );
    assert.equal(migrated.attempts[0]!.status, 'succeeded');
    assert.equal(migrated.results[0]!.acceptance, 'accepted');
    assert.deepEqual(readExecutionJobState(runtime, jobId), migrated);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('store-only enumeration and explicit scoped materialization are safe and idempotent', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const fixtures = [
      {
        investigationId: 'investigation-materialize-one',
        invocationId: 'invocation-materialize-one',
      },
      {
        investigationId: 'investigation-materialize-two',
        invocationId: 'invocation-materialize-two',
      },
    ];
    for (const fixture of fixtures) {
      const request = createRequest(
        repository,
        manifest,
        fixture.invocationId,
        1,
        fixture.investigationId,
      );
      createDirectProviderInvocation(repository, runtime, {
        investigationId: fixture.investigationId,
        changeId: CHANGE_ID,
        attempt: 1,
        manifest,
        request,
        createdAt: '2026-08-03T10:30:00.000Z',
      });
    }
    assert.equal(listExecutionJobStates(runtime).length, 2);
    fs.rmSync(executionStorePaths(runtime).root, {
      recursive: true,
      force: true,
    });
    assert.deepEqual(listExecutionJobStates(runtime), []);

    const scoped = materializeLegacyExecutionInvestigation(
      runtime,
      fixtures[0]!.investigationId,
    );
    assert.equal(scoped.scope.kind, 'investigation');
    assert.equal(scoped.jobs.length, 1);
    assert.equal(scoped.jobs[0]!.changed, true);
    assert.equal(listExecutionJobStates(runtime).length, 1);

    const all = materializeAllLegacyExecution(runtime);
    assert.equal(all.scope.kind, 'repository');
    assert.equal(all.jobs.length, 2);
    assert.equal(all.jobs.filter(({ changed }) => changed).length, 1);
    assert.equal(all.jobs.filter(({ changed }) => !changed).length, 1);
    assert.equal(listExecutionJobStates(runtime).length, 2);
    const replay = materializeAllLegacyExecution(runtime);
    assert.deepEqual(
      replay.jobs.map(({ changed }) => changed),
      [false, false],
    );

    const unexpected = path.join(
      executionStorePaths(runtime).jobs,
      'unexpected.json',
    );
    fs.writeFileSync(unexpected, '{}\n', { mode: 0o600 });
    assert.throws(
      () => listExecutionJobStates(runtime),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('recovery repairs a legacy lease after durable acceptance crash exactly once and rejects divergent state', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-acceptance-crash-window',
      1,
      'investigation-acceptance-crash-window',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-acceptance-crash-window',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T10:45:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-acceptance-crash-window',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T10:46:00.000Z',
    });
    assert.throws(
      () =>
        completeProviderInvocation(runtime, request.invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          outcome: providerOutcome(request),
          now: '2026-08-03T10:47:00.000Z',
          simulateCrashAfterExecutionAcceptance: true,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_COMPLETION_SIMULATED_CRASH'),
    );
    const leased = readProviderInvocation(runtime, request.invocationId);
    assert.equal(leased.state, 'leased');
    const projection = projectProviderInvocationExecution({
      record: leased,
      request,
    });
    const accepted = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(accepted);
    assert.equal(accepted.job.acceptedAttemptId, projection.attempt.attemptId);
    assert.equal(accepted.results[0]!.acceptance, 'accepted');

    const statePath = path.join(
      runtime.invocations,
      request.invocationId,
      'state.json',
    );
    const leasedBytes = fs.readFileSync(statePath, 'utf8');
    const divergent = {
      ...leased,
      revision: leased.revision + 1,
      state: 'failed' as const,
      lease: null,
      result: null,
      failure: {
        kind: 'retryable' as const,
        code: 'PROVIDER_PROCESS_CRASH',
        message: 'A conflicting terminal state won the legacy CAS.',
      },
      updatedAt: '2026-08-03T10:47:01.000Z',
    };
    const divergentBytes = `${canonicalJson(divergent)}\n`;
    fs.writeFileSync(statePath, divergentBytes, 'utf8');
    assert.throws(
      () =>
        reconcileLegacyProviderInvocation(runtime, {
          invocationId: request.invocationId,
          expectedExecutionRevision: accepted.revision,
          expectedLegacyRevision: leased.revision,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_COMPLETION_RECOVERY_CONFLICT'),
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), divergentBytes);
    fs.writeFileSync(statePath, leasedBytes, 'utf8');

    const recovered = reconcileLegacyProviderInvocation(runtime, {
      invocationId: request.invocationId,
      expectedExecutionRevision: accepted.revision,
      expectedLegacyRevision: leased.revision,
    });
    const succeeded = readProviderInvocation(runtime, request.invocationId);
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.revision, leased.revision + 1);
    assert.equal(
      succeeded.result?.outputDigest,
      accepted.results[0]!.outputDigest.replace(/^sha256:/u, ''),
    );
    assert.equal(
      recovered.state.job.acceptedAttemptId,
      projection.attempt.attemptId,
    );
    assert.equal(recovered.state.reconciliationReceipts.length, 1);

    const replay = reconcileLegacyProviderInvocation(runtime, {
      invocationId: request.invocationId,
      expectedExecutionRevision: accepted.revision,
      expectedLegacyRevision: leased.revision,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, recovered.receipt);
    assert.deepEqual(
      readProviderInvocation(runtime, request.invocationId),
      succeeded,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reconciliation repairs a provider-write crash once, emits one receipt, and preserves the winner', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-reconciliation-crash',
      1,
      'investigation-reconciliation-crash',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-reconciliation-crash',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T11:00:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-reconciliation-crash',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T11:01:00.000Z',
    });
    const projection = projectProviderInvocationExecution({
      record: claim.record,
      request,
    });
    const accepted = acceptLegacyProviderAttemptResult(runtime, {
      entries: [{ record: claim.record, request }],
      attemptId: projection.attempt.attemptId,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      outputDigest: evaluateProviderProcess(
        request,
        providerOutcome(request),
        blindSurveyOutputValidator(request),
      ).outputDigest,
      completedAt: '2026-08-03T11:02:00.000Z',
    });
    const result = evaluateProviderProcess(
      request,
      providerOutcome(request),
      blindSurveyOutputValidator(request),
    );
    const divergentOutcome = providerOutcome(request);
    const divergentEnvelope = JSON.parse(divergentOutcome.stdout) as {
      output: { terms: Array<{ kind: string; value: string }> };
    };
    divergentEnvelope.output.terms = [
      { kind: 'symbol', value: 'DivergentDurableResult' },
    ];
    const divergentResult = evaluateProviderProcess(
      request,
      { ...divergentOutcome, stdout: JSON.stringify(divergentEnvelope) },
      blindSurveyOutputValidator(request),
    );
    const succeeded = {
      ...claim.record,
      revision: claim.record.revision + 1,
      state: 'succeeded' as const,
      lease: null,
      result,
      failure: null,
      updatedAt: '2026-08-03T11:02:00.000Z',
    };
    fs.writeFileSync(
      path.join(runtime.invocations, request.invocationId, 'state.json'),
      `${canonicalJson({ ...succeeded, result: divergentResult })}\n`,
      'utf8',
    );
    assert.throws(
      () =>
        reconcileLegacyProviderInvocation(runtime, {
          invocationId: request.invocationId,
          expectedExecutionRevision: accepted.state.revision,
          expectedLegacyRevision: succeeded.revision,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_PROJECTION_CONFLICT'),
    );
    fs.writeFileSync(
      path.join(runtime.invocations, request.invocationId, 'state.json'),
      `${canonicalJson(succeeded)}\n`,
      'utf8',
    );
    assert.equal(
      readProviderInvocation(runtime, request.invocationId).revision,
      succeeded.revision,
    );
    assert.throws(
      () => inspectExecutionJob(repository, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_JOB_CONFLICT'),
    );
    assert.throws(
      () =>
        reconcileLegacyProviderInvocation(runtime, {
          invocationId: request.invocationId,
          expectedExecutionRevision: accepted.state.revision + 1,
          expectedLegacyRevision: succeeded.revision,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_CAS_MISMATCH'),
    );

    const reconciled = reconcileLegacyProviderInvocation(runtime, {
      invocationId: request.invocationId,
      expectedExecutionRevision: accepted.state.revision,
      expectedLegacyRevision: succeeded.revision,
    });
    assert.equal(reconciled.replayed, false);
    assert.equal(
      reconciled.state.job.acceptedAttemptId,
      accepted.state.job.acceptedAttemptId,
    );
    assert.equal(
      reconciled.state.legacyProjection.invocations[0]!.legacyRevision,
      succeeded.revision,
    );
    assert.equal(
      reconciled.receipt.acceptedAttemptId,
      projection.attempt.attemptId,
    );
    assert.equal(
      reconciled.receipt.resultingExecutionRevision,
      accepted.state.revision + 1,
    );
    assert.deepEqual(reconciled.receipt.reconciledInvocationIds, [
      request.invocationId,
    ]);
    assert.equal(
      inspectExecutionJob(repository, projection.job.jobId).acceptedAttemptId,
      projection.attempt.attemptId,
    );

    const replay = reconcileLegacyProviderInvocation(runtime, {
      invocationId: request.invocationId,
      expectedExecutionRevision: accepted.state.revision,
      expectedLegacyRevision: succeeded.revision,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, reconciled.receipt);
    assert.equal(replay.state.revision, reconciled.state.revision);
    assert.equal(replay.state.reconciliationReceipts.length, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reconciliation rejects a canonical durable semantic divergence', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-reconciliation-divergence',
      1,
      'investigation-reconciliation-divergence',
    );
    const record = createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-reconciliation-divergence',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T12:00:00.000Z',
    });
    const jobId = projectProviderInvocationExecution({ record, request }).job
      .jobId;
    const stored = readExecutionJobState(runtime, jobId);
    assert.ok(stored);
    const divergentContext = `sha256:${'f'.repeat(64)}`;
    const divergent = {
      ...stored,
      workflow: { ...stored.workflow, contextDigest: divergentContext },
      job: {
        ...stored.job,
        contextDigest: divergentContext,
        requestDigest: `sha256:${'e'.repeat(64)}`,
        semanticSpec: {
          ...stored.job.semanticSpec,
          contextDigest: divergentContext,
        },
      },
      attempts: stored.attempts.map((attempt) => ({
        ...attempt,
        contextDigest: divergentContext,
      })),
    };
    fs.writeFileSync(
      executionJobStatePath(runtime, jobId),
      `${canonicalJson(divergent)}\n`,
      'utf8',
    );
    assert.ok(readExecutionJobState(runtime, jobId));
    assert.throws(
      () =>
        reconcileLegacyProviderInvocation(runtime, {
          invocationId: request.invocationId,
          expectedExecutionRevision: stored.revision,
          expectedLegacyRevision: record.revision,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_PROJECTION_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('validator failure reloads as a bounded repair Attempt and missing durable lineage fails closed', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const investigationId = 'investigation-durable-repair';
    const firstRequest = createRequest(
      repository,
      manifest,
      'invocation-durable-repair-1',
      1,
      investigationId,
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request: firstRequest,
      createdAt: '2026-08-03T13:00:00.000Z',
    });
    const firstClaim = claimProviderInvocation(
      runtime,
      firstRequest.invocationId,
      {
        workerId: 'worker-durable-repair-1',
        leaseDurationMs: firstRequest.limits.timeoutMs,
        now: '2026-08-03T13:01:00.000Z',
      },
    );
    failProviderInvocation(runtime, firstRequest.invocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_NATIVE_OUTPUT_INVALID',
        message: 'Provider output failed full validation.',
      },
      repair: {
        repairKind: 'schema',
        previousOutput: {
          reference: firstRequest.invocationId,
          terms: [],
        },
        validationErrors: [
          {
            path: '/terms',
            code: 'MIN_ITEMS',
            message: 'Expected at least one item.',
          },
        ],
        targetSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
      },
      now: '2026-08-03T13:02:00.000Z',
    });

    const secondRequest = createRepairRequest(
      firstRequest,
      'invocation-durable-repair-2',
    );
    const second = createDirectProviderInvocation(repository, runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 2,
      manifest,
      request: secondRequest,
      createdAt: '2026-08-03T13:03:00.000Z',
    });
    const jobId = projectProviderInvocationExecution({
      record: second,
      request: secondRequest,
    }).job.jobId;
    const reloaded = readExecutionJobState(runtime, jobId);
    assert.ok(reloaded);
    assert.equal(reloaded.job.repairAttemptCount, 1);
    assert.equal(reloaded.attempts[1]!.retryMode, 'repair');
    assert.equal(
      reloaded.attempts[1]!.retryOf,
      reloaded.attempts[0]!.attemptId,
    );
    assert.equal(
      reloaded.attempts[1]!.repairContext?.validationErrors[0]?.path,
      '/terms',
    );
    assert.equal(
      reloaded.attempts[1]!.repairContext?.instruction,
      'return-complete-replacement-object',
    );

    const lineagePath = path.join(
      runtime.invocations,
      secondRequest.invocationId,
      'repair-lineage.json',
    );
    const durableLineage = fs.readFileSync(lineagePath, 'utf8');
    fs.unlinkSync(lineagePath);
    assert.throws(
      () =>
        claimProviderInvocation(runtime, secondRequest.invocationId, {
          workerId: 'worker-missing-repair-lineage',
          leaseDurationMs: secondRequest.limits.timeoutMs,
          now: '2026-08-03T13:04:00.000Z',
        }),
      (error) => isWorkflowError(error, 'PROVIDER_REPAIR_LINEAGE_REQUIRED'),
    );
    assert.equal(
      readProviderInvocation(runtime, secondRequest.invocationId).state,
      'prepared',
    );
    assert.throws(
      () =>
        materializeLegacyProviderExecutionJob(runtime, [
          {
            record: readProviderInvocation(runtime, firstRequest.invocationId),
            request: firstRequest,
          },
          { record: second, request: secondRequest },
        ]),
      (error) => isWorkflowError(error, 'PROVIDER_REPAIR_LINEAGE_REQUIRED'),
    );
    assert.equal(
      readExecutionJobState(runtime, jobId)?.attempts[1]?.retryMode,
      'repair',
    );
    fs.writeFileSync(lineagePath, durableLineage, { mode: 0o600 });
    assert.equal(
      materializeLegacyProviderExecutionJob(runtime, [
        {
          record: readProviderInvocation(runtime, firstRequest.invocationId),
          request: firstRequest,
        },
        { record: second, request: secondRequest },
      ]).attempts[1]?.retryMode,
      'repair',
    );

    claimProviderInvocation(runtime, secondRequest.invocationId, {
      workerId: 'worker-repair-authority-binding',
      leaseDurationMs: secondRequest.limits.timeoutMs,
      now: '2026-08-03T13:05:00.000Z',
    });
    const acceptance = prepareProviderInvocationAcceptanceBinding(
      runtime,
      secondRequest.invocationId,
    );
    assert.doesNotThrow(() =>
      assertProviderInvocationAcceptanceBindingCurrent(runtime, acceptance),
    );
    const parsedLineage = JSON.parse(durableLineage) as Record<string, unknown>;
    const changedLineagePayload: Record<string, unknown> = {
      ...parsedLineage,
      createdAt: '2026-08-03T13:03:30.000Z',
    };
    delete changedLineagePayload.lineageDigest;
    const changedLineage = {
      ...changedLineagePayload,
      lineageDigest: `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(changedLineagePayload))
        .digest('hex')}`,
    };
    fs.writeFileSync(lineagePath, `${canonicalJson(changedLineage)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () =>
        assertProviderInvocationAcceptanceBindingCurrent(runtime, acceptance),
      (error) => isWorkflowError(error, 'PROVIDER_REPAIR_AUTHORITY_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createManifest(repository: string): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: CHANGE_ID,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Exercise the durable execution store.',
      explicitPaths: ['packages/workflow-engine/src/execution-store.ts'],
      explicitSymbols: ['readExecutionJobState'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'How does the execution engine persist one accepted Attempt result?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
  attempt: number,
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
    limits: {
      timeoutMs: 300_000 + (attempt - 1) * 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  });
}

function createDirectProviderInvocation(
  repository: string,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  input: Parameters<typeof createProviderInvocation>[1],
) {
  storeProviderExecutionPolicySnapshot(
    runtime,
    input.request,
    loadAiAdapterPolicy(repository),
  );
  return createProviderInvocation(runtime, input);
}

function createRepairRequest(
  previous: ProviderInvocationRequest,
  invocationId: string,
): ProviderInvocationRequest {
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: previous.purpose,
    providerId: previous.providerId,
    roleAssignment: previous.roleAssignment,
    capabilityProfile: previous.capabilityProfile,
    repositoryId: previous.repositoryId,
    baseCommit: previous.baseCommit,
    baseTree: previous.baseTree,
    targetDigest: previous.targetDigest,
    inputManifestDigest: previous.inputManifestDigest,
    authorizationNodeId: previous.authorizationNodeId,
    writeAllowedPaths: [],
    outputSchema: previous.outputSchema,
    evaluatorVersion: previous.evaluatorVersion,
    policyDigest: previous.policyDigest,
    limits: previous.limits,
  });
}

function completeClaim(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
  claim: ProviderLeaseClaim,
  now: string,
): void {
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
    now,
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
        terms: [{ kind: 'symbol', value: 'DurableExecutionStore' }],
      },
    }),
    stderr: '',
  };
}
