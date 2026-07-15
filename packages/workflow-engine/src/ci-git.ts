import { ExitCode, workflowError } from './errors.ts';
import { commitChangedPaths, commitFacts } from './git-transitions.ts';
import { runGit } from './git.ts';
import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
  type ManagedTrailers,
} from './managed-trailers.ts';
import { normalizeChangedPath } from './paths.ts';

export type { ManagedTrailers } from './managed-trailers.ts';

export type RangeCommit = {
  hash: string;
  subject: string;
  parents: string[];
  trailers?: ManagedTrailers;
};

export function assertCiCommit(repositoryRoot: string, value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw ciGitError('CI_COMMIT_ID_INVALID', 'CI requires an exact commit ID.');
  }
  const resolved = runGit(repositoryRoot, [
    'rev-parse',
    `${value}^{commit}`,
  ]).trim();
  if (resolved !== value) {
    throw ciGitError(
      'CI_COMMIT_ID_INVALID',
      'CI commit ID did not resolve exactly.',
    );
  }
  return resolved;
}

export function findMergeBase(
  repositoryRoot: string,
  base: string,
  head: string,
): string {
  const mergeBase = runGit(repositoryRoot, ['merge-base', base, head]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeBase)) {
    throw ciGitError(
      'CI_MERGE_BASE_INVALID',
      'CI could not determine a valid merge base.',
    );
  }
  return mergeBase;
}

export function listRangeCommits(
  repositoryRoot: string,
  base: string,
  head: string,
): RangeCommit[] {
  const hashes = runGit(repositoryRoot, [
    'rev-list',
    '--reverse',
    `${base}..${head}`,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (hashes.length === 0) {
    throw ciGitError(
      'CI_EMPTY_RANGE',
      'CI base and head contain no PR commits.',
    );
  }
  return hashes.map((hash) => {
    const facts = commitFacts(repositoryRoot, hash);
    let trailers: ManagedTrailers | undefined;
    try {
      trailers = parseManagedTrailers(facts.message);
    } catch (error) {
      if (error instanceof ManagedTrailerSyntaxError) {
        throw ciGitError(
          'CI_INVALID_MANAGED_TRAILERS',
          'A PR commit contains a non-canonical managed trailer block.',
        );
      }
      throw error;
    }
    return {
      hash: facts.hash,
      subject: facts.message.split('\n', 1)[0],
      parents: facts.parents,
      ...(trailers ? { trailers } : {}),
    };
  });
}

export function listRangePaths(
  repositoryRoot: string,
  base: string,
  head: string,
): string[] {
  return runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    '--diff-filter=ACDMRTUXB',
    base,
    head,
    '--',
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
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${filePath}`,
  ]);
  return listing
    ? runGit(repositoryRoot, ['show', `${commit}:${filePath}`])
    : undefined;
}

export function listChangesAtCommit(
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
): string[] {
  const prefix = `${changeRoot}/`;
  return [
    ...new Set(
      runGit(repositoryRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        commit,
        '--',
        changeRoot,
      ])
        .split('\0')
        .filter((filePath) => filePath.endsWith('/guard.json'))
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => filePath.slice(prefix.length).split('/')[0])
        .filter((changeId) => changeId && changeId !== 'archive'),
    ),
  ].sort();
}

export function firstCommitIntroduces(
  repositoryRoot: string,
  commit: RangeCommit,
  requiredPaths: string[],
): boolean {
  const changed = new Set(commitChangedPaths(repositoryRoot, commit.hash));
  return requiredPaths.every((filePath) => changed.has(filePath));
}

export function listCommitPaths(
  repositoryRoot: string,
  commit: RangeCommit,
): string[] {
  return commitChangedPaths(repositoryRoot, commit.hash);
}

function ciGitError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
