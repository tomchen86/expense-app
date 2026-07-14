import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

const CHANGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_PATTERN = /^\d+(?:\.\d+)+$/;
const SESSION_ID_PATTERN = /^session-[a-zA-Z0-9-]+$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const UNSUPPORTED_GLOB_PATTERN = /[*?[\]{}!]/;

export function assertChangeId(value: string): string {
  if (!CHANGE_ID_PATTERN.test(value)) {
    throw workflowError(
      'INVALID_CHANGE_ID',
      `Invalid change ID: ${value}`,
      ExitCode.usage,
      {
        recovery: 'Use lower-case kebab-case, for example add-expense-export.',
      },
    );
  }
  return value;
}

export function assertTaskId(value: string): string {
  if (!TASK_ID_PATTERN.test(value)) {
    throw workflowError(
      'INVALID_TASK_ID',
      `Invalid task ID: ${value}`,
      ExitCode.usage,
      { recovery: 'Use a dotted numeric task ID, for example 1.1.' },
    );
  }
  return value;
}

export function assertSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw workflowError(
      'INVALID_SESSION_ID',
      `Invalid session ID: ${value}`,
      ExitCode.usage,
    );
  }
  return value;
}

export function normalizePolicyPath(value: string): string {
  if (!value || value.trim() !== value || value.includes('\\')) {
    throw invalidPolicyPath(value);
  }

  const isPrefix = value.endsWith('/**');
  const candidate = isPrefix ? value.slice(0, -3) : value;

  if (
    !candidate ||
    path.posix.isAbsolute(candidate) ||
    WINDOWS_ABSOLUTE_PATTERN.test(candidate) ||
    candidate.startsWith('./') ||
    candidate.endsWith('/') ||
    UNSUPPORTED_GLOB_PATTERN.test(candidate)
  ) {
    throw invalidPolicyPath(value);
  }

  const segments = candidate.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw invalidPolicyPath(value);
  }

  return isPrefix ? `${candidate}/**` : candidate;
}

export function normalizeChangedPath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATTERN.test(value) ||
    value.startsWith('./') ||
    value.endsWith('/')
  ) {
    throw invalidRepositoryPath(value);
  }

  const segments = value.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw invalidRepositoryPath(value);
  }

  return value;
}

export function matchesAllowedPath(
  changedPath: string,
  allowedPath: string,
): boolean {
  const changed = normalizeChangedPath(changedPath);
  const allowed = normalizePolicyPath(allowedPath);

  if (!allowed.endsWith('/**')) {
    return changed === allowed;
  }

  const base = allowed.slice(0, -3);
  return changed === base || changed.startsWith(`${base}/`);
}

export function assertPolicyPathInsideRepository(
  repositoryRoot: string,
  policyPath: string,
): void {
  const normalized = normalizePolicyPath(policyPath);
  const relative = normalized.endsWith('/**')
    ? normalized.slice(0, -3)
    : normalized;
  const repositoryRealPath = fs.realpathSync(repositoryRoot);
  const targetPath = path.resolve(repositoryRealPath, relative);

  assertInside(repositoryRealPath, targetPath, policyPath);

  let existingPath = targetPath;
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      break;
    }
    existingPath = parent;
  }

  const existingRealPath = fs.realpathSync(existingPath);
  assertInside(repositoryRealPath, existingRealPath, policyPath);
}

function assertInside(
  repositoryRoot: string,
  targetPath: string,
  policyPath: string,
): void {
  const relative = path.relative(repositoryRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw workflowError(
      'PATH_ESCAPES_REPOSITORY',
      `Policy path escapes the repository: ${policyPath}`,
      ExitCode.guard,
      { details: { policyPath } },
    );
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
