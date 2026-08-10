import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { materializeLegacyExecutionInvestigation } from '../src/execution-recovery.ts';
import {
  executionStorePaths,
  readExecutionJobState,
} from '../src/execution-store.ts';
import { listExecutionJobs } from '../src/execution-runtime.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
} from '../src/provider-invocation-store.ts';
import { createFixtureRepository, git } from './fixture.ts';

const CHANGE_ID = 'policy-lineage-gap';
const INVESTIGATION_ID = 'investigation-policy-lineage-gap';

test('durable materialization preserves observed policy changes across an incomplete legacy ordinal gap', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const requests = [
      createRequest(
        repository,
        manifest,
        'invocation-policy-lineage-gap-1',
        300_000,
      ),
      createRequest(
        repository,
        manifest,
        'invocation-policy-lineage-gap-3',
        600_000,
      ),
    ];

    requests.forEach((request, index) => {
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId: INVESTIGATION_ID,
        changeId: CHANGE_ID,
        attempt: index + 1,
        manifest,
        request,
        createdAt: `2026-08-10T02:0${index}:00.000Z`,
      });
      const claim = claimProviderInvocation(runtime, request.invocationId, {
        workerId: `worker-policy-lineage-gap-${index + 1}`,
        leaseDurationMs: request.limits.timeoutMs,
        now: `2026-08-10T02:0${index}:10.000Z`,
      });
      failProviderInvocation(runtime, request.invocationId, {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          code: 'PROVIDER_TIMEOUT',
          kind: 'retryable',
          message: 'Provider invocation timed out.',
        },
        now: `2026-08-10T02:0${index}:20.000Z`,
      });
    });

    rewriteRecordedAttempt(runtime, requests[1]!.invocationId, 3);
    fs.rmSync(executionStorePaths(runtime).root, {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(runtime.root, 'provider-invocation-supersessions'), {
      recursive: true,
      force: true,
    });

    const before = listExecutionJobs(repository)[0]!;
    assert.equal(before.attemptNumbering, 'legacy-renumbered');
    assert.equal(before.attempts[1]!.retryMode, 'execution-policy-change');
    assert.deepEqual(before.attempts[1]!.changedFields, [
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);

    materializeLegacyExecutionInvestigation(runtime, INVESTIGATION_ID);

    const durable = readExecutionJobState(runtime, before.job.jobId);
    assert.ok(durable);
    assert.equal(durable.legacyProjection.completeHistory, false);
    assert.deepEqual(
      durable.attempts.map(({ attemptNumber }) => attemptNumber),
      [1, 3],
    );
    assert.equal(durable.attempts[1]!.retryOf, null);
    assert.equal(durable.attempts[1]!.retryMode, 'execution-policy-change');
    assert.deepEqual(durable.attempts[1]!.changedFields, [
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);

    const after = listExecutionJobs(repository)[0]!;
    assert.equal(after.attempts[1]!.retryOf, null);
    assert.equal(after.attempts[1]!.retryMode, 'execution-policy-change');
    assert.deepEqual(after.attempts[1]!.changedFields, [
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function rewriteRecordedAttempt(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  invocationId: string,
  attempt: number,
): void {
  const statePath = path.join(runtime.invocations, invocationId, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    attempt: number;
  };
  state.attempt = attempt;
  fs.writeFileSync(statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });
}

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
      summary: 'Preserve legacy provider execution-policy lineage.',
      explicitPaths: ['packages/workflow-engine/src/execution-store.ts'],
      explicitSymbols: ['materializeLegacyProviderExecutionJob'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'How does durable materialization preserve policy changes when a legacy ordinal is missing?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
  timeoutMs: number,
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
      sessionId: `provider-session-${INVESTIGATION_ID}`,
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
    limits: { timeoutMs, aggregateOutputBytes: 1_048_576 },
  });
}
