import crypto from 'node:crypto';
import path from 'node:path';

import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  type AuthorityAuditEventInput,
  type AuthorityAuditRecordedEvent,
  type AuthorityAuditServiceHooks,
} from './authority-audit-service.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ExternalEffectAuditEvent,
  Sha256Digest,
} from '../../modules/authority/external-effect-grant.ts';

export type ExternalEffectAuthorityAuditOptions = {
  serviceHooks?: AuthorityAuditServiceHooks;
  onRecord?: (
    event: ExternalEffectAuditEvent,
    entry: AuthorityAuditRecordedEvent,
  ) => void;
};

/**
 * Production bridge from one task-correlated External Effect event to the
 * repository-external authority audit service. Scope comes only from the
 * signed event; callers cannot replace the durable append with an observer.
 */
export function appendExternalEffectAuthorityAudit(
  repositoryRootValue: string,
  event: ExternalEffectAuditEvent,
  options: ExternalEffectAuthorityAuditOptions = {},
): AuthorityAuditRecordedEvent {
  const externalAuditRoot = assertAbsolute(event.externalAuditRoot);
  const repositoryRoot = assertAbsolute(repositoryRootValue);
  const repositoryId = deriveAuthorityAuditRepositoryId(event.repositoryId);
  const mapped = mapEvent(event);
  const entry = recordAuthorityAuditEvent(
    { externalAuditRoot, repositoryRoot, repositoryId },
    {
      eventType: mapped.eventType,
      occurredAt: event.occurredAt,
      idempotencyKey: event.eventId,
      actor:
        event.resolver === null
          ? { kind: 'engine', identity: 'workflow-engine' }
          : { kind: 'human', identity: event.resolver },
      taskId: event.taskId,
      changeId: event.changeId,
      workflowId: event.changeId,
      grantDigest: event.grantDigest,
      candidateBundleDigest: null,
      prestateDigest: event.prestateDigest,
      poststateDigest: event.poststateDigest,
      command: {
        name: commandName(event.eventType),
        argvDigest: digest(
          canonicalJson({
            grantId: event.grantId,
            transactionId: event.transactionId,
            eventType: event.eventType,
          }),
        ),
      },
      providerInvocation: null,
      externalEffect: {
        kind: event.effectKind,
        targetDigest: event.targetDigest,
        idempotencyKey: event.effectIdempotencyDigest,
      },
      result: mapped.result,
      outcomeDigest: digest(
        canonicalJson({
          schemaVersion: 1,
          kind: 'external-effect-audit-result.v1',
          changeId: event.changeId,
          taskId: event.taskId,
          mandateId: event.mandateId,
          mandateDigest: event.mandateDigest,
          grantId: event.grantId,
          eventId: event.eventId,
          eventType: event.eventType,
          transactionId: event.transactionId,
          artifactDigest: event.artifactDigest,
          evidenceDigest: event.evidenceDigest,
          resolver: event.resolver,
          result: event.result,
          reason: event.reason,
        }),
      ),
      errorCode: mapped.errorCode,
    },
    options.serviceHooks,
  );
  options.onRecord?.(event, entry);
  return entry;
}

function mapEvent(event: ExternalEffectAuditEvent): {
  eventType: AuthorityAuditEventInput['eventType'];
  result: AuthorityAuditEventInput['result'];
  errorCode: string | null;
} {
  switch (event.eventType) {
    case 'reconciliation-resolved':
      if (event.result === 'reconciled-succeeded') {
        return {
          eventType: 'external-effect',
          result: 'succeeded',
          errorCode: null,
        };
      }
      if (event.result === 'reconciled-rolled-back') {
        return {
          eventType: 'rollback',
          result: 'rolled-back',
          errorCode: null,
        };
      }
      return {
        eventType: 'error',
        result: 'failed',
        errorCode: 'EXTERNAL_EFFECT_RECONCILIATION_FAILED',
      };
    case 'grant-consumed':
      return {
        eventType: 'grant-consume',
        result: 'succeeded',
        errorCode: null,
      };
    case 'grant-revoked':
      return { eventType: 'revoke', result: 'revoked', errorCode: null };
    case 'grant-failed':
    case 'grant-expired':
    case 'manual-reconciliation':
      return {
        eventType: 'error',
        result: 'failed',
        errorCode:
          event.eventType === 'grant-expired'
            ? 'EXTERNAL_EFFECT_GRANT_EXPIRED'
            : event.eventType === 'manual-reconciliation'
              ? 'EXTERNAL_EFFECT_MANUAL_RECONCILIATION'
              : 'EXTERNAL_EFFECT_DISPATCH_FAILED',
      };
    case 'grant-issued':
    case 'grant-reserved':
    case 'dispatch-issued':
    case 'effect-observed':
      return {
        eventType: 'external-effect',
        result: 'recorded',
        errorCode: null,
      };
  }
}

function commandName(eventType: ExternalEffectAuditEvent['eventType']): string {
  return `external-effect.${eventType}`;
}

function assertAbsolute(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_SCOPE_MISMATCH',
      'External effect authority audit paths must be exact and absolute.',
      ExitCode.guard,
    );
  }
  return value;
}

function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
