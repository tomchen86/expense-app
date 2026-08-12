import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  runFullGateForTesting,
} from '../../../scripts/workflow-full-gate.ts';
import { createFullGateIdentity } from '../../../scripts/full-gate-progress.ts';

test('full-gate wrapper preserves the two existing test entrypoints and their order', () => {
  const repository = path.resolve(import.meta.dirname, '../../..');
  const packageRoot = path.join(repository, 'packages/workflow-engine');
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(repository, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const fromRepository = buildFullGateCommand(repository);
  const fromPackage = buildFullGateCommand(packageRoot);

  assert.equal(fromRepository.executable, process.execPath);
  assert.deepEqual(fromRepository.args, [
    '--experimental-strip-types',
    '--test',
    'packages/workflow-engine/test/contracts.test.ts',
    'packages/workflow-engine/test/session.integration.test.ts',
  ]);
  assert.deepEqual(fromPackage.args, [
    '--experimental-strip-types',
    '--test',
    'test/contracts.test.ts',
    'test/session.integration.test.ts',
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
    packageManifest.scripts.test,
    'node --experimental-strip-types ../../scripts/workflow-full-gate.ts',
  );
  assert.equal(
    packageManifest.scripts['test:status'],
    'node --experimental-strip-types ../../scripts/workflow-full-gate.ts --status',
  );
});

test('pnpm argument separator is transport, not a full-gate option', () => {
  assert.deepEqual(parseFullGateCli(['--', '--expected-total', '1741']), {
    status: false,
    json: false,
    expectedTotal: 1_741,
    reason: null,
  });
  assert.deepEqual(parseFullGateCli(['--status', '--', '--json']), {
    status: true,
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

test('full-gate transport stores raw TAP in logs and emits only start and completion', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-state-'));
  const output: string[] = [];
  const command = {
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('TAP version 13\\nok 1 - first\\nok 2 - second\\n# tests 2\\n# suites 0\\n# pass 2\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 10\\n')",
    ],
  };

  const first = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command,
    expectedTotal: 2,
    terminal: false,
    writeProgress: (line) => output.push(line),
    sampleIntervalMs: 5,
  });
  assert.equal(first.exitCode, 0);
  assert.equal(first.reused, false);
  assert.equal(output.length, 2, JSON.stringify(output));
  assert.match(output[0] ?? '', /0\/2/);
  assert.match(output[1] ?? '', /2\/2/);
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

test('a nonzero process without a test failure is still rendered and receipted as failed', async () => {
  const repository = createGitRepository();
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'one\n');
  commitAll(repository, 'Initial');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-fail-'));
  const output: string[] = [];
  const result = await runFullGateForTesting({
    cwd: repository,
    stateRoot,
    command: {
      executable: process.execPath,
      args: ['-e', "process.stderr.write('runner failed\\n'); process.exit(3)"],
    },
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
    command: {
      executable: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeFileSync('tracked.txt','drift\\n'); process.stdout.write('TAP version 13\\nok 1 - pass\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 10\\n')",
      ],
    },
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

function createGitRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'full-gate-repo-'));
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.name', 'Full Gate Test']);
  git(repository, ['config', 'user.email', 'full-gate@example.invalid']);
  return repository;
}

function commitAll(repository: string, message: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', message]);
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
}
