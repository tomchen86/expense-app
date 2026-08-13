import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireFullGateLock,
  buildFullGateCommand,
  parseFullGateCli,
  projectWorkingTreeOid,
  releaseFullGateLock,
  runFullGate,
  runFullGateForTesting,
} from '../../../scripts/workflow-full-gate.ts';
import { createFullGateIdentity } from '../../../scripts/full-gate-progress.ts';
import {
  digestWorkflowTestFileSet,
  loadWorkflowTestShardManifest,
  workflowTestShardWrapperPaths,
  type FullGateCoverageExpectation,
} from '../../../scripts/workflow-test-inventory.ts';

test('full-gate wrapper runs the exact eight shard wrappers with bounded concurrency', () => {
  const repository = path.resolve(import.meta.dirname, '../../..');
  const packageRoot = path.join(repository, 'packages/workflow-engine');
  const shardWrappers = workflowTestShardWrapperPaths(
    loadWorkflowTestShardManifest(repository),
  );
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(repository, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const checkRegistry = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/checks.json'), 'utf8'),
  ) as { checks: Record<string, { command: string[] }> };
  const fromRepository = buildFullGateCommand(repository);
  const fromPackage = buildFullGateCommand(packageRoot);

  assert.equal(fromRepository.executable, process.execPath);
  assert.deepEqual(fromRepository.args, [
    '--experimental-strip-types',
    '--test',
    '--test-concurrency=4',
    '--test-reporter=./scripts/full-gate-reporter.ts',
    ...shardWrappers,
  ]);
  assert.deepEqual(fromPackage.args, [
    '--experimental-strip-types',
    '--test',
    '--test-concurrency=4',
    '--test-reporter=../../scripts/full-gate-reporter.ts',
    ...shardWrappers.map((wrapper) =>
      path.posix.relative('packages/workflow-engine', wrapper),
    ),
  ]);
  assert.deepEqual(checkRegistry.checks['workflow-tests']?.command, [
    'node',
    '--experimental-strip-types',
    '--test',
    '--test-concurrency=4',
    ...shardWrappers,
  ]);
  assert.equal(
    rootManifest.scripts['workflow:test'],
    'node --experimental-strip-types scripts/workflow-full-gate.ts',
  );
  assert.equal(
    rootManifest.scripts['workflow:test:status'],
    'node --experimental-strip-types scripts/workflow-full-gate.ts --status',
  );
  assert.equal(
    rootManifest.scripts['workflow:test:failures'],
    'node --experimental-strip-types scripts/workflow-full-gate.ts --failures',
  );
  assert.equal(
    rootManifest.scripts['workflow:test:timings'],
    'node --experimental-strip-types scripts/workflow-full-gate.ts --timings',
  );
  assert.equal(
    packageManifest.scripts.test,
    'node --experimental-strip-types ../../scripts/workflow-full-gate.ts',
  );
  assert.equal(
    packageManifest.scripts['test:status'],
    'node --experimental-strip-types ../../scripts/workflow-full-gate.ts --status',
  );
  assert.equal(
    packageManifest.scripts['test:failures'],
    'node --experimental-strip-types ../../scripts/workflow-full-gate.ts --failures',
  );
  assert.equal(
    packageManifest.scripts['test:timings'],
    'node --experimental-strip-types ../../scripts/workflow-full-gate.ts --timings',
  );
});

test('full-gate runner publishes one private run-bound telemetry sidecar without changing spec output', async () => {
  const repository = createGitRepository();
  const sourceRepository = path.resolve(import.meta.dirname, '../../..');
  const reporter = path.join(sourceRepository, 'scripts/full-gate-reporter.ts');
  const sampleTest = 'packages/workflow-engine/test/sample.test.ts';
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/test'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, sampleTest),
    "import test from 'node:test';\ntest('measured leaf', async () => {});\n",
  );
  commitAll(repository, 'Initial');
  const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
  const gate = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: {
      executable: process.execPath,
      args: [
        '--experimental-strip-types',
        '--test',
        `--test-reporter=${reporter}`,
        sampleTest,
      ],
    },
    coverageExpectation: syntheticCoverageExpectation([sampleTest]),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });

  assert.equal(gate.exitCode, 0);
  assert.match(fs.readFileSync(gate.stdoutLogPath, 'utf8'), /measured leaf/);
  assert.ok(gate.telemetryLogPath);
  const telemetryStats = fs.lstatSync(gate.telemetryLogPath);
  assert.equal(telemetryStats.isFile(), true);
  assert.equal(telemetryStats.isSymbolicLink(), false);
  assert.equal(telemetryStats.nlink, 1);
  assert.equal(telemetryStats.mode & 0o777, 0o600);
  const telemetry = fs
    .readFileSync(gate.telemetryLogPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(telemetry.length, 2);
  assert.equal(telemetry[0]?.name, 'measured leaf');
  assert.equal(telemetry[0]?.file, sampleTest);
  assert.deepEqual(telemetry[1], {
    kind: 'workflow-full-gate-test-telemetry-end.v1',
    recordCount: 1,
  });
  const latest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'latest.json'), 'utf8'),
  ) as { telemetryLogPath?: string };
  assert.equal(latest.telemetryLogPath, gate.telemetryLogPath);
  const cliPath = path.join(sourceRepository, 'scripts/workflow-full-gate.ts');
  const human = execFileSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, '--timings'],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.match(human, /1 test nodes across 1 files/);
  assert.match(human, /measured leaf/);
  const machine = JSON.parse(
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, '--timings', '--json'],
      { cwd: repository, encoding: 'utf8' },
    ),
  ) as {
    kind?: string;
    authority?: string;
    runId?: string;
    runState?: string;
    complete?: boolean;
    telemetryLogPath?: string;
    summary?: { kind?: string; testNodeCount?: number };
  };
  assert.equal(machine.kind, 'full-gate-timing-inspection.v1');
  assert.equal(machine.authority, 'observational-only');
  assert.equal(machine.runId, gate.runId);
  assert.equal(machine.runState, 'complete');
  assert.equal(machine.complete, true);
  assert.equal(machine.telemetryLogPath, gate.telemetryLogPath);
  assert.equal(
    machine.summary?.kind,
    'workflow-full-gate-telemetry-summary.v1',
  );
  assert.equal(machine.summary?.testNodeCount, 1);
  const receipt = JSON.parse(
    fs.readFileSync(gate.receiptPath ?? '', 'utf8'),
  ) as {
    kind?: string;
    outcome?: string;
    coverage?: {
      fileSetMatches?: boolean;
      footerComplete?: boolean;
      observedFileCount?: number;
      testNodeCount?: number;
    };
  };
  assert.equal(receipt.kind, 'full-gate-run-receipt.v2');
  assert.equal(receipt.outcome, 'passed');
  assert.equal(receipt.coverage?.fileSetMatches, true);
  assert.equal(receipt.coverage?.footerComplete, true);
  assert.equal(receipt.coverage?.observedFileCount, 1);
  assert.equal(receipt.coverage?.testNodeCount, 1);
});

test('pnpm argument separator is transport, not a full-gate option', () => {
  assert.deepEqual(parseFullGateCli(['--', '--expected-total', '1741']), {
    status: false,
    failures: false,
    timings: false,
    json: false,
    expectedTotal: 1_741,
    reason: null,
  });
  assert.deepEqual(parseFullGateCli(['--status', '--', '--json']), {
    status: true,
    failures: false,
    timings: false,
    json: true,
    expectedTotal: null,
    reason: null,
  });
  assert.deepEqual(parseFullGateCli(['--failures', '--json']), {
    status: false,
    failures: true,
    timings: false,
    json: true,
    expectedTotal: null,
    reason: null,
  });
  assert.deepEqual(parseFullGateCli(['--timings', '--json']), {
    status: false,
    failures: false,
    timings: true,
    json: true,
    expectedTotal: null,
    reason: null,
  });
});

test('projected tree identity survives an empty commit and changes with bytes', () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const before = projectWorkingTreeOid(repository);

  git(repository, ['commit', '--allow-empty', '-m', 'Same tree']);
  assert.equal(projectWorkingTreeOid(repository), before);

  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'two\n');
  assert.notEqual(projectWorkingTreeOid(repository), before);
});

test('production full-gate API rejects every test-only override own key', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'full-gate-production-boundary-'),
  );
  const invokeProduction = runFullGate as unknown as (
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  const command = syntheticCommand(
    "process.stdout.write('TAP version 13\\nok 1 - pass\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1\\n')",
    ['passed'],
  );
  const coverageExpectation = syntheticCoverageExpectation();

  for (const override of [
    { command },
    { coverageExpectation },
    { command, coverageExpectation },
    { command: undefined, coverageExpectation: undefined },
  ]) {
    await assert.rejects(
      invokeProduction({ cwd: repository, stateRoot, ...override }),
      (error) =>
        error instanceof TypeError &&
        /test-only full-gate overrides.*runFullGateForTesting/i.test(
          error.message,
        ),
    );
  }
});

test('full-gate transport stores raw TAP and emits exact startup hints once', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-state-'));
  const output: string[] = [];
  let latestAtFirstHint:
    | {
        snapshot: { runId: string; state: string };
        transition: string;
        stdoutLogPath: string;
      }
    | undefined;
  const command = syntheticCommand(
    "process.stdout.write('TAP version 13\\nok 1 - first\\nok 2 - second\\n# tests 2\\n# suites 0\\n# pass 2\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 10\\n')",
    ['passed', 'passed'],
  );

  const first = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 2,
    terminal: false,
    writeProgress: (line) => {
      if (output.length === 0) {
        latestAtFirstHint = JSON.parse(
          fs.readFileSync(path.join(stateRoot, 'latest.json'), 'utf8'),
        ) as typeof latestAtFirstHint;
      }
      output.push(line);
    },
    sampleIntervalMs: 5,
  });
  assert.equal(first.exitCode, 0);
  assert.equal(first.reused, false);
  assert.equal(latestAtFirstHint?.snapshot.runId, first.runId);
  assert.equal(latestAtFirstHint?.snapshot.state, 'buffered');
  assert.equal(latestAtFirstHint?.transition, 'started');
  assert.equal(latestAtFirstHint?.stdoutLogPath, first.stdoutLogPath);
  assert.equal(output.length, 6, JSON.stringify(output));
  assert.deepEqual(output.slice(0, 4), [
    'Monitor: pnpm workflow:test:status',
    'Machine status: pnpm workflow:test:status --json',
    `Full log: ${first.stdoutLogPath}`,
    'Failures: pnpm workflow:test:failures',
  ]);
  assert.match(output[4] ?? '', /0\/2/);
  assert.match(output[5] ?? '', /2\/2/);
  assert.doesNotMatch(output.slice(0, 4).join('\n'), /-- --json/);
  assert.doesNotMatch(output.join('\n'), /TAP version/);
  assert.match(fs.readFileSync(first.stdoutLogPath, 'utf8'), /TAP version 13/);
  const latest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'latest.json'), 'utf8'),
  ) as { snapshot: { state: string; completed: number } };
  assert.equal(latest.snapshot.state, 'complete');
  assert.equal(latest.snapshot.completed, 2);

  output.length = 0;
  git(repository, ['commit', '--allow-empty', '-m', 'Same tree']);
  const reused = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 2,
    terminal: false,
    writeProgress: (line) => output.push(line),
    sampleIntervalMs: 5,
  });
  assert.equal(reused.exitCode, 0);
  assert.equal(reused.reused, true);
  assert.equal(reused.runId, first.runId);
  assert.equal(output.length, 1);
  assert.match(output[0] ?? '', /REUSED/);

  const forced = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 2,
    reason: 'generated-artifact change',
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  assert.equal(forced.exitCode, 0);
  assert.equal(forced.reused, false);
  assert.notEqual(forced.runId, first.runId);
});

test('reusing an exact passing receipt republishes latest status and observation locators', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
  const passingCommand = syntheticCommand(
    "process.stdout.write('✔ pass (1ms)\\nℹ tests 1\\nℹ pass 1\\nℹ fail 0\\n')",
    ['passed'],
  );
  const passed = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: passingCommand,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  const forcedFailure = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      "process.stdout.write('✖ fail (1ms)\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\n'); process.exitCode=1",
      ['not-passed'],
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    reason: 'force newer failure',
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  assert.notEqual(forcedFailure.runId, passed.runId);

  const reused = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: passingCommand,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.runId, passed.runId);
  const latest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'latest.json'), 'utf8'),
  ) as {
    snapshot?: { runId?: string; state?: string };
    transition?: string;
    stdoutLogPath?: string;
  };
  assert.equal(latest.snapshot?.runId, passed.runId);
  assert.equal(latest.snapshot?.state, 'complete');
  assert.equal(latest.transition, 'reused');
  assert.equal(latest.stdoutLogPath, passed.stdoutLogPath);
});

test('receipt reuse rejects symlinked and non-private run ancestors', async (t) => {
  for (const attack of ['symlink', 'non-private'] as const) {
    await t.test(attack, async () => {
      const repository = createGitRepository();
      fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
      commitAll(repository, 'Initial');
      const stateRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `full-gate-reuse-${attack}-`),
      );
      const command = syntheticCommand(
        "process.stdout.write('TAP version 13\\nok 1 - pass\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1\\n')",
        ['passed'],
      );
      const options = {
        cwd: repository,
        stateRoot,
        command,
        coverageExpectation: syntheticCoverageExpectation(),
        expectedTotal: 1,
        terminal: false,
        writeProgress: () => {},
        sampleIntervalMs: 5,
      } as const;
      const first = await runFullGateForTesting(options);
      assert.equal(first.exitCode, 0);
      assert.equal(first.reused, false);
      const runRoot = path.dirname(first.stdoutLogPath);

      if (attack === 'symlink') {
        const relocated = path.join(stateRoot, `relocated-${first.runId}`);
        fs.renameSync(runRoot, relocated);
        fs.symlinkSync(relocated, runRoot, 'dir');
      } else {
        fs.chmodSync(runRoot, 0o755);
      }

      const second = await runFullGateForTesting(options);
      assert.equal(second.exitCode, 0);
      assert.equal(second.reused, false);
      assert.notEqual(second.runId, first.runId);
    });
  }
});

test('receipt reuse opens evidence with no-follow semantics', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'full-gate-reuse-no-follow-'),
  );
  const command = syntheticCommand(
    "process.stdout.write('TAP version 13\\nok 1 - pass\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1\\n')",
    ['passed'],
  );
  const options = {
    cwd: repository,
    stateRoot,
    command,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  } as const;
  const first = await runFullGateForTesting(options);
  assert.equal(first.exitCode, 0);
  const telemetryPath = first.telemetryLogPath;
  const originalTelemetryPath = `${telemetryPath}.original`;
  const mutableFs = fs as unknown as {
    openSync: typeof fs.openSync;
  };
  const originalOpenSync = mutableFs.openSync;
  let attackTriggered = false;
  mutableFs.openSync = ((
    target: fs.PathLike,
    flags: fs.OpenMode,
    mode?: fs.Mode,
  ): number => {
    if (
      !attackTriggered &&
      String(target) === telemetryPath &&
      typeof flags === 'number' &&
      (flags & fs.constants.O_NOFOLLOW) !== 0
    ) {
      attackTriggered = true;
      fs.renameSync(telemetryPath, originalTelemetryPath);
      fs.symlinkSync(originalTelemetryPath, telemetryPath);
    }
    return mode === undefined
      ? originalOpenSync(target, flags)
      : originalOpenSync(target, flags, mode);
  }) as typeof fs.openSync;

  let second: Awaited<ReturnType<typeof runFullGateForTesting>>;
  try {
    second = await runFullGateForTesting(options);
  } finally {
    mutableFs.openSync = originalOpenSync;
    const observed = fs.lstatSync(telemetryPath, { throwIfNoEntry: false });
    if (observed?.isSymbolicLink()) {
      fs.unlinkSync(telemetryPath);
      fs.renameSync(originalTelemetryPath, telemetryPath);
    }
  }

  assert.equal(attackTriggered, true);
  assert.equal(second.exitCode, 0);
  assert.equal(second.reused, false);
  assert.notEqual(second.runId, first.runId);
});

test('failure inspector reads only the latest raw stdout log and bounds concise locations', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
  const resultLines = Array.from(
    { length: 22 },
    (_, index) => `✖ failed test ${index + 1} (1ms)`,
  );
  const summary = [
    'ℹ tests 22',
    'ℹ suites 0',
    'ℹ pass 0',
    'ℹ fail 22',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 22',
    '✖ failing tests:',
    'AssertionError: this stack must not be copied',
  ];
  const gate = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      `process.stdout.write(${JSON.stringify(`${[...resultLines, ...summary].join('\n')}\n`)}); process.exitCode = 1`,
      Array.from({ length: 22 }, () => 'not-passed'),
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 22,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  assert.equal(gate.exitCode, 1);

  const cliPath = path.resolve(
    import.meta.dirname,
    '../../../scripts/workflow-full-gate.ts',
  );
  const json = execFileSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, '--failures', '--json'],
    { cwd: repository, encoding: 'utf8' },
  );
  const inspection = JSON.parse(json) as {
    authority: string;
    runId: string;
    stdoutLogPath: string;
    failures: Array<{
      index: number;
      name: string;
      logLine: number;
      byteOffset: number;
    }>;
    truncated: boolean;
  };
  assert.equal(inspection.authority, 'observational-only');
  assert.equal(inspection.runId, gate.runId);
  assert.equal(inspection.stdoutLogPath, gate.stdoutLogPath);
  assert.equal(inspection.failures.length, 20);
  assert.deepEqual(inspection.failures[0], {
    index: 1,
    name: 'failed test 1',
    logLine: 1,
    byteOffset: 0,
  });
  assert.deepEqual(inspection.failures.at(-1), {
    index: 20,
    name: 'failed test 20',
    logLine: 20,
    byteOffset: Buffer.byteLength(`${resultLines.slice(0, 19).join('\n')}\n`),
  });
  assert.equal(inspection.truncated, true);

  const human = execFileSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, '--failures'],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.match(human, /1\. failed test 1 .*stdout\.log:1/);
  assert.doesNotMatch(human, /AssertionError|stack must not be copied/);

  const noRunRepository = createGitRepository();
  const noRun = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, '--failures'],
    { cwd: noRunRepository, encoding: 'utf8' },
  );
  assert.notEqual(noRun.status, 0);
  assert.match(noRun.stderr, /No full-gate run is available/);
});

test('failure inspector says No failures observed for a latest passing raw log', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
  await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      "process.stdout.write('✔ pass (1ms)\\nℹ tests 1\\nℹ pass 1\\nℹ fail 0\\n')",
      ['passed'],
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  const cliPath = path.resolve(
    import.meta.dirname,
    '../../../scripts/workflow-full-gate.ts',
  );
  const human = execFileSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, '--failures'],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.equal(human, 'No failures observed\n');
});

test('failure inspector rejects symlinked or non-private run ancestors', async (t) => {
  const cliPath = path.resolve(
    import.meta.dirname,
    '../../../scripts/workflow-full-gate.ts',
  );

  await t.test('symlinked runs directory', async () => {
    const repository = createGitRepository();
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
    commitAll(repository, 'Initial');
    const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
    const gate = await runFullGateForTesting({
      cwd: repository,
      stateRoot,
      command: syntheticCommand(
        "process.stdout.write('✖ failed test (1ms)\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\n'); process.exitCode = 1",
        ['not-passed'],
      ),
      coverageExpectation: syntheticCoverageExpectation(),
      expectedTotal: 1,
      terminal: false,
      writeProgress: () => {},
      sampleIntervalMs: 5,
    });
    const runsRoot = path.dirname(path.dirname(gate.stdoutLogPath));
    const relocatedRunsRoot = path.join(stateRoot, 'runs-relocated');
    fs.renameSync(runsRoot, relocatedRunsRoot);
    fs.symlinkSync(relocatedRunsRoot, runsRoot, 'dir');

    const inspection = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, '--failures'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.notEqual(inspection.status, 0);
    assert.match(inspection.stderr, /unsafe/);
  });

  await t.test('non-private run directory', async () => {
    const repository = createGitRepository();
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
    commitAll(repository, 'Initial');
    const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
    const gate = await runFullGateForTesting({
      cwd: repository,
      stateRoot,
      command: syntheticCommand(
        "process.stdout.write('✖ failed test (1ms)\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\n'); process.exitCode = 1",
        ['not-passed'],
      ),
      coverageExpectation: syntheticCoverageExpectation(),
      expectedTotal: 1,
      terminal: false,
      writeProgress: () => {},
      sampleIntervalMs: 5,
    });
    fs.chmodSync(path.dirname(gate.stdoutLogPath), 0o755);

    const inspection = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, '--failures'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.notEqual(inspection.status, 0);
    assert.match(inspection.stderr, /unsafe/);
  });
});

test('human failure output escapes terminal control characters', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = path.join(repository, '.git/workflow-engine/full-gate');
  const gate = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      "process.stdout.write('✖ safe test (1ms)\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\n'); process.exitCode = 1",
      ['not-passed'],
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });
  fs.writeFileSync(
    gate.stdoutLogPath,
    `✖ hostile\u001b[31m\u0000\u202ename (1ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1\n`,
  );
  const cliPath = path.resolve(
    import.meta.dirname,
    '../../../scripts/workflow-full-gate.ts',
  );
  const human = execFileSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, '--failures'],
    { cwd: repository, encoding: 'utf8' },
  );

  assert.match(human, /hostile\\u001B\[31m\\u0000\\u202Ename/);
  assert.doesNotMatch(human.trimEnd(), /[\p{Cc}\p{Cf}]/u);
});

test('running durable status preserves the first failure name and an exact rereadable log locator', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-status-'));
  let releaseFailureSnapshot: (() => void) | undefined;
  const failureSnapshotWritten = new Promise<void>((resolve) => {
    releaseFailureSnapshot = resolve;
  });
  const command = syntheticCommand(
    [
      "process.stdout.write('✔ first test (1.2ms)\\n✖ second test (2.4ms)\\n');",
      'setTimeout(() => {',
      "  process.stdout.write('ℹ tests 2\\nℹ suites 0\\nℹ pass 1\\nℹ fail 1\\nℹ cancelled 0\\nℹ skipped 0\\nℹ todo 0\\nℹ duration_ms 10.5\\n✖ failing tests:\\ntest at fixture.test.ts:2:1\\n✖ second test (2.4ms)\\n');",
      '  process.exitCode = 1;',
      '}, 150);',
    ].join(' '),
    ['passed', 'not-passed'],
  );

  const run = runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command,
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 2,
    terminal: false,
    writeProgress: (line) => {
      if (/fail 1/.test(line)) releaseFailureSnapshot?.();
    },
    sampleIntervalMs: 5,
  });

  await failureSnapshotWritten;
  const latest = await waitForLatestState(stateRoot, 'buffered');
  assert.equal(latest.snapshot.firstFailureName, 'second test');
  assert.ok(latest.snapshot.firstFailureLogLocator);
  const locator = latest.snapshot.firstFailureLogLocator!;
  assert.equal(locator.path, latest.stdoutLogPath);
  const rawLog = fs.readFileSync(locator.path);
  assert.equal(
    rawLog.subarray(locator.byteOffset).toString().split(/\r?\n/, 1)[0],
    '✖ second test (2.4ms)',
  );

  const result = await run;
  assert.equal(result.exitCode, 1);
  const receipt = JSON.parse(
    fs.readFileSync(result.receiptPath ?? '', 'utf8'),
  ) as { progress: { completed: number; pass: number; fail: number } };
  assert.deepEqual(receipt.progress, {
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

test('same-identity full gates cannot run in parallel', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-lock-'));
  const identity = createFullGateIdentity({
    projectedTreeOid: 'a'.repeat(40),
    generatedArtifactsDigest: `sha256:${'b'.repeat(64)}`,
    command: [process.execPath, '--test', 'test.ts'],
    workingDirectory: '.',
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  });
  const first = acquireFullGateLock(
    stateRoot,
    identity,
    'run-one',
    process.pid,
  );
  assert.equal(first.acquired, true);
  const duplicate = acquireFullGateLock(
    stateRoot,
    identity,
    'run-two',
    process.pid,
  );
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.owner?.runId, 'run-one');
  releaseFullGateLock(first);

  const stale = acquireFullGateLock(
    stateRoot,
    identity,
    'run-stale',
    2_147_483_647,
  );
  assert.equal(stale.acquired, true);
  const recovered = acquireFullGateLock(
    stateRoot,
    identity,
    'run-recovered',
    process.pid,
  );
  assert.equal(recovered.acquired, true);
  assert.ok(
    fs
      .readdirSync(path.join(stateRoot, 'stale-locks'))
      .some((entry) => entry.endsWith('.json')),
  );
  releaseFullGateLock(recovered);
});

test('malformed telemetry fails closed with a terminal failed snapshot and receipt', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'full-gate-malformed-telemetry-'),
  );
  const result = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      [
        `require('node:fs').writeFileSync(process.env.WORKFLOW_FULL_GATE_TELEMETRY_PATH, '{malformed}\\n')`,
        "process.stdout.write('TAP version 13\\nok 1 - pass\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 10\\n')",
      ].join('; '),
      ['passed'],
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });

  assert.equal(result.exitCode, 1);
  const latest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'latest.json'), 'utf8'),
  ) as { snapshot: { state: string } };
  assert.equal(latest.snapshot.state, 'failed');
  const receipt = JSON.parse(
    fs.readFileSync(result.receiptPath ?? '', 'utf8'),
  ) as {
    kind: string;
    outcome: string;
    coverage: { footerComplete: boolean; fileSetMatches: boolean };
  };
  assert.equal(receipt.kind, 'full-gate-run-receipt.v2');
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.coverage.footerComplete, false);
  assert.equal(receipt.coverage.fileSetMatches, false);
});

test('a nonzero process without a test failure is still rendered and receipted as failed', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-fail-'));
  const output: string[] = [];
  const result = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      "process.stderr.write('runner failed\\n'); process.exitCode = 3",
      [],
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 2,
    terminal: false,
    writeProgress: (line) => output.push(line),
    sampleIntervalMs: 5,
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.reused, false);
  assert.match(output.at(-1) ?? '', /failed/);
  const latest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'latest.json'), 'utf8'),
  ) as { snapshot: { state: string } };
  assert.equal(latest.snapshot.state, 'failed');
  const receipt = JSON.parse(
    fs.readFileSync(result.receiptPath ?? '', 'utf8'),
  ) as {
    outcome: string;
    standardErrorBytes: number;
  };
  assert.equal(receipt.outcome, 'failed');
  assert.ok(receipt.standardErrorBytes > 0);
});

test('a passing process cannot publish a reusable receipt after the checkout drifts', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-drift-'));
  const result = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: syntheticCommand(
      "require('node:fs').writeFileSync('tracked.txt','drift\\n'); process.stdout.write('TAP version 13\\nok 1 - pass\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 10\\n')",
      ['passed'],
    ),
    coverageExpectation: syntheticCoverageExpectation(),
    expectedTotal: 1,
    terminal: false,
    writeProgress: () => {},
    sampleIntervalMs: 5,
  });

  const receipt = JSON.parse(
    fs.readFileSync(result.receiptPath ?? '', 'utf8'),
  ) as {
    outcome: string;
    identityStable: boolean;
    identity: { bindings: { workingDirectory: string } };
  };
  assert.equal(
    fs.readFileSync(path.join(repository, 'tracked.txt'), 'utf8'),
    'drift\n',
  );
  assert.equal(result.exitCode, 1, JSON.stringify(receipt));
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.identityStable, false);
  assert.equal(receipt.identity.bindings.workingDirectory, '.');
});

type SyntheticTestOutcome = 'passed' | 'not-passed' | 'skipped' | 'todo';

const SYNTHETIC_TEST_FILE = 'packages/workflow-engine/test/synthetic.test.ts';

function syntheticCommand(
  body: string,
  outcomes: readonly SyntheticTestOutcome[],
  file = SYNTHETIC_TEST_FILE,
): { executable: string; args: readonly string[] } {
  const records = outcomes.map((outcome, index) => ({
    kind: 'workflow-full-gate-test-telemetry.v1',
    sequence: index + 1,
    testNumber: index + 1,
    file,
    line: index + 1,
    name: `synthetic test ${index + 1}`,
    nesting: 0,
    outcome,
    durationMs: 1,
  }));
  const telemetry = `${[
    ...records,
    {
      kind: 'workflow-full-gate-test-telemetry-end.v1',
      recordCount: records.length,
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`;
  const writeTelemetry = `require('node:fs').writeFileSync(process.env.WORKFLOW_FULL_GATE_TELEMETRY_PATH, ${JSON.stringify(telemetry)}, { encoding: 'utf8', flag: 'wx', mode: 0o600 })`;
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze(['-e', `${writeTelemetry}; ${body}`]),
  });
}

function syntheticCoverageExpectation(
  expectedFiles: readonly string[] = [SYNTHETIC_TEST_FILE],
): FullGateCoverageExpectation {
  const files = Object.freeze([...expectedFiles]);
  return Object.freeze({
    inventoryDigest: `sha256:${'f'.repeat(64)}`,
    expectedFiles: files,
    expectedFileSetDigest: digestWorkflowTestFileSet(files),
  });
}

function createGitRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-repo-'));
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.name', 'Full Gate Test']);
  git(repository, ['config', 'user.email', 'full-gate@example.invalid']);
  return repository;
}

async function waitForLatestState(
  stateRoot: string,
  state: string,
): Promise<{
  snapshot: {
    state: string;
    firstFailureName: string | null;
    firstFailureLogLocator: { path: string; byteOffset: number } | null;
  };
  stdoutLogPath: string;
}> {
  const latestPath = path.join(stateRoot, 'latest.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(latestPath)) {
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as {
        snapshot: {
          state: string;
          firstFailureName: string | null;
          firstFailureLogLocator: {
            path: string;
            byteOffset: number;
          } | null;
        };
        stdoutLogPath: string;
      };
      if (latest.snapshot.state === state) return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`latest.json never reached ${state}`);
}

function commitAll(repository: string, message: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', message]);
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
}
