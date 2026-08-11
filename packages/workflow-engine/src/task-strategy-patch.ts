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
import { runSessionOperation } from './lifecycle-context.ts';
import {
  investigationRuntimePaths,
  matchesAllowedPath,
  normalizeChangedPath,
} from './paths.ts';
import { readTaskStrategyTransaction } from './task-strategy-store.ts';
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
  type TaskStrategyPatchImportReceipt,
  type TaskStrategyPatchRecord,
  type TaskStrategyPatchReservation,
} from './task-strategy-patch-store.ts';
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
  changes: readonly TaskStrategyPatchChange[];
  implementer: ResolvedActor;
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

export function validateTaskStrategyPatch(
  cwd: string,
  requestedSessionId: string,
  input: Readonly<{
    patch: string | Buffer;
    explicitActor?: string;
    environment?: NodeJS.ProcessEnv;
  }>,
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
    testCrashAfter?:
      'reservation-persisted' | 'record-persisted' | 'patch-applied';
  }>,
): ImportedTaskStrategyPatch {
  return runSessionOperation(cwd, requestedSessionId, () =>
    importTaskStrategyPatchUnlocked(cwd, requestedSessionId, input),
  );
}

function importTaskStrategyPatchUnlocked(
  cwd: string,
  requestedSessionId: string,
  input: Readonly<{
    patch: string | Buffer;
    explicitActor?: string;
    environment?: NodeJS.ProcessEnv;
    testCrashAfter?:
      'reservation-persisted' | 'record-persisted' | 'patch-applied';
  }>,
): ImportedTaskStrategyPatch {
  const patchBytes = normalizePatchBytes(input.patch);
  const patchDigest = sha256(patchBytes);
  let inspection = inspectSession(cwd, requestedSessionId);
  const task = executionTask(inspection);
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const implementer = resolveImplementer(
    task,
    readTaskStrategyTransaction(runtime, inspection.session.sessionId),
    input,
  );
  let reservation = readTaskStrategyPatchReservation(
    runtime,
    inspection.session.sessionId,
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
  );
  if (record === null) {
    const validation = validateTaskStrategyPatch(
      cwd,
      requestedSessionId,
      input,
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
      implementer,
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
    assertPatchRecordCurrent(record, inspection, task, implementer, patchBytes);
    assertPatchStateRelations(record, reservation, null, null);
  }
  assertPatchStateRelations(record, reservation, null, null);

  let receipt = readTaskStrategyPatchImportReceipt(
    runtime,
    inspection.session.sessionId,
    patchDigest,
  );
  let binding = readTaskStrategyPatchCurrentBinding(
    runtime,
    inspection.session.sessionId,
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
  receipt ??= createTaskStrategyPatchImportReceipt(runtime, {
    recordDigest: record.recordDigest,
    sessionId: record.sessionId,
    patchDigest: record.patchDigest,
    candidateTree: record.candidateTree,
    importedAt,
  });
  binding ??= createTaskStrategyPatchCurrentBinding(runtime, {
    sessionId: record.sessionId,
    patchDigest: record.patchDigest,
    recordDigest: record.recordDigest,
    receiptDigest: receipt.receiptDigest,
    candidateTree: record.candidateTree,
    createdAt: importedAt,
  });
  assertPatchStateRelations(record, reservation, receipt, binding);
  return Object.freeze({ record, reservation, receipt, binding });
}

function applyPatchToWorktree(
  repositoryRoot: string,
  patchBytes: Buffer,
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
        '--binary',
        '--whitespace=error-all',
        '--recount',
        '--',
        patchPath,
      ]);
    } catch {
      throw workflowError(
        'TASK_STRATEGY_PATCH_IMPORT_FAILED',
        'The validated implementation patch could not be applied to the exact RED worktree.',
        ExitCode.staleState,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function resolveImplementer(
  task: CrossAgentTddExecution | TddSingleAgentExecution,
  transaction: ReturnType<typeof readTaskStrategyTransaction>,
  input: Readonly<{
    explicitActor?: string;
    environment?: NodeJS.ProcessEnv;
  }>,
): ResolvedActor {
  if (transaction === null) {
    throw workflowError(
      'TASK_STRATEGY_RED_REQUIRED',
      'Patch import requires the exact current engine-sealed RED transaction.',
      ExitCode.verification,
    );
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
  if (
    task.strategy === 'cross-agent-tdd' &&
    actor.actor.providerId === transaction.author.providerId
  ) {
    throw workflowError(
      'TASK_STRATEGY_IMPLEMENTER_REQUIRED',
      'Cross-agent TDD forbids the RED author from importing the implementation patch.',
      ExitCode.guard,
    );
  }
  return Object.freeze(actor.actor);
}

function assertPatchRecordCurrent(
  record: TaskStrategyPatchRecord,
  inspection: SessionInspection,
  task: CrossAgentTddExecution | TddSingleAgentExecution,
  implementer: ResolvedActor,
  patchBytes: Buffer,
): void {
  if (
    record.sessionId !== inspection.session.sessionId ||
    record.changeId !== inspection.session.changeId ||
    record.taskId !== inspection.session.taskId ||
    record.strategy !== task.strategy ||
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
  requested:
    'reservation-persisted' | 'record-persisted' | 'patch-applied' | undefined,
  phase: 'reservation-persisted' | 'record-persisted' | 'patch-applied',
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
