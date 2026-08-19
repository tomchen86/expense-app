import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { executionStorePaths } from '../src/runtime/storage-journal/execution-store.ts';
import { listExecutionJobs } from '../src/runtime/provider-execution/execution-runtime.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';

test('a group whose retries each recorded attempt one still aggregates', () => {
  // A legacy retry opened a fresh invocation and left it numbered 1, so a Job
  // can hold two attempt-1 records. Refusing that does not spoil one Job: the
  // scan is fail-closed for the whole store, so two such records anywhere make
  // job list and job status unusable for every Job in the repository.
  const fixture = prepareGroup('attempt-numbering-duplicated', [
    { suffix: '1', attempt: 1, completedAt: '2026-07-26T00:42:06.850Z' },
    { suffix: '2', attempt: 1, completedAt: '2026-07-26T01:08:43.437Z' },
  ]);
  try {
    const jobs = listExecutionJobs(fixture.repository);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.attempts.length, 2);
  } finally {
    fixture.dispose();
  }
});

test('the renumbering is named, and the attempts chain in observed order', () => {
  // Tolerating the numbering must not mean inventing history: the projected
  // order has to be the order the records were observed in, and the Job has to
  // say its ordinals are the reader's rather than the writer's.
  const fixture = prepareGroup('attempt-numbering-named', [
    { suffix: '1', attempt: 1, completedAt: '2026-07-26T00:42:06.850Z' },
    { suffix: '2', attempt: 1, completedAt: '2026-07-26T01:08:43.437Z' },
  ]);
  try {
    const [job] = listExecutionJobs(fixture.repository);
    assert.equal(job?.attemptNumbering, 'legacy-renumbered');
    const [first, second] = job!.attempts;
    assert.equal(first?.retryOf, null);
    assert.equal(second?.retryOf, first?.attemptId);
    assert.equal(
      Date.parse(second!.updatedAt) >= Date.parse(first!.updatedAt),
      true,
    );
  } finally {
    fixture.dispose();
  }
});

test('a group the writer numbered itself is the unremarkable case', () => {
  // The tolerance must not swallow the ordinary shape: a Job whose records
  // carry 1..N is exactly what the current writer produces, and it has to keep
  // saying so.
  const fixture = prepareGroup('attempt-numbering-recorded', [
    { suffix: '1', attempt: 1, completedAt: '2026-07-26T00:42:06.850Z' },
    { suffix: '2', attempt: 2, completedAt: '2026-07-26T01:08:43.437Z' },
  ]);
  try {
    const [job] = listExecutionJobs(fixture.repository);
    assert.equal(job?.attemptNumbering, 'recorded');
    assert.equal(job?.attempts.length, 2);
  } finally {
    fixture.dispose();
  }
});

test('records that cannot be ordered in time stay a conflict', () => {
  // Renumbering is only sound because the projected order is the observed
  // order. When the records disagree about which ran first there is no order to
  // project, so the Job must still fail closed rather than pick one.
  const fixture = prepareGroup('attempt-numbering-unordered', [
    { suffix: '1', attempt: 1, completedAt: '2026-07-26T01:08:43.437Z' },
    { suffix: '2', attempt: 1, completedAt: '2026-07-26T00:42:06.850Z' },
  ]);
  try {
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error: unknown) =>
        isWorkflowError(error, 'EXECUTION_RUNTIME_JOB_CONFLICT'),
    );
  } finally {
    fixture.dispose();
  }
});

function prepareGroup(
  name: string,
  members: Array<{ suffix: string; attempt: number; completedAt: string }>,
) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  // One manifest for the whole group: the legacy Job identity is the
  // investigation, the stage and the manifest digest, so sharing it is what
  // puts these records in one Job at all.
  const manifest = createManifest(repository, investigationId);
  try {
    members.forEach((member, index) => {
      const invocationId = `invocation-${name}-${member.suffix}`;
      const request = createRequest(
        repository,
        manifest,
        invocationId,
        investigationId,
      );
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      // Written with the numbering the current writer insists on, because it
      // refuses to open a second attempt 1 in one group at all -- which is the
      // very reason a record carrying one can only be older than that rule.
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt: index + 1,
        manifest,
        request,
        createdAt: new Date(
          Date.parse(member.completedAt) - 60_000,
        ).toISOString(),
      });
      failInvocation(runtime, request, member.completedAt);
      if (member.attempt !== index + 1) {
        rewriteRecordedAttempt(runtime, invocationId, member.attempt);
      }
    });
    // These records predate durable execution state and supersession edges,
    // which is exactly why they are read through the legacy aggregation at all:
    // listExecutionJobs takes that path only for a Job with no durable state.
    // The current writer creates both, and a supersession edge would still
    // assert the retry ordinal this fixture just restated, so reproducing the
    // aged shape means removing what the writer added around the record.
    for (const directory of [
      executionStorePaths(runtime).root,
      path.join(runtime.root, 'provider-invocation-supersessions'),
    ]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    return {
      repository,
      runtime,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Restate the attempt ordinal a record carries. The store is the only writer of
 * this field and it now numbers a group 1..N, so reproducing a legacy record
 * means editing the state it already wrote rather than asking it to write a
 * shape it refuses.
 */
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
      summary: `Read attempt numbering for ${investigationId}.`,
      explicitPaths: ['packages/workflow-engine/src/execution-runtime.ts'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'How were these attempts numbered when written?',
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

/**
 * Fail the invocation rather than completing it. The records this reproduces
 * are failed plan-review attempts, and a succeeded one would be materialised
 * into durable execution state, which is a different read path with its own
 * stricter guard.
 */
function failInvocation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
  failedAt: string,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(failedAt) - 30_000).toISOString(),
  });
  failProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure: {
      code: 'PROVIDER_PROCESS_FAILED',
      kind: 'retryable',
      message: 'Provider invocation failed durably (PROVIDER_PROCESS_FAILED).',
    },
    now: failedAt,
  });
}
