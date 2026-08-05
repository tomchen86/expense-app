import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { inspectDurableRetentionCatalog } from '../src/execution-governance.ts';
import { listExecutionJobStates } from '../src/execution-store.ts';
import { listProviderInvocationLifecycleProjections } from '../src/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import { startPropose } from '../src/propose-orchestrator.ts';
import { inspectProviderPromptContextRetentionBinding } from '../src/provider-execution-governance.ts';
import { providerRuntimeEvidenceId } from '../src/provider-retention.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
} from '../src/provider-invocation-store.ts';
import {
  pinWorkflowEvidence,
  runEvidenceRetentionMaintenance,
} from '../src/retention-control.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { createFixtureRepository, git } from './fixture.ts';

function runtimeRecords(storeRoot: string, workflowId: string) {
  return inspectDurableRetentionCatalog(storeRoot, workflowId).records.filter(
    ({ evidenceId }) => evidenceId.startsWith('provider-runtime-'),
  );
}

test('creating a provider invocation leaves a pinnable handle for its runtime', () => {
  // Without this the pruning pass honours pins nobody can record: the ceremony
  // is reachable, the policy is right, and it protects nothing.
  const fixture = prepareWorkflow('provider-runtime-registered');
  try {
    const [record] = runtimeRecords(fixture.storeRoot, fixture.workflowId);
    assert.ok(record, 'invocation creation must leave something to pin');
    assert.equal(
      record.evidenceId,
      providerRuntimeEvidenceId(fixture.attemptId),
    );
    assert.equal(record.evidenceClass, 'raw');
    assert.equal(record.retention, 'active');
    assert.equal(record.pin, null);
    assert.equal(record.itemIdentity, `attempt:${fixture.attemptId}`);
  } finally {
    fixture.dispose();
  }
});

test('the handle names the runtime under the identity the pruning pass reads', () => {
  // The catalog belongs to the provider prompt context, while the Attempt sits
  // under the investigation. Recording a pin under one identity and resolving
  // it under the other is how a correct pin becomes invisible.
  const fixture = prepareWorkflow('provider-runtime-identity');
  try {
    assert.equal(fixture.workflowId, fixture.promptContextWorkflowId);
    assert.notEqual(fixture.workflowId, fixture.investigationId);
    const [record] = runtimeRecords(fixture.storeRoot, fixture.workflowId);
    assert.equal(record?.workflowId, fixture.promptContextWorkflowId);
  } finally {
    fixture.dispose();
  }
});

test('a maintainer can pin the registered runtime through the production surface', () => {
  const fixture = prepareWorkflow('provider-runtime-pinnable');
  try {
    const evidenceId = providerRuntimeEvidenceId(fixture.attemptId);
    const pinned = pinWorkflowEvidence(
      fixture.repository,
      {
        workflowId: fixture.workflowId,
        evidenceId,
        reason: 'Keep the runtime that explains this decision.',
      },
      { signer: fixture.mandate.signer },
    );
    assert.equal(pinned.record.evidenceId, evidenceId);
    assert.equal(pinned.record.retention, 'pinned');
    assert.equal(pinned.record.pin?.actor, fixture.mandate.signer.identity());

    // A maintenance pass must not undo a human decision it just read.
    runEvidenceRetentionMaintenance(fixture.repository, {
      limit: 10,
      now: '2026-08-03T10:00:00.000Z',
    });
    const [record] = runtimeRecords(fixture.storeRoot, fixture.workflowId);
    assert.equal(record?.retention, 'pinned');
    assert.equal(record?.pin?.actor, fixture.mandate.signer.identity());
  } finally {
    fixture.dispose();
  }
});

test('registration is idempotent for an invocation that already has a handle', () => {
  const fixture = prepareWorkflow('provider-runtime-idempotent');
  try {
    assert.equal(
      runtimeRecords(fixture.storeRoot, fixture.workflowId).length,
      1,
    );
    const generation = inspectDurableRetentionCatalog(
      fixture.storeRoot,
      fixture.workflowId,
    ).generation;
    runEvidenceRetentionMaintenance(fixture.repository, {
      limit: 10,
      now: '2026-08-03T10:00:00.000Z',
    });
    assert.equal(
      runtimeRecords(fixture.storeRoot, fixture.workflowId).length,
      1,
    );
    assert.equal(
      inspectDurableRetentionCatalog(fixture.storeRoot, fixture.workflowId)
        .generation,
      generation,
    );
  } finally {
    fixture.dispose();
  }
});

function prepareWorkflow(changeId: string) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: `Create ${changeId} retention evidence.`,
      explicitPaths: ['packages/workflow-engine/src/execution-core.ts'],
      explicitSymbols: ['createExecutionJob'],
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
  // The store production actually writes durable provider contexts to.
  const storeRoot = runtimeContext.runtime.root;
  const projection = listProviderInvocationLifecycleProjections(
    runtimeContext.runtime,
  )[0];
  assert.ok(projection);
  const record = readProviderInvocation(
    runtimeContext.runtime,
    projection.invocationId,
  );
  const binding = inspectProviderPromptContextRetentionBinding(
    runtimeContext.runtime.root,
    readProviderInvocationRequest(
      runtimeContext.runtime,
      projection.invocationId,
    ),
    readProviderInvocationManifest(
      runtimeContext.runtime,
      projection.invocationId,
    ),
    projection.ownerInvestigationId,
    record.createdAt,
  );
  assert.ok(binding);
  // The pruning pass looks a pin up by the Attempt's identity, not the legacy
  // invocation's, so the test has to name the same thing the engine will.
  const attemptId = listExecutionJobStates(runtimeContext.runtime)
    .flatMap(({ attempts }) => attempts)
    .find(
      (attempt) =>
        attempt.legacyInvocation?.invocationId === projection.invocationId,
    )?.attemptId;
  assert.ok(attemptId);
  return {
    repository,
    mandate,
    workflowId: binding.workflowId,
    promptContextWorkflowId: binding.workflowId,
    investigationId: projection.ownerInvestigationId,
    attemptId,
    storeRoot,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}
