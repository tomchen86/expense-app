import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  OBSERVED_CHECK_FAILURE_EXCERPT_BYTES,
  pinCheckRunner,
  runCheck,
  runObservedCheck,
  type CheckEvidence,
  type ObservedCheckFailure,
} from '../src/check-runner.ts';
import type { CheckDefinition } from '../src/contracts.ts';
import type { InvestigationRuntimePaths } from '../src/paths.ts';
import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  createTaskStrategyGreenFailureRecord,
  parseTaskStrategyCorrectionPolicy,
  prepareTaskStrategyGreenFailureRecord,
  readTaskStrategyGreenFailureRecord,
} from '../src/task-strategy-correction-store.ts';

const SESSION_ID = 'session-correction-store';

test('an ordinary non-zero check preserves bounded engine-observed failure evidence', () => {
  const repository = createRunnerFixture();
  try {
    const definition = writeRunner(
      repository,
      'ordinary-failure.mjs',
      [
        `process.stdout.write('OUT:' + 'x'.repeat(${OBSERVED_CHECK_FAILURE_EXCERPT_BYTES + 64}));`,
        `process.stderr.write('ERR:' + 'y'.repeat(${OBSERVED_CHECK_FAILURE_EXCERPT_BYTES + 64}));`,
        'process.exit(7);',
      ].join('\n'),
    );
    const pinned = pinCheckRunner(repository, 'fixture', definition);
    const first = runObservedCheck(
      repository,
      'fixture',
      definition,
      pinned,
      process.env,
    );
    const second = runObservedCheck(
      repository,
      'fixture',
      definition,
      pinned,
      process.env,
    );

    assert.equal(first.outcome, 'failed');
    assert.equal(second.outcome, 'failed');
    if (first.outcome !== 'failed' || second.outcome !== 'failed') {
      throw new Error('fixture must fail');
    }
    assert.equal(first.checkId, 'fixture');
    assert.equal(first.exitCode, 7);
    assert.equal(first.runner, pinned.runner);
    assert.equal(first.runnerDigest, pinned.digest);
    assert.equal(first.stdoutTruncated, true);
    assert.equal(first.stderrTruncated, true);
    assert.ok(
      Buffer.byteLength(first.stdoutExcerpt, 'utf8') <=
        OBSERVED_CHECK_FAILURE_EXCERPT_BYTES,
    );
    assert.ok(
      Buffer.byteLength(first.stderrExcerpt, 'utf8') <=
        OBSERVED_CHECK_FAILURE_EXCERPT_BYTES,
    );
    assert.match(first.stdoutDigest, /^[0-9a-f]{64}$/u);
    assert.match(first.stderrDigest, /^[0-9a-f]{64}$/u);
    assert.match(first.failureFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(first.failureFingerprint, second.failureFingerprint);

    assert.throws(
      () => runCheck(repository, 'fixture', definition, pinned, process.env),
      hasCode('CHECK_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('signal and max-buffer failures never masquerade as semantic check failures', () => {
  const repository = createRunnerFixture();
  try {
    const signaled = writeRunner(
      repository,
      'signal.mjs',
      "process.kill(process.pid, 'SIGTERM');\n",
    );
    assert.throws(
      () =>
        runObservedCheck(
          repository,
          'signal-check',
          signaled,
          pinCheckRunner(repository, 'signal-check', signaled),
          process.env,
        ),
      hasCode('CHECK_TERMINATED'),
    );

    const overflowing = writeRunner(
      repository,
      'overflow.mjs',
      "import fs from 'node:fs';\nfs.writeSync(1, Buffer.alloc(11 * 1024 * 1024, 120));\nprocess.exit(3);\n",
    );
    assert.throws(
      () =>
        runObservedCheck(
          repository,
          'overflow-check',
          overflowing,
          pinCheckRunner(repository, 'overflow-check', overflowing),
          process.env,
        ),
      hasCode('CHECK_EXECUTION_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('green failure records bind the exact candidate and are append-only and idempotent', () => {
  const fixture = createRuntimeFixture();
  try {
    const input = greenFailureInput();
    const prepared = prepareTaskStrategyGreenFailureRecord(input);
    const laterAuditTime = prepareTaskStrategyGreenFailureRecord({
      ...input,
      createdAt: '2026-08-13T00:01:00.000Z',
    });
    assert.equal(prepared.subjectDigest, laterAuditTime.subjectDigest);
    assert.notEqual(prepared.recordDigest, laterAuditTime.recordDigest);
    assert.equal('expiresAt' in prepared, false);
    assert.equal('maxAgeMs' in prepared, false);

    const created = createTaskStrategyGreenFailureRecord(fixture.paths, input);
    const replayed = createTaskStrategyGreenFailureRecord(fixture.paths, {
      ...input,
      createdAt: '2026-08-13T00:01:00.000Z',
    });
    assert.equal(replayed.recordDigest, created.recordDigest);
    assert.deepEqual(
      readTaskStrategyGreenFailureRecord(
        fixture.paths,
        SESSION_ID,
        input.candidateTree,
      ),
      created,
    );

    const changedFailure = {
      ...input.failingCheck,
      stderrDigest: digest('different stderr'),
      stderrExcerpt: 'different stderr',
    };
    const fingerprintBody = {
      ...changedFailure,
      failureFingerprint: undefined,
    };
    delete fingerprintBody.failureFingerprint;
    assert.throws(
      () =>
        createTaskStrategyGreenFailureRecord(fixture.paths, {
          ...input,
          failingCheck: {
            ...changedFailure,
            failureFingerprint: digest(canonicalJson(fingerprintBody)),
          },
        }),
      hasCode('TASK_STRATEGY_GREEN_FAILURE_CONFLICT'),
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('correction policy reuses the bounded adapter repair accounting shape', () => {
  assert.deepEqual(DEFAULT_TASK_STRATEGY_CORRECTION_POLICY, {
    maxRepairAttempts: 2,
    maxSameFailureFingerprint: 2,
  });
  assert.deepEqual(
    parseTaskStrategyCorrectionPolicy({
      maxRepairAttempts: 1,
      maxSameFailureFingerprint: 2,
    }),
    {
      maxRepairAttempts: 1,
      maxSameFailureFingerprint: 2,
    },
  );
  assert.throws(
    () =>
      parseTaskStrategyCorrectionPolicy({
        maxRepairAttempts: 3,
        maxSameFailureFingerprint: 2,
      }),
    hasCode('TASK_STRATEGY_CORRECTION_POLICY_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskStrategyCorrectionPolicy({
        maxRepairAttempts: 1,
        maxSameFailureFingerprint: 2,
        deadlineMs: 1,
      }),
    hasCode('TASK_STRATEGY_CORRECTION_POLICY_INVALID'),
  );
});

function greenFailureInput() {
  const passedCheck: CheckEvidence = {
    checkId: 'lint',
    outcome: 'passed',
    exitCode: 0,
    runner: 'node',
    runnerDigest: digest('lint-runner'),
    destructiveDatabase: false,
  };
  const failureWithoutFingerprint = {
    checkId: 'test',
    outcome: 'failed' as const,
    exitCode: 1,
    runner: 'node',
    runnerDigest: digest('test-runner'),
    stdoutDigest: digest('one test failed'),
    stderrDigest: digest(''),
    stdoutExcerpt: 'one test failed',
    stderrExcerpt: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const failingCheck: ObservedCheckFailure = {
    ...failureWithoutFingerprint,
    failureFingerprint: digest(canonicalJson(failureWithoutFingerprint)),
  };
  return {
    sessionId: SESSION_ID,
    currentRedTransactionDigest: digest('red-transaction'),
    currentPatchHead: {
      bindingDigest: digest('patch-binding'),
      recordDigest: digest('patch-record'),
      patchDigest: digest('patch'),
      receiptDigest: digest('patch-receipt'),
    },
    candidateTree: '1'.repeat(40),
    checkDefinitions: [
      {
        checkId: 'lint',
        definition: {
          command: ['node', 'scripts/lint.mjs'],
          destructiveDatabase: false,
        },
        runner: 'node',
        runnerDigest: passedCheck.runnerDigest,
      },
      {
        checkId: 'test',
        definition: {
          command: ['node', 'scripts/test.mjs'],
          destructiveDatabase: false,
        },
        runner: 'node',
        runnerDigest: failingCheck.runnerDigest,
      },
    ],
    passedChecks: [passedCheck],
    failingCheck,
    createdAt: '2026-08-13T00:00:00.000Z',
  };
}

function createRunnerFixture(): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-correction-runner-')),
  );
  fs.mkdirSync(path.join(repository, 'scripts'));
  return repository;
}

function writeRunner(
  repository: string,
  name: string,
  content: string,
): CheckDefinition {
  fs.writeFileSync(path.join(repository, 'scripts', name), content);
  return {
    command: ['node', `scripts/${name}`],
    destructiveDatabase: false,
  };
}

function createRuntimeFixture(): {
  base: string;
  paths: InvestigationRuntimePaths;
} {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-correction-store-')),
  );
  const root = path.join(base, 'workflow-engine', 'investigations');
  return {
    base,
    paths: {
      base,
      root,
      objects: path.join(root, 'objects', 'sha256'),
      refs: path.join(root, 'refs'),
      sessions: path.join(root, 'sessions'),
      invocations: path.join(root, 'invocations'),
      locks: path.join(root, 'locks'),
    },
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === expected;
}
