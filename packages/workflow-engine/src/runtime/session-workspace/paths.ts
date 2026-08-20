import {
  RepositoryBoundaryError,
  assertChangeId as assertCoreChangeId,
  assertInvestigationId as assertCoreInvestigationId,
  assertInvocationId as assertCoreInvocationId,
  assertPolicyPathInsideRepository as assertCorePolicyPathInsideRepository,
  assertSessionId as assertCoreSessionId,
  assertTaskId as assertCoreTaskId,
  investigationRuntimePaths,
  type InvestigationRuntimePaths,
} from '@jigwright/core/runtime-path-kernel';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  matchesAllowedPath,
  normalizeChangedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';

export {
  investigationRuntimePaths,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
};
export type { InvestigationRuntimePaths };

export function assertChangeId(value: string): string {
  return assertCoreChangeId(value, () =>
    workflowError(
      'INVALID_CHANGE_ID',
      `Invalid change ID: ${value}`,
      ExitCode.usage,
      {
        recovery: 'Use lower-case kebab-case, for example add-expense-export.',
      },
    ),
  );
}

export function assertTaskId(value: string): string {
  return assertCoreTaskId(value, () =>
    workflowError(
      'INVALID_TASK_ID',
      `Invalid task ID: ${value}`,
      ExitCode.usage,
      { recovery: 'Use a dotted numeric task ID, for example 1.1.' },
    ),
  );
}

export function assertSessionId(value: string): string {
  return assertCoreSessionId(value, () =>
    workflowError(
      'INVALID_SESSION_ID',
      `Invalid session ID: ${value}`,
      ExitCode.usage,
    ),
  );
}

export function assertInvestigationId(value: string): string {
  return assertCoreInvestigationId(value, () =>
    workflowError(
      'INVALID_INVESTIGATION_ID',
      `Invalid investigation ID: ${value}`,
      ExitCode.usage,
    ),
  );
}

export function assertInvocationId(value: string): string {
  return assertCoreInvocationId(value, () =>
    workflowError(
      'INVALID_INVOCATION_ID',
      `Invalid provider invocation ID: ${value}`,
      ExitCode.usage,
    ),
  );
}

export function assertPolicyPathInsideRepository(
  repositoryRoot: string,
  policyPath: string,
): void {
  const normalized = normalizePolicyPath(policyPath);
  try {
    assertCorePolicyPathInsideRepository(repositoryRoot, normalized);
  } catch (error) {
    if (!(error instanceof RepositoryBoundaryError)) throw error;
    if (error.code === 'PATH_ESCAPES_REPOSITORY') {
      throw workflowError(
        'PATH_ESCAPES_REPOSITORY',
        `Policy path escapes the repository: ${policyPath}`,
        ExitCode.guard,
        { details: { policyPath } },
      );
    }
    throw workflowError(
      'SYMLINK_POLICY_PATH',
      `Policy path crosses a symbolic link: ${policyPath}`,
      ExitCode.guard,
      {
        details: { policyPath, symlinkPath: error.symlinkPath },
        recovery: 'Use a direct repository path without symbolic-link aliases.',
      },
    );
  }
}
