import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renderHandoff } from '../src/handoff.ts';
import { cancelFinalizeRecovery, finalizeSession } from '../src/lifecycle.ts';
import { getSession, startSession } from '../src/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
} from './fixture.ts';

test('workflow status exposes the exact durable finalize recovery classification', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    assert.throws(
      () =>
        finalizeSession(
          repository,
          sessionId,
          'Complete recovered task',
          process.env,
          { testCrashAfter: 'checks-running' },
        ),
      /Simulated finalize interruption/,
    );
    const transaction = JSON.parse(
      fs.readFileSync(transactionPath, 'utf8'),
    ) as { phase: string; transactionId: string };
    assert.equal(transaction.phase, 'checks-running');

    const status = runCli(repository, ['status', sessionId, '--json']);
    assert.equal(status.status, 0, status.stderr);
    const output = JSON.parse(status.stdout) as {
      finalize: Record<string, unknown>;
    };
    assert.deepEqual(output.finalize, {
      state: 'recovery-required',
      transactionId: transaction.transactionId,
      phase: 'checks-running',
      retrySafe: false,
      recoveryCommand:
        `pnpm workflow finalize-recover ${sessionId} ` +
        `--cancel ${transaction.transactionId} --reason <text> --json`,
    });

    const unsafeRecovery = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--json',
    ]);
    assert.notEqual(unsafeRecovery.status, 0);
    assert.equal(
      parseErrorCode(unsafeRecovery.stderr),
      'FINALIZE_RECOVERY_REQUIRED',
    );
    assert.equal(
      (
        JSON.parse(fs.readFileSync(transactionPath, 'utf8')) as {
          phase: string;
        }
      ).phase,
      'checks-running',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize-recover explicitly cancels one ambiguous transaction and preserves its journal', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    assert.throws(
      () =>
        finalizeSession(
          repository,
          sessionId,
          'Complete recovered task',
          process.env,
          { testCrashAfter: 'checks-running' },
        ),
      /Simulated finalize interruption/,
    );
    const transaction = JSON.parse(
      fs.readFileSync(transactionPath, 'utf8'),
    ) as { transactionId: string };
    const reason = 'Ambiguous check outcome was reviewed';
    const args = [
      'finalize-recover',
      sessionId,
      '--cancel',
      transaction.transactionId,
      '--reason',
      reason,
      '--json',
    ];

    const cancelled = runCli(repository, args);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const result = parseResult(cancelled.stdout);
    assert.equal(result.state, 'cancelled');
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.transactionId, transaction.transactionId);
    assert.equal(result.reason, reason);
    assert.match(result.cancelledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.existsSync(transactionPath), false);
    const archivedPath = path.join(
      runtimeRoot(repository),
      'finalize-transaction-history',
      `${transaction.transactionId}.json`,
    );
    const archived = JSON.parse(fs.readFileSync(archivedPath, 'utf8')) as {
      phase: string;
      transactionId: string;
      transaction: { phase: string; transactionId: string };
      reason: string;
      cancelledAt: string;
    };
    assert.equal(archived.phase, 'completed');
    assert.equal(archived.transactionId, transaction.transactionId);
    assert.equal(archived.transaction.phase, 'checks-running');
    assert.equal(archived.transaction.transactionId, transaction.transactionId);
    assert.equal(archived.reason, reason);
    assert.equal(archived.cancelledAt, result.cancelledAt);
    assert.match(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[ \] 1\.1/,
    );
    assert.doesNotMatch(
      fs.readFileSync(
        path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      /None — all tasks are complete\./,
    );
    assert.equal(
      fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
      'export {};\n',
    );
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only', '--']),
      '',
    );
    assert.equal(getSession(repository, sessionId).state, 'active');

    const replay = runCli(repository, args);
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(parseResult(replay.stdout), result);

    const wrongReason = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transaction.transactionId,
      '--reason',
      'Different cancellation reason',
      '--json',
    ]);
    assert.notEqual(wrongReason.status, 0);
    assert.equal(
      parseErrorCode(wrongReason.stderr),
      'FINALIZE_CANCELLATION_INVALID',
    );

    const restarted = runCli(repository, [
      'finalize',
      sessionId,
      '--message',
      'Complete recovered task',
      '--json',
    ]);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(getSession(repository, sessionId).state, 'committed');

    const restartedTransaction = fs.readFileSync(transactionPath, 'utf8');
    const replayAfterRestart = runCli(repository, args);
    assert.equal(replayAfterRestart.status, 0, replayAfterRestart.stderr);
    assert.deepEqual(parseResult(replayAfterRestart.stdout), result);
    assert.equal(
      fs.readFileSync(transactionPath, 'utf8'),
      restartedTransaction,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const phase of [
  'cancellation-requested',
  'projection-restored',
  'cancellation-completed',
] as const) {
  test(`workflow finalize cancellation recovers the exact ${phase} interruption`, () => {
    const { repository, sessionId, transactionPath } = createRecoveryFixture();
    try {
      assert.throws(
        () =>
          finalizeSession(
            repository,
            sessionId,
            'Complete recovered task',
            process.env,
            { testCrashAfter: 'checks-running' },
          ),
        /Simulated finalize interruption/,
      );
      const transaction = JSON.parse(
        fs.readFileSync(transactionPath, 'utf8'),
      ) as { transactionId: string };
      const reason = `Recover ${phase}`;
      assert.throws(
        () =>
          cancelFinalizeRecovery(
            repository,
            sessionId,
            transaction.transactionId,
            reason,
            { testCrashAfter: phase },
          ),
        /Simulated finalize cancellation/,
      );

      const recovered = cancelFinalizeRecovery(
        repository,
        sessionId,
        transaction.transactionId,
        reason,
      );
      assert.equal(recovered.state, 'cancelled');
      assert.equal(recovered.transactionId, transaction.transactionId);
      assert.equal(fs.existsSync(transactionPath), false);
      assert.match(
        fs.readFileSync(
          path.join(repository, 'openspec/changes/demo-change/tasks.md'),
          'utf8',
        ),
        /- \[ \] 1\.1/,
      );
      assert.equal(
        fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
        'export {};\n',
      );
      assert.equal(
        git(repository, ['diff', '--cached', '--name-only', '--']),
        '',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('workflow finalize-recover resumes a safe phase without rerunning its check', () => {
  const { repository, sessionId, transactionPath, counterPath } =
    createRecoveryFixture();
  try {
    assert.throws(
      () =>
        finalizeSession(
          repository,
          sessionId,
          'Complete recovered task',
          process.env,
          { testCrashAfter: 'checked' },
        ),
      /Simulated finalize interruption/,
    );
    const before = JSON.parse(fs.readFileSync(transactionPath, 'utf8')) as {
      transactionId: string;
    };
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const recovered = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--json',
    ]);
    assert.equal(recovered.status, 0, recovered.stderr);
    const result = JSON.parse(recovered.stdout) as {
      result: { transactionId: string; tree: string };
    };
    assert.equal(result.result.transactionId, before.transactionId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(getSession(repository, sessionId).state, 'active');

    const committed = runCli(repository, [
      'finalize',
      sessionId,
      '--message',
      'Complete recovered task',
      '--json',
    ]);
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(getSession(repository, sessionId).state, 'committed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize cancellation preserves a foreign staged index and its active transaction', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    assert.throws(
      () =>
        finalizeSession(
          repository,
          sessionId,
          'Complete recovered task',
          process.env,
          { testCrashAfter: 'checks-running' },
        ),
      /Simulated finalize interruption/,
    );
    const transaction = JSON.parse(
      fs.readFileSync(transactionPath, 'utf8'),
    ) as { transactionId: string };
    fs.writeFileSync(path.join(repository, 'src/foreign.ts'), 'export {};\n');
    git(repository, ['add', 'src/foreign.ts']);

    const cancellation = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transaction.transactionId,
      '--reason',
      'Cancel without overwriting foreign staged bytes',
      '--json',
    ]);
    assert.notEqual(cancellation.status, 0);
    assert.equal(
      parseErrorCode(cancellation.stderr),
      'FINALIZE_TRANSACTION_DIVERGED',
    );
    assert.equal(fs.existsSync(transactionPath), true);
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only', '--']).trim(),
      'src/foreign.ts',
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[x\] 1\.1/,
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      /None — all tasks are complete\./,
    );
    const archived = JSON.parse(
      fs.readFileSync(
        cancellationRecordPath(repository, transaction.transactionId),
        'utf8',
      ),
    ) as { phase: string };
    assert.equal(archived.phase, 'requested');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize cancellation rejects an oversized reason before publishing authority', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    assert.throws(
      () =>
        finalizeSession(
          repository,
          sessionId,
          'Complete recovered task',
          process.env,
          { testCrashAfter: 'checks-running' },
        ),
      /Simulated finalize interruption/,
    );
    const transaction = JSON.parse(
      fs.readFileSync(transactionPath, 'utf8'),
    ) as { transactionId: string };

    const cancellation = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transaction.transactionId,
      '--reason',
      'x'.repeat(1025),
      '--json',
    ]);
    assert.notEqual(cancellation.status, 0);
    assert.equal(
      parseErrorCode(cancellation.stderr),
      'FINALIZE_CANCELLATION_REASON_INVALID',
    );
    assert.equal(fs.existsSync(transactionPath), true);
    assert.equal(
      fs.existsSync(
        cancellationRecordPath(repository, transaction.transactionId),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize cancellation preserves a tampered immutable cancellation record', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    const transactionId = createInterruptedCancellation(
      repository,
      sessionId,
      transactionPath,
      'Review tampered cancellation',
    );
    const recordPath = cancellationRecordPath(repository, transactionId);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      recordPath,
      `${JSON.stringify({ ...record, reason: 'Substituted reason' }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const result = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transactionId,
      '--reason',
      'Review tampered cancellation',
      '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(
      parseErrorCode(result.stderr),
      'FINALIZE_CANCELLATION_INVALID',
    );
    assert.equal(fs.existsSync(transactionPath), true);
    assert.match(fs.readFileSync(recordPath, 'utf8'), /Substituted reason/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize cancellation rejects a hard-linked cancellation record without deleting it', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    const reason = 'Review unsafe cancellation storage';
    const transactionId = createInterruptedCancellation(
      repository,
      sessionId,
      transactionPath,
      reason,
    );
    const recordPath = cancellationRecordPath(repository, transactionId);
    const aliasPath = `${recordPath}.alias`;
    fs.linkSync(recordPath, aliasPath);

    const result = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transactionId,
      '--reason',
      reason,
      '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(
      parseErrorCode(result.stderr),
      'FINALIZE_CANCELLATION_INVALID',
    );
    assert.equal(fs.existsSync(transactionPath), true);
    assert.equal(fs.statSync(recordPath).nlink, 2);
    assert.equal(fs.statSync(aliasPath).nlink, 2);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize cancellation reconciles its exact linked publication residue', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    const reason = 'Recover linked cancellation publication';
    const transactionId = createInterruptedCancellation(
      repository,
      sessionId,
      transactionPath,
      reason,
    );
    const recordPath = cancellationRecordPath(repository, transactionId);
    const preparationPath = cancellationPreparationPath(
      repository,
      transactionId,
    );
    fs.linkSync(recordPath, preparationPath);

    const recovered = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transactionId,
      '--reason',
      reason,
      '--json',
    ]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(parseResult(recovered.stdout).state, 'cancelled');
    assert.equal(fs.existsSync(preparationPath), false);
    assert.equal(fs.statSync(recordPath).nlink, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize cancellation publishes an exact durable preparation after restart', () => {
  const { repository, sessionId, transactionPath } = createRecoveryFixture();
  try {
    const reason = 'Recover prepared cancellation publication';
    const transactionId = createInterruptedCancellation(
      repository,
      sessionId,
      transactionPath,
      reason,
    );
    const recordPath = cancellationRecordPath(repository, transactionId);
    const preparationPath = cancellationPreparationPath(
      repository,
      transactionId,
    );
    const prepared = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      requestedAt: string;
    };
    fs.linkSync(recordPath, preparationPath);
    fs.unlinkSync(recordPath);

    const recovered = runCli(repository, [
      'finalize-recover',
      sessionId,
      '--cancel',
      transactionId,
      '--reason',
      reason,
      '--json',
    ]);
    assert.equal(recovered.status, 0, recovered.stderr);
    const published = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      requestedAt: string;
    };
    assert.equal(published.requestedAt, prepared.requestedAt);
    assert.equal(fs.existsSync(preparationPath), false);
    assert.equal(fs.statSync(recordPath).nlink, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createRecoveryFixture(): {
  repository: string;
  sessionId: string;
  transactionPath: string;
  counterPath: string;
} {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'finalize-recovery-count');
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  renderHandoff(repository);
  fs.writeFileSync(
    path.join(repository, 'scripts/count-recovery.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-recovery.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
  git(repository, ['checkout', '-b', 'work/demo-change']);
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  return {
    repository,
    sessionId: session.sessionId,
    counterPath,
    transactionPath: path.join(
      runtimeRoot(repository),
      'finalize-transactions',
      `${session.sessionId}.json`,
    ),
  };
}

function createInterruptedCancellation(
  repository: string,
  sessionId: string,
  transactionPath: string,
  reason: string,
): string {
  assert.throws(
    () =>
      finalizeSession(
        repository,
        sessionId,
        'Complete recovered task',
        process.env,
        { testCrashAfter: 'checks-running' },
      ),
    /Simulated finalize interruption/,
  );
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8')) as {
    transactionId: string;
  };
  assert.throws(
    () =>
      cancelFinalizeRecovery(
        repository,
        sessionId,
        transaction.transactionId,
        reason,
        { testCrashAfter: 'cancellation-requested' },
      ),
    /Simulated finalize cancellation/,
  );
  return transaction.transactionId;
}

function cancellationRecordPath(
  repository: string,
  transactionId: string,
): string {
  return path.join(
    runtimeRoot(repository),
    'finalize-transaction-history',
    `${transactionId}.json`,
  );
}

function cancellationPreparationPath(
  repository: string,
  transactionId: string,
): string {
  return path.join(
    runtimeRoot(repository),
    'finalize-transaction-history',
    `${transactionId}.prepare.json`,
  );
}

function runCli(
  repository: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../src/cli.ts'),
      ...args,
    ],
    { cwd: repository, encoding: 'utf8' },
  );
}

function parseResult(stdout: string): {
  state: string;
  sessionId: string;
  transactionId: string;
  reason: string;
  cancelledAt: string;
} {
  return (JSON.parse(stdout) as { result: ReturnType<typeof parseResult> })
    .result;
}

function parseErrorCode(stderr: string): string {
  return (JSON.parse(stderr) as { error: { code: string } }).error.code;
}
