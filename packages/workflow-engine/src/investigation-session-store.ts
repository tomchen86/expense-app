import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, type WorkflowError, workflowError } from './errors.ts';
import type { InvestigationDispositionInput } from './investigation-groups.ts';
import type { InvestigationWhyAnswer } from './investigation-why.ts';
import {
  INVESTIGATION_LIMITS,
  previewInvestigationTermUnion,
  type InvestigationMainTermInput,
  type InvestigationTermKind,
} from './investigation-terms.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  type InvestigationRuntimePaths,
} from './paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHECKPOINT_ID = /^checkpoint-[0-9a-f]{64}$/;
const MAX_CHECKPOINT_BYTES = 1_048_576;
const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export type InvestigationSessionState =
  | 'actor-resolution-required'
  | 'human-action-required'
  | 'awaiting-main-terms'
  | 'waiting-for-provider'
  | 'awaiting-group-dispositions'
  | 'awaiting-ledger-answers'
  | 'investigation-sealed';

export type InvestigationCheckpointKind =
  'main-terms' | 'group-dispositions' | 'why-answers';

export type MainTermsPayload = {
  reference: string;
  terms: InvestigationMainTermInput[];
};

export type GroupDispositionsPayload = {
  dispositions: InvestigationDispositionInput[];
};

export type WhyAnswersPayload = {
  answers: InvestigationWhyAnswer[];
};

export type InvestigationCheckpointEnvelope =
  | InvestigationCheckpointEnvelopeBase<'main-terms', MainTermsPayload>
  | InvestigationCheckpointEnvelopeBase<
      'group-dispositions',
      GroupDispositionsPayload
    >
  | InvestigationCheckpointEnvelopeBase<'why-answers', WhyAnswersPayload>;

type InvestigationCheckpointEnvelopeBase<
  Kind extends InvestigationCheckpointKind,
  Payload,
> = {
  schemaVersion: 1;
  kind: Kind;
  checkpointId: string;
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  payload: Payload;
};

export type StoredInvestigationCheckpoint = {
  envelopeDigest: string;
  contributionDigest: string;
  envelope: InvestigationCheckpointEnvelope;
};

export type BlindResultReference = {
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
};

export type InvestigationSession = {
  schemaVersion: 1;
  investigationId: string;
  revision: number;
  state: InvestigationSessionState;
  changeId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string | null;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  blindRequestDigest: string;
  blindInvocationIds: string[];
  currentBlindInvocationId: string;
  milestones: {
    mainTerms: StoredInvestigationCheckpoint | null;
    blindResult: BlindResultReference | null;
    groupDispositions: StoredInvestigationCheckpoint | null;
    whyAnswers: StoredInvestigationCheckpoint | null;
  };
  blocker: {
    state: 'actor-resolution-required' | 'human-action-required';
    code: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type CurrentInvestigationRef = {
  schemaVersion: 1;
  changeId: string;
  investigationId: string;
};

export function createInvestigationId(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `investigation-${timestamp}-${crypto.randomUUID()}`;
}

export function investigationCheckpointId(
  session: InvestigationSession,
  kind: InvestigationCheckpointKind,
): string {
  const prerequisites =
    kind === 'main-terms'
      ? {
          blindManifestDigest: session.blindManifestDigest,
          intentDigest: session.intentDigest,
          baseline: session.baseline,
        }
      : kind === 'group-dispositions'
        ? {
            mainTermsDigest:
              session.milestones.mainTerms?.contributionDigest ?? null,
            blindResult: session.milestones.blindResult,
          }
        : {
            groupDispositionsDigest:
              session.milestones.groupDispositions?.contributionDigest ?? null,
          };
  return `checkpoint-${sha256(
    canonicalJson({
      schemaVersion: 1,
      investigationId: session.investigationId,
      changeId: session.changeId,
      kind,
      prerequisites,
    }),
  )}`;
}

export function createInvestigationSessionRecord(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
): InvestigationSession {
  const validated = assertInvestigationSession(session);
  const sessionPath = investigationSessionPath(
    paths,
    validated.investigationId,
  );
  createPrivateCanonicalJson(
    paths,
    sessionPath,
    validated,
    sessionUnsafe,
    'INVESTIGATION_SESSION_COLLISION',
  );
  return readInvestigationSession(paths, validated.investigationId);
}

export function readInvestigationSession(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): InvestigationSession {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const value = readPrivateCanonicalJson(
    paths,
    investigationSessionPath(paths, investigationId),
    sessionUnsafe,
  );
  const session = assertInvestigationSession(value);
  if (session.investigationId !== investigationId) {
    throw workflowError(
      'INVESTIGATION_SESSION_ID_MISMATCH',
      'Investigation session content does not match its filename.',
      ExitCode.staleState,
    );
  }
  return deepFreeze(structuredClone(session));
}

export function investigationSessionExists(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): boolean {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  return privatePathExists(
    paths,
    investigationSessionPath(paths, investigationId),
    sessionUnsafe,
  );
}

export function compareAndSwapInvestigationSession(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  expectedRevision: number,
  transition: (current: InvestigationSession) => InvestigationSession,
): InvestigationSession {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${investigationId}.lock`),
    () => {
      const current = readInvestigationSession(paths, investigationId);
      if (current.revision !== expectedRevision) {
        throw investigationCasMismatch(expectedRevision, current.revision);
      }
      const next = assertInvestigationSession(
        transition(deepFreeze(structuredClone(current))),
      );
      assertMonotonicSessionTransition(current, next);
      writePrivateCanonicalJsonAtomic(
        paths,
        investigationSessionPath(paths, investigationId),
        next,
        sessionUnsafe,
      );
      return readInvestigationSession(paths, investigationId);
    },
    'INVESTIGATION_SESSION_OPERATION_CONFLICT',
    sessionLockInvalid,
  );
}

export function createCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  changeId: string,
  investigationId: string,
): void {
  const ref: CurrentInvestigationRef = {
    schemaVersion: 1,
    changeId: assertChangeId(changeId),
    investigationId: assertInvestigationId(investigationId),
  };
  createPrivateCanonicalJson(
    paths,
    currentInvestigationRefPath(paths, ref.changeId),
    ref,
    refUnsafe,
    'CURRENT_INVESTIGATION_CONFLICT',
  );
}

export function readCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): CurrentInvestigationRef | null {
  const changeId = assertChangeId(requestedChangeId);
  const refPath = currentInvestigationRefPath(paths, changeId);
  if (!privatePathExists(paths, refPath, refUnsafe)) {
    return null;
  }
  const value = readPrivateCanonicalJson(paths, refPath, refUnsafe);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'investigationId']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    typeof value.investigationId !== 'string'
  ) {
    throw refUnsafe();
  }
  assertInvestigationId(value.investigationId);
  return deepFreeze(value as CurrentInvestigationRef);
}

export function assertInvestigationCheckpointEnvelope(
  value: unknown,
): InvestigationCheckpointEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'checkpointId',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'payload',
    ]) ||
    value.schemaVersion !== 1 ||
    !isCheckpointKind(value.kind) ||
    typeof value.checkpointId !== 'string' ||
    !CHECKPOINT_ID.test(value.checkpointId) ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    !isDigest(value.blindManifestDigest)
  ) {
    throw checkpointInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  if (value.kind === 'main-terms') {
    assertMainTermsPayload(value.payload);
  } else if (value.kind === 'group-dispositions') {
    assertGroupDispositionsPayload(value.payload);
  } else {
    assertWhyAnswersPayload(value.payload);
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw checkpointInvalid();
  }
  return deepFreeze(structuredClone(value)) as InvestigationCheckpointEnvelope;
}

export function checkpointEnvelopeDigest(
  envelope: InvestigationCheckpointEnvelope,
): string {
  return sha256(canonicalJson(assertInvestigationCheckpointEnvelope(envelope)));
}

export function checkpointContributionDigest(
  envelope: InvestigationCheckpointEnvelope,
): string {
  const validated = assertInvestigationCheckpointEnvelope(envelope);
  return sha256(
    canonicalJson({
      schemaVersion: validated.schemaVersion,
      kind: validated.kind,
      investigationId: validated.investigationId,
      changeId: validated.changeId,
      baseline: validated.baseline,
      intentDigest: validated.intentDigest,
      blindManifestDigest: validated.blindManifestDigest,
      payload: validated.payload,
    }),
  );
}

export function deriveInvestigationSessionState(
  session: Pick<InvestigationSession, 'blocker' | 'milestones'>,
): InvestigationSessionState {
  if (session.blocker !== null) {
    return session.blocker.state;
  }
  if (session.milestones.mainTerms === null) {
    return 'awaiting-main-terms';
  }
  if (session.milestones.blindResult === null) {
    return 'waiting-for-provider';
  }
  if (session.milestones.groupDispositions === null) {
    return 'awaiting-group-dispositions';
  }
  if (session.milestones.whyAnswers === null) {
    return 'awaiting-ledger-answers';
  }
  return 'investigation-sealed';
}

export function ensurePrivateInvestigationDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): void {
  walkPrivateDirectory(paths, directory, makeError, true);
}

export function readPrivateCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => WorkflowError,
): unknown {
  walkPrivateDirectory(paths, path.dirname(filePath), makeError, false);
  const content = readPrivateFile(filePath, makeError);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  if (`${canonicalJson(value)}\n` !== content) {
    throw makeError();
  }
  return value;
}

export function createPrivateCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  makeError: () => WorkflowError,
  collisionCode: string,
): void {
  const content = `${canonicalJson(value)}\n`;
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    if (readPrivateFile(filePath, makeError) === content) {
      return;
    }
    throw workflowError(
      collisionCode,
      'A different durable investigation record already exists.',
      ExitCode.conflict,
    );
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const raced = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (raced) {
      if (readPrivateFile(filePath, makeError) === content) {
        return;
      }
      throw workflowError(
        collisionCode,
        'A different durable investigation record already exists.',
        ExitCode.conflict,
      );
    }
    // Every caller holds the appropriate short store/change lock. Renaming a
    // fully fsynced private temp is atomic and avoids the crash window where a
    // temp-to-final hardlink would leave the durable target with nlink=2.
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writePrivateCanonicalJsonAtomic(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  makeError: () => WorkflowError,
): void {
  const content = `${canonicalJson(value)}\n`;
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateFile(existing, makeError);
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (current) {
      assertPrivateFile(current, makeError);
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function withPrivateRuntimeLock<T>(
  paths: InvestigationRuntimePaths,
  lockPath: string,
  operation: () => T,
  conflictCode: string,
  invalidLock: () => WorkflowError,
): T {
  ensurePrivateInvestigationDirectory(
    paths,
    path.dirname(lockPath),
    invalidLock,
  );
  const marker = `${canonicalJson({
    schemaVersion: 1,
    ownerToken: crypto.randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, NO_FOLLOW_CREATE, 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, marker, 'utf8');
      fs.fsyncSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        attempt === 0 &&
        reclaimDeadPrivateRuntimeLock(lockPath, invalidLock)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          conflictCode,
          'A durable investigation operation is already in progress.',
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw invalidLock();
  }
  const owned = fs.fstatSync(descriptor);
  let result: T;
  try {
    result = operation();
  } catch (error) {
    releasePrivateRuntimeLock(lockPath, descriptor, owned, marker, invalidLock);
    throw error;
  }
  releasePrivateRuntimeLock(lockPath, descriptor, owned, marker, invalidLock);
  return result;
}

export function privatePathExists(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => WorkflowError,
): boolean {
  if (!walkPrivateDirectory(paths, path.dirname(filePath), makeError, false)) {
    return false;
  }
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    return false;
  }
  assertPrivateFile(stats, makeError);
  return true;
}

function assertInvestigationSession(value: unknown): InvestigationSession {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'investigationId',
      'revision',
      'state',
      'changeId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'blindRequestDigest',
      'blindInvocationIds',
      'currentBlindInvocationId',
      'milestones',
      'blocker',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.investigationId !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.changeId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    (value.branch !== null && typeof value.branch !== 'string') ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    !isDigest(value.blindManifestDigest) ||
    !isDigest(value.blindRequestDigest) ||
    !isStringArray(value.blindInvocationIds) ||
    value.blindInvocationIds.length < 1 ||
    typeof value.currentBlindInvocationId !== 'string' ||
    !isMilestones(value.milestones) ||
    !isBlocker(value.blocker) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw sessionInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  for (const invocationId of value.blindInvocationIds) {
    assertInvocationId(invocationId);
  }
  assertInvocationId(value.currentBlindInvocationId);
  if (
    new Set(value.blindInvocationIds).size !==
      value.blindInvocationIds.length ||
    !value.blindInvocationIds.includes(value.currentBlindInvocationId)
  ) {
    throw sessionInvalid();
  }
  const session = value as InvestigationSession;
  if (
    session.state !== deriveInvestigationSessionState(session) ||
    !milestonesBelongToSession(session)
  ) {
    throw sessionInvalid();
  }
  return session;
}

function milestonesBelongToSession(session: InvestigationSession): boolean {
  for (const [kind, stored] of [
    ['main-terms', session.milestones.mainTerms],
    ['group-dispositions', session.milestones.groupDispositions],
    ['why-answers', session.milestones.whyAnswers],
  ] as const) {
    if (stored === null) {
      continue;
    }
    const envelope = stored.envelope;
    if (
      envelope.kind !== kind ||
      envelope.investigationId !== session.investigationId ||
      envelope.changeId !== session.changeId ||
      envelope.expectedRevision > session.revision ||
      canonicalJson(envelope.baseline) !== canonicalJson(session.baseline) ||
      envelope.intentDigest !== session.intentDigest ||
      envelope.blindManifestDigest !== session.blindManifestDigest ||
      envelope.checkpointId !== investigationCheckpointId(session, kind)
    ) {
      return false;
    }
  }
  const blindResult = session.milestones.blindResult;
  return (
    blindResult === null ||
    (blindResult.invocationId === session.currentBlindInvocationId &&
      blindResult.requestDigest === session.blindRequestDigest)
  );
}

function assertMonotonicSessionTransition(
  current: InvestigationSession,
  next: InvestigationSession,
): void {
  for (const key of [
    'schemaVersion',
    'investigationId',
    'changeId',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'intentDigest',
    'blindManifestDigest',
    'createdAt',
  ] as const) {
    if (canonicalJson(current[key]) !== canonicalJson(next[key])) {
      throw sessionTransitionInvalid();
    }
  }
  if (
    next.revision !== current.revision + 1 ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    canonicalJson(next.blocker) !== canonicalJson(current.blocker) ||
    next.blindInvocationIds.length < current.blindInvocationIds.length ||
    current.blindInvocationIds.some(
      (invocationId, index) => next.blindInvocationIds[index] !== invocationId,
    )
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    next.currentBlindInvocationId === current.currentBlindInvocationId &&
    (next.blindRequestDigest !== current.blindRequestDigest ||
      next.blindInvocationIds.length !== current.blindInvocationIds.length)
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    next.currentBlindInvocationId !== current.currentBlindInvocationId &&
    (next.blindInvocationIds.length !== current.blindInvocationIds.length + 1 ||
      next.currentBlindInvocationId !== next.blindInvocationIds.at(-1) ||
      next.blindRequestDigest === current.blindRequestDigest)
  ) {
    throw sessionTransitionInvalid();
  }
  for (const key of [
    'mainTerms',
    'blindResult',
    'groupDispositions',
    'whyAnswers',
  ] as const) {
    const before = current.milestones[key];
    const after = next.milestones[key];
    if (before !== null && canonicalJson(before) !== canonicalJson(after)) {
      throw sessionTransitionInvalid();
    }
  }
}

function isMilestones(
  value: unknown,
): value is InvestigationSession['milestones'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'mainTerms',
      'blindResult',
      'groupDispositions',
      'whyAnswers',
    ]) ||
    !isStoredCheckpoint(value.mainTerms, 'main-terms') ||
    !isBlindResult(value.blindResult) ||
    !isStoredCheckpoint(value.groupDispositions, 'group-dispositions') ||
    !isStoredCheckpoint(value.whyAnswers, 'why-answers')
  ) {
    return false;
  }
  if (
    value.groupDispositions !== null &&
    (value.mainTerms === null || value.blindResult === null)
  ) {
    return false;
  }
  if (value.whyAnswers !== null && value.groupDispositions === null) {
    return false;
  }
  return true;
}

function isStoredCheckpoint(
  value: unknown,
  kind: InvestigationCheckpointKind,
): value is StoredInvestigationCheckpoint | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ]) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.contributionDigest)
  ) {
    return false;
  }
  try {
    const envelope = assertInvestigationCheckpointEnvelope(value.envelope);
    return (
      envelope.kind === kind &&
      checkpointEnvelopeDigest(envelope) === value.envelopeDigest &&
      checkpointContributionDigest(envelope) === value.contributionDigest
    );
  } catch {
    return false;
  }
}

function isBlindResult(value: unknown): value is BlindResultReference | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['invocationId', 'requestDigest', 'outputDigest']) ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest)
  ) {
    return false;
  }
  try {
    assertInvocationId(value.invocationId);
    return true;
  } catch {
    return false;
  }
}

function isBlocker(value: unknown): value is InvestigationSession['blocker'] {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['state', 'code']) &&
      (value.state === 'actor-resolution-required' ||
        value.state === 'human-action-required') &&
      typeof value.code === 'string' &&
      value.code.length > 0)
  );
}

function assertMainTermsPayload(
  value: unknown,
): asserts value is MainTermsPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reference', 'terms']) ||
    typeof value.reference !== 'string' ||
    value.reference.trim().length === 0 ||
    !Array.isArray(value.terms) ||
    value.terms.length < 1 ||
    value.terms.length > INVESTIGATION_LIMITS.maxMainTerms
  ) {
    throw checkpointInvalid();
  }
  for (const term of value.terms) {
    if (
      !isRecord(term) ||
      !hasExactKeys(term, [
        'kind',
        'value',
        'rationale',
        'expectedRelationship',
      ]) ||
      typeof term.kind !== 'string' ||
      typeof term.value !== 'string' ||
      typeof term.rationale !== 'string' ||
      typeof term.expectedRelationship !== 'string'
    ) {
      throw checkpointInvalid();
    }
    try {
      previewInvestigationTermUnion([
        {
          source: 'main',
          reference: value.reference,
          terms: [
            {
              kind: term.kind as InvestigationTermKind,
              value: term.value,
              rationale: term.rationale,
              expectedRelationship: term.expectedRelationship,
            },
          ],
        },
      ]);
    } catch {
      throw checkpointInvalid();
    }
  }
}

function assertGroupDispositionsPayload(
  value: unknown,
): asserts value is GroupDispositionsPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['dispositions']) ||
    !Array.isArray(value.dispositions) ||
    value.dispositions.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid();
  }
  const seen = new Set<string>();
  const classifications = new Set([
    'load-bearing',
    'test-or-mirror',
    'generated',
    'incidental-reference',
    'irrelevant',
  ]);
  for (const item of value.dispositions) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [
        'groupId',
        'classification',
        'rationale',
        'author',
      ]) ||
      typeof item.groupId !== 'string' ||
      !DIGEST.test(item.groupId) ||
      typeof item.classification !== 'string' ||
      !classifications.has(item.classification) ||
      typeof item.rationale !== 'string' ||
      item.rationale.trim().length === 0 ||
      typeof item.author !== 'string' ||
      item.author.trim().length === 0 ||
      seen.has(item.groupId)
    ) {
      throw checkpointInvalid();
    }
    seen.add(item.groupId);
  }
}

function assertWhyAnswersPayload(
  value: unknown,
): asserts value is WhyAnswersPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['answers']) ||
    !Array.isArray(value.answers) ||
    value.answers.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid();
  }
  const seen = new Set<string>();
  for (const answer of value.answers) {
    if (
      !isRecord(answer) ||
      !hasExactKeys(answer, [
        'manifestEntryId',
        'why',
        'protectedInvariant',
        'reviewerQuestion',
        'answer',
        'semanticAuthor',
        'readComplete',
      ]) ||
      typeof answer.manifestEntryId !== 'string' ||
      !DIGEST.test(answer.manifestEntryId) ||
      !isSemanticText(answer.why) ||
      !isSemanticText(answer.protectedInvariant) ||
      !isSemanticText(answer.reviewerQuestion) ||
      !isSemanticText(answer.answer) ||
      typeof answer.semanticAuthor !== 'string' ||
      answer.semanticAuthor.trim().length === 0 ||
      answer.readComplete !== true ||
      seen.has(answer.manifestEntryId)
    ) {
      throw checkpointInvalid();
    }
    seen.add(answer.manifestEntryId);
  }
}

function isSemanticText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/\b(?:TODO|FIXME|TBD|XXX|WIP)\b/i.test(value) &&
    !/\{\{[\s\S]*?\}\}/.test(value) &&
    !/<(?!!)[^>]*>/.test(value)
  );
}

function writePrivateTemporary(filePath: string, content: string): string {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readPrivateFile(
  filePath: string,
  makeError: () => WorkflowError,
): string {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) {
    throw makeError();
  }
  assertPrivateFile(before, makeError);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    assertPrivateFile(opened, makeError);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw makeError();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkPrivateDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
  create: boolean,
): boolean {
  const relative = path.relative(paths.base, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw makeError();
  }
  let current = paths.base;
  for (const segment of relative.split(path.sep)) {
    if (!segment) {
      continue;
    }
    current = path.join(current, segment);
    let stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) {
      if (!create) {
        return false;
      }
      fs.mkdirSync(current, { mode: 0o700 });
      fs.chmodSync(current, 0o700);
      stats = fs.lstatSync(current);
      fsyncDirectory(path.dirname(current));
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== path.resolve(current) ||
      (isInsideOrEqual(paths.root, current) && (stats.mode & 0o777) !== 0o700)
    ) {
      throw makeError();
    }
  }
  return true;
}

function releasePrivateRuntimeLock(
  lockPath: string,
  descriptor: number,
  owned: fs.Stats,
  marker: string,
  invalidLock: () => WorkflowError,
): void {
  const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  let content: string | undefined;
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(marker));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    content = bytes.subarray(0, count).toString('utf8');
  } catch {
    content = undefined;
  }
  fs.closeSync(descriptor);
  if (
    !observed?.isFile() ||
    observed.isSymbolicLink() ||
    observed.dev !== owned.dev ||
    observed.ino !== owned.ino ||
    content !== marker
  ) {
    throw invalidLock();
  }
  fs.unlinkSync(lockPath);
  fsyncDirectory(path.dirname(lockPath));
}

function reclaimDeadPrivateRuntimeLock(
  lockPath: string,
  invalidLock: () => WorkflowError,
): boolean {
  const before = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!before) {
    return true;
  }
  assertPrivateFile(before, invalidLock);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw invalidLock();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    assertPrivateFile(opened, invalidLock);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw invalidLock();
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw invalidLock();
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'ownerToken',
        'pid',
        'createdAt',
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.ownerToken !== 'string' ||
      value.ownerToken.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      !isTimestamp(value.createdAt) ||
      `${canonicalJson(value)}\n` !== content
    ) {
      throw invalidLock();
    }
    if (isProcessAlive(value.pid as number)) {
      return false;
    }
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      !observed ||
      observed.dev !== opened.dev ||
      observed.ino !== opened.ino
    ) {
      return true;
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

function assertPrivateFile(
  stats: fs.Stats,
  makeError: () => WorkflowError,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
}

function investigationSessionPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(paths.sessions, `${investigationId}.json`);
}

function currentInvestigationRefPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-session.json`);
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
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

function isCheckpointKind(
  value: unknown,
): value is InvestigationCheckpointKind {
  return (
    value === 'main-terms' ||
    value === 'group-dispositions' ||
    value === 'why-answers'
  );
}

function isBaseline(value: unknown): value is InvestigationSession['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sessionUnsafe() {
  return workflowError(
    'INVESTIGATION_SESSION_UNSAFE',
    'Investigation session storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function sessionInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_INVALID',
    'Investigation session is malformed or internally inconsistent.',
    ExitCode.staleState,
  );
}

function sessionTransitionInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_TRANSITION_INVALID',
    'Investigation session transition is not monotonic.',
    ExitCode.staleState,
  );
}

function investigationCasMismatch(expected: number, observed: number) {
  return workflowError(
    'INVESTIGATION_CAS_MISMATCH',
    'Investigation session changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

function checkpointInvalid() {
  return workflowError(
    'INVESTIGATION_CHECKPOINT_INVALID',
    'Investigation caller checkpoint is malformed, unbounded, or unbound.',
    ExitCode.usage,
  );
}

function refUnsafe() {
  return workflowError(
    'CURRENT_INVESTIGATION_REF_UNSAFE',
    'Current investigation reference is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function sessionLockInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_LOCK_INVALID',
    'Investigation session lock ownership changed during the transition.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
