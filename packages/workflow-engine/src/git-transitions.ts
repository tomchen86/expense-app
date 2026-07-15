import { ExitCode, workflowError } from './errors.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listChangedPaths, runGit, runGitWithEnvironment } from './git.ts';
import { normalizeChangedPath } from './paths.ts';

export type TaskCommit = {
  hash: string;
  subject: string;
};

export function stageExactPaths(
  repositoryRoot: string,
  baselineHead: string,
  expectedPaths: string[],
): {
  stagedPaths: string[];
  tree: string;
  previousIndexTree: string;
} {
  if (expectedPaths.length === 0) {
    throw workflowError(
      'EMPTY_FINISH_DIFF',
      'A managed finish requires at least the task checkbox projection.',
      ExitCode.verification,
    );
  }
  const expected = [...expectedPaths].sort();
  const changedBefore = listChangedPaths(repositoryRoot, baselineHead);
  const stagedBefore = listStagedPaths(repositoryRoot, baselineHead);
  if (JSON.stringify(changedBefore) !== JSON.stringify(expected)) {
    throw workflowError(
      'FINISH_PATHS_CHANGED',
      'Changed paths no longer match the verified task paths.',
      ExitCode.staleState,
      { details: { expectedPaths: expected, changedPaths: changedBefore } },
    );
  }
  if (stagedBefore.length > 0) {
    throw workflowError(
      'STAGING_ALREADY_PRESENT',
      'Only workflow finish may create the managed staging projection.',
      ExitCode.staleState,
      { details: { stagedPaths: stagedBefore } },
    );
  }

  const previousIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
  const literalPaths = expected.map((entry) => `:(literal)${entry}`);
  const workflowIndexTree = predictIndexTree(
    repositoryRoot,
    baselineHead,
    previousIndexTree,
    literalPaths,
    expected,
  );
  try {
    if (runGit(repositoryRoot, ['write-tree']).trim() !== previousIndexTree) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index changed before workflow staging; foreign staging was preserved.',
        ExitCode.staleState,
      );
    }
    runGit(repositoryRoot, ['add', '-A', '--', ...literalPaths]);
    if (runGit(repositoryRoot, ['write-tree']).trim() !== workflowIndexTree) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index differs from the isolated workflow projection; foreign staging was preserved.',
        ExitCode.staleState,
      );
    }
    const changedPaths = listChangedPaths(repositoryRoot, baselineHead);
    const stagedPaths = listStagedPaths(repositoryRoot, baselineHead);
    if (
      JSON.stringify(changedPaths) !== JSON.stringify(expected) ||
      JSON.stringify(stagedPaths) !== JSON.stringify(expected)
    ) {
      throw workflowError(
        'STAGED_PATHS_MISMATCH',
        'Staged paths do not exactly match the verified task paths.',
        ExitCode.staleState,
        { details: { expectedPaths: expected, changedPaths, stagedPaths } },
      );
    }
    const unstagedPaths = splitNull(
      runGit(repositoryRoot, ['diff', '--name-only', '-z', '--']),
    )
      .map(normalizeChangedPath)
      .sort();
    if (unstagedPaths.length > 0) {
      throw workflowError(
        'WORKTREE_INDEX_MISMATCH',
        'The worktree changed while the managed index was being staged.',
        ExitCode.staleState,
        { details: { unstagedPaths } },
      );
    }
    return {
      stagedPaths,
      tree: workflowIndexTree,
      previousIndexTree,
    };
  } catch (error) {
    const currentIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
    if (
      currentIndexTree !== previousIndexTree &&
      currentIndexTree !== workflowIndexTree
    ) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index changed during workflow staging; foreign staging was preserved.',
        ExitCode.staleState,
        {
          details: {
            causeCode: error instanceof Error ? error.name : String(error),
          },
        },
      );
    }
    if (currentIndexTree === workflowIndexTree) {
      runGit(repositoryRoot, ['read-tree', previousIndexTree]);
    }
    throw error;
  }
}

export function rollbackExactStaging(
  repositoryRoot: string,
  previousIndexTree: string,
  workflowStagedTree: string,
  cause: unknown,
): void {
  const currentIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (currentIndexTree !== workflowStagedTree) {
    throw workflowError(
      'STAGING_INDEX_DIVERGED',
      'The Git index changed after workflow staging; foreign staging was preserved.',
      ExitCode.staleState,
      {
        details: {
          causeCode:
            cause instanceof Error && 'code' in cause
              ? String(cause.code)
              : undefined,
        },
      },
    );
  }
  runGit(repositoryRoot, ['read-tree', previousIndexTree]);
}

function predictIndexTree(
  repositoryRoot: string,
  baselineHead: string,
  previousIndexTree: string,
  literalPaths: string[],
  expectedPaths: string[],
): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-index-'),
  );
  const indexEnvironment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  try {
    runGitWithEnvironment(
      repositoryRoot,
      ['read-tree', previousIndexTree],
      indexEnvironment,
    );
    runGitWithEnvironment(
      repositoryRoot,
      ['add', '-A', '--', ...literalPaths],
      indexEnvironment,
    );
    const tree = runGitWithEnvironment(
      repositoryRoot,
      ['write-tree'],
      indexEnvironment,
    ).trim();
    const stagedPaths = splitNull(
      runGitWithEnvironment(
        repositoryRoot,
        [
          'diff',
          '--cached',
          '--name-only',
          '--no-renames',
          '-z',
          baselineHead,
          '--',
        ],
        indexEnvironment,
      ),
    )
      .map(normalizeChangedPath)
      .sort();
    const unstagedPaths = splitNull(
      runGitWithEnvironment(
        repositoryRoot,
        ['diff', '--name-only', '--no-renames', '-z', '--'],
        indexEnvironment,
      ),
    )
      .map(normalizeChangedPath)
      .sort();
    if (
      JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths) ||
      unstagedPaths.length > 0
    ) {
      throw workflowError(
        'STAGED_PATHS_MISMATCH',
        'The isolated staging projection did not match the verified paths.',
        ExitCode.staleState,
      );
    }
    return tree;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function listStagedPaths(
  repositoryRoot: string,
  baselineHead: string,
): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'diff',
      '--cached',
      '--ita-visible-in-index',
      '--name-only',
      '--no-renames',
      '-z',
      baselineHead,
      '--',
    ]),
  )
    .map(normalizeChangedPath)
    .sort();
}

export function createManagedCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  subject: string,
  changeId: string,
  taskId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTask: ${taskId}`,
    ],
    identity,
  ).trim();
}

export function createPlanningCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  changeId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const subject = `Plan ${changeId}`;
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTransition: plan`,
    ],
    identity,
  ).trim();
}

export function createArchiveCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  changeId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const subject = `Archive ${changeId}`;
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTransition: archive`,
    ],
    identity,
  ).trim();
}

export function updateManagedRef(
  repositoryRoot: string,
  expectedHead: string,
  commitHash: string,
  ref = 'HEAD',
): void {
  runGit(repositoryRoot, [
    'update-ref',
    '-m',
    'workflow managed commit',
    ref,
    commitHash,
    expectedHead,
  ]);
  if (runGit(repositoryRoot, ['rev-parse', ref]).trim() !== commitHash) {
    throw workflowError(
      'COMMIT_REF_UPDATE_FAILED',
      'The branch ref did not advance to the authorized commit.',
      ExitCode.staleState,
    );
  }
}

export function planningCommitMessage(changeId: string): string {
  const subject = `Plan ${changeId}`;
  validateCommitSubject(subject);
  return [subject, '', `Change: ${changeId}`, 'Transition: plan'].join('\n');
}

export function archiveCommitMessage(changeId: string): string {
  const subject = `Archive ${changeId}`;
  validateCommitSubject(subject);
  return [subject, '', `Change: ${changeId}`, 'Transition: archive'].join('\n');
}

export function managedCommitMessage(
  subject: string,
  changeId: string,
  taskId: string,
): string {
  validateCommitSubject(subject);
  return [subject, '', `Change: ${changeId}`, `Task: ${taskId}`].join('\n');
}

function validateCommitSubject(subject: string): void {
  if (
    !subject ||
    subject.trim() !== subject ||
    [...subject].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    /^(?:Change|Task):/i.test(subject)
  ) {
    throw workflowError(
      'INVALID_COMMIT_SUBJECT',
      'Managed commit subject must be one trimmed line without control characters or trailers.',
      ExitCode.usage,
    );
  }
}

function resolveCommitIdentity(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const name =
    runGit(
      repositoryRoot,
      ['config', '--local', '--get', 'user.name'],
      true,
    ).trim() || environment.WORKFLOW_GIT_AUTHOR_NAME;
  const email =
    runGit(
      repositoryRoot,
      ['config', '--local', '--get', 'user.email'],
      true,
    ).trim() || environment.WORKFLOW_GIT_AUTHOR_EMAIL;
  if (!isSafeIdentity(name) || !isSafeIdentity(email)) {
    throw workflowError(
      'COMMIT_IDENTITY_REQUIRED',
      'Managed commit requires local Git identity or WORKFLOW_GIT_AUTHOR_NAME and WORKFLOW_GIT_AUTHOR_EMAIL.',
      ExitCode.unsafeEnvironment,
    );
  }
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function isSafeIdentity(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

export function commitFacts(
  repositoryRoot: string,
  commitHash: string,
): {
  hash: string;
  parents: string[];
  tree: string;
  message: string;
} {
  const hash = runGit(repositoryRoot, [
    'rev-parse',
    `${commitHash}^{commit}`,
  ]).trim();
  const parents = runGit(repositoryRoot, ['show', '-s', '--format=%P', hash])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const tree = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%T',
    hash,
  ]).trim();
  const rawCommit = runGit(repositoryRoot, ['cat-file', 'commit', hash]);
  const messageOffset = rawCommit.indexOf('\n\n');
  if (messageOffset === -1) {
    throw workflowError(
      'INVALID_COMMIT_OBJECT',
      'Git commit object does not contain a message boundary.',
      ExitCode.staleState,
    );
  }
  const message = rawCommit.slice(messageOffset + 2);
  return { hash, parents, tree, message };
}

export function commitChangedPaths(
  repositoryRoot: string,
  commitHash: string,
): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      commitHash,
      '--',
    ]),
  )
    .map(normalizeChangedPath)
    .sort();
}

export function findExactTaskCommits(
  repositoryRoot: string,
  changeId: string,
  taskId: string,
): TaskCommit[] {
  const values = runGit(repositoryRoot, [
    'log',
    'HEAD',
    '--format=%H%x00%s%x00%B%x00',
  ]).split('\0');
  const commits: TaskCommit[] = [];
  for (let index = 0; index + 2 < values.length; index += 3) {
    const hash = values[index].trimStart();
    const subject = values[index + 1];
    const message = values[index + 2];
    if (!/^[0-9a-f]{40,64}$/.test(hash)) {
      continue;
    }
    if (hasExactTrailers(message, changeId, taskId)) {
      commits.push({ hash, subject });
    }
  }
  return commits;
}

export function hasExactTrailers(
  message: string,
  changeId: string,
  taskId: string,
): boolean {
  const normalized = message.endsWith('\n') ? message.slice(0, -1) : message;
  if (normalized.endsWith('\n') || normalized.includes('\r')) {
    return false;
  }
  const lines = normalized.split('\n');
  if (
    lines.length < 4 ||
    lines.at(-3) !== '' ||
    lines.at(-2) !== `Change: ${changeId}` ||
    lines.at(-1) !== `Task: ${taskId}`
  ) {
    return false;
  }
  return !lines.slice(0, -2).some((line) => /^(?:Change|Task):/.test(line));
}

function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}
