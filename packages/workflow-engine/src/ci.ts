import fs from 'node:fs';
import path from 'node:path';

import { runCiChecks } from './ci-checks.ts';
import { canonicalCheckDefinition } from './ci-historical-contract.ts';
import { replayCommitSequence } from './ci-sequence.ts';
import {
  assertCiCommit,
  findMergeBase,
  firstCommitIntroduces,
  listChangesAtCommit,
  listRangeCommits,
  listRangePaths,
  readFileAtCommit,
  type RangeCommit,
} from './ci-git.ts';
import {
  loadCiPolicy,
  loadPlanningBootstrapPolicy,
  type BootstrapException,
} from './ci-policy.ts';
import type { CompletedTask } from './ci-task-state.ts';
import {
  loadChangeContract,
  loadChecksConfig,
  loadWorkflowConfig,
  type ChangeContract,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';
import { validateRepositoryState } from './repository-validation.ts';

export type { CompletedTask } from './ci-task-state.ts';

export function verifyPullRequest(
  cwd: string,
  requestedBase: string,
  requestedHead: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const git = discoverRepository(cwd);
  const base = assertCiCommit(git.repositoryRoot, requestedBase);
  const head = assertCiCommit(git.repositoryRoot, requestedHead);
  if (git.head !== head) {
    throw ciError('CI_HEAD_MISMATCH', 'CI head is not the checked out commit.');
  }
  if (git.statusEntries.length > 0) {
    throw ciError('CI_WORKTREE_DIRTY', 'CI requires a clean checkout.');
  }
  const mergeBase = findMergeBase(git.repositoryRoot, base, head);
  if (mergeBase !== base) {
    throw ciError(
      'CI_BASE_NOT_ANCESTOR',
      'PR head must include the exact current base before assurance runs.',
    );
  }
  const commits = listRangeCommits(git.repositoryRoot, mergeBase, head);
  const validated = validateRepositoryState(git.repositoryRoot);
  const contracts = new Map(
    validated.changes.map((changeId) => [
      changeId,
      loadChangeContract(git.repositoryRoot, changeId),
    ]),
  );
  assertChangesPreserved(
    listChangesAtCommit(
      git.repositoryRoot,
      mergeBase,
      loadWorkflowConfig(git.repositoryRoot).changeRoot,
    ),
    contracts,
  );
  assertPoliciesAnchored(git.repositoryRoot, mergeBase);
  const exceptions = activeBootstrapExceptions(
    git.repositoryRoot,
    mergeBase,
    contracts,
    commits,
  );
  const replay = replayCommitSequence(
    git.repositoryRoot,
    commits,
    contracts,
    exceptions,
    loadPlanningBootstrapPolicy(git.repositoryRoot),
  );
  const completedTasks = replay.completedTasks;
  const changedPaths = listRangePaths(git.repositoryRoot, mergeBase, head);
  const checkIds = assertHistoricalChecksCurrent(
    git.repositoryRoot,
    contracts,
    completedTasks,
    replay.requiredCheckDefinitions,
  );
  const checks = runCiChecks(git.repositoryRoot, head, checkIds, environment);
  return {
    base,
    head,
    mergeBase,
    commits: commits.map(({ hash }) => hash),
    completedTasks,
    changedPaths,
    checks,
    managedDocuments: validated.documents,
    runtimeReportsTrusted: false,
  };
}

function assertChangesPreserved(
  baseChanges: string[],
  contracts: Map<string, ChangeContract>,
): void {
  const removed = baseChanges.filter((changeId) => !contracts.has(changeId));
  if (removed.length > 0) {
    throw ciError(
      'CI_CHANGE_REMOVED',
      'Active changes may not disappear across the CI merge boundary.',
      { removedChanges: removed },
    );
  }
}

function assertPoliciesAnchored(repositoryRoot: string, base: string): void {
  for (const policyPath of [
    'workflow/config.json',
    'workflow/document-policy.json',
  ]) {
    const basePolicy = readFileAtCommit(repositoryRoot, base, policyPath);
    if (
      basePolicy !== undefined &&
      basePolicy !== readCurrentFile(repositoryRoot, policyPath)
    ) {
      throw ciError(
        'CI_POLICY_CHANGED',
        `Existing CI authority policy changed in ${policyPath}.`,
      );
    }
  }
}

function assertHistoricalChecksCurrent(
  repositoryRoot: string,
  contracts: Map<string, ChangeContract>,
  completedTasks: CompletedTask[],
  historicalDefinitions: Record<string, string>,
): string[] {
  const current = loadChecksConfig(repositoryRoot);
  const required = new Map(Object.entries(historicalDefinitions));
  for (const task of completedTasks) {
    const policy = contracts.get(task.changeId)?.guard.tasks[task.taskId];
    if (!policy) {
      throw ciError(
        'CI_MANAGED_TRAILER_UNKNOWN',
        'A completed task is absent from the current validated contract.',
      );
    }
    for (const checkId of policy.requiredChecks) {
      if (!required.has(checkId)) {
        const definition = current.checks[checkId];
        if (!definition) {
          throw ciError(
            'CI_CHECK_UNKNOWN',
            `CI task policy references unknown check ${checkId}.`,
          );
        }
        required.set(checkId, canonicalCheckDefinition(definition));
      }
    }
  }
  for (const [checkId, expected] of required) {
    const definition = current.checks[checkId];
    if (!definition || canonicalCheckDefinition(definition) !== expected) {
      throw ciError(
        'CI_CHECK_DEFINITION_CHANGED',
        `Required check ${checkId} changed after its task commit.`,
      );
    }
  }
  return [...required.keys()].sort();
}

function activeBootstrapExceptions(
  repositoryRoot: string,
  base: string,
  contracts: Map<string, ChangeContract>,
  commits: RangeCommit[],
): BootstrapException[] {
  return loadCiPolicy(repositoryRoot).filter((exception) => {
    const contract = contracts.get(exception.changeId);
    if (!contract) {
      return false;
    }
    if (
      exception.taskIds.some(
        (taskId) => !contract.tasks.some(({ id }) => id === taskId),
      ) ||
      exception.compatibilityCommits.some(
        ({ taskId }) => !contract.tasks.some(({ id }) => id === taskId),
      )
    ) {
      throw workflowError(
        'CI_POLICY_INVALID',
        'Bootstrap exception references an unknown task.',
        ExitCode.guard,
      );
    }
    const guardPath = relative(
      repositoryRoot,
      path.join(contract.changeDirectory, 'guard.json'),
    );
    return (
      readFileAtCommit(repositoryRoot, base, 'workflow/ci-policy.json') ===
        undefined &&
      readFileAtCommit(repositoryRoot, base, guardPath) === undefined &&
      firstCommitIntroduces(
        repositoryRoot,
        commits[0],
        exception.introductionPaths,
      )
    );
  });
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function readCurrentFile(
  repositoryRoot: string,
  filePath: string,
): string | undefined {
  try {
    return fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8');
  } catch {
    return undefined;
  }
}

function ciError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
