import { ExitCode, workflowError } from './errors.ts';

const CANONICAL_GITHUB_ORIGIN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/;
const AUTHORITY_TAG_REF =
  /^refs\/tags\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

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

function invalidAuthorityRelayCommand() {
  return workflowError(
    'AUTHORITY_RELAY_COMMAND_INVALID',
    'Authority relay commands require a canonical GitHub repository origin and authority tag ref.',
    ExitCode.guard,
  );
}
