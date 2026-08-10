import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { isWorkflowError } from './fixture.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  readProviderInvocationEvidence,
  recoverProviderInvocationSupersession,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type ProviderInvocationRecord,
} from '../src/provider-invocation-store.ts';
import { listProviderInvocationLifecycleProjections } from '../src/investigation-session-store.ts';
import { createFixtureRepository, git } from './fixture.ts';

const FIRST_CREATED_AT = '2026-08-04T01:00:00.000Z';
const FAILED_AT = '2026-08-04T01:01:00.000Z';
const SECOND_CREATED_AT = '2026-08-04T01:01:01.000Z';

test('replacement invocation publishes one canonical bidirectional superseded-by edge without overwriting predecessor evidence', () => {
  const fixture = createFailedInvocationFixture('bidirectional');
  try {
    const predecessorStatePath = path.join(
      fixture.runtime.invocations,
      fixture.failed.invocationId,
      'state.json',
    );
    const predecessorState = fs.readFileSync(predecessorStatePath, 'utf8');
    const secondRequest = replacementRequest(
      fixture.firstRequest,
      'invocation-supersession-bidirectional-2',
    );
    storeProviderExecutionPolicySnapshot(
      fixture.runtime,
      secondRequest,
      fixture.policy,
    );
    createProviderInvocation(fixture.runtime, {
      investigationId: fixture.failed.investigationId,
      changeId: fixture.failed.changeId,
      attempt: 2,
      manifest: fixture.manifest,
      request: secondRequest,
      createdAt: SECOND_CREATED_AT,
    });

    const predecessor = readProviderInvocationEvidence(
      fixture.runtime,
      fixture.failed.invocationId,
    );
    const successor = readProviderInvocationEvidence(
      fixture.runtime,
      secondRequest.invocationId,
    );
    assert.equal(predecessor.replacementOf, null);
    assert.ok(predecessor.supersededBy);
    assert.ok(successor.replacementOf);
    assert.equal(successor.supersededBy, null);
    assert.equal(
      predecessor.supersededBy.edgeDigest,
      successor.replacementOf.edgeDigest,
    );
    assert.equal(
      predecessor.supersededBy.invocation.invocationId,
      secondRequest.invocationId,
    );
    assert.equal(
      successor.replacementOf.invocation.invocationId,
      fixture.failed.invocationId,
    );
    assert.equal(
      successor.replacementOf.invocation.requestDigest,
      fixture.firstRequest.requestDigest,
    );
    assert.equal(
      successor.replacementOf.invocation.subjectDigest,
      fixture.firstRequest.targetDigest,
    );
    assert.equal(
      successor.replacementOf.invocation.promptDigest,
      digest(fixture.prompt),
    );
    assert.equal(
      successor.replacementOf.invocation.rawOutputDigest,
      digest(fixture.rawOutput),
    );
    assert.equal(
      successor.replacementOf.invocation.semanticOutputDigest,
      digest(canonicalJson(fixture.previousOutput)),
    );
    assert.equal(successor.replacementOf.invocation.terminalStatus, 'failed');
    assert.equal(successor.replacementOf.invocation.terminalAt, FAILED_AT);
    assert.equal(
      fs.readFileSync(predecessorStatePath, 'utf8'),
      predecessorState,
      'publishing the edge must not rewrite predecessor state/evidence',
    );
  } finally {
    fixture.dispose();
  }
});

test('one predecessor cannot fork to two current replacement invocations', () => {
  const fixture = createFailedInvocationFixture('fork');
  try {
    const secondRequest = replacementRequest(
      fixture.firstRequest,
      'invocation-supersession-fork-2a',
    );
    storeProviderExecutionPolicySnapshot(
      fixture.runtime,
      secondRequest,
      fixture.policy,
    );
    createProviderInvocation(fixture.runtime, {
      investigationId: fixture.failed.investigationId,
      changeId: fixture.failed.changeId,
      attempt: 2,
      manifest: fixture.manifest,
      request: secondRequest,
      createdAt: SECOND_CREATED_AT,
    });

    const competing = replacementRequest(
      fixture.firstRequest,
      'invocation-supersession-fork-2b',
    );
    storeProviderExecutionPolicySnapshot(
      fixture.runtime,
      competing,
      fixture.policy,
    );
    assert.throws(
      () =>
        createProviderInvocation(fixture.runtime, {
          investigationId: fixture.failed.investigationId,
          changeId: fixture.failed.changeId,
          attempt: 2,
          manifest: fixture.manifest,
          request: competing,
          createdAt: SECOND_CREATED_AT,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT'),
    );
  } finally {
    fixture.dispose();
  }
});

test('timeout replacement also publishes lineage with honestly unavailable output digests', () => {
  const fixture = createFailedInvocationFixture('timeout', {
    repair: false,
    runtimeEvidence: false,
  });
  try {
    const secondRequest = replacementRequest(
      fixture.firstRequest,
      'invocation-supersession-timeout-2',
    );
    storeProviderExecutionPolicySnapshot(
      fixture.runtime,
      secondRequest,
      fixture.policy,
    );
    createProviderInvocation(fixture.runtime, {
      investigationId: fixture.failed.investigationId,
      changeId: fixture.failed.changeId,
      attempt: 2,
      manifest: fixture.manifest,
      request: secondRequest,
      createdAt: SECOND_CREATED_AT,
    });
    const successor = readProviderInvocationEvidence(
      fixture.runtime,
      secondRequest.invocationId,
    );
    assert.equal(successor.replacementOf?.replacementMode, 'retry');
    assert.equal(successor.replacementOf?.invocation.promptDigest, null);
    assert.equal(successor.replacementOf?.invocation.rawOutputDigest, null);
    assert.equal(
      successor.replacementOf?.invocation.semanticOutputDigest,
      null,
    );
    assert.equal(
      successor.replacementOf?.invocation.failureCode,
      'PROVIDER_TIMEOUT',
    );
  } finally {
    fixture.dispose();
  }
});

test('half-published supersession fails closed and deterministic recovery finishes the same edge', () => {
  const fixture = createFailedInvocationFixture('recovery');
  try {
    const secondRequest = replacementRequest(
      fixture.firstRequest,
      'invocation-supersession-recovery-2',
    );
    storeProviderExecutionPolicySnapshot(
      fixture.runtime,
      secondRequest,
      fixture.policy,
    );
    assert.throws(
      () =>
        createProviderInvocation(fixture.runtime, {
          investigationId: fixture.failed.investigationId,
          changeId: fixture.failed.changeId,
          attempt: 2,
          manifest: fixture.manifest,
          request: secondRequest,
          createdAt: SECOND_CREATED_AT,
          simulateSupersessionCrashAfter: 'predecessor-indexed',
        }),
      (error) =>
        isWorkflowError(
          error,
          'PROVIDER_INVOCATION_SUPERSESSION_SIMULATED_CRASH',
        ),
    );
    for (const invocationId of [
      fixture.failed.invocationId,
      secondRequest.invocationId,
    ]) {
      assert.throws(
        () => readProviderInvocationEvidence(fixture.runtime, invocationId),
        (error) =>
          isWorkflowError(
            error,
            'PROVIDER_INVOCATION_SUPERSESSION_RECOVERY_REQUIRED',
          ),
      );
    }
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );

    const resumed = createProviderInvocation(fixture.runtime, {
      investigationId: fixture.failed.investigationId,
      changeId: fixture.failed.changeId,
      attempt: 2,
      manifest: fixture.manifest,
      request: secondRequest,
      createdAt: SECOND_CREATED_AT,
    });
    assert.equal(resumed.invocationId, secondRequest.invocationId);
    const recovered = recoverProviderInvocationSupersession(
      fixture.runtime,
      secondRequest.invocationId,
      { recoveredAt: '2026-08-04T01:01:03.000Z' },
    );
    assert.equal(recovered.replayed, true);
    const predecessor = readProviderInvocationEvidence(
      fixture.runtime,
      fixture.failed.invocationId,
    );
    const successor = readProviderInvocationEvidence(
      fixture.runtime,
      secondRequest.invocationId,
    );
    assert.equal(
      predecessor.supersededBy?.edgeDigest,
      recovered.edge.edgeDigest,
    );
    assert.equal(
      successor.replacementOf?.edgeDigest,
      recovered.edge.edgeDigest,
    );

    const edgePath = path.join(
      fixture.runtime.root,
      'provider-invocation-supersessions',
      'edges',
      `${recovered.edge.edgeDigest}.json`,
    );
    const originalEdge = fs.readFileSync(edgePath, 'utf8');
    const tamperedEdge = JSON.parse(originalEdge) as Record<string, unknown>;
    tamperedEdge.jobId = 'tampered-provider-job';
    fs.writeFileSync(edgePath, `${canonicalJson(tamperedEdge)}\n`);
    assert.throws(
      () =>
        readProviderInvocationEvidence(
          fixture.runtime,
          fixture.failed.invocationId,
        ),
      (error) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_SUPERSESSION_UNSAFE'),
    );
    fs.writeFileSync(edgePath, originalEdge);

    const successorIndex = path.join(
      fixture.runtime.root,
      'provider-invocation-supersessions',
      'by-successor',
      `${digest(secondRequest.invocationId)}.json`,
    );
    fs.unlinkSync(successorIndex);
    assert.throws(
      () =>
        readProviderInvocationEvidence(
          fixture.runtime,
          fixture.failed.invocationId,
        ),
      (error) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_SUPERSESSION_UNSAFE'),
    );
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('creation retry resumes transaction and pointer crash windows before lifecycle scanning', async (t) => {
  for (const phase of [
    'transaction-written',
    'transaction-prepared',
  ] as const) {
    await t.test(phase, () => {
      const fixture = createFailedInvocationFixture(`creation-${phase}`);
      try {
        const predecessorStatePath = path.join(
          fixture.runtime.invocations,
          fixture.failed.invocationId,
          'state.json',
        );
        const predecessorState = fs.readFileSync(predecessorStatePath, 'utf8');
        const secondRequest = replacementRequest(
          fixture.firstRequest,
          `invocation-supersession-creation-${phase}-2`,
        );
        storeProviderExecutionPolicySnapshot(
          fixture.runtime,
          secondRequest,
          fixture.policy,
        );
        assert.throws(
          () =>
            createProviderInvocation(fixture.runtime, {
              investigationId: fixture.failed.investigationId,
              changeId: fixture.failed.changeId,
              attempt: 2,
              manifest: fixture.manifest,
              request: secondRequest,
              createdAt: SECOND_CREATED_AT,
              simulateSupersessionCrashAfter: phase,
            }),
          (error) =>
            isWorkflowError(
              error,
              'PROVIDER_INVOCATION_SUPERSESSION_SIMULATED_CRASH',
            ),
        );
        assert.equal(
          fs.existsSync(
            path.join(
              fixture.runtime.invocations,
              secondRequest.invocationId,
              'state.json',
            ),
          ),
          false,
        );

        const resumed = createProviderInvocation(fixture.runtime, {
          investigationId: fixture.failed.investigationId,
          changeId: fixture.failed.changeId,
          attempt: 2,
          manifest: fixture.manifest,
          request: secondRequest,
          createdAt: SECOND_CREATED_AT,
        });
        assert.equal(resumed.invocationId, secondRequest.invocationId);
        assert.equal(
          fs.readFileSync(predecessorStatePath, 'utf8'),
          predecessorState,
        );
        assert.equal(
          listProviderInvocationLifecycleProjections(fixture.runtime).length,
          2,
        );
        const successor = readProviderInvocationEvidence(
          fixture.runtime,
          secondRequest.invocationId,
        );
        assert.equal(
          successor.replacementOf?.invocation.invocationId,
          fixture.failed.invocationId,
        );
        assert.equal(
          fs.readdirSync(
            path.join(
              fixture.runtime.root,
              'provider-invocation-supersessions',
              'edges',
            ),
          ).length,
          1,
        );
      } finally {
        fixture.dispose();
      }
    });
  }
});

function createFailedInvocationFixture(
  label: string,
  options: { repair?: boolean; runtimeEvidence?: boolean } = {},
) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const policy = loadAiAdapterPolicy(repository);
  const manifest = createManifest(repository, label);
  const firstRequest = request(
    manifest,
    policy.digest,
    `invocation-supersession-${label}-1`,
  );
  storeProviderExecutionPolicySnapshot(runtime, firstRequest, policy);
  const first = createProviderInvocation(runtime, {
    investigationId: `investigation-supersession-${label}`,
    changeId: manifest.changeId,
    attempt: 1,
    manifest,
    request: firstRequest,
    createdAt: FIRST_CREATED_AT,
  });
  const claim = claimProviderInvocation(runtime, first.invocationId, {
    expectedRevision: first.revision,
    workerId: `worker-supersession-${label}`,
    leaseDurationMs: 120_000,
    now: '2026-08-04T01:00:01.000Z',
  });
  const previousOutput = {
    reference: first.invocationId,
    terms: [] as string[],
  };
  const prompt = canonicalJson({
    schemaVersion: 1,
    kind: 'managed-provider-prompt',
    invocationId: first.invocationId,
  });
  const rawOutput = canonicalJson(previousOutput);
  if (options.runtimeEvidence !== false) {
    createRuntimeEvidence(runtime.invocations, first.invocationId, {
      prompt,
      schema: canonicalJson(BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA),
      rawOutput,
    });
  }
  const repair = options.repair !== false;
  const failed = failProviderInvocation(runtime, first.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure: {
      kind: 'retryable',
      code: repair ? 'PROVIDER_NATIVE_OUTPUT_INVALID' : 'PROVIDER_TIMEOUT',
      message: repair
        ? 'Provider output requires semantic repair.'
        : 'Provider exceeded its bounded runtime.',
      executionKind: repair ? 'schema-mismatch' : 'provider-timeout',
    },
    ...(repair
      ? {
          repair: {
            repairKind: 'semantic' as const,
            previousOutput,
            validationErrors: [
              {
                path: '/terms',
                code: 'SEMANTIC_COVERAGE',
                message: 'Expected a semantically complete term set.',
              },
            ],
            targetSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
          },
        }
      : {}),
    now: FAILED_AT,
  });
  return {
    repository,
    runtime,
    policy,
    manifest,
    firstRequest,
    failed,
    previousOutput,
    prompt,
    rawOutput,
    dispose: () => fs.rmSync(repository, { recursive: true, force: true }),
  };
}

function createManifest(
  repository: string,
  label: string,
): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: `Exercise provider supersession ${label}.`,
      explicitPaths: [
        'packages/workflow-engine/src/provider-invocation-supersession.ts',
      ],
      explicitSymbols: ['readProviderInvocationEvidence'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'How is immutable invocation lineage verified?',
    capabilityProfile: 'repository-read-only',
  };
}

function request(
  manifest: BlindSurveyManifest,
  policyDigest: string,
  invocationId: string,
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
      sessionId: `provider-session-${invocationId}`,
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
    policyDigest,
    limits: { timeoutMs: 3_600_000, aggregateOutputBytes: 1_048_576 },
  });
}

function replacementRequest(
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

function createRuntimeEvidence(
  invocationsRoot: string,
  invocationId: string,
  content: { prompt: string; schema: string; rawOutput: string },
): void {
  const runtime = path.join(invocationsRoot, invocationId, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, value] of [
    ['prompt.json', content.prompt],
    ['schema.json', content.schema],
    ['semantic-output.json', content.rawOutput],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), value, { mode: 0o600 });
  }
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
