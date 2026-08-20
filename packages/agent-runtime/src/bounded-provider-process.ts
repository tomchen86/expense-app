import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  HARNESS_JSONL_V1_LIMITS,
  ProviderWrapperProtocolError,
  createProviderWrapperProtocolParser,
  type ProviderWrapperProtocolExecution,
  type ProviderWrapperProtocolReceipt,
} from './harness-jsonl-v1.ts';

export const BOUNDED_PROVIDER_PROCESS_CONTRACT_VERSION =
  'jigwright.agent-runtime.bounded-provider-process.v1' as const;

export const BOUNDED_PROVIDER_PROCESS_TERMINATIONS = [
  'exited',
  'timed-out',
  'cancelled',
  'output-limit',
  'spawn-error',
  'protocol-error',
] as const;

export type BoundedProviderProcessTermination =
  (typeof BOUNDED_PROVIDER_PROCESS_TERMINATIONS)[number];

export type BoundedProviderProcessActivity = Readonly<{
  type: 'spawned' | 'stdout' | 'stderr' | BoundedProviderProcessTermination;
  elapsedMs: number;
  bytes?: number;
}>;

export type BoundedProviderProcessInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdinContent?: Buffer;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onActivity?: (event: BoundedProviderProcessActivity) => void;
  wrapperProtocol?: ProviderWrapperProtocolExecution;
}>;

export type BoundedProviderProcessOutcome = Readonly<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnErrorCode: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  terminationReason: BoundedProviderProcessTermination;
  wrapperProtocolReceipt?: ProviderWrapperProtocolReceipt;
}>;

/**
 * Launch one provider process without a shell and observe it asynchronously.
 * The primitive retains at most aggregateOutputBytes + one sentinel byte across
 * both streams, terminates on timeout/output overflow, and accepts an explicit
 * cancellation signal. Wrapper framing is interpreted only after an explicit
 * protocol declaration; undeclared Codex/Claude output remains opaque.
 */
export function spawnBoundedProviderProcess(
  input: BoundedProviderProcessInput,
): Promise<BoundedProviderProcessOutcome> {
  assertBoundedProcessInput(input);
  const protocolParser =
    input.wrapperProtocol === undefined
      ? null
      : createProviderWrapperProtocolParser({
          binding: input.wrapperProtocol.binding,
          ...(input.wrapperProtocol.onFrame === undefined
            ? {}
            : { onFrame: input.wrapperProtocol.onFrame }),
        });
  const started = process.hrtime.bigint();
  if (input.signal?.aborted === true) {
    return Promise.resolve(
      Object.freeze({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnErrorCode: 'ABORT_ERR',
        elapsedMs: 0,
        stdout: '',
        stderr: '',
        terminationReason: 'cancelled' as const,
      }),
    );
  }

  return new Promise((resolve) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let terminationReason: BoundedProviderProcessTermination | null = null;
    let spawnErrorCode: string | null = null;
    let outputBytes = 0;
    let retainedBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let cancelKillTimer: NodeJS.Timeout | undefined;
    let cancellationForced = false;
    let protocolError: ProviderWrapperProtocolError | null = null;
    let wrapperProtocolReceipt: ProviderWrapperProtocolReceipt | undefined;
    let settled = false;

    const elapsedMs = () =>
      Number((process.hrtime.bigint() - started) / 1_000_000n);
    const emit = (
      type: BoundedProviderProcessActivity['type'],
      bytes?: number,
    ) => {
      try {
        input.onActivity?.({
          type,
          elapsedMs: elapsedMs(),
          ...(bytes === undefined ? {} : { bytes }),
        });
      } catch {
        // Activity observation must not gain process-control authority.
      }
    };
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // A process that already exited needs no further termination.
        }
      }
    };
    const terminate = (reason: BoundedProviderProcessTermination) => {
      if (terminationReason !== null) return;
      terminationReason = reason;
      if (reason === 'cancelled') {
        killProcessGroup('SIGTERM');
        cancelKillTimer = setTimeout(() => {
          cancellationForced = true;
          killProcessGroup('SIGKILL');
        }, HARNESS_JSONL_V1_LIMITS.cancelGraceMs);
        cancelKillTimer.unref();
      } else {
        killProcessGroup('SIGKILL');
      }
    };
    const retain = (
      target: Buffer[],
      chunk: Buffer,
      stream: 'stdout' | 'stderr',
    ) => {
      outputBytes += chunk.length;
      const remaining = input.maxOutputBytes + 1 - retainedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        target.push(retained);
        retainedBytes += retained.length;
      }
      emit(stream, chunk.length);
      if (
        stream === 'stdout' &&
        protocolParser !== null &&
        protocolError === null
      ) {
        try {
          protocolParser.push(chunk);
        } catch (error) {
          protocolError =
            error instanceof ProviderWrapperProtocolError
              ? error
              : new ProviderWrapperProtocolError();
          spawnErrorCode = protocolError.code;
          terminate('protocol-error');
        }
      }
      if (outputBytes > input.maxOutputBytes) {
        terminate('output-limit');
      }
    };
    const onAbort = () => {
      if (
        protocolParser !== null &&
        protocolError === null &&
        (terminationReason === null || terminationReason === 'cancelled')
      ) {
        try {
          protocolParser.requestCancellation();
        } catch (error) {
          protocolError =
            error instanceof ProviderWrapperProtocolError
              ? error
              : new ProviderWrapperProtocolError();
          spawnErrorCode = protocolError.code;
          terminate('protocol-error');
          return;
        }
      }
      terminate('cancelled');
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => terminate('timed-out'), input.timeoutMs);
    timeout.unref();

    child.once('spawn', () => emit('spawned'));
    child.stdout.on('data', (chunk: Buffer) => retain(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => retain(stderr, chunk, 'stderr'));
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? 'SPAWN_FAILED';
      terminationReason ??= 'spawn-error';
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cancelKillTimer !== undefined) clearTimeout(cancelKillTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (
        protocolParser !== null &&
        protocolError === null &&
        (terminationReason === null || terminationReason === 'cancelled')
      ) {
        try {
          wrapperProtocolReceipt = protocolParser.finish({
            cancellationForced,
          });
        } catch (error) {
          protocolError =
            error instanceof ProviderWrapperProtocolError
              ? error
              : new ProviderWrapperProtocolError();
          spawnErrorCode = protocolError.code;
          terminationReason = 'protocol-error';
        }
      }
      const reason =
        protocolError === null
          ? (terminationReason ?? 'exited')
          : 'protocol-error';
      emit(reason);
      resolve(
        Object.freeze({
          exitCode,
          signal,
          timedOut: reason === 'timed-out',
          spawnErrorCode: reason === 'cancelled' ? 'ABORT_ERR' : spawnErrorCode,
          elapsedMs: elapsedMs(),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          terminationReason: reason,
          ...(wrapperProtocolReceipt === undefined
            ? {}
            : { wrapperProtocolReceipt }),
        }),
      );
    });

    child.stdin.once('error', () => {
      // EPIPE is reflected by the process close outcome; never convert it into
      // a second terminal event or an unhandled stream error.
    });
    child.stdin.end(input.stdinContent);
  });
}

function assertBoundedProcessInput(input: BoundedProviderProcessInput): void {
  if (!path.isAbsolute(input.executable) || !path.isAbsolute(input.cwd)) {
    throw new TypeError('Provider executable and cwd must be absolute paths.');
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes <= 0
  ) {
    throw new RangeError(
      'Provider process bounds must be positive safe integers.',
    );
  }
  if (!input.args.every((argument) => typeof argument === 'string')) {
    throw new TypeError('Provider arguments must be strings.');
  }
  if (
    input.wrapperProtocol !== undefined &&
    input.wrapperProtocol.protocol !== 'harness-jsonl-v1'
  ) {
    throw new ProviderWrapperProtocolError();
  }
}
