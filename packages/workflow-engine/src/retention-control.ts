import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { projectProviderInvocationExecution } from './execution-core.ts';
import { listExecutionJobStates } from './execution-store.ts';
import {
  inspectDurableEpochContextStore,
  inspectDurableRetentionCatalog,
  pinDurableEvidence,
  storeDurableEvidence,
  planEvidencePruning,
  pruneDurableEvidence,
  type DurablePruneReceipt,
  type EvidenceRetentionRecord,
} from './execution-governance.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { listProviderInvocationLifecycleProjections } from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import { inspectProviderPromptContextRetentionBinding } from './provider-execution-governance.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
} from './provider-invocation-store.ts';
import {
  inspectProviderRetentionMetrics,
  providerRuntimeEvidenceId,
  pruneProviderRuntime,
  type ProviderRetentionMetrics,
  type ProviderRetentionPassResult,
} from './provider-retention.ts';
import {
  inspectActiveTaskMandateBinding,
  type TaskMandateBinding,
} from './task-mandate.ts';

export const RETENTION_MAINTENANCE_MAX_WORKFLOWS = 100;

export type EvidenceRetentionMaintenanceResult = Readonly<{
  schemaVersion: 1;
  kind: 'evidence-retention-maintenance.v1';
  provider: ProviderRetentionPassResult;
  durableContexts: Readonly<{
    examined: number;
    pruned: ReadonlyArray<{
      workflowId: string;
      deleted: number;
      receipt: DurablePruneReceipt;
    }>;
    skipped: ReadonlyArray<{
      workflowId: string;
      reason: 'context-not-found' | 'nothing-expired';
    }>;
  }>;
}>;

export type EvidenceRetentionInspection = Readonly<{
  schemaVersion: 1;
  kind: 'evidence-retention-inspection.v1';
  provider: ProviderRetentionMetrics;
  durableContexts: ReadonlyArray<{
    workflowId: string;
    currentEpoch: number;
    contextGeneration: number;
    catalogGeneration: number;
    records: number;
    active: number;
    expiring: number;
    pinned: number;
  }>;
}>;

/**
 * Runs one bounded repository maintenance pass. Provider raw artifacts and the
 * generic durable context store use separate crash-safe receipts, but share a
 * single exact observation time and bounded caller budget.
 */
export function runEvidenceRetentionMaintenance(
  cwd: string,
  input: { limit: number; now?: string },
): EvidenceRetentionMaintenanceResult {
  const limit = assertLimit(input.limit);
  const now = exactTimestamp(input.now ?? new Date().toISOString());
  const provider = pruneProviderRuntime(cwd, { limit, now });
  const storeRoot = loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  const workflows = durableContextEntries(cwd).slice(0, limit);
  const pruned: Array<{
    workflowId: string;
    deleted: number;
    receipt: DurablePruneReceipt;
  }> = [];
  const skipped: Array<{
    workflowId: string;
    reason: 'context-not-found' | 'nothing-expired';
  }> = [];
  for (const { workflowId } of workflows) {
    let context;
    let catalog;
    try {
      context = inspectDurableEpochContextStore(storeRoot, workflowId);
      catalog = inspectDurableRetentionCatalog(storeRoot, workflowId);
    } catch (error) {
      if (isWorkflowError(error, 'EXECUTION_CONTEXT_NOT_FOUND')) {
        skipped.push({ workflowId, reason: 'context-not-found' });
        continue;
      }
      throw error;
    }
    const plan = planEvidencePruning({
      records: catalog.records,
      currentEpoch: context.workflow.currentEpoch,
      currentManifest: context.currentManifest,
      now: new Date(now),
    });
    if (plan.delete.length === 0) {
      skipped.push({ workflowId, reason: 'nothing-expired' });
      continue;
    }
    const result = pruneDurableEvidence(storeRoot, {
      workflowId,
      expectedContextGeneration: context.generation,
      expectedEpoch: context.workflow.currentEpoch,
      expectedContextDigest: context.workflow.contextDigest,
      expectedCatalogGeneration: catalog.generation,
      now: new Date(now),
    });
    pruned.push({
      workflowId,
      deleted: result.receipt.deleted.length,
      receipt: result.receipt,
    });
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'evidence-retention-maintenance.v1' as const,
    provider,
    durableContexts: {
      examined: workflows.length,
      pruned,
      skipped,
    },
  });
}

export function inspectEvidenceRetention(
  cwd: string,
  input: { now?: string } = {},
): EvidenceRetentionInspection {
  const now = exactTimestamp(input.now ?? new Date().toISOString());
  const storeRoot = loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  const durableContexts = durableContextEntries(cwd).flatMap(
    ({ workflowId }) => {
      try {
        const context = inspectDurableEpochContextStore(storeRoot, workflowId);
        const catalog = inspectDurableRetentionCatalog(storeRoot, workflowId);
        return [
          {
            workflowId,
            currentEpoch: context.workflow.currentEpoch,
            contextGeneration: context.generation,
            catalogGeneration: catalog.generation,
            records: catalog.records.length,
            active: catalog.records.filter(
              ({ retention }) => retention === 'active',
            ).length,
            expiring: catalog.records.filter(
              ({ retention }) => retention === 'expiring',
            ).length,
            pinned: catalog.records.filter(
              ({ retention }) => retention === 'pinned',
            ).length,
          },
        ];
      } catch (error) {
        if (isWorkflowError(error, 'EXECUTION_CONTEXT_NOT_FOUND')) return [];
        throw error;
      }
    },
  );
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'evidence-retention-inspection.v1' as const,
    provider: inspectProviderRetentionMetrics(cwd, { now }),
    durableContexts,
  });
}

/**
 * Registers one Attempt's private provider runtime in the durable catalog so a
 * maintainer has something to pin. An Attempt's own retention is projected from
 * its legacy invocation and can never carry a pin, so without a catalog entry
 * the human-presence ceremony would protect nothing. The stored descriptor
 * names the runtime rather than copying it: the raw bytes stay where they are,
 * and this record is the handle the pruning pass consults.
 */
export function registerProviderRuntimeEvidence(
  cwd: string,
  request: { workflowId: string; attemptId: string },
  options: { now?: Date } = {},
): Readonly<{ workflowId: string; evidenceId: string; created: boolean }> {
  const context = loadInvestigationRuntimeContext(cwd);
  const storeRoot = context.lifecycleRuntime.root;
  const evidenceId = providerRuntimeEvidenceId(request.attemptId);
  const catalog = inspectDurableRetentionCatalog(storeRoot, request.workflowId);
  if (catalog.records.some((record) => record.evidenceId === evidenceId)) {
    return { workflowId: request.workflowId, evidenceId, created: false };
  }

  const state = listExecutionJobStates(context.runtime).find(
    (candidate) =>
      candidate.workflow.workflowId === request.workflowId &&
      candidate.attempts.some(
        ({ attemptId }) => attemptId === request.attemptId,
      ),
  );
  const attempt = state?.attempts.find(
    ({ attemptId }) => attemptId === request.attemptId,
  );
  if (state === undefined || attempt === undefined) {
    throw workflowError(
      'RETENTION_EVIDENCE_NOT_FOUND',
      `Attempt ${request.attemptId} was not found in workflow ${request.workflowId}.`,
      ExitCode.guard,
    );
  }
  if (attempt.legacyInvocation === null) {
    throw workflowError(
      'RETENTION_EVIDENCE_NOT_FOUND',
      `Attempt ${request.attemptId} has no provider runtime to retain.`,
      ExitCode.guard,
    );
  }

  const content = `${canonicalJson({
    kind: 'provider-runtime-evidence.v1',
    workflowId: state.workflow.workflowId,
    epoch: attempt.epoch,
    attemptId: attempt.attemptId,
    invocationId: attempt.legacyInvocation.invocationId,
    legacyRevision: attempt.legacyInvocation.legacyRevision,
  })}\n`;
  const now = options.now ?? new Date();
  storeDurableEvidence(storeRoot, {
    workflowId: state.workflow.workflowId,
    expectedCatalogGeneration: catalog.generation,
    record: {
      schemaVersion: 1,
      kind: 'evidence-retention',
      evidenceId,
      itemIdentity: `attempt:${attempt.attemptId}`,
      workflowId: state.workflow.workflowId,
      epoch: attempt.epoch,
      evidenceClass: 'raw',
      digest: crypto.createHash('sha256').update(content).digest('hex'),
      retention: 'active',
      createdAt: now.toISOString(),
      expiresAt: null,
      pin: null,
    },
    content,
  });
  return { workflowId: request.workflowId, evidenceId, created: true };
}

export function pinWorkflowEvidence(
  cwd: string,
  request: { workflowId: string; evidenceId: string; reason: string },
  options: { now?: Date; signer?: MaintainerSignerProvider } = {},
): Readonly<{
  workflowId: string;
  evidenceId: string;
  record: EvidenceRetentionRecord;
  catalogGeneration: number;
  replayed: boolean;
}> {
  const reason = assertReason(request.reason);
  const entries = durableContextEntries(cwd).filter(
    (entry) => entry.workflowId === request.workflowId,
  );
  if (entries.length === 0) {
    throw workflowError(
      'RETENTION_WORKFLOW_NOT_FOUND',
      `Execution workflow ${request.workflowId} was not found.`,
      ExitCode.guard,
    );
  }
  const binding = exactWorkflowMandateBinding(
    entries.map(({ mandateBinding }) => mandateBinding),
  );
  const active = inspectActiveTaskMandateBinding(cwd, binding.mandateTaskId, {
    now: options.now,
    ...(options.signer === undefined ? {} : { signer: options.signer }),
  });
  if (canonicalJson(active) !== canonicalJson(binding)) {
    throw workflowError(
      'RETENTION_TASK_MANDATE_MISMATCH',
      'Evidence retention authority no longer matches the exact active Task Mandate.',
      ExitCode.staleState,
    );
  }
  const storeRoot = loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  const catalog = inspectDurableRetentionCatalog(storeRoot, request.workflowId);
  const current = catalog.records.find(
    ({ evidenceId }) => evidenceId === request.evidenceId,
  );
  if (current === undefined) {
    throw workflowError(
      'RETENTION_EVIDENCE_NOT_FOUND',
      `Evidence ${request.evidenceId} was not found.`,
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
  signer.assertHumanPresent();
  const actor = signer.identity();
  if (!policy.trustedSigners.some(({ identity }) => identity === actor)) {
    throw workflowError(
      'RETENTION_PIN_SIGNER_UNTRUSTED',
      'Evidence pinning requires a currently trusted controlling maintainer.',
      ExitCode.verification,
    );
  }
  if (current.retention === 'pinned') {
    if (current.pin?.actor !== actor || current.pin.reason !== reason) {
      throw workflowError(
        'RETENTION_PIN_CONFLICT',
        'Evidence is already pinned by a different durable human decision.',
        ExitCode.conflict,
      );
    }
    return deepFreeze({
      workflowId: request.workflowId,
      evidenceId: request.evidenceId,
      record: current,
      catalogGeneration: catalog.generation,
      replayed: true,
    });
  }
  const updated = pinDurableEvidence(storeRoot, {
    workflowId: request.workflowId,
    evidenceId: request.evidenceId,
    expectedCatalogGeneration: catalog.generation,
    decision: {
      actor,
      reason,
      pinnedAt: options.now ?? new Date(),
      humanConfirmed: true,
    },
  });
  const record = updated.records.find(
    ({ evidenceId }) => evidenceId === request.evidenceId,
  )!;
  return deepFreeze({
    workflowId: request.workflowId,
    evidenceId: request.evidenceId,
    record,
    catalogGeneration: updated.generation,
    replayed: false,
  });
}

function durableContextEntries(cwd: string): Array<{
  workflowId: string;
  mandateBinding: TaskMandateBinding;
}> {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const byWorkflow = new Map<
    string,
    { workflowId: string; mandateBinding: TaskMandateBinding }
  >();
  for (const projection of listProviderInvocationLifecycleProjections(
    runtime,
  )) {
    const record = readProviderInvocation(runtime, projection.invocationId);
    const request = readProviderInvocationRequest(
      runtime,
      projection.invocationId,
    );
    const manifest = readProviderInvocationManifest(
      runtime,
      projection.invocationId,
    );
    const context = inspectProviderPromptContextRetentionBinding(
      runtime.root,
      request,
      manifest,
      projection.ownerInvestigationId,
      record.createdAt,
    );
    if (context === null) continue;
    const execution = projectProviderInvocationExecution({ record, request });
    const mandateBinding = execution.job.mandateBinding;
    if (mandateBinding === undefined) continue;
    const previous = byWorkflow.get(context.workflowId);
    if (
      previous !== undefined &&
      canonicalJson(previous.mandateBinding) !== canonicalJson(mandateBinding)
    ) {
      throw workflowError(
        'RETENTION_WORKFLOW_STATE_AMBIGUOUS',
        `Provider invocations disagree about workflow ${context.workflowId}.`,
        ExitCode.staleState,
      );
    }
    byWorkflow.set(context.workflowId, {
      workflowId: context.workflowId,
      mandateBinding: structuredClone(mandateBinding),
    });
  }
  return [...byWorkflow.values()].sort((left, right) =>
    left.workflowId.localeCompare(right.workflowId),
  );
}

function exactWorkflowMandateBinding(
  bindings: readonly TaskMandateBinding[],
): TaskMandateBinding {
  const first = bindings[0]!;
  if (
    bindings.some((binding) => canonicalJson(binding) !== canonicalJson(first))
  ) {
    throw workflowError(
      'RETENTION_TASK_MANDATE_MISMATCH',
      'Execution jobs disagree about the workflow Task Mandate binding.',
      ExitCode.staleState,
    );
  }
  return structuredClone(first);
}

function assertLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > RETENTION_MAINTENANCE_MAX_WORKFLOWS
  ) {
    throw workflowError(
      'RETENTION_MAINTENANCE_INVALID',
      `Retention maintenance limit must be between 1 and ${RETENTION_MAINTENANCE_MAX_WORKFLOWS}.`,
      ExitCode.usage,
    );
  }
  return value;
}

function assertReason(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value) > 2_048
  ) {
    throw workflowError(
      'RETENTION_PIN_INVALID',
      'Evidence pin reason must be a non-empty trimmed string.',
      ExitCode.usage,
    );
  }
  return value;
}

function exactTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw workflowError(
      'RETENTION_MAINTENANCE_INVALID',
      'Retention maintenance requires an exact ISO-8601 time.',
      ExitCode.usage,
    );
  }
  return value;
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
