import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import {
  assertHumanRevocationAuthorization,
  authorizeHumanRevocation,
  canonicalHumanRevocationAuthorization,
  digestHumanRevocationSubject,
  type HumanRevocationAuthorization,
  type HumanRevocationOptions,
} from './human-revocation.ts';
import {
  createEngineArtifact,
  verifyHarnessMaintenanceGrant,
  type EngineArtifact,
  type HarnessMaintenanceGrantEnvelope,
  type HarnessMaintenanceOperation,
  type HarnessMaintenanceWaiver,
  type Sha256Digest,
} from './intervention-control.ts';
import {
  interventionEngineArtifactRecordPath as storedArtifactRecordPath,
  readStoredInterventionEngineArtifact,
} from './intervention-engine-artifact-store.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  activeBootstrapMaintenanceWorkflowBindingDigest,
  interventionControlPersistencePaths,
  preparePersistedEngineAdoption,
  recordBootstrapSidecarArtifactReady,
  readPersistedBootstrapSidecarWorkflow,
  readPersistedIntervention,
} from './intervention-control-persistence.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const ENGINE_PROBE_TIMEOUT_MS = 10_000;

// Only paths this repository actually has. A scope naming a package that does
// not exist reads as authority over something and grants nothing — the kind of
// clause that looks like protection until someone relies on it.
export const MAINTENANCE_SCOPE_PATHS = Object.freeze([
  'packages/workflow-engine/**',
] as const);

export const MAINTENANCE_SCOPE_OPERATIONS = Object.freeze([
  'adopt-engine-into-parent',
  'build-engine-artifact',
  'create-isolated-workspace',
  'modify-engine',
  'run-engine-tests',
] as const satisfies readonly HarnessMaintenanceOperation[]);

// Every waiver the grant type admits. Issuing three of the five meant an
// intervention could be stopped by a rule the design says a maintenance grant
// may waive, with nothing in the signed record explaining why that rule was
// treated differently from its siblings.
export const MAINTENANCE_SCOPE_WAIVERS = Object.freeze([
  'active-change-exclusivity',
  'clean-worktree-required',
  'engine-path-protection',
  'parent-terminalization-required',
  'selected-workflow-check',
] as const satisfies readonly HarnessMaintenanceWaiver[]);

export interface MaintenanceApprovalSummary {
  kind: 'maintenance-approval-summary.v1';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  engineFromDigest: Sha256Digest;
  sessionSchema: string;
  reason: string;
  childWorkspace: {
    path: string;
    changeRef: string;
  };
  scope: {
    paths: string[];
    operations: HarnessMaintenanceOperation[];
  };
  waivers: HarnessMaintenanceWaiver[];
  authorityAudit: {
    externalAuditRoot: string;
    repositoryId: Sha256Digest;
  };
  maxLocalAdoptions: 1;
  humanReadable: string;
}

export interface PersistedMaintenanceGrantRecord {
  kind: 'persisted-maintenance-grant.v1';
  state: 'available' | 'expired' | 'revoked';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  authorityAudit: {
    externalAuditRoot: string;
    repositoryId: Sha256Digest;
  };
  envelope: HarnessMaintenanceGrantEnvelope;
  summary: MaintenanceApprovalSummary;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  revocationAuthorization?: HumanRevocationAuthorization;
  recordDigest: Sha256Digest;
}

export type MaintenanceGrantRevocationOptions = HumanRevocationOptions & {
  verifyHumanSignature: (
    payload: string,
    signature: string,
    identity: string,
    namespace: string,
  ) => boolean;
};

export interface PersistedInterventionEngineArtifact {
  kind:
    | 'persisted-intervention-engine-artifact.v1'
    | 'persisted-intervention-engine-artifact.v2';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  artifact: EngineArtifact;
  executablePath: string;
  /** Required when kind is v2; absent only on historical v1 records. */
  workflowBindingDigest?: Sha256Digest;
  workflowStatus?: 'repair-active';
  createdAt: string;
  recordDigest: Sha256Digest;
}

export function buildAndPersistInterventionEngineArtifact(
  storageRoot: string,
  input: {
    parentChangeId: string;
    executablePath: string;
    protocolVersion: number;
    policySchemaVersion: number;
    now: Date;
  },
): PersistedInterventionEngineArtifact {
  const intervention = readPersistedIntervention(
    storageRoot,
    input.parentChangeId,
  );
  const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(
    storageRoot,
    input.parentChangeId,
  );
  if (sidecarWorkflow.workflowBinding.status !== 'repair-active') {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_WORKFLOW_NOT_ACTIVE',
      'Engine artifacts can only be built by the active bootstrap-maintenance Workflow.',
      ExitCode.conflict,
    );
  }
  if (
    !Number.isSafeInteger(input.protocolVersion) ||
    input.protocolVersion < 1 ||
    !Number.isSafeInteger(input.policySchemaVersion) ||
    input.policySchemaVersion < 1
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_VERSION_INVALID',
      'Engine artifact protocol and policy schema versions must be positive integers.',
      ExitCode.usage,
    );
  }
  const childWorkspacePath = intervention.childWorkspace.childWorkspacePath;
  const childRepository = discoverRepository(childWorkspacePath);
  if (
    childRepository.repositoryRealPath !== childWorkspacePath ||
    childRepository.branch !==
      `work/${intervention.relationship.interventionChangeId}` ||
    childRepository.head !== intervention.checkpoint.baseOid
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_WORKSPACE_MISMATCH',
      'Engine artifact must be built from the exact reserved child worktree and checkpoint base.',
      ExitCode.verification,
    );
  }
  const executablePath = assertScopedChildArtifactPath(
    childWorkspacePath,
    input.executablePath,
  );
  const executableBytes = readBoundedArtifactSource(
    childWorkspacePath,
    executablePath,
  );
  const executableDigest = digest(executableBytes);
  const sourceDigestBeforeSmoke = interventionSourceDigest(childWorkspacePath);
  const probe = runArtifactProbe(executablePath, '--bootstrap-probe');
  const health = runArtifactProbe(executablePath, '--health-check');
  const sourceDigest = interventionSourceDigest(childWorkspacePath);
  if (sourceDigest !== sourceDigestBeforeSmoke) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_SOURCE_DRIFT',
      'Engine source changed while the candidate smoke contract was running.',
      ExitCode.staleState,
    );
  }
  if (
    probe.kind !== 'engine-bootstrap-probe.v1' ||
    probe.started !== true ||
    probe.sessionSchema !== intervention.parent.sessionSchema ||
    health.kind !== 'engine-health.v1' ||
    health.healthy !== true ||
    health.sessionSchema !== intervention.parent.sessionSchema
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_SMOKE_FAILED',
      'Candidate engine did not pass the bootstrap and health smoke contract.',
      ExitCode.verification,
    );
  }
  const smokeReportDigest = digest(
    canonicalJson({
      kind: 'intervention-engine-smoke-report.v1',
      executableDigest,
      sourceDigest,
      probe,
      health,
    }),
  );
  const artifact = createEngineArtifact({
    sourceChangeId: intervention.relationship.interventionChangeId,
    sourceDigest,
    executableDigest,
    protocolVersion: input.protocolVersion,
    canReadSessionSchemas: [intervention.parent.sessionSchema],
    writesSessionSchema: intervention.parent.sessionSchema,
    policySchemaVersion: input.policySchemaVersion,
    smokeReportDigest,
    workflowBindingDigest:
      sidecarWorkflow.workflowBinding.workflowBindingDigest,
  });
  return persistInterventionEngineArtifact(storageRoot, {
    parentChangeId: input.parentChangeId,
    artifact,
    executablePath,
    now: input.now,
  });
}

export function maintenanceGrantId(
  parentChangeId: string,
  checkpointId: Sha256Digest,
  issuedAt?: string,
  interventionChangeId?: string,
): string {
  assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  assertDigest(checkpointId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  if (issuedAt !== undefined) {
    exactDate(new Date(issuedAt));
    assertNonEmpty(interventionChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  }
  return `maintenance-${crypto
    .createHash('sha256')
    .update(
      issuedAt === undefined
        ? `maintenance-grant\0${parentChangeId}\0${checkpointId}`
        : `maintenance-grant.v2\0${parentChangeId}\0${checkpointId}\0${interventionChangeId}\0${issuedAt}`,
    )
    .digest('hex')}`;
}

export function maintenanceApprovalSummary(input: {
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  engineFromDigest: Sha256Digest;
  sessionSchema: string;
  reason: string;
  childWorkspace: {
    path: string;
    changeRef: string;
  };
  authorityAudit: {
    externalAuditRoot: string;
    repositoryId: Sha256Digest;
  };
}): MaintenanceApprovalSummary {
  const humanReadable = [
    'Harness maintenance intervention',
    `Parent change: ${input.parentChangeId}`,
    `Intervention change: ${input.interventionChangeId}`,
    `Checkpoint: ${input.checkpointId}`,
    `Current engine: ${input.engineFromDigest}`,
    `Session schema: ${input.sessionSchema}`,
    `Reason: ${input.reason}`,
    `Reserved child workspace: ${input.childWorkspace.path}`,
    `Reserved child change ref: ${input.childWorkspace.changeRef}`,
    `Exact scope paths: ${MAINTENANCE_SCOPE_PATHS.join(', ')}`,
    `Allowed operations: ${MAINTENANCE_SCOPE_OPERATIONS.join(', ')}`,
    `Explicit waivers: ${MAINTENANCE_SCOPE_WAIVERS.join(', ')}`,
    `External authority audit root: ${input.authorityAudit.externalAuditRoot}`,
    `Authority audit repository: ${input.authorityAudit.repositoryId}`,
    'Local adoption limit: 1',
    'Repository-default/global engine promotion: forbidden',
  ].join('\n');
  return deepFreeze({
    kind: 'maintenance-approval-summary.v1' as const,
    ...input,
    scope: {
      paths: [...MAINTENANCE_SCOPE_PATHS],
      operations: [...MAINTENANCE_SCOPE_OPERATIONS],
    },
    waivers: [...MAINTENANCE_SCOPE_WAIVERS],
    authorityAudit: structuredClone(input.authorityAudit),
    maxLocalAdoptions: 1 as const,
    humanReadable,
  });
}

export function persistMaintenanceGrantRecord(
  storageRoot: string,
  input: {
    envelope: HarnessMaintenanceGrantEnvelope;
    summary: MaintenanceApprovalSummary;
    now: Date;
  },
): PersistedMaintenanceGrantRecord {
  const paths = maintenancePaths(storageRoot);
  ensurePrivateDirectory(paths.grants);
  const payload = input.envelope.payload;
  assertAuditBinding(input.summary.authorityAudit);
  const legacyGrantId = maintenanceGrantId(
    input.summary.parentChangeId,
    input.summary.checkpointId,
  );
  const issuedGrantId = maintenanceGrantId(
    input.summary.parentChangeId,
    input.summary.checkpointId,
    payload.issuedAt,
    payload.interventionChangeId,
  );
  if (
    ![legacyGrantId, issuedGrantId].includes(payload.grantId) ||
    payload.parentChangeId !== input.summary.parentChangeId ||
    payload.interventionChangeId !== input.summary.interventionChangeId ||
    payload.engineFromDigest !== input.summary.engineFromDigest ||
    payload.sessionSchema !== input.summary.sessionSchema ||
    payload.reason !== input.summary.reason ||
    canonicalJson(payload.scope) !== canonicalJson(input.summary.scope) ||
    canonicalJson(payload.waivers) !== canonicalJson(input.summary.waivers) ||
    payload.maxLocalAdoptions !== input.summary.maxLocalAdoptions
  ) {
    throw maintenanceRecordCorrupt(
      'Maintenance grant does not match the presented approval summary.',
    );
  }
  const at = exactDate(input.now).toISOString();
  const record = withRecordDigest({
    kind: 'persisted-maintenance-grant.v1' as const,
    state: 'available' as const,
    parentChangeId: input.summary.parentChangeId,
    interventionChangeId: input.summary.interventionChangeId,
    checkpointId: input.summary.checkpointId,
    authorityAudit: structuredClone(input.summary.authorityAudit),
    envelope: structuredClone(input.envelope),
    summary: structuredClone(input.summary),
    createdAt: at,
    updatedAt: at,
    expiredAt: null,
    revokedAt: null,
    revocationReason: null,
  });
  const target = maintenanceGrantRecordPath(storageRoot, payload.grantId);
  if (fs.existsSync(target)) {
    const existing = readMaintenanceGrantRecord(storageRoot, payload.grantId);
    if (canonicalJson(existing) !== canonicalJson(record)) {
      throw workflowError(
        'MAINTENANCE_GRANT_RECORD_CONFLICT',
        'Maintenance grant id is already bound to different bytes.',
        ExitCode.conflict,
      );
    }
    return existing;
  }
  createPrivateFileExclusive(target, `${canonicalJson(record)}\n`);
  return deepFreeze(structuredClone(record));
}

export function readMaintenanceGrantRecord(
  storageRoot: string,
  grantId: string,
): PersistedMaintenanceGrantRecord {
  const value = readCanonicalPrivateFile(
    maintenanceGrantRecordPath(storageRoot, grantId),
    'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
  );
  const hasRevocationAuthorization =
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'revocationAuthorization');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'checkpointId',
      'authorityAudit',
      'createdAt',
      'envelope',
      'expiredAt',
      'interventionChangeId',
      'kind',
      'parentChangeId',
      'recordDigest',
      'revocationReason',
      ...(hasRevocationAuthorization ? ['revocationAuthorization'] : []),
      'revokedAt',
      'state',
      'summary',
      'updatedAt',
    ]) ||
    value.kind !== 'persisted-maintenance-grant.v1' ||
    !['available', 'expired', 'revoked'].includes(String(value.state)) ||
    !verifyRecordDigest(value)
  ) {
    throw maintenanceRecordCorrupt();
  }
  const record = value as unknown as PersistedMaintenanceGrantRecord;
  assertAuditBinding(record.authorityAudit);
  assertAuditBinding(record.summary.authorityAudit);
  if (
    record.envelope.payload.grantId !== grantId ||
    record.envelope.payload.parentChangeId !== record.parentChangeId ||
    record.envelope.payload.interventionChangeId !==
      record.interventionChangeId ||
    record.summary.checkpointId !== record.checkpointId ||
    record.summary.parentChangeId !== record.parentChangeId ||
    record.summary.interventionChangeId !== record.interventionChangeId ||
    canonicalJson(record.authorityAudit) !==
      canonicalJson(record.summary.authorityAudit) ||
    (record.state === 'available' &&
      (record.expiredAt !== null ||
        record.revokedAt !== null ||
        record.revocationReason !== null)) ||
    (record.state === 'expired' &&
      (record.expiredAt !== record.envelope.payload.expiresAt ||
        record.revokedAt !== null ||
        record.revocationReason !== null)) ||
    (record.state === 'revoked' &&
      (record.expiredAt !== null ||
        record.revokedAt === null ||
        record.revocationReason === null)) ||
    (hasRevocationAuthorization &&
      (record.state !== 'revoked' ||
        canonicalJson(
          assertMaintenanceRevocationAuthorization(
            record.revocationAuthorization,
            grantId,
            record.revocationReason,
            record.revokedAt,
          ),
        ) !== canonicalJson(record.revocationAuthorization)))
  ) {
    throw maintenanceRecordCorrupt();
  }
  exactDate(new Date(record.createdAt));
  exactDate(new Date(record.updatedAt));
  return deepFreeze(structuredClone(record));
}

export function readMaintenanceGrantForParent(
  storageRoot: string,
  parentChangeId: string,
): PersistedMaintenanceGrantRecord {
  assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  const directory = maintenancePaths(storageRoot).grants;
  if (!fs.existsSync(directory)) {
    throw workflowError(
      'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
      'Persisted maintenance record was not found.',
      ExitCode.conflict,
    );
  }
  const matches: PersistedMaintenanceGrantRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'revocation-authorizations') {
      continue;
    }
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw workflowError(
        'INTERVENTION_MAINTENANCE_STORAGE_UNSAFE',
        'Maintenance grant store contains an unexpected entry.',
        ExitCode.unsafeEnvironment,
      );
    }
    const value = readCanonicalPrivateFile(
      path.join(directory, entry.name),
      'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
    );
    if (
      !isRecord(value) ||
      !isRecord(value.envelope) ||
      !isRecord(value.envelope.payload) ||
      typeof value.envelope.payload.grantId !== 'string'
    ) {
      throw maintenanceRecordCorrupt();
    }
    const grantId = value.envelope.payload.grantId;
    if (
      path.basename(maintenanceGrantRecordPath(storageRoot, grantId)) !==
      entry.name
    ) {
      throw maintenanceRecordCorrupt();
    }
    const record = readMaintenanceGrantRecord(storageRoot, grantId);
    if (record.parentChangeId === parentChangeId) matches.push(record);
  }
  if (matches.length === 0) {
    throw workflowError(
      'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
      'Persisted maintenance record was not found.',
      ExitCode.conflict,
    );
  }
  matches.sort((left, right) => {
    const byTime =
      left.createdAt < right.createdAt
        ? -1
        : left.createdAt > right.createdAt
          ? 1
          : 0;
    if (byTime !== 0) return byTime;
    const rank = { expired: 0, revoked: 1, available: 2 } as const;
    const byState = rank[left.state] - rank[right.state];
    if (byState !== 0) return byState;
    return left.envelope.payload.grantId < right.envelope.payload.grantId
      ? -1
      : left.envelope.payload.grantId > right.envelope.payload.grantId
        ? 1
        : 0;
  });
  return matches.at(-1)!;
}

export function revokeMaintenanceGrantForParent(
  cwd: string,
  storageRoot: string,
  parentChangeId: string,
  options: MaintenanceGrantRevocationOptions,
): PersistedMaintenanceGrantRecord {
  assertNonEmpty(options.reason, 'MAINTENANCE_GRANT_REVOCATION_INVALID');
  const repository = discoverRepository(cwd);
  const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
  if (current.state !== 'available' && current.state !== 'revoked') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Only active harness-maintenance authority can be revoked.',
      ExitCode.guard,
    );
  }
  const requestedNow = exactDate(options.now ?? new Date());
  if (current.state !== 'revoked') {
    const intervention = readPersistedIntervention(storageRoot, parentChangeId);
    const expiresAt = Date.parse(current.envelope.payload.expiresAt);
    const verificationNow = new Date(
      Math.min(requestedNow.getTime(), expiresAt - 1),
    );
    verifyHarnessMaintenanceGrant(current.envelope, {
      now: verificationNow,
      parent: intervention.parent,
      relationship: intervention.relationship,
      checkpoint: intervention.checkpoint,
      verifyHumanSignature: options.verifyHumanSignature,
    });
  }
  const expectedAuditRepositoryId = deriveAuthorityAuditRepositoryId(
    `git-common:${repository.gitCommonDirectory}`,
  );
  if (current.authorityAudit.repositoryId !== expectedAuditRepositoryId) {
    throw workflowError(
      'HUMAN_REVOCATION_BINDING_INVALID',
      'Maintenance revocation audit binding does not match this Git common directory.',
      ExitCode.guard,
    );
  }
  const policy = loadCurrentMaintainerPolicy(repository.repositoryRoot);
  const authorization = authorizeHumanRevocation(
    repository.repositoryRoot,
    {
      subjectKind: 'harness-maintenance-grant',
      grantId: current.envelope.payload.grantId,
      grantDigest: digestHumanRevocationSubject(
        `${canonicalJson(current.envelope)}\n`,
      ),
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      changeId: current.parentChangeId,
      taskId: null,
      workflowId: current.interventionChangeId,
      audit: structuredClone(current.authorityAudit),
    },
    options,
    path.join(
      storageRoot,
      'maintenance-grants',
      'revocation-authorizations',
      `${current.envelope.payload.grantId}.json`,
    ),
    current.revocationAuthorization ?? null,
  );
  if (current.state === 'revoked') {
    if (
      current.revocationReason !== authorization.payload.reason ||
      current.revocationAuthorization === undefined ||
      canonicalHumanRevocationAuthorization(current.revocationAuthorization) !==
        canonicalHumanRevocationAuthorization(authorization)
    ) {
      throw workflowError(
        'HUMAN_REVOCATION_CONFLICT',
        'Maintenance grant already has a different revocation tombstone.',
        ExitCode.conflict,
      );
    }
    return current;
  }
  const at = authorization.payload.revokedAt;
  const next = withRecordDigest({
    ...withoutRecordDigest(current),
    state: 'revoked' as const,
    updatedAt: at,
    revokedAt: at,
    revocationReason: authorization.payload.reason,
    revocationAuthorization: authorization,
  });
  replacePrivateFileAtomic(
    maintenanceGrantRecordPath(storageRoot, current.envelope.payload.grantId),
    `${canonicalJson(next)}\n`,
  );
  return deepFreeze(structuredClone(next));
}

export function terminalizeExpiredMaintenanceGrantForParent(
  storageRoot: string,
  parentChangeId: string,
  now: Date,
): PersistedMaintenanceGrantRecord {
  const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
  if (current.state !== 'available') return current;
  const observedAt = exactDate(now).getTime();
  const expiresAt = Date.parse(current.envelope.payload.expiresAt);
  if (!Number.isFinite(expiresAt)) throw maintenanceRecordCorrupt();
  if (observedAt < expiresAt) return current;
  const terminalAt = new Date(expiresAt).toISOString();
  const next = withRecordDigest({
    ...withoutRecordDigest(current),
    state: 'expired' as const,
    updatedAt: terminalAt,
    expiredAt: terminalAt,
  });
  replacePrivateFileAtomic(
    maintenanceGrantRecordPath(storageRoot, current.envelope.payload.grantId),
    `${canonicalJson(next)}\n`,
  );
  return deepFreeze(structuredClone(next));
}

export function persistInterventionEngineArtifact(
  storageRoot: string,
  input: {
    parentChangeId: string;
    artifact: EngineArtifact;
    executablePath: string;
    now: Date;
    testObserveArtifactRecordPublication?: (
      phase:
        | 'file-fsynced'
        | 'target-linked'
        | 'target-directory-fsynced'
        | 'temporary-cleaned',
    ) => void;
    testAfterArtifactExecutableOpenedBeforeRead?: () => void;
    testAfterWorkflowBindingVerifiedBeforeArtifactPersisted?: () => void;
    testAfterArtifactPersistedBeforeSidecar?: () => void;
  },
): PersistedInterventionEngineArtifact {
  const intervention = readPersistedIntervention(
    storageRoot,
    input.parentChangeId,
  );
  const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(
    storageRoot,
    input.parentChangeId,
  );
  if (sidecarWorkflow.workflowBinding.status !== 'repair-active') {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_NOT_ACTIVE',
      'Engine artifacts can be persisted only while the bootstrap-maintenance Workflow is repair-active.',
      ExitCode.conflict,
    );
  }
  const workflowBindingDigest = activeBootstrapMaintenanceWorkflowBindingDigest(
    sidecarWorkflow.workflowBinding,
  );
  const artifact = verifyArtifact(input.artifact);
  if (
    artifact.sourceChangeId !== intervention.relationship.interventionChangeId
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_BINDING_MISMATCH',
      'Engine artifact was not produced by the persisted intervention.',
      ExitCode.verification,
    );
  }
  if (
    artifact.workflowBindingDigest !== undefined &&
    artifact.workflowBindingDigest !== workflowBindingDigest
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_BINDING_MISMATCH',
      'Engine artifact belongs to a different bootstrap-maintenance Workflow binding.',
      ExitCode.verification,
    );
  }
  const executablePath = verifyArtifactExecutable(
    intervention.childWorkspace.childWorkspacePath,
    input.executablePath,
    artifact.executableDigest,
    input.testAfterArtifactExecutableOpenedBeforeRead,
  );
  const record = withRecordDigest({
    kind: 'persisted-intervention-engine-artifact.v2' as const,
    parentChangeId: input.parentChangeId,
    interventionChangeId: intervention.relationship.interventionChangeId,
    checkpointId: intervention.checkpoint.checkpointId,
    artifact,
    executablePath,
    workflowBindingDigest,
    workflowStatus: 'repair-active' as const,
    createdAt: exactDate(input.now).toISOString(),
  });
  const paths = maintenancePaths(storageRoot);
  ensurePrivateDirectory(paths.artifacts);
  const target = storedArtifactRecordPath(storageRoot, artifact.artifactId);
  const serializedRecord = `${canonicalJson(record)}\n`;
  if (
    reconcilePrivateFileExclusivePublication(target, serializedRecord) ||
    fs.existsSync(target)
  ) {
    const existing = readInterventionEngineArtifact(
      storageRoot,
      artifact.artifactId,
    );
    if (
      existing.parentChangeId !== record.parentChangeId ||
      existing.interventionChangeId !== record.interventionChangeId ||
      existing.checkpointId !== record.checkpointId ||
      canonicalJson(existing.artifact) !== canonicalJson(record.artifact) ||
      existing.executablePath !== record.executablePath ||
      existing.workflowBindingDigest !== record.workflowBindingDigest ||
      existing.workflowStatus !== record.workflowStatus
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_CONFLICT',
        'Artifact id is already bound to different intervention bytes.',
        ExitCode.conflict,
      );
    }
    assertArtifactWorkflowStillActive(
      storageRoot,
      input.parentChangeId,
      sidecarWorkflow.recordDigest,
      workflowBindingDigest,
    );
    recordBootstrapSidecarArtifactReady(storageRoot, {
      parentChangeId: existing.parentChangeId,
      artifact: existing.artifact,
      evidenceDigest: existing.recordDigest,
      readyAt: existing.createdAt,
    });
    return existing;
  }
  input.testAfterWorkflowBindingVerifiedBeforeArtifactPersisted?.();
  assertArtifactWorkflowStillActive(
    storageRoot,
    input.parentChangeId,
    sidecarWorkflow.recordDigest,
    workflowBindingDigest,
  );
  createPrivateFileExclusive(
    target,
    serializedRecord,
    input.testObserveArtifactRecordPublication,
  );
  input.testAfterArtifactPersistedBeforeSidecar?.();
  assertArtifactWorkflowStillActive(
    storageRoot,
    input.parentChangeId,
    sidecarWorkflow.recordDigest,
    workflowBindingDigest,
  );
  recordBootstrapSidecarArtifactReady(storageRoot, {
    parentChangeId: record.parentChangeId,
    artifact: record.artifact,
    evidenceDigest: record.recordDigest,
    readyAt: record.createdAt,
  });
  return deepFreeze(structuredClone(record));
}

function assertArtifactWorkflowStillActive(
  storageRoot: string,
  parentChangeId: string,
  expectedSidecarRecordDigest: Sha256Digest,
  expectedWorkflowBindingDigest: Sha256Digest,
): void {
  const current = readPersistedBootstrapSidecarWorkflow(
    storageRoot,
    parentChangeId,
  );
  if (
    current.recordDigest !== expectedSidecarRecordDigest ||
    current.workflowBinding.status !== 'repair-active' ||
    current.workflowBinding.workflowBindingDigest !==
      expectedWorkflowBindingDigest
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_NOT_ACTIVE',
      'Bootstrap-maintenance Workflow changed before the artifact record could be persisted.',
      ExitCode.staleState,
    );
  }
}

export function readInterventionEngineArtifact(
  storageRoot: string,
  artifactId: string,
): PersistedInterventionEngineArtifact {
  const record = readStoredInterventionEngineArtifact(storageRoot, artifactId);
  const intervention = readPersistedIntervention(
    storageRoot,
    record.parentChangeId,
  );
  const artifact = verifyArtifact(record.artifact);
  if (
    artifact.artifactId !== artifactId ||
    record.interventionChangeId !==
      intervention.relationship.interventionChangeId ||
    record.checkpointId !== intervention.checkpoint.checkpointId
  ) {
    throw artifactRecordCorrupt();
  }
  if (record.kind === 'persisted-intervention-engine-artifact.v2') {
    const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(
      storageRoot,
      record.parentChangeId,
    );
    if (
      record.workflowStatus !== 'repair-active' ||
      record.workflowBindingDigest === undefined ||
      record.workflowBindingDigest !==
        (sidecarWorkflow.workflowBinding.status === 'repair-active'
          ? sidecarWorkflow.workflowBinding.workflowBindingDigest
          : activeBootstrapMaintenanceWorkflowBindingDigest(
              sidecarWorkflow.workflowBinding,
            )) ||
      (artifact.workflowBindingDigest !== undefined &&
        artifact.workflowBindingDigest !== record.workflowBindingDigest)
    ) {
      throw artifactRecordCorrupt();
    }
  }
  verifyArtifactExecutable(
    intervention.childWorkspace.childWorkspacePath,
    record.executablePath,
    artifact.executableDigest,
  );
  return deepFreeze(structuredClone({ ...record, artifact }));
}

export function preparePersistedEngineAdoptionFromArtifactRecord(
  storageRoot: string,
  input: {
    txId: string;
    parentChangeId: string;
    artifactId: Sha256Digest;
    maintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
    priorLocalAdoptions: number;
    testAfterArtifactSnapshotBeforeParentLock?: () => void;
  },
  dependencies: Parameters<typeof preparePersistedEngineAdoption>[2],
) {
  const record = readInterventionEngineArtifact(storageRoot, input.artifactId);
  if (
    record.kind !== 'persisted-intervention-engine-artifact.v2' ||
    record.parentChangeId !== input.parentChangeId ||
    record.workflowBindingDigest === undefined ||
    record.workflowStatus !== 'repair-active'
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_BINDING_REQUIRED',
      'Engine adoption requires the exact persisted v2 artifact record for the active bootstrap-maintenance Workflow.',
      ExitCode.verification,
    );
  }
  input.testAfterArtifactSnapshotBeforeParentLock?.();
  return preparePersistedEngineAdoption(
    storageRoot,
    {
      txId: input.txId,
      parentChangeId: input.parentChangeId,
      artifact: record.artifact,
      artifactAuthority: {
        recordDigest: record.recordDigest,
        createdAt: record.createdAt,
        workflowBindingDigest: record.workflowBindingDigest,
      },
      maintenanceGrantEnvelope: input.maintenanceGrantEnvelope,
      priorLocalAdoptions: input.priorLocalAdoptions,
    },
    dependencies,
  );
}

function interventionSourceDigest(childWorkspacePath: string): Sha256Digest {
  const changed = runGit(childWorkspacePath, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    'HEAD',
    '--',
  ]);
  const untracked = runGit(childWorkspacePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  const paths = [
    ...new Set([...splitNul(changed), ...splitNul(untracked)]),
  ].sort();
  let totalBytes = 0;
  const entries = paths.map((relativePath) => {
    assertMaintenanceScopedRelativePath(relativePath);
    const target = path.join(childWorkspacePath, relativePath);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stats) {
      return { path: relativePath, kind: 'deleted' as const };
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size > MAX_EXECUTABLE_BYTES
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SOURCE_UNSAFE',
        `Engine source snapshot contains an unsafe entry: ${relativePath}`,
        ExitCode.unsafeEnvironment,
      );
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_SOURCE_SNAPSHOT_BYTES) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SOURCE_TOO_LARGE',
        'Engine source snapshot exceeds the bounded build limit.',
        ExitCode.guard,
      );
    }
    return {
      path: relativePath,
      kind: 'file' as const,
      mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
      contentDigest: digest(fs.readFileSync(target)),
    };
  });
  const head = runGit(childWorkspacePath, ['rev-parse', 'HEAD']).trim();
  return digest(
    canonicalJson({
      kind: 'intervention-engine-source-snapshot.v1',
      head,
      entries,
    }),
  );
}

function assertScopedChildArtifactPath(
  childWorkspacePath: string,
  requestedPath: string,
): string {
  if (
    typeof requestedPath !== 'string' ||
    !path.isAbsolute(requestedPath) ||
    path.resolve(requestedPath) !== requestedPath
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_PATH_INVALID',
      'Engine executable path must be exact, normalized, and absolute.',
      ExitCode.usage,
    );
  }
  const childRoot = fs.realpathSync(childWorkspacePath);
  const relativePath = path.relative(childRoot, requestedPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_PATH_OUTSIDE_SCOPE',
      'Engine executable must stay inside the reserved child worktree.',
      ExitCode.guard,
    );
  }
  assertMaintenanceScopedRelativePath(relativePath);
  return requestedPath;
}

function assertMaintenanceScopedRelativePath(relativePath: string): void {
  const normalized = relativePath.split(path.sep).join('/');
  if (
    normalized !== relativePath ||
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '..') ||
    (!normalized.startsWith('packages/workflow-engine/') &&
      !normalized.startsWith('packages/harness-runtime/'))
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_SCOPE_VIOLATION',
      `Engine build changed a path outside the signed maintenance scope: ${relativePath}`,
      ExitCode.guard,
    );
  }
}

function readBoundedArtifactSource(
  childWorkspacePath: string,
  filePath: string,
): Buffer {
  try {
    return readStableArtifactExecutable(childWorkspacePath, filePath).bytes;
  } catch {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_EXECUTABLE_UNSAFE',
      'Candidate engine must be a bounded canonical single-link executable.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function runArtifactProbe(
  executablePath: string,
  mode: '--bootstrap-probe' | '--health-check',
): Record<string, unknown> {
  const result = spawnSync(executablePath, [mode], {
    cwd: path.dirname(executablePath),
    encoding: 'utf8',
    timeout: ENGINE_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: path.dirname(executablePath),
    },
  });
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_SMOKE_FAILED',
      `Candidate engine ${mode} command failed.`,
      ExitCode.verification,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_SMOKE_INVALID',
      `Candidate engine ${mode} output is not JSON.`,
      ExitCode.verification,
    );
  }
  if (!isRecord(value)) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_SMOKE_INVALID',
      `Candidate engine ${mode} output must be an object.`,
      ExitCode.verification,
    );
  }
  return value;
}

function splitNul(value: string): string[] {
  if (value.length === 0) return [];
  if (!value.endsWith('\0')) {
    throw workflowError(
      'INTERVENTION_ENGINE_BUILD_GIT_OUTPUT_INVALID',
      'Git source snapshot output was not NUL terminated.',
      ExitCode.verification,
    );
  }
  return value.slice(0, -1).split('\0');
}

function maintenancePaths(storageRoot: string) {
  const root = interventionControlPersistencePaths(storageRoot).root;
  return {
    grants: path.join(root, 'maintenance-grants'),
    artifacts: path.join(root, 'intervention-engine-artifacts'),
  };
}

function maintenanceGrantRecordPath(storageRoot: string, grantId: string) {
  assertNonEmpty(grantId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  const name = crypto
    .createHash('sha256')
    .update(`maintenance-record\0${grantId}`)
    .digest('hex');
  return path.join(maintenancePaths(storageRoot).grants, `${name}.json`);
}

function interventionArtifactRecordPath(
  storageRoot: string,
  artifactId: string,
) {
  assertDigest(artifactId, 'INTERVENTION_ENGINE_ARTIFACT_INVALID');
  return path.join(
    maintenancePaths(storageRoot).artifacts,
    `${artifactId.slice('sha256:'.length)}.json`,
  );
}

function verifyArtifact(artifact: EngineArtifact): EngineArtifact {
  const rebuilt = createEngineArtifact(artifact);
  if (rebuilt.artifactId !== artifact.artifactId) throw artifactRecordCorrupt();
  return rebuilt;
}

function verifyArtifactExecutable(
  childWorkspacePath: string,
  requestedPath: string,
  expectedDigest: Sha256Digest,
  testAfterOpenedBeforeRead?: () => void,
): string {
  try {
    const stable = readStableArtifactExecutable(
      childWorkspacePath,
      requestedPath,
      testAfterOpenedBeforeRead,
    );
    if (digest(stable.bytes) !== expectedDigest)
      throw new Error('digest drift');
    return stable.executablePath;
  } catch {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_DRIFT',
      'Persisted engine artifact executable is missing, unsafe, or changed.',
      ExitCode.verification,
    );
  }
}

function readStableArtifactExecutable(
  childWorkspacePath: string,
  requestedPath: string,
  testAfterOpenedBeforeRead?: () => void,
): { executablePath: string; bytes: Buffer } {
  if (
    typeof requestedPath !== 'string' ||
    !path.isAbsolute(requestedPath) ||
    path.resolve(requestedPath) !== requestedPath
  ) {
    throw new Error('non-canonical executable path');
  }
  const childRoot = fs.realpathSync(childWorkspacePath);
  if (childRoot !== childWorkspacePath) {
    throw new Error('non-canonical child workspace');
  }
  const relative = path.relative(childRoot, requestedPath);
  if (
    relative.length === 0 ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error('executable outside child workspace');
  }

  const descriptor = fs.openSync(
    requestedPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertStableArtifactExecutable(before);
    testAfterOpenedBeforeRead?.();
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(requestedPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    let currentRealPath: string | null = null;
    try {
      currentRealPath = fs.realpathSync(requestedPath);
    } catch {
      // The stable identity comparison below fails closed.
    }
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      currentRealPath !== requestedPath ||
      bytes.length !== Number(before.size) ||
      !sameArtifactExecutableIdentity(before, after) ||
      !sameArtifactExecutableIdentity(before, current)
    ) {
      throw new Error('executable pathname changed during verification');
    }
    return { executablePath: requestedPath, bytes };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertStableArtifactExecutable(stats: fs.BigIntStats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.size < 1n ||
    stats.size > BigInt(MAX_EXECUTABLE_BYTES)
  ) {
    throw new Error('unsafe executable inode');
  }
}

function sameArtifactExecutableIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    observed.isFile() &&
    !observed.isSymbolicLink() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = fs.lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw workflowError(
      'INTERVENTION_MAINTENANCE_STORAGE_UNSAFE',
      'Maintenance records require private plain directories.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function createPrivateFileExclusive(
  filePath: string,
  content: string,
  testObservePublication?: (
    phase:
      | 'file-fsynced'
      | 'target-linked'
      | 'target-directory-fsynced'
      | 'temporary-cleaned',
  ) => void,
): void {
  const directory = path.dirname(filePath);
  const temporary = privatePublicationTemporaryPath(filePath);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  testObservePublication?.('file-fsynced');
  finishPrivateFileExclusivePublication(
    filePath,
    temporary,
    content,
    testObservePublication,
  );
}

function reconcilePrivateFileExclusivePublication(
  filePath: string,
  content: string,
): boolean {
  const temporary = privatePublicationTemporaryPath(filePath);
  const targetExists = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const temporaryExists = fs.lstatSync(temporary, { throwIfNoEntry: false });
  if (targetExists === undefined && temporaryExists === undefined) return false;
  if (temporaryExists === undefined) return true;
  const prepared = readPrivatePublicationFile(
    temporary,
    targetExists === undefined ? 1n : 2n,
  );
  if (!sameArtifactPublicationReplay(prepared.content, content)) {
    throw artifactPublicationCorrupt();
  }
  if (targetExists === undefined) {
    finishPrivateFileExclusivePublication(
      filePath,
      temporary,
      prepared.content,
    );
    return true;
  }
  const target = readPrivatePublicationFile(filePath, 2n);
  if (
    target.content !== prepared.content ||
    target.stats.dev !== prepared.stats.dev ||
    target.stats.ino !== prepared.stats.ino
  ) {
    throw artifactPublicationCorrupt();
  }
  finishPrivateFileExclusivePublication(filePath, temporary, prepared.content);
  return true;
}

function finishPrivateFileExclusivePublication(
  filePath: string,
  temporary: string,
  content: string,
  testObservePublication?: (
    phase:
      | 'file-fsynced'
      | 'target-linked'
      | 'target-directory-fsynced'
      | 'temporary-cleaned',
  ) => void,
): void {
  const directory = path.dirname(filePath);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    fs.linkSync(temporary, filePath);
    testObservePublication?.('target-linked');
  }
  assertExactPrivatePublicationPair(filePath, temporary, content);
  fsyncDirectory(directory);
  testObservePublication?.('target-directory-fsynced');
  assertExactPrivatePublicationPair(filePath, temporary, content);
  fs.unlinkSync(temporary);
  fsyncDirectory(directory);
  assertExactPrivatePublicationFile(filePath, content, 1n);
  testObservePublication?.('temporary-cleaned');
}

function assertExactPrivatePublicationPair(
  filePath: string,
  temporary: string,
  content: string,
): void {
  const target = assertExactPrivatePublicationFile(filePath, content, 2n);
  const prepared = assertExactPrivatePublicationFile(temporary, content, 2n);
  if (target.dev !== prepared.dev || target.ino !== prepared.ino) {
    throw artifactPublicationCorrupt();
  }
}

function assertExactPrivatePublicationFile(
  filePath: string,
  content: string,
  expectedLinks: bigint,
): fs.BigIntStats {
  const observed = readPrivatePublicationFile(filePath, expectedLinks);
  if (observed.content !== content) throw artifactPublicationCorrupt();
  return observed.stats;
}

function readPrivatePublicationFile(
  filePath: string,
  expectedLinks: bigint,
): { stats: fs.BigIntStats; content: string } {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw artifactPublicationCorrupt();
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const raw = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      current === undefined ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== expectedLinks ||
      (before.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      !sameArtifactExecutableIdentity(before, after) ||
      !sameArtifactExecutableIdentity(before, current)
    ) {
      throw artifactPublicationCorrupt();
    }
    return { stats: before, content: raw };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameArtifactPublicationReplay(
  observedContent: string,
  candidateContent: string,
): boolean {
  try {
    const observed = JSON.parse(observedContent) as unknown;
    const candidate = JSON.parse(candidateContent) as unknown;
    if (
      !isRecord(observed) ||
      !isRecord(candidate) ||
      `${canonicalJson(observed)}\n` !== observedContent ||
      `${canonicalJson(candidate)}\n` !== candidateContent ||
      !verifyRecordDigest(observed) ||
      !verifyRecordDigest(candidate) ||
      typeof observed.createdAt !== 'string' ||
      Number.isNaN(Date.parse(observed.createdAt)) ||
      new Date(observed.createdAt).toISOString() !== observed.createdAt
    ) {
      return false;
    }
    const {
      createdAt: _observedCreatedAt,
      recordDigest: _observedRecordDigest,
      ...observedIdentity
    } = observed;
    const {
      createdAt: _candidateCreatedAt,
      recordDigest: _candidateRecordDigest,
      ...candidateIdentity
    } = candidate;
    return canonicalJson(observedIdentity) === canonicalJson(candidateIdentity);
  } catch {
    return false;
  }
}

function privatePublicationTemporaryPath(filePath: string): string {
  return `${filePath}.pending`;
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  createPrivateFileExclusive(temporary, content);
  fs.renameSync(temporary, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isDirectory())
      throw new Error('publication parent is not a directory');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readCanonicalPrivateFile(filePath: string, notFoundCode: string) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    throw workflowError(
      notFoundCode,
      'Persisted maintenance record was not found.',
      ExitCode.conflict,
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_RECORD_BYTES
  ) {
    throw maintenanceRecordCorrupt();
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw maintenanceRecordCorrupt();
  }
  if (`${canonicalJson(value)}\n` !== raw) throw maintenanceRecordCorrupt();
  return value;
}

function withRecordDigest<T extends Record<string, unknown>>(
  value: T,
): T & { recordDigest: Sha256Digest } {
  return { ...value, recordDigest: digest(canonicalJson(value)) };
}

function verifyRecordDigest(value: Record<string, unknown>): boolean {
  const { recordDigest, ...payload } = value;
  return (
    typeof recordDigest === 'string' &&
    digest(canonicalJson(payload)) === recordDigest
  );
}

function withoutRecordDigest<T extends { recordDigest: Sha256Digest }>(
  value: T,
): Omit<T, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...payload } = value;
  return payload;
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      'INTERVENTION_MAINTENANCE_TIME_INVALID',
      'Maintenance record time is invalid.',
      ExitCode.guard,
    );
  }
  return new Date(value.getTime());
}

function loadCurrentMaintainerPolicy(repositoryRoot: string) {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          'HEAD:workflow/maintainer-policy.json',
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The current HEAD does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

function assertMaintenanceRevocationAuthorization(
  value: unknown,
  grantId: string,
  reason: string | null,
  revokedAt: string | null,
): HumanRevocationAuthorization {
  const authorization = assertHumanRevocationAuthorization(value);
  if (
    authorization.payload.subjectKind !== 'harness-maintenance-grant' ||
    authorization.payload.grantId !== grantId ||
    authorization.payload.reason !== reason ||
    authorization.payload.revokedAt !== revokedAt
  ) {
    throw maintenanceRecordCorrupt();
  }
  return authorization;
}

function digest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.guard);
  }
}

function assertNonEmpty(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw workflowError(
      code,
      'Expected a non-empty exact string.',
      ExitCode.guard,
    );
  }
}

function assertAuditBinding(
  value: MaintenanceApprovalSummary['authorityAudit'],
): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['externalAuditRoot', 'repositoryId']) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_AUDIT_BINDING_INVALID',
      'Maintenance grant requires an exact absolute authority-audit root.',
      ExitCode.guard,
    );
  }
  assertDigest(value.repositoryId, 'MAINTENANCE_GRANT_AUDIT_BINDING_INVALID');
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function maintenanceRecordCorrupt(
  message = 'Persisted maintenance grant failed integrity verification.',
) {
  return workflowError(
    'MAINTENANCE_GRANT_RECORD_CORRUPT',
    message,
    ExitCode.verification,
  );
}

function artifactRecordCorrupt() {
  return workflowError(
    'INTERVENTION_ENGINE_ARTIFACT_RECORD_CORRUPT',
    'Persisted intervention engine artifact failed integrity verification.',
    ExitCode.verification,
  );
}

function artifactPublicationCorrupt() {
  return workflowError(
    'INTERVENTION_ENGINE_ARTIFACT_PUBLICATION_CORRUPT',
    'Prepared intervention engine artifact publication is foreign, incomplete, or inconsistent.',
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
