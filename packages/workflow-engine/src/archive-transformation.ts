import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveEligibility } from './archive-eligibility.ts';
import {
  assertPlainArchiveOutputFile,
  listPlainArchiveFiles,
} from './archive-output-safety.ts';
import { readFileAtCommit } from './ci-git.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  listChangedPaths,
  runGit,
} from './git.ts';
import {
  createOpenSpecProcess,
  resolveOpenSpecInstallation,
} from './openspec-executor.ts';
import { parseValidation } from './openspec-payloads.ts';

export type ArchiveTransformation = {
  changeId: string;
  archiveName: string;
  archivePath: string;
  baseSpecPaths: string[];
  changedPaths: string[];
  patch: string;
  patchDigest: string;
  tree: string;
  archivedArtifactDigests: Record<string, string>;
  openspecVersion: '1.6.0';
  totals?: ArchiveTotals;
};

type ArchiveTotals = {
  added: number;
  modified: number;
  removed: number;
  renamed: number;
};

type ArchivePayload = {
  archivedAs: string;
  specsUpdated: boolean;
  totals?: ArchiveTotals;
};

export function createArchiveTransformation(
  eligibility: ArchiveEligibility,
): ArchiveTransformation {
  assertEligibilityCurrent(eligibility);
  const installation = resolveOpenSpecInstallation(eligibility.repositoryRoot);
  const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
  if (!temporaryBase) {
    throw archiveError(
      'ARCHIVE_TEMPORARY_DIRECTORY_UNAVAILABLE',
      'A trusted temporary directory is required for archive.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-archive-'),
  );
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    runGit(eligibility.repositoryRoot, [
      'worktree',
      'add',
      '--detach',
      worktree,
      eligibility.head,
    ]);
    worktreeAdded = true;
    assertDetachedWorktree(worktree, eligibility);
    const openspec = createOpenSpecProcess(installation, {
      executionRoot: worktree,
    });
    let document: { value: unknown; status: number };
    try {
      document = openspec.archive(eligibility.changeId);
    } catch (error) {
      throw archiveFailure(error);
    }
    const payload = parseArchivePayload(document.value, worktree, eligibility);
    const result = verifyTransformation(
      worktree,
      eligibility,
      payload,
      installation.version,
    );
    validateRebuiltSpecs(openspec, worktree);
    assertTemporaryProjectionCurrent(worktree, eligibility, result);
    assertEligibilityCurrent(eligibility);
    return result;
  } finally {
    if (worktreeAdded) {
      runGit(eligibility.repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        worktree,
      ]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyTransformation(
  worktree: string,
  eligibility: ArchiveEligibility,
  payload: ArchivePayload,
  openspecVersion: '1.6.0',
): ArchiveTransformation {
  const activeRoot = `openspec/changes/${eligibility.changeId}`;
  const activeFiles = listTreeFiles(worktree, eligibility.head, activeRoot);
  const archivedFiles = listPlainArchiveFiles(worktree, payloadPath(payload));
  const expectedArchivedFiles = activeFiles.map(
    (filePath) =>
      `${payloadPath(payload)}/${filePath.slice(activeRoot.length + 1)}`,
  );
  const archivedArtifactDigests: Record<string, string> = {};
  if (JSON.stringify(archivedFiles) !== JSON.stringify(expectedArchivedFiles)) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archived files do not exactly mirror the active change.',
    );
  }
  for (let index = 0; index < activeFiles.length; index += 1) {
    const before = readFileAtCommit(
      worktree,
      eligibility.head,
      activeFiles[index],
    );
    const after = fs.readFileSync(path.join(worktree, archivedFiles[index]));
    if (before === undefined || !Buffer.from(before).equals(after)) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        'Archived file content differs from the active change.',
      );
    }
    archivedArtifactDigests[
      archivedFiles[index].slice(payloadPath(payload).length + 1)
    ] = crypto.createHash('sha256').update(after).digest('hex');
  }

  const changedPaths = listChangedPaths(worktree, eligibility.head);
  const allowed = new Set([
    ...activeFiles,
    ...expectedArchivedFiles,
    ...eligibility.targetPaths.filter((target) =>
      target.startsWith('openspec/specs/'),
    ),
  ]);
  if (
    changedPaths.some((changedPath) => !allowed.has(changedPath)) ||
    activeFiles.some((activeFile) => !changedPaths.includes(activeFile)) ||
    expectedArchivedFiles.some(
      (archivedFile) => !changedPaths.includes(archivedFile),
    )
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_PATHS_INVALID',
      'Archive transformation changed paths outside its exact targets.',
      { changedPaths },
    );
  }
  const baseSpecPaths = changedPaths.filter((changedPath) =>
    changedPath.startsWith('openspec/specs/'),
  );
  for (const baseSpecPath of baseSpecPaths) {
    assertPlainArchiveOutputFile(worktree, baseSpecPath);
  }
  if (payload.specsUpdated !== baseSpecPaths.length > 0) {
    throw archiveError(
      'OPENSPEC_ARCHIVE_PAYLOAD_INVALID',
      'OpenSpec spec-update output contradicts the Git transformation.',
    );
  }

  stageTemporaryProjection(worktree, eligibility.head, changedPaths);
  const patch = runGit(worktree, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-renames',
    eligibility.head,
    '--',
    ...changedPaths.map((changedPath) => `:(literal)${changedPath}`),
  ]);
  if (!patch || !/^diff --git /m.test(patch)) {
    throw archiveError(
      'ARCHIVE_PATCH_INVALID',
      'Archive did not produce a non-empty full-index patch.',
    );
  }
  const tree = runGit(worktree, ['write-tree']).trim();
  return {
    changeId: eligibility.changeId,
    archiveName: payload.archivedAs,
    archivePath: payloadPath(payload),
    baseSpecPaths,
    changedPaths,
    patch,
    patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
    tree,
    archivedArtifactDigests,
    openspecVersion,
    ...(payload.totals ? { totals: payload.totals } : {}),
  };
}

function assertTemporaryProjectionCurrent(
  worktree: string,
  eligibility: ArchiveEligibility,
  result: ArchiveTransformation,
): void {
  if (
    JSON.stringify(listChangedPaths(worktree, eligibility.head)) !==
    JSON.stringify(result.changedPaths)
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_CHANGED',
      'Temporary archive projection changed during validation.',
    );
  }
  const patch = runGit(worktree, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-renames',
    eligibility.head,
    '--',
    ...result.changedPaths.map((changedPath) => `:(literal)${changedPath}`),
  ]);
  if (
    crypto.createHash('sha256').update(patch).digest('hex') !==
    result.patchDigest
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_CHANGED',
      'Temporary archive patch changed during validation.',
    );
  }
}

function stageTemporaryProjection(
  worktree: string,
  head: string,
  changedPaths: string[],
): void {
  runGit(worktree, [
    'add',
    '-A',
    '--',
    ...changedPaths.map((changedPath) => `:(literal)${changedPath}`),
  ]);
  const staged = runGit(worktree, [
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    '-z',
    head,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(staged) !== JSON.stringify(changedPaths)) {
    throw archiveError(
      'ARCHIVE_PATCH_INVALID',
      'Temporary index does not contain the exact archive projection.',
    );
  }
}

function validateRebuiltSpecs(
  openspec: ReturnType<typeof createOpenSpecProcess>,
  worktree: string,
): void {
  const executed = openspec.validateAllSpecs();
  const validation = parseValidation(executed.value, {
    repositoryRoot: worktree,
    expectedType: 'spec',
  });
  if (executed.status !== 0 || !validation.valid) {
    throw archiveError(
      'ARCHIVE_REBUILT_SPECS_INVALID',
      'Strict validation rejected rebuilt base specs.',
    );
  }
}

function parseArchivePayload(
  value: unknown,
  worktree: string,
  eligibility: ArchiveEligibility,
): ArchivePayload {
  if (!isRecord(value) || !hasExactKeys(value, ['archive', 'root'])) {
    throw invalidPayload();
  }
  const root = value.root;
  const archive = value.archive;
  if (
    !isRecord(root) ||
    !hasExactKeys(root, ['path', 'source']) ||
    root.path !== worktree ||
    root.source !== 'nearest' ||
    !isRecord(archive) ||
    !hasArchiveKeys(archive) ||
    archive.change !== eligibility.changeId ||
    archive.archivedAs !== path.basename(eligibility.archiveDestination) ||
    archive.path !== path.join(worktree, eligibility.archiveDestination) ||
    archive.specsUpdated !== true
  ) {
    throw invalidPayload();
  }
  const totals = archive.totals;
  if (totals !== undefined && !isTotals(totals)) {
    throw invalidPayload();
  }
  return {
    archivedAs: archive.archivedAs as string,
    specsUpdated: archive.specsUpdated as boolean,
    ...(totals ? { totals } : {}),
  };
}

function assertDetachedWorktree(
  worktree: string,
  eligibility: ArchiveEligibility,
): void {
  const git = discoverRepository(worktree);
  if (
    git.repositoryRoot !== worktree ||
    git.repositoryRealPath !== worktree ||
    git.gitCommonDirectory !== eligibility.gitCommonDirectory ||
    git.branch !== null ||
    git.head !== eligibility.head ||
    git.tree !== eligibility.tree ||
    git.statusEntries.length > 0
  ) {
    throw archiveError(
      'ARCHIVE_WORKTREE_INVALID',
      'Temporary archive worktree is not the exact detached baseline.',
    );
  }
}

function assertEligibilityCurrent(eligibility: ArchiveEligibility): void {
  const git = discoverRepository(eligibility.repositoryRoot);
  if (
    git.repositoryRoot !== eligibility.repositoryRoot ||
    git.repositoryRealPath !== eligibility.repositoryRealPath ||
    git.gitCommonDirectory !== eligibility.gitCommonDirectory ||
    git.branch !== eligibility.branch ||
    git.head !== eligibility.head ||
    git.tree !== eligibility.tree ||
    git.statusEntries.length > 0 ||
    fingerprintRepositoryWorktree(git.repositoryRoot, git.head) !==
      eligibility.fingerprint
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Real repository state changed after archive eligibility.',
    );
  }
}

function listTreeFiles(
  repository: string,
  commit: string,
  root: string,
): string[] {
  return runGit(repository, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    commit,
    '--',
    `:(literal)${root}`,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
}

function payloadPath(payload: ArchivePayload): string {
  return `openspec/changes/archive/${payload.archivedAs}`;
}

function archiveFailure(error: unknown) {
  return workflowError(
    'OPENSPEC_ARCHIVE_FAILED',
    'Pinned OpenSpec archive execution failed inside the temporary worktree.',
    error instanceof WorkflowError ? error.exitCode : ExitCode.verification,
    {
      details: {
        causeCode: error instanceof WorkflowError ? error.code : undefined,
      },
    },
  );
}

function isTotals(value: unknown): value is ArchiveTotals {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['added', 'modified', 'removed', 'renamed']) &&
    ['added', 'modified', 'removed', 'renamed'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    )
  );
}

function hasArchiveKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(['archivedAs', 'change', 'path', 'specsUpdated']) ||
    JSON.stringify(keys) ===
      JSON.stringify(['archivedAs', 'change', 'path', 'specsUpdated', 'totals'])
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return hasKeys(value, keys) && Object.keys(value).length === keys.length;
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPayload() {
  return archiveError(
    'OPENSPEC_ARCHIVE_PAYLOAD_INVALID',
    'OpenSpec archive returned an invalid root, identity, or destination.',
  );
}

function archiveError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
