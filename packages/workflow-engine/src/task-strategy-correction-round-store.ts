import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
} from './investigation-session-store.ts';
import { assertSessionId, type InvestigationRuntimePaths } from './paths.ts';
import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  parseTaskStrategyCorrectionPolicy,
  parseTaskStrategyGreenFailureRecord,
  readTaskStrategyGreenFailureRecord,
  type TaskStrategyCorrectionPolicy,
  type TaskStrategyGreenFailureRecord,
  type TaskStrategyPatchHead,
} from './task-strategy-correction-store.ts';
import type { TaskStrategyPatchImplementer } from './task-strategy-patch-store.ts';
import { isProviderId } from './provider-registry.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INVESTIGATION_ID = /^investigation-[a-zA-Z0-9-]+$/u;
const INVOCATION_ID = /^invocation-[a-zA-Z0-9-]+$/u;
const ROUND_DIRECTORY = /^([0-9]{4})$/u;

export type TaskStrategyCorrectionFailureIdentity = Readonly<{
  recordDigest: string;
  subjectDigest: string;
  candidateTree: string;
  failureFingerprint: string;
  currentRedTransactionDigest: string;
  currentPatchHead: TaskStrategyPatchHead;
}>;

export type TaskStrategyCorrectionProviderRequestIdentity = Readonly<{
  ownerInvestigationId: string;
  invocationId: string;
  requestDigest: string;
}>;

export type TaskStrategyCorrectionProviderReservationIdentity = Readonly<{
  reservationDigest: string;
  authorizationNodeId: string;
  reservationNodeId: string;
}>;

export type TaskStrategyCorrectionProviderResultIdentity = Readonly<{
  bindingDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
}>;

export type TaskStrategyCorrectionProviderAttemptIdentity = Readonly<{
  attempt: number;
  attemptReservationDigest: string;
  invocationId: string;
  requestDigest: string;
}>;

export type TaskStrategyCorrectionCallerReservationIdentity = Readonly<{
  reservationDigest: string;
  grantId: string;
  transitionDigest: string;
  submissionNodeId: string;
  submissionResultDigest: string;
}>;

export type TaskStrategyCorrectionCallerResultIdentity = Readonly<{
  bindingDigest: string;
  resultNodeId: string;
  resultDigest: string;
  roleResultDigest: string;
  grantUseDigest: string;
}>;

/** The exact source-scoped transition from the failed candidate to this round. */
export type TaskStrategyCorrectionPatchResult = Readonly<{
  sourceTree: string;
  targetCandidateTree: string;
  patchRecordDigest: string;
  patchDigest: string;
}>;

export type TaskStrategyCorrectionReservationAuthority =
  | Readonly<{
      kind: 'provider';
      providerRequest: TaskStrategyCorrectionProviderRequestIdentity;
      providerReservation: TaskStrategyCorrectionProviderReservationIdentity;
    }>
  | Readonly<{
      kind: 'sealed-local';
      author: TaskStrategyPatchImplementer;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      callerReservation: TaskStrategyCorrectionCallerReservationIdentity;
    }>;

export type TaskStrategyCorrectionResultAuthority =
  | Readonly<{
      kind: 'provider';
      providerRequest: TaskStrategyCorrectionProviderRequestIdentity;
      providerReservation: TaskStrategyCorrectionProviderReservationIdentity;
      providerAttempt: TaskStrategyCorrectionProviderAttemptIdentity;
      providerResult: TaskStrategyCorrectionProviderResultIdentity;
    }>
  | Readonly<{
      kind: 'sealed-local';
      author: TaskStrategyPatchImplementer;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      callerReservation: TaskStrategyCorrectionCallerReservationIdentity;
      callerResult: TaskStrategyCorrectionCallerResultIdentity;
    }>;

export type TaskStrategyCorrectionImportReceiptIdentity = Readonly<{
  patchRecordDigest: string;
  patchDigest: string;
  receiptDigest: string;
  candidateTree: string;
}>;

export type TaskStrategyCorrectionRoundReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  round: number;
  policy: TaskStrategyCorrectionPolicy;
  policyDigest: string;
  predecessorFailure: TaskStrategyCorrectionFailureIdentity;
  correctionSubjectDigest: string;
  redSourceTree: string;
  authority: TaskStrategyCorrectionReservationAuthority;
  createdAt: string;
}>;

export type TaskStrategyCorrectionRoundResult = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-result.v1';
  resultDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  createdAt: string;
}>;

export type TaskStrategyCorrectionRoundImport = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-import.v1';
  importDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  importReceipt: TaskStrategyCorrectionImportReceiptIdentity;
  currentPatchHead: TaskStrategyPatchHead;
  importedAt: string;
}>;

export type TaskStrategyCorrectionRound = Readonly<{
  reservation: TaskStrategyCorrectionRoundReservation;
  result: TaskStrategyCorrectionRoundResult | null;
  importRecord: TaskStrategyCorrectionRoundImport | null;
}>;

export type TaskStrategyCorrectionState =
  | Readonly<{
      state: 'correction-required';
      round: number;
      nextAction: 'reserve';
    }>
  | Readonly<{
      state: 'correction-required';
      round: number;
      nextAction: 'publish-result' | 'publish-import-receipt';
      correctionSubjectDigest: string;
    }>
  | Readonly<{
      state: 'correction-exhausted';
      completedRounds: number;
      reason: 'max-repair-attempts' | 'same-failure-fingerprint';
      failureRecordDigest: string;
    }>;

export type ReserveTaskStrategyCorrectionRoundInput = Readonly<{
  sessionId: string;
  round: number;
  policy: TaskStrategyCorrectionPolicy;
  predecessorFailure: TaskStrategyGreenFailureRecord;
  /** Exact digest minted by createTaskStrategyCorrectionSubject. */
  correctionSubjectDigest: string;
  redSourceTree: string;
  authority: TaskStrategyCorrectionReservationAuthority;
  createdAt: string;
}>;

export type PublishTaskStrategyCorrectionRoundResultInput = Readonly<{
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  createdAt: string;
}>;

export type PublishTaskStrategyCorrectionRoundImportInput = Readonly<{
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  importReceipt: TaskStrategyCorrectionImportReceiptIdentity;
  currentPatchHead: TaskStrategyPatchHead;
  importedAt: string;
}>;

export function reserveTaskStrategyCorrectionRound(
  paths: InvestigationRuntimePaths,
  input: ReserveTaskStrategyCorrectionRoundInput,
): TaskStrategyCorrectionRoundReservation {
  const sessionId = assertSessionId(input.sessionId);
  const policy = parseTaskStrategyCorrectionPolicy(input.policy);
  if (
    !isPositiveInteger(input.round) ||
    input.round > policy.maxRepairAttempts
  ) {
    throw correctionRoundExhausted();
  }
  const failure = parseTaskStrategyGreenFailureRecord(input.predecessorFailure);
  if (
    failure.sessionId !== sessionId ||
    failure.currentRedTransactionDigest.length !== 64
  ) {
    throw correctionRoundStateInvalid();
  }
  const prepared = prepareReservation({
    ...input,
    sessionId,
    policy,
    predecessorFailure: failure,
  });
  return withCorrectionRoundLock(
    paths,
    sessionId,
    failure.currentRedTransactionDigest,
    () => {
      assertStoredFailure(paths, failure);
      const rounds = listTaskStrategyCorrectionRounds(
        paths,
        sessionId,
        failure.currentRedTransactionDigest,
      );
      const existing = rounds[input.round - 1]?.reservation ?? null;
      if (existing !== null) {
        if (
          sameExceptAudit(existing, prepared, [
            'reservationDigest',
            'createdAt',
          ])
        ) {
          return existing;
        }
        throw correctionRoundReservationConflict();
      }
      if (input.round !== rounds.length + 1) {
        throw correctionRoundSequenceInvalid();
      }
      assertRoundCanFollow(rounds, prepared);
      if (
        rounds.filter(
          ({ reservation }) =>
            reservation.predecessorFailure.failureFingerprint ===
            failure.failingCheck.failureFingerprint,
        ).length >= policy.maxSameFailureFingerprint
      ) {
        throw correctionRoundExhausted();
      }
      createPrivateCanonicalJson(
        paths,
        reservationPath(
          paths,
          sessionId,
          failure.currentRedTransactionDigest,
          input.round,
        ),
        prepared,
        correctionRoundStateInvalid,
        'TASK_STRATEGY_CORRECTION_ROUND_RESERVATION_CONFLICT',
      );
      const stored = readTaskStrategyCorrectionRound(
        paths,
        sessionId,
        failure.currentRedTransactionDigest,
        input.round,
      )?.reservation;
      if (stored === undefined) throw correctionRoundStateInvalid();
      return stored;
    },
  );
}

export function publishTaskStrategyCorrectionRoundResult(
  paths: InvestigationRuntimePaths,
  input: PublishTaskStrategyCorrectionRoundResultInput,
): TaskStrategyCorrectionRoundResult {
  const sessionId = assertSessionId(input.sessionId);
  const redTransactionDigest = assertDigest(input.currentRedTransactionDigest);
  const round = assertRound(input.round);
  return withCorrectionRoundLock(paths, sessionId, redTransactionDigest, () => {
    const snapshot = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    );
    if (snapshot === null || snapshot.importRecord !== null) {
      throw correctionRoundSequenceInvalid();
    }
    const prepared = prepareResult(snapshot.reservation, input);
    if (snapshot.result !== null) {
      if (
        sameExceptAudit(snapshot.result, prepared, [
          'resultDigest',
          'createdAt',
        ])
      ) {
        return snapshot.result;
      }
      throw correctionRoundResultConflict();
    }
    createPrivateCanonicalJson(
      paths,
      resultPath(paths, sessionId, redTransactionDigest, round),
      prepared,
      correctionRoundStateInvalid,
      'TASK_STRATEGY_CORRECTION_ROUND_RESULT_CONFLICT',
    );
    const stored = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    )?.result;
    if (stored === undefined || stored === null) {
      throw correctionRoundStateInvalid();
    }
    return stored;
  });
}

export function publishTaskStrategyCorrectionRoundImport(
  paths: InvestigationRuntimePaths,
  input: PublishTaskStrategyCorrectionRoundImportInput,
): TaskStrategyCorrectionRoundImport {
  const sessionId = assertSessionId(input.sessionId);
  const redTransactionDigest = assertDigest(input.currentRedTransactionDigest);
  const round = assertRound(input.round);
  return withCorrectionRoundLock(paths, sessionId, redTransactionDigest, () => {
    const snapshot = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    );
    if (snapshot === null || snapshot.result === null) {
      throw correctionRoundSequenceInvalid();
    }
    const prepared = prepareImport(
      snapshot.reservation,
      snapshot.result,
      input,
    );
    if (snapshot.importRecord !== null) {
      if (
        sameExceptAudit(snapshot.importRecord, prepared, [
          'importDigest',
          'importedAt',
        ])
      ) {
        return snapshot.importRecord;
      }
      throw correctionRoundImportConflict();
    }
    createPrivateCanonicalJson(
      paths,
      importPath(paths, sessionId, redTransactionDigest, round),
      prepared,
      correctionRoundStateInvalid,
      'TASK_STRATEGY_CORRECTION_ROUND_IMPORT_CONFLICT',
    );
    const stored = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    )?.importRecord;
    if (stored === undefined || stored === null) {
      throw correctionRoundStateInvalid();
    }
    return stored;
  });
}

export function readTaskStrategyCorrectionRound(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRedTransactionDigest: string,
  requestedRound: number,
): TaskStrategyCorrectionRound | null {
  const sessionId = assertSessionId(requestedSessionId);
  const redTransactionDigest = assertDigest(requestedRedTransactionDigest);
  const round = assertRound(requestedRound);
  const target = roundDirectory(paths, sessionId, redTransactionDigest, round);
  const observed = fs.lstatSync(target, { throwIfNoEntry: false });
  if (observed === undefined) return null;
  assertPrivateInvestigationDirectory(
    paths,
    target,
    correctionRoundStateInvalid,
  );
  const names = listRoundArtifactNames(target);
  const reservation = parseReservation(
    readPrivateCanonicalJson(
      paths,
      reservationPath(paths, sessionId, redTransactionDigest, round),
      correctionRoundStateInvalid,
    ),
  );
  const result = names.includes('result.json')
    ? parseResult(
        readPrivateCanonicalJson(
          paths,
          resultPath(paths, sessionId, redTransactionDigest, round),
          correctionRoundStateInvalid,
        ),
      )
    : null;
  const importRecord = names.includes('import.json')
    ? parseImport(
        readPrivateCanonicalJson(
          paths,
          importPath(paths, sessionId, redTransactionDigest, round),
          correctionRoundStateInvalid,
        ),
      )
    : null;
  assertSnapshotLinks(
    { reservation, result, importRecord },
    sessionId,
    redTransactionDigest,
    round,
  );
  return deepFreeze({ reservation, result, importRecord });
}

export function listTaskStrategyCorrectionRounds(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRedTransactionDigest: string,
): readonly TaskStrategyCorrectionRound[] {
  const sessionId = assertSessionId(requestedSessionId);
  const redTransactionDigest = assertDigest(requestedRedTransactionDigest);
  const directory = lineageDirectory(paths, sessionId, redTransactionDigest);
  const observed = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (observed === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(
    paths,
    directory,
    correctionRoundStateInvalid,
  );
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    entries.some(
      (entry) =>
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !ROUND_DIRECTORY.test(entry.name),
    )
  ) {
    throw correctionRoundStateInvalid();
  }
  const rounds = entries.map((entry, index) => {
    const observedRound = Number(ROUND_DIRECTORY.exec(entry.name)?.[1]);
    if (observedRound !== index + 1) throw correctionRoundStateInvalid();
    const snapshot = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      observedRound,
    );
    if (snapshot === null) throw correctionRoundStateInvalid();
    return snapshot;
  });
  assertContiguousRoundLineage(rounds);
  return deepFreeze(rounds);
}

export function deriveTaskStrategyCorrectionState(
  paths: InvestigationRuntimePaths,
  currentFailureValue: TaskStrategyGreenFailureRecord,
  requestedPolicy: TaskStrategyCorrectionPolicy,
): TaskStrategyCorrectionState {
  const currentFailure =
    parseTaskStrategyGreenFailureRecord(currentFailureValue);
  const policy = parseTaskStrategyCorrectionPolicy(requestedPolicy);
  assertStoredFailure(paths, currentFailure);
  const rounds = listTaskStrategyCorrectionRounds(
    paths,
    currentFailure.sessionId,
    currentFailure.currentRedTransactionDigest,
  );
  if (rounds.length === 0) {
    return deepFreeze({
      state: 'correction-required',
      round: 1,
      nextAction: 'reserve',
    });
  }
  if (
    rounds.some(
      ({ reservation }) => reservation.policyDigest !== policyDigest(policy),
    )
  ) {
    throw correctionRoundStateInvalid();
  }
  const latest = rounds.at(-1)!;
  if (latest.importRecord === null) {
    if (
      !failureIdentityMatches(
        latest.reservation.predecessorFailure,
        currentFailure,
      )
    ) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      state: 'correction-required',
      round: latest.reservation.round,
      nextAction:
        latest.result === null ? 'publish-result' : 'publish-import-receipt',
      correctionSubjectDigest: latest.reservation.correctionSubjectDigest,
    });
  }
  if (
    latest.importRecord.patchResult.targetCandidateTree !==
      currentFailure.candidateTree ||
    canonicalJson(latest.importRecord.currentPatchHead) !==
      canonicalJson(currentFailure.currentPatchHead)
  ) {
    throw correctionRoundStateInvalid();
  }
  const sameFingerprintAttempts = rounds.filter(
    ({ reservation }) =>
      reservation.predecessorFailure.failureFingerprint ===
      currentFailure.failingCheck.failureFingerprint,
  ).length;
  if (sameFingerprintAttempts >= policy.maxSameFailureFingerprint) {
    return deepFreeze({
      state: 'correction-exhausted',
      completedRounds: rounds.length,
      reason: 'same-failure-fingerprint',
      failureRecordDigest: currentFailure.recordDigest,
    });
  }
  if (rounds.length >= policy.maxRepairAttempts) {
    return deepFreeze({
      state: 'correction-exhausted',
      completedRounds: rounds.length,
      reason: 'max-repair-attempts',
      failureRecordDigest: currentFailure.recordDigest,
    });
  }
  return deepFreeze({
    state: 'correction-required',
    round: rounds.length + 1,
    nextAction: 'reserve',
  });
}

function prepareReservation(
  input: ReserveTaskStrategyCorrectionRoundInput & {
    policy: TaskStrategyCorrectionPolicy;
    predecessorFailure: TaskStrategyGreenFailureRecord;
  },
): TaskStrategyCorrectionRoundReservation {
  const predecessorFailure = failureIdentity(input.predecessorFailure);
  const digestOfPolicy = policyDigest(input.policy);
  const correctionSubjectDigest = assertDigest(input.correctionSubjectDigest);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-reservation.v1' as const,
    sessionId: input.sessionId,
    round: input.round,
    policy: input.policy,
    policyDigest: digestOfPolicy,
    predecessorFailure,
    correctionSubjectDigest,
    redSourceTree: input.redSourceTree,
    authority: parseReservationAuthority(input.authority),
    createdAt: input.createdAt,
  };
  return parseReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
}

function prepareResult(
  reservation: TaskStrategyCorrectionRoundReservation,
  input: PublishTaskStrategyCorrectionRoundResultInput,
): TaskStrategyCorrectionRoundResult {
  if (
    input.sessionId !== reservation.sessionId ||
    input.currentRedTransactionDigest !==
      reservation.predecessorFailure.currentRedTransactionDigest ||
    input.round !== reservation.round ||
    input.correctionSubjectDigest !== reservation.correctionSubjectDigest ||
    input.patchResult.sourceTree !==
      reservation.predecessorFailure.candidateTree ||
    input.patchResult.targetCandidateTree ===
      reservation.predecessorFailure.candidateTree
  ) {
    throw correctionRoundStateInvalid();
  }
  const authority = parseResultAuthority(input.authority);
  assertResultAuthorityMatchesReservation(authority, reservation.authority);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-result.v1' as const,
    sessionId: input.sessionId,
    currentRedTransactionDigest: input.currentRedTransactionDigest,
    round: input.round,
    correctionSubjectDigest: input.correctionSubjectDigest,
    authority,
    patchResult: input.patchResult,
    createdAt: input.createdAt,
  };
  return parseResult({
    ...body,
    resultDigest: sha256(canonicalJson(body)),
  });
}

function prepareImport(
  reservation: TaskStrategyCorrectionRoundReservation,
  result: TaskStrategyCorrectionRoundResult,
  input: PublishTaskStrategyCorrectionRoundImportInput,
): TaskStrategyCorrectionRoundImport {
  if (
    input.sessionId !== reservation.sessionId ||
    input.currentRedTransactionDigest !==
      reservation.predecessorFailure.currentRedTransactionDigest ||
    input.round !== reservation.round ||
    input.correctionSubjectDigest !== reservation.correctionSubjectDigest ||
    canonicalJson(input.importReceipt) !==
      canonicalJson({
        patchRecordDigest: result.patchResult.patchRecordDigest,
        patchDigest: result.patchResult.patchDigest,
        receiptDigest: input.currentPatchHead.receiptDigest,
        candidateTree: result.patchResult.targetCandidateTree,
      }) ||
    input.currentPatchHead.recordDigest !==
      result.patchResult.patchRecordDigest ||
    input.currentPatchHead.patchDigest !== result.patchResult.patchDigest
  ) {
    throw correctionRoundStateInvalid();
  }
  const authority = parseResultAuthority(input.authority);
  if (canonicalJson(authority) !== canonicalJson(result.authority)) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-import.v1' as const,
    sessionId: input.sessionId,
    currentRedTransactionDigest: input.currentRedTransactionDigest,
    round: input.round,
    correctionSubjectDigest: input.correctionSubjectDigest,
    authority,
    patchResult: result.patchResult,
    importReceipt: input.importReceipt,
    currentPatchHead: input.currentPatchHead,
    importedAt: input.importedAt,
  };
  return parseImport({
    ...body,
    importDigest: sha256(canonicalJson(body)),
  });
}

function parseReservation(
  value: unknown,
): TaskStrategyCorrectionRoundReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'sessionId',
      'round',
      'policy',
      'policyDigest',
      'predecessorFailure',
      'correctionSubjectDigest',
      'redSourceTree',
      'authority',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-correction-round-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isPositiveInteger(value.round) ||
    !isDigest(value.policyDigest) ||
    !isDigest(value.correctionSubjectDigest) ||
    !isGitObjectId(value.redSourceTree) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw correctionRoundStateInvalid();
  }
  const policy = parsePolicyForStore(value.policy);
  const predecessorFailure = parseFailureIdentity(value.predecessorFailure);
  const authority = parseReservationAuthority(value.authority);
  if (
    value.round > policy.maxRepairAttempts ||
    value.policyDigest !== policyDigest(policy) ||
    predecessorFailure.currentRedTransactionDigest.length !== 64
  ) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-reservation.v1' as const,
    sessionId: value.sessionId,
    round: value.round,
    policy,
    policyDigest: value.policyDigest,
    predecessorFailure,
    correctionSubjectDigest: value.correctionSubjectDigest,
    redSourceTree: value.redSourceTree,
    authority,
    createdAt: value.createdAt,
  };
  if (value.reservationDigest !== sha256(canonicalJson(body))) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({ ...body, reservationDigest: value.reservationDigest });
}

function parseResult(value: unknown): TaskStrategyCorrectionRoundResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'resultDigest',
      'sessionId',
      'currentRedTransactionDigest',
      'round',
      'correctionSubjectDigest',
      'authority',
      'patchResult',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-correction-round-result.v1' ||
    !isDigest(value.resultDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isDigest(value.currentRedTransactionDigest) ||
    !isPositiveInteger(value.round) ||
    !isDigest(value.correctionSubjectDigest) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-result.v1' as const,
    sessionId: value.sessionId,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    round: value.round,
    correctionSubjectDigest: value.correctionSubjectDigest,
    authority: parseResultAuthority(value.authority),
    patchResult: parsePatchResult(value.patchResult),
    createdAt: value.createdAt,
  };
  if (value.resultDigest !== sha256(canonicalJson(body))) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({ ...body, resultDigest: value.resultDigest });
}

function parseImport(value: unknown): TaskStrategyCorrectionRoundImport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'importDigest',
      'sessionId',
      'currentRedTransactionDigest',
      'round',
      'correctionSubjectDigest',
      'authority',
      'patchResult',
      'importReceipt',
      'currentPatchHead',
      'importedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-correction-round-import.v1' ||
    !isDigest(value.importDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isDigest(value.currentRedTransactionDigest) ||
    !isPositiveInteger(value.round) ||
    !isDigest(value.correctionSubjectDigest) ||
    !isCanonicalTimestamp(value.importedAt)
  ) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-import.v1' as const,
    sessionId: value.sessionId,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    round: value.round,
    correctionSubjectDigest: value.correctionSubjectDigest,
    authority: parseResultAuthority(value.authority),
    patchResult: parsePatchResult(value.patchResult),
    importReceipt: parseImportReceipt(value.importReceipt),
    currentPatchHead: parsePatchHead(value.currentPatchHead),
    importedAt: value.importedAt,
  };
  if (value.importDigest !== sha256(canonicalJson(body))) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({ ...body, importDigest: value.importDigest });
}

function assertSnapshotLinks(
  snapshot: TaskStrategyCorrectionRound,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): void {
  const { reservation, result, importRecord } = snapshot;
  if (
    reservation.sessionId !== sessionId ||
    reservation.round !== round ||
    reservation.predecessorFailure.currentRedTransactionDigest !==
      redTransactionDigest
  ) {
    throw correctionRoundStateInvalid();
  }
  if (
    result !== null &&
    (result.sessionId !== sessionId ||
      result.currentRedTransactionDigest !== redTransactionDigest ||
      result.round !== round ||
      result.correctionSubjectDigest !== reservation.correctionSubjectDigest ||
      !resultAuthorityMatchesReservation(
        result.authority,
        reservation.authority,
      ) ||
      result.patchResult.sourceTree !==
        reservation.predecessorFailure.candidateTree ||
      result.patchResult.targetCandidateTree ===
        reservation.predecessorFailure.candidateTree)
  ) {
    throw correctionRoundStateInvalid();
  }
  if (importRecord !== null && result === null) {
    throw correctionRoundStateInvalid();
  }
  if (
    importRecord !== null &&
    result !== null &&
    (importRecord.sessionId !== sessionId ||
      importRecord.currentRedTransactionDigest !== redTransactionDigest ||
      importRecord.round !== round ||
      importRecord.correctionSubjectDigest !==
        reservation.correctionSubjectDigest ||
      canonicalJson(importRecord.authority) !==
        canonicalJson(result.authority) ||
      canonicalJson(importRecord.patchResult) !==
        canonicalJson(result.patchResult) ||
      importRecord.importReceipt.patchRecordDigest !==
        result.patchResult.patchRecordDigest ||
      importRecord.importReceipt.patchDigest !==
        result.patchResult.patchDigest ||
      importRecord.importReceipt.candidateTree !==
        result.patchResult.targetCandidateTree ||
      importRecord.currentPatchHead.recordDigest !==
        result.patchResult.patchRecordDigest ||
      importRecord.currentPatchHead.patchDigest !==
        result.patchResult.patchDigest ||
      importRecord.currentPatchHead.receiptDigest !==
        importRecord.importReceipt.receiptDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
}

function assertContiguousRoundLineage(
  rounds: readonly TaskStrategyCorrectionRound[],
): void {
  for (let index = 0; index < rounds.length; index += 1) {
    const current = rounds[index]!;
    if (current.reservation.round !== index + 1) {
      throw correctionRoundStateInvalid();
    }
    if (index === 0) continue;
    const previous = rounds[index - 1]!;
    if (
      previous.importRecord === null ||
      current.reservation.policyDigest !==
        rounds[0]!.reservation.policyDigest ||
      current.reservation.redSourceTree !==
        rounds[0]!.reservation.redSourceTree ||
      current.reservation.predecessorFailure.candidateTree !==
        previous.importRecord.patchResult.targetCandidateTree ||
      canonicalJson(current.reservation.predecessorFailure.currentPatchHead) !==
        canonicalJson(previous.importRecord.currentPatchHead)
    ) {
      throw correctionRoundStateInvalid();
    }
  }
}

function assertRoundCanFollow(
  rounds: readonly TaskStrategyCorrectionRound[],
  prepared: TaskStrategyCorrectionRoundReservation,
): void {
  if (rounds.length === 0) return;
  const first = rounds[0]!.reservation;
  const previous = rounds.at(-1)!;
  if (
    previous.importRecord === null ||
    prepared.policyDigest !== first.policyDigest ||
    prepared.redSourceTree !== first.redSourceTree ||
    prepared.predecessorFailure.candidateTree !==
      previous.importRecord.patchResult.targetCandidateTree ||
    canonicalJson(prepared.predecessorFailure.currentPatchHead) !==
      canonicalJson(previous.importRecord.currentPatchHead)
  ) {
    throw correctionRoundSequenceInvalid();
  }
}

function assertStoredFailure(
  paths: InvestigationRuntimePaths,
  failure: TaskStrategyGreenFailureRecord,
): void {
  const stored = readTaskStrategyGreenFailureRecord(
    paths,
    failure.sessionId,
    failure.candidateTree,
  );
  if (stored === null || stored.recordDigest !== failure.recordDigest) {
    throw correctionRoundStateInvalid();
  }
}

function failureIdentity(
  failure: TaskStrategyGreenFailureRecord,
): TaskStrategyCorrectionFailureIdentity {
  return deepFreeze({
    recordDigest: failure.recordDigest,
    subjectDigest: failure.subjectDigest,
    candidateTree: failure.candidateTree,
    failureFingerprint: failure.failingCheck.failureFingerprint,
    currentRedTransactionDigest: failure.currentRedTransactionDigest,
    currentPatchHead: failure.currentPatchHead,
  });
}

function failureIdentityMatches(
  identity: TaskStrategyCorrectionFailureIdentity,
  failure: TaskStrategyGreenFailureRecord,
): boolean {
  return canonicalJson(identity) === canonicalJson(failureIdentity(failure));
}

function parseFailureIdentity(
  value: unknown,
): TaskStrategyCorrectionFailureIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'recordDigest',
      'subjectDigest',
      'candidateTree',
      'failureFingerprint',
      'currentRedTransactionDigest',
      'currentPatchHead',
    ]) ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.subjectDigest) ||
    !isGitObjectId(value.candidateTree) ||
    !isDigest(value.failureFingerprint) ||
    !isDigest(value.currentRedTransactionDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    recordDigest: value.recordDigest,
    subjectDigest: value.subjectDigest,
    candidateTree: value.candidateTree,
    failureFingerprint: value.failureFingerprint,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    currentPatchHead: parsePatchHead(value.currentPatchHead),
  });
}

function parseProviderRequest(
  value: unknown,
): TaskStrategyCorrectionProviderRequestIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'ownerInvestigationId',
      'invocationId',
      'requestDigest',
    ]) ||
    typeof value.ownerInvestigationId !== 'string' ||
    !INVESTIGATION_ID.test(value.ownerInvestigationId) ||
    typeof value.invocationId !== 'string' ||
    !INVOCATION_ID.test(value.invocationId) ||
    !isDigest(value.requestDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    ownerInvestigationId: value.ownerInvestigationId,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
  });
}

function parseProviderReservation(
  value: unknown,
): TaskStrategyCorrectionProviderReservationIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'reservationDigest',
      'authorizationNodeId',
      'reservationNodeId',
    ]) ||
    !isDigest(value.reservationDigest) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    reservationDigest: value.reservationDigest,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
  });
}

function parseProviderResult(
  value: unknown,
): TaskStrategyCorrectionProviderResultIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bindingDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'providerResultNodeId',
      'providerResultDigest',
    ]) ||
    !isDigest(value.bindingDigest) ||
    typeof value.invocationId !== 'string' ||
    !INVOCATION_ID.test(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    bindingDigest: value.bindingDigest,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
  });
}

function parseProviderAttempt(
  value: unknown,
): TaskStrategyCorrectionProviderAttemptIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempt',
      'attemptReservationDigest',
      'invocationId',
      'requestDigest',
    ]) ||
    !isPositiveInteger(value.attempt) ||
    !isDigest(value.attemptReservationDigest) ||
    typeof value.invocationId !== 'string' ||
    !INVOCATION_ID.test(value.invocationId) ||
    !isDigest(value.requestDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    attempt: value.attempt,
    attemptReservationDigest: value.attemptReservationDigest,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
  });
}

function parseCallerReservation(
  value: unknown,
): TaskStrategyCorrectionCallerReservationIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'reservationDigest',
      'grantId',
      'transitionDigest',
      'submissionNodeId',
      'submissionResultDigest',
    ]) ||
    !isDigest(value.reservationDigest) ||
    typeof value.grantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.grantId,
    ) ||
    !isDigest(value.transitionDigest) ||
    !isDigest(value.submissionNodeId) ||
    !isDigest(value.submissionResultDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    reservationDigest: value.reservationDigest,
    grantId: value.grantId,
    transitionDigest: value.transitionDigest,
    submissionNodeId: value.submissionNodeId,
    submissionResultDigest: value.submissionResultDigest,
  });
}

function parseCallerResult(
  value: unknown,
): TaskStrategyCorrectionCallerResultIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bindingDigest',
      'resultNodeId',
      'resultDigest',
      'roleResultDigest',
      'grantUseDigest',
    ]) ||
    !isDigest(value.bindingDigest) ||
    !isDigest(value.resultNodeId) ||
    !isDigest(value.resultDigest) ||
    !isDigest(value.roleResultDigest) ||
    !isDigest(value.grantUseDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    bindingDigest: value.bindingDigest,
    resultNodeId: value.resultNodeId,
    resultDigest: value.resultDigest,
    roleResultDigest: value.roleResultDigest,
    grantUseDigest: value.grantUseDigest,
  });
}

function parseReservationAuthority(
  value: unknown,
): TaskStrategyCorrectionReservationAuthority {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw correctionRoundStateInvalid();
  }
  if (value.kind === 'provider') {
    if (
      !hasExactKeys(value, ['kind', 'providerRequest', 'providerReservation'])
    ) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'provider' as const,
      providerRequest: parseProviderRequest(value.providerRequest),
      providerReservation: parseProviderReservation(value.providerReservation),
    });
  }
  if (value.kind === 'caller-supplied') {
    if (!hasExactKeys(value, ['kind', 'callerReservation'])) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'caller-supplied' as const,
      callerReservation: parseCallerReservation(value.callerReservation),
    });
  }
  if (
    value.kind !== 'sealed-local' ||
    !hasExactKeys(value, ['kind', 'author'])
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    kind: 'sealed-local' as const,
    author: parsePatchImplementer(value.author),
  });
}

function parseResultAuthority(
  value: unknown,
): TaskStrategyCorrectionResultAuthority {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw correctionRoundStateInvalid();
  }
  if (value.kind === 'provider') {
    if (
      !hasExactKeys(value, [
        'kind',
        'providerRequest',
        'providerReservation',
        'providerAttempt',
        'providerResult',
      ])
    ) {
      throw correctionRoundStateInvalid();
    }
    const providerRequest = parseProviderRequest(value.providerRequest);
    const providerAttempt = parseProviderAttempt(value.providerAttempt);
    const providerResult = parseProviderResult(value.providerResult);
    if (
      providerResult.invocationId !== providerAttempt.invocationId ||
      providerResult.requestDigest !== providerAttempt.requestDigest
    ) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'provider' as const,
      providerRequest,
      providerReservation: parseProviderReservation(value.providerReservation),
      providerAttempt,
      providerResult,
    });
  }
  if (value.kind === 'caller-supplied') {
    if (!hasExactKeys(value, ['kind', 'callerReservation', 'callerResult'])) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'caller-supplied' as const,
      callerReservation: parseCallerReservation(value.callerReservation),
      callerResult: parseCallerResult(value.callerResult),
    });
  }
  if (
    value.kind !== 'sealed-local' ||
    !hasExactKeys(value, ['kind', 'author'])
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    kind: 'sealed-local' as const,
    author: parsePatchImplementer(value.author),
  });
}

function assertResultAuthorityMatchesReservation(
  result: TaskStrategyCorrectionResultAuthority,
  reservation: TaskStrategyCorrectionReservationAuthority,
): void {
  if (!resultAuthorityMatchesReservation(result, reservation)) {
    throw correctionRoundStateInvalid();
  }
}

function resultAuthorityMatchesReservation(
  result: TaskStrategyCorrectionResultAuthority,
  reservation: TaskStrategyCorrectionReservationAuthority,
): boolean {
  if (result.kind !== reservation.kind) return false;
  if (result.kind === 'sealed-local') {
    return (
      reservation.kind === 'sealed-local' &&
      canonicalJson(result.author) === canonicalJson(reservation.author)
    );
  }
  if (result.kind === 'caller-supplied') {
    return (
      reservation.kind === 'caller-supplied' &&
      canonicalJson(result.callerReservation) ===
        canonicalJson(reservation.callerReservation)
    );
  }
  return (
    reservation.kind === 'provider' &&
    canonicalJson(result.providerRequest) ===
      canonicalJson(reservation.providerRequest) &&
    canonicalJson(result.providerReservation) ===
      canonicalJson(reservation.providerReservation)
  );
}

function parsePatchImplementer(value: unknown): TaskStrategyPatchImplementer {
  if (!isRecord(value)) throw correctionRoundStateInvalid();
  if (
    hasExactKeys(value, ['providerId', 'assurance']) &&
    typeof value.providerId === 'string' &&
    isProviderId(value.providerId) &&
    isActorAssurance(value.assurance)
  ) {
    return deepFreeze({
      providerId: value.providerId,
      assurance: value.assurance,
    });
  }
  if (
    !hasExactKeys(value, [
      'providerId',
      'principalId',
      'assurance',
      'degradedForm',
      'grantId',
    ]) ||
    value.providerId !== null ||
    typeof value.principalId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(value.principalId) ||
    !isActorAssurance(value.assurance) ||
    value.degradedForm !== 'caller-supplied' ||
    typeof value.grantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.grantId,
    )
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    providerId: null,
    principalId: value.principalId,
    assurance: value.assurance,
    degradedForm: 'caller-supplied' as const,
    grantId: value.grantId,
  });
}

function isActorAssurance(
  value: unknown,
): value is 'self-declared' | 'runtime-hint' | 'adapter-assigned' {
  return (
    value === 'self-declared' ||
    value === 'runtime-hint' ||
    value === 'adapter-assigned'
  );
}

function parsePatchResult(value: unknown): TaskStrategyCorrectionPatchResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceTree',
      'targetCandidateTree',
      'patchRecordDigest',
      'patchDigest',
    ]) ||
    !isGitObjectId(value.sourceTree) ||
    !isGitObjectId(value.targetCandidateTree) ||
    value.sourceTree === value.targetCandidateTree ||
    !isDigest(value.patchRecordDigest) ||
    !isDigest(value.patchDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    sourceTree: value.sourceTree,
    targetCandidateTree: value.targetCandidateTree,
    patchRecordDigest: value.patchRecordDigest,
    patchDigest: value.patchDigest,
  });
}

function parseImportReceipt(
  value: unknown,
): TaskStrategyCorrectionImportReceiptIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'patchRecordDigest',
      'patchDigest',
      'receiptDigest',
      'candidateTree',
    ]) ||
    !isDigest(value.patchRecordDigest) ||
    !isDigest(value.patchDigest) ||
    !isDigest(value.receiptDigest) ||
    !isGitObjectId(value.candidateTree)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    patchRecordDigest: value.patchRecordDigest,
    patchDigest: value.patchDigest,
    receiptDigest: value.receiptDigest,
    candidateTree: value.candidateTree,
  });
}

function parsePatchHead(value: unknown): TaskStrategyPatchHead {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bindingDigest',
      'recordDigest',
      'patchDigest',
      'receiptDigest',
    ]) ||
    !isDigest(value.bindingDigest) ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.patchDigest) ||
    !isDigest(value.receiptDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    bindingDigest: value.bindingDigest,
    recordDigest: value.recordDigest,
    patchDigest: value.patchDigest,
    receiptDigest: value.receiptDigest,
  });
}

function parsePolicyForStore(value: unknown): TaskStrategyCorrectionPolicy {
  try {
    return parseTaskStrategyCorrectionPolicy(value);
  } catch {
    throw correctionRoundStateInvalid();
  }
}

function policyDigest(policy: TaskStrategyCorrectionPolicy): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-strategy-correction-policy.v1',
      policy,
    }),
  );
}

function listRoundArtifactNames(directory: string): readonly string[] {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    throw correctionRoundStateInvalid();
  }
  const names = entries.map(({ name }) => name);
  const valid = [
    ['reservation.json'],
    ['reservation.json', 'result.json'],
    ['import.json', 'reservation.json', 'result.json'],
  ];
  if (
    !valid.some((expected) => canonicalJson(expected) === canonicalJson(names))
  ) {
    throw correctionRoundStateInvalid();
  }
  return Object.freeze(names);
}

function withCorrectionRoundLock<T>(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(
      paths.locks,
      'task-strategy-correction-rounds',
      `${sessionId}-${redTransactionDigest}.lock`,
    ),
    operation,
    'TASK_STRATEGY_CORRECTION_ROUND_BUSY',
    correctionRoundStateInvalid,
  );
}

function lineageDirectory(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-correction-rounds',
    sessionId,
    redTransactionDigest,
  );
}

function roundDirectory(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    lineageDirectory(paths, sessionId, redTransactionDigest),
    String(round).padStart(4, '0'),
  );
}

function reservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    roundDirectory(paths, sessionId, redTransactionDigest, round),
    'reservation.json',
  );
}

function resultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    roundDirectory(paths, sessionId, redTransactionDigest, round),
    'result.json',
  );
}

function importPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    roundDirectory(paths, sessionId, redTransactionDigest, round),
    'import.json',
  );
}

function sameExceptAudit(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  omittedKeys: readonly string[],
): boolean {
  const omit = new Set(omittedKeys);
  return (
    canonicalJson(
      Object.fromEntries(
        Object.entries(left).filter(([key]) => !omit.has(key)),
      ),
    ) ===
    canonicalJson(
      Object.fromEntries(
        Object.entries(right).filter(([key]) => !omit.has(key)),
      ),
    )
  );
}

function assertRound(value: number): number {
  if (
    !isPositiveInteger(value) ||
    value > DEFAULT_TASK_STRATEGY_CORRECTION_POLICY.maxRepairAttempts
  ) {
    throw correctionRoundStateInvalid();
  }
  return value;
}

function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw correctionRoundStateInvalid();
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function correctionRoundStateInvalid() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_STATE_INVALID',
    'Task-strategy correction-round state is invalid, stale, or unsafe.',
    ExitCode.staleState,
  );
}

function correctionRoundSequenceInvalid() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_SEQUENCE_INVALID',
    'Task-strategy correction rounds must be contiguous and each prior round must have an exact import receipt.',
    ExitCode.guard,
  );
}

function correctionRoundExhausted() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_EXHAUSTED',
    'The bounded task-strategy correction policy is exhausted.',
    ExitCode.guard,
  );
}

function correctionRoundReservationConflict() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_RESERVATION_CONFLICT',
    'A different immutable reservation already exists for this correction round.',
    ExitCode.conflict,
  );
}

function correctionRoundResultConflict() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_RESULT_CONFLICT',
    'A different immutable provider result already exists for this correction round.',
    ExitCode.conflict,
  );
}

function correctionRoundImportConflict() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_IMPORT_CONFLICT',
    'A different immutable import receipt already exists for this correction round.',
    ExitCode.conflict,
  );
}
