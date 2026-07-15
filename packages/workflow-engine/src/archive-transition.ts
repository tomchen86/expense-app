import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  withArchiveEligibility,
  type ArchiveEligibility,
} from './archive-eligibility.ts';
import { verifyArchiveDeltaOutcomes } from './archive-delta-verifier.ts';
import {
  listArchiveReports,
  readArchiveReport,
  writeArchiveReport,
  type ArchiveTransitionReport,
} from './archive-report.ts';
import {
  createArchiveTransformation,
  type ArchiveTransformation,
} from './archive-transformation.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import {
  archiveCommitMessage,
  commitChangedPaths,
  commitFacts,
  createArchiveCommitObject,
  listStagedPaths,
  updateManagedRef,
} from './git-transitions.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  listChangedPaths,
  runGit,
} from './git.ts';
import { runtimePaths } from './session-store.ts';

export type ArchiveTransitionResult = {
  status: 'committed' | 'already-archived';
  changeId: string;
  archivePath: string;
  commitHash: string;
  reportId: string;
  changedPaths: string[];
};

export type ArchiveTransitionTestHooks = {
  beforeApply?(context: { repositoryRoot: string }): void;
  beforeRefUpdate?(context: {
    repositoryRoot: string;
    headRef: string;
    commitHash: string;
    reportId: string;
  }): void;
};

export function commitArchiveTransition(
  cwd: string,
  requestedChangeId: string,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: ArchiveTransitionTestHooks = {},
): ArchiveTransitionResult {
  const existing = findExistingArchive(cwd, requestedChangeId);
  if (existing) return existing;
  return withArchiveEligibility(
    cwd,
    requestedChangeId,
    (eligibility, assertOwned) =>
      commitEligibleArchive(eligibility, environment, testHooks, assertOwned),
  );
}

function commitEligibleArchive(
  eligibility: ArchiveEligibility,
  environment: NodeJS.ProcessEnv,
  testHooks: ArchiveTransitionTestHooks,
  assertOwned: () => void,
): ArchiveTransitionResult {
  const transformation = createArchiveTransformation(eligibility);
  const delta = verifyArchiveDeltaOutcomes(
    eligibility.repositoryRoot,
    eligibility,
    transformation,
  );
  const headRef = `refs/heads/${eligibility.branch}`;
  if (
    runGit(
      eligibility.repositoryRoot,
      ['symbolic-ref', '--quiet', 'HEAD'],
      true,
    ).trim() !== headRef
  ) {
    throw archiveError(
      'ARCHIVE_HEAD_CHANGED',
      'Archive branch reference is not stable.',
    );
  }
  const commitHash = createArchiveCommitObject(
    eligibility.repositoryRoot,
    transformation.tree,
    eligibility.head,
    eligibility.changeId,
    environment,
  );
  assertArchiveCommit(
    eligibility.repositoryRoot,
    eligibility,
    transformation,
    commitHash,
  );
  const reportsDirectory = archiveReportsDirectory(eligibility.repositoryRoot);
  const report: ArchiveTransitionReport = {
    schemaVersion: 1,
    kind: 'archive-transition',
    createdAt: new Date().toISOString(),
    changeId: eligibility.changeId,
    archivePath: transformation.archivePath,
    parent: eligibility.head,
    tree: transformation.tree,
    commitHash,
    patch: transformation.patch,
    patchDigest: transformation.patchDigest,
    changedPaths: transformation.changedPaths,
    logicalIdentity: logicalIdentity(
      eligibility,
      transformation,
      delta.promotedSpecDigests,
    ),
    contractDigest: eligibility.contractDigest,
    promotedSpecDigests: delta.promotedSpecDigests,
    archivedArtifactDigests: transformation.archivedArtifactDigests,
  };
  const reportId = writeArchiveReport(reportsDirectory, report);
  const patchDirectory = path.join(
    eligibility.gitCommonDirectory,
    loadWorkflowConfig(eligibility.repositoryRoot).runtimeDirectory,
    'archive-patches',
  );
  ensurePlainDirectory(patchDirectory);
  const patchPath = path.join(patchDirectory, `${report.patchDigest}.patch`);
  writePatchOnce(patchPath, report.patch);

  let applied = false;
  let refUpdated = false;
  try {
    testHooks.beforeApply?.({ repositoryRoot: eligibility.repositoryRoot });
    assertOwned();
    assertRealState(eligibility, transformation, false);
    runGit(eligibility.repositoryRoot, [
      'apply',
      '--check',
      '--binary',
      '--index',
      patchPath,
    ]);
    runGit(eligibility.repositoryRoot, [
      'apply',
      '--binary',
      '--index',
      patchPath,
    ]);
    applied = true;
    assertRealState(eligibility, transformation, true);
    assertReportCurrent(reportsDirectory, reportId, report);
    testHooks.beforeRefUpdate?.({
      repositoryRoot: eligibility.repositoryRoot,
      headRef,
      commitHash,
      reportId,
    });
    assertOwned();
    assertRealState(eligibility, transformation, true);
    assertReportCurrent(reportsDirectory, reportId, report);
    if (
      runGit(
        eligibility.repositoryRoot,
        ['rev-parse', headRef],
        true,
      ).trim() !== eligibility.head
    ) {
      throw archiveError(
        'ARCHIVE_HEAD_CHANGED',
        'Archive branch changed before compare-and-swap.',
      );
    }
    updateManagedRef(
      eligibility.repositoryRoot,
      eligibility.head,
      commitHash,
      headRef,
    );
    refUpdated = true;
    if (
      discoverRepository(eligibility.repositoryRoot).statusEntries.length > 0
    ) {
      throw archiveError(
        'ARCHIVE_POSTCONDITION_FAILED',
        'Archive commit did not leave a clean repository.',
      );
    }
    return resultFromReport('committed', reportId, report);
  } catch (error) {
    if (applied && !refUpdated) rollbackPatch(eligibility, patchPath);
    throw error;
  }
}

function assertRealState(
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
  applied: boolean,
): void {
  const git = discoverRepository(eligibility.repositoryRoot);
  if (git.head !== eligibility.head) {
    throw archiveError(
      'ARCHIVE_HEAD_CHANGED',
      'Archive branch changed before compare-and-swap.',
    );
  }
  const expectedPaths = applied ? transformation.changedPaths : [];
  if (
    git.repositoryRealPath !== eligibility.repositoryRealPath ||
    git.gitCommonDirectory !== eligibility.gitCommonDirectory ||
    git.branch !== eligibility.branch ||
    JSON.stringify(listChangedPaths(git.repositoryRoot, git.head)) !==
      JSON.stringify(expectedPaths) ||
    JSON.stringify(listStagedPaths(git.repositoryRoot, git.head)) !==
      JSON.stringify(expectedPaths) ||
    (!applied &&
      fingerprintRepositoryWorktree(git.repositoryRoot, git.head) !==
        eligibility.fingerprint) ||
    (applied &&
      runGit(git.repositoryRoot, ['write-tree']).trim() !== transformation.tree)
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Real repository state changed before archive authorization completed.',
    );
  }
}

function assertArchiveCommit(
  repositoryRoot: string,
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
  commitHash: string,
): void {
  const facts = commitFacts(repositoryRoot, commitHash);
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([eligibility.head]) ||
    facts.tree !== transformation.tree ||
    facts.message !== `${archiveCommitMessage(eligibility.changeId)}\n` ||
    JSON.stringify(commitChangedPaths(repositoryRoot, commitHash)) !==
      JSON.stringify(transformation.changedPaths)
  ) {
    throw archiveError(
      'ARCHIVE_COMMIT_INVALID',
      'Archive commit object does not match the verified transformation.',
    );
  }
}

function rollbackPatch(
  eligibility: ArchiveEligibility,
  patchPath: string,
): void {
  try {
    runGit(eligibility.repositoryRoot, [
      'apply',
      '-R',
      '--binary',
      '--index',
      patchPath,
    ]);
    const git = discoverRepository(eligibility.repositoryRoot);
    if (
      listChangedPaths(git.repositoryRoot, eligibility.head).length > 0 ||
      listStagedPaths(git.repositoryRoot, eligibility.head).length > 0
    ) {
      throw new Error('rollback state mismatch');
    }
  } catch {
    throw archiveError(
      'ARCHIVE_ROLLBACK_FAILED',
      'Archive patch could not be rolled back safely.',
    );
  }
}

function findExistingArchive(
  cwd: string,
  changeId: string,
): ArchiveTransitionResult | undefined {
  const git = discoverRepository(cwd);
  if (git.statusEntries.length > 0) {
    throw archiveError(
      'ARCHIVE_WORKTREE_DIRTY',
      'Archive idempotency requires a clean repository.',
    );
  }
  const reports = listArchiveReports(
    archiveReportsDirectory(git.repositoryRoot),
    changeId,
  ).filter(
    ({ report }) =>
      report.commitHash === git.head ||
      isAncestor(git.repositoryRoot, report.commitHash, git.head),
  );
  const archiveRoot = path.join(git.repositoryRoot, 'openspec/changes/archive');
  const paths = fs
    .lstatSync(archiveRoot, { throwIfNoEntry: false })
    ?.isDirectory()
    ? fs
        .readdirSync(archiveRoot)
        .filter((entry) =>
          new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(changeId)}$`).test(
            entry,
          ),
        )
    : [];
  const active = fs.existsSync(
    path.join(git.repositoryRoot, 'openspec/changes', changeId),
  );
  if (paths.length === 0 && reports.length === 0) return undefined;
  if (active || paths.length !== 1 || reports.length !== 1) {
    throw archiveError(
      'ARCHIVE_IDEMPOTENCY_INVALID',
      'Archive identity is ambiguous or conflicts with an active change.',
    );
  }
  const [{ reportId, report }] = reports;
  const facts = commitFacts(git.repositoryRoot, report.commitHash);
  if (
    report.archivePath !== `openspec/changes/archive/${paths[0]}` ||
    facts.tree !== report.tree ||
    facts.message !== `${archiveCommitMessage(changeId)}\n` ||
    JSON.stringify(
      commitChangedPaths(git.repositoryRoot, report.commitHash),
    ) !== JSON.stringify(report.changedPaths)
  ) {
    throw archiveError(
      'ARCHIVE_IDEMPOTENCY_INVALID',
      'Archived path does not match its verified evidence.',
    );
  }
  return resultFromReport('already-archived', reportId, report);
}

function assertReportCurrent(
  directory: string,
  reportId: string,
  report: ArchiveTransitionReport,
): void {
  if (
    JSON.stringify(readArchiveReport(directory, reportId)) !==
    JSON.stringify(report)
  ) {
    throw archiveError('ARCHIVE_REPORT_STALE', 'Archive evidence changed.');
  }
}

function writePatchOnce(filePath: string, patch: string): void {
  try {
    fs.writeFileSync(filePath, patch, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isNodeError(error) ||
      error.code !== 'EEXIST' ||
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      fs.realpathSync(filePath) !== filePath ||
      fs.readFileSync(filePath, 'utf8') !== patch
    ) {
      throw archiveError(
        'ARCHIVE_PATCH_STORE_INVALID',
        'Archive patch store is unsafe.',
      );
    }
  }
}

function logicalIdentity(
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
  promotedSpecDigests: Record<string, string>,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        changeId: eligibility.changeId,
        archiveSuffix: eligibility.changeId,
        archivedArtifacts: transformation.archivedArtifactDigests,
        promotedSpecDigests,
      }),
    )
    .digest('hex');
}

function resultFromReport(
  status: ArchiveTransitionResult['status'],
  reportId: string,
  report: ArchiveTransitionReport,
): ArchiveTransitionResult {
  return {
    status,
    changeId: report.changeId,
    archivePath: report.archivePath,
    commitHash: report.commitHash,
    reportId,
    changedPaths: report.changedPaths,
  };
}

function archiveReportsDirectory(repositoryRoot: string): string {
  const git = discoverRepository(repositoryRoot);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return path.join(
    runtimePaths(git.gitCommonDirectory, config.runtimeDirectory).root,
    'archive-reports',
  );
}

function isAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  return (
    runGit(
      repositoryRoot,
      ['merge-base', ancestor, descendant],
      true,
    ).trim() === ancestor
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function archiveError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}
