import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_HISTORY_RECORD_BYTES = 1024 * 1024;
const HISTORY_DIRECTORY_NAME = 'control-plane-supervisor-history';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;

export type ControlPlaneSupervisorHistoryDigest = `sha256:${string}`;

export interface ControlPlaneSupervisorHistoryArtifactSelection {
  artifactId: ControlPlaneSupervisorHistoryDigest;
  executableDigest: ControlPlaneSupervisorHistoryDigest;
  closureDigest: ControlPlaneSupervisorHistoryDigest;
}

export type ControlPlaneSupervisorHistoryAnchorAuthority =
  | {
      kind: 'initial-bootstrap-anchor.v1';
      initialBootstrapPublishedDigest: ControlPlaneSupervisorHistoryDigest;
    }
  | {
      kind: 'legacy-v2-terminal-anchor.v1';
      initialBootstrapPublishedDigest: ControlPlaneSupervisorHistoryDigest;
      grantId: string;
      txId: string;
      terminalState: 'FINALIZED' | 'ROLLED_BACK';
      updateRecordDigest: ControlPlaneSupervisorHistoryDigest;
      transactionJournalDigest: ControlPlaneSupervisorHistoryDigest;
      grantEnvelopeDigest: ControlPlaneSupervisorHistoryDigest;
      promotionBundleDigest: ControlPlaneSupervisorHistoryDigest;
    };

export interface ControlPlaneSupervisorHistoryAnchor {
  kind: 'control-plane-supervisor-history-anchor.v1';
  sequence: 0;
  previousRecordDigest: null;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  authority: ControlPlaneSupervisorHistoryAnchorAuthority;
  recordedAt: string;
  recordDigest: ControlPlaneSupervisorHistoryDigest;
}

export interface ControlPlaneSupervisorHistoryTransition {
  kind: 'control-plane-supervisor-history-transition.v1';
  sequence: number;
  previousRecordDigest: ControlPlaneSupervisorHistoryDigest;
  repositoryId: string;
  phase: 'candidate-selected' | 'rollback-restored';
  fromGeneration: number;
  toGeneration: number;
  fromSupervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  toSupervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: ControlPlaneSupervisorHistoryDigest;
  promotionBundleDigest: ControlPlaneSupervisorHistoryDigest;
  promotionLineageDigest: ControlPlaneSupervisorHistoryDigest;
  sourceTransactionState: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED';
  sourceJournalDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
  recordDigest: ControlPlaneSupervisorHistoryDigest;
}

export interface ControlPlaneSupervisorHistoryTerminal {
  kind: 'control-plane-supervisor-history-terminal.v1';
  sequence: number;
  previousRecordDigest: ControlPlaneSupervisorHistoryDigest;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  terminalState: 'FINALIZED' | 'ROLLED_BACK';
  grantId: string;
  txId: string;
  updateRecordDigest: ControlPlaneSupervisorHistoryDigest;
  transactionJournalDigest: ControlPlaneSupervisorHistoryDigest;
  grantEnvelopeDigest: ControlPlaneSupervisorHistoryDigest;
  promotionBundleDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
  recordDigest: ControlPlaneSupervisorHistoryDigest;
}

export type ControlPlaneSupervisorHistoryRecord =
  | ControlPlaneSupervisorHistoryAnchor
  | ControlPlaneSupervisorHistoryTransition
  | ControlPlaneSupervisorHistoryTerminal;

export interface VerifiedControlPlaneSupervisorHistoryProgress {
  records: ControlPlaneSupervisorHistoryRecord[];
  anchor: ControlPlaneSupervisorHistoryAnchor;
  leaf: ControlPlaneSupervisorHistoryRecord;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  terminal: boolean;
}

export interface VerifiedControlPlaneSupervisorHistory extends VerifiedControlPlaneSupervisorHistoryProgress {
  leaf:
    ControlPlaneSupervisorHistoryAnchor | ControlPlaneSupervisorHistoryTerminal;
  terminal: true;
}

export interface ControlPlaneSupervisorHistoryAppendHooks {
  /** Test-only hard-crash seam; production callers omit it. */
  testAfterDurablePhase?: (phase: 'PREPARED' | 'HARD_LINKED') => void;
}

export interface ControlPlaneSupervisorHistoryAppendResult {
  replayed: boolean;
  history: VerifiedControlPlaneSupervisorHistoryProgress;
}

type HistoryPredecessor = ControlPlaneSupervisorHistoryRecord;

export function controlPlaneSupervisorHistoryRecordDigest(
  payload: unknown,
): ControlPlaneSupervisorHistoryDigest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex')}`;
}

export function createControlPlaneSupervisorHistoryAnchor(input: {
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  authority: ControlPlaneSupervisorHistoryAnchorAuthority;
  recordedAt: string;
}): ControlPlaneSupervisorHistoryAnchor {
  const payload = {
    kind: 'control-plane-supervisor-history-anchor.v1' as const,
    sequence: 0 as const,
    previousRecordDigest: null,
    repositoryId: input.repositoryId,
    generation: input.generation,
    supervisorRecordDigest: input.supervisorRecordDigest,
    activeArtifact: structuredClone(input.activeArtifact),
    activeTrustCommit: input.activeTrustCommit,
    authority: structuredClone(input.authority),
    recordedAt: input.recordedAt,
  };
  return verifyControlPlaneSupervisorHistoryRecord({
    ...payload,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  }) as ControlPlaneSupervisorHistoryAnchor;
}

export function createControlPlaneSupervisorHistoryTransition(input: {
  previous: HistoryPredecessor;
  phase: 'candidate-selected' | 'rollback-restored';
  toSupervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: ControlPlaneSupervisorHistoryDigest;
  promotionBundleDigest: ControlPlaneSupervisorHistoryDigest;
  promotionLineageDigest: ControlPlaneSupervisorHistoryDigest;
  sourceTransactionState: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED';
  sourceJournalDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
}): ControlPlaneSupervisorHistoryTransition {
  const previous = verifyControlPlaneSupervisorHistoryRecord(input.previous);
  const fromGeneration = recordGeneration(previous);
  const payload = {
    kind: 'control-plane-supervisor-history-transition.v1' as const,
    sequence: previous.sequence + 1,
    previousRecordDigest: previous.recordDigest,
    repositoryId: previous.repositoryId,
    phase: input.phase,
    fromGeneration,
    toGeneration: fromGeneration + 1,
    fromSupervisorRecordDigest: recordSupervisorDigest(previous),
    toSupervisorRecordDigest: input.toSupervisorRecordDigest,
    activeArtifact: structuredClone(input.activeArtifact),
    activeTrustCommit: input.activeTrustCommit,
    grantId: input.grantId,
    txId: input.txId,
    grantEnvelopeDigest: input.grantEnvelopeDigest,
    promotionBundleDigest: input.promotionBundleDigest,
    promotionLineageDigest: input.promotionLineageDigest,
    sourceTransactionState: input.sourceTransactionState,
    sourceJournalDigest: input.sourceJournalDigest,
    recordedAt: input.recordedAt,
  };
  const record = verifyControlPlaneSupervisorHistoryRecord({
    ...payload,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  });
  assertTransitionFollows(
    previous,
    record as ControlPlaneSupervisorHistoryTransition,
  );
  return record as ControlPlaneSupervisorHistoryTransition;
}

export function createControlPlaneSupervisorHistoryTerminal(input: {
  previous: ControlPlaneSupervisorHistoryTransition;
  terminalState: 'FINALIZED' | 'ROLLED_BACK';
  updateRecordDigest: ControlPlaneSupervisorHistoryDigest;
  transactionJournalDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
}): ControlPlaneSupervisorHistoryTerminal {
  const previous = verifyControlPlaneSupervisorHistoryRecord(input.previous);
  if (previous.kind !== 'control-plane-supervisor-history-transition.v1') {
    throw transitionInvalid(
      'A terminal seal must follow a supervisor transition.',
    );
  }
  const payload = {
    kind: 'control-plane-supervisor-history-terminal.v1' as const,
    sequence: previous.sequence + 1,
    previousRecordDigest: previous.recordDigest,
    repositoryId: previous.repositoryId,
    generation: previous.toGeneration,
    supervisorRecordDigest: previous.toSupervisorRecordDigest,
    activeArtifact: structuredClone(previous.activeArtifact),
    activeTrustCommit: previous.activeTrustCommit,
    terminalState: input.terminalState,
    grantId: previous.grantId,
    txId: previous.txId,
    updateRecordDigest: input.updateRecordDigest,
    transactionJournalDigest: input.transactionJournalDigest,
    grantEnvelopeDigest: previous.grantEnvelopeDigest,
    promotionBundleDigest: previous.promotionBundleDigest,
    recordedAt: input.recordedAt,
  };
  const record = verifyControlPlaneSupervisorHistoryRecord({
    ...payload,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  });
  assertTerminalFollows(
    previous,
    record as ControlPlaneSupervisorHistoryTerminal,
  );
  return record as ControlPlaneSupervisorHistoryTerminal;
}

export function verifyControlPlaneSupervisorHistoryRecord(
  value: unknown,
): ControlPlaneSupervisorHistoryRecord {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw recordInvalid('Supervisor history record is not an object.');
  }
  switch (value.kind) {
    case 'control-plane-supervisor-history-anchor.v1':
      return verifyAnchor(value);
    case 'control-plane-supervisor-history-transition.v1':
      return verifyTransition(value);
    case 'control-plane-supervisor-history-terminal.v1':
      return verifyTerminal(value);
    default:
      throw recordInvalid('Unknown supervisor history record kind.');
  }
}

export function verifyControlPlaneSupervisorHistoryProgress(
  values: readonly unknown[],
): VerifiedControlPlaneSupervisorHistoryProgress {
  if (!Array.isArray(values) || values.length === 0) {
    throw historyGap('Supervisor history has no anchor.');
  }
  const records = values.map(verifyControlPlaneSupervisorHistoryRecord);
  const digests = new Set<string>();
  const children = new Map<string, number>();
  for (const record of records) {
    if (digests.has(record.recordDigest)) {
      throw historyFork('Supervisor history repeats a record digest.');
    }
    digests.add(record.recordDigest);
    if (record.previousRecordDigest !== null) {
      children.set(
        record.previousRecordDigest,
        (children.get(record.previousRecordDigest) ?? 0) + 1,
      );
    }
  }
  if ([...children.values()].some((count) => count !== 1)) {
    throw historyFork('Supervisor history contains more than one child.');
  }
  const ordered = [...records].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.sequence !== index) {
      throw historyGap('Supervisor history sequences are not contiguous.');
    }
  }
  const anchor = ordered[0]!;
  if (anchor.kind !== 'control-plane-supervisor-history-anchor.v1') {
    throw historyGap('Supervisor history does not begin with an anchor.');
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.previousRecordDigest !== previous.recordDigest) {
      throw historyGap(
        'Supervisor history previous digests are discontinuous.',
      );
    }
    if (current.repositoryId !== anchor.repositoryId) {
      throw transitionInvalid(
        'Supervisor history crosses repository identities.',
      );
    }
    if (Date.parse(current.recordedAt) < Date.parse(previous.recordedAt)) {
      throw transitionInvalid(
        'Supervisor history timestamps are not monotonic.',
      );
    }
    if (current.kind === 'control-plane-supervisor-history-transition.v1') {
      assertTransitionFollows(previous, current);
      if (current.phase === 'rollback-restored') {
        const restored = ordered[index - 2];
        if (
          restored === undefined ||
          canonicalJson(current.activeArtifact) !==
            canonicalJson(recordActiveArtifact(restored)) ||
          current.activeTrustCommit !== recordActiveTrustCommit(restored)
        ) {
          throw transitionInvalid(
            'Rollback does not restore the exact pre-candidate selection.',
          );
        }
      }
    } else if (
      current.kind === 'control-plane-supervisor-history-terminal.v1'
    ) {
      assertTerminalFollows(previous, current);
    } else {
      throw transitionInvalid('A second history anchor is forbidden.');
    }
  }
  const leaf = ordered.at(-1)!;
  const progress = {
    records: ordered.map((record) => structuredClone(record)),
    anchor: structuredClone(anchor),
    leaf: structuredClone(leaf),
    generation: recordGeneration(leaf),
    supervisorRecordDigest: recordSupervisorDigest(leaf),
    activeArtifact: structuredClone(recordActiveArtifact(leaf)),
    activeTrustCommit: recordActiveTrustCommit(leaf),
    terminal:
      leaf.kind === 'control-plane-supervisor-history-anchor.v1' ||
      leaf.kind === 'control-plane-supervisor-history-terminal.v1',
  };
  return deepFreeze(progress);
}

export function verifyControlPlaneSupervisorHistory(
  values: readonly unknown[],
): VerifiedControlPlaneSupervisorHistory {
  const progress = verifyControlPlaneSupervisorHistoryProgress(values);
  if (!progress.terminal) {
    throw workflowError(
      'CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL',
      'Supervisor history leaf is an incomplete transition.',
      ExitCode.conflict,
    );
  }
  return progress as VerifiedControlPlaneSupervisorHistory;
}

export function controlPlaneSupervisorHistoryDirectory(
  storageRoot: string,
): string {
  return path.join(storageRoot, HISTORY_DIRECTORY_NAME);
}

export function controlPlaneSupervisorHistoryRecordPath(
  storageRoot: string,
  recordDigest: ControlPlaneSupervisorHistoryDigest,
): string {
  assertDigest(recordDigest);
  return path.join(
    controlPlaneSupervisorHistoryDirectory(storageRoot),
    `${recordDigest.slice('sha256:'.length)}.json`,
  );
}

export function controlPlaneSupervisorHistoryPendingPath(
  storageRoot: string,
  recordDigest: ControlPlaneSupervisorHistoryDigest,
): string {
  assertDigest(recordDigest);
  return path.join(
    controlPlaneSupervisorHistoryDirectory(storageRoot),
    `.${recordDigest.slice('sha256:'.length)}.json.pending`,
  );
}

export function readControlPlaneSupervisorHistoryProgress(
  storageRoot: string,
): VerifiedControlPlaneSupervisorHistoryProgress {
  const root = assertStorageRoot(storageRoot);
  const directory = controlPlaneSupervisorHistoryDirectory(root);
  assertPrivateDirectory(directory);
  return verifyControlPlaneSupervisorHistoryProgress(
    readHistoryRecords(directory),
  );
}

export function readControlPlaneSupervisorHistory(
  storageRoot: string,
): VerifiedControlPlaneSupervisorHistory {
  const progress = readControlPlaneSupervisorHistoryProgress(storageRoot);
  if (!progress.terminal) {
    throw workflowError(
      'CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL',
      'Supervisor history leaf is an incomplete transition.',
      ExitCode.conflict,
    );
  }
  return progress as VerifiedControlPlaneSupervisorHistory;
}

export function appendControlPlaneSupervisorHistoryRecord(
  storageRoot: string,
  recordValue: ControlPlaneSupervisorHistoryRecord,
  hooks: ControlPlaneSupervisorHistoryAppendHooks = {},
): ControlPlaneSupervisorHistoryAppendResult {
  const record = verifyControlPlaneSupervisorHistoryRecord(recordValue);
  const root = assertStorageRoot(storageRoot);
  const directory = ensureHistoryDirectory(root);
  const target = controlPlaneSupervisorHistoryRecordPath(
    root,
    record.recordDigest,
  );
  const pending = controlPlaneSupervisorHistoryPendingPath(
    root,
    record.recordDigest,
  );
  assertAppendInventory(directory, path.basename(pending));
  const content = `${canonicalJson(record)}\n`;
  const targetBefore = fs.lstatSync(target, { throwIfNoEntry: false });
  const pendingBefore = fs.lstatSync(pending, { throwIfNoEntry: false });
  const replayed = targetBefore !== undefined || pendingBefore !== undefined;

  if (targetBefore === undefined && pendingBefore === undefined) {
    const existing = readHistoryRecords(directory);
    verifyAppendRelation(existing, record);
    createPreparedRecord(pending, content);
    fsyncDirectory(directory);
    hooks.testAfterDurablePhase?.('PREPARED');
  } else if (targetBefore === undefined) {
    const existing = readHistoryRecords(directory, path.basename(pending));
    verifyAppendRelation(existing, record);
  } else if (pendingBefore !== undefined) {
    const existing = readHistoryRecords(
      directory,
      path.basename(pending),
      path.basename(target),
    );
    verifyAppendRelation(existing, record);
  }

  reconcilePreparedRecord(directory, pending, target, content, hooks);
  const history = verifyControlPlaneSupervisorHistoryProgress(
    readHistoryRecords(directory),
  );
  if (
    !history.records.some(
      ({ recordDigest }) => recordDigest === record.recordDigest,
    )
  ) {
    throw storageUnsafe(
      'Published history record is absent after reconciliation.',
    );
  }
  return deepFreeze({ replayed, history });
}

function verifyAppendRelation(
  existing: readonly ControlPlaneSupervisorHistoryRecord[],
  record: ControlPlaneSupervisorHistoryRecord,
): void {
  if (existing.length === 0) {
    if (record.kind !== 'control-plane-supervisor-history-anchor.v1') {
      throw historyGap(
        'The first supervisor history record must be an anchor.',
      );
    }
    verifyControlPlaneSupervisorHistoryProgress([record]);
    return;
  }
  const current = verifyControlPlaneSupervisorHistoryProgress(existing);
  if (
    record.sequence !== current.leaf.sequence + 1 ||
    record.previousRecordDigest !== current.leaf.recordDigest
  ) {
    throw historyFork('Append does not extend the unique history leaf.');
  }
  verifyControlPlaneSupervisorHistoryProgress([...current.records, record]);
}

function reconcilePreparedRecord(
  directory: string,
  pending: string,
  target: string,
  content: string,
  hooks: ControlPlaneSupervisorHistoryAppendHooks,
): void {
  let pendingStats = fs.lstatSync(pending, { throwIfNoEntry: false });
  let targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (pendingStats === undefined && targetStats === undefined) {
    throw storageUnsafe('Prepared history record disappeared before publish.');
  }
  if (pendingStats !== undefined && targetStats === undefined) {
    assertPrivateRecordBytes(pending, content, 1);
    try {
      fs.linkSync(pending, target);
      fsyncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
    pendingStats = fs.lstatSync(pending, { throwIfNoEntry: false });
    targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
    assertPreparedLinkPair(pending, target, content, pendingStats, targetStats);
    hooks.testAfterDurablePhase?.('HARD_LINKED');
  }
  if (pendingStats !== undefined && targetStats !== undefined) {
    assertPreparedLinkPair(pending, target, content, pendingStats, targetStats);
    fs.unlinkSync(pending);
    fsyncDirectory(directory);
  }
  assertPrivateRecordBytes(target, content, 1);
}

function assertPreparedLinkPair(
  pending: string,
  target: string,
  content: string,
  pendingStats = fs.lstatSync(pending, { throwIfNoEntry: false }),
  targetStats = fs.lstatSync(target, { throwIfNoEntry: false }),
): void {
  if (
    pendingStats === undefined ||
    targetStats === undefined ||
    !pendingStats.isFile() ||
    pendingStats.isSymbolicLink() ||
    !targetStats.isFile() ||
    targetStats.isSymbolicLink() ||
    pendingStats.dev !== targetStats.dev ||
    pendingStats.ino !== targetStats.ino ||
    pendingStats.nlink !== 2 ||
    targetStats.nlink !== 2
  ) {
    throw storageUnsafe(
      'Prepared and published history paths are not one exact hard-link pair.',
    );
  }
  assertPrivateRecordBytes(pending, content, 2);
  assertPrivateRecordBytes(target, content, 2);
}

function createPreparedRecord(filePath: string, content: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readHistoryRecords(
  directory: string,
  allowedPendingName?: string,
  allowedLinkedTargetName?: string,
): ControlPlaneSupervisorHistoryRecord[] {
  const records: ControlPlaneSupervisorHistoryRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === allowedPendingName ||
      entry.name === allowedLinkedTargetName
    ) {
      continue;
    }
    if (
      !RECORD_FILE.test(entry.name) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_HISTORY_UNKNOWN_RESIDUE',
        'Supervisor history directory contains an unknown or indirect entry.',
        ExitCode.unsafeEnvironment,
      );
    }
    const filePath = path.join(directory, entry.name);
    const raw = readPrivateRecordText(filePath, 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw recordInvalid('Supervisor history file is not JSON.');
    }
    if (`${canonicalJson(value)}\n` !== raw) {
      throw recordInvalid('Supervisor history file is not canonical JSON.');
    }
    const record = verifyControlPlaneSupervisorHistoryRecord(value);
    if (`${record.recordDigest.slice('sha256:'.length)}.json` !== entry.name) {
      throw recordInvalid(
        'Supervisor history filename does not match its digest.',
      );
    }
    records.push(record);
  }
  return records;
}

function assertAppendInventory(
  directory: string,
  allowedPendingName: string,
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === allowedPendingName) continue;
    if (
      !RECORD_FILE.test(entry.name) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_HISTORY_UNKNOWN_RESIDUE',
        'Supervisor history directory contains residue unrelated to this append.',
        ExitCode.unsafeEnvironment,
      );
    }
  }
}

function verifyAnchor(
  value: Record<string, unknown>,
): ControlPlaneSupervisorHistoryAnchor {
  if (
    !hasExactKeys(value, [
      'activeArtifact',
      'activeTrustCommit',
      'authority',
      'generation',
      'kind',
      'previousRecordDigest',
      'recordDigest',
      'recordedAt',
      'repositoryId',
      'sequence',
      'supervisorRecordDigest',
    ]) ||
    value.sequence !== 0 ||
    value.previousRecordDigest !== null ||
    !isPositiveSafeInteger(value.generation)
  ) {
    throw recordInvalid('Supervisor history anchor schema is invalid.');
  }
  assertNonEmpty(value.repositoryId);
  assertDigest(value.supervisorRecordDigest);
  const activeArtifact = verifyArtifactSelection(value.activeArtifact);
  assertGitOid(value.activeTrustCommit);
  const authority = verifyAnchorAuthority(value.authority);
  assertIso(value.recordedAt);
  verifySelfDigest(value);
  return deepFreeze({
    ...(structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryAnchor),
    activeArtifact,
    authority,
  });
}

function verifyTransition(
  value: Record<string, unknown>,
): ControlPlaneSupervisorHistoryTransition {
  if (
    !hasExactKeys(value, [
      'activeArtifact',
      'activeTrustCommit',
      'fromGeneration',
      'fromSupervisorRecordDigest',
      'grantEnvelopeDigest',
      'grantId',
      'kind',
      'phase',
      'previousRecordDigest',
      'promotionBundleDigest',
      'promotionLineageDigest',
      'recordDigest',
      'recordedAt',
      'repositoryId',
      'sequence',
      'sourceJournalDigest',
      'sourceTransactionState',
      'toGeneration',
      'toSupervisorRecordDigest',
      'txId',
    ]) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isPositiveSafeInteger(value.fromGeneration) ||
    !isPositiveSafeInteger(value.toGeneration) ||
    value.toGeneration !== Number(value.fromGeneration) + 1 ||
    (value.phase !== 'candidate-selected' &&
      value.phase !== 'rollback-restored') ||
    (value.sourceTransactionState !== 'RECOVERY_VERIFIED' &&
      value.sourceTransactionState !== 'ROLLBACK_REQUIRED')
  ) {
    throw recordInvalid('Supervisor history transition schema is invalid.');
  }
  for (const field of [value.repositoryId, value.grantId, value.txId]) {
    assertNonEmpty(field);
  }
  for (const field of [
    value.previousRecordDigest,
    value.fromSupervisorRecordDigest,
    value.toSupervisorRecordDigest,
    value.grantEnvelopeDigest,
    value.promotionBundleDigest,
    value.promotionLineageDigest,
    value.sourceJournalDigest,
  ]) {
    assertDigest(field);
  }
  const activeArtifact = verifyArtifactSelection(value.activeArtifact);
  assertGitOid(value.activeTrustCommit);
  assertIso(value.recordedAt);
  verifySelfDigest(value);
  return deepFreeze({
    ...(structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryTransition),
    activeArtifact,
  });
}

function verifyTerminal(
  value: Record<string, unknown>,
): ControlPlaneSupervisorHistoryTerminal {
  if (
    !hasExactKeys(value, [
      'activeArtifact',
      'activeTrustCommit',
      'generation',
      'grantEnvelopeDigest',
      'grantId',
      'kind',
      'previousRecordDigest',
      'promotionBundleDigest',
      'recordDigest',
      'recordedAt',
      'repositoryId',
      'sequence',
      'supervisorRecordDigest',
      'terminalState',
      'transactionJournalDigest',
      'txId',
      'updateRecordDigest',
    ]) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isPositiveSafeInteger(value.generation) ||
    (value.terminalState !== 'FINALIZED' &&
      value.terminalState !== 'ROLLED_BACK')
  ) {
    throw recordInvalid('Supervisor history terminal schema is invalid.');
  }
  for (const field of [value.repositoryId, value.grantId, value.txId]) {
    assertNonEmpty(field);
  }
  for (const field of [
    value.previousRecordDigest,
    value.supervisorRecordDigest,
    value.updateRecordDigest,
    value.transactionJournalDigest,
    value.grantEnvelopeDigest,
    value.promotionBundleDigest,
  ]) {
    assertDigest(field);
  }
  const activeArtifact = verifyArtifactSelection(value.activeArtifact);
  assertGitOid(value.activeTrustCommit);
  assertIso(value.recordedAt);
  verifySelfDigest(value);
  return deepFreeze({
    ...(structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryTerminal),
    activeArtifact,
  });
}

function verifyArtifactSelection(
  value: unknown,
): ControlPlaneSupervisorHistoryArtifactSelection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['artifactId', 'closureDigest', 'executableDigest'])
  ) {
    throw recordInvalid('Supervisor history artifact selection is invalid.');
  }
  assertDigest(value.artifactId);
  assertDigest(value.executableDigest);
  assertDigest(value.closureDigest);
  return deepFreeze({
    artifactId: value.artifactId,
    executableDigest: value.executableDigest,
    closureDigest: value.closureDigest,
  });
}

function verifyAnchorAuthority(
  value: unknown,
): ControlPlaneSupervisorHistoryAnchorAuthority {
  if (!isRecord(value)) {
    throw recordInvalid('Supervisor history anchor authority is invalid.');
  }
  if (value.kind === 'initial-bootstrap-anchor.v1') {
    if (!hasExactKeys(value, ['initialBootstrapPublishedDigest', 'kind'])) {
      throw recordInvalid('Initial supervisor history authority is invalid.');
    }
    assertDigest(value.initialBootstrapPublishedDigest);
    return deepFreeze({
      kind: value.kind,
      initialBootstrapPublishedDigest: value.initialBootstrapPublishedDigest,
    });
  }
  if (
    value.kind !== 'legacy-v2-terminal-anchor.v1' ||
    !hasExactKeys(value, [
      'grantEnvelopeDigest',
      'grantId',
      'initialBootstrapPublishedDigest',
      'kind',
      'promotionBundleDigest',
      'terminalState',
      'transactionJournalDigest',
      'txId',
      'updateRecordDigest',
    ]) ||
    (value.terminalState !== 'FINALIZED' &&
      value.terminalState !== 'ROLLED_BACK')
  ) {
    throw recordInvalid('Legacy V2 supervisor history authority is invalid.');
  }
  assertNonEmpty(value.grantId);
  assertNonEmpty(value.txId);
  for (const field of [
    value.initialBootstrapPublishedDigest,
    value.updateRecordDigest,
    value.transactionJournalDigest,
    value.grantEnvelopeDigest,
    value.promotionBundleDigest,
  ]) {
    assertDigest(field);
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryAnchorAuthority,
  );
}

function assertTransitionFollows(
  previous: ControlPlaneSupervisorHistoryRecord,
  current: ControlPlaneSupervisorHistoryTransition,
): void {
  if (
    current.previousRecordDigest !== previous.recordDigest ||
    current.sequence !== previous.sequence + 1 ||
    current.repositoryId !== previous.repositoryId ||
    current.fromGeneration !== recordGeneration(previous) ||
    current.toGeneration !== current.fromGeneration + 1 ||
    current.fromSupervisorRecordDigest !== recordSupervisorDigest(previous)
  ) {
    throw transitionInvalid(
      'Supervisor transition does not extend its exact predecessor.',
    );
  }
  if (current.phase === 'candidate-selected') {
    if (
      (previous.kind !== 'control-plane-supervisor-history-anchor.v1' &&
        previous.kind !== 'control-plane-supervisor-history-terminal.v1') ||
      current.sourceTransactionState !== 'RECOVERY_VERIFIED'
    ) {
      throw transitionInvalid(
        'Candidate selection must extend a terminal history leaf.',
      );
    }
    return;
  }
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    previous.phase !== 'candidate-selected' ||
    current.sourceTransactionState !== 'ROLLBACK_REQUIRED' ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    current.promotionLineageDigest !== previous.promotionLineageDigest
  ) {
    throw transitionInvalid(
      'Rollback must extend the exact candidate selection transaction.',
    );
  }
}

function assertTerminalFollows(
  previous: ControlPlaneSupervisorHistoryRecord,
  current: ControlPlaneSupervisorHistoryTerminal,
): void {
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    current.previousRecordDigest !== previous.recordDigest ||
    current.sequence !== previous.sequence + 1 ||
    current.repositoryId !== previous.repositoryId ||
    current.generation !== previous.toGeneration ||
    current.supervisorRecordDigest !== previous.toSupervisorRecordDigest ||
    canonicalJson(current.activeArtifact) !==
      canonicalJson(previous.activeArtifact) ||
    current.activeTrustCommit !== previous.activeTrustCommit ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    (current.terminalState === 'FINALIZED' &&
      previous.phase !== 'candidate-selected') ||
    (current.terminalState === 'ROLLED_BACK' &&
      previous.phase !== 'rollback-restored')
  ) {
    throw transitionInvalid(
      'Terminal seal does not match its exact supervisor transition.',
    );
  }
}

function recordGeneration(record: ControlPlaneSupervisorHistoryRecord): number {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toGeneration
    : record.generation;
}

function recordSupervisorDigest(
  record: ControlPlaneSupervisorHistoryRecord,
): ControlPlaneSupervisorHistoryDigest {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toSupervisorRecordDigest
    : record.supervisorRecordDigest;
}

function recordActiveArtifact(
  record: ControlPlaneSupervisorHistoryRecord,
): ControlPlaneSupervisorHistoryArtifactSelection {
  return record.activeArtifact;
}

function recordActiveTrustCommit(
  record: ControlPlaneSupervisorHistoryRecord,
): string {
  return record.activeTrustCommit;
}

function verifySelfDigest(value: Record<string, unknown>): void {
  assertDigest(value.recordDigest);
  const { recordDigest, ...payload } = value;
  if (recordDigest !== controlPlaneSupervisorHistoryRecordDigest(payload)) {
    throw recordInvalid(
      'Supervisor history self-digest does not match its canonical bytes.',
    );
  }
}

function assertStorageRoot(storageRoot: string): string {
  const stats =
    typeof storageRoot === 'string'
      ? fs.lstatSync(storageRoot, { throwIfNoEntry: false })
      : undefined;
  if (
    typeof storageRoot !== 'string' ||
    !path.isAbsolute(storageRoot) ||
    path.resolve(storageRoot) !== storageRoot ||
    stats === undefined ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    fs.realpathSync(storageRoot) !== storageRoot
  ) {
    throw storageUnsafe(
      'Supervisor history storage root is not an exact private directory.',
    );
  }
  return storageRoot;
}

function ensureHistoryDirectory(storageRoot: string): string {
  const directory = controlPlaneSupervisorHistoryDirectory(storageRoot);
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      fsyncDirectory(storageRoot);
    } catch {
      throw storageUnsafe(
        'Supervisor history directory could not be created safely.',
      );
    }
  }
  assertPrivateDirectory(directory);
  return directory;
}

function assertPrivateDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    fs.realpathSync(directory) !== directory
  ) {
    throw storageUnsafe(
      'Supervisor history directory is missing, indirect, or not private.',
    );
  }
}

function assertPrivateRecordBytes(
  filePath: string,
  expected: string,
  expectedLinks: number,
): void {
  const observed = readPrivateRecordText(filePath, expectedLinks);
  if (observed !== expected) {
    throw workflowError(
      'CONTROL_PLANE_SUPERVISOR_HISTORY_CONFLICT',
      'Existing supervisor history path contains different canonical bytes.',
      ExitCode.conflict,
    );
  }
}

function readPrivateRecordText(
  filePath: string,
  expectedLinks: number,
): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== expectedLinks ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_HISTORY_RECORD_BYTES ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw storageUnsafe(
      'Supervisor history record is indirect, linked, oversized, or not private.',
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, 'utf8');
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.nlink !== expectedLinks ||
      opened.size !== stats.size ||
      Buffer.byteLength(raw) !== stats.size
    ) {
      throw storageUnsafe(
        'Supervisor history record changed while it was read.',
      );
    }
    return raw;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertDigest(
  value: unknown,
): asserts value is ControlPlaneSupervisorHistoryDigest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw recordInvalid(
      'Supervisor history expected a canonical sha256 digest.',
    );
  }
}

function assertGitOid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !GIT_OID.test(value)) {
    throw recordInvalid(
      'Supervisor history trust commit is not a full Git object id.',
    );
  }
}

function assertNonEmpty(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw recordInvalid(
      'Supervisor history identifier is not a non-empty trimmed string.',
    );
  }
}

function assertIso(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw recordInvalid(
      'Supervisor history timestamp is not canonical ISO-8601.',
    );
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function recordInvalid(message: string) {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_HISTORY_RECORD_INVALID',
    message,
    ExitCode.verification,
  );
}

function transitionInvalid(message: string) {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_HISTORY_TRANSITION_INVALID',
    message,
    ExitCode.verification,
  );
}

function historyGap(message: string) {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_HISTORY_GAP',
    message,
    ExitCode.verification,
  );
}

function historyFork(message: string) {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_HISTORY_FORK',
    message,
    ExitCode.verification,
  );
}

function storageUnsafe(message: string) {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_HISTORY_STORAGE_UNSAFE',
    message,
    ExitCode.unsafeEnvironment,
  );
}
