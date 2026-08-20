import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  type GitState,
} from '../runtime/repository-transaction/git.ts';
import {
  loadValidatedChangeContract,
  type ValidatedChangeContract,
} from '../adapters/planning/openspec/documents/managed-change-contract.ts';
import { planningProviderBindingReader } from '../runtime/repository-transaction/planning-provider-binding-store.ts';

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
    planningProviderBindingReader,
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
