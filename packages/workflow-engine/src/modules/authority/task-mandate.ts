import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from '../../authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  type AuthorityAuditRecordedEvent,
} from '../../authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../../filesystem-safety.ts';
import {
  discoverRepository,
  isPostApprovalAdmissionFailure,
  runGit,
} from '../../git.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../maintainer-signer.ts';
import {
  isProviderId,
  type ProviderId,
} from '../provider-orchestration/provider-registry.ts';
import { assertChangeId } from '../../paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../session-store.ts';

export const TASK_MANDATE_SIGNATURE_NAMESPACE =
  'HARNESS_TASK_MANDATE_V1' as const;
export const TASK_MANDATE_SIGNATURE_NAMESPACE_V2 =
  'HARNESS_TASK_MANDATE_V2' as const;
export const TASK_MANDATE_INACTIVITY_DAYS = 14;

const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;
const DATA_TYPES = [
  'diff',
  'repository-metadata',
  'source-code',
  'task-intent',
  'test-output',
] as const;
const PAYLOAD_KEYS = [
  'kind',
  'mandateId',
  'changeId',
  'taskId',
  'repositoryId',
  'repositoryOrigin',
  'externalAuditRoot',
  'policyBlob',
  'baseCommit',
  'intent',
  'preparation',
  'authoritativeEffects',
  'controlPlaneMutation',
  'secretScopes',
  'validUntil',
  'auditRequired',
  'issuedAt',
  'signer',
] as const;
const LEGACY_PAYLOAD_KEYS = PAYLOAD_KEYS.filter(
  (key) => key !== 'changeId' && key !== 'externalAuditRoot',
);

export type TaskMandateDataType = (typeof DATA_TYPES)[number];

export type TaskMandateProviderDeclaration = {
  maxInvocations: number;
  maxBudget: number | null;
  dataTypes: TaskMandateDataType[];
  sourceCode: boolean;
  secrets: false;
  retryOnFailure: boolean;
  retryRequiresHuman: boolean;
};

export type TaskMandateRequest = {
  changeId: string;
  taskId: string;
  intent: string;
  providerCalls: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>;
};

export type TaskMandatePayload = {
  kind: 'task-mandate.v2';
  mandateId: string;
  changeId: string;
  taskId: string;
  repositoryId: string;
  repositoryOrigin: string;
  externalAuditRoot: string;
  policyBlob: string;
  baseCommit: string;
  intent: string;
  preparation: {
    repositoryRead: true;
    isolatedRepositoryWrites: true;
    addDeleteRenameFiles: true;
    localCommands: true;
    draftCommits: true;
    candidateAndDesignArtifacts: true;
    providerCalls: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>;
    readOnlyConnectors: true;
  };
  authoritativeEffects: false;
  controlPlaneMutation: false;
  secretScopes: [];
  validUntil: {
    taskClosed: true;
    humanRevokes: true;
    repositoryIdentityChanges: true;
    intentReplaced: true;
    inactivityDays: 14;
  };
  auditRequired: true;
  issuedAt: string;
  signer: string;
};

export type TaskMandateEnvelope = {
  payload: TaskMandatePayload;
  signature: string;
};

type LegacyTaskMandatePayload = Omit<
  TaskMandatePayload,
  'kind' | 'changeId' | 'externalAuditRoot'
> & {
  kind: 'task-mandate.v1';
};

type LegacyTaskMandateEnvelope = {
  payload: LegacyTaskMandatePayload;
  signature: string;
};

type AnyTaskMandateEnvelope = TaskMandateEnvelope | LegacyTaskMandateEnvelope;

export type TaskMandateProviderUsage = {
  invocations: number;
  budget: number;
};

type StoredTaskMandateProviderUsage = TaskMandateProviderUsage & {
  reservations: Array<{
    reservationId: string;
    authorizedAt: string;
    requestDigest: string;
    operationDigest: string;
    executionGrantId?: string;
  }>;
};

export type TaskMandateBinding = {
  schemaVersion: 1;
  mandateTaskId: string;
  mandateId: string;
  mandateDigest: string;
  changeId: string;
  externalAuditRoot: string;
};

type TaskMandateRecord = {
  schemaVersion: 2;
  state: 'active' | 'revoked';
  mandateId: string;
  changeId: string;
  externalAuditRoot: string;
  taskId: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, StoredTaskMandateProviderUsage>>;
  revokedAt: string | null;
  revocationReason: string | null;
  envelope: TaskMandateEnvelope;
};

type LegacyTaskMandateRecord = {
  schemaVersion: 1;
  state: 'active' | 'revoked';
  mandateId: string;
  taskId: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, TaskMandateProviderUsage>>;
  revokedAt: string | null;
  revocationReason: string | null;
  envelope: LegacyTaskMandateEnvelope;
};

type AnyTaskMandateRecord = TaskMandateRecord | LegacyTaskMandateRecord;

export type TaskMandateInspection = {
  mandateId: string;
  changeId?: string;
  externalAuditRoot?: string;
  taskId: string;
  legacyReadOnly: boolean;
  state: 'active' | 'expired' | 'revoked';
  intent: string;
  baseCommit: string;
  signer: string;
  issuedAt: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, TaskMandateProviderUsage>>;
  inactivityDays: 14;
  revokedAt?: string;
  revocationReason?: string;
};

export type TaskMandateOperation =
  | {
      kind:
        | 'repository-read'
        | 'isolated-repository-write'
        | 'add-delete-rename'
        | 'local-command'
        | 'draft-commit'
        | 'candidate-or-design-artifact'
        | 'read-only-connector';
    }
  | {
      kind:
        | 'authoritative-ref-update'
        | 'push'
        | 'deploy'
        | 'secret-scope-expansion'
        | 'irreversible-external-effect'
        | 'live-workflow-state-mutation'
        | 'control-plane-mutation';
    }
  | {
      kind: 'provider-call';
      providerId: ProviderId;
      dataTypes: TaskMandateDataType[];
      sourceCode: boolean;
      secrets: boolean;
      retry: boolean;
      budget: number | null;
    };

export type TaskMandateOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export type TaskMandateOperationOptions = TaskMandateOptions & {
  changeId: string;
};

export type TaskMandateProviderReservationOperation = Omit<
  Extract<TaskMandateOperation, { kind: 'provider-call' }>,
  'kind'
> & {
  requestDigest: string;
  /**
   * A signed execution-budget grant the caller has already validated and
   * consumed for this exact replacement Attempt. The human signature it
   * carries is the consent that lets this one reservation proceed past an
   * exhausted declared budget; the ledger records the grant so the excess is
   * attributed, never silent.
   */
  executionGrant?: { grantId: string };
};

export type TaskMandateProviderReservationAuthorization = {
  authorized: true;
  binding: TaskMandateBinding;
  reservationId: string;
  providerUsage: TaskMandateProviderUsage;
  replay: boolean;
  audit: AuthorityAuditRecordedEvent;
};

export type TaskMandateProviderInvocationAuditInput = {
  providerId: ProviderId;
  invocationId: string;
  requestDigest: string;
  occurredAt: string;
};

export type AuthorizeTaskMandateOptions = TaskMandateOptions & {
  mandateId?: string;
  externalAuditRoot?: string;
};

export type RevokeTaskMandateOptions = TaskMandateOptions & {
  reason: string;
};

export function parseTaskMandateRequest(value: unknown): TaskMandateRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['changeId', 'taskId', 'intent', 'providerCalls']) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.intent !== 'string' ||
    !isRecord(value.providerCalls)
  ) {
    throw mandateInvalid('Task mandate request is malformed.');
  }
  const request: TaskMandateRequest = {
    changeId: assertChangeId(value.changeId),
    taskId: assertTaskMandateTaskId(value.taskId),
    intent: assertIntent(value.intent),
    providerCalls: parseProviderDeclarations(value.providerCalls),
  };
  return request;
}

export function authorizeTaskMandate(
  cwd: string,
  requested: TaskMandateRequest,
  options: AuthorizeTaskMandateOptions = {},
): {
  mandateId: string;
  recordPath: string;
  envelope: TaskMandateEnvelope;
  audit: AuthorityAuditRecordedEvent;
} {
  const request = parseTaskMandateRequest(requested);
  const context = loadTrustContext(cwd);
  const externalAuditRoot = assertExternalAuditRoot(options.externalAuditRoot);
  scanAuthorityAuditLedger({
    externalAuditRoot,
    repositoryRoot: context.repository.repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(
      context.policy.repository.id,
    ),
  });
  const now = exactDate(options.now ?? new Date());
  const mandateId = assertMandateId(options.mandateId ?? crypto.randomUUID());
  const paths = taskMandateStorePaths(context.repository.gitCommonDirectory);
  const existingActive = taskRecordPath(paths.active, request.taskId);
  const existingTerminal = taskRecordPath(paths.terminal, request.taskId);
  if (fs.existsSync(existingActive)) {
    throw workflowError(
      'TASK_MANDATE_EXISTS',
      `Task ${request.taskId} already has an active mandate.`,
      ExitCode.conflict,
    );
  }
  if (fs.existsSync(existingTerminal)) {
    const terminal = parseTaskMandateRecord(readPrivateFile(existingTerminal));
    validateTaskMandateEnvelopeForRepository(
      context.repository.repositoryRoot,
      terminal.envelope,
      options.signer,
    );
  }
  const signer =
    options.signer ??
    createInteractiveSshSigner(
      context.repository.repositoryRoot,
      context.policy,
    );

  signer.assertHumanPresent();
  const identity = signer.identity();
  if (
    !context.policy.trustedSigners.some(({ identity: id }) => id === identity)
  ) {
    throw workflowError(
      'TASK_MANDATE_SIGNER_UNTRUSTED',
      'Task mandate signer is not trusted by the exact base policy.',
      ExitCode.verification,
    );
  }
  const payload: TaskMandatePayload = {
    kind: 'task-mandate.v2',
    mandateId,
    changeId: request.changeId,
    taskId: request.taskId,
    repositoryId: context.policy.repository.id,
    repositoryOrigin: context.policy.repository.origin,
    externalAuditRoot,
    policyBlob: context.policyBlob,
    baseCommit: context.repository.head,
    intent: request.intent,
    preparation: {
      repositoryRead: true,
      isolatedRepositoryWrites: true,
      addDeleteRenameFiles: true,
      localCommands: true,
      draftCommits: true,
      candidateAndDesignArtifacts: true,
      providerCalls: cloneProviderDeclarations(request.providerCalls),
      readOnlyConnectors: true,
    },
    authoritativeEffects: false,
    controlPlaneMutation: false,
    secretScopes: [],
    validUntil: {
      taskClosed: true,
      humanRevokes: true,
      repositoryIdentityChanges: true,
      intentReplaced: true,
      inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    },
    auditRequired: true,
    issuedAt: now.toISOString(),
    signer: identity,
  };
  validateTaskMandatePayload(payload);
  let signature: string;
  try {
    signature = signer.sign(
      canonicalTaskMandatePayload(payload),
      TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
    );
    assertSignature(signature);
    signer.verify(
      canonicalTaskMandatePayload(payload),
      signature,
      identity,
      TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
    );
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature could not be created or verified.',
      ExitCode.verification,
    );
  }
  const envelope = { payload, signature };
  const record: TaskMandateRecord = {
    schemaVersion: 2,
    state: 'active',
    mandateId,
    changeId: request.changeId,
    externalAuditRoot,
    taskId: request.taskId,
    lastActivityAt: now.toISOString(),
    providerUsage: Object.fromEntries(
      Object.keys(request.providerCalls).map((providerId) => [
        providerId,
        { invocations: 0, budget: 0, reservations: [] },
      ]),
    ),
    revokedAt: null,
    revocationReason: null,
    envelope,
  };
  const recordPath = withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      ensureStore(paths);
      assertOwned();
      const active = taskRecordPath(paths.active, request.taskId);
      const terminal = taskRecordPath(paths.terminal, request.taskId);
      if (fs.existsSync(active)) {
        throw workflowError(
          'TASK_MANDATE_EXISTS',
          `Task ${request.taskId} already has an active mandate.`,
          ExitCode.conflict,
        );
      }
      if (fs.existsSync(terminal)) {
        const previous = parseTaskMandateRecord(readPrivateFile(terminal));
        const history = taskHistoryPath(
          paths.history,
          request.taskId,
          previous.mandateId,
        );
        if (fs.existsSync(history)) throw unsafeStore();
        fs.renameSync(terminal, history);
        fsyncDirectory(paths.terminal);
        fsyncDirectory(paths.history);
      }
      createPrivateFileAtomic(active, canonicalTaskMandateRecord(record));
      assertOwned();
      return active;
    },
  );
  const audit = appendTaskMandateAuthorizationAudit(
    context.repository.repositoryRoot,
    record,
    exactDate(options.now ?? new Date()),
  );
  return { mandateId, recordPath, envelope, audit };
}

export function inspectTaskMandate(
  cwd: string,
  requestedTaskId: string,
  options: TaskMandateOptions = {},
): TaskMandateInspection {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  const record = readTaskRecord(paths, taskId);
  validateTaskMandateEnvelopeForRepository(
    repository.repositoryRoot,
    record.envelope,
    options.signer,
  );
  return inspectRecord(record, exactDate(options.now ?? new Date()));
}

export function inspectActiveTaskMandateBinding(
  cwd: string,
  requestedTaskId: string,
  options: TaskMandateOptions = {},
): TaskMandateBinding {
  return withActiveTaskMandateBinding(
    cwd,
    requestedTaskId,
    options,
    (binding) => binding,
  );
}

export function withActiveTaskMandateBinding<T>(
  cwd: string,
  requestedTaskId: string,
  options: TaskMandateOptions,
  operation: (binding: TaskMandateBinding, assertOwned: () => void) => T,
): T {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    assertProductionTaskMandateRecord(record);
    const auditNow = exactDate(options.now ?? new Date());
    assertRecordActive(record, auditNow);
    appendTaskMandateAuthorizationAudit(
      repository.repositoryRoot,
      record,
      auditNow,
    );
    assertOwned();
    return operation(taskMandateBinding(record), assertOwned);
  });
}

export function authorizeTaskMandateOperation(
  cwd: string,
  requestedTaskId: string,
  operation: Exclude<TaskMandateOperation, { kind: 'provider-call' }>,
  options: TaskMandateOperationOptions,
): {
  authorized: true;
  mandateId: string;
  taskId: string;
  binding: TaskMandateBinding;
} {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const changeId = assertChangeId(options.changeId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    assertProductionTaskMandateRecord(record);
    const now = exactDate(options.now ?? new Date());
    const refusalBinding = taskMandateRefusalBinding(
      repository.repositoryRoot,
      record,
      'task-mandate.operation',
      {
        changeId,
        operationKind: operation.kind,
      },
    );
    return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
      assertRecordActive(record, now);
      assertTaskMandateChange(record, changeId);
      appendTaskMandateAuthorizationAudit(
        repository.repositoryRoot,
        record,
        now,
      );
      assertOwned();
      if (!isPreparationOperation(operation.kind)) {
        throw workflowError(
          'TASK_MANDATE_EFFECT_NOT_AUTHORIZED',
          `Task mandate does not authorize ${operation.kind}.`,
          ExitCode.guard,
        );
      }
      record.lastActivityAt = now.toISOString();
      replacePrivateFileAtomic(
        taskRecordPath(paths.active, taskId),
        canonicalTaskMandateRecord(record),
      );
      assertOwned();
      return {
        authorized: true as const,
        mandateId: record.mandateId,
        taskId,
        binding: taskMandateBinding(record),
      };
    });
  });
}

export function authorizeTaskMandateProviderReservation(
  cwd: string,
  binding: TaskMandateBinding,
  requestedReservationId: string,
  operation: TaskMandateProviderReservationOperation,
  options: TaskMandateOptions = {},
): TaskMandateProviderReservationAuthorization {
  const exactBinding = assertTaskMandateBinding(binding);
  const reservationId = assertProviderReservationId(requestedReservationId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    authorizeTaskMandateProviderReservationLocked(
      repository.repositoryRoot,
      paths,
      exactBinding,
      reservationId,
      operation,
      options,
      assertOwned,
    ),
  );
}

export function authorizeTaskMandateProviderReservationUnderLifecycleLock(
  cwd: string,
  binding: TaskMandateBinding,
  requestedReservationId: string,
  operation: TaskMandateProviderReservationOperation,
  assertOwned: () => void,
  options: TaskMandateOptions = {},
): TaskMandateProviderReservationAuthorization {
  const exactBinding = assertTaskMandateBinding(binding);
  const reservationId = assertProviderReservationId(requestedReservationId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  assertOwned();
  return authorizeTaskMandateProviderReservationLocked(
    repository.repositoryRoot,
    paths,
    exactBinding,
    reservationId,
    operation,
    options,
    assertOwned,
  );
}

export function assertActiveTaskMandateBindingUnderLifecycleLock(
  cwd: string,
  binding: TaskMandateBinding,
  assertOwned: () => void,
  options: TaskMandateOptions = {},
): TaskMandateBinding {
  const exactBinding = assertTaskMandateBinding(binding);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  assertOwned();
  const record = readTaskRecord(paths, exactBinding.mandateTaskId);
  validateTaskMandateEnvelopeForRepository(
    repository.repositoryRoot,
    record.envelope,
    options.signer,
  );
  assertProductionTaskMandateRecord(record);
  const bindingNow = exactDate(options.now ?? new Date());
  assertRecordActive(record, bindingNow);
  assertExactTaskMandateBinding(record, exactBinding);
  appendTaskMandateAuthorizationAudit(
    repository.repositoryRoot,
    record,
    bindingNow,
  );
  assertOwned();
  return exactBinding;
}

export function recordTaskMandateProviderInvocation(
  cwd: string,
  binding: TaskMandateBinding,
  input: TaskMandateProviderInvocationAuditInput,
  options: TaskMandateOptions = {},
): AuthorityAuditRecordedEvent {
  const exactBinding = assertTaskMandateBinding(binding);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    recordTaskMandateProviderInvocationLocked(
      repository.repositoryRoot,
      paths,
      exactBinding,
      input,
      options,
      assertOwned,
    ),
  );
}

export function recordTaskMandateProviderInvocationUnderLifecycleLock(
  cwd: string,
  binding: TaskMandateBinding,
  input: TaskMandateProviderInvocationAuditInput,
  assertOwned: () => void,
  options: TaskMandateOptions = {},
): AuthorityAuditRecordedEvent {
  const exactBinding = assertTaskMandateBinding(binding);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  assertOwned();
  return recordTaskMandateProviderInvocationLocked(
    repository.repositoryRoot,
    paths,
    exactBinding,
    input,
    options,
    assertOwned,
  );
}

function recordTaskMandateProviderInvocationLocked(
  repositoryRoot: string,
  paths: ReturnType<typeof taskMandateStorePaths>,
  exactBinding: TaskMandateBinding,
  rawInput: TaskMandateProviderInvocationAuditInput,
  options: TaskMandateOptions,
  assertOwned: () => void,
): AuthorityAuditRecordedEvent {
  const input = assertProviderInvocationAuditInput(rawInput);
  const record = readTaskRecord(paths, exactBinding.mandateTaskId);
  validateTaskMandateEnvelopeForRepository(
    repositoryRoot,
    record.envelope,
    options.signer,
  );
  assertProductionTaskMandateRecord(record);
  const invocationNow = exactDate(options.now ?? new Date());
  assertRecordActive(record, invocationNow);
  assertExactTaskMandateBinding(record, exactBinding);
  appendTaskMandateAuthorizationAudit(repositoryRoot, record, invocationNow);
  const reservation = findTaskMandateProviderReservation(
    record,
    input.invocationId,
  );
  if (
    reservation === null ||
    reservation.providerId !== input.providerId ||
    reservation.reservation.requestDigest !== input.requestDigest
  ) {
    throw workflowError(
      'TASK_MANDATE_PROVIDER_INVOCATION_UNRESERVED',
      'Provider invocation has no exact durable Task Mandate reservation.',
      ExitCode.guard,
    );
  }
  assertOwned();
  const audit = appendTaskMandateProviderInvocationAudit(
    repositoryRoot,
    record,
    input,
  );
  assertOwned();
  return audit;
}

function authorizeTaskMandateProviderReservationLocked(
  repositoryRoot: string,
  paths: ReturnType<typeof taskMandateStorePaths>,
  exactBinding: TaskMandateBinding,
  reservationId: string,
  operation: TaskMandateProviderReservationOperation,
  options: TaskMandateOptions,
  assertOwned: () => void,
): TaskMandateProviderReservationAuthorization {
  const record = readTaskRecord(paths, exactBinding.mandateTaskId);
  validateTaskMandateEnvelopeForRepository(
    repositoryRoot,
    record.envelope,
    options.signer,
  );
  assertProductionTaskMandateRecord(record);
  const now = exactDate(options.now ?? new Date());
  assertRecordActive(record, now);
  assertExactTaskMandateBinding(record, exactBinding);
  appendTaskMandateAuthorizationAudit(repositoryRoot, record, now);
  const checkedOperation = assertProviderReservationOperation(operation);
  const operationDigest = taskMandateProviderOperationDigest(checkedOperation);
  const existing = findTaskMandateProviderReservation(record, reservationId);
  if (existing !== null) {
    if (
      existing.providerId !== checkedOperation.providerId ||
      existing.reservation.requestDigest !== checkedOperation.requestDigest ||
      existing.reservation.operationDigest !== operationDigest
    ) {
      throw workflowError(
        'TASK_MANDATE_PROVIDER_RESERVATION_CONFLICT',
        'Provider reservation replay does not match its exact authorized call.',
        ExitCode.conflict,
      );
    }
    const audit = appendTaskMandateProviderReservationAudit(
      repositoryRoot,
      record,
      existing.providerId,
      existing.reservation,
    );
    return {
      authorized: true,
      binding: exactBinding,
      reservationId,
      providerUsage: {
        invocations: existing.usage.invocations,
        budget: existing.usage.budget,
      },
      replay: true,
      audit,
    };
  }
  assertOwned();
  const providerUsage = authorizeProviderCall(
    record,
    checkedOperation,
    reservationId,
    now.toISOString(),
    operationDigest,
  );
  record.lastActivityAt = now.toISOString();
  replacePrivateFileAtomic(
    taskRecordPath(paths.active, exactBinding.mandateTaskId),
    canonicalTaskMandateRecord(record),
  );
  assertOwned();
  const stored = findTaskMandateProviderReservation(record, reservationId);
  if (stored === null) throw unsafeStore();
  const audit = appendTaskMandateProviderReservationAudit(
    repositoryRoot,
    record,
    stored.providerId,
    stored.reservation,
  );
  assertOwned();
  return {
    authorized: true,
    binding: exactBinding,
    reservationId,
    providerUsage,
    replay: false,
    audit,
  };
}

export function revokeTaskMandate(
  cwd: string,
  requestedTaskId: string,
  options: RevokeTaskMandateOptions,
): TaskMandateInspection {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const reason = assertRevocationReason(options.reason);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureStore(paths);
    const terminalPath = taskRecordPath(paths.terminal, taskId);
    if (fs.existsSync(terminalPath)) {
      const terminal = parseTaskMandateRecord(readPrivateFile(terminalPath));
      validateTaskMandateEnvelopeForRepository(
        repository.repositoryRoot,
        terminal.envelope,
        options.signer,
      );
      if (terminal.schemaVersion === 2) {
        appendTaskMandateAuthorizationAudit(
          repository.repositoryRoot,
          terminal,
          exactDate(options.now ?? new Date()),
        );
        appendTaskMandateRevocationAudit(
          repository.repositoryRoot,
          terminal,
          exactDate(options.now ?? new Date()),
        );
      }
      return inspectRecord(terminal, exactDate(options.now ?? new Date()));
    }
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    assertProductionTaskMandateRecord(record);
    const now = exactDate(options.now ?? new Date());
    const refusalBinding = taskMandateRefusalBinding(
      repository.repositoryRoot,
      record,
      'task-mandate.revoke',
      { reasonDigest: authorityRefusalDigest(reason) },
    );
    return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
      appendTaskMandateAuthorizationAudit(
        repository.repositoryRoot,
        record,
        now,
      );
      const signer = options.signer ?? currentSigner(repository.repositoryRoot);
      signer.assertHumanPresent();
      const currentPolicy = loadPolicyAt(
        repository.repositoryRoot,
        repository.head,
      ).policy;
      if (
        !currentPolicy.trustedSigners.some(
          ({ identity }) => identity === signer.identity(),
        )
      ) {
        throw workflowError(
          'TASK_MANDATE_SIGNER_UNTRUSTED',
          'Task mandate revocation requires a currently trusted signer.',
          ExitCode.verification,
        );
      }
      record.state = 'revoked';
      record.revokedAt = now.toISOString();
      record.revocationReason = reason;
      assertOwned();
      const activePath = taskRecordPath(paths.active, taskId);
      fs.renameSync(activePath, terminalPath);
      replacePrivateFileAtomic(
        terminalPath,
        canonicalTaskMandateRecord(record),
      );
      assertOwned();
      appendTaskMandateRevocationAudit(repository.repositoryRoot, record, now);
      assertOwned();
      return inspectRecord(record, now);
    });
  });
}

export function canonicalTaskMandatePayload(
  payload: TaskMandatePayload | LegacyTaskMandatePayload,
): string {
  validateAnyTaskMandatePayload(payload);
  return `${canonicalJson(payload)}\n`;
}

export function canonicalTaskMandateEnvelope(
  envelope: AnyTaskMandateEnvelope,
): string {
  validateAnyTaskMandatePayload(envelope.payload);
  assertSignature(envelope.signature);
  return `${canonicalJson(envelope)}\n`;
}

export function parseTaskMandateEnvelope(raw: string): AnyTaskMandateEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 1_048_576) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signature']) ||
      !isRecord(value.payload) ||
      (!hasExactKeys(value.payload, PAYLOAD_KEYS) &&
        !hasExactKeys(value.payload, LEGACY_PAYLOAD_KEYS)) ||
      typeof value.signature !== 'string'
    ) {
      throw new Error('invalid envelope shape');
    }
    const envelope =
      value.payload.kind === 'task-mandate.v1'
        ? {
            payload: parseLegacyTaskMandatePayload(value.payload),
            signature: value.signature,
          }
        : {
            payload: parseTaskMandatePayload(value.payload),
            signature: value.signature,
          };
    assertSignature(envelope.signature);
    if (canonicalTaskMandateEnvelope(envelope) !== raw) {
      throw new Error('noncanonical envelope');
    }
    return envelope;
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw mandateInvalid('Task mandate envelope is malformed or noncanonical.');
  }
}

function parseTaskMandatePayload(
  value: Record<string, unknown>,
): TaskMandatePayload {
  if (
    value.kind !== 'task-mandate.v2' ||
    typeof value.mandateId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.repositoryId !== 'string' ||
    typeof value.repositoryOrigin !== 'string' ||
    typeof value.externalAuditRoot !== 'string' ||
    typeof value.policyBlob !== 'string' ||
    typeof value.baseCommit !== 'string' ||
    typeof value.intent !== 'string' ||
    !isRecord(value.preparation) ||
    value.authoritativeEffects !== false ||
    value.controlPlaneMutation !== false ||
    !Array.isArray(value.secretScopes) ||
    !isRecord(value.validUntil) ||
    value.auditRequired !== true ||
    typeof value.issuedAt !== 'string' ||
    typeof value.signer !== 'string'
  ) {
    throw new Error('invalid task mandate payload');
  }
  const preparation = value.preparation;
  const validUntil = value.validUntil;
  if (
    !hasExactKeys(preparation, [
      'repositoryRead',
      'isolatedRepositoryWrites',
      'addDeleteRenameFiles',
      'localCommands',
      'draftCommits',
      'candidateAndDesignArtifacts',
      'providerCalls',
      'readOnlyConnectors',
    ]) ||
    preparation.repositoryRead !== true ||
    preparation.isolatedRepositoryWrites !== true ||
    preparation.addDeleteRenameFiles !== true ||
    preparation.localCommands !== true ||
    preparation.draftCommits !== true ||
    preparation.candidateAndDesignArtifacts !== true ||
    !isRecord(preparation.providerCalls) ||
    preparation.readOnlyConnectors !== true ||
    !hasExactKeys(validUntil, [
      'taskClosed',
      'humanRevokes',
      'repositoryIdentityChanges',
      'intentReplaced',
      'inactivityDays',
    ]) ||
    validUntil.taskClosed !== true ||
    validUntil.humanRevokes !== true ||
    validUntil.repositoryIdentityChanges !== true ||
    validUntil.intentReplaced !== true ||
    validUntil.inactivityDays !== TASK_MANDATE_INACTIVITY_DAYS
  ) {
    throw new Error('unsafe task mandate bounds');
  }
  const payload: TaskMandatePayload = {
    kind: 'task-mandate.v2',
    mandateId: value.mandateId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    externalAuditRoot: value.externalAuditRoot,
    policyBlob: value.policyBlob,
    baseCommit: value.baseCommit,
    intent: value.intent,
    preparation: {
      repositoryRead: true,
      isolatedRepositoryWrites: true,
      addDeleteRenameFiles: true,
      localCommands: true,
      draftCommits: true,
      candidateAndDesignArtifacts: true,
      providerCalls: parseProviderDeclarations(preparation.providerCalls),
      readOnlyConnectors: true,
    },
    authoritativeEffects: false,
    controlPlaneMutation: false,
    secretScopes: [],
    validUntil: {
      taskClosed: true,
      humanRevokes: true,
      repositoryIdentityChanges: true,
      intentReplaced: true,
      inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    },
    auditRequired: true,
    issuedAt: value.issuedAt,
    signer: value.signer,
  };
  validateTaskMandatePayload(payload);
  return payload;
}

function parseLegacyTaskMandatePayload(
  value: Record<string, unknown>,
): LegacyTaskMandatePayload {
  if (value.kind !== 'task-mandate.v1') {
    throw new Error('invalid legacy task mandate kind');
  }
  const migrated = parseTaskMandatePayload({
    ...value,
    kind: 'task-mandate.v2',
    changeId: 'legacy-read-only',
    externalAuditRoot: '/legacy-read-only',
  });
  const {
    changeId: _legacyChangePlaceholder,
    externalAuditRoot: _legacyAuditPlaceholder,
    ...legacy
  } = migrated;
  return { ...legacy, kind: 'task-mandate.v1' };
}

function validateAnyTaskMandatePayload(
  payload: TaskMandatePayload | LegacyTaskMandatePayload,
): void {
  if (payload.kind === 'task-mandate.v2') {
    validateTaskMandatePayload(payload);
    return;
  }
  const migrated = {
    ...payload,
    kind: 'task-mandate.v2' as const,
    changeId: 'legacy-read-only',
    externalAuditRoot: '/legacy-read-only',
  };
  validateTaskMandatePayload(migrated);
}

function validateTaskMandatePayload(payload: TaskMandatePayload): void {
  if (
    payload.kind !== 'task-mandate.v2' ||
    !MANDATE_ID.test(payload.mandateId) ||
    assertChangeId(payload.changeId) !== payload.changeId ||
    !TASK_ID.test(payload.taskId) ||
    payload.taskId.length > 128 ||
    !/^github:[A-Za-z0-9_-]+$/.test(payload.repositoryId) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      payload.repositoryOrigin,
    ) ||
    assertExternalAuditRootPath(payload.externalAuditRoot) !==
      payload.externalAuditRoot ||
    !COMMIT_OID.test(payload.policyBlob) ||
    !COMMIT_OID.test(payload.baseCommit) ||
    assertIntent(payload.intent) !== payload.intent ||
    payload.authoritativeEffects !== false ||
    payload.controlPlaneMutation !== false ||
    payload.secretScopes.length !== 0 ||
    payload.auditRequired !== true ||
    exactTimestamp(payload.issuedAt) === undefined ||
    payload.signer.length === 0 ||
    payload.signer.length > 128
  ) {
    throw mandateInvalid(
      'Task mandate does not preserve the preparation-only boundary.',
    );
  }
  parseProviderDeclarations(payload.preparation.providerCalls);
}

function validateTaskMandateEnvelopeForRepository(
  repositoryRoot: string,
  envelope: AnyTaskMandateEnvelope,
  providedSigner?: MaintainerSignerProvider,
): void {
  const payload = envelope.payload;
  const base = loadPolicyAt(repositoryRoot, payload.baseCommit);
  const currentHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const current = loadPolicyAt(repositoryRoot, currentHead);
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  if (
    base.policyBlob !== payload.policyBlob ||
    base.policy.repository.id !== payload.repositoryId ||
    base.policy.repository.origin !== payload.repositoryOrigin ||
    current.policy.repository.id !== payload.repositoryId ||
    current.policy.repository.origin !== payload.repositoryOrigin ||
    origin !== payload.repositoryOrigin ||
    !base.policy.trustedSigners.some(
      ({ identity }) => identity === payload.signer,
    )
  ) {
    throw workflowError(
      'TASK_MANDATE_REPOSITORY_MISMATCH',
      'Task mandate no longer matches this repository identity or trust base.',
      ExitCode.staleState,
    );
  }
  if (payload.kind === 'task-mandate.v2') {
    scanAuthorityAuditLedger(taskMandateAuditScope(repositoryRoot, payload));
  }
  const signer =
    providedSigner ?? createInteractiveSshSigner(repositoryRoot, base.policy);
  try {
    signer.verify(
      canonicalTaskMandatePayload(payload),
      envelope.signature,
      payload.signer,
      payload.kind === 'task-mandate.v2'
        ? TASK_MANDATE_SIGNATURE_NAMESPACE_V2
        : TASK_MANDATE_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature is invalid for its dedicated domain.',
      ExitCode.verification,
    );
  }
}

function authorizeProviderCall(
  record: TaskMandateRecord,
  operation: TaskMandateProviderReservationOperation,
  reservationId: string,
  authorizedAt: string,
  operationDigest: string,
): TaskMandateProviderUsage {
  const declaration =
    record.envelope.payload.preparation.providerCalls[operation.providerId];
  const requestedDataTypes = normalizeDataTypes(operation.dataTypes);
  if (!declaration) {
    throw workflowError(
      'TASK_MANDATE_PROVIDER_NOT_DECLARED',
      `Provider ${operation.providerId} is not declared by the task mandate.`,
      ExitCode.guard,
    );
  }
  if (
    requestedDataTypes.some(
      (dataType) => !declaration.dataTypes.includes(dataType),
    ) ||
    requestedDataTypes.includes('source-code') !== operation.sourceCode ||
    (operation.sourceCode && !declaration.sourceCode) ||
    operation.secrets ||
    (operation.retry && !declaration.retryOnFailure)
  ) {
    throw workflowError(
      'TASK_MANDATE_PROVIDER_SCOPE_EXCEEDED',
      'Provider call exceeds the data, source, secret, or retry scope in the task mandate.',
      ExitCode.guard,
    );
  }
  if (operation.retry && declaration.retryRequiresHuman) {
    throw workflowError(
      'TASK_MANDATE_HUMAN_CONFIRMATION_REQUIRED',
      'This provider retry requires a new human confirmation.',
      ExitCode.guard,
    );
  }
  const usage = record.providerUsage[operation.providerId] ?? {
    invocations: 0,
    budget: 0,
    reservations: [],
  };
  const budget = operation.budget === null ? 0 : operation.budget;
  if (!Number.isFinite(budget) || budget < 0) {
    throw mandateInvalid('Provider call budget is invalid.');
  }
  if (declaration.maxBudget !== null && operation.budget === null) {
    throw workflowError(
      'TASK_MANDATE_PROVIDER_SCOPE_EXCEEDED',
      'A metered provider declaration requires an exact call budget.',
      ExitCode.guard,
    );
  }
  // The declared budget bounds unsupervised spend. A caller holding a
  // validated, consumed execution-budget grant carries a fresh human
  // signature for exactly one bounded replacement, and that consent lifts the
  // invocation ceiling by the one reservation it names. The monetary ceiling
  // stays strict either way: granted entries record no per-call amount, so a
  // metered excess could never be attributed.
  if (
    (usage.invocations >= declaration.maxInvocations &&
      operation.executionGrant === undefined) ||
    (declaration.maxBudget !== null &&
      usage.budget + budget > declaration.maxBudget)
  ) {
    throw workflowError(
      'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED',
      'Task mandate provider invocation or monetary budget is exhausted.',
      ExitCode.guard,
    );
  }
  const next = {
    invocations: usage.invocations + 1,
    budget: usage.budget + budget,
    reservations: [
      ...usage.reservations,
      {
        reservationId,
        authorizedAt,
        requestDigest: operation.requestDigest,
        operationDigest,
        ...(operation.executionGrant === undefined
          ? {}
          : { executionGrantId: operation.executionGrant.grantId }),
      },
    ].sort((left, right) =>
      left.reservationId.localeCompare(right.reservationId),
    ),
  };
  record.providerUsage[operation.providerId] = next;
  return { invocations: next.invocations, budget: next.budget };
}

function isPreparationOperation(kind: TaskMandateOperation['kind']): boolean {
  return [
    'repository-read',
    'isolated-repository-write',
    'add-delete-rename',
    'local-command',
    'draft-commit',
    'candidate-or-design-artifact',
    'read-only-connector',
  ].includes(kind);
}

function parseProviderDeclarations(
  value: Record<string, unknown>,
): Partial<Record<ProviderId, TaskMandateProviderDeclaration>> {
  const result: Partial<Record<ProviderId, TaskMandateProviderDeclaration>> =
    {};
  for (const providerId of Object.keys(value).sort()) {
    const declaration = value[providerId];
    if (!isProviderId(providerId) || !isRecord(declaration)) {
      throw mandateInvalid('Task mandate names an unknown provider.');
    }
    if (
      !hasExactKeys(declaration, [
        'maxInvocations',
        'maxBudget',
        'dataTypes',
        'sourceCode',
        'secrets',
        'retryOnFailure',
        'retryRequiresHuman',
      ]) ||
      typeof declaration.maxInvocations !== 'number' ||
      !Number.isInteger(declaration.maxInvocations) ||
      declaration.maxInvocations < 1 ||
      declaration.maxInvocations > 1000 ||
      (declaration.maxBudget !== null &&
        (typeof declaration.maxBudget !== 'number' ||
          !Number.isFinite(declaration.maxBudget) ||
          declaration.maxBudget < 0 ||
          declaration.maxBudget > 1_000_000)) ||
      !Array.isArray(declaration.dataTypes) ||
      typeof declaration.sourceCode !== 'boolean' ||
      declaration.secrets !== false ||
      typeof declaration.retryOnFailure !== 'boolean' ||
      typeof declaration.retryRequiresHuman !== 'boolean'
    ) {
      throw mandateInvalid('Task mandate provider declaration is invalid.');
    }
    const dataTypes = normalizeDataTypes(declaration.dataTypes);
    if (
      dataTypes.length === 0 ||
      dataTypes.includes('source-code') !== declaration.sourceCode ||
      (declaration.retryRequiresHuman && !declaration.retryOnFailure)
    ) {
      throw mandateInvalid(
        'Task mandate provider declaration has inconsistent data or retry bounds.',
      );
    }
    result[providerId] = {
      maxInvocations: declaration.maxInvocations,
      maxBudget: declaration.maxBudget,
      dataTypes,
      sourceCode: declaration.sourceCode,
      secrets: false,
      retryOnFailure: declaration.retryOnFailure,
      retryRequiresHuman: declaration.retryRequiresHuman,
    };
  }
  return result;
}

function normalizeDataTypes(value: unknown[]): TaskMandateDataType[] {
  if (
    !value.every(
      (entry): entry is TaskMandateDataType =>
        typeof entry === 'string' &&
        (DATA_TYPES as readonly string[]).includes(entry),
    )
  ) {
    throw mandateInvalid('Task mandate provider data type is unknown.');
  }
  const normalized = [...new Set(value)].sort();
  if (
    normalized.length !== value.length ||
    normalized.some((entry, index) => entry !== value[index])
  ) {
    throw mandateInvalid(
      'Task mandate provider data types must be sorted and unique.',
    );
  }
  return normalized;
}

function cloneProviderDeclarations(
  declarations: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>,
): Partial<Record<ProviderId, TaskMandateProviderDeclaration>> {
  return Object.fromEntries(
    Object.entries(declarations).map(([providerId, declaration]) => [
      providerId,
      {
        ...declaration,
        dataTypes: [...declaration.dataTypes],
      },
    ]),
  );
}

function inspectRecord(
  record: AnyTaskMandateRecord,
  now: Date,
): TaskMandateInspection {
  assertRecordClock(record, now);
  const state =
    record.state === 'revoked'
      ? 'revoked'
      : isInactive(record, now)
        ? 'expired'
        : 'active';
  return {
    mandateId: record.mandateId,
    ...(record.schemaVersion === 2
      ? {
          changeId: record.changeId,
          externalAuditRoot: record.externalAuditRoot,
        }
      : {}),
    taskId: record.taskId,
    legacyReadOnly: record.schemaVersion === 1,
    state,
    intent: record.envelope.payload.intent,
    baseCommit: record.envelope.payload.baseCommit,
    signer: record.envelope.payload.signer,
    issuedAt: record.envelope.payload.issuedAt,
    lastActivityAt: record.lastActivityAt,
    providerUsage: Object.fromEntries(
      Object.entries(record.providerUsage).map(([providerId, usage]) => [
        providerId,
        { invocations: usage.invocations, budget: usage.budget },
      ]),
    ),
    inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    ...(record.revocationReason
      ? { revocationReason: record.revocationReason }
      : {}),
  };
}

function assertRecordActive(record: AnyTaskMandateRecord, now: Date): void {
  assertRecordClock(record, now);
  if (record.state === 'revoked') {
    throw workflowError(
      'TASK_MANDATE_REVOKED',
      'Task mandate has been revoked.',
      ExitCode.staleState,
    );
  }
  if (isInactive(record, now)) {
    throw workflowError(
      'TASK_MANDATE_EXPIRED',
      'Task mandate expired after fourteen days without activity.',
      ExitCode.staleState,
    );
  }
}

function assertRecordClock(record: AnyTaskMandateRecord, now: Date): void {
  const lastActivity = exactTimestamp(record.lastActivityAt);
  if (lastActivity === undefined || lastActivity > now.getTime() + 30_000) {
    throw unsafeStore();
  }
}

function isInactive(record: AnyTaskMandateRecord, now: Date): boolean {
  const lastActivity = exactTimestamp(record.lastActivityAt);
  if (lastActivity === undefined) throw unsafeStore();
  return (
    now.getTime() - lastActivity >=
    TASK_MANDATE_INACTIVITY_DAYS * 24 * 60 * 60_000
  );
}

function taskMandateStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'task-mandates');
  return {
    runtime,
    root,
    active: path.join(root, 'active'),
    terminal: path.join(root, 'terminal'),
    history: path.join(root, 'history'),
  };
}

function ensureStore(paths: ReturnType<typeof taskMandateStorePaths>): void {
  for (const directory of [
    paths.root,
    paths.active,
    paths.terminal,
    paths.history,
  ]) {
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
  }
}

function readTaskRecord(
  paths: ReturnType<typeof taskMandateStorePaths>,
  taskId: string,
): AnyTaskMandateRecord {
  const active = taskRecordPath(paths.active, taskId);
  const terminal = taskRecordPath(paths.terminal, taskId);
  if (fs.existsSync(active))
    return parseTaskMandateRecord(readPrivateFile(active));
  if (fs.existsSync(terminal)) {
    return parseTaskMandateRecord(readPrivateFile(terminal));
  }
  throw workflowError(
    'TASK_MANDATE_NOT_FOUND',
    `No task mandate exists for ${taskId}.`,
    ExitCode.guard,
  );
}

function canonicalTaskMandateRecord(record: AnyTaskMandateRecord): string {
  return `${canonicalJson(record)}\n`;
}

function parseTaskMandateRecord(raw: string): AnyTaskMandateRecord {
  try {
    const value = JSON.parse(raw) as unknown;
    if (isRecord(value) && value.schemaVersion === 1) {
      return parseLegacyTaskMandateRecord(raw, value);
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'state',
        'mandateId',
        'changeId',
        'externalAuditRoot',
        'taskId',
        'lastActivityAt',
        'providerUsage',
        'revokedAt',
        'revocationReason',
        'envelope',
      ]) ||
      value.schemaVersion !== 2 ||
      (value.state !== 'active' && value.state !== 'revoked') ||
      typeof value.mandateId !== 'string' ||
      typeof value.changeId !== 'string' ||
      typeof value.externalAuditRoot !== 'string' ||
      typeof value.taskId !== 'string' ||
      typeof value.lastActivityAt !== 'string' ||
      !isRecord(value.providerUsage) ||
      (value.revokedAt !== null && typeof value.revokedAt !== 'string') ||
      (value.revocationReason !== null &&
        typeof value.revocationReason !== 'string') ||
      !isRecord(value.envelope)
    ) {
      throw new Error('invalid record shape');
    }
    const envelope = parseTaskMandateEnvelope(
      `${canonicalJson(value.envelope)}\n`,
    );
    if (envelope.payload.kind !== 'task-mandate.v2') {
      throw new Error('v2 record contains a legacy envelope');
    }
    const productionEnvelope = envelope as TaskMandateEnvelope;
    const providerUsage: Partial<
      Record<ProviderId, StoredTaskMandateProviderUsage>
    > = {};
    for (const [providerId, usage] of Object.entries(value.providerUsage)) {
      if (
        !isProviderId(providerId) ||
        !isRecord(usage) ||
        !hasExactKeys(usage, ['invocations', 'budget', 'reservations']) ||
        typeof usage.invocations !== 'number' ||
        !Number.isInteger(usage.invocations) ||
        usage.invocations < 0 ||
        typeof usage.budget !== 'number' ||
        !Number.isFinite(usage.budget) ||
        usage.budget < 0 ||
        !isSortedUniqueProviderReservations(usage.reservations)
      ) {
        throw new Error('invalid provider usage');
      }
      providerUsage[providerId] = {
        invocations: usage.invocations,
        budget: usage.budget,
        reservations: structuredClone(usage.reservations),
      };
    }
    const record: TaskMandateRecord = {
      schemaVersion: 2,
      state: value.state,
      mandateId: value.mandateId,
      changeId: value.changeId,
      externalAuditRoot: value.externalAuditRoot,
      taskId: value.taskId,
      lastActivityAt: value.lastActivityAt,
      providerUsage,
      revokedAt: value.revokedAt,
      revocationReason: value.revocationReason,
      envelope: productionEnvelope,
    };
    const issuedAt = exactTimestamp(productionEnvelope.payload.issuedAt);
    const lastActivityAt = exactTimestamp(record.lastActivityAt);
    const declaredProviders = Object.keys(
      productionEnvelope.payload.preparation.providerCalls,
    ).sort();
    const usageProviders = Object.keys(record.providerUsage).sort();
    const reservations = Object.values(record.providerUsage).flatMap(
      (usage) => usage?.reservations ?? [],
    );
    if (
      record.mandateId !== productionEnvelope.payload.mandateId ||
      record.changeId !== productionEnvelope.payload.changeId ||
      record.externalAuditRoot !==
        productionEnvelope.payload.externalAuditRoot ||
      record.taskId !== productionEnvelope.payload.taskId ||
      issuedAt === undefined ||
      lastActivityAt === undefined ||
      lastActivityAt < issuedAt ||
      JSON.stringify(declaredProviders) !== JSON.stringify(usageProviders) ||
      new Set(reservations.map(({ reservationId }) => reservationId)).size !==
        reservations.length ||
      reservations.some(
        ({ authorizedAt }) => exactTimestamp(authorizedAt)! > lastActivityAt,
      ) ||
      declaredProviders.some((providerId) => {
        const declaration =
          productionEnvelope.payload.preparation.providerCalls[
            providerId as ProviderId
          ];
        const usage = record.providerUsage[providerId as ProviderId];
        // Reservations attributed to a signed execution grant legitimately
        // exceed the declared invocation ceiling by exactly their count.
        const grantedReservations =
          usage?.reservations.filter(
            ({ executionGrantId }) => executionGrantId !== undefined,
          ).length ?? 0;
        return (
          !declaration ||
          !usage ||
          usage.invocations !== usage.reservations.length ||
          usage.invocations >
            declaration.maxInvocations + grantedReservations ||
          (declaration.maxBudget !== null &&
            usage.budget > declaration.maxBudget)
        );
      }) ||
      (record.state === 'active' &&
        (record.revokedAt !== null || record.revocationReason !== null)) ||
      (record.state === 'revoked' &&
        (exactTimestamp(record.revokedAt ?? '') === undefined ||
          exactTimestamp(record.revokedAt ?? '')! < lastActivityAt ||
          !record.revocationReason)) ||
      canonicalTaskMandateRecord(record) !== raw
    ) {
      throw new Error('invalid record binding');
    }
    return record;
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw unsafeStore();
  }
}

function parseLegacyTaskMandateRecord(
  raw: string,
  value: Record<string, unknown>,
): LegacyTaskMandateRecord {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'mandateId',
      'taskId',
      'lastActivityAt',
      'providerUsage',
      'revokedAt',
      'revocationReason',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    (value.state !== 'active' && value.state !== 'revoked') ||
    typeof value.mandateId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.lastActivityAt !== 'string' ||
    !isRecord(value.providerUsage) ||
    (value.revokedAt !== null && typeof value.revokedAt !== 'string') ||
    (value.revocationReason !== null &&
      typeof value.revocationReason !== 'string') ||
    !isRecord(value.envelope)
  ) {
    throw new Error('invalid legacy record shape');
  }
  const envelope = parseTaskMandateEnvelope(
    `${canonicalJson(value.envelope)}\n`,
  );
  if (envelope.payload.kind !== 'task-mandate.v1') {
    throw new Error('legacy record contains a non-legacy envelope');
  }
  const legacyEnvelope = envelope as LegacyTaskMandateEnvelope;
  const providerUsage: Partial<Record<ProviderId, TaskMandateProviderUsage>> =
    {};
  for (const [providerId, usage] of Object.entries(value.providerUsage)) {
    if (
      !isProviderId(providerId) ||
      !isRecord(usage) ||
      !hasExactKeys(usage, ['invocations', 'budget']) ||
      typeof usage.invocations !== 'number' ||
      !Number.isInteger(usage.invocations) ||
      usage.invocations < 0 ||
      typeof usage.budget !== 'number' ||
      !Number.isFinite(usage.budget) ||
      usage.budget < 0
    ) {
      throw new Error('invalid legacy provider usage');
    }
    providerUsage[providerId] = {
      invocations: usage.invocations,
      budget: usage.budget,
    };
  }
  const record: LegacyTaskMandateRecord = {
    schemaVersion: 1,
    state: value.state,
    mandateId: value.mandateId,
    taskId: value.taskId,
    lastActivityAt: value.lastActivityAt,
    providerUsage,
    revokedAt: value.revokedAt,
    revocationReason: value.revocationReason,
    envelope: legacyEnvelope,
  };
  const issuedAt = exactTimestamp(envelope.payload.issuedAt);
  const lastActivityAt = exactTimestamp(record.lastActivityAt);
  const declaredProviders = Object.keys(
    envelope.payload.preparation.providerCalls,
  ).sort();
  const usageProviders = Object.keys(record.providerUsage).sort();
  if (
    record.mandateId !== envelope.payload.mandateId ||
    record.taskId !== envelope.payload.taskId ||
    issuedAt === undefined ||
    lastActivityAt === undefined ||
    lastActivityAt < issuedAt ||
    JSON.stringify(declaredProviders) !== JSON.stringify(usageProviders) ||
    declaredProviders.some((providerId) => {
      const declaration =
        envelope.payload.preparation.providerCalls[providerId as ProviderId];
      const usage = record.providerUsage[providerId as ProviderId];
      return (
        !declaration ||
        !usage ||
        usage.invocations > declaration.maxInvocations ||
        (declaration.maxBudget !== null && usage.budget > declaration.maxBudget)
      );
    }) ||
    (record.state === 'active' &&
      (record.revokedAt !== null || record.revocationReason !== null)) ||
    (record.state === 'revoked' &&
      (exactTimestamp(record.revokedAt ?? '') === undefined ||
        exactTimestamp(record.revokedAt ?? '')! < lastActivityAt ||
        !record.revocationReason)) ||
    canonicalTaskMandateRecord(record) !== raw
  ) {
    throw new Error('invalid legacy record binding');
  }
  return record;
}

function taskMandateAuditScope(
  repositoryRoot: string,
  payload: TaskMandatePayload,
): AuthorityAuditLedgerScope {
  return {
    externalAuditRoot: payload.externalAuditRoot,
    repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
  };
}

function taskMandateRefusalBinding(
  repositoryRoot: string,
  record: TaskMandateRecord,
  operation: string,
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const binding = taskMandateBinding(record);
  const grantDigest = prefixedDigest(binding.mandateDigest);
  return {
    scope: taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    family: 'task-mandate',
    operation,
    subjectId: record.mandateId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: record.taskId,
    changeId: record.changeId,
    workflowId: record.mandateId,
    grantDigest,
    bindingDigest: grantDigest,
    refusalIdentity: {
      mandateId: record.mandateId,
      ...refusalIdentity,
    },
  };
}

function appendTaskMandateAuthorizationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  now?: Date,
): AuthorityAuditRecordedEvent {
  const binding = taskMandateBinding(record);
  const grantDigest = prefixedDigest(binding.mandateDigest);
  return recordAuthorityAuditEvent(
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'task-mandate',
      occurredAt: record.envelope.payload.issuedAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-authorization-audit.v1',
        mandateId: record.mandateId,
        grantDigest,
      }),
      actor: { kind: 'human', identity: record.envelope.payload.signer },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: record.mandateId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-authorized-poststate.v1',
        mandateId: record.mandateId,
        issuedAt: record.envelope.payload.issuedAt,
        state: 'active',
      }),
      command: {
        name: 'task.authorize',
        argvDigest: auditValueDigest({
          changeId: record.changeId,
          taskId: record.taskId,
          grantDigest,
        }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'recorded',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-authorization-outcome.v1',
        binding,
      }),
      errorCode: null,
    },
    now === undefined ? {} : { now: () => now },
  );
}

/**
 * The ledger rejects an event stamped far ahead of its own clock. The event
 * time here comes from the caller's clock, so the append has to read the same
 * one — otherwise any operation running on an injected clock records a time
 * the ledger then refuses.
 */
function appendTaskMandateRevocationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  now?: Date,
): AuthorityAuditRecordedEvent {
  if (
    record.state !== 'revoked' ||
    record.revokedAt === null ||
    record.revocationReason === null
  ) {
    throw unsafeStore();
  }
  const binding = taskMandateBinding(record);
  const grantDigest = prefixedDigest(binding.mandateDigest);
  return recordAuthorityAuditEvent(
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'revoke',
      occurredAt: record.revokedAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-revocation-audit.v1',
        mandateId: record.mandateId,
        revokedAt: record.revokedAt,
      }),
      actor: { kind: 'human', identity: record.envelope.payload.signer },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: record.mandateId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: auditValueDigest({
        kind: 'task-mandate-revocation-prestate.v1',
        mandateId: record.mandateId,
        state: 'active',
      }),
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-revocation-poststate.v1',
        mandateId: record.mandateId,
        revokedAt: record.revokedAt,
        reasonDigest: auditValueDigest(record.revocationReason),
        state: 'revoked',
      }),
      command: {
        name: 'task.revoke',
        argvDigest: auditValueDigest({
          taskId: record.taskId,
          reasonDigest: auditValueDigest(record.revocationReason),
        }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'revoked',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-revocation-outcome.v1',
        mandateId: record.mandateId,
        revokedAt: record.revokedAt,
      }),
      errorCode: null,
    },
    now === undefined ? {} : { now: () => now },
  );
}

function appendTaskMandateProviderReservationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  providerId: ProviderId,
  reservation: StoredTaskMandateProviderUsage['reservations'][number],
): AuthorityAuditRecordedEvent {
  const grantDigest = prefixedDigest(taskMandateBinding(record).mandateDigest);
  const requestDigest = prefixedDigest(reservation.requestDigest);
  return recordAuthorityAuditEvent(
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'grant-consume',
      occurredAt: reservation.authorizedAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-provider-reservation-audit.v1',
        mandateId: record.mandateId,
        reservationId: reservation.reservationId,
        operationDigest: reservation.operationDigest,
      }),
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: reservation.reservationId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: auditValueDigest({
        kind: 'task-mandate-provider-reservation-prestate.v1',
        mandateId: record.mandateId,
        providerId,
      }),
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-provider-reservation-poststate.v1',
        mandateId: record.mandateId,
        providerId,
        reservationId: reservation.reservationId,
        operationDigest: reservation.operationDigest,
      }),
      command: {
        name: 'provider.reserve',
        argvDigest: auditValueDigest({
          providerId,
          reservationId: reservation.reservationId,
          requestDigest,
        }),
      },
      providerInvocation: {
        providerId,
        invocationId: reservation.reservationId,
        requestDigest,
      },
      externalEffect: null,
      result: 'recorded',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-provider-reservation-outcome.v1',
        providerId,
        reservation,
      }),
      errorCode: null,
    },
  );
}

function appendTaskMandateProviderInvocationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  input: TaskMandateProviderInvocationAuditInput,
): AuthorityAuditRecordedEvent {
  const grantDigest = prefixedDigest(taskMandateBinding(record).mandateDigest);
  const requestDigest = prefixedDigest(input.requestDigest);
  return recordAuthorityAuditEvent(
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'provider-invocation',
      occurredAt: input.occurredAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-provider-invocation-audit.v1',
        mandateId: record.mandateId,
        invocationId: input.invocationId,
        requestDigest,
      }),
      actor: { kind: 'engine', identity: 'provider-worker' },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: input.invocationId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: auditValueDigest({
        kind: 'task-mandate-provider-invocation-prestate.v1',
        invocationId: input.invocationId,
        state: 'prepared',
      }),
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-provider-invocation-poststate.v1',
        invocationId: input.invocationId,
        state: 'dispatch-authorized',
      }),
      command: null,
      providerInvocation: {
        providerId: input.providerId,
        invocationId: input.invocationId,
        requestDigest,
      },
      externalEffect: null,
      result: 'recorded',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-provider-invocation-outcome.v1',
        providerId: input.providerId,
        invocationId: input.invocationId,
        requestDigest,
      }),
      errorCode: null,
    },
  );
}

function auditValueDigest(value: unknown): Sha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function prefixedDigest(value: string): Sha256Digest {
  if (!/^[0-9a-f]{64}$/.test(value)) throw unsafeStore();
  return `sha256:${value}`;
}

function loadTrustContext(cwd: string) {
  const repository = discoverRepository(cwd);
  const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== loaded.policy.repository.origin) {
    throw workflowError(
      'TASK_MANDATE_REPOSITORY_MISMATCH',
      'Repository origin differs from its trusted task mandate policy.',
      ExitCode.guard,
    );
  }
  return { repository, ...loaded };
}

function loadPolicyAt(repositoryRoot: string, commit: string) {
  try {
    const content = runGit(repositoryRoot, [
      'show',
      `${commit}:workflow/maintainer-policy.json`,
    ]);
    return {
      policy: parseMaintainerPolicy(JSON.parse(content)),
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${commit}:workflow/maintainer-policy.json`,
      ]).trim(),
    };
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_POLICY_INVALID',
      'Task mandate trust-base policy is unavailable or invalid.',
      ExitCode.guard,
    );
  }
}

function currentSigner(repositoryRoot: string): MaintainerSignerProvider {
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  return createInteractiveSshSigner(
    repositoryRoot,
    loadPolicyAt(repositoryRoot, head).policy,
  );
}

function taskRecordPath(directory: string, taskId: string): string {
  return path.join(directory, `${assertTaskMandateTaskId(taskId)}.json`);
}

function taskHistoryPath(
  directory: string,
  taskId: string,
  mandateId: string,
): string {
  return path.join(
    directory,
    `${assertTaskMandateTaskId(taskId)}.${assertMandateId(mandateId)}.json`,
  );
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
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

function replacePrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
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

function readPrivateFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw unsafeStore();
  }
  return fs.readFileSync(filePath, 'utf8');
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertTaskMandateTaskId(value: string): string {
  if (!TASK_ID.test(value) || value.length > 128) {
    throw mandateInvalid('Task mandate task ID must be lower-case kebab-case.');
  }
  return value;
}

function taskMandateBinding(record: TaskMandateRecord): TaskMandateBinding {
  return {
    schemaVersion: 1,
    mandateTaskId: record.taskId,
    mandateId: record.mandateId,
    mandateDigest: crypto
      .createHash('sha256')
      .update(canonicalTaskMandateEnvelope(record.envelope))
      .digest('hex'),
    changeId: record.changeId,
    externalAuditRoot: record.externalAuditRoot,
  };
}

function assertTaskMandateBinding(value: unknown): TaskMandateBinding {
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
    typeof value.mandateId !== 'string' ||
    typeof value.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    typeof value.externalAuditRoot !== 'string'
  ) {
    throw mandateInvalid('Task mandate binding is malformed.');
  }
  return {
    schemaVersion: 1,
    mandateTaskId: assertTaskMandateTaskId(value.mandateTaskId),
    mandateId: assertMandateId(value.mandateId),
    mandateDigest: value.mandateDigest,
    changeId: assertChangeId(value.changeId),
    externalAuditRoot: assertExternalAuditRootPath(value.externalAuditRoot),
  };
}

function assertTaskMandateChange(
  record: TaskMandateRecord,
  changeId: string,
): void {
  if (record.changeId !== changeId) {
    throw workflowError(
      'TASK_MANDATE_CHANGE_MISMATCH',
      `Task mandate ${record.taskId} is bound to another change.`,
      ExitCode.guard,
    );
  }
}

function assertProductionTaskMandateRecord(
  record: AnyTaskMandateRecord,
): asserts record is TaskMandateRecord {
  if (record.schemaVersion !== 2) {
    throw workflowError(
      'TASK_MANDATE_LEGACY_READ_ONLY',
      'A legacy task mandate without an exact change binding is read-only.',
      ExitCode.guard,
    );
  }
}

function assertExactTaskMandateBinding(
  record: TaskMandateRecord,
  binding: TaskMandateBinding,
): void {
  const current = taskMandateBinding(record);
  if (canonicalJson(current) !== canonicalJson(binding)) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'The durable task mandate binding no longer matches the active mandate.',
      ExitCode.staleState,
    );
  }
}

function assertProviderReservationId(value: string): string {
  if (!PROVIDER_RESERVATION_ID.test(value)) {
    throw mandateInvalid('Provider reservation ID is invalid.');
  }
  return value;
}

function assertProviderReservationOperation(
  value: unknown,
): TaskMandateProviderReservationOperation {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, [
        'providerId',
        'dataTypes',
        'sourceCode',
        'secrets',
        'retry',
        'budget',
        'requestDigest',
      ]) ||
      hasExactKeys(value, [
        'providerId',
        'dataTypes',
        'sourceCode',
        'secrets',
        'retry',
        'budget',
        'requestDigest',
        'executionGrant',
      ])
    ) ||
    !isProviderId(value.providerId) ||
    !Array.isArray(value.dataTypes) ||
    typeof value.sourceCode !== 'boolean' ||
    typeof value.secrets !== 'boolean' ||
    typeof value.retry !== 'boolean' ||
    (value.budget !== null && typeof value.budget !== 'number') ||
    typeof value.requestDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
    (value.executionGrant !== undefined &&
      !(
        isRecord(value.executionGrant) &&
        hasExactKeys(value.executionGrant, ['grantId']) &&
        typeof value.executionGrant.grantId === 'string' &&
        /^[0-9a-f-]{36}$/.test(value.executionGrant.grantId)
      ))
  ) {
    throw mandateInvalid('Provider reservation operation is malformed.');
  }
  return {
    providerId: value.providerId,
    dataTypes: normalizeDataTypes(value.dataTypes),
    sourceCode: value.sourceCode,
    secrets: value.secrets,
    retry: value.retry,
    budget: value.budget,
    requestDigest: value.requestDigest,
    ...(value.executionGrant === undefined
      ? {}
      : {
          executionGrant: {
            grantId: (value.executionGrant as { grantId: string }).grantId,
          },
        }),
  };
}

function taskMandateProviderOperationDigest(
  operation: TaskMandateProviderReservationOperation,
): string {
  // The grant is the authorization vehicle, not part of the operation's
  // semantic identity: the same reservation replays identically whether or
  // not its caller still holds the grant object.
  const { executionGrant: _executionGrant, ...semantic } = operation;
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        kind: 'task-mandate-provider-reservation-operation.v1',
        operation: semantic,
      }),
    )
    .digest('hex');
}

function findTaskMandateProviderReservation(
  record: TaskMandateRecord,
  reservationId: string,
): {
  providerId: ProviderId;
  usage: StoredTaskMandateProviderUsage;
  reservation: StoredTaskMandateProviderUsage['reservations'][number];
} | null {
  let found: ReturnType<typeof findTaskMandateProviderReservation> = null;
  for (const [rawProviderId, usage] of Object.entries(record.providerUsage)) {
    if (!isProviderId(rawProviderId) || usage === undefined)
      throw unsafeStore();
    const reservation = usage.reservations.find(
      (candidate) => candidate.reservationId === reservationId,
    );
    if (reservation === undefined) continue;
    if (found !== null) throw unsafeStore();
    found = { providerId: rawProviderId, usage, reservation };
  }
  return found;
}

function assertProviderInvocationAuditInput(
  value: unknown,
): TaskMandateProviderInvocationAuditInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'invocationId',
      'requestDigest',
      'occurredAt',
    ]) ||
    !isProviderId(value.providerId) ||
    typeof value.invocationId !== 'string' ||
    typeof value.requestDigest !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
    exactTimestamp(value.occurredAt) === undefined
  ) {
    throw mandateInvalid('Provider invocation audit input is malformed.');
  }
  return {
    providerId: value.providerId,
    invocationId: assertProviderReservationId(value.invocationId),
    requestDigest: value.requestDigest,
    occurredAt: value.occurredAt,
  };
}

function isSortedUniqueProviderReservations(
  value: unknown,
): value is StoredTaskMandateProviderUsage['reservations'] {
  return (
    Array.isArray(value) &&
    value.every(
      (reservation) =>
        isRecord(reservation) &&
        (hasExactKeys(reservation, [
          'reservationId',
          'authorizedAt',
          'requestDigest',
          'operationDigest',
        ]) ||
          hasExactKeys(reservation, [
            'reservationId',
            'authorizedAt',
            'requestDigest',
            'operationDigest',
            'executionGrantId',
          ])) &&
        typeof reservation.reservationId === 'string' &&
        PROVIDER_RESERVATION_ID.test(reservation.reservationId) &&
        typeof reservation.authorizedAt === 'string' &&
        exactTimestamp(reservation.authorizedAt) !== undefined &&
        typeof reservation.requestDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(reservation.requestDigest) &&
        typeof reservation.operationDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(reservation.operationDigest) &&
        (reservation.executionGrantId === undefined ||
          (typeof reservation.executionGrantId === 'string' &&
            /^[0-9a-f-]{36}$/.test(reservation.executionGrantId))),
    ) &&
    new Set(value.map(({ reservationId }) => reservationId)).size ===
      value.length &&
    [...value]
      .sort((left, right) =>
        left.reservationId.localeCompare(right.reservationId),
      )
      .every(
        (reservation, index) =>
          canonicalJson(reservation) === canonicalJson(value[index]),
      )
  );
}

function assertExternalAuditRoot(value: string | undefined): string {
  if (value === undefined) {
    throw workflowError(
      'TASK_MANDATE_AUDIT_ROOT_REQUIRED',
      'Task Mandate authorization requires an explicit repository-external audit root.',
      ExitCode.unsafeEnvironment,
    );
  }
  return assertExternalAuditRootPath(value);
}

function assertExternalAuditRootPath(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw mandateInvalid(
      'Task mandate external audit root must be an exact absolute path.',
    );
  }
  return value;
}

function assertMandateId(value: string): string {
  if (!MANDATE_ID.test(value)) {
    throw mandateInvalid('Task mandate ID must be a UUID v4.');
  }
  return value;
}

function assertIntent(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 4096 ||
    containsControlCharacter(value)
  ) {
    throw mandateInvalid('Task mandate intent is invalid.');
  }
  return value;
}

function assertRevocationReason(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 1024 ||
    containsControlCharacter(value)
  ) {
    throw mandateInvalid('Task mandate revocation reason is invalid.');
  }
  return value;
}

function assertSignature(value: string): void {
  if (!SIGNATURE.test(value)) {
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature is not canonical armored SSH signature data.',
      ExitCode.verification,
    );
  }
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw mandateInvalid('Task mandate timestamp is invalid.');
  }
  return date;
}

function exactTimestamp(value: string): number | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date.getTime()
    : undefined;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function isWorkflowFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

function mandateInvalid(message: string) {
  return workflowError('TASK_MANDATE_INVALID', message, ExitCode.guard);
}

function unsafeStore() {
  return workflowError(
    'TASK_MANDATE_STORE_UNSAFE',
    'Task mandate storage is malformed or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}
