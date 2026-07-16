import { validateCiArchiveCommit } from './ci-archive.ts';
import { assertExactPlanningBootstrap } from './ci-bootstrap.ts';
import {
  loadHistoricalTaskAuthority,
  type HistoricalTaskAuthority,
} from './ci-historical-contract.ts';
import {
  listCommitPaths,
  readFileAtCommit,
  type RangeCommit,
} from './ci-git.ts';
import { validateCiPlanningCommit } from './ci-planning.ts';
import type {
  BootstrapCompatibilityCommit,
  BootstrapException,
  PlanningBootstrapException,
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
import { assertExactTaskProjection } from './task-projection.ts';

export type CommitSequenceResult = {
  completedTasks: CompletedTask[];
  archivedChanges: string[];
  requiredCheckDefinitions: Record<string, string>;
};

export function replayCommitSequence(
  repositoryRoot: string,
  commits: RangeCommit[],
  contracts: Map<string, ChangeContract>,
  legacyExceptions: BootstrapException[],
  planningBootstrapPolicies: PlanningBootstrapException[],
): CommitSequenceResult {
  const priorTaskTrailers = new Set<string>();
  const completedTasks = new Map<string, CompletedTask>();
  const archivedChanges = new Set<string>();
  const requiredCheckDefinitions = new Map<string, string>();
  const completionPaths = completionDocumentPaths(repositoryRoot);
  const expectedCompatibility = legacyExceptions.flatMap((exception) =>
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

    const planningBootstrap =
      commit.trailers?.kind === 'plan' && index === 0
        ? planningBootstrapPolicies.find(
            (policy) =>
              policy.changeId === commit.trailers?.changeId &&
              policy.expectedParent === commit.parents[0],
          )
        : undefined;
    if (planningBootstrap) {
      assertExactPlanningBootstrap(
        repositoryRoot,
        commit.hash,
        planningBootstrap,
        index,
      );
      continue;
    }

    const legacyIntroduction =
      index === 0 && !commit.trailers && legacyExceptions.length > 0;
    const compatibility = legacyIntroduction
      ? undefined
      : expectedCompatibility[compatibilityIndex];

    if (legacyIntroduction) {
      const transitions = taskTransitionsForCommit(repositoryRoot, commit);
      assertLegacyBootstrapTransitions(transitions, legacyExceptions);
      validateScope(
        repositoryRoot,
        commit,
        transitions,
        legacyExceptions.flatMap(({ allowedPaths }) => allowedPaths),
        completionPaths,
      );
      recordTransitions(completedTasks, transitions);
      continue;
    }

    if (compatibility) {
      const transitions = taskTransitionsForCommit(repositoryRoot, commit);
      assertCompatibilityCommit(
        repositoryRoot,
        commit,
        transitions,
        compatibility.changeId,
        compatibility.definition,
      );
      validateScope(
        repositoryRoot,
        commit,
        transitions,
        compatibility.definition.changedPaths,
        completionPaths,
      );
      compatibilityIndex += 1;
      if (commit.trailers?.kind === 'task') {
        priorTaskTrailers.add(taskKey(commit.trailers));
      }
      continue;
    }

    if (!commit.trailers) {
      throw ciError(
        'CI_COMMIT_TRAILERS_REQUIRED',
        'Every non-bootstrap PR commit requires canonical managed trailers.',
      );
    }

    if (commit.trailers.kind === 'plan') {
      validateCiPlanningCommit(
        repositoryRoot,
        commit.hash,
        commit.trailers.changeId,
      );
      continue;
    }
    if (commit.trailers.kind === 'archive') {
      const archive = validateCiArchiveCommit(
        repositoryRoot,
        commit.hash,
        commit.trailers.changeId,
      );
      recordDefinitions(requiredCheckDefinitions, archive.checkDefinitions);
      archivedChanges.add(archive.changeId);
      continue;
    }
    if (commit.trailers.kind === 'authority') {
      throw ciError(
        'CI_AUTHORITY_VERIFIER_REQUIRED',
        'Authority commits require independent parent-policy verification.',
      );
    }

    const transitions = taskTransitionsForCommit(repositoryRoot, commit);
    if (transitions.length === 0) {
      throw ciError(
        'CI_TASK_TRANSITION_REQUIRED',
        'A task commit must complete its exact trailer task.',
      );
    }
    const authority = loadHistoricalTaskAuthority(
      repositoryRoot,
      commit.parents[0],
      commit.trailers.changeId,
      commit.trailers.taskId,
    );
    validateTaskTransition(
      repositoryRoot,
      commit,
      commit.trailers,
      transitions,
      authority,
      priorTaskTrailers,
    );
    validateTaskScope(
      repositoryRoot,
      commit,
      transitions,
      authority,
      completionPaths,
    );
    recordTransitions(completedTasks, transitions);
    recordCheckDefinitions(requiredCheckDefinitions, authority);
    priorTaskTrailers.add(taskKey(commit.trailers));
  }

  if (compatibilityIndex !== expectedCompatibility.length) {
    throw ciError(
      'CI_BOOTSTRAP_COMPATIBILITY_MISMATCH',
      'Bootstrap compatibility commits do not match the declared sequence.',
    );
  }

  return {
    completedTasks: [...completedTasks.values()].sort(compareTasks),
    archivedChanges: [...archivedChanges].sort(),
    requiredCheckDefinitions: Object.fromEntries(
      [...requiredCheckDefinitions].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function taskTransitionsForCommit(
  repositoryRoot: string,
  commit: RangeCommit,
): CompletedTask[] {
  const transitions: CompletedTask[] = [];
  const taskPaths = listCommitPaths(repositoryRoot, commit).filter((filePath) =>
    /^openspec\/changes\/[a-z0-9]+(?:-[a-z0-9]+)*\/tasks\.md$/.test(filePath),
  );
  for (const tasksPath of taskPaths) {
    const changeId = tasksPath.split('/')[2];
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

function validateTaskTransition(
  repositoryRoot: string,
  commit: RangeCommit,
  trailers: { kind: 'task'; changeId: string; taskId: string },
  transitions: CompletedTask[],
  authority: HistoricalTaskAuthority,
  priorTaskTrailers: Set<string>,
): void {
  const own = {
    changeId: trailers.changeId,
    taskId: trailers.taskId,
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
  if (predecessor.length > 0) {
    const ownIndex = authority.tasks.findIndex(({ id }) => id === own.taskId);
    const previous = predecessor[0];
    const previousIndex = authority.tasks.findIndex(
      ({ id }) => id === previous.taskId,
    );
    if (
      predecessor.length !== 1 ||
      previousIndex !== ownIndex - 1 ||
      !priorTaskTrailers.has(taskKey(previous))
    ) {
      throw ciError(
        'CI_PREDECESSOR_TRANSITION_INVALID',
        'Only one previously evidenced adjacent predecessor may be reconciled.',
      );
    }
  }

  const before = readFileAtCommit(
    repositoryRoot,
    commit.parents[0],
    authority.tasksPath,
  );
  const after = readFileAtCommit(
    repositoryRoot,
    commit.hash,
    authority.tasksPath,
  );
  if (before === undefined || after === undefined) {
    throw ciError(
      'CI_TASK_PROJECTION_INVALID',
      'A task commit is missing its task projection.',
    );
  }
  const policyAllowsTaskEdits = authority.allowedPaths.some((allowedPath) =>
    matchesAllowedPath(authority.tasksPath, allowedPath),
  );
  if (!policyAllowsTaskEdits) {
    try {
      assertExactTaskProjection(
        before,
        after,
        transitions.map(({ taskId }) => taskId),
      );
    } catch {
      throw ciError(
        'CI_TASK_PROJECTION_INVALID',
        `Task file ${authority.tasksPath} is not an exact checkbox projection.`,
      );
    }
  }
}

function validateTaskScope(
  repositoryRoot: string,
  commit: RangeCommit,
  transitions: CompletedTask[],
  authority: HistoricalTaskAuthority,
  completionPaths: string[],
): void {
  const transitionPaths = new Set(
    transitions.map(({ changeId }) => `openspec/changes/${changeId}/tasks.md`),
  );
  const implicit = new Set([...transitionPaths, ...completionPaths]);
  const changedPaths = listCommitPaths(repositoryRoot, commit);
  const planningMutation = changedPaths.find(
    (changedPath) =>
      changedPath.startsWith('openspec/changes/') &&
      !transitionPaths.has(changedPath),
  );
  if (planningMutation) {
    throw ciError(
      planningMutation.endsWith('/guard.json')
        ? 'CI_GUARD_CHANGED'
        : 'CI_TASK_PLANNING_MUTATION',
      'Task commits may not revise planning authority.',
      { commit: commit.hash, path: planningMutation },
    );
  }
  const unexpected = changedPaths.filter(
    (changedPath) =>
      !implicit.has(changedPath) &&
      !authority.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );
  if (unexpected.length > 0) {
    throw ciError(
      'CI_COMMIT_OUT_OF_SCOPE',
      `Commit ${commit.hash} contains paths outside its parent task scope.`,
      { commit: commit.hash, unexpectedPaths: unexpected },
    );
  }
}

function validateScope(
  repositoryRoot: string,
  commit: RangeCommit,
  transitions: CompletedTask[],
  allowedPaths: string[],
  completionPaths: string[],
): void {
  const implicit = new Set(
    transitions
      .map(({ changeId }) => `openspec/changes/${changeId}/tasks.md`)
      .concat(transitions.length > 0 ? completionPaths : []),
  );
  const unexpected = listCommitPaths(repositoryRoot, commit).filter(
    (changedPath) =>
      !implicit.has(changedPath) &&
      !allowedPaths.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );
  if (unexpected.length > 0) {
    throw ciError(
      'CI_COMMIT_OUT_OF_SCOPE',
      `Commit ${commit.hash} contains paths outside its exception scope.`,
      { commit: commit.hash, unexpectedPaths: unexpected },
    );
  }
}

function assertLegacyBootstrapTransitions(
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
    commit.trailers?.kind !== 'task' ||
    commit.trailers.changeId !== changeId ||
    commit.trailers.taskId !== expected.taskId ||
    commit.subject !== expected.subject ||
    JSON.stringify(changedPaths) !== JSON.stringify(expected.changedPaths)
  ) {
    throw ciError(
      'CI_BOOTSTRAP_COMPATIBILITY_MISMATCH',
      'Bootstrap compatibility commit does not match its semantic policy.',
      { commit: commit.hash },
    );
  }
}

function recordTransitions(
  completed: Map<string, CompletedTask>,
  transitions: CompletedTask[],
): void {
  for (const task of transitions) {
    completed.set(taskKey(task), task);
  }
}

function recordCheckDefinitions(
  collected: Map<string, string>,
  authority: HistoricalTaskAuthority,
): void {
  recordDefinitions(collected, authority.checkDefinitions);
}

function recordDefinitions(
  collected: Map<string, string>,
  definitions: Record<string, string>,
): void {
  for (const [checkId, definition] of Object.entries(definitions)) {
    const previous = collected.get(checkId);
    if (previous !== undefined && previous !== definition) {
      throw ciError(
        'CI_CHECK_DEFINITION_CHANGED',
        `Required check ${checkId} changed between task commits.`,
      );
    }
    collected.set(checkId, definition);
  }
}

function ciError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
