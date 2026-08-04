import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  bootstrapInterventionStateRoot,
  resolveLocalEngineSelection,
} from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  digestArtifacts,
  loadChangeContract,
  loadWorkflowConfig,
  parseTasks,
  type TaskPolicy,
} from './contracts.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import {
  pinCheckRunner,
  runCheck,
  type CheckEvidence,
  type CheckEvidenceMetadata,
} from './check-runner.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from './database-policy.ts';
import { ExitCode, workflowError } from './errors.ts';
import { completionDocumentPaths } from './managed-documents.ts';
import {
  readLocalEngineBinding,
  readPersistedWipBundle,
} from './intervention-control-bootstrap.ts';
import { readPersistedEngineAdoption } from './intervention-control-persistence.ts';
import {
  loadCapabilityProfileFromTrustBase,
  type CheckDependency,
} from './maintainer-manifest.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
  type GitState,
} from './git.ts';
import { type ValidatedChangeContract } from './managed-change-contract.ts';
import {
  assertInvestigationPlanningActivation,
  readActivationMarkerFile,
} from './openspec-schema-contract.ts';
import { assertSessionId, matchesAllowedPath } from './paths.ts';
import { createTaskPlanningAssuranceBinding } from './planning-assurance-validator.ts';
import {
  readImmutableReport,
  writeImmutableReport,
  type WorkflowReport,
} from './report-store.ts';
import {
  assertInspectionReport,
  assertReportChecks,
} from './report-validation.ts';
import {
  assertOwnedLock,
  readSessionFile,
  runtimePaths,
  type WorkflowSession,
  withSessionOperation,
  writeJsonAtomic,
} from './session-store.ts';
import { assertTaskProjectionSourceDigest } from './task-projection.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';

export type SessionCheck = {
  sessionId: string;
  changeId: string;
  taskId: string;
  changedPaths: string[];
  unexpectedPaths: string[];
  checks: CheckEvidence[];
  executedCheckIds: string[];
  reusedCheckIds: string[];
  passed: true;
  reportId: string;
};

export type SessionCheckOptions = {
  environment?: NodeJS.ProcessEnv;
  /** Trusted clock used to bind persisted check completion and freshness. */
  now?: () => Date;
  /**
   * Engine-owned trust seam for current external snapshots. Production callers
   * must never populate this from argv, candidate content, persisted session
   * fields, or ambient environment values.
   */
  externalSnapshotDigests?: Readonly<Record<string, string>>;
  /** Test-only crash window after immutable publication and before CAS. */
  testAfterReconciliationReport?: () => void;
};

type TrustedCheckPolicy = {
  checkDependencies: Record<string, CheckDependency[]>;
  externalStateFreshness: Record<string, { maxAgeMs: number }>;
};

export type SessionInspection = {
  git: GitState;
  session: WorkflowSession;
  contract: ValidatedChangeContract;
  policy: TaskPolicy;
  artifactDigests: Record<string, string>;
  changedPaths: string[];
  unexpectedPaths: string[];
  fingerprint: string;
  tasksPath: string;
  baselineTasks: string;
};

export function checkSession(
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions = {},
): SessionCheck {
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessionId = assertSessionId(requestedSessionId);
  return withSessionOperation(runtime, sessionId, () =>
    checkSessionUnlocked(cwd, sessionId, options),
  );
}

function checkSessionUnlocked(
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions,
): SessionCheck {
  const reconciled = reconcileSessionChecksAfterLocalEngineAdoption(
    cwd,
    requestedSessionId,
    options,
  );
  if (reconciled !== null) return reconciled;
  const initial = inspectSession(cwd, requestedSessionId);
  const trustedPolicy = tryLoadTrustedCheckPolicy(
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.session.requiredChecks,
  );
  const evidenceMetadata = trustedPolicy
    ? createSessionEvidenceMetadata(
        initial.session.requiredChecks,
        trustedPolicy,
        options,
      )
    : undefined;
  const verified = executeChecks(
    cwd,
    initial,
    initial.session.requiredChecks,
    options.environment ?? process.env,
    [],
    undefined,
    [],
    evidenceMetadata,
  );
  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'check',
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    createdAt: new Date().toISOString(),
    baseline: initial.session.baseline,
    branch: initial.session.branch,
    artifactDigests: verified.inspection.artifactDigests,
    allowedPaths: initial.session.allowedPaths,
    requiredChecks: initial.session.requiredChecks,
    requiredCheckDigests: digestRequiredCheckDefinitions(
      initial.contract.checks,
      initial.session.requiredChecks,
    ),
    changedPaths: verified.inspection.changedPaths,
    fingerprint: verified.inspection.fingerprint,
    checks: verified.checks,
    ...(trustedPolicy
      ? {
          checkDependencies: trustedPolicy.checkDependencies,
          externalStateFreshness: trustedPolicy.externalStateFreshness,
        }
      : {}),
  };
  const reportId = writeSessionReport(verified.inspection, report);
  const localAdoption = resolveVerifiedLocalAdoption(
    verified.inspection,
    options.environment ?? process.env,
  );
  persistSession(verified.inspection, {
    ...verified.inspection.session,
    latestCheckReportId: reportId,
    ...(localAdoption
      ? { checkEvidenceEngineDigest: localAdoption.toEngineDigest }
      : {}),
  });

  return {
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    changedPaths: verified.inspection.changedPaths,
    unexpectedPaths: [],
    checks: verified.checks,
    executedCheckIds: [...initial.session.requiredChecks],
    reusedCheckIds: [],
    passed: true,
    reportId,
  };
}

type VerifiedLocalAdoption = {
  txId: string;
  checkpointId: `sha256:${string}`;
  fromEngineDigest: `sha256:${string}`;
  toEngineDigest: `sha256:${string}`;
  committedAt: string;
  journalDigest: `sha256:${string}`;
  snapshotSession: WorkflowSession;
};

/**
 * Reconcile only check evidence affected by a bootstrap-verified local engine
 * adoption.  The immutable replacement report is intentionally timestamped
 * from the adoption journal, so a crash after publication but before the
 * session CAS replays to the same content-addressed report ID.
 */
export function reconcileSessionChecksAfterLocalEngineAdoption(
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions = {},
): SessionCheck | null {
  const initial = inspectSession(cwd, requestedSessionId);
  const adoption = resolveVerifiedLocalAdoption(
    initial,
    options.environment ?? process.env,
  );
  if (adoption === null || !initial.session.latestCheckReportId) return null;
  if (initial.session.checkEvidenceEngineDigest === adoption.toEngineDigest) {
    return null;
  }
  if (
    initial.session.checkEvidenceEngineDigest !== undefined &&
    initial.session.checkEvidenceEngineDigest !== adoption.fromEngineDigest
  ) {
    throw workflowError(
      'SESSION_CHECK_ENGINE_BINDING_CONFLICT',
      'Durable check evidence is bound to neither side of the verified local engine adoption.',
      ExitCode.staleState,
    );
  }
  if (
    canonicalJson(adoption.snapshotSession) !== canonicalJson(initial.session)
  ) {
    throw workflowError(
      'SESSION_ADOPTION_CHECKPOINT_CHANGED',
      'The durable parent session changed after its intervention checkpoint.',
      ExitCode.staleState,
    );
  }

  const previousReportId = initial.session.latestCheckReportId;
  const previousReport = readImmutableReport(
    runtimePaths(
      initial.git.gitCommonDirectory,
      initial.contract.config.runtimeDirectory,
    ).reports,
    initial.session.sessionId,
    previousReportId,
  );
  assertInspectionReport(
    previousReport,
    initial,
    'check',
    'CHECK_REPORT_STALE',
  );
  assertReportChecks(
    previousReport,
    initial,
    initial.session.requiredChecks,
    'CHECK_REPORT_STALE',
  );
  if (previousReport.parentReportId !== undefined) {
    throw workflowError(
      'CHECK_REPORT_STALE',
      'The current check report has an unexpected report parent.',
      ExitCode.staleState,
    );
  }

  const trustedPolicy = loadTrustedCheckPolicy(
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.session.requiredChecks,
  );
  const { checkDependencies, externalStateFreshness } = trustedPolicy;
  if (
    previousReport.checkDependencies !== undefined &&
    canonicalJson(previousReport.checkDependencies) !==
      canonicalJson(checkDependencies)
  ) {
    throw workflowError(
      'SESSION_CHECK_ATTESTATION_MISMATCH',
      'Persisted check dependency attestation differs from its trust-base declaration.',
      ExitCode.staleState,
    );
  }
  if (
    previousReport.externalStateFreshness !== undefined &&
    canonicalJson(previousReport.externalStateFreshness) !==
      canonicalJson(externalStateFreshness)
  ) {
    throw workflowError(
      'SESSION_CHECK_ATTESTATION_MISMATCH',
      'Persisted external-state freshness attestation differs from its trust-base declaration.',
      ExitCode.staleState,
    );
  }

  const previousChecks = previousReport.checks as CheckEvidence[];
  const previousById = new Map(
    previousChecks.map((evidence) => [evidence.checkId, evidence]),
  );
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw workflowError(
      'SESSION_CHECK_CLOCK_INVALID',
      'The trusted check freshness clock is invalid.',
      ExitCode.staleState,
    );
  }
  const externalStateInvalidated = new Set<string>();
  const invalidatedCheckIds = initial.session.requiredChecks.filter(
    (checkId) => {
      const dependencies = checkDependencies[checkId]!;
      const definition = initial.contract.checks.checks[checkId];
      const runner = pinCheckRunner(
        initial.git.repositoryRoot,
        checkId,
        definition,
      );
      const evidence = previousById.get(checkId)!;
      const externalInvalid = dependencies.includes('external-state')
        ? !isReusableExternalStateEvidence(
            checkId,
            evidence,
            externalStateFreshness[checkId],
            options.externalSnapshotDigests?.[checkId],
            now,
          )
        : false;
      if (externalInvalid) externalStateInvalidated.add(checkId);
      return (
        dependencies.includes('harness-engine') ||
        externalInvalid ||
        evidence.runnerDigest !== runner.digest
      );
    },
  );
  const invalidated = new Set(invalidatedCheckIds);
  const reusedCheckIds = initial.session.requiredChecks.filter(
    (checkId) => !invalidated.has(checkId),
  );
  const rerun = executeChecks(
    cwd,
    initial,
    invalidatedCheckIds,
    options.environment ?? process.env,
    [],
    undefined,
    [],
    createSessionEvidenceMetadata(
      invalidatedCheckIds,
      trustedPolicy,
      options.now
        ? options
        : {
            ...options,
            // A durable adoption timestamp is conservative (never later than
            // actual completion) and keeps crash replay content-addressed.
            now: () => new Date(adoption.committedAt),
          },
    ),
  );
  const rerunById = new Map(
    rerun.checks.map((evidence) => [evidence.checkId, evidence]),
  );
  const checks = initial.session.requiredChecks.map(
    (checkId) => rerunById.get(checkId) ?? previousById.get(checkId)!,
  );
  const selectiveInvalidation = {
    schemaVersion: 1 as const,
    kind: 'local-engine-check-invalidation.v1' as const,
    adoptionTxId: adoption.txId,
    checkpointId: adoption.checkpointId,
    fromEngineDigest: adoption.fromEngineDigest,
    toEngineDigest: adoption.toEngineDigest,
    changedDependencies:
      externalStateInvalidated.size > 0
        ? (['external-state', 'harness-engine'] as const)
        : (['harness-engine'] as const),
    invalidatedCheckIds,
    reusedCheckIds,
    checkDependencies,
    ...(Object.keys(externalStateFreshness).length > 0
      ? { externalStateFreshness }
      : {}),
  };
  const report: WorkflowReport = {
    ...previousReport,
    createdAt: adoption.committedAt,
    checks,
    checkDependencies,
    ...(Object.keys(externalStateFreshness).length > 0
      ? { externalStateFreshness }
      : {}),
    reconciledFromReportId: previousReportId,
    selectiveInvalidation,
  };
  const reportId = writeSessionReport(rerun.inspection, report);
  options.testAfterReconciliationReport?.();
  persistSession(rerun.inspection, {
    ...rerun.inspection.session,
    latestCheckReportId: reportId,
    checkEvidenceEngineDigest: adoption.toEngineDigest,
  });
  return {
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    changedPaths: rerun.inspection.changedPaths,
    unexpectedPaths: [],
    checks,
    executedCheckIds: invalidatedCheckIds,
    reusedCheckIds,
    passed: true,
    reportId,
  };
}

function resolveVerifiedLocalAdoption(
  inspection: SessionInspection,
  environment: NodeJS.ProcessEnv,
): VerifiedLocalAdoption | null {
  const stateRoot = bootstrapInterventionStateRoot(
    inspection.git.gitCommonDirectory,
  );
  const selection = resolveLocalEngineSelection(stateRoot, {
    worktreeRoot: inspection.git.repositoryRealPath,
    branchRef: inspection.git.branch
      ? `refs/heads/${inspection.git.branch}`
      : null,
  });
  const rawResumeBinding = environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
  if (selection === null) {
    if (rawResumeBinding !== undefined) {
      throw workflowError(
        'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
        'A local engine resume binding was supplied without a verified adoption.',
        ExitCode.staleState,
      );
    }
    return null;
  }
  if (rawResumeBinding === undefined) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_RESUME_BINDING_REQUIRED',
      'A committed local adoption must resume through the bootstrap-selected engine.',
      ExitCode.staleState,
    );
  }
  let parsedResumeBinding: unknown;
  try {
    parsedResumeBinding = JSON.parse(rawResumeBinding);
  } catch {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      'The local engine resume binding is malformed.',
      ExitCode.staleState,
    );
  }
  if (
    canonicalJson(parsedResumeBinding) !==
      canonicalJson(selection.resumeBinding) ||
    selection.resumeBinding.parentChangeId !== inspection.session.changeId
  ) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      'The local engine resume binding differs from bootstrap-verified state.',
      ExitCode.staleState,
    );
  }

  const bindingPath = path.join(
    stateRoot,
    'local-parent-sessions',
    `${crypto
      .createHash('sha256')
      .update(`parent-session\0${inspection.session.changeId}`)
      .digest('hex')}.json`,
  );
  const binding = readLocalEngineBinding(bindingPath);
  const adoption = readPersistedEngineAdoption(stateRoot, binding.txId);
  const journal = adoption.journal;
  if (
    journal.state !== 'COMMITTED' ||
    journal.parentChangeId !== inspection.session.changeId ||
    journal.txId !== binding.txId ||
    journal.checkpointId !== selection.resumeBinding.checkpointId ||
    journal.toEngineDigest !== selection.resumeBinding.engineDigest ||
    journal.toEngineDigest !== binding.engineDigest
  ) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_ADOPTION_MISMATCH',
      'Bootstrap selection, local binding, and adoption journal disagree.',
      ExitCode.staleState,
    );
  }
  const committedAt = journal.history.at(-1)?.at;
  if (
    journal.history.at(-1)?.state !== 'COMMITTED' ||
    typeof committedAt !== 'string'
  ) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_ADOPTION_MISMATCH',
      'Committed adoption journal lacks a terminal timestamp.',
      ExitCode.staleState,
    );
  }
  const bundle = readPersistedWipBundle(stateRoot, journal.checkpointId);
  let snapshotSession: unknown;
  try {
    snapshotSession = JSON.parse(
      Buffer.from(bundle.session.contentBase64, 'base64').toString('utf8'),
    );
  } catch {
    throw workflowError(
      'SESSION_ADOPTION_CHECKPOINT_INVALID',
      'The intervention checkpoint does not contain a valid session snapshot.',
      ExitCode.staleState,
    );
  }
  if (!isWorkflowSessionSnapshot(snapshotSession, inspection.session)) {
    throw workflowError(
      'SESSION_ADOPTION_CHECKPOINT_INVALID',
      'The intervention checkpoint session identity is invalid.',
      ExitCode.staleState,
    );
  }
  return {
    txId: journal.txId,
    checkpointId: journal.checkpointId,
    fromEngineDigest: journal.fromEngineDigest,
    toEngineDigest: journal.toEngineDigest,
    committedAt,
    journalDigest: journal.journalDigest,
    snapshotSession,
  };
}

function isWorkflowSessionSnapshot(
  value: unknown,
  current: WorkflowSession,
): value is WorkflowSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    (value as { sessionId?: unknown }).sessionId === current.sessionId &&
    (value as { changeId?: unknown }).changeId === current.changeId &&
    (value as { taskId?: unknown }).taskId === current.taskId
  );
}

function loadTrustedCheckPolicy(
  repositoryRoot: string,
  trustBaseCommit: string,
  requiredChecks: string[],
): TrustedCheckPolicy {
  let value: unknown;
  try {
    value = JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${trustBaseCommit}:workflow/maintainer-profiles.json`,
      ]),
    );
  } catch {
    throw checkDependenciesInvalid(
      'Trust base does not contain maintainer check dependency declarations.',
    );
  }
  if (
    !isRecordValue(value) ||
    value.schemaVersion !== 1 ||
    !isRecordValue(value.profiles) ||
    Object.keys(value.profiles).length === 0
  ) {
    throw checkDependenciesInvalid(
      'Trust-base maintainer check dependency declarations are malformed.',
    );
  }
  const profiles = Object.keys(value.profiles)
    .sort()
    .map((profileId) =>
      loadCapabilityProfileFromTrustBase(
        repositoryRoot,
        trustBaseCommit,
        profileId,
      ),
    );
  const checkDependencies = Object.fromEntries(
    requiredChecks.map((checkId) => {
      const declarations = profiles
        .filter((profile) => profile.requiredChecks.includes(checkId))
        .map((profile) => profile.checkDependencies[checkId]!)
        .map((dependencies) => canonicalJson(dependencies));
      const unique = [...new Set(declarations)];
      if (unique.length !== 1) {
        throw checkDependenciesInvalid(
          unique.length === 0
            ? `Required check ${checkId} lacks a trust-base dependency declaration.`
            : `Required check ${checkId} has conflicting trust-base dependency declarations.`,
        );
      }
      return [checkId, JSON.parse(unique[0]!) as CheckDependency[]];
    }),
  );
  const externalStateFreshness = Object.fromEntries(
    requiredChecks.flatMap((checkId) => {
      if (!checkDependencies[checkId]!.includes('external-state')) return [];
      const declarations = profiles
        .filter((profile) => profile.requiredChecks.includes(checkId))
        .map((profile) => profile.externalStateFreshness?.[checkId]?.maxAgeMs);
      const unique = [...new Set(declarations)];
      if (
        unique.length !== 1 ||
        !Number.isSafeInteger(unique[0]) ||
        Number(unique[0]) < 1
      ) {
        throw checkDependenciesInvalid(
          unique.length > 1
            ? `Required external-state check ${checkId} has conflicting trust-base freshness declarations.`
            : `Required external-state check ${checkId} lacks a valid trust-base freshness declaration.`,
        );
      }
      return [[checkId, { maxAgeMs: Number(unique[0]) }]];
    }),
  );
  return { checkDependencies, externalStateFreshness };
}

function tryLoadTrustedCheckPolicy(
  repositoryRoot: string,
  trustBaseCommit: string,
  requiredChecks: string[],
): TrustedCheckPolicy | undefined {
  try {
    runGit(repositoryRoot, [
      'cat-file',
      '-e',
      `${trustBaseCommit}:workflow/maintainer-profiles.json`,
    ]);
  } catch {
    return undefined;
  }
  return loadTrustedCheckPolicy(
    repositoryRoot,
    trustBaseCommit,
    requiredChecks,
  );
}

function createSessionEvidenceMetadata(
  checkIds: string[],
  trustedPolicy: TrustedCheckPolicy,
  options: SessionCheckOptions,
): Readonly<Record<string, CheckEvidenceMetadata>> {
  const clock = options.now ?? (() => new Date());
  return Object.fromEntries(
    checkIds.map((checkId) => {
      const dependencies = trustedPolicy.checkDependencies[checkId]!;
      if (!dependencies.includes('external-state')) {
        return [checkId, { completedAt: clock }];
      }
      const externalSnapshotDigest = options.externalSnapshotDigests?.[checkId];
      const freshness = trustedPolicy.externalStateFreshness[checkId];
      if (
        typeof externalSnapshotDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(externalSnapshotDigest) ||
        !freshness
      ) {
        throw workflowError(
          'SESSION_EXTERNAL_STATE_SNAPSHOT_REQUIRED',
          `Required external-state check ${checkId} lacks a trusted current snapshot.`,
          ExitCode.staleState,
          { details: { checkId } },
        );
      }
      return [
        checkId,
        {
          completedAt: clock,
          externalSnapshotDigest,
          maxAgeMs: freshness.maxAgeMs,
        },
      ];
    }),
  );
}

function isReusableExternalStateEvidence(
  checkId: string,
  evidence: CheckEvidence,
  freshness: { maxAgeMs: number } | undefined,
  currentSnapshotDigest: string | undefined,
  now: Date,
): boolean {
  const completedAt = Date.parse(evidence.completedAt ?? '');
  return (
    freshness !== undefined &&
    typeof currentSnapshotDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(currentSnapshotDigest) &&
    evidence.externalSnapshotDigest === currentSnapshotDigest &&
    evidence.maxAgeMs === freshness.maxAgeMs &&
    Number.isFinite(completedAt) &&
    completedAt <= now.getTime() &&
    now.getTime() - completedAt <= freshness.maxAgeMs &&
    evidence.checkId === checkId
  );
}

function checkDependenciesInvalid(message: string) {
  return workflowError(
    'SESSION_CHECK_DEPENDENCIES_INVALID',
    message,
    ExitCode.staleState,
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function inspectSession(
  cwd: string,
  requestedSessionId: string,
  options: {
    expectedSession?: WorkflowSession;
    projectedTaskIds?: string[];
    projectionSourceDigest?: string;
    authorizedTransitionPaths?: string[];
  } = {},
): SessionInspection {
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessionId = assertSessionId(requestedSessionId);
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);
  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${session.sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  if (
    options.expectedSession &&
    JSON.stringify(session) !== JSON.stringify(options.expectedSession)
  ) {
    throw workflowError(
      'SESSION_CHANGED_DURING_CHECK',
      'The active session changed while required checks were running.',
      ExitCode.staleState,
    );
  }
  assertPinnedGit(discovered, session);

  const { git, contract } = loadStableValidatedChangeContract(
    discovered,
    session.changeId,
  );
  // Task execution is authorized by a governing planning generation, so a
  // change whose generation predates the anchor keeps running its pinned
  // legacy session after activation. What activation does add is that the
  // reviewed marker must still be present: removing it from an activated
  // checkout fails the session closed rather than restoring legacy freedom.
  assertInvestigationPlanningActivation({
    repositoryRoot: git.repositoryRoot,
    baselines: [session.baseline.head],
    readMarker: () => readActivationMarkerFile(git.repositoryRoot),
  });
  if (
    JSON.stringify(session.planningAssurance ?? null) !==
    JSON.stringify(
      createTaskPlanningAssuranceBinding(contract, contract.planningAssurance),
    )
  ) {
    throw workflowError(
      'SESSION_PLANNING_ASSURANCE_STALE',
      'Session planning assurance no longer matches the live validated change contract.',
      ExitCode.staleState,
    );
  }
  const policy = contract.guard.tasks[session.taskId];
  if (!policy) {
    throw workflowError(
      'SESSION_TASK_REMOVED',
      `Session task ${session.taskId} no longer exists in guard.json.`,
      ExitCode.staleState,
    );
  }
  assertOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    session.sessionId,
    session.changeId,
    session.taskId,
  );
  if (
    JSON.stringify(policy.allowedPaths) !==
      JSON.stringify(session.allowedPaths) ||
    JSON.stringify(policy.requiredChecks) !==
      JSON.stringify(session.requiredChecks)
  ) {
    throw workflowError(
      'SESSION_POLICY_TAMPERED',
      'Session task policy does not match the pinned change contract.',
      ExitCode.staleState,
    );
  }

  const artifactDigests = digestArtifacts(
    git.repositoryRoot,
    contract.artifactPaths,
  );
  const tasksPath = path.join(contract.changeDirectory, 'tasks.md');
  const relativeTasksPath = relative(git.repositoryRoot, tasksPath);
  const baselineTasks = runGit(git.repositoryRoot, [
    'show',
    `${session.baseline.head}:${relativeTasksPath}`,
  ]);
  const currentTasks = fs.readFileSync(tasksPath, 'utf8');
  assertTaskProjection(
    baselineTasks,
    currentTasks,
    options.projectedTaskIds ?? [],
    options.projectionSourceDigest,
  );
  const bootstrapArtifactUpgrade = assertArtifactDrift(
    session,
    contract,
    artifactDigests,
    relativeTasksPath,
    options.projectedTaskIds ?? [],
  );

  const changedPaths = listChangedPaths(
    git.repositoryRoot,
    session.baseline.head,
  );
  const projectedPaths =
    (options.projectedTaskIds?.length ?? 0) > 0 ? [relativeTasksPath] : [];
  const transitionPaths = options.authorizedTransitionPaths ?? [];
  const allowedTransitionPaths = completionDocumentPaths(git.repositoryRoot);
  if (
    transitionPaths.some(
      (transitionPath) => !allowedTransitionPaths.includes(transitionPath),
    )
  ) {
    throw workflowError(
      'UNAUTHORIZED_TRANSITION_PATH',
      'A transition path is not an active generated completion document.',
      ExitCode.staleState,
    );
  }
  const unexpectedPaths = changedPaths.filter(
    (changedPath) =>
      !projectedPaths.includes(changedPath) &&
      !transitionPaths.includes(changedPath) &&
      !policy.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );
  if (unexpectedPaths.length > 0) {
    throw workflowError(
      'OUT_OF_SCOPE_PATHS',
      `Session contains ${unexpectedPaths.length} out-of-scope path(s).`,
      ExitCode.verification,
      { details: { changedPaths, unexpectedPaths } },
    );
  }

  const inspectedSession = bootstrapArtifactUpgrade
    ? persistBootstrapArtifactUpgrade(
        sessionPath,
        session,
        contract,
        artifactDigests,
      )
    : session;

  return {
    git,
    session: inspectedSession,
    contract,
    policy,
    artifactDigests,
    changedPaths,
    unexpectedPaths,
    fingerprint: fingerprintRepositoryProjection(
      git.repositoryRoot,
      session.baseline.head,
      git.statusEntries,
    ),
    tasksPath,
    baselineTasks,
  };
}

export function executeChecks(
  cwd: string,
  initial: SessionInspection,
  checkIds: string[],
  environment: NodeJS.ProcessEnv,
  projectedTaskIds: string[] = [],
  projectionSourceDigest?: string,
  authorizedTransitionPaths: string[] = [],
  evidenceMetadata: Readonly<Record<string, CheckEvidenceMetadata>> = {},
): { checks: CheckEvidence[]; inspection: SessionInspection } {
  const requiredChecks = checkIds.map((checkId) => ({
    checkId,
    definition: initial.contract.checks.checks[checkId],
  }));
  const databaseEvidence = requiredChecks.some(
    ({ definition }) => definition.destructiveDatabase,
  )
    ? assertDisposableDatabase(environment)
    : undefined;
  const pinnedChecks = requiredChecks.map(({ checkId, definition }) => ({
    checkId,
    definition,
    runner: pinCheckRunner(initial.git.repositoryRoot, checkId, definition),
  }));
  const fingerprint = fingerprintWorkingState(
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.git.statusEntries,
  );
  const checks: CheckEvidence[] = [];
  let inspection = initial;
  for (const { checkId, definition, runner } of pinnedChecks) {
    checks.push(
      runCheck(
        initial.git.repositoryRoot,
        checkId,
        definition,
        runner,
        createCheckEnvironment(environment, definition.destructiveDatabase),
        definition.destructiveDatabase ? databaseEvidence?.identity : undefined,
        evidenceMetadata[checkId],
      ),
    );
    inspection = inspectSession(cwd, initial.session.sessionId, {
      expectedSession: initial.session,
      projectedTaskIds,
      projectionSourceDigest,
      authorizedTransitionPaths,
    });
    if (
      fingerprintWorkingState(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        inspection.git.statusEntries,
      ) !== fingerprint
    ) {
      throw workflowError(
        'CHECK_MUTATED_WORKTREE',
        `Required check ${checkId} changed the Git working state.`,
        ExitCode.staleState,
        { details: { checkId } },
      );
    }
  }
  return { checks, inspection };
}

export function persistSession(
  inspection: SessionInspection,
  session: WorkflowSession,
): void {
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  const current = readSessionFile(sessionPath);
  if (JSON.stringify(current) !== JSON.stringify(inspection.session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The session changed before its transition could be persisted.',
      ExitCode.staleState,
    );
  }
  writeJsonAtomic(sessionPath, session);
}

export function writeSessionReport(
  inspection: SessionInspection,
  report: WorkflowReport,
): string {
  const planningAssurance = inspection.session.planningAssurance ?? null;
  if (
    report.planningAssurance !== undefined &&
    JSON.stringify(report.planningAssurance) !==
      JSON.stringify(planningAssurance)
  ) {
    throw workflowError(
      'REPORT_PLANNING_ASSURANCE_MISMATCH',
      'Task report planning assurance does not match its governing session.',
      ExitCode.staleState,
    );
  }
  return writeImmutableReport(
    runtimePaths(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    ).reports,
    { ...report, planningAssurance },
  );
}

function assertPinnedGit(git: GitState, session: WorkflowSession): void {
  if (git.repositoryRealPath !== session.repositoryRoot) {
    throw workflowError(
      'REPOSITORY_IDENTITY_CHANGED',
      'Session repository identity does not match the current repository.',
      ExitCode.staleState,
    );
  }
  if (git.gitCommonDirectory !== session.gitCommonDirectory) {
    throw workflowError(
      'GIT_COMMON_DIRECTORY_CHANGED',
      'Session Git common-directory identity has changed.',
      ExitCode.staleState,
    );
  }
  if (git.branch !== session.branch) {
    throw workflowError(
      'SESSION_BRANCH_CHANGED',
      `Session branch changed from ${session.branch} to ${git.branch ?? 'detached HEAD'}.`,
      ExitCode.staleState,
    );
  }
  if (git.head !== session.baseline.head) {
    throw workflowError(
      'SESSION_HEAD_CHANGED',
      'HEAD changed after session start.',
      ExitCode.staleState,
      { details: { baseline: session.baseline.head, actual: git.head } },
    );
  }
}

function assertArtifactDrift(
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  currentDigests: Record<string, string>,
  tasksPath: string,
  projectedTaskIds: string[],
): boolean {
  const task32BootstrapArtifactSet = isTask32BootstrapArtifactSet(
    session,
    contract,
    tasksPath,
    projectedTaskIds,
  );
  const allPaths = new Set([
    ...Object.keys(session.artifacts),
    ...Object.keys(currentDigests),
  ]);
  for (const artifactPath of allPaths) {
    if (session.artifacts[artifactPath] === currentDigests[artifactPath]) {
      continue;
    }
    if (
      task32BootstrapArtifactSet &&
      !Object.hasOwn(session.artifacts, artifactPath)
    ) {
      continue;
    }
    if (artifactPath === 'workflow/config.json') {
      throw artifactsChanged();
    }
    if (artifactPath === 'workflow/checks.json') {
      if (
        !session.requiredCheckDigests ||
        JSON.stringify(
          digestRequiredCheckDefinitions(
            contract.checks,
            session.requiredChecks,
          ),
        ) !== JSON.stringify(session.requiredCheckDigests)
      ) {
        throw artifactsChanged();
      }
    }
    const projected = artifactPath === tasksPath && projectedTaskIds.length > 0;
    if (
      !projected &&
      !session.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(artifactPath, allowedPath),
      )
    ) {
      throw artifactsChanged();
    }
  }
  return task32BootstrapArtifactSet;
}

function persistBootstrapArtifactUpgrade(
  sessionPath: string,
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  artifactDigests: Record<string, string>,
): WorkflowSession {
  if (!sameStringRecord(contract.artifactDigests, artifactDigests)) {
    throw workflowError(
      'OPENSPEC_CHANGE_STATE_CHANGED',
      'Managed change inputs changed before the bootstrap session could be upgraded.',
      ExitCode.staleState,
    );
  }
  const current = readSessionFile(sessionPath);
  if (JSON.stringify(current) !== JSON.stringify(session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_CHECK',
      'The active session changed before its artifact contract could be upgraded.',
      ExitCode.staleState,
    );
  }
  const upgraded: WorkflowSession = {
    ...session,
    artifacts: { ...artifactDigests },
  };
  writeJsonAtomic(sessionPath, upgraded);
  if (
    JSON.stringify(readSessionFile(sessionPath)) !== JSON.stringify(upgraded)
  ) {
    throw workflowError(
      'SESSION_WRITE_VERIFICATION_FAILED',
      'The upgraded session artifact contract could not be verified.',
      ExitCode.staleState,
    );
  }
  return upgraded;
}

function isTask32BootstrapArtifactSet(
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  tasksPath: string,
  projectedTaskIds: string[],
): boolean {
  if (
    session.changeId !== 'integrate-openspec-with-workflow' ||
    session.taskId !== '3.2'
  ) {
    return false;
  }
  const bootstrapModule =
    'packages/workflow-engine/src/managed-change-contract.ts';
  const baselinePaths = runGit(session.repositoryRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    session.baseline.head,
    '--',
    `:(literal)${bootstrapModule}`,
  ]);
  if (baselinePaths !== '') {
    return false;
  }

  const legacyArtifacts = loadChangeContract(
    session.repositoryRoot,
    session.changeId,
  ).artifactDigests;
  const sessionPaths = Object.keys(session.artifacts).sort(compareText);
  const legacyPaths = Object.keys(legacyArtifacts).sort(compareText);
  if (JSON.stringify(sessionPaths) !== JSON.stringify(legacyPaths)) {
    return false;
  }
  return legacyPaths.every(
    (artifactPath) =>
      (artifactPath === tasksPath && projectedTaskIds.length > 0) ||
      session.artifacts[artifactPath] === legacyArtifacts[artifactPath],
  );
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sameStringRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return (
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function assertTaskProjection(
  baseline: string,
  current: string,
  projectedTaskIds: string[],
  projectionSourceDigest?: string,
): void {
  if (projectedTaskIds.length > 0) {
    if (!projectionSourceDigest) {
      throw workflowError(
        'TASK_PROJECTION_SOURCE_REQUIRED',
        'Projected tasks require the checked source digest.',
        ExitCode.staleState,
      );
    }
    assertTaskProjectionSourceDigest(
      current,
      projectedTaskIds,
      projectionSourceDigest,
    );
    return;
  }
  const baselineTasks = parseTasks(baseline).map(({ id, completed }) => ({
    id,
    completed,
  }));
  const currentTasks = parseTasks(current).map(({ id, completed }) => ({
    id,
    completed,
  }));
  if (JSON.stringify(baselineTasks) !== JSON.stringify(currentTasks)) {
    throw workflowError(
      'UNAUTHORIZED_TASK_PROJECTION',
      'Task checkboxes may only change through workflow complete-task.',
      ExitCode.staleState,
    );
  }
}

function artifactsChanged() {
  return workflowError(
    'ARTIFACTS_CHANGED',
    'Pinned workflow artifacts changed without preserving the active policy.',
    ExitCode.staleState,
  );
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
