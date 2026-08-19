import crypto from 'node:crypto';

import type {
  AuthorityAuditRecordedEvent,
  AuthorityAuditServiceHooks,
} from '../../runtime/storage-journal/authority-audit-service.ts';
import { deriveAuthorityAuditRepositoryId } from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from '../../modules/authority/authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { loadWorkflowConfig } from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { requireExecutionJobMandateBinding } from '../../modules/provider-orchestration/execution-core.ts';
import {
  canonicalExecutionBudgetGrantEnvelope,
  canonicalExecutionBudgetGrantSigningBytes,
  createExecutionBudgetGrantEnvelope,
  EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
  inspectExecutionBudgetGrant,
  inspectExecutionBudgetGrantAuthorization,
  parseExecutionBudgetGrantRequest,
  revokeExecutionBudgetGrant,
  storeExecutionBudgetGrant,
  canonicalExecutionBudgetGrantRequest,
  type ExecutionBudgetGrantEnvelope,
  type ExecutionBudgetGrantRequest,
} from '../../modules/authority/execution-governance.ts';
import { inspectExecutionJob } from '../../runtime/provider-execution/execution-runtime.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
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
} from '../../modules/authority/task-mandate.ts';

export type IssueExecutionBudgetGrantOptions = {
  grantId?: string;
  maxUses?: number;
  now?: Date;
  signer?: MaintainerSignerProvider;
  auditServiceHooks?: AuthorityAuditServiceHooks;
  onAuditRecord?: (entry: AuthorityAuditRecordedEvent) => void;
};

export type IssueExecutionBudgetGrantResult = {
  grantId: string;
  recordPath: string;
  envelope: ExecutionBudgetGrantEnvelope;
};

export function issueExecutionBudgetGrant(
  cwd: string,
  untrustedRequest: ExecutionBudgetGrantRequest,
  options: IssueExecutionBudgetGrantOptions = {},
): IssueExecutionBudgetGrantResult {
  const request = parseExecutionBudgetGrantRequest(
    canonicalExecutionBudgetGrantRequest(untrustedRequest),
  );
  if (request.mandateBinding === undefined) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY',
      'A legacy execution-budget request without a Task Mandate binding cannot be approved.',
      ExitCode.guard,
    );
  }
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const job = inspectExecutionJob(repository.repositoryRoot, request.jobId).job;
  const jobBinding = requireExecutionJobMandateBinding(job);
  const now = options.now ?? new Date();
  const grantId = options.grantId ?? crypto.randomUUID();
  const activeBinding = inspectActiveTaskMandateBinding(
    repository.repositoryRoot,
    jobBinding.mandateTaskId,
    { now, signer },
  );
  const refusalBinding = executionBudgetCliRefusalBinding({
    repositoryRoot: repository.repositoryRoot,
    repositoryIdentity: policy.repository.id,
    mandateBinding: activeBinding,
    operation: 'execution-budget.issue',
    subjectId: grantId,
    workflowId: job.workflowId,
    grantDigest: null,
    candidateBundleDigest: authorityRefusalDigest(request),
    refusalIdentity: {
      grantId,
      requestId: request.requestId,
      jobId: request.jobId,
      requestDigest: authorityRefusalDigest(request),
    },
  });
  return withAuthorityRefusalAudit(
    refusalBinding,
    {
      now,
      serviceHooks: options.auditServiceHooks,
      onRecord: options.onAuditRecord,
    },
    () => {
      if (canonicalJson(activeBinding) !== canonicalJson(jobBinding)) {
        throw workflowError(
          'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
          'Execution Job no longer matches the exact active Task Mandate.',
          ExitCode.staleState,
        );
      }
      if (
        request.workflowId !== job.workflowId ||
        request.epoch !== job.epoch ||
        canonicalJson(request.mandateBinding) !== canonicalJson(jobBinding)
      ) {
        throw workflowError(
          'EXECUTION_BUDGET_GRANT_JOB_MISMATCH',
          'Execution-budget request does not match the exact current Execution Job binding.',
          ExitCode.guard,
        );
      }
      signer.assertHumanPresent();
      const issuer = signer.identity();
      if (!policy.trustedSigners.some(({ identity }) => identity === issuer)) {
        throw workflowError(
          'EXECUTION_BUDGET_GRANT_SIGNER_UNTRUSTED',
          'Execution-budget grant signer is not trusted by the exact repository policy.',
          ExitCode.guard,
        );
      }
      const common = {
        grantId,
        issuedAt: now,
        issuer,
        maxUses: options.maxUses ?? request.expiresAfterAttempts,
      };
      const draft = createExecutionBudgetGrantEnvelope(request, {
        ...common,
        signature: 'pending-human-signature',
      });
      const signingBytes = canonicalExecutionBudgetGrantSigningBytes(
        draft.payload,
      );
      const signature = signer.sign(
        signingBytes,
        EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
      );
      signer.verify(
        signingBytes,
        signature,
        issuer,
        EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
      );
      const envelope = createExecutionBudgetGrantEnvelope(request, {
        ...common,
        signature,
      });
      const config = loadWorkflowConfig(repository.repositoryRoot);
      const runtime = runtimePaths(
        repository.gitCommonDirectory,
        config.runtimeDirectory,
      );
      const recordPath = withActiveTaskMandateBinding(
        repository.repositoryRoot,
        activeBinding.mandateTaskId,
        { now, signer },
        (observedBinding, assertOwned) => {
          if (canonicalJson(observedBinding) !== canonicalJson(jobBinding)) {
            throw workflowError(
              'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
              'Execution Job no longer matches the exact active Task Mandate.',
              ExitCode.staleState,
            );
          }
          assertOwned();
          return storeExecutionBudgetGrant(runtime.root, envelope, {
            request,
            mandateBinding: jobBinding,
            audit: {
              repositoryRoot: repository.repositoryRoot,
              repositoryIdentity: policy.repository.id,
              serviceHooks: options.auditServiceHooks,
              onRecord: options.onAuditRecord,
            },
            verify(payload, observedSignature) {
              signer.verify(
                payload,
                observedSignature,
                issuer,
                EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
              );
            },
          });
        },
      );
      return { grantId: envelope.payload.grantId, recordPath, envelope };
    },
  );
}

export function inspectIssuedExecutionBudgetGrant(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  return inspectExecutionBudgetGrant(
    runtimePaths(repository.gitCommonDirectory, config.runtimeDirectory).root,
    grantId,
  );
}

export function revokeIssuedExecutionBudgetGrant(
  cwd: string,
  grantId: string,
  options: {
    reason: string;
    now?: Date;
    signer?: MaintainerSignerProvider;
    auditServiceHooks?: AuthorityAuditServiceHooks;
    onAuditRecord?: (entry: AuthorityAuditRecordedEvent) => void;
  },
) {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const revoker =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const authorization = inspectExecutionBudgetGrantAuthorization(
    runtime.root,
    grantId,
  );
  const { envelope, payload } = authorization;
  try {
    revoker.verify(
      canonicalExecutionBudgetGrantSigningBytes(payload),
      envelope.signature,
      payload.issuer,
      EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      throw error;
    }
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_SIGNATURE_INVALID',
      'Execution-budget grant signature verification failed before revocation.',
      ExitCode.verification,
    );
  }
  if (payload.mandateBinding === undefined) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY',
      'A legacy execution-budget grant without a Task Mandate binding is read-only.',
      ExitCode.guard,
    );
  }
  const mandateBinding = payload.mandateBinding;
  const now = options.now ?? new Date();
  const grantDigest = `sha256:${crypto
    .createHash('sha256')
    .update(canonicalExecutionBudgetGrantEnvelope(envelope))
    .digest('hex')}` as const;
  const refusalBinding = executionBudgetCliRefusalBinding({
    repositoryRoot: repository.repositoryRoot,
    repositoryIdentity: policy.repository.id,
    mandateBinding,
    operation: 'execution-budget.revoke-issued',
    subjectId: payload.grantId,
    workflowId: payload.workflowId,
    grantDigest,
    refusalIdentity: {
      grantId: payload.grantId,
      jobId: payload.jobId,
      reasonDigest: authorityRefusalDigest(options.reason),
    },
  });
  return withAuthorityRefusalAudit(
    refusalBinding,
    {
      now,
      serviceHooks: options.auditServiceHooks,
      onRecord: options.onAuditRecord,
    },
    () => {
      revoker.assertHumanPresent();
      const revokerIdentity = revoker.identity();
      if (
        !policy.trustedSigners.some(
          ({ identity }) => identity === revokerIdentity,
        )
      ) {
        throw workflowError(
          'EXECUTION_BUDGET_GRANT_REVOKER_UNTRUSTED',
          'Execution-budget revocation requires a trusted controlling maintainer.',
          ExitCode.guard,
        );
      }
      try {
        const job = inspectExecutionJob(
          repository.repositoryRoot,
          payload.jobId,
        ).job;
        const jobBinding = requireExecutionJobMandateBinding(job);
        if (
          payload.workflowId !== job.workflowId ||
          payload.epoch !== job.epoch ||
          canonicalJson(mandateBinding) !== canonicalJson(jobBinding)
        ) {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_JOB_MISMATCH',
            'Execution-budget grant conflicts with the retained Execution Job binding.',
            ExitCode.guard,
          );
        }
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EXECUTION_RUNTIME_JOB_NOT_FOUND'
        )) {
          throw error;
        }
      }
      return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
        assertOwned();
        return revokeExecutionBudgetGrant(runtime.root, {
          grantId,
          mandateBinding,
          reason: options.reason,
          now,
          audit: {
            repositoryRoot: repository.repositoryRoot,
            repositoryIdentity: policy.repository.id,
            actor: { kind: 'human', identity: revokerIdentity },
            serviceHooks: options.auditServiceHooks,
            onRecord: options.onAuditRecord,
          },
        });
      });
    },
  );
}

function executionBudgetCliRefusalBinding(input: {
  repositoryRoot: string;
  repositoryIdentity: string;
  mandateBinding: TaskMandateBinding;
  operation: string;
  subjectId: string;
  workflowId: string;
  grantDigest: `sha256:${string}` | null;
  candidateBundleDigest?: `sha256:${string}`;
  refusalIdentity: Readonly<Record<string, unknown>>;
}): AuthorityRefusalAuditBinding {
  return {
    scope: {
      externalAuditRoot: input.mandateBinding.externalAuditRoot,
      repositoryRoot: input.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(input.repositoryIdentity),
    },
    family: 'execution-budget-grant',
    operation: input.operation,
    subjectId: input.subjectId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: input.mandateBinding.mandateTaskId,
    changeId: input.mandateBinding.changeId,
    workflowId: input.workflowId,
    grantDigest: input.grantDigest,
    candidateBundleDigest: input.candidateBundleDigest ?? null,
    bindingDigest:
      input.grantDigest ?? authorityRefusalDigest(input.mandateBinding),
    refusalIdentity: input.refusalIdentity,
  };
}
