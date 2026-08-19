import fs from 'node:fs';
import path from 'node:path';

import { assertUniqueCollaborationGrantUses } from '../../modules/authority/collaboration-grant.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { collectHistoricalCollaborationGrantUses } from '../../ci-planning.ts';
import {
  loadWorkflowConfig,
  parseTasks,
  type ManagedSchemaName,
} from '../../contracts.ts';
import { readFileAtCommit } from '../../ci-git.ts';
import { assertDocumentationClosureCommitCurrent } from '../../documentation-closure.ts';
import { documentationClosureActivationAtCommit } from '../../documentation-closure-activation.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertInvestigationPlanningActivation,
  readActivationMarkerFile,
} from '../../openspec-schema-contract.ts';
import { validateInvestigationFirstPlanningReadiness } from '../../modules/assurance/planning-assurance-validator.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  protectedBranchRef,
  runGit,
} from '../../git.ts';
import { preEpochCompletedTaskIds } from '../../bootstrap-task-exemption.ts';
import type { TaskCommit } from '../../git-transitions.ts';
import { committedPlanningGeneration } from '../../planning-generation-history.ts';
import { ensurePlanningExecutionEpochCompleteForArchive } from '../../modules/lifecycle/planning-execution-epoch.ts';
import { resolveTaskExecutionGenerationEvidence } from '../../modules/assurance/task-execution-evidence.ts';
import { withChangeTransitionAuthority } from '../../planning-lock.ts';
import {
  assertPlanningPaths,
  requiredPlanningArtifactPaths,
} from '../../modules/source/planning-paths.ts';
import { runtimePaths } from '../../session-store.ts';
import { loadStableValidatedChangeContract } from '../../validated-contract-context.ts';
import { completionDocumentPaths } from '../../managed-documents.ts';

export type ArchiveEligibility = {
  changeId: string;
  repositoryRoot: string;
  repositoryRealPath: string;
  gitCommonDirectory: string;
  branch: string;
  head: string;
  tree: string;
  changeRoot: string;
  activeRoot: string;
  schemaName: ManagedSchemaName;
  activeArtifactPaths: string[];
  baseRef: string;
  base: string;
  contractDigest: string;
  artifactDigests: Record<string, string>;
  artifactModes: Record<string, '100644' | '100755'>;
  taskCommits: Array<TaskCommit & { taskId: string }>;
  targetPaths: string[];
  archiveDestination: string;
  fingerprint: string;
};

export function withArchiveEligibility<T>(
  cwd: string,
  requestedChangeId: string,
  operation: (
    eligibility: ArchiveEligibility,
    assertOwned: () => void,
    refreshEligibility: (now: Date) => ArchiveEligibility,
  ) => T,
  now = new Date(),
): T {
  const initial = discoverRepository(cwd);
  const config = loadWorkflowConfig(initial.repositoryRoot);
  const runtime = runtimePaths(
    initial.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withChangeTransitionAuthority(
    runtime,
    requestedChangeId,
    'archive',
    (assertOwned) => {
      const eligibility = inspectEligibility(
        initial.repositoryRoot,
        requestedChangeId,
        now,
      );
      assertOwned();
      return operation(eligibility, assertOwned, (refreshedNow) => {
        assertOwned();
        const refreshed = inspectEligibility(
          initial.repositoryRoot,
          requestedChangeId,
          refreshedNow,
        );
        assertOwned();
        assertRolloverRefreshStable(eligibility, refreshed, refreshedNow);
        return refreshed;
      });
    },
  );
}

function assertRolloverRefreshStable(
  original: ArchiveEligibility,
  refreshed: ArchiveEligibility,
  refreshedNow: Date,
): void {
  if (refreshed.head !== original.head) {
    throw archiveError(
      'ARCHIVE_HEAD_CHANGED',
      'Archive eligibility refresh may not adopt a concurrent commit.',
    );
  }

  const stableOriginal = stableRefreshAuthority(original);
  const stableRefreshed = stableRefreshAuthority(refreshed);
  const originalDate = archiveDestinationDate(original);
  const refreshedDate = utcDate(refreshedNow);
  const expectedDate = nextUtcDate(originalDate);
  const expectedDestination = `${original.changeRoot}/archive/${expectedDate}-${original.changeId}`;
  const expectedTargets = original.targetPaths
    .map((targetPath) =>
      targetPath === original.archiveDestination
        ? expectedDestination
        : targetPath,
    )
    .sort();
  if (
    canonicalJson(stableRefreshed) !== canonicalJson(stableOriginal) ||
    refreshedDate !== expectedDate ||
    refreshed.archiveDestination !== expectedDestination ||
    canonicalJson(refreshed.targetPaths) !== canonicalJson(expectedTargets) ||
    refreshed.fingerprint !== original.fingerprint
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Archive eligibility refresh changed state beyond the exact UTC-date projection.',
    );
  }
}

function stableRefreshAuthority(eligibility: ArchiveEligibility) {
  return {
    changeId: eligibility.changeId,
    repositoryRoot: eligibility.repositoryRoot,
    repositoryRealPath: eligibility.repositoryRealPath,
    gitCommonDirectory: eligibility.gitCommonDirectory,
    branch: eligibility.branch,
    head: eligibility.head,
    tree: eligibility.tree,
    changeRoot: eligibility.changeRoot,
    activeRoot: eligibility.activeRoot,
    schemaName: eligibility.schemaName,
    activeArtifactPaths: eligibility.activeArtifactPaths,
    baseRef: eligibility.baseRef,
    base: eligibility.base,
    contractDigest: eligibility.contractDigest,
    artifactDigests: eligibility.artifactDigests,
    artifactModes: eligibility.artifactModes,
    taskCommits: eligibility.taskCommits,
  };
}

function archiveDestinationDate(eligibility: ArchiveEligibility): string {
  const prefix = `${eligibility.changeRoot}/archive/`;
  const suffix = `-${eligibility.changeId}`;
  if (
    !eligibility.archiveDestination.startsWith(prefix) ||
    !eligibility.archiveDestination.endsWith(suffix)
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Archive eligibility has a non-canonical dated destination.',
    );
  }
  const date = eligibility.archiveDestination.slice(
    prefix.length,
    -suffix.length,
  );
  if (!isUtcDate(date)) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Archive eligibility has a non-canonical dated destination.',
    );
  }
  return date;
}

function nextUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return utcDate(date);
}

function isUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && utcDate(date) === value;
}

function inspectEligibility(
  repositoryRoot: string,
  requestedChangeId: string,
  now: Date,
): ArchiveEligibility {
  const initial = discoverRepository(repositoryRoot);
  if (initial.statusEntries.length > 0) {
    throw archiveError(
      'ARCHIVE_WORKTREE_DIRTY',
      'Archive requires a clean worktree and index.',
      { statusEntries: initial.statusEntries },
    );
  }
  if (!initial.branch) {
    throw archiveError(
      'ARCHIVE_BRANCH_REQUIRED',
      'Archive requires an attached branch.',
    );
  }

  const config = loadWorkflowConfig(initial.repositoryRoot);
  const protectedBranch = config.protectedBranches[0];
  if (!protectedBranch) {
    throw archiveError(
      'ARCHIVE_BASE_REF_REQUIRED',
      'workflow/config.json must configure a protected archive base.',
    );
  }
  const baseRef = protectedBranchRef(protectedBranch);
  const base = resolveBase(initial.repositoryRoot, baseRef);
  assertAncestor(
    initial.repositoryRoot,
    base,
    initial.head,
    'ARCHIVE_BASE_NOT_ANCESTOR',
    'The configured archive base must be an ancestor of HEAD.',
  );

  // Archiving replays an immutable generation, so an activated repository may
  // still archive a legacy change; what it may not do is archive out of a
  // checkout that has dropped the reviewed marker.
  assertInvestigationPlanningActivation({
    repositoryRoot: initial.repositoryRoot,
    baselines: [initial.head],
    readMarker: () => readActivationMarkerFile(initial.repositoryRoot),
  });

  const stable = loadStableValidatedChangeContract(initial, requestedChangeId);
  const { contract, git } = stable;
  if (!git.branch) {
    throw archiveError(
      'ARCHIVE_BRANCH_REQUIRED',
      'Archive requires an attached branch.',
    );
  }
  const activePrefix = `${config.changeRoot}/${contract.changeId}/`;
  const activeArtifactPaths = Object.keys(contract.artifactDigests)
    .filter((artifactPath) => artifactPath.startsWith(activePrefix))
    .sort();
  assertPlanningPaths(
    config.changeRoot,
    contract.changeId,
    activeArtifactPaths,
    [],
    contract.schemaName,
  );
  const requiredArtifactPaths = requiredPlanningArtifactPaths(
    config.changeRoot,
    contract.changeId,
    contract.schemaName,
  );
  if (
    requiredArtifactPaths.some(
      (requiredPath) => !activeArtifactPaths.includes(requiredPath),
    ) ||
    !activeArtifactPaths.some(
      (artifactPath) =>
        artifactPath.startsWith(`${activePrefix}specs/`) &&
        artifactPath.endsWith('/spec.md'),
    )
  ) {
    throw archiveError(
      'ARCHIVE_ARTIFACT_MANIFEST_INVALID',
      'Archive eligibility requires the complete schema-selected planning manifest.',
    );
  }
  if (contract.schemaName === 'expense-app-v2') {
    // The contract loader already replayed current semantic readiness with the
    // shared validator. Archive additionally decides one-use grant uniqueness
    // over every exact planning transition in this change's immutable history;
    // a singleton current role result cannot reveal an earlier reuse.
    const { grantUse } = validateInvestigationFirstPlanningReadiness(
      initial.repositoryRoot,
      contract,
    ).roleResult;
    const historicalUses = collectHistoricalCollaborationGrantUses(
      git.repositoryRoot,
      git.head,
      contract.changeId,
      config.changeRoot,
    );
    assertUniqueCollaborationGrantUses(historicalUses);
    if (
      grantUse !== null &&
      !historicalUses.some(
        (use) =>
          use.grantId === grantUse.grantId &&
          use.signedEnvelopeDigest === grantUse.signedEnvelopeDigest &&
          use.transitionDigest === grantUse.transitionDigest,
      )
    ) {
      throw archiveError(
        'ARCHIVE_COLLABORATION_GRANT_HISTORY_MISMATCH',
        'The current collaboration grant use is absent from managed planning history.',
      );
    }
  }

  const incomplete = contract.tasks
    .filter(({ completed }) => !completed)
    .map(({ id }) => id);
  if (incomplete.length > 0) {
    throw archiveError(
      'ARCHIVE_TASKS_INCOMPLETE',
      'Every task must be completed before archive.',
      { taskIds: incomplete },
    );
  }

  const exemptTaskIds = preEpochCompletedTaskIds(
    git.repositoryRoot,
    config.changeRoot,
    contract.changeId,
    git.head,
  );
  const executionGeneration = resolveTaskExecutionGenerationEvidence(
    git.repositoryRoot,
    config.changeRoot,
    contract.changeId,
    contract.tasks.map(({ id }) => id),
    git.head,
  );
  const taskCommits = contract.tasks.flatMap(({ id: taskId }) => {
    const commits = executionGeneration.commitsByTask[taskId] ?? [];
    if (commits.length !== 1) {
      if (executionGeneration.boundary === null && exemptTaskIds.has(taskId)) {
        return [];
      }
      throw archiveError(
        commits.length === 0
          ? 'ARCHIVE_TASK_EVIDENCE_MISSING'
          : 'ARCHIVE_TASK_EVIDENCE_AMBIGUOUS',
        'Each completed task requires exactly one canonical workflow commit.',
        { taskId, commitHashes: commits.map(({ hash }) => hash) },
      );
    }
    const [commit] = commits;
    assertAncestor(
      git.repositoryRoot,
      commit.hash,
      base,
      'ARCHIVE_TASK_COMMIT_UNREACHABLE',
      'Every task commit must be reachable from the configured archive base.',
      { taskId, commitHash: commit.hash },
    );
    return [{ ...commit, taskId }];
  });
  assertArchiveDocumentationClosure({
    repositoryRoot: git.repositoryRoot,
    head: git.head,
    changeId: contract.changeId,
    tasksPath: `${activePrefix}tasks.md`,
    taskCommits,
    completionPaths: completionDocumentPaths(git.repositoryRoot),
  });
  ensurePlanningExecutionEpochCompleteForArchive(git.repositoryRoot, {
    changeId: contract.changeId,
    head: git.head,
    planningGeneration: committedPlanningGeneration(
      git.repositoryRoot,
      git.head,
      config.changeRoot,
      contract.changeId,
    ),
    taskEvidence: contract.tasks.map(({ id: taskId }) => {
      const commit = taskCommits.find(
        ({ taskId: committedTaskId }) => committedTaskId === taskId,
      );
      return commit === undefined
        ? {
            taskId,
            source: 'pre-epoch-exemption' as const,
            commitHash: null,
          }
        : {
            taskId,
            source: 'managed-task-commit' as const,
            commitHash: commit.hash,
          };
    }),
    now,
  });

  const date = utcDate(now);
  const archiveDestination = `${config.changeRoot}/archive/${date}-${contract.changeId}`;
  const targetPaths = inspectArchiveTargets(
    git.repositoryRoot,
    config.changeRoot,
    contract.changeId,
    archiveDestination,
  );
  const current = discoverRepository(git.repositoryRoot);
  if (
    current.repositoryRealPath !== git.repositoryRealPath ||
    current.gitCommonDirectory !== git.gitCommonDirectory ||
    current.branch !== git.branch ||
    current.head !== git.head ||
    current.tree !== git.tree ||
    current.statusEntries.length > 0
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Repository identity or state changed during archive eligibility checks.',
    );
  }

  return {
    changeId: contract.changeId,
    repositoryRoot: git.repositoryRoot,
    repositoryRealPath: git.repositoryRealPath,
    gitCommonDirectory: git.gitCommonDirectory,
    branch: git.branch,
    head: git.head,
    tree: git.tree,
    changeRoot: config.changeRoot,
    activeRoot: activePrefix.slice(0, -1),
    schemaName: contract.schemaName,
    activeArtifactPaths,
    baseRef,
    base,
    contractDigest: contract.contractDigest,
    artifactDigests: contract.artifactDigests,
    artifactModes: contract.artifactModes,
    taskCommits,
    targetPaths,
    archiveDestination,
    fingerprint: fingerprintRepositoryWorktree(git.repositoryRoot, git.head),
  };
}

function assertArchiveDocumentationClosure(input: {
  repositoryRoot: string;
  head: string;
  changeId: string;
  tasksPath: string;
  taskCommits: readonly (TaskCommit & { taskId: string })[];
  completionPaths: readonly string[];
}): void {
  if (input.taskCommits.length === 0) return;
  const finalCandidates = input.taskCommits.filter(({ hash }) => {
    const tasks = readFileAtCommit(input.repositoryRoot, hash, input.tasksPath);
    return (
      tasks !== undefined &&
      parseTasks(tasks).every(({ completed }) => completed)
    );
  });
  if (finalCandidates.length !== 1) {
    throw archiveError(
      'ARCHIVE_DOCUMENTATION_CLOSURE_INVALID',
      'Archive requires one canonical final managed task commit.',
      { commitHashes: finalCandidates.map(({ hash }) => hash) },
    );
  }
  const finalCommit = finalCandidates[0]!;
  const finalParent = runGit(input.repositoryRoot, [
    'rev-parse',
    `${finalCommit.hash}^`,
  ]).trim();
  const activation = documentationClosureActivationAtCommit(
    input.repositoryRoot,
    finalParent,
  );
  if (!activation.activated) return;
  documentationClosureActivationAtCommit(input.repositoryRoot, input.head);
  const taskHashes = new Set(input.taskCommits.map(({ hash }) => hash));
  const firstTaskCommit = runGit(input.repositoryRoot, [
    'rev-list',
    '--reverse',
    '--topo-order',
    input.head,
  ])
    .split('\n')
    .find((hash) => taskHashes.has(hash));
  if (firstTaskCommit === undefined) {
    throw archiveError(
      'ARCHIVE_DOCUMENTATION_CLOSURE_INVALID',
      'Archive cannot resolve the first managed task commit.',
    );
  }
  const changeBaseCommit = runGit(input.repositoryRoot, [
    'rev-parse',
    `${firstTaskCommit}^`,
  ]).trim();
  try {
    assertDocumentationClosureCommitCurrent({
      repositoryRoot: input.repositoryRoot,
      commitHash: finalCommit.hash,
      changeId: input.changeId,
      taskId: finalCommit.taskId,
      changeBaseCommit,
      allowedProjectionPaths: [input.tasksPath, ...input.completionPaths],
    });
  } catch {
    throw archiveError(
      'ARCHIVE_DOCUMENTATION_CLOSURE_INVALID',
      'The final managed task documentation closure is missing, malformed, or stale.',
      { taskId: finalCommit.taskId, commitHash: finalCommit.hash },
    );
  }
}

function inspectArchiveTargets(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  archiveDestination: string,
): string[] {
  const activeRoot = `${changeRoot}/${changeId}`;
  assertPlainAncestors(repositoryRoot, activeRoot);
  assertPlainDirectory(repositoryRoot, activeRoot, true);
  assertPlainAncestors(repositoryRoot, `${changeRoot}/archive`);
  assertPlainDirectory(repositoryRoot, `${changeRoot}/archive`, false);
  const destinationPath = path.join(repositoryRoot, archiveDestination);
  if (fs.lstatSync(destinationPath, { throwIfNoEntry: false })) {
    throw archiveError(
      'ARCHIVE_DESTINATION_COLLISION',
      'The dated archive destination already exists.',
      { archiveDestination },
    );
  }

  const deltaRoot = path.join(repositoryRoot, activeRoot, 'specs');
  const capabilities = fs
    .readdirSync(deltaRoot, { withFileTypes: true })
    .filter(({ name }) => name !== '.DS_Store')
    .map((entry) => {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)
      ) {
        throw archiveError(
          'ARCHIVE_TARGET_UNSAFE',
          'Archive delta capability targets are unsafe.',
        );
      }
      return entry.name;
    })
    .sort();
  const baseSpecs = capabilities.map(
    (capability) => `openspec/specs/${capability}/spec.md`,
  );
  for (const baseSpec of baseSpecs) {
    assertPlainAncestors(repositoryRoot, baseSpec);
    assertPlainFile(repositoryRoot, baseSpec, false);
  }
  return [activeRoot, archiveDestination, ...baseSpecs].sort();
}

function assertPlainAncestors(
  repositoryRoot: string,
  relativePath: string,
): void {
  const segments = relativePath.split('/').slice(0, -1);
  let current = repositoryRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) return;
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw archiveError(
        'ARCHIVE_TARGET_UNSAFE',
        'Archive target ancestors must be canonical plain directories.',
        { path: path.relative(repositoryRoot, current) },
      );
    }
  }
}

function assertPlainDirectory(
  repositoryRoot: string,
  relativePath: string,
  required: boolean,
): void {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!stats && !required) return;
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(absolutePath) !== absolutePath
  ) {
    throw archiveError(
      'ARCHIVE_TARGET_UNSAFE',
      'Archive targets must be canonical plain directories.',
      { path: relativePath },
    );
  }
}

function assertPlainFile(
  repositoryRoot: string,
  relativePath: string,
  required: boolean,
): void {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!stats && !required) return;
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(absolutePath) !== absolutePath ||
    (stats.mode & 0o111) !== 0
  ) {
    throw archiveError(
      'ARCHIVE_TARGET_UNSAFE',
      'Archive targets must be canonical non-executable files.',
      { path: relativePath },
    );
  }
}

function resolveBase(repositoryRoot: string, baseRef: string): string {
  const base = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${baseRef}^{commit}`],
    true,
  ).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) {
    throw archiveError(
      'ARCHIVE_BASE_UNRESOLVED',
      'The configured archive base does not resolve to a commit.',
      { baseRef },
    );
  }
  return base;
}

function assertAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  const mergeBase = runGit(
    repositoryRoot,
    ['merge-base', ancestor, descendant],
    true,
  ).trim();
  if (mergeBase !== ancestor) {
    throw archiveError(code, message, details);
  }
}

function utcDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw archiveError('ARCHIVE_DATE_INVALID', 'Archive date is invalid.');
  }
  return value.toISOString().slice(0, 10);
}

function archiveError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
