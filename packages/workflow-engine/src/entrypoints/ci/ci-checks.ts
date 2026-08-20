import {
  pinCheckRunner,
  runCheck,
  type CheckEvidence,
} from '../../adapters/consumer/expense-app/work-registry/check-runner.ts';
import { productionCheckRegistryPort } from '../../composition-root/check-registry-production.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from '../../adapters/consumer/expense-app/work-registry/database-policy.ts';
import type {
  CheckDefinitionV1,
  CheckRegistryPortV1,
} from '@jigwright/core/check-registry-port';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
} from '../../runtime/repository-transaction/git.ts';
import { validateRepositoryState } from '../../composition-root/repository-validation.ts';

export type ResolvedRequiredCiCheck = Readonly<{
  checkId: string;
  definition: CheckDefinitionV1;
}>;

export function resolveRequiredCiChecks(
  repositoryRoot: string,
  checkIds: readonly string[],
  checkRegistryPort: CheckRegistryPortV1 = productionCheckRegistryPort,
): ResolvedRequiredCiCheck[] {
  if (
    !isRecord(checkRegistryPort) ||
    checkRegistryPort.contractVersion !== 'jigwright.check-registry-port.v1' ||
    typeof checkRegistryPort.load !== 'function'
  ) {
    throw workflowError(
      'CI_CHECK_REGISTRY_UNSUPPORTED',
      'CI check selection requires the exact CheckRegistry port contract v1.',
      ExitCode.guard,
    );
  }
  const registry = checkRegistryPort.load(repositoryRoot);
  if (
    !isRecord(registry) ||
    registry.schemaVersion !== 1 ||
    !isRecord(registry.checks)
  ) {
    throw invalidCheckRegistry();
  }
  return checkIds.map((checkId) => {
    if (!Object.hasOwn(registry.checks, checkId)) {
      throw workflowError(
        'CI_CHECK_UNKNOWN',
        `CI task policy references unknown check ${checkId}.`,
        ExitCode.guard,
      );
    }
    const definition = registry.checks[checkId];
    if (
      !isRecord(definition) ||
      !hasExactDefinitionKeys(definition) ||
      !Array.isArray(definition.command) ||
      definition.command.some((part) => typeof part !== 'string') ||
      typeof definition.destructiveDatabase !== 'boolean' ||
      (definition.liveStderr !== undefined &&
        typeof definition.liveStderr !== 'boolean')
    ) {
      throw invalidCheckRegistry();
    }
    const normalized = Object.freeze({
      command: [...definition.command],
      destructiveDatabase: definition.destructiveDatabase,
      ...(definition.liveStderr === undefined
        ? {}
        : { liveStderr: definition.liveStderr }),
    });
    return Object.freeze({ checkId, definition: normalized });
  });
}

export function runCiChecks(
  repositoryRoot: string,
  head: string,
  checkIds: string[],
  environment: NodeJS.ProcessEnv,
  checkRegistryPort: CheckRegistryPortV1 = productionCheckRegistryPort,
): CheckEvidence[] {
  const required = resolveRequiredCiChecks(
    repositoryRoot,
    checkIds,
    checkRegistryPort,
  );
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

function hasExactDefinitionKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(['command', 'destructiveDatabase']) ||
    JSON.stringify(keys) ===
      JSON.stringify(['command', 'destructiveDatabase', 'liveStderr'])
  );
}

function invalidCheckRegistry(): ReturnType<typeof workflowError> {
  return workflowError(
    'CI_CHECK_REGISTRY_INVALID',
    'The selected CheckRegistry adapter returned an invalid v1 registry.',
    ExitCode.guard,
  );
}
