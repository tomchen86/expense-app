import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { loadWorkflowConfig } from './contracts.ts';
import {
  buildContextManifest,
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  inspectDurableRetentionCatalog,
  rolloverDurableEpochContextStore,
  type DurableEpochContextState,
  type DurableRetentionCatalog,
  type WorkflowContextState,
} from './execution-governance.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { commitFacts } from './git-transitions.ts';
import { parseManagedTrailers } from './managed-trailers.ts';
import { assertChangeId } from './paths.ts';
import {
  readPlanningTransitionReport,
  type PlanningCarryForwardTaskEvidence,
  type PlanningTransitionReport,
} from './planning-report.ts';
import { runtimePaths } from './session-store.ts';
import { preEpochCompletedTaskIds } from './bootstrap-task-exemption.ts';
import { resolveTaskExecutionGenerationEvidence } from './task-execution-evidence.ts';

const SOURCE_CHECKPOINT = 'execution-complete';
const RESTART_CHECKPOINT = 'execution-restart-required';

export type PlanningExecutionEpochInspection = Readonly<{
  workflowId: string;
  context: DurableEpochContextState;
  retention: DurableRetentionCatalog;
}>;

export type PlanningExecutionEpochTransition = Readonly<{
  changeId: string;
  amendmentCommit: string;
  parentCommit: string;
  planningGeneration: string;
  amendsPlanningGeneration: string;
  decisionDigest: string;
  reportId: string;
  executionImpact: 'none' | 'required';
  taskEvidence: readonly PlanningCarryForwardTaskEvidence[];
  createdAt: string;
}>;

/**
 * Materialize the amendment's Layer-A transition in the existing durable epoch
 * store. The source epoch is an exact projection of the already-verified task
 * commits; the next epoch either carries those bytes unchanged or excludes all
 * of them and leaves the change at the execution restart checkpoint.
 */
export function recordPlanningExecutionEpochTransition(
  cwd: string,
  input: PlanningExecutionEpochTransition,
): PlanningExecutionEpochInspection {
  const changeId = assertChangeId(input.changeId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const storeRoot = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  ).root;
  const workflowId = planningExecutionWorkflowId(changeId);
  const sourceItems = taskEvidenceItems(input.taskEvidence);
  let current: DurableEpochContextState;
  try {
    current = inspectDurableEpochContextStore(storeRoot, workflowId);
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.code !== 'EXECUTION_CONTEXT_NOT_FOUND'
    ) {
      throw error;
    }
    const sourceManifest = planningManifest({
      workflowId,
      epoch: 1,
      contractVersion: 1,
      commit: input.parentCommit,
      intent: input.amendsPlanningGeneration,
      planningGeneration: input.amendsPlanningGeneration,
      items: sourceItems,
    });
    const workflow: WorkflowContextState = {
      workflowId,
      currentEpoch: 1,
      contractVersion: 1,
      contextDigest: sourceManifest.contextDigest,
      snapshotDigest: sourceManifest.baselineDigest,
      status: 'active',
      checkpoint: SOURCE_CHECKPOINT,
      blocker: null,
    };
    current = initializeDurableEpochContextStore(storeRoot, {
      workflow,
      manifest: sourceManifest,
      items: sourceItems,
      now: exactDate(input.createdAt),
    });
  }

  const nextItems = input.executionImpact === 'none' ? sourceItems : [];
  if (
    current.currentManifest.baselineDigest === digest(input.amendmentCommit) &&
    current.currentManifest.intentDigest === digest(input.decisionDigest) &&
    current.currentManifest.planningSnapshotDigest ===
      digest(input.planningGeneration) &&
    canonicalJson(current.currentManifest.items) ===
      canonicalJson(
        planningManifest({
          workflowId,
          epoch: current.workflow.currentEpoch,
          contractVersion: current.workflow.contractVersion,
          commit: input.amendmentCommit,
          intent: input.decisionDigest,
          planningGeneration: input.planningGeneration,
          items: nextItems,
        }).items,
      ) &&
    current.workflow.checkpoint ===
      (input.executionImpact === 'none'
        ? SOURCE_CHECKPOINT
        : RESTART_CHECKPOINT)
  ) {
    return inspectPlanningExecutionEpoch(cwd, changeId);
  }

  if (
    current.workflow.checkpoint === RESTART_CHECKPOINT &&
    current.currentManifest.planningSnapshotDigest ===
      digest(input.amendsPlanningGeneration) &&
    current.currentManifest.items.length === 0
  ) {
    const completedManifest = planningManifestWithIntentDigest({
      workflowId,
      epoch: current.workflow.currentEpoch + 1,
      contractVersion: current.workflow.contractVersion,
      commit: input.parentCommit,
      intentDigest: current.currentManifest.intentDigest,
      planningGeneration: input.amendsPlanningGeneration,
      items: sourceItems,
    });
    current = rolloverDurableEpochContextStore(storeRoot, {
      workflowId,
      expectedGeneration: current.generation,
      expectedEpoch: current.workflow.currentEpoch,
      expectedContextDigest: current.workflow.contextDigest,
      nextManifest: completedManifest,
      items: sourceItems,
      reason:
        'Every task reopened by the reviewed amendment completed with exact managed commit evidence.',
      restartFrom: SOURCE_CHECKPOINT,
      carriedForward: [],
      carryForwardManifest: {
        sourceWorkflow: workflowId,
        sourceEpoch: current.workflow.currentEpoch,
        carriedForward: [],
        excluded: [],
      },
      invalidated: [],
      verification: {
        check: 'managed-task-generation-complete',
        result: 'passed',
      },
      createdAt: exactDate(input.createdAt),
    });
  }

  const sourceManifest = planningManifestWithIntentDigest({
    workflowId,
    epoch: current.workflow.currentEpoch,
    contractVersion: current.workflow.contractVersion,
    commit: input.parentCommit,
    intentDigest: current.currentManifest.intentDigest,
    planningGeneration: input.amendsPlanningGeneration,
    items: sourceItems,
  });
  if (
    current.currentManifest.contextDigest !== sourceManifest.contextDigest ||
    current.workflow.checkpoint !== SOURCE_CHECKPOINT
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_STALE',
      'The current execution epoch does not match the exact completed generation being amended.',
      ExitCode.staleState,
    );
  }

  const nextManifest = planningManifest({
    workflowId,
    epoch: current.workflow.currentEpoch + 1,
    contractVersion: current.workflow.contractVersion + 1,
    commit: input.amendmentCommit,
    intent: input.decisionDigest,
    planningGeneration: input.planningGeneration,
    items: nextItems,
  });

  const carriedForward =
    input.executionImpact === 'none'
      ? sourceItems.map(({ identity }) => identity)
      : [];
  const carriedSet = new Set(carriedForward);
  current = rolloverDurableEpochContextStore(storeRoot, {
    workflowId,
    expectedGeneration: current.generation,
    expectedEpoch: current.workflow.currentEpoch,
    expectedContextDigest: current.workflow.contextDigest,
    nextManifest,
    items: nextItems,
    reason:
      input.executionImpact === 'none'
        ? 'Reviewed planning amendment preserved the exact completed execution evidence.'
        : 'Reviewed planning amendment invalidated the completed execution evidence.',
    restartFrom:
      input.executionImpact === 'none' ? SOURCE_CHECKPOINT : RESTART_CHECKPOINT,
    carriedForward,
    carryForwardManifest: {
      sourceWorkflow: workflowId,
      sourceEpoch: current.workflow.currentEpoch,
      carriedForward: carriedForward.map((identity) => ({
        identity,
        reason:
          'Exact managed task evidence remains valid under the reviewed no-impact amendment.',
      })),
      excluded: sourceItems
        .filter(({ identity }) => !carriedSet.has(identity))
        .map(({ identity }) => ({
          identity,
          reason:
            'The reviewed amendment requires this task to execute again in the new planning generation.',
        })),
    },
    invalidated:
      input.executionImpact === 'required'
        ? sourceItems.map(({ identity }) => identity)
        : [],
    verification: {
      check: 'reviewed-planning-amendment',
      result: 'passed',
      reportDigest: digest(input.reportId),
    },
    createdAt: exactDate(input.createdAt),
  });

  if (
    current.currentManifest.contextDigest !== nextManifest.contextDigest ||
    current.workflow.checkpoint !==
      (input.executionImpact === 'none'
        ? SOURCE_CHECKPOINT
        : RESTART_CHECKPOINT)
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_CORRUPT',
      'The durable execution epoch did not reach the amendment checkpoint.',
      ExitCode.staleState,
    );
  }
  return inspectPlanningExecutionEpoch(cwd, changeId);
}

export function inspectPlanningExecutionEpoch(
  cwd: string,
  requestedChangeId: string,
): PlanningExecutionEpochInspection {
  const changeId = assertChangeId(requestedChangeId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const storeRoot = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  ).root;
  const workflowId = planningExecutionWorkflowId(changeId);
  return Object.freeze({
    workflowId,
    context: inspectDurableEpochContextStore(storeRoot, workflowId),
    retention: inspectDurableRetentionCatalog(storeRoot, workflowId),
  });
}

/**
 * Archive-side recovery and admission. A required-impact amendment deliberately
 * leaves an empty active epoch. Once every reopened task has one canonical
 * commit in that generation, archive projects those exact bytes into the next
 * epoch before it evaluates eligibility. Repositories with no amendment epoch
 * remain historical and are not silently enrolled.
 */
export function ensurePlanningExecutionEpochCompleteForArchive(
  cwd: string,
  input: {
    changeId: string;
    head: string;
    planningGeneration: string | null;
    taskEvidence: readonly PlanningCarryForwardTaskEvidence[];
    now: Date;
  },
): PlanningExecutionEpochInspection | null {
  const changeId = assertChangeId(input.changeId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const storeRoot = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  ).root;
  const workflowId = planningExecutionWorkflowId(changeId);
  let current: DurableEpochContextState;
  try {
    current = inspectDurableEpochContextStore(storeRoot, workflowId);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_CONTEXT_NOT_FOUND'
    ) {
      const recovered = recoverLatestPlanningExecutionEpoch(
        repository.repositoryRoot,
        storeRoot,
        config.changeRoot,
        changeId,
        input.head,
      );
      if (recovered === null) return null;
      current = recovered.context;
    } else {
      throw error;
    }
  }
  if (
    input.planningGeneration !== null &&
    current.currentManifest.planningSnapshotDigest !==
      digest(input.planningGeneration)
  ) {
    const recovered = recoverLatestPlanningExecutionEpoch(
      repository.repositoryRoot,
      storeRoot,
      config.changeRoot,
      changeId,
      input.head,
    );
    if (recovered !== null) current = recovered.context;
  }
  if (input.planningGeneration === null) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_STALE',
      'A durable planning execution epoch has no current planning generation.',
      ExitCode.staleState,
    );
  }
  const items = taskEvidenceItems(input.taskEvidence);
  const expectedReferences = planningManifest({
    workflowId,
    epoch: current.workflow.currentEpoch,
    contractVersion: current.workflow.contractVersion,
    commit: input.head,
    intent: input.planningGeneration,
    planningGeneration: input.planningGeneration,
    items,
  }).items;
  const generationMatches =
    current.currentManifest.planningSnapshotDigest ===
    digest(input.planningGeneration);
  if (
    generationMatches &&
    current.workflow.checkpoint === SOURCE_CHECKPOINT &&
    current.currentManifest.baselineDigest === digest(input.head) &&
    canonicalJson(current.currentManifest.items) ===
      canonicalJson(expectedReferences)
  ) {
    return inspectPlanningExecutionEpoch(cwd, changeId);
  }
  if (
    !generationMatches ||
    current.workflow.checkpoint !== RESTART_CHECKPOINT ||
    current.currentManifest.items.length !== 0
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_STALE',
      'Archive execution evidence does not match the active planning epoch.',
      ExitCode.staleState,
    );
  }
  const completedManifest = buildContextManifest({
    workflowId,
    epoch: current.workflow.currentEpoch + 1,
    contractVersion: current.workflow.contractVersion,
    baselineDigest: digest(input.head),
    intentDigest: current.currentManifest.intentDigest,
    termSetDigest: digest(canonicalJson(items.map(({ identity }) => identity))),
    planningSnapshotDigest: current.currentManifest.planningSnapshotDigest,
    items,
  });
  current = rolloverDurableEpochContextStore(storeRoot, {
    workflowId,
    expectedGeneration: current.generation,
    expectedEpoch: current.workflow.currentEpoch,
    expectedContextDigest: current.workflow.contextDigest,
    nextManifest: completedManifest,
    items,
    reason:
      'All tasks reopened by the current planning generation completed before archive.',
    restartFrom: SOURCE_CHECKPOINT,
    carriedForward: [],
    carryForwardManifest: {
      sourceWorkflow: workflowId,
      sourceEpoch: current.workflow.currentEpoch,
      carriedForward: [],
      excluded: [],
    },
    invalidated: [],
    verification: {
      check: 'archive-task-generation-complete',
      result: 'passed',
    },
    createdAt: input.now,
  });
  if (
    current.workflow.checkpoint !== SOURCE_CHECKPOINT ||
    current.currentManifest.contextDigest !== completedManifest.contextDigest
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_CORRUPT',
      'Archive execution completion did not reach its exact durable epoch.',
      ExitCode.staleState,
    );
  }
  return inspectPlanningExecutionEpoch(cwd, changeId);
}

function recoverLatestPlanningExecutionEpoch(
  repositoryRoot: string,
  storeRoot: string,
  changeRoot: string,
  changeId: string,
  tip: string,
): PlanningExecutionEpochInspection | null {
  const amendment = latestAmendmentCommit(repositoryRoot, changeId, tip);
  if (amendment === null) return null;
  const reportsDirectory = path.join(storeRoot, 'planning-reports');
  const matches = fs
    .readdirSync(reportsDirectory)
    .filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))
    .flatMap((entry) => {
      const reportId = entry.slice(0, -'.json'.length);
      const report = readPlanningTransitionReport(reportsDirectory, reportId);
      return report.commitHash === amendment.commitHash
        ? [{ reportId, report }]
        : [];
    });
  if (matches.length !== 1) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
      'Epoch recovery requires exactly one immutable report for the committed amendment.',
      ExitCode.staleState,
    );
  }
  const [{ reportId, report }] = matches;
  if (
    report.transition !== 'amend-plan' ||
    report.parent.head !== amendment.parentCommit ||
    report.amendment === null ||
    report.amendment.status !== 'recorded' ||
    report.amendment.planningGeneration !== amendment.planningGeneration ||
    report.amendment.amendsPlanningGeneration !==
      amendment.amendsPlanningGeneration ||
    report.amendment.executionImpact !== amendment.executionImpact
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
      'The immutable amendment report does not match its committed transition.',
      ExitCode.staleState,
    );
  }
  const taskEvidence = sourceTaskEvidenceForReport(
    repositoryRoot,
    changeRoot,
    changeId,
    amendment.parentCommit,
    report,
  );
  return recordPlanningExecutionEpochTransition(repositoryRoot, {
    changeId,
    amendmentCommit: amendment.commitHash,
    parentCommit: amendment.parentCommit,
    planningGeneration: amendment.planningGeneration,
    amendsPlanningGeneration: amendment.amendsPlanningGeneration,
    decisionDigest: report.amendment.decisionDigest,
    reportId,
    executionImpact: amendment.executionImpact,
    taskEvidence,
    createdAt: report.createdAt,
  });
}

function latestAmendmentCommit(
  repositoryRoot: string,
  changeId: string,
  tip: string,
): {
  commitHash: string;
  parentCommit: string;
  planningGeneration: string;
  amendsPlanningGeneration: string;
  executionImpact: 'none' | 'required';
} | null {
  const commits = runGit(repositoryRoot, ['rev-list', '--first-parent', tip])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const commitHash of commits) {
    const facts = commitFacts(repositoryRoot, commitHash);
    const trailers = parseManagedTrailers(
      facts.message.endsWith('\n') ? facts.message.slice(0, -1) : facts.message,
    );
    if (trailers?.kind !== 'amend-plan' || trailers.changeId !== changeId) {
      continue;
    }
    if (facts.parents.length !== 1) {
      throw workflowError(
        'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
        'A recoverable amendment must have exactly one parent.',
        ExitCode.staleState,
      );
    }
    return {
      commitHash,
      parentCommit: facts.parents[0]!,
      planningGeneration: trailers.planningGeneration,
      amendsPlanningGeneration: trailers.amendsPlanningGeneration,
      executionImpact: trailers.executionImpact,
    };
  }
  return null;
}

function sourceTaskEvidenceForReport(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  parentCommit: string,
  report: PlanningTransitionReport,
): PlanningCarryForwardTaskEvidence[] {
  if (
    report.amendment !== null &&
    report.amendment.status === 'recorded' &&
    report.amendment.executionDisposition.kind === 'carried-forward'
  ) {
    return [...report.amendment.executionDisposition.tasks];
  }
  const taskIds =
    report.amendment !== null &&
    report.amendment.status === 'recorded' &&
    report.amendment.executionDisposition.kind === 'reopened'
      ? report.amendment.executionDisposition.taskIds
      : [];
  const generation = resolveTaskExecutionGenerationEvidence(
    repositoryRoot,
    changeRoot,
    changeId,
    taskIds,
    parentCommit,
  );
  const preEpoch = preEpochCompletedTaskIds(
    repositoryRoot,
    changeRoot,
    changeId,
    parentCommit,
  );
  return taskIds.map((taskId) => {
    const commits = generation.commitsByTask[taskId] ?? [];
    if (commits.length === 1) {
      return {
        taskId,
        source: 'managed-task-commit' as const,
        commitHash: commits[0]!.hash,
      };
    }
    if (commits.length === 0 && preEpoch.has(taskId)) {
      return {
        taskId,
        source: 'pre-epoch-exemption' as const,
        commitHash: null,
      };
    }
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
      'The committed amendment source task generation is missing or ambiguous.',
      ExitCode.staleState,
    );
  });
}

function planningExecutionWorkflowId(changeId: string): string {
  return `planning-execution:${changeId}`;
}

function planningManifest(input: {
  workflowId: string;
  epoch: number;
  contractVersion: number;
  commit: string;
  intent: string;
  planningGeneration: string;
  items: { identity: string; content: string }[];
}) {
  return buildContextManifest({
    workflowId: input.workflowId,
    epoch: input.epoch,
    contractVersion: input.contractVersion,
    baselineDigest: digest(input.commit),
    intentDigest: digest(input.intent),
    termSetDigest: digest(
      canonicalJson(input.items.map(({ identity }) => identity)),
    ),
    planningSnapshotDigest: digest(input.planningGeneration),
    items: input.items,
  });
}

function planningManifestWithIntentDigest(input: {
  workflowId: string;
  epoch: number;
  contractVersion: number;
  commit: string;
  intentDigest: string;
  planningGeneration: string;
  items: { identity: string; content: string }[];
}) {
  return buildContextManifest({
    workflowId: input.workflowId,
    epoch: input.epoch,
    contractVersion: input.contractVersion,
    baselineDigest: digest(input.commit),
    intentDigest: input.intentDigest,
    termSetDigest: digest(
      canonicalJson(input.items.map(({ identity }) => identity)),
    ),
    planningSnapshotDigest: digest(input.planningGeneration),
    items: input.items,
  });
}

function taskEvidenceItems(
  evidence: readonly PlanningCarryForwardTaskEvidence[],
): { identity: string; content: string }[] {
  const sorted = [...evidence].sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
  if (
    sorted.length === 0 ||
    new Set(sorted.map(({ taskId }) => taskId)).size !== sorted.length
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_INVALID',
      'Execution epoch transition requires one exact evidence record per completed task.',
      ExitCode.verification,
    );
  }
  return sorted.map((entry) => ({
    identity: `task:${entry.taskId}`,
    content: canonicalJson({
      schemaVersion: 1,
      kind: 'planning-task-execution-evidence',
      ...entry,
    }),
  }));
}

function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_INVALID',
      'Planning execution epoch timestamp is invalid.',
      ExitCode.verification,
    );
  }
  return date;
}
