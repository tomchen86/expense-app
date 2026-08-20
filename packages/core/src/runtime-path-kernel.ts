import fs from 'node:fs';
import path from 'node:path';

import { normalizePolicyPath } from './repository-path.ts';

const CHANGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_PATTERN = /^\d+(?:\.\d+)+$/;
const SESSION_ID_PATTERN = /^session-[a-zA-Z0-9-]+$/;
const INVESTIGATION_ID_PATTERN = /^investigation-[a-zA-Z0-9-]+$/;
const INVOCATION_ID_PATTERN = /^invocation-[a-zA-Z0-9-]+$/;

export type InvalidRuntimeIdentifierFactory = () => Error;

export type InvestigationRuntimePaths = {
  base: string;
  root: string;
  objects: string;
  refs: string;
  sessions: string;
  invocations: string;
  locks: string;
};

export type RepositoryBoundaryErrorCode =
  'PATH_ESCAPES_REPOSITORY' | 'SYMLINK_POLICY_PATH';

/**
 * A consumer-neutral repository-boundary fact. Presentation, exit status, and
 * recovery policy remain owned by the calling adapter.
 */
export class RepositoryBoundaryError extends Error {
  readonly code: RepositoryBoundaryErrorCode;
  readonly policyPath: string;
  readonly symlinkPath?: string;

  constructor(options: {
    code: RepositoryBoundaryErrorCode;
    policyPath: string;
    symlinkPath?: string;
  }) {
    super(
      options.code === 'PATH_ESCAPES_REPOSITORY'
        ? `Policy path escapes the repository: ${options.policyPath}`
        : `Policy path crosses a symbolic link: ${options.policyPath}`,
    );
    this.name = 'RepositoryBoundaryError';
    this.code = options.code;
    this.policyPath = options.policyPath;
    this.symlinkPath = options.symlinkPath;
  }
}

/**
 * Resolve the investigation runtime layout beneath a canonical Git-common
 * base. This owns path projection only, never storage or session state.
 */
export function investigationRuntimePaths(
  gitCommonDirectory: string,
  runtimeDirectory: string,
): InvestigationRuntimePaths {
  const base = fs.realpathSync(path.resolve(gitCommonDirectory));
  const root = path.join(base, runtimeDirectory, 'investigations');
  return {
    base,
    root,
    objects: path.join(root, 'objects', 'sha256'),
    refs: path.join(root, 'refs'),
    sessions: path.join(root, 'sessions'),
    invocations: path.join(root, 'invocations'),
    locks: path.join(root, 'locks'),
  };
}

export function assertChangeId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, CHANGE_ID_PATTERN, invalid);
}

export function assertTaskId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, TASK_ID_PATTERN, invalid);
}

export function assertSessionId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, SESSION_ID_PATTERN, invalid);
}

export function assertInvestigationId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, INVESTIGATION_ID_PATTERN, invalid);
}

export function assertInvocationId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, INVOCATION_ID_PATTERN, invalid);
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
  assertNoSymlinkSegments(repositoryRealPath, relative, policyPath);
}

function assertIdentifier(
  value: string,
  pattern: RegExp,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  if (!pattern.test(value)) throw invalid();
  return value;
}

function assertNoSymlinkSegments(
  repositoryRoot: string,
  relativePath: string,
  policyPath: string,
): void {
  let currentPath = repositoryRoot;
  for (const segment of relativePath.split('/')) {
    currentPath = path.join(currentPath, segment);
    const stats = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      let resolvedPath: string;
      try {
        resolvedPath = fs.realpathSync(currentPath);
      } catch {
        throw invalidPolicySymlink(repositoryRoot, currentPath, policyPath);
      }
      assertInside(repositoryRoot, resolvedPath, policyPath);
      throw invalidPolicySymlink(repositoryRoot, currentPath, policyPath);
    }
    if (!stats.isDirectory()) return;
  }
}

function assertInside(
  repositoryRoot: string,
  targetPath: string,
  policyPath: string,
): void {
  const relative = path.relative(repositoryRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RepositoryBoundaryError({
      code: 'PATH_ESCAPES_REPOSITORY',
      policyPath,
    });
  }
}

function invalidPolicySymlink(
  repositoryRoot: string,
  symlinkPath: string,
  policyPath: string,
): RepositoryBoundaryError {
  return new RepositoryBoundaryError({
    code: 'SYMLINK_POLICY_PATH',
    policyPath,
    symlinkPath: path.relative(repositoryRoot, symlinkPath),
  });
}
