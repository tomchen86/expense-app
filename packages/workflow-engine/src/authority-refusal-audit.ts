import crypto from 'node:crypto';

import {
  scanAuthorityAuditLedger,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from './authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  type AuthorityAuditActor,
  type AuthorityAuditRecordedEvent,
  type AuthorityAuditServiceHooks,
} from './authority-audit-service.ts';
import { canonicalJson } from './canonical-json.ts';
import { WorkflowError } from './errors.ts';

export type AuthorityRefusalAuditBinding = Readonly<{
  scope: AuthorityAuditLedgerScope;
  family: string;
  operation: string;
  subjectId: string;
  actor: AuthorityAuditActor;
  taskId: string | null;
  changeId: string | null;
  workflowId: string | null;
  grantDigest: Sha256Digest | null;
  candidateBundleDigest?: Sha256Digest | null;
  bindingDigest: Sha256Digest;
  refusalIdentity: Readonly<Record<string, unknown>>;
}>;

export type AuthorityRefusalAuditOptions = Readonly<{
  now?: Date;
  serviceHooks?: AuthorityAuditServiceHooks;
  onRecord?: (entry: AuthorityAuditRecordedEvent) => void;
}>;

/**
 * Audit one refusal only after a caller has independently verified the
 * durable authority binding used to construct `binding`. The idempotency key
 * excludes wall-clock time; retry after an audit-only crash recovers the first
 * durable occurrence and reproduces the exact event bytes.
 */
export function recordAuthorityRefusal(
  binding: AuthorityRefusalAuditBinding,
  error: WorkflowError,
  options: AuthorityRefusalAuditOptions = {},
): AuthorityAuditRecordedEvent {
  const identity = {
    schemaVersion: 1,
    kind: 'authority-refusal-audit-identity.v1',
    family: binding.family,
    operation: binding.operation,
    subjectId: binding.subjectId,
    actor: binding.actor,
    taskId: binding.taskId,
    changeId: binding.changeId,
    workflowId: binding.workflowId,
    grantDigest: binding.grantDigest,
    bindingDigest: binding.bindingDigest,
    refusalIdentity: binding.refusalIdentity,
    errorCode: error.code,
  };
  const idempotencyKey = digest(canonicalJson(identity));
  const durableOccurrence = scanAuthorityAuditLedger(
    binding.scope,
  ).records.find(({ record }) => record.idempotencyKey === idempotencyKey)
    ?.record.occurredAt;
  const occurredAt =
    durableOccurrence ?? exactDate(options.now ?? new Date()).toISOString();
  const outcomeDigest = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'authority-refusal-audit-outcome.v1',
      identity,
      result: 'failed',
    }),
  );
  const entry = recordAuthorityAuditEvent(
    binding.scope,
    {
      eventType: 'error',
      occurredAt,
      idempotencyKey,
      actor: binding.actor,
      taskId: binding.taskId,
      changeId: binding.changeId,
      workflowId: binding.workflowId,
      grantDigest: binding.grantDigest,
      candidateBundleDigest: binding.candidateBundleDigest ?? null,
      prestateDigest: binding.bindingDigest,
      poststateDigest: null,
      command: {
        name: binding.operation,
        argvDigest: digest(
          canonicalJson({
            family: binding.family,
            operation: binding.operation,
            subjectId: binding.subjectId,
            refusalIdentity: binding.refusalIdentity,
          }),
        ),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'failed',
      outcomeDigest,
      errorCode: error.code,
    },
    options.serviceHooks,
  );
  options.onRecord?.(entry);
  return entry;
}

export function withAuthorityRefusalAudit<T>(
  binding: AuthorityRefusalAuditBinding,
  options: AuthorityRefusalAuditOptions,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.code.startsWith('AUTHORITY_AUDIT_')
    ) {
      throw error;
    }
    recordAuthorityRefusal(binding, error, options);
    throw error;
  }
}

export function authorityRefusalDigest(value: unknown): Sha256Digest {
  return digest(canonicalJson(value));
}

function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('Authority refusal audit time is invalid.');
  }
  return date;
}
