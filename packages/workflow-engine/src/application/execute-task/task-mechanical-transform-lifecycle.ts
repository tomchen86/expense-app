import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  MechanicalTransformExecution,
  TransformationTerm,
} from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { readFinalizeTransaction } from '../../runtime/repository-transaction/finalize-transaction.ts';
import { listStagedPaths } from '../../runtime/repository-transaction/git-transitions.ts';
import { listChangedPaths } from '../../runtime/repository-transaction/git.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from '../../runtime/storage-journal/investigation-session-store.ts';
import { loadActiveSessionContext } from '../../composition-root/lifecycle-context.ts';
import { classifyMutationPath } from '../../modules/source/mutation-class-policy.ts';
import {
  investigationRuntimePaths,
  matchesAllowedPath,
  normalizeChangedPath,
} from '../../runtime/session-workspace/paths.ts';
import { deriveReviewedMutationClassPolicy } from '../../runtime/managed-documents/ownership/reviewed-mutation-policy.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../../runtime/session-workspace/session-store.ts';
import {
  readPinnedTrackedTree,
  type TrackedTreeEntry,
} from '../../runtime/repository-transaction/tracked-tree-reader.ts';
import {
  inspectSession,
  type SessionInspection,
} from '../finalize/verification.ts';

const RETAINED_CLASSES = new Set([
  'append-only',
  'immutable',
  'historical-reference',
]);
const DIGEST = /^[0-9a-f]{64}$/;

export type TaskMechanicalTransformLifecycleState =
  'transformation-required' | 'transformation-produced';

export type TaskMechanicalTransformLifecycleStatus = Readonly<{
  state: TaskMechanicalTransformLifecycleState;
  projectionDigest: string;
}>;

type MechanicalProjectionOperation = Readonly<{
  sourcePath: string;
  targetPath: string;
  mode: '100644' | '100755';
  before: Buffer;
  after: Buffer;
  beforeDigest: string;
  afterDigest: string;
  temporaryPath: string;
  targetQuarantinePath: string;
  sourceQuarantinePath: string;
}>;

type MechanicalProjectionPlan = Readonly<{
  projectionDigest: string;
  changedPaths: readonly string[];
  operations: readonly MechanicalProjectionOperation[];
}>;

type ProjectionPathCandidate = Readonly<{
  bytes: Buffer;
  mode: '100644' | '100755';
}>;

type MutationPathCas = Readonly<{
  relativePath: string;
  absolutePath: string;
  descriptor: number | null;
  identity: fs.BigIntStats | null;
  expectedBytes: Buffer | null;
  expectedMode: '100644' | '100755' | null;
}>;

type MechanicalProjectionJournal = Readonly<{
  schemaVersion: 1;
  kind: 'task-mechanical-transform-journal.v1';
  state: 'prepared' | 'completed';
  recordDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  taskContractDigest: string;
  transformationContractDigest: string;
  projectionDigest: string;
  operationCount: number;
}>;

export type ResumeTaskMechanicalTransformationOptions = Readonly<{
  /** Test-only crash cut after durable intent and before worktree mutation. */
  testAfterJournalPersist?: () => void;
  /** Test-only interleaving immediately before the first target publish. */
  testBeforeFirstTargetPublish?: () => void;
  /** Test-only adversarial cut after target CAS, before pathname mutation. */
  testAfterTargetCasBeforePathMutation?: (targetPath: string) => void;
  /** Test-only crash cut after an existing target is quarantined. */
  testAfterTargetQuarantine?: (targetPath: string) => void;
  /** Test-only crash cut after no-replace publication, before link cleanup. */
  testAfterTargetHardLink?: (targetPath: string) => void;
  /** Test-only adversarial cut after source CAS, before pathname mutation. */
  testAfterSourceCasBeforePathMutation?: (sourcePath: string) => void;
  /** Test-only crash cut after a removable source is quarantined. */
  testAfterSourceQuarantine?: (sourcePath: string) => void;
  /** Test-only crash cut after the first target file is atomically published. */
  testAfterFirstTargetPublish?: () => void;
  /** Test-only crash cut after exact worktree publication, before terminal CAS. */
  testAfterProjectionPublish?: () => void;
}>;

/** Read-only projection status; it never creates evidence or runtime state. */
export function inspectTaskMechanicalTransformLifecycle(
  cwd: string,
  requestedSessionId: string,
): TaskMechanicalTransformLifecycleStatus | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const finalizeTransaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  const projectionApplied =
    finalizeTransaction !== null &&
    finalizeTransaction.phase !== 'projection-prepared';
  const inspection = inspectSession(cwd, requestedSessionId, {
    expectedSession: context.session,
    ...(projectionApplied
      ? {
          projectedTaskIds: [...finalizeTransaction.completedTaskIds],
          projectionSourceDigest: finalizeTransaction.projectionSourceDigest,
          authorizedTransitionPaths: [...finalizeTransaction.transitionPaths],
        }
      : {}),
  });
  return inspectPreparedMechanicalTransformLifecycle(inspection, {
    ...(projectionApplied
      ? { expectedChangedPaths: [...finalizeTransaction.changedPaths] }
      : {}),
  });
}

export function inspectPreparedMechanicalTransformLifecycle(
  inspection: SessionInspection,
  options: Readonly<{ expectedChangedPaths?: readonly string[] }> = {},
): TaskMechanicalTransformLifecycleStatus | null {
  const task = mechanicalTask(inspection);
  if (task === null) return null;
  const plan = prepareProjection(inspection, task);
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const journal = readProjectionJournalIfPresent(
    runtime,
    projectionJournalPath(runtime.sessions, inspection.session.sessionId),
  );
  if (journal !== null) {
    assertJournalCurrent(
      journal,
      journalFor(inspection, task, plan, 'prepared'),
    );
    if (journal.state === 'prepared') {
      assertRecoverableWorktree(inspection, plan);
    }
  }
  return Object.freeze({
    state: projectionIsCurrent(
      inspection,
      plan,
      options.expectedChangedPaths ?? plan.changedPaths,
    )
      ? 'transformation-produced'
      : 'transformation-required',
    projectionDigest: plan.projectionDigest,
  });
}

/**
 * Apply the reviewed deterministic transform under repository and session
 * locks. The durable journal is published before mutation. Recovery accepts
 * only exact baseline/target bytes (plus an exact engine-owned temporary), so
 * an interrupted or foreign same-path write fails closed instead of being
 * overwritten.
 */
export function resumeTaskMechanicalTransformation(
  cwd: string,
  requestedSessionId: string,
  options: ResumeTaskMechanicalTransformationOptions = {},
): TaskMechanicalTransformLifecycleStatus {
  const initial = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
    withSessionOperation(initial.runtime, requestedSessionId, () => {
      assertOwned();
      const inspection = inspectSession(cwd, requestedSessionId);
      const task = mechanicalTask(inspection);
      if (task === null) {
        throw workflowError(
          'TASK_MECHANICAL_TRANSFORMATION_NOT_APPLICABLE',
          'Only a reviewed mechanical-transform task can run the deterministic projection.',
          ExitCode.guard,
        );
      }
      assertMutableSession(inspection);
      const staged = listStagedPaths(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
      );
      if (staged.length > 0) {
        throw workflowError(
          'TASK_MECHANICAL_TRANSFORMATION_STAGING_PRESENT',
          'Deterministic transformation resume refuses a pre-existing staged projection.',
          ExitCode.staleState,
          { details: { stagedPaths: staged } },
        );
      }
      const plan = prepareProjection(inspection, task);
      if (plan.operations.length === 0) {
        throw workflowError(
          'TASK_MECHANICAL_TRANSFORMATION_NO_CHANGE',
          'The reviewed deterministic transform does not produce any scoped byte or path change.',
          ExitCode.verification,
        );
      }
      const runtime = investigationRuntimePaths(
        inspection.git.gitCommonDirectory,
        inspection.contract.config.runtimeDirectory,
      );
      const journalPath = projectionJournalPath(
        runtime.sessions,
        inspection.session.sessionId,
      );
      const expectedJournal = journalFor(inspection, task, plan, 'prepared');
      const journal = readProjectionJournal(runtime, journalPath);
      if (journal === null) {
        assertNoUnownedTemporary(plan, inspection.git.repositoryRoot);
        createPrivateCanonicalJson(
          runtime,
          journalPath,
          expectedJournal,
          journalCorrupt,
          'TASK_MECHANICAL_TRANSFORMATION_JOURNAL_CONFLICT',
        );
      } else {
        assertJournalCurrent(journal, expectedJournal);
      }
      options.testAfterJournalPersist?.();
      assertRecoverableWorktree(inspection, plan);
      if (!projectionIsCurrent(inspection, plan)) {
        publishProjection(
          inspection.git.repositoryRoot,
          plan,
          assertOwned,
          options,
        );
      }
      options.testAfterProjectionPublish?.();
      assertOwned();
      const current = inspectSession(cwd, requestedSessionId);
      if (!projectionIsCurrent(current, plan)) {
        throw workflowError(
          'TASK_MECHANICAL_TRANSFORMATION_RECOVERY_REQUIRED',
          'The deterministic transform stopped without producing its exact reviewed projection.',
          ExitCode.staleState,
          {
            recovery: `pnpm workflow resume ${inspection.session.sessionId} --json`,
          },
        );
      }
      writePrivateCanonicalJsonAtomic(
        runtime,
        journalPath,
        journalFor(current, task, plan, 'completed'),
        journalCorrupt,
      );
      return Object.freeze({
        state: 'transformation-produced' as const,
        projectionDigest: plan.projectionDigest,
      });
    }),
  );
}

function prepareProjection(
  inspection: SessionInspection,
  task: MechanicalTransformExecution,
): MechanicalProjectionPlan {
  const baseline = readPinnedTrackedTree({
    repositoryRoot: inspection.git.repositoryRoot,
    treeOid: inspection.session.baseline.tree,
  });
  const mutationPolicy = deriveReviewedMutationClassPolicy(baseline);
  const scoped = baseline.entries.filter(
    (entry) =>
      entry.path.utf8 !== null &&
      task.transformationContract.fileScopes.some((scope) =>
        matchesAllowedPath(entry.path.utf8!, scope),
      ),
  );
  assertScannable(scoped);
  const targetPaths = new Set<string>();
  const rawOperations: Array<
    Omit<
      MechanicalProjectionOperation,
      'temporaryPath' | 'targetQuarantinePath' | 'sourceQuarantinePath'
    >
  > = [];
  for (const entry of scoped) {
    const sourcePath = entry.path.utf8!;
    const retained = RETAINED_CLASSES.has(
      classifyMutationPath(mutationPolicy, entry.path).mutationClass,
    );
    const targetPath = retained
      ? sourcePath
      : transformedPath(
          sourcePath,
          task.transformationContract.oldTerms,
          task.transformationContract.replacementTerms,
        );
    if (
      targetPaths.has(targetPath) ||
      !task.transformationContract.fileScopes.some((scope) =>
        matchesAllowedPath(targetPath, scope),
      )
    ) {
      throw projectionInvalid(
        'The deterministic path mapping collides or escapes its reviewed scope.',
        { sourcePath, targetPath },
      );
    }
    targetPaths.add(targetPath);
    const mode = parseRegularMode(entry.mode, sourcePath);
    const before = Buffer.from(entry.content!);
    const after = retained
      ? Buffer.from(before)
      : simultaneousReplace(
          before,
          contentReplacements(
            task.transformationContract.oldTerms,
            task.transformationContract.replacementTerms,
          ),
        );
    if (sourcePath !== targetPath || !before.equals(after)) {
      rawOperations.push({
        sourcePath,
        targetPath,
        mode,
        before,
        after,
        beforeDigest: sha256(before),
        afterDigest: sha256(after),
      });
    }
  }
  const operationIdentity = rawOperations
    .map(({ sourcePath, targetPath, mode, beforeDigest, afterDigest }) => ({
      sourcePath,
      targetPath,
      mode,
      beforeDigest,
      afterDigest,
    }))
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  const projectionDigest = sha256(
    canonicalJson({
      schemaVersion: 1,
      baseline: inspection.session.baseline,
      taskContractDigest: sha256(canonicalJson(task)),
      operations: operationIdentity,
    }),
  );
  const operations = rawOperations
    .map((operation) => ({
      ...operation,
      temporaryPath: temporaryPathFor(
        inspection.session.sessionId,
        projectionDigest,
        operation.targetPath,
      ),
      targetQuarantinePath: quarantinePathFor(
        inspection.session.sessionId,
        projectionDigest,
        'target',
        operation.targetPath,
      ),
      sourceQuarantinePath: quarantinePathFor(
        inspection.session.sessionId,
        projectionDigest,
        'source',
        operation.sourcePath,
      ),
    }))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  const changedPaths = [
    ...new Set(
      operations.flatMap(({ sourcePath, targetPath }) => [
        sourcePath,
        targetPath,
      ]),
    ),
  ].sort();
  return Object.freeze({ projectionDigest, changedPaths, operations });
}

function projectionIsCurrent(
  inspection: SessionInspection,
  plan: MechanicalProjectionPlan,
  expectedChangedPaths: readonly string[] = plan.changedPaths,
): boolean {
  if (
    canonicalJson(
      listChangedPaths(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
      ),
    ) !== canonicalJson([...expectedChangedPaths].sort())
  ) {
    return false;
  }
  const targets = new Set(plan.operations.map(({ targetPath }) => targetPath));
  for (const operation of plan.operations) {
    if (
      !fileMatches(
        inspection.git.repositoryRoot,
        operation.targetPath,
        operation.after,
        operation.mode,
      )
    ) {
      return false;
    }
    if (
      operation.sourcePath !== operation.targetPath &&
      !targets.has(operation.sourcePath) &&
      fs.lstatSync(
        path.join(inspection.git.repositoryRoot, operation.sourcePath),
        { throwIfNoEntry: false },
      ) !== undefined
    ) {
      return false;
    }
  }
  return plan.operations.length > 0;
}

function assertRecoverableWorktree(
  inspection: SessionInspection,
  plan: MechanicalProjectionPlan,
): void {
  const repositoryRoot = inspection.git.repositoryRoot;
  const ownedPaths = new Set(
    plan.operations.flatMap(
      ({
        sourcePath,
        targetPath,
        temporaryPath,
        targetQuarantinePath,
        sourceQuarantinePath,
      }) => [
        sourcePath,
        targetPath,
        temporaryPath,
        targetQuarantinePath,
        sourceQuarantinePath,
      ],
    ),
  );
  const outside = listChangedPaths(
    repositoryRoot,
    inspection.session.baseline.head,
  ).filter((changedPath) => !ownedPaths.has(changedPath));
  if (outside.length > 0) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DIRTY',
      'Deterministic transformation resume refuses paths outside its exact projection.',
      ExitCode.staleState,
      { details: { outsidePaths: outside } },
    );
  }

  const { allowed, mayBeMissing } = projectionPathAuthorities(plan);
  for (const operation of plan.operations) {
    assertSafeRepositoryPath(repositoryRoot, operation.sourcePath);
    assertSafeRepositoryPath(repositoryRoot, operation.targetPath);
    assertSafeRepositoryPath(repositoryRoot, operation.temporaryPath);
    assertSafeRepositoryPath(repositoryRoot, operation.targetQuarantinePath);
    assertSafeRepositoryPath(repositoryRoot, operation.sourceQuarantinePath);
    const temporary = fs.lstatSync(
      path.join(repositoryRoot, operation.temporaryPath),
      { throwIfNoEntry: false },
    );
    if (
      temporary !== undefined &&
      !fileMatches(
        repositoryRoot,
        operation.temporaryPath,
        operation.after,
        operation.mode,
      ) &&
      !isPublishedHardLinkIntermediate(repositoryRoot, operation)
    ) {
      throw worktreeDrift(operation.temporaryPath);
    }
    const targetCandidates = allowed.get(operation.targetPath) ?? [];
    if (
      pathExists(repositoryRoot, operation.targetQuarantinePath) &&
      !pathMatchesCandidates(
        repositoryRoot,
        operation.targetQuarantinePath,
        targetCandidates,
      )
    ) {
      throw worktreeDrift(operation.targetQuarantinePath);
    }
    if (
      pathExists(repositoryRoot, operation.sourceQuarantinePath) &&
      !fileMatches(
        repositoryRoot,
        operation.sourceQuarantinePath,
        operation.before,
        operation.mode,
      )
    ) {
      throw worktreeDrift(operation.sourceQuarantinePath);
    }
  }
  for (const [relativePath, candidates] of allowed) {
    const absolute = path.join(repositoryRoot, relativePath);
    const observed = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (observed === undefined) {
      if (
        mayBeMissing.has(relativePath) ||
        pathHasExactQuarantine(repositoryRoot, plan, relativePath)
      ) {
        continue;
      }
      throw worktreeDrift(relativePath);
    }
    if (
      !pathMatchesRecoverableCandidate(
        repositoryRoot,
        plan,
        relativePath,
        candidates,
      )
    ) {
      throw worktreeDrift(relativePath);
    }
  }
}

function projectionPathAuthorities(plan: MechanicalProjectionPlan): Readonly<{
  allowed: Map<string, ProjectionPathCandidate[]>;
  mayBeMissing: Set<string>;
}> {
  const allowed = new Map<string, ProjectionPathCandidate[]>();
  const mayBeMissing = new Set<string>();
  const sources = new Set(plan.operations.map(({ sourcePath }) => sourcePath));
  const targets = new Set(plan.operations.map(({ targetPath }) => targetPath));
  for (const operation of plan.operations) {
    appendAllowed(allowed, operation.sourcePath, {
      bytes: operation.before,
      mode: operation.mode,
    });
    appendAllowed(allowed, operation.targetPath, {
      bytes: operation.after,
      mode: operation.mode,
    });
    if (!targets.has(operation.sourcePath)) {
      mayBeMissing.add(operation.sourcePath);
    }
    if (!sources.has(operation.targetPath)) {
      mayBeMissing.add(operation.targetPath);
    }
  }
  return { allowed, mayBeMissing };
}

function publishProjection(
  repositoryRoot: string,
  plan: MechanicalProjectionPlan,
  assertOwned: () => void,
  options: ResumeTaskMechanicalTransformationOptions,
): void {
  const authorities = projectionPathAuthorities(plan);
  for (const operation of plan.operations) {
    assertOwned();
    recoverPublishedHardLink(
      repositoryRoot,
      operation,
      authorities.allowed.get(operation.targetPath) ?? [],
    );
    ensureSafeParent(repositoryRoot, operation.temporaryPath);
    if (
      fileMatches(
        repositoryRoot,
        operation.targetPath,
        operation.after,
        operation.mode,
      )
    ) {
      continue;
    }
    publishTemporary(repositoryRoot, operation);
  }

  let published = 0;
  for (const operation of plan.operations) {
    assertOwned();
    if (
      fileMatches(
        repositoryRoot,
        operation.targetPath,
        operation.after,
        operation.mode,
      )
    ) {
      cleanupTargetQuarantine(
        repositoryRoot,
        operation,
        authorities.allowed.get(operation.targetPath) ?? [],
      );
      cleanupExactTemporary(repositoryRoot, operation);
      continue;
    }
    if (pathExists(repositoryRoot, operation.temporaryPath)) {
      if (published === 0) options.testBeforeFirstTargetPublish?.();
      publishTargetNoReplace(
        repositoryRoot,
        operation,
        authorities.allowed.get(operation.targetPath) ?? [],
        authorities.mayBeMissing.has(operation.targetPath),
        assertOwned,
        options,
      );
      published += 1;
      if (published === 1) options.testAfterFirstTargetPublish?.();
    }
  }

  const targets = new Set(plan.operations.map(({ targetPath }) => targetPath));
  for (const operation of plan.operations) {
    assertOwned();
    if (
      operation.sourcePath === operation.targetPath ||
      targets.has(operation.sourcePath)
    ) {
      continue;
    }
    quarantineAndRemoveSource(repositoryRoot, operation, assertOwned, options);
  }
}

function publishTargetNoReplace(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
  targetCandidates: readonly ProjectionPathCandidate[],
  targetMayBeMissing: boolean,
  assertOwned: () => void,
  options: ResumeTaskMechanicalTransformationOptions,
): void {
  if (targetCandidates.length === 0) throw worktreeDrift(operation.targetPath);
  const target = path.join(repositoryRoot, operation.targetPath);
  const quarantine = path.join(repositoryRoot, operation.targetQuarantinePath);
  const temporary = path.join(repositoryRoot, operation.temporaryPath);
  ensureSafeParent(repositoryRoot, operation.targetPath);
  ensureSafeParent(repositoryRoot, operation.targetQuarantinePath);

  let targetCas: MutationPathCas | null = null;
  let quarantineCas: MutationPathCas | null = null;
  let temporaryCas: MutationPathCas | null = null;
  try {
    if (pathExists(repositoryRoot, operation.targetQuarantinePath)) {
      if (pathExists(repositoryRoot, operation.targetPath)) {
        cleanupTargetQuarantine(repositoryRoot, operation, targetCandidates);
        cleanupExactTemporary(repositoryRoot, operation);
        throw worktreeDrift(operation.targetPath);
      }
      quarantineCas = openMutationPathCas(
        repositoryRoot,
        operation.targetQuarantinePath,
        targetCandidates,
        false,
      );
    } else {
      targetCas = openMutationPathCas(
        repositoryRoot,
        operation.targetPath,
        targetCandidates,
        targetMayBeMissing,
      );
      assertOwned();
      assertMutationPathCasCurrent(targetCas);
      options.testAfterTargetCasBeforePathMutation?.(operation.targetPath);
      if (targetCas.descriptor !== null) {
        if (pathExists(repositoryRoot, operation.targetQuarantinePath)) {
          throw worktreeDrift(operation.targetQuarantinePath);
        }
        fs.renameSync(target, quarantine);
        fsyncDirectory(path.dirname(target));
        try {
          quarantineCas = openMutationPathCas(
            repositoryRoot,
            operation.targetQuarantinePath,
            [candidateFromMutationCas(targetCas)],
            false,
          );
          assertSameMutationInode(targetCas, quarantineCas);
        } catch {
          restoreQuarantineNoReplace(
            repositoryRoot,
            operation.targetQuarantinePath,
            operation.targetPath,
          );
          cleanupExactTemporary(repositoryRoot, operation);
          throw worktreeDrift(operation.targetPath);
        }
        options.testAfterTargetQuarantine?.(operation.targetPath);
      }
    }

    temporaryCas = openMutationPathCas(
      repositoryRoot,
      operation.temporaryPath,
      [{ bytes: operation.after, mode: operation.mode }],
      false,
    );
    assertOwned();
    assertMutationPathCasCurrent(temporaryCas);
    try {
      fs.linkSync(temporary, target);
    } catch {
      cleanupTargetQuarantine(repositoryRoot, operation, targetCandidates);
      cleanupExactTemporary(repositoryRoot, operation);
      throw worktreeDrift(operation.targetPath);
    }
    fsyncDirectory(path.dirname(target));
    assertPublishedHardLink(temporaryCas, target, operation);
    options.testAfterTargetHardLink?.(operation.targetPath);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(temporary));
    cleanupTargetQuarantine(repositoryRoot, operation, targetCandidates);
    if (
      !fileMatches(
        repositoryRoot,
        operation.targetPath,
        operation.after,
        operation.mode,
      )
    ) {
      throw worktreeDrift(operation.targetPath);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT' &&
      !isPublishedHardLinkIntermediate(repositoryRoot, operation)
    ) {
      cleanupExactTemporary(repositoryRoot, operation);
    }
    throw error;
  } finally {
    if (temporaryCas !== null) closeMutationPathCas(temporaryCas);
    if (quarantineCas !== null) closeMutationPathCas(quarantineCas);
    if (targetCas !== null) closeMutationPathCas(targetCas);
  }
}

function quarantineAndRemoveSource(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
  assertOwned: () => void,
  options: ResumeTaskMechanicalTransformationOptions,
): void {
  const source = path.join(repositoryRoot, operation.sourcePath);
  const quarantine = path.join(repositoryRoot, operation.sourceQuarantinePath);
  ensureSafeParent(repositoryRoot, operation.sourceQuarantinePath);
  if (pathExists(repositoryRoot, operation.sourceQuarantinePath)) {
    if (pathExists(repositoryRoot, operation.sourcePath)) {
      cleanupSourceQuarantine(repositoryRoot, operation);
      throw worktreeDrift(operation.sourcePath);
    }
    cleanupSourceQuarantine(repositoryRoot, operation);
    return;
  }
  if (!pathExists(repositoryRoot, operation.sourcePath)) return;

  const sourceCas = openMutationPathCas(
    repositoryRoot,
    operation.sourcePath,
    [{ bytes: operation.before, mode: operation.mode }],
    false,
  );
  let quarantineCas: MutationPathCas | null = null;
  try {
    assertOwned();
    assertMutationPathCasCurrent(sourceCas);
    options.testAfterSourceCasBeforePathMutation?.(operation.sourcePath);
    if (pathExists(repositoryRoot, operation.sourceQuarantinePath)) {
      throw worktreeDrift(operation.sourceQuarantinePath);
    }
    fs.renameSync(source, quarantine);
    fsyncDirectory(path.dirname(source));
    try {
      quarantineCas = openMutationPathCas(
        repositoryRoot,
        operation.sourceQuarantinePath,
        [{ bytes: operation.before, mode: operation.mode }],
        false,
      );
      assertSameMutationInode(sourceCas, quarantineCas);
    } catch {
      restoreQuarantineNoReplace(
        repositoryRoot,
        operation.sourceQuarantinePath,
        operation.sourcePath,
      );
      throw worktreeDrift(operation.sourcePath);
    }
    options.testAfterSourceQuarantine?.(operation.sourcePath);
    cleanupSourceQuarantine(repositoryRoot, operation);
  } finally {
    if (quarantineCas !== null) closeMutationPathCas(quarantineCas);
    closeMutationPathCas(sourceCas);
  }
}

function recoverPublishedHardLink(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
  targetCandidates: readonly ProjectionPathCandidate[],
): void {
  if (!isPublishedHardLinkIntermediate(repositoryRoot, operation)) return;
  const temporary = path.join(repositoryRoot, operation.temporaryPath);
  fs.unlinkSync(temporary);
  fsyncDirectory(path.dirname(temporary));
  cleanupTargetQuarantine(repositoryRoot, operation, targetCandidates);
  if (
    !fileMatches(
      repositoryRoot,
      operation.targetPath,
      operation.after,
      operation.mode,
    )
  ) {
    throw worktreeDrift(operation.targetPath);
  }
}

function isPublishedHardLinkIntermediate(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
): boolean {
  const temporary = path.join(repositoryRoot, operation.temporaryPath);
  const target = path.join(repositoryRoot, operation.targetPath);
  const temporaryStats = fs.lstatSync(temporary, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const targetStats = fs.lstatSync(target, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    temporaryStats === undefined ||
    targetStats === undefined ||
    !isExactPublishedLinkStats(temporaryStats, operation.mode) ||
    !isExactPublishedLinkStats(targetStats, operation.mode) ||
    temporaryStats.dev !== targetStats.dev ||
    temporaryStats.ino !== targetStats.ino
  ) {
    return false;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = readDescriptorBytes(descriptor, before.size);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const currentTemporary = fs.lstatSync(temporary, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const currentTarget = fs.lstatSync(target, {
      bigint: true,
      throwIfNoEntry: false,
    });
    return (
      bytes.equals(operation.after) &&
      currentTemporary !== undefined &&
      currentTarget !== undefined &&
      samePublishedLinkIdentity(before, after) &&
      samePublishedLinkIdentity(after, currentTemporary) &&
      samePublishedLinkIdentity(after, currentTarget)
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertPublishedHardLink(
  temporaryCas: MutationPathCas,
  target: string,
  operation: MechanicalProjectionOperation,
): void {
  if (
    temporaryCas.descriptor === null ||
    temporaryCas.identity === null ||
    temporaryCas.expectedBytes === null
  ) {
    throw worktreeDrift(operation.targetPath);
  }
  const opened = fs.fstatSync(temporaryCas.descriptor, { bigint: true });
  const bytes = readDescriptorBytes(temporaryCas.descriptor, opened.size);
  const targetStats = fs.lstatSync(target, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    targetStats === undefined ||
    !bytes.equals(temporaryCas.expectedBytes) ||
    !isExactPublishedLinkStats(opened, operation.mode) ||
    !isExactPublishedLinkStats(targetStats, operation.mode) ||
    opened.dev !== temporaryCas.identity.dev ||
    opened.ino !== temporaryCas.identity.ino ||
    opened.dev !== targetStats.dev ||
    opened.ino !== targetStats.ino ||
    opened.size !== targetStats.size ||
    opened.mtimeNs !== targetStats.mtimeNs
  ) {
    throw worktreeDrift(operation.targetPath);
  }
}

function isExactPublishedLinkStats(
  stats: fs.BigIntStats,
  mode: '100644' | '100755',
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 2n &&
    mutationModeMatches(stats, mode)
  );
}

function samePublishedLinkIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    observed.isFile() &&
    !observed.isSymbolicLink() &&
    observed.nlink === 2n &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function candidateFromMutationCas(
  cas: MutationPathCas,
): ProjectionPathCandidate {
  if (cas.expectedBytes === null || cas.expectedMode === null) {
    throw worktreeDrift(cas.relativePath);
  }
  return { bytes: Buffer.from(cas.expectedBytes), mode: cas.expectedMode };
}

function assertSameMutationInode(
  expected: MutationPathCas,
  observed: MutationPathCas,
): void {
  if (
    expected.identity === null ||
    observed.identity === null ||
    expected.identity.dev !== observed.identity.dev ||
    expected.identity.ino !== observed.identity.ino
  ) {
    throw worktreeDrift(observed.relativePath);
  }
}

function restoreQuarantineNoReplace(
  repositoryRoot: string,
  quarantinePath: string,
  originalPath: string,
): void {
  const quarantine = path.join(repositoryRoot, quarantinePath);
  const original = path.join(repositoryRoot, originalPath);
  if (fs.lstatSync(original, { throwIfNoEntry: false }) !== undefined) {
    throw worktreeDrift(originalPath);
  }
  try {
    fs.linkSync(quarantine, original);
  } catch {
    throw worktreeDrift(originalPath);
  }
  fsyncDirectory(path.dirname(original));
  const quarantined = fs.lstatSync(quarantine, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const restored = fs.lstatSync(original, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    quarantined === undefined ||
    restored === undefined ||
    quarantined.dev !== restored.dev ||
    quarantined.ino !== restored.ino
  ) {
    throw worktreeDrift(originalPath);
  }
  fs.unlinkSync(quarantine);
  fsyncDirectory(path.dirname(quarantine));
}

function cleanupTargetQuarantine(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
  candidates: readonly ProjectionPathCandidate[],
): void {
  cleanupExactEnginePath(
    repositoryRoot,
    operation.targetQuarantinePath,
    candidates,
  );
}

function cleanupSourceQuarantine(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
): void {
  cleanupExactEnginePath(repositoryRoot, operation.sourceQuarantinePath, [
    { bytes: operation.before, mode: operation.mode },
  ]);
}

function cleanupExactTemporary(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
): void {
  cleanupExactEnginePath(repositoryRoot, operation.temporaryPath, [
    { bytes: operation.after, mode: operation.mode },
  ]);
}

function cleanupExactEnginePath(
  repositoryRoot: string,
  relativePath: string,
  candidates: readonly ProjectionPathCandidate[],
): void {
  if (!pathExists(repositoryRoot, relativePath)) return;
  if (!pathMatchesCandidates(repositoryRoot, relativePath, candidates)) {
    throw worktreeDrift(relativePath);
  }
  const absolute = path.join(repositoryRoot, relativePath);
  fs.unlinkSync(absolute);
  fsyncDirectory(path.dirname(absolute));
}

function pathMatchesRecoverableCandidate(
  repositoryRoot: string,
  plan: MechanicalProjectionPlan,
  relativePath: string,
  candidates: readonly ProjectionPathCandidate[],
): boolean {
  if (pathMatchesCandidates(repositoryRoot, relativePath, candidates)) {
    return true;
  }
  return plan.operations.some(
    (operation) =>
      operation.targetPath === relativePath &&
      isPublishedHardLinkIntermediate(repositoryRoot, operation),
  );
}

function pathMatchesCandidates(
  repositoryRoot: string,
  relativePath: string,
  candidates: readonly ProjectionPathCandidate[],
): boolean {
  return candidates.some(({ bytes, mode }) =>
    fileMatches(repositoryRoot, relativePath, bytes, mode),
  );
}

function pathHasExactQuarantine(
  repositoryRoot: string,
  plan: MechanicalProjectionPlan,
  relativePath: string,
): boolean {
  const authorities = projectionPathAuthorities(plan);
  return plan.operations.some((operation) => {
    if (
      operation.targetPath === relativePath &&
      pathMatchesCandidates(
        repositoryRoot,
        operation.targetQuarantinePath,
        authorities.allowed.get(operation.targetPath) ?? [],
      )
    ) {
      return true;
    }
    return (
      operation.sourcePath === relativePath &&
      fileMatches(
        repositoryRoot,
        operation.sourceQuarantinePath,
        operation.before,
        operation.mode,
      )
    );
  });
}

function pathExists(repositoryRoot: string, relativePath: string): boolean {
  return (
    fs.lstatSync(path.join(repositoryRoot, relativePath), {
      throwIfNoEntry: false,
    }) !== undefined
  );
}

function publishTemporary(
  repositoryRoot: string,
  operation: MechanicalProjectionOperation,
): void {
  const temporary = path.join(repositoryRoot, operation.temporaryPath);
  const observed = fs.lstatSync(temporary, { throwIfNoEntry: false });
  if (observed !== undefined) {
    if (
      !fileMatches(
        repositoryRoot,
        operation.temporaryPath,
        operation.after,
        operation.mode,
      )
    ) {
      throw worktreeDrift(operation.temporaryPath);
    }
    return;
  }
  const descriptor = fs.openSync(temporary, 'wx', modeBits(operation.mode));
  try {
    fs.writeFileSync(descriptor, operation.after);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, modeBits(operation.mode));
  fsyncDirectory(path.dirname(temporary));
}

function journalFor(
  inspection: SessionInspection,
  task: MechanicalTransformExecution,
  plan: MechanicalProjectionPlan,
  state: MechanicalProjectionJournal['state'],
): MechanicalProjectionJournal {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-mechanical-transform-journal.v1' as const,
    state,
    sessionId: inspection.session.sessionId,
    changeId: inspection.session.changeId,
    taskId: inspection.session.taskId,
    baseline: inspection.session.baseline,
    taskContractDigest: sha256(canonicalJson(task)),
    transformationContractDigest: sha256(
      canonicalJson(task.transformationContract),
    ),
    projectionDigest: plan.projectionDigest,
    operationCount: plan.operations.length,
  };
  return Object.freeze({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
}

function readProjectionJournal(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  journalPath: string,
): MechanicalProjectionJournal | null {
  if (!privatePathExists(runtime, journalPath, journalCorrupt)) return null;
  const value = readPrivateCanonicalJson(runtime, journalPath, journalCorrupt);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'baseline',
      'changeId',
      'kind',
      'operationCount',
      'projectionDigest',
      'recordDigest',
      'schemaVersion',
      'sessionId',
      'state',
      'taskContractDigest',
      'taskId',
      'transformationContractDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-mechanical-transform-journal.v1' ||
    (value.state !== 'prepared' && value.state !== 'completed') ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    !isRecord(value.baseline) ||
    !hasExactKeys(value.baseline, ['head', 'tree']) ||
    typeof value.baseline.head !== 'string' ||
    typeof value.baseline.tree !== 'string' ||
    !DIGEST.test(String(value.taskContractDigest)) ||
    !DIGEST.test(String(value.transformationContractDigest)) ||
    !DIGEST.test(String(value.projectionDigest)) ||
    !Number.isSafeInteger(value.operationCount) ||
    Number(value.operationCount) < 1 ||
    !DIGEST.test(String(value.recordDigest))
  ) {
    throw journalCorrupt();
  }
  const journal = value as unknown as MechanicalProjectionJournal;
  const { recordDigest: _recordDigest, ...body } = journal;
  if (journal.recordDigest !== sha256(canonicalJson(body))) {
    throw journalCorrupt();
  }
  return journal;
}

function readProjectionJournalIfPresent(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  journalPath: string,
): MechanicalProjectionJournal | null {
  if (!privatePathExists(runtime, journalPath, journalCorrupt)) return null;
  return readProjectionJournal(runtime, journalPath);
}

function assertJournalCurrent(
  actual: MechanicalProjectionJournal,
  expected: MechanicalProjectionJournal,
): void {
  if (
    actual.sessionId !== expected.sessionId ||
    actual.changeId !== expected.changeId ||
    actual.taskId !== expected.taskId ||
    canonicalJson(actual.baseline) !== canonicalJson(expected.baseline) ||
    actual.taskContractDigest !== expected.taskContractDigest ||
    actual.transformationContractDigest !==
      expected.transformationContractDigest ||
    actual.projectionDigest !== expected.projectionDigest ||
    actual.operationCount !== expected.operationCount
  ) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_JOURNAL_STALE',
      'The durable deterministic-transform journal no longer matches the active reviewed task.',
      ExitCode.staleState,
    );
  }
}

function assertMutableSession(inspection: SessionInspection): void {
  const session = inspection.session;
  if (
    session.state !== 'active' ||
    session.revisionLeaseId !== undefined ||
    session.latestCheckReportId !== undefined ||
    session.completionReportId !== undefined ||
    session.finishReportId !== undefined ||
    session.commitReportId !== undefined
  ) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_SESSION_STALE',
      'Deterministic transformation requires an active pre-check task session.',
      ExitCode.staleState,
    );
  }
}

function assertScannable(entries: readonly TrackedTreeEntry[]): void {
  for (const entry of entries) {
    if (entry.skipReason !== undefined || entry.content === undefined) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_INPUT_UNSCANNABLE',
        'The reviewed deterministic transform refuses a symlink, binary, sensitive, oversized, or otherwise unscannable scoped input.',
        ExitCode.verification,
        {
          details: {
            path: entry.path.utf8,
            skipReason: entry.skipReason ?? 'missing-content',
          },
        },
      );
    }
  }
}

function transformedPath(
  sourcePath: string,
  oldTerms: readonly TransformationTerm[],
  replacementTerms: readonly TransformationTerm[],
): string {
  const transformed = simultaneousReplace(
    Buffer.from(sourcePath),
    oldTerms.flatMap((term, index) =>
      term.kind === 'path'
        ? [
            {
              before: Buffer.from(term.value),
              after: Buffer.from(replacementTerms[index]!.value),
            },
          ]
        : [],
    ),
  ).toString('utf8');
  try {
    return normalizeChangedPath(transformed);
  } catch {
    throw projectionInvalid(
      'The deterministic path transformation produced an unsafe repository path.',
      { sourcePath, transformedPath: transformed },
    );
  }
}

function contentReplacements(
  oldTerms: readonly TransformationTerm[],
  replacementTerms: readonly TransformationTerm[],
): Array<{ before: Buffer; after: Buffer }> {
  return oldTerms.flatMap((term, index) =>
    term.kind === 'path'
      ? []
      : [
          {
            before: Buffer.from(term.value),
            after: Buffer.from(replacementTerms[index]!.value),
          },
        ],
  );
}

function simultaneousReplace(
  source: Buffer,
  replacements: readonly { before: Buffer; after: Buffer }[],
): Buffer {
  if (replacements.length === 0) return Buffer.from(source);
  const ordered = [...replacements].sort(
    (left, right) =>
      right.before.length - left.before.length ||
      Buffer.compare(left.before, right.before),
  );
  const chunks: Buffer[] = [];
  let literalStart = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const match = ordered.find(
      ({ before }) =>
        cursor + before.length <= source.length &&
        source.subarray(cursor, cursor + before.length).equals(before),
    );
    if (match === undefined) {
      cursor += 1;
      continue;
    }
    chunks.push(source.subarray(literalStart, cursor), match.after);
    cursor += match.before.length;
    literalStart = cursor;
  }
  chunks.push(source.subarray(literalStart));
  return Buffer.concat(chunks);
}

function fileMatches(
  repositoryRoot: string,
  relativePath: string,
  bytes: Buffer,
  mode: '100644' | '100755',
): boolean {
  const absolute = path.join(repositoryRoot, relativePath);
  const observed = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    observed === undefined ||
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.nlink !== 1 ||
    (observed.mode & 0o111) !== (mode === '100755' ? 0o111 : 0)
  ) {
    return false;
  }
  try {
    return fs.readFileSync(absolute).equals(bytes);
  } catch {
    return false;
  }
}

function openMutationPathCas(
  repositoryRoot: string,
  relativePath: string,
  candidates: readonly ProjectionPathCandidate[],
  mayBeMissing: boolean,
): MutationPathCas {
  assertSafeRepositoryPath(repositoryRoot, relativePath);
  const absolutePath = path.join(repositoryRoot, relativePath);
  const initial = fs.lstatSync(absolutePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (initial === undefined) {
    if (!mayBeMissing) throw worktreeDrift(relativePath);
    return {
      relativePath,
      absolutePath,
      descriptor: null,
      identity: null,
      expectedBytes: null,
      expectedMode: null,
    };
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = readDescriptorBytes(descriptor, before.size);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(absolutePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const candidate = candidates.find(
      ({ bytes: expectedBytes, mode }) =>
        expectedBytes.equals(bytes) && mutationModeMatches(after, mode),
    );
    if (
      current === undefined ||
      candidate === undefined ||
      !sameMutationPathIdentity(initial, before) ||
      !sameMutationPathIdentity(before, after) ||
      !sameMutationPathIdentity(after, current)
    ) {
      throw worktreeDrift(relativePath);
    }
    return {
      relativePath,
      absolutePath,
      descriptor,
      identity: after,
      expectedBytes: Buffer.from(candidate.bytes),
      expectedMode: candidate.mode,
    };
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw worktreeDrift(relativePath);
  }
}

function assertMutationPathCasCurrent(cas: MutationPathCas): void {
  const current = fs.lstatSync(cas.absolutePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (cas.descriptor === null) {
    if (current !== undefined) throw worktreeDrift(cas.relativePath);
    return;
  }
  if (
    cas.identity === null ||
    cas.expectedBytes === null ||
    cas.expectedMode === null ||
    current === undefined
  ) {
    throw worktreeDrift(cas.relativePath);
  }
  const before = fs.fstatSync(cas.descriptor, { bigint: true });
  const bytes = readDescriptorBytes(cas.descriptor, before.size);
  const after = fs.fstatSync(cas.descriptor, { bigint: true });
  if (
    !cas.expectedBytes.equals(bytes) ||
    !mutationModeMatches(after, cas.expectedMode) ||
    !sameMutationPathIdentity(cas.identity, before) ||
    !sameMutationPathIdentity(before, after) ||
    !sameMutationPathIdentity(after, current)
  ) {
    throw worktreeDrift(cas.relativePath);
  }
}

function closeMutationPathCas(cas: MutationPathCas): void {
  if (cas.descriptor !== null) fs.closeSync(cas.descriptor);
}

function readDescriptorBytes(descriptor: number, size: bigint): Buffer {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('file too large');
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (read === 0) throw new Error('file changed while reading');
    offset += read;
  }
  return bytes;
}

function mutationModeMatches(
  stats: fs.BigIntStats,
  mode: '100644' | '100755',
): boolean {
  return (stats.mode & 0o111n) === (mode === '100755' ? 0o111n : 0n);
}

function sameMutationPathIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    observed.isFile() &&
    !observed.isSymbolicLink() &&
    observed.nlink === 1n &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function appendAllowed(
  allowed: Map<string, ProjectionPathCandidate[]>,
  relativePath: string,
  candidate: ProjectionPathCandidate,
): void {
  const existing = allowed.get(relativePath) ?? [];
  if (
    !existing.some(
      ({ bytes, mode }) =>
        mode === candidate.mode && bytes.equals(candidate.bytes),
    )
  ) {
    existing.push(candidate);
  }
  allowed.set(relativePath, existing);
}

function assertNoUnownedTemporary(
  plan: MechanicalProjectionPlan,
  repositoryRoot: string,
): void {
  for (const operation of plan.operations) {
    const conflictPath = [
      operation.temporaryPath,
      operation.targetQuarantinePath,
      operation.sourceQuarantinePath,
    ].find((relativePath) => pathExists(repositoryRoot, relativePath));
    if (conflictPath !== undefined) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_TEMPORARY_CONFLICT',
        'An engine-owned deterministic-transform temporary or quarantine path already exists without its journal.',
        ExitCode.staleState,
        { details: { path: conflictPath } },
      );
    }
  }
}

function assertSafeRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): void {
  if (normalizeChangedPath(relativePath) !== relativePath) {
    throw projectionInvalid('A deterministic projection path is unsafe.', {
      path: relativePath,
    });
  }
  const segments = relativePath.split('/');
  let cursor = repositoryRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const observed = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (observed === undefined) break;
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_PATH_UNSAFE',
        'A deterministic projection path traverses a symlink or non-directory ancestor.',
        ExitCode.unsafeEnvironment,
        { details: { path: relativePath } },
      );
    }
  }
}

function ensureSafeParent(repositoryRoot: string, relativePath: string): void {
  assertSafeRepositoryPath(repositoryRoot, relativePath);
  const segments = path.dirname(relativePath).split('/').filter(Boolean);
  let cursor = repositoryRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const observed = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (observed === undefined) {
      fs.mkdirSync(cursor, { mode: 0o755 });
    } else if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_PATH_UNSAFE',
        'A deterministic projection parent is a symlink or non-directory.',
        ExitCode.unsafeEnvironment,
        { details: { path: relativePath } },
      );
    }
  }
}

function parseRegularMode(
  mode: string,
  relativePath: string,
): '100644' | '100755' {
  if (mode === '100644' || mode === '100755') return mode;
  throw workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_INPUT_UNSCANNABLE',
    'The deterministic transform supports only ordinary tracked file modes.',
    ExitCode.verification,
    { details: { path: relativePath, mode } },
  );
}

function temporaryPathFor(
  sessionId: string,
  projectionDigest: string,
  targetPath: string,
): string {
  const token = sha256(
    `${sessionId}\0${projectionDigest}\0${targetPath}`,
  ).slice(0, 24);
  return normalizeChangedPath(
    path.posix.join(
      path.posix.dirname(targetPath),
      `.${path.posix.basename(targetPath)}.workflow-mechanical-${token}.tmp`,
    ),
  );
}

function quarantinePathFor(
  sessionId: string,
  projectionDigest: string,
  kind: 'target' | 'source',
  ownedPath: string,
): string {
  const token = sha256(
    `${sessionId}\0${projectionDigest}\0${kind}\0${ownedPath}`,
  ).slice(0, 24);
  return normalizeChangedPath(
    path.posix.join(
      path.posix.dirname(ownedPath),
      `.${path.posix.basename(ownedPath)}.workflow-mechanical-${kind}-quarantine-${token}`,
    ),
  );
}

function projectionJournalPath(
  sessionsRoot: string,
  sessionId: string,
): string {
  return path.join(
    sessionsRoot,
    sessionId,
    'mechanical-transform',
    'projection-journal.json',
  );
}

function mechanicalTask(
  inspection: SessionInspection,
): MechanicalTransformExecution | null {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  return task?.strategy === 'mechanical-transform' ? task : null;
}

function modeBits(mode: '100644' | '100755'): number {
  return mode === '100755' ? 0o755 : 0o644;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function projectionInvalid(message: string, details: Record<string, unknown>) {
  return workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_PROJECTION_INVALID',
    message,
    ExitCode.verification,
    { details },
  );
}

function worktreeDrift(relativePath: string) {
  return workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_WORKTREE_DRIFT',
    'A deterministic-transform path contains neither its journal-bound baseline nor target bytes.',
    ExitCode.staleState,
    { details: { path: relativePath } },
  );
}

function journalCorrupt() {
  return workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_JOURNAL_CORRUPT',
    'The durable deterministic-transform journal is malformed or digest-invalid.',
    ExitCode.guard,
  );
}
