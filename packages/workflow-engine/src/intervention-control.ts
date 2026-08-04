import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';

export type Sha256Digest = `sha256:${string}`;

export const HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE =
  'expense-app.harness-maintenance-grant.v1';
export const CONTROL_PLANE_SIGNATURE_NAMESPACE =
  'expense-app.control-plane-grant.v1';
export const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE =
  'expense-app.control-plane-independent-review.v1';

type HumanSignatureVerifier = (
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
) => boolean;

function verifyHumanSignatureSafely(
  verifier: HumanSignatureVerifier,
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
): boolean {
  try {
    return verifier(payload, signature, signer, namespace);
  } catch {
    return false;
  }
}

function sha256(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(value: unknown): Sha256Digest {
  return sha256(canonicalJson(value));
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw workflowError(
      code,
      'Expected a canonical sha256 digest.',
      ExitCode.usage,
    );
  }
}

function assertNonEmpty(
  value: unknown,
  code: string,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw workflowError(
      code,
      `${label} must be a non-empty trimmed string.`,
      ExitCode.usage,
    );
  }
}

function assertIsoTimestamp(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw workflowError(
      code,
      'Expected a canonical ISO-8601 timestamp.',
      ExitCode.usage,
    );
  }
}

function assertSortedUnique(values: readonly string[], code: string): void {
  const expected = [...new Set(values)].sort();
  if (canonicalJson(values) !== canonicalJson(expected)) {
    throw workflowError(
      code,
      'Values must be sorted and unique.',
      ExitCode.usage,
    );
  }
}

function assertSafePath(value: string, allowGlob: boolean, code: string): void {
  assertNonEmpty(value, code, 'Path');
  if (
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..') ||
    (!allowGlob && /[*?[\]{}]/.test(value))
  ) {
    throw workflowError(code, `Unsafe path: ${value}`, ExitCode.usage);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hasExactObjectKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    sameJson(Object.keys(value).sort(), [...keys].sort())
  );
}

function assertMonotonicTimestamp(
  previous: string,
  next: string,
  code: string,
): void {
  assertIsoTimestamp(next, code);
  if (Date.parse(next) < Date.parse(previous)) {
    throw workflowError(
      code,
      'Journal timestamps must be monotonic.',
      ExitCode.staleState,
    );
  }
}

// ---------------------------------------------------------------------------
// M10: immutable parent checkpoint and intervention relationship
// ---------------------------------------------------------------------------

export interface WipCheckpointInput {
  parentChangeId: string;
  baseOid: string;
  worktreeFingerprint: Sha256Digest;
  trackedTreeDigest: Sha256Digest;
  untrackedBundleDigest: Sha256Digest;
  sessionStateDigest: Sha256Digest;
  pendingIntentDigest: Sha256Digest;
  engineDigest: Sha256Digest;
  policyDigest: Sha256Digest;
  createdAt: string;
}

export interface WipCheckpoint extends WipCheckpointInput {
  kind: 'harness-wip-checkpoint.v1';
  checkpointId: Sha256Digest;
}

function checkpointPayload(input: WipCheckpointInput) {
  return {
    kind: 'harness-wip-checkpoint.v1' as const,
    parentChangeId: input.parentChangeId,
    baseOid: input.baseOid,
    worktreeFingerprint: input.worktreeFingerprint,
    trackedTreeDigest: input.trackedTreeDigest,
    untrackedBundleDigest: input.untrackedBundleDigest,
    sessionStateDigest: input.sessionStateDigest,
    pendingIntentDigest: input.pendingIntentDigest,
    engineDigest: input.engineDigest,
    policyDigest: input.policyDigest,
    createdAt: input.createdAt,
  };
}

function validateCheckpointInput(input: WipCheckpointInput): void {
  assertNonEmpty(
    input.parentChangeId,
    'INTERVENTION_CHECKPOINT_INVALID',
    'Parent change id',
  );
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseOid)) {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_INVALID',
      'Checkpoint baseOid must be a full Git object id.',
      ExitCode.usage,
    );
  }
  for (const digest of [
    input.worktreeFingerprint,
    input.trackedTreeDigest,
    input.untrackedBundleDigest,
    input.sessionStateDigest,
    input.pendingIntentDigest,
    input.engineDigest,
    input.policyDigest,
  ]) {
    assertDigest(digest, 'INTERVENTION_CHECKPOINT_INVALID');
  }
  assertIsoTimestamp(input.createdAt, 'INTERVENTION_CHECKPOINT_INVALID');
}

export function createWipCheckpoint(input: WipCheckpointInput): WipCheckpoint {
  validateCheckpointInput(input);
  const payload = checkpointPayload(input);
  return freezeDeep({
    ...payload,
    checkpointId: canonicalDigest(payload),
  });
}

export function verifyWipCheckpoint(checkpoint: WipCheckpoint): WipCheckpoint {
  validateCheckpointInput(checkpoint);
  if (checkpoint.kind !== 'harness-wip-checkpoint.v1') {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_INVALID',
      'Unknown WIP checkpoint schema.',
      ExitCode.usage,
    );
  }
  assertDigest(checkpoint.checkpointId, 'INTERVENTION_CHECKPOINT_INVALID');
  const expected = canonicalDigest(checkpointPayload(checkpoint));
  if (checkpoint.checkpointId !== expected) {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_DIGEST_MISMATCH',
      'WIP checkpoint content no longer matches its immutable digest.',
      ExitCode.verification,
      { details: { expected, actual: checkpoint.checkpointId } },
    );
  }
  return freezeDeep({ ...checkpoint });
}

export type ParentChangeStatus =
  'draft' | 'active' | 'completed' | 'cancelled' | 'superseded';

export interface HarnessInterventionBlocker {
  kind: 'harness-intervention';
  checkpointId: Sha256Digest;
  blockedBy: string;
}

export interface ParentChangeState {
  changeId: string;
  status: ParentChangeStatus;
  engineBinding: Sha256Digest;
  sessionSchema: string;
  blocker: HarnessInterventionBlocker | null;
}

export interface HarnessInterventionRelationship {
  kind: 'harness-intervention.v1';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  unblocks: string;
  state: 'active' | 'adopted' | 'closed';
}

export function beginHarnessIntervention(
  parent: ParentChangeState,
  interventionChangeId: string,
  checkpointValue: WipCheckpoint,
): {
  parent: ParentChangeState;
  relationship: HarnessInterventionRelationship;
} {
  const checkpoint = verifyWipCheckpoint(checkpointValue);
  assertNonEmpty(
    interventionChangeId,
    'INTERVENTION_CHANGE_ID_INVALID',
    'Intervention change id',
  );
  if (parent.status !== 'active') {
    throw workflowError(
      'INTERVENTION_PARENT_NOT_ACTIVE',
      'An intervention can only block an active parent change.',
      ExitCode.conflict,
    );
  }
  if (parent.blocker?.kind === 'harness-intervention') {
    throw workflowError(
      'INTERVENTION_ALREADY_ACTIVE',
      'The parent already has an active harness intervention.',
      ExitCode.conflict,
    );
  }
  if (parent.blocker !== null) {
    throw workflowError(
      'INTERVENTION_PARENT_BLOCKED',
      'The parent has another blocker that must be resolved first.',
      ExitCode.conflict,
    );
  }
  assertDigest(parent.engineBinding, 'INTERVENTION_PARENT_INVALID');
  assertNonEmpty(
    parent.sessionSchema,
    'INTERVENTION_PARENT_INVALID',
    'Session schema',
  );
  if (
    checkpoint.parentChangeId !== parent.changeId ||
    checkpoint.engineDigest !== parent.engineBinding
  ) {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_PARENT_MISMATCH',
      'Checkpoint is not bound to the exact parent and engine state.',
      ExitCode.verification,
    );
  }
  if (interventionChangeId === parent.changeId) {
    throw workflowError(
      'INTERVENTION_SELF_REFERENCE_FORBIDDEN',
      'The intervention change must be distinct from its parent.',
      ExitCode.usage,
    );
  }

  const blocker: HarnessInterventionBlocker = {
    kind: 'harness-intervention',
    checkpointId: checkpoint.checkpointId,
    blockedBy: interventionChangeId,
  };
  return freezeDeep({
    parent: { ...parent, blocker },
    relationship: {
      kind: 'harness-intervention.v1',
      parentChangeId: parent.changeId,
      interventionChangeId,
      checkpointId: checkpoint.checkpointId,
      unblocks: parent.changeId,
      state: 'active',
    },
  });
}

// ---------------------------------------------------------------------------
// M10: versioned engine artifact and human-verified maintenance grant
// ---------------------------------------------------------------------------

export interface EngineArtifactInput {
  sourceChangeId: string;
  sourceDigest: Sha256Digest;
  executableDigest: Sha256Digest;
  protocolVersion: number;
  canReadSessionSchemas: string[];
  writesSessionSchema: string;
  policySchemaVersion: number;
  smokeReportDigest: Sha256Digest;
}

export interface EngineArtifact extends EngineArtifactInput {
  kind: 'engine-artifact.v1';
  artifactId: Sha256Digest;
}

function engineArtifactPayload(input: EngineArtifactInput) {
  return {
    kind: 'engine-artifact.v1' as const,
    sourceChangeId: input.sourceChangeId,
    sourceDigest: input.sourceDigest,
    executableDigest: input.executableDigest,
    protocolVersion: input.protocolVersion,
    canReadSessionSchemas: input.canReadSessionSchemas,
    writesSessionSchema: input.writesSessionSchema,
    policySchemaVersion: input.policySchemaVersion,
    smokeReportDigest: input.smokeReportDigest,
  };
}

export function createEngineArtifact(
  input: EngineArtifactInput,
): EngineArtifact {
  assertNonEmpty(
    input.sourceChangeId,
    'ENGINE_ARTIFACT_INVALID',
    'Source change id',
  );
  assertDigest(input.sourceDigest, 'ENGINE_ARTIFACT_INVALID');
  assertDigest(input.executableDigest, 'ENGINE_ARTIFACT_INVALID');
  assertDigest(input.smokeReportDigest, 'ENGINE_ARTIFACT_INVALID');
  if (
    !Number.isSafeInteger(input.protocolVersion) ||
    input.protocolVersion < 1
  ) {
    throw workflowError(
      'ENGINE_ARTIFACT_INVALID',
      'Invalid engine protocol version.',
      ExitCode.usage,
    );
  }
  if (
    !Number.isSafeInteger(input.policySchemaVersion) ||
    input.policySchemaVersion < 1
  ) {
    throw workflowError(
      'ENGINE_ARTIFACT_INVALID',
      'Invalid policy schema version.',
      ExitCode.usage,
    );
  }
  assertNonEmpty(
    input.writesSessionSchema,
    'ENGINE_ARTIFACT_INVALID',
    'Written session schema',
  );
  for (const schema of input.canReadSessionSchemas) {
    assertNonEmpty(
      schema,
      'ENGINE_ARTIFACT_INVALID',
      'Readable session schema',
    );
  }
  assertSortedUnique(input.canReadSessionSchemas, 'ENGINE_ARTIFACT_INVALID');
  if (!input.canReadSessionSchemas.includes(input.writesSessionSchema)) {
    throw workflowError(
      'ENGINE_ARTIFACT_INVALID',
      'Engine must be able to read the session schema that it writes.',
      ExitCode.usage,
    );
  }
  const payload = engineArtifactPayload(input);
  return freezeDeep({ ...payload, artifactId: canonicalDigest(payload) });
}

export type HarnessMaintenanceOperation =
  | 'adopt-engine-into-parent'
  | 'build-engine-artifact'
  | 'create-isolated-workspace'
  | 'modify-engine'
  | 'run-engine-tests';

export type HarnessMaintenanceWaiver =
  | 'active-change-exclusivity'
  | 'clean-worktree-required'
  | 'engine-path-protection'
  | 'parent-terminalization-required'
  | 'selected-workflow-check';

const MAINTENANCE_OPERATIONS: readonly HarnessMaintenanceOperation[] = [
  'adopt-engine-into-parent',
  'build-engine-artifact',
  'create-isolated-workspace',
  'modify-engine',
  'run-engine-tests',
];

const MAINTENANCE_WAIVERS: readonly HarnessMaintenanceWaiver[] = [
  'active-change-exclusivity',
  'clean-worktree-required',
  'engine-path-protection',
  'parent-terminalization-required',
  'selected-workflow-check',
];

export interface HarnessMaintenanceGrantPayload {
  kind: 'harness-maintenance-grant.v1';
  grantId: string;
  parentChangeId: string;
  interventionChangeId: string;
  scope: {
    paths: string[];
    operations: HarnessMaintenanceOperation[];
  };
  waivers: HarnessMaintenanceWaiver[];
  engineFromDigest: Sha256Digest;
  sessionSchema: string;
  maxLocalAdoptions: number;
  issuedAt: string;
  expiresAt: string;
  humanSigner: string;
  reason: string;
}

export interface HarnessMaintenanceGrantEnvelope {
  payload: HarnessMaintenanceGrantPayload;
  signature: string;
}

export interface VerifiedHarnessMaintenanceGrant {
  payload: HarnessMaintenanceGrantPayload;
  signature: string;
  verifiedAt: string;
  verification: 'human-signature-verified';
}

export function canonicalHarnessMaintenanceGrantPayload(
  payload: HarnessMaintenanceGrantPayload,
): string {
  return `${canonicalJson(payload)}\n`;
}

function validateMaintenancePayload(
  payload: HarnessMaintenanceGrantPayload,
): void {
  if (payload.kind !== 'harness-maintenance-grant.v1') {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Unknown maintenance grant schema.',
      ExitCode.usage,
    );
  }
  for (const [value, label] of [
    [payload.grantId, 'Grant id'],
    [payload.parentChangeId, 'Parent change id'],
    [payload.interventionChangeId, 'Intervention change id'],
    [payload.sessionSchema, 'Session schema'],
    [payload.humanSigner, 'Human signer'],
    [payload.reason, 'Reason'],
  ] as const) {
    assertNonEmpty(value, 'MAINTENANCE_GRANT_INVALID', label);
  }
  assertDigest(payload.engineFromDigest, 'MAINTENANCE_GRANT_INVALID');
  if (payload.parentChangeId === payload.interventionChangeId) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Parent and intervention must differ.',
      ExitCode.usage,
    );
  }
  if (!Array.isArray(payload.scope.paths) || payload.scope.paths.length === 0) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Maintenance scope needs exact path globs.',
      ExitCode.usage,
    );
  }
  for (const path of payload.scope.paths) {
    assertSafePath(path, true, 'MAINTENANCE_GRANT_INVALID');
  }
  assertSortedUnique(payload.scope.paths, 'MAINTENANCE_GRANT_INVALID');
  if (
    !Array.isArray(payload.scope.operations) ||
    payload.scope.operations.length === 0
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Maintenance scope needs operations.',
      ExitCode.usage,
    );
  }
  assertSortedUnique(payload.scope.operations, 'MAINTENANCE_GRANT_INVALID');
  if (
    payload.scope.operations.some(
      (operation) => !MAINTENANCE_OPERATIONS.includes(operation),
    )
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_OPERATION_UNKNOWN',
      'Unknown maintenance operation.',
      ExitCode.guard,
    );
  }
  if (!payload.scope.operations.includes('adopt-engine-into-parent')) {
    throw workflowError(
      'MAINTENANCE_GRANT_ADOPTION_NOT_AUTHORIZED',
      'Maintenance grant does not authorize local engine adoption.',
      ExitCode.guard,
    );
  }
  assertSortedUnique(payload.waivers, 'MAINTENANCE_GRANT_INVALID');
  if (payload.waivers.some((waiver) => !MAINTENANCE_WAIVERS.includes(waiver))) {
    throw workflowError(
      'MAINTENANCE_GRANT_NONWAIVABLE_INVARIANT',
      'Maintenance grant attempts to waive a recovery invariant.',
      ExitCode.guard,
    );
  }
  if (payload.maxLocalAdoptions !== 1) {
    throw workflowError(
      'MAINTENANCE_GRANT_V1_ADOPTION_LIMIT_INVALID',
      'V1 maintenance grants authorize exactly one local adoption.',
      ExitCode.guard,
    );
  }
  assertIsoTimestamp(payload.issuedAt, 'MAINTENANCE_GRANT_INVALID');
  assertIsoTimestamp(payload.expiresAt, 'MAINTENANCE_GRANT_INVALID');
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Maintenance grant expiry must follow issue time.',
      ExitCode.usage,
    );
  }
}

export function verifyHarnessMaintenanceGrant(
  envelope: HarnessMaintenanceGrantEnvelope,
  context: {
    now: Date;
    parent: ParentChangeState;
    relationship: HarnessInterventionRelationship;
    checkpoint: WipCheckpoint;
    verifyHumanSignature: HumanSignatureVerifier;
  },
): VerifiedHarnessMaintenanceGrant {
  validateMaintenancePayload(envelope.payload);
  assertNonEmpty(
    envelope.signature,
    'MAINTENANCE_GRANT_SIGNATURE_INVALID',
    'Signature',
  );
  const checkpoint = verifyWipCheckpoint(context.checkpoint);
  const blocker = context.parent.blocker;
  if (
    context.parent.status !== 'active' ||
    blocker?.kind !== 'harness-intervention' ||
    blocker.checkpointId !== checkpoint.checkpointId ||
    blocker.blockedBy !== context.relationship.interventionChangeId ||
    context.relationship.state !== 'active' ||
    context.relationship.parentChangeId !== context.parent.changeId ||
    context.relationship.checkpointId !== checkpoint.checkpointId
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_INTERVENTION_MISMATCH',
      'Maintenance grant requires the exact active intervention relationship.',
      ExitCode.verification,
    );
  }
  const payload = envelope.payload;
  if (
    payload.parentChangeId !== context.parent.changeId ||
    payload.interventionChangeId !==
      context.relationship.interventionChangeId ||
    payload.engineFromDigest !== context.parent.engineBinding ||
    payload.engineFromDigest !== checkpoint.engineDigest ||
    payload.sessionSchema !== context.parent.sessionSchema
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_BINDING_MISMATCH',
      'Maintenance grant does not match the parent checkpoint and engine binding.',
      ExitCode.verification,
    );
  }
  if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
    throw workflowError(
      'MAINTENANCE_GRANT_EXPIRED',
      'Maintenance grant has expired.',
      ExitCode.staleState,
    );
  }
  const signatureValid = verifyHumanSignatureSafely(
    context.verifyHumanSignature,
    canonicalHarnessMaintenanceGrantPayload(payload),
    envelope.signature,
    payload.humanSigner,
    HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
  );
  if (!signatureValid) {
    throw workflowError(
      'MAINTENANCE_GRANT_SIGNATURE_INVALID',
      'Human maintenance grant signature could not be verified.',
      ExitCode.verification,
    );
  }
  return freezeDeep({
    payload: { ...payload },
    signature: envelope.signature,
    verifiedAt: context.now.toISOString(),
    verification: 'human-signature-verified',
  });
}

// ---------------------------------------------------------------------------
// M10: adoption journal, rollback, and deterministic crash recovery
// ---------------------------------------------------------------------------

export type EngineAdoptionState =
  | 'PREPARED'
  | 'PARENT_CHECKPOINTED'
  | 'ENGINE_BINDING_UPDATED'
  | 'NEW_ENGINE_STARTED'
  | 'ROLLBACK_REQUIRED'
  | 'HEALTHY'
  | 'COMMITTED'
  | 'ENGINE_BINDING_ROLLED_BACK';

export interface EngineAdoptionJournal {
  kind: 'engine-adoption-journal.v1';
  txId: string;
  grantId: string;
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  fromEngineDigest: Sha256Digest;
  toEngineDigest: Sha256Digest;
  artifactId: Sha256Digest;
  sessionSchema: string;
  state: EngineAdoptionState;
  history: Array<{ state: EngineAdoptionState; at: string }>;
  journalDigest: Sha256Digest;
}

type EngineAdoptionEvent =
  | { kind: 'parent-checkpointed'; at: string }
  | { kind: 'engine-binding-updated'; at: string }
  | { kind: 'new-engine-started'; at: string }
  | { kind: 'health-check-passed'; at: string }
  | { kind: 'health-check-failed'; at: string }
  | { kind: 'commit'; at: string }
  | { kind: 'engine-binding-rolled-back'; at: string };

function adoptionJournalPayload(
  journal: Omit<EngineAdoptionJournal, 'journalDigest'>,
) {
  return { ...journal };
}

function buildAdoptionJournal(
  journal: Omit<EngineAdoptionJournal, 'journalDigest'>,
): EngineAdoptionJournal {
  return freezeDeep({
    ...journal,
    journalDigest: canonicalDigest(adoptionJournalPayload(journal)),
  });
}

function verifyAdoptionJournal(journal: EngineAdoptionJournal): void {
  assertDigest(journal.journalDigest, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
  const { journalDigest, ...payload } = journal;
  if (
    canonicalDigest(adoptionJournalPayload(payload)) !== journalDigest ||
    journal.history.length === 0 ||
    journal.history.at(-1)?.state !== journal.state
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_JOURNAL_CORRUPT',
      'Engine adoption journal failed integrity verification.',
      ExitCode.verification,
    );
  }
  for (let index = 1; index < journal.history.length; index += 1) {
    assertMonotonicTimestamp(
      journal.history[index - 1].at,
      journal.history[index].at,
      'ENGINE_ADOPTION_JOURNAL_CORRUPT',
    );
  }
}

export function prepareEngineAdoption(input: {
  txId: string;
  parent: ParentChangeState;
  relationship: HarnessInterventionRelationship;
  checkpoint: WipCheckpoint;
  artifact: EngineArtifact;
  maintenanceGrant: VerifiedHarnessMaintenanceGrant;
  priorLocalAdoptions: number;
  now: Date;
}): EngineAdoptionJournal {
  assertNonEmpty(
    input.txId,
    'ENGINE_ADOPTION_INVALID',
    'Adoption transaction id',
  );
  const checkpoint = verifyWipCheckpoint(input.checkpoint);
  const rebuiltArtifact = createEngineArtifact(input.artifact);
  if (rebuiltArtifact.artifactId !== input.artifact.artifactId) {
    throw workflowError(
      'ENGINE_ARTIFACT_DIGEST_MISMATCH',
      'Engine artifact digest mismatch.',
      ExitCode.verification,
    );
  }
  if (
    input.parent.status !== 'active' ||
    input.parent.blocker?.kind !== 'harness-intervention' ||
    input.parent.blocker.checkpointId !== checkpoint.checkpointId ||
    input.parent.blocker.blockedBy !==
      input.relationship.interventionChangeId ||
    input.relationship.state !== 'active' ||
    input.relationship.checkpointId !== checkpoint.checkpointId ||
    input.artifact.sourceChangeId !== input.relationship.interventionChangeId
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_INTERVENTION_MISMATCH',
      'Adoption is not bound to the exact active intervention.',
      ExitCode.verification,
    );
  }
  if (
    input.maintenanceGrant.verification !== 'human-signature-verified' ||
    input.maintenanceGrant.payload.grantId.length === 0 ||
    input.maintenanceGrant.payload.parentChangeId !== input.parent.changeId ||
    input.maintenanceGrant.payload.interventionChangeId !==
      input.relationship.interventionChangeId ||
    input.maintenanceGrant.payload.engineFromDigest !==
      input.parent.engineBinding
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_GRANT_MISMATCH',
      'Verified maintenance grant does not authorize this adoption.',
      ExitCode.guard,
    );
  }
  if (
    input.now.getTime() >= Date.parse(input.maintenanceGrant.payload.expiresAt)
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_GRANT_EXPIRED',
      'Maintenance grant expired before adoption.',
      ExitCode.staleState,
    );
  }
  if (
    !Number.isSafeInteger(input.priorLocalAdoptions) ||
    input.priorLocalAdoptions < 0 ||
    input.priorLocalAdoptions >=
      input.maintenanceGrant.payload.maxLocalAdoptions
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_LIMIT_EXHAUSTED',
      'Maintenance grant local adoption limit is exhausted.',
      ExitCode.conflict,
    );
  }
  if (
    input.artifact.writesSessionSchema !== input.parent.sessionSchema ||
    input.maintenanceGrant.payload.sessionSchema !==
      input.parent.sessionSchema ||
    !input.artifact.canReadSessionSchemas.includes(input.parent.sessionSchema)
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_SCHEMA_CHANGE_FORBIDDEN',
      'V1 local adoption cannot modify the durable session schema.',
      ExitCode.guard,
    );
  }
  const at = input.now.toISOString();
  return buildAdoptionJournal({
    kind: 'engine-adoption-journal.v1',
    txId: input.txId,
    grantId: input.maintenanceGrant.payload.grantId,
    parentChangeId: input.parent.changeId,
    interventionChangeId: input.relationship.interventionChangeId,
    checkpointId: checkpoint.checkpointId,
    fromEngineDigest: input.parent.engineBinding,
    toEngineDigest: input.artifact.executableDigest,
    artifactId: input.artifact.artifactId,
    sessionSchema: input.parent.sessionSchema,
    state: 'PREPARED',
    history: [{ state: 'PREPARED', at }],
  });
}

const ADOPTION_TRANSITIONS: Record<
  EngineAdoptionState,
  Partial<Record<EngineAdoptionEvent['kind'], EngineAdoptionState>>
> = {
  PREPARED: { 'parent-checkpointed': 'PARENT_CHECKPOINTED' },
  PARENT_CHECKPOINTED: { 'engine-binding-updated': 'ENGINE_BINDING_UPDATED' },
  ENGINE_BINDING_UPDATED: { 'new-engine-started': 'NEW_ENGINE_STARTED' },
  NEW_ENGINE_STARTED: {
    'health-check-passed': 'HEALTHY',
    'health-check-failed': 'ROLLBACK_REQUIRED',
  },
  ROLLBACK_REQUIRED: {
    'engine-binding-rolled-back': 'ENGINE_BINDING_ROLLED_BACK',
  },
  HEALTHY: { commit: 'COMMITTED' },
  COMMITTED: {},
  ENGINE_BINDING_ROLLED_BACK: {},
};

export function advanceEngineAdoption(
  journal: EngineAdoptionJournal,
  event: EngineAdoptionEvent,
): EngineAdoptionJournal {
  verifyAdoptionJournal(journal);
  const nextState = ADOPTION_TRANSITIONS[journal.state][event.kind];
  if (nextState === undefined) {
    throw workflowError(
      'ENGINE_ADOPTION_TRANSITION_INVALID',
      `Cannot apply ${event.kind} while adoption is ${journal.state}.`,
      ExitCode.conflict,
    );
  }
  assertMonotonicTimestamp(
    journal.history.at(-1)!.at,
    event.at,
    'ENGINE_ADOPTION_TRANSITION_INVALID',
  );
  const { journalDigest: _journalDigest, ...payload } = journal;
  return buildAdoptionJournal({
    ...payload,
    state: nextState,
    history: [...journal.history, { state: nextState, at: event.at }],
  });
}

export type EngineAdoptionRecoveryDecision = {
  action:
    | 'none'
    | 'checkpoint-parent'
    | 'update-engine-binding'
    | 'start-new-engine'
    | 'run-health-check'
    | 'finalize-commit'
    | 'rollback-engine-binding';
  authoritativeEngineDigest: Sha256Digest;
  blockerCleared: boolean;
};

export function decideEngineAdoptionRecovery(
  journal: EngineAdoptionJournal,
): EngineAdoptionRecoveryDecision {
  verifyAdoptionJournal(journal);
  switch (journal.state) {
    case 'PREPARED':
      return {
        action: 'checkpoint-parent',
        authoritativeEngineDigest: journal.fromEngineDigest,
        blockerCleared: false,
      };
    case 'PARENT_CHECKPOINTED':
      return {
        action: 'update-engine-binding',
        authoritativeEngineDigest: journal.fromEngineDigest,
        blockerCleared: false,
      };
    case 'ENGINE_BINDING_UPDATED':
      return {
        action: 'start-new-engine',
        authoritativeEngineDigest: journal.toEngineDigest,
        blockerCleared: false,
      };
    case 'NEW_ENGINE_STARTED':
      return {
        action: 'run-health-check',
        authoritativeEngineDigest: journal.toEngineDigest,
        blockerCleared: false,
      };
    case 'ROLLBACK_REQUIRED':
      return {
        action: 'rollback-engine-binding',
        authoritativeEngineDigest: journal.fromEngineDigest,
        blockerCleared: false,
      };
    case 'HEALTHY':
      return {
        action: 'finalize-commit',
        authoritativeEngineDigest: journal.toEngineDigest,
        blockerCleared: false,
      };
    case 'COMMITTED':
      return {
        action: 'none',
        authoritativeEngineDigest: journal.toEngineDigest,
        blockerCleared: true,
      };
    case 'ENGINE_BINDING_ROLLED_BACK':
      return {
        action: 'none',
        authoritativeEngineDigest: journal.fromEngineDigest,
        blockerCleared: false,
      };
  }
}

export function finalizeEngineAdoption(
  parent: ParentChangeState,
  relationship: HarnessInterventionRelationship,
  journal: EngineAdoptionJournal,
): {
  parent: ParentChangeState;
  relationship: HarnessInterventionRelationship;
} {
  verifyAdoptionJournal(journal);
  if (
    parent.status !== 'active' ||
    parent.blocker?.kind !== 'harness-intervention' ||
    parent.changeId !== journal.parentChangeId ||
    parent.blocker.checkpointId !== journal.checkpointId ||
    parent.blocker.blockedBy !== journal.interventionChangeId ||
    relationship.parentChangeId !== journal.parentChangeId ||
    relationship.interventionChangeId !== journal.interventionChangeId ||
    relationship.state !== 'active'
  ) {
    throw workflowError(
      'ENGINE_ADOPTION_FINALIZE_MISMATCH',
      'Parent or intervention relationship changed during adoption.',
      ExitCode.staleState,
    );
  }
  if (journal.state === 'COMMITTED') {
    return freezeDeep({
      parent: {
        ...parent,
        engineBinding: journal.toEngineDigest,
        blocker: null,
      },
      relationship: { ...relationship, state: 'adopted' },
    });
  }
  if (journal.state === 'ENGINE_BINDING_ROLLED_BACK') {
    return freezeDeep({
      parent: { ...parent, engineBinding: journal.fromEngineDigest },
      relationship: { ...relationship },
    });
  }
  throw workflowError(
    'ENGINE_ADOPTION_NOT_TERMINAL',
    'Adoption can only finalize after commit or durable rollback.',
    ExitCode.conflict,
  );
}

// ---------------------------------------------------------------------------
// M11: protected capability closure and candidate classification
// ---------------------------------------------------------------------------

export const REQUIRED_PROTECTED_CAPABILITIES = [
  'adoption.journal',
  'apply.journal',
  'audit.append',
  'authorization.verify',
  'control-plane.update',
  'effect.monitor',
  'human.trust-roots',
  'policy.classify',
  'recovery.rollback',
  'ref-generation.ledger',
  'sandbox.enforce',
  'workflow.abort-or-supersede',
] as const;

export type ProtectedCapability =
  (typeof REQUIRED_PROTECTED_CAPABILITIES)[number];

export interface ProtectedCapabilityEntry {
  capability: ProtectedCapability;
  entrypoints: string[];
  dependencies: string[];
  contentDigest: Sha256Digest;
  closureDigest: Sha256Digest;
}

export interface ProtectedCapabilityManifest {
  kind: 'protected-capability-manifest.v1';
  schemaVersion: 1;
  manifestPath: string;
  entries: ProtectedCapabilityEntry[];
  manifestDigest: Sha256Digest;
}

export function protectedCapabilityClosureDigest(
  entrypoints: readonly string[],
  dependencies: readonly string[],
  contentDigest: Sha256Digest,
): Sha256Digest {
  for (const path of [...entrypoints, ...dependencies]) {
    assertSafePath(path, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  }
  assertSortedUnique(entrypoints, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  assertSortedUnique(dependencies, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  assertDigest(contentDigest, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  return canonicalDigest({ entrypoints, dependencies, contentDigest });
}

function protectedManifestPayload(
  input: Omit<ProtectedCapabilityManifest, 'manifestDigest'>,
) {
  return { ...input };
}

export function createProtectedCapabilityManifest(input: {
  schemaVersion: 1;
  manifestPath: string;
  entries: ProtectedCapabilityEntry[];
}): ProtectedCapabilityManifest {
  if (input.schemaVersion !== 1) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'Unknown manifest schema.',
      ExitCode.usage,
    );
  }
  assertSafePath(
    input.manifestPath,
    false,
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
  );
  const entries = [...input.entries]
    .map((entry) => {
      if (!REQUIRED_PROTECTED_CAPABILITIES.includes(entry.capability)) {
        throw workflowError(
          'PROTECTED_CAPABILITY_UNKNOWN',
          `Unknown protected capability: ${String(entry.capability)}`,
          ExitCode.guard,
        );
      }
      if (entry.entrypoints.length === 0) {
        throw workflowError(
          'PROTECTED_CAPABILITY_MANIFEST_INVALID',
          `Protected capability ${entry.capability} needs an entrypoint.`,
          ExitCode.usage,
        );
      }
      for (const path of [...entry.entrypoints, ...entry.dependencies]) {
        assertSafePath(path, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
      }
      assertSortedUnique(
        entry.entrypoints,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      assertSortedUnique(
        entry.dependencies,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      assertDigest(
        entry.contentDigest,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      assertDigest(
        entry.closureDigest,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      if (
        entry.closureDigest !==
        protectedCapabilityClosureDigest(
          entry.entrypoints,
          entry.dependencies,
          entry.contentDigest,
        )
      ) {
        throw workflowError(
          'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH',
          `Protected capability ${entry.capability} closure digest is invalid.`,
          ExitCode.verification,
        );
      }
      return {
        capability: entry.capability,
        entrypoints: [...entry.entrypoints],
        dependencies: [...entry.dependencies],
        contentDigest: entry.contentDigest,
        closureDigest: entry.closureDigest,
      };
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
  assertSortedUnique(
    entries.map((entry) => entry.capability),
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
  );
  const missing = REQUIRED_PROTECTED_CAPABILITIES.filter(
    (capability) => !entries.some((entry) => entry.capability === capability),
  );
  if (missing.length > 0) {
    throw workflowError(
      'PROTECTED_CAPABILITY_REQUIRED_MISSING',
      `Protected capability manifest is missing: ${missing.join(', ')}`,
      ExitCode.guard,
    );
  }
  const payload = protectedManifestPayload({
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: input.manifestPath,
    entries,
  });
  return freezeDeep({ ...payload, manifestDigest: canonicalDigest(payload) });
}

function verifyProtectedManifest(manifest: ProtectedCapabilityManifest): void {
  const rebuilt = createProtectedCapabilityManifest(manifest);
  if (rebuilt.manifestDigest !== manifest.manifestDigest) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_DIGEST_MISMATCH',
      'Protected capability manifest digest mismatch.',
      ExitCode.verification,
    );
  }
}

export interface ExactControlPlaneChange {
  path: string;
  beforeDigest: Sha256Digest | null;
  afterDigest: Sha256Digest | null;
}

function normalizedExactChanges(
  changes: readonly ExactControlPlaneChange[],
): ExactControlPlaneChange[] {
  if (changes.length === 0) {
    throw workflowError(
      'CONTROL_PLANE_EXACT_DIFF_INVALID',
      'Candidate exact diff is empty.',
      ExitCode.usage,
    );
  }
  const normalized = changes
    .map((change) => {
      assertSafePath(change.path, false, 'CONTROL_PLANE_EXACT_DIFF_INVALID');
      if (change.beforeDigest !== null) {
        assertDigest(change.beforeDigest, 'CONTROL_PLANE_EXACT_DIFF_INVALID');
      }
      if (change.afterDigest !== null) {
        assertDigest(change.afterDigest, 'CONTROL_PLANE_EXACT_DIFF_INVALID');
      }
      if (
        (change.beforeDigest === null && change.afterDigest === null) ||
        change.beforeDigest === change.afterDigest
      ) {
        throw workflowError(
          'CONTROL_PLANE_EXACT_DIFF_INVALID',
          'Exact diff contains a no-op.',
          ExitCode.usage,
        );
      }
      return { ...change };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  assertSortedUnique(
    normalized.map((change) => change.path),
    'CONTROL_PLANE_EXACT_DIFF_INVALID',
  );
  return normalized;
}

export function controlPlaneCandidateDigest(
  changes: readonly ExactControlPlaneChange[],
): Sha256Digest {
  return canonicalDigest({
    kind: 'control-plane-candidate.v1',
    changes: normalizedExactChanges(changes),
  });
}

export interface ProtectedCandidateImpact {
  class: 'A' | 'C';
  kind: 'ordinary' | 'control-plane';
  affectedCapabilities: ProtectedCapability[];
  manifestChanged: boolean;
}

export function classifyProtectedCandidateImpact(input: {
  beforeManifest: ProtectedCapabilityManifest;
  afterManifest: ProtectedCapabilityManifest;
  changes: ExactControlPlaneChange[];
}): ProtectedCandidateImpact {
  verifyProtectedManifest(input.beforeManifest);
  verifyProtectedManifest(input.afterManifest);
  const changes = normalizedExactChanges(input.changes);
  const changedPaths = new Set(changes.map((change) => change.path));
  const manifestChanged =
    changedPaths.has(input.beforeManifest.manifestPath) ||
    input.beforeManifest.manifestDigest !== input.afterManifest.manifestDigest;
  const capabilities = new Set<ProtectedCapability>();
  for (const capability of REQUIRED_PROTECTED_CAPABILITIES) {
    const before = input.beforeManifest.entries.find(
      (entry) => entry.capability === capability,
    )!;
    const after = input.afterManifest.entries.find(
      (entry) => entry.capability === capability,
    )!;
    const paths = new Set([
      ...before.entrypoints,
      ...before.dependencies,
      ...after.entrypoints,
      ...after.dependencies,
    ]);
    if (
      before.closureDigest !== after.closureDigest ||
      [...changedPaths].some((path) => paths.has(path))
    ) {
      capabilities.add(capability);
    }
  }
  const affectedCapabilities = [
    ...capabilities,
  ].sort() as ProtectedCapability[];
  const controlPlane = manifestChanged || affectedCapabilities.length > 0;
  return freezeDeep(
    controlPlane
      ? {
          class: 'C',
          kind: 'control-plane',
          affectedCapabilities,
          manifestChanged,
        }
      : {
          class: 'A',
          kind: 'ordinary',
          affectedCapabilities: [],
          manifestChanged: false,
        },
  );
}

// ---------------------------------------------------------------------------
// M11: exact Control-Plane Grant and pure minimal updater transaction
// ---------------------------------------------------------------------------

export interface ControlPlaneIndependentReviewAttestationPayload {
  kind: 'control-plane-independent-review.v1';
  repositoryId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  affectedCapabilities: ProtectedCapability[];
  verdict: 'approved';
  reviewedAt: string;
  reviewSummary: string;
  reviewer: string;
}

export interface ControlPlaneIndependentReviewAttestationEnvelope {
  payload: ControlPlaneIndependentReviewAttestationPayload;
  signature: string;
}

export interface VerifiedControlPlaneIndependentReviewAttestation {
  payload: ControlPlaneIndependentReviewAttestationPayload;
  signature: string;
  attestationDigest: Sha256Digest;
  verification: 'independent-human-signature-verified';
}

export function canonicalControlPlaneIndependentReviewAttestationPayload(
  payload: ControlPlaneIndependentReviewAttestationPayload,
): string {
  return `${canonicalJson(payload)}\n`;
}

export function controlPlaneIndependentReviewAttestationDigest(
  envelope: ControlPlaneIndependentReviewAttestationEnvelope,
): Sha256Digest {
  validateControlPlaneIndependentReviewAttestation(envelope);
  return canonicalDigest(envelope);
}

export function verifyControlPlaneIndependentReviewAttestation(
  envelope: ControlPlaneIndependentReviewAttestationEnvelope,
  context: {
    expectedDigest: Sha256Digest;
    repositoryId: string;
    candidateDigest: Sha256Digest;
    beforeClosureDigest: Sha256Digest;
    afterClosureDigest: Sha256Digest;
    recoveryBundleDigest: Sha256Digest;
    affectedCapabilities: ProtectedCapability[];
    grantHumanSigner: string;
    grantIssuedAt: string;
    verifyHumanSignature: HumanSignatureVerifier;
  },
): VerifiedControlPlaneIndependentReviewAttestation {
  validateControlPlaneIndependentReviewAttestation(envelope);
  assertDigest(
    context.expectedDigest,
    'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
  );
  const attestationDigest = canonicalDigest(envelope);
  if (attestationDigest !== context.expectedDigest) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH',
      'Independent review bytes do not match the grant-bound digest.',
      ExitCode.verification,
    );
  }
  const payload = envelope.payload;
  assertIsoTimestamp(
    context.grantIssuedAt,
    'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
  );
  if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID',
      'Independent review must be completed before grant issuance.',
      ExitCode.guard,
    );
  }
  if (payload.reviewer === context.grantHumanSigner) {
    throw workflowError(
      'CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT',
      'The independent reviewer must differ from the grant signer.',
      ExitCode.guard,
    );
  }
  if (payload.repositoryId !== context.repositoryId) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_REPOSITORY_MISMATCH',
      'Independent review is bound to a different repository.',
      ExitCode.verification,
    );
  }
  if (payload.candidateDigest !== context.candidateDigest) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_CANDIDATE_MISMATCH',
      'Independent review is bound to a different candidate.',
      ExitCode.verification,
    );
  }
  if (
    payload.beforeClosureDigest !== context.beforeClosureDigest ||
    payload.afterClosureDigest !== context.afterClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_CLOSURE_MISMATCH',
      'Independent review is bound to different protected closures.',
      ExitCode.verification,
    );
  }
  if (payload.recoveryBundleDigest !== context.recoveryBundleDigest) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_RECOVERY_MISMATCH',
      'Independent review is bound to a different recovery bundle.',
      ExitCode.verification,
    );
  }
  if (!sameJson(payload.affectedCapabilities, context.affectedCapabilities)) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_CAPABILITY_MISMATCH',
      'Independent review does not bind the exact affected capabilities.',
      ExitCode.verification,
    );
  }
  if (
    !verifyHumanSignatureSafely(
      context.verifyHumanSignature,
      canonicalControlPlaneIndependentReviewAttestationPayload(payload),
      envelope.signature,
      payload.reviewer,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE,
    )
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
      'Independent review attestation signature could not be verified.',
      ExitCode.verification,
    );
  }
  return freezeDeep({
    payload: {
      ...payload,
      affectedCapabilities: [...payload.affectedCapabilities],
    },
    signature: envelope.signature,
    attestationDigest,
    verification: 'independent-human-signature-verified',
  });
}

function validateControlPlaneIndependentReviewAttestation(
  envelope: ControlPlaneIndependentReviewAttestationEnvelope,
): void {
  if (
    !hasExactObjectKeys(envelope, ['payload', 'signature']) ||
    !hasExactObjectKeys(envelope.payload, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'candidateDigest',
      'kind',
      'recoveryBundleDigest',
      'repositoryId',
      'reviewSummary',
      'reviewedAt',
      'reviewer',
      'verdict',
    ]) ||
    envelope.payload.kind !== 'control-plane-independent-review.v1' ||
    envelope.payload.verdict !== 'approved'
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
      'Independent review attestation has an unknown or non-approved schema.',
      ExitCode.guard,
    );
  }
  const payload = envelope.payload;
  for (const [value, label] of [
    [payload.repositoryId, 'Repository id'],
    [payload.reviewSummary, 'Review summary'],
    [payload.reviewer, 'Reviewer'],
    [envelope.signature, 'Review signature'],
  ] as const) {
    assertNonEmpty(value, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', label);
  }
  for (const digest of [
    payload.candidateDigest,
    payload.beforeClosureDigest,
    payload.afterClosureDigest,
    payload.recoveryBundleDigest,
  ]) {
    assertDigest(digest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
  }
  if (
    !Array.isArray(payload.affectedCapabilities) ||
    payload.affectedCapabilities.some(
      (capability) => !REQUIRED_PROTECTED_CAPABILITIES.includes(capability),
    )
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
      'Independent review contains an unknown protected capability.',
      ExitCode.guard,
    );
  }
  assertSortedUnique(
    payload.affectedCapabilities,
    'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
  );
  assertIsoTimestamp(
    payload.reviewedAt,
    'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID',
  );
}

export interface ControlPlaneGrantPayload {
  kind: 'control-plane-grant.v1';
  grantId: string;
  mandateBinding: ControlPlaneTaskMandateBinding;
  repositoryId: string;
  candidateDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChange[];
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  affectedCapabilities: ProtectedCapability[];
  behaviorChangeSummary: string;
  recoveryBundle: {
    bundleDigest: Sha256Digest;
    previousClosureDigest: Sha256Digest;
    restartArtifactDigest: Sha256Digest;
    rollbackTestReportDigest: Sha256Digest;
  };
  independentReviewAttestationDigest: Sha256Digest;
  updaterVersion: number;
  oneShot: true;
  issuedAt: string;
  expiresAt: string;
  humanSigner: string;
}

export interface ControlPlaneTaskMandateBinding {
  schemaVersion: 1;
  parentTaskId: string;
  mandateId: string;
  mandateDigest: string;
  changeId: string;
  externalAuditRoot: string;
}

export function normalizeControlPlaneTaskMandateBinding(
  value: unknown,
): ControlPlaneTaskMandateBinding {
  if (
    !hasExactObjectKeys(value, [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'parentTaskId',
      'schemaVersion',
    ])
  ) {
    throw invalidControlPlaneTaskMandateBinding();
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.parentTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.parentTaskId) ||
    typeof raw.mandateId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      raw.mandateId,
    ) ||
    typeof raw.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.mandateDigest) ||
    typeof raw.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.changeId) ||
    typeof raw.externalAuditRoot !== 'string' ||
    !path.isAbsolute(raw.externalAuditRoot) ||
    path.normalize(raw.externalAuditRoot) !== raw.externalAuditRoot ||
    raw.externalAuditRoot === path.parse(raw.externalAuditRoot).root
  ) {
    throw invalidControlPlaneTaskMandateBinding();
  }
  return freezeDeep({
    schemaVersion: 1,
    parentTaskId: raw.parentTaskId,
    mandateId: raw.mandateId,
    mandateDigest: raw.mandateDigest,
    changeId: raw.changeId,
    externalAuditRoot: raw.externalAuditRoot,
  });
}

function invalidControlPlaneTaskMandateBinding() {
  return workflowError(
    'CONTROL_PLANE_TASK_MANDATE_BINDING_INVALID',
    'Control-Plane Grant requires an exact parent Task Mandate binding and absolute external audit root.',
    ExitCode.guard,
  );
}

export interface ControlPlaneGrantEnvelope {
  payload: ControlPlaneGrantPayload;
  signature: string;
}

export interface VerifiedControlPlaneGrant {
  payload: ControlPlaneGrantPayload;
  signature: string;
  verifiedAt: string;
  verification: 'human-signature-verified';
}

export function canonicalControlPlaneGrantPayload(
  payload: ControlPlaneGrantPayload,
): string {
  return `${canonicalJson(payload)}\n`;
}

export function verifyControlPlaneGrant(
  envelope: ControlPlaneGrantEnvelope,
  context: {
    now: Date;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    changes: ExactControlPlaneChange[];
    consumedGrantIds: ReadonlySet<string>;
    verifyHumanSignature: HumanSignatureVerifier;
  },
): VerifiedControlPlaneGrant {
  const payload = envelope.payload;
  if (
    !hasExactObjectKeys(payload, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateDigest',
      'exactChanges',
      'expiresAt',
      'grantId',
      'humanSigner',
      'independentReviewAttestationDigest',
      'issuedAt',
      'kind',
      'mandateBinding',
      'oneShot',
      'recoveryBundle',
      'repositoryId',
      'updaterVersion',
    ]) ||
    payload.kind !== 'control-plane-grant.v1' ||
    payload.oneShot !== true
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Unknown or non-one-shot control-plane grant.',
      ExitCode.guard,
    );
  }
  const mandateBinding = normalizeControlPlaneTaskMandateBinding(
    payload.mandateBinding,
  );
  for (const [value, label] of [
    [payload.grantId, 'Grant id'],
    [payload.repositoryId, 'Repository id'],
    [payload.behaviorChangeSummary, 'Behavior change summary'],
    [payload.humanSigner, 'Human signer'],
    [envelope.signature, 'Signature'],
  ] as const) {
    assertNonEmpty(value, 'CONTROL_PLANE_GRANT_INVALID', label);
  }
  if (context.consumedGrantIds.has(payload.grantId)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_ALREADY_CONSUMED',
      'One-shot Control-Plane Grant has already been consumed.',
      ExitCode.conflict,
    );
  }
  verifyProtectedManifest(context.beforeManifest);
  verifyProtectedManifest(context.afterManifest);
  if (payload.beforeClosureDigest !== context.beforeManifest.manifestDigest) {
    throw workflowError(
      'CONTROL_PLANE_BEFORE_CLOSURE_MISMATCH',
      'Control-Plane Grant is stale for the current protected closure.',
      ExitCode.staleState,
    );
  }
  if (payload.afterClosureDigest !== context.afterManifest.manifestDigest) {
    throw workflowError(
      'CONTROL_PLANE_AFTER_CLOSURE_MISMATCH',
      'Control-Plane Grant does not bind the candidate protected closure.',
      ExitCode.verification,
    );
  }
  const exactChanges = normalizedExactChanges(context.changes);
  if (!sameJson(payload.exactChanges, exactChanges)) {
    throw workflowError(
      'CONTROL_PLANE_EXACT_DIFF_MISMATCH',
      'Control-Plane Grant exact diff differs from the candidate.',
      ExitCode.verification,
    );
  }
  const expectedCandidateDigest = controlPlaneCandidateDigest(exactChanges);
  assertDigest(payload.candidateDigest, 'CONTROL_PLANE_GRANT_INVALID');
  if (payload.candidateDigest !== expectedCandidateDigest) {
    throw workflowError(
      'CONTROL_PLANE_CANDIDATE_DIGEST_MISMATCH',
      'Control-Plane Grant candidate digest mismatch.',
      ExitCode.verification,
    );
  }
  if (
    context.beforeManifest.manifestDigest !==
      context.afterManifest.manifestDigest &&
    !exactChanges.some(
      (change) =>
        change.path === context.beforeManifest.manifestPath &&
        change.beforeDigest === context.beforeManifest.manifestDigest &&
        change.afterDigest === context.afterManifest.manifestDigest,
    )
  ) {
    throw workflowError(
      'CONTROL_PLANE_MANIFEST_DIFF_MISSING',
      'Changed protected manifest is absent from the exact candidate diff.',
      ExitCode.verification,
    );
  }
  const impact = classifyProtectedCandidateImpact({
    beforeManifest: context.beforeManifest,
    afterManifest: context.afterManifest,
    changes: exactChanges,
  });
  if (impact.class !== 'C') {
    throw workflowError(
      'CONTROL_PLANE_GRANT_NOT_REQUIRED',
      'Candidate does not affect a protected capability.',
      ExitCode.usage,
    );
  }
  assertSortedUnique(
    payload.affectedCapabilities,
    'CONTROL_PLANE_GRANT_INVALID',
  );
  if (!sameJson(payload.affectedCapabilities, impact.affectedCapabilities)) {
    throw workflowError(
      'CONTROL_PLANE_CAPABILITY_IMPACT_MISMATCH',
      'Control-Plane Grant affected capabilities are not exact.',
      ExitCode.verification,
    );
  }
  for (const digest of [
    payload.beforeClosureDigest,
    payload.afterClosureDigest,
    payload.recoveryBundle.bundleDigest,
    payload.recoveryBundle.previousClosureDigest,
    payload.recoveryBundle.restartArtifactDigest,
    payload.recoveryBundle.rollbackTestReportDigest,
    payload.independentReviewAttestationDigest,
  ]) {
    assertDigest(digest, 'CONTROL_PLANE_GRANT_INVALID');
  }
  if (
    payload.recoveryBundle.previousClosureDigest !== payload.beforeClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_RECOVERY_BUNDLE_MISMATCH',
      'Recovery bundle does not restore the exact previous closure.',
      ExitCode.verification,
    );
  }
  if (
    !Number.isSafeInteger(payload.updaterVersion) ||
    payload.updaterVersion < 1
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Invalid minimal updater version.',
      ExitCode.usage,
    );
  }
  assertIsoTimestamp(payload.issuedAt, 'CONTROL_PLANE_GRANT_INVALID');
  assertIsoTimestamp(payload.expiresAt, 'CONTROL_PLANE_GRANT_INVALID');
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-plane grant expiry is invalid.',
      ExitCode.usage,
    );
  }
  if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_EXPIRED',
      'Control-Plane Grant has expired.',
      ExitCode.staleState,
    );
  }
  const signatureValid = verifyHumanSignatureSafely(
    context.verifyHumanSignature,
    canonicalControlPlaneGrantPayload(payload),
    envelope.signature,
    payload.humanSigner,
    CONTROL_PLANE_SIGNATURE_NAMESPACE,
  );
  if (!signatureValid) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      'Human Control-Plane Grant signature could not be verified.',
      ExitCode.verification,
    );
  }
  return freezeDeep({
    payload: {
      ...payload,
      mandateBinding: { ...mandateBinding },
      exactChanges: exactChanges.map((change) => ({ ...change })),
    },
    signature: envelope.signature,
    verifiedAt: context.now.toISOString(),
    verification: 'human-signature-verified',
  });
}

export type MinimalUpdaterState =
  | 'PREPARED'
  | 'OLD_CLOSURE_VERIFIED'
  | 'CANDIDATE_VERIFIED'
  | 'RECOVERY_VERIFIED'
  | 'SWITCHED'
  | 'SELF_TESTED'
  | 'ROLLBACK_REQUIRED'
  | 'FINALIZED'
  | 'ROLLED_BACK';

export interface MinimalUpdaterTransaction {
  kind: 'minimal-control-plane-updater.v1';
  txId: string;
  grantId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  updaterVersion: number;
  state: MinimalUpdaterState;
  history: Array<{ state: MinimalUpdaterState; at: string }>;
  journalDigest: Sha256Digest;
}

type MinimalUpdaterEvent =
  | { kind: 'old-closure-verified'; at: string }
  | { kind: 'candidate-verified'; at: string }
  | { kind: 'recovery-bundle-verified'; at: string }
  | { kind: 'atomic-switch-completed'; at: string }
  | { kind: 'self-tests-passed'; at: string }
  | { kind: 'self-tests-failed'; at: string }
  | { kind: 'finalize'; at: string }
  | { kind: 'rollback-completed'; at: string };

function minimalUpdaterPayload(
  tx: Omit<MinimalUpdaterTransaction, 'journalDigest'>,
) {
  return { ...tx };
}

function buildMinimalUpdaterTransaction(
  tx: Omit<MinimalUpdaterTransaction, 'journalDigest'>,
): MinimalUpdaterTransaction {
  return freezeDeep({
    ...tx,
    journalDigest: canonicalDigest(minimalUpdaterPayload(tx)),
  });
}

function verifyMinimalUpdaterTransaction(tx: MinimalUpdaterTransaction): void {
  assertDigest(tx.journalDigest, 'CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT');
  const { journalDigest, ...payload } = tx;
  if (
    canonicalDigest(minimalUpdaterPayload(payload)) !== journalDigest ||
    tx.history.length === 0 ||
    tx.history.at(-1)?.state !== tx.state
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT',
      'Minimal updater journal failed integrity verification.',
      ExitCode.verification,
    );
  }
}

export function prepareMinimalUpdaterTransaction(
  grant: VerifiedControlPlaneGrant,
  input: { txId: string; now: Date },
): MinimalUpdaterTransaction {
  assertNonEmpty(
    input.txId,
    'CONTROL_PLANE_UPDATE_INVALID',
    'Control-plane transaction id',
  );
  if (
    grant.verification !== 'human-signature-verified' ||
    grant.payload.oneShot !== true
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_GRANT_INVALID',
      'Minimal updater requires a verified one-shot Control-Plane Grant.',
      ExitCode.guard,
    );
  }
  if (input.now.getTime() >= Date.parse(grant.payload.expiresAt)) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_GRANT_EXPIRED',
      'Grant expired before updater preparation.',
      ExitCode.staleState,
    );
  }
  const at = input.now.toISOString();
  return buildMinimalUpdaterTransaction({
    kind: 'minimal-control-plane-updater.v1',
    txId: input.txId,
    grantId: grant.payload.grantId,
    candidateDigest: grant.payload.candidateDigest,
    beforeClosureDigest: grant.payload.beforeClosureDigest,
    afterClosureDigest: grant.payload.afterClosureDigest,
    recoveryBundleDigest: grant.payload.recoveryBundle.bundleDigest,
    updaterVersion: grant.payload.updaterVersion,
    state: 'PREPARED',
    history: [{ state: 'PREPARED', at }],
  });
}

const MINIMAL_UPDATER_TRANSITIONS: Record<
  MinimalUpdaterState,
  Partial<Record<MinimalUpdaterEvent['kind'], MinimalUpdaterState>>
> = {
  PREPARED: { 'old-closure-verified': 'OLD_CLOSURE_VERIFIED' },
  OLD_CLOSURE_VERIFIED: { 'candidate-verified': 'CANDIDATE_VERIFIED' },
  CANDIDATE_VERIFIED: { 'recovery-bundle-verified': 'RECOVERY_VERIFIED' },
  RECOVERY_VERIFIED: { 'atomic-switch-completed': 'SWITCHED' },
  SWITCHED: {
    'self-tests-passed': 'SELF_TESTED',
    'self-tests-failed': 'ROLLBACK_REQUIRED',
  },
  SELF_TESTED: { finalize: 'FINALIZED' },
  ROLLBACK_REQUIRED: { 'rollback-completed': 'ROLLED_BACK' },
  FINALIZED: {},
  ROLLED_BACK: {},
};

export function advanceMinimalUpdaterTransaction(
  tx: MinimalUpdaterTransaction,
  event: MinimalUpdaterEvent,
): MinimalUpdaterTransaction {
  verifyMinimalUpdaterTransaction(tx);
  const nextState = MINIMAL_UPDATER_TRANSITIONS[tx.state][event.kind];
  if (nextState === undefined) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_TRANSITION_INVALID',
      `Cannot apply ${event.kind} while updater is ${tx.state}.`,
      ExitCode.conflict,
    );
  }
  assertMonotonicTimestamp(
    tx.history.at(-1)!.at,
    event.at,
    'CONTROL_PLANE_UPDATE_TRANSITION_INVALID',
  );
  const { journalDigest: _journalDigest, ...payload } = tx;
  return buildMinimalUpdaterTransaction({
    ...payload,
    state: nextState,
    history: [...tx.history, { state: nextState, at: event.at }],
  });
}

export type ControlPlaneRecoveryDecision = {
  action:
    | 'none'
    | 'resume-verification'
    | 'rollback-with-recovery-bundle'
    | 'finalize';
  authoritativeClosureDigest: Sha256Digest;
  terminal: boolean;
};

export function decideControlPlaneRecovery(
  tx: MinimalUpdaterTransaction,
): ControlPlaneRecoveryDecision {
  verifyMinimalUpdaterTransaction(tx);
  switch (tx.state) {
    case 'PREPARED':
    case 'OLD_CLOSURE_VERIFIED':
    case 'CANDIDATE_VERIFIED':
    case 'RECOVERY_VERIFIED':
      return {
        action: 'resume-verification',
        authoritativeClosureDigest: tx.beforeClosureDigest,
        terminal: false,
      };
    case 'SWITCHED':
    case 'ROLLBACK_REQUIRED':
      return {
        action: 'rollback-with-recovery-bundle',
        authoritativeClosureDigest: tx.beforeClosureDigest,
        terminal: false,
      };
    case 'SELF_TESTED':
      return {
        action: 'finalize',
        authoritativeClosureDigest: tx.afterClosureDigest,
        terminal: false,
      };
    case 'FINALIZED':
      return {
        action: 'none',
        authoritativeClosureDigest: tx.afterClosureDigest,
        terminal: true,
      };
    case 'ROLLED_BACK':
      return {
        action: 'none',
        authoritativeClosureDigest: tx.beforeClosureDigest,
        terminal: true,
      };
  }
}

// ---------------------------------------------------------------------------
// M11: supersede restriction and legacy v1 read-only verification
// ---------------------------------------------------------------------------

export const WORKFLOW_SUPERSEDE_REASONS = [
  'semantic-decision-no-continuing-value',
  'user-abandoned-goal-for-different-workflow',
  'workflow-replaced',
  'workflows-merged',
] as const;

export type WorkflowSupersedeReason =
  (typeof WORKFLOW_SUPERSEDE_REASONS)[number];

const EXECUTION_FAILURE_REASONS = new Set([
  'environment-drift',
  'execution-limit-change',
  'network-error',
  'provider-adapter-upgrade',
  'provider-process-failure',
  'provider-timeout',
  'rate-limit',
  'retry-policy-change',
  'schema-invalid',
  'validator-repair',
  'worker-crash',
]);

export function validateWorkflowSupersedeReason(reason: string): {
  allowed: true;
  reason: WorkflowSupersedeReason;
} {
  if (WORKFLOW_SUPERSEDE_REASONS.includes(reason as WorkflowSupersedeReason)) {
    return { allowed: true, reason: reason as WorkflowSupersedeReason };
  }
  if (EXECUTION_FAILURE_REASONS.has(reason)) {
    throw workflowError(
      'SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN',
      'Execution failures must use retry, repair, grant, or recovery; they cannot supersede a workflow.',
      ExitCode.guard,
    );
  }
  if (reason === 'contract-or-baseline-change') {
    throw workflowError(
      'SUPERSEDE_REQUIRES_EPOCH_ROLLOVER',
      'Contract or baseline changes require an epoch rollover, not supersede.',
      ExitCode.guard,
    );
  }
  throw workflowError(
    'SUPERSEDE_REASON_UNSUPPORTED',
    'Supersede requires an explicit workflow-replacement reason.',
    ExitCode.usage,
  );
}

export interface LegacyGrantV1AuditRecord {
  kind: 'legacy-grant-v1-audit.v1';
  legacyKind: 'maintainer-grant.v1';
  grantId: string;
  signedPayload: string;
  payloadDigest: Sha256Digest;
  signer: string;
  signature: string;
}

export function verifyLegacyGrantV1ReadOnly(
  record: LegacyGrantV1AuditRecord,
  context: { verifyHumanSignature: HumanSignatureVerifier },
): {
  grantId: string;
  legacyKind: 'maintainer-grant.v1';
  mode: 'historical-read-only';
  signatureValid: true;
} {
  if (
    record.kind !== 'legacy-grant-v1-audit.v1' ||
    record.legacyKind !== 'maintainer-grant.v1'
  ) {
    throw workflowError(
      'LEGACY_GRANT_V1_INVALID',
      'Unknown legacy grant audit record.',
      ExitCode.usage,
    );
  }
  for (const [value, label] of [
    [record.grantId, 'Grant id'],
    [record.signedPayload, 'Signed payload'],
    [record.signer, 'Signer'],
    [record.signature, 'Signature'],
  ] as const) {
    assertNonEmpty(value, 'LEGACY_GRANT_V1_INVALID', label);
  }
  assertDigest(record.payloadDigest, 'LEGACY_GRANT_V1_INVALID');
  if (sha256(record.signedPayload) !== record.payloadDigest) {
    throw workflowError(
      'LEGACY_GRANT_V1_PAYLOAD_DIGEST_MISMATCH',
      'Historical grant payload digest mismatch.',
      ExitCode.verification,
    );
  }
  const signatureValid = verifyHumanSignatureSafely(
    context.verifyHumanSignature,
    record.signedPayload,
    record.signature,
    record.signer,
    'expense-app.workflow.maintainer-grant.v1',
  );
  if (!signatureValid) {
    throw workflowError(
      'LEGACY_GRANT_V1_SIGNATURE_INVALID',
      'Historical V1 grant signature could not be verified.',
      ExitCode.verification,
    );
  }
  return freezeDeep({
    grantId: record.grantId,
    legacyKind: record.legacyKind,
    mode: 'historical-read-only',
    signatureValid: true,
  });
}

export function assertLegacyGrantV1SigningAllowed(): never {
  throw workflowError(
    'LEGACY_GRANT_V1_NEW_SIGNING_DISABLED',
    'New V1 grant signing is disabled; V1 records are historical read-only evidence.',
    ExitCode.guard,
  );
}
