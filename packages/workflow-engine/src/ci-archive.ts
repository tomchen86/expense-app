import fs from 'node:fs';
import path from 'node:path';

import { verifyArchiveDeltaOutcomes } from './archive-delta-verifier.ts';
import { preEpochCompletedTaskIds } from './bootstrap-task-exemption.ts';
import { canonicalCheckDefinition } from './ci-historical-contract.ts';
import {
  assertArchiveReplayContent,
  inspectArchiveCommitTree,
  isArchiveName,
  normalizeArchivePaths,
} from './ci-archive-tree.ts';
import {
  loadChangeContract,
  loadChecksConfig,
  loadWorkflowConfig,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import {
  archiveCommitMessage,
  commitChangedPaths,
  commitFacts,
  findExactTaskCommits,
} from './git-transitions.ts';
import { listChangedPaths, runGit } from './git.ts';
import {
  createOpenSpecProcess,
  resolveOpenSpecInstallation,
} from './openspec-executor.ts';
import {
  parseSchemaResolution,
  parseSchemaValidation,
  parseStatus,
  parseValidation,
} from './openspec-payloads.ts';
import { inspectOpenSpecSchemaContract } from './openspec-schema-contract.ts';

type ArchiveTotals = {
  added: number;
  modified: number;
  removed: number;
  renamed: number;
};

export type CiArchiveValidation = {
  changeId: string;
  archivePath: string;
  changedPaths: string[];
  checkDefinitions: Record<string, string>;
};

export function validateCiArchiveCommit(
  repositoryRoot: string,
  commitHash: string,
  changeId: string,
): CiArchiveValidation {
  assertChangeId(changeId);
  const facts = commitFacts(repositoryRoot, commitHash);
  if (
    facts.parents.length !== 1 ||
    facts.message !== `${archiveCommitMessage(changeId)}\n`
  ) {
    throw archiveError(
      'CI_ARCHIVE_MESSAGE_INVALID',
      'Archive commits require the exact managed message and one parent.',
    );
  }
  const parent = facts.parents[0];
  const changedPaths = commitChangedPaths(repositoryRoot, commitHash);
  const config = loadWorkflowConfig(repositoryRoot);
  const archivePath = inspectArchiveCommitTree(
    repositoryRoot,
    parent,
    commitHash,
    config.changeRoot,
    changeId,
    changedPaths,
  );

  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const schema = inspectOpenSpecSchemaContract(repositoryRoot);
  const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
  if (!temporaryBase) {
    throw archiveError(
      'CI_ARCHIVE_TEMPORARY_DIRECTORY_UNAVAILABLE',
      'Archive replay requires a trusted temporary directory.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-ci-archive-'),
  );
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    runGit(repositoryRoot, ['worktree', 'add', '--detach', worktree, parent]);
    worktreeAdded = true;
    const contract = loadChangeContract(worktree, changeId);
    if (contract.tasks.some(({ completed }) => !completed)) {
      throw archiveError(
        'CI_ARCHIVE_TASKS_INCOMPLETE',
        'Every archived task must be complete in the archive parent.',
      );
    }
    assertTaskEvidence(
      repositoryRoot,
      parent,
      config.changeRoot,
      contract.changeId,
      contract.tasks,
    );
    const checkDefinitions = archiveCheckDefinitions(worktree, contract);
    const openspec = createOpenSpecProcess(installation, {
      executionRoot: worktree,
    });
    validateOpenSpecInputs(openspec, worktree, changeId, schema);
    const payload = parseArchivePayload(
      openspec.archive(changeId),
      worktree,
      changeId,
    );
    validateRebuiltSpecs(openspec, worktree);
    const replayPaths = listChangedPaths(worktree, parent);
    if (
      JSON.stringify(normalizeArchivePaths(changedPaths, changeId)) !==
      JSON.stringify(normalizeArchivePaths(replayPaths, changeId))
    ) {
      throw replayMismatch();
    }
    assertArchiveReplayContent(
      repositoryRoot,
      commitHash,
      archivePath,
      worktree,
      payload.archivePath,
      replayPaths,
    );
    const baseSpecPaths = replayPaths.filter((filePath) =>
      filePath.startsWith('openspec/specs/'),
    );
    verifyArchiveDeltaOutcomes(
      repositoryRoot,
      { changeId, head: parent },
      {
        baseSpecPaths,
        tree: commitHash,
        totals: payload.totals,
      },
    );
    return { changeId, archivePath, changedPaths, checkDefinitions };
  } finally {
    if (worktreeAdded) {
      runGit(repositoryRoot, ['worktree', 'remove', '--force', worktree]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function validateOpenSpecInputs(
  openspec: ReturnType<typeof createOpenSpecProcess>,
  worktree: string,
  changeId: string,
  schema: ReturnType<typeof inspectOpenSpecSchemaContract>,
): void {
  openspec.version();
  for (const expected of [
    {
      name: 'spec-driven',
      source: 'package' as const,
      path: schema.packageSchema.directory,
    },
    {
      name: 'expense-app',
      source: 'project' as const,
      path: path.join(worktree, 'openspec/schemas/expense-app'),
    },
  ]) {
    parseSchemaResolution(openspec.whichSchema(expected.name).value, expected);
    const validation = parseSchemaValidation(
      openspec.validateSchema(expected.name).value,
      expected,
    );
    if (!validation.valid) throw replayMismatch();
  }
  const status = parseStatus(openspec.status(changeId, 'expense-app').value, {
    repositoryRoot: worktree,
    changeId,
    schemaName: 'expense-app',
  });
  const executed = openspec.validateChange(changeId);
  const validation = parseValidation(executed.value, {
    repositoryRoot: worktree,
    expectedType: 'change',
    expectedId: changeId,
  });
  if (executed.status !== 0 || !status.isComplete || !validation.valid) {
    throw replayMismatch();
  }
}

function parseArchivePayload(
  executed: { value: unknown; status: number },
  worktree: string,
  changeId: string,
): { archivePath: string; totals: ArchiveTotals } {
  const value = executed.value;
  if (executed.status !== 0 || !isRecord(value) || !isRecord(value.archive)) {
    throw replayMismatch();
  }
  const archive = value.archive;
  const root = value.root;
  const totals = archive.totals;
  if (
    !hasExactKeys(value, ['archive', 'root']) ||
    !isRecord(root) ||
    !hasExactKeys(root, ['path', 'source']) ||
    root.path !== worktree ||
    root.source !== 'nearest' ||
    !hasExactKeys(archive, [
      'archivedAs',
      'change',
      'path',
      'specsUpdated',
      'totals',
    ]) ||
    archive.change !== changeId ||
    archive.specsUpdated !== true ||
    typeof archive.archivedAs !== 'string' ||
    archive.path !==
      path.join(worktree, 'openspec/changes/archive', archive.archivedAs) ||
    !isArchiveName(archive.archivedAs, changeId) ||
    !isTotals(totals)
  ) {
    throw replayMismatch();
  }
  return {
    archivePath: `openspec/changes/archive/${archive.archivedAs}`,
    totals,
  };
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
  if (executed.status !== 0 || !validation.valid) throw replayMismatch();
}

function assertTaskEvidence(
  repositoryRoot: string,
  parent: string,
  changeRoot: string,
  changeId: string,
  tasks: Array<{ id: string }>,
): void {
  const exemptTaskIds = preEpochCompletedTaskIds(
    repositoryRoot,
    changeRoot,
    changeId,
    parent,
  );
  for (const task of tasks) {
    const commits = findExactTaskCommits(repositoryRoot, changeId, task.id);
    if (commits.length !== 1) {
      if (exemptTaskIds.has(task.id)) {
        continue;
      }
      throw archiveError(
        'CI_ARCHIVE_TASK_EVIDENCE_INVALID',
        'Every archived task requires one reachable canonical task commit.',
      );
    }
    if (
      runGit(
        repositoryRoot,
        ['merge-base', commits[0].hash, parent],
        true,
      ).trim() !== commits[0].hash
    ) {
      throw archiveError(
        'CI_ARCHIVE_TASK_EVIDENCE_INVALID',
        'Every archived task requires one reachable canonical task commit.',
      );
    }
  }
}

function archiveCheckDefinitions(
  repositoryRoot: string,
  contract: ReturnType<typeof loadChangeContract>,
): Record<string, string> {
  const checks = loadChecksConfig(repositoryRoot).checks;
  return Object.fromEntries(
    [
      ...new Set(
        Object.values(contract.guard.tasks).flatMap(
          ({ requiredChecks }) => requiredChecks,
        ),
      ),
    ]
      .sort()
      .map((checkId) => {
        const definition = checks[checkId];
        if (!definition) throw replayMismatch();
        return [checkId, canonicalCheckDefinition(definition)];
      }),
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

function assertChangeId(changeId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) throw replayMismatch();
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replayMismatch() {
  return archiveError(
    'CI_ARCHIVE_REPLAY_MISMATCH',
    'Archive commit differs from the independently replayed transformation.',
  );
}

function archiveError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
