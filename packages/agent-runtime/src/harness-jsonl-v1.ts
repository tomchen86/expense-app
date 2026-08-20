import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '@jigwright/core/canonical-json';

export const HARNESS_JSONL_V1_CONTRACT_VERSION =
  'jigwright.agent-runtime.harness-jsonl.v1' as const;

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export const HARNESS_JSONL_V1_LIMITS = Object.freeze({
  maxLineBytes: 4_096,
  maxAggregateBytes: 64 * 1_024,
  maxFrameCount: 128,
  cancelGraceMs: 100,
});

export type ProviderWrapperProtocolDeclaration = Readonly<{
  protocol: 'harness-jsonl-v1';
}>;

export type ProviderWrapperProtocolBinding = Readonly<{
  invocationId: string;
  requestDigest: string;
  attemptId: string;
}>;

export type ProviderWrapperHelloFrame = Readonly<{
  schemaVersion: 1;
  type: 'hello';
  sequence: number;
  protocol: 'harness-jsonl-v1';
}>;

export type ProviderWrapperProgressFrame = Readonly<{
  schemaVersion: 1;
  type: 'progress';
  sequence: number;
  phase: 'starting' | 'tool' | 'model' | 'finalizing';
}>;

export type ProviderWrapperResultFrame = Readonly<{
  schemaVersion: 1;
  type: 'result';
  sequence: number;
  outputSlot: 'primary';
}>;

export type ProviderWrapperErrorFrame = Readonly<{
  schemaVersion: 1;
  type: 'error';
  sequence: number;
  code: string;
}>;

export type ProviderWrapperCancelAckFrame = Readonly<{
  schemaVersion: 1;
  type: 'cancel-ack';
  sequence: number;
}>;

export type ProviderWrapperFrame =
  | ProviderWrapperHelloFrame
  | ProviderWrapperProgressFrame
  | ProviderWrapperResultFrame
  | ProviderWrapperErrorFrame
  | ProviderWrapperCancelAckFrame;

export type ProviderWrapperFrameReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-wrapper-frame-receipt';
  protocol: 'harness-jsonl-v1';
  receiptSequence: number;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  frame: ProviderWrapperFrame;
}>;

export type ProviderWrapperProtocolReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-wrapper-protocol-receipt';
  protocol: 'harness-jsonl-v1';
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  frameCount: number;
  aggregateBytes: number;
  lastSequence: number;
  progressFrameCount: number;
  terminal: 'result' | 'error' | 'cancelled';
  outputSlot: 'primary' | null;
  errorCode: string | null;
  cancellation: Readonly<{
    requested: boolean;
    acknowledged: boolean;
    forced: boolean;
  }>;
  receiptDigest: string;
}>;

export type ProviderWrapperProtocolExecution =
  ProviderWrapperProtocolDeclaration &
    Readonly<{
      binding: ProviderWrapperProtocolBinding;
      onFrame?: (receipt: ProviderWrapperFrameReceipt) => void;
    }>;

export class ProviderWrapperProtocolError extends Error {
  readonly code = 'PROVIDER_WRAPPER_PROTOCOL_INVALID';

  constructor() {
    super('Provider wrapper protocol stream is malformed or out of order.');
    this.name = 'ProviderWrapperProtocolError';
  }
}

export function renderProviderWrapperFrame(
  frame: ProviderWrapperFrame,
): string {
  const admitted = assertProviderWrapperFrame(frame);
  const rendered = `${canonicalJson(admitted)}\n`;
  if (
    Buffer.byteLength(rendered, 'utf8') > HARNESS_JSONL_V1_LIMITS.maxLineBytes
  ) {
    throw new ProviderWrapperProtocolError();
  }
  return rendered;
}

export function assertProviderWrapperProtocolReceipt(
  value: unknown,
  expectedBinding?: ProviderWrapperProtocolBinding,
): ProviderWrapperProtocolReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'protocol',
      'invocationId',
      'requestDigest',
      'attemptId',
      'frameCount',
      'aggregateBytes',
      'lastSequence',
      'progressFrameCount',
      'terminal',
      'outputSlot',
      'errorCode',
      'cancellation',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-wrapper-protocol-receipt' ||
    value.protocol !== 'harness-jsonl-v1' ||
    !Number.isSafeInteger(value.frameCount) ||
    (value.frameCount as number) < 1 ||
    (value.frameCount as number) > HARNESS_JSONL_V1_LIMITS.maxFrameCount ||
    !Number.isSafeInteger(value.aggregateBytes) ||
    (value.aggregateBytes as number) < 1 ||
    (value.aggregateBytes as number) >
      HARNESS_JSONL_V1_LIMITS.maxAggregateBytes ||
    value.lastSequence !== value.frameCount ||
    !Number.isSafeInteger(value.progressFrameCount) ||
    (value.progressFrameCount as number) < 0 ||
    (value.progressFrameCount as number) > (value.frameCount as number) ||
    !['result', 'error', 'cancelled'].includes(String(value.terminal)) ||
    !isRecord(value.cancellation) ||
    !hasExactKeys(value.cancellation, [
      'requested',
      'acknowledged',
      'forced',
    ]) ||
    typeof value.cancellation.requested !== 'boolean' ||
    typeof value.cancellation.acknowledged !== 'boolean' ||
    typeof value.cancellation.forced !== 'boolean' ||
    (value.cancellation.acknowledged && !value.cancellation.requested) ||
    (value.cancellation.forced && !value.cancellation.requested) ||
    (value.terminal === 'result' &&
      (value.outputSlot !== 'primary' || value.errorCode !== null)) ||
    (value.terminal === 'error' &&
      (value.outputSlot !== null ||
        typeof value.errorCode !== 'string' ||
        !ERROR_CODE.test(value.errorCode))) ||
    (value.terminal === 'cancelled' &&
      (value.outputSlot !== null ||
        value.errorCode !== null ||
        !value.cancellation.requested)) ||
    (value.terminal !== 'cancelled' && value.cancellation.requested) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw new ProviderWrapperProtocolError();
  }
  const binding = assertProviderWrapperBinding({
    invocationId: value.invocationId as string,
    requestDigest: value.requestDigest as string,
    attemptId: value.attemptId as string,
  });
  if (
    expectedBinding !== undefined &&
    canonicalJson(binding) !==
      canonicalJson(assertProviderWrapperBinding(expectedBinding))
  ) {
    throw new ProviderWrapperProtocolError();
  }
  const payload = { ...value };
  delete payload.receiptDigest;
  if (sha256(canonicalJson(payload)) !== value.receiptDigest) {
    throw new ProviderWrapperProtocolError();
  }
  return deepFreeze(structuredClone(value) as ProviderWrapperProtocolReceipt);
}

export function createProviderWrapperProtocolParser(input: {
  binding: ProviderWrapperProtocolBinding;
  onFrame?: (receipt: ProviderWrapperFrameReceipt) => void;
}) {
  const binding = assertProviderWrapperBinding(input.binding);
  let pending = Buffer.alloc(0);
  let aggregateBytes = 0;
  let frameCount = 0;
  let progressFrameCount = 0;
  let nextSequence = 1;
  let helloSeen = false;
  let terminalFrame:
    ProviderWrapperResultFrame | ProviderWrapperErrorFrame | null = null;
  let cancellationRequested = false;
  let cancellationAcknowledged = false;
  let finished = false;

  const fail = (): never => {
    throw new ProviderWrapperProtocolError();
  };

  const admit = (candidate: unknown): void => {
    if (finished || terminalFrame !== null) fail();
    const frame = assertProviderWrapperFrame(candidate);
    if (frame.sequence !== nextSequence) fail();
    if (!helloSeen) {
      if (
        frame.type !== 'hello' ||
        frame.sequence !== 1 ||
        frame.protocol !== 'harness-jsonl-v1'
      ) {
        fail();
      }
      helloSeen = true;
    } else if (frame.type === 'hello') {
      fail();
    } else if (frame.type === 'progress') {
      progressFrameCount += 1;
    } else if (frame.type === 'cancel-ack') {
      if (!cancellationRequested || cancellationAcknowledged) fail();
      cancellationAcknowledged = true;
    } else {
      terminalFrame = frame;
    }
    frameCount += 1;
    nextSequence += 1;
    if (frameCount > HARNESS_JSONL_V1_LIMITS.maxFrameCount) fail();
    const receipt = deepFreeze({
      schemaVersion: 1 as const,
      kind: 'provider-wrapper-frame-receipt' as const,
      protocol: 'harness-jsonl-v1' as const,
      receiptSequence: frameCount,
      ...binding,
      frame,
    });
    try {
      input.onFrame?.(receipt);
    } catch {
      // Observation callbacks never gain parser or process-control authority.
    }
  };

  const parseLine = (line: Buffer): void => {
    if (
      line.length === 0 ||
      line.length + 1 > HARNESS_JSONL_V1_LIMITS.maxLineBytes ||
      line.at(-1) === 0x0d
    ) {
      fail();
    }
    let document = '';
    try {
      document = new TextDecoder('utf-8', { fatal: true }).decode(line);
    } catch {
      fail();
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(document) as unknown;
    } catch {
      fail();
    }
    admit(candidate);
  };

  return Object.freeze({
    push(chunk: Buffer): void {
      if (finished || !Buffer.isBuffer(chunk) || chunk.length === 0) fail();
      aggregateBytes += chunk.length;
      if (
        aggregateBytes > HARNESS_JSONL_V1_LIMITS.maxAggregateBytes ||
        !Number.isSafeInteger(aggregateBytes)
      ) {
        fail();
      }
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        parseLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
      }
      if (pending.length >= HARNESS_JSONL_V1_LIMITS.maxLineBytes) fail();
    },
    requestCancellation(): void {
      if (finished || terminalFrame !== null || cancellationRequested) fail();
      cancellationRequested = true;
    },
    finish(input: {
      cancellationForced: boolean;
    }): ProviderWrapperProtocolReceipt {
      if (
        finished ||
        pending.length !== 0 ||
        !helloSeen ||
        typeof input.cancellationForced !== 'boolean' ||
        (input.cancellationForced && !cancellationRequested) ||
        (!cancellationRequested && terminalFrame === null)
      ) {
        fail();
      }
      finished = true;
      const terminal = cancellationRequested
        ? ('cancelled' as const)
        : terminalFrame!.type;
      const payload = {
        schemaVersion: 1 as const,
        kind: 'provider-wrapper-protocol-receipt' as const,
        protocol: 'harness-jsonl-v1' as const,
        ...binding,
        frameCount,
        aggregateBytes,
        lastSequence: nextSequence - 1,
        progressFrameCount,
        terminal,
        outputSlot:
          terminal === 'result' && terminalFrame?.type === 'result'
            ? terminalFrame.outputSlot
            : null,
        errorCode:
          terminal === 'error' && terminalFrame?.type === 'error'
            ? terminalFrame.code
            : null,
        cancellation: {
          requested: cancellationRequested,
          acknowledged: cancellationAcknowledged,
          forced: input.cancellationForced,
        },
      };
      return assertProviderWrapperProtocolReceipt({
        ...payload,
        receiptDigest: sha256(canonicalJson(payload)),
      });
    },
  });
}

function assertProviderWrapperBinding(
  value: ProviderWrapperProtocolBinding,
): ProviderWrapperProtocolBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['invocationId', 'requestDigest', 'attemptId']) ||
    typeof value.invocationId !== 'string' ||
    !IDENTIFIER.test(value.invocationId) ||
    typeof value.requestDigest !== 'string' ||
    !DIGEST.test(value.requestDigest) ||
    typeof value.attemptId !== 'string' ||
    !IDENTIFIER.test(value.attemptId)
  ) {
    throw new ProviderWrapperProtocolError();
  }
  return deepFreeze(structuredClone(value));
}

function assertProviderWrapperFrame(value: unknown): ProviderWrapperFrame {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1
  ) {
    throw new ProviderWrapperProtocolError();
  }
  if (
    value.type === 'hello' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'protocol']) &&
    value.protocol === 'harness-jsonl-v1'
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperHelloFrame);
  }
  if (
    value.type === 'progress' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'phase']) &&
    ['starting', 'tool', 'model', 'finalizing'].includes(String(value.phase))
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperProgressFrame);
  }
  if (
    value.type === 'result' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'outputSlot']) &&
    value.outputSlot === 'primary'
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperResultFrame);
  }
  if (
    value.type === 'error' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'code']) &&
    typeof value.code === 'string' &&
    ERROR_CODE.test(value.code)
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperErrorFrame);
  }
  if (
    value.type === 'cancel-ack' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence'])
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperCancelAckFrame);
  }
  throw new ProviderWrapperProtocolError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
