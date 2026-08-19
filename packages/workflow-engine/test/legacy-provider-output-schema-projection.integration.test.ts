import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { listExecutionJobs } from '../src/runtime/provider-execution/execution-runtime.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderOutputSchema,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  providerExecutionPolicySnapshotPath,
  providerInvocationManifestDigest,
  readProviderInvocation,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const INVESTIGATION_ID = 'investigation-output-schema-generation';
const CHANGE_ID = 'demo-change';
const INVOCATION_ID = 'invocation-output-schema-attempt-1';
const CREATED_AT = '2026-07-25T16:00:00.000Z';
const COMPLETED_AT = '2026-07-25T16:02:00.000Z';

/**
 * The blind-survey output schema identity as this repository's oldest surviving
 * records carry it. Only the digest differs from the current constant: the id
 * and version are the same code-owned identity, which is exactly what separates
 * a record whose schema body was edited afterwards from a foreign one.
 */
const SUPERSEDED_OUTPUT_SCHEMA: ProviderOutputSchema = {
  id: BLIND_SURVEY_OUTPUT_SCHEMA.id,
  version: BLIND_SURVEY_OUTPUT_SCHEMA.version,
  digest: '69953ef03f9d9a49a669c1235edc44f0ff68bfe49a2265a050b6c31826947721',
};

const FOREIGN_OUTPUT_SCHEMA: ProviderOutputSchema = {
  id: 'not-a-code-owned.output',
  version: 1,
  digest: 'a'.repeat(64),
};

test('a durable result written against a superseded code-owned schema still reads', () => {
  // The schema body changed after these records were written, so re-judging
  // their output against today's grammar is impossible: that grammar is gone
  // from the code. Refusing them does not fail one read — the legacy scan is
  // fail-closed for the whole store, so a single aged record makes `job list`
  // and `job status` unusable for every Job in the repository.
  const fixture = prepareInvocation(SUPERSEDED_OUTPUT_SCHEMA);
  try {
    const record = readProviderInvocation(fixture.runtime, INVOCATION_ID);
    assert.equal(record.state, 'succeeded');
    assert.equal(record.requestDigest, fixture.request.requestDigest);

    const jobs = listExecutionJobs(fixture.repository);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.attempts.length, 1);
    assert.equal(jobs[0]?.results.length, 1);
    assert.equal(jobs[0]?.results[0]?.invocationId, INVOCATION_ID);
  } finally {
    fixture.dispose();
  }
});

test('the projection reports the superseded generation instead of hiding it', () => {
  // Skipping a check silently would make an unjudgeable result indistinguishable
  // from one today's grammar accepted. The reader has to be able to tell which
  // results were re-validated and which only kept their original binding.
  const superseded = prepareInvocation(SUPERSEDED_OUTPUT_SCHEMA);
  try {
    assert.equal(
      listExecutionJobs(superseded.repository)[0]?.results[0]?.outputSchema,
      'legacy-superseded',
    );
  } finally {
    superseded.dispose();
  }

  const current = prepareInvocation(BLIND_SURVEY_OUTPUT_SCHEMA);
  try {
    assert.equal(
      listExecutionJobs(current.repository)[0]?.results[0]?.outputSchema,
      'code-owned',
    );
  } finally {
    current.dispose();
  }
});

test('a superseded generation still binds its stored output exactly', () => {
  // The tolerance drops the vanished grammar check and nothing else. The output
  // digest recomputation still fixes the exact output bytes under the stored
  // schema id and version, so an edited output is rejected as it always was.
  const fixture = prepareInvocation(SUPERSEDED_OUTPUT_SCHEMA);
  try {
    const statePath = path.join(
      fixture.runtime.invocations,
      INVOCATION_ID,
      'state.json',
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      result: { output: { terms: Array<{ kind: string; value: string }> } };
    };
    state.result.output.terms = [{ kind: 'symbol', value: 'Substituted' }];
    fs.writeFileSync(statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });

    assert.throws(
      () => readProviderInvocation(fixture.runtime, INVOCATION_ID),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a schema this engine never owned stays unsupported', () => {
  // An unrecognized id is not evidence of age. No writer of this engine ever
  // emitted it, so tolerating it would admit a foreign output contract rather
  // than an older generation of a code-owned one.
  const fixture = prepareInvocation(FOREIGN_OUTPUT_SCHEMA);
  try {
    assert.throws(
      () => readProviderInvocation(fixture.runtime, INVOCATION_ID),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a superseded generation cannot be completed anew', () => {
  // Reading an aged record is not permission to run against a schema the code
  // no longer owns. Completion still needs a validator bound to the current
  // generation, so the write path keeps rejecting what the read path tolerates.
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      SUPERSEDED_OUTPUT_SCHEMA,
    );
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId: INVESTIGATION_ID,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: CREATED_AT,
    });
    const claim = claimProviderInvocation(runtime, INVOCATION_ID, {
      workerId: `worker-${INVOCATION_ID}`,
      leaseDurationMs: request.limits.timeoutMs,
      now: CREATED_AT,
    });
    assert.throws(
      () =>
        completeProviderInvocation(runtime, INVOCATION_ID, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          outcome: providerOutcome(request),
          now: COMPLETED_AT,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

/**
 * Record one completed invocation and then bind it to `outputSchema`.
 *
 * The completion runs against the current code-owned schema so every durable
 * byte — the result, its output digest, and the policy snapshot — is written by
 * the real writer rather than assembled by hand. Rebinding afterwards is the
 * only way to reproduce a record whose schema generation has since moved on:
 * the writer of the day wrote whatever constant the code then held, and no
 * present-day writer can be asked to produce it.
 */
function prepareInvocation(outputSchema: ProviderOutputSchema) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const manifest = createManifest(repository);
  const policy = loadAiAdapterPolicy(repository);
  const written = createRequest(
    repository,
    manifest,
    BLIND_SURVEY_OUTPUT_SCHEMA,
  );
  storeProviderExecutionPolicySnapshot(runtime, written, policy);
  createProviderInvocation(runtime, {
    investigationId: INVESTIGATION_ID,
    changeId: CHANGE_ID,
    attempt: 1,
    manifest,
    request: written,
    createdAt: CREATED_AT,
  });
  const claim = claimProviderInvocation(runtime, INVOCATION_ID, {
    workerId: `worker-${INVOCATION_ID}`,
    leaseDurationMs: written.limits.timeoutMs,
    now: CREATED_AT,
  });
  completeProviderInvocation(runtime, INVOCATION_ID, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(written),
    now: COMPLETED_AT,
  });

  const request = createRequest(repository, manifest, outputSchema);
  if (request.requestDigest !== written.requestDigest) {
    const directory = path.join(runtime.invocations, INVOCATION_ID);
    fs.writeFileSync(
      path.join(directory, 'request.json'),
      `${canonicalJson(request)}\n`,
      { mode: 0o600 },
    );
    const statePath = path.join(directory, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      requestDigest: string;
      result: { requestDigest: string };
    };
    state.requestDigest = request.requestDigest;
    state.result.requestDigest = request.requestDigest;
    fs.writeFileSync(statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });
    // The snapshot digests the request it was taken for, so it is re-taken
    // rather than patched: the policy axis stays current and this fixture
    // exercises the output schema alone.
    fs.rmSync(providerExecutionPolicySnapshotPath(runtime, INVOCATION_ID), {
      force: true,
    });
    storeProviderExecutionPolicySnapshot(runtime, request, policy);
  }

  return {
    repository,
    runtime,
    request,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
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
      summary: 'Inspect a legacy provider result through one stable Job.',
      explicitPaths: [
        'packages/workflow-engine/src/provider-invocation-store.ts',
      ],
      explicitSymbols: ['readProviderInvocation'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'How should an evolved output schema keep its own history readable?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  outputSchema: ProviderOutputSchema,
): ProviderInvocationRequest {
  const targetDigest = blindSurveyIntentDigest(manifest);
  return createProviderInvocationRequest({
    invocationId: INVOCATION_ID,
    nonce: `${INVOCATION_ID}-nonce-000000`,
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
    outputSchema,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: loadAiAdapterPolicy(repository).digest,
    limits: { timeoutMs: 300_000, aggregateOutputBytes: 1_048_576 },
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
        terms: [{ kind: 'symbol', value: 'ProviderOutputSchema' }],
      },
    }),
    stderr: '',
  };
}
