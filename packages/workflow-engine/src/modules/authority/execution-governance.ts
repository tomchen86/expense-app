import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  deriveAuthorityAuditRepositoryId,
  type Sha256Digest,
} from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  type AuthorityAuditActor,
  type AuthorityAuditRecordedEvent,
  type AuthorityAuditServiceHooks,
} from '../../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from './task-mandate.ts';

export const EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE =
  'HARNESS_EXECUTION_BUDGET_GRANT_V1';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_GRANT_USES = 16;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ExecutionBudgetChange = {
  path: string;
  from: JsonValue;
  to: JsonValue;
};

export type ExecutionBudgetGrantRequest = {
  schemaVersion: 1;
  kind: 'execution-budget-grant-request';
  requestId: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  /** Absent only on persisted legacy requests, which are read-only. */
  mandateBinding?: TaskMandateBinding;
  requestedChanges: ExecutionBudgetChange[];
  rationale: string;
  expiresAfterAttempts: number;
  createdAt: string;
};

export type GrantRequest = ExecutionBudgetGrantRequest;

export type ExecutionBudgetGrantPayload = {
  schemaVersion: 1;
  kind: 'execution-budget-grant.v1';
  grantId: string;
  requestDigest: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  /** Absent only on persisted legacy grants, which are read-only. */
  mandateBinding?: TaskMandateBinding;
  allowedChanges: ExecutionBudgetChange[];
  maxUses: number;
  issuedAt: string;
  issuer: string;
};

export type ExecutionBudgetGrantEnvelope = {
  payload: ExecutionBudgetGrantPayload;
  signature: string;
};

export type ExecutionBudgetConsumeReceipt = {
  schemaVersion: 1;
  kind: 'execution-budget-consume-receipt';
  receiptId: string;
  grantId: string;
  requestDigest: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  mandateBinding: TaskMandateBinding;
  attemptId: string;
  useNumber: number;
  remainingUses: number;
  consumedAt: string;
};

export type ExecutionBudgetGrantAuthorization = Readonly<{
  grantId: string;
  request: ExecutionBudgetGrantRequest;
  receipt: ExecutionBudgetConsumeReceipt;
}>;

type ExecutionBudgetGrantRecord = {
  schemaVersion: 1 | 2 | 3;
  state: 'active' | 'consumed' | 'revoked';
  envelopeDigest: string;
  envelope: ExecutionBudgetGrantEnvelope;
  remainingUses: number;
  consumedAttemptIds: string[];
  receipts: ExecutionBudgetConsumeReceipt[];
  revokedAt?: string | null;
  revocationReason?: string | null;
};

export type ExecutionBudgetGrantAuditContext = Readonly<{
  repositoryRoot: string;
  repositoryIdentity: string;
  actor?: AuthorityAuditActor;
  serviceHooks?: AuthorityAuditServiceHooks;
  onRecord?: (entry: AuthorityAuditRecordedEvent) => void;
}>;

export type ExecutionBudgetGrantInspection = {
  state: 'active' | 'consumed' | 'revoked';
  remainingUses: number;
  receipts: ExecutionBudgetConsumeReceipt[];
  revokedAt?: string;
  revocationReason?: string;
};

export type ExecutionBudgetGrantMetricsRecord = Readonly<{
  grantId: string;
  requestDigest: string;
  consumedAttemptIds: readonly string[];
}>;

export function createExecutionBudgetGrantRequest(input: {
  requestId: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  mandateBinding: TaskMandateBinding;
  requestedChanges: ExecutionBudgetChange[];
  rationale: string;
  expiresAfterAttempts: number;
  createdAt: Date;
}): ExecutionBudgetGrantRequest {
  const request: ExecutionBudgetGrantRequest = {
    schemaVersion: 1,
    kind: 'execution-budget-grant-request',
    requestId: input.requestId,
    workflowId: input.workflowId,
    epoch: input.epoch,
    jobId: input.jobId,
    mandateBinding: assertExecutionGrantMandateBinding(
      input.mandateBinding,
      invalidGrantRequest,
    ),
    requestedChanges: sortChanges(input.requestedChanges, invalidGrantRequest),
    rationale: input.rationale,
    expiresAfterAttempts: input.expiresAfterAttempts,
    createdAt: exactDate(input.createdAt, 'EXECUTION_GRANT_REQUEST_INVALID'),
  };
  validateExecutionBudgetGrantRequest(request);
  return request;
}

export function canonicalExecutionBudgetGrantRequest(
  request: ExecutionBudgetGrantRequest,
): string {
  validateExecutionBudgetGrantRequest(request);
  return `${canonicalJson(request)}\n`;
}

export function parseExecutionBudgetGrantRequest(
  raw: string,
): ExecutionBudgetGrantRequest {
  try {
    const value = parseDocument(raw);
    validateExecutionBudgetGrantRequest(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'EXECUTION_GRANT_REQUEST_INVALID',
      'Execution-budget grant request is malformed.',
    );
  }
}

export function createExecutionBudgetGrantEnvelope(
  request: ExecutionBudgetGrantRequest,
  input: {
    grantId: string;
    issuedAt: Date;
    issuer: string;
    maxUses: number;
    signature: string;
  },
): ExecutionBudgetGrantEnvelope {
  validateExecutionBudgetGrantRequest(request);
  if (
    !Number.isSafeInteger(input.maxUses) ||
    input.maxUses < 1 ||
    input.maxUses > request.expiresAfterAttempts
  ) {
    throw invalidGrant(
      'Grant uses must be positive and no greater than the requested attempt bound.',
    );
  }
  const issuedAt = exactDate(input.issuedAt, 'EXECUTION_BUDGET_GRANT_INVALID');
  if (new Date(issuedAt).getTime() < new Date(request.createdAt).getTime()) {
    throw invalidGrant('Grant cannot be issued before its bound request.');
  }
  const payload: ExecutionBudgetGrantPayload = {
    schemaVersion: 1,
    kind: 'execution-budget-grant.v1',
    grantId: input.grantId,
    requestDigest: digest(canonicalExecutionBudgetGrantRequest(request)),
    workflowId: request.workflowId,
    epoch: request.epoch,
    jobId: request.jobId,
    ...(request.mandateBinding === undefined
      ? {}
      : {
          mandateBinding: assertExecutionGrantMandateBinding(
            request.mandateBinding,
            invalidGrant,
          ),
        }),
    allowedChanges: request.requestedChanges.map((change) =>
      cloneChange(change, invalidGrant),
    ),
    maxUses: input.maxUses,
    issuedAt,
    issuer: input.issuer,
  };
  const envelope = { payload, signature: input.signature };
  validateExecutionBudgetGrantEnvelope(envelope);
  return envelope;
}

export function canonicalExecutionBudgetGrantSigningBytes(
  payload: ExecutionBudgetGrantPayload,
): string {
  validateExecutionBudgetGrantPayload(payload);
  return `${EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE}\n${canonicalJson(payload)}\n`;
}

export function canonicalExecutionBudgetGrantEnvelope(
  envelope: ExecutionBudgetGrantEnvelope,
): string {
  validateExecutionBudgetGrantEnvelope(envelope);
  return `${canonicalJson(envelope)}\n`;
}

export function parseExecutionBudgetGrantEnvelope(
  raw: string,
): ExecutionBudgetGrantEnvelope {
  try {
    const value = parseDocument(raw);
    validateExecutionBudgetGrantEnvelope(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'EXECUTION_BUDGET_GRANT_INVALID',
      'Execution-budget grant envelope is malformed.',
    );
  }
}

export function storeExecutionBudgetGrant(
  storeRoot: string,
  envelope: ExecutionBudgetGrantEnvelope,
  options: {
    request: ExecutionBudgetGrantRequest;
    mandateBinding: TaskMandateBinding;
    audit: ExecutionBudgetGrantAuditContext;
    verify: (signingBytes: string, signature: string) => void;
  },
): string {
  validateExecutionBudgetGrantEnvelope(envelope);
  const binding = requireAuditedExecutionBudgetGrant(envelope, {
    request: options?.request,
    mandateBinding: options?.mandateBinding,
    audit: options?.audit,
  });
  try {
    options.verify(
      canonicalExecutionBudgetGrantSigningBytes(envelope.payload),
      envelope.signature,
    );
  } catch (error) {
    if (isWorkflowError(error)) throw error;
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_SIGNATURE_INVALID',
      'Execution-budget grant signature verification failed.',
      ExitCode.verification,
    );
  }
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  const grantId = assertUuid(envelope.payload.grantId, invalidGrant);
  return withExecutionGrantLock(paths, grantId, () => {
    const recordPath = path.join(paths.grants, `${grantId}.json`);
    if (fs.existsSync(recordPath)) {
      throw workflowError(
        'EXECUTION_BUDGET_GRANT_EXISTS',
        `Execution-budget grant ${grantId} already exists.`,
        ExitCode.conflict,
      );
    }
    const record: ExecutionBudgetGrantRecord = {
      schemaVersion: 3,
      state: 'active',
      envelopeDigest: digest(canonicalExecutionBudgetGrantEnvelope(envelope)),
      envelope,
      remainingUses: envelope.payload.maxUses,
      consumedAttemptIds: [],
      receipts: [],
      revokedAt: null,
      revocationReason: null,
    };
    const pendingPath = path.join(paths.pending, `${grantId}.json`);
    const recordBytes = canonicalGrantRecord(record);
    const pendingStats = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
    if (pendingStats === undefined) {
      createPrivateFileAtomic(pendingPath, recordBytes);
    } else if (
      canonicalGrantRecord(readGrantRecord(pendingPath)) !== recordBytes
    ) {
      throw unsafeGrantStore();
    }
    appendExecutionBudgetGrantAudit(
      envelope,
      binding,
      options.audit,
      'issue',
      envelope.payload.issuedAt,
      null,
    );
    createPrivateFileAtomic(recordPath, recordBytes);
    unlinkExactPrivateFile(pendingPath, recordBytes);
    return recordPath;
  });
}

export function consumeExecutionBudgetGrant(
  storeRoot: string,
  input: {
    grantId: string;
    workflowId: string;
    epoch: number;
    jobId: string;
    attemptId: string;
    mandateBinding: TaskMandateBinding;
    requestDigest: string;
    requestedChanges: ExecutionBudgetChange[];
    now: Date;
    audit: ExecutionBudgetGrantAuditContext;
  },
): ExecutionBudgetConsumeReceipt {
  const grantId = assertUuid(input.grantId, invalidGrant);
  assertIdentity(input.workflowId, invalidGrant, 'workflow ID');
  assertPositiveInteger(input.epoch, invalidGrant, 'epoch');
  assertIdentity(input.jobId, invalidGrant, 'job ID');
  assertIdentity(input.attemptId, invalidGrant, 'attempt ID');
  assertDigest(input.requestDigest, invalidGrant, 'grant request digest');
  validateChanges(input.requestedChanges, invalidGrant);
  const consumedAt = exactDate(input.now, 'EXECUTION_BUDGET_GRANT_INVALID');
  const inputBinding = assertExecutionGrantMandateBinding(
    input.mandateBinding,
    invalidGrant,
  );
  const audit = assertExecutionBudgetGrantAuditContext(input.audit);
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  return withExecutionGrantLock(paths, grantId, () => {
    const recordPath = path.join(paths.grants, `${grantId}.json`);
    const record = readGrantRecord(recordPath);
    const payload = record.envelope.payload;
    const storedBinding = requireStoredExecutionBudgetGrantBinding(payload);
    const refusalBinding = executionBudgetGrantRefusalBinding(
      record.envelope,
      storedBinding,
      audit,
      'execution-budget.consume',
      {
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        epoch: input.epoch,
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        requestedBindingDigest: authorityRefusalDigest(inputBinding),
        requestedChangesDigest: authorityRefusalDigest(input.requestedChanges),
      },
    );
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: new Date(consumedAt),
        serviceHooks: audit.serviceHooks,
        onRecord: audit.onRecord,
      },
      () => {
        const binding = requireCurrentExecutionBudgetGrantBinding(
          payload,
          inputBinding,
        );
        if (
          payload.workflowId !== input.workflowId ||
          payload.epoch !== input.epoch ||
          payload.jobId !== input.jobId
        ) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
            'Execution-budget grant cannot be reused across a workflow epoch or job.',
            ExitCode.guard,
          );
        }
        if (payload.requestDigest !== input.requestDigest) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_REQUEST_MISMATCH',
            'Execution-budget grant is not bound to the expected GrantRequest.',
            ExitCode.guard,
          );
        }
        if (record.consumedAttemptIds.includes(input.attemptId)) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_ATTEMPT_REUSED',
            `Attempt ${input.attemptId} already consumed this grant.`,
            ExitCode.conflict,
          );
        }
        if (record.state === 'revoked') {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_REVOKED',
            `Execution-budget grant ${grantId} was revoked.`,
            ExitCode.guard,
          );
        }
        if (record.remainingUses < 1 || record.state === 'consumed') {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_EXHAUSTED',
            `Execution-budget grant ${grantId} has no remaining uses.`,
            ExitCode.guard,
          );
        }
        if (
          canonicalJson(input.requestedChanges) !==
          canonicalJson(payload.allowedChanges)
        ) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_CHANGE_MISMATCH',
            'Execution-budget grant does not authorize the requested execution-policy change.',
            ExitCode.guard,
          );
        }
        const previousConsumedAt = record.receipts.at(-1)?.consumedAt;
        if (
          new Date(consumedAt).getTime() <
            new Date(payload.issuedAt).getTime() ||
          (previousConsumedAt !== undefined &&
            new Date(consumedAt).getTime() <
              new Date(previousConsumedAt).getTime())
        ) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_TIME_INVALID',
            'Execution-budget grant use predates issuance or a prior use.',
            ExitCode.staleState,
          );
        }
        const receiptCore = {
          schemaVersion: 1 as const,
          kind: 'execution-budget-consume-receipt' as const,
          grantId,
          requestDigest: payload.requestDigest,
          workflowId: payload.workflowId,
          epoch: payload.epoch,
          jobId: payload.jobId,
          mandateBinding: binding,
          attemptId: input.attemptId,
          useNumber: record.receipts.length + 1,
          remainingUses: record.remainingUses - 1,
          consumedAt,
        };
        const receipt: ExecutionBudgetConsumeReceipt = {
          ...receiptCore,
          receiptId: digest(canonicalJson(receiptCore)),
        };
        validateExecutionBudgetConsumeReceipt(receipt, payload);
        const next: ExecutionBudgetGrantRecord = {
          ...record,
          schemaVersion: 3,
          receipts: [...record.receipts, receipt],
          consumedAttemptIds: [...record.consumedAttemptIds, input.attemptId],
          remainingUses: record.remainingUses - 1,
          state: record.remainingUses - 1 === 0 ? 'consumed' : 'active',
        };
        appendExecutionBudgetGrantAudit(
          record.envelope,
          binding,
          audit,
          'consume',
          consumedAt,
          receipt,
        );
        replacePrivateFileAtomic(recordPath, canonicalGrantRecord(next));
        return receipt;
      },
    );
  });
}

export function inspectExecutionBudgetGrant(
  storeRoot: string,
  grantId: string,
): ExecutionBudgetGrantInspection {
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  const record = readGrantRecordRequired(
    path.join(paths.grants, `${assertUuid(grantId, invalidGrant)}.json`),
  );
  return inspectionFromRecord(record);
}

export function revokeExecutionBudgetGrant(
  storeRoot: string,
  input: {
    grantId: string;
    mandateBinding: TaskMandateBinding;
    reason: string;
    now: Date;
    audit: ExecutionBudgetGrantAuditContext;
  },
): ExecutionBudgetGrantInspection & {
  state: 'revoked';
  revokedAt: string;
  revocationReason: string;
} {
  const grantId = assertUuid(input.grantId, invalidGrant);
  assertReason(input.reason, invalidGrant, 'revocation reason');
  const revokedAt = exactDate(input.now, 'EXECUTION_BUDGET_GRANT_INVALID');
  const inputBinding = assertExecutionGrantMandateBinding(
    input.mandateBinding,
    invalidGrant,
  );
  const audit = assertExecutionBudgetGrantAuditContext(input.audit);
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  return withExecutionGrantLock(paths, grantId, () => {
    const recordPath = path.join(paths.grants, `${grantId}.json`);
    const record = readGrantRecord(recordPath);
    const storedBinding = requireStoredExecutionBudgetGrantBinding(
      record.envelope.payload,
    );
    const refusalBinding = executionBudgetGrantRefusalBinding(
      record.envelope,
      storedBinding,
      audit,
      'execution-budget.revoke',
      {
        reasonDigest: authorityRefusalDigest(input.reason),
        requestedBindingDigest: authorityRefusalDigest(inputBinding),
      },
    );
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: new Date(revokedAt),
        serviceHooks: audit.serviceHooks,
        onRecord: audit.onRecord,
      },
      () => {
        const binding = requireCurrentExecutionBudgetGrantBinding(
          record.envelope.payload,
          inputBinding,
        );
        if (record.state === 'revoked') {
          appendExecutionBudgetGrantAudit(
            record.envelope,
            binding,
            audit,
            'revoke',
            record.revokedAt!,
            record.revocationReason!,
          );
          return revokedInspectionFromRecord(record);
        }
        if (record.state === 'consumed') {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_ALREADY_CONSUMED',
            `Execution-budget grant ${grantId} was already fully consumed.`,
            ExitCode.guard,
          );
        }
        const latestAuthorityAt =
          record.receipts.at(-1)?.consumedAt ??
          record.envelope.payload.issuedAt;
        if (
          new Date(revokedAt).getTime() < new Date(latestAuthorityAt).getTime()
        ) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_TIME_INVALID',
            'Execution-budget grant revocation predates issuance or a prior use.',
            ExitCode.staleState,
          );
        }
        const revoked: ExecutionBudgetGrantRecord = {
          ...record,
          schemaVersion: 3,
          state: 'revoked',
          revokedAt,
          revocationReason: input.reason,
        };
        appendExecutionBudgetGrantAudit(
          record.envelope,
          binding,
          audit,
          'revoke',
          revokedAt,
          input.reason,
        );
        replacePrivateFileAtomic(recordPath, canonicalGrantRecord(revoked));
        return revokedInspectionFromRecord(revoked);
      },
    );
  });
}

function inspectionFromRecord(
  record: ExecutionBudgetGrantRecord,
): ExecutionBudgetGrantInspection {
  const inspection: ExecutionBudgetGrantInspection = {
    state: record.state,
    remainingUses: record.remainingUses,
    receipts: record.receipts.map((receipt) => ({ ...receipt })),
  };
  if (record.state === 'revoked') {
    inspection.revokedAt = record.revokedAt!;
    inspection.revocationReason = record.revocationReason!;
  }
  return inspection;
}

function revokedInspectionFromRecord(
  record: ExecutionBudgetGrantRecord,
): ExecutionBudgetGrantInspection & {
  state: 'revoked';
  revokedAt: string;
  revocationReason: string;
} {
  if (
    record.state !== 'revoked' ||
    record.revokedAt == null ||
    record.revocationReason == null
  ) {
    throw unsafeGrantStore();
  }
  return {
    ...inspectionFromRecord(record),
    state: 'revoked',
    revokedAt: record.revokedAt,
    revocationReason: record.revocationReason,
  };
}

function requireAuditedExecutionBudgetGrant(
  envelope: ExecutionBudgetGrantEnvelope,
  input: {
    request: ExecutionBudgetGrantRequest | undefined;
    mandateBinding: TaskMandateBinding | undefined;
    audit: ExecutionBudgetGrantAuditContext | undefined;
  },
): TaskMandateBinding {
  const payloadBinding = envelope.payload.mandateBinding;
  const requestBinding = input.request?.mandateBinding;
  if (payloadBinding === undefined || requestBinding === undefined) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY',
      'A legacy execution-budget request or grant without a Task Mandate binding is read-only.',
      ExitCode.guard,
    );
  }
  if (input.request === undefined || input.audit === undefined) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_AUDIT_REQUIRED',
      'Execution-budget authority requires its exact request and external audit context.',
      ExitCode.guard,
    );
  }
  validateExecutionBudgetGrantRequest(input.request);
  const binding = assertExecutionGrantMandateBinding(
    input.mandateBinding,
    invalidGrant,
  );
  assertExecutionBudgetGrantAuditContext(input.audit);
  if (
    canonicalJson(binding) !== canonicalJson(payloadBinding) ||
    canonicalJson(binding) !== canonicalJson(requestBinding) ||
    envelope.payload.requestDigest !==
      digest(canonicalExecutionBudgetGrantRequest(input.request)) ||
    envelope.payload.workflowId !== input.request.workflowId ||
    envelope.payload.epoch !== input.request.epoch ||
    envelope.payload.jobId !== input.request.jobId ||
    canonicalJson(envelope.payload.allowedChanges) !==
      canonicalJson(input.request.requestedChanges)
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
      'Execution-budget grant, request, and Task Mandate bindings do not match exactly.',
      ExitCode.guard,
    );
  }
  return binding;
}

function requireCurrentExecutionBudgetGrantBinding(
  payload: ExecutionBudgetGrantPayload,
  requested: TaskMandateBinding,
): TaskMandateBinding {
  const binding = requireStoredExecutionBudgetGrantBinding(payload);
  if (canonicalJson(binding) !== canonicalJson(requested)) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
      'Execution-budget grant does not match the exact Execution Job Task Mandate binding.',
      ExitCode.guard,
    );
  }
  return binding;
}

function requireStoredExecutionBudgetGrantBinding(
  payload: ExecutionBudgetGrantPayload,
): TaskMandateBinding {
  if (payload.mandateBinding === undefined) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY',
      'A legacy execution-budget grant without a Task Mandate binding cannot be consumed or revoked.',
      ExitCode.guard,
    );
  }
  const binding = assertExecutionGrantMandateBinding(
    payload.mandateBinding,
    unsafeGrantStore,
  );
  return binding;
}

function executionBudgetGrantRefusalBinding(
  envelope: ExecutionBudgetGrantEnvelope,
  binding: TaskMandateBinding,
  audit: ExecutionBudgetGrantAuditContext,
  operation: 'execution-budget.consume' | 'execution-budget.revoke',
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const grantDigest = digest(
    canonicalExecutionBudgetGrantEnvelope(envelope),
  ) as Sha256Digest;
  return {
    scope: {
      // The external root always comes from the parsed durable grant envelope,
      // never from the caller's requested binding.
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: audit.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    },
    family: 'execution-budget-grant',
    operation,
    subjectId: envelope.payload.grantId,
    actor: audit.actor ?? { kind: 'engine', identity: 'workflow-engine' },
    taskId: binding.mandateTaskId,
    changeId: binding.changeId,
    workflowId: envelope.payload.workflowId,
    grantDigest,
    bindingDigest: grantDigest,
    refusalIdentity: {
      grantId: envelope.payload.grantId,
      ...refusalIdentity,
    },
  };
}

function appendExecutionBudgetGrantAudit(
  envelope: ExecutionBudgetGrantEnvelope,
  binding: TaskMandateBinding,
  rawAudit: ExecutionBudgetGrantAuditContext,
  transition: 'issue' | 'consume' | 'revoke',
  occurredAt: string,
  detail: ExecutionBudgetConsumeReceipt | string | null,
): AuthorityAuditRecordedEvent {
  const audit = assertExecutionBudgetGrantAuditContext(rawAudit);
  const grantDigest = digest(
    canonicalExecutionBudgetGrantEnvelope(envelope),
  ) as Sha256Digest;
  const transitionDetail =
    transition === 'consume'
      ? (detail as ExecutionBudgetConsumeReceipt).receiptId
      : transition === 'revoke'
        ? (detail as string)
        : envelope.payload.requestDigest;
  const idempotencyKey = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'execution-budget-audit-idempotency.v1',
      transition,
      grantDigest,
      detail: transitionDetail,
    }),
  ) as Sha256Digest;
  const outcomeDigest = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'execution-budget-audit-outcome.v1',
      transition,
      grantId: envelope.payload.grantId,
      requestDigest: envelope.payload.requestDigest,
      mandateBinding: binding,
      detail: transitionDetail,
    }),
  ) as Sha256Digest;
  const entry = recordAuthorityAuditEvent(
    {
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: audit.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    },
    {
      eventType:
        transition === 'issue'
          ? 'escalation-request'
          : transition === 'consume'
            ? 'grant-consume'
            : 'revoke',
      occurredAt,
      idempotencyKey,
      actor:
        audit.actor ??
        (transition === 'issue'
          ? { kind: 'human', identity: envelope.payload.issuer }
          : { kind: 'engine', identity: 'workflow-engine' }),
      taskId: binding.mandateTaskId,
      changeId: binding.changeId,
      workflowId: envelope.payload.workflowId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: outcomeDigest,
      command: {
        name: `execution-budget.${transition}`,
        argvDigest: digest(
          canonicalJson({
            grantId: envelope.payload.grantId,
            jobId: envelope.payload.jobId,
            transition,
          }),
        ) as Sha256Digest,
      },
      providerInvocation: null,
      externalEffect: null,
      result:
        transition === 'consume'
          ? 'succeeded'
          : transition === 'revoke'
            ? 'revoked'
            : 'recorded',
      outcomeDigest,
      errorCode: null,
    },
    audit.serviceHooks,
  );
  audit.onRecord?.(entry);
  return entry;
}

export function inspectExecutionBudgetGrantAuthorization(
  storeRoot: string,
  grantId: string,
): {
  envelope: ExecutionBudgetGrantEnvelope;
  payload: ExecutionBudgetGrantPayload;
  state: 'active' | 'consumed' | 'revoked';
  remainingUses: number;
  receipts: ExecutionBudgetConsumeReceipt[];
} {
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  const record = readGrantRecordRequired(
    path.join(paths.grants, `${assertUuid(grantId, invalidGrant)}.json`),
  );
  return {
    envelope: structuredClone(record.envelope),
    payload: structuredClone(record.envelope.payload),
    state: record.state,
    remainingUses: record.remainingUses,
    receipts: record.receipts.map((receipt) => ({ ...receipt })),
  };
}

/**
 * Enumerate every durably published execution-budget grant without creating
 * or repairing store state. Metrics include active, consumed, and revoked
 * grants, including grants that have never been consumed by an Attempt.
 */
export function listExecutionBudgetGrantMetrics(
  storeRoot: string,
): readonly ExecutionBudgetGrantMetricsRecord[] {
  if (typeof storeRoot !== 'string' || storeRoot.length < 1) {
    throw unsafeGrantStore();
  }
  const root = path.resolve(storeRoot);
  const grants = path.join(root, 'execution-budget-grants');
  const stats = fs.lstatSync(grants, { throwIfNoEntry: false });
  if (stats === undefined) return Object.freeze([]);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(grants) !== grants
  ) {
    throw unsafeGrantStore();
  }
  const records = fs
    .readdirSync(grants, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const match = entry.name.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/,
      );
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw unsafeGrantStore();
      }
      const grantId = match[1]!;
      const record = readGrantRecord(path.join(grants, entry.name));
      if (record.envelope.payload.grantId !== grantId) {
        throw unsafeGrantStore();
      }
      return {
        grantId,
        requestDigest: record.envelope.payload.requestDigest,
        consumedAttemptIds: [...record.consumedAttemptIds].sort(),
      };
    });
  return Object.freeze(
    records.map((record) =>
      Object.freeze({
        ...record,
        consumedAttemptIds: Object.freeze([...record.consumedAttemptIds]),
      }),
    ),
  );
}

export type RepairKind = 'schema' | 'semantic';

export type StructuredValidationError = {
  path: string;
  code: string;
  message: string;
};

export type RepairContext = {
  schemaVersion: 1;
  kind: 'repair-context.v1';
  repairKind: RepairKind;
  workflowId: string;
  epoch: number;
  jobId: string;
  attemptId: string;
  contextDigest: string;
  previousOutput: JsonValue;
  validationErrors: StructuredValidationError[];
  targetSchema: JsonValue;
  instruction: string;
  requiresFullValidation: true;
};

export type RepairBudget = {
  schemaVersion: 1;
  kind: 'repair-budget.v1';
  maxSchemaAttempts: number;
  maxSemanticAttempts: number;
  maxSameFailureFingerprint: number;
  schemaAttempts: number;
  semanticAttempts: number;
  fingerprints: { fingerprint: string; count: number }[];
};

const REPAIR_INSTRUCTION =
  'Return one complete replacement object that satisfies every validation error and the target schema.';

export function buildRepairContext(input: {
  repairKind: RepairKind;
  workflowId: string;
  epoch: number;
  jobId: string;
  attemptId: string;
  contextDigest: string;
  previousOutput: JsonValue;
  validationErrors: StructuredValidationError[];
  targetSchema: JsonValue;
}): RepairContext {
  const context: RepairContext = {
    schemaVersion: 1,
    kind: 'repair-context.v1',
    repairKind: input.repairKind,
    workflowId: input.workflowId,
    epoch: input.epoch,
    jobId: input.jobId,
    attemptId: input.attemptId,
    contextDigest: input.contextDigest,
    previousOutput: cloneJson(input.previousOutput),
    validationErrors: [...input.validationErrors]
      .map((error) => ({ ...error }))
      .sort(compareValidationErrors),
    targetSchema: cloneJson(input.targetSchema),
    instruction: REPAIR_INSTRUCTION,
    requiresFullValidation: true,
  };
  validateRepairContext(context);
  return context;
}

export function canonicalRepairContext(context: RepairContext): string {
  validateRepairContext(context);
  return `${canonicalJson(context)}\n`;
}

export function parseRepairContext(raw: string): RepairContext {
  try {
    const value = parseDocument(raw);
    validateRepairContext(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'REPAIR_CONTEXT_INVALID',
      'Repair context is malformed.',
    );
  }
}

export function createRepairBudget(
  input: {
    maxSchemaAttempts?: number;
    maxSemanticAttempts?: number;
    maxSameFailureFingerprint?: number;
  } = {},
): RepairBudget {
  const budget: RepairBudget = {
    schemaVersion: 1,
    kind: 'repair-budget.v1',
    maxSchemaAttempts: input.maxSchemaAttempts ?? 2,
    maxSemanticAttempts: input.maxSemanticAttempts ?? 1,
    maxSameFailureFingerprint: input.maxSameFailureFingerprint ?? 2,
    schemaAttempts: 0,
    semanticAttempts: 0,
    fingerprints: [],
  };
  validateRepairBudget(budget);
  return budget;
}

export function consumeRepairBudget(
  current: RepairBudget,
  repairKind: RepairKind,
  failureFingerprint: string,
): RepairBudget {
  validateRepairBudget(current);
  if (repairKind !== 'schema' && repairKind !== 'semantic') {
    throw invalidRepairBudget('Repair kind must be schema or semantic.');
  }
  assertFingerprint(failureFingerprint);
  const budget: RepairBudget = {
    ...current,
    fingerprints: current.fingerprints.map((entry) => ({ ...entry })),
  };
  const entry = budget.fingerprints.find(
    ({ fingerprint }) => fingerprint === failureFingerprint,
  );
  const fingerprintCount = entry?.count ?? 0;
  const exhaustedByKind =
    repairKind === 'schema'
      ? budget.schemaAttempts >= budget.maxSchemaAttempts
      : budget.semanticAttempts >= budget.maxSemanticAttempts;
  if (exhaustedByKind || fingerprintCount >= budget.maxSameFailureFingerprint) {
    throw workflowError(
      'REPAIR_BUDGET_EXHAUSTED',
      `${repairKind} repair budget is exhausted.`,
      ExitCode.guard,
    );
  }
  if (repairKind === 'schema') budget.schemaAttempts += 1;
  else budget.semanticAttempts += 1;
  if (entry) entry.count += 1;
  else budget.fingerprints.push({ fingerprint: failureFingerprint, count: 1 });
  budget.fingerprints.sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
  validateRepairBudget(budget);
  return budget;
}

export function canonicalRepairBudget(budget: RepairBudget): string {
  validateRepairBudget(budget);
  return `${canonicalJson(budget)}\n`;
}

export function parseRepairBudget(raw: string): RepairBudget {
  try {
    const value = parseDocument(raw);
    validateRepairBudget(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'REPAIR_BUDGET_INVALID',
      'Repair budget is malformed.',
    );
  }
}

export type ContextManifestItemReference = {
  identity: string;
  digest: string;
};

export type ContextManifest = {
  schemaVersion: 1;
  kind: 'epoch-context-manifest';
  workflowId: string;
  epoch: number;
  contractVersion: number;
  baselineDigest: string;
  intentDigest: string;
  termSetDigest: string;
  planningSnapshotDigest: string;
  contextDigest: string;
  items: ContextManifestItemReference[];
};

export function buildContextManifest(input: {
  workflowId: string;
  epoch: number;
  contractVersion: number;
  baselineDigest: string;
  intentDigest: string;
  termSetDigest: string;
  planningSnapshotDigest: string;
  items: { identity: string; content: string }[];
}): ContextManifest {
  const references = [...input.items]
    .map(({ identity, content }) => {
      assertIdentity(identity, invalidContextManifest, 'context item identity');
      if (typeof content !== 'string' || Buffer.byteLength(content) > 262_144) {
        throw invalidContextManifest('Context item content is invalid.');
      }
      return { identity, digest: digest(content) };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const contextIdentity = {
    workflowId: input.workflowId,
    epoch: input.epoch,
    contractVersion: input.contractVersion,
    baselineDigest: input.baselineDigest,
    intentDigest: input.intentDigest,
    termSetDigest: input.termSetDigest,
    planningSnapshotDigest: input.planningSnapshotDigest,
    items: references,
  };
  const manifest: ContextManifest = {
    schemaVersion: 1,
    kind: 'epoch-context-manifest',
    ...contextIdentity,
    contextDigest: digest(canonicalJson(contextIdentity)),
  };
  validateContextManifest(manifest);
  return manifest;
}

export function canonicalContextManifest(manifest: ContextManifest): string {
  validateContextManifest(manifest);
  return `${canonicalJson(manifest)}\n`;
}

export function parseContextManifest(raw: string): ContextManifest {
  try {
    const value = parseDocument(raw);
    validateContextManifest(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'CONTEXT_MANIFEST_INVALID',
      'Epoch context manifest is malformed.',
    );
  }
}

export function assemblePromptFromManifest(
  manifest: ContextManifest,
  loadExactItem: (reference: ContextManifestItemReference) => {
    identity: string;
    digest: string;
    content: string;
  },
): string {
  validateContextManifest(manifest);
  const contents = manifest.items.map((reference) => {
    let loaded: ReturnType<typeof loadExactItem>;
    try {
      loaded = loadExactItem({ ...reference });
    } catch (error) {
      if (isWorkflowError(error)) throw error;
      throw workflowError(
        'CONTEXT_ITEM_UNAVAILABLE',
        `Context item ${reference.identity} could not be loaded.`,
        ExitCode.staleState,
      );
    }
    if (
      !isRecord(loaded) ||
      !hasExactKeys(loaded, ['identity', 'digest', 'content']) ||
      loaded.identity !== reference.identity ||
      loaded.digest !== reference.digest ||
      typeof loaded.content !== 'string' ||
      digest(loaded.content) !== reference.digest
    ) {
      throw workflowError(
        'CONTEXT_ITEM_MISMATCH',
        `Context item ${reference.identity} does not match its manifest digest.`,
        ExitCode.staleState,
      );
    }
    return loaded.content;
  });
  const prompt = contents.join('\n\n');
  if (Buffer.byteLength(prompt) > MAX_DOCUMENT_BYTES) {
    throw workflowError(
      'CONTEXT_PROMPT_TOO_LARGE',
      'Manifest-only prompt exceeds the bounded context size.',
      ExitCode.guard,
    );
  }
  return prompt;
}

export type WorkflowContextState = {
  workflowId: string;
  currentEpoch: number;
  contractVersion: number;
  contextDigest: string;
  snapshotDigest: string;
  status: 'active' | 'completed' | 'cancelled' | 'superseded';
  checkpoint: string;
  blocker: { kind: string; since: string } | null;
};

export type ResultEligibilityJob = {
  workflowId: string;
  jobId: string;
  epoch: number;
  contextDigest: string;
  snapshotDigest: string;
  acceptedAttemptId: string | null;
  eligibleAttemptIds: string[];
};

export type AttemptResultCandidate = {
  workflowId: string;
  jobId: string;
  attemptId: string;
  epoch: number;
  contextDigest: string;
  snapshotDigest: string;
};

export type AttemptResultEligibility = {
  eligible: boolean;
  classification: 'eligible' | 'stale' | 'late-duplicate' | 'rejected';
  reasonCode?: string;
  doNotMerge?: true;
};

export function assessAttemptResultEligibility(
  workflow: WorkflowContextState,
  job: ResultEligibilityJob,
  result: AttemptResultCandidate,
): AttemptResultEligibility {
  if (
    result.workflowId !== workflow.workflowId ||
    job.workflowId !== workflow.workflowId
  ) {
    return rejectedResult('RESULT_WRONG_OWNER');
  }
  if (workflow.status !== 'active') {
    return rejectedResult('RESULT_WORKFLOW_TERMINAL');
  }
  if (
    result.epoch !== workflow.currentEpoch ||
    job.epoch !== workflow.currentEpoch
  ) {
    return staleResult('RESULT_STALE_EPOCH');
  }
  if (
    result.contextDigest !== workflow.contextDigest ||
    job.contextDigest !== workflow.contextDigest
  ) {
    return staleResult('RESULT_CONTEXT_MISMATCH');
  }
  if (result.jobId !== job.jobId) {
    return rejectedResult('RESULT_WRONG_JOB');
  }
  if (
    result.snapshotDigest !== workflow.snapshotDigest ||
    job.snapshotDigest !== workflow.snapshotDigest
  ) {
    return staleResult('RESULT_SNAPSHOT_MISMATCH');
  }
  if (job.acceptedAttemptId !== null) {
    return {
      eligible: false,
      classification: 'late-duplicate',
      reasonCode: 'RESULT_ALREADY_ACCEPTED',
      doNotMerge: true,
    };
  }
  if (!job.eligibleAttemptIds.includes(result.attemptId)) {
    return rejectedResult('RESULT_ATTEMPT_INELIGIBLE');
  }
  return { eligible: true, classification: 'eligible' };
}

export type EpochTransitionVerification = {
  check: string;
  result: 'passed' | 'failed';
  reportDigest?: string;
};

export type EpochCarryForwardDecision = {
  identity: string;
  reason: string;
};

export type EpochCarryForwardManifest = {
  schemaVersion: 1;
  kind: 'epoch-carry-forward-manifest';
  sourceWorkflow: string;
  sourceEpoch: number;
  carriedForward: EpochCarryForwardDecision[];
  excluded: EpochCarryForwardDecision[];
};

type EpochTransitionReceiptCommon = {
  kind: 'epoch-transition';
  workflowId: string;
  fromEpoch: number;
  toEpoch: number;
  fromContractVersion: number;
  toContractVersion: number;
  reason: string;
  restartFrom: string;
  carriedForward: string[];
  invalidated: string[];
  previousContextDigest: string;
  newContextDigest: string;
  verification: EpochTransitionVerification | null;
  createdAt: string;
};

export type EpochTransitionReceipt =
  | (EpochTransitionReceiptCommon & {
      schemaVersion: 1;
    })
  | (EpochTransitionReceiptCommon & {
      schemaVersion: 2;
      carryForwardManifest: EpochCarryForwardManifest;
    });

export type EpochTransitionStub = {
  schemaVersion: 1;
  kind: 'epoch-transition-stub';
  workflowId: string;
  fromEpoch: number;
  toEpoch: number;
  prunedAt: string;
  pruningPolicyVersion: number;
};

export function performEpochRollover(input: {
  workflow: WorkflowContextState;
  nextManifest: ContextManifest;
  reason: string;
  restartFrom: string;
  carriedForward: string[];
  carryForwardManifest?: {
    sourceWorkflow: string;
    sourceEpoch: number;
    carriedForward: EpochCarryForwardDecision[];
    excluded: EpochCarryForwardDecision[];
  };
  invalidated: string[];
  verification: EpochTransitionVerification | null;
  createdAt: Date;
}): { workflow: WorkflowContextState; receipt: EpochTransitionReceipt } {
  validateContextManifest(input.nextManifest);
  validateWorkflowContextState(input.workflow);
  if (
    input.nextManifest.workflowId !== input.workflow.workflowId ||
    input.nextManifest.epoch !== input.workflow.currentEpoch + 1 ||
    input.nextManifest.contextDigest === input.workflow.contextDigest
  ) {
    throw invalidEpochTransition(
      'Epoch rollover must advance the same workflow by one to a new context digest.',
    );
  }
  assertReason(input.reason, invalidEpochTransition, 'rollover reason');
  assertIdentity(
    input.restartFrom,
    invalidEpochTransition,
    'restart checkpoint',
  );
  const carriedForward = sortedUniqueIdentities(
    input.carriedForward,
    invalidEpochTransition,
    'carried-forward identity',
  );
  const allowed = new Set(
    input.nextManifest.items.map(({ identity }) => identity),
  );
  if (carriedForward.some((identity) => !allowed.has(identity))) {
    throw invalidEpochTransition(
      'Every carried-forward identity must appear in the new context manifest.',
    );
  }
  const invalidated = sortedUniqueIdentities(
    input.invalidated,
    invalidEpochTransition,
    'invalidated stage',
  );
  const verification = validateEpochVerification(input.verification);
  const createdAt = exactDate(input.createdAt, 'EPOCH_TRANSITION_INVALID');
  const carryForwardManifest =
    input.carryForwardManifest === undefined
      ? null
      : normalizeEpochCarryForwardManifest(
          input.carryForwardManifest,
          input.workflow,
          carriedForward,
        );
  const workflow: WorkflowContextState = {
    ...input.workflow,
    currentEpoch: input.nextManifest.epoch,
    contractVersion: input.nextManifest.contractVersion,
    contextDigest: input.nextManifest.contextDigest,
    snapshotDigest: input.nextManifest.baselineDigest,
    checkpoint: input.restartFrom,
    status: 'active',
    blocker: null,
  };
  const receiptCommon: EpochTransitionReceiptCommon = {
    kind: 'epoch-transition',
    workflowId: workflow.workflowId,
    fromEpoch: input.workflow.currentEpoch,
    toEpoch: workflow.currentEpoch,
    fromContractVersion: input.workflow.contractVersion,
    toContractVersion: workflow.contractVersion,
    reason: input.reason,
    restartFrom: input.restartFrom,
    carriedForward,
    invalidated,
    previousContextDigest: input.workflow.contextDigest,
    newContextDigest: workflow.contextDigest,
    verification,
    createdAt,
  };
  const receipt: EpochTransitionReceipt =
    carryForwardManifest === null
      ? { schemaVersion: 1, ...receiptCommon }
      : {
          schemaVersion: 2,
          ...receiptCommon,
          carryForwardManifest,
        };
  validateEpochTransitionReceipt(receipt);
  return { workflow, receipt };
}

export function canonicalEpochTransitionReceipt(
  receipt: EpochTransitionReceipt,
): string {
  validateEpochTransitionReceipt(receipt);
  return `${canonicalJson(receipt)}\n`;
}

export function parseEpochTransitionReceipt(
  raw: string,
): EpochTransitionReceipt {
  try {
    const value = parseDocument(raw);
    validateEpochTransitionReceipt(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'EPOCH_TRANSITION_INVALID',
      'Epoch transition receipt is malformed.',
    );
  }
}

export type Retention = 'active' | 'expiring' | 'pinned';

export type EvidenceRetentionRecord = {
  schemaVersion: 1;
  kind: 'evidence-retention';
  evidenceId: string;
  itemIdentity: string | null;
  workflowId: string;
  epoch: number;
  evidenceClass: 'raw' | 'derived' | 'manifest-item';
  digest: string;
  retention: Retention;
  createdAt: string;
  expiresAt: string | null;
  pin: {
    actor: string;
    reason: string;
    pinnedAt: string;
  } | null;
};

export type RetentionPolicy = {
  schemaVersion: 1;
  previousEpochTtlDays: number;
  maxExpiringTtlDays: number;
  transitionReceiptTtlDays: number;
  maxFullTransitionReceipts: number;
  maxTransitionReceiptStubs: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  schemaVersion: 1,
  previousEpochTtlDays: 7,
  maxExpiringTtlDays: 90,
  transitionReceiptTtlDays: 90,
  maxFullTransitionReceipts: 20,
  maxTransitionReceiptStubs: 100,
});

export function pinEvidence(
  record: EvidenceRetentionRecord,
  decision: {
    actor: string;
    reason: string;
    pinnedAt: Date;
    humanConfirmed: true;
  },
): EvidenceRetentionRecord {
  validateEvidenceRetentionRecord(record);
  if (decision.humanConfirmed !== true) {
    throw workflowError(
      'RETENTION_PIN_REQUIRES_HUMAN',
      'Evidence may be pinned only by an explicit human decision.',
      ExitCode.guard,
    );
  }
  assertIdentity(decision.actor, invalidRetentionRecord, 'pin actor');
  assertReason(decision.reason, invalidRetentionRecord, 'pin reason');
  const result: EvidenceRetentionRecord = {
    ...record,
    retention: 'pinned',
    expiresAt: null,
    pin: {
      actor: decision.actor,
      reason: decision.reason,
      pinnedAt: exactDate(decision.pinnedAt, 'RETENTION_RECORD_INVALID'),
    },
  };
  if (
    new Date(result.pin!.pinnedAt).getTime() <
    new Date(record.createdAt).getTime()
  ) {
    throw invalidRetentionRecord('Evidence cannot be pinned before it exists.');
  }
  validateEvidenceRetentionRecord(result);
  return result;
}

export function markEpochEvidenceExpiring(
  records: EvidenceRetentionRecord[],
  input: {
    endedEpoch: number;
    endedAt: Date;
    policy?: RetentionPolicy;
  },
): EvidenceRetentionRecord[] {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  assertPositiveInteger(
    input.endedEpoch,
    invalidRetentionRecord,
    'ended epoch',
  );
  const endedAt = new Date(
    exactDate(input.endedAt, 'RETENTION_RECORD_INVALID'),
  );
  const expiresAt = new Date(
    endedAt.getTime() + policy.previousEpochTtlDays * 86_400_000,
  ).toISOString();
  return records.map((record) => {
    validateEvidenceRetentionRecord(record, policy);
    if (record.epoch !== input.endedEpoch || record.retention !== 'active') {
      return cloneRetentionRecord(record);
    }
    const next: EvidenceRetentionRecord = {
      ...record,
      retention: 'expiring',
      expiresAt,
      pin: null,
    };
    validateEvidenceRetentionRecord(next, policy);
    return next;
  });
}

export function planEvidencePruning(input: {
  records: EvidenceRetentionRecord[];
  currentEpoch: number;
  currentManifest: ContextManifest;
  now: Date;
  policy?: RetentionPolicy;
}): { keep: string[]; delete: string[] } {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  validateContextManifest(input.currentManifest);
  assertPositiveInteger(
    input.currentEpoch,
    invalidRetentionRecord,
    'current epoch',
  );
  if (input.currentManifest.epoch !== input.currentEpoch) {
    throw invalidRetentionRecord(
      'Current manifest epoch must equal the pruning current epoch.',
    );
  }
  const now = new Date(exactDate(input.now, 'RETENTION_RECORD_INVALID'));
  const manifestItems = new Map(
    input.currentManifest.items.map(({ identity, digest: itemDigest }) => [
      identity,
      itemDigest,
    ]),
  );
  const seen = new Set<string>();
  const keep: string[] = [];
  const remove: string[] = [];
  for (const record of input.records) {
    validateEvidenceRetentionRecord(record, policy);
    if (seen.has(record.evidenceId)) {
      throw invalidRetentionRecord(
        'Evidence IDs must be unique while pruning.',
      );
    }
    seen.add(record.evidenceId);
    const manifestDigest =
      record.itemIdentity === null
        ? undefined
        : manifestItems.get(record.itemIdentity);
    if (manifestDigest !== undefined) {
      if (manifestDigest === record.digest) {
        keep.push(record.evidenceId);
        continue;
      }
      if (record.epoch === input.currentEpoch) {
        throw workflowError(
          'RETENTION_MANIFEST_DIGEST_MISMATCH',
          `Evidence ${record.evidenceId} conflicts with the current manifest digest.`,
          ExitCode.staleState,
        );
      }
    }
    if (record.retention === 'pinned' || record.epoch === input.currentEpoch) {
      keep.push(record.evidenceId);
      continue;
    }
    if (record.retention === 'active') {
      throw invalidRetentionRecord(
        `Non-current evidence ${record.evidenceId} must be expiring or pinned.`,
      );
    }
    const expired = new Date(record.expiresAt!).getTime() <= now.getTime();
    const olderRaw =
      record.evidenceClass === 'raw' && record.epoch < input.currentEpoch - 1;
    (expired || olderRaw ? remove : keep).push(record.evidenceId);
  }
  return { keep: keep.sort(), delete: remove.sort() };
}

export function canonicalEvidenceRetentionRecord(
  record: EvidenceRetentionRecord,
): string {
  validateEvidenceRetentionRecord(record);
  return `${canonicalJson(record)}\n`;
}

export function parseEvidenceRetentionRecord(
  raw: string,
): EvidenceRetentionRecord {
  try {
    const value = parseDocument(raw);
    validateEvidenceRetentionRecord(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'RETENTION_RECORD_INVALID',
      'Evidence retention record is malformed.',
    );
  }
}

export function compactEpochTransitionReceipts(
  receipts: EpochTransitionReceipt[],
  existingStubs: EpochTransitionStub[],
  input: { now: Date; policy?: RetentionPolicy },
): {
  full: EpochTransitionReceipt[];
  stubs: EpochTransitionStub[];
  discarded: string[];
} {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const nowIso = exactDate(input.now, 'RETENTION_POLICY_INVALID');
  const now = new Date(nowIso);
  receipts.forEach(validateEpochTransitionReceipt);
  existingStubs.forEach(validateEpochTransitionStub);
  const ordered = [...receipts].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const full: EpochTransitionReceipt[] = [];
  const compacted: EpochTransitionStub[] = [];
  const maxAgeMs = policy.transitionReceiptTtlDays * 86_400_000;
  for (const receipt of ordered) {
    const withinAge =
      now.getTime() - new Date(receipt.createdAt).getTime() <= maxAgeMs;
    if (withinAge && full.length < policy.maxFullTransitionReceipts) {
      full.push(receipt);
    } else {
      compacted.push({
        schemaVersion: 1,
        kind: 'epoch-transition-stub',
        workflowId: receipt.workflowId,
        fromEpoch: receipt.fromEpoch,
        toEpoch: receipt.toEpoch,
        prunedAt: nowIso,
        pruningPolicyVersion: policy.schemaVersion,
      });
    }
  }
  const uniqueStubs = new Map<string, EpochTransitionStub>();
  for (const stub of [...existingStubs, ...compacted]) {
    validateEpochTransitionStub(stub);
    uniqueStubs.set(transitionKey(stub), stub);
  }
  const orderedStubs = [...uniqueStubs.values()].sort((left, right) => {
    const byPruned =
      new Date(right.prunedAt).getTime() - new Date(left.prunedAt).getTime();
    return byPruned || right.toEpoch - left.toEpoch;
  });
  const stubs = orderedStubs.slice(0, policy.maxTransitionReceiptStubs);
  const discarded = orderedStubs
    .slice(policy.maxTransitionReceiptStubs)
    .map(transitionKey);
  return { full, stubs, discarded };
}

export function canonicalEpochTransitionStub(
  stub: EpochTransitionStub,
): string {
  validateEpochTransitionStub(stub);
  return `${canonicalJson(stub)}\n`;
}

export type DurableEpochContextState = {
  schemaVersion: 1;
  kind: 'durable-epoch-context';
  generation: number;
  workflow: WorkflowContextState;
  currentManifest: ContextManifest;
  transitionReceipts: EpochTransitionReceipt[];
  transitionStubs: EpochTransitionStub[];
  updatedAt: string;
};

export type DurableRetentionCatalog = {
  schemaVersion: 1;
  kind: 'durable-retention-catalog';
  workflowId: string;
  generation: number;
  records: EvidenceRetentionRecord[];
  updatedAt: string;
};

export type DurablePruneReceipt = {
  schemaVersion: 1;
  kind: 'durable-evidence-prune';
  receiptId: string;
  state: 'prepared' | 'complete' | 'aborted';
  workflowId: string;
  contextGeneration: number;
  epoch: number;
  contextDigest: string;
  catalogGenerationBefore: number;
  catalogDigestBefore: string;
  catalogGenerationAfter: number;
  catalogDigestAfter: string;
  deleted: { evidenceId: string; digest: string }[];
  preparedAt: string;
  completedAt: string | null;
  abortedAt: string | null;
  abortReason: string | null;
};

type DurableGovernanceState = {
  schemaVersion: 1;
  kind: 'durable-execution-governance-state';
  context: DurableEpochContextState;
  retention: DurableRetentionCatalog;
};

type DurableGovernancePaths = {
  root: string;
  states: string;
  objects: string;
  locks: string;
  pruneReceipts: string;
};

/**
 * Creates the first durable context generation and its retention catalog as one
 * atomic workflow envelope. Context objects are published before the envelope,
 * so an interrupted initialization can leave only unreachable content objects.
 */
export function initializeDurableEpochContextStore(
  storeRoot: string,
  input: {
    workflow: WorkflowContextState;
    manifest: ContextManifest;
    items: { identity: string; content: string }[];
    now: Date;
  },
): DurableEpochContextState {
  validateContextManifest(input.manifest);
  validateWorkflowContextState(input.workflow);
  assertContextManifestBinding(input.workflow, input.manifest);
  const updatedAt = exactDate(input.now, 'EXECUTION_CONTEXT_INVALID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflow.workflowId, () => {
    const statePath = durableStatePath(paths, input.workflow.workflowId);
    if (fs.lstatSync(statePath, { throwIfNoEntry: false }) !== undefined) {
      throw workflowError(
        'EXECUTION_CONTEXT_EXISTS',
        `Durable context for ${input.workflow.workflowId} already exists.`,
        ExitCode.conflict,
      );
    }
    persistManifestItems(
      paths,
      input.workflow.workflowId,
      input.manifest,
      input.items,
    );
    const context: DurableEpochContextState = {
      schemaVersion: 1,
      kind: 'durable-epoch-context',
      generation: 1,
      workflow: structuredClone(input.workflow),
      currentManifest: structuredClone(input.manifest),
      transitionReceipts: [],
      transitionStubs: [],
      updatedAt,
    };
    const retention: DurableRetentionCatalog = {
      schemaVersion: 1,
      kind: 'durable-retention-catalog',
      workflowId: input.workflow.workflowId,
      generation: 1,
      records: manifestRetentionRecords(input.manifest, updatedAt),
      updatedAt,
    };
    const state: DurableGovernanceState = {
      schemaVersion: 1,
      kind: 'durable-execution-governance-state',
      context,
      retention,
    };
    createDurablePrivateFileAtomic(
      statePath,
      canonicalDurableGovernanceState(state),
    );
    return structuredClone(context);
  });
}

export function inspectDurableEpochContextStore(
  storeRoot: string,
  workflowId: string,
): DurableEpochContextState {
  assertIdentity(workflowId, invalidDurableContext, 'workflow ID');
  const state = readDurableGovernanceState(
    ensureDurableGovernanceStore(storeRoot),
    workflowId,
  );
  return structuredClone(state.context);
}

export type DurableEpochTransitionCompactionResult = Readonly<{
  workflowId: string;
  changed: boolean;
  contextGeneration: number;
  fullReceiptsBefore: number;
  fullReceiptsAfter: number;
  stubsBefore: number;
  stubsAfter: number;
  discarded: readonly string[];
}>;

/**
 * Applies transition-receipt TTL and count bounds without requiring another
 * semantic epoch rollover. Receipt retention is operational maintenance: it
 * may advance the durable context envelope generation, but it must not change
 * the current epoch, manifest, workflow binding, or evidence catalog.
 */
export function compactDurableEpochTransitionReceipts(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedContextGeneration: number;
    now: Date;
    policy?: RetentionPolicy;
  },
): DurableEpochTransitionCompactionResult {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  assertPositiveInteger(
    input.expectedContextGeneration,
    invalidDurableContext,
    'expected context generation',
  );
  const updatedAt = exactDate(input.now, 'RETENTION_POLICY_INVALID');
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    if (state.context.generation !== input.expectedContextGeneration) {
      throw workflowError(
        'EXECUTION_CONTEXT_CAS_MISMATCH',
        'Durable context changed before transition receipts were compacted.',
        ExitCode.staleState,
      );
    }
    const fullReceiptsBefore = state.context.transitionReceipts.length;
    const stubsBefore = state.context.transitionStubs.length;
    const compacted = compactEpochTransitionReceipts(
      state.context.transitionReceipts,
      state.context.transitionStubs,
      { now: input.now, policy },
    );
    const changed =
      canonicalJson(compacted.full) !==
        canonicalJson(state.context.transitionReceipts) ||
      canonicalJson(compacted.stubs) !==
        canonicalJson(state.context.transitionStubs);
    if (!changed) {
      return Object.freeze({
        workflowId: input.workflowId,
        changed: false,
        contextGeneration: state.context.generation,
        fullReceiptsBefore,
        fullReceiptsAfter: fullReceiptsBefore,
        stubsBefore,
        stubsAfter: stubsBefore,
        discarded: Object.freeze([...compacted.discarded]),
      });
    }
    const context: DurableEpochContextState = {
      ...state.context,
      generation: state.context.generation + 1,
      transitionReceipts: compacted.full,
      transitionStubs: compacted.stubs,
      updatedAt,
    };
    replacePrivateFileAtomic(
      durableStatePath(paths, input.workflowId),
      canonicalDurableGovernanceState({ ...state, context }),
    );
    return Object.freeze({
      workflowId: input.workflowId,
      changed: true,
      contextGeneration: context.generation,
      fullReceiptsBefore,
      fullReceiptsAfter: context.transitionReceipts.length,
      stubsBefore,
      stubsAfter: context.transitionStubs.length,
      discarded: Object.freeze([...compacted.discarded]),
    });
  });
}

/**
 * Revalidate one exact current context and execute a short synchronous
 * acceptance operation while holding the same per-workflow lock used by epoch
 * rollover. Callers receive no raw lock primitive and must not perform
 * long-running provider or tool work inside the callback.
 */
export function withCurrentDurableEpochContextStore<T>(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
    expectedManifest: ContextManifest;
  },
  operation: (context: DurableEpochContextState) => T,
): T {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  assertPositiveInteger(
    input.expectedGeneration,
    invalidDurableContext,
    'expected generation',
  );
  assertPositiveInteger(
    input.expectedEpoch,
    invalidDurableContext,
    'expected epoch',
  );
  assertDigest(
    input.expectedContextDigest,
    invalidDurableContext,
    'expected context digest',
  );
  validateContextManifest(input.expectedManifest);
  if (
    input.expectedManifest.workflowId !== input.workflowId ||
    input.expectedManifest.epoch !== input.expectedEpoch ||
    input.expectedManifest.contextDigest !== input.expectedContextDigest
  ) {
    throw invalidDurableContext(
      'Expected context manifest does not match its acceptance binding.',
    );
  }
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    const state = readDurableGovernanceState(paths, input.workflowId);
    if (
      state.context.generation !== input.expectedGeneration ||
      state.context.workflow.status !== 'active' ||
      state.context.workflow.currentEpoch !== input.expectedEpoch ||
      state.context.workflow.contextDigest !== input.expectedContextDigest ||
      canonicalJson(state.context.currentManifest) !==
        canonicalJson(input.expectedManifest)
    ) {
      throw workflowError(
        'EXECUTION_CONTEXT_CAS_MISMATCH',
        'Durable context changed before the guarded acceptance operation.',
        ExitCode.staleState,
      );
    }
    return operation(structuredClone(state.context));
  });
}

export function inspectDurableRetentionCatalog(
  storeRoot: string,
  workflowId: string,
): DurableRetentionCatalog {
  assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
  const state = readDurableGovernanceState(
    ensureDurableGovernanceStore(storeRoot),
    workflowId,
  );
  return structuredClone(state.retention);
}

/**
 * Rolls the current epoch under a context-generation CAS. Only the new
 * manifest is retained as the assembly authority; historical manifests are
 * represented by bounded transition receipts/stubs, not prompt inputs.
 */
export function rolloverDurableEpochContextStore(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
    nextManifest: ContextManifest;
    items: { identity: string; content: string }[];
    reason: string;
    restartFrom: string;
    carriedForward: string[];
    carryForwardManifest?: {
      sourceWorkflow: string;
      sourceEpoch: number;
      carriedForward: EpochCarryForwardDecision[];
      excluded: EpochCarryForwardDecision[];
    };
    invalidated: string[];
    verification: EpochTransitionVerification | null;
    createdAt: Date;
    policy?: RetentionPolicy;
  },
): DurableEpochContextState {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  validateContextManifest(input.nextManifest);
  const createdAt = exactDate(input.createdAt, 'EPOCH_TRANSITION_INVALID');
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    assertContextCas(state.context, input);
    if (input.nextManifest.workflowId !== input.workflowId) {
      throw invalidEpochTransition(
        'The next context manifest belongs to another workflow.',
      );
    }
    if (state.context.workflow.status !== 'active') {
      throw invalidEpochTransition(
        'A terminal workflow cannot advance to another epoch.',
      );
    }
    const transition = performEpochRollover({
      workflow: state.context.workflow,
      nextManifest: input.nextManifest,
      reason: input.reason,
      restartFrom: input.restartFrom,
      carriedForward: input.carriedForward,
      carryForwardManifest: input.carryForwardManifest,
      invalidated: input.invalidated,
      verification: input.verification,
      createdAt: input.createdAt,
    });
    if (transition.receipt.schemaVersion === 2) {
      assertEpochCarryForwardSourceMembership(
        transition.receipt.carryForwardManifest,
        state.context.currentManifest,
        input.nextManifest,
      );
    }
    persistManifestItems(
      paths,
      input.workflowId,
      input.nextManifest,
      input.items,
    );
    const compacted = compactEpochTransitionReceipts(
      [...state.context.transitionReceipts, transition.receipt],
      state.context.transitionStubs,
      { now: input.createdAt, policy },
    );
    const context: DurableEpochContextState = {
      ...state.context,
      generation: state.context.generation + 1,
      workflow: transition.workflow,
      currentManifest: structuredClone(input.nextManifest),
      transitionReceipts: compacted.full,
      transitionStubs: compacted.stubs,
      updatedAt: createdAt,
    };
    const expired = markEpochEvidenceExpiring(state.retention.records, {
      endedEpoch: state.context.workflow.currentEpoch,
      endedAt: input.createdAt,
      policy,
    });
    const records = [
      ...expired,
      ...manifestRetentionRecords(input.nextManifest, createdAt),
    ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    assertUniqueEvidenceIds(records);
    const retention: DurableRetentionCatalog = {
      ...state.retention,
      generation: state.retention.generation + 1,
      records,
      updatedAt: createdAt,
    };
    const next: DurableGovernanceState = {
      ...state,
      context,
      retention,
    };
    replacePrivateFileAtomic(
      durableStatePath(paths, input.workflowId),
      canonicalDurableGovernanceState(next),
    );
    return structuredClone(context);
  });
}

/** Prompt assembly is deliberately a current-manifest-only traversal. */
export function assembleCurrentPromptFromStore(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedEpoch: number;
    expectedContextDigest: string;
  },
): string {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  assertPositiveInteger(
    input.expectedEpoch,
    invalidDurableContext,
    'expected epoch',
  );
  assertDigest(
    input.expectedContextDigest,
    invalidDurableContext,
    'expected context digest',
  );
  const paths = ensureDurableGovernanceStore(storeRoot);
  const state = readDurableGovernanceState(paths, input.workflowId);
  if (state.context.workflow.currentEpoch !== input.expectedEpoch) {
    throw workflowError(
      'EXECUTION_CONTEXT_STALE_EPOCH',
      `Epoch ${input.expectedEpoch} is not the current epoch for ${input.workflowId}.`,
      ExitCode.staleState,
    );
  }
  if (state.context.workflow.contextDigest !== input.expectedContextDigest) {
    throw workflowError(
      'EXECUTION_CONTEXT_STALE_MANIFEST',
      `The expected manifest is not current for ${input.workflowId}.`,
      ExitCode.staleState,
    );
  }
  return assemblePromptFromManifest(
    state.context.currentManifest,
    (reference) => ({
      ...reference,
      content: readDurableContentObject(
        paths,
        input.workflowId,
        reference.digest,
      ),
    }),
  );
}

export function assessStoredAttemptResultEligibility(
  storeRoot: string,
  workflowId: string,
  job: ResultEligibilityJob,
  result: AttemptResultCandidate,
): AttemptResultEligibility {
  const state = inspectDurableEpochContextStore(storeRoot, workflowId);
  return assessAttemptResultEligibility(state.workflow, job, result);
}

export function storeDurableEvidence(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedCatalogGeneration: number;
    record: EvidenceRetentionRecord;
    content: string;
  },
): DurableRetentionCatalog {
  assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
  validateEvidenceRetentionRecord(input.record);
  if (input.record.retention === 'pinned') {
    throw workflowError(
      'RETENTION_PIN_REQUIRES_HUMAN',
      'Pinned evidence must be created through an explicit human pin decision.',
      ExitCode.guard,
    );
  }
  if (
    typeof input.content !== 'string' ||
    Buffer.byteLength(input.content) > MAX_DOCUMENT_BYTES ||
    digest(input.content) !== input.record.digest
  ) {
    throw workflowError(
      'RETENTION_EVIDENCE_DIGEST_MISMATCH',
      'Evidence content does not match its retention digest.',
      ExitCode.verification,
    );
  }
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    assertCatalogCas(state.retention, input.expectedCatalogGeneration);
    if (input.record.workflowId !== input.workflowId) {
      throw invalidRetentionRecord('Evidence belongs to another workflow.');
    }
    if (
      input.record.epoch > state.context.workflow.currentEpoch ||
      (input.record.retention === 'active' &&
        input.record.epoch !== state.context.workflow.currentEpoch)
    ) {
      throw workflowError(
        'RETENTION_STALE_EPOCH',
        'Only the current epoch may publish active evidence.',
        ExitCode.staleState,
      );
    }
    assertCurrentManifestEvidenceBinding(
      state.context.currentManifest,
      input.record,
    );
    if (
      state.retention.records.some(
        ({ evidenceId }) => evidenceId === input.record.evidenceId,
      )
    ) {
      throw workflowError(
        'RETENTION_EVIDENCE_EXISTS',
        `Evidence ${input.record.evidenceId} already exists.`,
        ExitCode.conflict,
      );
    }
    publishDurableContentObject(
      paths,
      input.workflowId,
      input.record.digest,
      input.content,
    );
    const updatedAt = new Date().toISOString();
    const retention: DurableRetentionCatalog = {
      ...state.retention,
      generation: state.retention.generation + 1,
      records: [...state.retention.records, structuredClone(input.record)].sort(
        (left, right) => left.evidenceId.localeCompare(right.evidenceId),
      ),
      updatedAt,
    };
    replaceDurableGovernanceState(paths, {
      ...state,
      retention,
    });
    return structuredClone(retention);
  });
}

export function pinDurableEvidence(
  storeRoot: string,
  input: {
    workflowId: string;
    evidenceId: string;
    expectedCatalogGeneration: number;
    decision: {
      actor: string;
      reason: string;
      pinnedAt: Date;
      humanConfirmed: true;
    };
  },
): DurableRetentionCatalog {
  assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
  assertIdentity(input.evidenceId, invalidRetentionRecord, 'evidence ID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    assertCatalogCas(state.retention, input.expectedCatalogGeneration);
    const index = state.retention.records.findIndex(
      ({ evidenceId }) => evidenceId === input.evidenceId,
    );
    if (index < 0) throw retentionEvidenceNotFound(input.evidenceId);
    const records = state.retention.records.map((record, recordIndex) =>
      recordIndex === index
        ? pinEvidence(record, input.decision)
        : structuredClone(record),
    );
    const retention: DurableRetentionCatalog = {
      ...state.retention,
      generation: state.retention.generation + 1,
      records,
      updatedAt: exactDate(input.decision.pinnedAt, 'RETENTION_RECORD_INVALID'),
    };
    replaceDurableGovernanceState(paths, { ...state, retention });
    return structuredClone(retention);
  });
}

export function readDurableEvidence(
  storeRoot: string,
  workflowId: string,
  evidenceId: string,
): { record: EvidenceRetentionRecord; content: string } {
  assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
  assertIdentity(evidenceId, invalidRetentionRecord, 'evidence ID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  const state = readDurableGovernanceState(paths, workflowId);
  const record = state.retention.records.find(
    (candidate) => candidate.evidenceId === evidenceId,
  );
  if (record === undefined) throw retentionEvidenceNotFound(evidenceId);
  return {
    record: structuredClone(record),
    content: readDurableContentObject(paths, workflowId, record.digest),
  };
}

/**
 * Performs one explicit pruning pass. The prepared receipt is durable before
 * the catalog CAS, and object deletion happens only after the catalog no longer
 * names the records. A later mutation recovers a prepared pass idempotently.
 */
export function pruneDurableEvidence(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedContextGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
    expectedCatalogGeneration: number;
    now: Date;
    policy?: RetentionPolicy;
  },
): { catalog: DurableRetentionCatalog; receipt: DurablePruneReceipt } {
  assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
  const now = exactDate(input.now, 'RETENTION_RECORD_INVALID');
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    if (
      state.context.generation !== input.expectedContextGeneration ||
      state.context.workflow.currentEpoch !== input.expectedEpoch ||
      state.context.workflow.contextDigest !== input.expectedContextDigest
    ) {
      throw workflowError(
        'EXECUTION_CONTEXT_CAS_MISMATCH',
        'Durable context changed before evidence pruning.',
        ExitCode.staleState,
      );
    }
    assertCatalogCas(state.retention, input.expectedCatalogGeneration);
    const plan = planEvidencePruning({
      records: state.retention.records,
      currentEpoch: state.context.workflow.currentEpoch,
      currentManifest: state.context.currentManifest,
      now: input.now,
      policy,
    });
    const deleting = new Set(plan.delete);
    const deleted = state.retention.records
      .filter(({ evidenceId }) => deleting.has(evidenceId))
      .map(({ evidenceId, digest: evidenceDigest }) => ({
        evidenceId,
        digest: evidenceDigest,
      }))
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const retention: DurableRetentionCatalog = {
      ...state.retention,
      generation: state.retention.generation + 1,
      records: state.retention.records
        .filter(({ evidenceId }) => !deleting.has(evidenceId))
        .map((record) => structuredClone(record)),
      updatedAt: now,
    };
    const receipt: DurablePruneReceipt = {
      schemaVersion: 1,
      kind: 'durable-evidence-prune',
      receiptId: crypto.randomUUID(),
      state: 'prepared',
      workflowId: input.workflowId,
      contextGeneration: state.context.generation,
      epoch: state.context.workflow.currentEpoch,
      contextDigest: state.context.workflow.contextDigest,
      catalogGenerationBefore: state.retention.generation,
      catalogDigestBefore: durableRetentionCatalogDigest(state.retention),
      catalogGenerationAfter: retention.generation,
      catalogDigestAfter: durableRetentionCatalogDigest(retention),
      deleted,
      preparedAt: now,
      completedAt: null,
      abortedAt: null,
      abortReason: null,
    };
    const receiptPath = durablePruneReceiptPath(
      paths,
      input.workflowId,
      receipt.receiptId,
    );
    createDurablePrivateFileAtomic(
      receiptPath,
      canonicalDurablePruneReceipt(receipt),
    );
    const next: DurableGovernanceState = { ...state, retention };
    replaceDurableGovernanceState(paths, next);
    deleteUnreferencedReceiptObjects(paths, next, receipt);
    const complete: DurablePruneReceipt = {
      ...receipt,
      state: 'complete',
      completedAt: now,
    };
    replacePrivateFileAtomic(
      receiptPath,
      canonicalDurablePruneReceipt(complete),
    );
    return {
      catalog: structuredClone(retention),
      receipt: structuredClone(complete),
    };
  });
}

export function listDurablePruneReceipts(
  storeRoot: string,
  workflowId: string,
): DurablePruneReceipt[] {
  assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  const directory = durableWorkflowReceiptDirectory(paths, workflowId, true);
  const receipts = fs
    .readdirSync(directory)
    .filter((name) => !isDurablePruneReceiptTemporary(name))
    .map((name) => {
      if (
        !UUID_V4.test(name.replace(/\.json$/, '')) ||
        !name.endsWith('.json')
      ) {
        throw unsafeDurableGovernanceStore();
      }
      const receipt = readDurablePruneReceipt(path.join(directory, name));
      if (receipt.workflowId !== workflowId) {
        throw unsafeDurableGovernanceStore();
      }
      return receipt;
    });
  return receipts
    .sort(
      (left, right) =>
        left.preparedAt.localeCompare(right.preparedAt) ||
        left.receiptId.localeCompare(right.receiptId),
    )
    .map((receipt) => structuredClone(receipt));
}

function canonicalDurableGovernanceState(
  state: DurableGovernanceState,
): string {
  validateDurableGovernanceState(state);
  return boundedDurableDocument(`${canonicalJson(state)}\n`);
}

function canonicalDurableRetentionCatalog(
  catalog: DurableRetentionCatalog,
): string {
  validateDurableRetentionCatalog(catalog);
  return boundedDurableDocument(`${canonicalJson(catalog)}\n`);
}

function durableRetentionCatalogDigest(
  catalog: DurableRetentionCatalog,
): string {
  return digest(canonicalDurableRetentionCatalog(catalog));
}

function canonicalDurablePruneReceipt(receipt: DurablePruneReceipt): string {
  validateDurablePruneReceipt(receipt);
  return boundedDurableDocument(`${canonicalJson(receipt)}\n`);
}

function boundedDurableDocument(content: string): string {
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
    throw workflowError(
      'EXECUTION_GOVERNANCE_STORE_CAPACITY',
      'Durable execution-governance document exceeds its size bound.',
      ExitCode.guard,
    );
  }
  return content;
}

function validateDurableGovernanceState(
  value: unknown,
): asserts value is DurableGovernanceState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'kind', 'context', 'retention']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-execution-governance-state'
  ) {
    throw unsafeDurableGovernanceStore();
  }
  validateDurableEpochContextState(value.context);
  validateDurableRetentionCatalog(value.retention);
  const context = value.context;
  const retention = value.retention;
  if (retention.workflowId !== context.workflow.workflowId) {
    throw unsafeDurableGovernanceStore();
  }
  const currentItems = new Map(
    context.currentManifest.items.map(({ identity, digest: itemDigest }) => [
      identity,
      itemDigest,
    ]),
  );
  for (const record of retention.records) {
    if (
      record.epoch > context.workflow.currentEpoch ||
      (record.retention === 'active' &&
        record.epoch !== context.workflow.currentEpoch)
    ) {
      throw unsafeDurableGovernanceStore();
    }
    if (record.itemIdentity !== null) {
      const currentDigest = currentItems.get(record.itemIdentity);
      if (
        record.epoch === context.workflow.currentEpoch &&
        currentDigest !== undefined &&
        currentDigest !== record.digest
      ) {
        throw unsafeDurableGovernanceStore();
      }
    }
  }
  for (const [identity, itemDigest] of currentItems) {
    if (
      !retention.records.some(
        (record) =>
          record.itemIdentity === identity &&
          record.digest === itemDigest &&
          record.epoch === context.workflow.currentEpoch &&
          record.evidenceClass === 'manifest-item' &&
          record.retention !== 'expiring',
      )
    ) {
      throw unsafeDurableGovernanceStore();
    }
  }
}

function validateDurableEpochContextState(
  value: unknown,
): asserts value is DurableEpochContextState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'generation',
      'workflow',
      'currentManifest',
      'transitionReceipts',
      'transitionStubs',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-epoch-context'
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertPositiveInteger(
    value.generation,
    unsafeDurableGovernanceStore,
    'context generation',
  );
  validateStoredWorkflowContextState(value.workflow);
  validateContextManifest(value.currentManifest);
  assertStoredContextManifestBinding(value.workflow, value.currentManifest);
  if (
    !Array.isArray(value.transitionReceipts) ||
    value.transitionReceipts.length >
      DEFAULT_RETENTION_POLICY.maxFullTransitionReceipts ||
    !Array.isArray(value.transitionStubs) ||
    value.transitionStubs.length > 200
  ) {
    throw unsafeDurableGovernanceStore();
  }
  const transitionKeys = new Set<string>();
  for (const receipt of value.transitionReceipts) {
    validateEpochTransitionReceipt(receipt);
    if (
      receipt.workflowId !== value.workflow.workflowId ||
      transitionKeys.has(transitionKey(receipt))
    ) {
      throw unsafeDurableGovernanceStore();
    }
    transitionKeys.add(transitionKey(receipt));
  }
  for (const stub of value.transitionStubs) {
    validateEpochTransitionStub(stub);
    if (
      stub.workflowId !== value.workflow.workflowId ||
      transitionKeys.has(transitionKey(stub))
    ) {
      throw unsafeDurableGovernanceStore();
    }
    transitionKeys.add(transitionKey(stub));
  }
  assertTimestamp(
    value.updatedAt,
    unsafeDurableGovernanceStore,
    'context updatedAt',
  );
}

function validateStoredWorkflowContextState(
  value: unknown,
): asserts value is WorkflowContextState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'workflowId',
      'currentEpoch',
      'contractVersion',
      'contextDigest',
      'snapshotDigest',
      'status',
      'checkpoint',
      'blocker',
    ])
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
  assertPositiveInteger(
    value.currentEpoch,
    unsafeDurableGovernanceStore,
    'current epoch',
  );
  assertPositiveInteger(
    value.contractVersion,
    unsafeDurableGovernanceStore,
    'contract version',
  );
  assertDigest(
    value.contextDigest,
    unsafeDurableGovernanceStore,
    'context digest',
  );
  assertDigest(
    value.snapshotDigest,
    unsafeDurableGovernanceStore,
    'snapshot digest',
  );
  assertIdentity(value.checkpoint, unsafeDurableGovernanceStore, 'checkpoint');
  if (
    !['active', 'completed', 'cancelled', 'superseded'].includes(
      String(value.status),
    )
  ) {
    throw unsafeDurableGovernanceStore();
  }
  if (value.blocker !== null) {
    if (
      !isRecord(value.blocker) ||
      !hasExactKeys(value.blocker, ['kind', 'since'])
    ) {
      throw unsafeDurableGovernanceStore();
    }
    assertIdentity(
      value.blocker.kind,
      unsafeDurableGovernanceStore,
      'blocker kind',
    );
    assertTimestamp(
      value.blocker.since,
      unsafeDurableGovernanceStore,
      'blocker since',
    );
  }
}

function validateDurableRetentionCatalog(
  value: unknown,
): asserts value is DurableRetentionCatalog {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'generation',
      'records',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-retention-catalog'
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
  assertPositiveInteger(
    value.generation,
    unsafeDurableGovernanceStore,
    'catalog generation',
  );
  if (!Array.isArray(value.records) || value.records.length > 8_192) {
    throw unsafeDurableGovernanceStore();
  }
  let previous = '';
  for (const record of value.records) {
    validateEvidenceRetentionRecord(record);
    if (
      record.workflowId !== value.workflowId ||
      record.evidenceId <= previous
    ) {
      throw unsafeDurableGovernanceStore();
    }
    previous = record.evidenceId;
  }
  assertTimestamp(
    value.updatedAt,
    unsafeDurableGovernanceStore,
    'catalog updatedAt',
  );
}

function validateDurablePruneReceipt(
  value: unknown,
): asserts value is DurablePruneReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'receiptId',
      'state',
      'workflowId',
      'contextGeneration',
      'epoch',
      'contextDigest',
      'catalogGenerationBefore',
      'catalogDigestBefore',
      'catalogGenerationAfter',
      'catalogDigestAfter',
      'deleted',
      'preparedAt',
      'completedAt',
      'abortedAt',
      'abortReason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-evidence-prune' ||
    !['prepared', 'complete', 'aborted'].includes(String(value.state))
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertUuid(value.receiptId, unsafeDurableGovernanceStore);
  assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
  assertPositiveInteger(
    value.contextGeneration,
    unsafeDurableGovernanceStore,
    'context generation',
  );
  assertPositiveInteger(value.epoch, unsafeDurableGovernanceStore, 'epoch');
  assertDigest(
    value.contextDigest,
    unsafeDurableGovernanceStore,
    'context digest',
  );
  assertPositiveInteger(
    value.catalogGenerationBefore,
    unsafeDurableGovernanceStore,
    'catalog generation before',
  );
  if (value.catalogGenerationAfter !== value.catalogGenerationBefore + 1) {
    throw unsafeDurableGovernanceStore();
  }
  assertDigest(
    value.catalogDigestBefore,
    unsafeDurableGovernanceStore,
    'catalog digest before',
  );
  assertDigest(
    value.catalogDigestAfter,
    unsafeDurableGovernanceStore,
    'catalog digest after',
  );
  if (!Array.isArray(value.deleted) || value.deleted.length > 8_192) {
    throw unsafeDurableGovernanceStore();
  }
  let previous = '';
  for (const entry of value.deleted) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['evidenceId', 'digest'])) {
      throw unsafeDurableGovernanceStore();
    }
    assertIdentity(
      entry.evidenceId,
      unsafeDurableGovernanceStore,
      'evidence ID',
    );
    assertDigest(entry.digest, unsafeDurableGovernanceStore, 'evidence digest');
    if (entry.evidenceId <= previous) throw unsafeDurableGovernanceStore();
    previous = entry.evidenceId;
  }
  assertTimestamp(value.preparedAt, unsafeDurableGovernanceStore, 'preparedAt');
  if (value.state === 'prepared') {
    if (
      value.completedAt !== null ||
      value.abortedAt !== null ||
      value.abortReason !== null
    ) {
      throw unsafeDurableGovernanceStore();
    }
  } else if (value.state === 'complete') {
    assertTimestamp(
      value.completedAt,
      unsafeDurableGovernanceStore,
      'completedAt',
    );
    if (value.abortedAt !== null || value.abortReason !== null) {
      throw unsafeDurableGovernanceStore();
    }
  } else {
    assertTimestamp(value.abortedAt, unsafeDurableGovernanceStore, 'abortedAt');
    assertReason(
      value.abortReason,
      unsafeDurableGovernanceStore,
      'abort reason',
    );
    if (value.completedAt !== null) throw unsafeDurableGovernanceStore();
  }
}

function assertContextManifestBinding(
  workflow: WorkflowContextState,
  manifest: ContextManifest,
): void {
  if (
    workflow.workflowId !== manifest.workflowId ||
    workflow.currentEpoch !== manifest.epoch ||
    workflow.contractVersion !== manifest.contractVersion ||
    workflow.contextDigest !== manifest.contextDigest ||
    workflow.snapshotDigest !== manifest.baselineDigest
  ) {
    throw invalidDurableContext(
      'Workflow state must exactly bind the current context manifest.',
    );
  }
}

function assertStoredContextManifestBinding(
  workflow: WorkflowContextState,
  manifest: ContextManifest,
): void {
  try {
    assertContextManifestBinding(workflow, manifest);
  } catch {
    throw unsafeDurableGovernanceStore();
  }
}

function assertCurrentManifestEvidenceBinding(
  manifest: ContextManifest,
  record: EvidenceRetentionRecord,
): void {
  if (
    record.evidenceClass === 'manifest-item' &&
    record.itemIdentity === null
  ) {
    throw invalidRetentionRecord(
      'Manifest-item evidence requires an item identity.',
    );
  }
  if (record.itemIdentity === null) return;
  const reference = manifest.items.find(
    ({ identity }) => identity === record.itemIdentity,
  );
  if (
    record.epoch === manifest.epoch &&
    reference !== undefined &&
    reference.digest !== record.digest
  ) {
    throw workflowError(
      'RETENTION_MANIFEST_DIGEST_MISMATCH',
      `Evidence ${record.evidenceId} conflicts with the current manifest digest.`,
      ExitCode.staleState,
    );
  }
}

function assertContextCas(
  context: DurableEpochContextState,
  expected: {
    expectedGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
  },
): void {
  assertPositiveInteger(
    expected.expectedGeneration,
    invalidDurableContext,
    'expected generation',
  );
  assertPositiveInteger(
    expected.expectedEpoch,
    invalidDurableContext,
    'expected epoch',
  );
  assertDigest(
    expected.expectedContextDigest,
    invalidDurableContext,
    'expected context digest',
  );
  if (
    context.generation !== expected.expectedGeneration ||
    context.workflow.currentEpoch !== expected.expectedEpoch ||
    context.workflow.contextDigest !== expected.expectedContextDigest
  ) {
    throw workflowError(
      'EXECUTION_CONTEXT_CAS_MISMATCH',
      'Durable context changed before the epoch transition.',
      ExitCode.staleState,
    );
  }
}

function assertCatalogCas(
  catalog: DurableRetentionCatalog,
  expectedGeneration: number,
): void {
  assertPositiveInteger(
    expectedGeneration,
    invalidRetentionRecord,
    'expected catalog generation',
  );
  if (catalog.generation !== expectedGeneration) {
    throw workflowError(
      'RETENTION_CATALOG_CAS_MISMATCH',
      'The retention catalog changed before the requested operation.',
      ExitCode.staleState,
    );
  }
}

function manifestRetentionRecords(
  manifest: ContextManifest,
  createdAt: string,
): EvidenceRetentionRecord[] {
  return manifest.items
    .map(({ identity, digest: itemDigest }) => ({
      schemaVersion: 1 as const,
      kind: 'evidence-retention' as const,
      evidenceId: `manifest-${manifest.epoch}-${crypto
        .createHash('sha256')
        .update(identity)
        .digest('hex')
        .slice(0, 32)}`,
      itemIdentity: identity,
      workflowId: manifest.workflowId,
      epoch: manifest.epoch,
      evidenceClass: 'manifest-item' as const,
      digest: itemDigest,
      retention: 'active' as const,
      createdAt,
      expiresAt: null,
      pin: null,
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function assertUniqueEvidenceIds(records: EvidenceRetentionRecord[]): void {
  const ids = new Set(records.map(({ evidenceId }) => evidenceId));
  if (ids.size !== records.length) {
    throw invalidRetentionRecord('Evidence IDs must be unique.');
  }
}

function persistManifestItems(
  paths: DurableGovernancePaths,
  workflowId: string,
  manifest: ContextManifest,
  items: { identity: string; content: string }[],
): void {
  if (!Array.isArray(items) || items.length !== manifest.items.length) {
    throw invalidContextManifest(
      'Stored context items must exactly match the manifest item set.',
    );
  }
  const byIdentity = new Map<string, string>();
  for (const item of items) {
    if (!isRecord(item) || !hasExactKeys(item, ['identity', 'content'])) {
      throw invalidContextManifest('Stored context item is malformed.');
    }
    assertIdentity(
      item.identity,
      invalidContextManifest,
      'context item identity',
    );
    if (
      typeof item.content !== 'string' ||
      Buffer.byteLength(item.content) > 262_144 ||
      byIdentity.has(item.identity)
    ) {
      throw invalidContextManifest('Stored context item content is invalid.');
    }
    byIdentity.set(item.identity, item.content);
  }
  for (const reference of manifest.items) {
    const content = byIdentity.get(reference.identity);
    if (content === undefined || digest(content) !== reference.digest) {
      throw workflowError(
        'CONTEXT_ITEM_MISMATCH',
        `Context item ${reference.identity} does not match its manifest digest.`,
        ExitCode.verification,
      );
    }
  }
  for (const reference of manifest.items) {
    const content = byIdentity.get(reference.identity)!;
    publishDurableContentObject(paths, workflowId, reference.digest, content);
  }
}

function ensureDurableGovernanceStore(
  storeRoot: string,
): DurableGovernancePaths {
  if (
    typeof storeRoot !== 'string' ||
    storeRoot.length < 1 ||
    storeRoot.includes('\0')
  ) {
    throw unsafeDurableGovernanceStore();
  }
  const hostRoot = path.resolve(storeRoot);
  ensurePrivateDirectory(hostRoot, false);
  const root = path.join(hostRoot, 'execution-governance-store');
  ensurePrivateDirectory(root, true);
  const states = path.join(root, 'states');
  const objects = path.join(root, 'objects');
  const locks = path.join(root, 'locks');
  const pruneReceipts = path.join(root, 'prune-receipts');
  ensurePrivateDirectory(states, true);
  ensurePrivateDirectory(objects, true);
  ensurePrivateDirectory(locks, true);
  ensurePrivateDirectory(pruneReceipts, true);
  return { root, states, objects, locks, pruneReceipts };
}

function ensurePrivateDirectory(directory: string, create: boolean): void {
  if (create) {
    try {
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw unsafeDurableGovernanceStore();
      }
    }
  }
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0
  ) {
    throw unsafeDurableGovernanceStore();
  }
}

function workflowStorageKey(workflowId: string): string {
  return crypto.createHash('sha256').update(workflowId).digest('hex');
}

function durableStatePath(
  paths: DurableGovernancePaths,
  workflowId: string,
): string {
  return path.join(paths.states, `${workflowStorageKey(workflowId)}.json`);
}

function durableWorkflowObjectDirectory(
  paths: DurableGovernancePaths,
  workflowId: string,
  create: boolean,
): string {
  const directory = path.join(paths.objects, workflowStorageKey(workflowId));
  ensurePrivateDirectory(directory, create);
  return directory;
}

function durableObjectPath(
  paths: DurableGovernancePaths,
  workflowId: string,
  contentDigest: string,
): string {
  assertDigest(contentDigest, unsafeDurableGovernanceStore, 'object digest');
  return path.join(
    durableWorkflowObjectDirectory(paths, workflowId, true),
    `${contentDigest.slice('sha256:'.length)}.blob`,
  );
}

function durableWorkflowReceiptDirectory(
  paths: DurableGovernancePaths,
  workflowId: string,
  create: boolean,
): string {
  const directory = path.join(
    paths.pruneReceipts,
    workflowStorageKey(workflowId),
  );
  ensurePrivateDirectory(directory, create);
  return directory;
}

function durablePruneReceiptPath(
  paths: DurableGovernancePaths,
  workflowId: string,
  receiptId: string,
): string {
  assertUuid(receiptId, unsafeDurableGovernanceStore);
  return path.join(
    durableWorkflowReceiptDirectory(paths, workflowId, true),
    `${receiptId}.json`,
  );
}

function readDurableGovernanceState(
  paths: DurableGovernancePaths,
  workflowId: string,
): DurableGovernanceState {
  const statePath = durableStatePath(paths, workflowId);
  if (fs.lstatSync(statePath, { throwIfNoEntry: false }) === undefined) {
    throw workflowError(
      'EXECUTION_CONTEXT_NOT_FOUND',
      `Durable context for ${workflowId} does not exist.`,
      ExitCode.staleState,
    );
  }
  try {
    const raw = readPrivateFile(statePath, MAX_DOCUMENT_BYTES);
    const value = parseDocument(raw);
    validateDurableGovernanceState(value);
    if (
      value.context.workflow.workflowId !== workflowId ||
      canonicalDurableGovernanceState(value) !== raw
    ) {
      throw unsafeDurableGovernanceStore();
    }
    return value;
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeDurableGovernanceStore();
  }
}

function replaceDurableGovernanceState(
  paths: DurableGovernancePaths,
  state: DurableGovernanceState,
): void {
  replacePrivateFileAtomic(
    durableStatePath(paths, state.context.workflow.workflowId),
    canonicalDurableGovernanceState(state),
  );
}

function publishDurableContentObject(
  paths: DurableGovernancePaths,
  workflowId: string,
  contentDigest: string,
  content: string,
): void {
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content) > MAX_DOCUMENT_BYTES ||
    digest(content) !== contentDigest
  ) {
    throw workflowError(
      'EXECUTION_CONTENT_OBJECT_MISMATCH',
      'Content-addressed object does not match its digest.',
      ExitCode.verification,
    );
  }
  const objectPath = durableObjectPath(paths, workflowId, contentDigest);
  if (fs.lstatSync(objectPath, { throwIfNoEntry: false }) !== undefined) {
    if (readPrivateFile(objectPath, MAX_DOCUMENT_BYTES) !== content) {
      throw unsafeDurableGovernanceStore();
    }
    return;
  }
  try {
    createDurablePrivateFileAtomic(objectPath, content);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  if (readPrivateFile(objectPath, MAX_DOCUMENT_BYTES) !== content) {
    throw unsafeDurableGovernanceStore();
  }
}

function readDurableContentObject(
  paths: DurableGovernancePaths,
  workflowId: string,
  contentDigest: string,
): string {
  try {
    const content = readPrivateFile(
      durableObjectPath(paths, workflowId, contentDigest),
      MAX_DOCUMENT_BYTES,
    );
    if (digest(content) !== contentDigest) {
      throw unsafeDurableGovernanceStore();
    }
    return content;
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeDurableGovernanceStore();
  }
}

function readPrivateFile(filePath: string, maximumBytes: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > maximumBytes
    ) {
      throw unsafeDurableGovernanceStore();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeDurableGovernanceStore();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readDurablePruneReceipt(filePath: string): DurablePruneReceipt {
  try {
    const raw = readPrivateFile(filePath, MAX_DOCUMENT_BYTES);
    const value = parseDocument(raw);
    validateDurablePruneReceipt(value);
    if (canonicalDurablePruneReceipt(value) !== raw) {
      throw unsafeDurableGovernanceStore();
    }
    return value;
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeDurableGovernanceStore();
  }
}

function recoverPreparedPruneReceipts(
  paths: DurableGovernancePaths,
  workflowId: string,
  state: DurableGovernanceState,
): void {
  const directory = durableWorkflowReceiptDirectory(paths, workflowId, true);
  const names = fs.readdirSync(directory).sort();
  for (const name of names) {
    if (isDurablePruneReceiptTemporary(name)) continue;
    if (!name.endsWith('.json') || !UUID_V4.test(name.slice(0, -5))) {
      throw unsafeDurableGovernanceStore();
    }
    const receiptPath = path.join(directory, name);
    const receipt = readDurablePruneReceipt(receiptPath);
    if (receipt.workflowId !== workflowId || receipt.state !== 'prepared') {
      if (receipt.workflowId !== workflowId) {
        throw unsafeDurableGovernanceStore();
      }
      continue;
    }
    const currentDigest = durableRetentionCatalogDigest(state.retention);
    const recoveredAt = new Date().toISOString();
    if (currentDigest === receipt.catalogDigestBefore) {
      const aborted: DurablePruneReceipt = {
        ...receipt,
        state: 'aborted',
        abortedAt: recoveredAt,
        abortReason: 'Pruning stopped before catalog publication.',
      };
      replacePrivateFileAtomic(
        receiptPath,
        canonicalDurablePruneReceipt(aborted),
      );
      continue;
    }
    if (currentDigest !== receipt.catalogDigestAfter) {
      throw unsafeDurableGovernanceStore();
    }
    deleteUnreferencedReceiptObjects(paths, state, receipt);
    const complete: DurablePruneReceipt = {
      ...receipt,
      state: 'complete',
      completedAt: recoveredAt,
    };
    replacePrivateFileAtomic(
      receiptPath,
      canonicalDurablePruneReceipt(complete),
    );
  }
}

function isDurablePruneReceiptTemporary(name: string): boolean {
  const [receiptId, json, pid, temporaryId, suffix, ...extra] = name.split('.');
  return (
    extra.length === 0 &&
    json === 'json' &&
    suffix === 'tmp' &&
    UUID_V4.test(receiptId ?? '') &&
    /^[1-9][0-9]*$/.test(pid ?? '') &&
    UUID_V4.test(temporaryId ?? '')
  );
}

function deleteUnreferencedReceiptObjects(
  paths: DurableGovernancePaths,
  state: DurableGovernanceState,
  receipt: DurablePruneReceipt,
): void {
  if (
    durableRetentionCatalogDigest(state.retention) !==
      receipt.catalogDigestAfter ||
    state.context.generation !== receipt.contextGeneration ||
    state.context.workflow.currentEpoch !== receipt.epoch ||
    state.context.workflow.contextDigest !== receipt.contextDigest
  ) {
    throw unsafeDurableGovernanceStore();
  }
  const referenced = new Set([
    ...state.context.currentManifest.items.map(
      ({ digest: itemDigest }) => itemDigest,
    ),
    ...state.retention.records.map(
      ({ digest: evidenceDigest }) => evidenceDigest,
    ),
  ]);
  const objectDirectory = durableWorkflowObjectDirectory(
    paths,
    receipt.workflowId,
    true,
  );
  let changed = false;
  for (const entry of receipt.deleted) {
    if (referenced.has(entry.digest)) continue;
    const objectPath = durableObjectPath(
      paths,
      receipt.workflowId,
      entry.digest,
    );
    if (fs.lstatSync(objectPath, { throwIfNoEntry: false }) === undefined) {
      continue;
    }
    const content = readPrivateFile(objectPath, MAX_DOCUMENT_BYTES);
    if (digest(content) !== entry.digest) {
      throw unsafeDurableGovernanceStore();
    }
    fs.unlinkSync(objectPath);
    changed = true;
  }
  if (changed) fsyncDirectory(objectDirectory);
}

function withDurableGovernanceLock<T>(
  paths: DurableGovernancePaths,
  workflowId: string,
  operation: () => T,
): T {
  const lockPath = path.join(
    paths.locks,
    `${workflowStorageKey(workflowId)}.lock`,
  );
  let descriptor: number | undefined;
  let ownedStats: fs.Stats | undefined;
  for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
    let createdThisAttempt = false;
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      createdThisAttempt = true;
      fs.fchmodSync(descriptor, 0o600);
      const lockRecord = {
        schemaVersion: 1,
        workflowId,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(descriptor, `${canonicalJson(lockRecord)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      ownedStats = fs.fstatSync(descriptor);
      fsyncDirectory(paths.locks);
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      ownedStats = undefined;
      if (createdThisAttempt) {
        try {
          fs.unlinkSync(lockPath);
          fsyncDirectory(paths.locks);
        } catch (cleanupError) {
          if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
            throw unsafeDurableGovernanceStore();
          }
        }
      }
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (!reclaimDeadDurableGovernanceLock(lockPath, workflowId)) {
        throw workflowError(
          'EXECUTION_GOVERNANCE_OPERATION_CONFLICT',
          `Workflow ${workflowId} already has a governance operation in progress.`,
          ExitCode.conflict,
        );
      }
    }
  }
  if (descriptor === undefined || ownedStats === undefined) {
    throw workflowError(
      'EXECUTION_GOVERNANCE_OPERATION_CONFLICT',
      `Workflow ${workflowId} already has a governance operation in progress.`,
      ExitCode.conflict,
    );
  }
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  fs.closeSync(descriptor);
  let releaseError: unknown;
  try {
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.dev !== ownedStats.dev ||
      current.ino !== ownedStats.ino
    ) {
      throw unsafeDurableGovernanceStore();
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(paths.locks);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

function reclaimDeadDurableGovernanceLock(
  lockPath: string,
  workflowId: string,
): boolean {
  const raw = readPrivateFile(lockPath, 4_096);
  let value: unknown;
  try {
    value = parseDocument(raw);
  } catch {
    throw unsafeDurableGovernanceStore();
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'workflowId', 'pid', 'createdAt']) ||
    value.schemaVersion !== 1 ||
    value.workflowId !== workflowId ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    `${canonicalJson(value)}\n` !== raw
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertTimestamp(
    value.createdAt,
    unsafeDurableGovernanceStore,
    'lock createdAt',
  );
  try {
    process.kill(value.pid as number, 0);
    return false;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') return false;
  }
  try {
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    throw error;
  }
}

function retentionEvidenceNotFound(evidenceId: string): WorkflowError {
  return workflowError(
    'RETENTION_EVIDENCE_NOT_FOUND',
    `Evidence ${evidenceId} does not exist in the current catalog.`,
    ExitCode.staleState,
  );
}

function validateExecutionBudgetGrantRequest(
  value: unknown,
): asserts value is ExecutionBudgetGrantRequest {
  const legacyKeys = [
    'schemaVersion',
    'kind',
    'requestId',
    'workflowId',
    'epoch',
    'jobId',
    'requestedChanges',
    'rationale',
    'expiresAfterAttempts',
    'createdAt',
  ];
  if (
    !isRecord(value) ||
    !hasKeysEither(value, [legacyKeys, [...legacyKeys, 'mandateBinding']]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-grant-request'
  ) {
    throw invalidGrantRequest('Grant request has an invalid shape.');
  }
  assertUuid(value.requestId, invalidGrantRequest);
  assertIdentity(value.workflowId, invalidGrantRequest, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidGrantRequest, 'epoch');
  assertIdentity(value.jobId, invalidGrantRequest, 'job ID');
  if (Object.prototype.hasOwnProperty.call(value, 'mandateBinding')) {
    assertExecutionGrantMandateBinding(
      value.mandateBinding,
      invalidGrantRequest,
    );
  }
  validateChanges(value.requestedChanges, invalidGrantRequest);
  assertReason(value.rationale, invalidGrantRequest, 'rationale');
  assertBoundedInteger(
    value.expiresAfterAttempts,
    1,
    MAX_GRANT_USES,
    invalidGrantRequest,
    'attempt bound',
  );
  assertTimestamp(value.createdAt, invalidGrantRequest, 'createdAt');
}

function validateExecutionBudgetGrantPayload(
  value: unknown,
): asserts value is ExecutionBudgetGrantPayload {
  const legacyKeys = [
    'schemaVersion',
    'kind',
    'grantId',
    'requestDigest',
    'workflowId',
    'epoch',
    'jobId',
    'allowedChanges',
    'maxUses',
    'issuedAt',
    'issuer',
  ];
  if (
    !isRecord(value) ||
    !hasKeysEither(value, [legacyKeys, [...legacyKeys, 'mandateBinding']]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-grant.v1'
  ) {
    throw invalidGrant('Grant payload has an invalid shape.');
  }
  assertUuid(value.grantId, invalidGrant);
  assertDigest(value.requestDigest, invalidGrant, 'request digest');
  assertIdentity(value.workflowId, invalidGrant, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidGrant, 'epoch');
  assertIdentity(value.jobId, invalidGrant, 'job ID');
  if (Object.prototype.hasOwnProperty.call(value, 'mandateBinding')) {
    assertExecutionGrantMandateBinding(value.mandateBinding, invalidGrant);
  }
  validateChanges(value.allowedChanges, invalidGrant);
  assertBoundedInteger(
    value.maxUses,
    1,
    MAX_GRANT_USES,
    invalidGrant,
    'maximum uses',
  );
  assertTimestamp(value.issuedAt, invalidGrant, 'issuedAt');
  assertIdentity(value.issuer, invalidGrant, 'issuer');
}

function validateExecutionBudgetGrantEnvelope(
  value: unknown,
): asserts value is ExecutionBudgetGrantEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    typeof value.signature !== 'string' ||
    value.signature.length < 1 ||
    value.signature.length > 16_384 ||
    value.signature.includes('\0')
  ) {
    throw invalidGrant('Grant envelope has an invalid shape or signature.');
  }
  validateExecutionBudgetGrantPayload(value.payload);
}

function validateExecutionBudgetConsumeReceipt(
  value: unknown,
  payload?: ExecutionBudgetGrantPayload,
): asserts value is ExecutionBudgetConsumeReceipt {
  const legacyKeys = [
    'schemaVersion',
    'kind',
    'receiptId',
    'grantId',
    'requestDigest',
    'workflowId',
    'epoch',
    'jobId',
    'attemptId',
    'useNumber',
    'remainingUses',
    'consumedAt',
  ];
  if (
    !isRecord(value) ||
    !hasKeysEither(value, [legacyKeys, [...legacyKeys, 'mandateBinding']]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-consume-receipt'
  ) {
    throw unsafeGrantStore();
  }
  assertDigest(value.receiptId, unsafeGrantStore, 'receipt ID');
  assertUuid(value.grantId, unsafeGrantStore);
  assertDigest(value.requestDigest, unsafeGrantStore, 'request digest');
  assertIdentity(value.workflowId, unsafeGrantStore, 'workflow ID');
  assertPositiveInteger(value.epoch, unsafeGrantStore, 'epoch');
  assertIdentity(value.jobId, unsafeGrantStore, 'job ID');
  if (Object.prototype.hasOwnProperty.call(value, 'mandateBinding')) {
    assertExecutionGrantMandateBinding(value.mandateBinding, unsafeGrantStore);
  }
  assertIdentity(value.attemptId, unsafeGrantStore, 'attempt ID');
  assertBoundedInteger(
    value.useNumber,
    1,
    MAX_GRANT_USES,
    unsafeGrantStore,
    'use',
  );
  assertBoundedInteger(
    value.remainingUses,
    0,
    MAX_GRANT_USES - 1,
    unsafeGrantStore,
    'remaining uses',
  );
  assertTimestamp(value.consumedAt, unsafeGrantStore, 'consumedAt');
  const { receiptId: _receiptId, ...core } = value;
  if (value.receiptId !== digest(canonicalJson(core))) throw unsafeGrantStore();
  if (
    payload &&
    (value.grantId !== payload.grantId ||
      value.requestDigest !== payload.requestDigest ||
      value.workflowId !== payload.workflowId ||
      value.epoch !== payload.epoch ||
      value.jobId !== payload.jobId ||
      (payload.mandateBinding === undefined
        ? Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        : !Object.prototype.hasOwnProperty.call(value, 'mandateBinding') ||
          canonicalJson(value.mandateBinding) !==
            canonicalJson(payload.mandateBinding)) ||
      value.useNumber + value.remainingUses !== payload.maxUses)
  ) {
    throw unsafeGrantStore();
  }
}

function validateRepairContext(value: unknown): asserts value is RepairContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repairKind',
      'workflowId',
      'epoch',
      'jobId',
      'attemptId',
      'contextDigest',
      'previousOutput',
      'validationErrors',
      'targetSchema',
      'instruction',
      'requiresFullValidation',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'repair-context.v1' ||
    (value.repairKind !== 'schema' && value.repairKind !== 'semantic') ||
    value.instruction !== REPAIR_INSTRUCTION ||
    value.requiresFullValidation !== true
  ) {
    throw invalidRepairContext('Repair context has an invalid shape.');
  }
  assertIdentity(value.workflowId, invalidRepairContext, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidRepairContext, 'epoch');
  assertIdentity(value.jobId, invalidRepairContext, 'job ID');
  assertIdentity(value.attemptId, invalidRepairContext, 'attempt ID');
  assertDigest(value.contextDigest, invalidRepairContext, 'context digest');
  assertJsonValue(value.previousOutput, invalidRepairContext);
  assertJsonValue(value.targetSchema, invalidRepairContext);
  if (
    !Array.isArray(value.validationErrors) ||
    value.validationErrors.length < 1 ||
    value.validationErrors.length > 100
  ) {
    throw invalidRepairContext(
      'Repair context requires bounded validation errors.',
    );
  }
  const errors = value.validationErrors as unknown[];
  for (const error of errors) {
    if (
      !isRecord(error) ||
      !hasExactKeys(error, ['path', 'code', 'message']) ||
      typeof error.path !== 'string' ||
      (!JSON_POINTER.test(error.path) && error.path !== '') ||
      typeof error.code !== 'string' ||
      !IDENTITY.test(error.code) ||
      typeof error.message !== 'string' ||
      error.message.trim() !== error.message ||
      error.message.length < 1 ||
      error.message.length > 500
    ) {
      throw invalidRepairContext('Validation error is malformed.');
    }
  }
  if (
    !isSorted(errors as StructuredValidationError[], compareValidationErrors)
  ) {
    throw invalidRepairContext('Validation errors must be sorted canonically.');
  }
  if (Buffer.byteLength(canonicalJson(value)) > MAX_DOCUMENT_BYTES) {
    throw invalidRepairContext('Repair context exceeds its size bound.');
  }
}

function validateRepairBudget(value: unknown): asserts value is RepairBudget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'maxSchemaAttempts',
      'maxSemanticAttempts',
      'maxSameFailureFingerprint',
      'schemaAttempts',
      'semanticAttempts',
      'fingerprints',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'repair-budget.v1'
  ) {
    throw invalidRepairBudget('Repair budget has an invalid shape.');
  }
  assertBoundedInteger(
    value.maxSchemaAttempts,
    1,
    2,
    invalidRepairBudget,
    'schema repair limit',
  );
  assertBoundedInteger(
    value.maxSemanticAttempts,
    1,
    2,
    invalidRepairBudget,
    'semantic repair limit',
  );
  assertBoundedInteger(
    value.maxSameFailureFingerprint,
    1,
    3,
    invalidRepairBudget,
    'failure fingerprint limit',
  );
  assertBoundedInteger(
    value.schemaAttempts,
    0,
    value.maxSchemaAttempts as number,
    invalidRepairBudget,
    'schema repair count',
  );
  assertBoundedInteger(
    value.semanticAttempts,
    0,
    value.maxSemanticAttempts as number,
    invalidRepairBudget,
    'semantic repair count',
  );
  if (!Array.isArray(value.fingerprints) || value.fingerprints.length > 16) {
    throw invalidRepairBudget('Repair fingerprints are invalid.');
  }
  const fingerprints = value.fingerprints as unknown[];
  let previous = '';
  let total = 0;
  for (const item of fingerprints) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['fingerprint', 'count']) ||
      typeof item.fingerprint !== 'string'
    ) {
      throw invalidRepairBudget('Repair fingerprint entry is malformed.');
    }
    assertFingerprint(item.fingerprint);
    assertBoundedInteger(
      item.count,
      1,
      value.maxSameFailureFingerprint as number,
      invalidRepairBudget,
      'fingerprint count',
    );
    if (item.fingerprint <= previous) {
      throw invalidRepairBudget(
        'Repair fingerprints must be sorted and unique.',
      );
    }
    previous = item.fingerprint;
    total += item.count as number;
  }
  if (
    total !==
    (value.schemaAttempts as number) + (value.semanticAttempts as number)
  ) {
    throw invalidRepairBudget('Repair fingerprint counts do not match usage.');
  }
}

function validateContextManifest(
  value: unknown,
): asserts value is ContextManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'epoch',
      'contractVersion',
      'baselineDigest',
      'intentDigest',
      'termSetDigest',
      'planningSnapshotDigest',
      'contextDigest',
      'items',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'epoch-context-manifest'
  ) {
    throw invalidContextManifest('Context manifest has an invalid shape.');
  }
  assertIdentity(value.workflowId, invalidContextManifest, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidContextManifest, 'epoch');
  assertPositiveInteger(
    value.contractVersion,
    invalidContextManifest,
    'contract version',
  );
  for (const [label, itemDigest] of [
    ['baseline digest', value.baselineDigest],
    ['intent digest', value.intentDigest],
    ['term set digest', value.termSetDigest],
    ['planning snapshot digest', value.planningSnapshotDigest],
    ['context digest', value.contextDigest],
  ] as const) {
    assertDigest(itemDigest, invalidContextManifest, label);
  }
  if (!Array.isArray(value.items) || value.items.length > 256) {
    throw invalidContextManifest('Context manifest item list is invalid.');
  }
  let previous = '';
  for (const item of value.items as unknown[]) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['identity', 'digest']) ||
      typeof item.identity !== 'string'
    ) {
      throw invalidContextManifest('Context manifest item is malformed.');
    }
    assertIdentity(
      item.identity,
      invalidContextManifest,
      'context item identity',
    );
    assertDigest(item.digest, invalidContextManifest, 'context item digest');
    if (item.identity <= previous) {
      throw invalidContextManifest(
        'Context manifest items must be sorted and unique.',
      );
    }
    previous = item.identity;
  }
  const expected = digest(
    canonicalJson({
      workflowId: value.workflowId,
      epoch: value.epoch,
      contractVersion: value.contractVersion,
      baselineDigest: value.baselineDigest,
      intentDigest: value.intentDigest,
      termSetDigest: value.termSetDigest,
      planningSnapshotDigest: value.planningSnapshotDigest,
      items: value.items,
    }),
  );
  if (value.contextDigest !== expected) {
    throw invalidContextManifest(
      'Context digest does not bind every semantic input and manifest identity.',
    );
  }
}

function validateWorkflowContextState(
  value: unknown,
): asserts value is WorkflowContextState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'workflowId',
      'currentEpoch',
      'contractVersion',
      'contextDigest',
      'snapshotDigest',
      'status',
      'checkpoint',
      'blocker',
    ])
  ) {
    throw invalidEpochTransition(
      'Workflow context state has an invalid shape.',
    );
  }
  assertIdentity(value.workflowId, invalidEpochTransition, 'workflow ID');
  assertPositiveInteger(
    value.currentEpoch,
    invalidEpochTransition,
    'current epoch',
  );
  assertPositiveInteger(
    value.contractVersion,
    invalidEpochTransition,
    'contract version',
  );
  assertDigest(value.contextDigest, invalidEpochTransition, 'context digest');
  assertDigest(value.snapshotDigest, invalidEpochTransition, 'snapshot digest');
  assertIdentity(value.checkpoint, invalidEpochTransition, 'checkpoint');
  if (
    !['active', 'completed', 'cancelled', 'superseded'].includes(
      String(value.status),
    )
  ) {
    throw invalidEpochTransition('Workflow status is invalid.');
  }
  if (value.blocker !== null) {
    if (
      !isRecord(value.blocker) ||
      !hasExactKeys(value.blocker, ['kind', 'since'])
    ) {
      throw invalidEpochTransition('Workflow blocker is malformed.');
    }
    assertIdentity(value.blocker.kind, invalidEpochTransition, 'blocker kind');
    assertTimestamp(
      value.blocker.since,
      invalidEpochTransition,
      'blocker since',
    );
  }
}

function normalizeEpochCarryForwardManifest(
  value: unknown,
  workflow: WorkflowContextState,
  carriedForwardSummary: readonly string[],
): EpochCarryForwardManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceWorkflow',
      'sourceEpoch',
      'carriedForward',
      'excluded',
    ])
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward manifest has an invalid shape.',
    );
  }
  const manifest = validateEpochCarryForwardManifest({
    schemaVersion: 1,
    kind: 'epoch-carry-forward-manifest',
    ...value,
  });
  if (
    manifest.sourceWorkflow !== workflow.workflowId ||
    manifest.sourceEpoch !== workflow.currentEpoch
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward manifest does not identify the source workflow epoch.',
    );
  }
  if (
    canonicalJson(manifest.carriedForward.map(({ identity }) => identity)) !==
    canonicalJson(carriedForwardSummary)
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward decisions must exactly match the receipt summary.',
    );
  }
  return manifest;
}

function validateEpochCarryForwardManifest(
  value: unknown,
): EpochCarryForwardManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sourceWorkflow',
      'sourceEpoch',
      'carriedForward',
      'excluded',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'epoch-carry-forward-manifest'
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward manifest has an invalid shape.',
    );
  }
  assertIdentity(
    value.sourceWorkflow,
    invalidEpochTransition,
    'carry-forward source workflow',
  );
  assertPositiveInteger(
    value.sourceEpoch,
    invalidEpochTransition,
    'carry-forward source epoch',
  );
  const carriedForward = normalizeEpochCarryForwardDecisions(
    value.carriedForward,
    'carried-forward',
  );
  const excluded = normalizeEpochCarryForwardDecisions(
    value.excluded,
    'excluded',
  );
  const carriedIdentities = new Set(
    carriedForward.map(({ identity }) => identity),
  );
  if (excluded.some(({ identity }) => carriedIdentities.has(identity))) {
    throw invalidEpochTransition(
      'An epoch item cannot be both carried forward and excluded.',
    );
  }
  return {
    schemaVersion: 1,
    kind: 'epoch-carry-forward-manifest',
    sourceWorkflow: value.sourceWorkflow as string,
    sourceEpoch: value.sourceEpoch as number,
    carriedForward,
    excluded,
  };
}

function normalizeEpochCarryForwardDecisions(
  value: unknown,
  label: string,
): EpochCarryForwardDecision[] {
  if (!Array.isArray(value)) {
    throw invalidEpochTransition(`${label} decisions must be an array.`);
  }
  const decisions = value.map((decision) => {
    if (
      !isRecord(decision) ||
      !hasExactKeys(decision, ['identity', 'reason'])
    ) {
      throw invalidEpochTransition(`${label} decision is malformed.`);
    }
    assertIdentity(
      decision.identity,
      invalidEpochTransition,
      `${label} identity`,
    );
    assertReason(decision.reason, invalidEpochTransition, `${label} reason`);
    return {
      identity: decision.identity as string,
      reason: decision.reason as string,
    };
  });
  decisions.sort((left, right) => left.identity.localeCompare(right.identity));
  if (
    decisions.some(
      ({ identity }, index) =>
        index > 0 && identity === decisions[index - 1]!.identity,
    )
  ) {
    throw invalidEpochTransition(`${label} decisions contain duplicates.`);
  }
  return decisions;
}

function assertEpochCarryForwardSourceMembership(
  manifest: EpochCarryForwardManifest,
  sourceManifest: ContextManifest,
  nextManifest: ContextManifest,
): void {
  if (
    manifest.sourceWorkflow !== sourceManifest.workflowId ||
    manifest.sourceEpoch !== sourceManifest.epoch
  ) {
    throw invalidEpochTransition(
      'Carry-forward decisions do not match the stored source manifest.',
    );
  }
  const sourceIdentities = new Set(
    sourceManifest.items.map(({ identity }) => identity),
  );
  const decidedIdentities = [...manifest.carriedForward, ...manifest.excluded]
    .map(({ identity }) => identity)
    .sort();
  if (decidedIdentities.some((identity) => !sourceIdentities.has(identity))) {
    throw invalidEpochTransition(
      'Every carry-forward decision must identify an item in the source manifest.',
    );
  }
  if (
    canonicalJson(decidedIdentities) !==
    canonicalJson([...sourceIdentities].sort())
  ) {
    throw invalidEpochTransition(
      'Every source manifest item must have a carry-forward decision.',
    );
  }
  const sourceDigests = new Map(
    sourceManifest.items.map(({ identity, digest }) => [identity, digest]),
  );
  const nextDigests = new Map(
    nextManifest.items.map(({ identity, digest }) => [identity, digest]),
  );
  if (
    manifest.carriedForward.some(
      ({ identity }) =>
        nextDigests.get(identity) !== sourceDigests.get(identity),
    )
  ) {
    throw invalidEpochTransition(
      'Every carried-forward item must retain its exact source digest in the next manifest.',
    );
  }
  if (
    manifest.excluded.some(
      ({ identity }) =>
        nextDigests.get(identity) === sourceDigests.get(identity),
    )
  ) {
    throw invalidEpochTransition(
      'An excluded source item cannot remain unchanged in the next manifest.',
    );
  }
}

function validateEpochTransitionReceipt(
  value: unknown,
): asserts value is EpochTransitionReceipt {
  const commonKeys = [
    'schemaVersion',
    'kind',
    'workflowId',
    'fromEpoch',
    'toEpoch',
    'fromContractVersion',
    'toContractVersion',
    'reason',
    'restartFrom',
    'carriedForward',
    'invalidated',
    'previousContextDigest',
    'newContextDigest',
    'verification',
    'createdAt',
  ];
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !hasExactKeys(
      value,
      value.schemaVersion === 1
        ? commonKeys
        : [...commonKeys, 'carryForwardManifest'],
    ) ||
    value.kind !== 'epoch-transition'
  ) {
    throw invalidEpochTransition('Transition receipt has an invalid shape.');
  }
  assertIdentity(value.workflowId, invalidEpochTransition, 'workflow ID');
  assertPositiveInteger(value.fromEpoch, invalidEpochTransition, 'from epoch');
  if (value.toEpoch !== (value.fromEpoch as number) + 1) {
    throw invalidEpochTransition(
      'Transition receipt must advance exactly one epoch.',
    );
  }
  assertPositiveInteger(
    value.fromContractVersion,
    invalidEpochTransition,
    'from contract version',
  );
  assertPositiveInteger(
    value.toContractVersion,
    invalidEpochTransition,
    'to contract version',
  );
  assertReason(value.reason, invalidEpochTransition, 'rollover reason');
  assertIdentity(
    value.restartFrom,
    invalidEpochTransition,
    'restart checkpoint',
  );
  sortedUniqueIdentities(
    value.carriedForward,
    invalidEpochTransition,
    'carried-forward identity',
    true,
  );
  if (value.schemaVersion === 2) {
    const manifest = validateEpochCarryForwardManifest(
      value.carryForwardManifest,
    );
    if (
      manifest.sourceWorkflow !== value.workflowId ||
      manifest.sourceEpoch !== value.fromEpoch ||
      canonicalJson(manifest.carriedForward.map(({ identity }) => identity)) !==
        canonicalJson(value.carriedForward)
    ) {
      throw invalidEpochTransition(
        'Transition carry-forward decisions do not match the receipt summary.',
      );
    }
  }
  sortedUniqueIdentities(
    value.invalidated,
    invalidEpochTransition,
    'invalidated stage',
    true,
  );
  assertDigest(
    value.previousContextDigest,
    invalidEpochTransition,
    'previous context digest',
  );
  assertDigest(
    value.newContextDigest,
    invalidEpochTransition,
    'new context digest',
  );
  if (value.previousContextDigest === value.newContextDigest) {
    throw invalidEpochTransition(
      'Epoch rollover must change the context digest.',
    );
  }
  validateEpochVerification(value.verification);
  assertTimestamp(value.createdAt, invalidEpochTransition, 'createdAt');
}

function validateEpochVerification(
  value: unknown,
): EpochTransitionVerification | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasKeysEither(value, [
      ['check', 'result'],
      ['check', 'result', 'reportDigest'],
    ]) ||
    typeof value.check !== 'string' ||
    !IDENTITY.test(value.check) ||
    (value.result !== 'passed' && value.result !== 'failed') ||
    (value.reportDigest !== undefined &&
      !SHA256.test(String(value.reportDigest)))
  ) {
    throw invalidEpochTransition('Transition verification is malformed.');
  }
  return {
    check: value.check,
    result: value.result,
    ...(value.reportDigest === undefined
      ? {}
      : { reportDigest: value.reportDigest as string }),
  };
}

function validateEvidenceRetentionRecord(
  value: unknown,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): asserts value is EvidenceRetentionRecord {
  validateRetentionPolicy(policy);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'evidenceId',
      'itemIdentity',
      'workflowId',
      'epoch',
      'evidenceClass',
      'digest',
      'retention',
      'createdAt',
      'expiresAt',
      'pin',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'evidence-retention'
  ) {
    throw invalidRetentionRecord('Retention record has an invalid shape.');
  }
  assertIdentity(value.evidenceId, invalidRetentionRecord, 'evidence ID');
  if (value.itemIdentity !== null) {
    assertIdentity(value.itemIdentity, invalidRetentionRecord, 'item identity');
  }
  assertIdentity(value.workflowId, invalidRetentionRecord, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidRetentionRecord, 'epoch');
  if (
    !['raw', 'derived', 'manifest-item'].includes(String(value.evidenceClass))
  ) {
    throw invalidRetentionRecord('Evidence class is invalid.');
  }
  assertDigest(value.digest, invalidRetentionRecord, 'evidence digest');
  if (!['active', 'expiring', 'pinned'].includes(String(value.retention))) {
    throw invalidRetentionRecord('Retention state is invalid.');
  }
  const createdAt = assertTimestamp(
    value.createdAt,
    invalidRetentionRecord,
    'createdAt',
  );
  if (value.retention === 'expiring') {
    const expiresAt = assertTimestamp(
      value.expiresAt,
      invalidRetentionRecord,
      'expiresAt',
    );
    if (
      value.pin !== null ||
      new Date(expiresAt).getTime() <= new Date(createdAt).getTime() ||
      new Date(expiresAt).getTime() - new Date(createdAt).getTime() >
        policy.maxExpiringTtlDays * 86_400_000
    ) {
      throw invalidRetentionRecord(
        'Expiring evidence must have a bounded TTL.',
      );
    }
  } else if (value.expiresAt !== null) {
    throw invalidRetentionRecord('Only expiring evidence may have expiresAt.');
  }
  if (value.retention === 'pinned') {
    if (
      !isRecord(value.pin) ||
      !hasExactKeys(value.pin, ['actor', 'reason', 'pinnedAt'])
    ) {
      throw invalidRetentionRecord(
        'Pinned evidence requires a human pin record.',
      );
    }
    assertIdentity(value.pin.actor, invalidRetentionRecord, 'pin actor');
    assertReason(value.pin.reason, invalidRetentionRecord, 'pin reason');
    assertTimestamp(value.pin.pinnedAt, invalidRetentionRecord, 'pinnedAt');
  } else if (value.pin !== null) {
    throw invalidRetentionRecord(
      'Unpinned evidence cannot carry pin metadata.',
    );
  }
}

function validateRetentionPolicy(
  value: unknown,
): asserts value is RetentionPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'previousEpochTtlDays',
      'maxExpiringTtlDays',
      'transitionReceiptTtlDays',
      'maxFullTransitionReceipts',
      'maxTransitionReceiptStubs',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw invalidRetentionPolicy('Retention policy has an invalid shape.');
  }
  assertBoundedInteger(
    value.previousEpochTtlDays,
    1,
    30,
    invalidRetentionPolicy,
    'previous epoch TTL',
  );
  assertBoundedInteger(
    value.maxExpiringTtlDays,
    value.previousEpochTtlDays as number,
    90,
    invalidRetentionPolicy,
    'maximum evidence TTL',
  );
  assertBoundedInteger(
    value.transitionReceiptTtlDays,
    1,
    90,
    invalidRetentionPolicy,
    'transition receipt TTL',
  );
  assertBoundedInteger(
    value.maxFullTransitionReceipts,
    1,
    20,
    invalidRetentionPolicy,
    'full transition receipt count',
  );
  assertBoundedInteger(
    value.maxTransitionReceiptStubs,
    0,
    200,
    invalidRetentionPolicy,
    'transition receipt stub count',
  );
}

function validateEpochTransitionStub(
  value: unknown,
): asserts value is EpochTransitionStub {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'fromEpoch',
      'toEpoch',
      'prunedAt',
      'pruningPolicyVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'epoch-transition-stub'
  ) {
    throw invalidRetentionRecord('Transition receipt stub is malformed.');
  }
  assertIdentity(value.workflowId, invalidRetentionRecord, 'workflow ID');
  assertPositiveInteger(value.fromEpoch, invalidRetentionRecord, 'from epoch');
  if (value.toEpoch !== (value.fromEpoch as number) + 1) {
    throw invalidRetentionRecord('Transition receipt stub epochs are invalid.');
  }
  assertTimestamp(value.prunedAt, invalidRetentionRecord, 'prunedAt');
  assertPositiveInteger(
    value.pruningPolicyVersion,
    invalidRetentionRecord,
    'pruning policy version',
  );
}

function canonicalGrantRecord(record: ExecutionBudgetGrantRecord): string {
  validateGrantRecord(record);
  return `${canonicalJson(record)}\n`;
}

function validateGrantRecord(
  value: unknown,
): asserts value is ExecutionBudgetGrantRecord {
  const legacyKeys = [
    'schemaVersion',
    'state',
    'envelopeDigest',
    'envelope',
    'remainingUses',
    'consumedAttemptIds',
    'receipts',
  ];
  const currentKeys = [...legacyKeys, 'revokedAt', 'revocationReason'];
  if (
    !isRecord(value) ||
    !(
      (value.schemaVersion === 1 && hasExactKeys(value, legacyKeys)) ||
      ((value.schemaVersion === 2 || value.schemaVersion === 3) &&
        hasExactKeys(value, currentKeys))
    ) ||
    !['active', 'consumed', 'revoked'].includes(String(value.state)) ||
    (value.schemaVersion === 1 && value.state === 'revoked')
  ) {
    throw unsafeGrantStore();
  }
  validateExecutionBudgetGrantEnvelope(value.envelope);
  assertDigest(value.envelopeDigest, unsafeGrantStore, 'envelope digest');
  if (
    value.envelopeDigest !==
    digest(canonicalExecutionBudgetGrantEnvelope(value.envelope))
  ) {
    throw unsafeGrantStore();
  }
  const payload = value.envelope.payload;
  if (value.schemaVersion === 3 && payload.mandateBinding === undefined) {
    throw unsafeGrantStore();
  }
  assertBoundedInteger(
    value.remainingUses,
    0,
    payload.maxUses,
    unsafeGrantStore,
    'remaining uses',
  );
  if (
    !Array.isArray(value.consumedAttemptIds) ||
    !Array.isArray(value.receipts) ||
    value.consumedAttemptIds.length !== value.receipts.length ||
    value.receipts.length + (value.remainingUses as number) !==
      payload.maxUses ||
    (value.state === 'active' && value.remainingUses === 0) ||
    (value.state === 'consumed' && value.remainingUses !== 0) ||
    (value.state === 'revoked' && value.remainingUses === 0)
  ) {
    throw unsafeGrantStore();
  }
  if (value.schemaVersion === 2 || value.schemaVersion === 3) {
    if (value.state === 'revoked') {
      assertTimestamp(value.revokedAt, unsafeGrantStore, 'revokedAt');
      assertReason(
        value.revocationReason,
        unsafeGrantStore,
        'revocation reason',
      );
      const latestAuthorityAt =
        value.receipts.at(-1)?.consumedAt ?? payload.issuedAt;
      if (
        new Date(value.revokedAt as string).getTime() <
        new Date(latestAuthorityAt).getTime()
      ) {
        throw unsafeGrantStore();
      }
    } else if (value.revokedAt !== null || value.revocationReason !== null) {
      throw unsafeGrantStore();
    }
  }
  const attemptIds = new Set<string>();
  for (let index = 0; index < value.receipts.length; index += 1) {
    const receipt = value.receipts[index];
    validateExecutionBudgetConsumeReceipt(receipt, payload);
    if (
      receipt.useNumber !== index + 1 ||
      receipt.remainingUses !== payload.maxUses - index - 1 ||
      value.consumedAttemptIds[index] !== receipt.attemptId ||
      attemptIds.has(receipt.attemptId)
    ) {
      throw unsafeGrantStore();
    }
    attemptIds.add(receipt.attemptId);
  }
}

function readGrantRecord(filePath: string): ExecutionBudgetGrantRecord {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size > MAX_DOCUMENT_BYTES
  ) {
    throw unsafeGrantStore();
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    const value = parseDocument(raw);
    validateGrantRecord(value);
    if (canonicalGrantRecord(value) !== raw) throw unsafeGrantStore();
    return value;
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_BUDGET_GRANT_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeGrantStore();
  }
}

function readGrantRecordRequired(filePath: string): ExecutionBudgetGrantRecord {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_NOT_FOUND',
      'Execution-budget grant does not exist or is not available.',
      ExitCode.staleState,
    );
  }
  return readGrantRecord(filePath);
}

function ensureExecutionBudgetGrantStore(storeRoot: string): {
  root: string;
  grants: string;
  pending: string;
  locks: string;
} {
  if (typeof storeRoot !== 'string' || storeRoot.length < 1) {
    throw unsafeGrantStore();
  }
  const root = path.resolve(storeRoot);
  ensurePlainDirectory(root, false);
  const grants = path.join(root, 'execution-budget-grants');
  const pending = path.join(root, 'execution-budget-grants-pending-audit');
  const locks = path.join(root, 'execution-budget-locks');
  ensurePlainDirectory(grants, true);
  ensurePlainDirectory(pending, true);
  ensurePlainDirectory(locks, true);
  return { root, grants, pending, locks };
}

function ensurePlainDirectory(directory: string, create: boolean): void {
  if (create) {
    try {
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
  }
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) throw unsafeGrantStore();
}

function withExecutionGrantLock<T>(
  paths: { locks: string },
  grantId: string,
  operation: () => T,
): T {
  const lockPath = path.join(paths.locks, `${grantId}.lock`);
  let descriptor: number | undefined;
  let ownsLock = false;
  let result: T | undefined;
  let operationError: unknown;
  try {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
      fs.writeFileSync(
        descriptor,
        `${canonicalJson({ grantId, pid: process.pid })}\n`,
        'utf8',
      );
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'EXECUTION_BUDGET_GRANT_OPERATION_CONFLICT',
          `Execution-budget grant ${grantId} already has an operation in progress.`,
          ExitCode.conflict,
        );
      }
      throw error;
    }
    result = operation();
  } catch (error) {
    operationError = error;
  }
  if (descriptor !== undefined) fs.closeSync(descriptor);
  let releaseError: unknown;
  if (ownsLock) {
    try {
      fs.unlinkSync(lockPath);
      fsyncDirectory(paths.locks);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') releaseError = error;
    }
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, filePath);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

// Durable-governance callers hold the workflow lock, so a no-overwrite check
// followed by rename avoids the hard-link alias window of the cross-process
// grant publisher while preserving atomic visibility to unlocked readers.
function createDurablePrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
      const error = new Error(`File ${filePath} already exists.`);
      Object.assign(error, { code: 'EEXIST' });
      throw error;
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function unlinkExactPrivateFile(filePath: string, expected: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    fs.readFileSync(filePath, 'utf8') !== expected
  ) {
    throw unsafeGrantStore();
  }
  fs.unlinkSync(filePath);
  fsyncDirectory(path.dirname(filePath));
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function cloneChange(
  change: ExecutionBudgetChange,
  invalid: (message: string) => WorkflowError,
): ExecutionBudgetChange {
  return {
    path: change.path,
    from: cloneJson(change.from, invalid),
    to: cloneJson(change.to, invalid),
  };
}

function sortChanges(
  changes: ExecutionBudgetChange[],
  invalid: (message: string) => WorkflowError,
): ExecutionBudgetChange[] {
  if (!Array.isArray(changes)) return changes;
  return changes
    .map((change) => cloneChange(change, invalid))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function validateChanges(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): asserts value is ExecutionBudgetChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw invalid('Execution-budget changes must be a non-empty bounded list.');
  }
  let previous = '';
  for (const change of value) {
    if (
      !isRecord(change) ||
      !hasExactKeys(change, ['path', 'from', 'to']) ||
      typeof change.path !== 'string' ||
      !JSON_POINTER.test(change.path) ||
      change.path <= previous
    ) {
      throw invalid(
        'Execution-budget changes must use sorted unique JSON-pointer paths.',
      );
    }
    assertJsonValue(change.from, invalid);
    assertJsonValue(change.to, invalid);
    if (canonicalJson(change.from) === canonicalJson(change.to)) {
      throw invalid('Execution-budget change must alter its value.');
    }
    previous = change.path;
  }
}

function cloneJson<T extends JsonValue>(
  value: T,
  invalid: (message: string) => WorkflowError = invalidRepairContext,
): T {
  assertJsonValue(value, invalid);
  return JSON.parse(canonicalJson(value)) as T;
}

function assertJsonValue(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): asserts value is JsonValue {
  try {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 262_144) {
      throw invalid('JSON value exceeds its size bound.');
    }
  } catch (error) {
    if (isWorkflowError(error) && error.code !== 'CANONICAL_JSON_INVALID') {
      throw error;
    }
    throw invalid('Value is not finite JSON data.');
  }
}

function compareValidationErrors(
  left: StructuredValidationError,
  right: StructuredValidationError,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function rejectedResult(reasonCode: string): AttemptResultEligibility {
  return {
    eligible: false,
    classification: 'rejected',
    reasonCode,
    doNotMerge: true,
  };
}

function staleResult(reasonCode: string): AttemptResultEligibility {
  return {
    eligible: false,
    classification: 'stale',
    reasonCode,
    doNotMerge: true,
  };
}

function cloneRetentionRecord(
  record: EvidenceRetentionRecord,
): EvidenceRetentionRecord {
  return {
    ...record,
    pin: record.pin === null ? null : { ...record.pin },
  };
}

function transitionKey(
  value: EpochTransitionReceipt | EpochTransitionStub,
): string {
  return `${value.workflowId}:${value.fromEpoch}:${value.toEpoch}`;
}

function sortedUniqueIdentities(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
  assertAlreadySorted = false,
): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw invalid(`${label} list is invalid.`);
  }
  const identities = value.map((item) => {
    assertIdentity(item, invalid, label);
    return item;
  });
  const sorted = [...identities].sort();
  if (
    new Set(identities).size !== identities.length ||
    (assertAlreadySorted &&
      identities.some((identity, index) => identity !== sorted[index]))
  ) {
    throw invalid(`${label} list must be sorted and unique.`);
  }
  return sorted;
}

function isSorted<T>(
  value: T[],
  compare: (left: T, right: T) => number,
): boolean {
  return value.every(
    (item, index) => index === 0 || compare(value[index - 1]!, item) < 0,
  );
}

function parseDocument(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) {
    throw new Error('document size');
  }
  return JSON.parse(raw) as unknown;
}

function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactDate(value: Date, errorCode: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(errorCode, 'Timestamp is invalid.', ExitCode.usage);
  }
  return value.toISOString();
}

function assertTimestamp(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): string {
  if (typeof value !== 'string') throw invalid(`${label} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalid(`${label} must be an exact ISO timestamp.`);
  }
  return value;
}

function assertUuid(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw invalid('Identifier must be a lower-case UUID v4.');
  }
  return value;
}

function assertIdentity(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
}

function assertDigest(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw invalid(`${label} is not a sha256 digest.`);
  }
}

function assertPositiveInteger(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is number {
  assertBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, invalid, label);
}

function assertBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw invalid(`${label} is outside its bound.`);
  }
}

function assertReason(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 16 ||
    value.length > 1_000 ||
    value.includes('\0')
  ) {
    throw invalid(`${label} must be a concrete bounded explanation.`);
  }
}

function assertExecutionGrantMandateBinding(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): TaskMandateBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
    typeof value.mandateId !== 'string' ||
    !UUID_V4.test(value.mandateId) ||
    typeof value.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot ||
    value.externalAuditRoot.length > 4_096
  ) {
    throw invalid('Task Mandate binding is malformed.');
  }
  return structuredClone(value) as TaskMandateBinding;
}

function assertExecutionBudgetGrantAuditContext(
  value: unknown,
): ExecutionBudgetGrantAuditContext {
  if (
    !isRecord(value) ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    path.normalize(value.repositoryRoot) !== value.repositoryRoot ||
    typeof value.repositoryIdentity !== 'string' ||
    value.repositoryIdentity.length < 1 ||
    (value.serviceHooks !== undefined && !isRecord(value.serviceHooks)) ||
    (value.actor !== undefined &&
      (!isRecord(value.actor) ||
        !hasExactKeys(value.actor, ['kind', 'identity']) ||
        !['agent', 'engine', 'human'].includes(String(value.actor.kind)) ||
        typeof value.actor.identity !== 'string' ||
        !IDENTITY.test(value.actor.identity))) ||
    (value.onRecord !== undefined && typeof value.onRecord !== 'function')
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_AUDIT_REQUIRED',
      'Execution-budget authority requires an exact repository audit context.',
      ExitCode.guard,
    );
  }
  return value as ExecutionBudgetGrantAuditContext;
}

function assertFingerprint(value: string): void {
  if (!IDENTITY.test(value)) {
    throw invalidRepairBudget('Failure fingerprint is invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length &&
    observed.every((key, index) => key === expected[index])
  );
}

function hasKeysEither(
  value: Record<string, unknown>,
  variants: string[][],
): boolean {
  return variants.some((keys) => hasExactKeys(value, keys));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isWorkflowError(error: unknown): error is WorkflowError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    'exitCode' in error
  );
}

function normalizeInvalid(
  error: unknown,
  code: string,
  message: string,
): WorkflowError {
  if (isWorkflowError(error) && error.code === code) return error;
  return workflowError(code, message, ExitCode.usage);
}

function invalidGrantRequest(message: string): WorkflowError {
  return workflowError(
    'EXECUTION_GRANT_REQUEST_INVALID',
    message,
    ExitCode.usage,
  );
}

function invalidGrant(message: string): WorkflowError {
  return workflowError(
    'EXECUTION_BUDGET_GRANT_INVALID',
    message,
    ExitCode.usage,
  );
}

function unsafeGrantStore(): WorkflowError {
  return workflowError(
    'EXECUTION_BUDGET_GRANT_STORE_UNSAFE',
    'Execution-budget grant store is missing, malformed, or unsafe.',
    ExitCode.staleState,
  );
}

function invalidRepairContext(message: string): WorkflowError {
  return workflowError('REPAIR_CONTEXT_INVALID', message, ExitCode.usage);
}

function invalidRepairBudget(message: string): WorkflowError {
  return workflowError('REPAIR_BUDGET_INVALID', message, ExitCode.usage);
}

function invalidContextManifest(message: string): WorkflowError {
  return workflowError('CONTEXT_MANIFEST_INVALID', message, ExitCode.usage);
}

function invalidDurableContext(message: string): WorkflowError {
  return workflowError('EXECUTION_CONTEXT_INVALID', message, ExitCode.usage);
}

function unsafeDurableGovernanceStore(): WorkflowError {
  return workflowError(
    'EXECUTION_GOVERNANCE_STORE_UNSAFE',
    'Durable execution-governance state is missing, malformed, or unsafe.',
    ExitCode.staleState,
  );
}

function invalidEpochTransition(message: string): WorkflowError {
  return workflowError('EPOCH_TRANSITION_INVALID', message, ExitCode.usage);
}

function invalidRetentionRecord(message: string): WorkflowError {
  return workflowError('RETENTION_RECORD_INVALID', message, ExitCode.usage);
}

function invalidRetentionPolicy(message: string): WorkflowError {
  return workflowError('RETENTION_POLICY_INVALID', message, ExitCode.usage);
}
