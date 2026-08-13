import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  FULL_GATE_TELEMETRY_END_KIND,
  FULL_GATE_TELEMETRY_KIND,
  type FullGateTestOutcome,
  type FullGateTestTelemetryRecord,
} from './full-gate-reporter.ts';

export const FULL_GATE_TELEMETRY_SUMMARY_KIND =
  'workflow-full-gate-telemetry-summary.v1' as const;
export const FULL_GATE_TELEMETRY_TOP_SLOW_LIMIT = 20;

const DEFAULT_MAX_BYTES = 64 * 1_024 * 1_024;
const DEFAULT_MAX_RECORDS = 100_000;
const MAX_RECORD_BYTES = 16_384;
const RECORD_KEYS = Object.freeze([
  'durationMs',
  'file',
  'kind',
  'line',
  'name',
  'nesting',
  'outcome',
  'sequence',
  'testNumber',
]);

export type FullGateTelemetryOutcomeCounts = Readonly<
  Record<FullGateTestOutcome, number>
>;

export type FullGateTelemetryFileTiming = Readonly<{
  file: string | null;
  testNodeCount: number;
  outcomeCounts: FullGateTelemetryOutcomeCounts;
  totalNodeDurationMs: number;
}>;

export type FullGateTelemetrySlowTestNode = Readonly<{
  sequence: number;
  testNumber: number | null;
  file: string | null;
  line: number | null;
  name: string;
  outcome: FullGateTestOutcome;
  durationMs: number;
}>;

export type FullGateTelemetrySummary = Readonly<{
  kind: typeof FULL_GATE_TELEMETRY_SUMMARY_KIND;
  partial: boolean;
  testNodeCount: number;
  fileCount: number;
  files: readonly FullGateTelemetryFileTiming[];
  topSlowTestNodeLimit: typeof FULL_GATE_TELEMETRY_TOP_SLOW_LIMIT;
  topSlowTestNodes: readonly FullGateTelemetrySlowTestNode[];
}>;

export type FullGateTelemetrySummaryOptions = Readonly<{
  maxBytes?: number;
  maxRecords?: number;
}>;

type MutableFileTiming = {
  file: string | null;
  testNodeCount: number;
  outcomeCounts: Record<FullGateTestOutcome, number>;
  totalNodeDurationMs: number;
};

/** Reads one bounded, no-follow snapshot of a private telemetry sidecar. */
export function readFullGateTelemetrySummary(
  telemetryPath: string,
  options: FullGateTelemetrySummaryOptions = {},
): FullGateTelemetrySummary {
  if (!path.isAbsolute(telemetryPath)) {
    throw new Error('Full-gate telemetry summary path must be absolute.');
  }
  const maximumBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    'maxBytes',
  );
  const target = path.resolve(telemetryPath);
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        'Full-gate telemetry summary input must be one private regular file.',
      );
    }
    if (stats.size > maximumBytes) {
      throw new Error(
        `Full-gate telemetry summary input exceeds its ${maximumBytes}-byte bound.`,
      );
    }
    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const observed = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (observed === 0) break;
      offset += observed;
    }
    const text = decodeUtf8(bytes.subarray(0, offset));
    return summarizeFullGateTelemetryJsonl(text, options);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Parses only newline-complete records; an unterminated final fragment is ignored. */
export function summarizeFullGateTelemetryJsonl(
  jsonl: string,
  options: FullGateTelemetrySummaryOptions = {},
): FullGateTelemetrySummary {
  const maximumBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    'maxBytes',
  );
  const maximumRecords = positiveInteger(
    options.maxRecords ?? DEFAULT_MAX_RECORDS,
    'maxRecords',
  );
  if (Buffer.byteLength(jsonl) > maximumBytes) {
    throw new Error(
      `Full-gate telemetry summary input exceeds its ${maximumBytes}-byte bound.`,
    );
  }

  const unterminated = jsonl.length > 0 && !jsonl.endsWith('\n');
  const completeText = unterminated
    ? jsonl.slice(0, jsonl.lastIndexOf('\n') + 1)
    : jsonl;
  const lines =
    completeText.length === 0 ? [] : completeText.slice(0, -1).split('\n');
  if (lines.length > maximumRecords + 1) {
    throw new Error(
      `Full-gate telemetry summary exceeds its ${maximumRecords}-record bound.`,
    );
  }

  const records: FullGateTestTelemetryRecord[] = [];
  let footerSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    if (Buffer.byteLength(`${line}\n`) > MAX_RECORD_BYTES) {
      throw new Error(
        `Full-gate telemetry record at line ${lineNumber} exceeds its byte bound.`,
      );
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `Full-gate telemetry record at line ${lineNumber} is malformed JSON.`,
      );
    }
    if (
      isObject(candidate) &&
      candidate.kind === FULL_GATE_TELEMETRY_END_KIND
    ) {
      if (
        index !== lines.length - 1 ||
        Object.keys(candidate).sort(compareText).join(',') !==
          'kind,recordCount' ||
        candidate.recordCount !== records.length
      ) {
        throw new Error(
          `Full-gate telemetry footer is invalid at line ${lineNumber}.`,
        );
      }
      footerSeen = true;
      continue;
    }
    const record = parseRecord(candidate, lineNumber);
    if (record.sequence !== records.length + 1) {
      throw new Error(
        `Full-gate telemetry sequence is noncontiguous at line ${lineNumber}.`,
      );
    }
    records.push(record);
  }

  if (footerSeen && unterminated) {
    throw new Error('Full-gate telemetry contains bytes after its footer.');
  }

  return summarizeRecords(records, unterminated || !footerSeen);
}

export function projectFullGateTelemetrySummaryJson(
  summary: FullGateTelemetrySummary,
): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export function projectFullGateTelemetrySummaryHuman(
  summary: FullGateTelemetrySummary,
): string {
  const completeness = summary.partial
    ? ' (incomplete; completion footer not observed or trailing record ignored)'
    : '';
  const lines = [
    `Full-gate telemetry: ${summary.testNodeCount} test nodes across ${summary.fileCount} files${completeness}`,
    'Durations are Node test-node durations. Parent and nested subtests can overlap, so sums are not workload or wall time; file wall time and runner queue time are not observed.',
    'Per-file test-node duration sums:',
  ];
  if (summary.files.length === 0)
    lines.push('  No completed test nodes observed.');
  for (const timing of summary.files) {
    lines.push(
      `  ${displayFile(timing.file)} — ${timing.testNodeCount} test nodes, duration sum ${displayMilliseconds(timing.totalNodeDurationMs)}; passed ${timing.outcomeCounts.passed}, not-passed ${timing.outcomeCounts['not-passed']}, skipped ${timing.outcomeCounts.skipped}, todo ${timing.outcomeCounts.todo}`,
    );
  }
  lines.push(`Top ${FULL_GATE_TELEMETRY_TOP_SLOW_LIMIT} slow test nodes:`);
  if (summary.topSlowTestNodes.length === 0)
    lines.push('  No completed test nodes observed.');
  for (const slow of summary.topSlowTestNodes) {
    const location = `${displayFile(slow.file)}${slow.line === null ? '' : `:${slow.line}`}`;
    lines.push(
      `  ${displayMilliseconds(slow.durationMs)} — ${location} — ${safeText(slow.name)} [${slow.outcome}]`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function summarizeRecords(
  records: readonly FullGateTestTelemetryRecord[],
  partial: boolean,
): FullGateTelemetrySummary {
  const byFile = new Map<string | null, MutableFileTiming>();
  for (const record of records) {
    const current = byFile.get(record.file) ?? {
      file: record.file,
      testNodeCount: 0,
      outcomeCounts: {
        passed: 0,
        'not-passed': 0,
        skipped: 0,
        todo: 0,
      },
      totalNodeDurationMs: 0,
    };
    current.testNodeCount += 1;
    current.totalNodeDurationMs = addMilliseconds(
      current.totalNodeDurationMs,
      record.durationMs,
    );
    current.outcomeCounts[record.outcome] += 1;
    byFile.set(record.file, current);
  }

  const files: FullGateTelemetryFileTiming[] = [...byFile.values()]
    .map((timing) => ({
      file: timing.file,
      testNodeCount: timing.testNodeCount,
      outcomeCounts: Object.freeze({ ...timing.outcomeCounts }),
      totalNodeDurationMs: timing.totalNodeDurationMs,
    }))
    .sort(
      (left, right) =>
        right.totalNodeDurationMs - left.totalNodeDurationMs ||
        compareNullableText(left.file, right.file),
    );
  const topSlowTestNodes: FullGateTelemetrySlowTestNode[] = records
    .map((record) => ({
      sequence: record.sequence,
      testNumber: record.testNumber,
      file: record.file,
      line: record.line,
      name: record.name,
      outcome: record.outcome,
      durationMs: record.durationMs,
    }))
    .sort(
      (left, right) =>
        right.durationMs - left.durationMs || left.sequence - right.sequence,
    )
    .slice(0, FULL_GATE_TELEMETRY_TOP_SLOW_LIMIT);

  return Object.freeze({
    kind: FULL_GATE_TELEMETRY_SUMMARY_KIND,
    partial,
    testNodeCount: records.length,
    fileCount: files.length,
    files: Object.freeze(files.map((timing) => Object.freeze(timing))),
    topSlowTestNodeLimit: FULL_GATE_TELEMETRY_TOP_SLOW_LIMIT,
    topSlowTestNodes: Object.freeze(
      topSlowTestNodes.map((timing) => Object.freeze(timing)),
    ),
  });
}

function parseRecord(
  candidate: unknown,
  lineNumber: number,
): FullGateTestTelemetryRecord {
  if (!isObject(candidate)) {
    throw new Error(
      `Full-gate telemetry record at line ${lineNumber} must be an object.`,
    );
  }
  const keys = Object.keys(candidate).sort(compareText);
  if (
    keys.length !== RECORD_KEYS.length ||
    keys.some((key, index) => key !== RECORD_KEYS[index])
  ) {
    throw new Error(
      `Full-gate telemetry record keys are invalid at line ${lineNumber}.`,
    );
  }
  if (candidate.kind !== FULL_GATE_TELEMETRY_KIND) {
    throw new Error(
      `Full-gate telemetry kind is invalid at line ${lineNumber}.`,
    );
  }
  const outcome = exactOutcome(candidate.outcome, lineNumber);
  const record: FullGateTestTelemetryRecord = {
    kind: FULL_GATE_TELEMETRY_KIND,
    sequence: positiveRecordInteger(candidate.sequence, 'sequence', lineNumber),
    testNumber: nullableNonnegativeInteger(
      candidate.testNumber,
      'testNumber',
      lineNumber,
    ),
    file: nullableSafeText(candidate.file, 'file', lineNumber),
    line: nullableNonnegativeInteger(candidate.line, 'line', lineNumber),
    name: safeTextField(candidate.name, 'name', lineNumber),
    nesting: nonnegativeInteger(candidate.nesting, 'nesting', lineNumber),
    outcome,
    durationMs: duration(candidate.durationMs, lineNumber),
  };
  return Object.freeze(record);
}

function duration(value: unknown, lineNumber: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Full-gate telemetry durationMs is invalid at line ${lineNumber}.`,
    );
  }
  return Math.round(value * 1_000) / 1_000;
}

function exactOutcome(value: unknown, lineNumber: number): FullGateTestOutcome {
  if (
    typeof value !== 'string' ||
    !['passed', 'not-passed', 'skipped', 'todo'].includes(value)
  ) {
    throw new Error(
      `Full-gate telemetry outcome is invalid at line ${lineNumber}.`,
    );
  }
  return value as FullGateTestOutcome;
}

function nullableSafeText(
  value: unknown,
  label: string,
  lineNumber: number,
): string | null {
  return value === null ? null : safeTextField(value, label, lineNumber);
}

function safeTextField(
  value: unknown,
  label: string,
  lineNumber: number,
): string {
  if (typeof value !== 'string') {
    throw new Error(
      `Full-gate telemetry ${label} is invalid at line ${lineNumber}.`,
    );
  }
  return safeText(value.normalize('NFC'));
}

function safeText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : `\\u{${codePoint.toString(16)}}`;
  });
}

function nullableNonnegativeInteger(
  value: unknown,
  label: string,
  lineNumber: number,
): number | null {
  return value === null ? null : nonnegativeInteger(value, label, lineNumber);
}

function positiveRecordInteger(
  value: unknown,
  label: string,
  lineNumber: number,
): number {
  const result = nonnegativeInteger(value, label, lineNumber);
  if (result === 0) {
    throw new Error(
      `Full-gate telemetry ${label} is invalid at line ${lineNumber}.`,
    );
  }
  return result;
}

function nonnegativeInteger(
  value: unknown,
  label: string,
  lineNumber: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Full-gate telemetry ${label} is invalid at line ${lineNumber}.`,
    );
  }
  return value as number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Full-gate telemetry summary ${label} must be a positive integer.`,
    );
  }
  return value;
}

function addMilliseconds(left: number, right: number): number {
  return Math.round((left + right) * 1_000) / 1_000;
}

function compareNullableText(
  left: string | null,
  right: string | null,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function displayFile(file: string | null): string {
  return file === null ? '<unknown>' : safeText(file);
}

function displayMilliseconds(value: number | null): string {
  return value === null ? 'unknown' : `${value.toFixed(3)} ms`;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Full-gate telemetry summary input is not valid UTF-8.');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
