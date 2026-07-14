import path from 'node:path';

import {
  listCommitPaths,
  readFileAtCommit,
  type RangeCommit,
} from './ci-git.ts';
import type {
  BootstrapCompatibilityCommit,
  BootstrapException,
} from './ci-policy.ts';
import {
  assertTaskHistory,
  compareTasks,
  taskKey,
  type CompletedTask,
} from './ci-task-state.ts';
import { parseTasks, type ChangeContract } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { completionDocumentPaths } from './managed-documents.ts';
import { matchesAllowedPath } from './paths.ts';

export function validateCommitSequence(
  repositoryRoot: string,
  commits: RangeCommit[],
  contracts: Map<string, ChangeContract>,
  exceptions: BootstrapException[],
): void {
  const priorTrailers = new Set<string>();
  const completionPaths = completionDocumentPaths(repositoryRoot);
  const expectedCompatibility = exceptions.flatMap((exception) =>
    exception.compatibilityCommits.map((definition) => ({
      changeId: exception.changeId,
      definition,
    })),
  );
  let compatibilityIndex = 0;
  for (const [index, commit] of commits.entries()) {
    if (commit.parents.length !== 1) {
      throw ciError(
        'CI_NON_LINEAR_COMMIT',
        'Managed PR commits must have exactly one parent.',
      );
    }
    const transitions = taskTransitionsForCommit(
      repositoryRoot,
      commit,
      contracts,
    );
    const bootstrapIntroduction =
      index === 0 && !commit.trailers && exceptions.length > 0;
    if (!commit.trailers && !bootstrapIntroduction) {
      throw ciError(
        'CI_COMMIT_TRAILERS_REQUIRED',
        'Every non-bootstrap PR commit requires canonical managed trailers.',
      );
    }
    const compatibility = bootstrapIntroduction
      ? undefined
      : expectedCompatibility[compatibilityIndex];
    if (bootstrapIntroduction) {
      assertBootstrapTransitions(transitions, exceptions);
    } else if (compatibility) {
      assertCompatibilityCommit(
        repositoryRoot,
        commit,
        transitions,
        compatibility.changeId,
        compatibility.definition,
      );
      compatibilityIndex += 1;
    } else if (commit.trailers) {
      assertKnownTrailer(commit, contracts);
      validateManagedTransitions(commit, transitions, contracts, priorTrailers);
    }
    validateCommitScope(
      repositoryRoot,
      commit,
      transitions,
      contracts,
      bootstrapIntroduction
        ? exceptions.flatMap(({ allowedPaths }) => allowedPaths)
        : (compatibility?.definition.changedPaths ?? []),
      completionPaths,
    );
    if (commit.trailers) {
      priorTrailers.add(taskKey(commit.trailers));
    }
  }
  if (compatibilityIndex !== expectedCompatibility.length) {
    throw ciError(
      'CI_BOOTSTRAP_COMPATIBILITY_MISMATCH',
      'Bootstrap compatibility commits do not match the declared sequence.',
    );
  }
}

function assertCompatibilityCommit(
  repositoryRoot: string,
  commit: RangeCommit,
  transitions: CompletedTask[],
  changeId: string,
  expected: BootstrapCompatibilityCommit,
): void {
  const changedPaths = listCommitPaths(repositoryRoot, commit);
  if (
    transitions.length !== 0 ||
    commit.trailers?.changeId !== changeId ||
    commit.trailers.taskId !== expected.taskId ||
    commit.subject !== expected.subject ||
    changedPaths.length !== expected.changedPaths.length ||
    changedPaths.some(
      (changedPath, index) => changedPath !== expected.changedPaths[index],
    )
  ) {
    throw ciError(
      'CI_BOOTSTRAP_COMPATIBILITY_MISMATCH',
      'Bootstrap compatibility commit does not match its semantic policy.',
      { commit: commit.hash },
    );
  }
}

function assertBootstrapTransitions(
  transitions: CompletedTask[],
  exceptions: BootstrapException[],
): void {
  if (
    transitions.some(
      (task) =>
        !exceptions.some(
          (exception) =>
            exception.changeId === task.changeId &&
            exception.taskIds.includes(task.taskId),
        ),
    )
  ) {
    throw ciError(
      'CI_BOOTSTRAP_TRANSITION_INVALID',
      'Bootstrap commit completed a task outside its semantic exception.',
    );
  }
}

function taskTransitionsForCommit(
  repositoryRoot: string,
  commit: RangeCommit,
  contracts: Map<string, ChangeContract>,
): CompletedTask[] {
  const transitions: CompletedTask[] = [];
  for (const [changeId, contract] of contracts) {
    const tasksPath = relative(
      repositoryRoot,
      path.join(contract.changeDirectory, 'tasks.md'),
    );
    const beforeContent = readFileAtCommit(
      repositoryRoot,
      commit.parents[0],
      tasksPath,
    );
    const afterContent = readFileAtCommit(
      repositoryRoot,
      commit.hash,
      tasksPath,
    );
    if (beforeContent === undefined && afterContent === undefined) {
      continue;
    }
    if (afterContent === undefined) {
      throw ciError(
        'CI_CHANGE_REMOVED',
        `Commit ${commit.hash} removed ${tasksPath}.`,
      );
    }
    const beforeTasks = beforeContent ? parseTasks(beforeContent) : [];
    const afterTasks = parseTasks(afterContent);
    assertTaskHistory(changeId, beforeTasks, afterTasks);
    const beforeById = new Map(beforeTasks.map((task) => [task.id, task]));
    for (const task of afterTasks) {
      if (task.completed && !beforeById.get(task.id)?.completed) {
        transitions.push({ changeId, taskId: task.id });
      }
    }
  }
  return transitions.sort(compareTasks);
}

function validateManagedTransitions(
  commit: RangeCommit,
  transitions: CompletedTask[],
  contracts: Map<string, ChangeContract>,
  priorTrailers: Set<string>,
): void {
  if (!commit.trailers) {
    return;
  }
  if (transitions.length === 0) {
    throw ciError(
      'CI_TASK_TRANSITION_REQUIRED',
      'A managed commit must complete its exact trailer task.',
    );
  }
  const own = {
    changeId: commit.trailers.changeId,
    taskId: commit.trailers.taskId,
  };
  if (
    !transitions.some(
      (task) => task.changeId === own.changeId && task.taskId === own.taskId,
    ) ||
    transitions.some((task) => task.changeId !== own.changeId)
  ) {
    throw ciError(
      'CI_TASK_TRANSITION_COMMIT_MISMATCH',
      'Checkbox transitions are not bound to the commit task trailer.',
    );
  }
  const predecessor = transitions.filter((task) => task.taskId !== own.taskId);
  if (predecessor.length === 0) {
    return;
  }
  const contract = contracts.get(own.changeId)!;
  const ownIndex = contract.tasks.findIndex(({ id }) => id === own.taskId);
  const previous = predecessor[0];
  const previousIndex = contract.tasks.findIndex(
    ({ id }) => id === previous.taskId,
  );
  if (
    predecessor.length !== 1 ||
    previousIndex !== ownIndex - 1 ||
    !priorTrailers.has(taskKey(previous))
  ) {
    throw ciError(
      'CI_PREDECESSOR_TRANSITION_INVALID',
      'Only one previously evidenced adjacent predecessor may be reconciled.',
    );
  }
}

function validateCommitScope(
  repositoryRoot: string,
  commit: RangeCommit,
  transitions: CompletedTask[],
  contracts: Map<string, ChangeContract>,
  exceptionPaths: string[],
  completionPaths: string[],
): void {
  const allowed = commit.trailers
    ? [
        ...(contracts.get(commit.trailers.changeId)?.guard.tasks[
          commit.trailers.taskId
        ]?.allowedPaths ?? []),
      ]
    : [];
  allowed.push(...exceptionPaths);
  const transitionPaths = new Set(
    transitions.map(({ changeId }) => `openspec/changes/${changeId}/tasks.md`),
  );
  if (transitions.length > 0) {
    completionPaths.forEach((filePath) => transitionPaths.add(filePath));
  }
  const unexpected = listCommitPaths(repositoryRoot, commit).filter(
    (changedPath) =>
      !transitionPaths.has(changedPath) &&
      !allowed.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );
  if (unexpected.length > 0) {
    throw ciError(
      'CI_COMMIT_OUT_OF_SCOPE',
      `Commit ${commit.hash} contains paths outside its task scope.`,
      { commit: commit.hash, unexpectedPaths: unexpected },
    );
  }
}

function assertKnownTrailer(
  commit: RangeCommit,
  contracts: Map<string, ChangeContract>,
): void {
  const trailers = commit.trailers!;
  const contract = contracts.get(trailers.changeId);
  if (!contract?.tasks.some(({ id }) => id === trailers.taskId)) {
    throw ciError(
      'CI_MANAGED_TRAILER_UNKNOWN',
      'A managed PR commit names an unknown change or task.',
    );
  }
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function ciError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
