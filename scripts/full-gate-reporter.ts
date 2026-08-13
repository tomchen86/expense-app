import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { spec, type TestEvent } from 'node:test/reporters';

export const FULL_GATE_TELEMETRY_KIND =
  'workflow-full-gate-test-telemetry.v1' as const;
export const FULL_GATE_TELEMETRY_END_KIND =
  'workflow-full-gate-test-telemetry-end.v1' as const;
export const FULL_GATE_TELEMETRY_PATH_ENV =
  'WORKFLOW_FULL_GATE_TELEMETRY_PATH' as const;
export const FULL_GATE_REPOSITORY_ROOT_ENV =
  'WORKFLOW_FULL_GATE_REPOSITORY_ROOT' as const;

const DEFAULT_MAX_RECORDS = 100_000;
const MAX_NAME_BYTES = 2_048;
const MAX_FILE_BYTES = 4_096;
const MAX_JSONL_RECORD_BYTES = 16_384;

export type FullGateTestEvent = TestEvent;
export type FullGateTestOutcome = 'passed' | 'not-passed' | 'skipped' | 'todo';

export type FullGateTestTelemetryRecord = Readonly<{
  kind: typeof FULL_GATE_TELEMETRY_KIND;
  sequence: number;
  testNumber: number | null;
  file: string | null;
  line: number | null;
  name: string;
  nesting: number;
  outcome: FullGateTestOutcome;
  durationMs: number;
}>;

export type FullGateTelemetryEndRecord = Readonly<{
  kind: typeof FULL_GATE_TELEMETRY_END_KIND;
  recordCount: number;
}>;

export type FullGateTelemetryRecord =
  FullGateTestTelemetryRecord | FullGateTelemetryEndRecord;

export type FullGateTelemetryProjectorOptions = Readonly<{
  repositoryRoot: string;
  maxRecords?: number;
}>;

export type FullGateReporterOptions = FullGateTelemetryProjectorOptions &
  Readonly<{
    telemetryPath: string;
  }>;

export type FullGateTelemetryProjector = Readonly<{
  observe(event: FullGateTestEvent): FullGateTestTelemetryRecord | null;
  readonly recordCount: number;
  readonly records: readonly FullGateTestTelemetryRecord[];
}>;

export type FullGateTelemetrySink = Readonly<{
  path: string;
  write(record: FullGateTelemetryRecord): void;
  close(): void;
}>;

/**
 * Projects Node test-runner lifecycle events into one bounded record per test
 * node. Parent subtests are included, so durations are not additive workload.
 * Diagnostic, stdout, stderr, and assertion error payloads are never inspected.
 */
export function createFullGateTelemetryProjector(
  options: FullGateTelemetryProjectorOptions,
): FullGateTelemetryProjector {
  const repositoryRoot = canonicalExistingDirectory(options.repositoryRoot);
  const maxRecords = positiveInteger(
    options.maxRecords ?? DEFAULT_MAX_RECORDS,
    'maxRecords',
  );
  const projected: FullGateTestTelemetryRecord[] = [];

  const complete = (
    event: Extract<FullGateTestEvent, { type: 'test:pass' | 'test:fail' }>,
  ): FullGateTestTelemetryRecord | null => {
    if (event.data.details.type === 'suite') return null;
    if (projected.length >= maxRecords) {
      throw new Error(
        `Full-gate telemetry exceeds its ${maxRecords} record bound.`,
      );
    }
    const record: FullGateTestTelemetryRecord = Object.freeze({
      kind: FULL_GATE_TELEMETRY_KIND,
      sequence: projected.length + 1,
      testNumber: safeIntegerOrNull(event.data.testNumber),
      file: canonicalTestFile(event.data.file, repositoryRoot),
      line: safeIntegerOrNull(event.data.line),
      name: boundedSafeText(event.data.name, MAX_NAME_BYTES),
      nesting: nonnegativeInteger(event.data.nesting, 'nesting'),
      outcome: terminalOutcome(event),
      durationMs: boundedDuration(event.data.details.duration_ms),
    });
    serializeFullGateTelemetryRecord(record);
    projected.push(record);
    return record;
  };

  return Object.freeze({
    observe(event: FullGateTestEvent): FullGateTestTelemetryRecord | null {
      switch (event.type) {
        case 'test:pass':
        case 'test:fail':
          return complete(event);
        default:
          return null;
      }
    },
    get recordCount(): number {
      return projected.length;
    },
    get records(): readonly FullGateTestTelemetryRecord[] {
      return Object.freeze([...projected]);
    },
  });
}

/** Opens one new JSONL sidecar. Existing paths are never appended or replaced. */
export function openFullGateTelemetrySink(
  telemetryPath: string,
): FullGateTelemetrySink {
  if (!path.isAbsolute(telemetryPath)) {
    throw new Error('Full-gate telemetry path must be absolute.');
  }
  const target = path.resolve(telemetryPath);
  const parent = path.dirname(target);
  const canonicalParent = canonicalExistingDirectory(parent);
  if (canonicalParent !== parent) {
    throw new Error(
      'Full-gate telemetry parent must be canonical and contain no symlink ancestor.',
    );
  }
  const parentStats = fs.lstatSync(parent);
  if ((parentStats.mode & 0o077) !== 0) {
    throw new Error('Full-gate telemetry parent directory must be private.');
  }
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined) {
    throw new Error('Full-gate telemetry output already exists.');
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      throw new Error('Full-gate telemetry output already exists.');
    }
    throw error;
  }
  fs.fchmodSync(descriptor, 0o600);
  let closed = false;

  const assertLiveTarget = (): void => {
    if (closed) throw new Error('Full-gate telemetry sink is closed.');
    const descriptorStats = fs.fstatSync(descriptor);
    const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      !descriptorStats.isFile() ||
      descriptorStats.nlink !== 1 ||
      (descriptorStats.mode & 0o777) !== 0o600 ||
      targetStats === undefined ||
      !targetStats.isFile() ||
      targetStats.isSymbolicLink() ||
      targetStats.nlink !== 1 ||
      targetStats.dev !== descriptorStats.dev ||
      targetStats.ino !== descriptorStats.ino
    ) {
      throw new Error(
        'Full-gate telemetry output was replaced, linked, or made non-private.',
      );
    }
  };

  try {
    assertLiveTarget();
    fsyncDirectory(parent);
  } catch (error) {
    const descriptorStats = fs.fstatSync(descriptor);
    fs.closeSync(descriptor);
    closed = true;
    const observed = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      observed?.isFile() &&
      !observed.isSymbolicLink() &&
      observed.nlink === 1 &&
      observed.dev === descriptorStats.dev &&
      observed.ino === descriptorStats.ino
    ) {
      fs.unlinkSync(target);
    }
    throw error;
  }

  return Object.freeze({
    path: target,
    write(record: FullGateTelemetryRecord): void {
      assertLiveTarget();
      const bytes = Buffer.from(serializeFullGateTelemetryRecord(record));
      let offset = 0;
      while (offset < bytes.length) {
        offset += fs.writeSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
        );
      }
    },
    close(): void {
      if (closed) return;
      assertLiveTarget();
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      closed = true;
      fsyncDirectory(parent);
    },
  });
}

/**
 * A custom Node reporter that preserves the built-in spec rendering and emits
 * the observational sidecar in the same event-consumption pass.
 */
export async function* reportWithFullGateTelemetry(
  source: AsyncIterable<FullGateTestEvent>,
  options: FullGateReporterOptions,
): AsyncGenerator<string, void> {
  const projector = createFullGateTelemetryProjector(options);
  const sink = openFullGateTelemetrySink(options.telemetryPath);
  let sourceExhausted = false;

  async function* observedEvents(): AsyncGenerator<FullGateTestEvent, void> {
    for await (const event of source) {
      const record = projector.observe(event);
      if (record !== null) sink.write(record);
      yield event;
    }
    sourceExhausted = true;
  }

  try {
    const rendered = Readable.from(observedEvents(), {
      objectMode: true,
    }).pipe(spec());
    for await (const chunk of rendered) yield String(chunk);
    if (sourceExhausted) {
      sink.write({
        kind: FULL_GATE_TELEMETRY_END_KIND,
        recordCount: projector.recordCount,
      });
    }
  } finally {
    sink.close();
  }
}

export default async function* fullGateReporter(
  source: AsyncIterable<FullGateTestEvent>,
): AsyncGenerator<string, void> {
  const telemetryPath = process.env[FULL_GATE_TELEMETRY_PATH_ENV];
  if (telemetryPath === undefined || telemetryPath.length === 0) {
    throw new Error(
      `${FULL_GATE_TELEMETRY_PATH_ENV} is required by the full-gate reporter.`,
    );
  }
  yield* reportWithFullGateTelemetry(source, {
    telemetryPath,
    repositoryRoot: process.env[FULL_GATE_REPOSITORY_ROOT_ENV] ?? process.cwd(),
  });
}

export function serializeFullGateTelemetryRecord(
  record: FullGateTelemetryRecord,
): string {
  if (record.kind === FULL_GATE_TELEMETRY_END_KIND) {
    const serialized = `${JSON.stringify({
      kind: FULL_GATE_TELEMETRY_END_KIND,
      recordCount: nonnegativeInteger(record.recordCount, 'recordCount'),
    } satisfies FullGateTelemetryEndRecord)}\n`;
    if (Buffer.byteLength(serialized) > MAX_JSONL_RECORD_BYTES) {
      throw new Error(
        'Full-gate telemetry JSONL record exceeds its byte bound.',
      );
    }
    return serialized;
  }
  const canonical = {
    kind: exactKind(record.kind),
    sequence: positiveInteger(record.sequence, 'sequence'),
    testNumber: nullableNonnegativeInteger(record.testNumber, 'testNumber'),
    file:
      record.file === null
        ? null
        : boundedSafeText(record.file, MAX_FILE_BYTES),
    line: nullableNonnegativeInteger(record.line, 'line'),
    name: boundedSafeText(record.name, MAX_NAME_BYTES),
    nesting: nonnegativeInteger(record.nesting, 'nesting'),
    outcome: exactOutcome(record.outcome),
    durationMs: boundedDuration(record.durationMs),
  } satisfies FullGateTestTelemetryRecord;
  const serialized = `${JSON.stringify(canonical)}\n`;
  if (Buffer.byteLength(serialized) > MAX_JSONL_RECORD_BYTES) {
    throw new Error('Full-gate telemetry JSONL record exceeds its byte bound.');
  }
  return serialized;
}

function terminalOutcome(
  event: Extract<FullGateTestEvent, { type: 'test:pass' | 'test:fail' }>,
): FullGateTestOutcome {
  if (event.data.skip !== undefined && event.data.skip !== false)
    return 'skipped';
  if (event.data.todo !== undefined && event.data.todo !== false) return 'todo';
  // Node reports failures, cancellations, aborts, and failed parent test nodes
  // through test:fail. Keep the observational category honest without relying
  // on runtime-internal failureType strings.
  return event.type === 'test:pass' ? 'passed' : 'not-passed';
}

function canonicalTestFile(
  file: string | undefined,
  repositoryRoot: string,
): string | null {
  if (file === undefined || file.length === 0) return null;
  let absolute: string;
  try {
    absolute = file.startsWith('file:')
      ? fileURLToPath(file)
      : path.resolve(repositoryRoot, file);
  } catch {
    return null;
  }
  const relative = path.relative(repositoryRoot, absolute);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return boundedSafeText(relative.split(path.sep).join('/'), MAX_FILE_BYTES);
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Full-gate telemetry durationMs must be nonnegative.');
  }
  return Math.round(value * 1_000) / 1_000;
}

function boundedSafeText(value: string, maximumBytes: number): string {
  if (typeof value !== 'string') {
    throw new Error('Full-gate telemetry text must be a string.');
  }
  const safe = value
    .normalize('NFC')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ');
  if (Buffer.byteLength(safe) <= maximumBytes) return safe;
  const suffix = '…';
  const limit = maximumBytes - Buffer.byteLength(suffix);
  let truncated = '';
  for (const character of safe) {
    if (Buffer.byteLength(truncated + character) > limit) break;
    truncated += character;
  }
  return truncated + suffix;
}

function canonicalExistingDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      'Full-gate telemetry directory must be an existing non-symlink directory.',
    );
  }
  const canonical = fs.realpathSync(absolute);
  return canonical;
}

function exactKind(value: string): typeof FULL_GATE_TELEMETRY_KIND {
  if (value !== FULL_GATE_TELEMETRY_KIND) {
    throw new Error('Full-gate telemetry kind is invalid.');
  }
  return value;
}

function exactOutcome(value: string): FullGateTestOutcome {
  if (!['passed', 'not-passed', 'skipped', 'todo'].includes(value)) {
    throw new Error('Full-gate telemetry outcome is invalid.');
  }
  return value as FullGateTestOutcome;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Full-gate telemetry ${label} must be a positive integer.`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Full-gate telemetry ${label} must be a nonnegative integer.`,
    );
  }
  return value;
}

function nullableNonnegativeInteger(
  value: number | null,
  label: string,
): number | null {
  return value === null ? null : nonnegativeInteger(value, label);
}

function safeIntegerOrNull(value: number | undefined): number | null {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? null
    : value;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
