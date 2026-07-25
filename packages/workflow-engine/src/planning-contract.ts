import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  parseTasks,
  readManagedSchemaName,
  type ManagedSchemaName,
  type ParsedTask,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  assertInvestigationPlanningActivation,
  readActivationMarkerFile,
  protectedActivationBaselines,
} from './openspec-schema-contract.ts';
import { normalizeChangedPath } from './paths.ts';
import {
  assertPlanningPaths,
  requiredPlanningArtifactPaths,
} from './planning-paths.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';
import type {
  PlanningTaskState,
  PlanningTransitionReport,
} from './planning-report.ts';

export type PlanningInspection = {
  transitionKind: 'introduction' | 'revision';
  schemaName: ManagedSchemaName;
  contract: ReturnType<typeof loadChangeContract>;
  beforeTasks: ParsedTask[] | undefined;
  currentPaths: string[];
  artifactDigests: Record<string, string>;
};

export { assertPlanningPaths } from './planning-paths.ts';

export function inspectPlanningTransition(
  repositoryRoot: string,
  baselineHead: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
): PlanningInspection {
  const metadataPath = path.join(
    repositoryRoot,
    changeRoot,
    changeId,
    '.openspec.yaml',
  );
  const schemaName = readManagedSchemaName(repositoryRoot, metadataPath);
  // A planning introduction has no prior generation to consult, and a revision
  // must not be able to reach behind its own parent, so both are decided from
  // the candidate parent plus the configured protected base. Activation is
  // monotonic across those baselines: a stale branch that omits the marker
  // still cannot select legacy once the protected base carries the anchor.
  assertInvestigationPlanningActivation({
    repositoryRoot,
    baselines: [baselineHead, ...protectedActivationBaselines(repositoryRoot)],
    readMarker: () => readActivationMarkerFile(repositoryRoot),
    declaredSchemaName: schemaName,
  });
  assertPlanningPaths(
    changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
    schemaName,
  );
  const currentPaths = assertPlanningArtifactTree(
    repositoryRoot,
    changeRoot,
    changeId,
    schemaName,
  );
  const tasksPath = `${changeRoot}/${changeId}/tasks.md`;
  const beforeTaskContent = readFileAtCommit(
    repositoryRoot,
    baselineHead,
    tasksPath,
  );
  const beforeTasks = beforeTaskContent
    ? parseTasks(beforeTaskContent)
    : undefined;
  const baselinePaths = listTreePaths(
    repositoryRoot,
    baselineHead,
    `${changeRoot}/${changeId}`,
  );
  const transitionKind = beforeTasks ? 'revision' : 'introduction';
  if (
    transitionKind === 'introduction' &&
    (baselinePaths.length > 0 ||
      JSON.stringify(currentPaths) !== JSON.stringify(changedPaths))
  ) {
    throw workflowError(
      'PLANNING_INTRODUCTION_INVALID',
      'A planning introduction must add one complete new planning tree.',
      ExitCode.guard,
    );
  }
  const contract = loadChangeContract(repositoryRoot, changeId, schemaName);
  assertPlanningTaskHistory(beforeTasks, contract.tasks);
  const artifactDigests = digestArtifacts(repositoryRoot, [
    ...contract.artifactPaths,
    metadataPath,
  ]);
  return {
    transitionKind,
    schemaName,
    contract,
    beforeTasks,
    currentPaths,
    artifactDigests,
  };
}

export function validateOpenSpecPlanning(
  repositoryRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName,
): Pick<PlanningTransitionReport, 'openspec' | 'planningAssurance'> {
  const validated = loadStableValidatedChangeContract(
    discoverRepository(repositoryRoot),
    changeId,
  ).contract;
  if (validated.schemaName !== schemaName) {
    throw workflowError(
      'OPENSPEC_CHANGE_STATE_CHANGED',
      'Managed change schema selection changed during planning validation.',
      ExitCode.staleState,
    );
  }
  return {
    openspec: validated.openspec,
    planningAssurance: validated.planningAssurance,
  };
}

export function assertPlanningTaskHistory(
  before: ParsedTask[] | undefined,
  after: ParsedTask[],
): void {
  if (!before) {
    if (after.some(({ completed }) => completed)) {
      throw invalidTaskState();
    }
    return;
  }
  const beforeById = new Map(before.map((task) => [task.id, task]));
  const afterById = new Map(after.map((task) => [task.id, task]));
  const invalidShared = after.some((task) => {
    const previous = beforeById.get(task.id);
    return previous ? previous.completed !== task.completed : task.completed;
  });
  const removedCompleted = before.some(
    (task) => task.completed && !afterById.has(task.id),
  );
  if (invalidShared || removedCompleted) {
    throw invalidTaskState();
  }
}

export function taskStates(tasks: ParsedTask[]): PlanningTaskState[] {
  return tasks.map(({ id, completed }) => ({ id, completed }));
}

function assertPlanningArtifactTree(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName,
): string[] {
  const changeDirectory = path.join(repositoryRoot, changeRoot, changeId);
  const files: string[] = [];
  walk(changeDirectory);
  const relativeFiles = files
    .map((filePath) => relative(repositoryRoot, filePath))
    .sort();
  assertPlanningPaths(changeRoot, changeId, relativeFiles, [], schemaName);
  const required = requiredPlanningArtifactPaths(
    changeRoot,
    changeId,
    schemaName,
  );
  if (
    required.some((requiredPath) => !relativeFiles.includes(requiredPath)) ||
    !relativeFiles.some((filePath) =>
      filePath.startsWith(`${changeRoot}/${changeId}/specs/`),
    )
  ) {
    throw workflowError(
      'PLANNING_TREE_INVALID',
      'Planning tree is missing a required artifact.',
      ExitCode.guard,
    );
  }
  return relativeFiles;

  function walk(directory: string): void {
    const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      !directoryStats?.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw unsafePlanningTree();
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = fs.lstatSync(entryPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        walk(entryPath);
      } else if (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        (stats.mode & 0o111) === 0 &&
        fs.realpathSync(entryPath) === path.resolve(entryPath)
      ) {
        files.push(entryPath);
      } else {
        throw unsafePlanningTree();
      }
    }
  }
}

function listTreePaths(
  repositoryRoot: string,
  commit: string,
  prefix: string,
): string[] {
  return runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    commit,
    '--',
    `:(literal)${prefix}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeChangedPath)
    .sort();
}

function readFileAtCommit(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string | undefined {
  return runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${filePath}`,
  ])
    ? runGit(repositoryRoot, ['show', `${commit}:${filePath}`])
    : undefined;
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function invalidTaskState() {
  return workflowError(
    'PLANNING_TASK_STATE_INVALID',
    'Planning transition may not project task completion state.',
    ExitCode.guard,
  );
}

function unsafePlanningTree() {
  return workflowError(
    'PLANNING_TREE_UNSAFE',
    'Planning artifacts must be canonical non-executable regular files.',
    ExitCode.unsafeEnvironment,
  );
}
