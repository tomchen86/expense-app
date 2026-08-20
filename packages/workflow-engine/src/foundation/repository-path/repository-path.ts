import {
  RepositoryPathError,
  matchesAllowedPath as matchesCoreAllowedPath,
  normalizeChangedPath as normalizeCoreChangedPath,
  normalizeExactRepositoryPath as normalizeCoreExactRepositoryPath,
  normalizePolicyPath as normalizeCorePolicyPath,
} from '@jigwright/core/repository-path';

import { ExitCode, workflowError } from '../errors/errors.ts';

export function normalizePolicyPath(value: string): string {
  return withWorkflowPathErrors(() => normalizeCorePolicyPath(value));
}

export function normalizeChangedPath(value: string): string {
  return withWorkflowPathErrors(() => normalizeCoreChangedPath(value));
}

export function normalizeExactRepositoryPath(value: string): string {
  return withWorkflowPathErrors(() => normalizeCoreExactRepositoryPath(value));
}

export function matchesAllowedPath(
  changedPath: string,
  allowedPath: string,
): boolean {
  return withWorkflowPathErrors(() =>
    matchesCoreAllowedPath(changedPath, allowedPath),
  );
}

function withWorkflowPathErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof RepositoryPathError)) throw error;
    throw error.code === 'INVALID_POLICY_PATH'
      ? invalidPolicyPath(error.value)
      : invalidRepositoryPath(error.value);
  }
}

function invalidPolicyPath(value: string): ReturnType<typeof workflowError> {
  return workflowError(
    'INVALID_POLICY_PATH',
    `Invalid policy path: ${value}`,
    ExitCode.guard,
    {
      details: { path: value },
      recovery:
        'Use a repository-relative exact path or a directory prefix ending in /**.',
    },
  );
}

function invalidRepositoryPath(
  value: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'INVALID_REPOSITORY_PATH',
    `Invalid repository path reported by Git: ${value}`,
    ExitCode.guard,
    { details: { path: value } },
  );
}
