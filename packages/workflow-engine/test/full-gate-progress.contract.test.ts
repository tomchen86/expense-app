import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceFullGateProgress,
  canReuseFullGateReceipt,
  createFullGateIdentity,
  createFullGateProgress,
  createFullGateReceipt,
  FullGateTapCounter,
  progressOutputFor,
  renderFullGateProgress,
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

test('full-gate counter progress renders one latest-only terminal snapshot', () => {
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
    'FULL GATE [██████░░░░] 14m · process alive · CPU +41s · 1034/1724 · fail 0',
  );
  assert.equal(
    progressOutputFor(advanced.snapshot, advanced.transition, true),
    '\r\u001b[2KFULL GATE [██████░░░░] 14m · process alive · CPU +41s · 1034/1724 · fail 0',
  );
  assert.equal(
    progressOutputFor(advanced.snapshot, advanced.transition, false),
    null,
  );
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
    'FULL GATE [██████░░░░] 15m · process alive · CPU +39s · output buffered',
  );
  assert.equal(progressOutputFor(buffered.snapshot, 'buffered', false), null);
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
    'FULL GATE [█████░░░░░] 21m · alive, no CPU/log progress for 3m · inspecting',
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

test('successful receipt reuse binds exact tree, generated artifacts, runtime, command, and raw log', () => {
  const rawLog = Buffer.from(
    'TAP version 13\nok 1 - pass\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 10\n',
  );
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
    completedAt: '2026-08-12T00:00:00.000Z',
  });

  assert.equal(canReuseFullGateReceipt(receipt, IDENTITY, rawLog), true);
  assert.equal(
    canReuseFullGateReceipt(
      receipt,
      createFullGateIdentity({
        ...IDENTITY.bindings,
        projectedTreeOid: 'd'.repeat(40),
      }),
      rawLog,
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
      rawLog,
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
      rawLog,
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
      rawLog,
    ),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(receipt, IDENTITY, Buffer.from('tampered')),
    false,
  );
  assert.equal(
    canReuseFullGateReceipt(
      { ...receipt, outcome: 'failed' },
      IDENTITY,
      rawLog,
    ),
    false,
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
    /0\/2/,
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
