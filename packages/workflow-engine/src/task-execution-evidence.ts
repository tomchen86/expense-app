import { replayCommitSequence } from './ci-sequence.ts';
import { listRangeCommits, readFileAtCommit } from './ci-git.ts';
import { validateCiPlanningCommit } from './ci-planning.ts';
import { preEpochCompletedTaskIds } from './bootstrap-task-exemption.ts';
import { parseTasks } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  commitFacts,
  findExactTaskCommits,
  type TaskCommit,
} from './git-transitions.ts';
import { runGit } from './git.ts';
import { parseManagedTrailers } from './managed-trailers.ts';

export type TaskExecutionGenerationEvidence = {
  boundary: null | {
    commitHash: string;
    planningGeneration: string;
    amendsPlanningGeneration: string;
  };
  commitsByTask: Readonly<Record<string, TaskCommit[]>>;
};

/**
 * Reconstruct the current task-execution generation from immutable Git facts.
 *
 * Exact-looking trailers are not evidence by themselves. Every candidate task
 * commit is replayed through the same task transition and historical guard
 * checks used by CI. A required-impact amendment is likewise replayed as a
 * planning commit and must have changed every completed task to unchecked.
 */
export function resolveTaskExecutionGenerationEvidence(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  taskIds: readonly string[],
  tip = 'HEAD',
): TaskExecutionGenerationEvidence {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length !== taskIds.length) {
    throw invalidGeneration(
      'Task execution generation inspection requires unique task identities.',
    );
  }
  const firstParentCommits = new Set(
    runGit(repositoryRoot, ['rev-list', '--first-parent', tip])
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  const boundary = latestRequiredAmendmentBoundary(
    repositoryRoot,
    changeRoot,
    changeId,
    tip,
  );
  const preEpochExemptions =
    boundary === null
      ? preEpochCompletedTaskIds(repositoryRoot, changeRoot, changeId, tip)
      : new Set<string>();
  const commitsByTask = Object.fromEntries(
    uniqueTaskIds.map((taskId) => {
      // A task that was already complete before the repository's earliest
      // canonical planning epoch has no managed task transition to replay.
      // Ignore exact-looking legacy trailers entirely: accepting or rejecting
      // them would let unauthoritative pre-epoch history decide compatibility.
      if (preEpochExemptions.has(taskId)) return [taskId, []];
      const candidates = findExactTaskCommits(
        repositoryRoot,
        changeId,
        taskId,
        tip,
      );
      for (const candidate of candidates) {
        if (!firstParentCommits.has(candidate.hash)) {
          throw invalidGeneration(
            'Task execution evidence must be on the managed first-parent history.',
            candidate.hash,
          );
        }
        assertCanonicalTaskCommit(
          repositoryRoot,
          changeId,
          taskId,
          candidate.hash,
        );
      }
      return [
        taskId,
        boundary === null
          ? candidates
          : candidates.filter(({ hash }) =>
              isStrictlyBetween(repositoryRoot, boundary.commitHash, hash, tip),
            ),
      ];
    }),
  );
  return { boundary, commitsByTask };
}

function assertCanonicalTaskCommit(
  repositoryRoot: string,
  changeId: string,
  taskId: string,
  commitHash: string,
): void {
  const facts = commitFacts(repositoryRoot, commitHash);
  if (facts.parents.length !== 1) {
    throw invalidGeneration(
      'Task execution evidence must have exactly one parent.',
      commitHash,
    );
  }
  let replay;
  try {
    const commits = listRangeCommits(
      repositoryRoot,
      facts.parents[0],
      commitHash,
    );
    replay = replayCommitSequence(repositoryRoot, commits, new Map(), [], []);
  } catch {
    throw invalidGeneration(
      'Task execution evidence did not pass canonical task-transition replay.',
      commitHash,
    );
  }
  if (
    replay.completedTasks.length !== 1 ||
    replay.completedTasks[0]?.changeId !== changeId ||
    replay.completedTasks[0]?.taskId !== taskId
  ) {
    throw invalidGeneration(
      'Task execution evidence does not complete exactly its named task.',
      commitHash,
    );
  }
}

function latestRequiredAmendmentBoundary(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  tip: string,
): NonNullable<TaskExecutionGenerationEvidence['boundary']> | null {
  const values = runGit(repositoryRoot, [
    'log',
    '--first-parent',
    tip,
    '--format=%H%x00%B%x00',
  ]).split('\0');
  for (let index = 0; index + 1 < values.length; index += 2) {
    const commitHash = values[index].trimStart();
    if (!/^[0-9a-f]{40,64}$/.test(commitHash)) continue;
    let trailers;
    try {
      trailers = parseManagedTrailers(values[index + 1]);
    } catch {
      throw invalidGeneration(
        'Task execution generation history contains a malformed managed transition.',
        commitHash,
      );
    }
    if (
      trailers?.kind !== 'amend-plan' ||
      trailers.changeId !== changeId ||
      trailers.executionImpact !== 'required'
    ) {
      continue;
    }
    try {
      validateCiPlanningCommit(
        repositoryRoot,
        commitHash,
        changeId,
        changeRoot,
      );
    } catch {
      throw invalidGeneration(
        'Required-impact execution boundary did not pass canonical planning replay.',
        commitHash,
      );
    }
    assertRequiredAmendmentReopenedEveryTask(
      repositoryRoot,
      changeRoot,
      changeId,
      commitHash,
    );
    return {
      commitHash,
      planningGeneration: trailers.planningGeneration,
      amendsPlanningGeneration: trailers.amendsPlanningGeneration,
    };
  }
  return null;
}

function assertRequiredAmendmentReopenedEveryTask(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  commitHash: string,
): void {
  const facts = commitFacts(repositoryRoot, commitHash);
  const tasksPath = `${changeRoot}/${changeId}/tasks.md`;
  if (facts.parents.length !== 1) {
    throw invalidGeneration(
      'Required-impact execution boundary must have exactly one parent.',
      commitHash,
    );
  }
  let before;
  let after;
  try {
    const beforeBytes = readFileAtCommit(
      repositoryRoot,
      facts.parents[0],
      tasksPath,
    );
    const afterBytes = readFileAtCommit(repositoryRoot, commitHash, tasksPath);
    if (beforeBytes === undefined || afterBytes === undefined) {
      throw new Error('missing tasks');
    }
    before = parseTasks(beforeBytes);
    after = parseTasks(afterBytes);
  } catch {
    throw invalidGeneration(
      'Required-impact execution boundary has no valid task projection.',
      commitHash,
    );
  }
  if (
    before.length === 0 ||
    before.some(({ completed }) => !completed) ||
    after.some(({ completed }) => completed) ||
    JSON.stringify(before.map(({ id }) => id)) !==
      JSON.stringify(after.map(({ id }) => id))
  ) {
    throw invalidGeneration(
      'Required-impact execution boundary did not reopen every completed task.',
      commitHash,
    );
  }
}

function isStrictlyBetween(
  repositoryRoot: string,
  lowerExclusive: string,
  candidate: string,
  upperInclusive: string,
): boolean {
  return (
    candidate !== lowerExclusive &&
    runGit(
      repositoryRoot,
      ['merge-base', lowerExclusive, candidate],
      true,
    ).trim() === lowerExclusive &&
    runGit(
      repositoryRoot,
      ['merge-base', candidate, upperInclusive],
      true,
    ).trim() === candidate
  );
}

function invalidGeneration(message: string, commitHash?: string) {
  return workflowError(
    'TASK_EXECUTION_GENERATION_INVALID',
    message,
    ExitCode.staleState,
    commitHash === undefined ? undefined : { details: { commitHash } },
  );
}
