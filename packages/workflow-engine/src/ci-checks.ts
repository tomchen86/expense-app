import {
  pinCheckRunner,
  runCheck,
  type CheckEvidence,
} from './check-runner.ts';
import { loadChecksConfig } from './contracts.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from './database-policy.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, fingerprintWorkingState } from './git.ts';
import { validateRepositoryState } from './repository-validation.ts';

export function runCiChecks(
  repositoryRoot: string,
  head: string,
  checkIds: string[],
  environment: NodeJS.ProcessEnv,
): CheckEvidence[] {
  const checksConfig = loadChecksConfig(repositoryRoot);
  const required = checkIds.map((checkId) => {
    const definition = checksConfig.checks[checkId];
    if (!definition) {
      throw workflowError(
        'CI_CHECK_UNKNOWN',
        `CI task policy references unknown check ${checkId}.`,
        ExitCode.guard,
      );
    }
    return { checkId, definition };
  });
  const database = required.some(
    ({ definition }) => definition.destructiveDatabase,
  )
    ? assertDisposableDatabase(environment)
    : undefined;
  const pinned = required.map(({ checkId, definition }) => ({
    checkId,
    definition,
    runner: pinCheckRunner(repositoryRoot, checkId, definition),
  }));
  const initial = discoverRepository(repositoryRoot);
  const fingerprint = fingerprintWorkingState(
    repositoryRoot,
    head,
    initial.statusEntries,
  );
  const evidence: CheckEvidence[] = [];
  for (const { checkId, definition, runner } of pinned) {
    evidence.push(
      runCheck(
        repositoryRoot,
        checkId,
        definition,
        runner,
        createCheckEnvironment(environment, definition.destructiveDatabase),
        definition.destructiveDatabase ? database?.identity : undefined,
      ),
    );
    const current = discoverRepository(repositoryRoot);
    const currentFingerprint = fingerprintWorkingState(
      repositoryRoot,
      head,
      current.statusEntries,
    );
    if (
      current.head !== head ||
      current.statusEntries.length > 0 ||
      currentFingerprint !== fingerprint
    ) {
      throw workflowError(
        'CI_CHECK_MUTATED_WORKTREE',
        `Required CI check ${checkId} changed the checkout.`,
        ExitCode.staleState,
        { details: { checkId } },
      );
    }
  }
  validateRepositoryState(repositoryRoot);
  return evidence;
}
