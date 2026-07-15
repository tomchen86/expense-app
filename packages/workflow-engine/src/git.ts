import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { normalizeChangedPath } from './paths.ts';

export type GitState = {
  repositoryRoot: string;
  repositoryRealPath: string;
  gitCommonDirectory: string;
  branch: string | null;
  head: string;
  tree: string;
  statusEntries: string[];
};

export function discoverRepository(cwd: string): GitState {
  const repositoryRoot = runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
  const repositoryRealPath = fs.realpathSync(repositoryRoot);
  const commonDirectoryValue = runGit(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim();
  const gitCommonDirectory = fs.realpathSync(
    path.isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : path.resolve(repositoryRoot, commonDirectoryValue),
  );
  const branchValue = runGit(
    repositoryRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    true,
  ).trim();
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const tree = runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  const hiddenIndexEntries = splitNull(
    runGit(repositoryRoot, ['ls-files', '-v', '-z']),
  ).filter(hasHiddenIndexFlag);
  if (hiddenIndexEntries.length > 0) {
    throw workflowError(
      'UNSAFE_INDEX_FLAGS',
      'Git index contains assume-unchanged or skip-worktree entries.',
      ExitCode.unsafeEnvironment,
      {
        details: {
          entryCount: hiddenIndexEntries.length,
          paths: hiddenIndexEntries.map((entry) => entry.slice(2)),
        },
        recovery:
          'Clear assume-unchanged and skip-worktree flags before using the workflow.',
      },
    );
  }
  const rawStatus = runGit(repositoryRoot, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]);
  const controlledUntrackedPaths = listControlledUntrackedPaths(repositoryRoot);

  return {
    repositoryRoot,
    repositoryRealPath,
    gitCommonDirectory,
    branch: branchValue || null,
    head,
    tree,
    statusEntries: [
      ...splitNull(rawStatus),
      ...controlledUntrackedPaths.map(
        (entry) => `controlled-untracked:${entry}`,
      ),
    ],
  };
}

export function listChangedPaths(
  repositoryRoot: string,
  baselineHead: string,
): string[] {
  const diffPaths = splitNull(
    runGit(repositoryRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      '--diff-filter=ACDMRTUXB',
      baselineHead,
      '--',
    ]),
  );
  const untrackedPaths = listControlledUntrackedPaths(repositoryRoot);

  return [
    ...new Set([...diffPaths, ...untrackedPaths].map(normalizeChangedPath)),
  ].sort();
}

export function fingerprintWorkingState(
  repositoryRoot: string,
  baselineHead: string,
  statusEntries: string[],
): string {
  return fingerprintState(repositoryRoot, baselineHead, statusEntries, true);
}

// macOS may rewrite com.apple.provenance asynchronously without changing the
// Git projection. Persisted evidence therefore omits tracked and controlled-
// changed entry ctime only on Darwin; check mutation detection stays strict.
export function fingerprintRepositoryProjection(
  repositoryRoot: string,
  baselineHead: string,
  statusEntries: string[],
): string {
  return fingerprintState(
    repositoryRoot,
    baselineHead,
    statusEntries,
    process.platform !== 'darwin',
  );
}

function fingerprintState(
  repositoryRoot: string,
  baselineHead: string,
  statusEntries: string[],
  includeVolatileMetadata: boolean,
): string {
  try {
    const digest = crypto.createHash('sha256');
    const trackedPaths = listTrackedPaths(repositoryRoot);
    const changedPaths = listChangedPaths(repositoryRoot, baselineHead);
    const ignoredPaths = listRepositoryIgnoredPaths(repositoryRoot);
    const indexState = runGit(repositoryRoot, [
      'diff',
      '--cached',
      '--raw',
      '-z',
      baselineHead,
      '--',
    ]);
    updateFramed(digest, 'index', indexState);
    for (const statusEntry of statusEntries) {
      updateFramed(digest, 'status', statusEntry);
    }

    for (const trackedPath of trackedPaths) {
      updateFramed(digest, 'tracked-path', trackedPath);
      fingerprintTrackedEntry(
        digest,
        repositoryRoot,
        trackedPath,
        includeVolatileMetadata,
      );
    }

    for (const changedPath of changedPaths) {
      updateFramed(digest, 'changed-path', changedPath);
      const absolutePath = path.join(repositoryRoot, changedPath);
      const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!stats) {
        updateFramed(digest, 'changed-kind', 'missing');
        continue;
      }
      updateFramed(
        digest,
        'changed-stat',
        fingerprintStats(stats, includeVolatileMetadata),
      );
      if (stats.isSymbolicLink()) {
        updateFramed(digest, 'changed-kind', 'symlink');
        updateFramed(digest, 'changed-link', fs.readlinkSync(absolutePath));
      } else if (stats.isFile()) {
        updateFramed(digest, 'changed-kind', 'file');
        updateFramed(digest, 'changed-content', fs.readFileSync(absolutePath));
      } else if (stats.isDirectory()) {
        updateFramed(digest, 'changed-kind', 'directory');
      } else {
        throw new Error('unsupported changed filesystem entry');
      }
    }

    for (const ignoredPath of ignoredPaths) {
      updateFramed(digest, 'ignored-path', ignoredPath);
      fingerprintIgnoredEntry(digest, repositoryRoot, ignoredPath);
    }
    return digest.digest('hex');
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw workflowError(
      'WORKTREE_FINGERPRINT_FAILED',
      'Unable to fingerprint the current Git working state safely.',
      ExitCode.staleState,
    );
  }
}

export function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): string {
  return executeGit(cwd, args, allowFailure, {});
}

export function runGitWithEnvironment(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): string {
  return executeGit(cwd, args, false, environment);
}

function executeGit(
  cwd: string,
  args: string[],
  allowFailure: boolean,
  environment: NodeJS.ProcessEnv,
): string {
  const executable = resolveGitExecutable();
  const commandArgs =
    args[0] === 'diff'
      ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
      : args;
  const result = spawnSync(
    executable,
    [
      '--no-pager',
      '--no-optional-locks',
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.fileMode=true',
      '-C',
      cwd,
      ...commandArgs,
    ],
    {
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...createTrustedExecutionEnvironment([executable]),
        ...environment,
      },
    },
  );

  if (result.error) {
    throw workflowError(
      'GIT_EXECUTION_FAILED',
      `Unable to run Git: ${result.error.message}`,
      ExitCode.unsafeEnvironment,
      { details: { args } },
    );
  }

  if (result.status !== 0 && !allowFailure) {
    throw workflowError(
      'GIT_COMMAND_FAILED',
      `Git command failed: git ${args.join(' ')}`,
      ExitCode.unsafeEnvironment,
      {
        details: {
          args,
          status: result.status,
          stderr: result.stderr.trim(),
        },
      },
    );
  }

  return result.stdout;
}

let pinnedGitExecutable: string | undefined;

export function resolveGitExecutable(): string {
  if (pinnedGitExecutable) {
    return pinnedGitExecutable;
  }

  for (const candidate of gitExecutableCandidates()) {
    try {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      pinnedGitExecutable = fs.realpathSync(candidate);
      return pinnedGitExecutable;
    } catch {
      continue;
    }
  }

  throw workflowError(
    'GIT_EXECUTABLE_UNAVAILABLE',
    'Git is not available from a trusted system location.',
    ExitCode.unsafeEnvironment,
  );
}

function gitExecutableCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)'];
    return programFiles.flatMap((directory) => [
      path.join(directory, 'Git', 'cmd', 'git.exe'),
      path.join(directory, 'Git', 'bin', 'git.exe'),
    ]);
  }
  return ['/usr/bin/git', '/bin/git'];
}

function hasHiddenIndexFlag(entry: string): boolean {
  const tag = entry[0];
  return tag === 'S' || (tag >= 'a' && tag <= 'z');
}

function listControlledUntrackedPaths(repositoryRoot: string): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'ls-files',
      '--others',
      '--exclude-per-directory=.gitignore',
      '-z',
      '--',
    ]),
  ).map(normalizeChangedPath);
}

function listTrackedPaths(repositoryRoot: string): string[] {
  return splitNull(
    runGit(repositoryRoot, ['ls-files', '--cached', '-z', '--']),
  ).map(normalizeChangedPath);
}

function listRepositoryIgnoredPaths(repositoryRoot: string): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-per-directory=.gitignore',
      '-z',
      '--',
    ]),
  ).map(normalizeChangedPath);
}

function fingerprintIgnoredEntry(
  digest: ReturnType<typeof crypto.createHash>,
  repositoryRoot: string,
  ignoredPath: string,
): void {
  const absolutePath = path.join(repositoryRoot, ignoredPath);
  const stats = fs.lstatSync(absolutePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!stats) {
    updateFramed(digest, 'ignored-kind', 'missing');
    return;
  }
  updateFramed(digest, 'ignored-stat', fingerprintStats(stats, true));
  if (stats.isSymbolicLink()) {
    updateFramed(digest, 'ignored-kind', 'symlink');
    updateFramed(digest, 'ignored-link', fs.readlinkSync(absolutePath));
  } else if (stats.isFile()) {
    updateFramed(digest, 'ignored-kind', 'file');
  } else if (stats.isDirectory()) {
    updateFramed(digest, 'ignored-kind', 'directory');
  } else {
    throw new Error('unsupported ignored filesystem entry');
  }
}

function fingerprintTrackedEntry(
  digest: ReturnType<typeof crypto.createHash>,
  repositoryRoot: string,
  trackedPath: string,
  includeVolatileMetadata: boolean,
): void {
  const absolutePath = path.join(repositoryRoot, trackedPath);
  const stats = fs.lstatSync(absolutePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!stats) {
    updateFramed(digest, 'tracked-kind', 'missing');
    return;
  }
  updateFramed(
    digest,
    'tracked-stat',
    fingerprintStats(stats, includeVolatileMetadata),
  );
  if (stats.isSymbolicLink()) {
    updateFramed(digest, 'tracked-kind', 'symlink');
    updateFramed(digest, 'tracked-link', fs.readlinkSync(absolutePath));
  } else if (stats.isFile()) {
    updateFramed(digest, 'tracked-kind', 'file');
    updateFramed(digest, 'tracked-content', fs.readFileSync(absolutePath));
  } else if (stats.isDirectory()) {
    updateFramed(digest, 'tracked-kind', 'directory');
  } else {
    throw new Error('unsupported tracked filesystem entry');
  }
}

function fingerprintStats(
  stats: fs.BigIntStats,
  includeVolatileMetadata: boolean,
): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.uid,
    stats.gid,
    stats.size,
    stats.mtimeNs,
    ...(includeVolatileMetadata ? [stats.ctimeNs] : []),
  ].join(':');
}

function updateFramed(
  digest: ReturnType<typeof crypto.createHash>,
  domain: string,
  value: string | Buffer,
): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  digest.update(`${domain.length}:${domain}:${bytes.length}:`);
  digest.update(bytes);
}

function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}
