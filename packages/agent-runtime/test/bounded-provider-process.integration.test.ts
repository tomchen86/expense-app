import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BOUNDED_PROVIDER_PROCESS_CONTRACT_VERSION,
  spawnBoundedProviderProcess,
  type ProviderWrapperProtocolBinding,
} from '../src/index.ts';

const fixtureProcess = path.join(
  import.meta.dirname,
  'fixtures/provider-wrapper-fixture.mjs',
);
const binding: ProviderWrapperProtocolBinding = Object.freeze({
  invocationId: 'invocation-agent-runtime-process',
  requestDigest: 'b'.repeat(64),
  attemptId: 'attempt-agent-runtime-process',
});

test('public bounded process preserves shell:false raw compatibility', async () => {
  assert.equal(
    BOUNDED_PROVIDER_PROCESS_CONTRACT_VERSION,
    'jigwright.agent-runtime.bounded-provider-process.v1',
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-runtime-package-shell-'),
  );
  const marker = path.join(directory, 'must-not-exist');
  try {
    const literal = `$(touch ${marker})`;
    const outcome = await spawnBoundedProviderProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', literal],
      cwd: directory,
      environment: {},
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    assert.equal(outcome.terminationReason, 'exited');
    assert.equal(outcome.stdout, literal);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(outcome.wrapperProtocolReceipt, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public bounded process consumes explicitly declared wrapper protocol', async () => {
  const outcome = await spawnBoundedProviderProcess({
    executable: process.execPath,
    args: [fixtureProcess, 'success'],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 2_000,
    maxOutputBytes: 8_192,
    wrapperProtocol: {
      protocol: 'harness-jsonl-v1',
      binding,
    },
  });

  assert.equal(outcome.terminationReason, 'exited');
  assert.equal(outcome.wrapperProtocolReceipt?.terminal, 'result');
  assert.equal(outcome.wrapperProtocolReceipt?.attemptId, binding.attemptId);
});

for (const fixture of [
  { mode: 'cancel-ack', acknowledged: true, forced: false },
  { mode: 'cancel-ignore', acknowledged: false, forced: true },
] as const) {
  test(`public bounded cancel records ${fixture.mode}`, async () => {
    const controller = new AbortController();
    const outcome = await spawnBoundedProviderProcess({
      executable: process.execPath,
      args: [fixtureProcess, fixture.mode],
      cwd: os.tmpdir(),
      environment: {},
      timeoutMs: 2_000,
      maxOutputBytes: 8_192,
      signal: controller.signal,
      wrapperProtocol: {
        protocol: 'harness-jsonl-v1',
        binding,
        onFrame(receipt) {
          if (receipt.frame.type === 'hello') controller.abort();
        },
      },
    });

    assert.equal(outcome.terminationReason, 'cancelled');
    assert.deepEqual(outcome.wrapperProtocolReceipt?.cancellation, {
      requested: true,
      acknowledged: fixture.acknowledged,
      forced: fixture.forced,
    });
  });
}
