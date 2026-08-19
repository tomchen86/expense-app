import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import { finalizeTask } from '../src/application/finalize/lifecycle.ts';
import {
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
} from './fixture.ts';

type CrashPhase =
  | 'projection-prepared'
  | 'task-projected'
  | 'projection-applied'
  | 'candidate-prepared'
  | 'checks-running'
  | 'checks-executed'
  | 'checked'
  | 'staged'
  | 'reports-persisted'
  | 'session-finished';
type CrashableFinalize = (
  cwd: string,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
  options: { testCrashAfter: CrashPhase },
) => unknown;

for (const phase of [
  'projection-prepared',
  'task-projected',
  'projection-applied',
  'candidate-prepared',
  'checked',
  'staged',
  'reports-persisted',
  'session-finished',
] as const) {
  test(`projected finalize recovers the exact ${phase} interruption without repeating passed checks`, () => {
    const { repository, counterPath, sessionId, transactionPath } =
      createFinalizeFixture();
    try {
      assert.throws(
        () =>
          (finalizeTask as CrashableFinalize)(
            repository,
            sessionId,
            process.env,
            { testCrashAfter: phase },
          ),
        /Simulated finalize interruption/,
      );
      assert.equal(
        fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0',
        [
          'projection-prepared',
          'task-projected',
          'projection-applied',
          'candidate-prepared',
        ].includes(phase)
          ? '0'
          : '1',
      );

      const recovered = finalizeTask(repository, sessionId);
      assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
      assert.equal(recovered.tree, git(repository, ['write-tree']).trim());
      assert.match(
        getSession(repository, sessionId).finishReportId ?? '',
        /^[0-9a-f]{64}$/,
      );
      const transaction = JSON.parse(
        fs.readFileSync(transactionPath, 'utf8'),
      ) as { phase: string; candidateTree: string };
      assert.equal(transaction.phase, 'completed');
      assert.equal(transaction.candidateTree, recovered.tree);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('projected finalize rejects a changed checked candidate without reusing its evidence', () => {
  const { repository, counterPath, sessionId, transactionPath } =
    createFinalizeFixture();
  try {
    crashFinalize(repository, sessionId, 'checked');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const changedAfterCheck = true;\n',
    );

    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('FINALIZE_TRANSACTION_DIVERGED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(fs.existsSync(transactionPath), false);
    assert.equal(
      fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
      'export const changedAfterCheck = true;\n',
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[ \] 1\.1/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('projected finalize rejects projection-base drift and restores only its owned partial projection', () => {
  const { repository, counterPath, sessionId, transactionPath } =
    createFinalizeFixture();
  try {
    crashFinalize(repository, sessionId, 'projection-applied');
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
      /None — no active change\./,
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const changedDuringRecovery = true;\n',
    );

    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('FINALIZE_TRANSACTION_DIVERGED'),
    );
    assert.equal(fs.existsSync(counterPath), false);
    assert.equal(fs.existsSync(transactionPath), false);
    assert.equal(
      fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
      'export const changedDuringRecovery = true;\n',
    );
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
      /None — no active change\./,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const [phase, expectedCount] of [
  ['checks-running', '0'],
  ['checks-executed', '1'],
] as const) {
  test(`projected finalize preserves ambiguous ${phase} evidence instead of rerunning checks`, () => {
    const { repository, counterPath, sessionId, transactionPath } =
      createFinalizeFixture();
    try {
      crashFinalize(repository, sessionId, phase);
      assert.equal(
        fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0',
        expectedCount,
      );

      assert.throws(
        () => finalizeTask(repository, sessionId),
        hasCode('FINALIZE_RECOVERY_REQUIRED'),
      );
      assert.equal(
        fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0',
        expectedCount,
      );
      assert.equal(readTransaction(transactionPath).phase, 'checks-running');
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('projected finalize preserves a foreign staged index and its recovery transaction', () => {
  const { repository, counterPath, sessionId, transactionPath } =
    createFinalizeFixture();
  try {
    crashFinalize(repository, sessionId, 'staged');
    fs.writeFileSync(path.join(repository, 'src/foreign.ts'), 'export {};\n');
    git(repository, ['add', 'src/foreign.ts']);

    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('FINALIZE_TRANSACTION_DIVERGED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(readTransaction(transactionPath).phase, 'staged');
    assert.deepEqual(
      git(repository, ['diff', '--cached', '--name-only', '--'])
        .trim()
        .split('\n')
        .sort(),
      [
        'docs/CURRENT_AND_NEXT_STEPS.md',
        'openspec/changes/demo-change/tasks.md',
        'src/feature.ts',
        'src/foreign.ts',
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('projected finalize rejects a corrupted immutable check report and rolls back its owned projection', () => {
  const { repository, counterPath, sessionId, transactionPath } =
    createFinalizeFixture();
  try {
    crashFinalize(repository, sessionId, 'checked');
    const transaction = readTransaction(transactionPath);
    assert.match(transaction.checkReportId ?? '', /^[0-9a-f]{64}$/);
    const reportPath = path.join(
      runtimeRoot(repository),
      'reports',
      sessionId,
      `${transaction.checkReportId}.json`,
    );
    fs.appendFileSync(reportPath, ' ');

    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('REPORT_DIGEST_MISMATCH'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(fs.existsSync(transactionPath), false);
    assert.match(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[ \] 1\.1/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('projected finalize preserves a transaction whose immutable identity was tampered', () => {
  const { repository, counterPath, sessionId, transactionPath } =
    createFinalizeFixture();
  try {
    crashFinalize(repository, sessionId, 'candidate-prepared');
    const transaction = readTransaction(transactionPath);
    fs.writeFileSync(
      transactionPath,
      `${JSON.stringify({ ...transaction, candidateTree: '0'.repeat(40) }, null, 2)}\n`,
      { mode: 0o600 },
    );

    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('FINALIZE_TRANSACTION_INVALID'),
    );
    assert.equal(fs.existsSync(counterPath), false);
    assert.equal(fs.existsSync(transactionPath), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('projected finalize rejects a phase-field transaction substitution before reading reports', () => {
  const { repository, sessionId, transactionPath } = createFinalizeFixture();
  try {
    crashFinalize(repository, sessionId, 'checked');
    const transaction = readTransaction(transactionPath);
    fs.writeFileSync(
      transactionPath,
      `${JSON.stringify({ ...transaction, checkReportId: '0'.repeat(64) }, null, 2)}\n`,
      { mode: 0o600 },
    );

    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('FINALIZE_TRANSACTION_INVALID'),
    );
    assert.equal(fs.existsSync(transactionPath), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createFinalizeFixture(): {
  repository: string;
  counterPath: string;
  sessionId: string;
  transactionPath: string;
} {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'finalize-count');
  enableCompletionHandoff(repository);
  fs.writeFileSync(
    path.join(repository, 'scripts/count-finalize.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      "const handoff = fs.readFileSync('docs/CURRENT_AND_NEXT_STEPS.md', 'utf8');",
      "if (!handoff.includes('None — no active change.')) process.exit(18);",
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-finalize.mjs', counterPath],
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
    counterPath,
    sessionId: session.sessionId,
    transactionPath: path.join(
      runtimeRoot(repository),
      'finalize-transactions',
      `${session.sessionId}.json`,
    ),
  };
}

function enableCompletionHandoff(repository: string): void {
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
}

function crashFinalize(
  repository: string,
  sessionId: string,
  phase: CrashPhase,
): void {
  assert.throws(
    () =>
      (finalizeTask as CrashableFinalize)(repository, sessionId, process.env, {
        testCrashAfter: phase,
      }),
    /Simulated finalize interruption/,
  );
}

function readTransaction(transactionPath: string): {
  phase: string;
  checkReportId: string | null;
  candidateTree: string;
} {
  return JSON.parse(fs.readFileSync(transactionPath, 'utf8')) as {
    phase: string;
    checkReportId: string | null;
    candidateTree: string;
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === code;
}
