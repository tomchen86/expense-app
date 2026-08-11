import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import { ExitCode, workflowError } from './errors.ts';
import { readFinalizeTransaction } from './finalize-transaction.ts';
import { listStagedPaths, previewExactStaging } from './git-transitions.ts';
import { fingerprintUnstagedRepositoryProjection, runGit } from './git.ts';
import { loadActiveSessionContext } from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
} from './path-role-registry.ts';
import {
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
} from './report-validation.ts';
import {
  createTaskDiffReviewSubject,
  taskDiffReviewRequirement,
  type TaskDiffPathTransition,
  type TaskDiffReviewSubject,
  type TaskDiffTreeEntry,
} from './task-diff-review.ts';
import { inspectSession } from './verification.ts';

/**
 * Derive the immutable exact-diff review subject from a checked projected
 * finalize transaction. This is read-only: it neither accepts a review nor
 * advances the finalize journal.
 */
export function inspectTaskDiffReviewSubject(
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewSubject {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const transaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  if (
    transaction === null ||
    !['checked', 'staged', 'reports-persisted', 'completed'].includes(
      transaction.phase,
    ) ||
    transaction.candidateTree === null ||
    transaction.candidateFingerprint === null ||
    transaction.checkReportId === null
  ) {
    throw reviewNotReady();
  }
  const checkedTransaction = transaction as typeof transaction & {
    candidateTree: string;
    candidateFingerprint: string;
    checkReportId: string;
  };
  if (
    transaction.sessionId !== context.session.sessionId ||
    transaction.changeId !== context.session.changeId ||
    transaction.taskId !== context.session.taskId ||
    transaction.repositoryRoot !== context.git.repositoryRealPath ||
    transaction.gitCommonDirectory !== context.git.gitCommonDirectory ||
    transaction.branch !== context.session.branch ||
    canonicalJson(transaction.baseline) !==
      canonicalJson(context.session.baseline)
  ) {
    throw candidateDiverged();
  }

  const inspection = inspectSession(cwd, context.session.sessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    authorizedTransitionPaths: [...transaction.transitionPaths],
  });
  if (
    canonicalJson(inspection.changedPaths) !==
      canonicalJson(transaction.changedPaths) ||
    inspection.fingerprint !== transaction.candidateFingerprint ||
    canonicalJson(inspection.git.statusEntries) !==
      canonicalJson(transaction.candidateStatusEntries)
  ) {
    throw candidateDiverged();
  }
  assertCandidateIndex(inspection, checkedTransaction);

  const checkReport = readSessionReport(
    inspection,
    checkedTransaction.checkReportId,
  );
  assertInspectionReport(
    checkReport,
    inspection,
    'check',
    'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
  );
  assertReportChecks(
    checkReport,
    inspection,
    inspection.session.requiredChecks,
    'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
  );
  if (
    checkReport.candidateTree !== checkedTransaction.candidateTree ||
    checkReport.finalizeProfile !== 'projected-single-pass-ordinary-failure'
  ) {
    throw candidateDiverged();
  }

  const planningAssurance = inspection.session.planningAssurance ?? null;
  if (planningAssurance === null) {
    throw workflowError(
      'TASK_DIFF_REVIEW_PLANNING_ASSURANCE_REQUIRED',
      'TaskDiffReview requires the exact planning assurance binding for this task.',
      ExitCode.staleState,
    );
  }
  const executionTask =
    inspection.contract.execution?.tasks[inspection.session.taskId];
  if (executionTask === undefined) {
    throw workflowError(
      'TASK_DIFF_REVIEW_TASK_CONTRACT_REQUIRED',
      'TaskDiffReview requires an exact execution task contract.',
      ExitCode.staleState,
    );
  }
  const pathRoles = parseBaselineJson(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    'workflow/path-roles.json',
    parsePathRoleRegistry,
  );
  const pathRoleFacts = inspection.changedPaths.map((changedPath) => {
    const resolution = resolvePathRole(pathRoles, changedPath);
    return {
      path: changedPath,
      role: resolution.registered ? resolution.role : ('unregistered' as const),
    };
  });
  const maintainerPolicy = parseBaselineJson(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    'workflow/maintainer-policy.json',
    parseMaintainerPolicy,
  );
  const requiredCheckDigests = digestRequiredCheckDefinitions(
    inspection.contract.checks,
    inspection.session.requiredChecks,
  );

  return createTaskDiffReviewSubject({
    repositoryId: maintainerPolicy.repository.id,
    changeId: inspection.session.changeId,
    taskId: inspection.session.taskId,
    baseCommit: inspection.session.baseline.head,
    baseTree: inspection.session.baseline.tree,
    candidateTree: checkedTransaction.candidateTree,
    transitions: deriveTransitions(
      inspection.git.repositoryRoot,
      inspection.session.baseline.tree,
      checkedTransaction.candidateTree,
      transaction.changedPaths,
    ),
    taskContractDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-task-contract.v1',
        guardTask: inspection.policy,
        executionTask,
      }),
    ),
    requiredCheckPolicyDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-check-policy.v1',
        requiredCheckDigests,
      }),
    ),
    checkEvidenceDigest: checkedTransaction.checkReportId,
    planningGenerationId: planningAssurance.planningGenerationId,
    planTargetDigest: planningAssurance.planTargetDigest,
    planReviewNodeId: planningAssurance.reviewNodeId,
    planningAssuranceDigest: sha256(canonicalJson(planningAssurance)),
    reviewRequirement: taskDiffReviewRequirement({
      diffReview: executionTask.diffReview,
      strategy: executionTask.strategy,
      paths: pathRoleFacts,
    }),
  });
}

function assertCandidateIndex(
  inspection: ReturnType<typeof inspectSession>,
  transaction: NonNullable<ReturnType<typeof readFinalizeTransaction>> & {
    candidateTree: string;
    candidateFingerprint: string;
    checkReportId: string;
  },
): void {
  const indexTree = runGit(inspection.git.repositoryRoot, [
    'write-tree',
  ]).trim();
  if (indexTree === transaction.previousIndexTree) {
    const preview = previewExactStaging(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...transaction.changedPaths],
    );
    if (
      preview.tree !== transaction.candidateTree ||
      preview.previousIndexTree !== transaction.previousIndexTree
    ) {
      throw candidateDiverged();
    }
    return;
  }
  if (
    indexTree !== transaction.candidateTree ||
    canonicalJson(
      listStagedPaths(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
      ),
    ) !== canonicalJson(transaction.changedPaths) ||
    runGit(inspection.git.repositoryRoot, [
      'diff',
      '--name-only',
      '-z',
      '--',
    ]) !== '' ||
    fingerprintUnstagedRepositoryProjection(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...transaction.candidateStatusEntries],
    ) !== transaction.candidateFingerprint
  ) {
    throw candidateDiverged();
  }
}

function deriveTransitions(
  repositoryRoot: string,
  baseTree: string,
  candidateTree: string,
  changedPaths: readonly string[],
): readonly TaskDiffPathTransition[] {
  return changedPaths.map((changedPath) => {
    const before = readTreeEntry(repositoryRoot, baseTree, changedPath);
    const after = readTreeEntry(repositoryRoot, candidateTree, changedPath);
    if (
      (before === null && after === null) ||
      canonicalJson(before) === canonicalJson(after)
    ) {
      throw candidateDiverged();
    }
    return { path: changedPath, before, after };
  });
}

function readTreeEntry(
  repositoryRoot: string,
  tree: string,
  candidatePath: string,
): TaskDiffTreeEntry | null {
  const output = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${candidatePath}`,
  ]);
  if (output === '') return null;
  const match =
    /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) throw candidateDiverged();
  return {
    mode: match[1] as TaskDiffTreeEntry['mode'],
    objectId: match[2]!,
  };
}

function parseBaselineJson<T>(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
  parse: (value: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(
      runGit(repositoryRoot, ['show', `${commit}:${relativePath}`]),
    );
  } catch (error) {
    throw workflowError(
      'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
      `TaskDiffReview could not verify baseline ${relativePath}.`,
      ExitCode.staleState,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  try {
    return parse(value);
  } catch (error) {
    throw workflowError(
      'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
      `TaskDiffReview baseline ${relativePath} is invalid.`,
      ExitCode.staleState,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reviewNotReady() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_READY',
    'TaskDiffReview is unavailable until finalize freezes a checked candidate tree.',
    ExitCode.staleState,
  );
}

function candidateDiverged() {
  return workflowError(
    'TASK_DIFF_REVIEW_CANDIDATE_DIVERGED',
    'TaskDiffReview candidate state no longer matches the durable finalize transaction.',
    ExitCode.staleState,
  );
}
