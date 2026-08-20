import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  assertPolicyPathInsideRepository,
  assertSessionId,
  assertTaskId,
  investigationRuntimePaths,
} from '../src/runtime/session-workspace/paths.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('runtime path kernel is public and module consumers no longer depend on session runtime', () => {
  const coreManifest = readJson('packages/core/package.json') as {
    exports?: Record<string, string>;
  };
  const fixtureManifest = readJson('packages/fixture-adapter/package.json') as {
    exports?: Record<string, string>;
  };
  assert.equal(
    coreManifest.exports?.['./runtime-path-kernel'],
    './src/runtime-path-kernel.ts',
  );
  assert.equal(
    fixtureManifest.exports?.['./runtime-paths'],
    './src/fixture-runtime-paths.ts',
  );

  const facade = readSource(
    'packages/workflow-engine/src/runtime/session-workspace/paths.ts',
  );
  assert.match(facade, /@jigwright\/core\/runtime-path-kernel/);
  assert.doesNotMatch(
    facade,
    /CHANGE_ID_PATTERN|TASK_ID_PATTERN|SESSION_ID_PATTERN|INVESTIGATION_ID_PATTERN|INVOCATION_ID_PATTERN/,
  );
  assert.doesNotMatch(facade, /from 'node:(?:fs|path)'/);

  for (const file of [
    'packages/workflow-engine/src/modules/assurance/planning-shadow-metrics.ts',
    'packages/workflow-engine/src/modules/provider-orchestration/provider-retry-decision.ts',
  ]) {
    const source = readSource(file);
    assert.match(source, /@jigwright\/core\/runtime-path-kernel/, file);
    assert.doesNotMatch(source, /runtime\/session-workspace\/paths\.ts/, file);
  }

  const mixedConsumer = readSource(
    'packages/workflow-engine/src/modules/assurance/task-strategy-gate.ts',
  );
  assert.match(mixedConsumer, /@jigwright\/core\/runtime-path-kernel/);
  assert.match(mixedConsumer, /runtime\/session-workspace\/paths\.ts/);
  assert.doesNotMatch(
    mixedConsumer,
    /import\s*\{[^}]*investigationRuntimePaths[^}]*\}\s*from\s*['"][^'"]*runtime\/session-workspace\/paths\.ts['"]/s,
  );
});

test('workflow facade preserves exact identifier errors', () => {
  const cases: ReadonlyArray<
    readonly [() => unknown, string, string, number, string | undefined]
  > = [
    [
      () => assertChangeId('Demo-change'),
      'INVALID_CHANGE_ID',
      'Invalid change ID: Demo-change',
      ExitCode.usage,
      'Use lower-case kebab-case, for example add-expense-export.',
    ],
    [
      () => assertTaskId('1'),
      'INVALID_TASK_ID',
      'Invalid task ID: 1',
      ExitCode.usage,
      'Use a dotted numeric task ID, for example 1.1.',
    ],
    [
      () => assertSessionId('session_1'),
      'INVALID_SESSION_ID',
      'Invalid session ID: session_1',
      ExitCode.usage,
      undefined,
    ],
    [
      () => assertInvestigationId('investigation_1'),
      'INVALID_INVESTIGATION_ID',
      'Invalid investigation ID: investigation_1',
      ExitCode.usage,
      undefined,
    ],
    [
      () => assertInvocationId('invocation_1'),
      'INVALID_INVOCATION_ID',
      'Invalid provider invocation ID: invocation_1',
      ExitCode.usage,
      undefined,
    ],
  ];

  for (const [operation, code, message, exitCode, recovery] of cases) {
    assert.throws(operation, (error) => {
      assert.equal(error instanceof WorkflowError, true);
      const workflow = error as WorkflowError;
      assert.equal(workflow.code, code);
      assert.equal(workflow.message, message);
      assert.equal(workflow.exitCode, exitCode);
      assert.equal(workflow.recovery, recovery);
      assert.equal(workflow.details, undefined);
      return true;
    });
  }
});

test('workflow facade preserves exact repository-boundary errors and layout bytes', () => {
  const container = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'workflow-runtime-paths-'),
  );
  const repository = path.join(container, 'repository');
  const outside = path.join(container, 'outside');
  fs.mkdirSync(repository);
  fs.mkdirSync(path.join(repository, 'source'));
  fs.mkdirSync(outside);
  try {
    const paths = investigationRuntimePaths(repository, 'workflow-engine');
    assert.equal(paths.base, fs.realpathSync(repository));
    assert.equal(
      paths.root,
      path.join(
        fs.realpathSync(repository),
        'workflow-engine',
        'investigations',
      ),
    );

    assert.throws(
      () => assertPolicyPathInsideRepository(repository, '../escape'),
      (error) => {
        assertWorkflowError(error, {
          code: 'INVALID_POLICY_PATH',
          message: 'Invalid policy path: ../escape',
          exitCode: ExitCode.guard,
          details: { path: '../escape' },
          recovery:
            'Use a repository-relative exact path or a directory prefix ending in /**.',
        });
        return true;
      },
    );

    fs.symlinkSync(outside, path.join(repository, 'escape'));
    assert.throws(
      () => assertPolicyPathInsideRepository(repository, 'escape/**'),
      (error) => {
        assertWorkflowError(error, {
          code: 'PATH_ESCAPES_REPOSITORY',
          message: 'Policy path escapes the repository: escape/**',
          exitCode: ExitCode.guard,
          details: { policyPath: 'escape/**' },
        });
        return true;
      },
    );

    fs.symlinkSync(
      path.join(repository, 'source'),
      path.join(repository, 'alias'),
    );
    assert.throws(
      () => assertPolicyPathInsideRepository(repository, 'alias/file.ts'),
      (error) => {
        assertWorkflowError(error, {
          code: 'SYMLINK_POLICY_PATH',
          message: 'Policy path crosses a symbolic link: alias/file.ts',
          exitCode: ExitCode.guard,
          details: { policyPath: 'alias/file.ts', symlinkPath: 'alias' },
          recovery:
            'Use a direct repository path without symbolic-link aliases.',
        });
        return true;
      },
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

function assertWorkflowError(
  error: unknown,
  expected: Readonly<{
    code: string;
    message: string;
    exitCode: number;
    details?: Record<string, unknown>;
    recovery?: string;
  }>,
): void {
  assert.equal(error instanceof WorkflowError, true);
  const workflow = error as WorkflowError;
  assert.equal(workflow.code, expected.code);
  assert.equal(workflow.message, expected.message);
  assert.equal(workflow.exitCode, expected.exitCode);
  assert.deepEqual(workflow.details, expected.details);
  assert.equal(workflow.recovery, expected.recovery);
}

function readJson(file: string): unknown {
  return JSON.parse(readSource(file)) as unknown;
}

function readSource(file: string): string {
  return fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
}
