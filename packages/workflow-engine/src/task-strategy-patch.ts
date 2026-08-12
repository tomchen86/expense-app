import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveActorIdentity } from './actor-identity.ts';
import { canonicalJson } from './canonical-json.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { previewExactStaging } from './git-transitions.ts';
import { runGit, runGitBuffer, runGitWithEnvironment } from './git.ts';
import {
  loadActiveSessionContext,
  runSessionOperation,
} from './lifecycle-context.ts';
import {
  investigationRuntimePaths,
  matchesAllowedPath,
  normalizeChangedPath,
} from './paths.ts';
import {
  readTaskStrategyTransaction,
  type TaskStrategyTransaction,
} from './task-strategy-store.ts';
import {
  createCurrentTaskStrategyCorrectionSubject,
  resolveCurrentTaskStrategyCorrection,
  resolveCurrentTaskStrategyImplementationAuthority,
} from './task-strategy-correction.ts';
import { readTaskStrategyGreenFailureRecord } from './task-strategy-correction-store.ts';
import {
  publishTaskStrategyCorrectionRoundImport,
  publishTaskStrategyCorrectionRoundResult,
  reserveTaskStrategyCorrectionRound,
} from './task-strategy-correction-round-store.ts';
import { DEFAULT_TASK_STRATEGY_CORRECTION_POLICY } from './task-strategy-correction-store.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from './session-store.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readCurrentTaskStrategyImplementationProviderAttempt,
  readTaskStrategyImplementationProviderAttempt,
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
} from './task-strategy-provider-store.ts';
import {
  createTaskStrategyPatchCurrentBinding,
  createTaskStrategyPatchImportReceipt,
  createTaskStrategyPatchReservation,
  persistTaskStrategyPatchRecord,
  prepareTaskStrategyPatchRecord,
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchReservation,
  type TaskStrategyPatchChange,
  type TaskStrategyPatchCurrentBinding,
  type TaskStrategyPatchImplementer,
  type TaskStrategyPatchImportReceipt,
  type TaskStrategyPatchRecord,
  type TaskStrategyPatchReservation,
} from './task-strategy-patch-store.ts';
import { inspectSession, type SessionInspection } from './verification.ts';

const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_PATHS = 1024;

type TaskStrategyPatchCrashPhase =
  | 'reservation-persisted'
  | 'record-persisted'
  | 'patch-applied'
  | 'receipt-persisted';

export type TaskStrategyPatchValidation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-validation.v1';
  sessionId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  sourceTree: string;
  candidateTree: string;
  patchDigest: string;
  changedPaths: readonly string[];
  changes: readonly TaskStrategyPatchChange[];
  implementer: TaskStrategyPatchImplementer;
}>;

export type TaskStrategyPatchState = Readonly<{
  record: TaskStrategyPatchRecord;
  reservation: TaskStrategyPatchReservation;
  receipt: TaskStrategyPatchImportReceipt | null;
  binding: TaskStrategyPatchCurrentBinding | null;
}>;

export type ImportedTaskStrategyPatch = Readonly<{
  record: TaskStrategyPatchRecord;
  reservation: TaskStrategyPatchReservation;
  receipt: TaskStrategyPatchImportReceipt;
  binding: TaskStrategyPatchCurrentBinding;
}>;

type CallerTaskStrategyPatchInput = Readonly<{
  patch: string | Buffer;
  explicitActor?: string;
  environment?: NodeJS.ProcessEnv;
}>;

type ProviderTaskStrategyPatchValidationInput = Readonly<{
  patch: string | Buffer;
  implementationReservationDigest: string;
  implementationSubjectDigest?: string;
}>;

type ProviderTaskStrategyPatchImportInput = Readonly<{
  patch: string | Buffer;
  implementationResultBindingDigest: string;
  implementationSubjectDigest?: string;
  testCrashAfter?: TaskStrategyPatchCrashPhase;
}>;

type CallerTaskStrategyPatchValidationInput = Readonly<{
  patch: string | Buffer;
  callerImplementer: Extract<
    TaskStrategyPatchImplementer,
    { providerId: null }
  >;
  implementationSubjectDigest: string;
}>;

type CallerTaskStrategyPatchImportInput = Readonly<{
  patch: string | Buffer;
  callerImplementationBindingDigest: string;
  implementationSubjectDigest: string;
  testCrashAfter?: TaskStrategyPatchCrashPhase;
}>;

type SealedLocalPatchAuthority = Readonly<{
  kind: 'sealed-local';
  implementer: Exclude<TaskStrategyPatchImplementer, { providerId: null }>;
  sourceTree: string;
}>;

export function validateTaskStrategyPatch(
  cwd: string,
  requestedSessionId: string,
  input: CallerTaskStrategyPatchInput,
): TaskStrategyPatchValidation {
  return validateTaskStrategyPatchWithAuthority(cwd, requestedSessionId, input);
}

export function validateTaskStrategyProviderPatch(
  cwd: string,
  requestedSessionId: string,
  input: ProviderTaskStrategyPatchValidationInput,
): TaskStrategyPatchValidation {
  return validateTaskStrategyPatchWithAuthority(cwd, requestedSessionId, input);
}

export function validateTaskStrategyCallerPatch(
  cwd: string,
  requestedSessionId: string,
  input: CallerTaskStrategyPatchValidationInput,
): TaskStrategyPatchValidation {
  return validateTaskStrategyPatchWithAuthority(cwd, requestedSessionId, input);
}

function validateTaskStrategyPatchWithAuthority(
  cwd: string,
  requestedSessionId: string,
  input:
    | CallerTaskStrategyPatchInput
    | ProviderTaskStrategyPatchValidationInput
    | ProviderTaskStrategyPatchImportInput
    | CallerTaskStrategyPatchValidationInput
    | CallerTaskStrategyPatchImportInput,
  sealedLocalAuthority?: SealedLocalPatchAuthority,
): TaskStrategyPatchValidation {
  const patchBytes = normalizePatchBytes(input.patch);
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
  const authority = resolvePatchImplementer(
    inspection,
    transaction,
    input,
    sha256(patchBytes),
    sealedLocalAuthority,
  );
  if (
    task.strategy === 'cross-agent-tdd' &&
    authority.implementer.providerId === transaction.author.providerId &&
    !authority.allowsSameProvider
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
  if (
    task.strategy === 'tdd-single-agent' &&
    canonicalJson(authority.implementer) !== canonicalJson(transaction.author)
  ) {
    throw workflowError(
      'TASK_STRATEGY_IMPLEMENTER_REQUIRED',
      'Single-agent TDD binds implementation authority to the sealed RED author.',
      ExitCode.guard,
    );
  }

  const projection = applyPatchToIsolatedTree(
    inspection.git.repositoryRoot,
    authority.sourceTree,
    patchBytes,
  );
  const current = previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  );
  if (
    current.tree !== authority.sourceTree &&
    (sealedLocalAuthority === undefined ||
      current.tree !== projection.candidateTree)
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_STALE',
      'The task worktree changed after RED sealing and before isolated patch validation.',
      ExitCode.staleState,
    );
  }
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
      authority.sourceTree,
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
    sourceTree: authority.sourceTree,
    candidateTree: projection.candidateTree,
    patchDigest: sha256(patchBytes),
    changedPaths: Object.freeze(projection.changedPaths),
    changes: Object.freeze(changes),
    implementer: Object.freeze(authority.implementer),
  });
}

export function inspectTaskStrategyPatchState(
  cwd: string,
  requestedSessionId: string,
  requestedPatchDigest: string,
): TaskStrategyPatchState {
  const inspection = inspectSession(cwd, requestedSessionId);
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const record = readTaskStrategyPatchRecord(
    runtime,
    inspection.session.sessionId,
    requestedPatchDigest,
  );
  if (record === null) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_NOT_FOUND',
      'No durable task strategy patch record exists for that digest.',
      ExitCode.staleState,
    );
  }
  const receipt = readTaskStrategyPatchImportReceipt(
    runtime,
    inspection.session.sessionId,
    requestedPatchDigest,
  );
  const binding = readTaskStrategyPatchCurrentBinding(
    runtime,
    inspection.session.sessionId,
  );
  const reservation = readTaskStrategyPatchReservation(
    runtime,
    inspection.session.sessionId,
  );
  if (reservation === null) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_STATE_CORRUPT',
      'A durable patch record exists without its exact reservation.',
      ExitCode.staleState,
    );
  }
  assertPatchStateRelations(record, reservation, receipt, binding);
  return Object.freeze({ record, reservation, receipt, binding });
}

export function importTaskStrategyPatch(
  cwd: string,
  requestedSessionId: string,
  input: Readonly<{
    patch: string | Buffer;
    explicitActor?: string;
    environment?: NodeJS.ProcessEnv;
    testCrashAfter?: TaskStrategyPatchCrashPhase;
  }>,
): ImportedTaskStrategyPatch {
  return runSessionOperation(cwd, requestedSessionId, () =>
    importTaskStrategyPatchUnlocked(cwd, requestedSessionId, input),
  );
}

/**
 * Bind an already-present single-agent implementation to the same durable
 * patch record/receipt used by provider imports. The sealed RED author is the
 * implementation identity; ambient resume actors cannot replace it.
 */
export function adoptCurrentTaskStrategyImplementation(
  cwd: string,
  requestedSessionId: string,
  options: Readonly<{ testCrashAfter?: TaskStrategyPatchCrashPhase }> = {},
): ImportedTaskStrategyPatch | null {
  const initial = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
    withSessionOperation(initial.runtime, requestedSessionId, () => {
      assertOwned();
      const inspection = inspectSession(cwd, requestedSessionId);
      const task = executionTask(inspection);
      const runtime = investigationRuntimePaths(
        inspection.git.gitCommonDirectory,
        inspection.contract.config.runtimeDirectory,
      );
      const transaction = readTaskStrategyTransaction(
        runtime,
        inspection.session.sessionId,
      );
      if (
        task.strategy !== 'tdd-single-agent' ||
        transaction === null ||
        transaction.strategy !== 'tdd-single-agent'
      ) {
        throw workflowError(
          'TASK_STRATEGY_LOCAL_ADOPTION_NOT_APPLICABLE',
          'Only an exact engine-sealed single-agent TDD transaction can adopt local implementation bytes.',
          ExitCode.guard,
        );
      }
      const current = previewExactStaging(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        [...inspection.changedPaths],
      );
      if (current.tree === transaction.red.candidateTree) return null;
      const patch = runGitBuffer(inspection.git.repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        '--no-renames',
        '--diff-algorithm=myers',
        transaction.red.candidateTree,
        current.tree,
        '--',
      ]);
      const imported = importTaskStrategyPatchUnlocked(
        cwd,
        requestedSessionId,
        {
          patch,
          ...(options.testCrashAfter === undefined
            ? {}
            : { testCrashAfter: options.testCrashAfter }),
        },
        {
          kind: 'sealed-local',
          implementer: Object.freeze(structuredClone(transaction.author)),
          sourceTree: transaction.red.candidateTree,
        },
      );
      assertOwned();
      return imported;
    }),
  );
}

/**
 * Bind a local single-agent correction already present in the worktree. The
 * preceding failed candidate is the new immutable patch source; prior patch
 * records remain append-only provenance and are never replaced.
 */
export function adoptCurrentTaskStrategyCorrection(
  cwd: string,
  requestedSessionId: string,
  options: Readonly<{ testCrashAfter?: TaskStrategyPatchCrashPhase }> = {},
): ImportedTaskStrategyPatch | null {
  const initial = loadActiveSessionContext(cwd, requestedSessionId);
  return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
    withSessionOperation(initial.runtime, requestedSessionId, () => {
      assertOwned();
      const inspection = inspectSession(cwd, requestedSessionId);
      const runtime = investigationRuntimePaths(
        inspection.git.gitCommonDirectory,
        inspection.contract.config.runtimeDirectory,
      );
      const task = executionTask(inspection);
      const projection = resolveCurrentTaskStrategyCorrection(inspection);
      const transaction = projection.transaction;
      const failure = projection.failure;
      if (
        task.strategy !== 'tdd-single-agent' ||
        transaction.strategy !== 'tdd-single-agent' ||
        failure === null ||
        projection.exhausted
      ) {
        throw workflowError(
          'TASK_STRATEGY_CORRECTION_NOT_APPLICABLE',
          'Only a current bounded single-agent GREEN failure can adopt local correction bytes.',
          ExitCode.guard,
        );
      }
      const correctionState = projection.correctionState;
      if (
        correctionState === null ||
        correctionState.state !== 'correction-required'
      ) {
        throw workflowError(
          'TASK_STRATEGY_CORRECTION_NOT_APPLICABLE',
          'The current GREEN failure has no resumable correction-round authority.',
          ExitCode.guard,
        );
      }
      const current = previewExactStaging(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        [...inspection.changedPaths],
      );
      if (current.tree === failure.candidateTree) return null;
      const patch = runGitBuffer(inspection.git.repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        '--no-renames',
        '--diff-algorithm=myers',
        failure.candidateTree,
        current.tree,
        '--',
      ]);
      const correctionSubject = createCurrentTaskStrategyCorrectionSubject(
        transaction,
        failure,
        correctionState.round,
      );
      const reservationAuthority = Object.freeze({
        kind: 'sealed-local' as const,
        author: Object.freeze(structuredClone(transaction.author)),
      });
      reserveTaskStrategyCorrectionRound(runtime, {
        sessionId: inspection.session.sessionId,
        round: correctionState.round,
        policy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
        predecessorFailure: failure,
        correctionSubjectDigest: correctionSubject.subjectDigest,
        redSourceTree: transaction.red.candidateTree,
        authority: reservationAuthority,
        createdAt: new Date().toISOString(),
      });
      const imported = importTaskStrategyPatchUnlocked(
        cwd,
        requestedSessionId,
        {
          patch,
          ...(options.testCrashAfter === undefined
            ? {}
            : { testCrashAfter: options.testCrashAfter }),
        },
        {
          kind: 'sealed-local',
          implementer: Object.freeze(structuredClone(transaction.author)),
          sourceTree: failure.candidateTree,
        },
      );
      const resultAuthority = Object.freeze({
        kind: 'sealed-local' as const,
        author: Object.freeze(structuredClone(transaction.author)),
      });
      publishTaskStrategyCorrectionRoundResult(runtime, {
        sessionId: inspection.session.sessionId,
        currentRedTransactionDigest: transaction.recordDigest,
        round: correctionState.round,
        correctionSubjectDigest: correctionSubject.subjectDigest,
        authority: resultAuthority,
        patchResult: {
          sourceTree: imported.record.sourceTree,
          targetCandidateTree: imported.record.candidateTree,
          patchRecordDigest: imported.record.recordDigest,
          patchDigest: imported.record.patchDigest,
        },
        createdAt: imported.receipt.importedAt,
      });
      publishTaskStrategyCorrectionRoundImport(runtime, {
        sessionId: inspection.session.sessionId,
        currentRedTransactionDigest: transaction.recordDigest,
        round: correctionState.round,
        correctionSubjectDigest: correctionSubject.subjectDigest,
        authority: resultAuthority,
        importReceipt: {
          patchRecordDigest: imported.record.recordDigest,
          patchDigest: imported.record.patchDigest,
          receiptDigest: imported.receipt.receiptDigest,
          candidateTree: imported.record.candidateTree,
        },
        currentPatchHead: {
          bindingDigest: imported.binding.bindingDigest,
          recordDigest: imported.record.recordDigest,
          patchDigest: imported.record.patchDigest,
          receiptDigest: imported.receipt.receiptDigest,
        },
        importedAt: imported.receipt.importedAt,
      });
      assertOwned();
      return imported;
    }),
  );
}

/**
 * Restore only the exact implementation delta of the current RED lineage.
 * This is the mutation step used by RED revision while the repository and
 * session lifecycle locks are already held. Durable patch records remain
 * immutable provenance; replay accepts only the exact candidate or source
 * tree and never overwrites ambient bytes.
 */
export function restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock(
  cwd: string,
  requestedSessionId: string,
  transaction: TaskStrategyTransaction,
  assertOwned: () => void,
): TaskStrategyPatchRecord | null {
  assertOwned();
  let inspection = inspectSession(cwd, requestedSessionId);
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const currentTree = () =>
    previewExactStaging(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    ).tree;
  const projection = resolveCurrentTaskStrategyCorrection(inspection);
  if (projection.transaction.recordDigest !== transaction.recordDigest) {
    throw patchStale();
  }
  const records: TaskStrategyPatchRecord[] = [];
  let sourceTree = transaction.red.candidateTree;
  while (true) {
    const binding = readTaskStrategyPatchCurrentBinding(
      runtime,
      inspection.session.sessionId,
      sourceTree,
    );
    if (binding === null) break;
    const record = readTaskStrategyPatchRecord(
      runtime,
      inspection.session.sessionId,
      binding.patchDigest,
      sourceTree,
    );
    const reservation = readTaskStrategyPatchReservation(
      runtime,
      inspection.session.sessionId,
      sourceTree,
    );
    const receipt = readTaskStrategyPatchImportReceipt(
      runtime,
      inspection.session.sessionId,
      binding.patchDigest,
      sourceTree,
    );
    if (
      record === null ||
      reservation === null ||
      receipt === null ||
      record.sourceTree !== sourceTree
    ) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_STATE_CORRUPT',
        'The current implementation lineage has no exact patch authority.',
        ExitCode.staleState,
      );
    }
    assertPatchStateRelations(record, reservation, receipt, binding);
    records.push(record);
    sourceTree = record.candidateTree;
    if (projection.head?.record.recordDigest === record.recordDigest) break;
    if (records.length > 64) throw patchStale();
  }
  if (records.length === 0) {
    if (currentTree() !== transaction.red.candidateTree) throw patchStale();
    return null;
  }
  if (records.at(-1)?.recordDigest !== projection.head?.record.recordDigest) {
    throw patchStale();
  }
  for (const record of [...records].reverse()) {
    const observedTree = currentTree();
    const changedEntries = record.changes.map((change) => ({
      change,
      observed: readRegularTreeEntry(
        inspection.git.repositoryRoot,
        observedTree,
        change.path,
      ),
    }));
    const alreadyRestored = changedEntries.every(
      ({ change, observed }) =>
        canonicalJson(observed) === canonicalJson(change.before),
    );
    if (!alreadyRestored) {
      if (
        changedEntries.some(
          ({ change, observed }) =>
            canonicalJson(observed) !== canonicalJson(change.after),
        )
      ) {
        throw patchStale();
      }
      applyPatchToWorktree(
        inspection.git.repositoryRoot,
        Buffer.from(record.patchBase64, 'base64'),
        true,
      );
      assertOwned();
      inspection = inspectSession(cwd, requestedSessionId, {
        expectedSession: inspection.session,
      });
    }
    if (currentTree() !== record.sourceTree) throw patchStale();
  }
  return records[0]!;
}

export function importTaskStrategyProviderPatch(
  cwd: string,
  requestedSessionId: string,
  input: ProviderTaskStrategyPatchImportInput,
): ImportedTaskStrategyPatch {
  return runSessionOperation(cwd, requestedSessionId, () =>
    importTaskStrategyPatchUnlocked(cwd, requestedSessionId, input),
  );
}

export function importTaskStrategyProviderPatchUnderLifecycleLock(
  cwd: string,
  requestedSessionId: string,
  input: ProviderTaskStrategyPatchImportInput,
  assertOwned: () => void,
): ImportedTaskStrategyPatch {
  assertOwned();
  const imported = importTaskStrategyPatchUnlocked(
    cwd,
    requestedSessionId,
    input,
  );
  assertOwned();
  return imported;
}

export function importTaskStrategyCallerPatchUnderLifecycleLock(
  cwd: string,
  requestedSessionId: string,
  input: CallerTaskStrategyPatchImportInput,
  assertOwned: () => void,
): ImportedTaskStrategyPatch {
  assertOwned();
  const imported = importTaskStrategyPatchUnlocked(
    cwd,
    requestedSessionId,
    input,
  );
  assertOwned();
  return imported;
}

function importTaskStrategyPatchUnlocked(
  cwd: string,
  requestedSessionId: string,
  input: Readonly<{
    patch: string | Buffer;
    explicitActor?: string;
    environment?: NodeJS.ProcessEnv;
    implementationResultBindingDigest?: string;
    implementationSubjectDigest?: string;
    callerImplementationBindingDigest?: string;
    testCrashAfter?: TaskStrategyPatchCrashPhase;
  }>,
  sealedLocalAuthority?: SealedLocalPatchAuthority,
): ImportedTaskStrategyPatch {
  const patchBytes = normalizePatchBytes(input.patch);
  const patchDigest = sha256(patchBytes);
  let inspection = inspectSession(cwd, requestedSessionId);
  const task = executionTask(inspection);
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const transaction = readTaskStrategyTransaction(
    runtime,
    inspection.session.sessionId,
  );
  const implementer = resolvePatchImplementer(
    inspection,
    transaction,
    input,
    patchDigest,
    sealedLocalAuthority,
  );
  let reservation = readTaskStrategyPatchReservation(
    runtime,
    inspection.session.sessionId,
    implementer.sourceTree,
  );
  if (reservation !== null && reservation.patchDigest !== patchDigest) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_RESERVATION_CONFLICT',
      'Another exact implementation patch is already prepared for this session.',
      ExitCode.conflict,
      { details: { reservedPatchDigest: reservation.patchDigest } },
    );
  }
  let record = readTaskStrategyPatchRecord(
    runtime,
    inspection.session.sessionId,
    patchDigest,
    implementer.sourceTree,
  );
  if (record === null) {
    const validation = validateTaskStrategyPatchWithAuthority(
      cwd,
      requestedSessionId,
      input,
      sealedLocalAuthority,
    );
    const preparedRecord = prepareTaskStrategyPatchRecord({
      sessionId: inspection.session.sessionId,
      changeId: inspection.session.changeId,
      taskId: inspection.session.taskId,
      strategy: validation.strategy,
      sourceTree: validation.sourceTree,
      candidateTree: validation.candidateTree,
      taskContractDigest: sha256(canonicalJson(task)),
      patchDigest,
      patchBase64: patchBytes.toString('base64'),
      changedPaths: [...validation.changedPaths],
      changes: [...validation.changes],
      implementer: implementer.implementer,
      createdAt: reservation?.createdAt ?? new Date().toISOString(),
    });
    if (reservation === null) {
      reservation = createTaskStrategyPatchReservation(runtime, {
        sessionId: preparedRecord.sessionId,
        patchDigest: preparedRecord.patchDigest,
        recordDigest: preparedRecord.recordDigest,
        sourceTree: preparedRecord.sourceTree,
        candidateTree: preparedRecord.candidateTree,
        createdAt: preparedRecord.createdAt,
      });
      assertPatchStateRelations(preparedRecord, reservation, null, null);
      maybeInterrupt(input.testCrashAfter, 'reservation-persisted');
    } else {
      assertPatchStateRelations(preparedRecord, reservation, null, null);
    }
    record = persistTaskStrategyPatchRecord(runtime, preparedRecord);
    maybeInterrupt(input.testCrashAfter, 'record-persisted');
  } else {
    if (reservation === null) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_STATE_CORRUPT',
        'A durable patch record exists without its preceding reservation.',
        ExitCode.staleState,
      );
    }
    if (transaction === null) throw patchStale();
    assertPatchRecordCurrent(
      record,
      inspection,
      task,
      transaction,
      implementer.implementer,
      patchBytes,
      implementer.sourceTree,
    );
    assertPatchStateRelations(record, reservation, null, null);
  }
  assertPatchStateRelations(record, reservation, null, null);

  let receipt = readTaskStrategyPatchImportReceipt(
    runtime,
    inspection.session.sessionId,
    patchDigest,
    record.sourceTree,
  );
  let binding = readTaskStrategyPatchCurrentBinding(
    runtime,
    inspection.session.sessionId,
    record.sourceTree,
  );
  assertPatchStateRelations(record, reservation, receipt, binding);
  let currentTree = previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  ).tree;
  if (receipt !== null && binding !== null) {
    if (currentTree !== record.candidateTree) throw patchStale();
    return Object.freeze({ record, reservation, receipt, binding });
  }
  if (currentTree === record.sourceTree) {
    if (sealedLocalAuthority !== undefined) throw patchStale();
    applyPatchToWorktree(
      inspection.git.repositoryRoot,
      Buffer.from(record.patchBase64, 'base64'),
    );
    inspection = inspectSession(cwd, requestedSessionId, {
      expectedSession: inspection.session,
    });
    currentTree = previewExactStaging(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    ).tree;
    if (currentTree !== record.candidateTree) throw patchStale();
    maybeInterrupt(input.testCrashAfter, 'patch-applied');
  } else if (currentTree !== record.candidateTree) {
    throw patchStale();
  }
  const importedAt = receipt?.importedAt ?? new Date().toISOString();
  if (receipt === null) {
    receipt = createTaskStrategyPatchImportReceipt(
      runtime,
      {
        recordDigest: record.recordDigest,
        sessionId: record.sessionId,
        patchDigest: record.patchDigest,
        candidateTree: record.candidateTree,
        importedAt,
      },
      record.sourceTree,
    );
    maybeInterrupt(input.testCrashAfter, 'receipt-persisted');
  }
  binding ??= createTaskStrategyPatchCurrentBinding(
    runtime,
    {
      sessionId: record.sessionId,
      patchDigest: record.patchDigest,
      recordDigest: record.recordDigest,
      receiptDigest: receipt.receiptDigest,
      candidateTree: record.candidateTree,
      createdAt: importedAt,
    },
    record.sourceTree,
  );
  assertPatchStateRelations(record, reservation, receipt, binding);
  return Object.freeze({ record, reservation, receipt, binding });
}

function applyPatchToWorktree(
  repositoryRoot: string,
  patchBytes: Buffer,
  reverse = false,
): void {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-task-patch-import-'),
  );
  const patchPath = path.join(temporaryDirectory, 'candidate.patch');
  try {
    fs.writeFileSync(patchPath, patchBytes, { flag: 'wx', mode: 0o600 });
    try {
      runGit(repositoryRoot, [
        'apply',
        ...(reverse ? ['--reverse'] : []),
        '--binary',
        '--whitespace=error-all',
        '--recount',
        '--',
        patchPath,
      ]);
    } catch {
      throw workflowError(
        'TASK_STRATEGY_PATCH_IMPORT_FAILED',
        reverse
          ? 'The exact current implementation patch could not be restored to its sealed RED source tree.'
          : 'The validated implementation patch could not be applied to the exact RED worktree.',
        ExitCode.staleState,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function resolvePatchImplementer(
  inspection: SessionInspection,
  transaction: ReturnType<typeof readTaskStrategyTransaction>,
  input:
    | CallerTaskStrategyPatchInput
    | ProviderTaskStrategyPatchValidationInput
    | ProviderTaskStrategyPatchImportInput
    | CallerTaskStrategyPatchValidationInput
    | CallerTaskStrategyPatchImportInput,
  patchDigest: string,
  sealedLocalAuthority?: SealedLocalPatchAuthority,
): Readonly<{
  implementer: TaskStrategyPatchImplementer;
  allowsSameProvider: boolean;
  sourceTree: string;
}> {
  if (transaction === null) {
    throw workflowError(
      'TASK_STRATEGY_RED_REQUIRED',
      'Patch import requires the exact current engine-sealed RED transaction.',
      ExitCode.verification,
    );
  }
  if (sealedLocalAuthority !== undefined) {
    if (
      transaction.strategy !== 'tdd-single-agent' ||
      canonicalJson(sealedLocalAuthority.implementer) !==
        canonicalJson(transaction.author)
    ) {
      throw patchAuthorityStale();
    }
    return Object.freeze({
      implementer: sealedLocalAuthority.implementer,
      allowsSameProvider: true,
      sourceTree: sealedLocalAuthority.sourceTree,
    });
  }
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  if ('callerImplementer' in input) {
    const subject = resolveCallerImplementationSubject(
      inspection,
      transaction,
      input.implementationSubjectDigest,
    );
    if (subject.subjectDigest !== input.implementationSubjectDigest) {
      throw patchAuthorityStale();
    }
    return Object.freeze({
      implementer: Object.freeze(structuredClone(input.callerImplementer)),
      allowsSameProvider: true,
      sourceTree: subject.sourceTree,
    });
  }
  if ('implementationReservationDigest' in input) {
    const reservation = readTaskStrategyImplementationReservation(
      runtime,
      inspection.session.sessionId,
      input.implementationSubjectDigest,
    );
    const attempt =
      reservation === null
        ? null
        : readCurrentTaskStrategyImplementationProviderAttempt(
            runtime,
            reservation,
          );
    if (
      reservation === null ||
      attempt === null ||
      reservation.recordDigest !== input.implementationReservationDigest ||
      reservation.subject.transactionDigest !== transaction.recordDigest ||
      !implementationSubjectSourceCurrent(
        inspection,
        transaction,
        reservation.subject,
      ) ||
      attempt.assignment.providerId === null ||
      attempt.assignment.sessionId === null
    ) {
      throw patchAuthorityStale();
    }
    return Object.freeze({
      implementer: Object.freeze({
        providerId: attempt.assignment.providerId,
        assurance: 'adapter-assigned' as const,
      }),
      allowsSameProvider:
        'grantId' in attempt.assignment &&
        attempt.assignment.degradedForm === 'same-provider-fresh-session',
      sourceTree: reservation.subject.sourceTree,
    });
  }
  if ('implementationResultBindingDigest' in input) {
    const reservation = readTaskStrategyImplementationReservation(
      runtime,
      inspection.session.sessionId,
      input.implementationSubjectDigest,
    );
    const binding = readTaskStrategyImplementationResultBinding(
      runtime,
      inspection.session.sessionId,
      input.implementationSubjectDigest,
    );
    const attempt =
      reservation === null || binding === null
        ? null
        : readTaskStrategyImplementationProviderAttempt(
            runtime,
            reservation,
            binding.invocationId,
          );
    const currentAttempt =
      reservation === null
        ? null
        : readCurrentTaskStrategyImplementationProviderAttempt(
            runtime,
            reservation,
          );
    if (
      binding === null ||
      reservation === null ||
      attempt === null ||
      currentAttempt === null ||
      binding.bindingDigest !== input.implementationResultBindingDigest ||
      reservation.subject.transactionDigest !== transaction.recordDigest ||
      !implementationSubjectSourceCurrent(
        inspection,
        transaction,
        reservation.subject,
      ) ||
      binding.subjectDigest !== reservation.subject.subjectDigest ||
      canonicalJson(binding.roleResult.assignment) !==
        canonicalJson(attempt.assignment) ||
      currentAttempt.request.invocationId !== attempt.request.invocationId ||
      binding.output.sessionId !== inspection.session.sessionId ||
      binding.output.sourceTree !== reservation.subject.sourceTree ||
      binding.output.patchDigest !== patchDigest ||
      binding.roleResult.providerInvocation === null ||
      binding.roleResult.assignment.providerId === null ||
      binding.roleResult.assignment.sessionId === null
    ) {
      throw patchAuthorityStale();
    }
    return Object.freeze({
      implementer: Object.freeze({
        providerId: binding.roleResult.assignment.providerId,
        assurance: 'adapter-assigned' as const,
      }),
      allowsSameProvider:
        binding.roleResult.form === 'granted-same-provider' &&
        binding.roleResult.grantUse?.degradedForm ===
          'same-provider-fresh-session',
      sourceTree: reservation.subject.sourceTree,
    });
  }
  if ('callerImplementationBindingDigest' in input) {
    const binding = readTaskStrategyCallerImplementationBinding(
      runtime,
      inspection.session.sessionId,
      input.implementationSubjectDigest,
    );
    const reservation = readTaskStrategyCallerImplementationReservation(
      runtime,
      inspection.session.sessionId,
      input.implementationSubjectDigest,
    );
    const participant = binding?.roleResult.participant;
    const assignment = binding?.roleResult.assignment;
    if (
      binding === null ||
      reservation === null ||
      binding.bindingDigest !== input.callerImplementationBindingDigest ||
      binding.subjectDigest !== reservation.subjectDigest ||
      reservation.subjectDigest !== input.implementationSubjectDigest ||
      resolveCallerImplementationSubject(
        inspection,
        transaction,
        input.implementationSubjectDigest,
      ).subjectDigest !== reservation.subjectDigest ||
      binding.output.sessionId !== inspection.session.sessionId ||
      binding.output.sourceTree !== reservation.output.sourceTree ||
      binding.output.patchDigest !== patchDigest ||
      binding.roleResult.form !== 'granted-caller-supplied' ||
      participant === undefined ||
      participant.providerId !== null ||
      participant.principalId === null ||
      participant.identityAssurance === 'maintainer-signed' ||
      assignment === undefined ||
      !('grantId' in assignment) ||
      assignment.degradedForm !== 'caller-supplied'
    ) {
      throw patchAuthorityStale();
    }
    return Object.freeze({
      implementer: Object.freeze({
        providerId: null,
        principalId: participant.principalId,
        assurance: participant.identityAssurance,
        degradedForm: 'caller-supplied' as const,
        grantId: assignment.grantId,
      }),
      allowsSameProvider: true,
      sourceTree: reservation.output.sourceTree,
    });
  }
  const actor = resolveActorIdentity({
    ...(input.explicitActor === undefined
      ? {}
      : { explicitActor: input.explicitActor }),
    environment: input.environment ?? process.env,
  });
  if (actor.outcome !== 'resolved') {
    throw workflowError(
      actor.code,
      'Patch import requires one exact implementation actor.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    implementer: Object.freeze(actor.actor),
    allowsSameProvider: false,
    sourceTree: transaction.red.candidateTree,
  });
}

function resolveCallerImplementationSubject(
  inspection: SessionInspection,
  transaction: TaskStrategyTransaction,
  expectedSubjectDigest: string,
) {
  const authority = resolveCurrentTaskStrategyImplementationAuthority(
    inspection,
    resolveCurrentTaskStrategyCorrection(inspection),
  );
  if (
    authority.subject.transactionDigest !== transaction.recordDigest ||
    authority.subject.subjectDigest !== expectedSubjectDigest
  ) {
    throw patchAuthorityStale();
  }
  return authority.subject;
}

function implementationSubjectSourceCurrent(
  inspection: SessionInspection,
  transaction: TaskStrategyTransaction,
  subject: NonNullable<
    ReturnType<typeof readTaskStrategyImplementationReservation>
  >['subject'],
): boolean {
  if (subject.correction === undefined) {
    return subject.sourceTree === transaction.red.candidateTree;
  }
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const projection = resolveCurrentTaskStrategyCorrection(inspection);
  const expectedRound = subject.correction.round;
  const failure =
    projection.failure !== null &&
    projection.completedCorrectionRounds + 1 === expectedRound
      ? projection.failure
      : projection.head !== null &&
          projection.completedCorrectionRounds === expectedRound &&
          projection.head.record.sourceTree === subject.sourceTree
        ? readTaskStrategyGreenFailureRecord(
            runtime,
            inspection.session.sessionId,
            subject.sourceTree,
          )
        : null;
  return (
    failure !== null &&
    subject.sourceTree === failure.candidateTree &&
    subject.correction.greenFailureRecordDigest === failure.recordDigest &&
    subject.correction.greenFailureSubjectDigest === failure.subjectDigest &&
    subject.correction.candidateTree === failure.candidateTree &&
    subject.correction.failingCheckFingerprint ===
      failure.failingCheck.failureFingerprint &&
    canonicalJson(subject.correction.currentPatchHead) ===
      canonicalJson(failure.currentPatchHead)
  );
}

function patchAuthorityStale() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
    'The implementation patch does not match its exact current provider result authority.',
    ExitCode.staleState,
  );
}

function assertPatchRecordCurrent(
  record: TaskStrategyPatchRecord,
  inspection: SessionInspection,
  task: CrossAgentTddExecution | TddSingleAgentExecution,
  transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  implementer: TaskStrategyPatchImplementer,
  patchBytes: Buffer,
  expectedSourceTree: string,
): void {
  if (
    record.sessionId !== inspection.session.sessionId ||
    record.changeId !== inspection.session.changeId ||
    record.taskId !== inspection.session.taskId ||
    record.strategy !== task.strategy ||
    record.sourceTree !== expectedSourceTree ||
    record.candidateTree === record.sourceTree ||
    record.taskContractDigest !== sha256(canonicalJson(task)) ||
    record.patchDigest !== sha256(patchBytes) ||
    record.patchBase64 !== patchBytes.toString('base64') ||
    canonicalJson(record.implementer) !== canonicalJson(implementer)
  ) {
    throw patchStale();
  }
}

function assertPatchStateRelations(
  record: TaskStrategyPatchRecord,
  reservation: TaskStrategyPatchReservation,
  receipt: TaskStrategyPatchImportReceipt | null,
  binding: TaskStrategyPatchCurrentBinding | null,
): void {
  if (
    reservation.sessionId !== record.sessionId ||
    reservation.patchDigest !== record.patchDigest ||
    reservation.recordDigest !== record.recordDigest ||
    reservation.sourceTree !== record.sourceTree ||
    reservation.candidateTree !== record.candidateTree ||
    reservation.createdAt !== record.createdAt ||
    (receipt !== null &&
      (receipt.recordDigest !== record.recordDigest ||
        receipt.sessionId !== record.sessionId ||
        receipt.patchDigest !== record.patchDigest ||
        receipt.candidateTree !== record.candidateTree)) ||
    (binding !== null &&
      (receipt === null ||
        binding.sessionId !== record.sessionId ||
        binding.patchDigest !== record.patchDigest ||
        binding.recordDigest !== record.recordDigest ||
        binding.receiptDigest !== receipt.receiptDigest ||
        binding.candidateTree !== record.candidateTree ||
        binding.createdAt !== receipt.importedAt))
  ) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_STATE_CORRUPT',
      'Task strategy patch reservation, record, receipt, and current binding disagree.',
      ExitCode.staleState,
    );
  }
}

function maybeInterrupt(
  requested: TaskStrategyPatchCrashPhase | undefined,
  phase: TaskStrategyPatchCrashPhase,
): void {
  if (requested === phase) {
    throw new SimulatedTaskStrategyPatchInterruption(phase);
  }
}

class SimulatedTaskStrategyPatchInterruption extends Error {
  constructor(phase: string) {
    super(`Simulated task strategy patch interruption after ${phase}.`);
  }
}

function patchStale() {
  return workflowError(
    'TASK_STRATEGY_PATCH_STALE',
    'The durable implementation patch no longer matches the exact session, actor, or task candidate tree.',
    ExitCode.staleState,
  );
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

function normalizePatchBytes(value: string | Buffer): Buffer {
  const patchBytes = typeof value === 'string' ? Buffer.from(value) : value;
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
  return patchBytes;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
