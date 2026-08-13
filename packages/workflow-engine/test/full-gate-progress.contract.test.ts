import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  advanceFullGateProgress,
  canReuseFullGateReceipt,
  createFullGateIdentity,
  createFullGateProgress,
  createFullGateReceipt,
  FullGateTapCounter,
  fullGateCoverageMatchesProgress,
  progressOutputFor,
  renderFullGateProgress,
  validateFullGateCoverage,
} from '../../../scripts/full-gate-progress.ts';

const RUN_ID = 'run-20260812000000000-00000000-0000-4000-8000-000000000000';
const IDENTITY = createFullGateIdentity({
  projectedTreeOid: 'a'.repeat(40),
  generatedArtifactsDigest: `sha256:${'b'.repeat(64)}`,
  command: [
    process.execPath,
    '--experimental-strip-types',
    '--test',
    'packages/workflow-engine/test/contracts.test.ts',
    'packages/workflow-engine/test/session.integration.test.ts',
  ],
  workingDirectory: '.',
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
});

test('full-gate counter progress reports observed counts without a predictive bar', () => {
  const initial = createFullGateProgress({
    runId: RUN_ID,
    identityDigest: IDENTITY.digest,
    expectedTotal: 1_724,
    startedAtMs: 0,
  });
  const advanced = advanceFullGateProgress(initial, {
    nowMs: 14 * 60_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 41,
    logBytes: 8_192,
    completed: 1_034,
    pass: 1_034,
    fail: 0,
  });

  assert.equal(advanced.snapshot.state, 'running');
  assert.equal(advanced.transition, 'progress');
  assert.equal(
    renderFullGateProgress(advanced.snapshot),
    'FULL GATE 14m · observed 1034/1724 · fail 0 · process alive · CPU +41s',
  );
  assert.equal(
    progressOutputFor(advanced.snapshot, advanced.transition, true),
    '\r\u001b[2KFULL GATE 14m · observed 1034/1724 · fail 0 · process alive · CPU +41s',
  );
  assert.equal(
    progressOutputFor(advanced.snapshot, advanced.transition, false),
    null,
  );
});

test('full-gate observations never move completed or failure counts backwards', () => {
  const initial = createFullGateProgress({
    runId: RUN_ID,
    identityDigest: IDENTITY.digest,
    expectedTotal: 1_724,
    startedAtMs: 0,
  });
  const first = advanceFullGateProgress(initial, {
    nowMs: 1_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 10,
    logBytes: 1_000,
    completed: 827,
    pass: 823,
    fail: 4,
  });
  const stale = advanceFullGateProgress(first.progress, {
    nowMs: 2_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 11,
    logBytes: 900,
    completed: 822,
    pass: 819,
    fail: 3,
  });

  assert.equal(stale.snapshot.completed, 827);
  assert.equal(stale.snapshot.pass, 823);
  assert.equal(stale.snapshot.fail, 4);
  assert.equal(stale.snapshot.logBytes, 1_000);
  assert.match(renderFullGateProgress(stale.snapshot), /observed 827\/1724/);
  assert.doesNotMatch(renderFullGateProgress(stale.snapshot), /\[/);
});

test('full-gate progress reports buffered output without moving the last bar', () => {
  const initial = createFullGateProgress({
    runId: RUN_ID,
    identityDigest: IDENTITY.digest,
    expectedTotal: 1_724,
    startedAtMs: 0,
  });
  const first = advanceFullGateProgress(initial, {
    nowMs: 14 * 60_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 41,
    logBytes: 8_192,
    completed: 1_034,
    pass: 1_034,
    fail: 0,
  });
  const buffered = advanceFullGateProgress(first.progress, {
    nowMs: 15 * 60_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 80,
    logBytes: 8_192,
    completed: 1_034,
    pass: 1_034,
    fail: 0,
  });

  assert.equal(buffered.snapshot.state, 'buffered');
  assert.equal(buffered.transition, 'buffered');
  assert.equal(
    renderFullGateProgress(buffered.snapshot),
    'FULL GATE 15m · progress unavailable · output buffered · process alive · CPU +39s · last observed 1034/1724 · fail 0',
  );
  assert.equal(progressOutputFor(buffered.snapshot, 'buffered', false), null);
});

test('full-gate startup does not present buffered zero output as zero progress', () => {
  const initial = createFullGateProgress({
    runId: RUN_ID,
    identityDigest: IDENTITY.digest,
    expectedTotal: 1_724,
    startedAtMs: 0,
  });
  const started = advanceFullGateProgress(initial, {
    nowMs: 0,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 0,
    logBytes: 0,
    completed: 0,
    pass: 0,
    fail: 0,
  });

  assert.equal(
    renderFullGateProgress(started.snapshot),
    'FULL GATE 0m · progress unavailable · output buffered · process alive · CPU +0s · no completed results observed',
  );
  assert.equal(
    progressOutputFor(started.snapshot, 'started', true),
    '\r\u001b[2KFULL GATE 0m · progress unavailable · output buffered · process alive · CPU +0s · no completed results observed',
  );
});

test('full-gate inactivity requires three quiet minutes and process-tree inspection', () => {
  const initial = createFullGateProgress({
    runId: RUN_ID,
    identityDigest: IDENTITY.digest,
    expectedTotal: 1_724,
    startedAtMs: 0,
  });
  const active = advanceFullGateProgress(initial, {
    nowMs: 18 * 60_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 20,
    logBytes: 4_096,
    completed: 800,
    pass: 800,
    fail: 0,
  });
  const notYetInspected = advanceFullGateProgress(active.progress, {
    nowMs: 21 * 60_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 20,
    logBytes: 4_096,
    completed: 800,
    pass: 800,
    fail: 0,
  });
  assert.equal(notYetInspected.snapshot.state, 'buffered');
  assert.equal(notYetInspected.requiresProcessTreeInspection, true);

  const inspecting = advanceFullGateProgress(active.progress, {
    nowMs: 21 * 60_000,
    processAlive: true,
    processTreeInspected: true,
    cpuTotalSeconds: 20,
    logBytes: 4_096,
    completed: 800,
    pass: 800,
    fail: 0,
  });
  assert.equal(inspecting.snapshot.state, 'inspecting');
  assert.equal(inspecting.transition, 'inspection');
  assert.equal(
    renderFullGateProgress(inspecting.snapshot),
    'FULL GATE 21m · progress unavailable · alive, no CPU/log progress for 3m · inspecting · last observed 800/1724 · fail 0',
  );

  const recovered = advanceFullGateProgress(inspecting.progress, {
    nowMs: 22 * 60_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 26,
    logBytes: 4_200,
    completed: 801,
    pass: 801,
    fail: 0,
  });
  assert.equal(recovered.transition, 'recovery');
  assert.match(
    progressOutputFor(recovered.snapshot, recovered.transition, false) ?? '',
    /process alive/,
  );
});

test('TAP parsing reports first failure and exact completion without raw output transport', () => {
  const counter = new FullGateTapCounter();
  counter.push('TAP version 13\n    ok 1 - nested assertion\n');
  counter.push('ok 1 - first test\nnot ok 2 - second test\n');
  counter.push(
    '# tests 2\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1250.5\n',
  );

  assert.deepEqual(counter.progress(), {
    completed: 2,
    pass: 1,
    fail: 1,
    total: 2,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    durationMs: 1_250.5,
  });
  assert.equal(counter.takeFirstFailureTransition(), true);
  assert.equal(counter.takeFirstFailureTransition(), false);
});

test('the existing Node spec reporter advances the same counter without changing reporter flags', () => {
  const counter = new FullGateTapCounter();
  counter.push('✔ first test (1.2ms)\n✖ second test (2.4ms)\n');
  counter.push(
    'ℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 10.5\n',
  );

  assert.deepEqual(counter.progress(), {
    completed: 2,
    pass: 1,
    fail: 1,
    total: 2,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    durationMs: 10.5,
  });
});

test('Node terminal failure details preserve the first failure without double-counting its repeated marker', () => {
  const counter = new FullGateTapCounter();
  const firstFailureLine = '✖ second test (2.4ms)';
  const output = [
    '✔ first test (1.2ms)',
    firstFailureLine,
    'ℹ tests 2',
    'ℹ suites 0',
    'ℹ pass 1',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 10.5',
    '✖ failing tests:',
    'test at fixture.test.ts:2:1',
    firstFailureLine,
    '  AssertionError: expected one failure',
    '',
  ].join('\n');

  counter.push(output);

  assert.deepEqual(counter.progress(), {
    completed: 2,
    pass: 1,
    fail: 1,
    total: 2,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    durationMs: 10.5,
  });
  assert.deepEqual(counter.firstFailure(), {
    name: 'second test',
    byteOffset: Buffer.byteLength('✔ first test (1.2ms)\n'),
  });
});

test('successful receipt reuse binds exact tree, generated artifacts, runtime, command, and raw log', () => {
  const rawLog = Buffer.from(
    'TAP version 13\nok 1 - pass\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 10\n',
  );
  const expectation = coverageExpectation([
    'packages/workflow-engine/test/pass.test.ts',
  ]);
  const telemetry = coverageTelemetry([
    telemetryRecord(1, {
      file: 'packages/workflow-engine/test/pass.test.ts',
    }),
  ]);
  const coverage = validateFullGateCoverage(telemetry, expectation);
  const receipt = createFullGateReceipt({
    runId: RUN_ID,
    identity: IDENTITY,
    headCommit: 'c'.repeat(40),
    completedHeadCommit: 'c'.repeat(40),
    completedIdentityDigest: IDENTITY.digest,
    identityStable: true,
    reason: null,
    exitCode: 0,
    signal: null,
    rawLog,
    coverage,
    completedAt: '2026-08-12T00:00:00.000Z',
  });

  assert.deepEqual(receipt.coverage, coverage);
  assert.equal(
    canReuseFullGateReceipt(receipt, IDENTITY, {
      rawLog,
      telemetry,
      coverageExpectation: expectation,
    }),
    true,
  );
  assert.equal(
    canReuseFullGateReceipt(
      receipt,
      createFullGateIdentity({
        ...IDENTITY.bindings,
        projectedTreeOid: 'd'.repeat(40),
      }),
      { rawLog, telemetry, coverageExpectation: expectation },
    ),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(
      receipt,
      createFullGateIdentity({
        ...IDENTITY.bindings,
        generatedArtifactsDigest: `sha256:${'e'.repeat(64)}`,
      }),
      { rawLog, telemetry, coverageExpectation: expectation },
    ),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(
      receipt,
      createFullGateIdentity({
        ...IDENTITY.bindings,
        command: [...IDENTITY.bindings.command, '--test-only'],
      }),
      { rawLog, telemetry, coverageExpectation: expectation },
    ),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(
      receipt,
      createFullGateIdentity({
        ...IDENTITY.bindings,
        nodeVersion: 'v99.0.0',
      }),
      { rawLog, telemetry, coverageExpectation: expectation },
    ),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(receipt, IDENTITY, {
      rawLog: Buffer.from('tampered'),
      telemetry,
      coverageExpectation: expectation,
    }),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt({ ...receipt, outcome: 'failed' }, IDENTITY, {
      rawLog,
      telemetry,
      coverageExpectation: expectation,
    }),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(receipt, IDENTITY, {
      rawLog,
      telemetry: Buffer.from(telemetry.toString().replace('pass', 'changed')),
      coverageExpectation: expectation,
    }),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(receipt, IDENTITY, {
      rawLog,
      telemetry,
      coverageExpectation: {
        ...expectation,
        inventoryDigest: `sha256:${'9'.repeat(64)}`,
      },
    }),
    false,
  );
});

test('coverage validation binds exact inventory, physical file set, footer, telemetry, and outcomes', () => {
  const expectation = coverageExpectation([
    'packages/workflow-engine/test/a.test.ts',
    'packages/workflow-engine/test/b.test.ts',
  ]);
  const telemetry = coverageTelemetry([
    telemetryRecord(1, {
      file: 'packages/workflow-engine/test/b.test.ts',
      name: 'b root',
    }),
    telemetryRecord(2, {
      file: 'packages/workflow-engine/test/a.test.ts',
      name: 'a root',
      outcome: 'skipped',
    }),
    telemetryRecord(3, {
      file: 'packages/workflow-engine/test/b.test.ts',
      name: 'b nested',
      nesting: 1,
      outcome: 'todo',
    }),
  ]);
  const coverage = validateFullGateCoverage(telemetry, expectation);

  assert.equal(coverage.kind, 'full-gate-coverage-evidence.v1');
  assert.equal(coverage.inventoryDigest, expectation.inventoryDigest);
  assert.equal(
    coverage.expectedFileSetDigest,
    expectation.expectedFileSetDigest,
  );
  assert.equal(coverage.expectedFileCount, 2);
  assert.equal(
    coverage.observedFileSetDigest,
    expectation.expectedFileSetDigest,
  );
  assert.equal(coverage.observedFileCount, 2);
  assert.equal(coverage.fileSetMatches, true);
  assert.equal(coverage.footerComplete, true);
  assert.equal(coverage.telemetryBytes, telemetry.length);
  assert.equal(coverage.telemetryDigest, digest(telemetry));
  assert.deepEqual(coverage.outcomeCounts, {
    passed: 1,
    'not-passed': 0,
    skipped: 1,
    todo: 1,
  });
  assert.equal(coverage.testNodeCount, 3);
  assert.equal(coverage.unattributedTestNodeCount, 0);
  assert.equal(
    fullGateCoverageMatchesProgress(coverage, {
      completed: 3,
      pass: 1,
      fail: 0,
      total: 3,
      cancelled: 0,
      skipped: 1,
      todo: 1,
      durationMs: 1,
    }),
    true,
  );
});

test('a zero-exit passing TAP receipt fails closed without complete exact telemetry coverage', () => {
  const rawLog = Buffer.from(
    'TAP version 13\nok 1 - pass\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 10\n',
  );
  const passFile = 'packages/workflow-engine/test/pass.test.ts';
  const exactExpectation = coverageExpectation([passFile]);
  const exactRecord = telemetryRecord(1, { file: passFile });
  const invalidCoverage = [
    validateFullGateCoverage(Buffer.alloc(0), exactExpectation),
    validateFullGateCoverage(
      Buffer.from(`${JSON.stringify(exactRecord)}\n`),
      exactExpectation,
    ),
    validateFullGateCoverage(
      coverageTelemetry([exactRecord]),
      coverageExpectation([
        passFile,
        'packages/workflow-engine/test/missing.test.ts',
      ]),
    ),
    validateFullGateCoverage(
      coverageTelemetry([
        exactRecord,
        telemetryRecord(2, {
          file: 'packages/workflow-engine/test/extra.test.ts',
        }),
      ]),
      exactExpectation,
    ),
    validateFullGateCoverage(
      coverageTelemetry([telemetryRecord(1, { file: null })]),
      exactExpectation,
    ),
    validateFullGateCoverage(
      coverageTelemetry([
        telemetryRecord(1, { file: passFile, outcome: 'not-passed' }),
      ]),
      exactExpectation,
    ),
  ];

  for (const [index, coverage] of invalidCoverage.entries()) {
    const receipt = createFullGateReceipt({
      runId: RUN_ID,
      identity: IDENTITY,
      headCommit: 'c'.repeat(40),
      completedHeadCommit: 'c'.repeat(40),
      completedIdentityDigest: IDENTITY.digest,
      identityStable: true,
      reason: null,
      exitCode: 0,
      signal: null,
      rawLog,
      coverage,
      completedAt: '2026-08-12T00:00:00.000Z',
    });
    assert.equal(receipt.outcome, 'failed', `invalid coverage ${index}`);
  }

  assert.throws(
    () =>
      validateFullGateCoverage(coverageTelemetry([exactRecord]), {
        ...exactExpectation,
        expectedFiles: [passFile, passFile],
      }),
    /duplicate/i,
  );
});

test('coverage file-set digest ignores test-node arrival order while receipt reuse binds raw telemetry order', () => {
  const expectation = coverageExpectation([
    'packages/workflow-engine/test/a.test.ts',
    'packages/workflow-engine/test/z.test.ts',
  ]);
  const firstTelemetry = coverageTelemetry([
    telemetryRecord(1, {
      file: 'packages/workflow-engine/test/z.test.ts',
      name: 'z',
    }),
    telemetryRecord(2, {
      file: 'packages/workflow-engine/test/a.test.ts',
      name: 'a',
    }),
  ]);
  const reversedTelemetry = coverageTelemetry([
    telemetryRecord(1, {
      file: 'packages/workflow-engine/test/a.test.ts',
      name: 'a',
    }),
    telemetryRecord(2, {
      file: 'packages/workflow-engine/test/z.test.ts',
      name: 'z',
    }),
  ]);
  const firstCoverage = validateFullGateCoverage(firstTelemetry, expectation);
  const reversedCoverage = validateFullGateCoverage(
    reversedTelemetry,
    expectation,
  );

  assert.equal(
    reversedCoverage.observedFileSetDigest,
    firstCoverage.observedFileSetDigest,
  );
  assert.notEqual(
    reversedCoverage.telemetryDigest,
    firstCoverage.telemetryDigest,
  );
});

test('receipt reuse rejects legacy, malformed, and extension-bearing JSON without throwing', () => {
  const rawLog = Buffer.from(
    'TAP version 13\nok 1 - pass\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 10\n',
  );
  const expectedFile = 'packages/workflow-engine/test/pass.test.ts';
  const expectation = coverageExpectation([expectedFile]);
  const telemetry = coverageTelemetry([
    telemetryRecord(1, { file: expectedFile }),
  ]);
  const receipt = createFullGateReceipt({
    runId: RUN_ID,
    identity: IDENTITY,
    headCommit: 'c'.repeat(40),
    completedHeadCommit: 'c'.repeat(40),
    completedIdentityDigest: IDENTITY.digest,
    identityStable: true,
    reason: null,
    exitCode: 0,
    signal: null,
    rawLog,
    coverage: validateFullGateCoverage(telemetry, expectation),
    completedAt: '2026-08-12T00:00:00.000Z',
  });
  const evidence = { rawLog, telemetry, coverageExpectation: expectation };
  const malformed: unknown[] = [
    null,
    {},
    { ...receipt, kind: 'full-gate-run-receipt.v1' },
    { ...receipt, extension: true },
    { ...receipt, identity: null },
    { ...receipt, progress: { ...receipt.progress, pass: '1' } },
    { ...receipt, coverage: undefined },
    { ...receipt, coverage: { ...receipt.coverage, extension: true } },
    { ...receipt, coverage: { ...receipt.coverage, footerComplete: 1 } },
    {
      ...receipt,
      coverage: {
        ...receipt.coverage,
        outcomeCounts: { ...receipt.coverage.outcomeCounts, passed: '1' },
      },
    },
  ];

  for (const [index, candidate] of malformed.entries()) {
    assert.doesNotThrow(() =>
      canReuseFullGateReceipt(candidate as typeof receipt, IDENTITY, evidence),
    );
    assert.equal(
      canReuseFullGateReceipt(candidate as typeof receipt, IDENTITY, evidence),
      false,
      `malformed receipt ${index}`,
    );
  }
});

test('coverage reconciles the 1893-node passed, skipped, todo, and nested summary exactly', () => {
  const expectedFile = 'packages/workflow-engine/test/all.test.ts';
  const records = Array.from({ length: 1_893 }, (_, index) => {
    const sequence = index + 1;
    return telemetryRecord(sequence, {
      file: expectedFile,
      nesting: index % 3,
      outcome: index < 11 ? 'skipped' : index < 18 ? 'todo' : 'passed',
    });
  });
  const coverage = validateFullGateCoverage(
    coverageTelemetry(records),
    coverageExpectation([expectedFile]),
  );

  assert.deepEqual(coverage.outcomeCounts, {
    passed: 1_875,
    'not-passed': 0,
    skipped: 11,
    todo: 7,
  });
  assert.equal(coverage.testNodeCount, 1_893);
  assert.equal(coverage.observedFileCount, 1);
  assert.equal(
    fullGateCoverageMatchesProgress(coverage, {
      completed: 1_893,
      pass: 1_875,
      fail: 0,
      total: 1_893,
      cancelled: 0,
      skipped: 11,
      todo: 7,
      durationMs: 60_000,
    }),
    true,
  );
});

test('non-TTY progress emits only lifecycle transitions', () => {
  const initial = createFullGateProgress({
    runId: RUN_ID,
    identityDigest: IDENTITY.digest,
    expectedTotal: 2,
    startedAtMs: 0,
  });
  const started = advanceFullGateProgress(initial, {
    nowMs: 0,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 0,
    logBytes: 0,
    completed: 0,
    pass: 0,
    fail: 0,
  });
  const failed = advanceFullGateProgress(started.progress, {
    nowMs: 1_000,
    processAlive: true,
    processTreeInspected: false,
    cpuTotalSeconds: 1,
    logBytes: 100,
    completed: 1,
    pass: 0,
    fail: 1,
  });
  const complete = advanceFullGateProgress(failed.progress, {
    nowMs: 2_000,
    processAlive: false,
    processTreeInspected: false,
    cpuTotalSeconds: 2,
    logBytes: 200,
    completed: 2,
    pass: 1,
    fail: 1,
  });

  assert.match(
    progressOutputFor(started.snapshot, 'started', false) ?? '',
    /progress unavailable[\s\S]*no completed results observed/,
  );
  assert.match(
    progressOutputFor(failed.snapshot, 'failure', false) ?? '',
    /fail 1/,
  );
  assert.match(
    progressOutputFor(complete.snapshot, 'complete', false) ?? '',
    /fail 1/,
  );
  assert.equal(progressOutputFor(failed.snapshot, 'progress', false), null);
});

type CoverageTelemetryRecord = Readonly<{
  kind: 'workflow-full-gate-test-telemetry.v1';
  sequence: number;
  testNumber: number | null;
  file: string | null;
  line: number | null;
  name: string;
  nesting: number;
  outcome: 'passed' | 'not-passed' | 'skipped' | 'todo';
  durationMs: number;
}>;

function telemetryRecord(
  sequence: number,
  overrides: Partial<CoverageTelemetryRecord> = {},
): CoverageTelemetryRecord {
  return {
    kind: 'workflow-full-gate-test-telemetry.v1',
    sequence,
    testNumber: sequence,
    file: 'packages/workflow-engine/test/default.test.ts',
    line: sequence,
    name: `test ${sequence}`,
    nesting: 0,
    outcome: 'passed',
    durationMs: 1,
    ...overrides,
  };
}

function coverageTelemetry(
  records: readonly CoverageTelemetryRecord[],
): Buffer {
  return Buffer.from(
    `${[
      ...records,
      {
        kind: 'workflow-full-gate-test-telemetry-end.v1',
        recordCount: records.length,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  );
}

function coverageExpectation(expectedFiles: readonly string[]): {
  inventoryDigest: `sha256:${string}`;
  expectedFiles: string[];
  expectedFileSetDigest: `sha256:${string}`;
} {
  const files = [...expectedFiles];
  return {
    inventoryDigest: `sha256:${'8'.repeat(64)}`,
    expectedFiles: files,
    expectedFileSetDigest: digest(JSON.stringify([...files].sort(compareText))),
  };
}

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
