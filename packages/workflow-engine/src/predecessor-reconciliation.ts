import type { CheckEvidence } from './check-runner.ts';
import type { TaskPolicy } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  commitChangedPaths,
  commitFacts,
  hasExactTrailers,
} from './git-transitions.ts';
import { runGit } from './git.ts';
import { matchesAllowedPath } from './paths.ts';
import { executeChecks, type SessionInspection } from './verification.ts';

export type ReconciledTask = {
  taskId: string;
  commitHash: string;
  changedPaths: string[];
  checks: CheckEvidence[];
};

export function reconcilePredecessor(
  cwd: string,
  inspection: SessionInspection,
  environment: NodeJS.ProcessEnv,
): ReconciledTask[] {
  const currentIndex = inspection.contract.tasks.findIndex(
    ({ id }) => id === inspection.session.taskId,
  );
  const incompleteEarlier = inspection.contract.tasks
    .slice(0, currentIndex)
    .filter(({ completed }) => !completed);
  if (incompleteEarlier.length === 0) {
    return [];
  }
  const predecessor = inspection.contract.tasks[currentIndex - 1];
  if (
    incompleteEarlier.length !== 1 ||
    !predecessor ||
    incompleteEarlier[0].id !== predecessor.id
  ) {
    throw predecessorInvalid();
  }

  const policy = inspection.contract.guard.tasks[predecessor.id];
  assertPredecessorContract(inspection, predecessor.id, policy);
  const facts = commitFacts(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  const changedPaths = commitChangedPaths(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  if (
    facts.parents.length !== 1 ||
    changedPaths.length === 0 ||
    !hasExactTrailers(
      facts.message,
      inspection.session.changeId,
      predecessor.id,
    ) ||
    changedPaths.some(
      (changedPath) =>
        !policy.allowedPaths.some((allowedPath) =>
          matchesAllowedPath(changedPath, allowedPath),
        ),
    )
  ) {
    throw predecessorInvalid();
  }

  const verified = executeChecks(
    cwd,
    inspection,
    policy.requiredChecks,
    environment,
  );
  return [
    {
      taskId: predecessor.id,
      commitHash: inspection.session.baseline.head,
      changedPaths,
      checks: verified.checks,
    },
  ];
}

function assertPredecessorContract(
  inspection: SessionInspection,
  taskId: string,
  currentPolicy: TaskPolicy,
): void {
  const guardPath = `${inspection.contract.config.changeRoot}/${inspection.session.changeId}/guard.json`;
  const baselineGuard = baselineJson(inspection, guardPath);
  const baselineChecks = baselineJson(inspection, 'workflow/checks.json');
  if (
    !isRecord(baselineGuard.tasks) ||
    JSON.stringify(baselineGuard.tasks[taskId]) !==
      JSON.stringify(currentPolicy) ||
    !isRecord(baselineChecks.checks)
  ) {
    throw predecessorInvalid();
  }
  for (const checkId of currentPolicy.requiredChecks) {
    if (
      JSON.stringify(baselineChecks.checks[checkId]) !==
      JSON.stringify(inspection.contract.checks.checks[checkId])
    ) {
      throw predecessorInvalid();
    }
  }
}

function baselineJson(
  inspection: SessionInspection,
  relativePath: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      runGit(inspection.git.repositoryRoot, [
        'show',
        `${inspection.session.baseline.head}:${relativePath}`,
      ]),
    );
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Converted to one fail-closed reconciliation error below.
  }
  throw predecessorInvalid();
}

function predecessorInvalid() {
  return workflowError(
    'PREDECESSOR_NOT_RECONCILABLE',
    'An incomplete predecessor lacks matching pinned Git and check evidence.',
    ExitCode.verification,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
