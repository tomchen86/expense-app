import { spawnSync } from 'node:child_process';

import type { CheckDefinition } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  resolveCheckRunner,
  type ResolvedCheckRunner,
} from './runner-resolution.ts';

export type CheckEvidence = {
  checkId: string;
  outcome: 'passed';
  exitCode: 0;
  runner: string;
  runnerDigest: string;
  destructiveDatabase: boolean;
  databaseIdentity?: string;
};

export type PinnedCheckRunner = Readonly<ResolvedCheckRunner>;

export function pinCheckRunner(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
): PinnedCheckRunner {
  return resolveCheckRunner(repositoryRoot, checkId, definition);
}

export function runCheck(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
  pinnedRunner: PinnedCheckRunner,
  environment: NodeJS.ProcessEnv,
  databaseIdentity?: string,
): CheckEvidence {
  const resolved = resolveCheckRunner(repositoryRoot, checkId, definition);
  assertRunnerUnchanged(checkId, pinnedRunner, resolved);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(resolved.executable, resolved.args, {
      cwd: repositoryRoot,
      shell: false,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw executionFailure(checkId, error);
  }

  if (result.error) {
    throw executionFailure(checkId, result.error);
  }

  if (result.status !== 0) {
    throw workflowError(
      result.signal ? 'CHECK_TERMINATED' : 'CHECK_FAILED',
      result.signal
        ? `Required check ${checkId} was terminated by a signal.`
        : `Required check ${checkId} exited non-zero.`,
      ExitCode.verification,
      {
        details: {
          checkId,
          exitCode: result.status,
          signal: result.signal,
        },
      },
    );
  }

  const resolvedAfter = resolveCheckRunner(repositoryRoot, checkId, definition);
  assertRunnerUnchanged(checkId, pinnedRunner, resolvedAfter);

  return {
    checkId,
    outcome: 'passed',
    exitCode: 0,
    runner: resolved.runner,
    runnerDigest: resolved.digest,
    destructiveDatabase: definition.destructiveDatabase,
    ...(definition.destructiveDatabase && databaseIdentity
      ? { databaseIdentity }
      : {}),
  };
}

function assertRunnerUnchanged(
  checkId: string,
  expected: PinnedCheckRunner,
  actual: ResolvedCheckRunner,
): void {
  if (
    actual.runner !== expected.runner ||
    actual.executable !== expected.executable ||
    actual.digest !== expected.digest ||
    JSON.stringify(actual.args) !== JSON.stringify(expected.args)
  ) {
    throw workflowError(
      'CHECK_RUNNER_CHANGED',
      `Required check ${checkId} changed its resolved runner during verification.`,
      ExitCode.staleState,
      { details: { checkId } },
    );
  }
}

function executionFailure(checkId: string, error: unknown) {
  return workflowError(
    'CHECK_EXECUTION_FAILED',
    `Required check ${checkId} could not be executed.`,
    ExitCode.verification,
    {
      details: {
        checkId,
        errorCode:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'UNKNOWN',
      },
    },
  );
}
