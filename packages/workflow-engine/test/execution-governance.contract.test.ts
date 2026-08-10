import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  assemblePromptFromManifest,
  assessAttemptResultEligibility,
  buildContextManifest,
  buildRepairContext,
  canonicalExecutionBudgetGrantRequest,
  canonicalExecutionBudgetGrantSigningBytes,
  compactEpochTransitionReceipts,
  consumeExecutionBudgetGrant,
  consumeRepairBudget,
  createExecutionBudgetGrantEnvelope,
  createExecutionBudgetGrantRequest,
  createRepairBudget,
  DEFAULT_RETENTION_POLICY,
  EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
  inspectExecutionBudgetGrant,
  markEpochEvidenceExpiring,
  parseContextManifest,
  parseExecutionBudgetGrantRequest,
  performEpochRollover,
  pinEvidence,
  planEvidencePruning,
  revokeExecutionBudgetGrant,
  storeExecutionBudgetGrant,
  type EvidenceRetentionRecord,
  type EpochTransitionReceipt,
} from '../src/execution-governance.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const STATIC_BINDING = {
  schemaVersion: 1 as const,
  mandateTaskId: 'task-plan-review',
  mandateId: '44444444-4444-4444-8444-444444444444',
  mandateDigest: 'a'.repeat(64),
  changeId: 'change-a',
  externalAuditRoot: '/private/tmp/execution-governance-authority-audit',
};

function request(binding = STATIC_BINDING) {
  return createExecutionBudgetGrantRequest({
    requestId: REQUEST_ID,
    workflowId: 'change-a',
    epoch: 4,
    jobId: 'job-plan-review-004',
    mandateBinding: binding,
    requestedChanges: [
      { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
    ],
    rationale: 'attempt-001 timed out at 300s; estimated completion is 405s',
    expiresAfterAttempts: 2,
    createdAt: NOW,
  });
}

test('execution-budget GrantRequest is strict, canonical, and concrete', () => {
  const grantRequest = request();
  assert.deepEqual(grantRequest, {
    schemaVersion: 1,
    kind: 'execution-budget-grant-request',
    requestId: REQUEST_ID,
    workflowId: 'change-a',
    epoch: 4,
    jobId: 'job-plan-review-004',
    mandateBinding: STATIC_BINDING,
    requestedChanges: [
      { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
    ],
    rationale: 'attempt-001 timed out at 300s; estimated completion is 405s',
    expiresAfterAttempts: 2,
    createdAt: NOW.toISOString(),
  });

  const canonical = canonicalExecutionBudgetGrantRequest(grantRequest);
  assert.deepEqual(parseExecutionBudgetGrantRequest(canonical), grantRequest);
  const tampered = JSON.parse(canonical) as Record<string, unknown>;
  tampered.unbounded = true;
  assert.throws(
    () => parseExecutionBudgetGrantRequest(`${JSON.stringify(tampered)}\n`),
    (error) => isWorkflowError(error, 'EXECUTION_GRANT_REQUEST_INVALID'),
  );
});

test('execution-budget grant uses domain-separated bytes and atomically consumes bounded uses', () => {
  const fixture = grantStoreFixture('execution-grant-');
  const store = fixture.storeRoot;
  try {
    const grantRequest = request(fixture.binding);
    const envelope = createExecutionBudgetGrantEnvelope(grantRequest, {
      grantId: GRANT_ID,
      issuedAt: NOW,
      issuer: 'fixture-maintainer',
      maxUses: 2,
      signature: 'fixture-signature',
    });
    const signingBytes = canonicalExecutionBudgetGrantSigningBytes(
      envelope.payload,
    );
    assert.equal(
      signingBytes.startsWith(
        `${EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE}\n`,
      ),
      true,
    );
    let verified = false;
    storeExecutionBudgetGrant(store, envelope, {
      request: grantRequest,
      mandateBinding: fixture.binding,
      audit: fixture.audit,
      verify(bytes, signature) {
        assert.equal(bytes, signingBytes);
        assert.equal(signature, 'fixture-signature');
        verified = true;
      },
    });
    assert.equal(verified, true);

    const first = consumeExecutionBudgetGrant(store, {
      grantId: GRANT_ID,
      workflowId: 'change-a',
      epoch: 4,
      jobId: 'job-plan-review-004',
      attemptId: 'attempt-002',
      mandateBinding: fixture.binding,
      requestDigest: envelope.payload.requestDigest,
      requestedChanges: grantRequest.requestedChanges,
      now: new Date('2026-08-03T09:01:00.000Z'),
      audit: fixture.audit,
    });
    assert.equal(first.useNumber, 1);
    assert.equal(first.remainingUses, 1);
    assert.equal(first.kind, 'execution-budget-consume-receipt');

    assert.throws(
      () =>
        consumeExecutionBudgetGrant(store, {
          grantId: GRANT_ID,
          workflowId: 'change-a',
          epoch: 5,
          jobId: 'job-plan-review-004',
          attemptId: 'attempt-wrong-epoch',
          mandateBinding: fixture.binding,
          requestDigest: envelope.payload.requestDigest,
          requestedChanges: grantRequest.requestedChanges,
          now: NOW,
          audit: fixture.audit,
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'),
    );
    assert.throws(
      () =>
        consumeExecutionBudgetGrant(store, {
          grantId: GRANT_ID,
          workflowId: 'change-a',
          epoch: 4,
          jobId: 'other-job',
          attemptId: 'attempt-wrong-job',
          mandateBinding: fixture.binding,
          requestDigest: envelope.payload.requestDigest,
          requestedChanges: grantRequest.requestedChanges,
          now: NOW,
          audit: fixture.audit,
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'),
    );
    assert.throws(
      () =>
        consumeExecutionBudgetGrant(store, {
          grantId: GRANT_ID,
          workflowId: 'change-a',
          epoch: 4,
          jobId: 'job-plan-review-004',
          attemptId: 'attempt-wrong-change',
          mandateBinding: fixture.binding,
          requestDigest: envelope.payload.requestDigest,
          requestedChanges: [
            { path: '/limits/timeoutMs', from: 300_000, to: 3_600_000 },
          ],
          now: NOW,
          audit: fixture.audit,
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_CHANGE_MISMATCH'),
    );
    assert.throws(
      () =>
        consumeExecutionBudgetGrant(store, {
          grantId: GRANT_ID,
          workflowId: 'change-a',
          epoch: 4,
          jobId: 'job-plan-review-004',
          attemptId: 'attempt-002',
          mandateBinding: fixture.binding,
          requestDigest: envelope.payload.requestDigest,
          requestedChanges: grantRequest.requestedChanges,
          now: NOW,
          audit: fixture.audit,
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_ATTEMPT_REUSED'),
    );

    const second = consumeExecutionBudgetGrant(store, {
      grantId: GRANT_ID,
      workflowId: 'change-a',
      epoch: 4,
      jobId: 'job-plan-review-004',
      attemptId: 'attempt-003',
      mandateBinding: fixture.binding,
      requestDigest: envelope.payload.requestDigest,
      requestedChanges: grantRequest.requestedChanges,
      now: new Date('2026-08-03T09:02:00.000Z'),
      audit: fixture.audit,
    });
    assert.equal(second.useNumber, 2);
    assert.equal(second.remainingUses, 0);
    assert.throws(
      () =>
        consumeExecutionBudgetGrant(store, {
          grantId: GRANT_ID,
          workflowId: 'change-a',
          epoch: 4,
          jobId: 'job-plan-review-004',
          attemptId: 'attempt-004',
          mandateBinding: fixture.binding,
          requestDigest: envelope.payload.requestDigest,
          requestedChanges: grantRequest.requestedChanges,
          now: NOW,
          audit: fixture.audit,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_EXHAUSTED'),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('two runners racing one use produce exactly one durable grant receipt', async () => {
  const fixture = grantStoreFixture('execution-grant-race-');
  try {
    const grantRequest = request(fixture.binding);
    const envelope = createExecutionBudgetGrantEnvelope(grantRequest, {
      grantId: GRANT_ID,
      issuedAt: NOW,
      issuer: 'fixture-maintainer',
      maxUses: 1,
      signature: 'fixture-signature',
    });
    storeExecutionBudgetGrant(fixture.storeRoot, envelope, {
      request: grantRequest,
      mandateBinding: fixture.binding,
      audit: fixture.audit,
      verify() {},
    });

    const workerSource = String.raw`
      const { parentPort, workerData } = require('node:worker_threads');
      void (async () => {
        const { consumeExecutionBudgetGrant } = await import(workerData.moduleUrl);
        parentPort.postMessage({ kind: 'ready' });
        await new Promise((resolve) => parentPort.once('message', resolve));
        try {
          const receipt = consumeExecutionBudgetGrant(workerData.storeRoot, {
            ...workerData.input,
            now: new Date(workerData.input.now),
          });
          parentPort.postMessage({ kind: 'result', ok: true, receipt });
        } catch (error) {
          parentPort.postMessage({
            kind: 'result',
            ok: false,
            code: error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : 'UNKNOWN',
          });
        }
      })();
    `;
    const moduleUrl = new URL('../src/execution-governance.ts', import.meta.url)
      .href;
    const workers = ['attempt-race-a', 'attempt-race-b'].map(
      (attemptId) =>
        new Worker(workerSource, {
          eval: true,
          execArgv: ['--experimental-strip-types'],
          workerData: {
            moduleUrl,
            storeRoot: fixture.storeRoot,
            input: {
              grantId: GRANT_ID,
              workflowId: 'change-a',
              epoch: 4,
              jobId: 'job-plan-review-004',
              attemptId,
              mandateBinding: fixture.binding,
              requestDigest: envelope.payload.requestDigest,
              requestedChanges: grantRequest.requestedChanges,
              now: '2026-08-03T09:01:00.000Z',
              audit: fixture.audit,
            },
          },
        }),
    );
    try {
      const ready = await Promise.all(
        workers.map((worker) => once(worker, 'message')),
      );
      assert.deepEqual(
        ready.map(([message]) => message),
        [{ kind: 'ready' }, { kind: 'ready' }],
      );
      const outcomes = workers.map((worker) => once(worker, 'message'));
      for (const worker of workers) worker.postMessage('consume');
      const results = (await Promise.all(outcomes)).map(
        ([message]) =>
          message as
            | { kind: 'result'; ok: true; receipt: { remainingUses: number } }
            | { kind: 'result'; ok: false; code: string },
      );
      assert.equal(results.filter(({ ok }) => ok).length, 1);
      assert.equal(results.filter(({ ok }) => !ok).length, 1);
      assert.ok(
        results
          .filter(
            (result): result is { kind: 'result'; ok: false; code: string } =>
              !result.ok,
          )
          .every(({ code }) =>
            [
              'EXECUTION_BUDGET_GRANT_EXHAUSTED',
              'EXECUTION_BUDGET_GRANT_OPERATION_CONFLICT',
            ].includes(code),
          ),
      );
      const stored = inspectExecutionBudgetGrant(fixture.storeRoot, GRANT_ID);
      assert.equal(stored.remainingUses, 0);
      assert.equal(stored.receipts.length, 1);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('execution-budget grant revocation is atomic, replay-safe, and preserves prior receipts', () => {
  const fixture = grantStoreFixture('execution-grant-revoke-');
  const store = fixture.storeRoot;
  try {
    const grantRequest = request(fixture.binding);
    const envelope = createExecutionBudgetGrantEnvelope(grantRequest, {
      grantId: GRANT_ID,
      issuedAt: NOW,
      issuer: 'fixture-maintainer',
      maxUses: 2,
      signature: 'fixture-signature',
    });
    storeExecutionBudgetGrant(store, envelope, {
      request: grantRequest,
      mandateBinding: fixture.binding,
      audit: fixture.audit,
      verify() {},
    });
    consumeExecutionBudgetGrant(store, {
      grantId: GRANT_ID,
      workflowId: 'change-a',
      epoch: 4,
      jobId: 'job-plan-review-004',
      attemptId: 'attempt-002',
      mandateBinding: fixture.binding,
      requestDigest: envelope.payload.requestDigest,
      requestedChanges: grantRequest.requestedChanges,
      now: new Date('2026-08-03T09:01:00.000Z'),
      audit: fixture.audit,
    });

    const revoked = revokeExecutionBudgetGrant(store, {
      grantId: GRANT_ID,
      mandateBinding: fixture.binding,
      reason: 'The maintainer withdrew the remaining retry authority.',
      now: new Date('2026-08-03T09:02:00.000Z'),
      audit: fixture.audit,
    });
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.remainingUses, 1);
    assert.equal(revoked.receipts.length, 1);
    assert.equal(revoked.revokedAt, '2026-08-03T09:02:00.000Z');

    assert.deepEqual(
      revokeExecutionBudgetGrant(store, {
        grantId: GRANT_ID,
        mandateBinding: fixture.binding,
        reason: 'A different replay reason cannot alter durable authority.',
        now: new Date('2026-08-03T09:03:00.000Z'),
        audit: fixture.audit,
      }),
      revoked,
    );
    assert.throws(
      () =>
        consumeExecutionBudgetGrant(store, {
          grantId: GRANT_ID,
          workflowId: 'change-a',
          epoch: 4,
          jobId: 'job-plan-review-004',
          attemptId: 'attempt-003',
          mandateBinding: fixture.binding,
          requestDigest: envelope.payload.requestDigest,
          requestedChanges: grantRequest.requestedChanges,
          now: new Date('2026-08-03T09:04:00.000Z'),
          audit: fixture.audit,
        }),
      (error) => isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_REVOKED'),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function grantStoreFixture(prefix: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repositoryRoot = path.join(root, 'repository');
  const storeRoot = path.join(root, 'store');
  const externalAuditRoot = path.join(root, 'authority-audit');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  fs.mkdirSync(externalAuditRoot, { mode: 0o700 });
  return {
    root,
    storeRoot,
    binding: { ...STATIC_BINDING, externalAuditRoot },
    audit: {
      repositoryRoot,
      repositoryIdentity: 'github:R_execution_governance_fixture',
    },
  };
}

test('schema and semantic repair contexts are identity-bound and budgeted', () => {
  let budget = createRepairBudget({
    maxSchemaAttempts: 2,
    maxSemanticAttempts: 1,
    maxSameFailureFingerprint: 2,
  });
  const context = buildRepairContext({
    repairKind: 'schema',
    workflowId: 'change-a',
    epoch: 4,
    jobId: 'job-plan-review-004',
    attemptId: 'attempt-001',
    contextDigest: `sha256:${'a'.repeat(64)}`,
    previousOutput: { answer: 42 },
    validationErrors: [
      { path: '/scopeAssessment', code: 'required', message: 'is required' },
    ],
    targetSchema: { type: 'object', required: ['scopeAssessment'] },
  });
  assert.equal(context.requiresFullValidation, true);
  assert.equal(
    context.instruction,
    'Return one complete replacement object that satisfies every validation error and the target schema.',
  );
  assert.equal(context.epoch, 4);

  budget = consumeRepairBudget(budget, 'schema', 'fingerprint-a');
  budget = consumeRepairBudget(budget, 'schema', 'fingerprint-a');
  assert.throws(
    () => consumeRepairBudget(budget, 'schema', 'fingerprint-a'),
    (error) => isWorkflowError(error, 'REPAIR_BUDGET_EXHAUSTED'),
  );

  budget = consumeRepairBudget(budget, 'semantic', 'fingerprint-b');
  assert.throws(
    () => consumeRepairBudget(budget, 'semantic', 'fingerprint-c'),
    (error) => isWorkflowError(error, 'REPAIR_BUDGET_EXHAUSTED'),
  );
});

test('context digest covers semantic inputs and prompt assembly reads exact manifest items only', () => {
  const intent = 'Keep the stable workflow and retry only the failed attempt.';
  const terms = 'attempt; epoch; bounded grant';
  const loaded: string[] = [];
  const manifest = buildContextManifest({
    workflowId: 'change-a',
    epoch: 4,
    contractVersion: 2,
    baselineDigest: `sha256:${'1'.repeat(64)}`,
    intentDigest: `sha256:${'2'.repeat(64)}`,
    termSetDigest: `sha256:${'3'.repeat(64)}`,
    planningSnapshotDigest: `sha256:${'4'.repeat(64)}`,
    items: [
      { identity: 'intent:intent-7', content: intent },
      { identity: 'terms:terms-12', content: terms },
    ],
  });
  const parsed = parseContextManifest(`${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual(parsed, manifest);
  const byIdentity = new Map([
    ['intent:intent-7', intent],
    ['terms:terms-12', terms],
    ['old:evidence-not-allowed', 'must not be loaded'],
  ]);
  const prompt = assemblePromptFromManifest(manifest, (reference) => {
    loaded.push(reference.identity);
    return {
      identity: reference.identity,
      digest: reference.digest,
      content: byIdentity.get(reference.identity)!,
    };
  });
  assert.deepEqual(loaded, ['intent:intent-7', 'terms:terms-12']);
  assert.equal(prompt, `${intent}\n\n${terms}`);

  assert.throws(
    () =>
      assemblePromptFromManifest(manifest, (reference) => ({
        identity: reference.identity,
        digest: reference.digest,
        content: `${byIdentity.get(reference.identity)!} tampered`,
      })),
    (error) => isWorkflowError(error, 'CONTEXT_ITEM_MISMATCH'),
  );
});

test('epoch rollover is semantic while lifecycle-only changes do not invalidate material', () => {
  const oldDigest = `sha256:${'a'.repeat(64)}`;
  const snapshotDigest = `sha256:${'b'.repeat(64)}`;
  const workflow = {
    workflowId: 'change-a',
    currentEpoch: 4,
    contractVersion: 1,
    contextDigest: oldDigest,
    snapshotDigest,
    status: 'active' as const,
    checkpoint: 'plan-review',
    blocker: null,
  };
  const job = {
    workflowId: 'change-a',
    jobId: 'job-plan-review-004',
    epoch: 4,
    contextDigest: oldDigest,
    snapshotDigest,
    acceptedAttemptId: null,
    eligibleAttemptIds: ['attempt-001'],
  };
  const result = {
    workflowId: 'change-a',
    jobId: 'job-plan-review-004',
    attemptId: 'attempt-001',
    epoch: 4,
    contextDigest: oldDigest,
    snapshotDigest,
  };
  assert.deepEqual(assessAttemptResultEligibility(workflow, job, result), {
    eligible: true,
    classification: 'eligible',
  });
  assert.equal(
    assessAttemptResultEligibility(
      {
        ...workflow,
        blocker: { kind: 'human-grant', since: NOW.toISOString() },
      },
      job,
      result,
    ).eligible,
    true,
  );
  assert.equal(
    assessAttemptResultEligibility(workflow, job, {
      ...result,
      workflowId: 'other-workflow',
    }).reasonCode,
    'RESULT_WRONG_OWNER',
  );
  assert.equal(
    assessAttemptResultEligibility(workflow, job, {
      ...result,
      contextDigest: `sha256:${'c'.repeat(64)}`,
    }).reasonCode,
    'RESULT_CONTEXT_MISMATCH',
  );
  assert.equal(
    assessAttemptResultEligibility(workflow, job, {
      ...result,
      snapshotDigest: `sha256:${'d'.repeat(64)}`,
    }).reasonCode,
    'RESULT_SNAPSHOT_MISMATCH',
  );
  assert.equal(
    assessAttemptResultEligibility(
      workflow,
      { ...job, acceptedAttemptId: 'attempt-000' },
      result,
    ).classification,
    'late-duplicate',
  );

  const nextManifest = buildContextManifest({
    workflowId: 'change-a',
    epoch: 5,
    contractVersion: 2,
    baselineDigest: snapshotDigest,
    intentDigest: `sha256:${'2'.repeat(64)}`,
    termSetDigest: `sha256:${'3'.repeat(64)}`,
    planningSnapshotDigest: `sha256:${'4'.repeat(64)}`,
    items: [{ identity: 'intent:intent-7', content: 'current intent' }],
  });
  const rollover = performEpochRollover({
    workflow,
    nextManifest,
    reason: 'Semantic validator contract now requires scope assessment.',
    restartFrom: 'main-terms',
    carriedForward: ['intent:intent-7'],
    invalidated: ['plan-review'],
    verification: {
      check: 'plan-review-scope-assessment-contract',
      result: 'passed',
      reportDigest: `sha256:${'9'.repeat(64)}`,
    },
    createdAt: NOW,
  });
  assert.equal(rollover.workflow.currentEpoch, 5);
  assert.equal(rollover.workflow.checkpoint, 'main-terms');
  assert.equal(rollover.receipt.fromEpoch, 4);
  assert.equal(rollover.receipt.toEpoch, 5);
  assert.equal(
    assessAttemptResultEligibility(rollover.workflow, job, result)
      .classification,
    'stale',
  );
});

test('bounded retention never prunes current-manifest references and compacts receipts', () => {
  const manifest = buildContextManifest({
    workflowId: 'change-a',
    epoch: 5,
    contractVersion: 2,
    baselineDigest: `sha256:${'1'.repeat(64)}`,
    intentDigest: `sha256:${'2'.repeat(64)}`,
    termSetDigest: `sha256:${'3'.repeat(64)}`,
    planningSnapshotDigest: `sha256:${'4'.repeat(64)}`,
    items: [{ identity: 'intent:current', content: 'current intent' }],
  });
  const records: EvidenceRetentionRecord[] = [
    {
      schemaVersion: 1,
      kind: 'evidence-retention',
      evidenceId: 'evidence-current-ref',
      itemIdentity: 'intent:current',
      workflowId: 'change-a',
      epoch: 3,
      evidenceClass: 'raw',
      digest: manifest.items[0]!.digest,
      retention: 'expiring',
      createdAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-07-08T00:00:00.000Z',
      pin: null,
    },
    {
      schemaVersion: 1,
      kind: 'evidence-retention',
      evidenceId: 'evidence-old-raw',
      itemIdentity: null,
      workflowId: 'change-a',
      epoch: 3,
      evidenceClass: 'raw',
      digest: `sha256:${'8'.repeat(64)}`,
      retention: 'expiring',
      createdAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-07-08T00:00:00.000Z',
      pin: null,
    },
  ];
  const marked = markEpochEvidenceExpiring(
    [
      {
        ...records[1]!,
        evidenceId: 'evidence-previous-active',
        epoch: 4,
        retention: 'active',
        expiresAt: null,
      },
    ],
    { endedEpoch: 4, endedAt: NOW, policy: DEFAULT_RETENTION_POLICY },
  );
  assert.equal(marked[0]!.retention, 'expiring');
  assert.equal(marked[0]!.expiresAt, '2026-08-10T09:00:00.000Z');

  assert.throws(
    () =>
      pinEvidence(records[1]!, {
        actor: 'fixture-maintainer',
        reason: 'Needed for a long-running audit.',
        pinnedAt: NOW,
        humanConfirmed: false as true,
      }),
    (error) => isWorkflowError(error, 'RETENTION_PIN_REQUIRES_HUMAN'),
  );
  const pinned = pinEvidence(
    { ...records[1]!, evidenceId: 'evidence-pinned' },
    {
      actor: 'fixture-maintainer',
      reason: 'Needed for a long-running audit.',
      pinnedAt: NOW,
      humanConfirmed: true,
    },
  );
  const pruning = planEvidencePruning({
    records: [...records, pinned],
    currentEpoch: 5,
    currentManifest: manifest,
    now: NOW,
    policy: DEFAULT_RETENTION_POLICY,
  });
  assert.equal(pruning.delete.includes('evidence-current-ref'), false);
  assert.equal(pruning.delete.includes('evidence-old-raw'), true);
  assert.equal(pruning.keep.includes('evidence-pinned'), true);

  const receipts: EpochTransitionReceipt[] = Array.from(
    { length: 25 },
    (_, index) => ({
      schemaVersion: 1,
      kind: 'epoch-transition',
      workflowId: 'change-a',
      fromEpoch: index + 1,
      toEpoch: index + 2,
      fromContractVersion: 1,
      toContractVersion: 2,
      reason: `Transition ${index + 1} changed semantic context.`,
      restartFrom: 'main-terms',
      carriedForward: [],
      invalidated: ['plan-review'],
      previousContextDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
      newContextDigest: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
      verification: null,
      createdAt: new Date(
        Date.UTC(2026, 7, 3) - (24 - index) * 86_400_000,
      ).toISOString(),
    }),
  );
  const compacted = compactEpochTransitionReceipts(receipts, [], {
    now: NOW,
    policy: { ...DEFAULT_RETENTION_POLICY, maxFullTransitionReceipts: 20 },
  });
  assert.equal(compacted.full.length, 20);
  assert.equal(compacted.stubs.length, 5);
  assert.equal(compacted.discarded.length, 0);
});
