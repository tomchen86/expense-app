import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ExitCode, workflowError } from './errors.ts';
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
  const rawStatus = runGit(repositoryRoot, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]);

  return {
    repositoryRoot,
    repositoryRealPath,
    gitCommonDirectory,
    branch: branchValue || null,
    head,
    tree,
    statusEntries: splitNull(rawStatus),
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
      '-z',
      '--diff-filter=ACDMRTUXB',
      baselineHead,
      '--',
    ]),
  );
  const untrackedPaths = splitNull(
    runGit(repositoryRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
    ]),
  );

  return [
    ...new Set([...diffPaths, ...untrackedPaths].map(normalizeChangedPath)),
  ].sort();
}

export function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });

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

function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}
