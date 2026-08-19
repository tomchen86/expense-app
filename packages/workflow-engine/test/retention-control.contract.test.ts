import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { inspectDurableRetentionCatalog } from '../src/modules/authority/execution-governance.ts';
import { listProviderInvocationLifecycleProjections } from '../src/runtime/storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { prepareProviderPromptContextForInvocation } from '../src/runtime/provider-execution/provider-execution-governance.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  inspectEvidenceRetention,
  pinWorkflowEvidence,
  runEvidenceRetentionMaintenance,
} from '../src/runtime/provider-execution/retention-control.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

test('main CLI exposes bounded retention inspection without requiring mutation authority', () => {
  const repository = createFixtureRepository();
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'retention',
        'inspect',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      result: { kind: string; durableContexts: unknown[] };
    };
    assert.equal(output.result.kind, 'evidence-retention-inspection.v1');
    assert.deepEqual(output.result.durableContexts, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production retention surface requires a trusted present human to pin exact workflow evidence', () => {
  const fixture = prepareWorkflow('retention-control-pin');
  const { repository, mandate, workflowId, evidenceId, storeRoot } = fixture;
  try {
    const before = inspectDurableRetentionCatalog(storeRoot, workflowId);
    assert.equal(
      before.records.find((record) => record.evidenceId === evidenceId)
        ?.retention,
      'active',
    );

    assert.throws(
      () =>
        pinWorkflowEvidence(repository, {
          workflowId,
          evidenceId,
          reason: 'Keep the reviewed incident evidence.',
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );
    assert.throws(
      () =>
        pinWorkflowEvidence(
          repository,
          {
            workflowId,
            evidenceId,
            reason: 'Keep the reviewed incident evidence.',
          },
          {
            signer: {
              ...mandate.signer,
              identity: () => 'untrusted-maintainer',
            },
          },
        ),
      (error) => isWorkflowError(error, 'RETENTION_PIN_SIGNER_UNTRUSTED'),
    );
    assert.equal(
      inspectDurableRetentionCatalog(storeRoot, workflowId).generation,
      before.generation,
    );

    const pinned = pinWorkflowEvidence(
      repository,
      {
        workflowId,
        evidenceId,
        reason: 'Keep the reviewed incident evidence.',
      },
      { signer: mandate.signer },
    );
    assert.equal(pinned.record.retention, 'pinned');
    assert.equal(pinned.record.pin?.actor, mandate.signer.identity());
    assert.equal(pinned.replayed, false);

    const replayed = pinWorkflowEvidence(
      repository,
      {
        workflowId,
        evidenceId,
        reason: 'Keep the reviewed incident evidence.',
      },
      { signer: mandate.signer },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.catalogGeneration, pinned.catalogGeneration);
    assert.deepEqual(replayed.record, pinned.record);
  } finally {
    fixture.dispose();
  }
});

test('production retention inspection and maintenance traverse durable contexts without empty prune receipts', () => {
  const fixture = prepareWorkflow('retention-control-maintenance');
  try {
    const inspected = inspectEvidenceRetention(fixture.repository, {
      now: '2026-08-03T10:00:00.000Z',
    });
    assert.deepEqual(
      inspected.durableContexts.map(({ workflowId }) => workflowId),
      [fixture.workflowId],
    );
    const before = inspectDurableRetentionCatalog(
      fixture.storeRoot,
      fixture.workflowId,
    );
    const result = runEvidenceRetentionMaintenance(fixture.repository, {
      limit: 10,
      now: '2026-08-03T10:00:00.000Z',
    });
    assert.equal(result.durableContexts.examined, 1);
    assert.deepEqual(result.durableContexts.pruned, []);
    assert.deepEqual(result.durableContexts.skipped, [
      { workflowId: fixture.workflowId, reason: 'nothing-expired' },
    ]);
    assert.equal(
      inspectDurableRetentionCatalog(fixture.storeRoot, fixture.workflowId)
        .generation,
      before.generation,
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
      explicitPaths: [
        'packages/workflow-engine/src/modules/provider-orchestration/execution-core.ts',
      ],
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
  const storeRoot = runtimeContext.lifecycleRuntime.root;
  const projection = listProviderInvocationLifecycleProjections(
    runtimeContext.runtime,
  )[0];
  assert.ok(projection);
  const record = readProviderInvocation(
    runtimeContext.runtime,
    projection.invocationId,
  );
  const request = readProviderInvocationRequest(
    runtimeContext.runtime,
    projection.invocationId,
  );
  const manifest = readProviderInvocationManifest(
    runtimeContext.runtime,
    projection.invocationId,
  );
  const context = prepareProviderPromptContextForInvocation(
    storeRoot,
    request,
    manifest,
    projection.ownerInvestigationId,
    new Date(record.createdAt),
  );
  const catalog = inspectDurableRetentionCatalog(storeRoot, context.workflowId);
  const evidenceId = catalog.records[0]?.evidenceId;
  assert.ok(evidenceId);
  return {
    repository,
    mandate,
    workflowId: context.workflowId,
    evidenceId,
    storeRoot,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}
