import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  parseTasks,
  type ParsedTask,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import { createOpenSpecAdapter } from './openspec-adapter.ts';
import { normalizeChangedPath } from './paths.ts';
import type {
  PlanningTaskState,
  PlanningTransitionReport,
} from './planning-report.ts';

export type PlanningInspection = {
  transitionKind: 'introduction' | 'revision';
  schemaName: string;
  contract: ReturnType<typeof loadChangeContract>;
  beforeTasks: ParsedTask[] | undefined;
  currentPaths: string[];
  artifactDigests: Record<string, string>;
};

export function inspectPlanningTransition(
  repositoryRoot: string,
  baselineHead: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
): PlanningInspection {
  assertPlanningPaths(changeRoot, changeId, changedPaths);
  const currentPaths = assertPlanningArtifactTree(
    repositoryRoot,
    changeRoot,
    changeId,
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
  const contract = loadChangeContract(repositoryRoot, changeId);
  assertPlanningTaskHistory(beforeTasks, contract.tasks);
  const metadataPath = path.join(
    repositoryRoot,
    changeRoot,
    changeId,
    '.openspec.yaml',
  );
  const schemaName = parseSchemaName(fs.readFileSync(metadataPath, 'utf8'));
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
  schemaName: string,
): PlanningTransitionReport['openspec'] {
  const adapter = createOpenSpecAdapter(repositoryRoot);
  const status = adapter.status(changeId, schemaName);
  const validation = adapter.validateChange(changeId);
  if (!status.isComplete || !validation.valid) {
    throw workflowError(
      'OPENSPEC_CHANGE_INVALID',
      'OpenSpec status and strict validation must both accept the planning tree.',
      ExitCode.verification,
      {
        details: {
          statusComplete: status.isComplete,
          validationValid: validation.valid,
        },
      },
    );
  }
  return {
    version: adapter.version(),
    schemaName,
    statusComplete: true,
    validationValid: true,
  };
}

export function assertPlanningPaths(
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
): void {
  const prefix = `${changeRoot}/${changeId}/`;
  const exact = new Set([
    `${prefix}.openspec.yaml`,
    `${prefix}proposal.md`,
    `${prefix}design.md`,
    `${prefix}tasks.md`,
    `${prefix}guard.json`,
  ]);
  const invalid = changedPaths.filter((candidate) => {
    const normalized = normalizeChangedPath(candidate);
    if (exact.has(normalized)) {
      return false;
    }
    if (!normalized.startsWith(`${prefix}specs/`)) {
      return true;
    }
    const relative = normalized.slice(`${prefix}specs/`.length);
    const segments = relative.split('/');
    return (
      segments.length < 2 ||
      segments.at(-1) !== 'spec.md' ||
      segments
        .slice(0, -1)
        .some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))
    );
  });
  if (invalid.length > 0) {
    throw workflowError(
      'PLANNING_PATHS_INVALID',
      'Planning transition contains paths outside the named planning tree.',
      ExitCode.guard,
      { details: { invalidPaths: invalid.sort() } },
    );
  }
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
): string[] {
  const changeDirectory = path.join(repositoryRoot, changeRoot, changeId);
  const files: string[] = [];
  walk(changeDirectory);
  const relativeFiles = files
    .map((filePath) => relative(repositoryRoot, filePath))
    .sort();
  assertPlanningPaths(changeRoot, changeId, relativeFiles);
  const required = [
    '.openspec.yaml',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
  ].map((entry) => `${changeRoot}/${changeId}/${entry}`);
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

function parseSchemaName(metadata: string): string {
  const matches = metadata
    .split('\n')
    .map((line) => /^schema: ([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match));
  if (matches.length !== 1) {
    throw workflowError(
      'PLANNING_METADATA_INVALID',
      '.openspec.yaml must declare exactly one safe schema name.',
      ExitCode.guard,
    );
  }
  return matches[0][1];
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
