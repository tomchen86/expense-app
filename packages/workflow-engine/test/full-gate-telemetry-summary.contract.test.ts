import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { FullGateTestTelemetryRecord } from '../../../scripts/full-gate-reporter.ts';
import {
  projectFullGateTelemetrySummaryHuman,
  projectFullGateTelemetrySummaryJson,
  readFullGateTelemetrySummary,
  summarizeFullGateTelemetryJsonl,
} from '../../../scripts/full-gate-telemetry-summary.ts';

test('telemetry summary deterministically aggregates files and bounds the slowest test nodes at twenty', () => {
  const records = Array.from({ length: 23 }, (_, index) =>
    telemetryRecord(index + 1, {
      file:
        index === 0
          ? 'test/z\u202e.test.ts'
          : index % 2 === 0
            ? 'test/a.test.ts'
            : 'test/b.test.ts',
      name:
        index === 0
          ? 'slow\u001b[31m\u202etest'
          : `test ${String(index + 1).padStart(2, '0')}`,
      durationMs: index + 0.125,
      outcome: index === 2 ? 'not-passed' : index === 4 ? 'skipped' : 'passed',
    }),
  );

  const summary = summarizeFullGateTelemetryJsonl(jsonl(records));

  assert.equal(summary.kind, 'workflow-full-gate-telemetry-summary.v1');
  assert.equal(summary.partial, false);
  assert.equal(summary.testNodeCount, 23);
  assert.equal(summary.fileCount, 3);
  assert.deepEqual(summary.files, [
    {
      file: 'test/a.test.ts',
      testNodeCount: 11,
      outcomeCounts: {
        passed: 9,
        'not-passed': 1,
        skipped: 1,
        todo: 0,
      },
      totalNodeDurationMs: 133.375,
    },
    {
      file: 'test/b.test.ts',
      testNodeCount: 11,
      outcomeCounts: {
        passed: 11,
        'not-passed': 0,
        skipped: 0,
        todo: 0,
      },
      totalNodeDurationMs: 122.375,
    },
    {
      file: 'test/z\\u202e.test.ts',
      testNodeCount: 1,
      outcomeCounts: {
        passed: 1,
        'not-passed': 0,
        skipped: 0,
        todo: 0,
      },
      totalNodeDurationMs: 0.125,
    },
  ]);
  assert.equal(summary.topSlowTestNodes.length, 20);
  assert.equal(summary.topSlowTestNodes[0]?.sequence, 23);
  assert.equal(summary.topSlowTestNodes[19]?.sequence, 4);
  assert.equal(
    summary.topSlowTestNodes.some((entry) => entry.sequence === 1),
    false,
  );
  assert.equal(summary.topSlowTestNodeLimit, 20);

  const human = projectFullGateTelemetrySummaryHuman(summary);
  const machine = projectFullGateTelemetrySummaryJson(summary);
  assert.equal(projectFullGateTelemetrySummaryHuman(summary), human);
  assert.equal(projectFullGateTelemetrySummaryJson(summary), machine);
  assert.match(human, /23 test nodes across 3 files/);
  assert.match(human, /Top 20 slow test nodes/);
  assert.match(human, /file wall time and runner queue time are not observed/i);
  assert.doesNotMatch(human, /\u001b|\u202e/iu);
  assert.doesNotMatch(machine, /\u001b|\u202e/iu);
  assert.match(machine, /slow\\\\u001b\[31mslow|z\\\\u202e/u);
  assert.deepEqual(JSON.parse(machine), summary);
});

test('telemetry summary reports an unterminated tail as partial and ignores it', () => {
  const first = telemetryRecord(1, { durationMs: 5 });
  const second = telemetryRecord(2, {
    name: 'unterminated but syntactically valid',
    durationMs: 99,
  });
  const summary = summarizeFullGateTelemetryJsonl(
    `${JSON.stringify(first)}\n${JSON.stringify(second)}`,
  );

  assert.equal(summary.partial, true);
  assert.equal(summary.testNodeCount, 1);
  assert.equal(summary.topSlowTestNodes[0]?.durationMs, 5);
  assert.match(projectFullGateTelemetrySummaryHuman(summary), /incomplete/i);

  const fragment = summarizeFullGateTelemetryJsonl(
    `${JSON.stringify(first)}\n{"kind":`,
  );
  assert.equal(fragment.partial, true);
  assert.equal(fragment.testNodeCount, 1);

  const cleanRecordWithoutFooter = summarizeFullGateTelemetryJsonl(
    `${JSON.stringify(first)}\n`,
  );
  assert.equal(cleanRecordWithoutFooter.partial, true);
  assert.equal(cleanRecordWithoutFooter.testNodeCount, 1);
});

test('telemetry summary fails closed on malformed or noncontiguous completed records', () => {
  const first = telemetryRecord(1);
  const third = telemetryRecord(3);

  assert.throws(
    () =>
      summarizeFullGateTelemetryJsonl(
        `${JSON.stringify(first)}\nnot-json\n{"partial":`,
      ),
    /line 2/i,
  );
  assert.throws(
    () => summarizeFullGateTelemetryJsonl(jsonl([first, third])),
    /sequence.*line 2/i,
  );
  assert.throws(
    () =>
      summarizeFullGateTelemetryJsonl(
        `${JSON.stringify({ ...first, unexpected: 'diagnostic' })}\n`,
      ),
    /keys.*line 1/i,
  );
  assert.throws(
    () =>
      summarizeFullGateTelemetryJsonl(
        `${JSON.stringify(first)}\n${JSON.stringify({ kind: 'workflow-full-gate-test-telemetry-end.v1', recordCount: 2 })}\n`,
      ),
    /footer.*line 2/i,
  );
  assert.throws(
    () =>
      summarizeFullGateTelemetryJsonl(
        `${JSON.stringify({ ...first, outcome: ['passed'] })}\n`,
      ),
    /outcome.*line 1/i,
  );
  assert.throws(
    () =>
      summarizeFullGateTelemetryJsonl(
        `${JSON.stringify({ ...first, queueMs: 999 })}\n`,
      ),
    /keys.*line 1/i,
  );
});

test('telemetry summary reads one bounded private JSONL snapshot without writing it', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'full-gate-telemetry-summary-'),
  );
  fs.chmodSync(directory, 0o700);
  const telemetryPath = path.join(directory, 'test-telemetry.jsonl');
  const content = jsonl([telemetryRecord(1, { durationMs: 12.345 })]);
  fs.writeFileSync(telemetryPath, content, { mode: 0o600 });

  const before = fs.statSync(telemetryPath);
  const summary = readFullGateTelemetrySummary(telemetryPath);
  const after = fs.statSync(telemetryPath);

  assert.equal(summary.topSlowTestNodes[0]?.durationMs, 12.345);
  assert.equal(fs.readFileSync(telemetryPath, 'utf8'), content);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  fs.chmodSync(telemetryPath, 0o644);
  assert.throws(() => readFullGateTelemetrySummary(telemetryPath), /private/i);
});

function jsonl(records: readonly FullGateTestTelemetryRecord[]): string {
  return (
    [
      ...records,
      {
        kind: 'workflow-full-gate-test-telemetry-end.v1',
        recordCount: records.length,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n'
  );
}

function telemetryRecord(
  sequence: number,
  overrides: Partial<FullGateTestTelemetryRecord> = {},
): FullGateTestTelemetryRecord {
  return {
    kind: 'workflow-full-gate-test-telemetry.v1',
    sequence,
    testNumber: sequence,
    file: 'test/default.test.ts',
    line: sequence,
    name: `test ${sequence}`,
    nesting: 0,
    outcome: 'passed',
    durationMs: 1,
    ...overrides,
  };
}
