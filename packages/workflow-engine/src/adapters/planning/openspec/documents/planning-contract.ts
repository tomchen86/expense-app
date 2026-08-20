import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  parseTasks,
  readManagedSchemaName,
  type ManagedSchemaName,
  type ParsedTask,
} from '../../../consumer/expense-app/work-registry/contracts.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../../../runtime/repository-transaction/git.ts';
import type { PlanningProviderBindingReaderPort } from '../../../../modules/planning-provider/planning-provider-binding.ts';
import {
  assertInvestigationPlanningActivation,
  readActivationMarkerFile,
  protectedActivationBaselines,
} from './openspec-schema-contract.ts';
import { normalizeChangedPath } from '../../../../runtime/session-workspace/paths.ts';
import {
  assertPlanningPaths,
  requiredPlanningArtifactPaths,
} from '../../../../modules/source/planning-paths.ts';
import { loadStableValidatedChangeContract } from '../../../../composition-root/validated-contract-context.ts';
import type {
  PlanningTaskState,
  PlanningTransitionReport,
} from '../../../../runtime/storage-journal/planning-report.ts';
import type { ResolvedPlanningProviderBinding } from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { planningProviderBindingPath } from '../../../../modules/source/planning-paths.ts';
import {
  resolveCurrentOpenSpecPlanningTransitionBinding,
  resolveHistoricalOpenSpecProviderBinding as resolveHistoricalOpenSpecProviderBindingWithReader,
  resolveHistoricalOpenSpecPlanningTransitionBinding as resolveHistoricalOpenSpecPlanningTransitionBindingWithReader,
} from './openspec-provider-binding.ts';

export type PlanningInspection = {
  /** Completed tasks this transition reopened, named rather than counted. */
  reopenedTasks: string[];
  transitionKind: 'introduction' | 'revision';
  schemaName: ManagedSchemaName;
  contract: ReturnType<typeof loadChangeContract>;
  beforeTasks: ParsedTask[] | undefined;
  currentPaths: string[];
  artifactDigests: Record<string, string>;
  planningProvider: ResolvedPlanningProviderBinding;
};

export { assertPlanningPaths } from '../../../../modules/source/planning-paths.ts';

export function resolveHistoricalOpenSpecPlanningTransitionBinding(
  planningProviderReader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  parentCommit: string,
  candidateCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
): ResolvedPlanningProviderBinding {
  return resolveHistoricalOpenSpecPlanningTransitionBindingWithReader(
    planningProviderReader,
    repositoryRoot,
    parentCommit,
    candidateCommit,
    changeRoot,
    changeId,
    transitionKind,
  );
}

export function resolveHistoricalOpenSpecProviderBinding(
  planningProviderReader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
): ResolvedPlanningProviderBinding {
  return resolveHistoricalOpenSpecProviderBindingWithReader(
    planningProviderReader,
    repositoryRoot,
    commit,
    changeRoot,
    changeId,
  );
}

export function inspectPlanningTransition(
  planningProviderReader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  baselineHead: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  reopenAuthorized = false,
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
  const planningProvider = resolveCurrentOpenSpecPlanningTransitionBinding(
    planningProviderReader,
    repositoryRoot,
    baselineHead,
    changeRoot,
    changeId,
    transitionKind,
  );
  const bindingPath = planningProviderBindingPath(changeId);
  if (
    transitionKind === 'introduction' &&
    (baselinePaths.length > 0 ||
      JSON.stringify([...currentPaths, bindingPath].sort()) !==
        JSON.stringify(changedPaths))
  ) {
    throw workflowError(
      'PLANNING_INTRODUCTION_INVALID',
      'A planning introduction must add one complete new planning tree.',
      ExitCode.guard,
    );
  }
  const contract = loadChangeContract(repositoryRoot, changeId, schemaName);
  const reopenedTasks = assertPlanningTaskHistory(beforeTasks, contract.tasks, {
    reopenAuthorized: reopenAuthorized === true,
  });
  const artifactDigests = digestArtifacts(repositoryRoot, [
    ...contract.artifactPaths,
    metadataPath,
  ]);
  return {
    reopenedTasks,
    transitionKind,
    schemaName,
    contract,
    beforeTasks,
    currentPaths,
    artifactDigests,
    planningProvider,
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

/**
 * Whether an amendment declared its execution invalid and then left it marked
 * done.
 *
 * One definition, consulted by the transition and by CI replay alike. Two
 * copies of this condition is how an engine mints a commit its own replay
 * rejects, so the copies are gone: only the error each side raises differs.
 */
export function amendmentLeftWorkMarkedDone(input: {
  reopenAuthorized: boolean;
  reopenedTasks: readonly string[];
  beforeTasks: readonly ParsedTask[] | undefined;
}): boolean {
  return (
    input.reopenAuthorized &&
    input.reopenedTasks.length === 0 &&
    (input.beforeTasks ?? []).some(({ completed }) => completed)
  );
}

export function assertPlanningTaskHistory(
  before: ParsedTask[] | undefined,
  after: ParsedTask[],
  options: { reopenAuthorized?: boolean } = {},
): string[] {
  if (!before) {
    if (after.some(({ completed }) => completed)) {
      throw invalidTaskState();
    }
    return [];
  }
  const beforeById = new Map(before.map((task) => [task.id, task]));
  const afterById = new Map(after.map((task) => [task.id, task]));
  const removedCompleted = before.some(
    (task) => task.completed && !afterById.has(task.id),
  );
  if (removedCompleted) {
    // Dropping a completed task loses the record that it was ever done, which
    // no authorization makes acceptable.
    throw invalidTaskState();
  }

  const newlyCompleted = after.filter(
    (task) => !beforeById.get(task.id)?.completed && task.completed,
  );
  const reopened = after
    .filter((task) => beforeById.get(task.id)?.completed && !task.completed)
    .map(({ id }) => id);

  if (newlyCompleted.length > 0) {
    // A plan may not mark work done; only the task transition may.
    throw invalidTaskState();
  }
  if (reopened.length === 0) return [];
  if (!options.reopenAuthorized) {
    throw invalidTaskState();
  }

  // Authorized reopening is all or nothing. Reopening a chosen subset would be
  // a claim that the rest of the completed work is unaffected by the
  // correction, and nothing here can establish that; redoing everything is the
  // answer that does not require the claim.
  const previouslyCompleted = before
    .filter((task) => task.completed)
    .map(({ id }) => id);
  if (reopened.length !== previouslyCompleted.length) {
    throw workflowError(
      'AMENDMENT_PARTIAL_REOPEN',
      'An amendment that reopens execution reopens all of it; a chosen subset would claim the rest is unaffected.',
      ExitCode.verification,
      {
        details: {
          reopened,
          stillCompleted: previouslyCompleted.filter(
            (id) => !reopened.includes(id),
          ),
        },
      },
    );
  }
  return reopened.sort();
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

export function readFileAtCommit(
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
