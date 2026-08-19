import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildContextManifest,
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
  type ContextManifest,
  type WorkflowContextState,
} from '../src/modules/authority/execution-governance.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { prepareProviderPromptContextForInvocation } from '../src/runtime/provider-execution/provider-execution-governance.ts';
import { isWorkflowError } from './fixture.ts';

const FIRST_AT = new Date('2026-08-10T01:00:00.000Z');
const ROLLOVER_AT = new Date('2026-08-10T01:01:00.000Z');

function manifest(
  epoch: number,
  items: { identity: string; content: string }[],
): ContextManifest {
  return buildContextManifest({
    workflowId: 'carry-forward-workflow',
    epoch,
    contractVersion: epoch,
    baselineDigest: `sha256:${String(epoch).repeat(64)}`,
    intentDigest: `sha256:${'a'.repeat(64)}`,
    termSetDigest: `sha256:${'b'.repeat(64)}`,
    planningSnapshotDigest: `sha256:${'c'.repeat(64)}`,
    items,
  });
}

function workflow(current: ContextManifest): WorkflowContextState {
  return {
    workflowId: current.workflowId,
    currentEpoch: current.epoch,
    contractVersion: current.contractVersion,
    contextDigest: current.contextDigest,
    snapshotDigest: current.baselineDigest,
    status: 'active',
    checkpoint: 'survey',
    blocker: null,
  };
}

test('epoch rollover persists reasoned carry-forward and exclusion decisions', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-carry-forward-'));
  try {
    const first = manifest(1, [
      { identity: 'intent:stable', content: 'stable intent' },
      { identity: 'provider-runtime:old', content: 'transient bytes' },
    ]);
    initializeDurableEpochContextStore(store, {
      workflow: workflow(first),
      manifest: first,
      items: [
        { identity: 'intent:stable', content: 'stable intent' },
        { identity: 'provider-runtime:old', content: 'transient bytes' },
      ],
      now: FIRST_AT,
    });
    const second = manifest(2, [
      { identity: 'intent:stable', content: 'stable intent' },
      { identity: 'planning:new', content: 'new planning context' },
    ]);

    const rolled = rolloverDurableEpochContextStore(store, {
      workflowId: first.workflowId,
      expectedGeneration: 1,
      expectedEpoch: 1,
      expectedContextDigest: first.contextDigest,
      nextManifest: second,
      items: [
        { identity: 'intent:stable', content: 'stable intent' },
        { identity: 'planning:new', content: 'new planning context' },
      ],
      reason: 'The planning contract changed.',
      restartFrom: 'main-terms',
      carriedForward: ['intent:stable'],
      carryForwardManifest: {
        sourceWorkflow: first.workflowId,
        sourceEpoch: 1,
        carriedForward: [
          {
            identity: 'intent:stable',
            reason: 'Still represents the current change intent.',
          },
        ],
        excluded: [
          {
            identity: 'provider-runtime:old',
            reason: 'Transient execution evidence is not semantic context.',
          },
        ],
      },
      invalidated: ['provider-runtime', 'survey'],
      verification: null,
      createdAt: ROLLOVER_AT,
    });

    assert.equal(rolled.transitionReceipts.length, 1);
    const receipt = rolled.transitionReceipts[0]!;
    assert.equal(receipt.schemaVersion, 2);
    assert.deepEqual(receipt.carriedForward, ['intent:stable']);
    assert.deepEqual(receipt.carryForwardManifest, {
      schemaVersion: 1,
      kind: 'epoch-carry-forward-manifest',
      sourceWorkflow: first.workflowId,
      sourceEpoch: 1,
      carriedForward: [
        {
          identity: 'intent:stable',
          reason: 'Still represents the current change intent.',
        },
      ],
      excluded: [
        {
          identity: 'provider-runtime:old',
          reason: 'Transient execution evidence is not semantic context.',
        },
      ],
    });
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('carry-forward decisions fail closed on missing reasons or wrong epoch membership', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-carry-forward-'));
  try {
    const first = manifest(1, [
      { identity: 'intent:stable', content: 'stable intent' },
      { identity: 'provider-runtime:old', content: 'transient bytes' },
    ]);
    initializeDurableEpochContextStore(store, {
      workflow: workflow(first),
      manifest: first,
      items: [
        { identity: 'intent:stable', content: 'stable intent' },
        { identity: 'provider-runtime:old', content: 'transient bytes' },
      ],
      now: FIRST_AT,
    });
    const second = manifest(2, [
      { identity: 'intent:stable', content: 'stable intent' },
    ]);
    const baseInput = {
      workflowId: first.workflowId,
      expectedGeneration: 1,
      expectedEpoch: 1,
      expectedContextDigest: first.contextDigest,
      nextManifest: second,
      items: [{ identity: 'intent:stable', content: 'stable intent' }],
      reason: 'The planning contract changed.',
      restartFrom: 'main-terms',
      carriedForward: ['intent:stable'],
      invalidated: ['survey'],
      verification: null,
      createdAt: ROLLOVER_AT,
    };

    for (const carryForwardManifest of [
      {
        sourceWorkflow: first.workflowId,
        sourceEpoch: 1,
        carriedForward: [{ identity: 'intent:stable', reason: ' ' }],
        excluded: [
          { identity: 'provider-runtime:old', reason: 'Transient evidence.' },
        ],
      },
      {
        sourceWorkflow: first.workflowId,
        sourceEpoch: 1,
        carriedForward: [
          { identity: 'intent:stable', reason: 'Still current.' },
        ],
        excluded: [
          { identity: 'evidence:not-in-old-epoch', reason: 'Stale evidence.' },
        ],
      },
    ]) {
      assert.throws(
        () =>
          rolloverDurableEpochContextStore(store, {
            ...baseInput,
            carryForwardManifest,
          }),
        (error) => isWorkflowError(error, 'EPOCH_TRANSITION_INVALID'),
      );
    }
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('carry-forward decisions account for every source manifest item', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-carry-forward-'));
  try {
    const first = manifest(1, [
      { identity: 'intent:stable', content: 'stable intent' },
      { identity: 'provider-runtime:old', content: 'transient bytes' },
    ]);
    initializeDurableEpochContextStore(store, {
      workflow: workflow(first),
      manifest: first,
      items: [
        { identity: 'intent:stable', content: 'stable intent' },
        { identity: 'provider-runtime:old', content: 'transient bytes' },
      ],
      now: FIRST_AT,
    });
    const second = manifest(2, [
      { identity: 'intent:stable', content: 'stable intent' },
    ]);
    assert.throws(
      () =>
        rolloverDurableEpochContextStore(store, {
          workflowId: first.workflowId,
          expectedGeneration: 1,
          expectedEpoch: 1,
          expectedContextDigest: first.contextDigest,
          nextManifest: second,
          items: [{ identity: 'intent:stable', content: 'stable intent' }],
          reason: 'The planning contract changed.',
          restartFrom: 'main-terms',
          carriedForward: ['intent:stable'],
          carryForwardManifest: {
            sourceWorkflow: first.workflowId,
            sourceEpoch: 1,
            carriedForward: [
              {
                identity: 'intent:stable',
                reason: 'Still represents the current intent.',
              },
            ],
            excluded: [],
          },
          invalidated: ['survey'],
          verification: null,
          createdAt: ROLLOVER_AT,
        }),
      (error: unknown) =>
        error instanceof Error &&
        isWorkflowError(error, 'EPOCH_TRANSITION_INVALID') &&
        error.message.includes(
          'Every source manifest item must have a carry-forward decision.',
        ),
    );
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('carry-forward decisions match the actual next-manifest bytes', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-carry-forward-'));
  try {
    const first = manifest(1, [
      { identity: 'intent:stable', content: 'stable intent' },
      { identity: 'provider-runtime:old', content: 'transient bytes' },
    ]);
    initializeDurableEpochContextStore(store, {
      workflow: workflow(first),
      manifest: first,
      items: [
        { identity: 'intent:stable', content: 'stable intent' },
        { identity: 'provider-runtime:old', content: 'transient bytes' },
      ],
      now: FIRST_AT,
    });
    const carryForwardManifest = {
      sourceWorkflow: first.workflowId,
      sourceEpoch: 1,
      carriedForward: [
        {
          identity: 'intent:stable',
          reason: 'Still represents the current intent.',
        },
      ],
      excluded: [
        {
          identity: 'provider-runtime:old',
          reason: 'Transient execution evidence is not semantic context.',
        },
      ],
    };
    const nextCases = [
      manifest(2, [
        {
          identity: 'intent:stable',
          content: 'changed behind the same identity',
        },
      ]),
      manifest(2, [
        { identity: 'intent:stable', content: 'stable intent' },
        { identity: 'provider-runtime:old', content: 'transient bytes' },
      ]),
    ];

    for (const nextManifest of nextCases) {
      assert.throws(
        () =>
          rolloverDurableEpochContextStore(store, {
            workflowId: first.workflowId,
            expectedGeneration: 1,
            expectedEpoch: 1,
            expectedContextDigest: first.contextDigest,
            nextManifest,
            items: nextManifest.items.map(({ identity }) => ({
              identity,
              content:
                identity === 'intent:stable'
                  ? nextManifest.items.length === 1
                    ? 'changed behind the same identity'
                    : 'stable intent'
                  : 'transient bytes',
            })),
            reason: 'The planning contract changed.',
            restartFrom: 'main-terms',
            carriedForward: ['intent:stable'],
            carryForwardManifest,
            invalidated: ['survey'],
            verification: null,
            createdAt: ROLLOVER_AT,
          }),
        (error) => isWorkflowError(error, 'EPOCH_TRANSITION_INVALID'),
      );
    }
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('production provider rollover records why the old semantic manifest is excluded', () => {
  const store = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-carry-forward-'),
  );
  try {
    const owner = 'investigation-carry-forward-production';
    const firstValue = { kind: 'provider-input', revision: 1 };
    const secondValue = { kind: 'provider-input', revision: 2 };
    const firstRequest = providerRequest(
      'provider-carry-forward-1',
      firstValue,
    );
    const secondRequest = providerRequest(
      'provider-carry-forward-2',
      secondValue,
    );
    const first = prepareProviderPromptContextForInvocation(
      store,
      firstRequest,
      firstValue,
      owner,
      FIRST_AT,
    );
    const second = prepareProviderPromptContextForInvocation(
      store,
      secondRequest,
      secondValue,
      owner,
      ROLLOVER_AT,
    );
    assert.equal(second.epoch, first.epoch + 1);

    const state = inspectDurableEpochContextStore(store, first.workflowId);
    const receipt = state.transitionReceipts[0]!;
    assert.equal(receipt.schemaVersion, 2);
    assert.deepEqual(receipt.carriedForward, []);
    assert.deepEqual(receipt.carryForwardManifest.excluded, [
      {
        identity: 'provider-input-manifest',
        reason:
          'The prior provider input manifest is bound to the superseded semantic request.',
      },
    ]);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

function providerRequest(invocationId: string, manifestValue: unknown) {
  const targetDigest = 'b'.repeat(64);
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: `${invocationId}-session`,
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'carry-forward-fixture',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    targetDigest,
    inputManifestDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(manifestValue))
      .digest('hex'),
    authorizationNodeId: 'e'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: {
      id: 'expense-app.workflow.blind-survey-output',
      version: 1,
      digest: 'd'.repeat(64),
    },
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest: 'f'.repeat(64),
    limits: { timeoutMs: 300_000, aggregateOutputBytes: 1_048_576 },
  });
}
