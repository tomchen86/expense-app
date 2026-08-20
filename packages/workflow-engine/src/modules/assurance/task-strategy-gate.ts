import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { previewExactStaging } from '../../runtime/repository-transaction/git-transitions.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import { matchesAllowedPath } from '../../runtime/session-workspace/paths.ts';
import { resolveCurrentTaskStrategyCorrection } from '../../application/execute-task/task-strategy-correction.ts';
import { readTaskStrategyGreenFailureRecord } from '../../runtime/storage-journal/task-strategy-correction-store.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchReservation,
} from '../../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  readTaskStrategyTransaction,
  type TaskStrategyFrozenFile,
} from '../../runtime/storage-journal/task-strategy-store.ts';
import {
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationSubject,
} from '../provider-orchestration/task-strategy-provider-contract.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationResultBinding,
} from '../../runtime/storage-journal/task-strategy-provider-store.ts';
import { assertTaskMechanicalTransformationEvidence } from '../../application/execute-task/task-mechanical-transform.ts';
import type { SessionInspection } from '../../application/finalize/verification.ts';

/**
 * Shared check/finalize predicate for strategy-specific execution evidence.
 * It does not interpret review findings or close challenges; TaskDiff Final
 * Assurance remains the only challenge-closure authority.
 */
export function assertTaskStrategyExecutionGate(
  inspection: SessionInspection,
  _environment: NodeJS.ProcessEnv,
): void {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (task?.strategy === 'mechanical-transform') {
    assertTaskMechanicalTransformationEvidence(inspection);
    return;
  }
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
  const initialImplementationSubject = createTaskStrategyImplementationSubject({
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    taskContractDigest: transaction.taskContractDigest,
    sourceTree: transaction.red.candidateTree,
    failureFingerprint: transaction.red.failureFingerprint,
    redEvidenceNodeId: transaction.red.evidenceNodeId,
    redEvidenceResultDigest: transaction.red.evidenceResultDigest,
    testPaths: transaction.red.testPaths,
    fixturePaths: transaction.red.fixturePaths,
    frozenFiles: transaction.red.files,
  });
  const correction = resolveCurrentTaskStrategyCorrection(inspection);
  if (correction.transaction.recordDigest !== transaction.recordDigest) {
    throw redStale();
  }
  if (correction.failure !== null) {
    throw workflowError(
      'TASK_STRATEGY_CORRECTION_REQUIRED',
      'GREEN checks cannot run while the latest imported candidate has an unresolved engine-observed failure.',
      ExitCode.verification,
      {
        recovery: `pnpm workflow resume ${transaction.sessionId} --json`,
      },
    );
  }
  const head = correction.head;
  if (head === null) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_REQUIRED',
      'GREEN checks require one engine-validated and durably imported implementation patch.',
      ExitCode.verification,
      {
        recovery:
          'Import the exact provider patch through the task strategy transaction before rerunning checks.',
      },
    );
  }
  const sourceTree = head.record.sourceTree;
  const binding = readTaskStrategyPatchCurrentBinding(
    runtime,
    inspection.session.sessionId,
    sourceTree,
  );
  const record = readTaskStrategyPatchRecord(
    runtime,
    inspection.session.sessionId,
    head.record.patchDigest,
    sourceTree,
  );
  const receipt = readTaskStrategyPatchImportReceipt(
    runtime,
    inspection.session.sessionId,
    head.record.patchDigest,
    sourceTree,
  );
  const reservation = readTaskStrategyPatchReservation(
    runtime,
    inspection.session.sessionId,
    sourceTree,
  );
  const implementationSubject =
    correction.completedCorrectionRounds === 0
      ? initialImplementationSubject
      : createTaskStrategyCorrectionSubject({
          subject: initialImplementationSubject,
          round: correction.completedCorrectionRounds,
          greenFailureRecord: requireCorrectionFailureRecord(
            runtime,
            inspection.session.sessionId,
            sourceTree,
          ),
        });
  const implementationResult = readTaskStrategyImplementationResultBinding(
    runtime,
    inspection.session.sessionId,
    implementationSubject.subjectDigest,
  );
  const callerImplementationResult =
    readTaskStrategyCallerImplementationBinding(
      runtime,
      inspection.session.sessionId,
      implementationSubject.subjectDigest,
    );
  const sameProviderDegradationCurrent =
    implementationResult !== null &&
    implementationResult.output.patchDigest === record?.patchDigest &&
    implementationResult.output.sourceTree === sourceTree &&
    implementationResult.roleResult.form === 'granted-same-provider' &&
    implementationResult.roleResult.grantUse?.degradedForm ===
      'same-provider-fresh-session' &&
    implementationResult.roleResult.grantUse.targetDigest ===
      implementationResult.subjectDigest &&
    implementationResult.roleResult.assignment.providerId ===
      record?.implementer.providerId;
  const callerDegradationCurrent =
    record?.implementer.providerId === null &&
    callerImplementationResult !== null &&
    callerImplementationResult.output.patchDigest === record.patchDigest &&
    callerImplementationResult.output.sourceTree === sourceTree &&
    callerImplementationResult.subjectDigest ===
      callerImplementationResult.roleResult.targetDigest &&
    callerImplementationResult.roleResult.form === 'granted-caller-supplied' &&
    callerImplementationResult.roleResult.orchestration === 'caller-supplied' &&
    callerImplementationResult.roleResult.providerInvocation === null &&
    callerImplementationResult.roleResult.directHumanReviewAttestation ===
      null &&
    callerImplementationResult.roleResult.assignment.providerId === null &&
    callerImplementationResult.roleResult.assignment.sessionId === null &&
    'grantId' in callerImplementationResult.roleResult.assignment &&
    callerImplementationResult.roleResult.assignment.grantId ===
      record.implementer.grantId &&
    callerImplementationResult.roleResult.assignment.degradedForm ===
      'caller-supplied' &&
    callerImplementationResult.roleResult.participant.providerId === null &&
    callerImplementationResult.roleResult.participant.sessionId === null &&
    callerImplementationResult.roleResult.participant.principalId ===
      record.implementer.principalId &&
    callerImplementationResult.roleResult.participant.identityAssurance ===
      record.implementer.assurance &&
    callerImplementationResult.roleResult.participant.engineSpawned === false &&
    callerImplementationResult.roleResult.grantUse?.grantId ===
      record.implementer.grantId &&
    callerImplementationResult.roleResult.grantUse.degradedForm ===
      'caller-supplied' &&
    callerImplementationResult.roleResult.grantUse.targetDigest ===
      callerImplementationResult.subjectDigest &&
    callerImplementationResult.roleResult.grantUse.structuredContent.kind ===
      'task-implementation' &&
    callerImplementationResult.roleResult.grantUse.structuredContent.nodeId ===
      callerImplementationResult.submissionNodeId &&
    callerImplementationResult.roleResult.grantUse.structuredContent
      .resultDigest === callerImplementationResult.submissionResultDigest;
  if (
    record === null ||
    receipt === null ||
    binding === null ||
    reservation === null ||
    binding.bindingDigest !== head.binding.bindingDigest ||
    record.recordDigest !== head.record.recordDigest ||
    receipt.receiptDigest !== head.receipt.receiptDigest ||
    record.sessionId !== inspection.session.sessionId ||
    record.changeId !== inspection.session.changeId ||
    record.taskId !== inspection.session.taskId ||
    record.strategy !== task.strategy ||
    record.sourceTree !== sourceTree ||
    record.taskContractDigest !== sha256(canonicalJson(task)) ||
    reservation.patchDigest !== record.patchDigest ||
    reservation.recordDigest !== record.recordDigest ||
    reservation.sourceTree !== record.sourceTree ||
    reservation.candidateTree !== record.candidateTree ||
    reservation.createdAt !== record.createdAt ||
    receipt.recordDigest !== record.recordDigest ||
    receipt.patchDigest !== record.patchDigest ||
    receipt.candidateTree !== record.candidateTree ||
    binding.patchDigest !== record.patchDigest ||
    binding.recordDigest !== record.recordDigest ||
    binding.receiptDigest !== receipt.receiptDigest ||
    binding.candidateTree !== record.candidateTree ||
    binding.createdAt !== receipt.importedAt ||
    preview.tree !== record.candidateTree ||
    (record.implementer.providerId === null && !callerDegradationCurrent) ||
    (task.strategy === 'tdd-single-agent' &&
      canonicalJson(record.implementer) !==
        canonicalJson(transaction.author)) ||
    (task.strategy === 'cross-agent-tdd' &&
      record.implementer.providerId === transaction.author.providerId &&
      !sameProviderDegradationCurrent)
  ) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_STALE',
      'The imported implementation patch is missing, stale, or not bound to the current strategy authority.',
      ExitCode.staleState,
    );
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

function requireCorrectionFailureRecord(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  sessionId: string,
  candidateTree: string,
) {
  const failure = readTaskStrategyGreenFailureRecord(
    runtime,
    sessionId,
    candidateTree,
  );
  if (failure === null) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_STALE',
      'The latest correction patch is not bound to its exact preceding engine-observed GREEN failure.',
      ExitCode.staleState,
    );
  }
  return failure;
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
