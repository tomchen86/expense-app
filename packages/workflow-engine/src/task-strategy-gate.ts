import crypto from 'node:crypto';

import { resolveActorIdentity } from './actor-identity.ts';
import { canonicalJson } from './canonical-json.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { previewExactStaging } from './git-transitions.ts';
import { runGit } from './git.ts';
import { investigationRuntimePaths, matchesAllowedPath } from './paths.ts';
import {
  readTaskStrategyTransaction,
  type TaskStrategyFrozenFile,
} from './task-strategy-store.ts';
import type { SessionInspection } from './verification.ts';

/**
 * Shared check/finalize predicate for strategy-specific execution evidence.
 * It does not interpret review findings or close challenges; TaskDiff Final
 * Assurance remains the only challenge-closure authority.
 */
export function assertTaskStrategyExecutionGate(
  inspection: SessionInspection,
  environment: NodeJS.ProcessEnv,
): void {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (
    task?.strategy !== 'cross-agent-tdd' &&
    task?.strategy !== 'tdd-single-agent'
  ) {
    return;
  }
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const transaction = readTaskStrategyTransaction(
    runtime,
    inspection.session.sessionId,
  );
  if (transaction === null) {
    throw workflowError(
      'TASK_STRATEGY_RED_REQUIRED',
      'The task cannot run GREEN checks until the engine seals exact RED evidence.',
      ExitCode.verification,
      {
        recovery:
          'Seal the strategy RED transaction with the registered failing check before implementation.',
      },
    );
  }
  if (
    transaction.changeId !== inspection.session.changeId ||
    transaction.taskId !== inspection.session.taskId ||
    transaction.strategy !== task.strategy ||
    canonicalJson(transaction.baseline) !==
      canonicalJson(inspection.session.baseline) ||
    transaction.taskContractDigest !== sha256(canonicalJson(task))
  ) {
    throw redStale();
  }
  const preview = previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  );
  const currentRedPaths = classifyCurrentRedPaths(
    inspection.changedPaths,
    task,
  );
  if (
    canonicalJson(currentRedPaths.testPaths) !==
      canonicalJson(transaction.red.testPaths) ||
    canonicalJson(currentRedPaths.fixturePaths) !==
      canonicalJson(transaction.red.fixturePaths) ||
    canonicalJson(
      readFrozenFiles(
        inspection.git.repositoryRoot,
        preview.tree,
        transaction.red.files.map(({ path }) => path),
      ),
    ) !== canonicalJson(transaction.red.files)
  ) {
    throw redStale();
  }
  if (task.strategy === 'cross-agent-tdd') {
    const actor = resolveActorIdentity({ environment });
    if (
      actor.outcome !== 'resolved' ||
      actor.actor.providerId === transaction.author.providerId
    ) {
      throw workflowError(
        'TASK_STRATEGY_IMPLEMENTER_REQUIRED',
        'Cross-agent TDD requires a provider-independent implementation actor after RED is sealed.',
        ExitCode.guard,
        {
          details: { redAuthor: transaction.author.providerId },
          recovery:
            'Resume implementation with a different engine-attributed provider, then rerun the managed checks.',
        },
      );
    }
  }
}

function classifyCurrentRedPaths(
  changedPaths: readonly string[],
  task: CrossAgentTddExecution | TddSingleAgentExecution,
): { testPaths: string[]; fixturePaths: string[] } {
  const testPaths: string[] = [];
  const fixturePaths: string[] = [];
  for (const changedPath of changedPaths) {
    if (
      task.fixturePathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      fixturePaths.push(changedPath);
    } else if (
      task.testPathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      testPaths.push(changedPath);
    }
  }
  return { testPaths: testPaths.sort(), fixturePaths: fixturePaths.sort() };
}

function readFrozenFiles(
  repositoryRoot: string,
  tree: string,
  paths: readonly string[],
): TaskStrategyFrozenFile[] {
  return paths.map((candidatePath) => {
    const output = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      tree,
      '--',
      `:(literal)${candidatePath}`,
    ]);
    const match =
      /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
        output,
      );
    if (!match || match[3] !== candidatePath) throw redStale();
    return {
      path: candidatePath,
      mode: match[1] as TaskStrategyFrozenFile['mode'],
      objectId: match[2]!,
    };
  });
}

function redStale() {
  return workflowError(
    'TASK_STRATEGY_RED_STALE',
    'The sealed RED transaction no longer matches the exact task or frozen test and fixture bytes.',
    ExitCode.staleState,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
