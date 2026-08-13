import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFullGateTelemetryProjector,
  openFullGateTelemetrySink,
  serializeFullGateTelemetryRecord,
  type FullGateTestEvent,
} from '../../../scripts/full-gate-reporter.ts';

test('full-gate telemetry projects deterministic bounded test-node records without diagnostic payloads', () => {
  const repository = privateDirectory('full-gate-reporter-repository-');
  const file = path.join(repository, 'test', 'slow.test.ts');
  const projector = createFullGateTelemetryProjector({
    repositoryRoot: repository,
  });
  const location = {
    file,
    line: 42,
    name: '\u001b[31mdoes work\u001b[0m\nwithout controls',
    nesting: 2,
  };

  assert.equal(
    projector.observe({
      type: 'test:stdout',
      data: { file, message: 'SECRET stdout must never enter telemetry' },
    } as FullGateTestEvent),
    null,
  );
  assert.equal(
    projector.observe({
      type: 'test:enqueue',
      data: { ...location, type: 'test' },
    } as FullGateTestEvent),
    null,
  );
  projector.observe({
    type: 'test:dequeue',
    data: { ...location, type: 'test' },
  } as FullGateTestEvent);
  projector.observe({
    type: 'test:start',
    data: location,
  } as FullGateTestEvent);
  const record = projector.observe({
    type: 'test:pass',
    data: {
      ...location,
      testNumber: 17,
      details: { duration_ms: 54.67891, type: 'test' },
    },
  } as FullGateTestEvent);

  assert.deepEqual(record, {
    kind: 'workflow-full-gate-test-telemetry.v1',
    sequence: 1,
    testNumber: 17,
    file: 'test/slow.test.ts',
    line: 42,
    name: 'does work without controls',
    nesting: 2,
    outcome: 'passed',
    durationMs: 54.679,
  });
  const serialized = serializeFullGateTelemetryRecord(record!);
  assert.equal(serialized, `${JSON.stringify(record)}\n`);
  assert.doesNotMatch(serialized, /SECRET|error|stack/i);
  assert.equal(serialized.includes('\u001b'), false);
  assert.equal(projector.recordCount, 1);
});

test('full-gate telemetry ignores suites and records explicit skip, todo, and failure outcomes once', () => {
  const projector = createFullGateTelemetryProjector({
    repositoryRoot: process.cwd(),
  });
  const suite = {
    file: path.join(process.cwd(), 'test', 'aggregate.test.ts'),
    line: 1,
    name: 'aggregate',
    nesting: 0,
  };
  projector.observe({
    type: 'test:enqueue',
    data: { ...suite, type: 'suite' },
  } as FullGateTestEvent);
  assert.equal(
    projector.observe({
      type: 'test:pass',
      data: {
        ...suite,
        testNumber: 1,
        details: { duration_ms: 1, type: 'suite' },
      },
    } as FullGateTestEvent),
    null,
  );

  const terminal = (
    name: string,
    testNumber: number,
    event: 'test:pass' | 'test:fail',
    disposition: { skip?: boolean; todo?: boolean },
  ) =>
    projector.observe({
      type: event,
      data: {
        ...suite,
        name,
        testNumber,
        ...disposition,
        details: {
          duration_ms: testNumber,
          type: 'test',
          ...(event === 'test:fail'
            ? { error: new Error('SECRET assertion details') }
            : {}),
        },
      },
    } as FullGateTestEvent)!;

  assert.equal(
    terminal('skip', 2, 'test:pass', { skip: true }).outcome,
    'skipped',
  );
  assert.equal(
    terminal('todo', 3, 'test:pass', { todo: true }).outcome,
    'todo',
  );
  const failure = terminal('failure', 4, 'test:fail', {});
  assert.equal(failure.outcome, 'not-passed');
  assert.doesNotMatch(JSON.stringify(failure), /SECRET|assertion|stack/i);
  assert.deepEqual(
    projector.records.map((record) => record.sequence),
    [1, 2, 3],
  );
});

test('full-gate telemetry enforces its record and JSONL text bounds', () => {
  const projector = createFullGateTelemetryProjector({
    repositoryRoot: process.cwd(),
    maxRecords: 1,
  });
  const complete = (testNumber: number) =>
    projector.observe({
      type: 'test:pass',
      data: {
        file: path.join(process.cwd(), 'bounded.test.ts'),
        line: testNumber,
        name: `bounded-${testNumber}-` + '四'.repeat(4_000),
        nesting: 0,
        testNumber,
        details: { duration_ms: 0, type: 'test' },
      },
    } as FullGateTestEvent);

  const first = complete(1)!;
  assert.ok(Buffer.byteLength(first.name) <= 2_048);
  assert.match(first.name, /…$/u);
  assert.ok(
    Buffer.byteLength(serializeFullGateTelemetryRecord(first)) <= 16_384,
  );
  assert.throws(() => complete(2), /exceeds its 1 record bound/i);
});

test('telemetry sink is private, create-only, canonical JSONL and rejects aliases', () => {
  const root = privateDirectory('full-gate-telemetry-root-');
  const output = path.join(root, 'test-telemetry.jsonl');
  const record = createFullGateTelemetryProjector({
    repositoryRoot: process.cwd(),
  }).observe({
    type: 'test:pass',
    data: {
      file: path.join(process.cwd(), 'one.test.ts'),
      line: 1,
      name: 'one',
      nesting: 0,
      testNumber: 1,
      details: { duration_ms: 1, type: 'test' },
    },
  } as FullGateTestEvent)!;
  const sink = openFullGateTelemetrySink(output);
  sink.write(record);
  sink.close();

  assert.equal(fs.lstatSync(output).isFile(), true);
  assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(output).nlink, 1);
  assert.equal(fs.lstatSync(output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(output, 'utf8'), JSON.stringify(record) + '\n');
  assert.throws(() => openFullGateTelemetrySink(output), /already exists/i);

  const guardedOutput = path.join(root, 'guarded.jsonl');
  const guardedSink = openFullGateTelemetrySink(guardedOutput);
  const injectedHardLink = path.join(root, 'injected-hard-link.jsonl');
  fs.linkSync(guardedOutput, injectedHardLink);
  assert.throws(() => guardedSink.write(record), /linked/i);
  fs.unlinkSync(injectedHardLink);
  guardedSink.write(record);
  guardedSink.close();

  const aliasContainer = privateDirectory('full-gate-telemetry-alias-');
  const alias = path.join(aliasContainer, 'run');
  fs.symlinkSync(root, alias);
  assert.throws(
    () => openFullGateTelemetrySink(path.join(alias, 'through-link.jsonl')),
    /symlink|canonical/i,
  );

  const linkedTarget = path.join(root, 'linked-target.jsonl');
  fs.writeFileSync(linkedTarget, 'do not overwrite\n', { mode: 0o600 });
  const hardLink = path.join(root, 'linked-output.jsonl');
  fs.linkSync(linkedTarget, hardLink);
  assert.throws(() => openFullGateTelemetrySink(hardLink), /already exists/i);
  assert.equal(fs.readFileSync(linkedTarget, 'utf8'), 'do not overwrite\n');
});

test('custom reporter preserves spec output while writing only test-node JSONL telemetry', () => {
  const repository = path.resolve(import.meta.dirname, '../../..');
  const fixture = privateDirectory('full-gate-reporter-fixture-');
  const telemetryRoot = privateDirectory('full-gate-reporter-output-');
  const testFile = path.join(fixture, 'sample.test.mjs');
  const telemetryPath = path.join(telemetryRoot, 'tests.jsonl');
  fs.writeFileSync(
    testFile,
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('visible leaf', () => assert.equal(1, 1));\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      `--test-reporter=${path.join(repository, 'scripts/full-gate-reporter.ts')}`,
      testFile,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => name !== 'NODE_TEST_CONTEXT',
          ),
        ),
        WORKFLOW_FULL_GATE_TELEMETRY_PATH: telemetryPath,
        WORKFLOW_FULL_GATE_REPOSITORY_ROOT: fixture,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /visible leaf/);
  assert.match(result.stdout, /tests 1/);
  const records = fs
    .readFileSync(telemetryPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.name, 'visible leaf');
  assert.equal(records[0]?.file, 'sample.test.mjs');
  assert.equal(records[0]?.outcome, 'passed');
  assert.equal('error' in records[0]!, false);
  assert.deepEqual(records[1], {
    kind: 'workflow-full-gate-test-telemetry-end.v1',
    recordCount: 1,
  });
  for (const misleading of [
    'enqueuedAtMs',
    'dequeuedAtMs',
    'startedAtMs',
    'completedAtMs',
    'queueMs',
    'dispatchMs',
  ]) {
    assert.equal(misleading in records[0]!, false);
  }
});

function privateDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}
