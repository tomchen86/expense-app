import { spawnSync } from 'node:child_process';

import type { CheckDefinition } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';

export type CheckEvidence = {
  checkId: string;
  outcome: 'passed';
  exitCode: 0;
  destructiveDatabase: boolean;
  databaseIdentity?: string;
};

export function runCheck(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
  environment: NodeJS.ProcessEnv,
  databaseIdentity?: string,
): CheckEvidence {
  const [executable, ...args] = definition.command;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, args, {
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

  return {
    checkId,
    outcome: 'passed',
    exitCode: 0,
    destructiveDatabase: definition.destructiveDatabase,
    ...(definition.destructiveDatabase && databaseIdentity
      ? { databaseIdentity }
      : {}),
  };
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
