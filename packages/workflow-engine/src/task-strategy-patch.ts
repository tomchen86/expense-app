import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveActorIdentity, type ResolvedActor } from './actor-identity.ts';
import { canonicalJson } from './canonical-json.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { previewExactStaging } from './git-transitions.ts';
import { runGit, runGitWithEnvironment } from './git.ts';
import {
  investigationRuntimePaths,
  matchesAllowedPath,
  normalizeChangedPath,
} from './paths.ts';
import { readTaskStrategyTransaction } from './task-strategy-store.ts';
import { inspectSession, type SessionInspection } from './verification.ts';

const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_PATHS = 1024;

export type TaskStrategyPatchValidation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-validation.v1';
  sessionId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  sourceTree: string;
  candidateTree: string;
  patchDigest: string;
  changedPaths: readonly string[];
  changes: readonly Readonly<{
    path: string;
    before: Readonly<{ mode: '100644' | '100755'; objectId: string }> | null;
    after: Readonly<{ mode: '100644' | '100755'; objectId: string }> | null;
  }>[];
  implementer: ResolvedActor;
}>;

export function validateTaskStrategyPatch(
  cwd: string,
  requestedSessionId: string,
  input: Readonly<{
    patch: string | Buffer;
    explicitActor?: string;
    environment?: NodeJS.ProcessEnv;
  }>,
): TaskStrategyPatchValidation {
  const patchBytes =
    typeof input.patch === 'string' ? Buffer.from(input.patch) : input.patch;
  if (patchBytes.length === 0 || patchBytes.length > MAX_PATCH_BYTES) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_INVALID',
      'The implementation patch is empty or exceeds the bounded byte limit.',
      ExitCode.verification,
      {
        details: {
          patchBytes: patchBytes.length,
          maxPatchBytes: MAX_PATCH_BYTES,
        },
      },
    );
  }
  const inspection = inspectSession(cwd, requestedSessionId);
  const task = executionTask(inspection);
  const transaction = readTaskStrategyTransaction(
    investigationRuntimePaths(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    ),
    inspection.session.sessionId,
  );
  if (
    transaction === null ||
    transaction.phase !== 'red-sealed' ||
    transaction.changeId !== inspection.session.changeId ||
    transaction.taskId !== inspection.session.taskId ||
    transaction.strategy !== task.strategy ||
    transaction.taskContractDigest !== sha256(canonicalJson(task)) ||
    canonicalJson(transaction.baseline) !==
      canonicalJson(inspection.session.baseline)
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_REQUIRED',
      'Patch validation requires the exact current engine-sealed RED transaction.',
      ExitCode.verification,
    );
  }
  const current = previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  );
  if (current.tree !== transaction.red.candidateTree) {
    throw workflowError(
      'TASK_STRATEGY_RED_STALE',
      'The task worktree changed after RED sealing and before isolated patch validation.',
      ExitCode.staleState,
    );
  }
  const actorResolution = resolveActorIdentity({
    ...(input.explicitActor === undefined
      ? {}
      : { explicitActor: input.explicitActor }),
    environment: input.environment ?? process.env,
  });
  if (actorResolution.outcome !== 'resolved') {
    throw workflowError(
      actorResolution.code,
      'Patch validation requires one exact implementation actor.',
      ExitCode.guard,
    );
  }
  if (
    task.strategy === 'cross-agent-tdd' &&
    actorResolution.actor.providerId === transaction.author.providerId
  ) {
    throw workflowError(
      'TASK_STRATEGY_IMPLEMENTER_REQUIRED',
      'Cross-agent TDD forbids the RED author from supplying the implementation patch.',
      ExitCode.guard,
      {
        details: { redAuthor: transaction.author.providerId },
        recovery:
          'Use a provider-independent implementer or an exact bounded collaboration grant.',
      },
    );
  }

  const projection = applyPatchToIsolatedTree(
    inspection.git.repositoryRoot,
    transaction.red.candidateTree,
    patchBytes,
  );
  if (
    projection.changedPaths.length === 0 ||
    projection.changedPaths.length > MAX_PATCH_PATHS
  ) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_INVALID',
      'The implementation patch produced no bounded tree delta.',
      ExitCode.verification,
    );
  }
  const frozen = new Set(transaction.red.files.map(({ path }) => path));
  const frozenChanges = projection.changedPaths.filter((entry) =>
    frozen.has(entry),
  );
  if (frozenChanges.length > 0) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_FROZEN_PATH',
      'The implementation patch modifies an engine-sealed RED test or fixture.',
      ExitCode.verification,
      { details: { paths: frozenChanges } },
    );
  }
  const scopeEscapes = projection.changedPaths.filter(
    (entry) =>
      !task.implementationPathScopes.some((scope) =>
        matchesAllowedPath(entry, scope),
      ),
  );
  if (scopeEscapes.length > 0) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_SCOPE_INVALID',
      'The implementation patch escapes the reviewed implementation scopes.',
      ExitCode.verification,
      { details: { paths: scopeEscapes } },
    );
  }
  const changes = projection.changedPaths.map((changedPath) => ({
    path: changedPath,
    before: readRegularTreeEntry(
      inspection.git.repositoryRoot,
      transaction.red.candidateTree,
      changedPath,
    ),
    after: readRegularTreeEntry(
      inspection.git.repositoryRoot,
      projection.candidateTree,
      changedPath,
    ),
  }));
  return Object.freeze({
    schemaVersion: 1,
    kind: 'task-strategy-patch-validation.v1',
    sessionId: inspection.session.sessionId,
    strategy: task.strategy,
    sourceTree: transaction.red.candidateTree,
    candidateTree: projection.candidateTree,
    patchDigest: sha256(patchBytes),
    changedPaths: Object.freeze(projection.changedPaths),
    changes: Object.freeze(changes),
    implementer: Object.freeze(actorResolution.actor),
  });
}

function applyPatchToIsolatedTree(
  repositoryRoot: string,
  sourceTree: string,
  patchBytes: Buffer,
): { candidateTree: string; changedPaths: string[] } {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-task-patch-'),
  );
  const indexEnvironment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  const patchPath = path.join(temporaryDirectory, 'candidate.patch');
  try {
    fs.writeFileSync(patchPath, patchBytes, { flag: 'wx', mode: 0o600 });
    runGitWithEnvironment(
      repositoryRoot,
      ['read-tree', sourceTree],
      indexEnvironment,
    );
    try {
      runGitWithEnvironment(
        repositoryRoot,
        [
          'apply',
          '--cached',
          '--binary',
          '--whitespace=error-all',
          '--recount',
          '--',
          patchPath,
        ],
        indexEnvironment,
      );
    } catch {
      throw workflowError(
        'TASK_STRATEGY_PATCH_INVALID',
        'The implementation patch does not apply exactly to the sealed RED tree.',
        ExitCode.verification,
      );
    }
    const candidateTree = runGitWithEnvironment(
      repositoryRoot,
      ['write-tree'],
      indexEnvironment,
    ).trim();
    const changedPaths = runGitWithEnvironment(
      repositoryRoot,
      [
        'diff',
        '--cached',
        '--name-only',
        '--no-renames',
        '-z',
        sourceTree,
        '--',
      ],
      indexEnvironment,
    )
      .split('\0')
      .filter(Boolean)
      .map(normalizeChangedPath)
      .sort();
    if (new Set(changedPaths).size !== changedPaths.length) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_INVALID',
        'The derived implementation path set is not canonical.',
        ExitCode.verification,
      );
    }
    return { candidateTree, changedPaths };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readRegularTreeEntry(
  repositoryRoot: string,
  tree: string,
  candidatePath: string,
): Readonly<{ mode: '100644' | '100755'; objectId: string }> | null {
  const output = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${candidatePath}`,
  ]);
  if (output === '') return null;
  const match =
    /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_MODE_INVALID',
      'The implementation patch creates an unsupported file mode, symlink, or submodule.',
      ExitCode.verification,
      { details: { path: candidatePath } },
    );
  }
  return Object.freeze({
    mode: match[1] as '100644' | '100755',
    objectId: match[2]!,
  });
}

function executionTask(
  inspection: SessionInspection,
): CrossAgentTddExecution | TddSingleAgentExecution {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (
    task?.strategy !== 'cross-agent-tdd' &&
    task?.strategy !== 'tdd-single-agent'
  ) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_NOT_APPLICABLE',
      'The active task does not admit a TDD implementation patch.',
      ExitCode.guard,
    );
  }
  return task;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
