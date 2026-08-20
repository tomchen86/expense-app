import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseAiAdapterPolicyDocument,
  parseLegacyAiAdapterPolicyDocument,
  type AiAdapterRetryAccounting,
  type LoadedAiAdapterPolicy,
  type LoadedLegacyAiAdapterPolicy,
} from '../provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  resolvePlanReviewInvocationOwner,
  resolveTaskDiffReviewInvocationOwner,
  resolveTaskStrategyImplementationInvocationOwner,
} from './evidence-object-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertReadOnlyProbe,
  projectProviderInvocationExecution,
  type ExecutionFailureKind,
  type ReadOnlyProbeRequest,
  type RetryMode,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  acceptLegacyProviderAttemptResult,
  materializeLegacyProviderExecutionJob,
  readExecutionJobState,
  type LegacyProviderExecutionEntry,
} from './execution-store.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  listProviderInvocationLifecycleProjections,
  privatePathExists,
  readHumanResolutionHead,
  readHumanResolutionNode,
  readPrivateCanonicalJson,
  scanProviderInvocationLifecycles,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import {
  assertDurableProviderExecutionBudgetAuthority as assertStoredProviderExecutionBudgetAuthority,
  createProviderExecutionBudgetAuthority,
  validateProviderExecutionBudgetAuthority,
  type ProviderExecutionBudgetAuthority,
  type ProviderExecutionGrantAuthorityInput,
} from '../provider-execution/provider-execution-policy-authority.ts';
import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
  type ProviderProcessResult,
  type ProviderRunnerReport,
  type ProviderRuntimeObservation,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  AgentRuntimeCompletionReceipt,
  AgentRuntimeProcessProgressProjection,
  ProviderInvocationAcceptanceBinding,
} from '../../modules/provider-orchestration/agent-runtime-port.ts';
import {
  assertProviderWrapperProtocolReceipt,
  type ProviderWrapperProtocolReceipt,
} from '../../modules/provider-orchestration/agent-runtime-protocol.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../provider-execution/provider-runner.ts';
import {
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  type InvestigationTermKind,
} from '../../modules/investigation/domain/investigation-terms.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  assertSessionId,
  assertTaskId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';
import type {
  CapabilityPurpose,
  ProviderId,
} from '../../modules/provider-orchestration/provider-registry.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';
import { registerProviderRetentionInvocation } from './provider-retention-catalog.ts';
import {
  providerRetentionArtifact,
  providerRetentionReviewRootArtifact,
  readCompleteProviderRetentionReceipt,
} from './provider-retention-receipt.ts';
import {
  assertProviderPromptContextCurrent,
  assertProviderRepairAuthorityCurrent,
  createProviderRepairLineage,
  ensureProviderPromptContext,
  persistProviderRepairEvidence,
  prepareProviderPromptContextForInvocation,
  readProviderRepairAuthorityBinding,
  registerProviderRuntimeEvidence,
  withCurrentProviderPromptContext,
  type ProviderRepairFailureInput,
} from '../provider-execution/provider-execution-governance.ts';
import {
  assertProviderInvocationSupersessionEndpointCurrent,
  finalizeProviderInvocationSupersession,
  prepareProviderInvocationSupersession,
  readProviderInvocationEvidenceRecord,
  recoverProviderInvocationSupersessionTransaction,
  resumePreparedProviderInvocationSupersession,
  type ProviderInvocationEvidence,
  type ProviderInvocationSupersessionCrashPhase,
} from '../provider-execution/provider-invocation-supersession.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  assertPlanReviewTargetSnapshot,
  assertPlanReviewSubject,
  planReviewSnapshotLineCount,
  type PlanReviewTargetSnapshot,
  type PlanReviewSubject,
} from '../../modules/assurance/plan-review.ts';
import {
  assertTaskDiffReviewChallengeResponseCurrent,
  parseTaskDiffReviewChallengeResponseRecord,
  parseTaskDiffReviewRecord,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  type TaskDiffReviewChallengeResponseRecord,
  type TaskDiffReviewRecord,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewScope,
  parseTaskDiffReviewSubject,
  type TaskDiffReviewScope,
  type TaskDiffReviewSubject,
} from '../../modules/assurance/task-diff-review.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  assertTaskStrategyImplementationManifest,
  type TaskStrategyImplementationManifest,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../session-workspace/session-store.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BLIND_MANIFEST_BYTES = 262_144;
const MAX_INTENT_SUMMARY_BYTES = 4_096;
const MAX_INTENT_FACT_BYTES = 512;
const MAX_INTENT_FACTS_PER_KIND = 256;
const MAX_ARCHITECTURE_QUESTION_BYTES = 16_384;
export const PROVIDER_COMPLETION_GRACE_MS = 30_000;
// Keep this canonical schema self-contained: provider CLIs infer their supported
// dialect, while an external `$schema` URI can be rejected before model launch.
// The request digest, runtime schema, provider argv, and native validator must
// continue to bind these exact bytes.
export const BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'terms'],
  properties: {
    reference: { type: 'string', minLength: 1 },
    terms: {
      type: 'array',
      minItems: 1,
      maxItems: INVESTIGATION_LIMITS.maxSurveyTerms,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: {
            enum: ['literal-content', 'literal-path', 'symbol', 'config-key'],
          },
          value: { type: 'string', minLength: 1 },
        },
      },
    },
  },
});
export const BLIND_SURVEY_OUTPUT_SCHEMA = Object.freeze({
  id: 'expense-app.workflow.blind-survey-output',
  version: 1,
  digest: sha256(canonicalJson(BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA)),
});

export type NormalizedChangeIntent = {
  schemaVersion: 1;
  summary: string;
  explicitPaths: string[];
  explicitSymbols: string[];
  explicitConfigKeys: string[];
  renamePairs: Array<{
    from: string;
    to: string;
  }>;
};

export type BlindSurveyManifest = {
  schemaVersion: 1;
  kind: 'blind-survey-manifest';
  changeId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  normalizedIntent: NormalizedChangeIntent;
  architectureQuestion: string;
  capabilityProfile: 'repository-read-only';
};

export type PlanReviewManifest = {
  schemaVersion: 1;
  kind: 'plan-review-manifest';
  changeId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  subject: PlanReviewSubject;
  planningTarget?: PlanReviewTargetSnapshot;
  capabilityProfile: 'repository-read-only';
};

export type TaskDiffReviewManifest = {
  schemaVersion: 1;
  kind: 'task-diff-review-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  reviewScope: TaskDiffReviewScope;
  capabilityProfile: 'repository-read-only';
};

export type TaskDiffReviewContinuationManifest = {
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  capabilityProfile: 'repository-read-only';
};

export type ProviderInvocationManifest =
  | BlindSurveyManifest
  | PlanReviewManifest
  | TaskDiffReviewManifest
  | TaskDiffReviewContinuationManifest
  | TaskStrategyImplementationManifest;

export type InvestigationStartReservation = {
  schemaVersion: 1;
  kind: 'investigation-start-reservation';
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  investigationId: string;
  invocationId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string | null;
  baseline: {
    head: string;
    tree: string;
  };
  manifestDigest: string;
  requestDigest: string;
  manifest: BlindSurveyManifest;
  request: ProviderInvocationRequest;
  createdAt: string;
};

export type InvestigationStartReservationSnapshot = Readonly<{
  rawDocument: string | null;
  digest: string | null;
  reservation: InvestigationStartReservation | null;
}>;

export type ProviderRetryDecisionBinding = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-decision-binding';
  executionJobId: string;
  executionRevision: number;
  failedAttemptId: string;
  evidenceDigest: string;
  evaluatedAt: string;
}>;

export type ProviderRetryReservationV1 = {
  schemaVersion: 1;
  kind: 'provider-retry-reservation';
  investigationId: string;
  changeId: string;
  attempt: number;
  previousInvocationId: string;
  invocationId: string;
  manifestDigest: string;
  requestDigest: string;
  request: ProviderInvocationRequest;
  createdAt: string;
};

export type ProviderRetryReservationV2 = Omit<
  ProviderRetryReservationV1,
  'schemaVersion'
> & {
  schemaVersion: 2;
  mandateBinding?: TaskMandateBinding;
  retryDecision: ProviderRetryDecisionBinding;
  executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent;
};

export type ProviderRetryReplacementBinding = Readonly<{
  attemptId: string;
  retryMode: Exclude<RetryMode, 'none' | 'new-context'>;
  strategyChanges: readonly string[];
  environmentDigest: string;
  executionGrantId: string | null;
  authorizationNodeId: string;
  reservationNodeId: string;
}>;

export type ProviderRetryReservationV3 = Omit<
  ProviderRetryReservationV2,
  'schemaVersion'
> & {
  schemaVersion: 3;
  replacement: ProviderRetryReplacementBinding;
};

export type ProviderRetryReservation =
  | ProviderRetryReservationV1
  | ProviderRetryReservationV2
  | ProviderRetryReservationV3;

export type ProviderInvocationFailure = {
  kind: 'retryable' | 'repository-reconciliation-required';
  code: string;
  message: string;
  executionKind?: ExecutionFailureKind;
  retryAfterMs?: number;
  probe?: Readonly<ReadOnlyProbeRequest>;
};

export type ProviderInvocationLease = {
  generation: number;
  workerId: string;
  tokenDigest: string;
  acquiredAt: string;
  expiresAt: string;
};

export type ProviderInvocationRecord = {
  schemaVersion: 1;
  invocationId: string;
  investigationId: string;
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  attempt: number;
  revision: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  providerId: ProviderId;
  purpose: CapabilityPurpose;
  requestDigest: string;
  manifestDigest: string;
  leaseGeneration: number;
  lease: ProviderInvocationLease | null;
  result: ProviderProcessResult | null;
  failure: ProviderInvocationFailure | null;
  /** Absent on historical and synchronous single-shot invocation records. */
  runtimeReceipt?: AgentRuntimeCompletionReceipt;
  createdAt: string;
  updatedAt: string;
};

export type ProviderExecutionPolicySnapshotV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-execution-policy-snapshot';
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  policyDocument: string;
}>;

export type ProviderAttemptBudgetReservation = Readonly<{
  runtimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
}>;

export type ProviderRetryAccountingSnapshot = Readonly<{
  retryPolicy: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
}>;

export type ProviderExecutionPolicySnapshotV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-execution-policy-snapshot';
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  policyDocument: string;
  retryAccounting: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
}>;

export type ProviderExecutionPolicySnapshotV3 = Readonly<{
  schemaVersion: 3;
  kind: 'provider-execution-policy-snapshot';
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  policyDocument: string;
  retryAccounting: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
  authority: ProviderExecutionBudgetAuthority;
}>;

export type ProviderExecutionPolicySnapshotCurrent =
  ProviderExecutionPolicySnapshotV2 | ProviderExecutionPolicySnapshotV3;

export type ProviderExecutionPolicySnapshot =
  ProviderExecutionPolicySnapshotV1 | ProviderExecutionPolicySnapshotCurrent;

export type { ProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';

type ProviderCompletionCandidate = Readonly<{
  schemaVersion: 1;
  kind: 'provider-completion-candidate';
  invocationId: string;
  requestDigest: string;
  expectedLegacyRevision: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  result: ProviderProcessResult;
  runtimeReceipt?: AgentRuntimeCompletionReceipt;
  completedAt: string;
  candidateDigest: string;
}>;

export type CreateProviderInvocationInput = {
  investigationId: string;
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  attempt: number;
  manifest: ProviderInvocationManifest;
  request: ProviderInvocationRequest;
  planReviewSnapshotFiles?: Array<{
    snapshotFile: string;
    content: Buffer;
  }>;
  createdAt?: string;
  simulateSupersessionCrashAfter?: ProviderInvocationSupersessionCrashPhase;
};

export type PlanReviewSnapshotRuntime = {
  root: string;
  files: Array<{ id: string; path: string }>;
};

export type ProviderLeaseClaim = {
  record: ProviderInvocationRecord;
  leaseToken: string;
};

export type ProviderWorkerLeaseClaim = ProviderLeaseClaim & {
  workerFenceToken: string;
};

export function blindSurveyManifestDigest(
  manifest: BlindSurveyManifest,
): string {
  return sha256(canonicalJson(assertBlindSurveyManifest(manifest)));
}

export function providerInvocationManifestDigest(
  manifest: ProviderInvocationManifest,
): string {
  return sha256(canonicalJson(assertProviderInvocationManifest(manifest)));
}

export function blindSurveyIntentDigest(manifest: BlindSurveyManifest): string {
  return sha256(
    canonicalJson(assertBlindSurveyManifest(manifest).normalizedIntent),
  );
}

export function createInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    investigationId: string;
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string | null;
    baseline: {
      head: string;
      tree: string;
    };
    manifest: BlindSurveyManifest;
    request: ProviderInvocationRequest;
    executionPolicy: LoadedAiAdapterPolicy;
    mandateBinding?: TaskMandateBinding;
    createdAt?: string;
  },
): InvestigationStartReservation {
  const changeId = assertChangeId(input.changeId);
  const investigationId = assertInvestigationId(input.investigationId);
  const manifest = assertBlindSurveyManifest(input.manifest);
  const request = assertProviderRequest(input.request);
  const manifestDigest = blindSurveyManifestDigest(manifest);
  assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!isTimestamp(createdAt)) {
    throw invocationInvalid();
  }
  const reservation = assertInvestigationStartReservation({
    schemaVersion: 1,
    kind: 'investigation-start-reservation',
    changeId,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    investigationId,
    invocationId: request.invocationId,
    repositoryRoot: input.repositoryRoot,
    gitCommonDirectory: input.gitCommonDirectory,
    branch: input.branch,
    baseline: input.baseline,
    manifestDigest,
    requestDigest: request.requestDigest,
    manifest,
    request,
    createdAt,
  });
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.investigation-start.lock`),
    () => {
      storeProviderExecutionPolicySnapshot(
        paths,
        request,
        input.executionPolicy,
      );
      createPrivateCanonicalJson(
        paths,
        investigationStartReservationPath(paths, changeId),
        reservation,
        invocationUnsafe,
        'INVESTIGATION_START_RESERVATION_CONFLICT',
      );
      return readInvestigationStartReservation(
        paths,
        changeId,
      ) as InvestigationStartReservation;
    },
    'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT',
    startReservationLockInvalid,
  );
}

export function readInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): InvestigationStartReservation | null {
  const changeId = assertChangeId(requestedChangeId);
  const reservationPath = investigationStartReservationPath(paths, changeId);
  if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
    return null;
  }
  const reservation = assertInvestigationStartReservation(
    readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe),
  );
  if (reservation.changeId !== changeId) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(reservation));
}

export function readInvestigationStartReservationSnapshot(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): InvestigationStartReservationSnapshot {
  const changeId = assertChangeId(requestedChangeId);
  const reservationPath = investigationStartReservationPath(paths, changeId);
  if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
    return absentInvestigationStartReservationSnapshot();
  }
  const rawDocument = readPrivateCanonicalDocument(
    paths,
    reservationPath,
    invocationUnsafe,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDocument);
  } catch {
    throw invocationInvalid();
  }
  const reservation = assertInvestigationStartReservation(parsed);
  if (
    reservation.changeId !== changeId ||
    rawDocument !== `${canonicalJson(parsed)}\n`
  ) {
    throw invocationInvalid();
  }
  return Object.freeze({
    rawDocument,
    digest: sha256(rawDocument),
    reservation,
  });
}

export function retireInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    expectedDigest: string | null;
  },
): InvestigationStartReservationSnapshot {
  const changeId = assertChangeId(input.changeId);
  if (input.expectedDigest !== null && !DIGEST.test(input.expectedDigest)) {
    throw invocationInvalid();
  }
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.investigation-start.lock`),
    () => {
      const current = readInvestigationStartReservationSnapshot(
        paths,
        changeId,
      );
      if (current.digest === null) {
        return current;
      }
      if (current.digest !== input.expectedDigest) {
        throw startReservationCasMismatch(input.expectedDigest, current.digest);
      }
      fs.unlinkSync(investigationStartReservationPath(paths, changeId));
      fsyncDirectory(paths.refs);
      const retired = readInvestigationStartReservationSnapshot(
        paths,
        changeId,
      );
      if (retired.digest !== null) {
        throw invocationInvalid();
      }
      return retired;
    },
    'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT',
    startReservationLockInvalid,
  );
}

export function createProviderRetryReservation(
  paths: InvestigationRuntimePaths,
  input: {
    investigationId: string;
    changeId: string;
    attempt: number;
    previousInvocationId: string;
    manifest: ProviderInvocationManifest;
    request: ProviderInvocationRequest;
    executionPolicy: LoadedAiAdapterPolicy;
    executionGrantAuthorization?: ProviderExecutionGrantAuthorityInput;
    retryDecision?: ProviderRetryDecisionBinding;
    replacement?: ProviderRetryReplacementBinding;
    mandateBinding?: TaskMandateBinding;
    createdAt?: string;
  },
): ProviderRetryReservation {
  const investigationId = assertInvestigationId(input.investigationId);
  const changeId = assertChangeId(input.changeId);
  const previousInvocationId = assertInvocationId(input.previousInvocationId);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 2) {
    throw invocationInvalid();
  }
  const manifest = assertProviderInvocationManifest(input.manifest);
  const request = assertProviderRequest(input.request);
  if (input.retryDecision === undefined) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_EVIDENCE_REQUIRED',
      'A durable retry decision binding is required before reserving provider work.',
      ExitCode.guard,
    );
  }
  const retryDecision = assertProviderRetryDecisionBinding(input.retryDecision);
  const executionPolicySnapshot = createProviderExecutionPolicySnapshot(
    request,
    input.executionPolicy,
    input.executionGrantAuthorization,
  );
  const manifestDigest = providerInvocationManifestDigest(manifest);
  assertProviderInvocationBinding(changeId, manifest, manifestDigest, request);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const reservation = assertProviderRetryReservation({
    schemaVersion: input.replacement === undefined ? 2 : 3,
    kind: 'provider-retry-reservation',
    investigationId,
    changeId,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    attempt: input.attempt,
    previousInvocationId,
    invocationId: request.invocationId,
    manifestDigest,
    requestDigest: request.requestDigest,
    request,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    retryDecision,
    executionPolicySnapshot,
    ...(input.replacement === undefined
      ? {}
      : { replacement: input.replacement }),
    createdAt,
  });
  createPrivateCanonicalJson(
    paths,
    providerRetryReservationPath(paths, investigationId, input.attempt),
    reservation,
    invocationUnsafe,
    'PROVIDER_RETRY_RESERVATION_CONFLICT',
  );
  ensureProviderExecutionPolicySnapshotFromSnapshot(
    paths,
    request,
    executionPolicySnapshot,
  );
  return readProviderRetryReservation(
    paths,
    investigationId,
    input.attempt,
  ) as ProviderRetryReservation;
}

export function readProviderRetryReservation(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  attempt: number,
): ProviderRetryReservation | null {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  if (!Number.isSafeInteger(attempt) || attempt < 2) {
    throw invocationInvalid();
  }
  const reservationPath = providerRetryReservationPath(
    paths,
    investigationId,
    attempt,
  );
  if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
    return null;
  }
  const reservation = assertProviderRetryReservation(
    readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe),
  );
  if (
    reservation.investigationId !== investigationId ||
    reservation.attempt !== attempt
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(reservation));
}

export function createProviderInvocation(
  paths: InvestigationRuntimePaths,
  input: CreateProviderInvocationInput,
): ProviderInvocationRecord {
  const investigationId = assertInvestigationId(input.investigationId);
  const changeId = assertChangeId(input.changeId);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw invocationInvalid();
  }
  const manifest = assertProviderInvocationManifest(input.manifest);
  const request = assertProviderRequest(input.request);
  const invocationId = assertInvocationId(request.invocationId);
  const manifestDigest = providerInvocationManifestDigest(manifest);
  assertProviderInvocationBinding(changeId, manifest, manifestDigest, request);
  const executionPolicy = readProviderExecutionPolicySnapshot(paths, request);
  if (
    executionPolicy.snapshot.schemaVersion === 3 &&
    canonicalJson(executionPolicy.snapshot.authority.receipt.mandateBinding) !==
      canonicalJson(input.mandateBinding ?? null)
  ) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  const now = input.createdAt ?? new Date().toISOString();
  if (!isTimestamp(now)) {
    throw invocationInvalid();
  }

  const directory = providerInvocationDirectory(paths, invocationId);
  const manifestPath = path.join(directory, 'manifest.json');
  const requestPath = path.join(directory, 'request.json');
  const statePath = path.join(directory, 'state.json');
  const record: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId,
    investigationId,
    changeId,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    attempt: input.attempt,
    revision: 0,
    state: 'prepared',
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    manifestDigest,
    leaseGeneration: 0,
    lease: null,
    result: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
  };

  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${invocationId}.lock`),
    () => {
      const invocationAlreadyExists = privatePathExists(
        paths,
        statePath,
        invocationUnsafe,
      );
      let supersession = resumePreparedProviderInvocationSupersession(
        paths,
        record,
        request,
      );
      let effectiveNow = now;
      let effectiveRecord = record;
      if (supersession !== null) {
        effectiveNow = supersession.edge.createdAt;
        if (input.createdAt !== undefined && input.createdAt !== effectiveNow) {
          throw invocationInvalid();
        }
        effectiveRecord = {
          ...record,
          createdAt: effectiveNow,
          updatedAt: effectiveNow,
        };
      }
      const executionHistory =
        supersession === null
          ? providerExecutionHistory(
              paths,
              effectiveRecord.investigationId,
              effectiveRecord.purpose,
              effectiveRecord.attempt,
              request,
            )
          : null;
      createPlanReviewSnapshotFiles(
        paths,
        directory,
        manifest,
        input.planReviewSnapshotFiles,
      );
      // The provider-neutral blind manifest is always made durable before the
      // provider-specific request and mutable prepared state.
      createPrivateCanonicalJson(
        paths,
        manifestPath,
        manifest,
        invocationUnsafe,
        'BLIND_MANIFEST_COLLISION',
      );
      createPrivateCanonicalJson(
        paths,
        requestPath,
        request,
        invocationUnsafe,
        'PROVIDER_REQUEST_COLLISION',
      );
      if (executionHistory !== null) {
        const repairLineage = createProviderRepairLineage(paths, {
          history: executionHistory,
          replacementRecord: effectiveRecord,
          replacementRequest: request,
        });
        supersession = prepareProviderInvocationSupersession(paths, {
          history: executionHistory,
          successorRecord: effectiveRecord,
          successorRequest: request,
          replacementMode: repairLineage === null ? 'retry' : 'repair',
          simulateCrashAfter: input.simulateSupersessionCrashAfter,
        });
      }
      if (!invocationAlreadyExists) {
        const promptContext = prepareProviderPromptContextForInvocation(
          paths.root,
          request,
          manifest,
          investigationId,
          new Date(effectiveNow),
        );
        // The runtime this invocation produces is prunable evidence, so its
        // catalog handle is written here, while the context is current and long
        // before a TTL could make the bytes eligible for deletion. Without it a
        // maintainer has no identity to pin and the pruning pass finds no
        // decision to honour.
        registerProviderRuntimeEvidence(paths.root, {
          binding: promptContext,
          attemptId: projectProviderInvocationExecution({
            record: effectiveRecord,
            request,
          }).attempt.attemptId,
          invocationId,
          legacyRevision: effectiveRecord.revision,
          now: new Date(effectiveNow),
        });
      }
      registerProviderRetentionInvocation(paths, invocationId, effectiveNow);
      createPrivateCanonicalJson(
        paths,
        statePath,
        effectiveRecord,
        invocationUnsafe,
        'PROVIDER_INVOCATION_COLLISION',
      );
      if (supersession !== null) {
        finalizeProviderInvocationSupersession(
          paths,
          supersession,
          (relatedInvocationId) => ({
            record: readProviderInvocationCore(paths, relatedInvocationId),
            request: readProviderInvocationRequest(paths, relatedInvocationId),
          }),
          {
            publishedAt: effectiveNow,
            simulateCrashAfter: input.simulateSupersessionCrashAfter,
          },
        );
      }
      const created = readProviderInvocation(paths, invocationId);
      materializeProviderExecutionState(paths, created, request);
      return created;
    },
    'PROVIDER_INVOCATION_OPERATION_CONFLICT',
    invocationLockInvalid,
  );
}

export function readProviderInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationRecord {
  const record = readProviderInvocationCore(paths, requestedInvocationId);
  const request = readProviderInvocationRequest(paths, record.invocationId);
  assertProviderInvocationSupersessionEndpointCurrent(
    paths,
    record,
    request,
    (relatedInvocationId) => ({
      record: readProviderInvocationCore(paths, relatedInvocationId),
      request: readProviderInvocationRequest(paths, relatedInvocationId),
    }),
  );
  return record;
}

/**
 * Read one optional async receipt only after re-admitting its durable
 * Job/Attempt projection. Historical and synchronous records intentionally
 * return null instead of being rewritten.
 */
export function readProviderInvocationRuntimeReceipt(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): AgentRuntimeCompletionReceipt | null {
  const record = readProviderInvocation(paths, requestedInvocationId);
  const receipt = record.runtimeReceipt;
  if (receipt === undefined) return null;
  const execution = readExecutionJobState(paths, receipt.executionJobId);
  const attempt = execution?.attempts.find(
    ({ attemptId }) => attemptId === receipt.executionAttemptId,
  );
  const terminalStatusMatches =
    receipt.terminalState === 'succeeded'
      ? attempt?.status === 'succeeded' || attempt?.status === 'late-duplicate'
      : attempt !== undefined &&
        [
          'failed-retryable',
          'failed-terminal',
          'timed-out',
          'stale',
          'cancelled',
        ].includes(attempt.status);
  if (
    execution === null ||
    execution.revision <= receipt.executionRevision ||
    attempt === undefined ||
    attempt.jobId !== receipt.executionJobId ||
    attempt.legacyInvocation?.invocationId !== receipt.invocationId ||
    attempt.legacyInvocation.legacyRevision !== receipt.terminalRevision ||
    ((receipt.schemaVersion === 2 || receipt.schemaVersion === 3) &&
      (receipt.protocolReceipt.invocationId !== receipt.invocationId ||
        receipt.protocolReceipt.requestDigest !== receipt.requestDigest ||
        receipt.protocolReceipt.attemptId !== attempt.attemptId)) ||
    !terminalStatusMatches
  ) {
    throw invocationInvalid();
  }
  return receipt;
}

function readProviderInvocationCore(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const value = readPrivateCanonicalJson(
    paths,
    providerInvocationStatePath(paths, invocationId),
    invocationUnsafe,
  );
  const record = assertProviderInvocationRecord(value);
  if (record.invocationId !== invocationId) {
    throw invocationInvalid();
  }
  const request = readProviderInvocationRequest(paths, invocationId);
  const manifest = readProviderInvocationManifest(paths, invocationId);
  assertPlanReviewSnapshotFiles(
    paths,
    invocationId,
    manifest,
    undefined,
    record,
  );
  assertProviderInvocationBinding(
    record.changeId,
    manifest,
    providerInvocationManifestDigest(manifest),
    request,
  );
  if (
    request.requestDigest !== record.requestDigest ||
    providerInvocationManifestDigest(manifest) !== record.manifestDigest ||
    request.providerId !== record.providerId ||
    request.purpose !== record.purpose ||
    (record.result !== null &&
      canonicalJson(
        assertProviderResult(
          request,
          record.result,
          providerOutputSchemaGeneration(request),
          'legacy-subset',
        ),
      ) !== canonicalJson(record.result))
  ) {
    throw invocationInvalid();
  }
  if (record.runtimeReceipt !== undefined) {
    const projection = projectProviderInvocationExecution({ record, request });
    if (
      record.runtimeReceipt.executionJobId !== projection.job.jobId ||
      record.runtimeReceipt.executionAttemptId !== projection.attempt.attemptId
    ) {
      throw invocationInvalid();
    }
  }
  if (
    manifest.kind === 'plan-review-manifest' &&
    resolvePlanReviewInvocationOwner(paths, {
      changeId: record.changeId,
      subject: manifest.subject,
      assignment: request.roleAssignment,
      authorizationNodeId: request.authorizationNodeId,
    }) !== record.investigationId
  ) {
    throw invocationInvalid();
  }
  if (
    manifest.kind === 'task-diff-review-manifest' ||
    manifest.kind === 'task-diff-review-continuation-manifest'
  ) {
    const owner = resolveTaskDiffReviewInvocationOwner(paths, {
      changeId: record.changeId,
      sessionId: manifest.sessionId,
      subject: manifest.subject,
      assignment: request.roleAssignment,
      authorizationNodeId: request.authorizationNodeId,
    });
    if (
      owner.ownerInvestigationId !== record.investigationId ||
      canonicalJson(owner.mandateBinding) !==
        canonicalJson(record.mandateBinding ?? null)
    ) {
      throw invocationInvalid();
    }
  }
  if (manifest.kind === 'task-strategy-implementation-manifest') {
    const owner = resolveTaskStrategyImplementationInvocationOwner(paths, {
      changeId: record.changeId,
      sessionId: manifest.subject.sessionId,
      subject: manifest.subject,
      assignment: request.roleAssignment,
      authorizationNodeId: request.authorizationNodeId,
    });
    if (
      owner.ownerInvestigationId !== record.investigationId ||
      canonicalJson(owner.mandateBinding) !==
        canonicalJson(record.mandateBinding ?? null)
    ) {
      throw invocationInvalid();
    }
  }
  return deepFreeze(structuredClone(record));
}

export function readProviderInvocationEvidence(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationEvidence {
  const record = readProviderInvocationCore(paths, requestedInvocationId);
  const request = readProviderInvocationRequest(paths, record.invocationId);
  return readProviderInvocationEvidenceRecord(
    paths,
    record,
    request,
    (relatedInvocationId) => ({
      record: readProviderInvocationCore(paths, relatedInvocationId),
      request: readProviderInvocationRequest(paths, relatedInvocationId),
    }),
  );
}

export function recoverProviderInvocationSupersession(
  paths: InvestigationRuntimePaths,
  requestedSuccessorInvocationId: string,
  input: { recoveredAt?: string } = {},
) {
  return recoverProviderInvocationSupersessionTransaction(
    paths,
    requestedSuccessorInvocationId,
    (relatedInvocationId) => ({
      record: readProviderInvocationCore(paths, relatedInvocationId),
      request: readProviderInvocationRequest(paths, relatedInvocationId),
    }),
    { recoveredAt: input.recoveredAt ?? new Date().toISOString() },
  );
}

export function readPlanReviewSnapshotRuntime(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): PlanReviewSnapshotRuntime | null {
  const invocationId = assertInvocationId(requestedInvocationId);
  const manifest = readProviderInvocationManifest(paths, invocationId);
  if (
    manifest.kind !== 'plan-review-manifest' ||
    manifest.planningTarget === undefined
  ) {
    return null;
  }
  assertPlanReviewSnapshotFiles(paths, invocationId, manifest);
  const root = path.join(
    providerInvocationDirectory(paths, invocationId),
    'review-root',
  );
  return {
    root,
    files: manifest.planningTarget.artifacts.map((artifact) => ({
      id: `planning-snapshot:${artifact.path}`,
      path: path.join(root, artifact.snapshotFile),
    })),
  };
}

export function readProviderInvocationRequest(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationRequest {
  const invocationId = assertInvocationId(requestedInvocationId);
  const value = readPrivateCanonicalJson(
    paths,
    path.join(providerInvocationDirectory(paths, invocationId), 'request.json'),
    invocationUnsafe,
  );
  const request = assertProviderRequest(value);
  if (request.invocationId !== invocationId) {
    throw invocationInvalid();
  }
  return request;
}

/**
 * Publish the exact validated policy bytes selected for one Attempt. The raw
 * document, rather than a reconstructed object, remains the digest authority so
 * the request cannot be rebound through whitespace or alternate JSON bytes.
 */
export function storeProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
  loadedInput: LoadedAiAdapterPolicy,
  executionGrantAuthorization?: ProviderExecutionGrantAuthorityInput,
): ProviderExecutionPolicySnapshot {
  const snapshot = createProviderExecutionPolicySnapshot(
    requestInput,
    loadedInput,
    executionGrantAuthorization,
  );
  return ensureProviderExecutionPolicySnapshotFromSnapshot(
    paths,
    requestInput,
    snapshot,
  );
}

export function createProviderExecutionPolicySnapshot(
  requestInput: ProviderInvocationRequest,
  loadedInput: LoadedAiAdapterPolicy,
  executionGrantAuthorization?: ProviderExecutionGrantAuthorityInput,
): ProviderExecutionPolicySnapshotCurrent {
  const request = assertProviderRequest(requestInput);
  let loaded: LoadedAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(loadedInput.document);
  } catch {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  if (
    loaded.digest !== loadedInput.digest ||
    canonicalJson(loaded.policy) !== canonicalJson(loadedInput.policy) ||
    request.policyDigest !== loaded.digest ||
    request.limits.aggregateOutputBytes >
      loaded.policy.limits.aggregateOutputBytes
  ) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  const authority =
    request.limits.timeoutMs > loaded.policy.limits.timeoutMs
      ? createProviderExecutionBudgetAuthority(
          request,
          loaded,
          executionGrantAuthorization ?? missingExecutionGrantAuthority(),
        )
      : null;
  const retryAccounting = structuredClone(loaded.policy.retryAccounting);
  const attemptReservation: ProviderAttemptBudgetReservation = Object.freeze({
    runtimeMs: request.limits.timeoutMs,
    providerCostMicros:
      retryAccounting.reservations[request.providerId].providerCostMicros,
    providerTokens:
      retryAccounting.reservations[request.providerId].providerTokens,
  });
  const accountingDigest = providerRetryAccountingDigest({
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    policyDigest: request.policyDigest,
    retryAccounting,
    attemptReservation,
  });
  const common = {
    kind: 'provider-execution-policy-snapshot',
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    policyDigest: request.policyDigest,
    policyDocument: loaded.document,
    retryAccounting,
    attemptReservation,
    accountingDigest,
  } as const;
  return deepFreeze(
    authority === null
      ? { schemaVersion: 2 as const, ...common }
      : { schemaVersion: 3 as const, ...common, authority },
  );
}

export function ensureProviderExecutionPolicySnapshotFromSnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
  snapshotInput: ProviderExecutionPolicySnapshotCurrent,
): ProviderExecutionPolicySnapshot {
  const request = assertProviderRequest(requestInput);
  const expected = validateProviderExecutionPolicySnapshot(
    request,
    snapshotInput,
  );
  if (expected.schemaVersion === 3) {
    assertDurableProviderExecutionBudgetAuthority(paths, expected.authority);
  }
  const snapshotPath = providerExecutionPolicySnapshotPath(
    paths,
    request.invocationId,
  );
  if (
    privatePathExists(
      paths,
      snapshotPath,
      providerExecutionPolicySnapshotUnsafe,
    )
  ) {
    const existing = readProviderExecutionPolicySnapshot(
      paths,
      request,
    ).snapshot;
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw providerExecutionPolicySnapshotMismatch();
    }
    return existing;
  }
  createPrivateCanonicalJson(
    paths,
    snapshotPath,
    expected,
    providerExecutionPolicySnapshotUnsafe,
    'PROVIDER_EXECUTION_POLICY_SNAPSHOT_CONFLICT',
  );
  return readProviderExecutionPolicySnapshot(paths, request).snapshot;
}

export function validateProviderExecutionPolicySnapshot(
  requestInput: ProviderInvocationRequest,
  snapshotInput: unknown,
): ProviderExecutionPolicySnapshotCurrent {
  const request = assertProviderRequest(requestInput);
  if (
    !isRecord(snapshotInput) ||
    ![2, 3].includes(snapshotInput.schemaVersion as number) ||
    !isProviderExecutionPolicySnapshotShape(snapshotInput)
  ) {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  let loaded: LoadedAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(snapshotInput.policyDocument);
  } catch {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  const expected = createProviderExecutionPolicySnapshot(
    request,
    loaded,
    snapshotInput.schemaVersion === 3
      ? validateProviderExecutionBudgetAuthority(
          request,
          loaded,
          snapshotInput.authority,
        )
      : undefined,
  );
  if (canonicalJson(expected) !== canonicalJson(snapshotInput)) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  return expected;
}

/**
 * Recover a missing snapshot only from policy bytes that independently validate
 * to the request's exact digest. An existing snapshot remains the authority and
 * is validated without consulting possibly newer live policy bytes.
 */
export function ensureProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
  loadedInput: LoadedAiAdapterPolicy,
): ProviderExecutionPolicySnapshot {
  const request = assertProviderRequest(requestInput);
  const snapshotPath = providerExecutionPolicySnapshotPath(
    paths,
    request.invocationId,
  );
  if (
    privatePathExists(
      paths,
      snapshotPath,
      providerExecutionPolicySnapshotUnsafe,
    )
  ) {
    return readProviderExecutionPolicySnapshot(paths, request).snapshot;
  }
  return storeProviderExecutionPolicySnapshot(paths, request, loadedInput);
}

export function readProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
): Readonly<{
  snapshot: ProviderExecutionPolicySnapshot;
  loaded: LoadedAiAdapterPolicy | LoadedLegacyAiAdapterPolicy;
  accounting: ProviderRetryAccountingSnapshot | null;
}> {
  const request = assertProviderRequest(requestInput);
  let value: unknown;
  try {
    value = readPrivateCanonicalJson(
      paths,
      providerExecutionPolicySnapshotPath(paths, request.invocationId),
      providerExecutionPolicySnapshotUnsafe,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE'
    ) {
      throw error;
    }
    throw providerExecutionPolicySnapshotUnsafe();
  }
  if (!isRecord(value) || !isProviderExecutionPolicySnapshotShape(value)) {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  let loaded: LoadedAiAdapterPolicy | LoadedLegacyAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(value.policyDocument);
  } catch {
    if (value.schemaVersion !== 1) {
      throw providerExecutionPolicySnapshotUnsafe();
    }
    try {
      loaded = parseLegacyAiAdapterPolicyDocument(value.policyDocument);
    } catch {
      throw providerExecutionPolicySnapshotUnsafe();
    }
  }
  if (
    value.invocationId !== request.invocationId ||
    value.requestDigest !== request.requestDigest ||
    value.policyDigest !== request.policyDigest ||
    value.policyDigest !== loaded.digest ||
    request.limits.aggregateOutputBytes >
      loaded.policy.limits.aggregateOutputBytes
  ) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  const validated =
    value.schemaVersion === 1
      ? null
      : validateProviderExecutionPolicySnapshot(request, value);
  if (validated?.schemaVersion === 3) {
    assertDurableProviderExecutionBudgetAuthority(paths, validated.authority);
  } else if (request.limits.timeoutMs > loaded.policy.limits.timeoutMs) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  let accounting: ProviderRetryAccountingSnapshot | null = null;
  if (value.schemaVersion === 2 || value.schemaVersion === 3) {
    if (loaded.policy.schemaVersion !== 4) {
      throw providerExecutionPolicySnapshotUnsafe();
    }
    const expectedReservation: ProviderAttemptBudgetReservation = {
      runtimeMs: request.limits.timeoutMs,
      providerCostMicros:
        loaded.policy.retryAccounting.reservations[request.providerId]
          .providerCostMicros,
      providerTokens:
        loaded.policy.retryAccounting.reservations[request.providerId]
          .providerTokens,
    };
    if (
      canonicalJson(value.retryAccounting) !==
        canonicalJson(loaded.policy.retryAccounting) ||
      canonicalJson(value.attemptReservation) !==
        canonicalJson(expectedReservation) ||
      value.accountingDigest !==
        providerRetryAccountingDigest({
          invocationId: request.invocationId,
          requestDigest: request.requestDigest,
          policyDigest: request.policyDigest,
          retryAccounting: loaded.policy.retryAccounting,
          attemptReservation: expectedReservation,
        })
    ) {
      throw providerExecutionPolicySnapshotMismatch();
    }
    accounting = deepFreeze({
      retryPolicy: structuredClone(loaded.policy.retryAccounting),
      attemptReservation: structuredClone(expectedReservation),
      accountingDigest: value.accountingDigest,
    });
  }
  return Object.freeze({
    snapshot: Object.freeze(
      structuredClone(value) as ProviderExecutionPolicySnapshot,
    ),
    loaded,
    accounting,
  });
}

function isProviderExecutionPolicySnapshotShape(
  value: Record<string, unknown>,
): value is ProviderExecutionPolicySnapshot {
  const common =
    value.kind === 'provider-execution-policy-snapshot' &&
    typeof value.invocationId === 'string' &&
    typeof value.requestDigest === 'string' &&
    typeof value.policyDigest === 'string' &&
    typeof value.policyDocument === 'string';
  if (!common) return false;
  if (value.schemaVersion === 1) {
    return hasExactKeys(value, [
      'invocationId',
      'kind',
      'policyDigest',
      'policyDocument',
      'requestDigest',
      'schemaVersion',
    ]);
  }
  const expectedKeys = [
    'accountingDigest',
    'attemptReservation',
    ...(value.schemaVersion === 3 ? ['authority'] : []),
    'invocationId',
    'kind',
    'policyDigest',
    'policyDocument',
    'requestDigest',
    'retryAccounting',
    'schemaVersion',
  ];
  return (
    (value.schemaVersion === 2 || value.schemaVersion === 3) &&
    hasExactKeys(value, expectedKeys) &&
    (value.schemaVersion !== 3 || isRecord(value.authority)) &&
    isRecord(value.retryAccounting) &&
    isProviderAttemptBudgetReservation(value.attemptReservation) &&
    typeof value.accountingDigest === 'string' &&
    DIGEST.test(value.accountingDigest)
  );
}

function assertDurableProviderExecutionBudgetAuthority(
  paths: InvestigationRuntimePaths,
  authority: ProviderExecutionBudgetAuthority,
): void {
  try {
    assertStoredProviderExecutionBudgetAuthority(paths.root, authority);
  } catch {
    throw providerExecutionPolicySnapshotMismatch();
  }
}

function missingExecutionGrantAuthority(): never {
  throw providerExecutionPolicySnapshotMismatch();
}

function isProviderAttemptBudgetReservation(
  value: unknown,
): value is ProviderAttemptBudgetReservation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'providerCostMicros',
      'providerTokens',
      'runtimeMs',
    ]) &&
    Number.isSafeInteger(value.runtimeMs) &&
    (value.runtimeMs as number) > 0 &&
    Number.isSafeInteger(value.providerCostMicros) &&
    (value.providerCostMicros as number) > 0 &&
    Number.isSafeInteger(value.providerTokens) &&
    (value.providerTokens as number) > 0
  );
}

function providerRetryAccountingDigest(input: {
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  retryAccounting: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
}): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-retry-accounting-snapshot',
      ...input,
    }),
  );
}

export function providerExecutionPolicySnapshotPath(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): string {
  return path.join(
    providerInvocationDirectory(
      paths,
      assertInvocationId(requestedInvocationId),
    ),
    'execution-policy.json',
  );
}

export function readBlindSurveyManifest(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): BlindSurveyManifest {
  const invocationId = assertInvocationId(requestedInvocationId);
  const manifest = readProviderInvocationManifest(paths, invocationId);
  if (manifest.kind !== 'blind-survey-manifest') {
    throw invocationInvalid();
  }
  return manifest;
}

export function readProviderInvocationManifest(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationManifest {
  const invocationId = assertInvocationId(requestedInvocationId);
  const value = readPrivateCanonicalJson(
    paths,
    path.join(
      providerInvocationDirectory(paths, invocationId),
      'manifest.json',
    ),
    invocationUnsafe,
  );
  return assertProviderInvocationManifest(value);
}

export function providerInvocationExists(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): boolean {
  const invocationId = assertInvocationId(requestedInvocationId);
  return privatePathExists(
    paths,
    providerInvocationStatePath(paths, invocationId),
    invocationUnsafe,
  );
}

export function prepareProviderInvocationAcceptanceBinding(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationAcceptanceBinding {
  const invocationId = assertInvocationId(requestedInvocationId);
  const record = readProviderInvocation(paths, invocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  if (record.state !== 'leased' || record.lease === null) {
    throw providerAcceptanceBindingStale();
  }
  assertProviderInvocationNotTerminallyResolved(paths, record);
  const manifest = readProviderInvocationManifest(paths, invocationId);
  const context = ensureProviderPromptContext(
    paths.root,
    request,
    manifest,
    record.investigationId,
  );
  const projection = projectProviderInvocationExecution({ record, request });
  const execution = readExecutionJobState(paths, projection.job.jobId);
  const attempt = execution?.attempts.find(
    ({ attemptId }) => attemptId === projection.attempt.attemptId,
  );
  if (
    execution === null ||
    execution.workflow.workflowId !== record.investigationId ||
    execution.job.jobId !== projection.job.jobId ||
    execution.job.acceptedAttemptId !== null ||
    attempt === undefined ||
    attempt.legacyInvocation?.invocationId !== invocationId ||
    attempt.legacyInvocation.legacyRevision !== record.revision
  ) {
    throw providerAcceptanceBindingStale();
  }
  const repair = readProviderRepairAuthorityBinding(paths, record, request);
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-invocation-acceptance-binding' as const,
    invocationId,
    requestDigest: request.requestDigest,
    ownerWorkflowId: record.investigationId,
    legacyRevision: record.revision,
    leaseGeneration: record.leaseGeneration,
    context,
    executionJobId: projection.job.jobId,
    executionAttemptId: projection.attempt.attemptId,
    executionRevision: execution.revision,
    executionStateDigest: sha256(canonicalJson(execution)),
    repair,
  };
  return deepFreeze({
    ...payload,
    bindingDigest: sha256(canonicalJson(payload)),
  });
}

export function assertProviderInvocationAcceptanceBindingCurrent(
  paths: InvestigationRuntimePaths,
  binding: ProviderInvocationAcceptanceBinding,
): void {
  assertProviderAcceptanceBinding(binding);
  const record = readProviderInvocation(paths, binding.invocationId);
  const request = readProviderInvocationRequest(paths, binding.invocationId);
  if (
    record.investigationId !== binding.ownerWorkflowId ||
    record.requestDigest !== binding.requestDigest ||
    record.revision !== binding.legacyRevision ||
    record.state !== 'leased' ||
    record.lease === null ||
    record.leaseGeneration !== binding.leaseGeneration ||
    record.lease.generation !== binding.leaseGeneration
  ) {
    throw providerAcceptanceBindingStale();
  }
  assertProviderInvocationNotTerminallyResolved(paths, record);
  assertProviderPromptContextCurrent(paths.root, binding.context);
  const projection = projectProviderInvocationExecution({ record, request });
  const execution = readExecutionJobState(paths, binding.executionJobId);
  const attempt = execution?.attempts.find(
    ({ attemptId }) => attemptId === binding.executionAttemptId,
  );
  if (
    projection.job.jobId !== binding.executionJobId ||
    projection.attempt.attemptId !== binding.executionAttemptId ||
    execution === null ||
    execution.revision !== binding.executionRevision ||
    sha256(canonicalJson(execution)) !== binding.executionStateDigest ||
    execution.workflow.workflowId !== binding.ownerWorkflowId ||
    execution.job.acceptedAttemptId !== null ||
    attempt === undefined ||
    attempt.legacyInvocation?.invocationId !== binding.invocationId ||
    attempt.legacyInvocation.legacyRevision !== binding.legacyRevision
  ) {
    throw providerAcceptanceBindingStale();
  }
  assertProviderRepairAuthorityCurrent(paths, record, request, binding.repair);
}

export function claimProviderInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    workerId: string;
    leaseDurationMs: number;
    expectedRevision?: number;
    now?: string;
  },
): ProviderLeaseClaim {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  if (
    typeof input.workerId !== 'string' ||
    input.workerId.trim().length === 0 ||
    Buffer.byteLength(input.workerId, 'utf8') > 256 ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > request.limits.timeoutMs
  ) {
    throw leaseInvalid();
  }
  const now = parseNow(input.now);
  return withProviderWorkerLifecycle(paths, () =>
    claimProviderInvocationUnderLifecycleLock(paths, invocationId, input, now),
  );
}

export function claimProviderInvocationForWorker(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    workerId: string;
    leaseDurationMs: number;
    expectedRevision?: number;
    now?: string;
  },
): ProviderWorkerLeaseClaim {
  return withProviderWorkerLifecycle(paths, (assertOwned) =>
    claimProviderInvocationForWorkerUnderLifecycleLock(
      paths,
      requestedInvocationId,
      input,
      assertOwned,
    ),
  );
}

export function claimProviderInvocationForWorkerUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    workerId: string;
    leaseDurationMs: number;
    expectedRevision?: number;
    now?: string;
  },
  assertOwned: () => void,
): ProviderWorkerLeaseClaim {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  if (
    typeof input.workerId !== 'string' ||
    input.workerId.trim().length === 0 ||
    Buffer.byteLength(input.workerId, 'utf8') > 256 ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > request.limits.timeoutMs
  ) {
    throw leaseInvalid();
  }
  const now = parseNow(input.now);
  assertOwned();
  const claim = claimProviderInvocationUnderLifecycleLock(
    paths,
    invocationId,
    input,
    now,
  );
  const workerFenceToken = crypto.randomUUID();
  createProviderWorkerFence(paths, claim.record, workerFenceToken);
  assertOwned();
  return { ...claim, workerFenceToken };
}

function claimProviderInvocationUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  input: {
    workerId: string;
    leaseDurationMs: number;
    expectedRevision?: number;
  },
  now: number,
): ProviderLeaseClaim {
  const leaseToken = crypto.randomBytes(32).toString('hex');
  const record = updateProviderInvocation(
    paths,
    invocationId,
    input.expectedRevision,
    (current) => {
      assertProviderInvocationNotTerminallyResolved(paths, current);
      if (
        current.state === 'leased' &&
        current.lease !== null &&
        now >= Date.parse(current.lease.expiresAt)
      ) {
        throw workflowError(
          'PROVIDER_INVOCATION_LEASE_EXPIRED',
          'Provider invocation lease expired and requires explicit recovery.',
          ExitCode.staleState,
        );
      }
      if (current.state !== 'prepared') {
        throw workflowError(
          'PROVIDER_INVOCATION_LEASE_CONFLICT',
          'Provider invocation is not prepared or already has a lease.',
          ExitCode.conflict,
        );
      }
      const generation = current.leaseGeneration + 1;
      return {
        ...current,
        revision: current.revision + 1,
        state: 'leased',
        leaseGeneration: generation,
        lease: {
          generation,
          workerId: input.workerId,
          tokenDigest: sha256(leaseToken),
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(
            now + input.leaseDurationMs + PROVIDER_COMPLETION_GRACE_MS,
          ).toISOString(),
        },
        result: null,
        failure: null,
        updatedAt: new Date(now).toISOString(),
      };
    },
  );
  return { record, leaseToken };
}

function assertProviderInvocationNotTerminallyResolved(
  paths: InvestigationRuntimePaths,
  invocation: ProviderInvocationRecord,
): void {
  const resolutionNodeId = readHumanResolutionHead(
    paths,
    invocation.investigationId,
  );
  if (resolutionNodeId === null) {
    return;
  }
  const resolution = readHumanResolutionNode(paths, resolutionNodeId);
  if (
    resolution.target.workflowId !== invocation.investigationId ||
    resolution.target.changeId !== invocation.changeId
  ) {
    throw invocationInvalid();
  }
  if (
    ['abort', 'supersede', 'quarantine', 'repair'].includes(
      resolution.decision.kind,
    )
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_TERMINALLY_RESOLVED',
      'Provider invocation belongs to a terminally resolved investigation.',
      ExitCode.guard,
    );
  }
}

type ProviderWorkerFence = {
  schemaVersion: 1;
  kind: 'provider-worker-fence';
  invocationId: string;
  leaseGeneration: number;
  workerId: string;
  leaseTokenDigest: string;
  ownerToken: string;
  pid: number;
  acquiredAt: string;
};

function createProviderWorkerFence(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  ownerToken: string,
): void {
  if (record.state !== 'leased' || record.lease === null) {
    throw providerWorkerFenceUnsafe();
  }
  const fence: ProviderWorkerFence = {
    schemaVersion: 1,
    kind: 'provider-worker-fence',
    invocationId: record.invocationId,
    leaseGeneration: record.leaseGeneration,
    workerId: record.lease.workerId,
    leaseTokenDigest: record.lease.tokenDigest,
    ownerToken,
    pid: process.pid,
    acquiredAt: record.lease.acquiredAt,
  };
  createPrivateCanonicalJson(
    paths,
    providerWorkerFencePath(paths, record.invocationId),
    fence,
    providerWorkerFenceUnsafe,
    'PROVIDER_INVOCATION_WORKER_FENCE_CONFLICT',
  );
}

export function releaseProviderInvocationWorkerFence(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  ownerToken: string,
): void {
  const invocationId = assertInvocationId(requestedInvocationId);
  withProviderWorkerLifecycle(paths, () => {
    const fence = readProviderWorkerFence(paths, invocationId);
    if (
      fence === null ||
      fence.ownerToken !== ownerToken ||
      fence.pid !== process.pid
    ) {
      throw providerWorkerFenceUnsafe();
    }
    fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
    fsyncDirectory(paths.locks);
  });
}

export function assertProviderWorkersQuiescentUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
): void {
  const stats = fs.lstatSync(paths.locks, { throwIfNoEntry: false });
  if (!stats) {
    return;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw providerWorkerFenceUnsafe();
  }
  const suffix = '.worker-active';
  for (const entry of fs
    .readdirSync(paths.locks, { withFileTypes: true })
    .filter(({ name }) => name.endsWith(suffix))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw providerWorkerFenceUnsafe();
    }
    const invocationId = assertInvocationId(
      entry.name.slice(0, -suffix.length),
    );
    assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
      paths,
      invocationId,
    );
  }
}

function assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  options: {
    allowDeadLeasedFence?: boolean;
  } = {},
): void {
  const fence = readProviderWorkerFence(paths, invocationId);
  if (fence === null) {
    return;
  }
  const invocation = readProviderInvocation(paths, invocationId);
  if (
    invocation.leaseGeneration !== fence.leaseGeneration ||
    invocation.state === 'prepared' ||
    (invocation.state === 'leased' &&
      (invocation.lease === null ||
        invocation.lease.workerId !== fence.workerId ||
        invocation.lease.tokenDigest !== fence.leaseTokenDigest))
  ) {
    throw providerWorkerFenceUnsafe();
  }
  if (isProcessAlive(fence.pid)) {
    throw workflowError(
      'PROVIDER_INVOCATION_WORKER_ACTIVE',
      'Provider invocation still has a live worker activity fence.',
      ExitCode.conflict,
      { details: { invocationId, pid: fence.pid } },
    );
  }
  if (invocation.state === 'leased') {
    if (options.allowDeadLeasedFence === true) {
      return;
    }
    throw workflowError(
      'PROVIDER_INVOCATION_WORKER_RECOVERY_REQUIRED',
      'A dead provider worker still owns a leased invocation and requires explicit recovery.',
      ExitCode.conflict,
      { details: { invocationId, pid: fence.pid } },
    );
  }
  fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
  fsyncDirectory(paths.locks);
}

function readProviderWorkerFence(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): ProviderWorkerFence | null {
  const filePath = providerWorkerFencePath(paths, invocationId);
  if (!privatePathExists(paths, filePath, providerWorkerFenceUnsafe)) {
    return null;
  }
  const value = readPrivateCanonicalJson(
    paths,
    filePath,
    providerWorkerFenceUnsafe,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'leaseGeneration',
      'workerId',
      'leaseTokenDigest',
      'ownerToken',
      'pid',
      'acquiredAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-worker-fence' ||
    value.invocationId !== invocationId ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    typeof value.workerId !== 'string' ||
    value.workerId.length === 0 ||
    !isDigest(value.leaseTokenDigest) ||
    typeof value.ownerToken !== 'string' ||
    value.ownerToken.length === 0 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    !isTimestamp(value.acquiredAt)
  ) {
    throw providerWorkerFenceUnsafe();
  }
  return value as ProviderWorkerFence;
}

function providerWorkerFencePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(paths.locks, `${invocationId}.worker-active`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function expireProviderInvocationLease(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    now?: string;
  },
): ProviderInvocationRecord {
  return withProviderWorkerLifecycle(paths, (assertOwned) =>
    expireProviderInvocationLeaseUnderLifecycleLock(
      paths,
      requestedInvocationId,
      input,
      assertOwned,
    ),
  );
}

export function expireProviderInvocationLeaseUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    now?: string;
  },
  assertOwned: () => void,
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const now = parseNow(input.now);
  assertOwned();
  assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
    paths,
    invocationId,
    { allowDeadLeasedFence: true },
  );
  const expired = updateProviderInvocation(
    paths,
    invocationId,
    input.expectedRevision,
    (current) => {
      if (
        current.state !== 'leased' ||
        current.lease === null ||
        now < Date.parse(current.lease.expiresAt)
      ) {
        throw workflowError(
          'PROVIDER_INVOCATION_LEASE_NOT_EXPIRED',
          'Provider invocation lease is absent or still current.',
          ExitCode.guard,
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        state: 'failed',
        lease: null,
        result: null,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_INVOCATION_LEASE_EXPIRED',
          message:
            'The prior worker lease expired; retry requires a fresh invocation.',
        },
        updatedAt: new Date(now).toISOString(),
      };
    },
  );
  assertOwned();
  assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
    paths,
    invocationId,
  );
  return expired;
}

export function completeProviderInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    leaseGeneration: number;
    leaseToken: string;
    outcome: ProviderProcessOutcome;
    now?: string;
    simulateCrashAfterExecutionAcceptance?: boolean;
  },
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  const result = evaluateProviderProcess(
    request,
    input.outcome,
    providerOutputValidator(request),
  );
  const now = parseNow(input.now);
  return withProviderWorkerLifecycle(paths, () =>
    updateProviderInvocation(
      paths,
      invocationId,
      input.expectedRevision,
      (current) => {
        assertCurrentLease(
          current,
          input.leaseGeneration,
          input.leaseToken,
          now,
        );
        persistProviderCompletionCandidate(paths, {
          current,
          request,
          leaseGeneration: input.leaseGeneration,
          leaseToken: input.leaseToken,
          result,
          completedAt: new Date(now).toISOString(),
        });
        persistProviderExecutionResult(
          paths,
          current,
          request,
          input.leaseGeneration,
          input.leaseToken,
          result.outputDigest,
          now,
        );
        if (input.simulateCrashAfterExecutionAcceptance === true) {
          throw workflowError(
            'PROVIDER_COMPLETION_SIMULATED_CRASH',
            'Simulated crash after durable execution acceptance.',
            ExitCode.internal,
          );
        }
        return {
          ...current,
          revision: current.revision + 1,
          state: 'succeeded',
          lease: null,
          result,
          failure: null,
          updatedAt: new Date(now).toISOString(),
        };
      },
    ),
  );
}

/**
 * Complete one leased invocation directly from the fixed runner report. The
 * semantic output and runtime observation are revalidated independently; a
 * real report is never reconstructed through the fake stdout evaluator.
 */
export function completeProviderInvocationFromRunner(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    leaseGeneration: number;
    leaseToken: string;
    report: ProviderRunnerReport;
    acceptanceBinding: ProviderInvocationAcceptanceBinding;
    runtimeProgress?: AgentRuntimeProcessProgressProjection;
    now?: string;
    simulateCrashAfterExecutionAcceptance?: boolean;
  },
): ProviderInvocationRecord {
  return withProviderWorkerLifecycle(paths, (assertOwned) =>
    completeProviderInvocationFromRunnerUnderLifecycleLock(
      paths,
      requestedInvocationId,
      input,
      assertOwned,
    ),
  );
}

/**
 * Complete one fixed-runner result while the caller holds the repository
 * lifecycle lock. This seam lets lifecycle-owned subjects revalidate their
 * exact owner and publish terminal success in one critical section.
 */
export function completeProviderInvocationFromRunnerUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    leaseGeneration: number;
    leaseToken: string;
    report: ProviderRunnerReport;
    acceptanceBinding: ProviderInvocationAcceptanceBinding;
    runtimeProgress?: AgentRuntimeProcessProgressProjection;
    now?: string;
    simulateCrashAfterExecutionAcceptance?: boolean;
  },
  assertOwned: () => void,
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  const result = providerResultFromRunnerReport(request, input.report);
  const now = parseNow(input.now);
  assertProviderAcceptanceBinding(input.acceptanceBinding);
  if (
    input.acceptanceBinding.invocationId !== invocationId ||
    input.acceptanceBinding.requestDigest !== request.requestDigest
  ) {
    throw providerAcceptanceBindingStale();
  }
  const protocolReceipt = assertSuccessfulRunnerProtocolReceipt(
    input.report.wrapperProtocolReceipt,
    request,
    input.acceptanceBinding,
  );
  if (protocolReceipt !== undefined && input.runtimeProgress === undefined) {
    throw invocationInvalid();
  }
  assertOwned();
  const completed = withCurrentProviderPromptContext(
    paths.root,
    input.acceptanceBinding.context,
    () =>
      updateProviderInvocation(
        paths,
        invocationId,
        input.expectedRevision,
        (current) => {
          assertCurrentLease(
            current,
            input.leaseGeneration,
            input.leaseToken,
            now,
          );
          assertProviderInvocationAcceptanceBindingCurrent(
            paths,
            input.acceptanceBinding,
          );
          const runtimeReceipt =
            input.runtimeProgress === undefined
              ? undefined
              : createAgentRuntimeCompletionReceipt({
                  current,
                  request,
                  acceptanceBinding: input.acceptanceBinding,
                  terminalState: 'succeeded',
                  progress: input.runtimeProgress,
                  ...(protocolReceipt === undefined ? {} : { protocolReceipt }),
                });
          persistProviderCompletionCandidate(paths, {
            current,
            request,
            leaseGeneration: input.leaseGeneration,
            leaseToken: input.leaseToken,
            result,
            completedAt: new Date(now).toISOString(),
            ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
          });
          persistProviderExecutionResult(
            paths,
            current,
            request,
            input.leaseGeneration,
            input.leaseToken,
            result.outputDigest,
            now,
            input.acceptanceBinding.executionRevision,
          );
          if (input.simulateCrashAfterExecutionAcceptance === true) {
            throw workflowError(
              'PROVIDER_COMPLETION_SIMULATED_CRASH',
              'Simulated crash after durable execution acceptance.',
              ExitCode.internal,
            );
          }
          return {
            ...current,
            revision: current.revision + 1,
            state: 'succeeded',
            lease: null,
            result,
            failure: null,
            ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
            updatedAt: new Date(now).toISOString(),
          };
        },
      ),
  );
  assertOwned();
  return completed;
}

export type ProviderCompletionRecovery = Readonly<{
  record: ProviderInvocationRecord;
  repaired: boolean;
  candidateDigest: string | null;
}>;

export function providerCompletionCandidateExists(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): boolean {
  const invocationId = assertInvocationId(requestedInvocationId);
  return privatePathExists(
    paths,
    providerCompletionCandidatePath(paths, invocationId),
    invocationUnsafe,
  );
}

/**
 * Finalize only an already-durable Attempt result. The caller must hold the
 * repository lifecycle lock and prove the exact durable result identity; this
 * function never evaluates or re-runs provider work.
 */
export function recoverProviderInvocationCompletionUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedLegacyRevision: number;
    acceptedOutputDigest: string;
  },
  assertOwned: () => void,
): ProviderCompletionRecovery {
  const invocationId = assertInvocationId(requestedInvocationId);
  if (
    !Number.isSafeInteger(input.expectedLegacyRevision) ||
    input.expectedLegacyRevision < 0 ||
    !isDigest(input.acceptedOutputDigest)
  ) {
    throw invocationInvalid();
  }
  assertOwned();
  assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
    paths,
    invocationId,
    { allowDeadLeasedFence: true },
  );
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${invocationId}.lock`),
    () => {
      assertOwned();
      const current = readProviderInvocation(paths, invocationId);
      const request = readProviderInvocationRequest(paths, invocationId);
      const candidatePath = providerCompletionCandidatePath(
        paths,
        invocationId,
      );
      const candidate = privatePathExists(
        paths,
        candidatePath,
        invocationUnsafe,
      )
        ? readProviderCompletionCandidate(paths, invocationId, request)
        : null;

      if (current.state === 'succeeded' && current.result !== null) {
        const candidateMatches =
          candidate === null ||
          (current.revision === candidate.expectedLegacyRevision + 1 &&
            canonicalJson(current.result) === canonicalJson(candidate.result) &&
            canonicalJson(current.runtimeReceipt ?? null) ===
              canonicalJson(candidate.runtimeReceipt ?? null));
        const expectedRevisionMatches =
          current.revision === input.expectedLegacyRevision ||
          candidate?.expectedLegacyRevision === input.expectedLegacyRevision;
        if (
          candidateMatches &&
          expectedRevisionMatches &&
          current.result.outputDigest === input.acceptedOutputDigest
        ) {
          return deepFreeze({
            record: current,
            repaired: false,
            candidateDigest: candidate?.candidateDigest ?? null,
          });
        }
        throw providerCompletionRecoveryConflict();
      }

      if (
        current.state !== 'leased' ||
        current.lease === null ||
        candidate === null
      ) {
        throw candidate === null && current.state === 'leased'
          ? workflowError(
              'PROVIDER_COMPLETION_RECOVERY_ARTIFACT_REQUIRED',
              'Durable acceptance cannot repair legacy state without its exact completion candidate.',
              ExitCode.staleState,
            )
          : providerCompletionRecoveryConflict();
      }
      if (
        current.revision !== input.expectedLegacyRevision ||
        candidate.expectedLegacyRevision !== input.expectedLegacyRevision ||
        candidate.leaseGeneration !== current.leaseGeneration ||
        candidate.leaseGeneration !== current.lease.generation ||
        candidate.leaseTokenDigest !== current.lease.tokenDigest ||
        candidate.result.outputDigest !== input.acceptedOutputDigest
      ) {
        throw providerCompletionRecoveryConflict();
      }
      const next = assertProviderInvocationRecord({
        ...current,
        revision: current.revision + 1,
        state: 'succeeded',
        lease: null,
        result: candidate.result,
        failure: null,
        ...(candidate.runtimeReceipt === undefined
          ? {}
          : { runtimeReceipt: candidate.runtimeReceipt }),
        updatedAt: candidate.completedAt,
      });
      assertMonotonicInvocationTransition(current, next);
      assertOwned();
      writePrivateCanonicalJsonAtomic(
        paths,
        providerInvocationStatePath(paths, invocationId),
        next,
        invocationUnsafe,
      );
      const repaired = readProviderInvocation(paths, invocationId);
      assertOwned();
      assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
        paths,
        invocationId,
      );
      return deepFreeze({
        record: repaired,
        repaired: true,
        candidateDigest: candidate.candidateDigest,
      });
    },
    'PROVIDER_COMPLETION_RECOVERY_CONFLICT',
    invocationLockInvalid,
  );
}

function persistProviderExecutionResult(
  paths: InvestigationRuntimePaths,
  current: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
  leaseGeneration: number,
  leaseToken: string,
  outputDigest: string,
  now: number,
  expectedExecutionRevision?: number,
): void {
  const entries = providerExecutionEntries(paths, current, request);
  const projection = projectProviderInvocationExecution({
    record: current,
    request,
  });
  const result = acceptLegacyProviderAttemptResult(paths, {
    entries,
    attemptId: projection.attempt.attemptId,
    leaseGeneration,
    leaseToken,
    outputDigest,
    completedAt: new Date(now).toISOString(),
    ...(expectedExecutionRevision === undefined
      ? {}
      : { expectedRevision: expectedExecutionRevision }),
  });
  if (
    result.result.attemptId !== projection.attempt.attemptId ||
    (result.accepted &&
      result.state.job.acceptedAttemptId !== projection.attempt.attemptId)
  ) {
    throw workflowError(
      'PROVIDER_RESULT_ACCEPTANCE_CAS_REJECTED',
      'Provider result did not bind to the stable Job result CAS.',
      ExitCode.staleState,
    );
  }
}

function persistProviderCompletionCandidate(
  paths: InvestigationRuntimePaths,
  input: {
    current: ProviderInvocationRecord;
    request: ProviderInvocationRequest;
    leaseGeneration: number;
    leaseToken: string;
    result: ProviderProcessResult;
    runtimeReceipt?: AgentRuntimeCompletionReceipt;
    completedAt: string;
  },
): ProviderCompletionCandidate {
  const result = assertProviderResult(input.request, input.result);
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-completion-candidate' as const,
    invocationId: input.current.invocationId,
    requestDigest: input.request.requestDigest,
    expectedLegacyRevision: input.current.revision,
    leaseGeneration: input.leaseGeneration,
    leaseTokenDigest: sha256(input.leaseToken),
    result,
    ...(input.runtimeReceipt === undefined
      ? {}
      : { runtimeReceipt: input.runtimeReceipt }),
    completedAt: input.completedAt,
  };
  const candidate = {
    ...payload,
    candidateDigest: sha256(canonicalJson(payload)),
  };
  const filePath = providerCompletionCandidatePath(
    paths,
    input.current.invocationId,
  );
  if (privatePathExists(paths, filePath, invocationUnsafe)) {
    const existing = readProviderCompletionCandidate(
      paths,
      input.current.invocationId,
      input.request,
    );
    if (canonicalJson(existing) !== canonicalJson(candidate)) {
      throw workflowError(
        'PROVIDER_COMPLETION_CANDIDATE_CONFLICT',
        'A different completion candidate already exists for this invocation.',
        ExitCode.conflict,
      );
    }
    return existing;
  }
  createPrivateCanonicalJson(
    paths,
    filePath,
    candidate,
    invocationUnsafe,
    'PROVIDER_COMPLETION_CANDIDATE_CONFLICT',
  );
  return readProviderCompletionCandidate(
    paths,
    input.current.invocationId,
    input.request,
  );
}

function readProviderCompletionCandidate(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  request: ProviderInvocationRequest,
): ProviderCompletionCandidate {
  const value = readPrivateCanonicalJson(
    paths,
    providerCompletionCandidatePath(paths, invocationId),
    invocationUnsafe,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'candidateDigest',
      'completedAt',
      'expectedLegacyRevision',
      'invocationId',
      'kind',
      'leaseGeneration',
      'leaseTokenDigest',
      'requestDigest',
      'result',
      ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
        ? ['runtimeReceipt']
        : []),
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-completion-candidate' ||
    value.invocationId !== invocationId ||
    value.requestDigest !== request.requestDigest ||
    !Number.isSafeInteger(value.expectedLegacyRevision) ||
    (value.expectedLegacyRevision as number) < 0 ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    !isDigest(value.leaseTokenDigest) ||
    !isTimestamp(value.completedAt) ||
    !isDigest(value.candidateDigest)
  ) {
    throw invocationUnsafe();
  }
  const result = assertProviderResult(
    request,
    value.result,
    providerOutputSchemaGeneration(request),
    'legacy-subset',
  );
  const runtimeReceipt = Object.prototype.hasOwnProperty.call(
    value,
    'runtimeReceipt',
  )
    ? assertAgentRuntimeCompletionReceipt(value.runtimeReceipt)
    : undefined;
  if (
    runtimeReceipt !== undefined &&
    (runtimeReceipt.invocationId !== invocationId ||
      runtimeReceipt.requestDigest !== request.requestDigest ||
      runtimeReceipt.leasedRevision !== value.expectedLegacyRevision ||
      runtimeReceipt.leaseGeneration !== value.leaseGeneration ||
      runtimeReceipt.terminalState !== 'succeeded')
  ) {
    throw invocationUnsafe();
  }
  const payload = { ...value };
  delete payload.candidateDigest;
  if (sha256(canonicalJson(payload)) !== value.candidateDigest) {
    throw invocationUnsafe();
  }
  return deepFreeze({
    ...(value as Omit<ProviderCompletionCandidate, 'result'>),
    result,
    ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
  });
}

function materializeProviderExecutionState(
  paths: InvestigationRuntimePaths,
  current: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): LegacyProviderExecutionEntry[] {
  const entries = providerExecutionEntries(paths, current, request);
  materializeLegacyProviderExecutionJob(paths, entries);
  return entries;
}

function providerExecutionEntries(
  paths: InvestigationRuntimePaths,
  current: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): LegacyProviderExecutionEntry[] {
  const currentProjection = projectProviderInvocationExecution({
    record: current,
    request,
  });
  const entries = listProviderInvocationLifecycleProjections(paths)
    .filter(
      (entry) =>
        entry.investigationId === current.investigationId &&
        entry.purpose === current.purpose,
    )
    .map((entry): LegacyProviderExecutionEntry => {
      if (entry.invocationId === current.invocationId) {
        return providerExecutionEntry(paths, current, request);
      }
      const historicalRecord = readProviderInvocation(
        paths,
        entry.invocationId,
      );
      const historicalRequest = readProviderInvocationRequest(
        paths,
        entry.invocationId,
      );
      return providerExecutionEntry(paths, historicalRecord, historicalRequest);
    })
    .filter(
      (entry) =>
        projectProviderInvocationExecution(entry).job.jobId ===
        currentProjection.job.jobId,
    )
    .sort(
      (left, right) =>
        left.record.attempt - right.record.attempt ||
        left.record.invocationId.localeCompare(right.record.invocationId),
    );
  if (
    entries.filter(({ record }) => record.invocationId === current.invocationId)
      .length !== 1
  ) {
    throw workflowError(
      'PROVIDER_EXECUTION_PROJECTION_MISSING',
      'The current provider invocation is absent from execution projection.',
      ExitCode.staleState,
    );
  }
  return entries;
}

function providerExecutionHistory(
  paths: InvestigationRuntimePaths,
  investigationId: string,
  purpose: ProviderInvocationRecord['purpose'],
  beforeAttempt: number,
  currentRequest: ProviderInvocationRequest,
): LegacyProviderExecutionEntry[] {
  const scan = scanProviderInvocationLifecycles(paths);
  const currentUnsafe = scan.unsafeInvocations.filter(
    ({ invocationId }) => invocationId === currentRequest.invocationId,
  );
  if (
    scan.unsafeInvocations.length !== currentUnsafe.length ||
    currentUnsafe.length > 1
  ) {
    // Preserve the scanner's canonical fail-closed error for unrelated unsafe
    // invocation state.
    listProviderInvocationLifecycleProjections(paths);
    throw invocationUnsafe();
  }
  if (currentUnsafe.length === 1) {
    const pendingDirectory = providerInvocationDirectory(
      paths,
      currentRequest.invocationId,
    );
    if (
      canonicalJson(fs.readdirSync(pendingDirectory).sort()) !==
      canonicalJson(['execution-policy.json'])
    ) {
      throw invocationUnsafe();
    }
    readProviderExecutionPolicySnapshot(paths, currentRequest);
  }
  return scan.projections
    .filter(
      (entry) =>
        entry.investigationId === investigationId &&
        entry.purpose === purpose &&
        entry.attempt < beforeAttempt,
    )
    .map((entry) => {
      const record = readProviderInvocation(paths, entry.invocationId);
      const request = readProviderInvocationRequest(paths, entry.invocationId);
      return providerExecutionEntry(paths, record, request);
    })
    .sort(
      (left, right) =>
        left.record.attempt - right.record.attempt ||
        left.record.invocationId.localeCompare(right.record.invocationId),
    );
}

export function failProviderInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    leaseGeneration: number;
    leaseToken: string;
    failure: ProviderInvocationFailure;
    runtimeEvidence?: Readonly<{
      acceptanceBinding: ProviderInvocationAcceptanceBinding;
      progress: AgentRuntimeProcessProgressProjection;
      protocolReceipt?: ProviderWrapperProtocolReceipt;
    }>;
    repair?: ProviderRepairFailureInput;
    now?: string;
  },
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const now = parseNow(input.now);
  const failure = assertProviderFailure(input.failure);
  return withProviderWorkerLifecycle(paths, () =>
    updateProviderInvocation(
      paths,
      invocationId,
      input.expectedRevision,
      (current) => {
        assertCurrentLease(
          current,
          input.leaseGeneration,
          input.leaseToken,
          now,
        );
        if (input.repair !== undefined) {
          persistProviderRepairEvidence(paths, {
            record: current,
            request: readProviderInvocationRequest(paths, invocationId),
            failure,
            repair: input.repair,
            recordedAt: new Date(now).toISOString(),
          });
        }
        const runtimeReceipt =
          input.runtimeEvidence === undefined
            ? undefined
            : createAgentRuntimeCompletionReceipt({
                current,
                request: readProviderInvocationRequest(paths, invocationId),
                acceptanceBinding: input.runtimeEvidence.acceptanceBinding,
                terminalState: 'failed',
                progress: input.runtimeEvidence.progress,
                ...(input.runtimeEvidence.protocolReceipt === undefined
                  ? {}
                  : {
                      protocolReceipt: input.runtimeEvidence.protocolReceipt,
                    }),
              });
        return {
          ...current,
          revision: current.revision + 1,
          state: 'failed',
          lease: null,
          result: null,
          failure,
          ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
          updatedAt: new Date(now).toISOString(),
        };
      },
    ),
  );
}

function createAgentRuntimeCompletionReceipt(input: {
  current: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  acceptanceBinding: ProviderInvocationAcceptanceBinding;
  terminalState: 'succeeded' | 'failed';
  progress: AgentRuntimeProcessProgressProjection;
  protocolReceipt?: ProviderWrapperProtocolReceipt;
}): AgentRuntimeCompletionReceipt {
  assertProviderAcceptanceBinding(input.acceptanceBinding);
  if (
    input.current.state !== 'leased' ||
    input.current.lease === null ||
    input.acceptanceBinding.invocationId !== input.current.invocationId ||
    input.acceptanceBinding.requestDigest !== input.request.requestDigest ||
    input.acceptanceBinding.requestDigest !== input.current.requestDigest ||
    input.acceptanceBinding.legacyRevision !== input.current.revision ||
    input.acceptanceBinding.leaseGeneration !== input.current.leaseGeneration
  ) {
    throw providerAcceptanceBindingStale();
  }
  const progress = assertAgentRuntimeProcessProgress(input.progress);
  const fields = {
    kind: 'agent-runtime-completion-receipt' as const,
    invocationId: input.current.invocationId,
    requestDigest: input.request.requestDigest,
    leasedRevision: input.current.revision,
    terminalRevision: input.current.revision + 1,
    leaseGeneration: input.current.leaseGeneration,
    executionJobId: input.acceptanceBinding.executionJobId,
    executionAttemptId: input.acceptanceBinding.executionAttemptId,
    executionRevision: input.acceptanceBinding.executionRevision,
    executionStateDigest: input.acceptanceBinding.executionStateDigest,
    acceptanceBindingDigest: input.acceptanceBinding.bindingDigest,
    terminalState: input.terminalState,
    launched: true as const,
    progress,
  };
  const protocolReceipt =
    input.protocolReceipt === undefined
      ? undefined
      : input.terminalState === 'succeeded'
        ? assertSuccessfulRunnerProtocolReceipt(
            input.protocolReceipt,
            input.request,
            input.acceptanceBinding,
          )
        : assertFailedRunnerProtocolReceipt(
            input.protocolReceipt,
            input.request,
            input.acceptanceBinding,
          );
  const payload =
    protocolReceipt === undefined
      ? { schemaVersion: 1 as const, ...fields }
      : input.terminalState === 'succeeded'
        ? {
            schemaVersion: 2 as const,
            ...fields,
            terminalState: 'succeeded' as const,
            protocolReceipt,
          }
        : {
            schemaVersion: 3 as const,
            ...fields,
            terminalState: 'failed' as const,
            protocolReceipt,
          };
  return assertAgentRuntimeCompletionReceipt({
    ...payload,
    receiptDigest: sha256(canonicalJson(payload)),
  });
}

function assertSuccessfulRunnerProtocolReceipt(
  value: ProviderWrapperProtocolReceipt | undefined,
  request: ProviderInvocationRequest,
  acceptanceBinding: ProviderInvocationAcceptanceBinding,
): ProviderWrapperProtocolReceipt | undefined {
  if (value === undefined) return undefined;
  let receipt: ProviderWrapperProtocolReceipt;
  try {
    receipt = assertProviderWrapperProtocolReceipt(value, {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      attemptId: acceptanceBinding.executionAttemptId,
    });
  } catch {
    throw invocationInvalid();
  }
  if (
    receipt.terminal !== 'result' ||
    receipt.outputSlot !== 'primary' ||
    receipt.errorCode !== null ||
    receipt.cancellation.requested ||
    receipt.cancellation.acknowledged ||
    receipt.cancellation.forced
  ) {
    throw invocationInvalid();
  }
  return receipt;
}

function assertFailedRunnerProtocolReceipt(
  value: ProviderWrapperProtocolReceipt | undefined,
  request: ProviderInvocationRequest,
  acceptanceBinding: ProviderInvocationAcceptanceBinding,
): ProviderWrapperProtocolReceipt | undefined {
  if (value === undefined) return undefined;
  let receipt: ProviderWrapperProtocolReceipt;
  try {
    receipt = assertProviderWrapperProtocolReceipt(value, {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      attemptId: acceptanceBinding.executionAttemptId,
    });
  } catch {
    throw invocationInvalid();
  }
  if (
    (receipt.terminal === 'error' &&
      (receipt.outputSlot !== null ||
        receipt.errorCode === null ||
        receipt.cancellation.requested ||
        receipt.cancellation.acknowledged ||
        receipt.cancellation.forced)) ||
    (receipt.terminal === 'cancelled' &&
      (receipt.outputSlot !== null ||
        receipt.errorCode !== null ||
        !receipt.cancellation.requested)) ||
    receipt.terminal === 'result'
  ) {
    throw invocationInvalid();
  }
  return receipt;
}

function withProviderWorkerLifecycle<T>(
  paths: InvestigationRuntimePaths,
  operation: (assertOwned: () => void) => T,
): T {
  const runtimeRoot = path.dirname(paths.root);
  return withRepositoryLifecycleOperation(
    runtimePaths(path.dirname(runtimeRoot), path.basename(runtimeRoot)),
    operation,
  );
}

function updateProviderInvocation(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  expectedRevision: number | undefined,
  transition: (current: ProviderInvocationRecord) => ProviderInvocationRecord,
): ProviderInvocationRecord {
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${invocationId}.lock`),
    () => {
      const current = readProviderInvocation(paths, invocationId);
      if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
      ) {
        throw providerCasMismatch(expectedRevision, current.revision);
      }
      // Re-admit the current durable Job/Attempt lineage before mutating the
      // legacy state file. A missing/tampered repair sidecar must fail closed
      // without leaving a lease or other partially applied lifecycle change.
      const request = readProviderInvocationRequest(paths, invocationId);
      const executionEntries = materializeProviderExecutionState(
        paths,
        current,
        request,
      );
      const next = assertProviderInvocationRecord(transition(current));
      assertMonotonicInvocationTransition(current, next);
      writePrivateCanonicalJsonAtomic(
        paths,
        providerInvocationStatePath(paths, invocationId),
        next,
        invocationUnsafe,
      );
      const updated = readProviderInvocation(paths, invocationId);
      materializeLegacyProviderExecutionJob(
        paths,
        executionEntries.map((entry) =>
          entry.record.invocationId === invocationId
            ? { ...entry, record: updated, request }
            : entry,
        ),
      );
      return updated;
    },
    'PROVIDER_INVOCATION_OPERATION_CONFLICT',
    invocationLockInvalid,
  );
}

function providerExecutionEntry(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): LegacyProviderExecutionEntry {
  // A record written before execution policy snapshots existed reserved no
  // attempt budget, which is exactly what a null accounting already means to
  // the retry ladder in execution-store. Reading a snapshot that was never
  // written would fail the whole history instead.
  const snapshotRecorded = privatePathExists(
    paths,
    providerExecutionPolicySnapshotPath(paths, request.invocationId),
    providerExecutionPolicySnapshotUnsafe,
  );
  const retryReservation =
    record.attempt < 2
      ? null
      : readProviderRetryReservation(
          paths,
          record.investigationId,
          record.attempt,
        );
  if (
    retryReservation !== null &&
    (retryReservation.invocationId !== record.invocationId ||
      retryReservation.requestDigest !== request.requestDigest ||
      retryReservation.manifestDigest !== record.manifestDigest)
  ) {
    throw invocationUnsafe();
  }
  return {
    record,
    request,
    retryAccounting: snapshotRecorded
      ? readProviderExecutionPolicySnapshot(paths, request).accounting
      : null,
    retryReplacement:
      retryReservation?.schemaVersion === 3
        ? retryReservation.replacement
        : null,
  };
}

function assertBlindSurveyManifest(value: unknown): BlindSurveyManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'normalizedIntent',
      'architectureQuestion',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'blind-survey-manifest' ||
    typeof value.changeId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    !isBoundedBlindText(
      value.architectureQuestion,
      MAX_ARCHITECTURE_QUESTION_BYTES,
    ) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw blindManifestInvalid();
  }
  assertChangeId(value.changeId);
  assertNormalizedChangeIntent(value.normalizedIntent);
  if (
    Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_BLIND_MANIFEST_BYTES
  ) {
    throw blindManifestInvalid();
  }
  return deepFreeze(structuredClone(value)) as BlindSurveyManifest;
}

function assertProviderInvocationManifest(
  value: unknown,
): ProviderInvocationManifest {
  if (isRecord(value) && value.kind === 'blind-survey-manifest') {
    return assertBlindSurveyManifest(value);
  }
  if (
    isRecord(value) &&
    value.kind === 'task-diff-review-continuation-manifest'
  ) {
    return assertTaskDiffReviewContinuationManifest(value);
  }
  if (isRecord(value) && value.kind === 'task-diff-review-manifest') {
    return assertTaskDiffReviewManifest(value);
  }
  if (
    isRecord(value) &&
    value.kind === 'task-strategy-implementation-manifest'
  ) {
    try {
      return assertTaskStrategyImplementationManifest(value);
    } catch {
      throw invocationInvalid();
    }
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'subject',
      ...(Object.hasOwn(value, 'planningTarget')
        ? ['planningTarget' as const]
        : []),
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-manifest' ||
    typeof value.changeId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw invocationInvalid();
  }
  assertChangeId(value.changeId);
  let subject: PlanReviewSubject;
  let planningTarget: PlanReviewTargetSnapshot | undefined;
  try {
    subject = assertPlanReviewSubject(value.subject);
    planningTarget =
      value.planningTarget === undefined
        ? undefined
        : assertPlanReviewTargetSnapshot(value.planningTarget);
  } catch {
    throw invocationInvalid();
  }
  if (
    planningTarget !== undefined &&
    (planningTarget.changeId !== value.changeId ||
      planningTarget.subjectDigest !== subject.subjectDigest ||
      planningTarget.planningGenerationId !== subject.planningGenerationId ||
      planningTarget.planTargetDigest !== subject.planTargetDigest)
  ) {
    throw invocationInvalid();
  }
  const manifest: PlanReviewManifest = {
    schemaVersion: 1,
    kind: 'plan-review-manifest',
    changeId: value.changeId,
    repositoryId: value.repositoryId,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    subject,
    ...(planningTarget ? { planningTarget } : {}),
    capabilityProfile: 'repository-read-only',
  };
  if (
    Buffer.byteLength(canonicalJson(manifest), 'utf8') >
    MAX_BLIND_MANIFEST_BYTES
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(manifest);
}

function assertTaskDiffReviewManifest(value: unknown): TaskDiffReviewManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'reviewScope',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-manifest' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    !isBoundedBlindText(value.repositoryIdentity, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw invocationInvalid();
  }
  try {
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
    assertSessionId(value.sessionId);
  } catch {
    throw invocationInvalid();
  }
  let subject: TaskDiffReviewSubject;
  let reviewScope: TaskDiffReviewScope;
  try {
    subject = parseTaskDiffReviewSubject(value.subject);
    reviewScope = parseTaskDiffReviewScope(value.reviewScope);
  } catch {
    throw invocationInvalid();
  }
  if (
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    subject.repositoryId !== value.repositoryIdentity ||
    subject.baseCommit !== value.baseCommit ||
    subject.baseTree !== value.baseTree ||
    reviewScope.currentSubjectDigest !== subject.subjectDigest
  ) {
    throw invocationInvalid();
  }
  const manifest: TaskDiffReviewManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    subject,
    reviewScope,
    capabilityProfile: 'repository-read-only',
  };
  if (
    Buffer.byteLength(canonicalJson(manifest), 'utf8') >
    MAX_BLIND_MANIFEST_BYTES
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(manifest);
}

function assertTaskDiffReviewContinuationManifest(
  value: unknown,
): TaskDiffReviewContinuationManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'review',
      'response',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-manifest' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    !isBoundedBlindText(value.repositoryIdentity, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw invocationInvalid();
  }
  try {
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
    assertSessionId(value.sessionId);
  } catch {
    throw invocationInvalid();
  }
  let subject: TaskDiffReviewSubject;
  let review: TaskDiffReviewRecord;
  let response: TaskDiffReviewChallengeResponseRecord;
  try {
    subject = parseTaskDiffReviewSubject(value.subject);
    review = parseTaskDiffReviewRecord(value.review);
    response = assertTaskDiffReviewChallengeResponseCurrent(
      review,
      parseTaskDiffReviewChallengeResponseRecord(value.response),
    );
  } catch {
    throw invocationInvalid();
  }
  if (
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    subject.repositoryId !== value.repositoryIdentity ||
    subject.baseCommit !== value.baseCommit ||
    subject.baseTree !== value.baseTree ||
    review.subjectDigest !== subject.subjectDigest ||
    canonicalJson(review.subject) !== canonicalJson(subject)
  ) {
    throw invocationInvalid();
  }
  const manifest: TaskDiffReviewContinuationManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    subject,
    review,
    response,
    capabilityProfile: 'repository-read-only',
  };
  if (
    Buffer.byteLength(canonicalJson(manifest), 'utf8') >
    MAX_BLIND_MANIFEST_BYTES
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(manifest);
}

function assertNormalizedChangeIntent(value: unknown): NormalizedChangeIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'summary',
      'explicitPaths',
      'explicitSymbols',
      'explicitConfigKeys',
      'renamePairs',
    ]) ||
    value.schemaVersion !== 1 ||
    !isBoundedBlindText(value.summary, MAX_INTENT_SUMMARY_BYTES) ||
    !isUniqueBoundedBlindStringArray(value.explicitPaths) ||
    !isUniqueBoundedBlindStringArray(value.explicitSymbols) ||
    !isUniqueBoundedBlindStringArray(value.explicitConfigKeys) ||
    !Array.isArray(value.renamePairs) ||
    value.renamePairs.length > MAX_INTENT_FACTS_PER_KIND
  ) {
    throw blindManifestInvalid();
  }
  const seenPairs = new Set<string>();
  for (const pair of value.renamePairs) {
    if (
      !isRecord(pair) ||
      !hasExactKeys(pair, ['from', 'to']) ||
      !isBoundedBlindFact(pair.from) ||
      !isBoundedBlindFact(pair.to) ||
      pair.from === pair.to
    ) {
      throw blindManifestInvalid();
    }
    const key = canonicalJson(pair);
    if (seenPairs.has(key)) {
      throw blindManifestInvalid();
    }
    seenPairs.add(key);
  }
  return deepFreeze(structuredClone(value)) as NormalizedChangeIntent;
}

function isUniqueBoundedBlindStringArray(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_INTENT_FACTS_PER_KIND ||
    !value.every(isBoundedBlindFact)
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function isBoundedBlindFact(value: unknown): value is string {
  return (
    isBoundedBlindText(value, MAX_INTENT_FACT_BYTES) &&
    !containsDisallowedControl(value)
  );
}

function isBoundedBlindText(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !value.includes('\u0000')
  );
}

function containsDisallowedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      return true;
    }
  }
  return false;
}

function assertInvestigationStartReservation(
  value: unknown,
): InvestigationStartReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'investigationId',
      'invocationId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'manifestDigest',
      'requestDigest',
      'manifest',
      'request',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-start-reservation' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    typeof value.investigationId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    typeof value.gitCommonDirectory !== 'string' ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    (value.branch !== null &&
      (typeof value.branch !== 'string' || value.branch.length === 0)) ||
    !isBaseline(value.baseline) ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw invocationInvalid();
  }
  const changeId = assertChangeId(value.changeId);
  const investigationId = assertInvestigationId(value.investigationId);
  const invocationId = assertInvocationId(value.invocationId);
  const manifest = assertBlindSurveyManifest(value.manifest);
  const request = assertProviderRequest(value.request);
  const manifestDigest = blindSurveyManifestDigest(manifest);
  assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
  if (
    invocationId !== request.invocationId ||
    value.manifestDigest !== manifestDigest ||
    value.requestDigest !== request.requestDigest ||
    value.baseline.head !== manifest.baseCommit ||
    value.baseline.tree !== manifest.baseTree
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone({
      ...value,
      changeId,
      investigationId,
      invocationId,
      manifest,
      request,
    }),
  ) as InvestigationStartReservation;
}

function assertProviderRetryReservation(
  value: unknown,
): ProviderRetryReservation {
  const baseKeys = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'attempt',
    'previousInvocationId',
    'invocationId',
    'manifestDigest',
    'requestDigest',
    'request',
    'createdAt',
  ];
  if (
    !isRecord(value) ||
    (value.schemaVersion === 1
      ? !hasExactKeys(value, baseKeys)
      : value.schemaVersion !== 2 && value.schemaVersion !== 3
        ? true
        : !hasExactKeys(value, [
            ...baseKeys,
            'executionPolicySnapshot',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
              ? ['mandateBinding']
              : []),
            'retryDecision',
            ...(value.schemaVersion === 3 ? ['replacement'] : []),
          ])) ||
    value.kind !== 'provider-retry-reservation' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 2 ||
    typeof value.previousInvocationId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw invocationInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  assertInvocationId(value.previousInvocationId);
  const invocationId = assertInvocationId(value.invocationId);
  const request = assertProviderRequest(value.request);
  const retryDecision =
    value.schemaVersion === 2 || value.schemaVersion === 3
      ? assertProviderRetryDecisionBinding(value.retryDecision)
      : undefined;
  const executionPolicySnapshot =
    value.schemaVersion === 2 || value.schemaVersion === 3
      ? assertEmbeddedProviderExecutionPolicySnapshot(
          value.executionPolicySnapshot,
          request,
        )
      : undefined;
  const replacement =
    value.schemaVersion === 3
      ? assertProviderRetryReplacementBinding(value.replacement)
      : undefined;
  if (
    invocationId !== request.invocationId ||
    value.requestDigest !== request.requestDigest ||
    value.previousInvocationId === invocationId ||
    (replacement !== undefined &&
      (replacement.attemptId !== `attempt-legacy-${invocationId}` ||
        request.authorizationNodeId !== replacement.authorizationNodeId))
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone({
      ...value,
      invocationId,
      request,
      ...(retryDecision === undefined ? {} : { retryDecision }),
      ...(executionPolicySnapshot === undefined
        ? {}
        : { executionPolicySnapshot }),
      ...(replacement === undefined ? {} : { replacement }),
    }),
  ) as ProviderRetryReservation;
}

function assertEmbeddedProviderExecutionPolicySnapshot(
  value: unknown,
  request: ProviderInvocationRequest,
): ProviderExecutionPolicySnapshotCurrent {
  try {
    return validateProviderExecutionPolicySnapshot(request, value);
  } catch {
    throw invocationInvalid();
  }
}

function assertProviderRetryDecisionBinding(
  value: unknown,
): ProviderRetryDecisionBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'evaluatedAt',
      'evidenceDigest',
      'executionJobId',
      'executionRevision',
      'failedAttemptId',
      'kind',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-decision-binding' ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    typeof value.failedAttemptId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.failedAttemptId) ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    !isTimestamp(value.evaluatedAt)
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(value) as ProviderRetryDecisionBinding);
}

function assertProviderRetryReplacementBinding(
  value: unknown,
): ProviderRetryReplacementBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attemptId',
      'retryMode',
      'strategyChanges',
      'environmentDigest',
      'executionGrantId',
      'authorizationNodeId',
      'reservationNodeId',
    ]) ||
    typeof value.attemptId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.attemptId) ||
    ![
      'same-input',
      'execution-policy-change',
      'repair',
      'strategy-change',
    ].includes(value.retryMode as string) ||
    !Array.isArray(value.strategyChanges) ||
    value.strategyChanges.length > 32 ||
    value.strategyChanges.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length < 1 ||
        Buffer.byteLength(entry, 'utf8') > 512,
    ) ||
    new Set(value.strategyChanges).size !== value.strategyChanges.length ||
    typeof value.environmentDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.environmentDigest) ||
    (value.executionGrantId !== null &&
      (typeof value.executionGrantId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(
          value.executionGrantId,
        ))) ||
    typeof value.authorizationNodeId !== 'string' ||
    !DIGEST.test(value.authorizationNodeId) ||
    typeof value.reservationNodeId !== 'string' ||
    !DIGEST.test(value.reservationNodeId) ||
    (value.retryMode === 'strategy-change') !== value.strategyChanges.length > 0
  ) {
    throw invocationInvalid();
  }
  return deepFreeze({
    attemptId: value.attemptId,
    retryMode: value.retryMode as ProviderRetryReplacementBinding['retryMode'],
    strategyChanges: [...value.strategyChanges] as string[],
    environmentDigest: value.environmentDigest,
    executionGrantId: value.executionGrantId as string | null,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
  });
}

function assertProviderRequest(value: unknown): ProviderInvocationRequest {
  if (!isRecord(value)) {
    throw invocationInvalid();
  }
  try {
    const reconstructed = createProviderInvocationRequest({
      invocationId: value.invocationId as string,
      nonce: value.nonce as string,
      purpose: value.purpose as CapabilityPurpose,
      providerId: value.providerId as ProviderId,
      roleAssignment: value.roleAssignment as never,
      capabilityProfile: value.capabilityProfile as 'repository-read-only',
      repositoryId: value.repositoryId as string,
      baseCommit: value.baseCommit as string,
      baseTree: value.baseTree as string,
      targetDigest: value.targetDigest as string,
      inputManifestDigest: value.inputManifestDigest as string,
      authorizationNodeId: value.authorizationNodeId as string,
      writeAllowedPaths: value.writeAllowedPaths as string[],
      outputSchema: value.outputSchema as never,
      evaluatorVersion: value.evaluatorVersion as string,
      policyDigest: value.policyDigest as string,
      limits: value.limits as never,
    });
    if (canonicalJson(reconstructed) !== canonicalJson(value)) {
      throw invocationInvalid();
    }
    assertInvocationId(reconstructed.invocationId);
    return reconstructed;
  } catch {
    throw invocationInvalid();
  }
}

function assertBlindInvocationBinding(
  changeId: string,
  manifest: BlindSurveyManifest,
  manifestDigest: string,
  request: ProviderInvocationRequest,
): void {
  if (
    manifest.changeId !== changeId ||
    manifest.repositoryId !== request.repositoryId ||
    manifest.baseCommit !== request.baseCommit ||
    manifest.baseTree !== request.baseTree ||
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'blind-surveyor' ||
    request.capabilityProfile !== 'repository-read-only' ||
    request.targetDigest !== blindSurveyIntentDigest(manifest) ||
    request.inputManifestDigest !== manifestDigest ||
    request.roleAssignment.targetDigest !== request.targetDigest
  ) {
    throw invocationInvalid();
  }
}

function assertProviderInvocationBinding(
  changeId: string,
  manifest: ProviderInvocationManifest,
  manifestDigest: string,
  request: ProviderInvocationRequest,
): void {
  if (manifest.kind === 'blind-survey-manifest') {
    assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
    return;
  }
  if (manifest.kind === 'task-diff-review-manifest') {
    if (
      manifest.changeId !== changeId ||
      manifest.repositoryId !== request.repositoryId ||
      manifest.baseCommit !== request.baseCommit ||
      manifest.baseTree !== request.baseTree ||
      request.purpose !== 'task-diff-review' ||
      request.roleAssignment.role !== 'task-diff-reviewer' ||
      request.capabilityProfile !== 'repository-read-only' ||
      request.targetDigest !== manifest.subject.subjectDigest ||
      request.inputManifestDigest !== manifestDigest ||
      request.roleAssignment.targetDigest !== request.targetDigest
    ) {
      throw invocationInvalid();
    }
    return;
  }
  if (manifest.kind === 'task-diff-review-continuation-manifest') {
    if (
      manifest.changeId !== changeId ||
      manifest.repositoryId !== request.repositoryId ||
      manifest.baseCommit !== request.baseCommit ||
      manifest.baseTree !== request.baseTree ||
      request.purpose !== 'task-diff-review' ||
      request.roleAssignment.role !== 'task-diff-reviewer' ||
      request.capabilityProfile !== 'repository-read-only' ||
      request.targetDigest !== manifest.subject.subjectDigest ||
      request.inputManifestDigest !== manifestDigest ||
      request.roleAssignment.targetDigest !== request.targetDigest ||
      request.providerId !== manifest.review.assignment.reviewerProviderId ||
      request.roleAssignment.providerId !==
        manifest.review.assignment.reviewerProviderId ||
      request.roleAssignment.sessionId ===
        manifest.review.assignment.reviewerSessionId ||
      request.outputSchema.id !==
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id ||
      request.outputSchema.version !==
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version ||
      request.outputSchema.digest !==
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest
    ) {
      throw invocationInvalid();
    }
    return;
  }
  if (manifest.kind === 'task-strategy-implementation-manifest') {
    if (
      manifest.subject.changeId !== changeId ||
      manifest.repositoryId !== request.repositoryId ||
      manifest.baseCommit !== request.baseCommit ||
      manifest.baseTree !== request.baseTree ||
      request.purpose !== 'task-implementation' ||
      request.roleAssignment.role !== 'task-implementer' ||
      request.capabilityProfile !== 'repository-read-only' ||
      request.targetDigest !== manifest.subject.subjectDigest ||
      request.inputManifestDigest !== manifestDigest ||
      request.roleAssignment.targetDigest !== request.targetDigest ||
      request.outputSchema.id !==
        TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.id ||
      request.outputSchema.version !==
        TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.version ||
      request.outputSchema.digest !==
        TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.digest
    ) {
      throw invocationInvalid();
    }
    return;
  }
  if (
    manifest.changeId !== changeId ||
    manifest.repositoryId !== request.repositoryId ||
    manifest.baseCommit !== request.baseCommit ||
    manifest.baseTree !== request.baseTree ||
    request.purpose !== 'plan-review' ||
    request.roleAssignment.role !== 'plan-reviewer' ||
    request.capabilityProfile !== 'repository-read-only' ||
    request.targetDigest !== manifest.subject.subjectDigest ||
    request.inputManifestDigest !== manifestDigest ||
    request.roleAssignment.targetDigest !== request.targetDigest
  ) {
    throw invocationInvalid();
  }
}

function createPlanReviewSnapshotFiles(
  paths: InvestigationRuntimePaths,
  invocationDirectory: string,
  manifest: ProviderInvocationManifest,
  files: CreateProviderInvocationInput['planReviewSnapshotFiles'],
): void {
  if (manifest.kind !== 'plan-review-manifest') {
    if (files !== undefined) throw invocationInvalid();
    return;
  }
  if (manifest.planningTarget === undefined) {
    if (files !== undefined) throw invocationInvalid();
    return;
  }
  if (!Array.isArray(files)) throw invocationInvalid();
  const expected = manifest.planningTarget.artifacts;
  if (files.length !== expected.length) throw invocationInvalid();
  const byName = new Map(files.map((entry) => [entry.snapshotFile, entry]));
  if (byName.size !== files.length) throw invocationInvalid();
  const root = path.join(invocationDirectory, 'review-root');
  ensurePrivateInvestigationDirectory(paths, root, invocationUnsafe);
  for (const artifact of expected) {
    const supplied = byName.get(artifact.snapshotFile);
    if (
      !supplied ||
      !Buffer.isBuffer(supplied.content) ||
      supplied.content.byteLength !== artifact.byteLength ||
      sha256Buffer(supplied.content) !== artifact.sha256 ||
      planReviewSnapshotLineCount(supplied.content) !== artifact.lineCount
    ) {
      throw invocationInvalid();
    }
    createPrivateSnapshotFile(
      path.join(root, artifact.snapshotFile),
      supplied.content,
    );
  }
  assertPlanReviewSnapshotFiles(
    paths,
    path.basename(invocationDirectory),
    manifest,
    invocationDirectory,
  );
}

function assertPlanReviewSnapshotFiles(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  manifest: ProviderInvocationManifest,
  knownDirectory?: string,
  record?: ProviderInvocationRecord,
): void {
  if (
    manifest.kind !== 'plan-review-manifest' ||
    manifest.planningTarget === undefined
  ) {
    return;
  }
  const directory =
    knownDirectory ??
    providerInvocationDirectory(
      paths,
      assertInvocationId(requestedInvocationId),
    );
  const root = path.join(directory, 'review-root');
  assertPrivateInvestigationDirectory(paths, root, invocationUnsafe);
  const names = fs.readdirSync(root).sort();
  const expectedNames = manifest.planningTarget.artifacts
    .map(({ snapshotFile }) => snapshotFile)
    .sort();
  const retentionReceipt =
    record === undefined ||
    (record.state !== 'succeeded' && record.state !== 'failed')
      ? null
      : readCompleteProviderRetentionReceipt(paths, record.invocationId, {
          requestDigest: record.requestDigest,
          manifestDigest: record.manifestDigest,
          legacyRevision: record.revision,
          terminalState: record.state,
          terminalAt: record.updatedAt,
        });
  const retainedReviewRoot =
    retentionReceipt === null
      ? null
      : providerRetentionArtifact(retentionReceipt, 'review-root');
  const expectedRetainedReviewRoot = providerRetentionReviewRootArtifact(
    manifest.planningTarget.artifacts.map((artifact) => ({
      name: `review-root/${artifact.snapshotFile}`,
      digest: artifact.sha256,
      bytes: artifact.byteLength,
    })),
  );
  if (
    (retainedReviewRoot === null
      ? canonicalJson(names) !== canonicalJson(expectedNames)
      : names.some((name) => !expectedNames.includes(name))) ||
    (retainedReviewRoot !== null &&
      canonicalJson(retainedReviewRoot) !==
        canonicalJson(expectedRetainedReviewRoot))
  ) {
    throw invocationInvalid();
  }
  for (const artifact of manifest.planningTarget.artifacts) {
    if (!names.includes(artifact.snapshotFile)) {
      if (retainedReviewRoot === null) throw invocationInvalid();
      continue;
    }
    const content = readPrivateSnapshotFile(
      path.join(root, artifact.snapshotFile),
    );
    if (
      content.byteLength !== artifact.byteLength ||
      sha256Buffer(content) !== artifact.sha256 ||
      planReviewSnapshotLineCount(content) !== artifact.lineCount
    ) {
      throw invocationInvalid();
    }
  }
}

function createPrivateSnapshotFile(filePath: string, content: Buffer): void {
  const pendingPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.pending`,
  );
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    if (!readPrivateSnapshotFile(filePath).equals(content)) {
      throw invocationInvalid();
    }
    const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
    if (pending) {
      if (!readPrivateSnapshotFile(pendingPath).equals(content)) {
        throw invocationInvalid();
      }
      fs.unlinkSync(pendingPath);
      fsyncDirectory(path.dirname(filePath));
    }
    return;
  }
  const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
  if (pending) {
    if (!readPrivateSnapshotFile(pendingPath).equals(content)) {
      throw invocationInvalid();
    }
  } else {
    createPendingSnapshotFile(pendingPath, content);
  }
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
    throw invocationInvalid();
  }
  fs.renameSync(pendingPath, filePath);
  fsyncDirectory(path.dirname(filePath));
  if (!readPrivateSnapshotFile(filePath).equals(content)) {
    throw invocationInvalid();
  }
}

function createPendingSnapshotFile(filePath: string, content: Buffer): void {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, flags, 0o600);
  } catch {
    throw invocationInvalid();
  }
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw invocationInvalid();
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateSnapshotFile(filePath: string): Buffer {
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch {
    throw invocationInvalid();
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw invocationInvalid();
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateCanonicalDocument(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => ReturnType<typeof workflowError>,
): string {
  assertPrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw makeError();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
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

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertProviderInvocationRecord(
  value: unknown,
): ProviderInvocationRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'invocationId',
      'investigationId',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'attempt',
      'revision',
      'state',
      'providerId',
      'purpose',
      'requestDigest',
      'manifestDigest',
      'leaseGeneration',
      'lease',
      'result',
      'failure',
      ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
        ? ['runtimeReceipt']
        : []),
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.invocationId !== 'string' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(
      String(value.state),
    ) ||
    (value.providerId !== 'codex' && value.providerId !== 'claude') ||
    (value.purpose !== 'survey' &&
      value.purpose !== 'plan-review' &&
      value.purpose !== 'task-diff-review' &&
      value.purpose !== 'task-implementation') ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.manifestDigest) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 0 ||
    !isLease(value.lease) ||
    !isStoredResult(value.result) ||
    !isStoredFailure(value.failure) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw invocationInvalid();
  }
  assertInvocationId(value.invocationId);
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  const runtimeReceipt = Object.prototype.hasOwnProperty.call(
    value,
    'runtimeReceipt',
  )
    ? assertAgentRuntimeCompletionReceipt(value.runtimeReceipt)
    : undefined;
  if (
    (value.state === 'prepared' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'leased' &&
      (value.lease === null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'succeeded' &&
      (value.lease !== null ||
        value.result === null ||
        value.failure !== null)) ||
    (value.state === 'failed' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure === null)) ||
    (value.lease !== null &&
      value.lease.generation !== value.leaseGeneration) ||
    (runtimeReceipt !== undefined &&
      (value.state !== runtimeReceipt.terminalState ||
        value.invocationId !== runtimeReceipt.invocationId ||
        value.requestDigest !== runtimeReceipt.requestDigest ||
        value.revision !== runtimeReceipt.terminalRevision ||
        value.leaseGeneration !== runtimeReceipt.leaseGeneration))
  ) {
    throw invocationInvalid();
  }
  return (
    runtimeReceipt === undefined ? value : { ...value, runtimeReceipt }
  ) as ProviderInvocationRecord;
}

function assertAgentRuntimeCompletionReceipt(
  value: unknown,
): AgentRuntimeCompletionReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'leasedRevision',
      'terminalRevision',
      'leaseGeneration',
      'executionJobId',
      'executionAttemptId',
      'executionRevision',
      'executionStateDigest',
      'acceptanceBindingDigest',
      'terminalState',
      'launched',
      'progress',
      ...(value.schemaVersion === 2 || value.schemaVersion === 3
        ? ['protocolReceipt']
        : []),
      'receiptDigest',
    ]) ||
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3) ||
    value.kind !== 'agent-runtime-completion-receipt' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !Number.isSafeInteger(value.leasedRevision) ||
    (value.leasedRevision as number) < 0 ||
    !Number.isSafeInteger(value.terminalRevision) ||
    value.terminalRevision !== (value.leasedRevision as number) + 1 ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
    typeof value.executionAttemptId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.executionAttemptId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    !isDigest(value.executionStateDigest) ||
    !isDigest(value.acceptanceBindingDigest) ||
    (value.terminalState !== 'succeeded' && value.terminalState !== 'failed') ||
    value.launched !== true ||
    !isDigest(value.receiptDigest)
  ) {
    throw invocationInvalid();
  }
  assertInvocationId(value.invocationId);
  const progress = assertAgentRuntimeProcessProgress(value.progress);
  let protocolReceipt: ProviderWrapperProtocolReceipt | undefined;
  if (value.schemaVersion === 2 || value.schemaVersion === 3) {
    try {
      protocolReceipt = assertProviderWrapperProtocolReceipt(
        value.protocolReceipt,
        {
          invocationId: value.invocationId,
          requestDigest: value.requestDigest as string,
          attemptId: value.executionAttemptId as string,
        },
      );
    } catch {
      throw invocationInvalid();
    }
  }
  if (
    (value.terminalState === 'succeeded' &&
      progress.processState !== 'exited') ||
    (protocolReceipt !== undefined &&
      ((value.schemaVersion === 2 &&
        (value.terminalState !== 'succeeded' ||
          protocolReceipt.terminal !== 'result' ||
          protocolReceipt.outputSlot !== 'primary' ||
          protocolReceipt.errorCode !== null ||
          protocolReceipt.cancellation.requested ||
          protocolReceipt.cancellation.acknowledged ||
          protocolReceipt.cancellation.forced)) ||
        (value.schemaVersion === 3 &&
          (value.terminalState !== 'failed' ||
            protocolReceipt.terminal === 'result' ||
            (protocolReceipt.terminal === 'error' &&
              progress.processState !== 'exited') ||
            (protocolReceipt.terminal === 'cancelled' &&
              progress.processState !== 'cancelled'))) ||
        progress.lastProviderActivityElapsedMs === null ||
        progress.stdoutBytes < protocolReceipt.aggregateBytes)) ||
    sha256(
      canonicalJson(
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'receiptDigest'),
        ),
      ),
    ) !== value.receiptDigest
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone({
      ...value,
      progress,
      ...(protocolReceipt === undefined ? {} : { protocolReceipt }),
    }) as AgentRuntimeCompletionReceipt,
  );
}

function assertAgentRuntimeProcessProgress(
  value: unknown,
): AgentRuntimeProcessProgressProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'processState',
      'eventCount',
      'stdoutBytes',
      'stderrBytes',
      'lastProcessActivityElapsedMs',
      'lastProviderActivityElapsedMs',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-process-progress' ||
    ![
      'not-started',
      'running',
      'exited',
      'timed-out',
      'cancelled',
      'output-limit',
      'spawn-error',
      'protocol-error',
    ].includes(String(value.processState)) ||
    !Number.isSafeInteger(value.eventCount) ||
    (value.eventCount as number) < 0 ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    (value.stdoutBytes as number) < 0 ||
    !Number.isSafeInteger(value.stderrBytes) ||
    (value.stderrBytes as number) < 0 ||
    !isNullableNonnegativeInteger(value.lastProcessActivityElapsedMs) ||
    !isNullableNonnegativeInteger(value.lastProviderActivityElapsedMs) ||
    ((value.eventCount as number) === 0) !==
      (value.lastProcessActivityElapsedMs === null) ||
    (value.lastProviderActivityElapsedMs !== null &&
      (value.lastProcessActivityElapsedMs === null ||
        (value.lastProviderActivityElapsedMs as number) >
          (value.lastProcessActivityElapsedMs as number)))
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone(value) as AgentRuntimeProcessProgressProjection,
  );
}

function isNullableNonnegativeInteger(value: unknown): boolean {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function assertMonotonicInvocationTransition(
  current: ProviderInvocationRecord,
  next: ProviderInvocationRecord,
): void {
  for (const key of [
    'schemaVersion',
    'invocationId',
    'investigationId',
    'changeId',
    'attempt',
    'providerId',
    'purpose',
    'requestDigest',
    'manifestDigest',
    'createdAt',
  ] as const) {
    if (canonicalJson(current[key]) !== canonicalJson(next[key])) {
      throw invocationTransitionInvalid();
    }
  }
  if (
    canonicalJson(current.mandateBinding ?? null) !==
      canonicalJson(next.mandateBinding ?? null) ||
    next.revision !== current.revision + 1 ||
    next.leaseGeneration < current.leaseGeneration ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    current.state === 'succeeded' ||
    current.state === 'failed'
  ) {
    throw invocationTransitionInvalid();
  }
}

function assertCurrentLease(
  current: ProviderInvocationRecord,
  leaseGeneration: number,
  leaseToken: string,
  now: number,
): void {
  if (
    current.state !== 'leased' ||
    current.lease === null ||
    !Number.isSafeInteger(leaseGeneration) ||
    current.leaseGeneration !== leaseGeneration ||
    current.lease.generation !== leaseGeneration ||
    typeof leaseToken !== 'string' ||
    !DIGEST.test(leaseToken) ||
    current.lease.tokenDigest !== sha256(leaseToken) ||
    now >= Date.parse(current.lease.expiresAt)
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_LEASE_STALE',
      'Provider invocation lease is missing, expired, or fenced.',
      ExitCode.staleState,
    );
  }
}

export type ProviderOutputSchemaGeneration = 'code-owned' | 'legacy-superseded';

function providerOutputSchemaUnsupported() {
  return workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned output schema.',
    ExitCode.verification,
  );
}

function codeOwnedProviderOutputSchema(request: ProviderInvocationRequest) {
  if (request.purpose === 'survey') {
    return BLIND_SURVEY_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'plan-review') {
    return PLAN_REVIEW_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'task-diff-review') {
    if (
      request.outputSchema.id === TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id
    ) {
      return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA;
    }
    return TASK_DIFF_REVIEW_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'task-implementation') {
    return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA;
  }
  throw providerOutputSchemaUnsupported();
}

/**
 * Classify which generation of a code-owned output schema a request binds.
 *
 * The current writer always binds one constant this module owns for the
 * request's purpose and semantic phase, so a request carrying that constant's
 * exact id and version with a different digest is a shape the writer cannot
 * produce: the schema body was edited after the record was written. That is
 * the record's own age, and it is reported rather than refused. An unrecognized
 * id or version is not evidence of age — no writer of this engine ever emitted
 * one — so it stays unsupported.
 */
export function providerOutputSchemaGeneration(
  request: ProviderInvocationRequest,
): ProviderOutputSchemaGeneration {
  const codeOwned = codeOwnedProviderOutputSchema(request);
  if (
    request.outputSchema.id !== codeOwned.id ||
    request.outputSchema.version !== codeOwned.version
  ) {
    throw providerOutputSchemaUnsupported();
  }
  return request.outputSchema.digest === codeOwned.digest
    ? 'code-owned'
    : 'legacy-superseded';
}

export function blindSurveyOutputValidator(request: ProviderInvocationRequest) {
  if (
    request.purpose !== 'survey' ||
    providerOutputSchemaGeneration(request) !== 'code-owned'
  ) {
    throw providerOutputSchemaUnsupported();
  }
  return {
    ...BLIND_SURVEY_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['reference', 'terms']) ||
        value.reference !== request.invocationId ||
        !Array.isArray(value.terms) ||
        value.terms.length < 1 ||
        value.terms.length > INVESTIGATION_LIMITS.maxSurveyTerms
      ) {
        return false;
      }
      const termIds = new Set<string>();
      try {
        for (const term of value.terms) {
          if (
            !isRecord(term) ||
            !hasExactKeys(term, ['kind', 'value']) ||
            typeof term.kind !== 'string' ||
            typeof term.value !== 'string'
          ) {
            return false;
          }
          const normalized = normalizeInvestigationTerm({
            kind: term.kind as InvestigationTermKind,
            value: term.value,
          });
          if (termIds.has(normalized.termId)) {
            return false;
          }
          termIds.add(normalized.termId);
        }
      } catch {
        return false;
      }
      return true;
    },
  };
}

export type ProviderResidualsGeneration = Readonly<{
  generation: 'current' | 'legacy-subset';
  missing: readonly string[];
}>;

/**
 * Whether a residuals list shorter than the current runner's may be read.
 *
 * The default keeps every caller strict, so a short list only survives from a
 * call site that is reading state this engine already made durable.
 */
type ProviderResidualsAcceptance = 'current-only' | 'legacy-subset';

/**
 * Classify which generation of the runner's residuals list an observation
 * carries.
 *
 * Every list this engine ever wrote spread one frozen constant, so the current
 * writer cannot produce a list shorter than that constant: a shorter one is the
 * record's own age, from a day when the constant itself was shorter. Age is
 * reported rather than refused, and the codes the record does not carry are
 * named so nothing silently claims fewer soft-containment caveats than today's
 * runner would.
 *
 * The tolerance is exactly that shape and nothing else. Because the constant
 * holds no duplicates, matching it as an order-preserving subsequence rejects a
 * superset, an unknown code, a repeat, and a permutation alike -- none of which
 * is evidence of age, because no writer of this engine ever emitted one.
 */
function classifyProviderResiduals(
  value: unknown,
): ProviderResidualsGeneration {
  // Guarded here rather than only at the observation call site, because a value
  // that has a length and matches nothing -- an empty string, say -- would
  // otherwise read as the shortest legacy list instead of as the wrong type.
  if (!Array.isArray(value)) {
    throw resultInvalid();
  }
  const missing: string[] = [];
  let matched = 0;
  for (const code of PROVIDER_RUNNER_RESIDUALS) {
    if (matched < value.length && value[matched] === code) {
      matched += 1;
    } else {
      missing.push(code);
    }
  }
  if (matched !== value.length) {
    throw resultInvalid();
  }
  return deepFreeze({
    generation: missing.length === 0 ? 'current' : 'legacy-subset',
    missing,
  }) as ProviderResidualsGeneration;
}

/**
 * Report the residuals generation a durable record carries, or null when it
 * holds no runtime observation to carry one. Classified from the record rather
 * than from the request, because residuals are what the run observed and not
 * what it was asked to do.
 */
export function providerResidualsGeneration(
  record: ProviderInvocationRecord,
): ProviderResidualsGeneration | null {
  const residuals = record.result?.runtimeObservation?.residuals;
  return residuals === undefined ? null : classifyProviderResiduals(residuals);
}

function assertProviderResult(
  request: ProviderInvocationRequest,
  value: unknown,
  outputSchema: ProviderOutputSchemaGeneration = 'code-owned',
  residuals: ProviderResidualsAcceptance = 'current-only',
): ProviderProcessResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'requestDigest',
      'invocationId',
      'purpose',
      'providerId',
      'output',
      'outputDigest',
      'runtimeObservation',
    ]) ||
    value.requestDigest !== request.requestDigest ||
    value.invocationId !== request.invocationId ||
    value.purpose !== request.purpose ||
    value.providerId !== request.providerId ||
    !isDigest(value.outputDigest)
  ) {
    throw resultInvalid();
  }
  const output = deepFreeze(structuredClone(value.output));
  // A durable result written against a superseded generation cannot be judged
  // by today's grammar: that grammar is gone from the code, so the choice is to
  // report the generation or to refuse a record this engine itself wrote. Only
  // the vanished check is skipped. The request bindings above, the output
  // digest below — which still fixes the exact output bytes under the schema id
  // and version the record stored — and the runtime observation all stay
  // strict. The default keeps every caller strict, so a generation only reaches
  // this from a call site that classified already-durable state.
  if (outputSchema === 'code-owned') {
    const validator = providerOutputValidator(request);
    let outputAccepted: boolean;
    try {
      outputAccepted = validator.validate(output) === true;
    } catch {
      throw resultInvalid();
    }
    if (!outputAccepted) {
      throw resultInvalid();
    }
  }
  const outputDigest = sha256(
    canonicalJson({
      id: request.outputSchema.id,
      version: request.outputSchema.version,
      output,
    }),
  );
  if (value.outputDigest !== outputDigest) {
    throw resultInvalid();
  }
  const runtimeObservation = assertRuntimeObservation(
    value.runtimeObservation,
    request,
    residuals,
  );
  return deepFreeze(
    structuredClone({ ...value, output, runtimeObservation }),
  ) as ProviderProcessResult;
}

function providerResultFromRunnerReport(
  request: ProviderInvocationRequest,
  report: ProviderRunnerReport,
): ProviderProcessResult {
  if (
    !isRecord(report) ||
    report.invocationId !== request.invocationId ||
    report.providerId !== request.providerId ||
    report.purpose !== request.purpose ||
    report.requestDigest !== request.requestDigest ||
    report.semanticOutputDigest !== sha256(canonicalJson(report.semanticOutput))
  ) {
    throw resultInvalid();
  }
  const validator = providerOutputValidator(request);
  let accepted: boolean;
  try {
    accepted = validator.validate(report.semanticOutput) === true;
  } catch {
    throw resultInvalid();
  }
  if (!accepted) {
    throw resultInvalid();
  }
  const output = deepFreeze(structuredClone(report.semanticOutput));
  const runtimeObservation = assertRuntimeObservation(
    {
      assurance: report.assurance,
      projection: report.projection,
      sameUserProcessConfined: report.sameUserProcessConfined,
      residuals: report.residuals,
      executable: report.executable,
      elapsedMs: report.elapsedMs,
    },
    request,
  );
  return deepFreeze({
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    purpose: request.purpose,
    providerId: request.providerId,
    output,
    outputDigest: sha256(
      canonicalJson({
        id: request.outputSchema.id,
        version: request.outputSchema.version,
        output,
      }),
    ),
    runtimeObservation,
  });
}

function providerOutputValidator(request: ProviderInvocationRequest) {
  if (providerOutputSchemaGeneration(request) !== 'code-owned') {
    throw providerOutputSchemaUnsupported();
  }
  if (request.purpose === 'survey') {
    return blindSurveyOutputValidator(request);
  }
  if (request.purpose === 'plan-review') {
    return PLAN_REVIEW_OUTPUT_VALIDATOR;
  }
  if (request.purpose === 'task-diff-review') {
    if (
      request.outputSchema.id ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id &&
      request.outputSchema.version ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version &&
      request.outputSchema.digest ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest
    ) {
      return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR;
    }
    return TASK_DIFF_REVIEW_OUTPUT_VALIDATOR;
  }
  if (request.purpose === 'task-implementation') {
    return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR;
  }
  throw providerOutputSchemaUnsupported();
}

function assertRuntimeObservation(
  value: unknown,
  request: ProviderInvocationRequest,
  residuals: ProviderResidualsAcceptance = 'current-only',
): ProviderRuntimeObservation | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'assurance',
      'projection',
      'sameUserProcessConfined',
      'residuals',
      'executable',
      'elapsedMs',
    ]) ||
    value.assurance !== 'unchanged-governed-projection' ||
    value.sameUserProcessConfined !== false ||
    !isRecord(value.projection) ||
    !hasExactKeys(value.projection, [
      'unchanged',
      'changedCategories',
      'beforeDigest',
      'afterDigest',
    ]) ||
    value.projection.unchanged !== true ||
    !Array.isArray(value.projection.changedCategories) ||
    value.projection.changedCategories.length !== 0 ||
    !isDigest(value.projection.beforeDigest) ||
    value.projection.beforeDigest !== value.projection.afterDigest ||
    !Array.isArray(value.residuals) ||
    !isExecutableIdentity(value.executable) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    (value.elapsedMs as number) < 0 ||
    (value.elapsedMs as number) > request.limits.timeoutMs
  ) {
    throw resultInvalid();
  }
  // A durable record written before a residual was named carries the list of
  // its own day. Reading it means classifying that list rather than demanding
  // today's, and classification still refuses every shape no writer of this
  // engine produced. A live report has no age to plead, so it must equal the
  // constant exactly.
  if (residuals === 'legacy-subset') {
    classifyProviderResiduals(value.residuals);
  } else if (
    canonicalJson(value.residuals) !== canonicalJson(PROVIDER_RUNNER_RESIDUALS)
  ) {
    throw resultInvalid();
  }
  return deepFreeze(structuredClone(value)) as ProviderRuntimeObservation;
}

function isExecutableIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'candidatePath',
      'realPath',
      'device',
      'inode',
      'mode',
      'uid',
      'gid',
      'size',
      'mtimeNs',
      'sha256',
    ]) &&
    typeof value.candidatePath === 'string' &&
    value.candidatePath.length > 0 &&
    typeof value.realPath === 'string' &&
    value.realPath.length > 0 &&
    typeof value.device === 'string' &&
    value.device.length > 0 &&
    typeof value.inode === 'string' &&
    value.inode.length > 0 &&
    Number.isSafeInteger(value.mode) &&
    Number.isSafeInteger(value.uid) &&
    Number.isSafeInteger(value.gid) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.mtimeNs === 'string' &&
    value.mtimeNs.length > 0 &&
    isDigest(value.sha256)
  );
}

function assertProviderFailure(value: unknown): ProviderInvocationFailure {
  const hasExecutionKind =
    isRecord(value) && Object.hasOwn(value, 'executionKind');
  const hasRetryAfter = isRecord(value) && Object.hasOwn(value, 'retryAfterMs');
  const hasProbe = isRecord(value) && Object.hasOwn(value, 'probe');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'code',
      'message',
      ...(hasExecutionKind ? ['executionKind'] : []),
      ...(hasRetryAfter ? ['retryAfterMs'] : []),
      ...(hasProbe ? ['probe'] : []),
    ]) ||
    (value.kind !== 'retryable' &&
      value.kind !== 'repository-reconciliation-required') ||
    typeof value.code !== 'string' ||
    value.code.length === 0 ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    (hasExecutionKind &&
      !PROVIDER_EXECUTION_FAILURE_KINDS.has(
        value.executionKind as ExecutionFailureKind,
      )) ||
    (hasRetryAfter &&
      (!Number.isSafeInteger(value.retryAfterMs) ||
        (value.retryAfterMs as number) < 0 ||
        (value.retryAfterMs as number) > 86_400_000)) ||
    (hasProbe && !isReadOnlyProbe(value.probe)) ||
    hasProbe !== (value.executionKind === 'probe-transient') ||
    Buffer.byteLength(canonicalJson(value), 'utf8') > 16_384
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(value)) as ProviderInvocationFailure;
}

function isReadOnlyProbe(value: unknown): boolean {
  try {
    assertReadOnlyProbe(value);
    return true;
  } catch {
    return false;
  }
}

const PROVIDER_EXECUTION_FAILURE_KINDS = new Set<ExecutionFailureKind>([
  'provider-timeout',
  'network',
  'rate-limit',
  'provider-process-crash',
  'worker-crash',
  'lease-expiry',
  'temporary-file-lock',
  'provider-capacity',
  'stdout-truncated',
  'process-nonzero',
  'json-parse',
  'schema-mismatch',
  'missing-required-field',
  'citation-out-of-range',
  'probe-transient',
  'needs-user-decision',
  'state-corruption',
  'unknown-side-effect',
]);

function isLease(value: unknown): value is ProviderInvocationLease | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'generation',
        'workerId',
        'tokenDigest',
        'acquiredAt',
        'expiresAt',
      ]) &&
      Number.isSafeInteger(value.generation) &&
      (value.generation as number) > 0 &&
      typeof value.workerId === 'string' &&
      value.workerId.length > 0 &&
      isDigest(value.tokenDigest) &&
      isTimestamp(value.acquiredAt) &&
      isTimestamp(value.expiresAt) &&
      Date.parse(value.expiresAt as string) >
        Date.parse(value.acquiredAt as string))
  );
}

function isStoredResult(value: unknown): value is ProviderProcessResult | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'requestDigest',
        'invocationId',
        'purpose',
        'providerId',
        'output',
        'outputDigest',
        'runtimeObservation',
      ]) &&
      isDigest(value.requestDigest) &&
      typeof value.invocationId === 'string' &&
      (value.purpose === 'survey' ||
        value.purpose === 'plan-review' ||
        value.purpose === 'task-diff-review' ||
        value.purpose === 'task-implementation') &&
      (value.providerId === 'codex' || value.providerId === 'claude') &&
      isDigest(value.outputDigest))
  );
}

function isStoredFailure(
  value: unknown,
): value is ProviderInvocationFailure | null {
  if (value === null) {
    return true;
  }
  try {
    assertProviderFailure(value);
    return true;
  } catch {
    return false;
  }
}

function providerInvocationDirectory(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(paths.invocations, invocationId);
}

function providerInvocationStatePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    providerInvocationDirectory(paths, invocationId),
    'state.json',
  );
}

function providerCompletionCandidatePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    paths.root,
    'execution',
    'completion-candidates',
    `${sha256(invocationId)}.json`,
  );
}

function investigationStartReservationPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-start.json`);
}

function providerRetryReservationPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
  attempt: number,
): string {
  return path.join(
    paths.refs,
    `${investigationId}.provider-retry-${attempt}.json`,
  );
}

function parseNow(value: string | undefined): number {
  const now = value === undefined ? Date.now() : Date.parse(value);
  if (!Number.isFinite(now)) {
    throw leaseInvalid();
  }
  return now;
}

function isTaskMandateBinding(
  value: unknown,
  changeId: string,
): value is TaskMandateBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) &&
    value.schemaVersion === 1 &&
    value.changeId === changeId &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    typeof value.mandateTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    isDigest(value.mandateDigest)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isBaseline(
  value: unknown,
): value is InvestigationStartReservation['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function blindManifestInvalid() {
  return workflowError(
    'BLIND_MANIFEST_INVALID',
    'Blind survey manifest is malformed, over-broad, or contains prior work.',
    ExitCode.guard,
  );
}

function invocationUnsafe() {
  return workflowError(
    'PROVIDER_INVOCATION_STORE_UNSAFE',
    'Provider invocation storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function providerExecutionPolicySnapshotUnsafe() {
  return workflowError(
    'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE',
    'Durable provider execution policy snapshot is missing, malformed, or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}

function providerExecutionPolicySnapshotMismatch() {
  return workflowError(
    'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
    'Durable provider execution policy snapshot is not bound to this request.',
    ExitCode.staleState,
  );
}

function assertProviderAcceptanceBinding(
  binding: ProviderInvocationAcceptanceBinding,
): void {
  const payload = { ...binding } as Record<string, unknown>;
  delete payload.bindingDigest;
  if (
    binding.schemaVersion !== 1 ||
    binding.kind !== 'provider-invocation-acceptance-binding' ||
    assertInvocationId(binding.invocationId) !== binding.invocationId ||
    assertInvestigationId(binding.ownerWorkflowId) !==
      binding.ownerWorkflowId ||
    !isDigest(binding.requestDigest) ||
    !Number.isSafeInteger(binding.legacyRevision) ||
    binding.legacyRevision < 0 ||
    !Number.isSafeInteger(binding.leaseGeneration) ||
    binding.leaseGeneration < 1 ||
    !Number.isSafeInteger(binding.executionRevision) ||
    binding.executionRevision < 0 ||
    !isDigest(binding.executionStateDigest) ||
    !isDigest(binding.bindingDigest) ||
    binding.context.ownerWorkflowId !== binding.ownerWorkflowId ||
    binding.repair.invocationId !== binding.invocationId ||
    sha256(canonicalJson(payload)) !== binding.bindingDigest
  ) {
    throw providerAcceptanceBindingStale();
  }
}

function providerAcceptanceBindingStale() {
  return workflowError(
    'PROVIDER_ACCEPTANCE_BINDING_STALE',
    'Provider execution authority changed before result acceptance.',
    ExitCode.staleState,
  );
}

function invocationInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_INVALID',
    'Provider invocation is malformed or internally inconsistent.',
    ExitCode.staleState,
  );
}

function invocationTransitionInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_TRANSITION_INVALID',
    'Provider invocation transition is not monotonic.',
    ExitCode.staleState,
  );
}

function leaseInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_LEASE_INVALID',
    'Provider invocation lease request is malformed.',
    ExitCode.usage,
  );
}

function resultInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_RESULT_INVALID',
    'Provider invocation result is not bound to its durable request.',
    ExitCode.verification,
  );
}

function providerCompletionRecoveryConflict() {
  return workflowError(
    'PROVIDER_COMPLETION_RECOVERY_CONFLICT',
    'Legacy provider state diverged from the exact durable completion candidate.',
    ExitCode.conflict,
  );
}

function providerCasMismatch(expected: number, observed: number) {
  return workflowError(
    'PROVIDER_INVOCATION_CAS_MISMATCH',
    'Provider invocation changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

function startReservationCasMismatch(
  expectedDigest: string | null,
  observedDigest: string | null,
) {
  return workflowError(
    'INVESTIGATION_START_RESERVATION_CAS_MISMATCH',
    'Investigation start reservation changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedDigest, observedDigest } },
  );
}

function startReservationLockInvalid() {
  return workflowError(
    'INVESTIGATION_START_RESERVATION_LOCK_INVALID',
    'Investigation start reservation lock ownership changed during retirement.',
    ExitCode.staleState,
  );
}

function invocationLockInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_LOCK_INVALID',
    'Provider invocation lock ownership changed during the transition.',
    ExitCode.staleState,
  );
}

function providerWorkerFenceUnsafe() {
  return workflowError(
    'PROVIDER_INVOCATION_WORKER_FENCE_UNSAFE',
    'Provider worker activity fence is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function absentInvestigationStartReservationSnapshot(): InvestigationStartReservationSnapshot {
  return Object.freeze({
    rawDocument: null,
    digest: null,
    reservation: null,
  });
}
