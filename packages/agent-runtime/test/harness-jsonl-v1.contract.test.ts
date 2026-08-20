import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARNESS_JSONL_V1_CONTRACT_VERSION,
  HARNESS_JSONL_V1_LIMITS,
  ProviderWrapperProtocolError,
  assertProviderWrapperProtocolReceipt,
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
  type ProviderWrapperProtocolBinding,
} from '../src/index.ts';

const binding: ProviderWrapperProtocolBinding = Object.freeze({
  invocationId: 'invocation-agent-runtime-package',
  requestDigest: 'a'.repeat(64),
  attemptId: 'attempt-agent-runtime-package',
});

test('public harness-jsonl-v1 contract is versioned and engine-bound', () => {
  assert.equal(
    HARNESS_JSONL_V1_CONTRACT_VERSION,
    'jigwright.agent-runtime.harness-jsonl.v1',
  );
  assert.deepEqual(HARNESS_JSONL_V1_LIMITS, {
    maxLineBytes: 4_096,
    maxAggregateBytes: 65_536,
    maxFrameCount: 128,
    cancelGraceMs: 100,
  });

  const parser = createProviderWrapperProtocolParser({ binding });
  parser.push(
    Buffer.from(
      [
        renderProviderWrapperFrame({
          schemaVersion: 1,
          type: 'hello',
          sequence: 1,
          protocol: 'harness-jsonl-v1',
        }),
        renderProviderWrapperFrame({
          schemaVersion: 1,
          type: 'progress',
          sequence: 2,
          phase: 'model',
        }),
        renderProviderWrapperFrame({
          schemaVersion: 1,
          type: 'result',
          sequence: 3,
          outputSlot: 'primary',
        }),
      ].join(''),
    ),
  );
  const receipt = parser.finish({ cancellationForced: false });

  assert.equal(receipt.invocationId, binding.invocationId);
  assert.equal(receipt.requestDigest, binding.requestDigest);
  assert.equal(receipt.attemptId, binding.attemptId);
  assert.equal(receipt.terminal, 'result');
  assert.deepEqual(
    assertProviderWrapperProtocolReceipt(receipt, binding),
    receipt,
  );
});

test('public protocol parser fails closed on unknown and post-terminal frames', () => {
  const hello = renderProviderWrapperFrame({
    schemaVersion: 1,
    type: 'hello',
    sequence: 1,
    protocol: 'harness-jsonl-v1',
  });
  const result = renderProviderWrapperFrame({
    schemaVersion: 1,
    type: 'result',
    sequence: 2,
    outputSlot: 'primary',
  });

  for (const stream of [
    `${JSON.stringify({ schemaVersion: 1, type: 'unknown', sequence: 1 })}\n`,
    `${hello}${result}${JSON.stringify({ schemaVersion: 1, type: 'progress', sequence: 3, phase: 'tool' })}\n`,
  ]) {
    const parser = createProviderWrapperProtocolParser({ binding });
    assert.throws(
      () => parser.push(Buffer.from(stream)),
      ProviderWrapperProtocolError,
    );
  }
});
