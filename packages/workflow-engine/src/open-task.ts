import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { readFileAtCommit } from './ci-git.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { engineProjectionPathsForTransition } from './engine-projection-registry.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import {
  commitChangedPaths,
  commitFacts,
  rollbackExactStaging,
  stageExactPaths,
  updateManagedRef,
} from './git-transitions.ts';
import { discoverRepository, runGit } from './git.ts';
import { validateHandoffForChange } from './handoff.ts';
import {
  refreshPlanningDocuments,
  rollbackGeneratedDocuments,
  type GeneratedDocumentMutation,
} from './managed-documents.ts';
import { assertChangeId, assertTaskId, normalizeChangedPath } from './paths.ts';
import {
  commitPlanningTransitionUnderAuthority,
  type PlanningTransitionResult,
} from './planning-transition.ts';
import {
  reclaimDeadChangeTransitionLock,
  withOpenTaskPlanningAuthority,
} from './planning-lock.ts';
import { readPlanningTransitionReport } from './planning-report.ts';
import { inspectPlanningDraftWorkspace } from './planning-workspace.ts';
import {
  assertOwnedLock,
  createSessionId,
  readSessionFile,
  runtimePaths,
  withRepositoryLifecycleOperation,
  type WorkflowSession,
} from './session-store.ts';
import { startMandatedSessionUnderLifecycleLock } from './session.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  authorizeTaskMandateOperation,
  type TaskMandateBinding,
  type TaskMandateOptions,
} from './task-mandate.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MANDATE_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_JOURNAL_BYTES = 128 * 1024;

export type OpenTaskPhase =
  'prepared' | 'plan-committed' | 'session-active' | 'completed';

export type OpenTaskJournal = Readonly<{
  schemaVersion: 1;
  kind: 'open-task-transaction.v1';
  transactionId: string;
  phase: OpenTaskPhase;
  changeId: string;
  taskId: string;
  mandateTaskId: string;
  mandateBinding: TaskMandateBinding;
  repositoryRoot: string;
  gitCommonDirectory: string;
  worktree: string;
  branch: string;
  parentCommit: string;
  parentTree: string;
  planningCommit: string;
  baselineTree: string;
  reportId: string;
  changedPaths: readonly string[];
  sessionId: string;
  createdAt: string;
  completedAt: string | null;
}>;

export type OpenTaskLifecycleStatus = Readonly<{
  kind: 'open-task-lifecycle-status.v1';
  state: 'opening' | 'active' | 'committed' | 'aborted' | 'recovery-required';
  lastDurablePhase: OpenTaskPhase;
  transactionId: string;
  changeId: string;
  taskId: string;
  mandateTaskId: string;
  sessionId: string;
  parentCommit: string;
  planningCommit: string;
  baselineTree: string;
  reportId: string;
  retrySafe: boolean;
  recoveryCommand: string | null;
  errorCode: string | null;
}>;

export type OpenTaskResult = Readonly<{
  changeId: string;
  taskId: string;
  mandateTaskId: string;
  sessionId: string;
  worktree: string;
  branch: string;
  planningCommit: string;
  baselineTree: string;
  allowedPaths: readonly string[];
  requiredChecks: readonly string[];
  recovered: boolean;
}>;

export type OpenTaskOptions = Readonly<{
  mandate?: TaskMandateOptions;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  testCrashAfter?: 'journal-prepared' | 'plan-committed' | 'session-active';
}>;

/**
 * Commit one reviewed planning draft and activate its exact first task as one
 * recoverable lifecycle transaction. The repository lock remains held while
 * the per-change planning lock is replaced by the active-session lock. Every
 * externally observable phase is therefore either absent or recoverable from
 * the exact durable journal below.
 */
export function openTask(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  requestedMandateTaskId: string,
  options: OpenTaskOptions = {},
): OpenTaskResult {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  const mandateTaskId = assertMandateTaskId(requestedMandateTaskId);
  const initialRepository = discoverRepository(cwd);
  const config = loadWorkflowConfig(initialRepository.repositoryRoot);
  const runtime = runtimePaths(
    initialRepository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const observedBeforeAuthorization = readOpenTaskJournal(
    cwd,
    changeId,
    taskId,
  );
  const authorization =
    observedBeforeAuthorization === null
      ? authorizeTaskMandateOperation(
          cwd,
          mandateTaskId,
          { kind: 'draft-commit' },
          { ...options.mandate, changeId },
        )
      : null;

  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
    assertRepositoryLock();
    const existing = readOpenTaskJournal(cwd, changeId, taskId);
    if (existing !== null) {
      assertRequestedTransaction(existing, {
        changeId,
        taskId,
        mandateTaskId,
        repository: initialRepository,
      });
      return recoverOpenTask(
        cwd,
        runtime,
        existing,
        assertRepositoryLock,
        options,
      );
    }
    if (authorization === null) {
      throw openTaskUnsafe(
        'The open-task journal disappeared after recovery admission.',
      );
    }

    const workspace = inspectPlanningDraftWorkspace(cwd, changeId);
    if (
      workspace === null ||
      workspace.worktreePath !== initialRepository.repositoryRealPath ||
      workspace.gitCommonDirectory !== initialRepository.gitCommonDirectory ||
      workspace.branch !== initialRepository.branch ||
      workspace.baseCommit !== initialRepository.head
    ) {
      throw workflowError(
        'OPEN_TASK_WORKSPACE_OWNERSHIP_MISMATCH',
        'Open-task requires the exact durable planning draft workspace at its pinned base.',
        ExitCode.staleState,
      );
    }
    const binding = assertActiveTaskMandateBindingUnderLifecycleLock(
      cwd,
      authorization.binding,
      assertRepositoryLock,
      options.mandate,
    );
    const createdAt = exactTimestamp(options.now ?? new Date());
    const sessionId = createSessionId();
    let prepared: OpenTaskJournal | null = null;

    const transition = withOpenTaskPlanningAuthority(
      runtime,
      changeId,
      assertRepositoryLock,
      (authority) =>
        commitPlanningTransitionUnderAuthority(
          cwd,
          changeId,
          authority,
          options.environment ?? process.env,
          {
            beforeRefUpdate(context) {
              const current = discoverRepository(cwd);
              prepared = createPreparedJournal({
                changeId,
                taskId,
                mandateTaskId,
                mandateBinding: binding,
                repositoryRoot: current.repositoryRealPath,
                gitCommonDirectory: current.gitCommonDirectory,
                worktree: current.repositoryRealPath,
                branch:
                  current.branch ??
                  (() => {
                    throw openTaskUnsafe(
                      'Planning workspace became detached before journal publication.',
                    );
                  })(),
                parentCommit: context.expectedHead,
                parentTree: current.tree,
                planningCommit: context.commitHash,
                baselineTree: context.tree,
                reportId: context.reportId,
                changedPaths: context.changedPaths,
                sessionId,
                createdAt,
              });
              publishPreparedJournal(runtime, prepared);
              if (options.testCrashAfter === 'journal-prepared') {
                throw simulatedInterruption('journal-prepared');
              }
            },
          },
        ),
    );
    if (prepared === null) {
      throw openTaskUnsafe(
        'Planning transition returned without an exact prepared journal.',
      );
    }
    assertTransitionMatchesJournal(transition, prepared);
    assertCommittedPlanningState(cwd, prepared);
    let durable = advanceJournalPhase(runtime, prepared, 'plan-committed');
    if (options.testCrashAfter === 'plan-committed') {
      throw simulatedInterruption('plan-committed');
    }

    const session = ensureExactSession(
      cwd,
      runtime,
      durable,
      assertRepositoryLock,
    );
    durable = advanceJournalPhase(runtime, durable, 'session-active');
    if (options.testCrashAfter === 'session-active') {
      throw simulatedInterruption('session-active');
    }
    const completed = completeJournal(runtime, durable, options.now);
    return resultFrom(completed, session, false);
  });
}

export function readOpenTaskJournal(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): OpenTaskJournal | null {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const filePath = journalPath(runtime, changeId, taskId);
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    const directory = path.dirname(filePath);
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
      assertPrivateDirectory(directory);
    }
    return null;
  }
  return parseJournal(readPrivateCanonicalFile(filePath));
}

export function findOpenTaskLifecycleStatus(
  cwd: string,
  identifier: string,
): OpenTaskLifecycleStatus | null {
  const matches = listOpenTaskJournals(cwd).filter(
    (journal) =>
      journal.transactionId === identifier ||
      journal.sessionId === identifier ||
      journal.changeId === identifier,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw workflowError(
      'OPEN_TASK_STATUS_AMBIGUOUS',
      'The status identifier matches more than one durable open-task transaction.',
      ExitCode.conflict,
    );
  }
  return inspectOpenTaskJournalStatus(cwd, matches[0]!);
}

export function contextualizeOpenTaskError(
  cwd: string,
  changeId: string,
  taskId: string,
  error: unknown,
): unknown {
  const workflowFailure =
    error instanceof WorkflowError
      ? error
      : workflowError(
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : String(error),
          ExitCode.internal,
        );
  try {
    const journal = readOpenTaskJournal(cwd, changeId, taskId);
    if (journal === null) return error;
    const status = inspectOpenTaskJournalStatus(cwd, journal);
    return workflowError(
      workflowFailure.code,
      workflowFailure.message,
      workflowFailure.exitCode,
      {
        details: {
          ...(workflowFailure.details ?? {}),
          transactionId: journal.transactionId,
          phase: journal.phase,
          sessionId: journal.sessionId,
          planningCommit: journal.planningCommit,
          baselineTree: journal.baselineTree,
        },
        recovery:
          workflowFailure.recovery ??
          status.recoveryCommand ??
          `pnpm workflow status ${journal.transactionId} --json`,
      },
    );
  } catch {
    return error;
  }
}

function listOpenTaskJournals(cwd: string): OpenTaskJournal[] {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const directory = path.join(runtime.root, 'open-task', 'transactions');
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  assertPrivateDirectory(directory);
  const canonicalEntries = fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const journals = canonicalEntries.map((entry) => {
    const journal = parseJournal(
      readPrivateCanonicalFile(path.join(directory, entry)),
    );
    if (
      path.basename(journalPath(runtime, journal.changeId, journal.taskId)) !==
      entry
    ) {
      throw openTaskUnsafe('Open-task journal pathname is not canonical.');
    }
    return journal;
  });
  const expectedEntries = journals
    .map((journal) =>
      path.basename(journalPath(runtime, journal.changeId, journal.taskId)),
    )
    .sort();
  if (
    canonicalJson(fs.readdirSync(directory).sort()) !==
    canonicalJson(expectedEntries)
  ) {
    throw openTaskUnsafe('Open-task journal inventory is not exact.');
  }
  return journals;
}

function inspectOpenTaskJournalStatus(
  cwd: string,
  journal: OpenTaskJournal,
): OpenTaskLifecycleStatus {
  let errorCode: string | null = null;
  let completedSessionState: WorkflowSession['state'] | null = null;
  try {
    assertJournalAuthority(cwd, journal);
    const repository = discoverRepository(cwd);
    const config = loadWorkflowConfig(repository.repositoryRoot);
    const runtime = runtimePaths(
      repository.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const sessionPath = path.join(
      runtime.sessions,
      `${journal.sessionId}.json`,
    );
    const sessionExists =
      fs.lstatSync(sessionPath, { throwIfNoEntry: false }) !== undefined;
    if (journal.phase === 'completed') {
      const session = readSessionFile(sessionPath);
      assertSessionIngressIdentity(session, journal);
      if (session.state === 'active') {
        readAndAssertExactSession(cwd, runtime, journal);
      }
      completedSessionState = session.state;
    } else if (journal.phase === 'prepared') {
      if (repository.head === journal.parentCommit) {
        if (
          repository.tree !== journal.parentTree ||
          repository.branch !== journal.branch
        ) {
          throw openTaskPhaseDiverged(
            'Prepared open-task phase no longer matches its parent state.',
          );
        }
      } else if (repository.head === journal.planningCommit) {
        assertCommittedPlanningState(cwd, journal);
        if (sessionExists) readAndAssertExactSession(cwd, runtime, journal);
      } else {
        throw workflowError(
          'OPEN_TASK_HEAD_DIVERGED',
          'Open-task status found neither its exact parent nor its exact planning commit.',
          ExitCode.staleState,
        );
      }
    } else {
      if (repository.head !== journal.planningCommit) {
        throw openTaskPhaseDiverged(
          'Durable open-task phase is ahead of its observable planning commit.',
        );
      }
      assertCommittedPlanningState(cwd, journal);
      if (journal.phase === 'plan-committed') {
        if (sessionExists) readAndAssertExactSession(cwd, runtime, journal);
      } else {
        if (!sessionExists) {
          throw openTaskPhaseDiverged(
            'Durable open-task phase is ahead of its observable task session.',
          );
        }
        readAndAssertExactSession(cwd, runtime, journal);
      }
    }
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    errorCode = error.code;
  }
  const retrySafe =
    errorCode === null &&
    (journal.phase !== 'completed' || completedSessionState === 'active');
  const recoveryCommand =
    journal.phase === 'completed' || errorCode !== null
      ? null
      : exactOpenTaskRetryCommand(journal);
  return Object.freeze({
    kind: 'open-task-lifecycle-status.v1' as const,
    state:
      errorCode !== null
        ? ('recovery-required' as const)
        : journal.phase === 'completed'
          ? (completedSessionState ?? ('recovery-required' as const))
          : ('opening' as const),
    lastDurablePhase: journal.phase,
    transactionId: journal.transactionId,
    changeId: journal.changeId,
    taskId: journal.taskId,
    mandateTaskId: journal.mandateTaskId,
    sessionId: journal.sessionId,
    parentCommit: journal.parentCommit,
    planningCommit: journal.planningCommit,
    baselineTree: journal.baselineTree,
    reportId: journal.reportId,
    retrySafe,
    recoveryCommand,
    errorCode,
  });
}

function recoverOpenTask(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
  assertRepositoryLock: () => void,
  options: OpenTaskOptions,
): OpenTaskResult {
  assertJournalAuthority(cwd, journal);
  if (journal.phase === 'completed') {
    const session = readAndAssertExactSession(cwd, runtime, journal);
    return resultFrom(journal, session, true);
  }

  let durable = journal;
  let current = discoverRepository(cwd);
  if (durable.phase === 'prepared') {
    if (current.head === durable.parentCommit) {
      assertActiveTaskMandateBindingUnderLifecycleLock(
        cwd,
        durable.mandateBinding,
        assertRepositoryLock,
        options.mandate,
      );
      withOpenTaskPlanningAuthority(
        runtime,
        durable.changeId,
        assertRepositoryLock,
        () => recoverPreparedPlanningCommit(cwd, durable),
      );
      current = discoverRepository(cwd);
    }
    if (current.head !== durable.planningCommit) {
      throw workflowError(
        'OPEN_TASK_HEAD_DIVERGED',
        'Open-task recovery found neither its exact parent nor its exact planning commit.',
        ExitCode.staleState,
      );
    }
    assertCommittedPlanningState(cwd, durable);
    durable = advanceJournalPhase(runtime, durable, 'plan-committed');
  } else {
    if (current.head !== durable.planningCommit) {
      throw openTaskPhaseDiverged(
        'Durable open-task phase is ahead of its observable planning commit.',
      );
    }
    assertCommittedPlanningState(cwd, durable);
  }

  let session: WorkflowSession;
  if (durable.phase === 'plan-committed') {
    session = ensureExactSession(cwd, runtime, durable, assertRepositoryLock);
    durable = advanceJournalPhase(runtime, durable, 'session-active');
  } else {
    session = readSessionForDurablePhase(cwd, runtime, durable);
  }
  const completed = completeJournal(runtime, durable, options.now);
  return resultFrom(completed, session, true);
}

function recoverPreparedPlanningCommit(
  cwd: string,
  journal: OpenTaskJournal,
): void {
  assertJournalAuthority(cwd, journal);
  const repository = discoverRepository(cwd);
  if (
    repository.head !== journal.parentCommit ||
    repository.tree !== journal.parentTree ||
    repository.branch !== journal.branch
  ) {
    throw workflowError(
      'OPEN_TASK_HEAD_DIVERGED',
      'Open-task parent state changed before its prepared commit recovered.',
      ExitCode.staleState,
    );
  }
  const projectionMutations = restorePreparedPlanningProjection(
    repository.repositoryRoot,
    journal,
  );
  const staged = stageExactPaths(
    repository.repositoryRoot,
    journal.parentCommit,
    [...journal.changedPaths],
  );
  if (staged.tree !== journal.baselineTree) {
    rollbackExactStaging(
      repository.repositoryRoot,
      staged.previousIndexTree,
      staged.tree,
      openTaskUnsafe('Prepared planning tree changed before recovery.'),
    );
    rollbackPreparedPlanningProjection(
      repository.repositoryRoot,
      projectionMutations,
    );
    throw openTaskUnsafe('Prepared planning tree changed before recovery.');
  }
  try {
    updateManagedRef(
      repository.repositoryRoot,
      journal.parentCommit,
      journal.planningCommit,
      `refs/heads/${journal.branch}`,
    );
  } catch (error) {
    rollbackExactStaging(
      repository.repositoryRoot,
      staged.previousIndexTree,
      staged.tree,
      error,
    );
    rollbackPreparedPlanningProjection(
      repository.repositoryRoot,
      projectionMutations,
    );
    throw error;
  }
  assertCommittedPlanningState(cwd, journal);
}

function restorePreparedPlanningProjection(
  repositoryRoot: string,
  journal: OpenTaskJournal,
): GeneratedDocumentMutation[] {
  const projectionPaths = planningProjectionPaths(journal);
  if (projectionPaths.length === 0) return [];
  const mutations = projectionPaths.map((projectionPath) => {
    const before = readFileAtCommit(
      repositoryRoot,
      journal.parentCommit,
      projectionPath,
    );
    const after = readFileAtCommit(
      repositoryRoot,
      journal.planningCommit,
      projectionPath,
    );
    if (after === undefined || after === before) {
      throw openTaskUnsafe(
        'Prepared open-task projection authority is invalid.',
      );
    }
    const current = readPlainProjectionFile(repositoryRoot, projectionPath);
    if (current !== before && current !== after) {
      throw workflowError(
        'OPEN_TASK_PROJECTION_DIVERGED',
        'Open-task recovery found foreign engine-projection bytes.',
        ExitCode.staleState,
      );
    }
    return { path: projectionPath, before, after };
  });
  try {
    refreshPlanningDocuments(repositoryRoot, journal.changeId);
    for (const mutation of mutations) {
      if (
        readPlainProjectionFile(repositoryRoot, mutation.path) !==
        mutation.after
      ) {
        throw openTaskUnsafe(
          'Prepared open-task projection did not regenerate exactly.',
        );
      }
    }
    validatePreparedPlanningProjection(repositoryRoot, journal);
    return mutations;
  } catch (error) {
    rollbackPreparedPlanningProjection(repositoryRoot, mutations, true);
    throw error;
  }
}

function rollbackPreparedPlanningProjection(
  repositoryRoot: string,
  mutations: GeneratedDocumentMutation[],
  allowAlreadyRestored = false,
): void {
  const applied: GeneratedDocumentMutation[] = [];
  for (const mutation of mutations) {
    const current = readPlainProjectionFile(repositoryRoot, mutation.path);
    if (allowAlreadyRestored && current === mutation.before) continue;
    if (current !== mutation.after) {
      throw workflowError(
        'OPEN_TASK_PROJECTION_DIVERGED',
        'Open-task could not restore a projection changed by another writer.',
        ExitCode.staleState,
      );
    }
    applied.push(mutation);
  }
  rollbackGeneratedDocuments(repositoryRoot, applied);
}

function readPlainProjectionFile(
  repositoryRoot: string,
  relativePath: string,
): string | undefined {
  const filePath = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw openTaskUnsafe('Open-task projection path is unsafe.');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function ensureExactSession(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
  assertRepositoryLock: () => void,
): WorkflowSession {
  const sessionPath = path.join(runtime.sessions, `${journal.sessionId}.json`);
  if (fs.lstatSync(sessionPath, { throwIfNoEntry: false })) {
    return readAndAssertExactSession(cwd, runtime, journal);
  }
  reclaimDeadChangeTransitionLock(
    runtime,
    journal.changeId,
    assertRepositoryLock,
  );
  const session = startMandatedSessionUnderLifecycleLock(
    cwd,
    journal.changeId,
    journal.taskId,
    journal.mandateBinding,
    { sessionId: journal.sessionId, createdAt: journal.createdAt },
    assertRepositoryLock,
  );
  assertExactSession(session, journal);
  return session;
}

function readAndAssertExactSession(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
): WorkflowSession {
  const session = readSessionFile(
    path.join(runtime.sessions, `${journal.sessionId}.json`),
  );
  assertExactSession(session, journal);
  assertOwnedLock(
    path.join(runtime.locks, `${journal.changeId}.lock`),
    journal.sessionId,
    journal.changeId,
    journal.taskId,
  );
  const repository = discoverRepository(cwd);
  if (repository.head !== journal.planningCommit) {
    throw openTaskUnsafe(
      'Active open-task session no longer owns its baseline.',
    );
  }
  return session;
}

function readSessionForDurablePhase(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
): WorkflowSession {
  const sessionPath = path.join(runtime.sessions, `${journal.sessionId}.json`);
  if (!fs.lstatSync(sessionPath, { throwIfNoEntry: false })) {
    throw openTaskPhaseDiverged(
      'Durable open-task phase is ahead of its observable task session.',
    );
  }
  return readAndAssertExactSession(cwd, runtime, journal);
}

function assertExactSession(
  session: WorkflowSession,
  journal: OpenTaskJournal,
): void {
  if (session.state !== 'active') {
    throw openTaskUnsafe(
      'Durable open-task session is no longer active during ingress recovery.',
    );
  }
  assertSessionIngressIdentity(session, journal);
}

function assertSessionIngressIdentity(
  session: WorkflowSession,
  journal: OpenTaskJournal,
): void {
  if (
    session.sessionId !== journal.sessionId ||
    session.changeId !== journal.changeId ||
    session.taskId !== journal.taskId ||
    session.repositoryRoot !== journal.repositoryRoot ||
    session.gitCommonDirectory !== journal.gitCommonDirectory ||
    session.branch !== journal.branch ||
    session.baseline.head !== journal.planningCommit ||
    session.baseline.tree !== journal.baselineTree ||
    session.createdAt !== journal.createdAt ||
    canonicalJson(session.mandateBinding) !==
      canonicalJson(journal.mandateBinding)
  ) {
    throw openTaskUnsafe(
      'Durable open-task session does not match its journal.',
    );
  }
}

function assertJournalAuthority(cwd: string, journal: OpenTaskJournal): void {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const expectedBranch = config.branchTemplate.replaceAll(
    '{changeId}',
    journal.changeId,
  );
  if (
    repository.repositoryRealPath !== journal.worktree ||
    repository.repositoryRealPath !== journal.repositoryRoot ||
    repository.gitCommonDirectory !== journal.gitCommonDirectory ||
    repository.branch !== journal.branch ||
    journal.branch !== expectedBranch
  ) {
    throw workflowError(
      'OPEN_TASK_WORKSPACE_OWNERSHIP_MISMATCH',
      'Open-task recovery is bound to another repository worktree or branch.',
      ExitCode.staleState,
    );
  }
  assertPreparedPlanningAuthority(
    repository.repositoryRoot,
    config.runtimeDirectory,
    config.changeRoot,
    journal,
  );
}

function assertPreparedPlanningAuthority(
  repositoryRoot: string,
  runtimeDirectory: string,
  changeRoot: string,
  journal: OpenTaskJournal,
): void {
  const prefix = `${changeRoot}/${journal.changeId}/`;
  const projectionPaths = new Set(planningProjectionPaths(journal));
  if (
    !journal.changedPaths.some((changedPath) =>
      changedPath.startsWith(prefix),
    ) ||
    journal.changedPaths.some(
      (changedPath) =>
        !changedPath.startsWith(prefix) && !projectionPaths.has(changedPath),
    )
  ) {
    throw openTaskUnsafe('Prepared open-task path authority is invalid.');
  }
  const facts = commitFacts(repositoryRoot, journal.planningCommit);
  if (
    facts.tree !== journal.baselineTree ||
    canonicalJson(facts.parents) !== canonicalJson([journal.parentCommit]) ||
    facts.message !==
      `Plan ${journal.changeId}\n\nChange: ${journal.changeId}\nTransition: plan\n` ||
    canonicalJson(
      commitChangedPaths(repositoryRoot, journal.planningCommit),
    ) !== canonicalJson(journal.changedPaths)
  ) {
    throw openTaskUnsafe('Prepared open-task commit authority is invalid.');
  }
  const report = readPlanningTransitionReport(
    path.join(journal.gitCommonDirectory, runtimeDirectory, 'planning-reports'),
    journal.reportId,
  );
  if (
    report.changeId !== journal.changeId ||
    report.transition !== 'plan' ||
    report.branch !== journal.branch ||
    report.headRef !== `refs/heads/${journal.branch}` ||
    report.parent.head !== journal.parentCommit ||
    report.parent.tree !== journal.parentTree ||
    report.tree !== journal.baselineTree ||
    report.commitHash !== journal.planningCommit ||
    canonicalJson(report.changedPaths) !==
      canonicalJson(journal.changedPaths) ||
    canonicalJson(report.engineProjectionPaths) !==
      canonicalJson(planningProjectionPaths(journal)) ||
    canonicalJson(report.planningPaths) !==
      canonicalJson(
        journal.changedPaths.filter(
          (changedPath) => !projectionPaths.has(changedPath),
        ),
      )
  ) {
    throw openTaskUnsafe('Prepared open-task planning report is invalid.');
  }
}

function assertCommittedPlanningState(
  cwd: string,
  journal: OpenTaskJournal,
): void {
  const repository = discoverRepository(cwd);
  if (
    repository.head !== journal.planningCommit ||
    repository.tree !== journal.baselineTree ||
    repository.branch !== journal.branch ||
    repository.statusEntries.length !== 0 ||
    runGit(repository.repositoryRoot, ['write-tree']).trim() !==
      journal.baselineTree
  ) {
    throw workflowError(
      'OPEN_TASK_COMMITTED_STATE_DIVERGED',
      'Open-task planning commit no longer matches the clean worktree and index.',
      ExitCode.staleState,
    );
  }
  validatePreparedPlanningProjection(repository.repositoryRoot, journal);
}

function planningProjectionPaths(journal: OpenTaskJournal): string[] {
  const known = new Set(engineProjectionPathsForTransition('plan'));
  return journal.changedPaths.filter((changedPath) => known.has(changedPath));
}

function validatePreparedPlanningProjection(
  repositoryRoot: string,
  journal: OpenTaskJournal,
): void {
  if (
    planningProjectionPaths(journal).includes('docs/CURRENT_AND_NEXT_STEPS.md')
  ) {
    validateHandoffForChange(repositoryRoot, journal.changeId);
  }
}

function createPreparedJournal(
  input: Omit<
    OpenTaskJournal,
    'schemaVersion' | 'kind' | 'transactionId' | 'phase' | 'completedAt'
  >,
): OpenTaskJournal {
  const stable = {
    schemaVersion: 1 as const,
    kind: 'open-task-transaction.v1' as const,
    changeId: input.changeId,
    taskId: input.taskId,
    mandateTaskId: input.mandateTaskId,
    mandateBinding: structuredClone(input.mandateBinding),
    repositoryRoot: input.repositoryRoot,
    gitCommonDirectory: input.gitCommonDirectory,
    worktree: input.worktree,
    branch: input.branch,
    parentCommit: input.parentCommit,
    parentTree: input.parentTree,
    planningCommit: input.planningCommit,
    baselineTree: input.baselineTree,
    reportId: input.reportId,
    changedPaths: [...input.changedPaths],
    sessionId: input.sessionId,
    createdAt: input.createdAt,
  };
  return parseJournal({
    ...stable,
    transactionId: transactionDigest(stable),
    phase: 'prepared',
    completedAt: null,
  });
}

function completeJournal(
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
  now?: Date,
): OpenTaskJournal {
  if (journal.phase === 'completed') return journal;
  if (journal.phase !== 'session-active') {
    throw openTaskPhaseDiverged(
      'Open-task cannot complete before its exact session-active phase.',
    );
  }
  const completed = parseJournal({
    ...journal,
    phase: 'completed',
    completedAt: exactTimestamp(now ?? new Date()),
  });
  replaceJournal(runtime, journal, completed);
  return completed;
}

function advanceJournalPhase(
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
  nextPhase: 'plan-committed' | 'session-active',
): OpenTaskJournal {
  const expectedCurrent =
    nextPhase === 'plan-committed' ? 'prepared' : 'plan-committed';
  if (journal.phase !== expectedCurrent) {
    throw openTaskPhaseDiverged(
      `Open-task cannot advance from ${journal.phase} to ${nextPhase}.`,
    );
  }
  const next = parseJournal({ ...journal, phase: nextPhase });
  replaceJournal(runtime, journal, next);
  return next;
}

function publishPreparedJournal(
  runtime: ReturnType<typeof runtimePaths>,
  journal: OpenTaskJournal,
): void {
  const filePath = journalPath(runtime, journal.changeId, journal.taskId);
  ensureJournalDirectory(filePath);
  const content = `${canonicalJson(journal)}\n`;
  const temporary = writePrivateTemporary(filePath, content);
  try {
    fs.linkSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(filePath));
    if (readPrivateCanonicalFile(filePath) !== content) {
      throw openTaskUnsafe('Prepared open-task journal publication changed.');
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (isNodeError(error) && error.code === 'EEXIST') {
      const existing = parseJournal(readPrivateCanonicalFile(filePath));
      if (canonicalJson(existing) === canonicalJson(journal)) return;
      throw workflowError(
        'OPEN_TASK_TRANSACTION_CONFLICT',
        'A different durable open-task transaction already exists.',
        ExitCode.conflict,
      );
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function replaceJournal(
  runtime: ReturnType<typeof runtimePaths>,
  previous: OpenTaskJournal,
  next: OpenTaskJournal,
): void {
  const filePath = journalPath(runtime, previous.changeId, previous.taskId);
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const observed = parseJournal(readPrivateCanonicalFile(filePath));
  const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before ||
    !current ||
    before.dev !== current.dev ||
    before.ino !== current.ino ||
    canonicalJson(observed) !== canonicalJson(previous)
  ) {
    throw openTaskUnsafe('Open-task journal changed before phase advancement.');
  }
  const content = `${canonicalJson(next)}\n`;
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const beforeRename = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !beforeRename ||
      before.dev !== beforeRename.dev ||
      before.ino !== beforeRename.ino
    ) {
      throw openTaskUnsafe('Open-task journal pathname changed.');
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    if (readPrivateCanonicalFile(filePath) !== content) {
      throw openTaskUnsafe('Completed open-task journal publication changed.');
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readPrivateCanonicalFile(filePath: string): string {
  const parent = path.dirname(filePath);
  assertPrivateDirectory(parent);
  reconcilePublishedJournalAlias(filePath);
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > MAX_JOURNAL_BYTES
  ) {
    throw openTaskUnsafe('Open-task journal file is unsafe.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !current ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      Buffer.byteLength(content) > MAX_JOURNAL_BYTES
    ) {
      throw openTaskUnsafe('Open-task journal changed while being read.');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw openTaskUnsafe('Open-task journal is not JSON.');
    }
    if (`${canonicalJson(value)}\n` !== content) {
      throw openTaskUnsafe('Open-task journal bytes are not canonical.');
    }
    return content;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseJournal(input: unknown): OpenTaskJournal {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw openTaskUnsafe('Open-task journal is not JSON.');
    }
  }
  if (!isRecord(value)) throw openTaskUnsafe('Open-task journal is malformed.');
  const expectedKeys = [
    'baselineTree',
    'branch',
    'changeId',
    'changedPaths',
    'completedAt',
    'createdAt',
    'gitCommonDirectory',
    'kind',
    'mandateBinding',
    'mandateTaskId',
    'parentCommit',
    'parentTree',
    'phase',
    'planningCommit',
    'reportId',
    'repositoryRoot',
    'schemaVersion',
    'sessionId',
    'taskId',
    'transactionId',
    'worktree',
  ].sort();
  if (
    Object.keys(value).sort().join('\0') !== expectedKeys.join('\0') ||
    value.schemaVersion !== 1 ||
    value.kind !== 'open-task-transaction.v1' ||
    (value.phase !== 'prepared' &&
      value.phase !== 'plan-committed' &&
      value.phase !== 'session-active' &&
      value.phase !== 'completed') ||
    typeof value.transactionId !== 'string' ||
    !SHA256.test(value.transactionId) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.mandateTaskId !== 'string' ||
    !MANDATE_TASK_ID.test(value.mandateTaskId) ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    typeof value.worktree !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.parentCommit !== 'string' ||
    !COMMIT_OID.test(value.parentCommit) ||
    typeof value.parentTree !== 'string' ||
    !COMMIT_OID.test(value.parentTree) ||
    typeof value.planningCommit !== 'string' ||
    !COMMIT_OID.test(value.planningCommit) ||
    typeof value.baselineTree !== 'string' ||
    !COMMIT_OID.test(value.baselineTree) ||
    typeof value.reportId !== 'string' ||
    !SHA256.test(value.reportId) ||
    !Array.isArray(value.changedPaths) ||
    value.changedPaths.some((entry) => typeof entry !== 'string') ||
    typeof value.sessionId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    (value.completedAt !== null && typeof value.completedAt !== 'string') ||
    (value.phase !== 'completed' && value.completedAt !== null) ||
    (value.phase === 'completed' && value.completedAt === null)
  ) {
    throw openTaskUnsafe('Open-task journal is malformed.');
  }
  const changeId = assertChangeId(value.changeId);
  const taskId = assertTaskId(value.taskId);
  const changedPaths = value.changedPaths.map((entry) =>
    normalizeChangedPath(entry as string),
  );
  if (
    canonicalJson(changedPaths) !==
      canonicalJson([...new Set(changedPaths)].sort()) ||
    !path.isAbsolute(value.repositoryRoot) ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    !path.isAbsolute(value.worktree)
  ) {
    throw openTaskUnsafe('Open-task journal identity is malformed.');
  }
  const mandateBinding = parseMandateBinding(value.mandateBinding);
  const createdAt = exactTimestamp(new Date(value.createdAt));
  const completedAt =
    value.completedAt === null
      ? null
      : exactTimestamp(new Date(value.completedAt));
  if (
    createdAt !== value.createdAt ||
    completedAt !== value.completedAt ||
    mandateBinding.mandateTaskId !== value.mandateTaskId ||
    mandateBinding.changeId !== changeId
  ) {
    throw openTaskUnsafe('Open-task journal bindings are not exact.');
  }
  const journal: OpenTaskJournal = {
    schemaVersion: 1,
    kind: 'open-task-transaction.v1',
    transactionId: value.transactionId,
    phase: value.phase,
    changeId,
    taskId,
    mandateTaskId: value.mandateTaskId,
    mandateBinding,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    worktree: value.worktree,
    branch: value.branch,
    parentCommit: value.parentCommit,
    parentTree: value.parentTree,
    planningCommit: value.planningCommit,
    baselineTree: value.baselineTree,
    reportId: value.reportId,
    changedPaths,
    sessionId: value.sessionId,
    createdAt,
    completedAt,
  };
  if (journal.transactionId !== transactionDigest(journal)) {
    throw openTaskUnsafe('Open-task transaction identity does not match.');
  }
  return Object.freeze(journal);
}

function parseMandateBinding(value: unknown): TaskMandateBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'changeId',
        'externalAuditRoot',
        'mandateDigest',
        'mandateId',
        'mandateTaskId',
        'schemaVersion',
      ]
        .sort()
        .join('\0') ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !MANDATE_TASK_ID.test(value.mandateTaskId) ||
    typeof value.mandateId !== 'string' ||
    !MANDATE_ID.test(value.mandateId) ||
    typeof value.mandateDigest !== 'string' ||
    !SHA256.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot)
  ) {
    throw openTaskUnsafe('Open-task mandate binding is malformed.');
  }
  return {
    schemaVersion: 1,
    mandateTaskId: value.mandateTaskId,
    mandateId: value.mandateId,
    mandateDigest: value.mandateDigest,
    changeId: assertChangeId(value.changeId),
    externalAuditRoot: value.externalAuditRoot,
  };
}

function assertRequestedTransaction(
  journal: OpenTaskJournal,
  request: {
    changeId: string;
    taskId: string;
    mandateTaskId: string;
    repository: ReturnType<typeof discoverRepository>;
  },
): void {
  if (
    journal.changeId !== request.changeId ||
    journal.taskId !== request.taskId ||
    journal.mandateTaskId !== request.mandateTaskId ||
    journal.repositoryRoot !== request.repository.repositoryRealPath ||
    journal.gitCommonDirectory !== request.repository.gitCommonDirectory ||
    journal.worktree !== request.repository.repositoryRealPath
  ) {
    throw workflowError(
      'OPEN_TASK_TRANSACTION_MISMATCH',
      'The requested task does not match its durable open-task transaction.',
      ExitCode.staleState,
    );
  }
}

function assertTransitionMatchesJournal(
  transition: PlanningTransitionResult,
  journal: OpenTaskJournal,
): void {
  if (
    transition.changeId !== journal.changeId ||
    transition.baselineHead !== journal.parentCommit ||
    transition.commitHash !== journal.planningCommit ||
    transition.tree !== journal.baselineTree ||
    transition.reportId !== journal.reportId ||
    canonicalJson(transition.changedPaths) !==
      canonicalJson(journal.changedPaths)
  ) {
    throw openTaskUnsafe(
      'Planning transition does not match its open-task journal.',
    );
  }
}

function resultFrom(
  journal: OpenTaskJournal,
  session: WorkflowSession,
  recovered: boolean,
): OpenTaskResult {
  return {
    changeId: journal.changeId,
    taskId: journal.taskId,
    mandateTaskId: journal.mandateTaskId,
    sessionId: journal.sessionId,
    worktree: journal.worktree,
    branch: journal.branch,
    planningCommit: journal.planningCommit,
    baselineTree: journal.baselineTree,
    allowedPaths: [...session.allowedPaths],
    requiredChecks: [...session.requiredChecks],
    recovered,
  };
}

function transactionDigest(
  value: Omit<OpenTaskJournal, 'transactionId' | 'phase' | 'completedAt'> &
    Partial<Pick<OpenTaskJournal, 'transactionId' | 'phase' | 'completedAt'>>,
): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schema: 'open-task-transaction.v1',
        changeId: value.changeId,
        taskId: value.taskId,
        mandateTaskId: value.mandateTaskId,
        mandateBinding: value.mandateBinding,
        repositoryRoot: value.repositoryRoot,
        gitCommonDirectory: value.gitCommonDirectory,
        worktree: value.worktree,
        branch: value.branch,
        parentCommit: value.parentCommit,
        parentTree: value.parentTree,
        planningCommit: value.planningCommit,
        baselineTree: value.baselineTree,
        reportId: value.reportId,
        changedPaths: value.changedPaths,
        sessionId: value.sessionId,
        createdAt: value.createdAt,
      }),
    )
    .digest('hex');
}

function journalPath(
  runtime: ReturnType<typeof runtimePaths>,
  changeId: string,
  taskId: string,
): string {
  return path.join(
    runtime.root,
    'open-task',
    'transactions',
    `${changeId}.${taskId}.json`,
  );
}

function ensureJournalDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  ensurePlainDirectory(path.dirname(directory));
  ensurePlainDirectory(directory);
  fs.chmodSync(path.dirname(directory), 0o700);
  fs.chmodSync(directory, 0o700);
  assertPrivateDirectory(directory);
}

function reconcilePublishedJournalAlias(filePath: string): void {
  const target = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!target || target.nlink === 1) return;
  if (
    !target.isFile() ||
    target.isSymbolicLink() ||
    target.nlink !== 2 ||
    (target.mode & 0o777) !== 0o600
  ) {
    throw openTaskUnsafe('Open-task journal publication residue is unsafe.');
  }
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const aliases = fs
    .readdirSync(directory)
    .filter(
      (entry) =>
        entry !== basename &&
        entry.startsWith(`${basename}.`) &&
        entry.endsWith('.tmp'),
    )
    .map((entry) => path.join(directory, entry))
    .filter((candidate) => {
      const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
      return (
        stats?.isFile() === true &&
        !stats.isSymbolicLink() &&
        stats.dev === target.dev &&
        stats.ino === target.ino &&
        stats.nlink === 2 &&
        (stats.mode & 0o777) === 0o600
      );
    });
  if (aliases.length !== 1) {
    throw openTaskUnsafe('Open-task journal publication residue is ambiguous.');
  }
  fs.unlinkSync(aliases[0]!);
  fsyncDirectory(directory);
  const reconciled = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !reconciled?.isFile() ||
    reconciled.isSymbolicLink() ||
    reconciled.nlink !== 1 ||
    reconciled.dev !== target.dev ||
    reconciled.ino !== target.ino
  ) {
    throw openTaskUnsafe('Open-task journal publication did not reconcile.');
  }
}

function assertPrivateDirectory(directory: string): void {
  for (const candidate of [path.dirname(directory), directory]) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(candidate) !== path.resolve(candidate) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw openTaskUnsafe('Open-task runtime directory is unsafe.');
    }
  }
}

function writePrivateTemporary(filePath: string, content: string): string {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function exactTimestamp(now: Date): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw workflowError(
      'OPEN_TASK_CLOCK_INVALID',
      'Open-task requires a valid wall-clock timestamp.',
      ExitCode.staleState,
    );
  }
  return new Date(milliseconds).toISOString();
}

function assertMandateTaskId(value: string): string {
  if (!MANDATE_TASK_ID.test(value) || value.length > 128) {
    throw workflowError(
      'OPEN_TASK_MANDATE_TASK_ID_INVALID',
      'Open-task mandate task ID must be lower-case kebab-case.',
      ExitCode.usage,
    );
  }
  return value;
}

function exactOpenTaskRetryCommand(journal: OpenTaskJournal): string {
  return `pnpm workflow open-task ${journal.changeId} --task ${journal.taskId} --mandate ${journal.mandateTaskId} --json`;
}

function openTaskPhaseDiverged(message: string): WorkflowError {
  return workflowError(
    'OPEN_TASK_PHASE_DIVERGED',
    message,
    ExitCode.staleState,
  );
}

function simulatedInterruption(phase: string): Error {
  return new Error(`Simulated open-task interruption after ${phase}.`);
}

function openTaskUnsafe(message: string) {
  return workflowError(
    'OPEN_TASK_JOURNAL_CORRUPT',
    message,
    ExitCode.staleState,
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
