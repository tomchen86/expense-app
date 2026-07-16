import type { CheckEvidence } from './check-runner.ts';
import { runCiChecks } from './ci-checks.ts';
import { loadChecksConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';

export type RegisteredCheckResult = {
  head: string;
  check: CheckEvidence;
};

export function runRegisteredCheck(
  cwd: string,
  checkId: string,
  environment: NodeJS.ProcessEnv,
): RegisteredCheckResult {
  const repository = discoverRepository(cwd);
  if (repository.statusEntries.length > 0) {
    throw workflowError(
      'STANDALONE_CHECK_DIRTY_WORKTREE',
      'Standalone registered checks require a clean checkout.',
      ExitCode.staleState,
      {
        details: { statusEntryCount: repository.statusEntries.length },
        recovery:
          'Commit or remove controlled checkout changes before running the registered check.',
      },
    );
  }

  const checks = loadChecksConfig(repository.repositoryRoot).checks;
  if (!Object.hasOwn(checks, checkId)) {
    throw workflowError(
      'CI_CHECK_UNKNOWN',
      `Check registry does not contain ${checkId}.`,
      ExitCode.guard,
      { details: { checkId } },
    );
  }
  const definition = checks[checkId]!;
  if (definition.destructiveDatabase) {
    throw workflowError(
      'STANDALONE_DESTRUCTIVE_CHECK',
      `Standalone execution refuses destructive check ${checkId}.`,
      ExitCode.unsafeEnvironment,
      {
        details: { checkId },
        recovery:
          'Run destructive checks only through an authorized managed task with explicit disposable database evidence.',
      },
    );
  }

  const evidence = runCiChecks(
    repository.repositoryRoot,
    repository.head,
    [checkId],
    environment,
  );
  return { head: repository.head, check: evidence[0]! };
}
