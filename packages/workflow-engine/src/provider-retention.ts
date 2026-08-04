import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import {
  projectProviderInvocationExecution,
  type AttemptRecord,
} from './execution-core.ts';
import {
  readExecutionJobState,
  type DurableExecutionJobState,
} from './execution-store.ts';
import {
  inspectDurableRetentionCatalog,
  type EvidenceRetentionRecord,
} from './execution-governance.ts';
import {
  inspectProviderPromptContextRetentionBinding,
  type ProviderPromptContextRetentionBinding,
} from './provider-execution-governance.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  assertPrivateInvestigationDirectory,
  listProviderInvocationLifecycleProjections,
  privatePathExists,
  readProviderInvocationLifecycleProjection,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import type { InvestigationRuntimePaths } from './paths.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  type ProviderInvocationRecord,
} from './provider-invocation-store.ts';
import {
  PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
  assertRetentionDirectories,
  canonicalProviderRetentionReceipt,
  createProviderRetentionReceipt,
  providerRetentionReceiptPath,
  providerRetentionReceiptId,
  providerRetentionReviewRootArtifact,
  providerRetentionRoot,
  providerRetentionStagingDirectory,
  readProviderRetentionReceipt,
  type ProviderRetentionArtifact,
  type ProviderRetentionArtifactName,
  type ProviderRetentionReceipt,
} from './provider-retention-receipt.ts';
import {
  commitProviderRetentionCatalogCursor,
  readProviderRetentionCatalogBatch,
  readProviderRetentionCatalogEntry,
} from './provider-retention-catalog.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';

export {
  PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
  providerRetentionReceiptPath,
  readProviderRetentionReceipt,
} from './provider-retention-receipt.ts';

const RUNTIME_ARTIFACTS = [
  'runtime/prompt.json',
  'runtime/schema.json',
  'runtime/semantic-output.json',
] as const satisfies readonly ProviderRetentionArtifactName[];
const MAX_RAW_ARTIFACT_BYTES = 16 * 1_048_576;

export const PROVIDER_RETENTION_DEFAULT_TTL_DAYS = 7;
export const PROVIDER_RETENTION_MAX_TTL_DAYS = 90;
export const PROVIDER_RETENTION_MAX_LIMIT = 100;

export type ProviderRetentionDenyReason =
  | 'accepted-result-current'
  | 'active-invocation'
  | 'active-retention'
  | 'already-pruned'
  | 'current-attempt'
  | 'consumed-repair-evidence-unproven'
  | 'nothing-prunable'
  | 'pinned'
  | 'schema-currentness-unknown'
  | 'schema-history-incomplete'
  | 'ttl-not-expired'
  | 'unsafe-artifact';

export type ProviderRetentionPassResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-runtime-prune-pass';
  policy: {
    schemaVersion: 1;
    ttlDays: number;
    maxTtlDays: number;
    cutoffAt: string;
    limit: number;
  };
  examined: number;
  recovered: string[];
  pruned: Array<{
    invocationId: string;
    receiptId: string;
    receiptPath: string;
    artifactCount: number;
    bytes: number;
  }>;
  deniedCount: number;
  denied: Array<{
    invocationId: string;
    reason: ProviderRetentionDenyReason;
  }>;
  deniedTruncated: boolean;
}>;

export type ProviderRetentionOptions = Readonly<{
  limit: number;
  now?: string;
  ttlDays?: number;
}>;

export type ProviderRetentionHooks = Readonly<{
  afterArtifactStaged?: (count: number, invocationId: string) => void;
  afterReceiptCompleted?: (invocationId: string) => void;
}>;

export type ProviderRetentionEligibilityInput = Readonly<{
  invocationState: ProviderInvocationRecord['state'];
  historyComplete: boolean;
  attemptEpoch: number;
  currentEpoch: number;
  retention: AttemptRecord['retention'];
  acceptedAttempt: boolean;
  latestUnacceptedAttempt: boolean;
  terminalAt: string;
  cutoffAt: string;
  /**
   * A human pin recorded in the durable governance catalog. An Attempt's own
   * retention is projected from its legacy invocation and never carries a pin,
   * so the catalog is the only place a maintainer's decision can be read from.
   */
  humanPinned?: boolean;
}>;

/**
 * Stable catalog identity for one Attempt's private provider runtime. A pin
 * recorded against this identity is what keeps the raw prompt, schema, and
 * semantic output from expiring on the ordinary schedule.
 */
export function providerRuntimeEvidenceId(attemptId: string): string {
  return `provider-runtime-${crypto
    .createHash('sha256')
    .update(attemptId)
    .digest('hex')
    .slice(0, 32)}`;
}

export type ProviderRetentionMetrics = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retention-metrics';
  measuredAt: string;
  ttlDays: number;
  rawEvidenceBytesByRetentionClass: Readonly<{
    active: number;
    debug: number;
    pinned: number;
  }>;
  expiredPendingDeletion: Readonly<{
    count: number;
    bytes: number;
  }>;
  pinnedCount: number;
  receiptCount: number;
}>;

/**
 * Reads the human pins recorded for one workflow. A missing or unreadable
 * catalog means no pin has been recorded, which leaves the ordinary schedule
 * in charge rather than silently protecting or deleting anything.
 */
function readHumanPinnedEvidenceIds(
  storeRoot: string,
  workflowId: string,
): ReadonlySet<string> {
  let records: readonly EvidenceRetentionRecord[];
  try {
    records = inspectDurableRetentionCatalog(storeRoot, workflowId).records;
  } catch {
    return new Set();
  }
  return new Set(
    records
      .filter((record) => record.retention === 'pinned' && record.pin !== null)
      .map(({ evidenceId }) => evidenceId),
  );
}

/**
 * Resolves human pins once per workflow within a single pass. The cache is
 * per-pass on purpose: a pin recorded between passes has to be visible to the
 * next one.
 */
function humanPinResolver(
  storeRoot: string,
): (workflowId: string) => ReadonlySet<string> {
  const seen = new Map<string, ReadonlySet<string>>();
  return (workflowId) => {
    const cached = seen.get(workflowId);
    if (cached !== undefined) return cached;
    const pins = readHumanPinnedEvidenceIds(storeRoot, workflowId);
    seen.set(workflowId, pins);
    return pins;
  };
}

/** Pure policy projection used by the physical pass and contract tests. */
export function classifyProviderRetentionEligibility(
  input: ProviderRetentionEligibilityInput,
): ProviderRetentionDenyReason | null {
  if (
    input.invocationState === 'prepared' ||
    input.invocationState === 'leased'
  ) {
    return 'active-invocation';
  }
  if (!input.historyComplete) return 'schema-history-incomplete';
  if (input.retention === 'pinned' || input.humanPinned === true) {
    return 'pinned';
  }
  if (input.acceptedAttempt && input.attemptEpoch === input.currentEpoch) {
    return 'accepted-result-current';
  }
  if (
    !input.acceptedAttempt &&
    input.latestUnacceptedAttempt &&
    input.attemptEpoch === input.currentEpoch
  ) {
    return 'current-attempt';
  }
  // An old epoch is no longer current even if a legacy projection still calls
  // its retention "active". The accepted Result/core stays durable, while its
  // private raw runtime becomes TTL-eligible rather than permanent by accident.
  if (
    input.retention === 'active' &&
    input.attemptEpoch === input.currentEpoch
  ) {
    return 'active-retention';
  }
  if (Date.parse(input.terminalAt) > Date.parse(input.cutoffAt)) {
    return 'ttl-not-expired';
  }
  return null;
}

/**
 * Derive storage metrics from the same strict invocation, Attempt, context,
 * and receipt bindings used by the physical pruning pass. A partial receipt or
 * unprovable lineage fails closed instead of reporting a reassuring estimate.
 */
export function inspectProviderRetentionMetrics(
  cwd: string,
  options: { now?: string; ttlDays?: number } = {},
): ProviderRetentionMetrics {
  const ttlDays = assertTtlDays(
    options.ttlDays ?? PROVIDER_RETENTION_DEFAULT_TTL_DAYS,
  );
  const now = parseTimestamp(options.now ?? new Date().toISOString());
  const cutoffAt = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
  const context = loadInvestigationRuntimeContext(cwd);
  return withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      assertOwned();
      const rawEvidenceBytesByRetentionClass = {
        active: 0,
        debug: 0,
        pinned: 0,
      };
      let expiredPendingCount = 0;
      let expiredPendingBytes = 0;
      let pinnedCount = 0;
      let receiptCount = 0;
      for (const projection of listProviderInvocationLifecycleProjections(
        context.runtime,
      )) {
        assertOwned();
        const record = readProviderInvocation(
          context.runtime,
          projection.invocationId,
        );
        const binding = readInvocationBinding(context.runtime, record);
        if (binding === undefined) throw runtimeUnsafe();
        const receipt = readProviderRetentionReceipt(
          context.runtime,
          record.invocationId,
        );
        if (receipt !== null) {
          assertReceiptBinding(receipt, binding, record);
          if (receipt.state !== 'complete') throw receiptUnsafe();
          receiptCount += 1;
          if (receipt.attemptRetention === 'pinned') pinnedCount += 1;
          continue;
        }
        const artifacts = collectPhysicalArtifacts(context.runtime, binding);
        const bytes = artifacts.reduce(
          (total, artifact) => total + artifact.bytes,
          0,
        );
        rawEvidenceBytesByRetentionClass[binding.attempt.retention] += bytes;
        if (binding.attempt.retention === 'pinned') pinnedCount += 1;
        if (
          privatePathExists(
            context.runtime,
            path.join(
              context.runtime.invocations,
              record.invocationId,
              'repair-evidence.json',
            ),
            runtimeUnsafe,
          )
        ) {
          continue;
        }
        const denial = classifyProviderRetentionEligibility({
          invocationState: record.state,
          historyComplete: binding.state.legacyProjection.completeHistory,
          attemptEpoch: binding.context.epoch,
          currentEpoch: binding.context.currentEpoch,
          retention: binding.attempt.retention,
          acceptedAttempt:
            binding.state.job.acceptedAttemptId === binding.attempt.attemptId,
          latestUnacceptedAttempt:
            binding.state.job.acceptedAttemptId === null &&
            binding.attempt.attemptNumber ===
              Math.max(
                ...binding.state.attempts.map(
                  ({ attemptNumber }) => attemptNumber,
                ),
              ),
          terminalAt: record.updatedAt,
          cutoffAt,
        });
        if (denial === null && bytes > 0) {
          expiredPendingCount += 1;
          expiredPendingBytes += bytes;
        }
      }
      assertOwned();
      return deepFreeze({
        schemaVersion: 1 as const,
        kind: 'provider-retention-metrics' as const,
        measuredAt: now.toISOString(),
        ttlDays,
        rawEvidenceBytesByRetentionClass,
        expiredPendingDeletion: {
          count: expiredPendingCount,
          bytes: expiredPendingBytes,
        },
        pinnedCount,
        receiptCount,
      });
    },
  );
}

type InvocationBinding = Readonly<{
  state: DurableExecutionJobState;
  attempt: AttemptRecord;
  record: ProviderInvocationRecord;
  context: ProviderPromptContextRetentionBinding;
}>;

type CandidateDecision =
  | Readonly<{
      kind: 'deny';
      invocationId: string;
      reason: ProviderRetentionDenyReason;
    }>
  | Readonly<{
      kind: 'prune';
      binding: InvocationBinding;
      artifacts: PhysicalArtifact[];
    }>;

type PhysicalArtifact = Readonly<{
  receiptName: ProviderRetentionArtifactName;
  physicalName: string;
  sourcePath: string;
  stagingPath: string;
  digest: string;
  bytes: number;
}>;

/**
 * Run one bounded physical retention pass. Eligibility comes only from the
 * exact durable Job/Attempt projection; legacy state that cannot prove its
 * current, epoch, and pin status is retained with an explicit deny reason.
 */
export function pruneProviderRuntime(
  cwd: string,
  options: ProviderRetentionOptions,
  hooks: ProviderRetentionHooks = {},
): ProviderRetentionPassResult {
  const limit = assertLimit(options.limit);
  const ttlDays = assertTtlDays(
    options.ttlDays ?? PROVIDER_RETENTION_DEFAULT_TTL_DAYS,
  );
  const now = parseTimestamp(options.now ?? new Date().toISOString());
  const cutoffAt = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
  const context = loadInvestigationRuntimeContext(cwd);

  return withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      assertOwned();
      ensureRetentionDirectories(context.runtime);
      const resolveHumanPins = humanPinResolver(context.lifecycleRuntime.root);
      const recovered: string[] = [];
      let remaining = limit;

      // A transaction creates its staging directory before publishing the
      // prepared receipt and completes one invocation before starting another.
      // Consequently there is at most one crash-recovery item, independent of
      // total history size.
      const recoveredInvocation = recoverInterruptedPruning(
        context.runtime,
        now,
        assertOwned,
        hooks,
      );
      if (recoveredInvocation !== null) {
        recovered.push(recoveredInvocation);
        remaining -= 1;
      }

      const denied: ProviderRetentionPassResult['denied'][number][] = [];
      let deniedCount = 0;
      const pruned: ProviderRetentionPassResult['pruned'][number][] = [];
      let examined = 0;
      const batch = readProviderRetentionCatalogBatch(
        context.runtime,
        remaining,
      );
      for (const { invocationId } of batch.entries) {
        examined += 1;
        const record = readProviderInvocation(context.runtime, invocationId);
        const binding = readInvocationBinding(context.runtime, record);
        const existing = readProviderRetentionReceipt(
          context.runtime,
          record.invocationId,
        );
        if (existing?.state === 'complete') {
          assertReceiptBinding(existing, binding, record);
          cleanupCompletedReceipt(context.runtime, existing, assertOwned);
          recordDenied('already-pruned');
          continue;
        }
        if (existing !== null) throw receiptUnsafe();

        const decision = decideCandidate(
          context.runtime,
          record,
          binding,
          cutoffAt,
          binding === undefined
            ? new Set<string>()
            : resolveHumanPins(binding.state.workflow.workflowId),
        );
        if (decision.kind === 'deny') {
          recordDenied(decision.reason);
          continue;
        }
        const receipt = prepareReceipt(
          context.runtime,
          decision.binding,
          decision.artifacts,
          ttlDays,
          cutoffAt,
          now.toISOString(),
          assertOwned,
        );
        const complete = completePreparedReceipt(
          context.runtime,
          receipt,
          now,
          assertOwned,
          hooks,
        );
        pruned.push({
          invocationId: record.invocationId,
          receiptId: complete.receiptId,
          receiptPath: providerRetentionReceiptPath(
            context.runtime,
            record.invocationId,
          ),
          artifactCount: decision.artifacts.length,
          bytes: decision.artifacts.reduce(
            (sum, artifact) => sum + artifact.bytes,
            0,
          ),
        });

        function recordDenied(reason: ProviderRetentionDenyReason): void {
          deniedCount += 1;
          if (denied.length < limit) {
            denied.push({ invocationId: record.invocationId, reason });
          }
        }
      }
      commitProviderRetentionCatalogCursor(context.runtime, batch);

      return deepFreeze({
        schemaVersion: 1,
        kind: 'provider-runtime-prune-pass',
        policy: {
          schemaVersion: 1,
          ttlDays,
          maxTtlDays: PROVIDER_RETENTION_MAX_TTL_DAYS,
          cutoffAt,
          limit,
        },
        examined,
        recovered,
        pruned,
        deniedCount,
        denied,
        deniedTruncated: deniedCount > denied.length,
      });
    },
  );
}

function decideCandidate(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  binding: InvocationBinding | undefined,
  cutoffAt: string,
  humanPinnedEvidenceIds: ReadonlySet<string>,
): CandidateDecision {
  if (binding === undefined) {
    return deny(record.invocationId, 'schema-currentness-unknown');
  }
  const { state, attempt, context } = binding;
  if (
    attempt.epoch !== state.job.epoch ||
    state.job.workflowId !== state.workflow.workflowId ||
    state.job.epoch > state.workflow.currentEpoch ||
    attempt.workflowId !== state.workflow.workflowId ||
    context.epoch > context.currentEpoch ||
    attempt.legacyInvocation?.invocationId !== record.invocationId ||
    attempt.legacyInvocation.legacyRevision !== record.revision
  ) {
    return deny(record.invocationId, 'schema-currentness-unknown');
  }
  const policyDenial = classifyProviderRetentionEligibility({
    invocationState: record.state,
    historyComplete: state.legacyProjection.completeHistory,
    attemptEpoch: context.epoch,
    currentEpoch: context.currentEpoch,
    retention: attempt.retention,
    humanPinned: humanPinnedEvidenceIds.has(
      providerRuntimeEvidenceId(attempt.attemptId),
    ),
    acceptedAttempt: state.job.acceptedAttemptId === attempt.attemptId,
    latestUnacceptedAttempt:
      state.job.acceptedAttemptId === null &&
      attempt.attemptNumber ===
        Math.max(...state.attempts.map(({ attemptNumber }) => attemptNumber)),
    terminalAt: record.updatedAt,
    cutoffAt,
  });
  if (policyDenial !== null) {
    return deny(record.invocationId, policyDenial);
  }
  if (
    fs.lstatSync(
      path.join(paths.invocations, record.invocationId, 'repair-evidence.json'),
      { throwIfNoEntry: false },
    )
  ) {
    // Current provider repair lineage still reads this exact predecessor
    // evidence. Until that reader has a receipt-backed logical projection,
    // physical deletion would make retry lineage unverifiable.
    return deny(record.invocationId, 'consumed-repair-evidence-unproven');
  }

  // Re-run the strict closure scanner immediately before capturing bytes.
  // This rejects unknown invocation files and any unsafe link without deleting
  // even a single pathname.
  try {
    readProviderInvocationLifecycleProjection(paths, record.invocationId);
  } catch {
    return deny(record.invocationId, 'unsafe-artifact');
  }
  let artifacts: PhysicalArtifact[];
  try {
    artifacts = collectPhysicalArtifacts(paths, binding);
  } catch {
    return deny(record.invocationId, 'unsafe-artifact');
  }
  if (artifacts.length === 0) {
    return deny(record.invocationId, 'nothing-prunable');
  }
  return { kind: 'prune', binding, artifacts };
}

function collectPhysicalArtifacts(
  paths: InvestigationRuntimePaths,
  binding: InvocationBinding,
): PhysicalArtifact[] {
  const invocationId = binding.record.invocationId;
  const invocationDirectory = path.join(paths.invocations, invocationId);
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    invocationId,
  );
  const artifacts: PhysicalArtifact[] = [];
  const runtimeDirectory = path.join(invocationDirectory, 'runtime');
  const runtimeStats = fs.lstatSync(runtimeDirectory, {
    throwIfNoEntry: false,
  });
  if (runtimeStats) {
    assertPrivateInvestigationDirectory(paths, runtimeDirectory, runtimeUnsafe);
    const names = fs.readdirSync(runtimeDirectory).sort();
    if (
      canonicalJson(names) !==
      canonicalJson(RUNTIME_ARTIFACTS.map((name) => path.basename(name)).sort())
    ) {
      throw runtimeUnsafe();
    }
    for (const name of RUNTIME_ARTIFACTS) {
      artifacts.push(
        physicalArtifact(
          name,
          name,
          path.join(invocationDirectory, name),
          path.join(stagingDirectory, stagingName(name)),
        ),
      );
    }
  }

  const candidatePath = providerCompletionCandidatePath(paths, invocationId);
  const candidateExists = privatePathExists(
    paths,
    candidatePath,
    runtimeUnsafe,
  );
  if (candidateExists && runtimeStats) {
    if (
      binding.record.state !== 'succeeded' ||
      binding.record.result === null ||
      !binding.state.results.some(
        (result) =>
          result.attemptId === binding.attempt.attemptId &&
          normalizeDigest(binding.record.result!.outputDigest) ===
            result.outputDigest,
      )
    ) {
      throw runtimeUnsafe();
    }
    artifacts.push(
      physicalArtifact(
        'completion-candidate',
        'completion-candidate',
        candidatePath,
        path.join(stagingDirectory, stagingName('completion-candidate')),
      ),
    );
  }
  const manifest = readProviderInvocationManifest(paths, invocationId);
  if (
    manifest.kind === 'plan-review-manifest' &&
    manifest.planningTarget !== undefined
  ) {
    const reviewRoot = path.join(invocationDirectory, 'review-root');
    assertPrivateInvestigationDirectory(paths, reviewRoot, runtimeUnsafe);
    const names = fs.readdirSync(reviewRoot).sort();
    const expected = manifest.planningTarget.artifacts.map(
      ({ snapshotFile }) => snapshotFile,
    );
    if (canonicalJson(names) !== canonicalJson(expected)) {
      throw runtimeUnsafe();
    }
    for (const snapshot of manifest.planningTarget.artifacts) {
      artifacts.push(
        physicalArtifact(
          'review-root',
          `review-root/${snapshot.snapshotFile}`,
          path.join(reviewRoot, snapshot.snapshotFile),
          path.join(stagingDirectory, `review-root-${snapshot.snapshotFile}`),
          { digest: snapshot.sha256, bytes: snapshot.byteLength },
        ),
      );
    }
  }
  return artifacts.sort((left, right) =>
    left.physicalName.localeCompare(right.physicalName),
  );
}

function prepareReceipt(
  paths: InvestigationRuntimePaths,
  binding: InvocationBinding,
  physicalArtifacts: PhysicalArtifact[],
  ttlDays: number,
  cutoffAt: string,
  preparedAt: string,
  assertOwned: () => void,
): ProviderRetentionReceipt {
  if (
    binding.record.state !== 'succeeded' &&
    binding.record.state !== 'failed'
  ) {
    throw runtimeUnsafe();
  }
  const artifacts: ProviderRetentionArtifact[] = [
    ...physicalArtifacts
      .filter(({ receiptName }) => receiptName !== 'review-root')
      .map(({ receiptName: name, digest, bytes }) => ({ name, digest, bytes })),
    ...(physicalArtifacts.some(
      ({ receiptName }) => receiptName === 'review-root',
    )
      ? [
          providerRetentionReviewRootArtifact(
            physicalArtifacts
              .filter(({ receiptName }) => receiptName === 'review-root')
              .map(({ physicalName: name, digest, bytes }) => ({
                name,
                digest,
                bytes,
              })),
          ),
        ]
      : []),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const identity = {
    invocationId: binding.record.invocationId,
    requestDigest: binding.record.requestDigest,
    manifestDigest: binding.record.manifestDigest,
    legacyRevision: binding.record.revision,
    terminalAt: binding.record.updatedAt,
    artifacts,
    workflowId: binding.context.workflowId,
    jobId: binding.state.job.jobId,
    attemptId: binding.attempt.attemptId,
    contextDigest: binding.context.contextDigest,
    epoch: binding.context.epoch,
    currentEpoch: binding.context.currentEpoch,
    executionRevision: binding.state.revision,
    executionStateDigest: sha256(canonicalJson(binding.state)),
    attemptRetention: binding.attempt.retention,
    acceptedAttemptId: binding.state.job.acceptedAttemptId,
  };
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    binding.record.invocationId,
  );
  ensurePrivateDirectory(stagingDirectory);
  if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
  const receipt = createProviderRetentionReceipt({
    schemaVersion: 1,
    kind: 'provider-runtime-prune-receipt',
    state: 'prepared',
    receiptId: providerRetentionReceiptId(identity),
    invocationId: binding.record.invocationId,
    workflowId: binding.context.workflowId,
    jobId: binding.state.job.jobId,
    attemptId: binding.attempt.attemptId,
    contextDigest: binding.context.contextDigest,
    executionRevision: binding.state.revision,
    executionStateDigest: sha256(canonicalJson(binding.state)),
    epoch: binding.context.epoch,
    currentEpoch: binding.context.currentEpoch,
    attemptRetention: binding.attempt.retention,
    acceptedAttemptId: binding.state.job.acceptedAttemptId,
    requestDigest: binding.record.requestDigest,
    manifestDigest: binding.record.manifestDigest,
    legacyRevision: binding.record.revision,
    terminalState: binding.record.state,
    terminalAt: binding.record.updatedAt,
    ttlDays,
    cutoffAt,
    artifacts,
    preparedAt,
    completedAt: null,
  });
  assertOwned();
  createPrivateFileAtomic(
    providerRetentionReceiptPath(paths, binding.record.invocationId),
    canonicalProviderRetentionReceipt(receipt),
  );
  return receipt;
}

function completePreparedReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
  completedAt: Date,
  assertOwned: () => void,
  hooks: ProviderRetentionHooks,
): ProviderRetentionReceipt {
  if (receipt.state !== 'prepared') throw receiptUnsafe();
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  ensurePrivateDirectory(stagingDirectory);
  let stagedCount = 0;
  for (const artifact of physicalArtifactsForReceipt(paths, receipt)) {
    assertOwned();
    const source = observeArtifact(artifact.sourcePath, artifact);
    const staged = observeArtifact(artifact.stagingPath, artifact);
    if (source && staged) throw runtimeUnsafe();
    if (!source && !staged) {
      throw workflowError(
        'PROVIDER_RETENTION_PRUNING_PARTIAL',
        'Prepared provider pruning lost an artifact before receipt completion.',
        ExitCode.staleState,
      );
    }
    if (source) {
      fs.renameSync(artifact.sourcePath, artifact.stagingPath);
      fsyncDirectory(path.dirname(artifact.sourcePath));
      fsyncDirectory(stagingDirectory);
      if (!observeArtifact(artifact.stagingPath, artifact)) {
        throw runtimeUnsafe();
      }
    }
    stagedCount += 1;
    hooks.afterArtifactStaged?.(stagedCount, receipt.invocationId);
  }
  const { receiptDigest: _receiptDigest, ...prepared } = receipt;
  const complete = createProviderRetentionReceipt({
    ...prepared,
    state: 'complete',
    completedAt: completedAt.toISOString(),
  });
  assertOwned();
  replacePrivateFileAtomic(
    providerRetentionReceiptPath(paths, receipt.invocationId),
    canonicalProviderRetentionReceipt(complete),
  );
  hooks.afterReceiptCompleted?.(receipt.invocationId);
  cleanupCompletedReceipt(paths, complete, assertOwned);
  return complete;
}

function cleanupCompletedReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
  assertOwned: () => void,
): void {
  if (receipt.state !== 'complete') throw receiptUnsafe();
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  const stagingStats = fs.lstatSync(stagingDirectory, {
    throwIfNoEntry: false,
  });
  if (stagingStats) assertPrivateDirectory(stagingStats);
  for (const artifact of physicalArtifactsForReceipt(paths, receipt)) {
    if (fs.lstatSync(artifact.sourcePath, { throwIfNoEntry: false })) {
      throw runtimeUnsafe();
    }
    if (observeArtifact(artifact.stagingPath, artifact)) {
      assertOwned();
      fs.unlinkSync(artifact.stagingPath);
      fsyncDirectory(stagingDirectory);
    }
  }
  if (fs.lstatSync(stagingDirectory, { throwIfNoEntry: false })) {
    if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
    assertOwned();
    fs.rmdirSync(stagingDirectory);
    fsyncDirectory(path.dirname(stagingDirectory));
  }
  const runtimeDirectory = path.join(
    paths.invocations,
    receipt.invocationId,
    'runtime',
  );
  const runtimeStats = fs.lstatSync(runtimeDirectory, {
    throwIfNoEntry: false,
  });
  if (runtimeStats) {
    assertPrivateDirectory(runtimeStats);
    if (fs.readdirSync(runtimeDirectory).length !== 0) throw runtimeUnsafe();
    // Keep the empty, exact runtime directory as a non-authoritative physical
    // marker. If the external complete receipt disappears, the ordinary
    // scanner observes an incomplete runtime closure and fails closed even for
    // legacy/failure records that do not carry runtimeObservation.
  }
  const reviewRoot = path.join(
    paths.invocations,
    receipt.invocationId,
    'review-root',
  );
  const reviewStats = fs.lstatSync(reviewRoot, { throwIfNoEntry: false });
  if (reviewStats) {
    assertPrivateDirectory(reviewStats);
    if (fs.readdirSync(reviewRoot).length !== 0) throw runtimeUnsafe();
  }
}

function physicalArtifactsForReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
): PhysicalArtifact[] {
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  const artifacts = receipt.artifacts.flatMap(
    (artifact): PhysicalArtifact[] => {
      if (artifact.name !== 'review-root') {
        return [
          {
            receiptName: artifact.name,
            physicalName: artifact.name,
            sourcePath: sourcePathForArtifact(
              paths,
              receipt.invocationId,
              artifact.name,
            ),
            stagingPath: path.join(
              stagingDirectory,
              stagingName(artifact.name),
            ),
            digest: artifact.digest,
            bytes: artifact.bytes,
          },
        ];
      }
      const manifest = readProviderInvocationManifest(
        paths,
        receipt.invocationId,
      );
      if (
        manifest.kind !== 'plan-review-manifest' ||
        manifest.planningTarget === undefined
      ) {
        throw receiptUnsafe();
      }
      const leaves = manifest.planningTarget.artifacts.map((snapshot) => ({
        name: `review-root/${snapshot.snapshotFile}`,
        digest: snapshot.sha256,
        bytes: snapshot.byteLength,
      }));
      if (
        canonicalJson(providerRetentionReviewRootArtifact(leaves)) !==
        canonicalJson(artifact)
      ) {
        throw receiptUnsafe();
      }
      return leaves.map((leaf) => ({
        receiptName: 'review-root',
        physicalName: leaf.name,
        sourcePath: path.join(
          paths.invocations,
          receipt.invocationId,
          leaf.name,
        ),
        stagingPath: path.join(
          stagingDirectory,
          `review-root-${path.basename(leaf.name)}`,
        ),
        digest: leaf.digest,
        bytes: leaf.bytes,
      }));
    },
  );
  return artifacts.sort((left, right) =>
    left.physicalName.localeCompare(right.physicalName),
  );
}

function assertReceiptBinding(
  receipt: ProviderRetentionReceipt,
  binding: InvocationBinding | undefined,
  record: ProviderInvocationRecord,
): asserts binding is InvocationBinding {
  if (
    binding === undefined ||
    receipt.invocationId !== record.invocationId ||
    receipt.workflowId !== binding.context.workflowId ||
    receipt.jobId !== binding.state.job.jobId ||
    receipt.attemptId !== binding.attempt.attemptId ||
    receipt.executionRevision !== binding.state.revision ||
    receipt.executionStateDigest !== sha256(canonicalJson(binding.state)) ||
    receipt.contextDigest !== binding.context.contextDigest ||
    receipt.epoch !== binding.context.epoch ||
    receipt.currentEpoch > binding.context.currentEpoch ||
    receipt.currentEpoch < receipt.epoch ||
    receipt.attemptRetention !== binding.attempt.retention ||
    receipt.acceptedAttemptId !== binding.state.job.acceptedAttemptId ||
    receipt.requestDigest !== record.requestDigest ||
    receipt.manifestDigest !== record.manifestDigest ||
    receipt.legacyRevision !== record.revision ||
    receipt.terminalState !== record.state ||
    receipt.terminalAt !== record.updatedAt ||
    Date.parse(receipt.terminalAt) > Date.parse(receipt.cutoffAt)
  ) {
    throw receiptUnsafe();
  }
}

function readInvocationBinding(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
): InvocationBinding | undefined {
  try {
    const request = readProviderInvocationRequest(paths, record.invocationId);
    const manifest = readProviderInvocationManifest(paths, record.invocationId);
    const context = inspectProviderPromptContextRetentionBinding(
      paths.root,
      request,
      manifest,
      record.investigationId,
      record.createdAt,
    );
    if (context === null) return undefined;
    const projected = projectProviderInvocationExecution({ record, request });
    const state = readExecutionJobState(paths, projected.job.jobId);
    if (state === null) return undefined;
    const sources = state.legacyProjection.invocations.filter(
      ({ invocationId }) => invocationId === record.invocationId,
    );
    if (sources.length !== 1) return undefined;
    const source = sources[0]!;
    const attempts = state.attempts.filter(
      ({ attemptId }) => attemptId === source.attemptId,
    );
    if (
      attempts.length !== 1 ||
      source.legacyRevision !== record.revision ||
      attempts[0]!.attemptId !== projected.attempt.attemptId ||
      attempts[0]!.legacyInvocation?.invocationId !== record.invocationId ||
      attempts[0]!.legacyInvocation?.legacyRevision !== record.revision
    ) {
      return undefined;
    }
    return { state, attempt: attempts[0]!, record, context };
  } catch {
    return undefined;
  }
}

function recoverInterruptedPruning(
  paths: InvestigationRuntimePaths,
  now: Date,
  assertOwned: () => void,
  hooks: ProviderRetentionHooks,
): string | null {
  const stagingRoot = providerRetentionRoot(paths).staging;
  const entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  if (entries.length === 0) return null;
  if (
    entries.length !== 1 ||
    !entries[0]!.isDirectory() ||
    entries[0]!.isSymbolicLink() ||
    !/^[0-9a-f]{64}$/.test(entries[0]!.name)
  ) {
    throw runtimeUnsafe();
  }
  const stagingDirectory = path.join(stagingRoot, entries[0]!.name);
  assertPrivateDirectory(fs.lstatSync(stagingDirectory));
  if (fs.realpathSync(stagingDirectory) !== path.resolve(stagingDirectory)) {
    throw runtimeUnsafe();
  }
  const invocationId = readProviderRetentionCatalogEntry(
    paths,
    entries[0]!.name,
  ).invocationId;
  const receipt = readProviderRetentionReceipt(paths, invocationId);
  if (receipt === null) {
    if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
    assertOwned();
    fs.rmdirSync(stagingDirectory);
    fsyncDirectory(stagingRoot);
    return invocationId;
  }
  const record = readProviderInvocation(paths, invocationId);
  const binding = readInvocationBinding(paths, record);
  assertReceiptBinding(receipt, binding, record);
  if (receipt.state === 'prepared') {
    completePreparedReceipt(paths, receipt, now, assertOwned, hooks);
  } else {
    cleanupCompletedReceipt(paths, receipt, assertOwned);
  }
  return invocationId;
}

function physicalArtifact(
  receiptName: ProviderRetentionArtifactName,
  physicalName: string,
  sourcePath: string,
  stagingPath: string,
  expected?: { digest: string; bytes: number },
): PhysicalArtifact {
  const content = readPrivateFile(sourcePath);
  const digest = sha256(content);
  if (
    expected !== undefined &&
    (expected.digest !== digest || expected.bytes !== content.byteLength)
  ) {
    throw runtimeUnsafe();
  }
  return {
    receiptName,
    physicalName,
    sourcePath,
    stagingPath,
    digest,
    bytes: content.byteLength,
  };
}

function observeArtifact(
  filePath: string,
  artifact: Pick<ProviderRetentionArtifact, 'bytes' | 'digest'>,
): boolean {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return false;
  const content = readPrivateFile(filePath);
  if (
    content.byteLength !== artifact.bytes ||
    sha256(content) !== artifact.digest
  ) {
    throw runtimeUnsafe();
  }
  return true;
}

function readPrivateFile(filePath: string): Buffer {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) throw runtimeUnsafe();
  assertPrivateRegularFile(before);
  if (before.size > MAX_RAW_ARTIFACT_BYTES) throw runtimeUnsafe();
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
    const opened = fs.fstatSync(descriptor);
    assertPrivateRegularFile(opened);
    if (!sameIdentity(before, opened)) throw runtimeUnsafe();
    const content = fs.readFileSync(descriptor);
    const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !after ||
      !sameIdentity(opened, after) ||
      after.size !== content.byteLength
    ) {
      throw runtimeUnsafe();
    }
    return content;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw runtimeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sourcePathForArtifact(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  name: ProviderRetentionArtifactName,
): string {
  if (name === 'review-root') throw receiptUnsafe();
  if (name === 'completion-candidate') {
    return providerCompletionCandidatePath(paths, invocationId);
  }
  return path.join(paths.invocations, invocationId, name);
}

function providerCompletionCandidatePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    paths.root,
    'execution',
    'completion-candidates',
    `${sha256(Buffer.from(invocationId))}.json`,
  );
}

function stagingName(name: ProviderRetentionArtifactName): string {
  switch (name) {
    case 'review-root':
      throw receiptUnsafe();
    case 'completion-candidate':
      return 'completion-candidate.json';
    case 'runtime/prompt.json':
      return 'runtime-prompt.json';
    case 'runtime/schema.json':
      return 'runtime-schema.json';
    case 'runtime/semantic-output.json':
      return 'runtime-semantic-output.json';
  }
}

function ensureRetentionDirectories(paths: InvestigationRuntimePaths): void {
  const retention = providerRetentionRoot(paths);
  if (assertRetentionDirectories(paths, false)) return;
  ensurePrivateDirectory(retention.root);
  ensurePrivateDirectory(retention.receipts);
  ensurePrivateDirectory(retention.staging);
  assertRetentionDirectories(paths, true);
}

function ensurePrivateDirectory(directory: string): void {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateDirectory(existing);
    if (fs.realpathSync(directory) !== path.resolve(directory)) {
      throw runtimeUnsafe();
    }
    return;
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  fsyncDirectory(path.dirname(directory));
  assertPrivateDirectory(fs.lstatSync(directory));
  if (fs.realpathSync(directory) !== path.resolve(directory)) {
    throw runtimeUnsafe();
  }
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  if (Buffer.byteLength(content) >= PROVIDER_RETENTION_MAX_RECEIPT_BYTES) {
    throw receiptUnsafe();
  }
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })) throw receiptUnsafe();
  writePrivateFileAtomic(filePath, content);
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  if (Buffer.byteLength(content) >= PROVIDER_RETENTION_MAX_RECEIPT_BYTES) {
    throw receiptUnsafe();
  }
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!existing) throw receiptUnsafe();
  assertPrivateRegularFile(existing);
  writePrivateFileAtomic(filePath, content);
}

function writePrivateFileAtomic(filePath: string, content: string): void {
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
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (current) assertPrivateRegularFile(current);
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temp either was never created or has already been atomically moved.
    }
    throw error;
  }
}

function assertPrivateDirectory(stats: fs.Stats): void {
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)
  ) {
    throw runtimeUnsafe();
  }
}

function assertPrivateRegularFile(stats: fs.Stats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600)
  ) {
    throw runtimeUnsafe();
  }
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > PROVIDER_RETENTION_MAX_LIMIT
  ) {
    throw workflowError(
      'PROVIDER_RETENTION_LIMIT_INVALID',
      `Provider retention limit must be between 1 and ${PROVIDER_RETENTION_MAX_LIMIT}.`,
      ExitCode.usage,
    );
  }
  return value;
}

function assertTtlDays(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > PROVIDER_RETENTION_MAX_TTL_DAYS
  ) {
    throw workflowError(
      'PROVIDER_RETENTION_TTL_INVALID',
      `Provider retention TTL must be between 1 and ${PROVIDER_RETENTION_MAX_TTL_DAYS} days.`,
      ExitCode.usage,
    );
  }
  return value;
}

function parseTimestamp(value: string): Date {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw workflowError(
      'PROVIDER_RETENTION_NOW_INVALID',
      'Provider retention time must be an exact ISO-8601 timestamp.',
      ExitCode.usage,
    );
  }
  return new Date(timestamp);
}

function deny(
  invocationId: string,
  reason: ProviderRetentionDenyReason,
): CandidateDecision {
  return { kind: 'deny', invocationId, reason };
}

function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function runtimeUnsafe(): WorkflowError {
  return workflowError(
    'PROVIDER_RETENTION_RUNTIME_UNSAFE',
    'Provider runtime retention encountered an unsafe or unbound artifact.',
    ExitCode.unsafeEnvironment,
  );
}

function receiptUnsafe(): WorkflowError {
  return workflowError(
    'PROVIDER_RETENTION_RECEIPT_UNSAFE',
    'Provider runtime pruning receipt is missing, malformed, or tampered.',
    ExitCode.unsafeEnvironment,
  );
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
