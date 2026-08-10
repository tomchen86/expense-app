import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/provider-contracts.ts';
import {
  inspectProviderPromptContextRetentionBinding,
  prepareProviderPromptContextForInvocation,
} from '../src/provider-execution-governance.ts';

const FIRST_AT = new Date('2026-08-10T02:00:00.000Z');
const SECOND_AT = new Date('2026-08-10T02:01:00.000Z');
const THIRD_AT = new Date('2026-08-10T02:02:00.000Z');
const FOURTH_AT = new Date('2026-08-10T02:03:00.000Z');

test('provider semantic-contract changes roll epoch and contractVersion while timeout-only changes do not', () => {
  const store = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-semantic-contract-'),
  );
  const manifestValue = {
    kind: 'provider-semantic-contract-fixture',
    evidence: ['stable-input'],
  };
  try {
    const owner = 'investigation-provider-semantic-contract';
    const firstRequest = providerRequest({
      invocationId: 'provider-semantic-contract-1',
      manifestValue,
    });
    const first = prepareProviderPromptContextForInvocation(
      store,
      firstRequest,
      manifestValue,
      owner,
      FIRST_AT,
    );

    const timeoutRequest = providerRequest({
      invocationId: 'provider-semantic-contract-2',
      manifestValue,
      timeoutMs: 600_000,
    });
    const timeoutOnly = prepareProviderPromptContextForInvocation(
      store,
      timeoutRequest,
      manifestValue,
      owner,
      SECOND_AT,
    );

    assert.equal(timeoutOnly.epoch, first.epoch);
    assert.equal(
      timeoutOnly.manifest.contractVersion,
      first.manifest.contractVersion,
    );
    assert.equal(timeoutOnly.contextDigest, first.contextDigest);
    assert.equal(timeoutOnly.generation, first.generation);

    const schemaRequest = providerRequest({
      invocationId: 'provider-semantic-contract-3',
      manifestValue,
      outputSchemaDigest: 'a'.repeat(64),
    });
    const schemaChanged = prepareProviderPromptContextForInvocation(
      store,
      schemaRequest,
      manifestValue,
      owner,
      THIRD_AT,
    );

    assert.equal(schemaChanged.epoch, timeoutOnly.epoch + 1);
    assert.equal(
      schemaChanged.manifest.contractVersion,
      timeoutOnly.manifest.contractVersion + 1,
    );
    assert.notEqual(schemaChanged.contextDigest, timeoutOnly.contextDigest);

    const evaluatorRequest = providerRequest({
      invocationId: 'provider-semantic-contract-4',
      manifestValue,
      outputSchemaDigest: 'a'.repeat(64),
      evaluatorVersion: 'blind-survey-evaluator.v2',
    });
    const evaluatorChanged = prepareProviderPromptContextForInvocation(
      store,
      evaluatorRequest,
      manifestValue,
      owner,
      FOURTH_AT,
    );

    assert.equal(evaluatorChanged.epoch, schemaChanged.epoch + 1);
    assert.equal(
      evaluatorChanged.manifest.contractVersion,
      schemaChanged.manifest.contractVersion + 1,
    );
    assert.notEqual(
      evaluatorChanged.contextDigest,
      schemaChanged.contextDigest,
    );

    const historical = inspectProviderPromptContextRetentionBinding(
      store,
      firstRequest,
      manifestValue,
      owner,
      FIRST_AT.toISOString(),
    );
    assert.equal(historical?.epoch, first.epoch);
    assert.equal(historical?.contextDigest, first.contextDigest);
    assert.equal(historical?.currentEpoch, evaluatorChanged.epoch);

    const current = inspectProviderPromptContextRetentionBinding(
      store,
      evaluatorRequest,
      manifestValue,
      owner,
      FOURTH_AT.toISOString(),
    );
    assert.equal(current?.epoch, evaluatorChanged.epoch);
    assert.equal(current?.contextDigest, evaluatorChanged.contextDigest);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

function providerRequest(input: {
  invocationId: string;
  manifestValue: unknown;
  timeoutMs?: number;
  outputSchemaDigest?: string;
  evaluatorVersion?: string;
}): ProviderInvocationRequest {
  const targetDigest = 'b'.repeat(64);
  return createProviderInvocationRequest({
    invocationId: input.invocationId,
    nonce: `${input.invocationId}-nonce-000000000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: `${input.invocationId}-session`,
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'semantic-contract-fixture',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    targetDigest,
    inputManifestDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(input.manifestValue))
      .digest('hex'),
    authorizationNodeId: 'e'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: {
      id: 'expense-app.workflow.blind-survey-output',
      version: 1,
      digest: input.outputSchemaDigest ?? 'd'.repeat(64),
    },
    evaluatorVersion: input.evaluatorVersion ?? 'blind-survey-evaluator.v1',
    policyDigest: 'f'.repeat(64),
    limits: {
      timeoutMs: input.timeoutMs ?? 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  });
}
