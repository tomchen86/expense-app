import fs from 'node:fs';
import path from 'node:path';

import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  runGit,
} from './git.ts';
import { findExactTaskCommits, type TaskCommit } from './git-transitions.ts';
import { withChangeTransitionAuthority } from './planning-lock.ts';
import { runtimePaths } from './session-store.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';

export type ArchiveEligibility = {
  changeId: string;
  repositoryRoot: string;
  repositoryRealPath: string;
  gitCommonDirectory: string;
  branch: string;
  head: string;
  tree: string;
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
  operation: (eligibility: ArchiveEligibility, assertOwned: () => void) => T,
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
      return operation(eligibility, assertOwned);
    },
  );
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
  const baseRef = config.protectedBranches[0];
  if (!baseRef) {
    throw archiveError(
      'ARCHIVE_BASE_REF_REQUIRED',
      'workflow/config.json must configure a protected archive base.',
    );
  }
  const base = resolveBase(initial.repositoryRoot, baseRef);
  assertAncestor(
    initial.repositoryRoot,
    base,
    initial.head,
    'ARCHIVE_BASE_NOT_ANCESTOR',
    'The configured archive base must be an ancestor of HEAD.',
  );

  const stable = loadStableValidatedChangeContract(initial, requestedChangeId);
  const { contract, git } = stable;
  if (!git.branch) {
    throw archiveError(
      'ARCHIVE_BRANCH_REQUIRED',
      'Archive requires an attached branch.',
    );
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

  const taskCommits = contract.tasks.flatMap(({ id: taskId }) => {
    const commits = findExactTaskCommits(
      git.repositoryRoot,
      contract.changeId,
      taskId,
    );
    if (commits.length !== 1) {
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
