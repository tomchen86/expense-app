import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import {
  assertSessionId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';
import { isProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  isSameReviewedTaskStrategyLineage,
  parseTaskStrategyTransaction,
  readTaskStrategyTransactionByDigest,
  type TaskStrategyTransaction,
} from './task-strategy-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_ID = /^red-revision-[0-9a-f]{64}$/;
const MAX_REASON_BYTES = 4096;

export const TASK_STRATEGY_RED_REVISION_PHASES = Object.freeze([
  'prepared',
  'implementation-restored',
  'current-authoring',
  'session-evidence-cleared',
  'reseal-prepared',
  'successor-persisted',
  'current-sealed',
  'completed',
] as const);

export type TaskStrategyRedRevisionPhase =
  (typeof TASK_STRATEGY_RED_REVISION_PHASES)[number];

export type TaskStrategyRedRevisionRequest = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-red-revision-request';
  sessionId: string;
  expectedTransactionDigest: string;
  reason: string;
}>;

export type TaskStrategyRedRevisionRequestSnapshot = Readonly<{
  revisionId: string;
  requestDigest: string;
  request: TaskStrategyRedRevisionRequest;
}>;

type TaskStrategyCurrentRefBase = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-current-ref.v1';
  refDigest: string;
  sessionId: string;
  predecessorTransactionDigest: string | null;
  revisionId: string | null;
  taskContractDigest: string;
  updatedAt: string;
}>;

export type TaskStrategyCurrentRef =
  | (TaskStrategyCurrentRefBase &
      Readonly<{
        state: 'red-authoring';
        transactionDigest: null;
        predecessorTransactionDigest: string;
        revisionId: string;
      }>)
  | (TaskStrategyCurrentRefBase &
      Readonly<{
        state: 'red-sealed';
        transactionDigest: string;
      }>);

export type TaskStrategyCurrentRefInput =
  | Readonly<{
      sessionId: string;
      state: 'red-authoring';
      transactionDigest: null;
      predecessorTransactionDigest: string;
      revisionId: string;
      taskContractDigest: string;
      updatedAt: string;
    }>
  | Readonly<{
      sessionId: string;
      state: 'red-sealed';
      transactionDigest: string;
      predecessorTransactionDigest: string | null;
      revisionId: string | null;
      taskContractDigest: string;
      updatedAt: string;
    }>;

export type TaskStrategyRedRevisionJournalState = Readonly<{
  revisionId: string;
  sessionId: string;
  phase: TaskStrategyRedRevisionPhase;
  request: TaskStrategyRedRevisionRequest;
  requestDigest: string;
  predecessor: Readonly<{
    transactionDigest: string;
    candidateTree: string;
    currentRefDigest: string | null;
  }>;
  binding: Readonly<{
    changeId: string;
    taskId: string;
    baseline: Readonly<{ head: string; tree: string }>;
    strategy: TaskStrategyTransaction['strategy'];
    taskContractDigest: string;
    checkId: string;
    runner: string;
    runnerDigest: string;
    author: TaskStrategyTransaction['author'];
  }>;
  restoration: Readonly<{
    sourceTree: string;
    implementationCandidateTree: string | null;
    patchRecordDigest: string | null;
    patchDigest: string | null;
  }>;
  sessionTransition: Readonly<{
    before: Readonly<Record<string, unknown>>;
    beforeDigest: string;
    after: Readonly<Record<string, unknown>>;
    afterDigest: string;
  }>;
  authoringRef: TaskStrategyCurrentRef;
  successorTransaction: TaskStrategyTransaction | null;
  successorRef: TaskStrategyCurrentRef | null;
  createdAt: string;
  updatedAt: string;
}>;

export type TaskStrategyRedRevisionJournal =
  TaskStrategyRedRevisionJournalState &
    Readonly<{
      schemaVersion: 1;
      kind: 'task-strategy-red-revision-journal.v1';
      journalDigest: string;
      previousJournalDigest: string | null;
    }>;

export type ActiveTaskStrategyRedRevision = Readonly<{
  request: TaskStrategyRedRevisionRequest;
  journal: TaskStrategyRedRevisionJournal | null;
}>;

export function parseTaskStrategyRedRevisionRequest(
  value: unknown,
): TaskStrategyRedRevisionRequest {
  return parseRevisionRequest(value, revisionRequestInvalid);
}

export function taskStrategyRedRevisionRequestDigest(
  request: TaskStrategyRedRevisionRequest,
): string {
  return sha256(
    canonicalJson(parseRevisionRequest(request, revisionRequestInvalid)),
  );
}

export function taskStrategyRedRevisionId(
  request: TaskStrategyRedRevisionRequest,
): string {
  return `red-revision-${taskStrategyRedRevisionRequestDigest(request)}`;
}

export function taskStrategyRedRevisionSnapshotDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function persistTaskStrategyRedRevisionRequest(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyRedRevisionRequest,
): TaskStrategyRedRevisionRequestSnapshot {
  const request = parseRevisionRequest(input, revisionRequestInvalid);
  const snapshot = requestSnapshot(request);
  createPrivateCanonicalJson(
    paths,
    revisionRequestPath(paths, request.sessionId, snapshot.revisionId),
    request,
    revisionStateCorrupt,
    'TASK_STRATEGY_RED_REVISION_REQUEST_CONFLICT',
  );
  const stored = readTaskStrategyRedRevisionRequest(
    paths,
    request.sessionId,
    snapshot.revisionId,
  );
  if (stored === null) throw revisionStateCorrupt();
  return stored;
}

export function readTaskStrategyRedRevisionRequest(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRevisionId: string,
): TaskStrategyRedRevisionRequestSnapshot | null {
  const sessionId = assertSessionId(requestedSessionId);
  const revisionId = assertRevisionId(requestedRevisionId);
  const target = revisionRequestPath(paths, sessionId, revisionId);
  if (!privatePathExists(paths, target, revisionStateCorrupt)) return null;
  const request = parseRevisionRequest(
    readPrivateCanonicalJson(paths, target, revisionStateCorrupt),
    revisionStateCorrupt,
  );
  const snapshot = requestSnapshot(request);
  if (request.sessionId !== sessionId || snapshot.revisionId !== revisionId) {
    throw revisionStateCorrupt();
  }
  return snapshot;
}

export function createTaskStrategyCurrentRef(
  input: TaskStrategyCurrentRefInput,
): TaskStrategyCurrentRef {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-current-ref.v1' as const,
    sessionId: input.sessionId,
    state: input.state,
    transactionDigest: input.transactionDigest,
    predecessorTransactionDigest: input.predecessorTransactionDigest,
    revisionId: input.revisionId,
    taskContractDigest: input.taskContractDigest,
    updatedAt: input.updatedAt,
  };
  return parseTaskStrategyCurrentRef({
    ...body,
    refDigest: sha256(canonicalJson(body)),
  });
}

export function parseTaskStrategyCurrentRef(
  value: unknown,
): TaskStrategyCurrentRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'refDigest',
      'sessionId',
      'state',
      'transactionDigest',
      'predecessorTransactionDigest',
      'revisionId',
      'taskContractDigest',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-current-ref.v1' ||
    !isDigest(value.refDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.taskContractDigest) ||
    !isTimestamp(value.updatedAt) ||
    (value.predecessorTransactionDigest !== null &&
      !isDigest(value.predecessorTransactionDigest)) ||
    (value.revisionId !== null && !isRevisionId(value.revisionId))
  ) {
    throw revisionStateCorrupt();
  }
  if (
    value.state === 'red-authoring'
      ? value.transactionDigest !== null ||
        !isDigest(value.predecessorTransactionDigest) ||
        !isRevisionId(value.revisionId)
      : value.state === 'red-sealed'
        ? !isDigest(value.transactionDigest) ||
          (value.predecessorTransactionDigest === null) !==
            (value.revisionId === null) ||
          (value.predecessorTransactionDigest !== null &&
            value.transactionDigest === value.predecessorTransactionDigest)
        : true
  ) {
    throw revisionStateCorrupt();
  }
  const { refDigest, ...body } = value;
  if (refDigest !== sha256(canonicalJson(body))) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(value as TaskStrategyCurrentRef);
}

export function readTaskStrategyCurrentRef(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyCurrentRef | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = currentRefPath(paths, sessionId);
  if (!privatePathExists(paths, target, revisionStateCorrupt)) return null;
  const current = parseTaskStrategyCurrentRef(
    readPrivateCanonicalJson(paths, target, revisionStateCorrupt),
  );
  if (current.sessionId !== sessionId) throw revisionStateCorrupt();
  return current;
}

export function compareAndSwapTaskStrategyCurrentRef(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    sessionId: string;
    expectedRefDigest: string | null;
    next: TaskStrategyCurrentRef;
  }>,
): TaskStrategyCurrentRef {
  const sessionId = assertSessionId(input.sessionId);
  if (
    input.expectedRefDigest !== null &&
    !DIGEST.test(input.expectedRefDigest)
  ) {
    throw revisionStateCorrupt();
  }
  const next = parseTaskStrategyCurrentRef(input.next);
  if (next.sessionId !== sessionId) throw revisionStateCorrupt();
  const current = readTaskStrategyCurrentRef(paths, sessionId);
  assertCurrentRefTargetAvailable(paths, next);
  if (current?.refDigest === next.refDigest) return current;
  const observedDigest = current?.refDigest ?? null;
  if (observedDigest !== input.expectedRefDigest) {
    throw workflowError(
      'TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH',
      'Task strategy current ref changed during compare-and-swap.',
      ExitCode.conflict,
      {
        details: {
          expectedRefDigest: input.expectedRefDigest,
          observedRefDigest: observedDigest,
          nextRefDigest: next.refDigest,
        },
      },
    );
  }
  assertCurrentRefTransition(paths, current, next);
  const target = currentRefPath(paths, sessionId);
  if (current === null) {
    createPrivateCanonicalJson(
      paths,
      target,
      next,
      revisionStateCorrupt,
      'TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH',
    );
  } else {
    writePrivateCanonicalJsonAtomic(paths, target, next, revisionStateCorrupt);
  }
  const published = readTaskStrategyCurrentRef(paths, sessionId);
  if (published?.refDigest !== next.refDigest) throw revisionStateCorrupt();
  return published;
}

export function createTaskStrategyRedRevisionJournal(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyRedRevisionJournalState,
): TaskStrategyRedRevisionJournal {
  if (input.phase !== 'prepared') throw revisionPhaseInvalid();
  const journal = buildRevisionJournal(input, null);
  assertPersistedRequestMatchesJournal(paths, journal);
  assertPreparedJournalPredecessor(paths, journal);
  createPrivateCanonicalJson(
    paths,
    revisionJournalPath(paths, journal.sessionId, journal.revisionId),
    journal,
    revisionStateCorrupt,
    'TASK_STRATEGY_RED_REVISION_JOURNAL_CONFLICT',
  );
  const stored = readTaskStrategyRedRevisionJournal(
    paths,
    journal.sessionId,
    journal.revisionId,
  );
  if (stored === null) throw revisionStateCorrupt();
  return stored;
}

export function readTaskStrategyRedRevisionJournal(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRevisionId: string,
): TaskStrategyRedRevisionJournal | null {
  const sessionId = assertSessionId(requestedSessionId);
  const revisionId = assertRevisionId(requestedRevisionId);
  const target = revisionJournalPath(paths, sessionId, revisionId);
  if (!privatePathExists(paths, target, revisionStateCorrupt)) return null;
  const journal = parseTaskStrategyRedRevisionJournal(
    readPrivateCanonicalJson(paths, target, revisionStateCorrupt),
  );
  if (journal.sessionId !== sessionId || journal.revisionId !== revisionId) {
    throw revisionStateCorrupt();
  }
  assertPersistedRequestMatchesJournal(paths, journal);
  return journal;
}

/**
 * Discover the one incomplete RED revision independently of the mutable
 * current ref. The request is the first durable record, so this also recovers
 * crashes before journal creation or before current-ref publication.
 */
export function readActiveTaskStrategyRedRevision(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): ActiveTaskStrategyRedRevision | null {
  const sessionId = assertSessionId(requestedSessionId);
  const root = path.join(paths.refs, 'task-strategy-red-revisions');
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (rootStats === undefined) return null;
  assertPrivateInvestigationDirectory(paths, root, revisionStateCorrupt);

  const sessionDirectory = path.join(root, sessionId);
  const sessionStats = fs.lstatSync(sessionDirectory, {
    throwIfNoEntry: false,
  });
  if (sessionStats === undefined) return null;
  assertPrivateInvestigationDirectory(
    paths,
    sessionDirectory,
    revisionStateCorrupt,
  );

  const active: ActiveTaskStrategyRedRevision[] = [];
  const entries = fs
    .readdirSync(sessionDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !isRevisionId(entry.name)
    ) {
      throw revisionStateCorrupt();
    }
    const directory = revisionDirectory(paths, sessionId, entry.name);
    assertPrivateInvestigationDirectory(paths, directory, revisionStateCorrupt);
    const artifacts = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const names = artifacts.map(({ name }) => name);
    if (
      artifacts.some(
        (artifact) => artifact.isSymbolicLink() || !artifact.isFile(),
      ) ||
      (canonicalJson(names) !== canonicalJson(['request.json']) &&
        canonicalJson(names) !==
          canonicalJson(['journal.json', 'request.json']))
    ) {
      throw revisionStateCorrupt();
    }
    const requestSnapshot = readTaskStrategyRedRevisionRequest(
      paths,
      sessionId,
      entry.name,
    );
    if (requestSnapshot === null) throw revisionStateCorrupt();
    const journal = names.includes('journal.json')
      ? readTaskStrategyRedRevisionJournal(paths, sessionId, entry.name)
      : null;
    if (names.includes('journal.json') && journal === null) {
      throw revisionStateCorrupt();
    }
    if (journal?.phase !== 'completed') {
      active.push(Object.freeze({ request: requestSnapshot.request, journal }));
      if (active.length > 1) throw revisionStateCorrupt();
    }
  }
  return active[0] ?? null;
}

export function updateTaskStrategyRedRevisionJournal(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    sessionId: string;
    revisionId: string;
    expectedJournalDigest: string;
    next: TaskStrategyRedRevisionJournalState;
  }>,
): TaskStrategyRedRevisionJournal {
  const sessionId = assertSessionId(input.sessionId);
  const revisionId = assertRevisionId(input.revisionId);
  if (!DIGEST.test(input.expectedJournalDigest)) throw revisionStateCorrupt();
  const current = readTaskStrategyRedRevisionJournal(
    paths,
    sessionId,
    revisionId,
  );
  if (current === null) throw revisionStateCorrupt();
  if (sameJournalState(current, input.next)) return current;
  if (current.journalDigest !== input.expectedJournalDigest) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_JOURNAL_CAS_MISMATCH',
      'Task strategy RED revision journal changed during compare-and-swap.',
      ExitCode.conflict,
      {
        details: {
          expectedJournalDigest: input.expectedJournalDigest,
          observedJournalDigest: current.journalDigest,
        },
      },
    );
  }
  assertNextJournalState(current, input.next);
  const next = buildRevisionJournal(input.next, current.journalDigest);
  writePrivateCanonicalJsonAtomic(
    paths,
    revisionJournalPath(paths, sessionId, revisionId),
    next,
    revisionStateCorrupt,
  );
  const published = readTaskStrategyRedRevisionJournal(
    paths,
    sessionId,
    revisionId,
  );
  if (published?.journalDigest !== next.journalDigest) {
    throw revisionStateCorrupt();
  }
  return published;
}

export function parseTaskStrategyRedRevisionJournal(
  value: unknown,
): TaskStrategyRedRevisionJournal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'journalDigest',
      'previousJournalDigest',
      'revisionId',
      'sessionId',
      'phase',
      'request',
      'requestDigest',
      'predecessor',
      'binding',
      'restoration',
      'sessionTransition',
      'authoringRef',
      'successorTransaction',
      'successorRef',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-red-revision-journal.v1' ||
    !isDigest(value.journalDigest) ||
    (value.previousJournalDigest !== null &&
      !isDigest(value.previousJournalDigest)) ||
    !isRevisionId(value.revisionId) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isRevisionPhase(value.phase) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    throw revisionStateCorrupt();
  }
  if ((value.phase === 'prepared') !== (value.previousJournalDigest === null)) {
    throw revisionStateCorrupt();
  }

  const request = parseRevisionRequest(value.request, revisionStateCorrupt);
  const predecessor = parsePredecessor(value.predecessor);
  const binding = parseBinding(value.binding);
  const restoration = parseRestoration(value.restoration);
  const sessionTransition = parseSessionTransition(value.sessionTransition);
  const authoringRef = parseTaskStrategyCurrentRef(value.authoringRef);
  const successorTransaction = parseNullableTransaction(
    value.successorTransaction,
  );
  const successorRef = parseNullableCurrentRef(value.successorRef);

  const journal = value as unknown as TaskStrategyRedRevisionJournal;
  if (
    request.sessionId !== journal.sessionId ||
    taskStrategyRedRevisionRequestDigest(request) !== journal.requestDigest ||
    taskStrategyRedRevisionId(request) !== journal.revisionId ||
    request.expectedTransactionDigest !== predecessor.transactionDigest ||
    restoration.sourceTree !== predecessor.candidateTree ||
    authoringRef.sessionId !== journal.sessionId ||
    authoringRef.state !== 'red-authoring' ||
    authoringRef.predecessorTransactionDigest !==
      predecessor.transactionDigest ||
    authoringRef.revisionId !== journal.revisionId ||
    authoringRef.taskContractDigest !== binding.taskContractDigest ||
    sessionTransition.before.sessionId !== journal.sessionId ||
    sessionTransition.beforeDigest !==
      taskStrategyRedRevisionSnapshotDigest(sessionTransition.before) ||
    sessionTransition.after.sessionId !== journal.sessionId ||
    sessionTransition.afterDigest !==
      taskStrategyRedRevisionSnapshotDigest(sessionTransition.after) ||
    !isExactSessionEvidenceClearingTransition(sessionTransition) ||
    !journalPhasePayloadIsValid(
      journal.phase,
      sessionTransition,
      successorTransaction,
      successorRef,
    ) ||
    !successorBindingIsValid(
      journal.sessionId,
      predecessor,
      binding,
      successorTransaction,
      successorRef,
      journal.revisionId,
    )
  ) {
    throw revisionStateCorrupt();
  }

  const { journalDigest, ...body } = value;
  if (journalDigest !== sha256(canonicalJson(body))) {
    throw revisionStateCorrupt();
  }
  return Object.freeze({
    ...journal,
    request,
    predecessor,
    binding,
    restoration,
    sessionTransition,
    authoringRef,
    successorTransaction,
    successorRef,
  });
}

function buildRevisionJournal(
  input: TaskStrategyRedRevisionJournalState,
  previousJournalDigest: string | null,
): TaskStrategyRedRevisionJournal {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-red-revision-journal.v1' as const,
    previousJournalDigest,
    revisionId: input.revisionId,
    sessionId: input.sessionId,
    phase: input.phase,
    request: input.request,
    requestDigest: input.requestDigest,
    predecessor: input.predecessor,
    binding: input.binding,
    restoration: input.restoration,
    sessionTransition: input.sessionTransition,
    authoringRef: input.authoringRef,
    successorTransaction: input.successorTransaction,
    successorRef: input.successorRef,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  return parseTaskStrategyRedRevisionJournal({
    ...body,
    journalDigest: sha256(canonicalJson(body)),
  });
}

function assertPersistedRequestMatchesJournal(
  paths: InvestigationRuntimePaths,
  journal: TaskStrategyRedRevisionJournal,
): void {
  const request = readTaskStrategyRedRevisionRequest(
    paths,
    journal.sessionId,
    journal.revisionId,
  );
  if (
    request === null ||
    request.requestDigest !== journal.requestDigest ||
    canonicalJson(request.request) !== canonicalJson(journal.request)
  ) {
    throw revisionStateCorrupt();
  }
}

function assertPreparedJournalPredecessor(
  paths: InvestigationRuntimePaths,
  journal: TaskStrategyRedRevisionJournal,
): void {
  const predecessor = readTaskStrategyTransactionByDigest(
    paths,
    journal.sessionId,
    journal.predecessor.transactionDigest,
  );
  if (
    predecessor === null ||
    predecessor.red.candidateTree !== journal.predecessor.candidateTree ||
    predecessor.changeId !== journal.binding.changeId ||
    predecessor.taskId !== journal.binding.taskId ||
    canonicalJson(predecessor.baseline) !==
      canonicalJson(journal.binding.baseline) ||
    predecessor.strategy !== journal.binding.strategy ||
    predecessor.taskContractDigest !== journal.binding.taskContractDigest ||
    predecessor.red.checkId !== journal.binding.checkId ||
    predecessor.red.runner !== journal.binding.runner ||
    predecessor.red.runnerDigest !== journal.binding.runnerDigest ||
    canonicalJson(predecessor.author) !== canonicalJson(journal.binding.author)
  ) {
    throw revisionStateCorrupt();
  }
  const current = readTaskStrategyCurrentRef(paths, journal.sessionId);
  if (
    journal.predecessor.currentRefDigest === null
      ? current !== null
      : current === null ||
        current.refDigest !== journal.predecessor.currentRefDigest ||
        current.state !== 'red-sealed' ||
        current.transactionDigest !== predecessor.recordDigest
  ) {
    throw workflowError(
      'TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH',
      'Task strategy current ref changed before RED revision preparation.',
      ExitCode.conflict,
      {
        details: {
          expectedRefDigest: journal.predecessor.currentRefDigest,
          observedRefDigest: current?.refDigest ?? null,
        },
      },
    );
  }
}

function assertCurrentRefTransition(
  paths: InvestigationRuntimePaths,
  current: TaskStrategyCurrentRef | null,
  next: TaskStrategyCurrentRef,
): void {
  if (current === null) {
    if (
      next.state === 'red-sealed' &&
      (next.predecessorTransactionDigest !== null || next.revisionId !== null)
    ) {
      throw revisionStateCorrupt();
    }
    return;
  }
  if (
    current.state === 'red-sealed'
      ? next.state !== 'red-authoring' ||
        next.predecessorTransactionDigest !== current.transactionDigest ||
        next.taskContractDigest !== current.taskContractDigest
      : next.state !== 'red-sealed' ||
        next.predecessorTransactionDigest !==
          current.predecessorTransactionDigest ||
        next.revisionId !== current.revisionId ||
        next.taskContractDigest !== current.taskContractDigest
  ) {
    throw revisionStateCorrupt();
  }
}

function assertCurrentRefTargetAvailable(
  paths: InvestigationRuntimePaths,
  next: TaskStrategyCurrentRef,
): void {
  const transactionDigest =
    next.state === 'red-authoring'
      ? next.predecessorTransactionDigest
      : next.transactionDigest;
  const transaction = readTaskStrategyTransactionByDigest(
    paths,
    next.sessionId,
    transactionDigest,
  );
  if (
    transaction === null ||
    transaction.taskContractDigest !== next.taskContractDigest
  ) {
    throw revisionStateCorrupt();
  }
  if (next.state === 'red-authoring') return;
  if (
    next.predecessorTransactionDigest !== null &&
    !isSameReviewedTaskStrategyLineage(
      transaction,
      readTaskStrategyTransactionByDigest(
        paths,
        next.sessionId,
        next.predecessorTransactionDigest,
      ),
    )
  ) {
    throw revisionStateCorrupt();
  }
}

function assertNextJournalState(
  current: TaskStrategyRedRevisionJournal,
  next: TaskStrategyRedRevisionJournalState,
): void {
  const currentIndex = TASK_STRATEGY_RED_REVISION_PHASES.indexOf(current.phase);
  const nextIndex = TASK_STRATEGY_RED_REVISION_PHASES.indexOf(next.phase);
  if (nextIndex !== currentIndex + 1) throw revisionPhaseInvalid();
  if (
    next.revisionId !== current.revisionId ||
    next.sessionId !== current.sessionId ||
    canonicalJson(next.request) !== canonicalJson(current.request) ||
    next.requestDigest !== current.requestDigest ||
    canonicalJson(next.predecessor) !== canonicalJson(current.predecessor) ||
    canonicalJson(next.binding) !== canonicalJson(current.binding) ||
    canonicalJson(next.restoration) !== canonicalJson(current.restoration) ||
    canonicalJson(next.authoringRef) !== canonicalJson(current.authoringRef) ||
    next.createdAt !== current.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    canonicalJson(next.sessionTransition.before) !==
      canonicalJson(current.sessionTransition.before) ||
    next.sessionTransition.beforeDigest !==
      current.sessionTransition.beforeDigest ||
    canonicalJson(next.sessionTransition.after) !==
      canonicalJson(current.sessionTransition.after) ||
    next.sessionTransition.afterDigest !==
      current.sessionTransition.afterDigest ||
    (current.successorTransaction !== null &&
      canonicalJson(next.successorTransaction) !==
        canonicalJson(current.successorTransaction)) ||
    (current.successorRef !== null &&
      canonicalJson(next.successorRef) !== canonicalJson(current.successorRef))
  ) {
    throw revisionStateCorrupt();
  }
}

function sameJournalState(
  current: TaskStrategyRedRevisionJournal,
  next: TaskStrategyRedRevisionJournalState,
): boolean {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    journalDigest: _journalDigest,
    previousJournalDigest: _previousJournalDigest,
    ...state
  } = current;
  return canonicalJson(state) === canonicalJson(next);
}

function journalPhasePayloadIsValid(
  phase: TaskStrategyRedRevisionPhase,
  sessionTransition: TaskStrategyRedRevisionJournal['sessionTransition'],
  successorTransaction: TaskStrategyTransaction | null,
  successorRef: TaskStrategyCurrentRef | null,
): boolean {
  const index = TASK_STRATEGY_RED_REVISION_PHASES.indexOf(phase);
  const resealPrepared =
    TASK_STRATEGY_RED_REVISION_PHASES.indexOf('reseal-prepared');
  return index < resealPrepared
    ? successorTransaction === null && successorRef === null
    : successorTransaction !== null && successorRef !== null;
}

function successorBindingIsValid(
  sessionId: string,
  predecessor: TaskStrategyRedRevisionJournal['predecessor'],
  binding: TaskStrategyRedRevisionJournal['binding'],
  successor: TaskStrategyTransaction | null,
  successorRef: TaskStrategyCurrentRef | null,
  revisionId: string,
): boolean {
  if (successor === null || successorRef === null) {
    return successor === null && successorRef === null;
  }
  return (
    successor.sessionId === sessionId &&
    successor.recordDigest !== predecessor.transactionDigest &&
    successor.changeId === binding.changeId &&
    successor.taskId === binding.taskId &&
    canonicalJson(successor.baseline) === canonicalJson(binding.baseline) &&
    successor.strategy === binding.strategy &&
    successor.taskContractDigest === binding.taskContractDigest &&
    canonicalJson(successor.author) === canonicalJson(binding.author) &&
    successor.red.checkId === binding.checkId &&
    successor.red.runner === binding.runner &&
    successor.red.runnerDigest === binding.runnerDigest &&
    successorRef.sessionId === sessionId &&
    successorRef.state === 'red-sealed' &&
    successorRef.transactionDigest === successor.recordDigest &&
    successorRef.predecessorTransactionDigest ===
      predecessor.transactionDigest &&
    successorRef.revisionId === revisionId &&
    successorRef.taskContractDigest === binding.taskContractDigest
  );
}

function parseRevisionRequest(
  value: unknown,
  invalid: () => WorkflowError,
): TaskStrategyRedRevisionRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sessionId',
      'expectedTransactionDigest',
      'reason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-red-revision-request' ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.expectedTransactionDigest) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    Buffer.byteLength(value.reason, 'utf8') > MAX_REASON_BYTES ||
    containsControlCharacter(value.reason)
  ) {
    throw invalid();
  }
  return Object.freeze(value as TaskStrategyRedRevisionRequest);
}

function requestSnapshot(
  request: TaskStrategyRedRevisionRequest,
): TaskStrategyRedRevisionRequestSnapshot {
  const requestDigest = taskStrategyRedRevisionRequestDigest(request);
  return Object.freeze({
    revisionId: `red-revision-${requestDigest}`,
    requestDigest,
    request,
  });
}

function parsePredecessor(
  value: unknown,
): TaskStrategyRedRevisionJournal['predecessor'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'transactionDigest',
      'candidateTree',
      'currentRefDigest',
    ]) ||
    !isDigest(value.transactionDigest) ||
    !isGitObjectId(value.candidateTree) ||
    (value.currentRefDigest !== null && !isDigest(value.currentRefDigest))
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['predecessor'],
  );
}

function parseBinding(
  value: unknown,
): TaskStrategyRedRevisionJournal['binding'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'taskId',
      'baseline',
      'strategy',
      'taskContractDigest',
      'checkId',
      'runner',
      'runnerDigest',
      'author',
    ]) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    !isBaseline(value.baseline) ||
    (value.strategy !== 'cross-agent-tdd' &&
      value.strategy !== 'tdd-single-agent') ||
    !isDigest(value.taskContractDigest) ||
    typeof value.checkId !== 'string' ||
    value.checkId.length === 0 ||
    typeof value.runner !== 'string' ||
    value.runner.length === 0 ||
    !isDigest(value.runnerDigest) ||
    !isAuthor(value.author)
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['binding'],
  );
}

function parseRestoration(
  value: unknown,
): TaskStrategyRedRevisionJournal['restoration'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceTree',
      'implementationCandidateTree',
      'patchRecordDigest',
      'patchDigest',
    ]) ||
    !isGitObjectId(value.sourceTree) ||
    (value.implementationCandidateTree !== null &&
      !isGitObjectId(value.implementationCandidateTree)) ||
    (value.patchRecordDigest !== null && !isDigest(value.patchRecordDigest)) ||
    (value.patchDigest !== null && !isDigest(value.patchDigest)) ||
    ((value.implementationCandidateTree === null ||
      value.patchRecordDigest === null ||
      value.patchDigest === null) &&
      (value.implementationCandidateTree !== null ||
        value.patchRecordDigest !== null ||
        value.patchDigest !== null))
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['restoration'],
  );
}

function parseSessionTransition(
  value: unknown,
): TaskStrategyRedRevisionJournal['sessionTransition'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['before', 'beforeDigest', 'after', 'afterDigest']) ||
    !isRecord(value.before) ||
    !isDigest(value.beforeDigest) ||
    !isRecord(value.after) ||
    !isDigest(value.afterDigest)
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['sessionTransition'],
  );
}

function isExactSessionEvidenceClearingTransition(
  transition: TaskStrategyRedRevisionJournal['sessionTransition'],
): boolean {
  const expected = { ...transition.before };
  delete expected.latestCheckReportId;
  delete expected.checkEvidenceEngineDigest;
  delete expected.implementationReconciliationReportId;
  delete expected.implementationReconciliationPaths;
  return canonicalJson(expected) === canonicalJson(transition.after);
}

function parseNullableTransaction(
  value: unknown,
): TaskStrategyTransaction | null {
  if (value === null) return null;
  try {
    return parseTaskStrategyTransaction(value);
  } catch {
    throw revisionStateCorrupt();
  }
}

function parseNullableCurrentRef(
  value: unknown,
): TaskStrategyCurrentRef | null {
  return value === null ? null : parseTaskStrategyCurrentRef(value);
}

function currentRefPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.refs, 'task-strategy-current', `${sessionId}.json`);
}

function revisionDirectory(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  revisionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-red-revisions',
    sessionId,
    revisionId,
  );
}

function revisionRequestPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  revisionId: string,
): string {
  return path.join(
    revisionDirectory(paths, sessionId, revisionId),
    'request.json',
  );
}

function revisionJournalPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  revisionId: string,
): string {
  return path.join(
    revisionDirectory(paths, sessionId, revisionId),
    'journal.json',
  );
}

function isBaseline(
  value: unknown,
): value is TaskStrategyTransaction['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    isGitObjectId(value.head) &&
    isGitObjectId(value.tree)
  );
}

function isAuthor(value: unknown): value is TaskStrategyTransaction['author'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['providerId', 'assurance']) &&
    typeof value.providerId === 'string' &&
    isProviderId(value.providerId) &&
    (value.assurance === 'self-declared' ||
      value.assurance === 'runtime-hint' ||
      value.assurance === 'adapter-assigned')
  );
}

function assertRevisionId(value: string): string {
  if (!REVISION_ID.test(value)) throw revisionStateCorrupt();
  return value;
}

function isRevisionId(value: unknown): value is string {
  return typeof value === 'string' && REVISION_ID.test(value);
}

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

function isRevisionPhase(
  value: unknown,
): value is TaskStrategyRedRevisionPhase {
  return TASK_STRATEGY_RED_REVISION_PHASES.includes(
    value as TaskStrategyRedRevisionPhase,
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function revisionRequestInvalid() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
    'Task strategy RED revision input is malformed or unsafe.',
    ExitCode.usage,
  );
}

function revisionPhaseInvalid() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_PHASE_INVALID',
    'Task strategy RED revision journal cannot skip, repeat with changed data, or move backwards.',
    ExitCode.conflict,
  );
}

function revisionStateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT',
    'Task strategy RED revision state is malformed or unsafe.',
    ExitCode.staleState,
  );
}
