import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { spawnBoundedProviderProcess } from '../src/runtime/provider-execution/bounded-provider-process.ts';
import {
  HARNESS_JSONL_V1_LIMITS,
  ProviderWrapperProtocolError,
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
  type ProviderWrapperFrame,
  type ProviderWrapperProtocolBinding,
} from '../src/modules/provider-orchestration/agent-runtime-protocol.ts';

const fixtureProcess = path.join(
  import.meta.dirname,
  'fixtures/provider-wrapper-fixture.mjs',
);
const protocolBinding: ProviderWrapperProtocolBinding = Object.freeze({
  invocationId: 'invocation-wrapper-fixture',
  requestDigest: 'a'.repeat(64),
  attemptId: 'attempt-wrapper-fixture',
});

test('bounded provider process uses shell:false and reports stream activity', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-async-shell-'),
  );
  const shellMarker = path.join(directory, 'must-not-exist');
  const events: string[] = [];
  try {
    const literalArgument = `$(touch ${shellMarker})`;
    const outcome = await spawnBoundedProviderProcess({
      executable: process.execPath,
      args: [
        '-e',
        [
          "process.stdin.setEncoding('utf8');",
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          '  process.stdout.write(JSON.stringify({ argument: process.argv[1], input }));',
          "  process.stderr.write('observed-stderr');",
          '});',
        ].join('\n'),
        literalArgument,
      ],
      cwd: directory,
      environment: {},
      stdinContent: Buffer.from('managed-input', 'utf8'),
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
      onActivity(event) {
        events.push(event.type);
      },
    });

    assert.equal(outcome.terminationReason, 'exited');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.spawnErrorCode, null);
    assert.deepEqual(JSON.parse(outcome.stdout), {
      argument: literalArgument,
      input: 'managed-input',
    });
    assert.equal(outcome.stderr, 'observed-stderr');
    assert.equal(fs.existsSync(shellMarker), false);
    assert.ok(events.includes('spawned'));
    assert.ok(events.includes('stdout'));
    assert.ok(events.includes('stderr'));
    assert.equal(events.at(-1), 'exited');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded provider process terminates on the aggregate output cap', async () => {
  const outcome = await spawnBoundedProviderProcess({
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000);",
    ],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
  });

  assert.equal(outcome.terminationReason, 'output-limit');
  assert.equal(outcome.timedOut, false);
  assert.ok(
    Buffer.byteLength(outcome.stdout, 'utf8') +
      Buffer.byteLength(outcome.stderr, 'utf8') <=
      1_025,
  );
});

test('bounded provider process enforces a hard timeout', async () => {
  const outcome = await spawnBoundedProviderProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 75,
    maxOutputBytes: 1_024,
  });

  assert.equal(outcome.terminationReason, 'timed-out');
  assert.equal(outcome.timedOut, true);
  assert.ok(outcome.elapsedMs < 2_000);
});

test('bounded provider process supports AbortSignal cancellation', async () => {
  const controller = new AbortController();
  const outcomePromise = spawnBoundedProviderProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
    signal: controller.signal,
    onActivity(event) {
      if (event.type === 'spawned') {
        controller.abort();
      }
    },
  });

  const outcome = await outcomePromise;
  assert.equal(outcome.terminationReason, 'cancelled');
  assert.equal(outcome.timedOut, false);
  assert.ok(outcome.elapsedMs < 2_000);
});

test('harness-jsonl-v1 renderer and parser stamp exact engine-owned binding', () => {
  const frames: ProviderWrapperFrame[] = [
    {
      schemaVersion: 1,
      type: 'hello',
      sequence: 1,
      protocol: 'harness-jsonl-v1',
    },
    { schemaVersion: 1, type: 'progress', sequence: 2, phase: 'tool' },
    {
      schemaVersion: 1,
      type: 'result',
      sequence: 3,
      outputSlot: 'primary',
    },
  ];
  const stamped: string[] = [];
  const parser = createProviderWrapperProtocolParser({
    binding: protocolBinding,
    onFrame(receipt) {
      stamped.push(
        `${receipt.invocationId}:${receipt.requestDigest}:${receipt.attemptId}:${receipt.receiptSequence}:${receipt.frame.type}`,
      );
    },
  });
  parser.push(Buffer.from(frames.map(renderProviderWrapperFrame).join('')));
  const receipt = parser.finish({ cancellationForced: false });

  assert.deepEqual(stamped, [
    `invocation-wrapper-fixture:${'a'.repeat(64)}:attempt-wrapper-fixture:1:hello`,
    `invocation-wrapper-fixture:${'a'.repeat(64)}:attempt-wrapper-fixture:2:progress`,
    `invocation-wrapper-fixture:${'a'.repeat(64)}:attempt-wrapper-fixture:3:result`,
  ]);
  assert.equal(receipt.terminal, 'result');
  assert.equal(receipt.outputSlot, 'primary');
  assert.equal(receipt.frameCount, 3);
  assert.equal(receipt.progressFrameCount, 1);
  assert.deepEqual(receipt.cancellation, {
    requested: false,
    acknowledged: false,
    forced: false,
  });
});

test('harness-jsonl-v1 fails closed on unknown, out-of-order, duplicate, trailing, and oversized frames', () => {
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
  const invalidStreams = [
    `${JSON.stringify({ schemaVersion: 1, type: 'unknown', sequence: 1 })}\n`,
    renderProviderWrapperFrame({
      schemaVersion: 1,
      type: 'progress',
      sequence: 1,
      phase: 'tool',
    }),
    `${hello}${JSON.stringify({ schemaVersion: 1, type: 'progress', sequence: 1, phase: 'tool' })}\n`,
    `${hello}${result}${JSON.stringify({ schemaVersion: 1, type: 'progress', sequence: 3, phase: 'model' })}\n`,
    `${hello}{"schemaVersion":1`,
  ];
  for (const stream of invalidStreams) {
    const parser = createProviderWrapperProtocolParser({
      binding: protocolBinding,
    });
    assert.throws(() => {
      parser.push(Buffer.from(stream));
      parser.finish({ cancellationForced: false });
    }, ProviderWrapperProtocolError);
  }

  const oversized = createProviderWrapperProtocolParser({
    binding: protocolBinding,
  });
  assert.throws(
    () =>
      oversized.push(
        Buffer.alloc(HARNESS_JSONL_V1_LIMITS.maxAggregateBytes + 1, 0x61),
      ),
    ProviderWrapperProtocolError,
  );
  const overlongLine = createProviderWrapperProtocolParser({
    binding: protocolBinding,
  });
  assert.throws(
    () =>
      overlongLine.push(
        Buffer.alloc(HARNESS_JSONL_V1_LIMITS.maxLineBytes, 0x61),
      ),
    ProviderWrapperProtocolError,
  );
  const tooManyFrames = createProviderWrapperProtocolParser({
    binding: protocolBinding,
  });
  assert.throws(
    () =>
      tooManyFrames.push(
        Buffer.from(
          [
            hello,
            ...Array.from(
              { length: HARNESS_JSONL_V1_LIMITS.maxFrameCount },
              (_, index) =>
                renderProviderWrapperFrame({
                  schemaVersion: 1,
                  type: 'progress',
                  sequence: index + 2,
                  phase: 'tool',
                }),
            ),
          ].join(''),
        ),
      ),
    ProviderWrapperProtocolError,
  );
  assert.throws(
    () =>
      renderProviderWrapperFrame({
        schemaVersion: 1,
        type: 'progress',
        sequence: 1,
        phase: 'tool',
        extra: true,
      } as never),
    ProviderWrapperProtocolError,
  );
});

test('bounded provider process produces a typed wrapper terminal receipt', async () => {
  const outcome = await spawnBoundedProviderProcess({
    executable: process.execPath,
    args: [fixtureProcess, 'success'],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 2_000,
    maxOutputBytes: 8_192,
    wrapperProtocol: {
      protocol: 'harness-jsonl-v1',
      binding: protocolBinding,
    },
  });

  assert.equal(outcome.terminationReason, 'exited');
  assert.equal(outcome.wrapperProtocolReceipt?.terminal, 'result');
  assert.equal(
    outcome.wrapperProtocolReceipt?.attemptId,
    protocolBinding.attemptId,
  );
  assert.equal(outcome.wrapperProtocolReceipt?.progressFrameCount, 1);
});

test('bounded provider process preserves a typed wrapper error terminal', async () => {
  const outcome = await spawnBoundedProviderProcess({
    executable: process.execPath,
    args: [fixtureProcess, 'error'],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 2_000,
    maxOutputBytes: 8_192,
    wrapperProtocol: {
      protocol: 'harness-jsonl-v1',
      binding: protocolBinding,
    },
  });

  assert.equal(outcome.terminationReason, 'exited');
  assert.equal(outcome.wrapperProtocolReceipt?.terminal, 'error');
  assert.equal(outcome.wrapperProtocolReceipt?.errorCode, 'FIXTURE_REJECTED');
  assert.equal(outcome.wrapperProtocolReceipt?.outputSlot, null);
});

test('wrapper parsing preserves the policy-owned timeout terminal', async () => {
  const outcome = await spawnBoundedProviderProcess({
    executable: process.execPath,
    args: [fixtureProcess, 'cancel-ignore'],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: 75,
    maxOutputBytes: 8_192,
    wrapperProtocol: {
      protocol: 'harness-jsonl-v1',
      binding: protocolBinding,
    },
  });

  assert.equal(outcome.terminationReason, 'timed-out');
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.wrapperProtocolReceipt, undefined);
});

for (const fixture of [
  { mode: 'cancel-ack', acknowledged: true, forced: false },
  { mode: 'cancel-ignore', acknowledged: false, forced: true },
] as const) {
  test(`bounded wrapper cancellation records ${fixture.mode}`, async () => {
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
        binding: protocolBinding,
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
    assert.equal(outcome.wrapperProtocolReceipt?.terminal, 'cancelled');
  });
}
