import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveEligibility } from './archive-eligibility.ts';
import {
  assertSpecDeltaPreconditions,
  verifyProjectedSpecDeltaOutcome,
  type SpecDeltaPreflightRecord,
} from '../../runtime/repository-transaction/archive-delta-verifier.ts';
import {
  assertPlainArchiveOutputFile,
  listPlainArchiveFiles,
} from '../../runtime/repository-transaction/archive-output-safety.ts';
import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';
import { readFileAtCommit } from '../../ci-git.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { createTrustedExecutionEnvironment } from '../../runtime/provider-execution/execution-environment.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  listChangedPaths,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  createOpenSpecProcess,
  resolveOpenSpecInstallation,
} from '../../adapters/planning/openspec/documents/openspec-executor.ts';
import { parseValidation } from '../../adapters/planning/openspec/documents/openspec-payloads.ts';
import {
  assertPlanningPaths,
  requiredPlanningArtifactPaths,
} from '../../modules/source/planning-paths.ts';
import {
  assertChangeId,
  normalizeChangedPath,
} from '../../runtime/session-workspace/paths.ts';

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

export type ArchiveApplicabilityProjectionInput = {
  repositoryRoot: string;
  changeRoot: string;
  changeId: string;
  baselineCommit: string;
  sourceCommit: string;
  activeArtifactPaths: string[];
  source: 'worktree' | 'commit';
  now?: Date;
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

type PublicArchivePayload = ArchivePayload & { archivePath: string };

export function createArchiveTransformation(
  eligibility: ArchiveEligibility,
  options: { now?: () => Date } = {},
): ArchiveTransformation {
  assertEligibilityCurrent(eligibility);
  assertEligibilityArtifactManifest(eligibility);
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
    const payload = parseArchivePayload(
      document.value,
      worktree,
      eligibility,
      options.now ?? (() => new Date()),
    );
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

/**
 * Execute the same pinned public OpenSpec archive used by the real archive
 * transition, but only inside a disposable detached worktree. Planning uses a
 * byte-exact overlay of its reviewed worktree artifacts; CI uses only the
 * immutable planning commit. Neither path imports OpenSpec private modules or
 * mutates a repository ref.
 */
export function createArchiveApplicabilityProjection(
  input: ArchiveApplicabilityProjectionInput,
): SpecDeltaPreflightRecord {
  const repository = discoverRepository(input.repositoryRoot);
  const { baselineCommit, changeId, changeRoot, sourceCommit, validatedAt } =
    assertArchiveApplicabilityInput(repository, input);
  const activeRoot = `${changeRoot}/${changeId}`;
  const activeArtifactPaths = assertProjectionArtifactPaths(
    activeRoot,
    input.activeArtifactPaths,
  );
  const installation = resolveOpenSpecInstallation(repository.repositoryRoot);
  const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
  if (!temporaryBase) {
    throw archiveError(
      'ARCHIVE_TEMPORARY_DIRECTORY_UNAVAILABLE',
      'A trusted temporary directory is required for archive applicability.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-applicability-'),
  );
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    runGit(repository.repositoryRoot, [
      'worktree',
      'add',
      '--detach',
      worktree,
      sourceCommit,
    ]);
    worktreeAdded = true;
    assertProjectionWorktree(
      worktree,
      repository.gitCommonDirectory,
      sourceCommit,
    );
    if (input.source === 'worktree') {
      overlayPlanningArtifacts(
        repository.repositoryRoot,
        worktree,
        activeRoot,
        activeArtifactPaths,
      );
    } else {
      assertCommittedProjectionArtifacts(
        worktree,
        sourceCommit,
        activeRoot,
        activeArtifactPaths,
      );
    }

    const specInputs = readProjectionSpecInputs(
      worktree,
      activeRoot,
      activeArtifactPaths,
    );
    const reviewedArtifacts = readProjectionArtifactBindings(
      worktree,
      activeArtifactPaths,
    );
    for (const specInput of specInputs) {
      assertSpecDeltaPreconditions(
        specInput.capability,
        specInput.before,
        specInput.delta,
      );
    }
    const openspec = createOpenSpecProcess(installation, {
      executionRoot: worktree,
    });
    let document: { value: unknown; status: number };
    try {
      document = openspec.archive(changeId);
    } catch (error) {
      throw archiveFailure(error);
    }
    const payload = parsePublicArchivePayload(
      document.value,
      worktree,
      changeId,
    );
    if (!payload.specsUpdated || payload.totals === undefined) {
      throw invalidPayload();
    }
    const archivedRoot = `${changeRoot}/archive/${payload.archivedAs}`;
    assertPreflightArchiveDestination(
      worktree,
      changeRoot,
      changeId,
      payload,
      archivedRoot,
    );
    assertArchivedProjectionArtifacts(
      worktree,
      activeRoot,
      archivedRoot,
      reviewedArtifacts,
    );
    validateRebuiltSpecs(openspec, worktree);

    assertProjectionChangedPaths(
      worktree,
      sourceCommit,
      activeRoot,
      archivedRoot,
      activeArtifactPaths,
      specInputs.map(({ baseSpecPath }) => baseSpecPath),
    );

    const totals: ArchiveTotals = {
      added: 0,
      modified: 0,
      removed: 0,
      renamed: 0,
    };
    const validatedBaseSpecDigests: Record<string, string> = {};
    for (const specInput of specInputs) {
      const projected = readPlainProjectionFile(
        worktree,
        specInput.baseSpecPath,
      );
      const verified = verifyProjectedSpecDeltaOutcome(
        specInput.capability,
        specInput.before,
        specInput.delta,
        projected,
      );
      for (const operation of Object.keys(totals) as Array<
        keyof ArchiveTotals
      >) {
        totals[operation] += verified.totals[operation];
      }
      validatedBaseSpecDigests[specInput.baseSpecPath] = sha256(
        specInput.before,
      );
    }
    if (canonicalJson(totals) !== canonicalJson(payload.totals)) {
      throw archiveError(
        'ARCHIVE_DELTA_OUTCOME_INVALID',
        'Public OpenSpec archive totals differ from the verified spec projection.',
      );
    }
    return {
      status: 'passed',
      validatedAt,
      validatedBaseCommit: baselineCommit,
      validatedBaseSpecDigests,
      validatorVersion: 'spec-delta-preflight-v3-public-archive',
    };
  } finally {
    if (worktreeAdded) {
      runGit(repository.repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        worktree,
      ]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertArchiveApplicabilityInput(
  repository: ReturnType<typeof discoverRepository>,
  input: ArchiveApplicabilityProjectionInput,
): {
  baselineCommit: string;
  changeId: string;
  changeRoot: string;
  sourceCommit: string;
  validatedAt: string;
} {
  let changeId: string;
  let changeRoot: string;
  try {
    changeId = assertChangeId(input.changeId);
    changeRoot = normalizeChangedPath(input.changeRoot);
  } catch {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires a canonical change identity and root.',
    );
  }
  const repositoryInput = path.resolve(input.repositoryRoot);
  if (
    fs.realpathSync(repositoryInput) !== repository.repositoryRealPath ||
    input.changeRoot !== changeRoot ||
    changeRoot.endsWith('/archive') ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baselineCommit) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sourceCommit) ||
    !['worktree', 'commit'].includes(input.source)
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires an exact repository, commit, and source boundary.',
    );
  }
  const baselineCommit = resolveExactCommit(
    repository.repositoryRoot,
    input.baselineCommit,
  );
  const sourceCommit = resolveExactCommit(
    repository.repositoryRoot,
    input.sourceCommit,
  );
  if (
    (input.source === 'worktree' &&
      (baselineCommit !== sourceCommit || repository.head !== sourceCommit)) ||
    (input.source === 'commit' &&
      canonicalJson(
        runGit(repository.repositoryRoot, [
          'show',
          '-s',
          '--format=%P',
          sourceCommit,
        ])
          .trim()
          .split(/\s+/)
          .filter(Boolean),
      ) !== canonicalJson([baselineCommit]))
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability source does not have the exact expected baseline.',
    );
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires a valid observation time.',
    );
  }
  return {
    baselineCommit,
    changeId,
    changeRoot,
    sourceCommit,
    validatedAt: now.toISOString(),
  };
}

function resolveExactCommit(repositoryRoot: string, value: string): string {
  let resolved: string;
  try {
    resolved = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${value}^{commit}`,
    ]).trim();
  } catch {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability commit boundary does not resolve.',
    );
  }
  if (resolved !== value) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability commit boundary is not exact.',
    );
  }
  return resolved;
}

function assertProjectionArtifactPaths(
  activeRoot: string,
  values: readonly string[],
): string[] {
  let normalized: string[];
  try {
    normalized = values.map(normalizeChangedPath);
  } catch {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires exact canonical active artifact paths.',
    );
  }
  const sorted = [...normalized].sort(compareCanonicalStrings);
  if (
    sorted.length === 0 ||
    new Set(sorted).size !== sorted.length ||
    canonicalJson(normalized) !== canonicalJson(values) ||
    sorted.some(
      (relativePath) =>
        path.isAbsolute(relativePath) ||
        path.posix.normalize(relativePath) !== relativePath ||
        !relativePath.startsWith(`${activeRoot}/`) ||
        relativePath.includes('\\'),
    )
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires exact canonical active artifact paths.',
    );
  }
  return sorted;
}

function assertProjectionWorktree(
  worktree: string,
  gitCommonDirectory: string,
  sourceCommit: string,
): void {
  const git = discoverRepository(worktree);
  const expectedHead = runGit(worktree, ['rev-parse', sourceCommit]).trim();
  if (
    git.repositoryRoot !== worktree ||
    git.repositoryRealPath !== worktree ||
    git.gitCommonDirectory !== gitCommonDirectory ||
    git.branch !== null ||
    git.head !== expectedHead ||
    git.statusEntries.length > 0
  ) {
    throw archiveError(
      'ARCHIVE_WORKTREE_INVALID',
      'Archive applicability did not start from the exact detached source commit.',
    );
  }
}

function overlayPlanningArtifacts(
  repositoryRoot: string,
  worktree: string,
  activeRoot: string,
  activeArtifactPaths: readonly string[],
): void {
  const targetRoot = path.join(worktree, activeRoot);
  assertInsideDirectory(worktree, targetRoot);
  assertPlainDirectoryChain(worktree, path.dirname(targetRoot));
  const existingTarget = fs.lstatSync(targetRoot, { throwIfNoEntry: false });
  if (
    existingTarget !== undefined &&
    (!existingTarget.isDirectory() || existingTarget.isSymbolicLink())
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability target root is not one plain directory.',
    );
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  for (const relativePath of activeArtifactPaths) {
    const target = path.join(worktree, relativePath);
    assertInsideDirectory(worktree, target);
    const { bytes, mode } = readPlainProjectionBytes(
      repositoryRoot,
      relativePath,
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, {
      flag: 'wx',
      mode,
    });
  }
}

function assertCommittedProjectionArtifacts(
  worktree: string,
  sourceCommit: string,
  activeRoot: string,
  activeArtifactPaths: readonly string[],
): void {
  const entries = runGit(worktree, [
    'ls-tree',
    '-r',
    '-z',
    sourceCommit,
    '--',
    `:(literal)${activeRoot}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^100644 blob [0-9a-f]{40,64}\t(.+)$/.exec(entry);
      if (!match) {
        throw archiveError(
          'ARCHIVE_APPLICABILITY_INPUT_INVALID',
          'Immutable planning commit contains a non-plain artifact.',
        );
      }
      return match[1];
    })
    .sort(compareCanonicalStrings);
  if (canonicalJson(entries) !== canonicalJson(activeArtifactPaths)) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Immutable planning commit does not contain the exact active artifact manifest.',
    );
  }
}

function readProjectionArtifactBindings(
  worktree: string,
  activeArtifactPaths: readonly string[],
): ReadonlyMap<string, { digest: string; mode: number }> {
  return new Map(
    activeArtifactPaths.map((relativePath) => {
      const artifact = readPlainProjectionBytes(
        worktree,
        relativePath,
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      );
      if ((artifact.mode & 0o111) !== 0) {
        throw archiveError(
          'ARCHIVE_TRANSFORMATION_TREE_INVALID',
          `Archive applicability artifact is executable: ${relativePath}.`,
        );
      }
      return [
        relativePath,
        { digest: sha256(artifact.bytes), mode: artifact.mode },
      ];
    }),
  );
}

function assertArchivedProjectionArtifacts(
  worktree: string,
  activeRoot: string,
  archivedRoot: string,
  reviewedArtifacts: ReadonlyMap<string, { digest: string; mode: number }>,
): void {
  for (const [relativePath, expected] of reviewedArtifacts) {
    const archivedPath = `${archivedRoot}/${relativePath.slice(activeRoot.length + 1)}`;
    const actual = readPlainProjectionBytes(
      worktree,
      archivedPath,
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
    );
    if (
      sha256(actual.bytes) !== expected.digest ||
      actual.mode !== expected.mode
    ) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        `Public OpenSpec archive changed a reviewed planning artifact: ${relativePath}.`,
      );
    }
  }
}

function readProjectionSpecInputs(
  worktree: string,
  activeRoot: string,
  activeArtifactPaths: readonly string[],
): Array<{
  capability: string;
  delta: string;
  before: string;
  baseSpecPath: string;
}> {
  const prefix = `${activeRoot}/specs/`;
  const deltaPaths = activeArtifactPaths.filter(
    (relativePath) =>
      relativePath.startsWith(prefix) && relativePath.endsWith('/spec.md'),
  );
  if (deltaPaths.length === 0) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires at least one current delta specification.',
    );
  }
  return deltaPaths.map((deltaPath) => {
    const capability = deltaPath.slice(prefix.length, -'/spec.md'.length);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability)) {
      throw archiveError(
        'ARCHIVE_APPLICABILITY_INPUT_INVALID',
        `Delta specification has a non-canonical capability: ${deltaPath}.`,
      );
    }
    const baseSpecPath = `openspec/specs/${capability}/spec.md`;
    return {
      capability,
      delta: readPlainProjectionFile(worktree, deltaPath),
      before: readOptionalPlainProjectionFile(worktree, baseSpecPath) ?? '',
      baseSpecPath,
    };
  });
}

function assertPreflightArchiveDestination(
  worktree: string,
  changeRoot: string,
  changeId: string,
  payload: PublicArchivePayload,
  archivedRoot: string,
): void {
  const suffix = `-${changeId}`;
  const date = payload.archivedAs.endsWith(suffix)
    ? payload.archivedAs.slice(0, -suffix.length)
    : '';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsed.getTime()) ||
    utcDate(parsed) !== date ||
    path.posix.dirname(archivedRoot) !== `${changeRoot}/archive` ||
    payload.archivePath !== path.join(worktree, archivedRoot)
  ) {
    throw invalidPayload();
  }
}

function assertProjectionChangedPaths(
  worktree: string,
  sourceCommit: string,
  activeRoot: string,
  archivedRoot: string,
  activeArtifactPaths: readonly string[],
  baseSpecPaths: readonly string[],
): void {
  const sourceActivePaths = runGit(worktree, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    sourceCommit,
    '--',
    `:(literal)${activeRoot}`,
  ])
    .split('\0')
    .filter(Boolean)
    .sort(compareCanonicalStrings);
  const archivedArtifactPaths = activeArtifactPaths.map(
    (relativePath) =>
      `${archivedRoot}/${relativePath.slice(activeRoot.length + 1)}`,
  );
  const changedPaths = listChangedPaths(worktree, sourceCommit);
  const allowed = new Set([
    ...sourceActivePaths,
    ...activeArtifactPaths,
    ...archivedArtifactPaths,
    ...baseSpecPaths,
  ]);
  if (
    changedPaths.some((relativePath) => !allowed.has(relativePath)) ||
    [...sourceActivePaths, ...archivedArtifactPaths, ...baseSpecPaths].some(
      (relativePath) => !changedPaths.includes(relativePath),
    )
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_PATHS_INVALID',
      'Public OpenSpec applicability projection changed paths outside its exact planning targets.',
      { changedPaths },
    );
  }
}

function readOptionalPlainProjectionFile(
  root: string,
  relativePath: string,
): string | undefined {
  const target = path.join(root, relativePath);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  return readPlainProjectionFile(root, relativePath, stats);
}

function readPlainProjectionFile(
  root: string,
  relativePath: string,
  knownStats?: fs.Stats,
): string {
  return readPlainProjectionBytes(
    root,
    relativePath,
    'ARCHIVE_TRANSFORMATION_TREE_INVALID',
    knownStats,
  ).bytes.toString('utf8');
}

function readPlainProjectionBytes(
  root: string,
  relativePath: string,
  errorCode: string,
  knownStats?: fs.Stats,
): { bytes: Buffer; mode: number } {
  const target = path.join(root, relativePath);
  assertInsideDirectory(root, target);
  assertPlainDirectoryChain(root, path.dirname(target));
  const pathBefore = knownStats ?? fs.lstatSync(target);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1
  ) {
    throw archiveError(
      errorCode,
      `Archive applicability file is not one plain file: ${relativePath}.`,
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw archiveError(
      errorCode,
      `Archive applicability file could not be opened safely: ${relativePath}.`,
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(target);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      BigInt(pathBefore.dev) !== before.dev ||
      BigInt(pathBefore.ino) !== before.ino ||
      BigInt(pathBefore.mode) !== before.mode ||
      BigInt(pathBefore.size) !== before.size ||
      !sameBigIntSnapshot(before, after) ||
      BigInt(pathAfter.dev) !== after.dev ||
      BigInt(pathAfter.ino) !== after.ino ||
      BigInt(pathAfter.mode) !== after.mode ||
      BigInt(pathAfter.size) !== after.size ||
      pathAfter.nlink !== 1
    ) {
      throw archiveError(
        'ARCHIVE_APPLICABILITY_INPUT_CHANGED',
        `Archive applicability file changed while it was read: ${relativePath}.`,
      );
    }
    assertPlainDirectoryChain(root, path.dirname(target));
    return { bytes, mode: Number(before.mode & 0o777n) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameBigIntSnapshot(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function assertPlainDirectoryChain(root: string, directory: string): void {
  const canonicalRoot = fs.realpathSync(root);
  if (canonicalRoot !== path.resolve(root)) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability root is not canonical.',
    );
  }
  assertInsideDirectory(root, directory);
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw archiveError(
        'ARCHIVE_APPLICABILITY_INPUT_INVALID',
        'Archive applicability path has a non-plain parent directory.',
      );
    }
  }
  if (fs.realpathSync(directory) !== path.resolve(directory)) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability path has a non-canonical parent directory.',
    );
  }
}

function assertInsideDirectory(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability path escapes its repository root.',
    );
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verifyTransformation(
  worktree: string,
  eligibility: ArchiveEligibility,
  payload: ArchivePayload,
  openspecVersion: '1.6.0',
): ArchiveTransformation {
  const activeRoot = eligibility.activeRoot;
  const activeFiles = [...eligibility.activeArtifactPaths].sort();
  if (
    JSON.stringify(listTreeFiles(worktree, eligibility.head, activeRoot)) !==
    JSON.stringify(activeFiles)
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive eligibility manifest differs from the active change tree.',
    );
  }
  const archivedFiles = listPlainArchiveFiles(
    worktree,
    eligibility.archiveDestination,
  );
  const expectedArchivedFiles = activeFiles.map(
    (filePath) =>
      `${eligibility.archiveDestination}/${filePath.slice(activeRoot.length + 1)}`,
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
    const digest = crypto.createHash('sha256').update(after).digest('hex');
    if (
      before === undefined ||
      !Buffer.from(before).equals(after) ||
      eligibility.artifactDigests[activeFiles[index]] !== digest
    ) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        'Archived file content differs from the eligible active change.',
      );
    }
    archivedArtifactDigests[
      archivedFiles[index].slice(eligibility.archiveDestination.length + 1)
    ] = digest;
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
    archivePath: eligibility.archiveDestination,
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
    // The rejected items name the requirement and scenario that failed. Losing
    // them leaves a maintainer with a verdict and no repair instructions.
    const rejected = validation.items
      .filter(({ valid }) => !valid)
      .map(({ id, issues }) => ({ spec: id, issues }));
    throw archiveError(
      'ARCHIVE_REBUILT_SPECS_INVALID',
      'Strict validation rejected rebuilt base specs.',
      withinDiagnosticBudget(rejected) ? { rejectedSpecs: rejected } : {},
    );
  }
}

function parseArchivePayload(
  value: unknown,
  worktree: string,
  eligibility: ArchiveEligibility,
  now: () => Date,
): ArchivePayload {
  const parsed = parsePublicArchivePayload(
    value,
    worktree,
    eligibility.changeId,
  );
  const expectedName = path.basename(eligibility.archiveDestination);
  const expectedPath = path.join(worktree, eligibility.archiveDestination);
  if (
    parsed.archivedAs !== expectedName ||
    parsed.archivePath !== expectedPath
  ) {
    const archive = (value as { archive: Record<string, unknown> }).archive;
    assertAdjacentUtcRollover(
      archive,
      worktree,
      eligibility,
      expectedName,
      now,
    );
  }
  return {
    archivedAs: parsed.archivedAs,
    specsUpdated: parsed.specsUpdated,
    ...(parsed.totals ? { totals: parsed.totals } : {}),
  };
}

function parsePublicArchivePayload(
  value: unknown,
  worktree: string,
  changeId: string,
): PublicArchivePayload {
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
    archive.change !== changeId ||
    archive.specsUpdated !== true ||
    typeof archive.archivedAs !== 'string' ||
    typeof archive.path !== 'string' ||
    path.basename(archive.path) !== archive.archivedAs ||
    path.normalize(archive.path) !== archive.path ||
    !archive.path.startsWith(`${worktree}${path.sep}`)
  ) {
    throw invalidPayload();
  }
  const totals = archive.totals;
  if (totals !== undefined && !isTotals(totals)) {
    throw invalidPayload();
  }
  return {
    archivedAs: archive.archivedAs,
    archivePath: archive.path,
    specsUpdated: true,
    ...(totals ? { totals } : {}),
  };
}

function assertAdjacentUtcRollover(
  archive: Record<string, unknown>,
  worktree: string,
  eligibility: ArchiveEligibility,
  expectedName: string,
  now: () => Date,
): never {
  const suffix = `-${eligibility.changeId}`;
  const archiveParent = `${eligibility.changeRoot}/archive`;
  const expectedDate = expectedName.endsWith(suffix)
    ? expectedName.slice(0, -suffix.length)
    : '';
  const rolloverDate = nextUtcDate(expectedDate);
  const rolloverName = `${rolloverDate}${suffix}`;
  const rolloverPath = path.join(worktree, archiveParent, rolloverName);
  if (
    path.posix.dirname(eligibility.archiveDestination) !== archiveParent ||
    archive.archivedAs !== rolloverName ||
    archive.path !== rolloverPath
  ) {
    throw invalidPayload();
  }

  const observedAt = now();
  if (
    !(observedAt instanceof Date) ||
    !Number.isFinite(observedAt.getTime()) ||
    utcDate(observedAt) !== rolloverDate
  ) {
    throw invalidPayload();
  }
  throw archiveError(
    'ARCHIVE_UTC_DATE_ROLLOVER',
    'Archive output crossed to the adjacent UTC date during this operation.',
    { expectedDate, observedDate: rolloverDate },
  );
}

function nextUtcDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidPayload();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || utcDate(date) !== value) {
    throw invalidPayload();
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return utcDate(date);
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
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

function assertEligibilityArtifactManifest(
  eligibility: ArchiveEligibility,
): void {
  const activeRoot = `${eligibility.changeRoot}/${eligibility.changeId}`;
  const required = requiredPlanningArtifactPaths(
    eligibility.changeRoot,
    eligibility.changeId,
    eligibility.schemaName,
  );
  try {
    assertPlanningPaths(
      eligibility.changeRoot,
      eligibility.changeId,
      eligibility.activeArtifactPaths,
      [],
      eligibility.schemaName,
    );
  } catch {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive eligibility manifest does not match its selected schema.',
    );
  }
  if (
    eligibility.activeRoot !== activeRoot ||
    required.some(
      (requiredPath) => !eligibility.activeArtifactPaths.includes(requiredPath),
    ) ||
    !eligibility.activeArtifactPaths.some(
      (artifactPath) =>
        artifactPath.startsWith(`${activeRoot}/specs/`) &&
        artifactPath.endsWith('/spec.md'),
    ) ||
    JSON.stringify(
      listTreeFiles(eligibility.repositoryRoot, eligibility.head, activeRoot),
    ) !== JSON.stringify(eligibility.activeArtifactPaths)
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive eligibility manifest differs from the active change tree.',
    );
  }
  for (const artifactPath of eligibility.activeArtifactPaths) {
    const content = readFileAtCommit(
      eligibility.repositoryRoot,
      eligibility.head,
      artifactPath,
    );
    if (
      content === undefined ||
      crypto.createHash('sha256').update(content).digest('hex') !==
        eligibility.artifactDigests[artifactPath]
    ) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        'Archive eligibility manifest digest differs from the active change.',
      );
    }
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

const MAX_DIAGNOSTIC_BYTES = 8_192;

/**
 * Projects a failure cause into the bounded payload the archive error carries.
 * The archive wrapper used to keep only the cause's code, which discarded the
 * named requirements and scenarios that say what to repair. Everything here is
 * already schema-validated before it reaches an error, but size is bounded
 * again because diagnostics travel into logs and reports.
 */
export function boundedArchiveCauseDiagnostic(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof WorkflowError)) return {};
  const diagnostic: Record<string, unknown> = { causeCode: error.code };
  if (!withinDiagnosticBudget(diagnostic)) return {};

  const details = boundedStructuredCauseDetails(error.details, diagnostic);
  if (details !== undefined) {
    diagnostic.causeDetails = details;
  }

  const withMessage = { ...diagnostic, causeMessage: error.message };
  if (withinDiagnosticBudget(withMessage)) {
    diagnostic.causeMessage = error.message;
  }
  return diagnostic;
}

function withinDiagnosticBudget(value: unknown): boolean {
  try {
    return (
      Buffer.byteLength(canonicalJson(value), 'utf8') <= MAX_DIAGNOSTIC_BYTES
    );
  } catch {
    return false;
  }
}

const STRUCTURED_REPAIR_HINT_KEYS = new Set([
  'capability',
  'faults',
  'from',
  'id',
  'identities',
  'identity',
  'issues',
  'message',
  'missingScenarios',
  'operation',
  'path',
  'reason',
  'rejectedSpecs',
  'renameCandidate',
  'renameCandidates',
  'renamed',
  'requirement',
  'scenario',
  'scenarios',
  'spec',
  'to',
]);

function boundedStructuredCauseDetails(
  details: Record<string, unknown> | undefined,
  diagnostic: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  if (withinDiagnosticBudget({ ...diagnostic, causeDetails: details })) {
    return details;
  }

  const projected = projectStructuredRepairHints(details, false, new Set());
  if (!isRecord(projected) || Object.keys(projected).length === 0) {
    return undefined;
  }
  if (withinDiagnosticBudget({ ...diagnostic, causeDetails: projected })) {
    return projected;
  }

  const bounded: Record<string, unknown> = {};
  for (const key of orderedRepairHintKeys(projected)) {
    const value = projected[key];
    if (
      withinDiagnosticBudget({
        ...diagnostic,
        causeDetails: { ...bounded, [key]: value },
      })
    ) {
      bounded[key] = value;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const entries: unknown[] = [];
    for (const entry of value) {
      if (
        !withinDiagnosticBudget({
          ...diagnostic,
          causeDetails: { ...bounded, [key]: [...entries, entry] },
        })
      ) {
        continue;
      }
      entries.push(entry);
    }
    if (entries.length > 0) bounded[key] = entries;
  }
  return Object.keys(bounded).length === 0 ? undefined : bounded;
}

function projectStructuredRepairHints(
  value: unknown,
  retainPrimitive: boolean,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return retainPrimitive ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    try {
      const entries = value.flatMap((entry) => {
        const projected = projectStructuredRepairHints(
          entry,
          retainPrimitive,
          ancestors,
        );
        return projected === undefined ? [] : [projected];
      });
      return entries.length === 0 ? undefined : entries;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value)) return undefined;
  if (ancestors.has(value)) return undefined;

  ancestors.add(value);
  try {
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCanonicalStrings)) {
      const child = projectStructuredRepairHints(
        value[key],
        STRUCTURED_REPAIR_HINT_KEYS.has(key),
        ancestors,
      );
      if (child !== undefined) projected[key] = child;
    }
    return Object.keys(projected).length === 0 ? undefined : projected;
  } finally {
    ancestors.delete(value);
  }
}

function orderedRepairHintKeys(value: Record<string, unknown>): string[] {
  const priority = [
    'capability',
    'requirement',
    'missingScenarios',
    'identities',
    'identity',
    'renameCandidates',
    'renameCandidate',
    'renamed',
    'from',
    'to',
    'faults',
    'rejectedSpecs',
    'issues',
    'spec',
    'path',
    'operation',
    'reason',
    'message',
    'id',
  ];
  return Object.keys(value).sort((left, right) => {
    const leftRank = priority.indexOf(left);
    const rightRank = priority.indexOf(right);
    return (
      (leftRank === -1 ? priority.length : leftRank) -
        (rightRank === -1 ? priority.length : rightRank) ||
      compareCanonicalStrings(left, right)
    );
  });
}

function archiveFailure(error: unknown) {
  return workflowError(
    'OPENSPEC_ARCHIVE_FAILED',
    'Pinned OpenSpec archive execution failed inside the temporary worktree.',
    error instanceof WorkflowError ? error.exitCode : ExitCode.verification,
    { details: boundedArchiveCauseDiagnostic(error) },
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
