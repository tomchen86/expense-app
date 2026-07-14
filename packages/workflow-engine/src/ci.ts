import fs from 'node:fs';
import path from 'node:path';

import { runCiChecks } from './ci-checks.ts';
import { validateCommitSequence } from './ci-commit-validation.ts';
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
import { loadCiPolicy, type BootstrapException } from './ci-policy.ts';
import {
  assertTaskHistory,
  compareTasks,
  type CompletedTask,
} from './ci-task-state.ts';
import {
  loadChangeContract,
  loadChecksConfig,
  loadWorkflowConfig,
  parseTasks,
  type ChangeContract,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';
import { matchesAllowedPath } from './paths.ts';
import { validateRepositoryState } from './repository-validation.ts';
import { assertExactTaskProjection } from './task-projection.ts';

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
  assertPoliciesAnchored(git.repositoryRoot, mergeBase, contracts);
  const exceptions = activeBootstrapExceptions(
    git.repositoryRoot,
    mergeBase,
    contracts,
    commits,
  );
  const completedTasks = findCompletedTasks(
    git.repositoryRoot,
    mergeBase,
    contracts,
  );
  validateCommitSequence(git.repositoryRoot, commits, contracts, exceptions);
  validateCommitTrailers(commits, contracts, completedTasks, exceptions);
  const changedPaths = listRangePaths(git.repositoryRoot, mergeBase, head);
  const checkIds = requiredChecks(contracts, completedTasks);
  assertCheckDefinitionsAnchored(git.repositoryRoot, mergeBase, checkIds);
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

function findCompletedTasks(
  repositoryRoot: string,
  base: string,
  contracts: Map<string, ChangeContract>,
): CompletedTask[] {
  const completed: CompletedTask[] = [];
  for (const [changeId, contract] of contracts) {
    const tasksPath = relative(
      repositoryRoot,
      path.join(contract.changeDirectory, 'tasks.md'),
    );
    const baseContent = readFileAtCommit(repositoryRoot, base, tasksPath);
    const baseTasks = baseContent ? parseTasks(baseContent) : [];
    assertTaskHistory(changeId, baseTasks, contract.tasks);
    const baseById = new Map(baseTasks.map((task) => [task.id, task]));
    for (const task of contract.tasks) {
      if (task.completed && !baseById.get(task.id)?.completed) {
        completed.push({ changeId, taskId: task.id });
      }
    }
    if (baseContent) {
      const completedIds = completed
        .filter((task) => task.changeId === changeId)
        .map(({ taskId }) => taskId);
      const policyAllowsTaskEdits = completedIds.some((taskId) =>
        contract.guard.tasks[taskId].allowedPaths.some((allowedPath) =>
          matchesAllowedPath(tasksPath, allowedPath),
        ),
      );
      if (!policyAllowsTaskEdits) {
        try {
          assertExactTaskProjection(
            baseContent,
            fs.readFileSync(path.join(repositoryRoot, tasksPath), 'utf8'),
            completedIds,
          );
        } catch {
          throw ciError(
            'CI_TASK_PROJECTION_INVALID',
            `Task file ${tasksPath} is not an exact checkbox projection.`,
          );
        }
      }
    }
  }
  return completed.sort(compareTasks);
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

function assertPoliciesAnchored(
  repositoryRoot: string,
  base: string,
  contracts: Map<string, ChangeContract>,
): void {
  for (const contract of contracts.values()) {
    const guardPath = relative(
      repositoryRoot,
      path.join(contract.changeDirectory, 'guard.json'),
    );
    const baseGuard = readFileAtCommit(repositoryRoot, base, guardPath);
    if (
      baseGuard !== undefined &&
      baseGuard !== readCurrentFile(repositoryRoot, guardPath)
    ) {
      throw ciError(
        'CI_GUARD_CHANGED',
        `Existing guard policy changed in ${guardPath}.`,
      );
    }
  }
  for (const policyPath of [
    'workflow/config.json',
    'workflow/document-policy.json',
    'workflow/ci-policy.json',
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

function assertCheckDefinitionsAnchored(
  repositoryRoot: string,
  base: string,
  checkIds: string[],
): void {
  const baseContent = readFileAtCommit(
    repositoryRoot,
    base,
    'workflow/checks.json',
  );
  if (baseContent === undefined) {
    return;
  }
  let baseChecks: unknown;
  try {
    baseChecks = JSON.parse(baseContent);
  } catch {
    throw ciError(
      'CI_BASE_CHECKS_INVALID',
      'Base workflow/checks.json is invalid.',
    );
  }
  const headChecks = loadChecksConfig(repositoryRoot);
  if (!isRecord(baseChecks) || !isRecord(baseChecks.checks)) {
    throw ciError(
      'CI_BASE_CHECKS_INVALID',
      'Base workflow/checks.json is invalid.',
    );
  }
  for (const checkId of checkIds) {
    const baseDefinition = baseChecks.checks[checkId];
    if (
      baseDefinition !== undefined &&
      JSON.stringify(baseDefinition) !==
        JSON.stringify(headChecks.checks[checkId])
    ) {
      throw ciError(
        'CI_CHECK_DEFINITION_CHANGED',
        `Required check ${checkId} changed across the merge boundary.`,
      );
    }
  }
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

function validateCommitTrailers(
  commits: RangeCommit[],
  contracts: Map<string, ChangeContract>,
  completedTasks: CompletedTask[],
  exceptions: BootstrapException[],
): void {
  for (const commit of commits) {
    if (!commit.trailers) {
      continue;
    }
    const contract = contracts.get(commit.trailers.changeId);
    if (
      !contract ||
      !contract.tasks.some(({ id }) => id === commit.trailers?.taskId) ||
      commit.parents.length !== 1
    ) {
      throw ciError(
        'CI_MANAGED_TRAILER_UNKNOWN',
        'A managed PR commit names an unknown change/task or is not single-parent.',
      );
    }
  }
  for (const task of completedTasks) {
    const matched = commits.some(
      ({ trailers }) =>
        trailers?.changeId === task.changeId && trailers.taskId === task.taskId,
    );
    const excepted = exceptions.some(
      (exception) =>
        exception.changeId === task.changeId &&
        exception.taskIds.includes(task.taskId),
    );
    if (!matched && !excepted) {
      throw ciError(
        'CI_TASK_COMMIT_MISSING',
        `Completed task ${task.changeId}/${task.taskId} has no exact trailer commit.`,
      );
    }
  }
}

function requiredChecks(
  contracts: Map<string, ChangeContract>,
  completedTasks: CompletedTask[],
): string[] {
  return [
    ...new Set(
      completedTasks.flatMap(
        (task) =>
          contracts.get(task.changeId)?.guard.tasks[task.taskId]
            ?.requiredChecks ?? [],
      ),
    ),
  ].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
