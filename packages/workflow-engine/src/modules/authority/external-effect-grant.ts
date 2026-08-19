import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deriveAuthorityAuditRepositoryId } from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  appendExternalEffectAuthorityAudit,
  type ExternalEffectAuthorityAuditOptions,
} from '../../runtime/storage-journal/external-effect-audit.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import {
  inspectActiveTaskMandateBinding,
  withActiveTaskMandateBinding,
  type TaskMandateBinding,
} from './task-mandate.ts';

export const EXTERNAL_EFFECT_SIGNATURE_NAMESPACE =
  'HARNESS_EXTERNAL_EFFECT_GRANT_V1' as const;
export const EXTERNAL_EFFECT_MAX_TTL_SECONDS = 5 * 60;
export const PUBLISH_TRANSACTION_ENV =
  'HARNESS_PUBLISH_TRANSACTION_TOKEN' as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF_NAME = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/;
const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;

const EFFECT_KINDS = [
  'publish-git-ref',
  'force-push-git-ref',
  'deploy-production',
  'delete-remote-resource',
  'send-external-message',
  'database-write',
  'provider-budget-expansion',
  'secret-scope-expansion',
] as const;

/**
 * Effect kinds with an in-process production executor. The broader schema is
 * retained so durable historical grants remain inspectable, but issuance must
 * never imply executable support that the engine does not actually possess.
 */
export const PRODUCTION_EXTERNAL_EFFECT_EXECUTOR_KINDS = [
  'publish-git-ref',
] as const satisfies readonly (typeof EFFECT_KINDS)[number][];

const _AUDIT_EVENT_TYPES = [
  'grant-issued',
  'grant-reserved',
  'dispatch-issued',
  'effect-observed',
  'grant-consumed',
  'grant-revoked',
  'grant-expired',
  'grant-failed',
  'manual-reconciliation',
  'reconciliation-resolved',
] as const;

export type Sha256Digest = `sha256:${string}`;
export type ExternalEffectKind = (typeof EFFECT_KINDS)[number];
export type ExternalEffectAuditEventType = (typeof _AUDIT_EVENT_TYPES)[number];

export type ExternalEffectGitRefTarget = {
  kind: 'git-ref';
  remoteName: string;
  remoteUrl: string;
  refName: string;
  sourceOid: string;
  expectedRemoteOid: string | null;
};

export type ExternalEffectResourceTarget = {
  kind: 'external-resource';
  service: string;
  resource: string;
};

export type ExternalEffectTarget =
  ExternalEffectGitRefTarget | ExternalEffectResourceTarget;

export type ExternalEffectRollbackPlan = {
  kind: 'restore-git-ref' | 'operator-procedure';
  planDigest: Sha256Digest;
};

export type ExternalEffectGrantRequest = {
  mandateBinding: TaskMandateBinding;
  effectKind: ExternalEffectKind;
  target: ExternalEffectTarget;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  rollbackPlan: ExternalEffectRollbackPlan | null;
  ttlSeconds?: number;
  idempotencyKey: string;
};

export type ExternalEffectGrantPayload = {
  kind: 'external-effect-grant.v1';
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  externalAuditRoot: string;
  changeId: string;
  mandateId: string;
  taskId: string;
  mandateDigest: string;
  effectKind: ExternalEffectKind;
  target: ExternalEffectTarget;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  rollbackPlan: ExternalEffectRollbackPlan | null;
  issuedAt: string;
  expiresAt: string;
  uses: 1;
  idempotencyKey: string;
  signer: string;
};

export type ExternalEffectGrantEnvelope = {
  payload: ExternalEffectGrantPayload;
  signature: string;
};

export type ExternalEffectObservation = {
  schemaVersion: 1;
  kind: 'external-effect-observation';
  grantId: string;
  transactionId: string;
  idempotencyKey: string;
  externalReceiptId: string;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest;
  observedAt: string;
  receiptDigest: Sha256Digest;
};

export type ExternalEffectReconciliationOutcome =
  'succeeded' | 'rolled-back' | 'failed';

export type ExternalEffectReconciliationRequest = {
  outcome: ExternalEffectReconciliationOutcome;
  evidenceDigest: Sha256Digest;
  externalReceiptId: string | null;
  poststateDigest: Sha256Digest | null;
  observedAt: string;
  reason: string;
};

export type ExternalEffectReconciliation = Readonly<{
  schemaVersion: 1;
  kind: 'external-effect-reconciliation.v1';
  grantId: string;
  grantDigest: Sha256Digest;
  transactionId: string;
  manualReconciliationReceiptDigest: Sha256Digest;
  outcome: ExternalEffectReconciliationOutcome;
  evidenceDigest: Sha256Digest;
  externalReceiptId: string | null;
  poststateDigest: Sha256Digest | null;
  observedAt: string;
  reason: string;
  resolver: string;
  resolvedAt: string;
  receiptDigest: Sha256Digest;
}>;

export type ExternalEffectAuditEvent = Readonly<{
  schemaVersion: 1;
  eventId: Sha256Digest;
  eventType: ExternalEffectAuditEventType;
  occurredAt: string;
  repositoryId: string;
  externalAuditRoot: string;
  changeId: string;
  taskId: string;
  mandateId: string;
  mandateDigest: string;
  effectKind: ExternalEffectKind;
  targetDigest: Sha256Digest;
  effectIdempotencyDigest: Sha256Digest;
  grantId: string;
  grantDigest: Sha256Digest;
  transactionId: string | null;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest | null;
  evidenceDigest: Sha256Digest | null;
  resolver: string | null;
  result:
    | 'authorized'
    | 'reserved'
    | 'issued'
    | 'observed'
    | 'consumed'
    | 'revoked'
    | 'expired'
    | 'failed'
    | 'manual-reconciliation'
    | 'reconciled-succeeded'
    | 'reconciled-rolled-back'
    | 'reconciled-failed';
  reason: string | null;
}>;

export type ExternalEffectGrantInspection = {
  grantId: string;
  grantDigest: Sha256Digest;
  state:
    | 'available'
    | 'reserved'
    | 'dispatch-issued'
    | 'effect-observed'
    | 'consumed'
    | 'revoked'
    | 'expired'
    | 'failed'
    | 'manual-reconciliation'
    | 'reconciled-succeeded'
    | 'reconciled-rolled-back'
    | 'reconciled-failed';
  payload: ExternalEffectGrantPayload;
  transactionId: string | null;
  transactionToken: string | null;
  observation: ExternalEffectObservation | null;
  reconciliation: ExternalEffectReconciliation | null;
  terminalAt: string | null;
  terminalReason: string | null;
};

export type ExternalEffectGrantPublicInspection = Omit<
  ExternalEffectGrantInspection,
  'transactionToken'
> & {
  transactionToken: null;
};

export type ExternalEffectIssueOptions = {
  now?: Date;
  grantId: string;
  signer?: MaintainerSignerProvider;
  onAuditRecord?: ExternalEffectAuthorityAuditOptions['onRecord'];
  testAuditServiceHooks?: ExternalEffectAuthorityAuditOptions['serviceHooks'];
};

export type ExternalEffectTransitionOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  onAuditRecord?: ExternalEffectAuthorityAuditOptions['onRecord'];
  testAuditServiceHooks?: ExternalEffectAuthorityAuditOptions['serviceHooks'];
};

export type ExternalEffectRevokeOptions = ExternalEffectTransitionOptions & {
  reason: string;
};

type AvailableRecord = {
  schemaVersion: 1;
  kind: 'external-effect-available';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  recordDigest: Sha256Digest;
};

type PendingRecord = {
  schemaVersion: 1;
  kind: 'external-effect-pending';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  recordDigest: Sha256Digest;
};

type IdempotencyRecord = {
  schemaVersion: 1;
  kind: 'external-effect-idempotency';
  idempotencyKey: string;
  grantId: string;
  grantDigest: Sha256Digest;
  recordDigest: Sha256Digest;
};

type TransactionRecord = {
  schemaVersion: 1;
  kind: 'external-effect-transaction';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  transactionId: string;
  transactionToken: string;
  phase: 'reserved' | 'dispatch-issued' | 'effect-observed';
  reservedAt: string;
  dispatchIssuedAt: string | null;
  effectObservedAt: string | null;
  observation: ExternalEffectObservation | null;
  recordDigest: Sha256Digest;
};

type TerminalState =
  'consumed' | 'revoked' | 'expired' | 'failed' | 'manual-reconciliation';

type TerminalRecord = {
  schemaVersion: 1;
  kind: 'external-effect-terminal';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  transactionId: string | null;
  state: TerminalState;
  observation: ExternalEffectObservation | null;
  terminalAt: string;
  reason: string | null;
  previousRecordDigest: Sha256Digest;
  receiptDigest: Sha256Digest;
};

type StoreState =
  | { kind: 'available'; record: AvailableRecord }
  | { kind: 'transaction'; record: TransactionRecord }
  | {
      kind: 'terminal';
      record: TerminalRecord;
      reconciliation: ExternalEffectReconciliation | null;
    };

const PAYLOAD_KEYS = [
  'kind',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'baseCommit',
  'policyBlob',
  'externalAuditRoot',
  'changeId',
  'mandateId',
  'taskId',
  'mandateDigest',
  'effectKind',
  'target',
  'artifactDigest',
  'prestateDigest',
  'rollbackPlan',
  'issuedAt',
  'expiresAt',
  'uses',
  'idempotencyKey',
  'signer',
] as const;

export function externalEffectStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'external-effect-grants');
  return {
    runtime,
    root,
    pending: path.join(root, 'pending'),
    available: path.join(root, 'available'),
    transactions: path.join(root, 'transactions'),
    terminal: path.join(root, 'terminal'),
    idempotency: path.join(root, 'idempotency'),
  };
}

export function canonicalExternalEffectGrantPayload(
  payload: ExternalEffectGrantPayload,
): string {
  return `${canonicalJson(parsePayload(payload))}\n`;
}

export function canonicalExternalEffectGrantEnvelope(
  envelope: ExternalEffectGrantEnvelope,
): string {
  return `${canonicalJson(parseEnvelope(envelope))}\n`;
}

export function parseExternalEffectGrantEnvelope(
  raw: string,
): ExternalEffectGrantEnvelope {
  if (Buffer.byteLength(raw) > 16 * 1024) throw invalidGrant();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidGrant();
  }
  const envelope = parseEnvelope(value);
  if (canonicalExternalEffectGrantEnvelope(envelope) !== raw) {
    throw invalidGrant();
  }
  return envelope;
}

export function issueExternalEffectGrant(
  cwd: string,
  request: ExternalEffectGrantRequest,
  options: ExternalEffectIssueOptions,
): {
  grantId: string;
  grantDigest: Sha256Digest;
  recordPath: string;
  envelope: ExternalEffectGrantEnvelope;
} {
  const parsed = parseRequest(request);
  const now = exactDate(options.now ?? new Date());
  const ttlSeconds = parsed.ttlSeconds ?? EXTERNAL_EFFECT_MAX_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > EXTERNAL_EFFECT_MAX_TTL_SECONDS
  ) {
    throw invalidGrant();
  }
  const grantId = assertUuid(options.grantId);
  const trust = loadTrustContext(cwd);
  const activeMandateBinding = inspectActiveTaskMandateBinding(
    trust.repository.repositoryRoot,
    parsed.mandateBinding.mandateTaskId,
    { now, signer: options.signer },
  );
  const refusalBinding = externalEffectRefusalBinding(
    trust.repository.repositoryRoot,
    trust.policy.repository.id,
    activeMandateBinding,
    grantId,
    parsed,
  );
  const refusalOptions = {
    now,
    serviceHooks: options.testAuditServiceHooks,
  };
  withAuthorityRefusalAudit(refusalBinding, refusalOptions, () => {
    if (
      canonicalJson(activeMandateBinding) !==
      canonicalJson(parsed.mandateBinding)
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_MANDATE_MISMATCH',
        'External effect grant does not match the exact active Task Mandate.',
        ExitCode.staleState,
      );
    }
    assertProductionExternalEffectExecutor(parsed.effectKind);
  });
  const paths = externalEffectStorePaths(trust.repository.gitCommonDirectory);
  const pendingPath = grantPath(paths.pending, grantId);
  const recoveredPendingRaw = readOptionalPrivateFile(pendingPath);
  const { envelope, grantDigest } = withAuthorityRefusalAudit(
    refusalBinding,
    refusalOptions,
    () => {
      if (recoveredPendingRaw !== null) {
        const pending = parsePending(recoveredPendingRaw);
        validateEnvelopeForRepository(
          trust.repository.repositoryRoot,
          pending.envelope,
          options.signer,
        );
        assertPendingMatchesRequest(
          pending,
          parsed,
          grantId,
          ttlSeconds,
          trust.repository.head,
        );
        if (expired(pending.envelope.payload, now)) {
          throw workflowError(
            'EXTERNAL_EFFECT_GRANT_STALE',
            'Pending external effect grant expired before audit recovery.',
            ExitCode.staleState,
          );
        }
        return {
          envelope: pending.envelope,
          grantDigest: pending.grantDigest,
        };
      }
      const signer =
        options.signer ??
        createInteractiveSshSigner(
          trust.repository.repositoryRoot,
          trust.policy,
        );
      signer.assertHumanPresent();
      const identity = signer.identity();
      assertTrustedSigner(trust.policy, identity);
      const payload: ExternalEffectGrantPayload = parsePayload({
        kind: 'external-effect-grant.v1',
        grantId,
        repositoryId: trust.policy.repository.id,
        repositoryOrigin: trust.policy.repository.origin,
        baseCommit: trust.repository.head,
        policyBlob: trust.policyBlob,
        externalAuditRoot: assertExternalAuditRoot(
          activeMandateBinding.externalAuditRoot,
          trust.repository.repositoryRoot,
        ),
        changeId: activeMandateBinding.changeId,
        mandateId: activeMandateBinding.mandateId,
        taskId: activeMandateBinding.mandateTaskId,
        mandateDigest: activeMandateBinding.mandateDigest,
        effectKind: parsed.effectKind,
        target: parsed.target,
        artifactDigest: parsed.artifactDigest,
        prestateDigest: parsed.prestateDigest,
        rollbackPlan: parsed.rollbackPlan,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        uses: 1,
        idempotencyKey: parsed.idempotencyKey,
        signer: identity,
      });
      let signature: string;
      try {
        signature = signer.sign(
          canonicalExternalEffectGrantPayload(payload),
          EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
        );
        assertSignature(signature);
        signer.verify(
          canonicalExternalEffectGrantPayload(payload),
          signature,
          identity,
          EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
        );
      } catch (error) {
        if (isWorkflowFailure(error)) throw error;
        throw workflowError(
          'EXTERNAL_EFFECT_SIGNATURE_INVALID',
          'External effect grant signature could not be created or verified.',
          ExitCode.verification,
        );
      }
      const issuedEnvelope = parseEnvelope({ payload, signature });
      return {
        envelope: issuedEnvelope,
        grantDigest: sha256(
          canonicalExternalEffectGrantEnvelope(issuedEnvelope),
        ),
      };
    },
  );
  const record = createAvailableRecord(envelope, grantDigest);
  const recordPath = grantPath(paths.available, grantId);

  return withAuthorityRefusalAudit(refusalBinding, refusalOptions, () =>
    withActiveTaskMandateBinding(
      trust.repository.repositoryRoot,
      activeMandateBinding.mandateTaskId,
      { now, signer: options.signer },
      (binding, assertOwned) => {
        if (canonicalJson(binding) !== canonicalJson(parsed.mandateBinding)) {
          throw workflowError(
            'EXTERNAL_EFFECT_MANDATE_MISMATCH',
            'External effect grant does not match the exact active Task Mandate.',
            ExitCode.staleState,
          );
        }
        const current = discoverRepository(trust.repository.repositoryRoot);
        if (current.head !== trust.repository.head) {
          throw workflowError(
            'EXTERNAL_EFFECT_GRANT_STALE',
            'Repository HEAD moved before external effect grant publication.',
            ExitCode.staleState,
          );
        }
        ensureStore(paths);
        const observedPendingRaw = readOptionalPrivateFile(pendingPath);
        if (observedPendingRaw === null) {
          assertGrantAbsent(paths, grantId);
          createPrivateFileAtomic(
            pendingPath,
            canonicalPending(createPendingRecord(envelope, grantDigest)),
          );
        } else if (
          canonicalPending(parsePending(observedPendingRaw)) !==
          canonicalPending(createPendingRecord(envelope, grantDigest))
        ) {
          throw unsafeStore();
        }
        assertIdempotencyAvailable(
          paths,
          envelope.payload.idempotencyKey,
          grantId,
          grantDigest,
        );
        assertOwned();
        emitAudit(
          trust.repository.repositoryRoot,
          options,
          auditInput(
            envelope,
            grantDigest,
            'grant-issued',
            new Date(envelope.payload.issuedAt),
            {
              result: 'authorized',
            },
          ),
        );
        assertOwned();
        createIdempotencyIndex(
          paths,
          envelope.payload.idempotencyKey,
          grantId,
          grantDigest,
        );
        const existingAvailable = readOptionalPrivateFile(recordPath);
        if (existingAvailable === null) {
          createPrivateFileAtomic(recordPath, canonicalAvailable(record));
        } else if (
          canonicalAvailable(parseAvailable(existingAvailable)) !==
          canonicalAvailable(record)
        ) {
          throw unsafeStore();
        }
        unlinkIfExact(
          pendingPath,
          canonicalPending(createPendingRecord(envelope, grantDigest)),
        );
        assertOwned();
        return { grantId, grantDigest, recordPath, envelope };
      },
    ),
  );
}

function externalEffectRefusalBinding(
  repositoryRoot: string,
  repositoryIdentity: string,
  mandateBinding: TaskMandateBinding,
  grantId: string,
  request: ExternalEffectGrantRequest,
): AuthorityRefusalAuditBinding {
  const bindingDigest = authorityRefusalDigest(mandateBinding);
  return {
    scope: {
      externalAuditRoot: mandateBinding.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(repositoryIdentity),
    },
    family: 'external-effect',
    operation: 'external-effect.issue',
    subjectId: grantId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: mandateBinding.mandateTaskId,
    changeId: mandateBinding.changeId,
    workflowId: mandateBinding.mandateId,
    grantDigest: bindingDigest,
    bindingDigest,
    refusalIdentity: {
      grantId,
      effectKind: request.effectKind,
      artifactDigest: request.artifactDigest,
      prestateDigest: request.prestateDigest,
      idempotencyKey: request.idempotencyKey,
    },
  };
}

/**
 * Construct refusal authority only from an already repository-validated,
 * domain-signed grant. The caller-supplied request never selects the audit
 * root, repository identity, task correlation, or grant digest.
 */
function storedExternalEffectRefusalBinding(
  repositoryRoot: string,
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
  operation: string,
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const mandateBinding: TaskMandateBinding = {
    schemaVersion: 1,
    mandateTaskId: envelope.payload.taskId,
    mandateId: envelope.payload.mandateId,
    mandateDigest: envelope.payload.mandateDigest,
    changeId: envelope.payload.changeId,
    externalAuditRoot: envelope.payload.externalAuditRoot,
  };
  const bindingDigest = authorityRefusalDigest(mandateBinding);
  return {
    scope: {
      externalAuditRoot: envelope.payload.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(
        envelope.payload.repositoryId,
      ),
    },
    family: 'external-effect',
    operation,
    subjectId: envelope.payload.grantId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: envelope.payload.taskId,
    changeId: envelope.payload.changeId,
    workflowId: envelope.payload.mandateId,
    grantDigest,
    bindingDigest,
    refusalIdentity,
  };
}

function refusalAuditOptions(
  now: Date,
  options: Pick<ExternalEffectTransitionOptions, 'testAuditServiceHooks'>,
) {
  return { now, serviceHooks: options.testAuditServiceHooks };
}

function assertProductionExternalEffectExecutor(
  effectKind: ExternalEffectKind,
): void {
  if (
    !(PRODUCTION_EXTERNAL_EFFECT_EXECUTOR_KINDS as readonly string[]).includes(
      effectKind,
    )
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_EXECUTOR_UNAVAILABLE',
      `External effect kind ${effectKind} has no production executor; no grant was issued.`,
      ExitCode.guard,
    );
  }
}

export function inspectExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  options: { now?: Date; signer?: MaintainerSignerProvider } = {},
): ExternalEffectGrantPublicInspection {
  return redactTransactionToken(
    inspectExternalEffectGrantForExecutor(cwd, requestedGrantId, options),
  );
}

/** Engine-internal inspection used only by the production effect executor. */
export function inspectExternalEffectGrantForExecutor(
  cwd: string,
  requestedGrantId: string,
  options: { now?: Date; signer?: MaintainerSignerProvider } = {},
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const state = readStoreState(paths, grantId);
  validateEnvelopeForRepository(
    repository.repositoryRoot,
    state.record.envelope,
    options.signer,
  );
  return inspectionFromState(state, exactDate(options.now ?? new Date()));
}

export function reserveExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const state = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      state.record.envelope,
      options.signer,
    );
    if (state.kind === 'terminal' || state.kind === 'transaction') {
      return inspectionFromState(state, now);
    }
    if (expired(state.record.envelope.payload, now)) {
      return terminalize(
        repository.repositoryRoot,
        paths,
        state,
        'expired',
        now,
        'Grant expired before reservation.',
        options,
        assertOwned,
      );
    }
    const transaction = createTransactionRecord(state.record, grantId, now);
    assertOwned();
    emitAudit(
      repository.repositoryRoot,
      options,
      auditInput(
        transaction.envelope,
        transaction.grantDigest,
        'grant-reserved',
        now,
        { transactionId: transaction.transactionId, result: 'reserved' },
      ),
    );
    assertOwned();
    createPrivateFileAtomic(
      grantPath(paths.transactions, grantId),
      canonicalTransaction(transaction),
    );
    unlinkIfExact(
      grantPath(paths.available, grantId),
      canonicalAvailable(state.record),
    );
    assertOwned();
    return inspectionFromState(
      { kind: 'transaction', record: transaction },
      now,
    );
  });
}

export function markExternalEffectDispatchIssued(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  return transitionTransaction(
    cwd,
    requestedGrantId,
    requestedTransactionId,
    options,
    'dispatch-issued',
  );
}

export function recordExternalEffectObservation(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  requestedObservation: Omit<
    ExternalEffectObservation,
    | 'schemaVersion'
    | 'kind'
    | 'grantId'
    | 'transactionId'
    | 'idempotencyKey'
    | 'receiptDigest'
  >,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const transactionId = assertUuid(requestedTransactionId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const state = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      state.record.envelope,
      options.signer,
    );
    return withAuthorityRefusalAudit(
      storedExternalEffectRefusalBinding(
        repository.repositoryRoot,
        state.record.envelope,
        state.record.grantDigest,
        'external-effect.observation',
        { transactionId, requestedObservation },
      ),
      refusalAuditOptions(now, options),
      () => {
        if (state.kind === 'terminal') return inspectionFromState(state, now);
        if (state.kind !== 'transaction') throw stateConflict();
        assertTransactionId(state.record, transactionId);
        if (state.record.phase === 'effect-observed') {
          const expected = createObservation(
            state.record,
            requestedObservation,
          );
          if (
            canonicalJson(expected) !== canonicalJson(state.record.observation)
          ) {
            throw stateConflict();
          }
          return inspectionFromState(state, now);
        }
        if (state.record.phase !== 'dispatch-issued') throw stateConflict();
        const observation = createObservation(
          state.record,
          requestedObservation,
        );
        assertObservationClock(observation, state.record, now);
        const next = replaceTransactionDigest({
          ...state.record,
          phase: 'effect-observed',
          effectObservedAt: observation.observedAt,
          observation,
        });
        assertOwned();
        emitAudit(
          repository.repositoryRoot,
          options,
          auditInput(next.envelope, next.grantDigest, 'effect-observed', now, {
            transactionId,
            poststateDigest: observation.poststateDigest,
            result: 'observed',
          }),
        );
        assertOwned();
        replacePrivateFileAtomic(
          grantPath(paths.transactions, grantId),
          canonicalTransaction(next),
        );
        assertOwned();
        return inspectionFromState({ kind: 'transaction', record: next }, now);
      },
    );
  });
}

export function consumeExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const transactionId = assertUuid(requestedTransactionId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const state = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      state.record.envelope,
      options.signer,
    );
    return withAuthorityRefusalAudit(
      storedExternalEffectRefusalBinding(
        repository.repositoryRoot,
        state.record.envelope,
        state.record.grantDigest,
        'external-effect.consume',
        { transactionId },
      ),
      refusalAuditOptions(now, options),
      () => {
        if (state.kind === 'terminal') return inspectionFromState(state, now);
        if (
          state.kind !== 'transaction' ||
          state.record.phase !== 'effect-observed' ||
          !state.record.observation
        ) {
          throw stateConflict();
        }
        assertTransactionId(state.record, transactionId);
        return terminalize(
          repository.repositoryRoot,
          paths,
          state,
          'consumed',
          now,
          null,
          options,
          assertOwned,
        );
      },
    );
  });
}

export function terminalizeExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  state: 'failed' | 'manual-reconciliation',
  reason: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const transactionId = assertUuid(requestedTransactionId);
  const terminalReason = assertReason(reason);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const current = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      current.record.envelope,
      options.signer,
    );
    return withAuthorityRefusalAudit(
      storedExternalEffectRefusalBinding(
        repository.repositoryRoot,
        current.record.envelope,
        current.record.grantDigest,
        'external-effect.terminalize',
        { transactionId, state, terminalReason },
      ),
      refusalAuditOptions(now, options),
      () => {
        if (current.kind === 'terminal')
          return inspectionFromState(current, now);
        if (current.kind !== 'transaction') throw stateConflict();
        assertTransactionId(current.record, transactionId);
        if (current.record.phase === 'effect-observed') throw stateConflict();
        return terminalize(
          repository.repositoryRoot,
          paths,
          current,
          state,
          now,
          terminalReason,
          options,
          assertOwned,
        );
      },
    );
  });
}

/**
 * Resolve an already-terminal unknown dispatch from independently observed
 * evidence. This API deliberately has no runner or dispatch dependency: it
 * can record what the human observed, but it can never replay the effect.
 * Audit scope and task correlation come only from the signed grant envelope.
 */
export function reconcileExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  requestedReconciliation: ExternalEffectReconciliationRequest,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantPublicInspection {
  const grantId = assertUuid(requestedGrantId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  const initial = readStoreState(paths, grantId);
  validateEnvelopeForRepository(
    repository.repositoryRoot,
    initial.record.envelope,
    options.signer,
  );
  return withAuthorityRefusalAudit(
    storedExternalEffectRefusalBinding(
      repository.repositoryRoot,
      initial.record.envelope,
      initial.record.grantDigest,
      'external-effect.reconcile',
      { requestedReconciliation },
    ),
    refusalAuditOptions(now, options),
    () => {
      assertManualReconciliationState(initial);
      const request = parseReconciliationRequest(
        requestedReconciliation,
        initial.record,
        now,
      );
      const trust = loadTrustForPayload(
        repository.repositoryRoot,
        initial.record.envelope.payload,
      );
      const signer =
        options.signer ??
        createInteractiveSshSigner(repository.repositoryRoot, trust.policy);
      signer.assertHumanPresent();
      const resolver = signer.identity();
      assertTrustedSigner(trust.policy, resolver);

      return redactTransactionToken(
        withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
          const current = readStoreState(paths, grantId);
          validateEnvelopeForRepository(
            repository.repositoryRoot,
            current.record.envelope,
            options.signer,
          );
          assertManualReconciliationState(current);
          const exactRequest = parseReconciliationRequest(
            request,
            current.record,
            now,
          );
          if (current.reconciliation) {
            assertReconciliationReplay(
              current.reconciliation,
              exactRequest,
              resolver,
            );
            return inspectionFromState(current, now);
          }
          const reconciliation = createReconciliationRecord(
            current.record,
            exactRequest,
            resolver,
            now,
          );
          assertOwned();
          emitAudit(
            repository.repositoryRoot,
            options,
            auditInput(
              current.record.envelope,
              current.record.grantDigest,
              'reconciliation-resolved',
              now,
              {
                transactionId: current.record.transactionId,
                poststateDigest: reconciliation.poststateDigest,
                evidenceDigest: reconciliation.evidenceDigest,
                resolver,
                result: `reconciled-${reconciliation.outcome}`,
                reason: reconciliation.reason,
              },
            ),
          );
          assertOwned();
          createPrivateFileAtomic(
            reconciliationPath(paths, grantId),
            canonicalReconciliation(reconciliation),
          );
          assertOwned();
          return inspectionFromState(
            { kind: 'terminal', record: current.record, reconciliation },
            now,
          );
        }),
      );
    },
  );
}

export function revokeExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  options: ExternalEffectRevokeOptions,
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const reason = assertReason(options.reason);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  const initial = readStoreState(paths, grantId);
  validateEnvelopeForRepository(
    repository.repositoryRoot,
    initial.record.envelope,
    options.signer,
  );
  return withAuthorityRefusalAudit(
    storedExternalEffectRefusalBinding(
      repository.repositoryRoot,
      initial.record.envelope,
      initial.record.grantDigest,
      'external-effect.revoke',
      { reason },
    ),
    refusalAuditOptions(now, options),
    () => {
      const trust = loadTrustForPayload(
        repository.repositoryRoot,
        initial.record.envelope.payload,
      );
      const signer =
        options.signer ??
        createInteractiveSshSigner(repository.repositoryRoot, trust.policy);
      signer.assertHumanPresent();
      assertTrustedSigner(trust.policy, signer.identity());
      return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        const current = readStoreState(paths, grantId);
        validateEnvelopeForRepository(
          repository.repositoryRoot,
          current.record.envelope,
          options.signer,
        );
        if (current.kind === 'terminal')
          return inspectionFromState(current, now);
        if (
          current.kind === 'transaction' &&
          current.record.phase !== 'reserved'
        ) {
          throw workflowError(
            'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED',
            'A dispatched external effect cannot be revoked without reconciliation.',
            ExitCode.guard,
          );
        }
        return terminalize(
          repository.repositoryRoot,
          paths,
          current,
          'revoked',
          now,
          reason,
          options,
          assertOwned,
        );
      });
    },
  );
}

export function assertActivePublishTransaction(
  cwd: string,
  hookArgs: string[],
  environment: NodeJS.ProcessEnv = process.env,
  signer?: MaintainerSignerProvider,
): ExternalEffectGrantInspection {
  const token = environment[PUBLISH_TRANSACTION_ENV];
  if (!token) throw publishTransactionRequired();
  const separator = token.indexOf('.');
  if (separator < 1) throw publishTransactionInvalid();
  const grantId = assertUuidForPublish(token.slice(0, separator));
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  let state: StoreState;
  try {
    state = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      state.record.envelope,
      signer,
    );
  } catch {
    throw publishTransactionInvalid();
  }
  if (
    state.kind !== 'transaction' ||
    state.record.phase !== 'dispatch-issued' ||
    state.record.transactionToken !== token ||
    state.record.envelope.payload.effectKind !== 'publish-git-ref' ||
    state.record.envelope.payload.target.kind !== 'git-ref' ||
    hookArgs.length !== 2 ||
    hookArgs[0] !== state.record.envelope.payload.target.remoteName ||
    hookArgs[1] !== state.record.envelope.payload.target.remoteUrl
  ) {
    throw publishTransactionInvalid();
  }
  const target = state.record.envelope.payload.target;
  const resolved = runGit(repository.repositoryRoot, [
    'rev-parse',
    '--verify',
    target.sourceOid,
  ]).trim();
  if (resolved !== target.sourceOid || repository.head !== target.sourceOid) {
    throw publishTransactionInvalid();
  }
  return inspectionFromState(state, new Date());
}

function transitionTransaction(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  options: ExternalEffectTransitionOptions,
  phase: 'dispatch-issued',
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const transactionId = assertUuid(requestedTransactionId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const now = exactDate(options.now ?? new Date());
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const state = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      state.record.envelope,
      options.signer,
    );
    if (state.kind === 'terminal') return inspectionFromState(state, now);
    if (state.kind !== 'transaction') throw stateConflict();
    assertTransactionId(state.record, transactionId);
    if (
      state.record.phase === phase ||
      state.record.phase === 'effect-observed'
    ) {
      return inspectionFromState(state, now);
    }
    if (state.record.phase !== 'reserved') throw stateConflict();
    if (expired(state.record.envelope.payload, now)) {
      return terminalize(
        repository.repositoryRoot,
        paths,
        state,
        'expired',
        now,
        'Grant expired before dispatch.',
        options,
        assertOwned,
      );
    }
    const next = replaceTransactionDigest({
      ...state.record,
      phase,
      dispatchIssuedAt: now.toISOString(),
    });
    assertOwned();
    emitAudit(
      repository.repositoryRoot,
      options,
      auditInput(next.envelope, next.grantDigest, 'dispatch-issued', now, {
        transactionId,
        result: 'issued',
      }),
    );
    assertOwned();
    replacePrivateFileAtomic(
      grantPath(paths.transactions, grantId),
      canonicalTransaction(next),
    );
    assertOwned();
    return inspectionFromState({ kind: 'transaction', record: next }, now);
  });
}

function terminalize(
  repositoryRoot: string,
  paths: ReturnType<typeof externalEffectStorePaths>,
  state: StoreState,
  terminalState: TerminalState,
  now: Date,
  reason: string | null,
  auditOptions: ExternalEffectTransitionOptions,
  assertOwned: () => void,
): ExternalEffectGrantInspection {
  if (state.kind === 'terminal') return inspectionFromState(state, now);
  const previousRecordDigest = state.record.recordDigest;
  const observation =
    state.kind === 'transaction' ? state.record.observation : null;
  const transactionId =
    state.kind === 'transaction' ? state.record.transactionId : null;
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: 'external-effect-terminal' as const,
    grantDigest: state.record.grantDigest,
    envelope: state.record.envelope,
    transactionId,
    state: terminalState,
    observation,
    terminalAt: now.toISOString(),
    reason,
    previousRecordDigest,
  };
  const terminal: TerminalRecord = {
    ...withoutDigest,
    receiptDigest: sha256(canonicalJson(withoutDigest)),
  };
  const eventType: ExternalEffectAuditEventType =
    terminalState === 'consumed'
      ? 'grant-consumed'
      : terminalState === 'revoked'
        ? 'grant-revoked'
        : terminalState === 'expired'
          ? 'grant-expired'
          : terminalState === 'failed'
            ? 'grant-failed'
            : 'manual-reconciliation';
  assertOwned();
  emitAudit(
    repositoryRoot,
    auditOptions,
    auditInput(terminal.envelope, terminal.grantDigest, eventType, now, {
      transactionId,
      poststateDigest: observation?.poststateDigest ?? null,
      result: terminalState,
      reason,
    }),
  );
  assertOwned();
  createPrivateFileAtomic(
    grantPath(paths.terminal, terminal.envelope.payload.grantId),
    canonicalTerminal(terminal),
  );
  if (state.kind === 'available') {
    unlinkIfExact(
      grantPath(paths.available, terminal.envelope.payload.grantId),
      canonicalAvailable(state.record),
    );
  }
  assertOwned();
  return inspectionFromState(
    { kind: 'terminal', record: terminal, reconciliation: null },
    now,
  );
}

function inspectionFromState(
  state: StoreState,
  now: Date,
): ExternalEffectGrantInspection {
  if (state.kind === 'available') {
    return {
      grantId: state.record.envelope.payload.grantId,
      grantDigest: state.record.grantDigest,
      state: expired(state.record.envelope.payload, now)
        ? 'expired'
        : 'available',
      payload: state.record.envelope.payload,
      transactionId: null,
      transactionToken: null,
      observation: null,
      reconciliation: null,
      terminalAt: null,
      terminalReason: null,
    };
  }
  if (state.kind === 'transaction') {
    return {
      grantId: state.record.envelope.payload.grantId,
      grantDigest: state.record.grantDigest,
      state: state.record.phase,
      payload: state.record.envelope.payload,
      transactionId: state.record.transactionId,
      transactionToken: state.record.transactionToken,
      observation: state.record.observation,
      reconciliation: null,
      terminalAt: null,
      terminalReason: null,
    };
  }
  return {
    grantId: state.record.envelope.payload.grantId,
    grantDigest: state.record.grantDigest,
    state: state.reconciliation
      ? (`reconciled-${state.reconciliation.outcome}` as const)
      : state.record.state,
    payload: state.record.envelope.payload,
    transactionId: state.record.transactionId,
    transactionToken: null,
    observation: state.record.observation,
    reconciliation: state.reconciliation,
    terminalAt: state.record.terminalAt,
    terminalReason: state.record.reason,
  };
}

function redactTransactionToken(
  inspection: ExternalEffectGrantInspection,
): ExternalEffectGrantPublicInspection {
  return { ...inspection, transactionToken: null };
}

function readStoreState(
  paths: ReturnType<typeof externalEffectStorePaths>,
  grantId: string,
): StoreState {
  assertStore(paths);
  const availablePath = grantPath(paths.available, grantId);
  const transactionPath = grantPath(paths.transactions, grantId);
  const terminalPath = grantPath(paths.terminal, grantId);
  const resolvedPath = reconciliationPath(paths, grantId);
  const available = readOptionalPrivateFile(availablePath);
  const transaction = readOptionalPrivateFile(transactionPath);
  const terminal = readOptionalPrivateFile(terminalPath);
  const resolved = readOptionalPrivateFile(resolvedPath);
  if (!available && !transaction && !terminal) {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_NOT_FOUND',
      `External effect grant ${grantId} was not found.`,
      ExitCode.guard,
    );
  }
  let availableRecord: AvailableRecord | null;
  let transactionRecord: TransactionRecord | null;
  let terminalRecord: TerminalRecord | null;
  let reconciliation: ExternalEffectReconciliation | null;
  try {
    availableRecord = available ? parseAvailable(available) : null;
    transactionRecord = transaction ? parseTransaction(transaction) : null;
    terminalRecord = terminal ? parseTerminal(terminal) : null;
    reconciliation =
      resolved && terminalRecord
        ? parseReconciliation(resolved, terminalRecord)
        : null;
  } catch {
    throw unsafeStore();
  }
  const records = [availableRecord, transactionRecord, terminalRecord].filter(
    (value): value is AvailableRecord | TransactionRecord | TerminalRecord =>
      value !== null,
  );
  const grantDigests = new Set(records.map(({ grantDigest }) => grantDigest));
  if (
    grantDigests.size !== 1 ||
    records.some(({ envelope }) => envelope.payload.grantId !== grantId)
  ) {
    throw unsafeStore();
  }
  if (
    (resolved !== null && terminalRecord === null) ||
    (reconciliation !== null &&
      terminalRecord?.state !== 'manual-reconciliation')
  ) {
    throw unsafeStore();
  }
  if (terminalRecord)
    return { kind: 'terminal', record: terminalRecord, reconciliation };
  if (transactionRecord)
    return { kind: 'transaction', record: transactionRecord };
  return { kind: 'available', record: availableRecord! };
}

function createAvailableRecord(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
): AvailableRecord {
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-available' as const,
    grantDigest,
    envelope,
  };
  return { ...value, recordDigest: sha256(canonicalJson(value)) };
}

function createPendingRecord(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
): PendingRecord {
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-pending' as const,
    grantDigest,
    envelope,
  };
  return { ...value, recordDigest: sha256(canonicalJson(value)) };
}

function parsePending(raw: string): PendingRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-pending' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const record = createPendingRecord(
    envelope,
    value.grantDigest as Sha256Digest,
  );
  if (
    record.recordDigest !== value.recordDigest ||
    record.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope)) ||
    canonicalPending(record) !== raw
  ) {
    throw unsafeStore();
  }
  return record;
}

function assertPendingMatchesRequest(
  pending: PendingRecord,
  request: ReturnType<typeof parseRequest>,
  grantId: string,
  ttlSeconds: number,
  baseCommit: string,
): void {
  const payload = pending.envelope.payload;
  const expectedBinding = {
    schemaVersion: 1 as const,
    mandateTaskId: payload.taskId,
    mandateId: payload.mandateId,
    mandateDigest: payload.mandateDigest,
    changeId: payload.changeId,
    externalAuditRoot: payload.externalAuditRoot,
  };
  if (
    payload.grantId !== grantId ||
    payload.baseCommit !== baseCommit ||
    canonicalJson(expectedBinding) !== canonicalJson(request.mandateBinding) ||
    payload.effectKind !== request.effectKind ||
    canonicalJson(payload.target) !== canonicalJson(request.target) ||
    payload.artifactDigest !== request.artifactDigest ||
    payload.prestateDigest !== request.prestateDigest ||
    canonicalJson(payload.rollbackPlan) !==
      canonicalJson(request.rollbackPlan) ||
    payload.idempotencyKey !== request.idempotencyKey ||
    Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) !==
      ttlSeconds * 1000
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_EXISTS',
      'Pending external effect grant differs from the exact recovery request.',
      ExitCode.conflict,
    );
  }
}

function createTransactionRecord(
  available: AvailableRecord,
  grantId: string,
  now: Date,
): TransactionRecord {
  return replaceTransactionDigest({
    schemaVersion: 1,
    kind: 'external-effect-transaction',
    grantDigest: available.grantDigest,
    envelope: available.envelope,
    transactionId: grantId,
    transactionToken: `${grantId}.${crypto.randomBytes(32).toString('hex')}`,
    phase: 'reserved',
    reservedAt: now.toISOString(),
    dispatchIssuedAt: null,
    effectObservedAt: null,
    observation: null,
    recordDigest: 'sha256:'.padEnd(71, '0') as Sha256Digest,
  });
}

function replaceTransactionDigest(
  transaction: TransactionRecord,
): TransactionRecord {
  const { recordDigest: _recordDigest, ...value } = transaction;
  return { ...value, recordDigest: sha256(canonicalJson(value)) };
}

function createObservation(
  transaction: TransactionRecord,
  requested: Omit<
    ExternalEffectObservation,
    | 'schemaVersion'
    | 'kind'
    | 'grantId'
    | 'transactionId'
    | 'idempotencyKey'
    | 'receiptDigest'
  >,
): ExternalEffectObservation {
  if (
    !isRecord(requested) ||
    !hasExactKeys(requested, [
      'externalReceiptId',
      'artifactDigest',
      'prestateDigest',
      'poststateDigest',
      'observedAt',
    ]) ||
    typeof requested.externalReceiptId !== 'string' ||
    requested.externalReceiptId.length < 1 ||
    requested.externalReceiptId.length > 512 ||
    !DIGEST.test(String(requested.artifactDigest)) ||
    !DIGEST.test(String(requested.prestateDigest)) ||
    !DIGEST.test(String(requested.poststateDigest)) ||
    typeof requested.observedAt !== 'string' ||
    !isTimestamp(requested.observedAt) ||
    requested.artifactDigest !== transaction.envelope.payload.artifactDigest ||
    requested.prestateDigest !== transaction.envelope.payload.prestateDigest
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECEIPT_INVALID',
      'External effect receipt does not match the signed grant.',
      ExitCode.verification,
    );
  }
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-observation' as const,
    grantId: transaction.envelope.payload.grantId,
    transactionId: transaction.transactionId,
    idempotencyKey: transaction.envelope.payload.idempotencyKey,
    externalReceiptId: requested.externalReceiptId,
    artifactDigest: requested.artifactDigest as Sha256Digest,
    prestateDigest: requested.prestateDigest as Sha256Digest,
    poststateDigest: requested.poststateDigest as Sha256Digest,
    observedAt: requested.observedAt,
  };
  return { ...value, receiptDigest: sha256(canonicalJson(value)) };
}

function parseRequest(request: ExternalEffectGrantRequest) {
  const hasOwnTtlSeconds = Object.hasOwn(request, 'ttlSeconds');
  if (
    !isPlainOwnDataRecord(request) ||
    !hasExactKeys(request, [
      'mandateBinding',
      'effectKind',
      'target',
      'artifactDigest',
      'prestateDigest',
      'rollbackPlan',
      ...(hasOwnTtlSeconds ? ['ttlSeconds'] : []),
      'idempotencyKey',
    ]) ||
    !isRecord(request.mandateBinding) ||
    !hasExactKeys(request.mandateBinding, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    request.mandateBinding.schemaVersion !== 1 ||
    typeof request.mandateBinding.mandateTaskId !== 'string' ||
    !TASK_ID.test(request.mandateBinding.mandateTaskId) ||
    typeof request.mandateBinding.mandateId !== 'string' ||
    !UUID_V4.test(request.mandateBinding.mandateId) ||
    typeof request.mandateBinding.mandateDigest !== 'string' ||
    !RAW_DIGEST.test(request.mandateBinding.mandateDigest) ||
    typeof request.mandateBinding.changeId !== 'string' ||
    request.mandateBinding.changeId.length < 1 ||
    request.mandateBinding.changeId.length > 128 ||
    typeof request.mandateBinding.externalAuditRoot !== 'string' ||
    !path.isAbsolute(request.mandateBinding.externalAuditRoot) ||
    !EFFECT_KINDS.includes(request.effectKind as ExternalEffectKind) ||
    !DIGEST.test(String(request.artifactDigest)) ||
    !DIGEST.test(String(request.prestateDigest)) ||
    typeof request.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(request.idempotencyKey) ||
    (hasOwnTtlSeconds && typeof request.ttlSeconds !== 'number')
  ) {
    throw invalidGrant();
  }
  const target = parseTarget(request.target);
  const effectKind = request.effectKind as ExternalEffectKind;
  if (
    ((effectKind === 'publish-git-ref' ||
      effectKind === 'force-push-git-ref') &&
      target.kind !== 'git-ref') ||
    (effectKind !== 'publish-git-ref' &&
      effectKind !== 'force-push-git-ref' &&
      target.kind !== 'external-resource')
  ) {
    throw invalidGrant();
  }
  return {
    mandateBinding: {
      schemaVersion: 1 as const,
      mandateTaskId: request.mandateBinding.mandateTaskId,
      mandateId: request.mandateBinding.mandateId,
      mandateDigest: request.mandateBinding.mandateDigest,
      changeId: request.mandateBinding.changeId,
      externalAuditRoot: request.mandateBinding.externalAuditRoot,
    },
    effectKind,
    target,
    artifactDigest: request.artifactDigest as Sha256Digest,
    prestateDigest: request.prestateDigest as Sha256Digest,
    rollbackPlan: parseRollback(request.rollbackPlan),
    ttlSeconds: hasOwnTtlSeconds ? request.ttlSeconds : undefined,
    idempotencyKey: request.idempotencyKey,
  };
}

function isPlainOwnDataRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        'value' in descriptor &&
        descriptor.enumerable === true
      );
    });
  } catch {
    return false;
  }
}

function parsePayload(value: unknown): ExternalEffectGrantPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    value.kind !== 'external-effect-grant.v1' ||
    typeof value.grantId !== 'string' ||
    !UUID_V4.test(value.grantId) ||
    typeof value.repositoryId !== 'string' ||
    !/^github:[A-Za-z0-9_-]+$/.test(value.repositoryId) ||
    typeof value.repositoryOrigin !== 'string' ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      value.repositoryOrigin,
    ) ||
    typeof value.baseCommit !== 'string' ||
    !COMMIT_OID.test(value.baseCommit) ||
    typeof value.policyBlob !== 'string' ||
    !COMMIT_OID.test(value.policyBlob) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    value.externalAuditRoot.length > 4096 ||
    typeof value.changeId !== 'string' ||
    value.changeId.length < 1 ||
    value.changeId.length > 128 ||
    typeof value.mandateId !== 'string' ||
    !UUID_V4.test(value.mandateId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    typeof value.mandateDigest !== 'string' ||
    !RAW_DIGEST.test(value.mandateDigest) ||
    !EFFECT_KINDS.includes(value.effectKind as ExternalEffectKind) ||
    !DIGEST.test(String(value.artifactDigest)) ||
    !DIGEST.test(String(value.prestateDigest)) ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) >
      EXTERNAL_EFFECT_MAX_TTL_SECONDS * 1000 ||
    value.uses !== 1 ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.signer !== 'string' ||
    value.signer.length < 1 ||
    value.signer.length > 128
  ) {
    throw invalidGrant();
  }
  const target = parseTarget(value.target);
  const effectKind = value.effectKind as ExternalEffectKind;
  if (
    ((effectKind === 'publish-git-ref' ||
      effectKind === 'force-push-git-ref') &&
      target.kind !== 'git-ref') ||
    (effectKind !== 'publish-git-ref' &&
      effectKind !== 'force-push-git-ref' &&
      target.kind !== 'external-resource')
  ) {
    throw invalidGrant();
  }
  return {
    kind: 'external-effect-grant.v1',
    grantId: value.grantId,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    baseCommit: value.baseCommit,
    policyBlob: value.policyBlob,
    externalAuditRoot: value.externalAuditRoot,
    changeId: value.changeId,
    mandateId: value.mandateId,
    taskId: value.taskId,
    mandateDigest: value.mandateDigest,
    effectKind,
    target,
    artifactDigest: value.artifactDigest as Sha256Digest,
    prestateDigest: value.prestateDigest as Sha256Digest,
    rollbackPlan: parseRollback(value.rollbackPlan),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    uses: 1,
    idempotencyKey: value.idempotencyKey,
    signer: value.signer,
  };
}

function parseEnvelope(value: unknown): ExternalEffectGrantEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    typeof value.signature !== 'string'
  ) {
    throw invalidGrant();
  }
  assertSignature(value.signature);
  return { payload: parsePayload(value.payload), signature: value.signature };
}

function parseTarget(value: unknown): ExternalEffectTarget {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw invalidGrant();
  }
  if (value.kind === 'git-ref') {
    if (
      !hasExactKeys(value, [
        'kind',
        'remoteName',
        'remoteUrl',
        'refName',
        'sourceOid',
        'expectedRemoteOid',
      ]) ||
      typeof value.remoteName !== 'string' ||
      !SIMPLE_NAME.test(value.remoteName) ||
      typeof value.remoteUrl !== 'string' ||
      value.remoteUrl.length < 1 ||
      value.remoteUrl.length > 1024 ||
      /[\0\r\n]/.test(value.remoteUrl) ||
      typeof value.refName !== 'string' ||
      !REF_NAME.test(value.refName) ||
      typeof value.sourceOid !== 'string' ||
      !COMMIT_OID.test(value.sourceOid) ||
      (value.expectedRemoteOid !== null &&
        (typeof value.expectedRemoteOid !== 'string' ||
          !COMMIT_OID.test(value.expectedRemoteOid)))
    ) {
      throw invalidGrant();
    }
    return {
      kind: 'git-ref',
      remoteName: value.remoteName,
      remoteUrl: value.remoteUrl,
      refName: value.refName,
      sourceOid: value.sourceOid,
      expectedRemoteOid: value.expectedRemoteOid,
    };
  }
  if (
    value.kind === 'external-resource' &&
    hasExactKeys(value, ['kind', 'service', 'resource']) &&
    typeof value.service === 'string' &&
    SIMPLE_NAME.test(value.service) &&
    typeof value.resource === 'string' &&
    value.resource.length >= 1 &&
    value.resource.length <= 1024 &&
    !/[\0\r\n]/.test(value.resource)
  ) {
    return {
      kind: 'external-resource',
      service: value.service,
      resource: value.resource,
    };
  }
  throw invalidGrant();
}

function parseRollback(value: unknown): ExternalEffectRollbackPlan | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'planDigest']) ||
    (value.kind !== 'restore-git-ref' && value.kind !== 'operator-procedure') ||
    typeof value.planDigest !== 'string' ||
    !DIGEST.test(value.planDigest)
  ) {
    throw invalidGrant();
  }
  return { kind: value.kind, planDigest: value.planDigest as Sha256Digest };
}

function parseAvailable(raw: string): AvailableRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-available' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const record = createAvailableRecord(
    envelope,
    value.grantDigest as Sha256Digest,
  );
  if (
    record.recordDigest !== value.recordDigest ||
    value.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope)) ||
    canonicalAvailable(record) !== raw
  ) {
    throw unsafeStore();
  }
  return record;
}

function parseTransaction(raw: string): TransactionRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'transactionId',
      'transactionToken',
      'phase',
      'reservedAt',
      'dispatchIssuedAt',
      'effectObservedAt',
      'observation',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-transaction' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.transactionId !== 'string' ||
    !UUID_V4.test(value.transactionId) ||
    typeof value.transactionToken !== 'string' ||
    !new RegExp(
      `^${value.transactionId.replaceAll('-', '\\-')}\\.[0-9a-f]{64}$`,
    ).test(value.transactionToken) ||
    (value.phase !== 'reserved' &&
      value.phase !== 'dispatch-issued' &&
      value.phase !== 'effect-observed') ||
    typeof value.reservedAt !== 'string' ||
    !isTimestamp(value.reservedAt) ||
    (value.dispatchIssuedAt !== null &&
      (typeof value.dispatchIssuedAt !== 'string' ||
        !isTimestamp(value.dispatchIssuedAt))) ||
    (value.effectObservedAt !== null &&
      (typeof value.effectObservedAt !== 'string' ||
        !isTimestamp(value.effectObservedAt))) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const observation =
    value.observation === null
      ? null
      : parseObservation(value.observation, envelope, value.transactionId);
  const transaction: TransactionRecord = {
    schemaVersion: 1,
    kind: 'external-effect-transaction',
    grantDigest: value.grantDigest as Sha256Digest,
    envelope,
    transactionId: value.transactionId,
    transactionToken: value.transactionToken,
    phase: value.phase,
    reservedAt: value.reservedAt,
    dispatchIssuedAt: value.dispatchIssuedAt,
    effectObservedAt: value.effectObservedAt,
    observation,
    recordDigest: value.recordDigest as Sha256Digest,
  };
  if (
    replaceTransactionDigest(transaction).recordDigest !==
      transaction.recordDigest ||
    transaction.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope)) ||
    (transaction.phase === 'reserved' &&
      (transaction.dispatchIssuedAt !== null ||
        transaction.effectObservedAt !== null ||
        transaction.observation !== null)) ||
    (transaction.phase === 'dispatch-issued' &&
      (transaction.dispatchIssuedAt === null ||
        transaction.effectObservedAt !== null ||
        transaction.observation !== null)) ||
    (transaction.phase === 'effect-observed' &&
      (transaction.dispatchIssuedAt === null ||
        transaction.effectObservedAt === null ||
        transaction.observation === null)) ||
    canonicalTransaction(transaction) !== raw
  ) {
    throw unsafeStore();
  }
  return transaction;
}

function parseObservation(
  value: unknown,
  envelope: ExternalEffectGrantEnvelope,
  transactionId: string,
): ExternalEffectObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantId',
      'transactionId',
      'idempotencyKey',
      'externalReceiptId',
      'artifactDigest',
      'prestateDigest',
      'poststateDigest',
      'observedAt',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-observation' ||
    value.grantId !== envelope.payload.grantId ||
    value.transactionId !== transactionId ||
    value.idempotencyKey !== envelope.payload.idempotencyKey ||
    typeof value.externalReceiptId !== 'string' ||
    value.externalReceiptId.length < 1 ||
    value.externalReceiptId.length > 512 ||
    value.artifactDigest !== envelope.payload.artifactDigest ||
    value.prestateDigest !== envelope.payload.prestateDigest ||
    typeof value.poststateDigest !== 'string' ||
    !DIGEST.test(value.poststateDigest) ||
    typeof value.observedAt !== 'string' ||
    !isTimestamp(value.observedAt) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw unsafeStore();
  }
  const { receiptDigest: _receiptDigest, ...withoutDigest } = value;
  if (sha256(canonicalJson(withoutDigest)) !== value.receiptDigest) {
    throw unsafeStore();
  }
  return value as ExternalEffectObservation;
}

function parseTerminal(raw: string): TerminalRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'transactionId',
      'state',
      'observation',
      'terminalAt',
      'reason',
      'previousRecordDigest',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-terminal' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    (value.transactionId !== null &&
      (typeof value.transactionId !== 'string' ||
        !UUID_V4.test(value.transactionId))) ||
    ![
      'consumed',
      'revoked',
      'expired',
      'failed',
      'manual-reconciliation',
    ].includes(String(value.state)) ||
    typeof value.terminalAt !== 'string' ||
    !isTimestamp(value.terminalAt) ||
    (value.reason !== null && typeof value.reason !== 'string') ||
    typeof value.previousRecordDigest !== 'string' ||
    !DIGEST.test(value.previousRecordDigest) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const observation =
    value.observation === null
      ? null
      : parseObservation(
          value.observation,
          envelope,
          String(value.transactionId),
        );
  const terminal = {
    schemaVersion: 1 as const,
    kind: 'external-effect-terminal' as const,
    grantDigest: value.grantDigest as Sha256Digest,
    envelope,
    transactionId: value.transactionId as string | null,
    state: value.state as TerminalState,
    observation,
    terminalAt: value.terminalAt,
    reason: value.reason as string | null,
    previousRecordDigest: value.previousRecordDigest as Sha256Digest,
  };
  if (
    sha256(canonicalJson(terminal)) !== value.receiptDigest ||
    terminal.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope))
  ) {
    throw unsafeStore();
  }
  const record = {
    ...terminal,
    receiptDigest: value.receiptDigest as Sha256Digest,
  };
  if (canonicalTerminal(record) !== raw) throw unsafeStore();
  return record;
}

function parseReconciliationRequest(
  value: unknown,
  terminal: TerminalRecord,
  now: Date,
): ExternalEffectReconciliationRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'outcome',
      'evidenceDigest',
      'externalReceiptId',
      'poststateDigest',
      'observedAt',
      'reason',
    ]) ||
    (value.outcome !== 'succeeded' &&
      value.outcome !== 'rolled-back' &&
      value.outcome !== 'failed') ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    (value.externalReceiptId !== null &&
      (typeof value.externalReceiptId !== 'string' ||
        value.externalReceiptId.length < 1 ||
        value.externalReceiptId.length > 512 ||
        value.externalReceiptId.trim() !== value.externalReceiptId ||
        /[\0\r\n]/.test(value.externalReceiptId))) ||
    (value.poststateDigest !== null &&
      (typeof value.poststateDigest !== 'string' ||
        !DIGEST.test(value.poststateDigest))) ||
    typeof value.observedAt !== 'string' ||
    !isTimestamp(value.observedAt) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length < 1 ||
    value.reason.length > 1024 ||
    /[\0\r]/.test(value.reason)
  ) {
    throw reconciliationInvalid();
  }
  const observedAt = Date.parse(value.observedAt);
  if (
    observedAt < Date.parse(terminal.terminalAt) ||
    observedAt > now.getTime() + 30_000 ||
    (value.outcome === 'succeeded' &&
      (value.poststateDigest === null || value.externalReceiptId === null)) ||
    (value.outcome === 'rolled-back' &&
      (value.poststateDigest !== terminal.envelope.payload.prestateDigest ||
        value.externalReceiptId === null))
  ) {
    throw reconciliationInvalid();
  }
  return {
    outcome: value.outcome,
    evidenceDigest: value.evidenceDigest as Sha256Digest,
    externalReceiptId: value.externalReceiptId,
    poststateDigest: value.poststateDigest as Sha256Digest | null,
    observedAt: value.observedAt,
    reason: value.reason,
  };
}

function createReconciliationRecord(
  terminal: TerminalRecord,
  request: ExternalEffectReconciliationRequest,
  resolver: string,
  resolvedAt: Date,
): ExternalEffectReconciliation {
  if (
    terminal.state !== 'manual-reconciliation' ||
    terminal.transactionId === null ||
    resolver.length < 1 ||
    resolver.length > 128 ||
    resolver.trim() !== resolver
  ) {
    throw reconciliationInvalid();
  }
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-reconciliation.v1' as const,
    grantId: terminal.envelope.payload.grantId,
    grantDigest: terminal.grantDigest,
    transactionId: terminal.transactionId,
    manualReconciliationReceiptDigest: terminal.receiptDigest,
    ...request,
    resolver,
    resolvedAt: resolvedAt.toISOString(),
  };
  return Object.freeze({
    ...value,
    receiptDigest: sha256(canonicalJson(value)),
  });
}

function parseReconciliation(
  raw: string,
  terminal: TerminalRecord,
): ExternalEffectReconciliation {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantId',
      'grantDigest',
      'transactionId',
      'manualReconciliationReceiptDigest',
      'outcome',
      'evidenceDigest',
      'externalReceiptId',
      'poststateDigest',
      'observedAt',
      'reason',
      'resolver',
      'resolvedAt',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-reconciliation.v1' ||
    value.grantId !== terminal.envelope.payload.grantId ||
    value.grantDigest !== terminal.grantDigest ||
    value.transactionId !== terminal.transactionId ||
    value.manualReconciliationReceiptDigest !== terminal.receiptDigest ||
    typeof value.resolver !== 'string' ||
    typeof value.resolvedAt !== 'string' ||
    !isTimestamp(value.resolvedAt) ||
    Date.parse(value.resolvedAt) < Date.parse(terminal.terminalAt) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw unsafeStore();
  }
  try {
    const request = parseReconciliationRequest(
      {
        outcome: value.outcome,
        evidenceDigest: value.evidenceDigest,
        externalReceiptId: value.externalReceiptId,
        poststateDigest: value.poststateDigest,
        observedAt: value.observedAt,
        reason: value.reason,
      },
      terminal,
      new Date(value.resolvedAt),
    );
    const record = createReconciliationRecord(
      terminal,
      request,
      value.resolver,
      new Date(value.resolvedAt),
    );
    if (
      record.receiptDigest !== value.receiptDigest ||
      canonicalReconciliation(record) !== raw
    ) {
      throw unsafeStore();
    }
    return record;
  } catch {
    throw unsafeStore();
  }
}

function assertManualReconciliationState(
  state: StoreState,
): asserts state is Extract<StoreState, { kind: 'terminal' }> & {
  record: TerminalRecord & {
    state: 'manual-reconciliation';
    transactionId: string;
  };
} {
  if (
    state.kind !== 'terminal' ||
    state.record.state !== 'manual-reconciliation' ||
    state.record.transactionId === null
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECONCILIATION_NOT_REQUIRED',
      'Only a durable manual-reconciliation terminal may be resolved.',
      ExitCode.guard,
    );
  }
}

function assertReconciliationReplay(
  existing: ExternalEffectReconciliation,
  request: ExternalEffectReconciliationRequest,
  resolver: string,
): void {
  const observed = {
    outcome: existing.outcome,
    evidenceDigest: existing.evidenceDigest,
    externalReceiptId: existing.externalReceiptId,
    poststateDigest: existing.poststateDigest,
    observedAt: existing.observedAt,
    reason: existing.reason,
  };
  if (
    canonicalJson(observed) !== canonicalJson(request) ||
    existing.resolver !== resolver
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECONCILIATION_CONFLICT',
      'External effect reconciliation is already bound to different human evidence.',
      ExitCode.conflict,
    );
  }
}

function validateEnvelopeForRepository(
  repositoryRoot: string,
  envelope: ExternalEffectGrantEnvelope,
  providedSigner?: MaintainerSignerProvider,
): void {
  const trust = loadTrustForPayload(repositoryRoot, envelope.payload);
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  assertExternalAuditRoot(envelope.payload.externalAuditRoot, repositoryRoot);
  if (
    trust.policy.repository.id !== envelope.payload.repositoryId ||
    trust.policy.repository.origin !== envelope.payload.repositoryOrigin ||
    trust.policyBlob !== envelope.payload.policyBlob ||
    origin !== envelope.payload.repositoryOrigin ||
    !trust.policy.trustedSigners.some(
      ({ identity }) => identity === envelope.payload.signer,
    )
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
      'External effect grant no longer matches the repository trust base.',
      ExitCode.staleState,
    );
  }
  const signer =
    providedSigner ?? createInteractiveSshSigner(repositoryRoot, trust.policy);
  try {
    signer.verify(
      canonicalExternalEffectGrantPayload(envelope.payload),
      envelope.signature,
      envelope.payload.signer,
      EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
    );
  } catch {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNATURE_INVALID',
      'External effect grant signature is invalid for its dedicated domain.',
      ExitCode.verification,
    );
  }
}

function loadTrustContext(cwd: string) {
  const repository = discoverRepository(cwd);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
  if (origin !== loaded.policy.repository.origin) {
    throw workflowError(
      'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
      'Repository origin differs from its trusted external effect policy.',
      ExitCode.guard,
    );
  }
  return { repository, ...loaded };
}

function loadTrustForPayload(
  repositoryRoot: string,
  payload: ExternalEffectGrantPayload,
) {
  return loadPolicyAt(repositoryRoot, payload.baseCommit);
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
      'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
      'External effect trust base could not be loaded.',
      ExitCode.verification,
    );
  }
}

function auditInput(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
  eventType: ExternalEffectAuditEventType,
  now: Date,
  overrides: Partial<
    Pick<
      ExternalEffectAuditEvent,
      | 'transactionId'
      | 'poststateDigest'
      | 'evidenceDigest'
      | 'resolver'
      | 'result'
      | 'reason'
    >
  >,
): Omit<ExternalEffectAuditEvent, 'eventId'> {
  return {
    schemaVersion: 1,
    eventType,
    occurredAt: now.toISOString(),
    repositoryId: envelope.payload.repositoryId,
    externalAuditRoot: envelope.payload.externalAuditRoot,
    changeId: envelope.payload.changeId,
    taskId: envelope.payload.taskId,
    mandateId: envelope.payload.mandateId,
    mandateDigest: envelope.payload.mandateDigest,
    effectKind: envelope.payload.effectKind,
    targetDigest: sha256(canonicalJson(envelope.payload.target)),
    effectIdempotencyDigest: sha256(envelope.payload.idempotencyKey),
    grantId: envelope.payload.grantId,
    grantDigest,
    transactionId: overrides.transactionId ?? null,
    artifactDigest: envelope.payload.artifactDigest,
    prestateDigest: envelope.payload.prestateDigest,
    poststateDigest: overrides.poststateDigest ?? null,
    evidenceDigest: overrides.evidenceDigest ?? null,
    resolver: overrides.resolver ?? null,
    result: overrides.result ?? 'failed',
    reason: overrides.reason ?? null,
  };
}

function emitAudit(
  repositoryRoot: string,
  options: Pick<
    ExternalEffectTransitionOptions,
    'onAuditRecord' | 'testAuditServiceHooks'
  >,
  input: Omit<ExternalEffectAuditEvent, 'eventId'>,
): void {
  const event = Object.freeze({
    ...input,
    eventId: sha256(
      canonicalJson({
        grantDigest: input.grantDigest,
        transactionId: input.transactionId,
        eventType: input.eventType,
        result: input.result,
        poststateDigest: input.poststateDigest,
        evidenceDigest: input.evidenceDigest,
        resolver: input.resolver,
      }),
    ),
  });
  appendExternalEffectAuthorityAudit(repositoryRoot, event, {
    serviceHooks: options.testAuditServiceHooks,
    onRecord: options.onAuditRecord,
  });
}

function ensureStore(paths: ReturnType<typeof externalEffectStorePaths>): void {
  for (const directory of storeDirectories(paths)) {
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
  }
  assertStore(paths);
}

function assertStore(paths: ReturnType<typeof externalEffectStorePaths>): void {
  for (const directory of storeDirectories(paths)) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o700 ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw unsafeStore();
    }
  }
}

function storeDirectories(
  paths: ReturnType<typeof externalEffectStorePaths>,
): string[] {
  return [
    paths.root,
    paths.pending,
    paths.available,
    paths.transactions,
    paths.terminal,
    paths.idempotency,
  ];
}

function assertIdempotencyAvailable(
  paths: ReturnType<typeof externalEffectStorePaths>,
  idempotencyKey: string,
  grantId: string,
  grantDigest: Sha256Digest,
): void {
  const raw = readOptionalPrivateFile(idempotencyPath(paths, idempotencyKey));
  if (raw === null) return;
  const existing = parseIdempotencyRecord(raw);
  if (
    existing.idempotencyKey !== idempotencyKey ||
    existing.grantId !== grantId ||
    existing.grantDigest !== grantDigest
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT',
      'External effect idempotency key is already bound to another exact grant.',
      ExitCode.conflict,
    );
  }
}

function createIdempotencyIndex(
  paths: ReturnType<typeof externalEffectStorePaths>,
  idempotencyKey: string,
  grantId: string,
  grantDigest: Sha256Digest,
): void {
  const filePath = idempotencyPath(paths, idempotencyKey);
  const raw = readOptionalPrivateFile(filePath);
  if (raw !== null) {
    assertIdempotencyAvailable(paths, idempotencyKey, grantId, grantDigest);
    return;
  }
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-idempotency' as const,
    idempotencyKey,
    grantId,
    grantDigest,
  };
  const record: IdempotencyRecord = {
    ...value,
    recordDigest: sha256(canonicalJson(value)),
  };
  createPrivateFileAtomic(filePath, `${canonicalJson(record)}\n`);
}

function parseIdempotencyRecord(raw: string): IdempotencyRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'idempotencyKey',
      'grantId',
      'grantDigest',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-idempotency' ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.grantId !== 'string' ||
    !UUID_V4.test(value.grantId) ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const { recordDigest: _recordDigest, ...withoutDigest } = value;
  if (
    sha256(canonicalJson(withoutDigest)) !== value.recordDigest ||
    `${canonicalJson(value)}\n` !== raw
  ) {
    throw unsafeStore();
  }
  return value as IdempotencyRecord;
}

function idempotencyPath(
  paths: ReturnType<typeof externalEffectStorePaths>,
  idempotencyKey: string,
): string {
  return path.join(
    paths.idempotency,
    `${sha256(idempotencyKey).slice('sha256:'.length)}.json`,
  );
}

function assertExternalAuditRoot(
  value: string,
  repositoryRoot: string,
): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.length > 4096
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
      'External effect audit root must be an exact absolute private directory.',
      ExitCode.guard,
    );
  }
  const relative = path.relative(path.resolve(repositoryRoot), value);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
      'External effect audit root must remain outside the repository.',
      ExitCode.guard,
    );
  }
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(value) !== value
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
      'External effect audit root is missing, linked, or not private.',
      ExitCode.guard,
    );
  }
  return value;
}

function assertGrantAbsent(
  paths: ReturnType<typeof externalEffectStorePaths>,
  grantId: string,
): void {
  if (
    [paths.pending, paths.available, paths.transactions, paths.terminal].some(
      (directory) => fs.existsSync(grantPath(directory, grantId)),
    ) ||
    fs.existsSync(reconciliationPath(paths, grantId))
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_EXISTS',
      `External effect grant ${grantId} already exists.`,
      ExitCode.conflict,
    );
  }
}

function grantPath(directory: string, grantId: string): string {
  return path.join(directory, `${assertUuid(grantId)}.json`);
}

function reconciliationPath(
  paths: ReturnType<typeof externalEffectStorePaths>,
  grantId: string,
): string {
  return path.join(
    paths.terminal,
    `${assertUuid(grantId)}.reconciliation.json`,
  );
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      0o600,
    );
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

function replacePrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      0o600,
    );
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

function readOptionalPrivateFile(filePath: string): string | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return null;
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size > 64 * 1024
  ) {
    throw unsafeStore();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size > 64 * 1024
    ) {
      throw unsafeStore();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function unlinkIfExact(filePath: string, expected: string): void {
  const raw = readOptionalPrivateFile(filePath);
  if (raw === null) return;
  if (raw !== expected) throw unsafeStore();
  fs.unlinkSync(filePath);
  fsyncDirectory(path.dirname(filePath));
}

function canonicalAvailable(record: AvailableRecord): string {
  return `${canonicalJson(record)}\n`;
}

function canonicalPending(record: PendingRecord): string {
  return `${canonicalJson(record)}\n`;
}

function canonicalTransaction(record: TransactionRecord): string {
  return `${canonicalJson(record)}\n`;
}

function canonicalTerminal(record: TerminalRecord): string {
  return `${canonicalJson(record)}\n`;
}

function canonicalReconciliation(record: ExternalEffectReconciliation): string {
  return `${canonicalJson(record)}\n`;
}

function parseJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > 64 * 1024) throw unsafeStore();
  try {
    return JSON.parse(raw);
  } catch {
    throw unsafeStore();
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

function assertTrustedSigner(
  policy: ReturnType<typeof parseMaintainerPolicy>,
  identity: string,
): void {
  if (
    !policy.trustedSigners.some(({ identity: value }) => value === identity)
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNER_UNTRUSTED',
      'External effect signer is not trusted by the exact base policy.',
      ExitCode.verification,
    );
  }
}

function assertTransactionId(
  transaction: TransactionRecord,
  transactionId: string,
): void {
  if (transaction.transactionId !== transactionId) throw stateConflict();
}

function assertObservationClock(
  observation: ExternalEffectObservation,
  transaction: TransactionRecord,
  now: Date,
): void {
  const observed = Date.parse(observation.observedAt);
  if (
    observed < Date.parse(transaction.reservedAt) ||
    observed > now.getTime() + 30_000
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECEIPT_INVALID',
      'External effect receipt time is outside the transaction window.',
      ExitCode.verification,
    );
  }
}

function expired(payload: ExternalEffectGrantPayload, now: Date): boolean {
  return now.getTime() >= Date.parse(payload.expiresAt);
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidGrant();
  }
  return new Date(value.getTime());
}

function isTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertUuid(value: string): string {
  if (!UUID_V4.test(value)) throw invalidGrant();
  return value;
}

function assertUuidForPublish(value: string): string {
  try {
    return assertUuid(value);
  } catch {
    throw publishTransactionInvalid();
  }
}

function assertSignature(value: string): void {
  if (!SIGNATURE.test(value) || Buffer.byteLength(value) > 16 * 1024) {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNATURE_INVALID',
      'External effect grant signature is malformed.',
      ExitCode.verification,
    );
  }
}

function assertReason(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 1024 ||
    /[\0\r]/.test(normalized)
  ) {
    throw invalidGrant();
  }
  return normalized;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function sha256(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function invalidGrant() {
  return workflowError(
    'EXTERNAL_EFFECT_GRANT_INVALID',
    'External effect grant is malformed or exceeds its authority bounds.',
    ExitCode.guard,
  );
}

function unsafeStore() {
  return workflowError(
    'EXTERNAL_EFFECT_STORE_UNSAFE',
    'External effect grant store is missing, noncanonical, or unsafe.',
    ExitCode.verification,
  );
}

function stateConflict() {
  return workflowError(
    'EXTERNAL_EFFECT_STATE_CONFLICT',
    'External effect grant is not in the exact required transaction phase.',
    ExitCode.conflict,
  );
}

function reconciliationInvalid() {
  return workflowError(
    'EXTERNAL_EFFECT_RECONCILIATION_INVALID',
    'External effect reconciliation evidence is malformed or does not prove the selected outcome.',
    ExitCode.verification,
  );
}

function publishTransactionRequired() {
  return workflowError(
    'PUBLISH_TRANSACTION_REQUIRED',
    'Direct push is denied without an exact active publish transaction token.',
    ExitCode.guard,
  );
}

function publishTransactionInvalid() {
  return workflowError(
    'PUBLISH_TRANSACTION_INVALID',
    'Publish transaction token does not match the active exact remote effect.',
    ExitCode.guard,
  );
}

function isWorkflowFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  );
}
