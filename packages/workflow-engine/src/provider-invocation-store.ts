import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { resolvePlanReviewInvocationOwner } from './evidence-object-store.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  privatePathExists,
  readHumanResolutionHead,
  readHumanResolutionNode,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
  type ProviderProcessResult,
  type ProviderRuntimeObservation,
} from './provider-contracts.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from './provider-runner.ts';
import {
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  type InvestigationTermKind,
} from './investigation-terms.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  type InvestigationRuntimePaths,
} from './paths.ts';
import type { ProviderId } from './provider-registry.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  assertPlanReviewTargetSnapshot,
  assertPlanReviewSubject,
  planReviewSnapshotLineCount,
  type PlanReviewTargetSnapshot,
  type PlanReviewSubject,
} from './plan-review.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';

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

export type ProviderInvocationManifest =
  BlindSurveyManifest | PlanReviewManifest;

export type InvestigationStartReservation = {
  schemaVersion: 1;
  kind: 'investigation-start-reservation';
  changeId: string;
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

export type ProviderRetryReservation = {
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

export type ProviderInvocationFailure = {
  kind: 'retryable' | 'repository-reconciliation-required';
  code: string;
  message: string;
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
  attempt: number;
  revision: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  providerId: ProviderId;
  purpose: 'survey' | 'plan-review';
  requestDigest: string;
  manifestDigest: string;
  leaseGeneration: number;
  lease: ProviderInvocationLease | null;
  result: ProviderProcessResult | null;
  failure: ProviderInvocationFailure | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateProviderInvocationInput = {
  investigationId: string;
  changeId: string;
  attempt: number;
  manifest: ProviderInvocationManifest;
  request: ProviderInvocationRequest;
  planReviewSnapshotFiles?: Array<{
    snapshotFile: string;
    content: Buffer;
  }>;
  createdAt?: string;
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
    manifest: BlindSurveyManifest;
    request: ProviderInvocationRequest;
    createdAt?: string;
  },
): ProviderRetryReservation {
  const investigationId = assertInvestigationId(input.investigationId);
  const changeId = assertChangeId(input.changeId);
  const previousInvocationId = assertInvocationId(input.previousInvocationId);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 2) {
    throw invocationInvalid();
  }
  const manifest = assertBlindSurveyManifest(input.manifest);
  const request = assertProviderRequest(input.request);
  const manifestDigest = blindSurveyManifestDigest(manifest);
  assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const reservation = assertProviderRetryReservation({
    schemaVersion: 1,
    kind: 'provider-retry-reservation',
    investigationId,
    changeId,
    attempt: input.attempt,
    previousInvocationId,
    invocationId: request.invocationId,
    manifestDigest,
    requestDigest: request.requestDigest,
    request,
    createdAt,
  });
  createPrivateCanonicalJson(
    paths,
    providerRetryReservationPath(paths, investigationId, input.attempt),
    reservation,
    invocationUnsafe,
    'PROVIDER_RETRY_RESERVATION_CONFLICT',
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
      createPrivateCanonicalJson(
        paths,
        statePath,
        record,
        invocationUnsafe,
        'PROVIDER_INVOCATION_COLLISION',
      );
      return readProviderInvocation(paths, invocationId);
    },
    'PROVIDER_INVOCATION_OPERATION_CONFLICT',
    invocationLockInvalid,
  );
}

export function readProviderInvocation(
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
  assertPlanReviewSnapshotFiles(paths, invocationId, manifest);
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
      canonicalJson(assertProviderResult(request, record.result)) !==
        canonicalJson(record.result))
  ) {
    throw invocationInvalid();
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
  return deepFreeze(structuredClone(record));
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
  return withProviderWorkerLifecycle(paths, () => {
    const claim = claimProviderInvocationUnderLifecycleLock(
      paths,
      invocationId,
      input,
      now,
    );
    const workerFenceToken = crypto.randomUUID();
    createProviderWorkerFence(paths, claim.record, workerFenceToken);
    return { ...claim, workerFenceToken };
  });
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
    now?: string;
  },
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  const result = providerResultFromRunnerReport(request, input.report);
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

export function failProviderInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    leaseGeneration: number;
    leaseToken: string;
    failure: ProviderInvocationFailure;
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
        return {
          ...current,
          revision: current.revision + 1,
          state: 'failed',
          lease: null,
          result: null,
          failure,
          updatedAt: new Date(now).toISOString(),
        };
      },
    ),
  );
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
      const next = assertProviderInvocationRecord(transition(current));
      assertMonotonicInvocationTransition(current, next);
      writePrivateCanonicalJsonAtomic(
        paths,
        providerInvocationStatePath(paths, invocationId),
        next,
        invocationUnsafe,
      );
      return readProviderInvocation(paths, invocationId);
    },
    'PROVIDER_INVOCATION_OPERATION_CONFLICT',
    invocationLockInvalid,
  );
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-reservation' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
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
  if (
    invocationId !== request.invocationId ||
    value.requestDigest !== request.requestDigest ||
    value.previousInvocationId === invocationId
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone({ ...value, invocationId, request }),
  ) as ProviderRetryReservation;
}

function assertProviderRequest(value: unknown): ProviderInvocationRequest {
  if (!isRecord(value)) {
    throw invocationInvalid();
  }
  try {
    const reconstructed = createProviderInvocationRequest({
      invocationId: value.invocationId as string,
      nonce: value.nonce as string,
      purpose: value.purpose as 'survey',
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
  if (canonicalJson(names) !== canonicalJson(expectedNames)) {
    throw invocationInvalid();
  }
  for (const artifact of manifest.planningTarget.artifacts) {
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
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.invocationId !== 'string' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(
      String(value.state),
    ) ||
    (value.providerId !== 'codex' && value.providerId !== 'claude') ||
    (value.purpose !== 'survey' && value.purpose !== 'plan-review') ||
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
    (value.lease !== null && value.lease.generation !== value.leaseGeneration)
  ) {
    throw invocationInvalid();
  }
  return value as ProviderInvocationRecord;
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

export function blindSurveyOutputValidator(request: ProviderInvocationRequest) {
  if (
    request.purpose !== 'survey' ||
    canonicalJson(request.outputSchema) !==
      canonicalJson(BLIND_SURVEY_OUTPUT_SCHEMA)
  ) {
    throw workflowError(
      'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
      'Provider invocation does not reference a code-owned output schema.',
      ExitCode.verification,
    );
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

function assertProviderResult(
  request: ProviderInvocationRequest,
  value: unknown,
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
  const validator = providerOutputValidator(request);
  const output = deepFreeze(structuredClone(value.output));
  let outputAccepted: boolean;
  try {
    outputAccepted = validator.validate(output) === true;
  } catch {
    throw resultInvalid();
  }
  if (!outputAccepted) {
    throw resultInvalid();
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
  if (request.purpose === 'survey') {
    return blindSurveyOutputValidator(request);
  }
  if (
    request.purpose === 'plan-review' &&
    canonicalJson(request.outputSchema) ===
      canonicalJson(PLAN_REVIEW_OUTPUT_SCHEMA)
  ) {
    return PLAN_REVIEW_OUTPUT_VALIDATOR;
  }
  throw workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned output schema.',
    ExitCode.verification,
  );
}

function assertRuntimeObservation(
  value: unknown,
  request: ProviderInvocationRequest,
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
    canonicalJson(value.residuals) !==
      canonicalJson(PROVIDER_RUNNER_RESIDUALS) ||
    !isExecutableIdentity(value.executable) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    (value.elapsedMs as number) < 0 ||
    (value.elapsedMs as number) > request.limits.timeoutMs
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'code', 'message']) ||
    (value.kind !== 'retryable' &&
      value.kind !== 'repository-reconciliation-required') ||
    typeof value.code !== 'string' ||
    value.code.length === 0 ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    Buffer.byteLength(canonicalJson(value), 'utf8') > 16_384
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(value)) as ProviderInvocationFailure;
}

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
      (value.purpose === 'survey' || value.purpose === 'plan-review') &&
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
