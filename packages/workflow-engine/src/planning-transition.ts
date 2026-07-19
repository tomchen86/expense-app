import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  commitChangedPaths,
  commitFacts,
  createPlanningCommitObject,
  listStagedPaths,
  planningCommitMessage,
  stageExactPaths,
  updateManagedRef,
} from './git-transitions.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  listChangedPaths,
  runGit,
} from './git.ts';
import { assertChangeId, normalizeChangedPath } from './paths.ts';
import {
  assertPlanningPaths,
  inspectPlanningTransition,
  taskStates,
  validateOpenSpecPlanning,
} from './planning-contract.ts';
import {
  readPlanningTransitionReport,
  writePlanningTransitionReport,
  type PlanningTransitionReport,
} from './planning-report.ts';
import { runtimePaths } from './session-store.ts';
import { withPlanningAuthority } from './planning-lock.ts';

export type PlanningTransitionResult = {
  changeId: string;
  kind: 'introduction' | 'revision';
  subject: string;
  baselineHead: string;
  changedPaths: string[];
  stagedPaths: string[];
  tree: string;
  commitHash: string;
  reportId: string;
};

export type PlanningTransitionTestHooks = {
  beforeStaging?(context: {
    repositoryRoot: string;
    expectedHead: string;
  }): void;
  beforeRefUpdate?(context: {
    repositoryRoot: string;
    expectedHead: string;
    expectedRef: string;
    commitHash: string;
  }): void;
};

export {
  assertPlanningPaths,
  assertPlanningTaskHistory,
} from './planning-contract.ts';

export function commitPlanningTransition(
  cwd: string,
  requestedChangeId: string,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: PlanningTransitionTestHooks = {},
): PlanningTransitionResult {
  const changeId = assertChangeId(requestedChangeId);
  const locator = discoverRepository(cwd);
  const config = loadWorkflowConfig(locator.repositoryRoot);
  const runtime = runtimePaths(
    locator.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withPlanningAuthority(runtime, changeId, (assertLocksOwned) =>
    commitPlanningTransitionLocked(
      cwd,
      changeId,
      environment,
      testHooks,
      assertLocksOwned,
    ),
  );
}

function commitPlanningTransitionLocked(
  cwd: string,
  changeId: string,
  environment: NodeJS.ProcessEnv,
  testHooks: PlanningTransitionTestHooks,
  assertLocksOwned: () => void,
): PlanningTransitionResult {
  const initial = discoverRepository(cwd);
  const config = loadWorkflowConfig(initial.repositoryRoot);
  const requiredBranch = config.branchTemplate.replaceAll(
    '{changeId}',
    changeId,
  );
  const headRef = `refs/heads/${requiredBranch}`;
  if (!initial.branch) {
    throw planningGuard('DETACHED_HEAD', 'Planning commits require a branch.');
  }
  if (initial.branch !== requiredBranch) {
    throw planningGuard(
      'WRONG_BRANCH',
      `Change ${changeId} requires branch ${requiredBranch}, not ${initial.branch}.`,
    );
  }
  if (config.protectedBranches.includes(initial.branch)) {
    throw planningGuard(
      'PROTECTED_BRANCH',
      `Planning commits are disabled on protected branch ${initial.branch}.`,
    );
  }
  if (
    runGit(
      initial.repositoryRoot,
      ['symbolic-ref', '--quiet', 'HEAD'],
      true,
    ).trim() !== headRef
  ) {
    throw planningGuard(
      'PLANNING_BRANCH_REF_INVALID',
      'Planning transition could not pin the expected full branch ref.',
    );
  }
  if (listStagedPaths(initial.repositoryRoot, initial.head).length > 0) {
    throw workflowError(
      'STAGING_ALREADY_PRESENT',
      'Planning transitions require an empty Git index.',
      ExitCode.staleState,
    );
  }

  const changedPaths = listChangedPaths(initial.repositoryRoot, initial.head);
  if (changedPaths.length === 0) {
    throw workflowError(
      'PLANNING_DIFF_REQUIRED',
      'Planning transition requires a non-empty planning diff.',
      ExitCode.verification,
    );
  }
  const deletedPaths = changedPaths.filter(
    (changedPath) =>
      !fs.existsSync(path.join(initial.repositoryRoot, changedPath)),
  );
  assertPlanningPaths(config.changeRoot, changeId, changedPaths, deletedPaths);
  const initialFingerprint = fingerprintRepositoryWorktree(
    initial.repositoryRoot,
    initial.head,
  );
  const inspection = inspectPlanningTransition(
    initial.repositoryRoot,
    initial.head,
    config.changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
  );
  const openspec = validateOpenSpecPlanning(
    initial.repositoryRoot,
    changeId,
    inspection.schemaName,
  );

  assertUnstagedPlanningState(
    initial,
    headRef,
    changedPaths,
    initialFingerprint,
  );
  const verified = inspectPlanningTransition(
    initial.repositoryRoot,
    initial.head,
    config.changeRoot,
    changeId,
    changedPaths,

    deletedPaths,
  );
  if (
    verified.transitionKind !== inspection.transitionKind ||
    verified.schemaName !== inspection.schemaName ||
    JSON.stringify(verified.artifactDigests) !==
      JSON.stringify(inspection.artifactDigests)
  ) {
    throw planningStale('PLANNING_ARTIFACTS_CHANGED');
  }

  let previousIndexTree = runGit(initial.repositoryRoot, ['write-tree']).trim();
  let stagedTree: string | undefined;
  let refUpdated = false;
  try {
    testHooks.beforeStaging?.({
      repositoryRoot: initial.repositoryRoot,
      expectedHead: initial.head,
    });
    const staged = stageExactPaths(
      initial.repositoryRoot,
      initial.head,
      changedPaths,
    );
    stagedTree = staged.tree;
    previousIndexTree = staged.previousIndexTree;
    assertStagedPlanningState(
      initial.repositoryRoot,
      initial.head,
      headRef,
      changedPaths,
      staged.tree,
      initialFingerprint,
    );
    assertStagedPlanningTree(
      initial.repositoryRoot,
      staged.tree,
      `${config.changeRoot}/${changeId}`,
      inspection.currentPaths,
      inspection.artifactDigests,
    );

    const subject = `Plan ${changeId}`;
    const message = planningCommitMessage(changeId);
    const commitHash = createPlanningCommitObject(
      initial.repositoryRoot,
      staged.tree,
      initial.head,
      changeId,
      environment,
    );
    assertPlanningCommitObject(
      initial.repositoryRoot,
      commitHash,
      initial.head,
      staged.tree,
      changedPaths,
      message,
    );

    const report: PlanningTransitionReport = {
      schemaVersion: 1,
      kind: 'planning-transition',
      createdAt: new Date().toISOString(),
      changeId,
      transition: 'plan',
      transitionKind: inspection.transitionKind,
      subject,
      message,
      trailers: [`Change: ${changeId}`, 'Transition: plan'],
      branch: requiredBranch,
      headRef,
      parent: { head: initial.head, tree: initial.tree },
      tree: staged.tree,
      commitHash,
      changedPaths,
      artifactDigests: inspection.artifactDigests,
      fingerprint: initialFingerprint,
      tasks: {
        before: inspection.beforeTasks
          ? taskStates(inspection.beforeTasks)
          : null,
        after: taskStates(inspection.contract.tasks),
      },
      openspec,
    };
    const reportsDirectory = path.join(
      initial.gitCommonDirectory,
      config.runtimeDirectory,
      'planning-reports',
    );
    const reportId = writePlanningTransitionReport(reportsDirectory, report);
    assertPlanningReportPersisted(reportsDirectory, reportId, report);

    testHooks.beforeRefUpdate?.({
      repositoryRoot: initial.repositoryRoot,
      expectedHead: initial.head,
      expectedRef: headRef,
      commitHash,
    });
    assertPlanningReportPersisted(reportsDirectory, reportId, report);
    assertLocksOwned();
    assertStagedPlanningState(
      initial.repositoryRoot,
      initial.head,
      headRef,
      changedPaths,
      staged.tree,
      initialFingerprint,
    );
    try {
      updateManagedRef(
        initial.repositoryRoot,
        initial.head,
        commitHash,
        headRef,
      );
    } catch (error) {
      if (
        runGit(initial.repositoryRoot, ['rev-parse', headRef], true).trim() !==
          initial.head ||
        runGit(
          initial.repositoryRoot,
          ['symbolic-ref', '--quiet', 'HEAD'],
          true,
        ).trim() !== headRef
      ) {
        throw planningStale('PLANNING_HEAD_CHANGED');
      }
      throw error;
    }
    refUpdated = true;
    if (
      runGit(
        initial.repositoryRoot,
        ['symbolic-ref', '--quiet', 'HEAD'],
        true,
      ).trim() !== headRef ||
      runGit(initial.repositoryRoot, ['rev-parse', 'HEAD']).trim() !==
        commitHash
    ) {
      throw planningStale('PLANNING_HEAD_CHANGED');
    }

    return {
      changeId,
      kind: inspection.transitionKind,
      subject,
      baselineHead: initial.head,
      changedPaths,
      stagedPaths: staged.stagedPaths,
      tree: staged.tree,
      commitHash,
      reportId,
    };
  } catch (error) {
    if (stagedTree && !refUpdated) {
      rollbackIndexLease(
        initial.repositoryRoot,
        previousIndexTree,
        stagedTree,
        error,
      );
    }
    throw error;
  }
}

function assertPlanningReportPersisted(
  reportsDirectory: string,
  reportId: string,
  expected: PlanningTransitionReport,
): void {
  const persisted = readPlanningTransitionReport(reportsDirectory, reportId);
  if (JSON.stringify(persisted) !== JSON.stringify(expected)) {
    throw planningStale('PLANNING_REPORT_STALE');
  }
}

function assertUnstagedPlanningState(
  initial: ReturnType<typeof discoverRepository>,
  headRef: string,
  changedPaths: string[],
  expectedFingerprint: string,
): void {
  const current = discoverRepository(initial.repositoryRoot);
  if (
    current.repositoryRealPath !== initial.repositoryRealPath ||
    current.gitCommonDirectory !== initial.gitCommonDirectory ||
    current.branch !== initial.branch ||
    current.head !== initial.head ||
    current.tree !== initial.tree ||
    runGit(
      current.repositoryRoot,
      ['symbolic-ref', '--quiet', 'HEAD'],
      true,
    ).trim() !== headRef ||
    JSON.stringify(listChangedPaths(current.repositoryRoot, current.head)) !==
      JSON.stringify(changedPaths) ||
    listStagedPaths(current.repositoryRoot, current.head).length > 0 ||
    fingerprintRepositoryWorktree(current.repositoryRoot, current.head) !==
      expectedFingerprint
  ) {
    throw planningStale('PLANNING_STATE_CHANGED');
  }
}

function assertStagedPlanningState(
  repositoryRoot: string,
  expectedHead: string,
  expectedRef: string,
  expectedPaths: string[],
  expectedTree: string,
  expectedFingerprint: string,
): void {
  const unstaged = runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeChangedPath)
    .sort();
  if (
    runGit(repositoryRoot, ['symbolic-ref', '--quiet', 'HEAD'], true).trim() !==
      expectedRef ||
    runGit(repositoryRoot, ['rev-parse', expectedRef], true).trim() !==
      expectedHead
  ) {
    throw planningStale('PLANNING_HEAD_CHANGED');
  }
  if (
    JSON.stringify(listChangedPaths(repositoryRoot, expectedHead)) !==
      JSON.stringify(expectedPaths) ||
    JSON.stringify(listStagedPaths(repositoryRoot, expectedHead)) !==
      JSON.stringify(expectedPaths) ||
    runGit(repositoryRoot, ['write-tree']).trim() !== expectedTree ||
    unstaged.length > 0 ||
    fingerprintRepositoryWorktree(repositoryRoot, expectedHead) !==
      expectedFingerprint
  ) {
    throw planningStale('PLANNING_STATE_CHANGED');
  }
}

function assertPlanningCommitObject(
  repositoryRoot: string,
  commitHash: string,
  parent: string,
  tree: string,
  changedPaths: string[],
  message: string,
): void {
  const facts = commitFacts(repositoryRoot, commitHash);
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([parent]) ||
    facts.tree !== tree ||
    facts.message !== `${message}\n` ||
    JSON.stringify(commitChangedPaths(repositoryRoot, commitHash)) !==
      JSON.stringify(changedPaths)
  ) {
    throw planningStale('PLANNING_COMMIT_INVALID');
  }
}

function assertStagedPlanningTree(
  repositoryRoot: string,
  tree: string,
  changePrefix: string,
  expectedPaths: string[],
  expectedDigests: Record<string, string>,
): void {
  const entries = runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    tree,
    '--',
    `:(literal)${changePrefix}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\S+) ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match) {
        throw planningStale('PLANNING_TREE_INVALID');
      }
      return {
        mode: match[1],
        type: match[2],
        objectId: match[3],
        path: normalizeChangedPath(match[4]),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    JSON.stringify(entries.map((entry) => entry.path)) !==
      JSON.stringify(expectedPaths) ||
    entries.some((entry) => entry.mode !== '100644' || entry.type !== 'blob')
  ) {
    throw planningStale('PLANNING_TREE_INVALID');
  }
  for (const entry of entries) {
    const expectedDigest = expectedDigests[entry.path];
    const content = runGit(repositoryRoot, [
      'cat-file',
      'blob',
      entry.objectId,
    ]);
    const actualDigest = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
    if (!expectedDigest || actualDigest !== expectedDigest) {
      throw planningStale('PLANNING_TREE_INVALID');
    }
  }
}

function rollbackIndexLease(
  repositoryRoot: string,
  previousIndexTree: string,
  workflowStagedTree: string,
  cause: unknown,
): void {
  const currentIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (currentIndexTree !== workflowStagedTree) {
    throw workflowError(
      'PLANNING_INDEX_DIVERGED',
      'The Git index changed after workflow staging; foreign staging was preserved.',
      ExitCode.staleState,
      {
        details: {
          causeCode: cause instanceof WorkflowError ? cause.code : undefined,
        },
      },
    );
  }
  runGit(repositoryRoot, ['read-tree', previousIndexTree]);
}

function planningGuard(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}

function planningStale(code: string) {
  return workflowError(
    code,
    'Planning transition state changed before authorization completed.',
    ExitCode.staleState,
  );
}
