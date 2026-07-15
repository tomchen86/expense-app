import { ExitCode, workflowError } from './errors.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  type GitState,
} from './git.ts';
import {
  loadValidatedChangeContract,
  type ValidatedChangeContract,
} from './managed-change-contract.ts';

export function loadStableValidatedChangeContract(
  initialGit: GitState,
  changeId: string,
): { git: GitState; contract: ValidatedChangeContract } {
  const beforeFingerprint = fingerprintRepositoryProjection(
    initialGit.repositoryRoot,
    initialGit.head,
    initialGit.statusEntries,
  );
  const contract = loadValidatedChangeContract(
    initialGit.repositoryRoot,
    changeId,
  );
  const git = discoverRepository(initialGit.repositoryRoot);
  const afterFingerprint = fingerprintRepositoryProjection(
    git.repositoryRoot,
    git.head,
    git.statusEntries,
  );
  if (
    git.repositoryRealPath !== initialGit.repositoryRealPath ||
    git.gitCommonDirectory !== initialGit.gitCommonDirectory ||
    git.branch !== initialGit.branch ||
    git.head !== initialGit.head ||
    git.tree !== initialGit.tree ||
    afterFingerprint !== beforeFingerprint
  ) {
    throw workflowError(
      'OPENSPEC_MUTATED_REPOSITORY',
      'OpenSpec validation changed the repository projection.',
      ExitCode.staleState,
    );
  }
  return { git, contract };
}
