import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

const CANONICAL_GITHUB_ORIGIN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/;
const AUTHORITY_TAG_REF =
  /^refs\/tags\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type AuthorityAttestCommandBinding = {
  originalCommit: string;
  mainCommit: string;
  grantBasePairs: Array<{ originalBase: string; mainBase: string }>;
};

export function authorityTagPublishCommand(
  repositoryOrigin: string,
  tagRef: string,
): string {
  const origin = CANONICAL_GITHUB_ORIGIN.exec(repositoryOrigin);
  if (!origin || !AUTHORITY_TAG_REF.test(tagRef)) {
    throw invalidAuthorityRelayCommand();
  }
  const [, owner, repository] = origin;
  return `git push git@github.com:${owner}/${repository}.git ${tagRef}:${tagRef}`;
}

export function authorityAttestationRelayProjectionCommand(
  originalCommit: string,
): string {
  assertCommitOid(originalCommit);
  return `pnpm workflow maintainer attestation-relay --original ${originalCommit} --json`;
}

export function authorityAttestCommand(
  binding: AuthorityAttestCommandBinding,
): string {
  assertCommitOid(binding.originalCommit);
  assertCommitOid(binding.mainCommit);
  if (
    binding.originalCommit === binding.mainCommit ||
    !Array.isArray(binding.grantBasePairs) ||
    binding.grantBasePairs.length > 64
  ) {
    throw invalidAuthorityRelayCommand();
  }
  const pairs = binding.grantBasePairs.map((pair) => {
    assertCommitOid(pair.originalBase);
    assertCommitOid(pair.mainBase);
    if (pair.originalBase === pair.mainBase) {
      throw invalidAuthorityRelayCommand();
    }
    return { ...pair };
  });
  const sortedPairs = [...pairs].sort((left, right) =>
    left.originalBase < right.originalBase ? -1 : 1,
  );
  if (
    new Set(sortedPairs.map(({ originalBase }) => originalBase)).size !==
      sortedPairs.length ||
    new Set(sortedPairs.map(({ mainBase }) => mainBase)).size !==
      sortedPairs.length
  ) {
    throw invalidAuthorityRelayCommand();
  }
  const baseArguments = sortedPairs.flatMap(({ originalBase, mainBase }) => [
    '--base',
    `${originalBase}=${mainBase}`,
  ]);
  return [
    'pnpm',
    'workflow',
    'maintainer',
    'attest',
    '--original',
    binding.originalCommit,
    '--main',
    binding.mainCommit,
    ...baseArguments,
    '--json',
  ].join(' ');
}

function assertCommitOid(value: string): void {
  if (typeof value !== 'string' || !COMMIT_OID.test(value)) {
    throw invalidAuthorityRelayCommand();
  }
}

function invalidAuthorityRelayCommand() {
  return workflowError(
    'AUTHORITY_RELAY_COMMAND_INVALID',
    'Authority relay commands require a canonical GitHub repository origin and authority tag ref.',
    ExitCode.guard,
  );
}
