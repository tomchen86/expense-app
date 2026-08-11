import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  createInteractiveSshSigner,
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  assertChangeId,
  assertSessionId,
  assertTaskId,
  normalizePolicyPath,
} from './paths.ts';
import {
  readContentRecord,
  writeContentRecord,
} from './content-record-store.ts';
import { runtimePaths } from './session-store.ts';

export const TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE =
  'expense-app.workflow.task-revision-approval.v1' as const;
export const TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT =
  'task-revision-authority-widening-only' as const;
export const TASK_REVISION_APPROVAL_TTL_MINUTES = 5;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LEASE_ID =
  /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/;

export type TaskRevisionApprovalBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-revision-approval-binding.v1';
  changeId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  actorAuthorityId: string;
  baselineCommit: string;
  baselineTree: string;
  priorContractDigest: string;
  candidateContractDigest: string;
  candidatePlanningGenerationId: string;
  implementationFingerprint: string;
  revisionReasonDigest: string;
  previousAllowedPaths: string[];
  nextAllowedPaths: string[];
  previousRequiredChecks: string[];
  nextRequiredChecks: string[];
}>;

export type TaskRevisionApprovalPayload = Readonly<{
  version: 1;
  kind: 'task-revision-approval.v1';
  repositoryId: string;
  repositoryOrigin: string;
  policyBlob: string;
  binding: TaskRevisionApprovalBinding;
  targetDigest: string;
  authorizedEffect: typeof TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT;
  rationale: string;
  issuedAt: string;
  expiresAt: string;
  signer: string;
}>;

export type TaskRevisionApprovalEnvelope = Readonly<{
  payload: TaskRevisionApprovalPayload;
  signature: string;
}>;

export type TaskRevisionApprovalIssueRequest = Readonly<{
  binding: TaskRevisionApprovalBinding;
  expectedTargetDigest: string;
  rationale: string;
}>;

export type TaskRevisionApprovalIssueOptions = Readonly<{
  now?: Date;
  signer?: MaintainerSignerProvider;
}>;

export type TaskRevisionApprovalValidationOptions = Readonly<{
  now: Date;
  allowExpired?: boolean;
  verifier?: Pick<MaintainerSignerProvider, 'verify'>;
}>;

export type TaskRevisionApprovalIssueResult = Readonly<{
  approvalId: string;
  recordPath: string;
  envelope: TaskRevisionApprovalEnvelope;
}>;

export function taskRevisionApprovalTargetDigest(
  requested: TaskRevisionApprovalBinding,
): string {
  const binding = assertTaskRevisionApprovalBinding(requested);
  return crypto
    .createHash('sha256')
    .update('task-revision-approval-target.v1\0')
    .update(canonicalJson(binding))
    .digest('hex');
}

export function issueTaskRevisionApproval(
  cwd: string,
  requested: TaskRevisionApprovalIssueRequest,
  options: TaskRevisionApprovalIssueOptions = {},
): TaskRevisionApprovalIssueResult {
  const binding = assertTaskRevisionApprovalBinding(requested.binding);
  const targetDigest = taskRevisionApprovalTargetDigest(binding);
  if (requested.expectedTargetDigest !== targetDigest) {
    throw approvalInvalid(
      'The requested task-revision approval target does not match the exact candidate.',
    );
  }
  const rationale = assertRationale(requested.rationale);
  const repository = discoverRepository(cwd);
  if (
    repository.head !== binding.baselineCommit ||
    repository.tree !== binding.baselineTree
  ) {
    throw approvalStale(
      'The task-revision approval baseline changed before human authorization.',
    );
  }
  const { policy, policyBlob } = loadPolicyAtCommit(
    repository.repositoryRoot,
    binding.baselineCommit,
  );
  const origin = readRepositoryOrigin(
    repository.repositoryRoot,
    approvalInvalid,
  );
  if (origin !== policy.repository.origin) {
    throw approvalInvalid(
      'Repository origin does not match the trusted approval policy.',
    );
  }
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  if (
    signerIdentity === binding.actorAuthorityId ||
    !policy.trustedSigners.some(({ identity }) => identity === signerIdentity)
  ) {
    throw approvalInvalid(
      'Task-revision approval must come from a trusted authority external to the benefiting session.',
    );
  }
  const now = exactDate(options.now ?? new Date());
  const payload: TaskRevisionApprovalPayload = {
    version: 1,
    kind: 'task-revision-approval.v1',
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob,
    binding,
    targetDigest,
    authorizedEffect: TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
    rationale,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() +
        Math.min(policy.maxTtlMinutes, TASK_REVISION_APPROVAL_TTL_MINUTES) *
          60_000,
    ).toISOString(),
    signer: signerIdentity,
  };
  assertTaskRevisionApprovalPayload(payload, policy, policyBlob, binding, {
    now,
  });
  const canonicalPayload = canonicalTaskRevisionApprovalPayload(payload);
  let signature: string;
  try {
    signature = signer.sign(
      canonicalPayload,
      TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    signer.verify(
      canonicalPayload,
      signature,
      signerIdentity,
      TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    throw approvalSignatureInvalid(error);
  }
  const envelope = Object.freeze({ payload, signature });
  const directory = approvalDirectory(
    repository.gitCommonDirectory,
    repository.repositoryRoot,
  );
  ensurePrivateApprovalDirectory(directory);
  const approvalId = writeContentRecord(directory, {
    schemaVersion: 1,
    kind: 'task-revision-approval-record.v1',
    createdAt: payload.issuedAt,
    envelope,
  });
  return {
    approvalId,
    recordPath: path.join(directory, `${approvalId}.json`),
    envelope,
  };
}

export function readAndValidateTaskRevisionApproval(
  cwd: string,
  requestedApprovalId: string,
  expectedBinding: TaskRevisionApprovalBinding,
  options: TaskRevisionApprovalValidationOptions,
): TaskRevisionApprovalEnvelope {
  const approvalId = assertApprovalId(requestedApprovalId);
  const binding = assertTaskRevisionApprovalBinding(expectedBinding);
  const repository = discoverRepository(cwd);
  const { policy, policyBlob } = loadPolicyAtCommit(
    repository.repositoryRoot,
    binding.baselineCommit,
  );
  const origin = readRepositoryOrigin(repository.repositoryRoot, approvalStale);
  if (origin !== policy.repository.origin) {
    throw approvalStale(
      'Repository origin changed after task-revision approval preparation.',
    );
  }
  const directory = approvalDirectory(
    repository.gitCommonDirectory,
    repository.repositoryRoot,
  );
  const recordPath = path.join(directory, `${approvalId}.json`);
  let record: ReturnType<typeof readContentRecord>;
  try {
    assertPrivateApprovalDirectory(directory);
    const stats = fs.lstatSync(recordPath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      fs.realpathSync(recordPath) !== path.resolve(recordPath)
    ) {
      throw new Error('unsafe approval record');
    }
    record = readContentRecord(directory, approvalId);
  } catch {
    throw workflowError(
      'TASK_REVISION_APPROVAL_NOT_FOUND',
      `Task-revision approval ${approvalId} is unavailable or unsafe.`,
      ExitCode.staleState,
    );
  }
  if (
    !hasExactKeys(record, ['schemaVersion', 'kind', 'createdAt', 'envelope']) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'task-revision-approval-record.v1'
  ) {
    throw approvalInvalid('Task-revision approval record is malformed.');
  }
  const envelope = assertTaskRevisionApprovalEnvelope(record.envelope);
  if (record.createdAt !== envelope.payload.issuedAt) {
    throw approvalInvalid(
      'Task-revision approval record timestamp does not match its signed payload.',
    );
  }
  if (taskRevisionApprovalRecordId(record.createdAt, envelope) !== approvalId) {
    throw approvalInvalid(
      'Task-revision approval record is not the unique canonical decision record.',
    );
  }
  assertTaskRevisionApprovalPayload(
    envelope.payload,
    policy,
    policyBlob,
    binding,
    options,
  );
  const signer = policy.trustedSigners.find(
    ({ identity }) => identity === envelope.payload.signer,
  );
  if (!signer) {
    throw approvalInvalid('Task-revision approval signer is not trusted.');
  }
  const canonicalPayload = canonicalTaskRevisionApprovalPayload(
    envelope.payload,
  );
  try {
    if (options.verifier) {
      options.verifier.verify(
        canonicalPayload,
        envelope.signature,
        envelope.payload.signer,
        TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
      );
    } else {
      verifySshSignatureWithPublicKey(
        canonicalPayload,
        envelope.signature,
        envelope.payload.signer,
        signer.publicKey,
        TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
      );
    }
  } catch (error) {
    throw approvalSignatureInvalid(error);
  }
  return envelope;
}

export function canonicalTaskRevisionApprovalPayload(
  payload: TaskRevisionApprovalPayload,
): string {
  return `${canonicalJson({
    version: payload.version,
    kind: payload.kind,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    policyBlob: payload.policyBlob,
    binding: payload.binding,
    targetDigest: payload.targetDigest,
    authorizedEffect: payload.authorizedEffect,
    rationale: payload.rationale,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    signer: payload.signer,
  })}\n`;
}

function canonicalTaskRevisionApprovalEnvelope(
  envelope: TaskRevisionApprovalEnvelope,
): string {
  return `${canonicalJson({
    payload: JSON.parse(canonicalTaskRevisionApprovalPayload(envelope.payload)),
    signature: envelope.signature,
  })}\n`;
}

function taskRevisionApprovalRecordId(
  createdAt: string,
  envelope: TaskRevisionApprovalEnvelope,
): string {
  return crypto
    .createHash('sha256')
    .update(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'task-revision-approval-record.v1',
          createdAt,
          envelope,
        },
        null,
        2,
      )}\n`,
    )
    .digest('hex');
}

function assertTaskRevisionApprovalEnvelope(
  value: unknown,
): TaskRevisionApprovalEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    typeof value.signature !== 'string'
  ) {
    throw approvalInvalid('Task-revision approval envelope is malformed.');
  }
  assertArmoredSignature(value.signature);
  const envelope = {
    payload: assertTaskRevisionApprovalPayloadShape(value.payload),
    signature: value.signature,
  };
  const canonical = canonicalTaskRevisionApprovalEnvelope(envelope);
  const reparsed = JSON.parse(canonical) as TaskRevisionApprovalEnvelope;
  if (
    canonicalTaskRevisionApprovalEnvelope(reparsed) !== canonical ||
    canonicalJson(reparsed.payload) !== canonicalJson(envelope.payload)
  ) {
    throw approvalInvalid('Task-revision approval envelope is not canonical.');
  }
  return Object.freeze(envelope);
}

function assertTaskRevisionApprovalPayloadShape(
  value: unknown,
): TaskRevisionApprovalPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'kind',
      'repositoryId',
      'repositoryOrigin',
      'policyBlob',
      'binding',
      'targetDigest',
      'authorizedEffect',
      'rationale',
      'issuedAt',
      'expiresAt',
      'signer',
    ]) ||
    value.version !== 1 ||
    value.kind !== 'task-revision-approval.v1' ||
    typeof value.repositoryId !== 'string' ||
    typeof value.repositoryOrigin !== 'string' ||
    typeof value.policyBlob !== 'string' ||
    typeof value.targetDigest !== 'string' ||
    value.authorizedEffect !== TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT ||
    typeof value.rationale !== 'string' ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.signer !== 'string'
  ) {
    throw approvalInvalid('Task-revision approval payload is malformed.');
  }
  return Object.freeze({
    version: 1,
    kind: 'task-revision-approval.v1',
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    policyBlob: value.policyBlob,
    binding: assertTaskRevisionApprovalBinding(value.binding),
    targetDigest: value.targetDigest,
    authorizedEffect: TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
    rationale: value.rationale,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    signer: value.signer,
  });
}

function assertTaskRevisionApprovalPayload(
  value: TaskRevisionApprovalPayload,
  policy: MaintainerPolicy,
  expectedPolicyBlob: string,
  expectedBinding: TaskRevisionApprovalBinding,
  options: TaskRevisionApprovalValidationOptions,
): void {
  const payload = assertTaskRevisionApprovalPayloadShape(value);
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const now = exactDate(options.now).getTime();
  if (
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    payload.policyBlob !== expectedPolicyBlob ||
    canonicalJson(payload.binding) !== canonicalJson(expectedBinding) ||
    payload.targetDigest !==
      taskRevisionApprovalTargetDigest(expectedBinding) ||
    payload.signer === expectedBinding.actorAuthorityId ||
    !policy.trustedSigners.some(
      ({ identity }) => identity === payload.signer,
    ) ||
    !OID.test(payload.policyBlob) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt >
      Math.min(policy.maxTtlMinutes, TASK_REVISION_APPROVAL_TTL_MINUTES) *
        60_000 ||
    issuedAt > now + 30_000 ||
    (!options.allowExpired && (now < issuedAt || now >= expiresAt))
  ) {
    throw approvalStale(
      'Task-revision approval is stale or does not match the exact widening candidate.',
    );
  }
  assertRationale(payload.rationale);
}

export function assertTaskRevisionApprovalBinding(
  value: unknown,
): TaskRevisionApprovalBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'leaseId',
      'actorAuthorityId',
      'baselineCommit',
      'baselineTree',
      'priorContractDigest',
      'candidateContractDigest',
      'candidatePlanningGenerationId',
      'implementationFingerprint',
      'revisionReasonDigest',
      'previousAllowedPaths',
      'nextAllowedPaths',
      'previousRequiredChecks',
      'nextRequiredChecks',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-revision-approval-binding.v1' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.leaseId !== 'string' ||
    typeof value.actorAuthorityId !== 'string' ||
    typeof value.baselineCommit !== 'string' ||
    typeof value.baselineTree !== 'string' ||
    typeof value.priorContractDigest !== 'string' ||
    typeof value.candidateContractDigest !== 'string' ||
    typeof value.candidatePlanningGenerationId !== 'string' ||
    typeof value.implementationFingerprint !== 'string' ||
    typeof value.revisionReasonDigest !== 'string' ||
    !Array.isArray(value.previousAllowedPaths) ||
    !Array.isArray(value.nextAllowedPaths) ||
    !Array.isArray(value.previousRequiredChecks) ||
    !Array.isArray(value.nextRequiredChecks)
  ) {
    throw approvalInvalid('Task-revision approval binding is malformed.');
  }
  assertChangeId(value.changeId);
  assertTaskId(value.taskId);
  assertSessionId(value.sessionId);
  if (
    !LEASE_ID.test(value.leaseId) ||
    !AUTHORITY_ID.test(value.actorAuthorityId) ||
    !OID.test(value.baselineCommit) ||
    !OID.test(value.baselineTree) ||
    !SHA256.test(value.priorContractDigest) ||
    !SHA256.test(value.candidateContractDigest) ||
    !SHA256.test(value.candidatePlanningGenerationId) ||
    !SHA256.test(value.implementationFingerprint) ||
    !SHA256.test(value.revisionReasonDigest)
  ) {
    throw approvalInvalid('Task-revision approval binding is invalid.');
  }
  const previousAllowedPaths = assertPolicyPaths(value.previousAllowedPaths);
  const nextAllowedPaths = assertPolicyPaths(value.nextAllowedPaths);
  const previousRequiredChecks = assertStringSet(
    value.previousRequiredChecks,
    'previous required checks',
  );
  const nextRequiredChecks = assertStringSet(
    value.nextRequiredChecks,
    'next required checks',
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'task-revision-approval-binding.v1',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    leaseId: value.leaseId,
    actorAuthorityId: value.actorAuthorityId,
    baselineCommit: value.baselineCommit,
    baselineTree: value.baselineTree,
    priorContractDigest: value.priorContractDigest,
    candidateContractDigest: value.candidateContractDigest,
    candidatePlanningGenerationId: value.candidatePlanningGenerationId,
    implementationFingerprint: value.implementationFingerprint,
    revisionReasonDigest: value.revisionReasonDigest,
    previousAllowedPaths,
    nextAllowedPaths,
    previousRequiredChecks,
    nextRequiredChecks,
  });
}

function assertPolicyPaths(value: unknown[]): string[] {
  const paths = value.map((candidate) => {
    if (typeof candidate !== 'string') {
      throw approvalInvalid('Task-revision approval path is invalid.');
    }
    return normalizePolicyPath(candidate);
  });
  if (!isSortedUnique(paths)) {
    throw approvalInvalid(
      'Task-revision approval paths must be normalized, sorted, and unique.',
    );
  }
  return paths;
}

function assertStringSet(value: unknown[], label: string): string[] {
  const strings = value.map((candidate) => {
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > 128
    ) {
      throw approvalInvalid(`Task-revision approval ${label} are invalid.`);
    }
    return candidate;
  });
  if (!isSortedUnique(strings)) {
    throw approvalInvalid(
      `Task-revision approval ${label} must be sorted and unique.`,
    );
  }
  return strings;
}

function approvalDirectory(
  gitCommonDirectory: string,
  repositoryRoot: string,
): string {
  const config = loadWorkflowConfig(repositoryRoot);
  return path.join(
    runtimePaths(gitCommonDirectory, config.runtimeDirectory).root,
    'task-revision-approvals',
  );
}

function ensurePrivateApprovalDirectory(directory: string): void {
  ensurePlainDirectory(directory);
  assertPrivateApprovalDirectory(directory);
}

function assertPrivateApprovalDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw approvalInvalid(
      'Task-revision approval storage is not a private canonical directory.',
    );
  }
}

function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): { policy: MaintainerPolicy; policyBlob: string } {
  if (!OID.test(commit)) {
    throw approvalInvalid('Task-revision approval baseline is invalid.');
  }
  try {
    return {
      policy: parseMaintainerPolicy(
        JSON.parse(
          runGit(repositoryRoot, [
            'show',
            `${commit}:workflow/maintainer-policy.json`,
          ]),
        ),
      ),
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${commit}:workflow/maintainer-policy.json`,
      ]).trim(),
    };
  } catch {
    throw approvalInvalid(
      'The exact task-revision baseline has no valid maintainer policy.',
    );
  }
}

function readRepositoryOrigin(
  repositoryRoot: string,
  errorFactory: (message: string) => Error,
): string {
  try {
    return runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  } catch {
    throw errorFactory(
      'The live repository origin is unavailable for task-revision approval.',
    );
  }
}

function assertApprovalId(value: string): string {
  if (!SHA256.test(value)) {
    throw approvalInvalid('Task-revision approval reference is invalid.');
  }
  return value;
}

function assertRationale(value: string): string {
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length < 8 ||
    normalized.length > 2_000
  ) {
    throw approvalInvalid(
      'Task-revision approval rationale must contain 8 to 2000 trimmed characters.',
    );
  }
  return normalized;
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw approvalInvalid('Task-revision approval clock is invalid.');
  }
  return new Date(value.getTime());
}

function assertArmoredSignature(value: string): void {
  if (
    !value.startsWith('-----BEGIN SSH SIGNATURE-----\n') ||
    !value.endsWith('-----END SSH SIGNATURE-----\n') ||
    value.length > 16_384
  ) {
    throw approvalInvalid('Task-revision approval signature is malformed.');
  }
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}

function approvalInvalid(message: string) {
  return workflowError(
    'TASK_REVISION_APPROVAL_INVALID',
    message,
    ExitCode.guard,
  );
}

function approvalStale(message: string) {
  return workflowError(
    'TASK_REVISION_APPROVAL_STALE',
    message,
    ExitCode.staleState,
  );
}

function approvalSignatureInvalid(_cause: unknown) {
  return workflowError(
    'TASK_REVISION_APPROVAL_SIGNATURE_INVALID',
    'Task-revision approval signature is invalid.',
    ExitCode.verification,
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
