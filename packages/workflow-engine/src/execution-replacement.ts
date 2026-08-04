import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import { requireExecutionJobMandateBinding } from './execution-core.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  consumeExecutionBudgetGrant,
  createExecutionBudgetGrantRequest,
  inspectExecutionBudgetGrantAuthorization,
  parseExecutionBudgetGrantRequest,
  type ExecutionBudgetConsumeReceipt,
  type ExecutionBudgetGrantRequest,
} from './execution-governance.ts';
import {
  inspectExecutionJob,
  inspectLegacyExecutionJobSource,
  previewLegacyReplacementGrantDelta,
} from './execution-runtime.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import type { InvestigationRuntimePaths } from './paths.ts';
import {
  createPlanReviewRetryEnvelope,
  createProviderRetryEnvelope,
  getProposeStatus,
  resumePropose,
} from './propose-orchestrator.ts';
import {
  MAX_PROVIDER_LIMITS,
  createProviderInvocationRequest,
  recreateProviderInvocationRequest,
} from './provider-contracts.ts';
import {
  providerInvocationExists,
  readProviderInvocation,
  readProviderInvocationRequest,
} from './provider-invocation-store.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';
import { assertActiveTaskMandateBindingUnderLifecycleLock } from './task-mandate.ts';

export type ExecutionRetryRequestResult = Readonly<{
  schemaVersion: 1;
  requestPath: string;
  requestDigest: string;
  request: ExecutionBudgetGrantRequest;
  bindingPath: string;
}>;

/**
 * Enumerate exact durable replacement GrantRequests without creating runtime
 * directories or requiring the later binding publication to have completed.
 */
export function listExecutionReplacementGrantRequestDigests(
  cwd: string,
): readonly string[] {
  const context = loadInvestigationRuntimeContext(cwd);
  const requestsDirectory = path.join(
    context.lifecycleRuntime.root,
    'execution-replacements',
    'requests',
  );
  const stats = fs.lstatSync(requestsDirectory, { throwIfNoEntry: false });
  if (stats === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(
    context.runtime,
    requestsDirectory,
    replacementUnsafe,
  );
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(requestsDirectory) !== requestsDirectory
  ) {
    throw replacementUnsafe();
  }
  const requestDigests = fs
    .readdirSync(requestsDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const match = entry.name.match(/^([0-9a-f]{64})\.json$/);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw replacementUnsafe();
      }
      const requestDigest = `sha256:${match[1]!}`;
      readPersistedRequest(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      return requestDigest;
    });
  return Object.freeze(requestDigests);
}

type ExecutionReplacementRequestBinding = Readonly<{
  schemaVersion: 1;
  kind: 'execution-replacement-request-binding';
  requestDigest: string;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureFingerprint: string;
  providerPolicyDigest: string;
  providerPolicyDocumentDigest: string;
  recordDigest: string;
}>;

export type ExecutionReplacementPhase =
  | 'prepared'
  | 'grant-consumed'
  | 'invocation-published'
  | 'dispatch-issued'
  | 'complete';

export type ExecutionReplacementTransaction = Readonly<{
  schemaVersion: 1;
  kind: 'execution-replacement-transaction';
  transactionId: string;
  phase: ExecutionReplacementPhase;
  grantId: string;
  requestDigest: string;
  request: ExecutionBudgetGrantRequest;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureFingerprint: string;
  replacementAttemptId: string;
  replacementInvocationId: string;
  replacementRequest: ReturnType<typeof createProviderInvocationRequest>;
  receipt: ExecutionBudgetConsumeReceipt | null;
  createdAt: string;
  updatedAt: string;
  recordDigest: string;
}>;

export type ExecuteGrantedReplacementOptions = {
  now?: Date;
  providerDispatcher?: (cwd: string, invocationId: string) => unknown;
  simulateCrashAfter?:
    | 'prepared'
    | 'grant-consume-before-journal'
    | 'grant-consumed'
    | 'invocation-published';
};

export class SimulatedExecutionReplacementCrash extends Error {
  readonly phase: NonNullable<
    ExecuteGrantedReplacementOptions['simulateCrashAfter']
  >;

  constructor(
    phase: NonNullable<ExecuteGrantedReplacementOptions['simulateCrashAfter']>,
  ) {
    super(`Simulated execution replacement crash after ${phase}.`);
    this.phase = phase;
  }
}

export function requestExecutionReplacement(
  cwd: string,
  requestedJobId: string,
  input: { timeoutMs: number },
): ExecutionRetryRequestResult {
  assertTimeout(input.timeoutMs);
  const context = loadInvestigationRuntimeContext(cwd);
  return withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      const inspection = inspectExecutionJob(cwd, requestedJobId);
      const source = inspectLegacyExecutionJobSource(cwd, requestedJobId);
      const previous = inspection.attempts.at(-1);
      const grantBase = inspection.latestFailure?.decision.requiredGrant;
      if (
        previous === undefined ||
        previous.failure === null ||
        grantBase === undefined ||
        inspection.acceptedAttemptId !== null
      ) {
        throw replacementNotGrantable();
      }
      const preview = previewLegacyReplacementGrantDelta(cwd, requestedJobId, {
        timeoutMs: input.timeoutMs,
        now: previous.updatedAt,
      });
      const providerPolicy = loadAiAdapterPolicy(context.git.repositoryRoot);
      const changes = mergeExactChanges([
        ...grantBase.requestedChanges,
        ...preview.changedFields,
        ...(input.timeoutMs > providerPolicy.policy.limits.timeoutMs
          ? [
              {
                path: '/providerPolicy/limits/timeoutMs',
                from: providerPolicy.policy.limits.timeoutMs,
                to: input.timeoutMs,
              },
            ]
          : []),
        ...(source.request.policyDigest === providerPolicy.digest
          ? []
          : [
              {
                path: '/providerPolicyDigest',
                from: source.request.policyDigest,
                to: providerPolicy.digest,
              },
            ]),
      ]);
      const request = createExecutionBudgetGrantRequest({
        requestId: deterministicUuid({
          kind: 'execution-replacement-request',
          jobId: inspection.job.jobId,
          failedAttemptId: previous.attemptId,
          changes,
        }),
        workflowId: inspection.workflow.workflowId,
        epoch: inspection.job.epoch,
        jobId: inspection.job.jobId,
        mandateBinding: requireExecutionJobMandateBinding(inspection.job),
        requestedChanges: changes,
        rationale: replacementRationale(
          previous,
          input.timeoutMs,
          providerPolicy.digest,
        ),
        expiresAfterAttempts: 1,
        createdAt: new Date(previous.updatedAt),
      });
      assertCompleteReplacementDelta(
        request,
        inspection.job.retryPolicy.maxAttempts,
        previous.policySnapshot.timeoutMs,
        input.timeoutMs,
        providerPolicy.policy.limits.timeoutMs,
      );
      const requestDigest = digestText(
        canonicalExecutionBudgetGrantRequest(request),
      );
      const requestPath = replacementRequestPath(
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const bindingPath = replacementRequestBindingPath(
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const binding = createRequestBinding({
        requestDigest,
        workflowId: inspection.workflow.workflowId,
        epoch: inspection.job.epoch,
        contextDigest: inspection.job.contextDigest,
        jobId: inspection.job.jobId,
        failedAttemptId: previous.attemptId,
        failedInvocationId: source.record.invocationId,
        failedInvocationRevision: source.record.revision,
        failureFingerprint: previous.failure.fingerprint,
        providerPolicyDigest: providerPolicy.digest,
        providerPolicyDocumentDigest: digestText(providerPolicy.document),
      });
      assertOwned();
      createPrivateCanonicalJson(
        context.runtime,
        requestPath,
        request,
        replacementUnsafe,
        'EXECUTION_REPLACEMENT_REQUEST_CONFLICT',
      );
      createPrivateCanonicalJson(
        context.runtime,
        bindingPath,
        binding,
        replacementUnsafe,
        'EXECUTION_REPLACEMENT_REQUEST_CONFLICT',
      );
      assertOwned();
      return Object.freeze({
        schemaVersion: 1,
        requestPath,
        requestDigest,
        request,
        bindingPath,
      });
    },
  );
}

export function executeGrantedReplacement(
  cwd: string,
  requestedJobId: string,
  grantId: string,
  options: ExecuteGrantedReplacementOptions = {},
): ExecutionReplacementTransaction {
  const context = loadInvestigationRuntimeContext(cwd);
  const grant = inspectExecutionBudgetGrantAuthorization(
    context.lifecycleRuntime.root,
    grantId,
  );
  if (grant.payload.jobId !== requestedJobId) {
    throw grantMismatch('Execution-budget grant belongs to another Job.');
  }
  const request = readPersistedRequest(
    context.runtime,
    context.lifecycleRuntime.root,
    grant.payload.requestDigest,
  );
  const requestBinding = readRequestBinding(
    context.runtime,
    context.lifecycleRuntime.root,
    grant.payload.requestDigest,
  );
  if (
    grant.payload.mandateBinding === undefined ||
    request.mandateBinding === undefined
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY',
      'A legacy unbound execution-budget grant cannot create a replacement Attempt.',
      ExitCode.guard,
    );
  }
  if (
    canonicalJson(request.requestedChanges) !==
      canonicalJson(grant.payload.allowedChanges) ||
    request.workflowId !== grant.payload.workflowId ||
    request.epoch !== grant.payload.epoch ||
    request.jobId !== grant.payload.jobId ||
    canonicalJson(request.mandateBinding) !==
      canonicalJson(grant.payload.mandateBinding)
  ) {
    throw grantMismatch('Grant does not sign the canonical persisted request.');
  }
  if (
    requestBinding.requestDigest !== grant.payload.requestDigest ||
    requestBinding.workflowId !== request.workflowId ||
    requestBinding.epoch !== request.epoch ||
    requestBinding.jobId !== request.jobId
  ) {
    throw grantMismatch('Grant request binding is stale or inconsistent.');
  }
  const timeoutMs = replacementTimeout(request);
  const requestDigest = digestText(
    canonicalExecutionBudgetGrantRequest(request),
  );
  const replacementInvocationId = `invocation-grant-retry-${digestCanonical({
    grantId,
    requestDigest,
  }).slice(7, 47)}`;
  const replacementAttemptId = `attempt-legacy-${replacementInvocationId}`;
  const transactionId = digestCanonical({
    kind: 'execution-replacement-transaction',
    grantId,
    requestDigest,
    replacementAttemptId,
  });
  const transactionPath = replacementTransactionPath(
    context.lifecycleRuntime.root,
    transactionId,
  );

  let transaction = withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      const lockedRequest = readPersistedRequest(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const lockedBinding = readRequestBinding(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const lockedGrant = inspectExecutionBudgetGrantAuthorization(
        context.lifecycleRuntime.root,
        grantId,
      );
      if (
        canonicalJson(lockedRequest) !== canonicalJson(request) ||
        canonicalJson(lockedBinding) !== canonicalJson(requestBinding) ||
        canonicalJson(lockedGrant.payload) !== canonicalJson(grant.payload)
      ) {
        throw replacementStale();
      }
      const existing = readTransactionIfPresent(
        context.runtime,
        transactionPath,
      );
      if (existing !== null) {
        assertTransactionIdentity(existing, {
          transactionId,
          grantId,
          requestDigest,
          jobId: requestedJobId,
          replacementAttemptId,
          replacementInvocationId,
        });
        assertCurrentTransactionLineage(cwd, existing);
        return recoverReceipt(
          context.git.repositoryRoot,
          context.runtime,
          context.lifecycleRuntime.root,
          existing,
          options,
          assertOwned,
        );
      }

      const inspection = inspectExecutionJob(cwd, requestedJobId);
      const source = inspectLegacyExecutionJobSource(cwd, requestedJobId);
      const failedAttempt = inspection.attempts.at(-1);
      if (
        inspection.workflow.workflowId !== request.workflowId ||
        inspection.job.epoch !== request.epoch ||
        inspection.job.contextDigest !== source.projection.job.contextDigest ||
        inspection.acceptedAttemptId !== null ||
        failedAttempt === undefined ||
        failedAttempt.failure === null ||
        failedAttempt.attemptId !== source.projection.attempt.attemptId ||
        source.record.state !== 'failed' ||
        source.record.failure?.kind !== 'retryable'
      ) {
        throw replacementStale();
      }
      const jobMandateBinding = requireExecutionJobMandateBinding(
        inspection.job,
      );
      if (
        canonicalJson(jobMandateBinding) !==
          canonicalJson(request.mandateBinding) ||
        canonicalJson(source.record.mandateBinding ?? null) !==
          canonicalJson(jobMandateBinding)
      ) {
        throw grantMismatch(
          'Grant does not match the durable provider invocation Task Mandate binding.',
        );
      }
      const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
      const expected = requestExecutionReplacementBytes(
        inspection,
        timeoutMs,
        source.request.policyDigest,
        requestBinding.providerPolicyDigest,
        policy.policy.limits.timeoutMs,
      );
      if (expected !== canonicalExecutionBudgetGrantRequest(request)) {
        throw grantMismatch(
          'Persisted request is not the exact complete delta for the current failed Attempt.',
        );
      }
      if (
        policy.digest !== requestBinding.providerPolicyDigest ||
        digestText(policy.document) !==
          requestBinding.providerPolicyDocumentDigest
      ) {
        throw grantMismatch(
          'Executable provider policy changed after the grant request was persisted.',
        );
      }
      if (
        requestBinding.contextDigest !== inspection.job.contextDigest ||
        requestBinding.failedAttemptId !== failedAttempt.attemptId ||
        requestBinding.failedInvocationId !== source.record.invocationId ||
        requestBinding.failedInvocationRevision !== source.record.revision ||
        requestBinding.failureFingerprint !== failedAttempt.failure.fingerprint
      ) {
        throw replacementStale();
      }
      const replacementRequest = createProviderInvocationRequest({
        invocationId: replacementInvocationId,
        nonce: `execution-grant-retry-${digestCanonical({ grantId, requestDigest }).slice(7)}`,
        purpose: source.request.purpose,
        providerId: source.request.providerId,
        roleAssignment: source.request.roleAssignment,
        capabilityProfile: source.request.capabilityProfile,
        repositoryId: source.request.repositoryId,
        baseCommit: source.request.baseCommit,
        baseTree: source.request.baseTree,
        targetDigest: source.request.targetDigest,
        inputManifestDigest: source.request.inputManifestDigest,
        authorizationNodeId: source.request.authorizationNodeId,
        writeAllowedPaths: [...source.request.writeAllowedPaths],
        outputSchema: source.request.outputSchema,
        evaluatorVersion: source.request.evaluatorVersion,
        policyDigest: requestBinding.providerPolicyDigest,
        limits: {
          timeoutMs,
          aggregateOutputBytes: source.request.limits.aggregateOutputBytes,
        },
      });
      const now = source.record.updatedAt;
      let prepared = createTransaction({
        schemaVersion: 1,
        kind: 'execution-replacement-transaction',
        transactionId,
        phase: 'prepared',
        grantId,
        requestDigest,
        request,
        workflowId: inspection.workflow.workflowId,
        epoch: inspection.job.epoch,
        contextDigest: inspection.job.contextDigest,
        jobId: inspection.job.jobId,
        failedAttemptId: failedAttempt.attemptId,
        failedInvocationId: source.record.invocationId,
        failedInvocationRevision: source.record.revision,
        failureFingerprint: failedAttempt.failure.fingerprint,
        replacementAttemptId,
        replacementInvocationId,
        replacementRequest,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      });
      assertOwned();
      writeTransaction(context.runtime, transactionPath, prepared, false);
      if (options.simulateCrashAfter === 'prepared') {
        throw new SimulatedExecutionReplacementCrash('prepared');
      }
      prepared = recoverReceipt(
        context.git.repositoryRoot,
        context.runtime,
        context.lifecycleRuntime.root,
        prepared,
        options,
        assertOwned,
      );
      return prepared;
    },
  );

  if (transaction.phase === 'grant-consumed') {
    publishReplacement(cwd, transaction);
    transaction = withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      () =>
        advanceTransaction(
          context.runtime,
          transactionPath,
          transaction,
          'invocation-published',
          options.now?.toISOString() ?? new Date().toISOString(),
        ),
    );
    if (options.simulateCrashAfter === 'invocation-published') {
      throw new SimulatedExecutionReplacementCrash('invocation-published');
    }
  }
  if (transaction.phase === 'invocation-published') {
    assertPublishedReplacement(cwd, transaction);
    transaction = withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      () => {
        const durable = readTransactionIfPresent(
          context.runtime,
          transactionPath,
        );
        if (durable === null) throw replacementUnsafe();
        if (durable.phase !== 'invocation-published') return durable;
        options.providerDispatcher?.(cwd, durable.replacementInvocationId);
        return advanceTransaction(
          context.runtime,
          transactionPath,
          durable,
          'dispatch-issued',
          options.now?.toISOString() ?? new Date().toISOString(),
        );
      },
    );
  }
  if (transaction.phase === 'dispatch-issued') {
    transaction = withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      () =>
        advanceTransaction(
          context.runtime,
          transactionPath,
          transaction,
          'complete',
          options.now?.toISOString() ?? new Date().toISOString(),
        ),
    );
  }
  return transaction;
}

function recoverReceipt(
  repositoryRoot: string,
  paths: InvestigationRuntimePaths,
  storeRoot: string,
  transaction: ExecutionReplacementTransaction,
  options: ExecuteGrantedReplacementOptions,
  assertOwned: () => void,
): ExecutionReplacementTransaction {
  if (transaction.receipt !== null) return transaction;
  const inspected = inspectExecutionBudgetGrantAuthorization(
    storeRoot,
    transaction.grantId,
  );
  let receipt = inspected.receipts.find(
    ({ attemptId }) => attemptId === transaction.replacementAttemptId,
  );
  if (receipt === undefined) {
    const mandateBinding = transaction.request.mandateBinding;
    if (mandateBinding === undefined) {
      throw workflowError(
        'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY',
        'A legacy unbound execution-budget request cannot create a replacement Attempt.',
        ExitCode.guard,
      );
    }
    assertActiveTaskMandateBindingUnderLifecycleLock(
      repositoryRoot,
      mandateBinding,
      assertOwned,
      { now: options.now },
    );
    const maintainerPolicy = parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          'HEAD:workflow/maintainer-policy.json',
        ]),
      ),
    );
    assertOwned();
    receipt = consumeExecutionBudgetGrant(storeRoot, {
      grantId: transaction.grantId,
      workflowId: transaction.workflowId,
      epoch: transaction.epoch,
      jobId: transaction.jobId,
      attemptId: transaction.replacementAttemptId,
      mandateBinding,
      requestDigest: transaction.requestDigest,
      requestedChanges: transaction.request.requestedChanges,
      now: options.now ?? new Date(),
      audit: {
        repositoryRoot,
        repositoryIdentity: maintainerPolicy.repository.id,
      },
    });
    if (options.simulateCrashAfter === 'grant-consume-before-journal') {
      throw new SimulatedExecutionReplacementCrash(
        'grant-consume-before-journal',
      );
    }
  }
  assertReceipt(transaction, receipt);
  const { recordDigest: _recordDigest, ...transactionCore } = transaction;
  const next = createTransaction({
    ...transactionCore,
    phase: 'grant-consumed' as const,
    receipt,
    updatedAt: receipt.consumedAt,
  });
  writeTransaction(
    paths,
    replacementTransactionPath(storeRoot, transaction.transactionId),
    next,
    true,
  );
  if (options.simulateCrashAfter === 'grant-consumed') {
    throw new SimulatedExecutionReplacementCrash('grant-consumed');
  }
  return next;
}

function publishReplacement(
  cwd: string,
  transaction: ExecutionReplacementTransaction,
): void {
  assertReceipt(transaction, transaction.receipt);
  const context = loadInvestigationRuntimeContext(cwd);
  if (isPublishedReplacement(cwd, transaction)) {
    return;
  }
  const failed = readProviderInvocation(
    context.runtime,
    transaction.failedInvocationId,
  );
  const output = getProposeStatus(cwd, failed.investigationId);
  const authorization = {
    grantId: transaction.grantId,
    grantRequest: transaction.request,
    receipt: transaction.receipt!,
    replacementRequest: transaction.replacementRequest,
  };
  const envelope =
    failed.purpose === 'survey'
      ? createProviderRetryEnvelope(cwd, output, {
          acknowledgeProviderCost: true,
        })
      : createPlanReviewRetryEnvelope(cwd, output, {
          acknowledgeProviderCost: true,
        });
  resumePropose(cwd, failed.changeId, envelope, {
    executionGrantAuthorization: authorization,
  });
  assertPublishedReplacement(cwd, transaction);
}

function assertPublishedReplacement(
  cwd: string,
  transaction: ExecutionReplacementTransaction,
): void {
  const context = loadInvestigationRuntimeContext(cwd);
  if (
    !providerInvocationExists(
      context.runtime,
      transaction.replacementInvocationId,
    )
  ) {
    throw replacementStale();
  }
  const record = readProviderInvocation(
    context.runtime,
    transaction.replacementInvocationId,
  );
  const request = readProviderInvocationRequest(
    context.runtime,
    transaction.replacementInvocationId,
  );
  if (
    record.attempt !==
      readProviderInvocation(context.runtime, transaction.failedInvocationId)
        .attempt +
        1 ||
    record.requestDigest !== transaction.replacementRequest.requestDigest ||
    canonicalJson(request) !== canonicalJson(transaction.replacementRequest)
  ) {
    throw replacementStale();
  }
  const output = getProposeStatus(cwd, record.investigationId);
  const referenced =
    record.purpose === 'survey'
      ? output.investigation?.kind === 'investigation' &&
        output.investigation.providerInvocationId === record.invocationId
      : output.planReview?.invocationId === record.invocationId;
  if (!referenced) throw replacementStale();
}

function isPublishedReplacement(
  cwd: string,
  transaction: ExecutionReplacementTransaction,
): boolean {
  const context = loadInvestigationRuntimeContext(cwd);
  if (
    !providerInvocationExists(
      context.runtime,
      transaction.replacementInvocationId,
    )
  ) {
    return false;
  }
  const record = readProviderInvocation(
    context.runtime,
    transaction.replacementInvocationId,
  );
  const output = getProposeStatus(cwd, record.investigationId);
  return record.purpose === 'survey'
    ? output.investigation?.kind === 'investigation' &&
        output.investigation.providerInvocationId === record.invocationId
    : output.planReview?.invocationId === record.invocationId;
}

function requestExecutionReplacementBytes(
  inspection: ReturnType<typeof inspectExecutionJob>,
  timeoutMs: number,
  previousProviderPolicyDigest: string,
  providerPolicyDigest: string,
  providerPolicyTimeoutCeilingMs: number,
): string {
  const previous = inspection.attempts.at(-1);
  const base = inspection.latestFailure?.decision.requiredGrant;
  if (
    previous === undefined ||
    previous.failure === null ||
    base === undefined
  ) {
    throw replacementNotGrantable();
  }
  const previewChanges = [
    {
      path: '/timeoutMs',
      from: previous.policySnapshot.timeoutMs,
      to: timeoutMs,
    },
  ];
  const changes = mergeExactChanges([
    ...base.requestedChanges,
    ...previewChanges,
    ...(timeoutMs > providerPolicyTimeoutCeilingMs
      ? [
          {
            path: '/providerPolicy/limits/timeoutMs',
            from: providerPolicyTimeoutCeilingMs,
            to: timeoutMs,
          },
        ]
      : []),
    ...(previousProviderPolicyDigest === providerPolicyDigest
      ? []
      : [
          {
            path: '/providerPolicyDigest',
            from: previousProviderPolicyDigest,
            to: providerPolicyDigest,
          },
        ]),
  ]);
  const request = createExecutionBudgetGrantRequest({
    requestId: deterministicUuid({
      kind: 'execution-replacement-request',
      jobId: inspection.job.jobId,
      failedAttemptId: previous.attemptId,
      changes,
    }),
    workflowId: inspection.workflow.workflowId,
    epoch: inspection.job.epoch,
    jobId: inspection.job.jobId,
    mandateBinding: requireExecutionJobMandateBinding(inspection.job),
    requestedChanges: changes,
    rationale: replacementRationale(previous, timeoutMs, providerPolicyDigest),
    expiresAfterAttempts: 1,
    createdAt: new Date(previous.updatedAt),
  });
  assertCompleteReplacementDelta(
    request,
    inspection.job.retryPolicy.maxAttempts,
    previous.policySnapshot.timeoutMs,
    timeoutMs,
    providerPolicyTimeoutCeilingMs,
  );
  return canonicalExecutionBudgetGrantRequest(request);
}

function assertCurrentTransactionLineage(
  cwd: string,
  transaction: ExecutionReplacementTransaction,
): void {
  const inspection = inspectExecutionJob(cwd, transaction.jobId);
  const failed = inspection.attempts.find(
    ({ attemptId }) => attemptId === transaction.failedAttemptId,
  );
  const context = loadInvestigationRuntimeContext(cwd);
  const record = readProviderInvocation(
    context.runtime,
    transaction.failedInvocationId,
  );
  const failedRequest = readProviderInvocationRequest(
    context.runtime,
    transaction.failedInvocationId,
  );
  const persistedRequest = readPersistedRequest(
    context.runtime,
    context.lifecycleRuntime.root,
    transaction.requestDigest,
  );
  const binding = readRequestBinding(
    context.runtime,
    context.lifecycleRuntime.root,
    transaction.requestDigest,
  );
  const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
  const timeoutMs = replacementTimeout(transaction.request);
  const expectedReplacementRequest = createProviderInvocationRequest({
    invocationId: transaction.replacementInvocationId,
    nonce: `execution-grant-retry-${digestCanonical({ grantId: transaction.grantId, requestDigest: transaction.requestDigest }).slice(7)}`,
    purpose: failedRequest.purpose,
    providerId: failedRequest.providerId,
    roleAssignment: failedRequest.roleAssignment,
    capabilityProfile: failedRequest.capabilityProfile,
    repositoryId: failedRequest.repositoryId,
    baseCommit: failedRequest.baseCommit,
    baseTree: failedRequest.baseTree,
    targetDigest: failedRequest.targetDigest,
    inputManifestDigest: failedRequest.inputManifestDigest,
    authorizationNodeId: failedRequest.authorizationNodeId,
    writeAllowedPaths: [...failedRequest.writeAllowedPaths],
    outputSchema: failedRequest.outputSchema,
    evaluatorVersion: failedRequest.evaluatorVersion,
    policyDigest: binding.providerPolicyDigest,
    limits: {
      timeoutMs,
      aggregateOutputBytes: failedRequest.limits.aggregateOutputBytes,
    },
  });
  const grant = inspectExecutionBudgetGrantAuthorization(
    context.lifecycleRuntime.root,
    transaction.grantId,
  );
  const durableReceipt = grant.receipts.find(
    ({ attemptId }) => attemptId === transaction.replacementAttemptId,
  );
  if (
    inspection.workflow.workflowId !== transaction.workflowId ||
    inspection.job.epoch !== transaction.epoch ||
    inspection.job.contextDigest !== transaction.contextDigest ||
    inspection.acceptedAttemptId !== null ||
    failed?.failure?.fingerprint !== transaction.failureFingerprint ||
    record.revision !== transaction.failedInvocationRevision ||
    record.state !== 'failed' ||
    binding.failedAttemptId !== transaction.failedAttemptId ||
    binding.failedInvocationId !== transaction.failedInvocationId ||
    binding.failedInvocationRevision !== transaction.failedInvocationRevision ||
    binding.failureFingerprint !== transaction.failureFingerprint ||
    binding.providerPolicyDigest !== policy.digest ||
    binding.providerPolicyDocumentDigest !== digestText(policy.document) ||
    canonicalJson(persistedRequest) !== canonicalJson(transaction.request) ||
    canonicalJson(expectedReplacementRequest) !==
      canonicalJson(transaction.replacementRequest) ||
    grant.payload.requestDigest !== transaction.requestDigest ||
    (transaction.receipt !== null &&
      (durableReceipt === undefined ||
        canonicalJson(durableReceipt) !== canonicalJson(transaction.receipt)))
  ) {
    throw replacementStale();
  }
}

function assertCompleteReplacementDelta(
  request: ExecutionBudgetGrantRequest,
  maxAttempts: number,
  oldTimeoutMs: number,
  timeoutMs: number,
  providerPolicyTimeoutCeilingMs: number,
): void {
  const maxAttemptsChange = request.requestedChanges.find(
    ({ path }) => path === '/retryPolicy/maxAttempts',
  );
  const timeoutChange = request.requestedChanges.find(
    ({ path }) => path === '/timeoutMs',
  );
  const ceilingChange = request.requestedChanges.find(
    ({ path }) => path === '/providerPolicy/limits/timeoutMs',
  );
  if (
    maxAttemptsChange === undefined ||
    timeoutChange === undefined ||
    canonicalJson(maxAttemptsChange) !==
      canonicalJson({
        path: '/retryPolicy/maxAttempts',
        from: maxAttempts,
        to: maxAttempts + 1,
      }) ||
    canonicalJson(timeoutChange) !==
      canonicalJson({
        path: '/timeoutMs',
        from: oldTimeoutMs,
        to: timeoutMs,
      }) ||
    (timeoutMs > providerPolicyTimeoutCeilingMs
      ? canonicalJson(ceilingChange) !==
        canonicalJson({
          path: '/providerPolicy/limits/timeoutMs',
          from: providerPolicyTimeoutCeilingMs,
          to: timeoutMs,
        })
      : ceilingChange !== undefined)
  ) {
    throw grantMismatch(
      'GrantRequest must contain exactly one maxAttempts increment and the timeout delta.',
    );
  }
}

function replacementRationale(
  previous: ReturnType<typeof inspectExecutionJob>['attempts'][number],
  timeoutMs: number,
  providerPolicyDigest: string,
): string {
  if (previous.failure === null || !isProviderDigest(providerPolicyDigest)) {
    throw replacementStale();
  }
  return (
    `Authorize exactly Attempt ${previous.attemptNumber + 1} after failed ${previous.attemptId} ` +
    `(${previous.failure.code}, ${previous.failure.fingerprint}): extend maxAttempts once and change timeout ` +
    `${previous.policySnapshot.timeoutMs}ms to ${timeoutMs}ms under provider policy ${providerPolicyDigest}.`
  );
}

function mergeExactChanges(
  changes: ExecutionBudgetGrantRequest['requestedChanges'],
): ExecutionBudgetGrantRequest['requestedChanges'] {
  const byPath = new Map<string, (typeof changes)[number]>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(change)
    ) {
      throw grantMismatch(`Conflicting replacement delta at ${change.path}.`);
    }
    byPath.set(change.path, structuredClone(change));
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function replacementTimeout(request: ExecutionBudgetGrantRequest): number {
  const change = request.requestedChanges.find(
    ({ path }) => path === '/timeoutMs',
  );
  if (change === undefined || !Number.isSafeInteger(change.to)) {
    throw grantMismatch('GrantRequest has no exact timeout replacement delta.');
  }
  assertTimeout(change.to as number);
  return change.to as number;
}

function createRequestBinding(
  input: Omit<
    ExecutionReplacementRequestBinding,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): ExecutionReplacementRequestBinding {
  const core = {
    schemaVersion: 1 as const,
    kind: 'execution-replacement-request-binding' as const,
    ...input,
  };
  return assertRequestBinding({
    ...core,
    recordDigest: digestCanonical(core),
  });
}

function assertRequestBinding(
  value: unknown,
): ExecutionReplacementRequestBinding {
  const keys = [
    'contextDigest',
    'epoch',
    'failedAttemptId',
    'failedInvocationId',
    'failedInvocationRevision',
    'failureFingerprint',
    'jobId',
    'kind',
    'providerPolicyDigest',
    'providerPolicyDocumentDigest',
    'recordDigest',
    'requestDigest',
    'schemaVersion',
    'workflowId',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-replacement-request-binding' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.contextDigest) ||
    !isDigest(value.failureFingerprint) ||
    !isProviderDigest(value.providerPolicyDigest) ||
    !isDigest(value.providerPolicyDocumentDigest) ||
    !isDigest(value.recordDigest) ||
    !isIdentity(value.workflowId) ||
    !isIdentity(value.jobId) ||
    !isIdentity(value.failedAttemptId) ||
    !isIdentity(value.failedInvocationId) ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !Number.isSafeInteger(value.failedInvocationRevision) ||
    (value.failedInvocationRevision as number) < 0
  ) {
    throw replacementUnsafe();
  }
  const { recordDigest, ...core } = value;
  if (recordDigest !== digestCanonical(core)) throw replacementUnsafe();
  return Object.freeze(
    structuredClone(value),
  ) as ExecutionReplacementRequestBinding;
}

function createTransaction(
  input: Omit<ExecutionReplacementTransaction, 'recordDigest'>,
): ExecutionReplacementTransaction {
  return assertTransactionRecord({
    ...input,
    recordDigest: digestCanonical(input),
  });
}

function assertTransactionRecord(
  value: unknown,
): ExecutionReplacementTransaction {
  const keys = [
    'contextDigest',
    'createdAt',
    'epoch',
    'failedAttemptId',
    'failedInvocationId',
    'failedInvocationRevision',
    'failureFingerprint',
    'grantId',
    'jobId',
    'kind',
    'phase',
    'receipt',
    'recordDigest',
    'replacementAttemptId',
    'replacementInvocationId',
    'replacementRequest',
    'request',
    'requestDigest',
    'schemaVersion',
    'transactionId',
    'updatedAt',
    'workflowId',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-replacement-transaction' ||
    ![
      'prepared',
      'grant-consumed',
      'invocation-published',
      'dispatch-issued',
      'complete',
    ].includes(value.phase as string) ||
    !isDigest(value.transactionId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.contextDigest) ||
    !isDigest(value.failureFingerprint) ||
    !isDigest(value.recordDigest) ||
    !isUuid(value.grantId) ||
    !isIdentity(value.workflowId) ||
    !isIdentity(value.jobId) ||
    !isIdentity(value.failedAttemptId) ||
    !isIdentity(value.failedInvocationId) ||
    !isIdentity(value.replacementAttemptId) ||
    !isIdentity(value.replacementInvocationId) ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !Number.isSafeInteger(value.failedInvocationRevision) ||
    (value.failedInvocationRevision as number) < 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw replacementUnsafe();
  }
  let request: ExecutionBudgetGrantRequest;
  let replacementRequest: ReturnType<typeof recreateProviderInvocationRequest>;
  try {
    request = parseExecutionBudgetGrantRequest(
      `${canonicalJson(value.request)}\n`,
    );
    replacementRequest = recreateProviderInvocationRequest(
      value.replacementRequest,
    );
  } catch {
    throw replacementUnsafe();
  }
  const receipt = value.receipt;
  if (
    (value.phase === 'prepared') !== (receipt === null) ||
    (receipt !== null && !isReceipt(receipt)) ||
    request.workflowId !== value.workflowId ||
    request.epoch !== value.epoch ||
    request.jobId !== value.jobId ||
    digestText(canonicalExecutionBudgetGrantRequest(request)) !==
      value.requestDigest ||
    replacementRequest.invocationId !== value.replacementInvocationId ||
    value.replacementAttemptId !==
      `attempt-legacy-${value.replacementInvocationId}` ||
    value.transactionId !==
      digestCanonical({
        kind: 'execution-replacement-transaction',
        grantId: value.grantId,
        requestDigest: value.requestDigest,
        replacementAttemptId: value.replacementAttemptId,
      }) ||
    Date.parse(value.updatedAt as string) <
      Date.parse(value.createdAt as string)
  ) {
    throw replacementUnsafe();
  }
  if (receipt !== null) {
    if (
      receipt.grantId !== value.grantId ||
      receipt.requestDigest !== value.requestDigest ||
      receipt.workflowId !== value.workflowId ||
      receipt.epoch !== value.epoch ||
      receipt.jobId !== value.jobId ||
      receipt.attemptId !== value.replacementAttemptId ||
      request.mandateBinding === undefined ||
      canonicalJson(receipt.mandateBinding) !==
        canonicalJson(request.mandateBinding)
    ) {
      throw replacementUnsafe();
    }
  }
  const { recordDigest, ...core } = value;
  if (recordDigest !== digestCanonical(core)) throw replacementUnsafe();
  return Object.freeze(
    structuredClone(value),
  ) as ExecutionReplacementTransaction;
}

function isReceipt(value: unknown): value is ExecutionBudgetConsumeReceipt {
  if (!(
    isRecord(value) &&
    hasExactKeys(value, [
      'attemptId',
      'consumedAt',
      'epoch',
      'grantId',
      'jobId',
      'kind',
      'mandateBinding',
      'receiptId',
      'remainingUses',
      'requestDigest',
      'schemaVersion',
      'useNumber',
      'workflowId',
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === 'execution-budget-consume-receipt' &&
    isDigest(value.receiptId) &&
    isDigest(value.requestDigest) &&
    isUuid(value.grantId) &&
    isIdentity(value.workflowId) &&
    isIdentity(value.jobId) &&
    isIdentity(value.attemptId) &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) > 0 &&
    Number.isSafeInteger(value.useNumber) &&
    (value.useNumber as number) > 0 &&
    Number.isSafeInteger(value.remainingUses) &&
    (value.remainingUses as number) >= 0 &&
    isTimestamp(value.consumedAt)
  ))
    return false;
  const { receiptId, ...core } = value;
  return receiptId === digestText(canonicalJson(core));
}

function readPersistedRequest(
  paths: InvestigationRuntimePaths,
  storeRoot: string,
  requestDigest: string,
): ExecutionBudgetGrantRequest {
  const filePath = replacementRequestPath(storeRoot, requestDigest);
  try {
    const value = readPrivateCanonicalJson(paths, filePath, replacementUnsafe);
    const request = parseExecutionBudgetGrantRequest(
      `${canonicalJson(value)}\n`,
    );
    if (
      digestText(canonicalExecutionBudgetGrantRequest(request)) !==
      requestDigest
    ) {
      throw replacementUnsafe();
    }
    return request;
  } catch {
    throw grantMismatch(
      'Canonical execution replacement request is missing or unsafe.',
    );
  }
}

function readRequestBinding(
  paths: InvestigationRuntimePaths,
  storeRoot: string,
  requestDigest: string,
): ExecutionReplacementRequestBinding {
  return assertRequestBinding(
    readPrivateCanonicalJson(
      paths,
      replacementRequestBindingPath(storeRoot, requestDigest),
      replacementUnsafe,
    ),
  );
}

function replacementRoot(storeRoot: string): string {
  return path.join(storeRoot, 'execution-replacements');
}

function replacementRequestPath(storeRoot: string, digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
  return path.join(
    replacementRoot(storeRoot),
    'requests',
    `${digest.slice(7)}.json`,
  );
}

function replacementRequestBindingPath(
  storeRoot: string,
  digest: string,
): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
  return path.join(
    replacementRoot(storeRoot),
    'request-bindings',
    `${digest.slice(7)}.json`,
  );
}

function replacementTransactionPath(storeRoot: string, digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
  return path.join(
    replacementRoot(storeRoot),
    'transactions',
    `${digest.slice(7)}.json`,
  );
}

function readTransactionIfPresent(
  paths: InvestigationRuntimePaths,
  filePath: string,
): ExecutionReplacementTransaction | null {
  if (!privatePathExists(paths, filePath, replacementUnsafe)) return null;
  return assertTransactionRecord(
    readPrivateCanonicalJson(paths, filePath, replacementUnsafe),
  );
}

function writeTransaction(
  paths: InvestigationRuntimePaths,
  filePath: string,
  transaction: ExecutionReplacementTransaction,
  replace: boolean,
): void {
  assertTransactionRecord(transaction);
  if (!replace) {
    createPrivateCanonicalJson(
      paths,
      filePath,
      transaction,
      replacementUnsafe,
      'EXECUTION_REPLACEMENT_TRANSACTION_CONFLICT',
    );
    return;
  }
  writePrivateCanonicalJsonAtomic(
    paths,
    filePath,
    transaction,
    replacementUnsafe,
  );
}

function advanceTransaction(
  paths: InvestigationRuntimePaths,
  filePath: string,
  transaction: ExecutionReplacementTransaction,
  phase: ExecutionReplacementPhase,
  updatedAt: string,
): ExecutionReplacementTransaction {
  const durable = readTransactionIfPresent(paths, filePath);
  if (durable === null) throw replacementUnsafe();
  assertTransactionIdentity(durable, {
    transactionId: transaction.transactionId,
    grantId: transaction.grantId,
    requestDigest: transaction.requestDigest,
    jobId: transaction.jobId,
    replacementAttemptId: transaction.replacementAttemptId,
    replacementInvocationId: transaction.replacementInvocationId,
  });
  if (phaseRank(durable.phase) >= phaseRank(phase)) return durable;
  if (phaseRank(durable.phase) + 1 !== phaseRank(phase)) {
    throw replacementUnsafe();
  }
  const { recordDigest: _recordDigest, ...durableCore } = durable;
  const next = createTransaction({ ...durableCore, phase, updatedAt });
  writeTransaction(paths, filePath, next, true);
  return next;
}

function phaseRank(phase: ExecutionReplacementPhase): number {
  return [
    'prepared',
    'grant-consumed',
    'invocation-published',
    'dispatch-issued',
    'complete',
  ].indexOf(phase);
}

function assertReceipt(
  transaction: ExecutionReplacementTransaction,
  receipt: ExecutionBudgetConsumeReceipt | null,
): asserts receipt is ExecutionBudgetConsumeReceipt {
  if (
    receipt === null ||
    receipt.grantId !== transaction.grantId ||
    receipt.requestDigest !== transaction.requestDigest ||
    receipt.workflowId !== transaction.workflowId ||
    receipt.epoch !== transaction.epoch ||
    receipt.jobId !== transaction.jobId ||
    receipt.attemptId !== transaction.replacementAttemptId
  ) {
    throw grantMismatch(
      'Grant receipt does not bind the exact replacement Attempt.',
    );
  }
}

function assertTransactionIdentity(
  transaction: ExecutionReplacementTransaction,
  expected: Pick<
    ExecutionReplacementTransaction,
    | 'transactionId'
    | 'grantId'
    | 'requestDigest'
    | 'jobId'
    | 'replacementAttemptId'
    | 'replacementInvocationId'
  >,
): void {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (transaction[key] !== expected[key]) throw replacementUnsafe();
  }
}

function assertTimeout(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PROVIDER_LIMITS.timeoutMs
  ) {
    throw workflowError(
      'EXECUTION_REPLACEMENT_TIMEOUT_INVALID',
      'Replacement timeout must be a bounded positive integer.',
      ExitCode.usage,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return canonicalJson(actual) === canonicalJson(sortedExpected);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isProviderDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function deterministicUuid(value: unknown): string {
  const hex = crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function replacementNotGrantable() {
  return workflowError(
    'EXECUTION_REPLACEMENT_GRANT_NOT_AVAILABLE',
    'The current failed Attempt has no bounded replacement grant request.',
    ExitCode.guard,
  );
}

function grantMismatch(message: string) {
  return workflowError(
    'EXECUTION_REPLACEMENT_GRANT_MISMATCH',
    message,
    ExitCode.guard,
  );
}

function replacementStale() {
  return workflowError(
    'EXECUTION_REPLACEMENT_STALE',
    'Job, epoch, context, failure, or provider revision changed before replacement dispatch.',
    ExitCode.staleState,
  );
}

function replacementUnsafe() {
  return workflowError(
    'EXECUTION_REPLACEMENT_STORE_UNSAFE',
    'Durable execution replacement state is malformed or unsafe.',
    ExitCode.staleState,
  );
}
