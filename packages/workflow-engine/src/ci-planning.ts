import { parseTasks, type ParsedTask } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  commitChangedPaths,
  commitFacts,
  planningCommitMessage,
} from './git-transitions.ts';
import { runGit } from './git.ts';
import {
  assertPlanningPaths,
  assertPlanningTaskHistory,
  taskStates,
} from './planning-contract.ts';
import type { PlanningTaskState } from './planning-report.ts';
import { normalizeChangedPath } from './paths.ts';

export type CiPlanningCommitValidation = {
  changeId: string;
  kind: 'introduction' | 'revision';
  beforeTasks: PlanningTaskState[] | undefined;
  afterTasks: PlanningTaskState[];
  changedPaths: string[];
};

type TreeEntry = {
  mode: string;
  type: string;
  path: string;
};

/**
 * Reconstruct one ordinary planning transition from its immutable Git commit.
 * The caller must dispatch only commits whose canonical trailer parser selected
 * the `plan` transition. The single integration bootstrap is deliberately an
 * outer exception because its dependency diff is not an ordinary plan diff.
 */
export function validateCiPlanningCommit(
  repositoryRoot: string,
  commitHash: string,
  changeId: string,
  changeRoot = 'openspec/changes',
): CiPlanningCommitValidation {
  assertChangeId(changeId);
  const normalizedChangeRoot = normalizeChangedPath(changeRoot);
  if (normalizedChangeRoot !== changeRoot || changeRoot.endsWith('/')) {
    throw ciPlanningError(
      'CI_PLANNING_ROOT_INVALID',
      'CI planning validation requires one canonical change root.',
    );
  }

  const facts = commitFacts(repositoryRoot, commitHash);
  if (facts.parents.length !== 1) {
    throw ciPlanningError(
      'CI_PLANNING_NON_LINEAR',
      'Planning commits must have exactly one parent.',
    );
  }
  if (facts.message !== `${planningCommitMessage(changeId)}\n`) {
    throw ciPlanningError(
      'CI_PLANNING_MESSAGE_INVALID',
      'Planning commits require the exact managed subject and trailer block.',
    );
  }

  const changedPaths = commitChangedPaths(repositoryRoot, facts.hash);
  if (changedPaths.length === 0) {
    throw ciPlanningError(
      'CI_PLANNING_DIFF_EMPTY',
      'Planning commits require a non-empty planning diff.',
    );
  }
  const prefix = `${normalizedChangeRoot}/${changeId}`;
  const beforeEntries = listTreeEntries(
    repositoryRoot,
    facts.parents[0],
    prefix,
  );
  const afterEntries = listTreeEntries(repositoryRoot, facts.hash, prefix);
  const afterPaths = new Set(afterEntries.map(({ path }) => path));
  const deletedPaths = beforeEntries
    .map(({ path }) => path)
    .filter(
      (beforePath) =>
        !afterPaths.has(beforePath) && changedPaths.includes(beforePath),
    );
  assertPlanningPaths(
    normalizedChangeRoot,
    changeId,
    changedPaths,
    deletedPaths,
  );
  assertCompletePlanningTree(normalizedChangeRoot, changeId, afterEntries);

  let beforeTasks: ParsedTask[] | undefined;
  let kind: CiPlanningCommitValidation['kind'];
  if (beforeEntries.length === 0) {
    kind = 'introduction';
    if (
      JSON.stringify(changedPaths) !==
      JSON.stringify(afterEntries.map(({ path }) => path))
    ) {
      throw ciPlanningError(
        'CI_PLANNING_INTRODUCTION_INVALID',
        'A planning introduction must add exactly one complete planning tree.',
      );
    }
  } else {
    kind = 'revision';
    const beforePaths = new Set(beforeEntries.map(({ path }) => path));
    const repairedPaths = requiredArtifactPaths(
      normalizedChangeRoot,
      changeId,
    ).filter(
      (requiredPath) =>
        !beforePaths.has(requiredPath) &&
        afterPaths.has(requiredPath) &&
        changedPaths.includes(requiredPath),
    );
    assertCompletePlanningTree(
      normalizedChangeRoot,
      changeId,
      beforeEntries,
      deletedPaths,
      repairedPaths,
    );
    beforeTasks = parseTasks(
      readRequiredFile(repositoryRoot, facts.parents[0], `${prefix}/tasks.md`),
    );
  }

  const afterTasks = parseTasks(
    readRequiredFile(repositoryRoot, facts.hash, `${prefix}/tasks.md`),
  );
  assertPlanningTaskHistory(beforeTasks, afterTasks);
  return {
    changeId,
    kind,
    beforeTasks: beforeTasks ? taskStates(beforeTasks) : undefined,
    afterTasks: taskStates(afterTasks),
    changedPaths,
  };
}

function requiredArtifactPaths(changeRoot: string, changeId: string): string[] {
  const prefix = `${changeRoot}/${changeId}`;
  return [
    '.openspec.yaml',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
  ].map((relativePath) => `${prefix}/${relativePath}`);
}

/**
 * A required artifact may be absent only from a revision's before tree, and
 * only when that same revision adds it (bootstrap-era tree repair).
 */
function assertCompletePlanningTree(
  changeRoot: string,
  changeId: string,
  entries: TreeEntry[],
  toleratedDeletedPaths: readonly string[] = [],
  toleratedMissingPaths: readonly string[] = [],
): void {
  const paths = entries.map(({ path }) => path);
  assertPlanningPaths(changeRoot, changeId, paths, toleratedDeletedPaths);
  const prefix = `${changeRoot}/${changeId}`;
  const required = requiredArtifactPaths(changeRoot, changeId);
  if (
    required.some(
      (requiredPath) =>
        !paths.includes(requiredPath) &&
        !toleratedMissingPaths.includes(requiredPath),
    ) ||
    !paths.some(
      (filePath) =>
        filePath.startsWith(`${prefix}/specs/`) &&
        filePath.endsWith('/spec.md'),
    )
  ) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_INVALID',
      'Planning commit tree is missing a required artifact.',
    );
  }
  if (entries.some(({ mode, type }) => mode !== '100644' || type !== 'blob')) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_UNSAFE',
      'Planning artifacts must be non-executable regular Git blobs.',
    );
  }
}

function listTreeEntries(
  repositoryRoot: string,
  commit: string,
  prefix: string,
): TreeEntry[] {
  return runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    commit,
    '--',
    `:(literal)${prefix}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\S+) [0-9a-f]+\t(.+)$/.exec(entry);
      if (!match) {
        throw ciPlanningError(
          'CI_PLANNING_TREE_INVALID',
          'CI could not parse the planning tree.',
        );
      }
      return {
        mode: match[1],
        type: match[2],
        path: normalizeChangedPath(match[3]),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function readRequiredFile(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string {
  try {
    return runGit(repositoryRoot, ['show', `${commit}:${filePath}`]);
  } catch (error) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_INVALID',
      'CI could not read a required planning artifact.',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function assertChangeId(changeId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) {
    throw ciPlanningError(
      'CI_PLANNING_CHANGE_ID_INVALID',
      'CI planning validation requires a canonical change ID.',
    );
  }
}

function ciPlanningError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, {
    ...(details ? { details } : {}),
  });
}
