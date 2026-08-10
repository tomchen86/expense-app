import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertSpecDeltaScenarioPreservation } from './archive-delta-verifier.ts';
import { preEpochCompletedTaskIds } from './bootstrap-task-exemption.ts';
import type { ArchiveApplicabilityRecord } from './planning-report.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  amendPlanCommitMessage,
  amendPlanCommitTrailers,
  createAmendPlanCommitObject,
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
  amendmentLeftWorkMarkedDone,
  inspectPlanningTransition,
  taskStates,
  validateOpenSpecPlanning,
} from './planning-contract.ts';
import {
  readPlanningTransitionReport,
  writePlanningTransitionReport,
  type PlanningCarryForwardTaskEvidence,
  type PlanningTransitionReport,
} from './planning-report.ts';
import { runtimePaths } from './session-store.ts';
import {
  assertHeldChangeTransitionAuthority,
  type HeldChangeTransitionAuthority,
  withPlanningAuthority,
} from './planning-lock.ts';
import type { InvestigationFirstPlanningAssuranceSummary } from './planning-assurance-validator.ts';
import {
  planningAmendmentDecisionDigest,
  readPlanningAmendmentDecision,
  type PlanningAmendmentDecision,
} from './planning-amendment-decision.ts';
import { committedPlanningGeneration } from './planning-generation-history.ts';
import { recordPlanningExecutionEpochTransition } from './planning-execution-epoch.ts';
import { resolveTaskExecutionGenerationEvidence } from './task-execution-evidence.ts';

export type AmendmentRequest = {
  reason: string;
  executionImpact: 'none' | 'required';
};

export type PlanningTransitionResult = {
  changeId: string;
  kind: 'introduction' | 'revision';
  /** Present when this transition was an amendment rather than a plan. */
  amendment?: {
    reason: string;
    executionImpact: 'none' | 'required';
    rationale: string;
    decisionDigest: string;
    reopenedTasks: string[];
    planningGeneration: string;
    amendsPlanningGeneration: string;
    planReview: string;
  };
  subject: string;
  baselineHead: string;
  changedPaths: string[];
  stagedPaths: string[];
  tree: string;
  commitHash: string;
  reportId: string;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
  archiveApplicability: ArchiveApplicabilityRecord;
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
  afterRefUpdateBeforeEpoch?(context: {
    repositoryRoot: string;
    commitHash: string;
    reportId: string;
  }): void;
};

export {
  assertPlanningPaths,
  assertPlanningTaskHistory,
} from './planning-contract.ts';

/**
 * Amends an already-committed plan.
 *
 * A change that finished its execution and then failed at archive has a
 * corrected plan to commit and no legal way to commit it: an ordinary plan
 * revision may not disturb completed work, and there is no other verb. This is
 * that verb, and it is deliberately narrow — it records which generation it
 * replaces, which review looked at the correction, and whether the work already
 * done still stands. An amendment that has not decided the last of those is
 * refused rather than assumed, because assuming it is how completed work
 * silently becomes uncertain.
 */
export function commitPlanAmendment(
  cwd: string,
  requestedChangeId: string,
  amendment: AmendmentRequest,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: PlanningTransitionTestHooks = {},
): PlanningTransitionResult {
  const changeId = assertChangeId(requestedChangeId);
  assertAmendmentRequest(amendment);
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
      amendment,
    ),
  );
}

function assertAmendmentRequest(amendment: AmendmentRequest): void {
  if (
    amendment.executionImpact !== 'none' &&
    amendment.executionImpact !== 'required'
  ) {
    throw workflowError(
      'AMENDMENT_EXECUTION_IMPACT_UNRESOLVED',
      'An amendment must say whether the work already done still stands.',
      ExitCode.usage,
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(amendment.reason)) {
    throw workflowError(
      'AMENDMENT_REASON_REQUIRED',
      'An amendment records why it was needed, as a stable reason code.',
      ExitCode.usage,
    );
  }
}

/**
 * Read the decision from the exact proposal bytes that the fresh PlanReview
 * covers. CLI flags remain an explicit confirmation surface, but they cannot
 * author or replace the reviewed reason, impact, rationale, or parent
 * generation.
 */
function readReviewedAmendmentDecision(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  request: AmendmentRequest,
  priorGeneration: string | null,
): PlanningAmendmentDecision {
  if (priorGeneration === null) {
    throw workflowError(
      'AMENDMENT_WITHOUT_PLAN',
      'An amendment replaces a planning generation; this change has none to replace.',
      ExitCode.guard,
    );
  }
  const repositoryRealPath = fs.realpathSync(repositoryRoot);
  const proposalPath = path.resolve(
    repositoryRoot,
    changeRoot,
    changeId,
    'proposal.md',
  );
  const expectedProposalRealPath = path.join(
    repositoryRealPath,
    changeRoot,
    changeId,
    'proposal.md',
  );
  let proposal: string;
  try {
    const stat = fs.lstatSync(proposalPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(proposalPath) !== expectedProposalRealPath
    ) {
      throw new Error('proposal is not one confined regular file');
    }
    proposal = fs.readFileSync(proposalPath, 'utf8');
  } catch {
    throw workflowError(
      'AMENDMENT_DECISION_INVALID',
      'The reviewed amendment decision must live in the confined proposal artifact.',
      ExitCode.guard,
    );
  }
  const decision = readPlanningAmendmentDecision(proposal);
  if (decision === null) {
    throw workflowError(
      'AMENDMENT_DECISION_REQUIRED',
      'An amendment requires a reason, impact, and rationale already covered by the fresh PlanReview.',
      ExitCode.guard,
    );
  }
  if (
    decision.reason !== request.reason ||
    decision.executionImpact !== request.executionImpact
  ) {
    throw workflowError(
      'AMENDMENT_DECISION_MISMATCH',
      'CLI amendment arguments must exactly confirm the reviewed decision.',
      ExitCode.guard,
    );
  }
  if (decision.amendsPlanningGeneration !== priorGeneration) {
    throw workflowError(
      'AMENDMENT_DECISION_STALE',
      'The reviewed amendment decision does not replace the exact generation committed by the parent.',
      ExitCode.staleState,
    );
  }
  return decision;
}

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

export function commitPlanningTransitionUnderAuthority(
  cwd: string,
  requestedChangeId: string,
  authority: HeldChangeTransitionAuthority,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: PlanningTransitionTestHooks = {},
): PlanningTransitionResult {
  const changeId = assertChangeId(requestedChangeId);
  const assertLocksOwned = assertHeldChangeTransitionAuthority(
    authority,
    changeId,
  );
  return commitPlanningTransitionLocked(
    cwd,
    changeId,
    environment,
    testHooks,
    assertLocksOwned,
  );
}

/**
 * The planning generation this change last committed under, read from what was
 * actually committed rather than from runtime state that may have been pruned.
 *
 * An amendment exists to replace a specific generation, so a change with none
 * has nothing to amend and is told so rather than being handed a first plan
 * through the amendment door. A committed review naming more than one
 * generation refuses the amendment: one that cannot say precisely what it
 * replaces records nothing worth reading later.
 */
function commitPlanningTransitionLocked(
  cwd: string,
  changeId: string,
  environment: NodeJS.ProcessEnv,
  testHooks: PlanningTransitionTestHooks,
  assertLocksOwned: () => void,
  amendment?: AmendmentRequest,
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
  const initialFingerprint = fingerprintRepositoryWorktree(
    initial.repositoryRoot,
    initial.head,
  );
  const priorGeneration =
    amendment === undefined
      ? null
      : committedPlanningGeneration(
          initial.repositoryRoot,
          initial.head,
          config.changeRoot,
          changeId,
        );
  const amendmentDecision =
    amendment === undefined
      ? null
      : readReviewedAmendmentDecision(
          initial.repositoryRoot,
          config.changeRoot,
          changeId,
          amendment,
          priorGeneration,
        );
  const reopenAuthorized = amendmentDecision?.executionImpact === 'required';
  const inspection = inspectPlanningTransition(
    initial.repositoryRoot,
    initial.head,
    config.changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
    reopenAuthorized,
  );
  const planningValidation = validateOpenSpecPlanning(
    initial.repositoryRoot,
    changeId,
    inspection.schemaName,
  );
  if (
    planningValidation.planningAssurance !== null &&
    (planningValidation.planningAssurance.investigationBaseline.head !==
      initial.head ||
      planningValidation.planningAssurance.investigationBaseline.tree !==
        initial.tree)
  ) {
    throw workflowError(
      'OPENSPEC_CHANGE_NOT_READY',
      'Investigation-first planning must be based on the exact plan-commit parent.',
      ExitCode.verification,
    );
  }

  let amendmentExecutionEvidence: PlanningCarryForwardTaskEvidence[] | null =
    null;
  if (amendment !== undefined) {
    if (priorGeneration === null) {
      throw workflowError(
        'AMENDMENT_WITHOUT_PLAN',
        'An amendment replaces a planning generation; this change has none to replace.',
        ExitCode.guard,
      );
    }
    amendmentExecutionEvidence = assertAmendmentStateEligible(
      initial.repositoryRoot,
      config.changeRoot,
      changeId,
      initial.head,
      inspection.beforeTasks,
    );
    assertNoImpactAmendmentPaths(
      amendmentDecision as PlanningAmendmentDecision,
      config.changeRoot,
      changeId,
      changedPaths,
    );
    if (planningValidation.planningAssurance === null) {
      throw workflowError(
        'AMENDMENT_REVIEW_REQUIRED',
        'An amendment is committed on a fresh review of the corrected plan.',
        ExitCode.verification,
      );
    }
    if (
      planningValidation.planningAssurance.planningGenerationId ===
      priorGeneration
    ) {
      throw workflowError(
        'AMENDMENT_GENERATION_UNCHANGED',
        'An amendment whose planning generation is the one it replaces has corrected nothing.',
        ExitCode.verification,
      );
    }
  }

  if (
    amendmentLeftWorkMarkedDone({
      reopenAuthorized,
      reopenedTasks: inspection.reopenedTasks,
      beforeTasks: inspection.beforeTasks,
    })
  ) {
    // Declaring the work invalid and then leaving it marked done is the one
    // combination that would leave the record saying two different things.
    // State admission above already proved the prior generation completed, so
    // required impact must reopen every one of those completed tasks.
    throw workflowError(
      'AMENDMENT_EXECUTION_NOT_REOPENED',
      'An amendment that says the work must be redone has to reopen it; completed tasks are still marked done.',
      ExitCode.verification,
    );
  }
  // A seam, deliberately not taken: when execution-side evidence lives in the
  // durable catalog, an epoch rollover hooks onto this same amendment record.
  // Nothing there today holds task completion — that lives in the committed
  // tree and in the task commits, which this transition leaves untouched — so
  // wiring one now would record a transition that never happened.

  // Archive applies delta specs onto the base specs; a delta that cannot apply
  // is not discoverable until then, which is a whole execution too late.
  const currentDeltaSpecPaths = inspection.currentPaths.filter(
    (candidate) =>
      candidate.startsWith(`${config.changeRoot}/${changeId}/specs/`) &&
      candidate.endsWith('/spec.md'),
  );
  const archiveApplicability = assertSpecDeltaScenarioPreservation(
    initial.repositoryRoot,
    initial.head,
    config.changeRoot,
    changeId,
    currentDeltaSpecPaths,
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
    reopenAuthorized,
  );
  if (
    verified.transitionKind !== inspection.transitionKind ||
    verified.schemaName !== inspection.schemaName ||
    JSON.stringify(verified.reopenedTasks) !==
      JSON.stringify(inspection.reopenedTasks) ||
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

    const provenance =
      amendment === undefined || planningValidation.planningAssurance === null
        ? null
        : {
            planningGeneration:
              planningValidation.planningAssurance.planningGenerationId,
            amendsPlanningGeneration: priorGeneration as string,
            executionImpact: (amendmentDecision as PlanningAmendmentDecision)
              .executionImpact,
            planReview: planningValidation.planningAssurance.reviewNodeId,
          };
    const subject =
      provenance === null ? `Plan ${changeId}` : `Amend plan ${changeId}`;
    const message =
      provenance === null
        ? planningCommitMessage(changeId)
        : amendPlanCommitMessage(changeId, provenance);
    const commitHash =
      provenance === null
        ? createPlanningCommitObject(
            initial.repositoryRoot,
            staged.tree,
            initial.head,
            changeId,
            environment,
          )
        : createAmendPlanCommitObject(
            initial.repositoryRoot,
            staged.tree,
            initial.head,
            changeId,
            provenance,
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
      reportVersion: 2,
      kind: 'planning-transition',
      createdAt: new Date().toISOString(),
      changeId,
      transition: provenance === null ? 'plan' : 'amend-plan',
      transitionKind: inspection.transitionKind,
      subject,
      message,
      trailers:
        provenance === null
          ? [`Change: ${changeId}`, 'Transition: plan']
          : amendPlanCommitTrailers(changeId, provenance).split('\n'),
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
        // Named rather than counted: whoever reads this later needs to know
        // exactly which work was sent back, not how much of it there was.
        reopened: inspection.reopenedTasks,
      },
      openspec: planningValidation.openspec,
      planningAssurance: planningValidation.planningAssurance,
      amendment:
        provenance === null ||
        amendmentDecision === null ||
        amendmentExecutionEvidence === null
          ? null
          : {
              status: 'recorded',
              reason: amendmentDecision.reason,
              executionImpact: amendmentDecision.executionImpact,
              rationale: amendmentDecision.rationale,
              decisionDigest:
                planningAmendmentDecisionDigest(amendmentDecision),
              planningGeneration: provenance.planningGeneration,
              amendsPlanningGeneration: provenance.amendsPlanningGeneration,
              planReview: provenance.planReview,
              executionDisposition:
                amendmentDecision.executionImpact === 'none'
                  ? {
                      kind: 'carried-forward',
                      tasks: amendmentExecutionEvidence,
                    }
                  : {
                      kind: 'reopened',
                      taskIds: inspection.reopenedTasks,
                    },
            },
      archiveApplicability,
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

    testHooks.afterRefUpdateBeforeEpoch?.({
      repositoryRoot: initial.repositoryRoot,
      commitHash,
      reportId,
    });

    if (
      provenance !== null &&
      amendmentDecision !== null &&
      amendmentExecutionEvidence !== null
    ) {
      recordPlanningExecutionEpochTransition(initial.repositoryRoot, {
        changeId,
        amendmentCommit: commitHash,
        parentCommit: initial.head,
        planningGeneration: provenance.planningGeneration,
        amendsPlanningGeneration: provenance.amendsPlanningGeneration,
        decisionDigest: planningAmendmentDecisionDigest(amendmentDecision),
        reportId,
        executionImpact: provenance.executionImpact,
        taskEvidence: amendmentExecutionEvidence,
        createdAt: report.createdAt,
      });
    }

    return {
      changeId,
      kind: inspection.transitionKind,
      ...(provenance === null || amendmentDecision === null
        ? {}
        : {
            amendment: {
              reason: amendmentDecision.reason,
              executionImpact: provenance.executionImpact,
              rationale: amendmentDecision.rationale,
              decisionDigest:
                planningAmendmentDecisionDigest(amendmentDecision),
              reopenedTasks: inspection.reopenedTasks,
              planningGeneration: provenance.planningGeneration,
              amendsPlanningGeneration: provenance.amendsPlanningGeneration,
              planReview: provenance.planReview,
            },
          }),
      subject,
      baselineHead: initial.head,
      changedPaths,
      stagedPaths: staged.stagedPaths,
      tree: staged.tree,
      commitHash,
      reportId,
      planningAssurance: planningValidation.planningAssurance,
      archiveApplicability,
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

function assertNoImpactAmendmentPaths(
  amendment: AmendmentRequest,
  changeRoot: string,
  changeId: string,
  changedPaths: readonly string[],
): void {
  if (amendment.executionImpact !== 'none') return;
  const prefix = `${changeRoot}/${changeId}/`;
  const executionContractPaths = new Set([
    `${prefix}.openspec.yaml`,
    `${prefix}execution.json`,
    `${prefix}guard.json`,
    `${prefix}tasks.md`,
  ]);
  const requiringExecution = changedPaths.filter((candidate) =>
    executionContractPaths.has(candidate),
  );
  if (requiringExecution.length > 0) {
    throw workflowError(
      'AMENDMENT_EXECUTION_IMPACT_REQUIRED',
      'A no-impact amendment may correct reviewed planning prose and delta specifications, but it may not change the task or execution contract.',
      ExitCode.guard,
      { details: { paths: requiringExecution } },
    );
  }
}

function assertAmendmentStateEligible(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  tip: string,
  beforeTasks: readonly { id: string; completed: boolean }[] | undefined,
): PlanningCarryForwardTaskEvidence[] {
  const tasks = beforeTasks ?? [];
  const preEpochCompleted = preEpochCompletedTaskIds(
    repositoryRoot,
    changeRoot,
    changeId,
    tip,
  );
  const incompleteTaskIds = tasks
    .filter(({ completed }) => !completed)
    .map(({ id }) => id);
  const generationEvidence = resolveTaskExecutionGenerationEvidence(
    repositoryRoot,
    changeRoot,
    changeId,
    tasks.map(({ id }) => id),
    tip,
  );
  const taskEvidence = tasks.map(({ id }) => ({
    taskId: id,
    boundary: generationEvidence.boundary,
    commits: generationEvidence.commitsByTask[id] ?? [],
  }));
  const invalidTaskEvidence = taskEvidence.filter(
    ({ taskId, boundary, commits }) =>
      commits.length !== 1 &&
      !(boundary === null && preEpochCompleted.has(taskId)),
  );
  if (
    tasks.length === 0 ||
    incompleteTaskIds.length > 0 ||
    invalidTaskEvidence.length > 0
  ) {
    throw workflowError(
      'AMENDMENT_STATE_INELIGIBLE',
      'A plan amendment is available only after the committed execution generation is complete and every completed task has one exact task commit.',
      ExitCode.guard,
      {
        details: {
          incompleteTaskIds,
          invalidTaskEvidence: invalidTaskEvidence.map(
            ({ taskId, boundary, commits }) => ({
              taskId,
              boundary: boundary?.commitHash ?? null,
              commitHashes: commits.map(({ hash }) => hash),
            }),
          ),
        },
      },
    );
  }
  return taskEvidence
    .map(({ taskId, commits }): PlanningCarryForwardTaskEvidence =>
      commits.length === 1
        ? {
            taskId,
            source: 'managed-task-commit',
            commitHash: commits[0]!.hash,
          }
        : {
            taskId,
            source: 'pre-epoch-exemption',
            commitHash: null,
          },
    )
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
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
