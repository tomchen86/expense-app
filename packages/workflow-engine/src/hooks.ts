import fs from 'node:fs';
import path from 'node:path';

import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { listStagedPaths } from './git-transitions.ts';
import { hasManagedTrailerLine } from './managed-trailers.ts';
import { validateRepositoryState } from './repository-validation.ts';
import { listSessions } from './session.ts';

export type HookResult = {
  hook: string;
  changes: string[];
  documents: string[];
};

export function runRepositoryHook(
  cwd: string,
  requestedHook: string,
  args: string[],
): HookResult {
  assertHookArguments(requestedHook, args);
  if (requestedHook === 'commit-msg') {
    validateCommitMessage(cwd, args[0]);
  }
  const validated = validateRepositoryState(cwd);
  const repositoryRealPath = fs.realpathSync(validated.repositoryRoot);
  if (
    requestedHook === 'pre-commit' &&
    listSessions(cwd).some(
      (session) =>
        session.state === 'active' &&
        session.repositoryRoot === repositoryRealPath,
    )
  ) {
    throw workflowError(
      'ACTIVE_SESSION_REQUIRES_MANAGED_COMMIT',
      'An active workflow session must be committed by the workflow engine.',
      ExitCode.guard,
    );
  }
  if (requestedHook === 'pre-commit') {
    const stagedLifecyclePaths = findStagedLifecyclePaths(
      validated.repositoryRoot,
    );
    if (stagedLifecyclePaths.length > 0) {
      throw workflowError(
        'MANAGED_DIFF_REQUIRES_WORKFLOW_COMMIT',
        'OpenSpec task, planning, and archive diffs require a workflow commit-tree transition.',
        ExitCode.guard,
        { details: { stagedPaths: stagedLifecyclePaths } },
      );
    }
  }
  return {
    hook: requestedHook,
    changes: validated.changes,
    documents: validated.documents,
  };
}

function findStagedLifecyclePaths(repositoryRoot: string): string[] {
  const config = loadWorkflowConfig(repositoryRoot);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const stagedPaths = listStagedPaths(repositoryRoot, head);
  const openspecRoot = path.posix.dirname(config.changeRoot);
  const baseSpecRoot = `${openspecRoot}/specs/`;
  const changeRoot = `${config.changeRoot}/`;
  return stagedPaths.filter(
    (filePath) =>
      filePath.startsWith(changeRoot) || filePath.startsWith(baseSpecRoot),
  );
}

function assertHookArguments(hook: string, args: string[]): void {
  const valid =
    (hook === 'pre-commit' && args.length === 0) ||
    (hook === 'commit-msg' && args.length === 1) ||
    (hook === 'pre-push' && (args.length === 0 || args.length === 2)) ||
    (hook === 'post-merge' &&
      args.length === 1 &&
      ['0', '1'].includes(args[0]));
  if (!valid) {
    throw workflowError(
      'INVALID_HOOK_USAGE',
      'Usage: pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> [hook arguments].',
      ExitCode.usage,
    );
  }
}

function validateCommitMessage(cwd: string, requestedPath: string): void {
  const git = discoverRepository(cwd);
  const expectedValue = runGit(git.repositoryRoot, [
    'rev-parse',
    '--git-path',
    'COMMIT_EDITMSG',
  ]).trim();
  const expectedPath = path.resolve(git.repositoryRoot, expectedValue);
  const messagePath = path.resolve(git.repositoryRoot, requestedPath);
  const stats = fs.lstatSync(messagePath, { throwIfNoEntry: false });
  const expectedStats = fs.lstatSync(expectedPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > 1024 * 1024 ||
    !expectedStats?.isFile() ||
    expectedStats.isSymbolicLink()
  ) {
    throw invalidCommitMessage(['Commit message file is missing or unsafe.']);
  }
  if (fs.realpathSync(messagePath) !== fs.realpathSync(expectedPath)) {
    throw workflowError(
      'COMMIT_MESSAGE_FILE_UNEXPECTED',
      'commit-msg must validate the current worktree Git message file.',
      ExitCode.guard,
    );
  }
  const lines = fs
    .readFileSync(messagePath, 'utf8')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  if (hasManagedTrailerLine(lines.join('\n'))) {
    throw workflowError(
      'MANAGED_TRAILERS_REQUIRE_WORKFLOW_COMMIT',
      'Managed trailers may only be created by a workflow commit transition.',
      ExitCode.guard,
    );
  }
  const header = (lines[0] ?? '').trim();
  const body = lines.slice(1);
  const errors: string[] = [];
  if (!header) {
    errors.push('Commit message requires a summary.');
  }
  if (header.length > 72) {
    errors.push('Summary exceeds 72 characters.');
  }
  if (/\b(?:WIP|FIXUP|SQUASH)\b/i.test(header)) {
    errors.push('Summary contains a placeholder.');
  }
  if (header.endsWith('.')) {
    errors.push('Summary ends with a period.');
  }
  const headerAfterEmoji = header.replace(/^[^\p{L}\p{N}]+\s*/u, '');
  if (/^[a-z]/.test(headerAfterEmoji)) {
    errors.push('Summary must start with a capitalized verb.');
  }
  if (body.some((line) => line.trim())) {
    if ((body[0] ?? '').trim()) {
      errors.push('Summary and body require a blank separator.');
    }
    if (body.some((line) => line.length > 100)) {
      errors.push('Body line exceeds 100 characters.');
    }
  }
  if (errors.length > 0) {
    throw invalidCommitMessage(errors);
  }
}

function invalidCommitMessage(errors: string[]) {
  return workflowError(
    'COMMIT_MESSAGE_INVALID',
    'Commit message does not satisfy repository guidelines.',
    ExitCode.guard,
    { details: { errors } },
  );
}
