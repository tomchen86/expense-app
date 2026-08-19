import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import { withChangeTransitionAuthority } from '../src/runtime/session-workspace/planning-lock.ts';
import { assertCompletionTaskIds } from '../src/runtime/storage-journal/report-validation.ts';
import {
  readImmutableReport,
  writeImmutableReport,
  type WorkflowReport,
} from '../src/runtime/storage-journal/report-store.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../src/runtime/session-workspace/session-store.ts';
import { createFixtureRepository } from './fixture.ts';

const SESSION_ID = 'session-report-boundary-hardening';

test('report writes reject a symlinked root before creating outside it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-root-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'report-outside-'));
  const reportsRoot = path.join(root, 'reports');
  try {
    fs.symlinkSync(outside, reportsRoot, 'dir');

    assert.throws(
      () => writeImmutableReport(reportsRoot, report()),
      (error) => isWorkflowError(error, 'REPORT_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(path.join(outside, SESSION_ID)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('report writes and reads reject a symlinked ancestor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-ancestor-'));
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-outside-')),
  );
  const alias = path.join(root, 'alias');
  const reportsRoot = path.join(alias, 'reports');
  try {
    fs.symlinkSync(outside, alias, 'dir');

    assert.throws(
      () => writeImmutableReport(reportsRoot, report()),
      (error) => isWorkflowError(error, 'REPORT_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(path.join(outside, 'reports')), false);

    const canonicalReports = path.join(outside, 'reports');
    const reportId = writeImmutableReport(canonicalReports, report());
    assert.throws(
      () => readImmutableReport(reportsRoot, SESSION_ID, reportId),
      (error) => isWorkflowError(error, 'REPORT_DIRECTORY_UNSAFE'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('report writes and reads reject a symlinked report file', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-file-link-')),
  );
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-outside-')),
  );
  const reportsRoot = path.join(root, 'reports');
  try {
    const reportId = writeImmutableReport(outside, report());
    const outsideReport = path.join(outside, SESSION_ID, `${reportId}.json`);
    const sessionDirectory = path.join(reportsRoot, SESSION_ID);
    fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      outsideReport,
      path.join(sessionDirectory, `${reportId}.json`),
    );

    assert.throws(
      () => writeImmutableReport(reportsRoot, report()),
      (error) => isWorkflowError(error, 'REPORT_FILE_UNSAFE'),
    );
    assert.throws(
      () => readImmutableReport(reportsRoot, SESSION_ID, reportId),
      (error) => isWorkflowError(error, 'REPORT_FILE_UNSAFE'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('repository lifecycle cleanup preserves operation and release failures', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'repository-lock-errors-')),
  );
  const runtime = runtimePaths(root, 'workflow-engine');
  const operationError = new Error('sentinel repository operation failure');
  try {
    assert.throws(
      () =>
        withRepositoryLifecycleOperation(runtime, () => {
          fs.unlinkSync(
            path.join(runtime.operations, 'repository-lifecycle.lock'),
          );
          throw operationError;
        }),
      (error) =>
        aggregateContains(
          error,
          operationError,
          'REPOSITORY_LIFECYCLE_LOCK_INVALID',
        ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('change lifecycle cleanup preserves operation and release failures', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'change-lock-errors-')),
  );
  const runtime = runtimePaths(root, 'workflow-engine');
  const operationError = new Error('sentinel change operation failure');
  try {
    assert.throws(
      () =>
        withChangeTransitionAuthority(runtime, 'demo-change', 'plan', () => {
          fs.unlinkSync(path.join(runtime.locks, 'demo-change.lock'));
          throw operationError;
        }),
      (error) =>
        aggregateContains(error, operationError, 'PLANNING_LOCK_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the global JSON flag is accepted once at the terminal argv position', () => {
  const repository = createFixtureRepository();
  try {
    assert.equal(runCli(['status', '--json'], repository), 0);
    assert.equal(
      runCli(['status', '--json', '--json'], repository),
      ExitCode.usage,
    );
    assert.equal(
      runCli(
        ['propose', 'demo-change', '--resume', '--input', '--json'],
        repository,
      ),
      ExitCode.usage,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a terminal JSON-looking option value is not consumed as output mode', () => {
  const repository = createFixtureRepository();
  try {
    assert.equal(
      runCli(
        ['authority-abort', 'session-does-not-exist', '--reason', '--json'],
        repository,
      ),
      ExitCode.staleState,
    );
    assert.equal(
      runCli(
        [
          'authority-abort',
          'session-does-not-exist',
          '--reason',
          '--json',
          '--json',
        ],
        repository,
      ),
      ExitCode.staleState,
    );
    for (const trailingOutputFlag of [false, true]) {
      assert.equal(
        runCli(
          [
            'document-refresh',
            'review',
            '--proposal',
            '0'.repeat(64),
            '--decision',
            'approve',
            '--reviewer',
            '--json',
            ...(trailingOutputFlag ? ['--json'] : []),
          ],
          repository,
        ),
        ExitCode.staleState,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion report validation rejects a task absent from the baseline', () => {
  const completionReport = {
    ...report(),
    completedTaskIds: ['9.9'],
  };
  assert.throws(
    () =>
      assertCompletionTaskIds(
        completionReport,
        {
          baselineTasks: '# Tasks\n\n- [ ] 1.1 Existing task\n',
          session: { taskId: '9.9' },
        } as never,
        'REPORT_TASK_SCOPE_STALE',
      ),
    (error) => isWorkflowError(error, 'REPORT_TASK_SCOPE_STALE'),
  );
});

function report(): WorkflowReport {
  return {
    schemaVersion: 1,
    kind: 'check',
    sessionId: SESSION_ID,
    changeId: 'demo-change',
    taskId: '1.1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function aggregateContains(
  error: unknown,
  operationError: Error,
  releaseCode: string,
): boolean {
  return (
    error instanceof AggregateError &&
    error.errors.includes(operationError) &&
    error.errors.some(
      (nested) =>
        nested instanceof WorkflowError && nested.code === releaseCode,
    )
  );
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
