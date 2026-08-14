import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadAiAdapterPolicy,
  parseAiAdapterPolicyDocument,
  type AiAdapterProviderReservation,
} from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import { isRecord } from './contract-values.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { createEvidenceNode } from './evidence-node.ts';
import { writeEvidenceNode } from './evidence-object-store.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  investigationRuntimePaths,
  normalizeExactRepositoryPath,
} from './paths.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from './provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyOutputValidator,
  claimProviderInvocation,
  completeProviderInvocationFromRunner,
  createProviderInvocation,
  ensureProviderExecutionPolicySnapshot,
  failProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  providerInvocationManifestDigest,
  readProviderInvocation,
  type BlindSurveyManifest,
} from './provider-invocation-store.ts';
import { listBuiltInProviders, type ProviderId } from './provider-registry.ts';
import {
  preflightBuiltInProvider,
  runBuiltInProvider,
  type ProviderPreflightOptions,
  type ProviderResolution,
  type ProviderRunnerReport,
  type ProviderRunInput,
  type ProviderRunOptions,
} from './provider-runner.ts';
import { scheduleOrdinaryRole } from './role-scheduler.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PILOT_RECORD_PATH =
  /^workflow\/provider-availability-pilots\/[a-z0-9][a-z0-9-]{0,127}\.json$/u;
const PILOT_AUTHORIZATION_SCHEMA =
  'expense-app.workflow.provider-availability-pilot-authorization.v1';
const PILOT_AUTHORIZATION_OUTPUT_SCHEMA =
  'expense-app.workflow.provider-availability-pilot-authorization-output.v1';
const PILOT_EVALUATOR = 'provider-availability-pilot.v1';
const PROVIDERS = Object.freeze(['codex', 'claude'] as const);

export type ProviderAvailabilityPilotObservation = Readonly<{
  providerId: ProviderId;
  role: 'blind-surveyor';
  state: 'succeeded' | 'unavailable' | 'failed';
  resolutionStatus: ProviderResolution['status'];
  version: string | null;
  invocationId: string | null;
  requestDigest: string | null;
  outputDigest: string | null;
  authorizationNodeId: string | null;
  achievedIndependence: 'provider-independent' | null;
  grantUsed: false;
  providerLatencyMs: number;
  mutationObservation: Readonly<{
    assurance: 'unchanged-governed-projection';
    unchanged: true;
    beforeDigest: string;
    afterDigest: string;
  }> | null;
  executableSha256: string | null;
  failureCode: string | null;
  cost: Readonly<{
    basis: 'policy-reservation-upper-bound';
    actualUsageReported: false;
    providerCostMicros: number;
    providerTokens: number;
    withinPolicyBudget: boolean;
  }>;
}>;

export type ProviderAvailabilityPilotRecord = Readonly<{
  schemaVersion: 1;
  kind: 'provider-availability-pilot-result.v1';
  pilotId: string;
  authority: 'empirical-observation-only';
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  policyDigest: string;
  startedAt: string;
  completedAt: string;
  decision: 'healthy-two-provider-observed' | 'incomplete';
  accepted: boolean;
  friction: Readonly<{
    providerWaitCount: number;
    collaborationGrantCount: 0;
    humanActionCount: 0;
  }>;
  totalProviderLatencyMs: number;
  totalReservedCostMicros: number;
  totalReservedTokens: number;
  observations: readonly ProviderAvailabilityPilotObservation[];
  recordDigest: string;
}>;

export type ProviderAvailabilityPilotRunResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-availability-pilot-run.v1';
  recordPath: string;
  record: ProviderAvailabilityPilotRecord;
}>;

type PilotRunOptions = Readonly<{ recordPath?: string }>;

type PilotDependencies = Readonly<{
  now: () => Date;
  randomUUID: () => string;
  preflight: (
    providerId: ProviderId,
    options: ProviderPreflightOptions,
  ) => ProviderResolution;
  runProvider: (
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ) => ProviderRunnerReport;
}>;

const productionDependencies: PilotDependencies = Object.freeze({
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
  preflight: preflightBuiltInProvider,
  runProvider: runBuiltInProvider,
});

export function runProviderAvailabilityPilot(
  cwd: string,
  options: PilotRunOptions = {},
): ProviderAvailabilityPilotRunResult {
  return runProviderAvailabilityPilotWithDependencies(
    cwd,
    options,
    productionDependencies,
  );
}

/** Tests may substitute bounded provider effects; production cannot. */
export function createProviderAvailabilityPilotRunnerForTesting(
  dependencies: PilotDependencies,
): (
  cwd: string,
  options?: PilotRunOptions,
) => ProviderAvailabilityPilotRunResult {
  return (cwd, options = {}) =>
    runProviderAvailabilityPilotWithDependencies(cwd, options, dependencies);
}

export function verifyProviderAvailabilityPilot(
  cwd: string,
  requestedRecordPath: string,
): ProviderAvailabilityPilotRecord {
  const repository = discoverRepository(cwd);
  const recordPath = resolvePilotRecordPath(
    repository.repositoryRoot,
    requestedRecordPath,
  );
  const value = readPilotRecord(recordPath);
  return assertProviderAvailabilityPilotRecord(
    repository.repositoryRoot,
    value,
  );
}

function runProviderAvailabilityPilotWithDependencies(
  cwd: string,
  options: PilotRunOptions,
  dependencies: PilotDependencies,
): ProviderAvailabilityPilotRunResult {
  const repository = discoverRepository(cwd);
  if (repository.statusEntries.length !== 0) {
    throw pilotInvalid(
      'Provider availability pilot requires a clean exact-baseline worktree.',
    );
  }
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const loadedPolicy = loadAiAdapterPolicy(repository.repositoryRoot);
  const runtime = investigationRuntimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const startedAt = dependencies.now().toISOString();
  const runToken = normalizeRunToken(dependencies.randomUUID());
  const pilotId = `provider-availability-${runToken}`;
  const recordPath =
    options.recordPath ??
    `workflow/provider-availability-pilots/${pilotId}.json`;
  resolvePilotRecordPath(repository.repositoryRoot, recordPath);
  const preflightDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-provider-availability-'),
  );
  const observations: ProviderAvailabilityPilotObservation[] = [];
  try {
    for (const providerId of PROVIDERS) {
      const resolution = dependencies.preflight(providerId, {
        platform: process.platform,
        enabled: loadedPolicy.policy.providers[providerId].enabled,
        sourceEnvironment: process.env,
        temporaryDirectory: preflightDirectory,
      });
      const reservation =
        loadedPolicy.policy.retryAccounting.reservations[providerId];
      if (resolution.status !== 'available') {
        observations.push(
          unavailableObservation(
            providerId,
            resolution,
            reservation,
            loadedPolicy.policy.retryAccounting,
          ),
        );
        continue;
      }
      observations.push(
        runAvailableProvider({
          repository,
          config,
          runtime,
          loadedPolicy,
          pilotId,
          runToken,
          providerId,
          resolution,
          dependencies,
        }),
      );
    }
  } finally {
    fs.rmSync(preflightDirectory, { recursive: true, force: true });
  }

  const completedAt = dependencies.now().toISOString();
  const payload = createPilotRecordPayload({
    pilotId,
    repositoryId: config.repositoryName,
    baseCommit: repository.head,
    baseTree: repository.tree,
    policyDigest: loadedPolicy.digest,
    startedAt,
    completedAt,
    observations,
  });
  const record: ProviderAvailabilityPilotRecord = Object.freeze({
    ...payload,
    recordDigest: sha256(canonicalJson(payload)),
  });
  assertProviderAvailabilityPilotRecord(repository.repositoryRoot, record);
  writePilotRecord(
    resolvePilotRecordPath(repository.repositoryRoot, recordPath),
    record,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'provider-availability-pilot-run.v1' as const,
    recordPath,
    record,
  });
}

function runAvailableProvider(input: {
  repository: ReturnType<typeof discoverRepository>;
  config: ReturnType<typeof loadWorkflowConfig>;
  runtime: ReturnType<typeof investigationRuntimePaths>;
  loadedPolicy: ReturnType<typeof loadAiAdapterPolicy>;
  pilotId: string;
  runToken: string;
  providerId: ProviderId;
  resolution: ProviderResolution;
  dependencies: PilotDependencies;
}): ProviderAvailabilityPilotObservation {
  const {
    repository,
    config,
    runtime,
    loadedPolicy,
    pilotId,
    runToken,
    providerId,
    resolution,
    dependencies,
  } = input;
  const counterparty = providerId === 'codex' ? 'claude' : 'codex';
  const changeId = `provider-availability-${providerId}-${runToken}`;
  const investigationId = `investigation-${changeId}`;
  const invocationId = `invocation-${changeId}`;
  const manifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId,
    repositoryId: config.repositoryName,
    baseCommit: repository.head,
    baseTree: repository.tree,
    normalizedIntent: {
      schemaVersion: 1,
      summary:
        'Observe whether the ordinary Codex and Claude read-only provider pair is callable.',
      explicitPaths: [],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'Identify one exact repository term that demonstrates read-only repository access. Do not propose changes.',
    capabilityProfile: 'repository-read-only',
  };
  const targetDigest = blindSurveyIntentDigest(manifest);
  const scheduled = scheduleOrdinaryRole({
    role: 'blind-surveyor',
    author: {
      providerId: counterparty,
      sessionId: `${pilotId}-${counterparty}-author`,
      principalId: counterparty,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    },
    targetDigest,
    candidates: [
      {
        providerId,
        sessionId: `${pilotId}-${providerId}-survey`,
        enabled: true,
        available: true,
      },
    ],
  });
  if (scheduled.outcome !== 'assigned') {
    throw pilotInvalid(
      'The healthy provider could not receive an ordinary role.',
    );
  }
  const authorizationNode = createEvidenceNode({
    type: 'provider-availability-pilot-authorization',
    nodeSchema: PILOT_AUTHORIZATION_SCHEMA,
    evaluator: PILOT_EVALUATOR,
    policyDigest: loadedPolicy.digest,
    exactInputDigests: {
      assignment: sha256(canonicalJson(scheduled.assignment)),
      baseline: sha256(
        canonicalJson({ head: repository.head, tree: repository.tree }),
      ),
      pilot: sha256(canonicalJson({ pilotId, providerId })),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: PILOT_AUTHORIZATION_OUTPUT_SCHEMA,
    output: {
      authority: 'empirical-observation-only',
      transitionAuthorized: false,
      assignment: scheduled.assignment,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorizationNode);
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `${pilotId}-${providerId}`,
    purpose: 'survey',
    providerId,
    roleAssignment: scheduled.assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: config.repositoryName,
    baseCommit: repository.head,
    baseTree: repository.tree,
    targetDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: authorizationNode.nodeId,
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest: loadedPolicy.digest,
    limits: {
      timeoutMs: loadedPolicy.policy.limits.timeoutMs,
      aggregateOutputBytes: loadedPolicy.policy.limits.aggregateOutputBytes,
    },
  });
  ensureProviderExecutionPolicySnapshot(runtime, request, loadedPolicy);
  const prepared = createProviderInvocation(runtime, {
    investigationId,
    changeId,
    attempt: 1,
    manifest,
    request,
  });
  const claim = claimProviderInvocation(runtime, invocationId, {
    workerId: `${pilotId}-${providerId}`,
    leaseDurationMs: request.limits.timeoutMs,
    expectedRevision: prepared.revision,
  });
  const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
    runtime,
    invocationId,
  );
  try {
    const report = dependencies.runProvider(
      {
        providerId,
        repositoryRoot: repository.repositoryRoot,
        invocationDirectory: path.join(runtime.invocations, invocationId),
        request,
        semanticOutputSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
        outputValidator: blindSurveyOutputValidator(request),
        governedRuntimeInputs: [],
        acceptanceBinding,
        reviewSnapshotRoot: null,
        sourceEnvironment: process.env,
      },
      { platform: process.platform },
    );
    const terminal = completeProviderInvocationFromRunner(
      runtime,
      invocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        report,
        acceptanceBinding,
      },
    );
    if (terminal.state !== 'succeeded' || terminal.result === null) {
      throw pilotInvalid('The provider result did not reach terminal success.');
    }
    return successfulObservation(
      providerId,
      resolution,
      request,
      authorizationNode.nodeId,
      report,
      loadedPolicy.policy.retryAccounting.reservations[providerId],
      loadedPolicy.policy.retryAccounting,
    );
  } catch (error) {
    const current = readProviderInvocation(runtime, invocationId);
    if (current.state !== 'leased') throw error;
    const code =
      error instanceof WorkflowError
        ? error.code
        : 'PROVIDER_AVAILABILITY_PILOT_PROVIDER_FAILED';
    failProviderInvocation(runtime, invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code,
        message: `Provider availability observation failed durably (${code}).`,
      },
    });
    return failedObservation(
      providerId,
      resolution,
      request,
      authorizationNode.nodeId,
      code,
      loadedPolicy.policy.retryAccounting.reservations[providerId],
      loadedPolicy.policy.retryAccounting,
    );
  }
}

function successfulObservation(
  providerId: ProviderId,
  resolution: ProviderResolution,
  request: ProviderInvocationRequest,
  authorizationNodeId: string,
  report: ProviderRunnerReport,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): ProviderAvailabilityPilotObservation {
  return Object.freeze({
    providerId,
    role: 'blind-surveyor' as const,
    state: 'succeeded' as const,
    resolutionStatus: 'available' as const,
    version: resolution.version ?? null,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: report.semanticOutputDigest,
    authorizationNodeId,
    achievedIndependence: 'provider-independent' as const,
    grantUsed: false as const,
    providerLatencyMs: report.elapsedMs,
    mutationObservation: Object.freeze({
      assurance: 'unchanged-governed-projection' as const,
      unchanged: true as const,
      beforeDigest: report.projection.beforeDigest,
      afterDigest: report.projection.afterDigest,
    }),
    executableSha256: report.executable.sha256,
    failureCode: null,
    cost: costObservation(providerId, reservation, accounting),
  });
}

function unavailableObservation(
  providerId: ProviderId,
  resolution: ProviderResolution,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): ProviderAvailabilityPilotObservation {
  return Object.freeze({
    providerId,
    role: 'blind-surveyor' as const,
    state: 'unavailable' as const,
    resolutionStatus: resolution.status,
    version: resolution.version ?? null,
    invocationId: null,
    requestDigest: null,
    outputDigest: null,
    authorizationNodeId: null,
    achievedIndependence: null,
    grantUsed: false as const,
    providerLatencyMs: 0,
    mutationObservation: null,
    executableSha256: resolution.executable?.sha256 ?? null,
    failureCode: null,
    cost: costObservation(providerId, reservation, accounting),
  });
}

function failedObservation(
  providerId: ProviderId,
  resolution: ProviderResolution,
  request: ProviderInvocationRequest,
  authorizationNodeId: string,
  failureCode: string,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): ProviderAvailabilityPilotObservation {
  return Object.freeze({
    providerId,
    role: 'blind-surveyor' as const,
    state: 'failed' as const,
    resolutionStatus: 'available' as const,
    version: resolution.version ?? null,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: null,
    authorizationNodeId,
    achievedIndependence: 'provider-independent' as const,
    grantUsed: false as const,
    providerLatencyMs: 0,
    mutationObservation: null,
    executableSha256: resolution.executable?.sha256 ?? null,
    failureCode,
    cost: costObservation(providerId, reservation, accounting),
  });
}

function costObservation(
  providerId: ProviderId,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
) {
  return Object.freeze({
    basis: 'policy-reservation-upper-bound' as const,
    actualUsageReported: false as const,
    providerCostMicros: reservation.providerCostMicros,
    providerTokens: reservation.providerTokens,
    withinPolicyBudget:
      reservation.providerCostMicros <= accounting.maxProviderCostMicros &&
      reservation.providerTokens <= accounting.maxProviderTokens &&
      accounting.providerLimits[providerId] >= 1,
  });
}

function createPilotRecordPayload(input: {
  pilotId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  policyDigest: string;
  startedAt: string;
  completedAt: string;
  observations: readonly ProviderAvailabilityPilotObservation[];
}) {
  const accepted = input.observations.every(
    ({ state, cost }) => state === 'succeeded' && cost.withinPolicyBudget,
  );
  return {
    schemaVersion: 1 as const,
    kind: 'provider-availability-pilot-result.v1' as const,
    pilotId: input.pilotId,
    authority: 'empirical-observation-only' as const,
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    policyDigest: input.policyDigest,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    decision: accepted
      ? ('healthy-two-provider-observed' as const)
      : ('incomplete' as const),
    accepted,
    friction: {
      providerWaitCount: input.observations.filter(
        ({ state }) => state !== 'succeeded',
      ).length,
      collaborationGrantCount: 0 as const,
      humanActionCount: 0 as const,
    },
    totalProviderLatencyMs: input.observations.reduce(
      (sum, { providerLatencyMs }) => sum + providerLatencyMs,
      0,
    ),
    totalReservedCostMicros: input.observations.reduce(
      (sum, { cost }) => sum + cost.providerCostMicros,
      0,
    ),
    totalReservedTokens: input.observations.reduce(
      (sum, { cost }) => sum + cost.providerTokens,
      0,
    ),
    observations: [...input.observations],
  };
}

function assertProviderAvailabilityPilotRecord(
  repositoryRoot: string,
  value: unknown,
): ProviderAvailabilityPilotRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'pilotId',
      'authority',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'policyDigest',
      'startedAt',
      'completedAt',
      'decision',
      'accepted',
      'friction',
      'totalProviderLatencyMs',
      'totalReservedCostMicros',
      'totalReservedTokens',
      'observations',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-availability-pilot-result.v1' ||
    typeof value.pilotId !== 'string' ||
    !/^provider-availability-[a-z0-9]{32}$/u.test(value.pilotId) ||
    value.authority !== 'empirical-observation-only' ||
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.length === 0 ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    typeof value.policyDigest !== 'string' ||
    !SHA256.test(value.policyDigest) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.completedAt) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
    (value.decision !== 'healthy-two-provider-observed' &&
      value.decision !== 'incomplete') ||
    typeof value.accepted !== 'boolean' ||
    !isRecord(value.friction) ||
    !hasExactKeys(value.friction, [
      'providerWaitCount',
      'collaborationGrantCount',
      'humanActionCount',
    ]) ||
    !isNonNegativeInteger(value.friction.providerWaitCount) ||
    value.friction.collaborationGrantCount !== 0 ||
    value.friction.humanActionCount !== 0 ||
    !isNonNegativeInteger(value.totalProviderLatencyMs) ||
    !isNonNegativeInteger(value.totalReservedCostMicros) ||
    !isNonNegativeInteger(value.totalReservedTokens) ||
    !Array.isArray(value.observations) ||
    value.observations.length !== PROVIDERS.length ||
    typeof value.recordDigest !== 'string' ||
    !SHA256.test(value.recordDigest)
  ) {
    throw pilotInvalid();
  }
  const policyContent = runGit(repositoryRoot, [
    'show',
    `${value.baseCommit}:workflow/ai-adapter-policy.json`,
  ]);
  const loadedPolicy = parseAiAdapterPolicyDocument(policyContent);
  const baseTree = runGit(repositoryRoot, [
    'rev-parse',
    `${value.baseCommit}^{tree}`,
  ]).trim();
  const config = JSON.parse(
    runGit(repositoryRoot, [
      'show',
      `${value.baseCommit}:workflow/config.json`,
    ]),
  ) as unknown;
  if (
    loadedPolicy.digest !== value.policyDigest ||
    baseTree !== value.baseTree ||
    !isRecord(config) ||
    config.repositoryName !== value.repositoryId
  ) {
    throw pilotInvalid();
  }
  const observations = value.observations.map((observation, index) =>
    assertPilotObservation(
      observation,
      PROVIDERS[index]!,
      loadedPolicy.policy.retryAccounting.reservations[PROVIDERS[index]!],
      loadedPolicy.policy.retryAccounting,
      loadedPolicy.policy.limits.timeoutMs,
    ),
  );
  const expectedPayload = createPilotRecordPayload({
    pilotId: value.pilotId,
    repositoryId: value.repositoryId,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    policyDigest: value.policyDigest,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    observations,
  });
  const actualPayload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'recordDigest'),
  );
  if (
    canonicalJson(expectedPayload) !== canonicalJson(actualPayload) ||
    value.recordDigest !== sha256(canonicalJson(expectedPayload))
  ) {
    throw pilotInvalid();
  }
  return Object.freeze(
    structuredClone(value),
  ) as ProviderAvailabilityPilotRecord;
}

function assertPilotObservation(
  value: unknown,
  expectedProviderId: ProviderId,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
  timeoutMs: number,
): ProviderAvailabilityPilotObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'role',
      'state',
      'resolutionStatus',
      'version',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'authorizationNodeId',
      'achievedIndependence',
      'grantUsed',
      'providerLatencyMs',
      'mutationObservation',
      'executableSha256',
      'failureCode',
      'cost',
    ]) ||
    value.providerId !== expectedProviderId ||
    value.role !== 'blind-surveyor' ||
    !['succeeded', 'unavailable', 'failed'].includes(value.state as string) ||
    !isResolutionStatus(value.resolutionStatus) ||
    (value.version !== null && typeof value.version !== 'string') ||
    value.grantUsed !== false ||
    !isNonNegativeInteger(value.providerLatencyMs) ||
    value.providerLatencyMs > timeoutMs ||
    (value.executableSha256 !== null &&
      (typeof value.executableSha256 !== 'string' ||
        !SHA256.test(value.executableSha256))) ||
    !isCostObservation(value.cost, expectedProviderId, reservation, accounting)
  ) {
    throw pilotInvalid();
  }
  const boundStrings = [
    value.invocationId,
    value.requestDigest,
    value.outputDigest,
    value.authorizationNodeId,
  ];
  if (value.state === 'succeeded') {
    if (
      value.resolutionStatus !== 'available' ||
      typeof value.invocationId !== 'string' ||
      !isInvocationId(value.invocationId) ||
      [value.requestDigest, value.outputDigest, value.authorizationNodeId].some(
        (entry) => typeof entry !== 'string' || !SHA256.test(entry),
      ) ||
      value.achievedIndependence !== 'provider-independent' ||
      value.failureCode !== null ||
      !isRecord(value.mutationObservation) ||
      !hasExactKeys(value.mutationObservation, [
        'assurance',
        'unchanged',
        'beforeDigest',
        'afterDigest',
      ]) ||
      value.mutationObservation.assurance !== 'unchanged-governed-projection' ||
      value.mutationObservation.unchanged !== true ||
      typeof value.mutationObservation.beforeDigest !== 'string' ||
      !SHA256.test(value.mutationObservation.beforeDigest) ||
      value.mutationObservation.afterDigest !==
        value.mutationObservation.beforeDigest ||
      value.executableSha256 === null
    ) {
      throw pilotInvalid();
    }
  } else if (value.state === 'unavailable') {
    if (
      value.resolutionStatus === 'available' ||
      boundStrings.some((entry) => entry !== null) ||
      value.achievedIndependence !== null ||
      value.providerLatencyMs !== 0 ||
      value.mutationObservation !== null ||
      value.failureCode !== null
    ) {
      throw pilotInvalid();
    }
  } else if (
    value.resolutionStatus !== 'available' ||
    typeof value.invocationId !== 'string' ||
    !isInvocationId(value.invocationId) ||
    typeof value.requestDigest !== 'string' ||
    !SHA256.test(value.requestDigest) ||
    value.outputDigest !== null ||
    typeof value.authorizationNodeId !== 'string' ||
    !SHA256.test(value.authorizationNodeId) ||
    value.achievedIndependence !== 'provider-independent' ||
    value.providerLatencyMs !== 0 ||
    value.mutationObservation !== null ||
    typeof value.failureCode !== 'string' ||
    value.failureCode.length === 0
  ) {
    throw pilotInvalid();
  }
  return Object.freeze(
    structuredClone(value),
  ) as ProviderAvailabilityPilotObservation;
}

function isCostObservation(
  value: unknown,
  providerId: ProviderId,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'basis',
      'actualUsageReported',
      'providerCostMicros',
      'providerTokens',
      'withinPolicyBudget',
    ]) &&
    value.basis === 'policy-reservation-upper-bound' &&
    value.actualUsageReported === false &&
    value.providerCostMicros === reservation.providerCostMicros &&
    value.providerTokens === reservation.providerTokens &&
    value.withinPolicyBudget ===
      (reservation.providerCostMicros <= accounting.maxProviderCostMicros &&
        reservation.providerTokens <= accounting.maxProviderTokens &&
        accounting.providerLimits[providerId] >= 1)
  );
}

function resolvePilotRecordPath(
  repositoryRoot: string,
  requestedPath: string,
): string {
  let normalized: string;
  try {
    normalized = normalizeExactRepositoryPath(requestedPath);
  } catch {
    throw pilotInvalid('The pilot record path is invalid.');
  }
  if (!PILOT_RECORD_PATH.test(normalized)) {
    throw pilotInvalid(
      'The pilot record must use the governed pilot directory.',
    );
  }
  return path.join(repositoryRoot, normalized);
}

function writePilotRecord(
  recordPath: string,
  record: ProviderAvailabilityPilotRecord,
): void {
  const directory = path.dirname(recordPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStats = fs.lstatSync(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw pilotInvalid('The pilot record directory is unsafe.');
  }
  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      recordPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, `${canonicalJson(record)}\n`);
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw pilotInvalid('The pilot record could not be created.', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readPilotRecord(recordPath: string): unknown {
  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(recordPath, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 1024 * 1024) {
      throw pilotInvalid();
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw pilotInvalid('The pilot record is unreadable.', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizeRunToken(value: string): string {
  const token = value.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(token)) throw pilotInvalid();
  return token;
}

function isResolutionStatus(
  value: unknown,
): value is ProviderResolution['status'] {
  return [
    'disabled',
    'unsupported-platform',
    'absent',
    'unsafe-candidate',
    'incompatible',
    'unauthenticated',
    'available',
  ].includes(value as string);
}

function isInvocationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pilotInvalid(
  message = 'Provider availability pilot is invalid.',
  cause?: unknown,
) {
  return workflowError(
    'PROVIDER_AVAILABILITY_PILOT_INVALID',
    message,
    ExitCode.guard,
    cause === undefined
      ? undefined
      : {
          details: {
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        },
  );
}

// Keep the pair pinned to the complete built-in registry. Adding a provider is
// a schema change, not an implicit widening of the empirical claim.
if (
  canonicalJson(listBuiltInProviders().map(({ id }) => id)) !==
  canonicalJson(PROVIDERS)
) {
  throw pilotInvalid('The provider availability pilot registry is stale.');
}
