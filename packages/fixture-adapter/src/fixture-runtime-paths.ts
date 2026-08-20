import {
  RepositoryBoundaryError,
  assertChangeId,
  assertPolicyPathInsideRepository,
  investigationRuntimePaths,
  type InvestigationRuntimePaths,
} from '@jigwright/core/runtime-path-kernel';
import { RepositoryPathError } from '@jigwright/core/repository-path';

export type FixtureRuntimePathErrorCode =
  | 'FIXTURE_CHANGE_ID_INVALID'
  | 'FIXTURE_INVALID_POLICY_PATH'
  | 'FIXTURE_PATH_ESCAPES_REPOSITORY'
  | 'FIXTURE_SYMLINK_POLICY_PATH';

export class FixtureRuntimePathError extends TypeError {
  readonly code: FixtureRuntimePathErrorCode;

  constructor(code: FixtureRuntimePathErrorCode, message: string) {
    super(message);
    this.name = 'FixtureRuntimePathError';
    this.code = code;
  }
}

export function fixtureInvestigationRuntimePaths(
  gitCommonDirectory: string,
): InvestigationRuntimePaths {
  return investigationRuntimePaths(gitCommonDirectory, 'fixture-runtime-v1');
}

export function assertFixtureChangeId(value: string): string {
  return assertChangeId(
    value,
    () =>
      new FixtureRuntimePathError(
        'FIXTURE_CHANGE_ID_INVALID',
        `Fixture change ID is invalid: ${value}`,
      ),
  );
}

export function assertFixturePolicyPathInsideRepository(
  repositoryRoot: string,
  policyPath: string,
): void {
  try {
    assertPolicyPathInsideRepository(repositoryRoot, policyPath);
  } catch (error) {
    if (error instanceof RepositoryPathError) {
      throw new FixtureRuntimePathError(
        'FIXTURE_INVALID_POLICY_PATH',
        `Fixture policy path is invalid: ${policyPath}`,
      );
    }
    if (error instanceof RepositoryBoundaryError) {
      throw new FixtureRuntimePathError(
        error.code === 'PATH_ESCAPES_REPOSITORY'
          ? 'FIXTURE_PATH_ESCAPES_REPOSITORY'
          : 'FIXTURE_SYMLINK_POLICY_PATH',
        error.message,
      );
    }
    throw error;
  }
}
